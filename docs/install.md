# 两机正式安装与更新

本指南管理个人 DSH 的安装、配置应用与维护切换。源码开发和成品验收见[隔离测试](testing.md)。在每台目标机器上执行命令；`--machine` 选择私有参数，不会连接远程服务器。

## 1. 准备目标

使用 Node.js 24、pnpm 11.24.0 与 chezmoi。选择已验证的 dsh-config Git 提交，安装仓库依赖：

```sh
pnpm install --frozen-lockfile --ignore-workspace
pnpm render --machine workstation
pnpm check --machine workstation
```

另一台机器使用自己的 `--machine server` 参数。通过私有通道保存各机 `private/machines/<name>/machine.yaml`；保留各机 MCP、relay、模型、认证引用、浏览器路径和专属插件。服务器不因共用配置更新而增加工作机的逆向 preset、session-tools 或 mobile。不要同步 credentials、sessions、storages、数据库或附件。

目标版本和来源由 [shared/dependencies.yaml](../shared/dependencies.yaml) 选定。按包名、包版本和实际资产 URL 核对；Release 的 fork 号表示发布批次，不用于推断包的 fork 号：

| 包类型 | 安装方式 | 正式来源 |
|---|---|---|
| 官方同名 fork、Pi fork | pnpm 用户级全局 overrides | 精确 GitHub Release tarball URL |
| 独立个人插件 | 每个消费 profile 的 dependencies | 精确 GitHub Release tarball URL |
| 官方运行时、普通库及明确允许的第三方插件 | 原有安装归属 | 精确 registry pin |

机器 `installation.globalWorkspace` 和 `installation.webPackage` 保留无关 overrides、专属依赖及 bundles；受管项由共用清单覆盖。未声明 installation 时，已有机器以首次迁移快照作为输入。缺少精确资产的条目保留目标版本并阻塞正式更新，不回退本地来源，也不自动改用新版或旧版。Pi 的同版本多资产由清单明确选定唯一来源。

清单中 `patchOnly: true` 的包保留 profile dependency，但移除重复的 profile bundle 激活；MCP Panel、mobile 等仍通过 bundle 贡献客户端行的包不受影响。共用插件与 preset 声明在 `$DSH_HOME/cordis.patch.yml`；真正 profile 特化的配置留在对应 profile patch。依赖安装在 profile 不表示配置属于该 profile。覆盖既有行的 `config` 是整个对象替换；保留该行需要的全部配置键和 `!!js` 表达式。

## 2. 声明本机部署位置

`deployment` 可以完全省略。Doctor、update 默认预览和 `update --apply` 在执行命令的机器上解析默认位置：

| 字段 | 默认值 |
|---|---|
| `home` | `DSH_HOME`，未定义时为 OS 用户主目录下的 `.dsh` |
| `globalWorkspacePath` | `pnpm root -g` 返回目录下的 `pnpm-workspace.yaml` |
| `globalBinDir` | `pnpm bin -g` |
| `globalDir` | pnpm 公共 `global-dir` 配置，未设置时由全局 root 推导 |
| `hostManifest` | `pnpm list -g --depth 0 --json` 中当前 `@deepseek-ai/dsh` 的 manifest |
| `homePatchPath` | home 下的 `cordis.patch.yml` |
| `profiles.web` | home 下 `profiles/web/package.json` 与 `cordis.patch.yml` |

需要覆盖时只填写不同的字段，例如：

```yaml
deployment:
  home: '$HOME/custom-dsh'
  profiles:
    headless: {}
```

所有部署路径支持 `~/`、`$HOME`、`${HOME}`、`$DSH_HOME` 及其他已定义环境变量；未定义变量按字段和变量名报错。展开仅替换路径文本，不使用 shell/eval，不递归展开变量值。显式其他 profile 按 home 推导位置，不自动扫描 profile。覆盖 profile 的 `packagePath` 后，未指定的 `patchPath` 默认位于该 manifest 同目录。无需填写 pnpm 哈希 slot。显式 workspace 的 globalDir 从该 workspace 推导，或单独覆盖，避免借用另一套本机配置。

全局更新后通过 pnpm 公开安装清单重新定位当前 Host，避免继续检查旧安装代际。`pnpm root -g` 的版本化全局项目目录与 `global-dir` 基目录不同。使用用户级全局 store/default cache，关闭自动安装 peers 和 global virtual store，包安装和 lockfile 由 pnpm 正规管理。

消费全局插件的其他 profile 必须先有完整的共用依赖布局，再显式纳入 `deployment.profiles` 和验收；其已声明的共用受管依赖使用同一选定版本。可用 `installation.profiles.<name>` 保存额外 profile 的安装输入；依赖清单中的 `profiles` 可限制真正 profile 特化的包，例如 mobile 仅用于 Web。不会因共用清单存在某个专属包就自动给其他机器或 profile 安装它。

## 3. 只读预览和诊断

```sh
node scripts/dsh-config.mjs update --machine workstation
node scripts/dsh-config.mjs update --machine server --offline
node scripts/dsh-config.mjs doctor --machine workstation
```

`update --offline` 预览使用机器 installation 参数或迁移快照，报告 `input: offline`；与 render/check 一样，不发现本机部署位置、不读取本机安装。可在工作机离线预览 server 参数。默认 update 预览使用执行机器的路径默认／覆盖和实际 manifest，报告 `input: live`；apply 始终使用 live 输入，与默认预览一致；`--offline` 不可与 `--apply` 组合。两个预览均只读且不运行 doctor 或安装器。部署目标尚未准备时，live 诊断会指出缺失字段／profile，离线预览仍可使用。

预览展示受管目标与阻塞。Doctor 使用安装 Host 的正式 profile resolver 和兼容检查，核对实际版本、来源与原始拒绝原因，不启动 Host、不授予豁免、不修改配置。Doctor 通过不表示运行中的旧 Host 已换版；目标来源缺资产仍须先解决。

### 共享 peer 解析验收

消费 profile 关闭 `auto-install-peers`，不直接安装 Host 已提供的 Cordis／DSH 服务 peers。插件保留准确的 peer 声明，由正式 DSH resolver 提供 Host 实例。裸 Node 导入失败或 pnpm peer warning 不能单独证明插件缺依赖；先看正式解析和 Loader 结果。不要为消除警告补装第二套共享服务包或删除 peer 声明。

Cordis／DSH 服务包核对共享身份；Schemastery 普通库允许同版本不同物理副本，使用 Host Config 校验确认行为。成品预检以打包后的 manifest 为准，`workspace:*` 可能在 pack 后成为精确 fork peer。只做 import 不能替代工具或 UI 的受影响行为验收。

### 精确兼容豁免

已完成成品行为验证的精确组合记录在共用清单的 `verifiedCompatibility` 中，格式为 `package@exactVersion: [exactRuntimeVersion]`。授权 `update --apply` 时，入口先核对安装的目标版本、来源及 built entry；仅当剩余问题全部是已记录组合的兼容拒绝，才通过官方公开 API 写入对应 profile 的精确豁免，再运行 doctor 后应用配置。默认 preview 和 doctor 仍只读，未知组合或安装问题仍阻塞，不自动接受其他 fork／版本。

官方 checker 可能把 fork 的精确 peer 与官方 runtime 基线比较。未记录组合须读取原始拒绝原因、完成相关行为验证，再记录已确认的精确组合；官方 CLI 仅作为外部诊断与授权出口：

```sh
dsh plugin --profile web allow-version PACKAGE@VERSION \
  --dsh-version RUNTIME_VERSION --accept-risk
```

这里的三个值都必须来自实际打包与安装组合。豁免只覆盖精确 package/runtime，任一版本变化重新确认。不能用 `allow-version` 补出缺失的 API，也不对所有 fork 无条件豁免。

## 4. 在外部维护窗口应用

所有精确资产齐全、预览已审查、相关成品 smoke 通过后，由外部维护流程停止受影响的 Host。不得从承载开发会话的 Host 内启停自身。

```sh
node scripts/dsh-config.mjs update --machine workstation --apply
```

入口合并受管安装目标，通过 pnpm 安装并核对解析／兼容结果，再应用配置；不启停 Host。同一目标重复 apply 会收敛到同一状态；目标声明、配置与实际解析已一致时，报告无需更新，不重复备份、安装或改写文件。

需要变更时先保留本次文件备份。安装后若只剩清单已记录的精确兼容拒绝，一次 apply 会写入所需豁免并重新检查，无需维护脚本逐项执行 allow-version 或第二次 apply。未知组合仍保留已安装状态和备份，不应用配置。失败时按报告的具体步骤处理。通过后仍是“已安装，待原 Host 启动验收”。

Apply 在 stderr 即时报告 pre-install doctor、global install、profile install、post-install doctor 与精确豁免后的 doctor。安装器 stdout/stderr 直接写入私有 `generated/global-install.log` 和 `generated/profile-install.log`，运行期间即可查看，不等命令结束。每个安装步骤沿用 600 秒上限，超时强制结束直接子进程。外部维护流程应为整次 apply 设明确边界，超时结束其独立进程组，并在 finally 恢复目标服务；不要用同步缓冲的外层调用让日志和恢复一直等待。恢复服务不等于回滚安装，失败的备份继续保留。

由用户按原方式启动原 Host，核对最终组合及受影响功能。`--dump-config` 可能展开凭据，应私下检查，避免把完整输出发布到日志或对话。UI 包更新还需核对原 Host 发布的 graph、实际服务脚本和认证页面加载，再在目标浏览器／手机验收。另起测试服务器、磁盘版本或最新 manifest 都不能证明日用页面已应用新版。

两机可以分开维护；先验证本机，再让服务器选择同一稳定提交和它自己的参数。远端执行 update 直接消费 Release URL，不通过 SCP tarball 维持长期依赖。只停止目标 DSH 服务，避免 `pkill node` 影响其他用户服务。

### 客户端更新链与热加载边界

以下边界决定「装了」和「页面真的用上了」之间的距离。

- **配置热加载 ≠ Node 模块重新导入 ≠ 客户端资源换版。** Profile patch 可触发 fiber 撤销与重挂，但不保证清除 Node 解析、模块或 ClientModules 来源缓存。首次新增插件可热生效，不能据此推断已有包升级也可热生效。
- **已有 bundle 升级按正式管理器的 `restart-required` 处理。** 依赖安装、配置中的新路径、Host 路由重新出现，都不能证明客户端已升级。绝对构建入口在 metadata 中合法，也不是生产热升级保证；不靠反复改名、私有清缓存或猴补绕过运行代际。未激活时明确报告“已安装、未激活”，需要重启则按当次授权另行安排运维切换。
- **客户端有独立的生产更新链：** Host ClientModules 发布实际 graph/bundle，`/plugins/events` 的 graph/rebuilt 通知浏览器执行 entries.sync/reload。源码自动重建需确认同一 checkout 的 `dev:web` watcher；已构建产物的生产通知不等于必须开开发服务器。Web shell/普通包修改仍需构建对应产物并刷新原 GUI，另起服务器不会更新原页面。
- **更新验收先查服务端实物，再查页面。** 读取公开 SSE 首个完整 graph 后关闭连接，定位目标插件广告的 revision/脚本 URL，对照实际服务脚本与目标包的构建入口，再核对已认证 boot/页面加载结果。combo 响应带分隔符与 source-map 尾缀，比较完整可执行内容时要区分这些包装；revision 基于文件 metadata，重新安装可变，不硬编码某个 hash 为永久版本号。磁盘版本、manifest、图标、登录 HTML、独立 link 实验或新进程烟测均不能替代日用客户端验收。
- **公开版本状态有边界：** `ctx.modules.manifest` 是最新解析的 Host graph，不是已成功应用版本；`entries.state` 只公开 syncing/failures，成功 revision 表是私有实现。不得把 SSE 首帧或当前 manifest 伪装成页面已应用版本，也不得读取／包装私有表来补接口。精确更新横幅需公开 applied/settled 契约；现有失败状态可用于诚实的手动重载恢复提示。
- **PWA 更新提示不是 Host 热升级。** 当前安装前端／mobile 未实现 SW waiting 更新流程；SW skipWaiting／controllerchange 只作用于浏览器 Service Worker。提示按钮重载页面，不重启服务器；仅服务器实际发布了新资源，刷新才可能取得新版。不要为更新提示缓存私有会话／API，也不要重复实现现有模块替换控制器。

本节边界来自一次针对特定 DSH 版本的实测。出现「已安装但未激活」时的各层调用链和完整反例见[更新链调查](../../artifacts/mobile-workbench-3.0.3-fork4/UPDATE-INVESTIGATION.md)；不能把其中的内部行为推广为永久契约，升级 DSH 后需重新核对。

## 5. 首次迁移与恢复

旧配置的共用行迁移可使用[配置迁移脚本](../../deepseek-harness/scripts/upgrade-daily-driver.mjs)：默认预览，`--apply` 只迁移配置与备份，`--rollback` 只恢复该次配置；日常包更新使用本仓库 update。旧 settings 的不支持项应先处理，不能静默丢弃。

首次从 session-search-pro 切换时，先为实际消费 profile 安装 session-tools，并通过[只读预检](../../dsh-session-tools/deploy/activate.mjs)：

```sh
node ../dsh-session-tools/deploy/activate.mjs --check-only \
  "$DSH_HOME" "$RELEASE_URL" "$EXACT_VERSION" "$HOST_MANIFEST" web
```

仅首次配置切换使用不带 `--check-only` 的 activate：将新插件插入全局 patch，移除旧 Web bundle，保留旧 dependency 供验证后的 pnpm 清理。已使用新插件的日常升级保留 global patch，不重复首次 activate。预检默认只检查指定 profile；其他已准备的消费 profile可使用 `web,headless` 等显式列表。

恢复时保持 Host 停止，按本次报告的备份恢复变更配置和 dependency declarations，再用 pnpm 重建相应安装与 lockfile；配置迁移备份不能恢复包版本。不要用旧会话或数据库覆盖升级后的新数据。仅在原 Host 功能验收后清理本次明确指定的备份和工作树，保留仍被安装或回滚方案引用的资产。
