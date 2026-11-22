# 待办

## 撤回 Pi fork（下次修改 DSH 时一起做）

目标：DSH 直接使用官方 `@earendil-works/pi-ai`，不再维护 Pi fork。决策依据（性能实测、`systemPromptFormat` 与 GPT-6.2 缓存、Gemini 签名）记在 DSH 适配器分支的 Agent Note `.agents/notes/implemented/architecture/2026-11-22-official-pi-ai-dependency.md`。

### 已完成（2026-11-22，均未 push）

- **DSH 适配器**：worktree `deepseek-harness-pi-retire`，分支 `llm-pi-ai-official-1.6`，基于 `fork/daily-driver` `398a33da61`。提交 `5468d304ed` 改用官方 1.6.0：修完 10 个 tsc 诊断，删除 `systemPromptFormat` 和 Gemini Chat Completions 签名测试，开放 3 个新 compat 字段，前缀摘要换成 v2，包版本 `0.2.2-rc.5-fork3`。提交 `eabd2b9fa3` 是 Agent Note。已审查；包测试 482、core 2246 通过，7 个变异被抓到。
- **Claude 网关**：现有代码已同时识别 `instructions` 和 input 里的 developer 消息，线上版本同样具备，不用改代码。分支 `fix/pi-retire` 的 `c1ca041` 只补了回归测试，合并前先 rebase 到 main。
- **会话头**：不需要插件（见下表）。**Gemini Chat Completions 路由**：本地三台没有。

### 下次要做（按顺序）

1. **发版路径（DSH fork，同一分支上改）**：删除 `scripts/daily-driver-pi.mjs` 及其测试；`scripts/daily-driver.mjs` 删除 `withPiFork` 的 import、测试列表里的 `daily-driver-pi.test.mjs`、verify 里的 `withPiFork` 分支、release 里要求 `DSH_PI_AI_TARBALL` 的断言；`.github/workflows/daily-driver-release.yml` 删除 `pi_tarball_url` 输入、`PI_TARBALL_URL` 环境变量和 core 下载块；同步 `scripts/README.daily-driver.md`。不改的话 core 发版会直接失败。
2. **发版**：分支合并到 `daily-driver`，走 Release workflow 发布新的 `dsh-llm-pi-ai`。
3. **dsh-config 配置**：删除 `shared/providers.yaml` 里 klaude-cl 的 `systemPromptFormat: instructions`，以及工作站私有参数里 agy-gateway 的同一字段；新适配器不认识这个字段，留着会导致配置加载失败。`shared/dependencies.yaml` 删除 `@earendil-works/pi-ai` 的 Pi fork 条目，`dsh-llm-pi-ai` 换成新发布的资产地址。
4. **部署验收**：klaude-cl 连发两轮相同系统提示的请求，第二轮命中缓存，网关不重建会话。AGY 网关能否正确处理 input 开头的 developer 消息尚未验证。skelviper（`anthropic-messages`）已有会话里的签名思考会失效一次，属预期。
5. **收尾**：停用 Pi 仓库 fork 的私有打包与发布 workflow；远端机器（axbio、lanlab）确认没有 Gemini 的 `openai-completions` 路由。

### 逐项依据

| Pi fork 改动 | 结论 |
|---|---|

| 工具参数只在结束时解析（性能） | 官方 1.6.0 已消除逐片重扫：200 KiB 参数旧版 1.4.0 约 4.7 s CPU，fork 9.6 ms，1.6.0 17.5 ms，带转义多约 41 ms；截断与修复行为一致。多路并发未测 |
| 系统提示放到顶层 `instructions` | klaude-openai 已于 2026-11-22 改回 `input`（GPT-6.2 后端把 `instructions` 拼在 `input` 之后，系统提示每轮不命中缓存；Sub2API 账户开透传后不再补 Codex 内置提示）。不要让网关把 developer 消息归入 instructions |
| 关闭缓存后仍发送会话 ID 请求头 | 共享配置、公开示例和本地三台机器的 Responses 路由均未设置 `cacheRetention: none`。DSH 只转发显式配置，Pi 1.6.0 默认 `short` 且继续发送 `x-client-request-id`，因此不加插件。`session_id` 在 1.6.0 改名为 `session-id`；Claude 和 AGY 网关优先读 `x-client-request-id`，Sub2API 上游同时识别两种拼写；切换时验证三个网关的会话亲和性（尤其是实际部署的 Sub2API）。将来若关闭缓存，再用 `llm-pi-ai/request-headers` 按需给指定 provider 补头 |
| Gemini 走 Chat Completions 时的思考签名 | 共享配置、公开示例和本地三台机器均无 Gemini 的 `openai-completions` 路由；本地 Gemini 只走 `agy-gateway` 的 `openai-responses`；确认远端机器也没有该路由后，撤回 fork 时不保留这项改动 |

DSH 适配器 `llm-pi-ai` 上的相关 fork 改动：

- `errorCodeRules`（例如 `^upstream_error:` → `SERVER`）可移到 `llm/stream` 插件：在流的结尾改写错误码，再由 `llm-retry` 重试。klaude-cl 的 `^tool_protocol_error: Model called an unavailable tool:` → `PI_AI_ERROR` 规则必须一起迁移：它阻止内建分类器把 `web_fetch` 等工具名误判为可重试的 TRANSPORT／TIMEOUT，恢复交给 `tool-call-hint`。
- `supportsToolSearch` 是官方 pi-ai 字段，但上游 DSH 适配器的 compat 白名单不放行它；白名单这一处修改必须保留，删除后工具搜索失效。
