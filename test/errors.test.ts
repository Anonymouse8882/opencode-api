import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapUpstreamError, localError, ZEN_ERROR_TYPES } from "../src/opencode/errors.ts"

describe("mapUpstreamError", () => {
  it("maps a real Zen AuthError body (captured from the live gateway)", () => {
    const mapped = mapUpstreamError({
      status: 401,
      rawBody: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    })
    assert.equal(mapped.status, 401)
    assert.equal(mapped.body.error.type, "authentication_error")
    assert.equal(mapped.body.error.code, "invalid_api_key")
    assert.equal(mapped.body.error.message, "Missing API key.")
    assert.equal(mapped.body.error.opencode?.type, "AuthError")
  })

  it("re-separates ModelError, which Zen also returns as 401", () => {
    const mapped = mapUpstreamError({
      status: 401,
      rawBody: '{"type":"error","error":{"type":"ModelError","message":"Model x is not supported"}}',
    })
    assert.equal(mapped.status, 401, "the upstream status is preserved verbatim")
    assert.equal(mapped.body.error.type, "invalid_request_error")
    assert.equal(mapped.body.error.code, "model_not_found")
  })

  it("preserves rate-limit status, Retry-After and metadata", () => {
    const mapped = mapUpstreamError({
      status: 429,
      rawBody:
        '{"type":"error","error":{"type":"FreeUsageLimitError","message":"limit"},"metadata":{"limitName":"weekly"}}',
      retryAfter: "3600",
    })
    assert.equal(mapped.status, 429)
    assert.equal(mapped.retryAfter, "3600")
    assert.equal(mapped.body.error.type, "rate_limit_error")
    assert.equal(mapped.body.error.code, "free_usage_limit_exceeded")
    assert.deepEqual(mapped.body.error.opencode?.metadata, { limitName: "weekly" })
  })

  it("maps region and data-policy refusals to 403 permission errors", () => {
    for (const type of ["RegionError", "DataPolicyError"]) {
      const mapped = mapUpstreamError({
        status: 403,
        rawBody: `{"type":"error","error":{"type":"${type}","message":"nope"}}`,
      })
      assert.equal(mapped.status, 403)
      assert.equal(mapped.body.error.type, "permission_error")
    }
  })

  it("maps every documented Zen error class to a known OpenAI type", () => {
    for (const type of ZEN_ERROR_TYPES) {
      const mapped = mapUpstreamError({
        status: 500,
        rawBody: `{"type":"error","error":{"type":"${type}","message":"m"}}`,
      })
      assert.notEqual(mapped.body.error.code, null)
      assert.equal(mapped.body.error.opencode?.type, type)
    }
  })

  it("falls back to the status code when the body is not a Zen envelope", () => {
    const mapped = mapUpstreamError({ status: 502, rawBody: "<html>bad gateway</html>" })
    assert.equal(mapped.status, 502)
    assert.equal(mapped.body.error.type, "api_error")
    assert.ok(mapped.body.error.message.includes("bad gateway"))
    assert.equal(mapped.body.error.opencode, undefined)
  })

  it("handles an empty upstream body", () => {
    const mapped = mapUpstreamError({ status: 500, rawBody: "" })
    assert.ok(mapped.body.error.message.includes("HTTP 500"))
  })

  it("passes an upstream provider error through with Zen's message prefix intact", () => {
    // handler.ts:312-314 rewrites error.message before passing the body along.
    const mapped = mapUpstreamError({
      status: 400,
      rawBody: '{"error":{"message":"Error from provider (Foo): bad input","type":"invalid_request_error"}}',
    })
    assert.equal(mapped.status, 400)
    assert.equal(mapped.body.error.message, "Error from provider (Foo): bad input")
  })
})

describe("localError", () => {
  it("produces an OpenAI-shaped envelope", () => {
    const err = localError(404, "nope", { type: "invalid_request_error", code: "model_not_found" })
    assert.deepEqual(err.body, {
      error: { message: "nope", type: "invalid_request_error", param: null, code: "model_not_found" },
    })
  })
})
