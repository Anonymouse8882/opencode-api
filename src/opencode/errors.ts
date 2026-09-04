/**
 * The OpenCode Zen gateway's error wire format, and its mapping onto the
 * OpenAI error shape.
 *
 * Source of truth for the payload shape and status codes:
 *   upstream-opencode/packages/console/app/src/routes/zen/util/handler.ts:431-519
 * Source of truth for the error class names:
 *   upstream-opencode/packages/console/app/src/routes/zen/util/error.ts
 *
 * Zen emits, verbatim:
 *   403 {"type":"error","error":{"type":"RegionError"|"DataPolicyError","message":...}}
 *   401 {"type":"error","error":{"type":"AuthError"|"CreditsError"|"MonthlyLimitError"
 *                                 |"UserLimitError"|"ModelError","message":...}}
 *   429 {"type":"error","error":{"type":"RateLimitError"|"FreeUsageLimitError"
 *                                 |"GoUsageLimitError"|"BlackUsageLimitError","message":...},
 *        "metadata":{...}}                       + `retry-after` header
 *   500 {"type":"error","error":{"type":"error","message":"Internal server error"}}
 *   499 (empty body -- the *caller* disconnected; handler.ts:437-441)
 *
 * Anything else with a non-2xx status is an upstream provider error that Zen
 * passed through after rewriting `error.message` to
 * `Error from provider (<name>): <original>` (handler.ts:312-314).
 */
import { z } from "zod"

/** error.ts:1-27 -- every exported error class name, used as `error.type`. */
export const ZEN_ERROR_TYPES = [
  "AuthError",
  "CreditsError",
  "MonthlyLimitError",
  "UserLimitError",
  "ModelError",
  "RegionError",
  "DataPolicyError",
  "RateLimitError",
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "BlackUsageLimitError",
] as const

export type ZenErrorType = (typeof ZEN_ERROR_TYPES)[number]

/** handler.ts:456-518 -- the JSON body Zen writes for a handled error. */
export const ZenErrorBody = z
  .object({
    type: z.string().optional(),
    error: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type ZenErrorBody = z.infer<typeof ZenErrorBody>

/** The OpenAI `{"error": {...}}` envelope this server returns to its clients. */
export interface OpenAIErrorBody {
  readonly error: {
    readonly message: string
    readonly type: string
    readonly param: string | null
    readonly code: string | null
    /** Preserved verbatim from Zen so callers can branch on the exact cause. */
    readonly opencode?: {
      readonly type?: string
      readonly metadata?: Record<string, unknown>
      /** Attempts made before giving up; present only when a retry happened. */
      readonly attempts?: number
    }
  }
}

/**
 * OpenAI error `type` values. `insufficient_quota` and `rate_limit_error` are
 * the two that OpenAI SDK retry logic keys on, so the Zen limit errors are
 * mapped onto them rather than onto a generic `api_error`.
 */
export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "api_error"
  | "api_connection_error"

interface Mapping {
  readonly type: OpenAIErrorType
  readonly code: string
}

/**
 * Zen returns 401 for several conditions that are not really authentication
 * failures (handler.ts:466-479 lumps ModelError in with AuthError). The mapping
 * below re-separates them so OpenAI clients see something sensible, while
 * `error.code` and `error.opencode.type` keep the original name.
 */
const BY_ZEN_TYPE: Readonly<Record<ZenErrorType, Mapping>> = {
  AuthError: { type: "authentication_error", code: "invalid_api_key" },
  CreditsError: { type: "insufficient_quota", code: "insufficient_quota" },
  MonthlyLimitError: { type: "insufficient_quota", code: "monthly_limit_exceeded" },
  UserLimitError: { type: "insufficient_quota", code: "user_limit_exceeded" },
  ModelError: { type: "invalid_request_error", code: "model_not_found" },
  RegionError: { type: "permission_error", code: "region_not_allowed" },
  DataPolicyError: { type: "permission_error", code: "data_policy" },
  RateLimitError: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  FreeUsageLimitError: { type: "rate_limit_error", code: "free_usage_limit_exceeded" },
  GoUsageLimitError: { type: "rate_limit_error", code: "go_usage_limit_exceeded" },
  BlackUsageLimitError: { type: "rate_limit_error", code: "usage_limit_exceeded" },
}

function isZenErrorType(value: string | undefined): value is ZenErrorType {
  return value !== undefined && (ZEN_ERROR_TYPES as readonly string[]).includes(value)
}

function byStatus(status: number): Mapping {
  if (status === 400) return { type: "invalid_request_error", code: "bad_request" }
  if (status === 401) return { type: "authentication_error", code: "invalid_api_key" }
  if (status === 403) return { type: "permission_error", code: "forbidden" }
  if (status === 404) return { type: "not_found_error", code: "not_found" }
  if (status === 429) return { type: "rate_limit_error", code: "rate_limit_exceeded" }
  if (status >= 500) return { type: "api_error", code: "upstream_error" }
  return { type: "api_error", code: "upstream_error" }
}

export interface MappedError {
  readonly status: number
  readonly body: OpenAIErrorBody
  /** Value for the `Retry-After` response header, when upstream supplied one. */
  readonly retryAfter: string | undefined
}

/**
 * Translate one upstream (Zen) failure into the OpenAI error envelope.
 *
 * The upstream status is preserved as-is: a 429 stays a 429 and carries its
 * `Retry-After` through, so callers observe the real rate limit rather than a
 * limit this server invented. See README "Known limitations".
 */
export function mapUpstreamError(input: {
  status: number
  rawBody: string
  retryAfter?: string | null
  attempts?: number
}): MappedError {
  const parsed = parseZenBody(input.rawBody)
  const zenType = parsed?.error?.type
  const mapping = isZenErrorType(zenType) ? BY_ZEN_TYPE[zenType] : byStatus(input.status)

  const message =
    parsed?.error?.message ??
    (input.rawBody.trim() === ""
      ? `OpenCode Zen returned HTTP ${input.status} with an empty body`
      : truncate(input.rawBody, 2000))

  const opencode: { type?: string; metadata?: Record<string, unknown>; attempts?: number } = {}
  if (zenType !== undefined) opencode.type = zenType
  if (parsed?.metadata !== undefined && Object.keys(parsed.metadata).length > 0) {
    opencode.metadata = parsed.metadata
  }
  if (input.attempts !== undefined && input.attempts > 1) opencode.attempts = input.attempts

  return {
    status: input.status,
    retryAfter: input.retryAfter ?? undefined,
    body: {
      error: {
        message,
        type: mapping.type,
        param: null,
        code: mapping.code,
        ...(Object.keys(opencode).length > 0 ? { opencode } : {}),
      },
    },
  }
}

/** Errors raised by this server itself, before or instead of an upstream call. */
export function localError(
  status: number,
  message: string,
  overrides?: { type?: OpenAIErrorType; code?: string },
): MappedError {
  const fallback = byStatus(status)
  return {
    status,
    retryAfter: undefined,
    body: {
      error: {
        message,
        type: overrides?.type ?? fallback.type,
        param: null,
        code: overrides?.code ?? fallback.code,
      },
    },
  }
}

function parseZenBody(raw: string): ZenErrorBody | undefined {
  if (raw.trim() === "") return undefined
  try {
    const result = ZenErrorBody.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
