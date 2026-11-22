# 待办

## 下次 DSH／Pi 大版本升级：撤回 Pi fork

目标：DSH 直接使用官方 `@earendil-works/pi-ai`，不再维护 Pi fork。退化输出检测已改由本仓库的 `llm/stream` 插件负责，其余改动按下表在升级时一并处理。依据与源码行号见 2026-11-21 的 Pi fork 审计（会话 `session-f8fe722f-1912-4491-95cf-c5fed27cc8e0`）。

| Pi fork 改动 | 处理方式 | 验收 |
|---|---|---|
| 工具参数只在结束时解析（性能） | 目标官方 Pi 1.6.0。2026-11-22 已测：200 KiB 参数逐片喂入，旧版 1.4.0 约 4.7 s CPU，fork 9.6 ms，1.6.0 17.5 ms；带转义时 1.6.0 多约 41 ms，相对数分钟的生成可忽略。截断与最终修复行为与 fork 一致，DSH 适配器不依赖 fork 的结束时解析。适配器对 1.6.0 有 10 个 scoped tsc 诊断：`catalog.ts` 的 compat 白名单需补上游新字段，删去 `systemPromptFormat`（`catalog.ts`、`config.ts`），`config.ts` 的 `ChatTemplateKwargValue` 输入类型需对齐（TS2375，不用断言掩盖），重新生成 `provider-data.generated.ts` | 修完诊断后做网关端到端验收；多路并发未测 |
| 系统提示放到顶层 `instructions`（`compat.systemPromptFormat`） | klaude-openai 已于 2026-11-22 改回 `input`：GPT-6.2 后端把 `instructions` 拼在 `input` 之后，系统提示每轮都不命中缓存（实测 29.6K 系统提示每轮全额计费，改后每轮约 150）；Sub2API 账户开启透传后，缺省 instructions 时不再补 Codex 内置提示。不要让网关把 developer 消息归入 instructions。klaude-cl 和 agy-gateway 仍用 `instructions`，撤回前确认各自网关能正确处理 input 开头的 developer 消息，然后删除该字段 | 每个网关连发两轮相同系统提示的请求，确认第二轮命中缓存，且未被补入额外指令 |
| 关闭缓存后仍发送会话 ID 请求头 | 共享配置、公开示例和本地三台机器的 Responses 路由均未设置 `cacheRetention: none`。DSH 只转发显式配置，Pi 1.6.0 默认 `short` 且继续发送 `x-client-request-id`，因此不加插件。`session_id` 在 1.6.0 改名为 `session-id`；Claude 和 AGY 网关优先读 `x-client-request-id`，Sub2API 上游同时识别两种拼写 | 切换时验证三个网关的会话亲和性（尤其是实际部署的 Sub2API）。将来若关闭缓存，再用 `llm-pi-ai/request-headers` 按需给指定 provider 补头 |
| Gemini 走 Chat Completions 时的思考签名 | 共享配置、公开示例和本地三台机器均无 Gemini 的 `openai-completions` 路由；本地 Gemini 只走 `agy-gateway` 的 `openai-responses` | 确认远端机器也没有该路由后，撤回 fork 时不保留这项改动 |
| 私有打包与发布 workflow | 以上完成后删除，依赖改为官方 pi-ai 精确版本 | 成品组合验收通过 |

DSH 适配器 `llm-pi-ai` 上的相关 fork 改动：

- `errorCodeRules`（例如 `^upstream_error:` → `SERVER`）可移到 `llm/stream` 插件：在流的结尾改写错误码，再由 `llm-retry` 重试。klaude-cl 的 `^tool_protocol_error: Model called an unavailable tool:` → `PI_AI_ERROR` 规则必须一起迁移：它阻止内建分类器把 `web_fetch` 等工具名误判为可重试的 TRANSPORT／TIMEOUT，恢复交给 `tool-call-hint`。
- `supportsToolSearch` 是官方 pi-ai 字段，但上游 DSH 适配器的 compat 白名单不放行它；白名单这一处修改必须保留，删除后工具搜索失效。
