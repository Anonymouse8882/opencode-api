# opencode-free-api

一个 **OpenAI Chat Completions 兼容** 的 API Server，把 [OpenCode](https://github.com/anomalyco/opencode) 当前可用的**免费模型**暴露给任意外部客户端。

它是 OpenCode 协议的**兼容层**，不修改 OpenCode 本身，也不需要安装 OpenCode。

---

## 1. 架构

```
你的客户端 (OpenAI SDK / curl / 任意兼容工具)
        │  OpenAI Chat Completions
        ▼
┌─────────────────────────────────────────────┐
│  opencode-free-api                          │
│                                             │
│  src/opencode/catalog.ts   模型发现          │
│  src/opencode/zen.ts       上游 HTTP 客户端   │
│  src/opencode/errors.ts    错误映射           │
│  src/adapter/openai.ts     请求校验 / 模型列表 │
│  src/adapter/sse.ts        SSE 重组           │
│  src/server.ts             路由               │
└─────────────────────────────────────────────┘
        │                          │
        │ ① GET /api.json          │ ③ POST /chat/completions
        │    (模型目录)             │    Authorization: Bearer public
        ▼                          ▼
 models.opencode.ai        opencode.ai/zen/v1  ──► 真实模型 provider
        │                          ▲
        └─ ② GET /zen/v1/models ───┘
             (当前实际在供的模型)
```

**调用链与 OpenCode 自己走的完全一致**：

| 步骤 | OpenCode 源码 | 本项目 |
|---|---|---|
| 拉取模型目录 | `packages/core/src/models-dev.ts:160,176` | `src/opencode/catalog.ts` |
| 判定"无凭据时哪些模型可用" | `packages/core/src/plugin/provider/opencode.ts:176-186` | `isFree()` in `catalog.ts` |
| 匿名凭据 `"public"` | `.../opencode.ts:178` 写入 → `console/.../zen/util/handler.ts:102` 识别 | `src/opencode/zen.ts` |
| 发请求 | `@ai-sdk/openai-compatible` → `POST {api}/chat/completions` | `src/opencode/zen.ts` |

> `upstream-opencode/` 是研究用的 OpenCode 源码检出（commit `b578b72`，分支 `dev`），不参与构建，已在 `.gitignore` 中。

### 为什么没有直接 import OpenCode 的包

优先复用上游类型是首选，但实际情况是：

- `@opencode-ai/core`（`ModelsDev` schema 的真正定义处）**未发布**到 npm，`npm view @opencode-ai/core version` 返回占位符 `0.0.0-reserved.0`；
- 已发布的 `@opencode-ai/schema` 的 `models-dev` 入口只导出 `models-dev.refreshed` 事件，不含目录结构；
- 已发布的 `@opencode-ai/sdk` 的 `ModelV2Info` 是**本地 opencode server** 的类型，用它就必须依赖用户安装并运行 `opencode serve`——本项目选择 direct 模式，不做这个假设。

因此 `src/opencode/api-json.ts` 是一份**逐字段对照、标注了上游行号**的镜像，并且刻意做成宽松解析（未知字段直接透传、非关键字段全部 optional），把漂移风险压到只剩几个 load-bearing 字段。文件顶部的注释写明了这一点。

---

## 2. 启动

需要 **Node.js ≥ 22**（用到内置 TypeScript type-stripping 与内置 test runner）。

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:8787`。

```bash
npm run dev        # 监听文件变化
npm run typecheck  # tsc --noEmit
npm test           # 单元 + 集成测试（71 个，全部离线，用本地 fake upstream）
npm run test:e2e   # 打真实 opencode.ai，会消耗匿名配额
```

---

## 3. 凭据要求

**默认不需要任何凭据。** 未设置 `OPENCODE_API_KEY` 时，本服务以字面量 `public` 作为 bearer token 调用 Zen 网关——这是 OpenCode 自己的匿名路径，不是绕过：

- 客户端写入：`packages/core/src/plugin/provider/opencode.ts:178`
  ```ts
  if (!hasKey) provider.request.body.apiKey = "public"
  ```
- 网关识别：`packages/console/app/src/routes/zen/util/handler.ts:102`
  ```ts
  const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
  ```
  随后 `handler.ts:670-674` 对标记了 `allowAnonymous` 的模型放行。

如果你有合法的 OpenCode Console 凭据，设置 `OPENCODE_API_KEY` 即可（走和 OpenCode 相同的环境变量名）。此时付费模型也可调用，用量计入该账号。

配置项见 [`.env.example`](.env.example)。凭据只在内存中作为 bearer token 使用，**不会出现在日志、`/health` 或任何响应里**（有测试守住这一点）。

### 本项目明确不做的事

- 不使用浏览器自动化、不读取本地 OpenCode 凭据文件、不抓 cookie；
- 不伪造 token、签名或设备身份；
- 不发送 `x-opencode-client` / `x-opencode-session` 等 OpenCode 自有 telemetry header，用自己的 `User-Agent`。（`ipRateLimiter.ts:8-20` 有一处目前被注释掉的 header 检查会据此给出更高配额；冒充官方客户端等于窃取不属于自己的配额。）
- 不轮换 IP / 身份来绕开限流。429 与 `Retry-After` **原样上抛**给调用方。

---

## 4. 免费模型来源

**不是静态列表**，每次都从真实数据源解析，5 分钟 TTL 缓存：

1. `GET https://models.opencode.ai/api.json` → 取 `opencode` provider 条目。
   这个条目同时提供了模型列表**和 Zen 的 base URL**（`api` 字段），所以 endpoint 也不是硬编码的。
2. 判定免费，规则原样抄自 `packages/core/src/plugin/provider/opencode.ts:182`：

   ```ts
   if (!model.cost.some((cost) => cost.input > 0)) continue   // ← 留下 = 免费
   ```

   即 **没有任何计价档对 input 收费** 才算免费（base cost、`tiers`、`context_over_200k` 三处都查）。
3. `GET https://opencode.ai/zen/v1/models` → 与网关**当前实际在供**的模型取交集。

第 3 步是本项目额外做的：OpenCode 自己不做交集，所以它会列出一些网关已经下线的模型。设 `OPENCODE_MODEL_FILTER=catalog` 可以关掉交集，行为回到与 OpenCode 一致。

**验证**：2026-09-03 用未登录的 `opencode serve` 实测，其 `GET /api/model` 返回 31 个模型，全部 `providerID: "opencode"`、全部零成本——与本项目从同一份 api.json 用上述规则筛出的集合完全一致。同一天交集后为 9 个。

> 注意：22/31 的模型状态是 `deprecated`。OpenCode **不会**按 `status` 过滤（实测这些模型仍是 `enabled: true`），本项目同样不过滤，只把 `status` 报给调用方自行决定。

---

## 5. API

### `GET /health`

```json
{
  "status": "ok",
  "uptime_ms": 1234,
  "credential": "anonymous",
  "catalog": {
    "zen_url": "https://opencode.ai/zen/v1",
    "provider": "OpenCode Zen",
    "free_models": 9,
    "exposed_models": 9,
    "served_list_reachable": true,
    "stale": false,
    "fetched_at": "2026-09-03T12:00:00.000Z"
  }
}
```

目录不可用时返回 `503` + `"status": "unavailable"`；使用过期缓存时为 `"degraded"`。

### `GET /v1/models` / `GET /v1/models/{id}`

```bash
curl -s localhost:8787/v1/models | jq '.data[].id'
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "nemotron-3.5-lightning-free",
      "object": "model",
      "created": 1786406400,
      "owned_by": "opencode",
      "opencode": {
        "provider": "opencode",
        "status": "active",
        "free": true,
        "served": true,
        "name": "Nemotron 3.5 Lightning Free",
        "context_length": 262144,
        "max_output_tokens": 262144,
        "tool_call": true
      }
    }
  ]
}
```

`id`/`object`/`created`/`owned_by` 与网关自己的 `/zen/v1/models` 一致（`zen/util/modelsHandler.ts:16-24`）；`opencode` 块是本项目附加的目录元数据。

### `POST /v1/chat/completions`

非流式：

```bash
curl -s localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "nemotron-3.5-lightning-free",
    "messages": [{"role": "user", "content": "hello"}],
    "max_tokens": 64
  }'
```

流式（SSE）：

```bash
curl -N localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "nemotron-3.5-lightning-free",
    "messages": [{"role": "user", "content": "count 1 to 5"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

OpenAI SDK 直接可用：

```ts
import OpenAI from "openai"
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "unused" })
const stream = await client.chat.completions.create({
  model: "nemotron-3.5-lightning-free",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
})
```

只有 `model`、`messages`、`stream` 会被校验；`temperature`、`tools`、`max_tokens`、`reasoning_effort` 等**全部原样透传**，不做二次 schema 约束。

### `GET /opencode/catalog`

调试用，返回完整发现结果（含被交集过滤掉的模型和它们的 `served` 标记）。

### 错误格式

统一为 OpenAI 信封，同时用 `error.code` 和 `error.opencode.type` 保留 Zen 的原始错误类型：

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "type": "rate_limit_error",
    "param": null,
    "code": "free_usage_limit_exceeded",
    "opencode": { "type": "FreeUsageLimitError" }
  }
}
```

映射表（左侧来自 `zen/util/error.ts` + `handler.ts:456-519`）：

| Zen 错误 | 上游状态码 | 本服务 `error.type` | `error.code` |
|---|---|---|---|
| `AuthError` | 401 | `authentication_error` | `invalid_api_key` |
| `ModelError` | 401 | `invalid_request_error` | `model_not_found` |
| `CreditsError` / `MonthlyLimitError` / `UserLimitError` | 401 | `insufficient_quota` | 各自 code |
| `RegionError` / `DataPolicyError` | 403 | `permission_error` | `region_not_allowed` / `data_policy` |
| `RateLimitError` / `FreeUsageLimitError` / `GoUsageLimitError` / `BlackUsageLimitError` | 429 | `rate_limit_error` | 各自 code |
| 其他 5xx | 5xx | `api_error` | `upstream_error` |

**上游状态码原样保留**（429 仍是 429，`Retry-After` 原样转发）。本服务自身的错误另有 `catalog_unavailable`(503)、`upstream_timeout`(504)、`upstream_unreachable`(502)。

---

## 6. 流式实现细节

Zen 的 SSE 有一个必须处理的怪癖。它把上游 provider 的字节**原样转发**（`handler.ts:410`），流结束后才追加自己的 cost 帧（`handler.ts:374` → `zen/util/provider/provider.ts:176`）：

```ts
case "oa-compat":
  return `data: ${JSON.stringify({ choices: [], cost })}\n\n`
```

此时 provider 的 `data: [DONE]` 已经发出去了，所以真实线序是：

```
data: {...最后一个 chunk，带 usage...}
data: [DONE]
data: {"choices":[],"cost":"0"}      ← 在终止符之后
```

严格的 OpenAI 客户端读到 `[DONE]` 就停；宽松的会去 parse 一个没有 `id`、没有 `object` 的 chunk。`src/adapter/sse.ts` 把终止符扣住，将其后的内容转成 **SSE 注释**（所有客户端都会忽略，因此 cost 信息不丢），最后再补发 `data: [DONE]`。

其余行为：

- `: keep-alive` 注释原样转发（它们是防止中间层超时的关键）；
- 上游在发出 `[DONE]` 前就断开 → 追加一个 error 帧，**不伪造终止符**，避免调用方把截断的回答当成完整回答；
- 调用方断开 → `AbortController` 传播到上游，取消 reader，不让推理流空转（`res.on("close")` → `controller.abort()`）；
- 上游返回非 2xx（即使请求了 stream）→ 返回 JSON 错误而不是 SSE，与 OpenAI 行为一致。

---

## 7. 重试策略

免费模型确实会瞬时失败，所以对**上游临时故障**做有界重试；但重试**绝不能变成限流规避**，这条线是硬的。

| 情况 | 行为 |
|---|---|
| `408` / `500` / `502` / `503` / `504`、网络层错误 | 重试，默认 2 次（共 3 次尝试） |
| **`429`** | **绝不重试**，原样上抛 + 转发 `Retry-After` |
| 其他 `4xx`（400/401/403/404…） | 不重试，确定性失败，重试只是浪费配额 |
| 自身请求超时 | 不重试，时间预算已用尽 |
| 流式请求 | 只在**写出任何字节之前**重试；中途断流走 error 帧，不重来 |

- **退避**：250ms 起，指数 ×2，**full jitter**（`[0, base·2^(n-1))`），避免多实例同步重试风暴。
- **`Retry-After`**：若上游在可重试状态码上给了 `Retry-After` 且 ≤5s，就遵守它；>5s 直接放弃并把响应上抛——让调用方等 10 分钟不如告诉它发生了什么。
- **总时间预算**：`OPENCODE_REQUEST_TIMEOUT_MS` 是**跨所有尝试**的总预算，不是单次的。开启重试不会把最坏延迟乘以 3。剩余预算不足 1s 时不再发起新尝试。
- **调用方断开**：退避期间的 sleep 会被 abort 打断，不会在没人接收时继续重试。
- **计费安全**：Zen 的 `trackUsage` 只在成功响应后执行，5xx 不计费，因此重试不会重复扣量。
- **可观测**：响应头 `x-opencode-attempts` 给出实际尝试次数；重试后仍失败时，错误体里带 `error.opencode.attempts`。

`OPENCODE_MAX_RETRIES=0` 可完全关闭。

实测（2026-09-04，经本服务）：

```
laguna-s-2.1-free                200  attempts=1
ling-3.0-flash-fin-free          200  attempts=1
deepseek-v4-flash-free           400  attempts=1   ← 确定性 4xx，未重试
muse-spark-1.3-contributor-free  500  attempts=3   ← 重试 2 次后如实上抛
```

---

## 8. 已知限制

1. **匿名访问本身是可用的，但个别模型可能上游不可用。** 2026-09-04 把当天 9 个免费模型逐个匿名探测（`Authorization: Bearer public`）的结果：

   | 模型 | 结果 |
   |---|---|
   | `big-pickle` / `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free` / `mimo-v2.5-free` | ✅ 200 |
   | `laguna-s-2.1-free` / `ling-3.0-flash-fin-free` | ✅ 200（首轮 503，重试即成功，瞬时抖动） |
   | `deepseek-v4-flash-free` | ❌ 400 `Error from provider (Console): Upstream request failed: Model is unavailable.` |
   | `muse-spark-1.2/1.3-contributor-free` | ❌ 500 `Internal server error` |

   **9 个里没有任何一个返回 `AuthError`。** 失败全部是 `server_error` / provider 侧不可用，与匿名身份无关——目录里标为免费的模型，后端 endpoint 可能已经下线或临时故障。

   因此：调用方应当对 5xx 做重试，并且不要假设 `/v1/models` 里的每一个 id 此刻都必然可用。本服务不预测、不预探测（那会白白消耗匿名配额），只如实映射并上抛上游错误。

2. **`"public"` 是行为契约而非文档化 API。** 它只存在于 `handler.ts:102` 一行。上游一旦改名或取消，匿名路径立刻失效；`OPENCODE_PUBLIC_KEY` 可覆盖，但没有稳定性保证。
3. **匿名调用有 per-IP 每日配额**（`ipRateLimiter.ts`），具体数值在服务端私有 `ZEN_LIMITS` 里，不公开。超限返回 429 + `Retry-After`（到当天 UTC 结束的秒数）。本服务不做任何规避。部署到共享出口 IP 上时，配额是所有用户共享的。
4. **可能有地区限制**（`RegionError`，403）。
5. **免费模型流失很快**：31 个里 22 个已 `deprecated`。永远动态拉取，不要缓存 model id 到你自己的配置里。
6. **`reasoning` / `reasoning_details` 是非标字段**。多个免费模型（如 nemotron）会在 delta 里返回它们，OpenAI 官方 schema 没有。本服务原样透传，不裁剪。
7. **`api.json` 的 schema 是手写镜像**，见上文第 1 节。这是本项目唯一的协议漂移点。缓解措施：宽松解析 + 只依赖少数 load-bearing 字段 + 上游行号注释；`test/catalog.test.ts` 里有一条专门验证"新增未知字段不会破坏发现"的用例。
8. **不支持 `/v1/completions`、`/v1/embeddings`**。Zen 另外还有 `/zen/v1/messages`（Anthropic 格式）、`/zen/v1/responses`（OpenAI Responses）、`/zen/v1/models/{model}:generateContent`（Google 格式）三个入口，本项目暂未适配。
9. **无鉴权、无自身限流。** 这是一个本地/内网工具，默认只监听 `127.0.0.1`。暴露到公网前请自行加一层认证——否则等于把你的匿名配额（或你的 `OPENCODE_API_KEY`）开放给所有人。

---

## 9. 测试

```bash
npm test        # 71 个用例，全部离线
npm run test:e2e
```

- `test/sse.test.ts` — SSE 重组，含 Zen cost 帧的真实线序、跨 chunk 分帧、CRLF、异常截断
- `test/errors.test.ts` — 错误映射，用例里的 payload 是从真实网关抓下来的
- `test/catalog.test.ts` — 免费判定规则、宽松解析、目录/交集/降级/TTL/单飞/stale 兜底
- `test/retry.test.ts` — 重试策略：可重试状态码集合、`Retry-After` 解析、full jitter、429 只调用一次、4xx 不重试、总预算、断开即停
- `test/server.test.ts` — 全部路由的端到端（对本地 fake upstream），含流式、abort 传播、凭据不外泄、匿名模型门控，以及「一个调用方断开不得影响其他并发请求的模型发现」
- `test/e2e.test.ts` — 打真实 `models.opencode.ai` + `opencode.ai/zen/v1`，默认跳过

E2E 每次运行最多发 3 次真实推理请求，命中第一个能用的模型就停，不会为了找一个能用的模型而遍历整个目录。遇到 429 会跳过而不是失败。
