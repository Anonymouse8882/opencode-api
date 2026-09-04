/**
 * Runtime configuration.
 *
 * Defaults mirror OpenCode's own defaults so that this server talks to the same
 * places a stock `opencode` install would:
 *
 *  - catalogUrl       upstream-opencode/packages/core/src/models-dev.ts:160
 *                     (`Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`)
 *  - catalogTtlMs     upstream-opencode/packages/core/src/models-dev.ts:165
 *                     (`const ttl = Duration.minutes(5)`)
 *  - catalogTimeoutMs upstream-opencode/packages/core/src/models-dev.ts:181
 *                     (`Effect.timeout("10 seconds")`)
 *  - publicKey        upstream-opencode/packages/core/src/plugin/provider/opencode.ts:178
 *                     (`if (!hasKey) provider.request.body.apiKey = "public"`)
 *  - apiKey           upstream-opencode/packages/core/src/plugin/provider/opencode.ts:176
 *                     (`process.env.OPENCODE_API_KEY || ...`)
 *
 * `requestTimeoutMs` is a TOTAL budget spanning every retry attempt, not a
 * per-attempt one, so enabling retries cannot silently multiply worst-case
 * latency. See ZenClient.chatCompletions.
 *
 * No credential is ever logged; `Config` deliberately has no `toString`/`toJSON`
 * that would expose `apiKey`.
 */

export const PROVIDER_ID = "opencode" as const

export type ModelFilter = "served" | "catalog"

export interface Config {
  readonly host: string
  readonly port: number
  /** Root of the models.dev-format catalog; `/api.json` is appended. */
  readonly catalogUrl: string
  /** Explicit Zen base URL override. When unset it is read from the catalog. */
  readonly zenUrlOverride: string | undefined
  /** Fallback Zen base URL, used only when the catalog has no `api` field. */
  readonly zenUrlFallback: string
  /** Anonymous credential understood by the Zen gateway. */
  readonly publicKey: string
  /** Real OpenCode credential, when the operator supplied one. */
  readonly apiKey: string | undefined
  readonly catalogTtlMs: number
  readonly catalogTimeoutMs: number
  /** Total budget for one client request, across every retry attempt. */
  readonly requestTimeoutMs: number
  /** Retries after the first attempt. 0 disables retrying. */
  readonly maxRetries: number
  /** First backoff step; doubles per attempt, with full jitter. */
  readonly retryBaseMs: number
  readonly modelFilter: ModelFilter
  readonly userAgent: string
}

class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

function intFrom0(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const filterRaw = env.OPENCODE_MODEL_FILTER?.trim() || "served"
  if (filterRaw !== "served" && filterRaw !== "catalog") {
    throw new ConfigError(`OPENCODE_MODEL_FILTER must be "served" or "catalog", got ${JSON.stringify(filterRaw)}`)
  }

  const zenOverride = nonEmpty(env, "OPENCODE_ZEN_URL")

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: int(env, "PORT", 8787),
    catalogUrl: trimTrailingSlash(env.OPENCODE_MODELS_URL?.trim() || "https://models.opencode.ai"),
    zenUrlOverride: zenOverride === undefined ? undefined : trimTrailingSlash(zenOverride),
    zenUrlFallback: "https://opencode.ai/zen/v1",
    publicKey: env.OPENCODE_PUBLIC_KEY?.trim() || "public",
    apiKey: nonEmpty(env, "OPENCODE_API_KEY"),
    catalogTtlMs: int(env, "OPENCODE_CATALOG_TTL_MS", 5 * 60_000),
    catalogTimeoutMs: int(env, "OPENCODE_CATALOG_TIMEOUT_MS", 10_000),
    requestTimeoutMs: int(env, "OPENCODE_REQUEST_TIMEOUT_MS", 120_000),
    maxRetries: intFrom0(env, "OPENCODE_MAX_RETRIES", 2),
    retryBaseMs: int(env, "OPENCODE_RETRY_BASE_MS", 250),
    modelFilter: filterRaw,
    userAgent: env.OPENCODE_USER_AGENT?.trim() || "opencode-free-api/0.1.0",
  }
}

/** Redacted view, safe to log or return from /health. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    catalogUrl: config.catalogUrl,
    zenUrl: config.zenUrlOverride ?? "(from catalog)",
    // Names the variable the credential came from, never its value: this is
    // printed at startup and served from GET /health.
    credential: config.apiKey ? "OPENCODE_API_KEY" : "anonymous (OPENCODE_PUBLIC_KEY)",
    catalogTtlMs: config.catalogTtlMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    modelFilter: config.modelFilter,
  }
}
