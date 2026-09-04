/**
 * End-to-end test against the real OpenCode services:
 *   models.opencode.ai/api.json  and  opencode.ai/zen/v1
 *
 * Skipped unless OPENCODE_E2E=1, because each run makes real inference calls
 * that count against the anonymous per-IP daily quota
 * (upstream-opencode/packages/console/app/src/routes/zen/util/ipRateLimiter.ts).
 * It sends at most three completions per run and stops at the first model that
 * works -- it does not sweep the catalog looking for one that will answer.
 *
 *   OPENCODE_E2E=1 npm run test:e2e
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/server.ts"
import { loadConfig } from "../src/config.ts"
import { readSse } from "./helpers.ts"

const enabled = process.env.OPENCODE_E2E === "1"
const MAX_MODEL_ATTEMPTS = 3

describe("end to end against live OpenCode services", { skip: enabled ? false : "set OPENCODE_E2E=1 to run" }, () => {
  let base = ""
  let close: () => Promise<void> = async () => {}
  /** First free model that actually answered; reused by the streaming test. */
  let workingModel: string | undefined

  before(async () => {
    const config = loadConfig({
      // No OPENCODE_MODELS_URL / OPENCODE_ZEN_URL: exercise the real defaults.
      ...(process.env.OPENCODE_API_KEY ? { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY } : {}),
    } as NodeJS.ProcessEnv)
    const app = createApp(config)
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve))
    const { port } = app.server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
    close = () => new Promise<void>((resolve) => app.server.close(() => resolve()))
  })

  after(() => close())

  it("reports healthy against the real catalog", async () => {
    const res = await fetch(`${base}/health`)
    const body = (await res.json()) as any
    assert.equal(res.status, 200)
    assert.equal(body.catalog.zen_url, "https://opencode.ai/zen/v1", "Zen URL comes from the live catalog")
    assert.ok(body.catalog.free_models > 0)
  })

  it("discovers free models dynamically from models.opencode.ai", async () => {
    const res = await fetch(`${base}/v1/models`)
    const body = (await res.json()) as any

    assert.equal(res.status, 200)
    assert.equal(body.object, "list")
    assert.ok(body.data.length > 0, "the live catalog must yield at least one free model")
    for (const model of body.data) {
      assert.equal(model.opencode.free, true)
      assert.equal(model.owned_by, "opencode")
    }
    // Not a static list: ids are whatever the catalog says today.
    console.log(`  free models today (${body.data.length}):`, body.data.map((m: any) => m.id).join(", "))
  })

  it("completes a non-streaming request on a free model", async () => {
    const models = ((await (await fetch(`${base}/v1/models`)).json()) as any).data as { id: string }[]
    const candidates = models.map((m) => m.id).slice(0, MAX_MODEL_ATTEMPTS)

    let lastError = ""
    for (const model of candidates) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
          max_tokens: 64,
        }),
      })
      const body = (await res.json()) as any

      if (res.status === 429) {
        console.log(`  skipping: anonymous daily quota reached (retry-after ${res.headers.get("retry-after")})`)
        return
      }
      if (!res.ok) {
        // Anonymous access works, but an individual model's backing endpoint can
        // be retired or briefly flaky. Probed all 9 free models on 2026-09-04:
        // six answered (two only after a retry), deepseek-v4-flash-free returned
        // 400 "Model is unavailable" and the two muse-spark-*-contributor-free
        // returned 500 -- and NONE returned AuthError. So a failure here is an
        // upstream availability problem, not an auth problem. Try the next one.
        lastError = `${model} -> ${res.status} ${JSON.stringify(body?.error ?? body)}`
        console.log(`  ${model}: unavailable (${res.status}), trying the next free model`)
        continue
      }

      assert.equal(body.object, "chat.completion")
      assert.equal(typeof body.choices?.[0]?.message?.role, "string")
      assert.equal(typeof body.usage?.total_tokens, "number")
      workingModel = model
      console.log(`  ${model}: ${body.usage.total_tokens} tokens, finish_reason=${body.choices[0].finish_reason}`)
      return
    }
    assert.fail(`no free model completed a request. Last failure: ${lastError}`)
  })

  it("streams a request on a free model", async () => {
    if (!workingModel) {
      console.log("  skipping: no working free model was established by the non-streaming test")
      return
    }

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: workingModel,
        messages: [{ role: "user", content: "Count: 1 2 3" }],
        max_tokens: 64,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    if (res.status === 429) {
      console.log("  skipping: anonymous daily quota reached")
      return
    }
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)

    const text = await readSse(res)
    const dataFrames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice("data: ".length))

    assert.ok(dataFrames.length > 1, "expected more than just a terminator")
    assert.equal(dataFrames.at(-1), "[DONE]", "[DONE] must be the last data frame")

    const chunks = dataFrames.filter((f) => f !== "[DONE]").map((f) => JSON.parse(f))
    // An upstream that dies mid-stream is a documented free-tier failure mode,
    // and this server reports it as an error frame. That is correct behaviour,
    // not a re-framing bug, so distinguish it from an assertion failure.
    const upstreamDied = chunks.find((c) => c.error !== undefined)
    if (upstreamDied) {
      console.log(`  skipping: upstream ended the stream early (${upstreamDied.error.message})`)
      return
    }
    assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"), "every data frame is a real chunk")
    assert.ok(chunks.some((c) => c.usage), "the usage chunk survives re-framing")
    console.log(`  ${workingModel}: ${chunks.length} chunks`)
  })

  it("refuses a paid model when running anonymously", async () => {
    if (process.env.OPENCODE_API_KEY) {
      console.log("  skipping: OPENCODE_API_KEY is set, paid models are allowed")
      return
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 404)
    assert.equal(((await res.json()) as any).error.code, "model_not_found")
  })
})
