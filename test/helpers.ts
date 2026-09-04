/** A stand-in for models.opencode.ai + opencode.ai/zen/v1, for hermetic tests. */
import http from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeUpstreamOptions {
  /** Body returned by `GET /api.json`. */
  catalog?: unknown
  /** Ids returned by `GET /zen/v1/models`; `null` makes the endpoint fail. */
  served?: string[] | null
  /** Handler for `POST /zen/v1/chat/completions`; receives the 1-based attempt number. */
  completions?: (
    body: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    attempt: number,
  ) => void | Promise<void>
  /** Fail `GET /api.json` with this status. */
  catalogStatus?: number
  /** Delay `GET /api.json` by this long, so a request can be aborted mid-fetch. */
  catalogDelayMs?: number
  /** Delay `GET /zen/v1/models` by this long. */
  servedDelayMs?: number
}

export interface FakeUpstream {
  readonly url: string
  readonly zenUrl: string
  readonly requests: { path: string; authorization: string | undefined; userAgent: string | undefined }[]
  /** Make `GET /api.json` start failing with this status (0 restores success). */
  setCatalogStatus(status: number): void
  /** How many times POST /zen/v1/chat/completions has been hit. */
  readonly completionAttempts: number
  close(): Promise<void>
}

export async function startFakeUpstream(options: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const requests: FakeUpstream["requests"] = []
  let catalogStatus = options.catalogStatus ?? 0
  let completionAttempts = 0

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    requests.push({
      path,
      authorization: req.headers.authorization,
      userAgent: req.headers["user-agent"],
    })

    if (path === "/api.json") {
      if (catalogStatus >= 400) {
        res.writeHead(catalogStatus).end("nope")
        return
      }
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(options.catalog ?? {}))
      }
      if (options.catalogDelayMs) setTimeout(send, options.catalogDelayMs)
      else send()
      return
    }

    if (path === "/zen/v1/models") {
      if (options.served === null) {
        res.writeHead(503).end("unavailable")
        return
      }
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: (options.served ?? []).map((id) => ({ id, object: "model", created: 0, owned_by: "opencode" })),
          }),
        )
      }
      if (options.servedDelayMs) setTimeout(send, options.servedDelayMs)
      else send()
      return
    }

    if (path === "/zen/v1/chat/completions" && req.method === "POST") {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        } catch {
          body = undefined
        }
        completionAttempts += 1
        if (options.completions) {
          void options.completions(body, req, res, completionAttempts)
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "gen-test", object: "chat.completion", choices: [] }))
      })
      return
    }

    res.writeHead(404).end("not found")
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    zenUrl: `${url}/zen/v1`,
    requests,
    setCatalogStatus: (status: number) => {
      catalogStatus = status
    },
    get completionAttempts() {
      return completionAttempts
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

/**
 * A catalog document shaped like models.opencode.ai/api.json, with the field
 * values that matter to this server (`api`, `npm`, per-model `cost`).
 */
export function catalogFixture(
  models: Record<string, { cost?: unknown; name?: string; status?: string; limit?: unknown }>,
  overrides: { api?: string } = {},
): unknown {
  return {
    // A second provider, to prove only `opencode` is read.
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      models: { "claude-x": { id: "claude-x", name: "Claude X", cost: { input: 3, output: 15 } } },
    },
    opencode: {
      id: "opencode",
      name: "OpenCode Zen",
      env: ["OPENCODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: overrides.api ?? "https://opencode.ai/zen/v1",
      models: Object.fromEntries(
        Object.entries(models).map(([id, model]) => [
          id,
          {
            id,
            name: model.name ?? id,
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: model.limit ?? { context: 1000, output: 100 },
            ...(model.cost === undefined ? {} : { cost: model.cost }),
            ...(model.status === undefined ? {} : { status: model.status }),
          },
        ]),
      ),
    },
  }
}

export async function readSse(response: Response): Promise<string> {
  const body = response.body
  if (!body) return ""
  let out = ""
  const decoder = new TextDecoder()
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}
