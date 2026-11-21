# 待办

## 下次 DSH／Pi 大版本升级：撤回 Pi fork

目标：DSH 直接使用官方 `@earendil-works/pi-ai`，不再维护 Pi fork。退化输出检测已改由本仓库的 `llm/stream` 插件负责，其余改动按下表在升级时一并处理。依据与源码行号见 2026-11-21 的 Pi fork 审计（会话 `session-f8fe722f-1912-4491-95cf-c5fed27cc8e0`）。

| Pi fork 改动 | 处理方式 | 验收 |
|---|---|---|
| 工具参数只在结束时解析（性能） | 升级官方 Pi ≥1.5.0（增量 JSON 解析器，建议直接试最新正式版）；确认 DSH 适配器与新版 Pi 兼容 | 长参数、截断、自定义工具、最终修复与回放；大参数的 CPU 和内存 |
| 系统提示放到顶层 `instructions`（`compat.systemPromptFormat`） | 三个网关都由我们维护：klaude-openai、klaude-cl（`claude-responses-gateway`）、agy-gateway（`agy-localharness-gateway`）。让网关把 `input` 中的 system／developer 消息归入 instructions，然后删除 provider 配置里的 `systemPromptFormat` | 每个网关录制一次请求，对比无 system、多段 system、对话中途 system 更新、工具增量与缓存前缀 |
| 关闭缓存后仍发送会话 ID 请求头 | 用 DSH 的 `llm-pi-ai/request-headers` 钩子写本仓库插件，只给需要的 provider 补会话头 | 网关能区分共享历史的不同分支；不向无关端点发送会话 ID |
| Gemini 走 Chat Completions 时的思考签名 | 直接删除：Gemini 走 agy-gateway 的 `openai-responses`，没有使用方 | 升级前再确认三台机器的配置里没有 Gemini 的 `openai-completions` 路由 |
| 私有打包与发布 workflow | 以上完成后删除，依赖改为官方 pi-ai 精确版本 | 成品组合验收通过 |

DSH 适配器 `llm-pi-ai` 上的相关 fork 改动：

- `errorCodeRules`（例如 `^upstream_error:` → `SERVER`）可移到 `llm/stream` 插件：在流的结尾改写错误码，再由 `llm-retry` 重试。
- `supportsToolSearch` 的 compat 白名单必须保留：上游 rc.5 适配器不开放该字段，删除后工具搜索失效。
