/**
 * Translate aily SSE events into harness {@link StreamChunk}s: one open block
 * per reasoning / text / tool-call stream, deferred `block-end`s, a single
 * `usage`, and a terminal `finish`. Unknown or advisory events (`response_*`,
 * `markdown_delta` aliases) are either mapped or ignored. The aily stream may
 * emit a `text_delta` `max_tokens` stop reason, so `LENGTH`/`MAX_TOKENS` map to
 * `max-tokens`.
 *
 * @module @deepseek-ai/dsh-llm-aily/translate
 */

import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ParsedAilyEvent } from './sse.ts'
import type { AilyUsage } from './types.ts'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
}

/** Map aily wire usage to disjoint harness token counts (cache reads subtracted). */
export function mapUsage(usage: AilyUsage | undefined): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : typeof usage.promptTokens === 'number'
      ? usage.promptTokens
      : undefined
  const completion = typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : typeof usage.completionTokens === 'number'
      ? usage.completionTokens
      : undefined
  if (prompt === undefined || completion === undefined) return undefined
  const cacheRead = typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined
  const reasoning = typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
    ? usage.completion_tokens_details.reasoning_tokens
    : undefined
  const out: TokenUsage = { inputTokens: prompt - (cacheRead && cacheRead > 0 ? cacheRead : 0), outputTokens: completion }
  if (cacheRead !== undefined && cacheRead > 0) out.cacheReadTokens = cacheRead
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  return out
}

/** Map the aily stop reason to a harness finish reason. */
export function mapStopReason(reason: string | undefined, hasBlocks: boolean): FinishReason {
  const r = String(reason ?? '').toUpperCase()
  if (r === 'COMPLETED' || r === 'STOP' || r === 'END_TURN' || r === '') return { kind: 'stop' }
  if (r === 'TOOL_CALLS' || r === 'TOOL_CALL' || r === 'TOOLS') return { kind: 'tool-calls' }
  if (r === 'LENGTH' || r === 'MAX_TOKENS' || r === 'MAX_TOKENS_REACHED') return { kind: 'max-tokens' }
  if (hasBlocks) return { kind: 'stop' }
  return { kind: 'error', failure: { message: `aily: model stopped: ${String(reason)}`, code: r } }
}

/** Translate the aily event stream into harness stream chunks. */
export async function* translate(
  events: AsyncIterable<ParsedAilyEvent>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  let pendingUsage: TokenUsage | undefined
  let pendingStop: string | undefined
  let streamError: string | undefined
  let hasBlocks = false

  for await (const { event, data } of events) {
    if (event === 'thinking' || event === 'thinking_delta') {
      const text = event === 'thinking' ? data?.content : data?.text
      if (typeof text === 'string' && text.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = { index: nextIndex++, kind: 'reasoning', text: '' }
          hasBlocks = true
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += text
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text }
      }
    } else if (event === 'text_delta' || event === 'markdown_delta') {
      const text = event === 'text_delta' ? data?.content : data?.text
      if (typeof text === 'string' && text.length > 0) {
        if (!textBlock) {
          textBlock = { index: nextIndex++, kind: 'text', text: '' }
          hasBlocks = true
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += text
        yield { type: 'text-delta', index: textBlock.index, text }
      }
    } else if (event === 'tool_call') {
      const id = typeof data?.tool_id === 'string' ? data.tool_id : ''
      const name = typeof data?.tool_name === 'string' ? data.tool_name : ''
      let args = ''
      if (typeof data?.tool_args === 'string') args = data.tool_args
      else if (data?.tool_args) args = JSON.stringify(data.tool_args)
      const index = nextIndex++
      hasBlocks = true
      const callId = id.length > 0 ? (id as Parameters<typeof CallId>[0]) : (`call-${index}` as Parameters<typeof CallId>[0])
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: CallId(callId), name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: CallId(callId), name, arguments: args } }
    } else if (event === 'usage') {
      const usage = mapUsage(data?.usage)
      if (usage) pendingUsage = usage
    } else if (event === 'response_complete') {
      if (data?.stop_reason !== undefined) pendingStop = data.stop_reason
    } else if (event === 'done') {
      if (data?.stop_reason !== undefined) pendingStop = data.stop_reason
      const usage = mapUsage(data?.usage)
      if (usage) pendingUsage = usage
    } else if (event === 'error') {
      streamError = data
        ? (typeof data.message === 'string' && data.message.length > 0
          ? data.message
          : String(data.code ?? data.message ?? 'unknown'))
        : 'aily service error'
    }
  }

  if (streamError !== undefined) throw new LlmError(`aily: ${streamError}`, 'INVALID_REQUEST')

  if (textBlock) {
    yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
  }
  if (reasoningBlock) {
    yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: mapStopReason(pendingStop, hasBlocks) }
}
