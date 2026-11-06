# DSH 0.2.2-rc.1 组合验收

本页记录 DSH 0.2.2-rc.1 组合的目标版本、配置迁移、验收方法和结果，供部署时核对，也供下次升级参考。升级流程见[升级手册](<upstream-upgrade.md>)，安装和切换见[安装指南](<install.md>)。

## 1. 组合

[依赖清单](<../shared/dependencies.yaml>)选择以下版本，全部来自 GitHub Release 正式资产：

| 组件 | 版本 |
|---|---|
| DSH CLI | `0.2.2-rc.1` |
| DSH fork 包（22 个） | `0.2.2-rc.1-fork1` |
| Pi | `1.3.0-fork1` |
| `dsh-workspace-overlay` | `0.4.0` |
| `dsh-workspace-envrc` | `0.4.0`（peer overlay `^0.4.0`） |
| `dsh-session-tools` | `0.5.0` |
| `dsh-active-context` | `0.6.0` |
| `dsh-progressive-tools` | `0.6.0` |
| `dsh-mcp-panel` | `0.6.24-fork2` |
| `dsh-web-mobile` | `3.5.0` |
| `@firecrawl/dsh-firecrawl` | `0.2.0-fork2` |

与 0.2.1-rc.1 相比，fork 包新增 `@deepseek-ai/dsh-tool-executor-ptc`（PTC native exceptions）和 `@deepseek-ai/dsh-experimental-client-ui-agent-team`（Team 面板的已归档成员分组）。Team 的 service、tools 和 UI 的 profile 依赖与全局 override 使用同一资产；不启用官方 Team profile bundle。

上游 0.2.2 新增的 `@botiverse/oar` 也依赖 Pi。pnpm 默认拒绝从 URL 安装间接依赖，所以全局规划和隔离 workspace 都设置了 `blockExoticSubdeps: false`，让 Pi 的 URL override 同样作用于间接依赖。

image-recovery、visualize、Better Sidebar 沿用已发布版本。

## 2. 配置迁移

对比 `dsh-v0.2.1-rc.1` 和 `dsh-v0.2.2-rc.1` 的各 bundle patch 和 `systemPrompt.variable` 注册后，[模板](<../templates/home.patch.yml.njk>)做了以下修改：

| 上游变化或用户决定 | 模板处理 |
|---|---|
| scoped executor 取代 `tools.mode` | Host 保留 progressive-tools 的 discovery 行，禁用上游 Native/PTC executor，插入无 config 的 `dsh-progressive-tools/native`。每个自定义 preset 禁用上游 executor，声明一行 `dsh-progressive-tools/ptc`，并行限制和 native exceptions 写在这一行。`tools` 行保留并整行写为 `config: {}`，防止保守更新留下旧的 `mode`。 |
| 删除 `/list-agents` 子路径导出 | 删除 `tool-subagent-list-agents` 行；`list_agents` 由 `tool-subagent-control` 提供。 |
| 普通子代理选模字段改名 | 改用 `modelSelection: true` 和 `modelDiscovery: true`。Team 的 `modelSelectionSettings` 仍受支持，保留。 |
| fresh 子代理的模型路由 | 普通 `agentOptions` 和 Team 的 `freshAgentOptions` 都由 `machine.subagentDefault` 渲染；`subagent_fork` 不设路由，继承父模型。 |
| `apply_patch` | preset 的 `tool-fs` 写明 `applyPatch: false`；`fs-observation-policy` 保持禁用。 |
| 自定义模型的默认上下文/输出改为 1,000,000/128,000 | 模板没有依赖旧默认值；`shared/providers.yaml` 中显式声明的容量和输出值不变。 |
| session-tools 与上游 `tool-session-query` 功能重叠 | 启用 session-tools 时整行禁用 `tool-session-query`。 |
| MCP Panel 在 PTC 中直接调用 | 每个 PTC executor 的 `ptcNativeTools` 包含 `context_compress` 和 `mcp_probe`。 |
| Responses 退化检测阈值 | 保持 2000/2000。 |

两个 tag 之间没有需要迁移的服务改名；prompt 变量仍只有 `provider` 和 `model`。三台机器的私有配置不需要手改。

## 3. 验收方法

每条命令都在 `export NODE_OPTIONS=--max-old-space-size=4096` 之后运行，安装和 Host 类命令用 `flock /tmp/dsh-heavy-build.lock` 串行。

1. 配置测试与机器检查：

   ```sh
   pnpm test
   node scripts/dsh-config.mjs check --machine workstation
   node scripts/dsh-config.mjs check --machine server
   node scripts/dsh-config.mjs check --machine nas
   ```

2. 把全部正式 Release tarball 放进一个目录（每个包只放一个 tarball），生成受控输入并预览：

   ```sh
   node scripts/prepare-profile-smoke.mjs <资产目录> generated/upgrade-0.2.2-rc.1/release-public
   node scripts/dsh-config.mjs check generated/upgrade-0.2.2-rc.1/release-public/machine.yaml
   node scripts/dsh-config.mjs update generated/upgrade-0.2.2-rc.1/release-public/machine.yaml --offline --verbose
   ```

3. 隔离组合验收。先跑公开输入，再依次跑三台机器的私有配置：

   ```sh
   flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-public/argv.json
   node scripts/prepare-profile-smoke.mjs <资产目录> generated/upgrade-0.2.2-rc.1/release-workstation --private workstation
   flock /tmp/dsh-heavy-build.lock node scripts/run-profile-smoke.mjs generated/upgrade-0.2.2-rc.1/release-workstation/argv.json
   ```

   server 和 nas 把 `workstation` 换成对应机器名。

每轮验收使用独立的临时 `DSH_HOME` 和端口，结束后清理 Host 和临时文件。受控输入禁用外部 MCP，不发模型请求；私有变体加载机器自己的配置行和提示词文件。

## 4. 结果

- `pnpm test`：148 项，142 通过；6 项需要 `DSH_CLI_PACKAGE` 的 installed-Loader 用例跳过。
- 三台机器的 `check` 和 `update --offline --verbose --json` 都退出 `0`，没有缺来源阻塞。离线预览的变化条目：workstation 41、server 42、nas 41。预览对比的是 installation 输入；目标机器实际安装的版本以部署前的 doctor 为准。
- 四套隔离验收（公开、workstation、server、nas）都退出 `0`。每套 34 个 tarball、44 项包和安装归属检查；standard、Team、redteam 三个 preset 都完成提示词和上下文渲染、工具隔离和模块版本检查。PTC preset 的模型可见工具只有 `run_code` 和配置的 native exceptions（`context_compress`、`mcp_probe`）。真实 SDK 调用、ACP 拒绝不修改 Surface、压缩成功提交与下一步归档都通过。
- 每套都是 `modelRequests: 0`、`cleaned: true`。Web 只验证了认证交换和页面 HTTP 请求，没有浏览器交互（`browserChecked: false`）。

### 精确兼容豁免

验收前先在隔离安装中运行官方兼容检查，记录不加豁免时实际被拒绝的组合，临时只放行这些组合。四套输入的拒绝集合相同。验收通过后，`verifiedCompatibility` 登记以下 15 个包，均为 `0.2.2-rc.1-fork1` 对 runtime `0.2.2-rc.1`（包名省略前缀 `@deepseek-ai/dsh-`）：

`agent`、`agent-loop`、`agent-preset-registry`、`experimental-agent-team`、`experimental-tool-agent-team`、`host-frontend-static`、`mcp-client`、`ptc-runtime-node`、`session-persistence-jsonl`、`session-query`、`session-query-sqlite`、`subagent`、`tool-executor-ptc`、`tool-subagent`、`tools`

其余 fork 包、Pi 和插件没有被拒绝，不登记豁免。

## 5. 未覆盖与待办

- **envrc**：发布 CI 固定在 Ubuntu 24.04（direnv 2.32.x，与三台机器一致）。在 direnv 2.37.1 下，`deny` 之后再执行仍退出 `0`，两项原生测试失败；envrc 尚不兼容 direnv 2.37.1。
- 浏览器交互、手机真机（iOS 输入法、软键盘、PWA、Android 返回键）、SSH 远端 helper（协议版本 3，不能混用旧 helper）、真实 provider 和 MCP 请求尚未验收。
- 尚未真实安装或切换任何机器。
