/**
 * Serialize a harness {@link GenerateOptions} request into the aily
 * `/api/v2/chat_stateless` body. Tool results arrive as harness `user`-role
 * messages carrying a `tool-result` block; the aily wire expects a `tool`-role
 * message with `tool_call_id` and the resolved tool `name` (tracked from the
 * preceding assistant tool-call block in the same request). Reasoning content
 * must be replayed as `reasoning_content` on assistant messages, or the
 * thinking-mode API rejects the turn.
 *
 * @module @deepseek-ai/dsh-llm-aily/serialize
 */

import type { GenerateOptions, Message, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AilyContentPart, AilyMessage, AilyRequestBody } from './types.ts'
import type { AilyPreset } from './types.ts'

/** Concatenate the text blocks of one content list (used for tool results). */
function concatText(blocks: readonly ContentBlock[] | undefined): string {
  let out = ''
  for (const block of blocks ?? []) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      out += (block as { text: string }).text
    }
  }
  return out
}

/** Resolve which preset id a harness model id selects (identity; kept explicit). */
export function resolvePresetId(model: string, _presetIds: readonly string[]): string {
  return model
}

/** Encode raw bytes as base64 without relying on Buffer (portable and async-free). */
export function base64Encode(bytes: Uint8Array): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] ?? 0 : 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHA[(n >> 18) & 63]
    out += ALPHA[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHA[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHA[n & 63] : '='
  }
  return out
}

/** Build one image content part from a durable attachment reference. */
async function imagePart(
  attachment: ContentBlock & { type: 'image' },
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<AilyContentPart> {
  if (attachments === undefined) {
    throw new Error('aily: image input requires the durable attachment service')
  }
  const stored = await attachments.readImage(attachment.attachment, signal)
  if (!stored || !stored.data) throw new Error('aily: failed to read image bytes')
  const mediaType = stored.ref?.mediaType ?? 'image/png'
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64Encode(stored.data) },
    detail: 'auto',
  }
}

/**
 * Serialize one harness message into the aily wire shape. `nameByCallId`
 * carries tool-call names forward from assistant messages so later tool
 * results can attach the name the server requires.
 */
async function toServiceMessage(
  message: Message,
  nameByCallId: Map<string, string>,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<AilyMessage | AilyMessage[] | null> {
  const blocks = message.content
  const hasToolResult = blocks.some(block => block.type === 'tool-result')
  if (hasToolResult) {
    const out: AilyMessage[] = []
    for (const block of blocks) {
      if (block.type !== 'tool-result') continue
      const callId = block.toolCallId
      out.push({
        role: 'tool',
        tool_call_id: callId,
        name: nameByCallId.get(callId) ?? 'tool',
        content: (block.isError ? '[tool error] ' : '') + concatText(block.content),
      })
    }
    return out.length === 0 ? null : out
  }

  const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
  const parts: AilyContentPart[] = []
  let reasoning = ''
  const toolCalls: NonNullable<AilyMessage['tool_calls']> = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      reasoning += block.text
    } else if (block.type === 'tool-call') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      })
      nameByCallId.set(block.id, block.name)
    } else if (block.type === 'image') {
      parts.push(await imagePart(block as ContentBlock & { type: 'image' }, attachments, signal))
    }
  }

  const msg: AilyMessage = { role, content: parts.length === 0 ? '' : parts }
  const only = parts[0]
  if (parts.length === 1 && only?.type === 'text') msg.content = only.text as string
  if (reasoning.length > 0) msg.reasoning_content = reasoning
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

/**
 * Serialize the full request body. `catalog` is used only to fall back to the
 * configured default preset; the harness model id is the aily preset id.
 */
export async function serializeRequest(
  options: GenerateOptions,
  catalog: readonly AilyPreset[],
  defaultPreset: string,
  attachments: AttachmentStore | undefined,
): Promise<AilyRequestBody> {
  const presetIds = catalog.map(preset => preset.id)
  const body: AilyRequestBody = { messages: [], model_preset_id: defaultPreset }

  if (typeof options.system === 'string' && options.system.length > 0) {
    body.messages.push({ role: 'system', content: options.system })
  }

  const nameByCallId = new Map<string, string>()
  for (const message of options.messages ?? []) {
    const wire = await toServiceMessage(message, nameByCallId, attachments, options.signal)
    if (Array.isArray(wire)) body.messages.push(...wire)
    else if (wire !== null) body.messages.push(wire)
  }

  const requested = typeof options.model === 'string' && options.model.trim().length > 0
    ? options.model.trim()
    : ''
  body.model_preset_id = requested.length > 0 ? resolvePresetId(requested, presetIds) : defaultPreset

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: tool.parameters ?? {},
    }))
  }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature
  }
  if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    body.max_tokens = Math.floor(options.maxTokens)
  }
  if (options.reasoningEffort !== undefined && typeof options.reasoningEffort === 'string') {
    body.reasoning_effort = options.reasoningEffort
  }
  return body
}
