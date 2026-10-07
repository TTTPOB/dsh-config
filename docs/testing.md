# fork 开发后的隔离成品测试

先在源码工作树验证改动，再检查打包成品，最后按[正式更新](install.md)安排日用切换。本地 tarball 只进入隔离副本；正式依赖目标保留 Release URL。

## 配置路径的聚焦回归

仅验证配置默认、覆盖、变量错误、离线预览与 apply 幂等时，运行：

```sh
node --test tests/deployment-paths.test.mjs tests/deployment.test.mjs tests/config.test.mjs
```

这些测试使用临时 fixture 和模拟安装步骤；不执行全局安装 suite。chezmoi 不在 PATH 时设置 `CHEZMOI_BIN`。两机私有快照可用 render/check 单独比对；输出保留在私有生成目录，不打印配置内容。

## 1. 聚焦源码验证与打包

在独立功能分支和持久 worktree 中开发，不得直接在发布工作树开发——`deepseek-harness` 主检出所在的分支就是发布分支。选择固定基线发布路线时，把已验证的原子提交集成到对应发布分支。固定目标 DSH 基线、Node/pnpm 版本及外部 fork 资产，保持 manifest、workspace overrides/patches 和 pnpm 生成的 lockfile 一致。已有 DSH [源码准备入口](../../deepseek-harness/scripts/daily-driver-source.mjs)可复用：

```sh
CI=true node scripts/daily-driver-source.mjs install packages/GROUP/PACKAGE
pnpm --config.verify-deps-before-run=false exec vitest run packages/GROUP/PACKAGE/tests
node scripts/daily-driver-source.mjs build packages/GROUP/PACKAGE
```

替换示例中的包目录。需要 native system 的测试先按源码工具链构建 native；只准备目标 closure。后续源码命令关闭 `verify-deps-before-run`，避免自动安装整个 workspace。客户端包同时构建 Host／Client 两端；打包前清理失去源文件的旧入口，避免增量构建把历史产物带入 tarball。

同一 DSH 基线内的小更新测试改动功能与必要配套包；跨基线 API 迁移才扩大到真实受影响调用链。新工具需要 query API 时，调用真实工具行为；已有行为 smoke 能暴露缺 API，不再补方法存在性清单。外部依赖故障按版本与资产、lockfile、下载、patch 和工具链分别定位，不以反复 install 或换回官方包兜底。固定组合无法恢复时，报告具体阻塞与缺少的资产或配置；持久修复进入依赖配置或共用准备入口。

## 2. 选择已有成品 smoke

使用成品 manifest 验证实际解析和兼容门禁，再执行受改动影响的行为。现有入口各自拥有安装布局，不能仅因调用成功就声称全部日用渲染配置已验证。

| 改动范围 | 复用入口 | 验收重点 |
|---|---|---|
| Agent／preset registry／Pi adapter／MCP client | [核心四包 smoke](../../deepseek-harness/scripts/smoke-core-packages-fork13.mjs) | 官方 CLI 安装副本、Host peers、打包 Config、awaited setup／卸载与 lazy preset；不安装个人插件、不启动 Host |
| query／SQLite 与 session-tools 配套 | [fork12 smoke](../../deepseek-harness/scripts/smoke-session-query-fork12.mjs) | query fork2、SQLite fork5、沿用 JSONL fork3；传入插件成品时验证真实工具调用 |
| JSONL／SQLite 固定旧组合 | [session-index smoke](../../deepseek-harness/scripts/smoke-session-index-fork4.mjs) | 指定版本的解析、共享身份、搜索和 closing tail；不启动 Host |
| Access、UI settings、plugin manager、terminal | [Access/UI smoke](../../deepseek-harness/scripts/smoke-access-navigation-fork6.mjs) | 配套成品、兼容性、官方 CLI 冷启动、认证 graph 与实际服务脚本 |
| 独立 session-tools 包 | [pack smoke](../../dsh-session-tools/tests/pack-smoke.mjs)及[profile 预检回归](../../dsh-session-tools/deploy/activate.test.mjs) | pack smoke 仅导入打包入口；profile 回归覆盖 Host 提供 peers 的实际布局 |

部分既有 smoke 会启动独立 Host，执行前须获得启动测试实例的明确授权；独立 DSH_HOME 与端口不能替代该授权。无需启动 Host 的源码或进程内测试可直接运行。Release workflow 内的 smoke 与当前开发机器的授权分别判断。

## 3. 从正常渲染建立测试副本

在私有机器参数的 `deployment.smoke` 中声明明确 argv 和绝对 cwd。复用自建安装布局的 smoke 时设置 `ownsInstallation: true`，使用 tarball 占位符传入测试成品：

```yaml
deployment:
  smoke:
    ownsInstallation: true
    cwd: /absolute/deepseek-harness
    argv:
      - node
      - scripts/smoke-session-query-fork12.mjs
      - "{tarball:@deepseek-ai/dsh-session-query}"
      - "{tarball:@deepseek-ai/dsh-session-query-sqlite}"
      - "{tarball:dsh-session-tools}"
```

获得该 smoke 所需授权后：

```sh
node scripts/dsh-config.mjs test --machine workstation \
  --tarball @deepseek-ai/dsh-session-query=/absolute/query.tgz \
  --tarball @deepseek-ai/dsh-session-query-sqlite=/absolute/sqlite.tgz \
  --tarball dsh-session-tools=/absolute/tools.tgz
```

入口先正常渲染，建立 `generated/<name>/isolated-*` 下的独立 home 和安装声明，将待测 tarball 传入既有 smoke；不修改真实 installation 或机器目标。自建安装布局的 smoke 验证它自身实际使用的组合，输出中的 `renderedConfigurationVerified: false` 表明尚未验证整份正常渲染配置。

需要 smoke 消费这份副本时，提供受控的 `homePatch`、`webPatch` 字面 YAML，并通过 `{testRoot}`、`{home}`、`{globalWorkspace}`、`{webPackage}`、`{homePatch}`、`{webPatch}` 参数传给能接收它们的测试入口。该入口自行完成安装与行为检查。子进程还会收到独立 `DSH_HOME`／`DSH_CONFIG_TEST_ROOT`。配置声明文件存在不代表依赖已安装或 Loader 已加载。

受控 patch 应保留受测 preset／工具和必要模型组合，但明确使用测试会话路径、索引和端口；会产生真实操作的 MCP／外部服务按测试需要禁用或改用测试目标。不要把正常渲染中保留的日用绝对数据库路径直接带入测试 Host。未提供待测缺资产项时，消费副本的测试停止并报告所需 tarball；自建布局的聚焦 smoke 可继续，但报告其他目标仍有缺口。

## 4. 分层判断失败

| 现象 | 下一步 |
|---|---|
| 源码类型检查缺 fork API | 用共用准备入口固定外部 fork 与 lockfile；确认实际消费包解析来源 |
| 插件加载或调用缺 API | 修正必要配套包，不能靠版本豁免补 API |
| 正确版本被 compatibility preflight 禁用 | 阅读原始原因；实际组合验收后才授权精确例外 |
| 裸 Node 导入缺 peer | 使用正式 Host resolver；不要补装第二套共享服务 |
| 普通 Schemastery 同版本不同目录 | 使用 Host Config 校验判断，不能仅凭物理目录不同拒绝 |
| 成品 import 通过、工具未注册 | 检查 Loader 兼容性及真实受影响行为，不把 import 当功能验收 |

完整布局原则见[共享 peer 解析验收](install.md#共享-peer-解析验收)。不要扩张成全面 peer 审计、重复 hash 检查或无关版本矩阵。

## 5. 发布与收尾

源码与成品通过后，原子提交并审查公开内容。只构建并发布受影响包，不覆盖既有 tag 或资产。

发布分两条轨道。**核心 fork 子包**（`@deepseek-ai/dsh-*` 的 fork）在 `deepseek-harness` 内以 `daily-driver-v<上游版本>-forkN` tag 发布，由[DSH Release](../../deepseek-harness/.github/workflows/daily-driver-release.yml) 承担，触发条件是 `push: tags: daily-driver-v*-fork*`，并由[源码验证](../../deepseek-harness/.github/workflows/daily-driver-verify.yml)校验；**树外个人插件**分别在自身仓库用自己的 tag 与 Release workflow 发布，不经过 daily-driver。经单独授权才复用这些流程。

将发布的精确 URL 写回依赖目标，运行两机 render／check／update 预览。测试完成只清理本次拥有的测试目录和进程；日用安装验收前保留功能 worktree 与必要回滚资料。维护报告分别写明源码测试、成品解析、Loader／行为验收与日用激活状态。
