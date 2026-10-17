# DSH 0.2.1-rc.1 组合验收

本页供维护者验证个人 profile 的升级组合。配置仓库的单元测试与 schema 检查不启动 Host；下面的成品 smoke 会启动并停止它自己创建的隔离 Host，执行前需要对应授权。发布与日用安装仍按[正式维护指南](<install.md>)另行进行。

## 1. 组合与依赖

- 标准＋PTC、可选逆向 preset 使用 `mode: ptc`。Home patch 按 id 整行重述 base 的 Node provider `ptc-runtime` 配置，设置 `executionMode: per-call` 并重述 rc.1 的资源默认值。rc.1 的 Node provider 固定 `language: typescript`，非 persistent 模式返回 `programFormat: function-body`；因此 `run_code` 是支持 `return` 的异步函数体，不是 Python 或 REPL。每个 Agent 的 runtime 都在 smoke 中再次断言。Spawn 默认选择对应的 `*-child` preset，且 `allowedAgentPresets` 只允许这个不含 `present` 的组合。子代理 preset 也可在 preset 列表中看到。
- Fork 继承父上下文与 preset。rc.1 拒绝 fork 的独立 `agentPreset`／`allowedAgentPresets`，因此父 preset 有 `present` 时，fork 仍可使用它；没有额外过滤插件。
- “标准+PTC+Team”只挂 Team 委托与控制工具，保留 Workflow／Ralph。普通 preset 保留普通子代理工具，没有 `spawn_teammate`。Team service 与 UI 是全局单例，模型工具只在 Team preset 中注册。
- Team 工具依赖 `@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.1-fork1` 的作用域修复；官方 rc.1 工具的启动遍历会向其他顶层 Agent 注册工具。必须同时验证普通与 Team Agent，不能只测 Team。
- 官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 是随 CLI 生产依赖交付、也单独发布到 registry 的组合包，默认未启用。它会全局插入 Team 工具并禁用普通控制行，因此本配置显式声明 service、tools、UI，不启用其 bundle patch。官方 service/UI 使用精确 registry 版本，工具 fork 同时登记 global override 与 profile Release dependency，确保 profile 解析也命中修复版。

[依赖清单](<../shared/dependencies.yaml>)固定 CLI 为 `0.2.1-rc.1`、核心 fork 为 `0.2.1-rc.1-fork1`、Pi 为 `1.1.0-fork1`。LibreOffice Kit 固定 `0.1.5`，native loader／require-builtin 固定 `0.1.9`；rc.1 lockfile 仍使用 `wsl-utils@1.0.0` 与 `@smithy/core@3.35.0`。退休列表删除 ui-settings override，仍受管的全局包（核心、Pi 与 pins）旧版本选择器归一为裸包名，以匹配 rc.1 的依赖版本。无关 overrides 保留。

MCP Panel 使用 registry `0.6.24`，其 engines 与 DSH peers 已包含 `>=0.2.1-0 <0.3.0`。与 `0.6.19` 的[版本比较](<https://github.com/PerryLink/dsh-mcp-panel/compare/v0.6.19...v0.6.24>)显示配置 schema 未改，runtime 源码只更新 MCP probe 的 clientInfo 版本；其余主要是兼容声明、测试 Loader 失败报告、CI、文档与发布修正。实际 profile 解析仍须确认 connection 命中 fork1、ui-settings 命中官方 rc.1。

新 Release 条目在资产发布并核实前只保存目标版本与“待发布来源”，没有推测 URL。`check`通过结构检查后另列缺来源；`update` 预览以退出码 `2` 报告阻塞。`verifiedCompatibility` 只记录实际验证过的精确组合，本次成品 smoke 前为空。

## 2. 第一阶段：不安装、不启动 Host

在配置仓库根目录执行：

```sh
NODE_OPTIONS=--max-old-space-size=3072 node --test \
  tests/deployment-paths.test.mjs tests/deployment.test.mjs tests/config.test.mjs \
  tests/prompt-sections.test.mjs tests/profile-smoke.test.mjs
node scripts/dsh-config.mjs check examples/workstation-machine.yaml
node scripts/dsh-config.mjs check examples/active-context-machine.yaml
node scripts/dsh-config.mjs update examples/workstation-machine.yaml --offline --verbose
```

最后一条在新资产尚未发布时应返回 `2`，不是配置 schema 失败。以上命令不要求私有参数。持有当前机器私有参数时，可另外执行 `check --machine <name>` 与默认 live `update --machine <name>`，但不要加 `--apply`；live 预览只读取目标 manifests。

源码 schema 检查使用 rc.1 checkout 的 tsx loader，直接调用 Config／自定义 resolver，不挂载插件。先设置绝对路径变量 `CONFIG_ROOT`、`RUNTIME_SOURCE` 和可选的 `EXTERNAL_SOURCE_ROOT`（树外插件 checkout 的父目录）：

```sh
(cd "$RUNTIME_SOURCE" && NODE_OPTIONS=--max-old-space-size=3072 \
  node --import tsx/esm "$CONFIG_ROOT/scripts/check-runtime-schemas.mjs" \
  "$RUNTIME_SOURCE" "$CONFIG_ROOT/examples/active-context-machine.yaml" "$EXTERNAL_SOURCE_ROOT")
```

检查会跳过 disabled 插件及不在映射中的树外插件；有 `EXTERNAL_SOURCE_ROOT` 时同时校验 progressive-tools、overlay、envrc 与 ACP 的配置。工具、服务和 Loader 的实际挂载由下一阶段确认。

## 3. 第二阶段：准备完整成品输入

等待核心与所有树外 tarball 完成，再设置 `TARBALL_DIR` 为它们所在的绝对目录。目录中同一包只能有一个 tarball，版本必须与清单相同；缺包、重复包或版本不一致都会在安装前停止。

```sh
node scripts/prepare-profile-smoke.mjs "$TARBALL_DIR" "$CONFIG_ROOT/generated/profile-smoke-input"
node scripts/dsh-config.mjs check "$CONFIG_ROOT/generated/profile-smoke-input/machine.yaml"
node scripts/dsh-config.mjs update "$CONFIG_ROOT/generated/profile-smoke-input/machine.yaml" --offline --verbose
```

准备入口只生成无凭据的受控输入和 [测试 argv](<../scripts/prepare-profile-smoke.mjs>)，不安装、不启动 Host。它选择 ACP、session-tools 与逆向模式，覆盖五个生成 preset；加入所有受管 profile 包；关闭 Codegraph MCP；使用不会发请求的 Firecrawl 占位 key；用本次生成的固定文本测试 prompt-sections。它不需要临时私有参数副本，也不读取真实凭据或日用会话。

需要另外核对日用私有参数时，在私有副本中保留原字段文本且只改部署位置，使用独立 home/profile/installation。日用 MCP、provider 和认证配置不在此公开 smoke 的验收范围内，不把含凭据的完整 dump 输出到对话。

## 4. 第二阶段：执行隔离 Host smoke

获得执行通知后，在配置仓库根目录运行：

```sh
NODE_OPTIONS=--max-old-space-size=3072 node scripts/run-profile-smoke.mjs \
  "$CONFIG_ROOT/generated/profile-smoke-input/argv.json"
```

这个 argv 实际执行 `dsh-config test <受控参数> --tarball package=/absolute/asset.tgz ...`。每个 Release 包通过 `--tarball` 提供，包括 Team tool fork；同一资产供 global override 与 profile dependency 使用。

测试入口执行以下步骤：

1. `test` 创建独立临时目录、独立 `DSH_HOME`、安装 manifests、受控 home/Web patch 与 tarball 副本。
2. 在隔离 installation 与 Web profile 各写 `pnpm-workspace.yaml`，放入 overrides、`blockExoticSubdeps: false` 和明确的 `allowBuilds`（包括 koffi、esbuild、node-pty 和官方 subprocess-local 的 spawn-helper postinstall）；不使用 `--ignore-workspace`，不创建项目 store/cache。
3. CLI installation 启用 `autoInstallPeers`，补齐 app-boot 等 Host 自身的 bootstrap peers；profile 关闭它，由正式 resolver 共享 Host 实例。用 pnpm 安装官方 `@deepseek-ai/dsh@0.2.1-rc.1` 与全部选定成品。临时风险豁免只写隔离 profile，不写共享兼容记录或真实 profile。
4. 通过该 CLI 的 `--dump-config` 检查五个 PTC preset、没有全局 Team 工具、Web 监听为 `127.0.0.1:0`。端口 `0` 由 OS 分配，不使用日用端口。
5. 启动同一个隔离 CLI 的 Web profile。临时 Loader probe 等待挂载审计，通过正式 pluginPackages resolver 核对全部受管包的实际版本及官方 ui-settings，检查 overlay／envrc／Team service，以及 session-tools／progressive-tools 的工具注册。
6. 同时创建五个空闲 Agent，防止 Team 启动遍历的跨 preset 泄漏漏测。普通 preset 必须有普通 subagent/control 且没有 `spawn_teammate`；Team preset 必须有 Team 控制、wait/task 工具且没有 subagent/fork。检查 `send_message` 参数来自正确实现、工具名无重复、子代理 preset 没有 `present`。
7. 检查每个 Agent 的 PTC runtime 为 TypeScript／function-body，以及实际提示词 assembly 有 `run_code` 与 ACP SDK；通过真实 `run_code` 调用各自的 `list_agents`；ACP SDK 的存在从真实 assembly 校验，不在普通程序中引用受限的 `tools.context_compress`。再在一个 ACP Agent 中追加合成的工具调用日志，经真实 per-call Node 子进程执行 `return await tools.context_compress({"regions":[]});`，必须到达“submit 1-N non-overlapping regions”的参数拒绝，而不是只在独立调用 guard 被挡住；断言拒绝前后既有 Surface 节点不变、没有 compaction summary。不发起模型请求、不创建 teammate、不实际压缩上下文。
8. 无论 probe 成功或失败，停止并等待自己启动的 Host；子进程 TMPDIR 位于隔离根内，`test` 的 finally 一并清理此次安装、会话、logs、dump、临时缓存和 tarball 副本。

外层 `test` 固定返回 `renderedConfigurationVerified: false`：本次验证的是明确构造的受控组合，不是整份日用私有配置。Host 挂载与工具注册成功也不等于手机布局、浏览器交互或真实 Firecrawl 请求已验收；客户端与实网行为仍由对应功能测试确认。

### 浏览器与手机基础检查

入口自动检查隔离 Web 首页返回 `200` 且包含 `window.__DSH_BOOT__`。需要让 Playwright 在 Host 存活期间检查时，给同一命令加 shell-free browser runner；`{url}` 替换为本次随机端口地址，runner 的非零退出会使 smoke 失败并执行 Host 清理：

```sh
DSH_CONFIG_BROWSER_SMOKE_ARGV='["node","/absolute/path/to/browser-smoke.mjs","{url}"]' \
  node scripts/run-profile-smoke.mjs "$CONFIG_ROOT/generated/profile-smoke-input/argv.json"
```

浏览器 runner 在第二阶段按实际页面固定以下基础断言，不通过注入假 DOM 伪造：

1. 使用 390×844、`hasTouch: true` 的上下文；打开本次 URL，等待 `html[data-mobile-workbench-active="true"]` 与唯一的 `[data-mobile-workbench="navigation"]`。
2. 通过真实 UI 选择／新建隔离会话；依次进入会话列表、会话、工作区，核对 `data-mobile-workbench-page` 为 `sessions`／`session`／`files`，以及导航的 `aria-current="page"`。不发送模型请求。
3. 检查 `[data-composer-stat="activity"]` 与 `[data-composer-stat="usage"]` 的实际呈现和详情点击；没有 usage 数据时明确记录“未覆盖”，不能把没有 pill 当作通过。
4. 通过插件按钮打开官方管理器，核对出现 modal 而非切换主页面；关闭后仍能使用三页导航。
5. 用 1280×800 的鼠标上下文确认移动导航不生效，保存两种布局的截图并收集页面错误。

本阶段只实现了 browser runner 接口，没有运行 Playwright，也没有把缺失数据的 usage／activity 或 modal 场景标成已通过。IME、真实软键盘、PWA、剪贴板、系统返回与复杂审批／终端交互仍为真机人工验收。

准备目录不是 Host 数据目录。确认无需重跑后，只删除本次 `generated/profile-smoke-input`；不要清空整个 generated 或任何日用 home。
