/**
 * `AilyAdapter`: fetch + SSE against the aily services endpoint
 * (`POST /api/v2/chat_stateless`), emitting harness StreamChunks. The adapter
 * is transport-only: the bearer token arrives through a per-request resolver
 * (the registering plugin owns refresh and file reads) and connection facts
 * through a thunk resolved once per operation, so a settings change reaches the
 * next request without re-registration.
 *
 * @module @deepseek-ai/dsh-llm-aily/adapter
 */

import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.ts'
import { parseEventStream } from './sse.ts'
import { translate } from './translate.ts'
import type { AilyPreset } from './types.ts'

/** Validated connection facts for one operation. */
export interface AilyConnectionOptions {
  /** Endpoint base; `/api/v2/chat_stateless` is appended. */
  baseURL: string
  /** Path of the aily-login token file (`.aily`), read by the plugin's token resolver. */
  tokenFile: string
  /** Preset id used when the requested model id is not in the catalog. */
  defaultPreset: string
  /** Selectable presets (the only routable aily model shape). */
  presets: readonly AilyPreset[]
  /** Default context capacity used when a preset has no exact value. */
  defaultContextWindow: number
  /** Default per-request output cap; explicit request values win. */
  defaultMaxTokens: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated base64 image payload in one request. */
  maxRequestImageBytes: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface AilyAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => AilyConnectionOptions
  /** Resolve the bearer token for one request; throws on missing/invalid credentials. */
  resolveToken: () => Promise<string>
  /** Resolve the durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 800_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 65_536
/** Default bound on accumulated base64 image payload per request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** The built-in aily product presets; the only routable model ids. */
export const DEFAULT_PRESETS: readonly AilyPreset[] = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'aily 自动调度：按容量与性能选择最佳模型（10% 折扣）',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'auto-max',
    name: 'Aily Max',
    description: 'GLM 5.3（1x 计费）· 高质量优先，适合复杂任务',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'auto-fast',
    name: 'Aily Fast',
    description: 'DeepSeek V4 Flash（0.5x 计费）· 响应速度优先',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    supportsReasoningEffort: ['high', 'xhigh'],
    defaultReasoningEffort: 'high',
  },
]

function modelInfo(provider: string, preset: AilyPreset): LlmModelInfo {
  return {
    provider,
    id: preset.id,
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
    inputModalities: preset.inputModalities ?? ['text'],
  }
}

/** Map an HTTP status to a stable LlmError code. */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status === 413) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function requestId(headers: Headers): Parameters<typeof ProviderRequestId>[0] | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : (value as Parameters<typeof ProviderRequestId>[0])
}/**
 * The aily adapter. One instance serves every preset it was registered under
 * (the harness model id IS the aily preset id).
 */
export class AilyAdapter extends LlmAdapter {
  constructor(private readonly config: AilyAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Aily 额度' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options()
    return Promise.resolve(connection.presets.map(preset => modelInfo(provider, preset)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const preset = connection.presets.find(entry => entry.id === model)
    const contextWindow = preset?.contextWindow ?? connection.defaultContextWindow
    const efforts = preset?.supportsReasoningEffort
    return Promise.resolve({
      provider,
      id: model,
      name: preset?.name ?? model,
      ...preset?.description === undefined ? {} : { description: preset.description },
      inputModalities: preset?.inputModalities ?? ['text'],
      context: { contextWindow },
      defaultMaxTokens: preset?.maxTokens ?? connection.defaultMaxTokens,
      ...efforts !== undefined && efforts.length > 0
        ? {
          reasoning: {
            efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effortLabel(effort) })),
            ...preset?.defaultReasoningEffort !== undefined
              ? { defaultEffort: ReasoningEffortId(preset.defaultReasoningEffort) }
              : {},
          },
        }
        : {},
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const hasImages = (options.messages ?? []).some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError('aily image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
      }
    }
    const token = await this.config.resolveToken()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)

    const body = await serializeRequest(options, connection.presets, connection.defaultPreset, attachments)
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      ...options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {},
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/api/v2/chat_stateless`, {
        method: 'POST',
        headers,
        body: payload,
        signal: watchdog.signal,
      })
    } catch (error: unknown) {
      if (watchdog.signal.aborted) throw error
      throw new LlmError(`aily API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let message = `aily API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as { message?: string; error?: string }
        message = parsed?.message ?? parsed?.error ?? message
      } catch {
        // The HTTP status still identifies the failure.
      }
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status), {
        status: response.status,
        ...id === undefined ? {} : { requestId: ProviderRequestId(id) },
      })
    }
    if (response.body === null) {
      throw new LlmError('aily API returned no response body', 'EMPTY_RESPONSE')
    }

    const events = parseEventStream(response.body)
    const iterator = translate(events)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`aily stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('aily request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`aily API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('aily stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return(undefined)
        } catch {
          // Consumer controller already owns termination.
        }
      }
    }
  }
}

/** Human label for one aily reasoning effort. */
function effortLabel(effort: string): string {
  switch (effort) {
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'xhigh': return 'Max'
    default: return effort
  }
}

// Referenced to keep the imported type in a strongly-typed position:
// ContentBlock is used by serialization configs that build on this package.
export type AilyContentBlock = ContentBlock
export type AilyTokenUsage = TokenUsage
export type AilyModelModality = ModelModality
