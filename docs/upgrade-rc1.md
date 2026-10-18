# DSH 0.2.1-rc.1 组合验收

本页记录 DSH 0.2.1-rc.1 的个人 profile 组合、验证命令与本次结果。后续版本的步骤顺序、fork 文件、Actions 发布和授权边界见[上游升级手册](<upstream-upgrade.md>)；真实安装与维护切换见[正式维护指南](<install.md>)。下面的成品 smoke 会启停自己创建的隔离 Host，执行前需要明确授权。

## 1. 组合与依赖

- 标准＋PTC、可选逆向 preset 使用 `mode: ptc`。Home patch 按 id 整行重述 base 的 Node provider `ptc-runtime` 配置，设置 `executionMode: per-call` 并重述 rc.1 的资源默认值。rc.1 的 Node provider 固定 `language: typescript`，非 persistent 模式返回 `programFormat: function-body`；因此 `run_code` 是支持 `return` 的异步函数体，不是 Python 或 REPL。每个 Agent 的 runtime 都在 smoke 中再次断言。
- 所有自定义 preset 都不挂载 `present`。Spawn 与 fork 子代理沿用父会话的工具组合，因此同样没有 `present`，不需要单独的子代理 preset。
- “标准+PTC+Team”只挂 Team 委托与控制工具，保留 Workflow／Ralph。普通 preset 保留普通子代理工具，没有 `spawn_teammate`。Team service 与 UI 是全局单例，模型工具只在 Team preset 中注册。
- Team 工具依赖 `@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.1-fork1` 的作用域修复；官方 rc.1 工具的启动遍历会向其他顶层 Agent 注册工具。必须同时验证普通与 Team Agent，不能只测 Team。
- 官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 是随 CLI 生产依赖交付、也单独发布到 registry 的组合包，默认未启用。它会全局插入 Team 工具并禁用普通控制行，因此本配置显式声明 service、tools、UI，不启用其 bundle patch。官方 service/UI 使用精确 registry 版本，工具 fork 同时登记 global override 与 profile Release dependency，确保 profile 解析也命中修复版。

[依赖清单](<../shared/dependencies.yaml>)固定 CLI 为 `0.2.1-rc.1`、核心 fork 为 `0.2.1-rc.1-fork1`、Pi 为 `1.1.0-fork1`。LibreOffice Kit 固定 `0.1.5`，native loader／require-builtin 固定 `0.1.9`；rc.1 lockfile 仍使用 `wsl-utils@1.0.0` 与 `@smithy/core@3.35.0`。退休列表删除 ui-settings override，仍受管的全局包（核心、Pi 与 pins）旧版本选择器归一为裸包名，以匹配 rc.1 的依赖版本。无关 overrides 保留。

MCP Panel 使用 registry `0.6.24`，其 engines 与 DSH peers 已包含 `>=0.2.1-0 <0.3.0`。与 `0.6.19` 的[版本比较](<https://github.com/PerryLink/dsh-mcp-panel/compare/v0.6.19...v0.6.24>)显示配置 schema 未改，runtime 源码只更新 MCP probe 的 clientInfo 版本；其余主要是兼容声明、测试 Loader 失败报告、CI、文档与发布修正。实际 profile 解析仍须确认 connection 命中 fork1、ui-settings 命中官方 rc.1。

本次 11 个 GitHub Actions Release 已交付 23 个唯一 tarball，资产包名、版本与 SHA256 已核对，清单保存精确 URL；Team 工具的 global override 与 profile dependency 共用同一已核实资产。`verifiedCompatibility` 只登记成品 smoke 通过、且官方 runtime 兼容检查确实要求豁免的精确组合，不按 fork 名称批量授权。缺来源仍由 `check` 单独列出，并使 `update` 以退出码 `2` 阻塞。

## 2. 第一阶段：不安装、不启动 Host

在配置仓库根目录执行：

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  tests/deployment-paths.test.mjs tests/deployment.test.mjs tests/config.test.mjs \
  tests/prompt-sections.test.mjs tests/profile-smoke.test.mjs
node scripts/dsh-config.mjs check examples/workstation-machine.yaml
node scripts/dsh-config.mjs check examples/active-context-machine.yaml
node scripts/dsh-config.mjs update examples/workstation-machine.yaml --offline --verbose
```

已核实来源的离线预览应返回 `0`；缺少精确来源时仍返回 `2`，不是配置 schema 失败。以上命令不要求私有参数。持有当前机器私有参数时，可另外执行 `check --machine <name>` 与默认 live `update --machine <name>`，但不要加 `--apply`；live 预览只读取目标 manifests。

源码 schema 检查使用 rc.1 checkout 的 tsx loader，直接调用 Config／自定义 resolver，不挂载插件。先设置绝对路径变量 `CONFIG_ROOT`、`RUNTIME_SOURCE` 和可选的 `EXTERNAL_SOURCE_ROOT`（树外插件 checkout 的父目录）：

```sh
(cd "$RUNTIME_SOURCE" && NODE_OPTIONS=--max-old-space-size=4096 \
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

准备入口只生成无凭据的受控输入和 [测试 argv](<../scripts/prepare-profile-smoke.mjs>)，不安装、不启动 Host。它启用 ACP、session-tools 与 prompt-sections，覆盖三个生成 preset；加入所有受管 profile 包；关闭 Codegraph MCP；使用不会发请求的 Firecrawl 占位 key；用本次生成的固定文本测试 prompt-sections。它不需要临时私有参数副本，也不读取真实凭据或日用会话。

加 `--private workstation` 或 `--private server` 时，改用该机 `private/machines/<机器>/machine.yaml` 的 overrides 与 home/Web 私有行，输出默认放在 `generated/profile-smoke-input-<机器>`。外部服务行（全部 MCP client 与 Firecrawl）被移除，其余私有行连同 `!!js` 表达式按原样加载，所以已改名的服务（例如 `ctx.webRuntime`）会在隔离 Host 启动时失败。本机存在的真实 prompt 文件也会一起使用。provider 行只加载、不发请求；不要把含凭据的完整 dump 输出到对话。

```sh
node scripts/prepare-profile-smoke.mjs "$TARBALL_DIR" --private workstation
node scripts/prepare-profile-smoke.mjs "$TARBALL_DIR" --private server
```

## 4. 第二阶段：执行隔离 Host smoke

获得执行通知后，在配置仓库根目录运行：

```sh
NODE_OPTIONS=--max-old-space-size=4096 node scripts/run-profile-smoke.mjs \
  "$CONFIG_ROOT/generated/profile-smoke-input/argv.json"
```

这个 argv 实际执行 `dsh-config test <受控参数> --tarball package=/absolute/asset.tgz ...`。每个 Release 包通过 `--tarball` 提供，包括 Team tool fork；同一资产供 global override 与 profile dependency 使用。

测试入口执行以下步骤：

1. `test` 创建独立临时目录、独立 `DSH_HOME`、安装 manifests、受控 home/Web patch 与 tarball 副本。
2. 按[长期 pnpm 11 规则](<install.md#pnpm-11-安装规则>)准备隔离 installation 与 Web profile 的 workspace、构建许可和共享 peers。
3. 用 pnpm 安装官方 `@deepseek-ai/dsh@0.2.1-rc.1` 与全部选定成品。临时风险豁免只写隔离 profile，不写共享兼容记录或真实 profile。
4. 通过该 CLI 的 `--dump-config` 检查三个 PTC preset、ACP 默认比例 0.70／0.65、没有精确 routes、Basic 配置完整、没有全局 Team 工具、Web 监听为 `127.0.0.1:0`。端口 `0` 由 OS 分配，不使用日用端口。
5. 启动同一个隔离 CLI 的 Web profile。临时 Loader probe 等待挂载审计，通过正式 pluginPackages resolver 核对全部受管包的实际版本及官方 ui-settings，检查 overlay／envrc／Team service，以及 session-tools／progressive-tools 的工具注册。
6. 同时创建三个空闲 Agent，防止 Team 启动遍历的跨 preset 泄漏漏测。普通 preset 必须有普通 subagent/control 且没有 `spawn_teammate`；Team preset 必须有 Team 控制、wait/task 工具且没有 subagent/fork。检查 `send_message` 参数来自正确实现、工具名无重复、任何 preset 都没有 `present`。
7. 每个 Agent 用默认模型创建（与 Web 会话相同），probe 用真实 `renderPrompt` 渲染静态提示词，并刷新、渲染 runtime context；未注册或无值的 `{{变量}}` 会以 preset 名报错。检查每个 Agent 的 PTC runtime 为 TypeScript／function-body，以及实际提示词 assembly 有 `run_code` 与 ACP SDK；通过真实 `run_code` 调用各自的 `list_agents`；ACP SDK 的存在从真实 assembly 校验，不在普通程序中引用受限的 `tools.context_compress`。ACP SDK 只从真正的 `tools:sdk` section 检查，不能由 active-context 提示文字代替。再在一个 ACP Agent 中追加合成历史与工具调用日志，经真实 per-call Node 子进程分别验证空 regions 拒绝和合法区间成功：`return await tools.context_compress({"regions":[]});` 必须到达“submit 1-N non-overlapping regions”的参数拒绝，拒绝前后既有 Surface 节点不变、没有 compaction summary；合法规范调用必须提交摘要，下一 step 的生产 pre-step 链用维护记录替换成功根 run_code call/result，Surface 上摘要只出现一次。不发起模型请求、不创建 teammate。
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

本次已用已发布的 23 个成品通过一次完整隔离 Host smoke：三个 preset 的 PTC／ACP、普通与 Team 工具隔离、实际包版本及官方 ui-settings 均通过；零模型请求，非法 ACP 调用在压缩前拒绝且 Surface 不变，临时 Host 与安装已清理。ACP v0.5.1 成品复验同时通过默认比例／完整 Basic dump 检查、真实 SDK section 校验，以及真实 Node per-call 成功压缩、下一 step 根工具对维护和摘要单次呈现；该轮没有重跑浏览器交互。Playwright 基础检查通过：390×844 触屏三页切换与 aria-current、插件 modal 保持主页面且关闭后导航可用、1280×800 鼠标首页无移动底部导航，两端 pageerror／console error 均为零。没有生成带真实 token 用量的会话，usage／activity pill 不计作通过；真实 provider／Firecrawl、IME、真实软键盘、PWA、剪贴板、系统返回与复杂审批／终端交互仍未覆盖。受控组合通过不代表整份日用私有配置已验证或已应用。

准备目录不是 Host 数据目录。确认无需重跑后，只删除本次 `generated/profile-smoke-input`；不要清空整个 generated 或任何日用 home。
