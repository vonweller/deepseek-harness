/**
 * Decode the aily SSE byte stream into typed events. The framing is the
 * standard `event:` + `data:` text/event-stream shape, decoded without an
 * external parser so this package has no runtime dependency on a parser whose
 * framing is tuned to the `[DONE]`-terminated OpenAI wire. Unlike that wire
 * there is no `[DONE]` sentinel, so EOF ends the stream cleanly.
 *
 * @module @deepseek-ai/dsh-llm-aily/sse
 */

import type { AilySseEvent } from './types.ts'

/** One decoded event: its `event` name and parsed JSON payload. */
export interface ParsedAilyEvent {
  event: string
  data: AilySseEvent | null
}

function decodeEventName(line: string): string {
  return line.startsWith('event:') ? line.slice(6).trim() : ''
}

function decodeData(lines: string[]): string {
  return lines.join('\n')
}

/**
 * Parse a UTF-8 SSE byte stream into decoded events. Frames are blank-line
 * terminated (`\n\n` after CRLF normalization); a `data:` field may span
 * several lines. Unparseable JSON yields a `null` payload so the caller can
 * skip it without aborting the stream.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @returns each event's name and payload in arrival order.
 */
export async function* parseEventStream(
  stream: ReadableStream<BufferSource>,
): AsyncGenerator<ParsedAilyEvent> {
  const decoded = stream.pipeThrough(new TextDecoderStream())
  const reader = decoded.getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value.replace(/\r\n/g, '\n')
      let idx = buffer.indexOf('\n\n')
      while (idx >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines: string[] = []
        let eventName = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = decodeEventName(line)
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length > 0) {
          const raw = decodeData(dataLines)
          let parsed: AilySseEvent | null = null
          try {
            parsed = JSON.parse(raw) as AilySseEvent
          } catch {
            parsed = null
          }
          yield { event: eventName, data: parsed }
        }
        idx = buffer.indexOf('\n\n')
      }
    }
    // A trailing unterminated frame is truncation, not a flushable event.
  } finally {
    reader.releaseLock()
  }
}
