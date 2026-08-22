/**
 * aily adapter wire types (the `aily.services` protocol).
 *
 * The aily chat backend exposes a proprietary SSE endpoint
 * (`POST /api/v2/chat_stateless`) whose request shape is a small superset of
 * OpenAI chat-completions messages plus a `model_preset_id` routing field, and
 * whose response is a text/event-stream of typed events. Only the fields this
 * adapter reads or writes are declared here; everything else is advisory.
 *
 * @module @deepseek-ai/dsh-llm-aily/types
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'

/** One selectable aily product preset (the only routable model shape). */
export interface AilyPreset {
  /** Preset id sent as `model_preset_id` (e.g. `auto-max`). */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap; omission falls back to the profile default. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /** Advertised reasoning efforts (e.g. `low`, `medium`, `high`, `xhigh`). */
  supportsReasoningEffort?: string[]
  /** Adapter-configured default reasoning effort. */
  defaultReasoningEffort?: string
}

/** One parsed SSE event from the aily stream. */
export interface AilySseEvent {
  type: string
  id?: string
  content?: string
  text?: string
  value?: unknown
  tool_id?: string
  tool_name?: string
  tool_args?: string
  stop_reason?: string
  usage?: AilyUsage
  code?: string
  message?: string
}

/** Wire token accounting for one completion. `prompt_tokens` includes cache reads. */
export interface AilyUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  promptTokens?: number
  completionTokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One message part the aily endpoint accepts. */
export interface AilyContentPart {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
  detail?: string
}

/** One message sent to the aily endpoint. */
export interface AilyMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | AilyContentPart[]
  reasoning_content?: string
  tool_call_id?: string
  name?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

/** The full request body for `POST /api/v2/chat_stateless`. */
export interface AilyRequestBody {
  messages: AilyMessage[]
  model_preset_id: string
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[]
  temperature?: number
  max_tokens?: number
  reasoning_effort?: string
}
