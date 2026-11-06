# DSH 0.2.2-rc.1 组合验收

本页记录目标组合、已执行的配置侧验证和后续成品验收。配置分支为 `upgrade/0.2.2-rc.1`，从 `feat/subagent-default-route` 创建，保留 fresh 路由、Responses 退化阈值与测试清理提交。当前尚未安装或激活这套组合；正式流程见[升级手册](<upstream-upgrade.md>)与[安装指南](<install.md>)，上一版结果仅作[历史实例](<upgrade-rc1.md>)。

## 1. 组合与依赖

[依赖清单](<../shared/dependencies.yaml>)选择 CLI `0.2.2-rc.1`、核心 fork `0.2.2-rc.1-fork1`、Pi `1.3.0-fork1`。核心包集合已逐一与本轮 CI 的 22 个根目录 tarball manifest 比较；上一版的 20 个 global fork 全部保留，新增 `@deepseek-ai/dsh-tool-executor-ptc` 和 `@deepseek-ai/dsh-experimental-client-ui-agent-team`。Team service、tools、UI 的 profile 依赖与全局 override 指向同一目标版本，不启用官方 Team profile bundle。

Pi 已有[正式 Release 资产](<https://github.com/TTTPOB/pi/releases/download/pi-ai-v1.3.0-fork1/earendil-works-pi-ai-1.3.0-fork1.tgz>)，本地同版 tarball 的 SHA256 已核实为 `0e8d79376b25c04d1fcb67ceb2d04a1e3bec804f3c6ec833fbacd15ef7fc7db1`。0.2.2 新增的 `@botiverse/oar` 也间接依赖 Pi；既有全局目标规划与隔离 installation/profile workspace 均已设置 `blockExoticSubdeps: false`，允许精确 URL override 作用于间接依赖，无需新增兼容层。

核心 fork 尚未发 Release，下表插件也尚未交付本轮 Release。清单仅保存目标版本和缺来源 `reason`，不猜 URL；旧版 `verifiedCompatibility` 已清空，待实际 runtime 拒绝和成品行为验证后再登记精确例外。

| 插件包 | 目标版本 |
|---|---|
| `dsh-workspace-overlay` | `0.4.0` |
| `dsh-workspace-envrc` | `0.4.0`（overlay peer 为 `^0.4.0`） |
| `dsh-session-tools` | `0.5.0` |
| `dsh-active-context` | `0.6.0` |
| `dsh-progressive-tools` | `0.6.0` |
| `dsh-mcp-panel` | `0.6.24-fork2` |
| `dsh-web-mobile` | `3.5.0` |

已对照目标源码 lockfile：LibreOffice Kit `0.1.5`、native loader／require-builtin `0.1.9`、`wsl-utils@1.0.0` 和 `@smithy/core@3.35.0` 均仍匹配，保留这些 pins。未重发的 Firecrawl、image-recovery、visualize、Better Sidebar 已发布资产已下载到隔离验收暂存；下载与 manifest 匹配不等于它们已通过新 runtime 的组合验收。

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

- 完整单元测试共 147 项：141 通过、0 失败；需要显式 `DSH_CLI_PACKAGE` 的 6 个既有 installed-Loader 集成用例按约定 skip，不将其报告为目标 runtime 成品通过。
- 三机私有输入均存在，`check` 全部退出 `0` 并列出待发布来源；公开 workstation、server、active-context、local-plugins 示例全部完成内存渲染和 patch 结构校验。
- 每个公开示例及三机的每个已生成 preset，persona／plan section 都经目标源码的真实 `renderPrompt` 成功渲染；变量名从目标 `agent-loop` 注册提取。没有读取 literal prompt-overlay 文件，未装载完整插件 assembly；完整 `renderContextSnapshot` 和成品提示词检查仍待下一阶段。
- 三机 `update --offline --json` 都退出 `2`，各报告 32 个缺来源条目；这是发布资产阻塞，不是配置结构失败。未执行 `--apply`。
- 五项变异检查分别删除 Team fresh 路由、忽略 required dependency、移除 executor 唯一性检查、绕过 smoke/catalog runtime 对齐、删除旧 tools 行迁移锚点；对应行为测试均失败，恢复实现后回归通过。未删除测试或添加兼容层。

## 4. 当前验收暂存：只差七个插件 tarball

本次生成的 `generated/upgrade-0.2.2-rc.1/assets/` 已包含本轮 22 个核心 tarball 的链接、校验过的 Pi tarball 链接和 4 个未变插件的正式资产。只扫目录根层，每个包仅放一个 tarball；不要把 CI 的重复 `raw/` 输入展开到同一目录。

```sh
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs \
  generated/upgrade-0.2.2-rc.1/assets \
  generated/upgrade-0.2.2-rc.1/input
```

实际结果：退出 `1`，仅报告本页版本表中七个插件包缺失；没有缺核心、Pi 或其他插件。prepare 在安装和 Host 启动前停止，未生成可执行的完整成品输入。这些暂存是本机忽略文件，不随配置 Git 提交交付；换机器时需重新下载／收集同版资产。

## 5. 待执行：插件到位后的组合验收

先把表中七个正确版本 tarball 放入上面的 assets 目录，同一包不得重复；下列准备与预览命令在配置仓库根执行，不安装、不启动 Host：

```sh
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/assets generated/upgrade-0.2.2-rc.1/input
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs check generated/upgrade-0.2.2-rc.1/input/machine.yaml
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/dsh-config.mjs update generated/upgrade-0.2.2-rc.1/input/machine.yaml --offline --verbose
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/assets --private workstation
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/assets --private server
export NODE_OPTIONS=--max-old-space-size=4096
node scripts/prepare-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/assets --private nas
```

本地 tarball 的准备不补齐正式 Release URL，因此离线 update 预览仍应退出 `2`；不得为让预览退出 `0` 编造来源或写兼容例外。

**另获隔离 Host 执行授权后**，逐个运行，不并发安装或启动实例：

```sh
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/input/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/profile-smoke-input-workstation/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/profile-smoke-input-server/argv.json
export NODE_OPTIONS=--max-old-space-size=4096
flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/profile-smoke-input-nas/argv.json
```

这些步骤尚未执行。完整 smoke 需要核对实际解析版本、唯一 executor、普通／Team 工具隔离、PTC native exceptions、每个 preset 的真实 prompt/context assembly、真实 per-call SDK 调用与 ACP 成功／拒绝路径。浏览器、手机真机、SSH helper、真实 provider／MCP 请求也尚未验收；外部请求另行授权。私有 prepare 按既有实现会使用本机存在的 prompt 文件，执行前须确认对 runtime 文本的读取授权。

最后等待 Release 发布，下载核验精确 URL／SHA256后再写入清单；按实际 runtime 拒绝决定是否需要新的精确兼容记录。正式安装、`update --apply` 和日用 Host 切换不属于本次工作。
