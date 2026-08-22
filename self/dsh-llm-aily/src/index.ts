/**
 * Register a {@link AilyAdapter} for the `aily` provider route on `ctx.llm`,
 * with the aily login token resolved per request from the aily-blockly `.aily`
 * file. Like the DeepSeek adapter, connection facts are resolved per request
 * (the plugin layers its `cordis.yml` entry config under the optional
 * `llm-aily` user-settings section), so a changed base URL, token file, or
 * preset list reaches the very next request without restarting anything.
 *
 * @module @deepseek-ai/dsh-llm-aily
 */

import { join } from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  AilyAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRESETS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
import type { AilyConnectionOptions } from './adapter.ts'
import { resolveAccessToken } from './auth.ts'
import type { AilyPreset } from './types.ts'

export {
  AilyAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRESETS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
export type { AilyAdapterOptions, AilyConnectionOptions } from './adapter.ts'
export type * from './types.ts'

export const name = 'llm-aily'
export const inject = ['llm']

const NS = settingsNamespace('llm-aily')
/** The single provider route this plugin owns. */
const PROVIDER = 'aily'

export const PUBLIC_BASE_URL = 'https://api.aily.pro'

/** Default `.aily` login-file path on the current host. */
export function defaultTokenFile(): string {
  const localAppData = process.env.LOCALAPPDATA
  const root = localAppData && localAppData.length > 0
    ? localAppData
    : join(os.homedir(), 'AppData', 'Local')
  return join(root, 'aily-project', '.aily')
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-aily` settings-section shape. Every field is optional in yml: the
 * token file defaults to the aily-blockly login file, and a missing token
 * resolves per request (failing with `MISSING_CREDENTIAL`, not at plugin load).
 */
export interface Config {
  /** Base URL of the aily services API. */
  baseUrl?: string
  /** Path of the aily-login token file (`.aily`). */
  tokenFile?: string
  /** Preset id used when a requested model id is not in the catalog. */
  defaultPreset?: string
  /** Selectable presets; defaults to Auto / Aily Max / Aily Fast. */
  presets?: AilyPreset[]
  /** Context capacity used when a preset has no exact value (default 800,000). */
  defaultContextWindow?: number
  /** Default per-request output cap (default 65,536). */
  defaultMaxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated base64 image payload per request. */
  maxRequestImageBytes?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig
}

const presetSchema: z<AilyPreset> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])).min(1).default(['text']),
  supportsReasoningEffort: z.array(z.string()).min(1),
  defaultReasoningEffort: z.string(),
})

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(PUBLIC_BASE_URL),
  tokenFile: z.string().role('path'),
  defaultPreset: z.string().default('auto'),
  presets: z.array(presetSchema).default([...DEFAULT_PRESETS]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  retryPolicy: RetryPolicySchema,
})

/** Validate, detach, and default one config snapshot into connection facts. */
export function resolveAdapterOptions(config: Config): AilyConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-aily: defaultContextWindow must be a positive integer')
  }
  if (config.defaultMaxTokens !== undefined
    && (!Number.isSafeInteger(config.defaultMaxTokens) || config.defaultMaxTokens <= 0)) {
    throw new Error('llm-aily: defaultMaxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-aily: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-aily: maxRequestImageBytes must be a positive safe integer')
  }
  const presets = resolvePresets(config.presets)
  if (config.defaultPreset !== undefined && !presets.some(preset => preset.id === config.defaultPreset)) {
    throw new Error(`llm-aily: defaultPreset "${config.defaultPreset}" is not in the preset catalog`)
  }
  return {
    baseURL: (config.baseUrl ?? PUBLIC_BASE_URL).replace(/\/$/, ''),
    tokenFile: config.tokenFile ?? defaultTokenFile(),
    defaultPreset: config.defaultPreset ?? 'auto',
    presets,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-aily: retryPolicy'),
  }
}

/** Validate the preset catalog: non-empty ids, unique ids, valid modalities. */
function resolvePresets(presets: readonly AilyPreset[] | undefined): readonly AilyPreset[] {
  const seen = new Set<string>()
  return (presets ?? DEFAULT_PRESETS).map(preset => {
    if (preset.id.length === 0) throw new Error('llm-aily: preset ids must be non-empty')
    if (seen.has(preset.id)) throw new Error(`llm-aily: duplicate preset "${preset.id}"`)
    seen.add(preset.id)
    const modalities = preset.inputModalities ?? ['text']
    if (modalities.length === 0) throw new Error(`llm-aily: preset "${preset.id}" inputModalities must not be empty`)
    if (modalities.some(modality => modality !== 'text' && modality !== 'image')) {
      throw new Error(`llm-aily: preset "${preset.id}" inputModalities must contain only "text" and "image"`)
    }
    return {
      id: preset.id,
      ...preset.name === undefined ? {} : { name: preset.name },
      ...preset.description === undefined ? {} : { description: preset.description },
      ...preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow },
      ...preset.maxTokens === undefined ? {} : { maxTokens: preset.maxTokens },
      inputModalities: [...modalities],
      ...preset.supportsReasoningEffort === undefined
        ? {}
        : { supportsReasoningEffort: [...preset.supportsReasoningEffort] },
      ...preset.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: preset.defaultReasoningEffort },
    }
  })
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: AilyConnectionOptions | undefined
  const options = (): AilyConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-aily: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveToken = async (): Promise<string> => {
    const connection = options()
    return resolveAccessToken(connection.baseURL, connection.tokenFile)
  }

  const adapter = new AilyAdapter({
    options,
    resolveToken,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Aily 额度', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: source => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
