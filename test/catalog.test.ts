import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { Catalog, isFree } from "../src/opencode/catalog.ts"
import { parseCatalog } from "../src/opencode/api-json.ts"
import { loadConfig } from "../src/config.ts"
import { startFakeUpstream, catalogFixture, type FakeUpstream } from "./helpers.ts"

function configFor(upstream: FakeUpstream, extra: Record<string, string> = {}) {
  return loadConfig({
    OPENCODE_MODELS_URL: upstream.url,
    OPENCODE_ZEN_URL: `${upstream.url}/zen/v1`,
    OPENCODE_CATALOG_TTL_MS: "60000",
    ...extra,
  } as NodeJS.ProcessEnv)
}

describe("isFree -- OpenCode's own free/paid rule", () => {
  // Transcribed from packages/core/src/plugin/provider/opencode.ts:182,
  // `!model.cost.some((cost) => cost.input > 0)`.
  it("treats a zero input+output cost as free", () => {
    assert.equal(isFree({ cost: { input: 0, output: 0 } }), true)
  })

  it("treats any positive input price as paid", () => {
    assert.equal(isFree({ cost: { input: 3, output: 15 } }), false)
    assert.equal(isFree({ cost: { input: 0.01, output: 0 } }), false)
  })

  it("ignores output-only pricing, matching upstream which only inspects `input`", () => {
    assert.equal(isFree({ cost: { input: 0, output: 15 } }), true)
  })

  it("checks the context_over_200k tier too", () => {
    assert.equal(
      isFree({ cost: { input: 0, output: 0, context_over_200k: { input: 6, output: 22 } } }),
      false,
    )
  })

  it("checks explicit tiers too", () => {
    assert.equal(
      isFree({ cost: { input: 0, output: 0, tiers: [{ input: 2, output: 4 }] } }),
      false,
    )
  })

  it("treats a model with no cost block as free, as upstream's empty array does", () => {
    assert.equal(isFree({ cost: undefined }), true)
  })
})

describe("parseCatalog", () => {
  it("keeps well-formed providers and drops malformed ones without failing the document", () => {
    const parsed = parseCatalog({
      opencode: { id: "opencode", api: "https://x/zen/v1", models: {} },
      broken: { models: "not-an-object" },
    })
    assert.equal(parsed.providers.has("opencode"), true)
    assert.deepEqual(parsed.skipped, ["broken"])
  })

  it("tolerates unknown fields, so a new upstream key cannot break discovery", () => {
    const parsed = parseCatalog({
      opencode: {
        id: "opencode",
        api: "https://x/zen/v1",
        brand_new_field: { nested: true },
        models: { m: { id: "m", cost: { input: 0, output: 0 }, brand_new_model_field: 1 } },
      },
    })
    assert.equal(parsed.providers.get("opencode")?.models["m"]?.id, "m")
  })
})

describe("Catalog", () => {
  const open: FakeUpstream[] = []
  after(async () => {
    for (const u of open) await u.close()
  })

  async function upstream(options: Parameters<typeof startFakeUpstream>[0]) {
    const u = await startFakeUpstream(options)
    open.push(u)
    return u
  }

  it("discovers free models and the Zen URL from the catalog, without hardcoding either", async () => {
    const u = await upstream({
      catalog: catalogFixture(
        {
          "free-a": { cost: { input: 0, output: 0 } },
          "paid-b": { cost: { input: 3, output: 15 } },
        },
        { api: "https://discovered.example/zen/v1" },
      ),
      served: ["free-a", "paid-b"],
    })

    // No OPENCODE_ZEN_URL override: the URL must come from the catalog body.
    const config = loadConfig({ OPENCODE_MODELS_URL: u.url } as NodeJS.ProcessEnv)
    const snapshot = await new Catalog(config).get()

    assert.equal(snapshot.zenUrl, "https://discovered.example/zen/v1")
    assert.deepEqual(snapshot.all.map((m) => m.id), ["free-a"])
    assert.equal(snapshot.providerName, "OpenCode Zen")
  })

  it("filters to models the gateway is currently serving", async () => {
    const u = await upstream({
      catalog: catalogFixture({
        "free-live": { cost: { input: 0, output: 0 } },
        "free-retired": { cost: { input: 0, output: 0 } },
      }),
      served: ["free-live"],
    })
    const snapshot = await new Catalog(configFor(u)).get()

    assert.deepEqual(snapshot.all.map((m) => m.id).sort(), ["free-live", "free-retired"])
    assert.deepEqual(snapshot.models.map((m) => m.id), ["free-live"])
    assert.equal(snapshot.all.find((m) => m.id === "free-retired")?.served, false)
  })

  it("exposes the whole free catalog under OPENCODE_MODEL_FILTER=catalog", async () => {
    const u = await upstream({
      catalog: catalogFixture({
        "free-live": { cost: { input: 0, output: 0 } },
        "free-retired": { cost: { input: 0, output: 0 } },
      }),
      served: ["free-live"],
    })
    const snapshot = await new Catalog(configFor(u, { OPENCODE_MODEL_FILTER: "catalog" })).get()
    assert.equal(snapshot.models.length, 2)
  })

  it("keeps deprecated models, matching OpenCode which does not filter on status", async () => {
    const u = await upstream({
      catalog: catalogFixture({ old: { cost: { input: 0, output: 0 }, status: "deprecated" } }),
      served: ["old"],
    })
    const snapshot = await new Catalog(configFor(u)).get()
    assert.equal(snapshot.models.length, 1)
    assert.equal(snapshot.models[0]?.status, "deprecated")
  })

  it("falls back to the catalog alone when the served list is unreachable", async () => {
    const u = await upstream({
      catalog: catalogFixture({ a: { cost: { input: 0, output: 0 } } }),
      served: null,
    })
    const snapshot = await new Catalog(configFor(u)).get()
    assert.equal(snapshot.servedKnown, false)
    assert.deepEqual(snapshot.models.map((m) => m.id), ["a"])
  })

  it("caches within the TTL and collapses concurrent refreshes", async () => {
    const u = await upstream({
      catalog: catalogFixture({ a: { cost: { input: 0, output: 0 } } }),
      served: ["a"],
    })
    const catalog = new Catalog(configFor(u))
    await Promise.all([catalog.get(), catalog.get(), catalog.get()])
    await catalog.get()
    assert.equal(u.requests.filter((r) => r.path === "/api.json").length, 1)
  })

  it("serves a stale snapshot rather than failing when a refresh breaks", async () => {
    const u = await upstream({
      catalog: catalogFixture({ a: { cost: { input: 0, output: 0 } } }),
      served: ["a"],
    })
    const catalog = new Catalog(configFor(u))
    const first = await catalog.get()
    assert.equal(first.stale, false)

    u.setCatalogStatus(503)

    const second = await catalog.refresh()
    assert.equal(second.stale, true)
    assert.deepEqual(second.models.map((m) => m.id), ["a"])
  })

  it("fails loudly when there is no cached snapshot to fall back on", async () => {
    const u = await upstream({ catalogStatus: 500 })
    await assert.rejects(() => new Catalog(configFor(u)).get(), /HTTP 500/)
  })

  it("fails when the catalog has no opencode provider", async () => {
    const u = await upstream({ catalog: { anthropic: { id: "anthropic", models: {} } } })
    await assert.rejects(() => new Catalog(configFor(u)).get(), /no "opencode" provider entry/)
  })

  it("sends its own User-Agent, not OpenCode's", async () => {
    const u = await upstream({
      catalog: catalogFixture({ a: { cost: { input: 0, output: 0 } } }),
      served: ["a"],
    })
    await new Catalog(configFor(u)).get()
    const ua = u.requests.find((r) => r.path === "/api.json")?.userAgent
    assert.ok(ua?.startsWith("opencode-free-api/"), `unexpected user-agent ${ua}`)
  })
})
