import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { SseReframer, reframe } from "../src/adapter/sse.ts"

describe("SseReframer", () => {
  it("forwards ordinary chunks unchanged and keeps [DONE] last", () => {
    const out = reframe([
      'data: {"id":"a","choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"id":"a","choices":[{"delta":{"content":"llo"}}]}\n\n',
      "data: [DONE]\n\n",
    ])
    assert.equal(
      out,
      'data: {"id":"a","choices":[{"delta":{"content":"he"}}]}\n\n' +
        'data: {"id":"a","choices":[{"delta":{"content":"llo"}}]}\n\n' +
        "data: [DONE]\n\n",
    )
  })

  it("moves Zen's post-[DONE] cost frame into a comment so [DONE] terminates the stream", () => {
    // Exact wire order observed from opencode.ai/zen/v1, produced by
    // buildCostChunk() in zen/util/provider/provider.ts:176.
    const out = reframe([
      'data: {"id":"a","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[],"cost":"0"}\n\n',
    ])

    const frames = out.split("\n\n").filter((f) => f !== "")
    assert.equal(frames.at(-1), "data: [DONE]")
    assert.ok(out.includes(': data: {"choices":[],"cost":"0"}'), "cost frame is preserved as a comment")
    assert.equal(out.indexOf('"cost"') < out.lastIndexOf("data: [DONE]"), true)
    // No client-visible data frame after the terminator.
    assert.equal(frames.filter((f) => f.startsWith("data: ")).at(-1), "data: [DONE]")
  })

  it("passes keep-alive comments through", () => {
    const out = reframe([": keep-alive\n\n", 'data: {"x":1}\n\n', "data: [DONE]\n\n"])
    assert.ok(out.startsWith(": keep-alive\n\n"))
  })

  it("handles frames split across chunk boundaries", () => {
    const out = reframe(['data: {"id":"a","choi', 'ces":[]}\n', "\ndata: [DONE]\n\n"])
    assert.equal(out, 'data: {"id":"a","choices":[]}\n\ndata: [DONE]\n\n')
  })

  it("does not invent a terminator when upstream ends abruptly", () => {
    const reframer = new SseReframer()
    let out = reframer.push('data: {"id":"a"}\n\n')
    out += reframer.flush()
    assert.equal(reframer.completed, false)
    assert.equal(out.includes("[DONE]"), false)
  })

  it("reports completion when upstream did terminate", () => {
    const reframer = new SseReframer()
    reframer.push('data: {"id":"a"}\n\ndata: [DONE]\n\n')
    assert.equal(reframer.completed, true)
  })

  it("emits a trailing frame that never got its blank-line separator", () => {
    const out = reframe(['data: {"id":"a"}'])
    assert.equal(out, 'data: {"id":"a"}\n\n')
  })

  it("accepts CRLF framing", () => {
    const out = reframe(['data: {"id":"a"}\r\n\r\ndata: [DONE]\r\n\r\n'])
    assert.equal(out, 'data: {"id":"a"}\n\ndata: [DONE]\n\n')
  })
})
