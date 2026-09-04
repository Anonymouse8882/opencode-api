/**
 * Re-frames the OpenCode Zen SSE stream into a strictly OpenAI-shaped one.
 *
 * WHY THIS EXISTS
 * ---------------
 * Zen passes the upstream provider's SSE bytes through verbatim
 * (upstream-opencode/packages/console/app/src/routes/zen/util/handler.ts:410),
 * and then, once the stream ends, appends its own cost frame
 * (handler.ts:374 -> util/provider/provider.ts:169-180):
 *
 *     case "oa-compat":
 *       return `data: ${JSON.stringify({ choices: [], cost })}\n\n`
 *
 * Because the provider's own `data: [DONE]` has already gone out by then, the
 * wire order is:
 *
 *     data: {...final chunk with usage...}
 *     data: [DONE]
 *     data: {"choices":[],"cost":"0"}      <- after the terminator
 *
 * Observed live on 2026-09-03. A strict OpenAI client stops reading at [DONE];
 * a lenient one may try to parse a chunk with no `id` and no `object`.
 *
 * This reframer holds the terminator back, converts anything that arrives after
 * it into SSE comments (which every client ignores, so the cost figure is
 * preserved rather than dropped), and re-emits `data: [DONE]` last.
 *
 * `: keep-alive` comments from Zen are forwarded untouched -- they are what
 * keeps intermediaries from timing the connection out.
 */

/** handler.ts:397 `buffer.split(/\r\n\r\n|\n\n|\r\r/)` -- the same framing. */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/

const DONE_PAYLOAD = "[DONE]"

function dataPayload(frame: string): string | undefined {
  const lines = frame.split(/\r\n|\n|\r/)
  const data: string[] = []
  for (const line of lines) {
    if (!line.startsWith("data:")) continue
    data.push(line.slice("data:".length).trimStart())
  }
  return data.length === 0 ? undefined : data.join("\n")
}

function asComment(frame: string): string {
  const body = frame
    .split(/\r\n|\n|\r/)
    .map((line) => `: ${line}`)
    .join("\n")
  return `${body}\n\n`
}

export class SseReframer {
  #buffer = ""
  #sawDone = false

  /** Feed decoded text; returns the bytes-worth of text to forward downstream. */
  push(text: string): string {
    this.#buffer += text
    const parts = this.#buffer.split(FRAME_SEPARATOR)
    this.#buffer = parts.pop() ?? ""
    let out = ""
    for (const part of parts) out += this.#frame(part)
    return out
  }

  /**
   * Flush at end of stream.
   *
   * `[DONE]` is re-emitted only when upstream actually sent one. A stream that
   * ends without it ended abnormally, and inventing a terminator would tell the
   * caller the completion finished cleanly when it did not.
   */
  flush(): string {
    let out = ""
    if (this.#buffer.trim() !== "") {
      out += this.#frame(this.#buffer)
      this.#buffer = ""
    }
    if (this.#sawDone) out += `data: ${DONE_PAYLOAD}\n\n`
    return out
  }

  /** True when upstream sent its terminator, i.e. the stream ended cleanly. */
  get completed(): boolean {
    return this.#sawDone
  }

  #frame(raw: string): string {
    const frame = raw.trim()
    if (frame === "") return ""

    const payload = dataPayload(frame)

    if (payload === DONE_PAYLOAD) {
      this.#sawDone = true
      return ""
    }

    // Anything after the terminator (Zen's cost frame) becomes a comment.
    if (this.#sawDone) return asComment(frame)

    return `${frame}\n\n`
  }
}

/** Convenience for tests: run a whole stream through the reframer. */
export function reframe(chunks: readonly string[]): string {
  const reframer = new SseReframer()
  let out = ""
  for (const chunk of chunks) out += reframer.push(chunk)
  return out + reframer.flush()
}

/** An OpenAI-style mid-stream error frame, used when upstream dies part-way. */
export function errorFrame(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`
}
