import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/server.ts"
import { loadConfig } from "../src/config.ts"
import { startFakeUpstream, catalogFixture, readSse, type FakeUpstream } from "./helpers.ts"

const FREE = { cost: { input: 0, output: 0 } }
const PAID = { cost: { input: 3, output: 15 } }

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

const DEFAULT = {
  catalog: catalogFixture({ "free-a": FREE, "free-b": FREE, "paid-c": PAID }),
  served: ["free-a", "free-b", "paid-c"],
}

describe("GET /health", () => {
  it("reports ok with catalog state and never leaks the credential", async () => {
    const h = await start(DEFAULT, { OPENCODE_API_KEY: "sk-secret-value" })
    const res = await fetch(`${h.base}/health`)
    const body = (await res.json()) as Record<string, any>

    assert.equal(res.status, 200)
    assert.equal(body.status, "ok")
    assert.equal(body.credential, "api-key")
    assert.equal(body.catalog.free_models, 2)
    assert.equal(body.catalog.zen_url, h.upstream.zenUrl)
    assert.equal(JSON.stringify(body).includes("sk-secret-value"), false, "credential must not appear anywhere")
  })

  it("does not echo OPENCODE_PUBLIC_KEY's value either", async () => {
    // An operator can mis-file a real key here; /health is unauthenticated.
    const h = await start(DEFAULT, { OPENCODE_PUBLIC_KEY: "sk-misfiled-here" })
    const body = await (await fetch(`${h.base}/health`)).json()
    assert.equal(JSON.stringify(body).includes("sk-misfiled-here"), false)
  })

  it("reports anonymous mode when no key is configured", async () => {
    const h = await start(DEFAULT)
    const body = (await (await fetch(`${h.base}/health`)).json()) as Record<string, any>
    assert.equal(body.credential, "anonymous")
  })

  it("returns 503 when discovery is broken", async () => {
    const h = await start({ catalogStatus: 500 })
    const res = await fetch(`${h.base}/health`)
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as Record<string, any>).status, "unavailable")
  })
})

describe("GET /v1/models", () => {
  it("lists only free models, in the OpenAI list shape", async () => {
    const h = await start(DEFAULT)
    const body = (await (await fetch(`${h.base}/v1/models`)).json()) as Record<string, any>

    assert.equal(body.object, "list")
    assert.deepEqual(body.data.map((m: any) => m.id).sort(), ["free-a", "free-b"])
    for (const model of body.data) {
      assert.equal(model.object, "model")
      assert.equal(model.owned_by, "opencode")
      assert.equal(model.opencode.free, true)
      assert.equal(typeof model.created, "number")
    }
  })

  it("rejects a malformed percent-escape as a client error, not a server fault", async () => {
    const h = await start(DEFAULT)
    const res = await fetch(`${h.base}/v1/models/%zz`)
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as any).error.type, "invalid_request_error")
  })

  it("serves a single model, and 404s an unknown or paid one", async () => {
    const h = await start(DEFAULT)
    const ok = await fetch(`${h.base}/v1/models/free-a`)
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as any).id, "free-a")

    const paid = await fetch(`${h.base}/v1/models/paid-c`)
    assert.equal(paid.status, 404)
    assert.equal(((await paid.json()) as any).error.code, "model_not_found")
  })
})

describe("POST /v1/chat/completions -- non-streaming", () => {
  it("proxies the body through and returns the upstream JSON verbatim", async () => {
    let seen: any
    const h = await start({
      ...DEFAULT,
      completions: (body, _req, res) => {
        seen = body
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "gen-1", object: "chat.completion", choices: [], cost: "0" }))
      },
    })

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "free-a",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.4,
        max_tokens: 16,
      }),
    })

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { id: "gen-1", object: "chat.completion", choices: [], cost: "0" })
    // Parameters this server does not model must survive the round trip.
    assert.equal(seen.temperature, 0.4)
    assert.equal(seen.max_tokens, 16)
  })

  it('authenticates anonymously with the literal "public" bearer token', async () => {
    const h = await start(DEFAULT)
    await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }] }),
    })
    const call = h.upstream.requests.find((r) => r.path === "/zen/v1/chat/completions")
    assert.equal(call?.authorization, "Bearer public")
  })

  it("uses the operator's key when one is configured", async () => {
    const h = await start(DEFAULT, { OPENCODE_API_KEY: "sk-real" })
    await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "paid-c", messages: [{ role: "user", content: "hi" }] }),
    })
    const call = h.upstream.requests.find((r) => r.path === "/zen/v1/chat/completions")
    assert.equal(call?.authorization, "Bearer sk-real")
  })

  it("refuses a paid model anonymously without calling upstream", async () => {
    const h = await start(DEFAULT)
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "paid-c", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 404)
    const body = (await res.json()) as any
    assert.equal(body.error.code, "model_not_found")
    assert.ok(body.error.message.includes("OPENCODE_API_KEY"))
    assert.equal(h.upstream.requests.some((r) => r.path === "/zen/v1/chat/completions"), false)
  })

  it("gates completions on exactly the set /v1/models exposes", async () => {
    // free-retired is free in the catalog but the gateway no longer serves it.
    const h = await start({
      catalog: catalogFixture({ "free-live": FREE, "free-retired": FREE }),
      served: ["free-live"],
    })

    const listed = ((await (await fetch(`${h.base}/v1/models`)).json()) as any).data.map((m: any) => m.id)
    assert.deepEqual(listed, ["free-live"])

    assert.equal((await fetch(`${h.base}/v1/models/free-retired`)).status, 404)

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-retired", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 404, "completions must agree with the model endpoints")
    assert.equal(h.upstream.requests.some((r) => r.path === "/zen/v1/chat/completions"), false)
  })

  it("rejects malformed requests before touching upstream", async () => {
    const h = await start(DEFAULT)
    const cases: [unknown, string][] = [
      [{ messages: [{ role: "user", content: "x" }] }, "model"],
      [{ model: "free-a" }, "messages"],
      [{ model: "free-a", messages: [] }, "messages"],
    ]
    for (const [body, param] of cases) {
      const res = await fetch(`${h.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 400)
      const parsed = (await res.json()) as any
      assert.equal(parsed.error.type, "invalid_request_error")
      assert.ok(parsed.error.message.includes(param), `${parsed.error.message} should mention ${param}`)
    }

    const bad = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as any).error.code, "invalid_json")
  })
})

describe("POST /v1/chat/completions -- upstream errors", () => {
  it("maps a Zen 429 and forwards Retry-After", async () => {
    const h = await start({
      ...DEFAULT,
      completions: (_body, _req, res) => {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1800" })
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "FreeUsageLimitError", message: "Rate limit exceeded" },
            metadata: {},
          }),
        )
      },
    })

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }] }),
    })

    assert.equal(res.status, 429, "the real rate limit is preserved, not swallowed")
    assert.equal(res.headers.get("retry-after"), "1800")
    const body = (await res.json()) as any
    assert.equal(body.error.type, "rate_limit_error")
    assert.equal(body.error.code, "free_usage_limit_exceeded")
    assert.equal(body.error.opencode.type, "FreeUsageLimitError")
  })

  it("maps a Zen AuthError even when stream was requested", async () => {
    const h = await start({
      ...DEFAULT,
      completions: (_body, _req, res) => {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { type: "AuthError", message: "Missing API key." } }))
      },
    })

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }], stream: true }),
    })

    assert.equal(res.status, 401)
    assert.match(res.headers.get("content-type") ?? "", /application\/json/)
    assert.equal(((await res.json()) as any).error.type, "authentication_error")
  })

  it("returns 502 when the gateway is unreachable", async () => {
    const h = await start(DEFAULT)
    // Warm the catalog first, so the failure under test is the completion call
    // rather than model discovery (which reports 503 instead).
    assert.equal((await fetch(`${h.base}/v1/models`)).status, 200)
    await h.upstream.close()
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 502)
    assert.equal(((await res.json()) as any).error.type, "api_connection_error")
  })
})

describe("POST /v1/chat/completions -- streaming", () => {
  it("streams SSE and re-frames Zen's post-[DONE] cost chunk", async () => {
    const h = await start({
      ...DEFAULT,
      completions: (_body, _req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(": keep-alive\n\n")
        res.write('data: {"id":"g","object":"chat.completion.chunk","choices":[{"delta":{"content":"he"}}]}\n\n')
        res.write('data: {"id":"g","object":"chat.completion.chunk","choices":[{"delta":{"content":"llo"}}]}\n\n')
        res.write("data: [DONE]\n\n")
        res.write('data: {"choices":[],"cost":"0"}\n\n')
        res.end()
      },
    })

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }], stream: true }),
    })

    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)

    const text = await readSse(res)
    const dataFrames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice("data: ".length))

    assert.equal(dataFrames.at(-1), "[DONE]", "[DONE] must be the final data frame")
    assert.equal(dataFrames.length, 3)
    assert.ok(text.includes(": keep-alive"), "keep-alive comments are forwarded")
    assert.ok(text.includes(': data: {"choices":[],"cost":"0"}'), "the cost frame survives as a comment")

    const deltas = dataFrames
      .filter((f) => f !== "[DONE]")
      .map((f) => JSON.parse(f).choices[0].delta.content)
      .join("")
    assert.equal(deltas, "hello")
  })

  it("appends an error frame when the stream ends without [DONE]", async () => {
    const h = await start({
      ...DEFAULT,
      completions: (_body, _req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"g","choices":[{"delta":{"content":"partial"}}]}\n\n')
        res.end()
      },
    })

    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }], stream: true }),
    })

    const text = await readSse(res)
    assert.ok(text.includes('"error"'), "a truncated stream is reported, not passed off as complete")
    assert.ok(text.includes("ended before the completion finished"))
    assert.equal(text.includes("[DONE]"), false, "no fabricated terminator")
  })

  it("aborts the upstream request when the caller disconnects", async () => {
    let upstreamClosed = false
    const h = await start({
      ...DEFAULT,
      completions: (_body, req, res) => {
        req.on("close", () => {
          upstreamClosed = true
        })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"g","choices":[{"delta":{"content":"tick"}}]}\n\n')
        // Deliberately never finishes.
      },
    })

    const controller = new AbortController()
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: controller.signal,
    })

    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(upstreamClosed, true, "the upstream inference stream must be torn down too")
  })
})

describe("model discovery is not bound to any one caller", () => {
  it("survives the caller that started the shared catalog fetch disconnecting", async () => {
    const h = await start({ ...DEFAULT, catalogDelayMs: 600 })
    const body = JSON.stringify({ model: "free-a", messages: [{ role: "user", content: "hi" }] })
    const send = (signal?: AbortSignal) =>
      fetch(`${h.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        ...(signal ? { signal } : {}),
      })

    const controller = new AbortController()
    const a = send(controller.signal).catch(() => "aborted")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const b = send() // joins A's in-flight catalog fetch
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()

    assert.equal(await a, "aborted")
    assert.equal((await b).status, 200, "B must not be failed by A hanging up")
  })

  it("does not cache a bogus served-list result when a caller disconnects", async () => {
    const h = await start({
      catalog: catalogFixture({ "free-live": FREE, "free-retired": FREE }),
      served: ["free-live"],
      servedDelayMs: 600,
    })

    const controller = new AbortController()
    const aborted = fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "free-live", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    }).catch(() => "aborted")
    await new Promise((resolve) => setTimeout(resolve, 200))
    controller.abort()
    await aborted

    const health = (await (await fetch(`${h.base}/health`)).json()) as any
    assert.equal(health.catalog.served_list_reachable, true, "the gateway was reachable throughout")
    const listed = ((await (await fetch(`${h.base}/v1/models`)).json()) as any).data.map((m: any) => m.id)
    assert.deepEqual(listed, ["free-live"], "a model the gateway does not serve must not be exposed")
  })
})

describe("routing", () => {
  it("404s unknown routes and 405s wrong methods, in the OpenAI error shape", async () => {
    const h = await start(DEFAULT)

    const unknown = await fetch(`${h.base}/nope`)
    assert.equal(unknown.status, 404)
    assert.equal(((await unknown.json()) as any).error.code, "unknown_route")

    const wrong = await fetch(`${h.base}/v1/chat/completions`)
    assert.equal(wrong.status, 405)
    assert.equal(((await wrong.json()) as any).error.code, "method_not_allowed")
  })

  it("answers CORS preflight", async () => {
    const h = await start(DEFAULT)
    const res = await fetch(`${h.base}/v1/models`, { method: "OPTIONS" })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get("access-control-allow-origin"), "*")
  })
})
