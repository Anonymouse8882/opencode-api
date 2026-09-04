/**
 * HTTP surface: an OpenAI-compatible facade over the OpenCode Zen gateway.
 *
 * Routes
 *   GET  /health                  liveness + catalog/upstream state
 *   GET  /v1/models               free models, OpenAI list shape
 *   GET  /v1/models/:id
 *   POST /v1/chat/completions     buffered or SSE, per `stream`
 *   GET  /opencode/catalog        the raw discovery result, for debugging
 */
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Catalog, type CatalogSnapshot } from "./opencode/catalog.ts"
import { ZenClient, ZenTransportError } from "./opencode/zen.ts"
import { type MappedError, localError, mapUpstreamError } from "./opencode/errors.ts"
import { SseReframer, errorFrame } from "./adapter/sse.ts"
import { parseChatCompletionRequest, toOpenAIModel, toOpenAIModelList } from "./adapter/openai.ts"
import { type Config, describeConfig } from "./config.ts"

const MAX_BODY_BYTES = 10 * 1024 * 1024

export interface App {
  readonly server: http.Server
  readonly catalog: Catalog
  readonly zen: ZenClient
  readonly config: Config
}

export function createApp(config: Config): App {
  const catalog = new Catalog(config)
  const zen = new ZenClient(config)
  const startedAt = Date.now()

  const server = http.createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      // Last-resort guard; every expected failure is handled inline.
      if (!res.headersSent) {
        sendError(res, localError(500, `unhandled server error: ${describe(cause)}`))
      } else {
        res.end()
      }
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = req.method ?? "GET"

    res.setHeader("access-control-allow-origin", "*")
    if (method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
      res.setHeader("access-control-allow-headers", "content-type, authorization")
      res.writeHead(204).end()
      return
    }

    if (method === "GET" && (path === "/health" || path === "/")) return health(res)
    if (method === "GET" && path === "/v1/models") return listModels(res)
    if (method === "GET" && path.startsWith("/v1/models/")) {
      const encoded = path.slice("/v1/models/".length)
      let id: string
      try {
        id = decodeURIComponent(encoded)
      } catch {
        // decodeURIComponent throws URIError on an invalid escape. That is a
        // malformed client request, not a server fault.
        sendError(res, localError(400, `model id ${JSON.stringify(encoded)} is not valid URL encoding`, {
          type: "invalid_request_error",
          code: "invalid_request",
        }))
        return
      }
      return getModel(res, id)
    }
    if (method === "GET" && path === "/opencode/catalog") return rawCatalog(res)
    if (method === "POST" && path === "/v1/chat/completions") return chatCompletions(req, res)

    if (path === "/v1/chat/completions" || path === "/v1/models" || path === "/health") {
      sendError(res, localError(405, `${method} is not allowed on ${path}`, { code: "method_not_allowed" }))
      return
    }
    sendError(res, localError(404, `unknown route ${method} ${path}`, { code: "unknown_route" }))
  }

  async function health(res: ServerResponse): Promise<void> {
    let snapshot: CatalogSnapshot | undefined
    let error: string | undefined
    try {
      snapshot = await catalog.get()
    } catch (cause) {
      error = describe(cause)
    }

    const healthy = snapshot !== undefined
    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? (snapshot?.stale ? "degraded" : "ok") : "unavailable",
      uptime_ms: Date.now() - startedAt,
      credential: zen.anonymous ? "anonymous" : "api-key",
      catalog: snapshot
        ? {
            zen_url: snapshot.zenUrl,
            provider: snapshot.providerName,
            free_models: snapshot.all.length,
            exposed_models: snapshot.models.length,
            served_list_reachable: snapshot.servedKnown,
            stale: snapshot.stale,
            fetched_at: new Date(snapshot.fetchedAt).toISOString(),
          }
        : null,
      config: describeConfig(config),
      ...(error ? { error } : {}),
    })
  }

  async function listModels(res: ServerResponse): Promise<void> {
    const snapshot = await catalog.get().catch((cause: unknown) => cause)
    if (!isSnapshot(snapshot)) return sendError(res, catalogFailure(snapshot))
    sendJson(res, 200, toOpenAIModelList(snapshot.models))
  }

  async function getModel(res: ServerResponse, id: string): Promise<void> {
    const snapshot = await catalog.get().catch((cause: unknown) => cause)
    if (!isSnapshot(snapshot)) return sendError(res, catalogFailure(snapshot))
    const model = snapshot.models.find((entry) => entry.id === id)
    if (!model) {
      sendError(res, localError(404, `model ${JSON.stringify(id)} is not an available free model`, {
        type: "invalid_request_error",
        code: "model_not_found",
      }))
      return
    }
    sendJson(res, 200, toOpenAIModel(model))
  }

  async function rawCatalog(res: ServerResponse): Promise<void> {
    const snapshot = await catalog.get().catch((cause: unknown) => cause)
    if (!isSnapshot(snapshot)) return sendError(res, catalogFailure(snapshot))
    sendJson(res, 200, {
      zen_url: snapshot.zenUrl,
      provider: snapshot.providerName,
      fetched_at: new Date(snapshot.fetchedAt).toISOString(),
      stale: snapshot.stale,
      served_list_reachable: snapshot.servedKnown,
      model_filter: config.modelFilter,
      models: snapshot.all,
    })
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController()
    // The caller going away must tear the upstream request down too, rather than
    // leaving an inference stream running with nobody reading it.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("client disconnected"))
    })

    const raw = await readBody(req)
    if (!raw.ok) return sendError(res, raw.error)

    let json: unknown
    try {
      json = JSON.parse(raw.text) as unknown
    } catch {
      return sendError(res, localError(400, "request body is not valid JSON", {
        type: "invalid_request_error",
        code: "invalid_json",
      }))
    }

    const parsed = parseChatCompletionRequest(json)
    if (!parsed.ok) {
      return sendError(res, localError(400, parsed.message, {
        type: "invalid_request_error",
        code: "invalid_request",
      }))
    }

    const snapshot = await catalog.get().catch((cause: unknown) => cause)
    if (!isSnapshot(snapshot)) return sendError(res, catalogFailure(snapshot))

    // Anonymously, only the free models are ours to call. Refusing here gives a
    // clearer error than the gateway's blanket 401 and keeps this server from
    // hammering the gateway with requests that cannot succeed. With a real
    // OPENCODE_API_KEY the operator's own entitlements decide, so anything goes.
    if (zen.anonymous && !snapshot.models.some((model) => model.id === parsed.value.model)) {
      return sendError(res, localError(
        404,
        `model ${JSON.stringify(parsed.value.model)} is not an available free model. ` +
          `Without OPENCODE_API_KEY only OpenCode Zen's free models can be called; see GET /v1/models.`,
        { type: "invalid_request_error", code: "model_not_found" },
      ))
    }

    let call: Awaited<ReturnType<ZenClient["chatCompletions"]>>
    try {
      call = await zen.chatCompletions({
        zenUrl: snapshot.zenUrl,
        body: parsed.value,
        signal: controller.signal,
      })
    } catch (cause) {
      return sendError(res, transportFailure(cause))
    }

    const upstream = call.response
    // Makes retries visible to the caller without any logging.
    res.setHeader("x-opencode-attempts", String(call.attempts))

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "")
      return sendError(
        res,
        mapUpstreamError({
          status: upstream.status,
          rawBody: body,
          retryAfter: upstream.headers.get("retry-after"),
          attempts: call.attempts,
        }),
      )
    }

    if (parsed.value.stream === true) return streamResponse(res, upstream, controller)
    return bufferedResponse(res, upstream)
  }

  async function bufferedResponse(res: ServerResponse, upstream: Response): Promise<void> {
    let text: string
    try {
      text = await upstream.text()
    } catch (cause) {
      // The connection dropped after headers but before the body finished.
      return sendError(res, transportFailure(cause))
    }
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    res.end(text)
  }



  async function streamResponse(
    res: ServerResponse,
    upstream: Response,
    controller: AbortController,
  ): Promise<void> {
    const body = upstream.body
    if (!body) {
      return sendError(res, localError(502, "OpenCode Zen returned a streaming response with no body"))
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops reverse proxies from buffering the stream into uselessness.
      "x-accel-buffering": "no",
    })

    const reframer = new SseReframer()
    const decoder = new TextDecoder()
    const reader = body.getReader()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await write(res, reframer.push(decoder.decode(value, { stream: true })))
      }
      // Flush any bytes the decoder held back as a partial multi-byte sequence.
      await write(res, reframer.push(decoder.decode()))
      await write(res, reframer.flush())
      if (!reframer.completed) {
        // Upstream closed without `[DONE]`: report it instead of letting the
        // caller mistake a truncated answer for a complete one.
        await write(
          res,
          errorFrame(localError(502, "the OpenCode Zen stream ended before the completion finished").body),
        )
      }
      res.end()
    } catch (cause) {
      if (controller.signal.aborted) {
        // Caller hung up; there is nobody left to tell.
        res.end()
        return
      }
      await write(res, errorFrame(transportFailure(cause).body))
      res.end()
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  return { server, catalog, zen, config }
}

/**
 * Write one SSE chunk, waiting for `drain` when the socket's buffer is full so a
 * slow reader throttles the upstream pump instead of growing Node's write queue.
 */
function write(res: ServerResponse, chunk: string): Promise<void> {
  // `destroyed` matters as much as `writableEnded`: once the socket is gone,
  // `close` has already fired and waiting on it below would never resolve.
  if (chunk === "" || res.writableEnded || res.destroyed) return Promise.resolve()
  if (res.write(chunk)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    if (res.destroyed) return resolve()
    const done = () => {
      res.off("drain", done)
      res.off("close", done)
      resolve()
    }
    res.once("drain", done)
    res.once("close", done)
  })
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  return typeof value === "object" && value !== null && "zenUrl" in value && "models" in value
}

function catalogFailure(cause: unknown): MappedError {
  return localError(503, `model discovery failed: ${describe(cause)}`, { code: "catalog_unavailable" })
}

function transportFailure(cause: unknown): MappedError {
  if (cause instanceof ZenTransportError) {
    if (cause.kind === "timeout") {
      return localError(504, cause.message, { type: "api_connection_error", code: "upstream_timeout" })
    }
    if (cause.kind === "aborted") {
      return localError(499, cause.message, { type: "api_connection_error", code: "client_disconnected" })
    }
    return localError(502, cause.message, { type: "api_connection_error", code: "upstream_unreachable" })
  }
  return localError(502, `upstream failure: ${describe(cause)}`, {
    type: "api_connection_error",
    code: "upstream_unreachable",
  })
}

interface BodyOk {
  readonly ok: true
  readonly text: string
}
interface BodyErr {
  readonly ok: false
  readonly error: MappedError
}

function readBody(req: IncomingMessage): Promise<BodyOk | BodyErr> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: BodyOk | BodyErr) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        finish({
          ok: false,
          error: localError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`, { code: "payload_too_large" }),
        })
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }))
    req.on("error", (cause) =>
      finish({ ok: false, error: localError(400, `could not read request body: ${cause.message}`) }),
    )
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

function sendError(res: ServerResponse, error: MappedError): void {
  if (res.headersSent) {
    res.end()
    return
  }
  // 499 is nginx's "client closed request"; there is no client left to read it,
  // so just close. Zen does the same (handler.ts:437-441).
  if (error.status === 499) {
    res.end()
    return
  }
  if (error.retryAfter !== undefined) res.setHeader("retry-after", error.retryAfter)
  sendJson(res, error.status, error.body)
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
