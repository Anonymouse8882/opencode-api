import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/server.ts"
import { loadConfig } from "../src/config.ts"
import { backoffMs, isRetriableStatus, parseRetryAfter } from "../src/opencode/zen.ts"
import { startFakeUpstream, catalogFixture, type FakeUpstream } from "./helpers.ts"

const FREE = { cost: { input: 0, output: 0 } }
const CATALOG = { catalog: catalogFixture({ "free-a": FREE }), served: ["free-a"] }

interface Harness {
  readonly base: string
  readonly upstream: FakeUpstream
  close(): Promise<void>
}

const started: Harness[] = []
after(async () => {
  for (const h of started) await h.close()
})

async function start(
  options: Parameters<typeof startFakeUpstream>[0],
  env: Record<string, string> = {},
): Promise<Harness> {
  const upstream = await startFakeUpstream(options)
  const config = loadConfig({
    OPENCODE_MODELS_URL: upstream.url,
    OPENCODE_ZEN_URL: upstream.zenUrl,
    OPENCODE_RETRY_BASE_MS: "10",
    ...env,
  } as NodeJS.ProcessEnv)
  const app = createApp(config)
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve))
  const { port } = app.server.address() as AddressInfo
  const harness: Harness = {
    base: `http://127.0.0.1:${port}`,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      await upstream.close().catch(() => {})
    },
  }
  started.push(harness)
  return harness
}

function post(base: string, body: Record<string, unknown> = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }], ...body }),
  })
}

function respond(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

const ZEN_503 = {
  error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Endpoint is unavailable." },
}

describe("retry helpers", () => {
  it("retries only transient statuses", () => {
    for (const status of [408, 500, 502, 503, 504]) assert.equal(isRetriableStatus(status), true, `${status}`)
    for (const status of [200, 400, 401, 403, 404, 409, 422, 429]) {
      assert.equal(isRetriableStatus(status), false, `${status} must not be retried`)
    }
  })

  it("parses Retry-After as seconds or as an HTTP date", () => {
    assert.equal(parseRetryAfter("30"), 30_000)
    assert.equal(parseRetryAfter("0"), 0)
    assert.equal(parseRetryAfter(null), undefined)
    assert.equal(parseRetryAfter(""), undefined)
    assert.equal(parseRetryAfter("garbage"), undefined)
    const now = Date.parse("2026-01-01T00:00:00Z")
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now), 10_000)
    // A date already in the past must not produce a negative wait.
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now + 5_000), 0)
  })

  it("uses full jitter so instances do not retry in lockstep", () => {
    assert.equal(backoffMs(1, 250, () => 0), 0)
    assert.equal(backoffMs(1, 250, () => 0.999), 249)
    assert.equal(backoffMs(2, 250, () => 0.999), 499)
    assert.equal(backoffMs(3, 250, () => 0.999), 999)
  })
})

describe("retrying transient upstream failures", () => {
  it("recovers from the 503 pattern seen on real free models", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res, attempt) => {
        if (attempt < 3) return respond(res, 503, ZEN_503)
        respond(res, 200, { id: "gen-1", object: "chat.completion", choices: [] })
      },
    })

    const res = await post(h.base)
    assert.equal(res.status, 200)
    assert.equal(h.upstream.completionAttempts, 3)
    assert.equal(res.headers.get("x-opencode-attempts"), "3")
  })

  it("gives up after the configured number of retries and returns the real error", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res) => respond(res, 503, ZEN_503),
    })

    const res = await post(h.base)
    assert.equal(res.status, 503)
    assert.equal(h.upstream.completionAttempts, 3, "1 attempt + 2 retries")
    const body = (await res.json()) as any
    assert.equal(body.error.opencode.attempts, 3)
    assert.ok(body.error.message.includes("Endpoint is unavailable"))
  })

  it("can be disabled entirely", async () => {
    const h = await start(
      { ...CATALOG, completions: (_b, _r, res) => respond(res, 503, ZEN_503) },
      { OPENCODE_MAX_RETRIES: "0" },
    )
    assert.equal((await post(h.base)).status, 503)
    assert.equal(h.upstream.completionAttempts, 1)
  })

  it("retries a streaming request too, since nothing has been written yet", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res, attempt) => {
        if (attempt < 2) return respond(res, 503, ZEN_503)
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"g","object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}\n\n')
        res.write("data: [DONE]\n\n")
        res.end()
      },
    })

    const res = await post(h.base, { stream: true })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
    assert.equal(h.upstream.completionAttempts, 2)
  })
})

describe("failures that must NOT be retried", () => {
  it("never retries 429 -- retrying a rate limit would be limit evasion", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res) =>
        respond(
          res,
          429,
          { type: "error", error: { type: "FreeUsageLimitError", message: "Rate limit exceeded" }, metadata: {} },
          { "retry-after": "3600" },
        ),
    })

    const res = await post(h.base)
    assert.equal(res.status, 429)
    assert.equal(h.upstream.completionAttempts, 1, "exactly one upstream call")
    assert.equal(res.headers.get("retry-after"), "3600")
    assert.equal(((await res.json()) as any).error.type, "rate_limit_error")
  })

  it("never retries deterministic 4xx", async () => {
    for (const status of [400, 401, 403, 404]) {
      const h = await start({
        ...CATALOG,
        completions: (_body, _req, res) =>
          respond(res, status, { error: { type: "server_error", message: "Model is unavailable." } }),
      })
      const res = await post(h.base)
      assert.equal(res.status, status)
      assert.equal(h.upstream.completionAttempts, 1, `${status} must not be retried`)
    }
  })

  it("honours a short Retry-After on a retriable status", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res, attempt) => {
        if (attempt < 2) return respond(res, 503, ZEN_503, { "retry-after": "1" })
        respond(res, 200, { id: "gen-1", object: "chat.completion", choices: [] })
      },
    })
    const startedAt = Date.now()
    const res = await post(h.base)
    assert.equal(res.status, 200)
    assert.ok(Date.now() - startedAt >= 1000, "the requested 1s delay was observed")
  })

  it("stops retrying when upstream asks for longer than we are willing to wait", async () => {
    const h = await start({
      ...CATALOG,
      completions: (_body, _req, res) => respond(res, 503, ZEN_503, { "retry-after": "600" }),
    })
    const res = await post(h.base)
    assert.equal(res.status, 503)
    assert.equal(h.upstream.completionAttempts, 1, "a 10 minute wait is propagated, not slept through")
  })

  it("does not exceed the total request budget by retrying", async () => {
    const h = await start(
      { ...CATALOG, completions: (_b, _r, res) => respond(res, 503, ZEN_503) },
      { OPENCODE_REQUEST_TIMEOUT_MS: "1200", OPENCODE_RETRY_BASE_MS: "400" },
    )
    const startedAt = Date.now()
    const res = await post(h.base)
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 503)
    assert.ok(elapsed < 3000, `retries must stay inside the budget, took ${elapsed}ms`)
  })

  it("abandons retries when the caller disconnects mid-backoff", async () => {
    // A long backoff guarantees the abort lands while the server is sleeping
    // between attempts rather than while it is waiting on upstream.
    const h = await start(
      { ...CATALOG, completions: (_b, _r, res) => respond(res, 503, ZEN_503) },
      { OPENCODE_RETRY_BASE_MS: "2000" },
    )

    const controller = new AbortController()
    const call = fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await assert.rejects(() => call)

    const attemptsAtAbort = h.upstream.completionAttempts
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(
      h.upstream.completionAttempts,
      attemptsAtAbort,
      "no further upstream calls once the caller is gone",
    )
  })
})
