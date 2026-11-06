# DSH 0.2.2-rc.1 组合验收

本页记录目标组合、已执行的配置侧验证和后续成品验收。配置分支为 `upgrade/0.2.2-rc.1`，从 `feat/subagent-default-route` 创建，保留 fresh 路由、Responses 退化阈值与测试清理提交。当前仅完成受控隔离组合验收，尚未安装或激活日用组合；正式流程见[升级手册](<upstream-upgrade.md>)与[安装指南](<install.md>)，旧版验收记录从 Git 历史查阅。

## 1. 组合与依赖

[依赖清单](<../shared/dependencies.yaml>)选择 CLI `0.2.2-rc.1`、核心 fork `0.2.2-rc.1-fork1`、Pi `1.3.0-fork1`。核心包集合已逐一与本轮 CI 的 22 个根目录 tarball manifest 比较；上一版的 20 个 global fork 全部保留，新增 `@deepseek-ai/dsh-tool-executor-ptc` 和 `@deepseek-ai/dsh-experimental-client-ui-agent-team`。Team service、tools、UI 的 profile 依赖与全局 override 指向同一目标版本，不启用官方 Team profile bundle。

Pi 已有[正式 Release 资产](<https://github.com/TTTPOB/pi/releases/download/pi-ai-v1.3.0-fork1/earendil-works-pi-ai-1.3.0-fork1.tgz>)，本地同版 tarball 的 SHA256 已核实为 `0e8d79376b25c04d1fcb67ceb2d04a1e3bec804f3c6ec833fbacd15ef7fc7db1`。0.2.2 新增的 `@botiverse/oar` 也间接依赖 Pi；既有全局目标规划与隔离 installation/profile workspace 均已设置 `blockExoticSubdeps: false`，允许精确 URL override 作用于间接依赖，无需新增兼容层。

核心 22 个 fork 包与下表 7 个插件均已正式发布。已核对下载副本的 SHA256 与 Release 来源清单、包名和版本，32 个清单行（包含 global/profile 重复归属）已填入精确 URL 并删除未发布 `reason`。Pi 与 4 个未变插件也使用正式 Release 资产，共 34 个唯一 tarball；Pi SHA256 再次核对一致。

| 插件包 | 目标版本 |
|---|---|
| `dsh-workspace-overlay` | `0.4.0` |
| `dsh-workspace-envrc` | `0.4.0`（overlay peer 为 `^0.4.0`） |
| `dsh-session-tools` | `0.5.0` |
| `dsh-active-context` | `0.6.0` |
| `dsh-progressive-tools` | `0.6.0` |
| `dsh-mcp-panel` | `0.6.24-fork2` |
| `dsh-web-mobile` | `3.5.0` |

已对照目标源码 lockfile：LibreOffice Kit `0.1.5`、native loader／require-builtin `0.1.9`、`wsl-utils@1.0.0` 和 `@smithy/core@3.35.0` 均仍匹配，保留这些 pins。未重发的 Firecrawl、image-recovery、visualize、Better Sidebar 已发布资产已下载到隔离验收暂存；这些资产已参与下文的受控隔离组合验收。

## 2. 模板迁移与上游名称审计

已用 `git show <tag>:<path>` 比较 `dsh-v0.2.1-rc.1` 与 `dsh-v0.2.2-rc.1` 的各 bundle patch 和生产 `systemPrompt.variable` 注册，再逐项检查[模板](<../templates/home.patch.yml.njk>)及私有输入中的名称。

| 上游变化或用户决定 | 本轮处理 |
|---|---|
| scoped executor 取代 `tools.mode` | Host 的 discovery 行不变，禁用上游 Native/PTC executor，插入无 config 的 `dsh-progressive-tools/native`；每个自定义 preset 禁用上游 executor 并声明唯一 `dsh-progressive-tools/ptc`，把并行限制及 native exceptions 移到该行。保留 `tools` id、整行覆盖 `config: {}`，防止保守更新把旧 `mode` 配置重新保留下来。 |
| `/list-agents` 子路径导出删除 | 删除 `tool-subagent-list-agents` 行；`list_agents` 由完整 `tool-subagent-control` 提供。Team 分支仍只挂自己的控制工具。 |
| 普通 `modelSelectionSettings` 字段改动 | fresh 普通子代理改用 `modelSelection: true` 与 `modelDiscovery: true`；Team 的同名字段仍受支持，保留。 |
| fresh 模型路由 | 普通 `agentOptions` 与 Team `freshAgentOptions` 都从 `machine.subagentDefault` 渲染；`subagent_fork` 不设置机器路由，继续继承父模型。 |
| fs observation／apply_patch | 保留显式禁用 `fs-observation-policy`；preset 的 `tool-fs` 明确设置 `applyPatch: false`。 |
| 自定义模型默认上下文／输出 | 目标 Pi adapter 的缺省变为 1,000,000／128,000。模板没有旧缺省 override；共享 provider 中明确声明的模型容量与输出值保持用户原有选择，不用上游缺省覆盖显式配置。 |
| SSH 协议 2→3 | 由目标 runtime 提供；模板没有可迁移的协议号字段。实际远端 helper 协商待部署验收，不能混用旧 helper。 |
| session-tools 与内置 consumer 冲突 | 启用 session-tools 时整行禁用 `tool-session-query`，不共同注册两套检索工具。 |
| MCP Panel 的 PTC 直接调用 | 每个 PTC executor 的 `ptcNativeTools` 同时包含 `context_compress` 与 `mcp_probe`。 |
| Responses 退化阈值 | 保留共享 provider 的 2000／2000 决定。 |

**名称结论：** 这两个 tag 之间未发现需迁移的服务名改名；`webStartup` 已是两版使用的名称，不能把更早版本的 `webRuntime`→`webStartup` 当作本轮新变化。删除的是上述 `/list-agents` 模块导出与 bundle 行，不是 `list_agents` 工具。Web／headless 删除旧的 `tools.mode`／`DSH_TOOLS_MODE` overlay，但 `tools` 服务保留。prompt 变量仍仅注册 `provider`、`model`，没有新增、改名或删除；注册实现改为优先使用 `context.modelSelection`。模板的插值只使用受支持的 `{{model}}`。

其他 bundle 变化包括 SDK app 的 workspace／上传／调度／交付物行、Web 的文件交互与 entry customization，以及 CUA、Forge、Liveshare、推荐模块的新增行；本轮不自动启用这些可选 bundle。

**私有配置结论：** 仅检索名字并记录位置，未输出值或读取凭据。三机现有 `webStartup` 均为正确名称；未命中 `webRuntime`、`{{cwd}}`、旧 `/list-agents` 导出、旧 presentation 行或手写 executor 参数。server 的依赖输入／快照包含 `tool-session-query` 包名，不代表它应另行注册 consumer；现有模板的禁用条件负责与 session-tools 分流。没有必须让用户手改的私有名称迁移项。

## 3. 已执行：配置侧验证

每条命令前均设置 `export NODE_OPTIONS=--max-old-space-size=4096`；重进程通过 `flock /tmp/dsh-heavy-build.lock` 串行运行。

```sh
export NODE_OPTIONS=--max-old-space-size=4096
pnpm test
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs check --machine workstation
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs check --machine server
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs check --machine nas
```

- 完整单元测试共 148 项：142 通过、0 失败；需要显式 `DSH_CLI_PACKAGE` 的 6 个 installed-Loader 集成用例按约定 skip。其中工具指引的目标 runtime 集成另在一次性安装中运行通过，见下文。
- 三机私有输入均存在，正式来源补齐后 `check` 全部退出 `0`，没有待发布来源；公开 workstation、server、active-context、local-plugins 示例全部完成内存渲染和 patch 结构校验。
- 每个公开示例及三机的每个已生成 preset，persona／plan section 都经目标源码的真实 `renderPrompt` 成功渲染；变量名从目标 `agent-loop` 注册提取。没有读取 literal prompt-overlay 文件，该项仅覆盖配置文本；完整 `renderContextSnapshot` 和成品提示词检查见下文隔离组合验收。
- 三机 `update --offline --verbose --json` 均退出 `0`、`blocked: 0`；workstation／server／nas 变化总条目分别为 41／42／41（workstation 含一项 retired override 移除）。这是与 installation 参数／快照的来源比较，不是当前实际安装的版本验收。未执行 `--apply`。
- 五项变异检查分别删除 Team fresh 路由、忽略 required dependency、移除 executor 唯一性检查、绕过 smoke/catalog runtime 对齐、删除旧 tools 行迁移锚点；对应行为测试均失败，恢复实现后回归通过。未删除测试或添加兼容层。

## 4. 受控输入与离线预览

`generated/upgrade-0.2.2-rc.1/release-assets/` 已备齐 34 个正式 Release tarball：22 个核心 fork、Pi、表中 7 个新插件和 4 个未变插件。每个包在目录根层只保留一个 tarball；这些忽略目录不随 Git 提交交付，换机器时需重新收集同版资产。

以下命令已使用正式 Release 输入重新执行。prepare 输出 `Prepared 3 presets and 34 tarballs (0 local)`，公开受控输入的 `check` 退出 `0`；正式来源补齐后离线 update 退出 `0`，没有缺来源阻塞。

```sh
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-assets generated/upgrade-0.2.2-rc.1/release-public
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs check generated/upgrade-0.2.2-rc.1/release-public/machine.yaml
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs update generated/upgrade-0.2.2-rc.1/release-public/machine.yaml --offline --verbose
```

prepare 为机器输入声明输出目录下的 `deployment.home`，供 `check`／update 预览解析共享本地插件路径；预览不安装该 home。`isolatedTest` 仍使用自己拥有并自动清理的临时 home。受控 smoke patch 从仓库源码加载本地插件，并在 Loader 求值凭据表达式前禁用外部 MCP；三机私有变体保留本地行与字面表达式，不请求真实 provider／MCP。

## 5. 已执行：隔离组合验收

以下命令按顺序执行，每个 smoke 使用独立临时 DSH_HOME、独立端口，并在成功或失败后回收本次 Host 与暂存目录。

```sh
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-public/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-assets generated/upgrade-0.2.2-rc.1/release-workstation --private workstation
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-workstation/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-assets generated/upgrade-0.2.2-rc.1/release-server --private server
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-server/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-assets generated/upgrade-0.2.2-rc.1/release-nas --private nas
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-nas/argv.json
```

公开输入、workstation、server、NAS 已用正式 Release 成品串行重跑，均退出 `0`；三份私有 prepare 也均输出 3 presets／34 tarballs（0 local），每轮实际核对 44 个包／安装归属。每个输入的 standard、Team、redteam 三个 preset 均完成真实 prompt/context assembly、工具隔离与实际模块版本检查，模型可见工具恰为 `run_code` 和配置声明的 native exceptions（本轮为 `context_compress`、`mcp_probe`）；真实 per-call SDK 调用、ACP 拒绝输入不改 Surface、成功提交及次步归档均通过。报告为 `modelRequests: 0`、`cleaned: true`，Web 验证只覆盖认证交换与页面 HTTP 请求，`browserChecked: false`。配置侧仍报告 `renderedConfigurationVerified: false`：验收的是受控组合，不是整份日用配置。

### 正式 runtime 的精确兼容拒绝

本轮 generated 验收入口在任何临时豁免前，用隔离安装的官方 `evaluatePluginCompatibility` 执行 doctor。四套输入都只发现相同的 16 个精确拒绝，没有其他安装或 built-entry 问题；临时安装仅对实际拒绝项执行 `allow-version`。四轮 smoke 全部通过后，清单只登记其中 15 个 DSH fork 与 `0.2.2-rc.1` 的精确组合，不给其他核心包、Pi 或七个新插件批量授权。

第 16 项为旧 `@firecrawl/dsh-firecrawl@0.2.0-fork1`，官方拒绝原因是它要求 `@deepseek-ai/dsh-launch-environment: 0.2.1-rc.1` 和 `@deepseek-ai/dsh-web: 0.2.1-rc.1`。本轮只有占位 key 下的加载和工具注册证据，没有真实 Firecrawl 请求，**不登记其永久兼容豁免**。离线 update 没有缺来源阻塞不表示真实 apply 已能通过兼容检查；Firecrawl 等待正规升级到 0.2.2 后的新 Release，不对旧版补豁免；新成品到位后再做真实自建服务行为验收。临时验收豁免随隔离 home 一并清理。

### 失败根因与回归

- 初次 `profile-install` 退出 `1` 来自外层组合验收步骤：日志显示 pnpm 安装、兼容检查与 Host 启动已完成，未发现包安装失败。HTTP `500` 来自本地 `GET /__dsh-config-smoke`，其 handler 将探针断言 `standard-ptc: missing run_code` 返回给客户端；随后客户端的 `500 !== 200` 是同一失败。
- DSH 0.2.2 的 `run_code` 是 executor 生成的 transport，不属于 `tools.schemas()` 的能力注册表。探针分别校验注册能力和最终 `assembly.tools`，后者严格要求 transport 加已声明的 native exceptions；`tools.execute()` 探针调用也使用本轮 batch `calls`／`results` API。`dsh-progressive-tools/ptc` 已组合上游 PTC executor，无需再装一行 executor。
- 本地 runtime-tooling-guidance 使用公开 presentation waterfall；DSH 0.2.2 在该事件结束后才附加 tools。插件根据上游 executor 的 `tools:ptc-only`／`tools:sdk` section 及当前 scope／step 可见能力生成指引，不访问私有 executor 方法。prepare 的共享本地插件 home 缺失和受控模块路径／MCP 隔离缺口也已修复。
- 相关配置／部署／smoke 测试 88 项：87 通过，1 项未设置 `DSH_CLI_PACKAGE` 时按约定 skip。另复用一次性目标安装运行真实 Loader 集成测试：2 项通过、0 skip；上游 Native/PTC executor 均从临时 YAML 经 Include 加载。Native scope 成功组装并生成 native 指引；将它错误交给 PTC 专用校验的负向用例按预期拒绝，PTC scope 正常通过并生成 PTC 指引。
- 五项新增变异均使对应行为测试失败，恢复后通过：删除预览 home、删除本地模块路径改写、启用外部 MCP、恢复旧 `assembled.tools` 读取、改错上游 PTC section id。未新增兼容层或豁免，也未修改任何插件包／DSH fork 源码。

## 6. 待执行

浏览器操作、手机真机、SSH helper、真实 provider／MCP 请求仍待验收，外部请求另行授权。Firecrawl 的 0.2.2 升级 Release 与真实自建服务请求验收仍待完成；真实安装、`update --apply` 和日用 Host 切换未执行。
