/**
 * OpenAI Chat Completions compatibility layer.
 *
 * The Zen gateway already speaks this dialect, so this module stays thin on
 * purpose: it validates the little that this server must understand to route a
 * request, and otherwise passes the body through untouched so that parameters
 * this server has never heard of still reach the model.
 */
import { z } from "zod"
import type { FreeModel } from "../opencode/catalog.ts"

/**
 * The model object returned by `GET /v1/models`.
 *
 * `id`/`object`/`created`/`owned_by` mirror what the gateway itself returns
 * from upstream-opencode/packages/console/app/src/routes/zen/util/modelsHandler.ts:16-24.
 * The extra `opencode` block carries catalog metadata that the gateway's own
 * list endpoint does not expose (cost, context limits, deprecation status).
 */
export interface OpenAIModel {
  readonly id: string
  readonly object: "model"
  readonly created: number
  readonly owned_by: string
  readonly opencode: {
    readonly provider: string
    readonly status: FreeModel["status"]
    readonly free: true
    readonly served: boolean
    readonly name: string
    readonly context_length: number | undefined
    readonly max_output_tokens: number | undefined
    readonly tool_call: boolean | undefined
    readonly reasoning: boolean | undefined
    readonly attachment: boolean | undefined
    readonly modalities: { input: readonly string[]; output: readonly string[] } | undefined
  }
}

/**
 * `created` is the model's release date when the catalog gives a parseable one.
 * (modelsHandler.ts:20 uses `Date.now()`, which carries no information; the
 * release date is strictly more useful and still a valid unix timestamp.)
 */
function createdAt(model: FreeModel): number {
  if (model.releaseDate) {
    const parsed = Date.parse(model.releaseDate)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

export function toOpenAIModel(model: FreeModel): OpenAIModel {
  return {
    id: model.id,
    object: "model",
    created: createdAt(model),
    owned_by: model.providerID,
    opencode: {
      provider: model.providerID,
      status: model.status,
      free: true,
      served: model.served,
      name: model.name,
      context_length: model.limit?.context,
      max_output_tokens: model.limit?.output,
      tool_call: model.toolCall,
      reasoning: model.reasoning,
      attachment: model.attachment,
      modalities: model.modalities,
    },
  }
}

export interface OpenAIModelList {
  readonly object: "list"
  readonly data: readonly OpenAIModel[]
}

export function toOpenAIModelList(models: readonly FreeModel[]): OpenAIModelList {
  return { object: "list", data: models.map(toOpenAIModel) }
}

/**
 * Request validation.
 *
 * Only the fields this server routes on are constrained:
 *   - `model`    -> the gateway reads `body.model` (routes/zen/v1/chat/completions.ts:8)
 *   - `messages` -> a chat request without them is meaningless
 *   - `stream`   -> the gateway reads `!!body.stream` (same file, line 10) and
 *                   this server has to pick a response mode before calling it
 * Everything else is `passthrough()`: temperature, tools, max_tokens,
 * reasoning_effort, stream_options and any future parameter go upstream
 * verbatim. Validating them here would only add a second, staler schema.
 */
export const ChatCompletionRequest = z
  .object({
    model: z.string().min(1, "model is required"),
    messages: z.array(z.unknown()).min(1, "messages must not be empty"),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>

export interface ValidationFailure {
  readonly ok: false
  readonly message: string
  readonly param: string | null
}

export interface ValidationSuccess {
  readonly ok: true
  readonly value: ChatCompletionRequest
}

export function parseChatCompletionRequest(input: unknown): ValidationSuccess | ValidationFailure {
  const result = ChatCompletionRequest.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return {
    ok: false,
    message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request body",
    param: issue && issue.path.length > 0 ? issue.path.join(".") : null,
  }
}
