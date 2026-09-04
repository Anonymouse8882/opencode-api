/**
 * Schema for the models.dev-format catalog served at `${OPENCODE_MODELS_URL}/api.json`.
 *
 * WHY THIS IS RE-DEFINED HERE
 * ---------------------------
 * The authoritative definition lives in OpenCode's `packages/core`, which is not
 * published to npm (`npm view @opencode-ai/core version` -> `0.0.0-reserved.0`,
 * a placeholder). `@opencode-ai/schema` *is* published, but its `models-dev`
 * entry point only exports the `models-dev.refreshed` event -- the catalog
 * structs are not part of its public surface. So there is no package to import
 * and this file is a deliberate, documented mirror.
 *
 * Every field below is transcribed from
 *   upstream-opencode/packages/core/src/models-dev.ts
 * at the line noted next to it (commit b578b72, branch `dev`).
 *
 * DRIFT POLICY: parsing is intentionally permissive. Unknown keys are ignored
 * rather than rejected, and every field this server does not itself need is
 * optional, so a new upstream field cannot break model discovery. Only the
 * handful of fields under "load-bearing" below actually affect behaviour.
 *
 * Load-bearing fields (a change to these changes what this server does):
 *   Provider.api      -> Zen base URL                         (models-dev.ts:126)
 *   Provider.models   -> model discovery                      (models-dev.ts:129)
 *   Model.cost.input  -> free/paid decision, see catalog.ts    (models-dev.ts:86)
 *   Model.id / name / limit / status                          (models-dev.ts:68,69,87,116)
 */
import { z } from "zod"

/** models-dev.ts:15 `CatalogModelStatus = Schema.Literals(["alpha","beta","deprecated"])` */
export const CatalogModelStatus = z.enum(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = z.infer<typeof CatalogModelStatus>

/** models-dev.ts:105 `Schema.Literals(["text","audio","image","video","pdf"])` */
const Modality = z.enum(["text", "audio", "image", "video", "pdf"])

/** models-dev.ts:26-38 `CostTier` */
const CostTier = z
  .object({
    input: z.number().finite(),
    output: z.number().finite(),
    cache_read: z.number().finite().optional(),
    cache_write: z.number().finite().optional(),
    tier: z.object({ type: z.literal("context"), size: z.number().finite() }).optional(),
  })
  .passthrough()

/** models-dev.ts:40-50 `Cost` */
export const Cost = z
  .object({
    input: z.number().finite(),
    output: z.number().finite(),
    cache_read: z.number().finite().optional(),
    cache_write: z.number().finite().optional(),
    tiers: z.array(CostTier).optional(),
    context_over_200k: z
      .object({
        input: z.number().finite(),
        output: z.number().finite(),
        cache_read: z.number().finite().optional(),
        cache_write: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type Cost = z.infer<typeof Cost>

/** models-dev.ts:87-91 `limit` */
export const Limit = z
  .object({
    context: z.number().finite(),
    input: z.number().finite().optional(),
    output: z.number().finite(),
  })
  .passthrough()
export type Limit = z.infer<typeof Limit>

/**
 * models-dev.ts:67-119 `Model`.
 *
 * Upstream marks `name`, `release_date`, `attachment`, `reasoning`,
 * `temperature`, `tool_call` and `limit` as required. They are optional here on
 * purpose: this server only reads a subset, and a catalog entry that omits a
 * field this server never touches should still be discoverable rather than
 * dropped. `id` is the one field made mandatory, because it is the routing key.
 */
export const Model = z
  .object({
    id: z.string(), // models-dev.ts:68
    name: z.string().optional(), // models-dev.ts:69
    family: z.string().optional(), // models-dev.ts:70
    release_date: z.string().optional(), // models-dev.ts:71
    attachment: z.boolean().optional(), // models-dev.ts:72
    reasoning: z.boolean().optional(), // models-dev.ts:73
    temperature: z.boolean().optional(), // models-dev.ts:74
    tool_call: z.boolean().optional(), // models-dev.ts:75
    cost: Cost.optional(), // models-dev.ts:86
    limit: Limit.optional(), // models-dev.ts:87
    modalities: z // models-dev.ts:92
      .object({ input: z.array(Modality), output: z.array(Modality) })
      .passthrough()
      .optional(),
    status: CatalogModelStatus.optional(), // models-dev.ts:116
    provider: z // models-dev.ts:117 (per-model provider override)
      .object({ npm: z.string().optional(), api: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type Model = z.infer<typeof Model>

/** models-dev.ts:123-130 `Provider` */
export const Provider = z
  .object({
    id: z.string(), // models-dev.ts:126
    name: z.string().optional(), // models-dev.ts:124
    api: z.string().optional(), // models-dev.ts:123
    env: z.array(z.string()).optional(), // models-dev.ts:125
    npm: z.string().optional(), // models-dev.ts:127
    models: z.record(z.string(), Model).default({}), // models-dev.ts:128
  })
  .passthrough()
export type Provider = z.infer<typeof Provider>

/**
 * models-dev.ts:139 `get: () => Effect<Record<string, Provider>>` -- api.json is a
 * bare object keyed by provider id.
 *
 * Providers that fail to parse are dropped rather than failing the whole
 * document, so one malformed entry elsewhere in the catalog cannot take down
 * discovery of the `opencode` provider.
 */
export const CatalogDocument = z.record(z.string(), z.unknown())

export interface ParsedCatalog {
  readonly providers: ReadonlyMap<string, Provider>
  readonly skipped: readonly string[]
}

export function parseCatalog(input: unknown): ParsedCatalog {
  const root = CatalogDocument.parse(input)
  const providers = new Map<string, Provider>()
  const skipped: string[] = []
  for (const [id, raw] of Object.entries(root)) {
    const result = Provider.safeParse(raw)
    if (result.success) providers.set(id, result.data)
    else skipped.push(id)
  }
  return { providers, skipped }
}
