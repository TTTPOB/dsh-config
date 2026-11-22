# 待办

## 撤回 Pi fork：只剩切换和验收

目标：DSH 直接使用官方 `@earendil-works/pi-ai`，不再维护 Pi fork。决策依据（性能实测、`systemPromptFormat` 与 GPT-6.2 缓存、Gemini 签名）记在 DSH 的 Agent Note `.agents/notes/implemented/architecture/2026-11-22-official-pi-ai-dependency.md`。

### 已完成（2026-11-23）

- **DSH 适配器与发版**：`daily-driver` `0bb03a26bd` 改用官方 Pi AI 1.6.0，删除 Pi fork 发版路径和适配器里的 `errorCodeRules`。Release `daily-driver-v0.2.2-rc.5-fork6` 发布 `dsh-llm-pi-ai` `0.2.2-rc.5-fork3`，已核对 SHA256、依赖版本和产物内容。
- **dsh-config**：`main` `931af2d`。依赖清单换成新资产，`retiredGlobalOverrides` 删除旧 Pi override；错误码改写移到 home 插件 [error-code-rules](<plugins/README.md#错误码改写>)；删除 klaude-cl 和工作站 agy-gateway 的 `systemPromptFormat`（新适配器会拒绝这个字段）。
- **三机 live dry run**：三台结果一致，依赖只有两项变化（移除 `@earendil-works/pi-ai` override、`dsh-llm-pi-ai` fork2 → fork3），另新增 `error-code-rules` 行、修改 `llm-pi-ai` 行，0 阻塞。
- **Claude 网关**：现有代码已同时识别 `instructions` 和 input 里的 developer 消息，不用改代码。分支 `fix/pi-retire` 的 `c1ca041` 只补了回归测试，合并前先 rebase 到 main。

### 切换时要做（按顺序）

1. **兼容拦截**：`verifiedCompatibility` 没有 `dsh-llm-pi-ai@0.2.2-rc.5-fork3`。先在隔离 profile 跑 doctor 取全部拦截再登记，否则 apply 后的 doctor 会让切换自动回滚。
2. **切换**：有全局依赖变化，必须走 host-switch（不能热加载），并设置 `DSH_APPLY_TIMEOUT=900 DSH_ROLLBACK_TIMEOUT=900`。远端的 machine.yaml 已和工作站同步。
3. **部署验收**：确认全局安装解析到官方 `@earendil-works/pi-ai` 1.6.0。klaude-cl 和 klaude-openai 各连发两轮相同系统提示的请求，第二轮命中缓存，网关不重建会话。skelviper（`anthropic-messages`）已有会话里的签名思考会失效一次，属预期。AGY 网关不验收，见下文退役项。
4. **收尾**：停用 Pi 仓库 fork 的私有打包与发布 workflow。

### 逐项依据

| Pi fork 改动 | 结论 |
|---|---|
| 工具参数只在结束时解析（性能） | 官方 1.6.0 已消除逐片重扫：200 KiB 参数旧版 1.4.0 约 4.7 s CPU，fork 9.6 ms，1.6.0 17.5 ms，带转义多约 41 ms；截断与修复行为一致。多路并发未测 |
| 系统提示放到顶层 `instructions` | klaude-openai 已于 2026-11-22 改回 `input`（GPT-6.2 后端把 `instructions` 拼在 `input` 之后，系统提示每轮不命中缓存；Sub2API 账户开透传后不再补 Codex 内置提示）。不要让网关把 developer 消息归入 instructions |
| 关闭缓存后仍发送会话 ID 请求头 | 共享配置、公开示例和本地三台机器的 Responses 路由均未设置 `cacheRetention: none`。DSH 只转发显式配置，Pi 1.6.0 默认 `short` 且继续发送 `x-client-request-id`，因此不加插件。`session_id` 在 1.6.0 改名为 `session-id`，不补发旧头。Claude 网关优先读 `x-client-request-id`。Sub2API（按 v0.2.24 源码核对）选账号时 `session-id` 优先级最高；转发 Codex 上游时，没有 `session_id` 就用 body 的 `prompt_cache_key` 生成，Pi 发送的值与会话 ID 相同，因此补发 `session_id` 不改变结果。切换后看 klaude-openai 连续两轮是否命中缓存。将来若关闭缓存，再用 `llm-pi-ai/request-headers` 按需给指定 provider 补头 |
| Gemini 走 Chat Completions 时的思考签名 | 共享配置、公开示例和本地三台机器均无 Gemini 的 `openai-completions` 路由；本地 Gemini 只走 `agy-gateway` 的 `openai-responses`，远端也没有该路由；撤回 fork 时不保留这项改动 |

DSH 适配器 `llm-pi-ai` 上的相关 fork 改动：

- Klaude 网关的[错误码改写](<plugins/README.md#错误码改写>)由 home 插件处理，不再依赖适配器 fork。
- `supportsToolSearch` 是官方 pi-ai 字段，但上游 DSH 适配器的 compat 白名单不放行它；白名单这一处修改必须保留，删除后工具搜索失效。

## 退役 AGY 网关

`agy-gateway` 目前基本不可用，也很久没用。退役时删除工作站私有参数里的 `agy-gateway` provider 行和 `subagentModels` 中的 `gemini-3.8-flash`，并从工作区约定里移除 `agy-localharness-gateway` 仓库条目。撤回 Pi fork 时不验收 AGY 网关。
