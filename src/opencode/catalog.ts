/**
 * Free-model discovery against the same public data OpenCode itself uses.
 *
 * Two public sources, no hardcoded model list and no hardcoded endpoint:
 *
 *  1. `${OPENCODE_MODELS_URL}/api.json` -- the models.dev-format catalog.
 *     OpenCode fetches exactly this URL in
 *     upstream-opencode/packages/core/src/models-dev.ts:160,176.
 *     Its `opencode` provider entry supplies BOTH the model list and the Zen
 *     base URL (`api`), so the endpoint is discovered rather than baked in.
 *
 *  2. `${zenUrl}/models` -- the gateway's own OpenAI-style list of what it is
 *     currently serving
 *     (upstream-opencode/packages/console/app/src/routes/zen/v1/models.ts).
 *
 * THE FREE PREDICATE
 * ------------------
 * `isFree` below is a transcription of OpenCode's own rule for "which models
 * stay usable when no credential is configured", from
 * upstream-opencode/packages/core/src/plugin/provider/opencode.ts:176-186:
 *
 *     const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || ...)
 *     if (!hasKey) provider.request.body.apiKey = "public"
 *     if (hasKey) return
 *     for (const model of item.models.values()) {
 *       if (!model.cost.some((cost) => cost.input > 0)) continue   // <- free
 *       catalog.model.update(..., (draft) => { draft.enabled = false })
 *     }
 *
 * i.e. a model is free iff NO cost tier charges for input. `ModelV2.cost` is an
 * array built from the api.json `cost` object plus its `tiers` and
 * `context_over_200k` variants, so all three are checked here.
 *
 * Verified against a stock unauthenticated `opencode serve` on 2026-09-03: its
 * `GET /api/model` returned 31 models, all `providerID: "opencode"`, which is
 * exactly the set this predicate selects from the same api.json.
 *
 * NOTE ON `status`: OpenCode does NOT filter deprecated models out of this set
 * (22 of the 31 are `deprecated` and were still returned as `enabled: true`).
 * Neither does this module; `status` is reported so callers can decide.
 */
import type { Config } from "../config.ts"
import { PROVIDER_ID } from "../config.ts"
import { type Cost, type Limit, type Model, type Provider, parseCatalog } from "./api-json.ts"
import { z } from "zod"

export interface FreeModel {
  readonly id: string
  readonly name: string
  readonly providerID: string
  /** api.json omits `status` for current models; upstream treats that as active. */
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly limit: Limit | undefined
  readonly cost: Cost | undefined
  readonly toolCall: boolean | undefined
  readonly reasoning: boolean | undefined
  readonly attachment: boolean | undefined
  readonly modalities: { input: readonly string[]; output: readonly string[] } | undefined
  readonly releaseDate: string | undefined
  /** True when `${zenUrl}/models` currently lists this id. */
  readonly served: boolean
}

export interface CatalogSnapshot {
  /** Zen base URL, from config override or the catalog's `opencode.api`. */
  readonly zenUrl: string
  readonly providerName: string
  /** Every free model in the catalog, `served` flag included. */
  readonly all: readonly FreeModel[]
  /** `all` narrowed by `config.modelFilter`. */
  readonly models: readonly FreeModel[]
  readonly fetchedAt: number
  /** False when `${zenUrl}/models` could not be reached; every `served` is then true. */
  readonly servedKnown: boolean
  /** True when this snapshot is being served past its TTL after a failed refresh. */
  readonly stale: boolean
}

export class CatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CatalogError"
  }
}

/** models.ts / modelsHandler.ts -- the gateway's OpenAI-shaped model list. */
const ZenModelList = z.object({
  object: z.literal("list").optional(),
  data: z.array(z.object({ id: z.string() }).passthrough()),
})

function costTiers(cost: Cost | undefined): readonly { input: number }[] {
  if (cost === undefined) return []
  const tiers: { input: number }[] = [{ input: cost.input }]
  for (const tier of cost.tiers ?? []) tiers.push({ input: tier.input })
  if (cost.context_over_200k) tiers.push({ input: cost.context_over_200k.input })
  return tiers
}

/**
 * OpenCode's rule, transcribed: free iff no cost tier has `input > 0`.
 *
 * A model with no `cost` at all yields an empty tier array and is therefore
 * treated as free -- this matches upstream, where `ModelV2.cost` would be `[]`
 * and `[].some(...)` is `false`. As of commit b578b72 no `opencode` model in
 * api.json omits `cost`, so the branch is not currently reachable in practice.
 */
export function isFree(model: Pick<Model, "cost">): boolean {
  return !costTiers(model.cost).some((tier) => tier.input > 0)
}

function toFreeModel(id: string, model: Model, served: boolean): FreeModel {
  return {
    id,
    name: model.name ?? id,
    providerID: PROVIDER_ID,
    status: model.status ?? "active",
    limit: model.limit,
    cost: model.cost,
    toolCall: model.tool_call,
    reasoning: model.reasoning,
    attachment: model.attachment,
    modalities: model.modalities
      ? { input: model.modalities.input, output: model.modalities.output }
      : undefined,
    releaseDate: model.release_date,
    served,
  }
}

async function fetchJson(url: string, init: { timeoutMs: number; userAgent: string }) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": init.userAgent },
    // Deliberately only the catalog's own timeout. A per-request signal must
    // never reach here: the fetch is shared between concurrent callers, so one
    // caller's abort would cancel discovery for everyone joined to it.
    signal: AbortSignal.timeout(init.timeoutMs),
  })
  if (!response.ok) {
    throw new CatalogError(`GET ${url} returned HTTP ${response.status}`)
  }
  return (await response.json()) as unknown
}

export class Catalog {
  #snapshot: CatalogSnapshot | undefined
  #inflight: Promise<CatalogSnapshot> | undefined
  readonly config: Config

  constructor(config: Config) {
    this.config = config
  }

  /** Cached snapshot, refreshed when older than `catalogTtlMs`. */
  async get(): Promise<CatalogSnapshot> {
    const current = this.#snapshot
    if (current && Date.now() - current.fetchedAt < this.config.catalogTtlMs) return current
    return this.refresh()
  }

  /**
   * Force a refresh, collapsing concurrent callers onto one upstream fetch.
   *
   * Takes no AbortSignal on purpose. The returned promise is shared, so binding
   * it to whichever caller happened to start it would let that caller's
   * disconnect fail discovery for every request joined to it. The fetch is
   * bounded by `catalogTimeoutMs` instead.
   */
  async refresh(): Promise<CatalogSnapshot> {
    if (this.#inflight) return this.#inflight
    const run = this.#load()
      .then((snapshot) => {
        this.#snapshot = snapshot
        return snapshot
      })
      .catch((cause: unknown) => {
        // Serving a stale catalog beats failing outright: model ids are stable
        // for far longer than the 5 minute TTL.
        const stale = this.#snapshot
        if (stale) return { ...stale, stale: true }
        throw cause instanceof CatalogError
          ? cause
          : new CatalogError("failed to load the OpenCode model catalog", { cause })
      })
      .finally(() => {
        this.#inflight = undefined
      })
    this.#inflight = run
    return run
  }

  async #load(): Promise<CatalogSnapshot> {
    const url = `${this.config.catalogUrl}/api.json`
    const raw = await fetchJson(url, {
      timeoutMs: this.config.catalogTimeoutMs,
      userAgent: this.config.userAgent,
    })

    const { providers } = parseCatalog(raw)
    const provider: Provider | undefined = providers.get(PROVIDER_ID)
    if (!provider) {
      throw new CatalogError(`the catalog at ${url} has no "${PROVIDER_ID}" provider entry`)
    }

    const zenUrl = this.config.zenUrlOverride ?? provider.api ?? this.config.zenUrlFallback
    const free = Object.entries(provider.models).filter(([, model]) => isFree(model))

    const served = await this.#fetchServed(zenUrl)
    const all = free.map(([id, model]) => toFreeModel(id, model, served ? served.has(id) : true))

    return {
      zenUrl,
      providerName: provider.name ?? PROVIDER_ID,
      all,
      models: this.config.modelFilter === "served" && served ? all.filter((m) => m.served) : all,
      fetchedAt: Date.now(),
      servedKnown: served !== undefined,
      stale: false,
    }
  }

  /**
   * `${zenUrl}/models` is best-effort: if it is unreachable we fall back to the
   * catalog alone (which is what OpenCode itself uses), rather than reporting
   * zero models.
   *
   * Swallowing the failure is only safe because `fetchJson` can no longer be
   * aborted by a caller. The sole abort it can raise is this method's own
   * timeout, for which "treat the gateway as unreachable" is the right answer.
   */
  async #fetchServed(zenUrl: string): Promise<Set<string> | undefined> {
    try {
      const raw = await fetchJson(`${zenUrl}/models`, {
        timeoutMs: this.config.catalogTimeoutMs,
        userAgent: this.config.userAgent,
      })
      const parsed = ZenModelList.safeParse(raw)
      if (!parsed.success) return undefined
      return new Set(parsed.data.data.map((entry) => entry.id))
    } catch {
      return undefined
    }
  }
}
