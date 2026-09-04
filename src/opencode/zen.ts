/**
 * HTTP client for the OpenCode Zen gateway.
 *
 * Wire format: OpenAI Chat Completions. That is not an assumption -- the catalog
 * declares `"npm": "@ai-sdk/openai-compatible"` for the `opencode` provider
 * (models.opencode.ai/api.json), and the gateway route is
 * upstream-opencode/packages/console/app/src/routes/zen/v1/chat/completions.ts,
 * whose handler is invoked with `format: "oa-compat"` and reads the credential
 * as `headers.get("authorization")?.split(" ")[1]`.
 *
 * CREDENTIAL
 * ----------
 * With no `OPENCODE_API_KEY` set, the bearer token is the literal string
 * `"public"`. This is OpenCode's own anonymous path, not a workaround:
 *
 *   - the client writes it:  packages/core/src/plugin/provider/opencode.ts:178
 *       `if (!hasKey) provider.request.body.apiKey = "public"`
 *   - the gateway reads it:  packages/console/app/src/routes/zen/util/handler.ts:102
 *       `const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey`
 *     and then handler.ts:670-674 lets the request through unauthenticated when
 *     the model is flagged `allowAnonymous`.
 *
 * Anonymous requests are rate limited per client IP (handler.ts:121-124 ->
 * util/ipRateLimiter.ts). This client does nothing to interfere with that: it
 * sends one identity, never rotates, and propagates 429 and `Retry-After`
 * upward untouched.
 *
 * HEADERS DELIBERATELY NOT SENT
 * -----------------------------
 * The gateway also reads `x-opencode-client`, `x-opencode-session`,
 * `x-opencode-request` and `x-opencode-project` (handler.ts:103-107) for its own
 * metrics, and `ipRateLimiter.ts:8-20` has a currently-disabled check that keys
 * a higher quota off client headers. This server sends none of them and uses its
 * own User-Agent: presenting itself as the official OpenCode client would be
 * both a misrepresentation and, if that check is ever re-enabled, a way of
 * claiming a quota it is not entitled to.
 */
import type { Config } from "../config.ts"

export interface ZenCallResult {
  readonly response: Response
  /** Total attempts made, including the first. 1 means no retry happened. */
  readonly attempts: number
}

/**
 * RETRY POLICY
 * ------------
 * Free models on Zen do fail transiently. Probing all nine free models on
 * 2026-09-04, `laguna-s-2.1-free` and `ling-3.0-flash-fin-free` both answered
 * 503 `Endpoint is unavailable` once and returned a normal completion on the
 * next attempt, while `deepseek-v4-flash-free` (400 `Model is unavailable`) and
 * the two `muse-spark-*-contributor-free` (500) failed identically every time.
 * So a small, bounded retry recovers real failures without papering over the
 * permanent ones.
 *
 * 429 IS NEVER RETRIED. Anonymous access is rate limited per IP
 * (zen/util/ipRateLimiter.ts) and retrying a rate-limit response is a form of
 * limit evasion. It is propagated with its `Retry-After` intact, and so is any
 * other 4xx, which is deterministic and would only burn quota on a retry.
 *
 * A caller-side timeout is not retried either: the time budget is already spent
 * and a second attempt would only double the wait.
 */
const RETRIABLE_STATUS: ReadonlySet<number> = new Set([408, 500, 502, 503, 504])

/**
 * Upper bound on an upstream-requested delay we are willing to sit out. Beyond
 * this, waiting is worse for the caller than being told what happened, so the
 * response is propagated instead.
 */
const MAX_RETRY_AFTER_MS = 5_000

/** Smallest remaining budget worth starting another attempt with. */
const MIN_ATTEMPT_BUDGET_MS = 1_000

export function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUS.has(status)
}

/** Parse `Retry-After`, which is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * Exponential backoff with full jitter: attempt 1 waits [0, base), attempt 2
 * waits [0, 2*base), and so on. Full jitter rather than a fixed ramp so that
 * several instances failing at once do not retry in lockstep.
 */
export function backoffMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const ceiling = baseMs * 2 ** (attempt - 1)
  return Math.floor(random() * ceiling)
}

export class ZenTransportError extends Error {
  readonly kind: "timeout" | "aborted" | "network"
  constructor(kind: "timeout" | "aborted" | "network", message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ZenTransportError"
    this.kind = kind
  }
}

export class ZenClient {
  readonly config: Config

  constructor(config: Config) {
    this.config = config
  }

  /** The bearer token; never logged, never returned by any route. */
  #credential(): string {
    return this.config.apiKey ?? this.config.publicKey
  }

  /** True when running on the anonymous public path rather than a real key. */
  get anonymous(): boolean {
    return this.config.apiKey === undefined
  }

  /**
   * POST a chat completion, retrying only transient upstream failures.
   *
   * `requestTimeoutMs` is the budget for the whole call, shared across attempts,
   * so turning retries on cannot multiply the worst-case latency a caller sees.
   *
   * The returned `response` always has an unread body: a response that is going
   * to be retried has its body cancelled first, which releases the connection
   * rather than leaking it.
   */
  async chatCompletions(input: {
    zenUrl: string
    body: unknown
    signal: AbortSignal
  }): Promise<ZenCallResult> {
    const deadline = Date.now() + this.config.requestTimeoutMs
    const payload = JSON.stringify(input.body)
    let attempt = 0

    for (;;) {
      attempt += 1
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new ZenTransportError(
          "timeout",
          `no response from OpenCode Zen within ${this.config.requestTimeoutMs}ms`,
        )
      }

      const timeout = AbortSignal.timeout(remaining)
      const signal = AbortSignal.any([timeout, input.signal])
      const last = attempt > this.config.maxRetries

      let response: Response
      try {
        response = await fetch(`${input.zenUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#credential()}`,
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            "user-agent": this.config.userAgent,
          },
          body: payload,
          signal,
        })
      } catch (cause) {
        if (input.signal.aborted) {
          throw new ZenTransportError("aborted", "the client disconnected before the response completed", { cause })
        }
        if (timeout.aborted) {
          throw new ZenTransportError(
            "timeout",
            `no response from OpenCode Zen within ${this.config.requestTimeoutMs}ms`,
            { cause },
          )
        }
        const wait = this.#backoffWithin(attempt, deadline)
        if (last || wait === undefined) {
          throw new ZenTransportError("network", `could not reach OpenCode Zen: ${describe(cause)}`, { cause })
        }
        await sleep(wait, input.signal)
        continue
      }

      if (response.ok || last || !isRetriableStatus(response.status)) {
        return { response, attempts: attempt }
      }

      const wait = this.#retryDelay(attempt, response, deadline)
      // Upstream asked us to wait longer than we are willing to, or the budget
      // is gone: hand the caller the real response instead of stalling.
      if (wait === undefined) return { response, attempts: attempt }

      await response.body?.cancel().catch(() => {})
      await sleep(wait, input.signal)
    }
  }

  /** Backoff for a failed attempt, or undefined when it will not fit the budget. */
  #backoffWithin(attempt: number, deadline: number): number | undefined {
    const wait = backoffMs(attempt, this.config.retryBaseMs)
    return this.#fits(wait, deadline) ? wait : undefined
  }

  #retryDelay(attempt: number, response: Response, deadline: number): number | undefined {
    const requested = parseRetryAfter(response.headers.get("retry-after"))
    if (requested !== undefined) {
      if (requested > MAX_RETRY_AFTER_MS) return undefined
      return this.#fits(requested, deadline) ? requested : undefined
    }
    return this.#backoffWithin(attempt, deadline)
  }

  #fits(wait: number, deadline: number): boolean {
    return Date.now() + wait + MIN_ATTEMPT_BUDGET_MS <= deadline
  }
}

/** Sleep that rejects promptly if the caller goes away mid-backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ZenTransportError("aborted", "the client disconnected before the response completed"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ZenTransportError("aborted", "the client disconnected before the response completed"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
