# fork 开发与隔离成品测试

源码仓库负责构建、功能回归和成品 smoke；本仓库负责把选定成品接入个人配置的隔离测试。正式安装使用精确 Release URL，本地 tarball 只用于测试副本。

## 1. 在源码仓库验证成品

在独立功能分支和持久 worktree 开发，运行受影响功能的测试，构建并打包受影响包。DSH fork 的包选择、源码准备、验证和发布命令见[源码交付指南](https://github.com/TTTPOB/deepseek-harness/blob/daily-driver/scripts/README.daily-driver.md)。独立插件使用各自仓库的构建与测试入口。

成品 smoke 应验证离开源码树后的实际依赖解析、built entry 和受影响行为。涉及共享 peer 时，使用正式 Host resolver；仅成功导入入口不能代替工具调用或 Loader 验收。测试按实际改动范围选择，不为每次发布新增一套脚本。

## 2. 接入配置侧隔离测试

在私有机器参数的 `deployment.smoke` 中声明测试命令 `argv` 和绝对工作目录 `cwd`。测试入口由源码仓库提供，本仓库不要求源码位于相邻目录。

两种接入方式：

- **入口自行安装测试环境：** 设置 `ownsInstallation: true`，在 `argv` 中用 `{tarball:包名}` 传入成品。验收范围是该入口实际安装并使用的组合。
- **入口消费配置侧测试副本：** 在 `argv` 中传入 `{testRoot}` 或 `{home}`，并提供受控的 `homePatch`、`webPatch` 字面 YAML。按入口需要传入 `{globalWorkspace}`、`{webPackage}`、`{homePatch}`、`{webPatch}`；入口负责安装依赖和行为检查。

配置好入口后，在本仓库根目录运行，例如：

```sh
node scripts/dsh-config.mjs test --machine workstation \
  --tarball @deepseek-ai/dsh-session-query=/absolute/query.tgz \
  --tarball @deepseek-ai/dsh-session-query-sqlite=/absolute/sqlite.tgz
```

按实际测试调整包名和路径；每个 `{tarball:包名}` 都必须有对应的 `--tarball`。只接受依赖清单中的受管包。需要启动独立 Host 的 smoke 必须另获明确授权，使用独立 DSH_HOME 和端口；进程内测试不需要启动 Host。

入口在独立临时目录中建立安装声明、受控 patch 和 tarball 副本，向子进程传入独立 `DSH_HOME`／`DSH_CONFIG_TEST_ROOT`，并在成功或失败结束后自动清理本次暂存。测试命令必须等待其子进程结束并负责停止自己启动的服务。受控 patch 使用测试会话路径、索引和端口；MCP／外部服务按测试需要禁用或改用测试目标。

配置侧结果固定报告 `renderedConfigurationVerified: false`：它准备测试输入，不自动证明整份日用配置已经通过 Loader。消费副本的测试遇到缺失 Release 资产时，需要对应 tarball 才能继续；自建安装布局的 smoke 可聚焦验证自身组合，同时报告未解决的其他资产。

## 3. 配置逻辑回归

修改配置默认、覆盖、部署路径或 update 行为时，在本仓库运行：

```sh
node --test tests/deployment-paths.test.mjs tests/deployment.test.mjs tests/config.test.mjs
```

这些测试使用独立临时 fixture 和模拟安装，不执行日用全局安装；每个测试登记结束清理，断言失败也会回收本次目录。完整 `pnpm test` 还包含使用独立安装根的真实 pnpm 安装测试，同样自动清理。测试日志不写维护日志。chezmoi 不在 PATH 时设置 `CHEZMOI_BIN`。两机基线直接使用 check 比对，无需预先 render。

## 4. 定位失败

| 现象 | 检查位置 |
|---|---|
| 源码类型检查或插件调用缺 API | 源码依赖与必要配套包的真实版本、来源 |
| compatibility preflight 拒绝成品 | 原始拒绝原因；实际组合验收后再授权精确例外 |
| 裸 Node 导入缺 peer | Host resolver 与共享依赖布局，见[共享 peer 解析验收](install.md#共享-peer-解析验收) |
| import 通过但工具未注册 | Loader 加载与真实工具行为 |

## 5. 发布与日用切换

核心 fork 在 [DSH 源码仓库](https://github.com/TTTPOB/deepseek-harness)发布；树外插件在各自仓库发布。使用已有交付流程，只发布受影响包，不覆盖既有 tag 或资产。核心 fork 子包版本使用 `<上游版本>-forkN`，每次修订递增 `N`；发布选择和精确包版本由源码仓库维护。本仓库的依赖清单只选择已经发布的安装目标。

发布后，将精确资产 URL 写入依赖清单，运行两机 render/check 与 update 预览；按[正式安装与更新](install.md)另行安排日用切换。源码测试、成品验收、发布、安装与 Host 激活分别报告。发布、真实安装、Host 切换需要各自明确授权。

自动清理仅覆盖本次测试暂存；真实更新备份保留到日用验收并确认不再需要回滚，见[生成文件与清理](../README.md#生成文件与清理)。临时 Dynamic Cordis plugin 没有持久发布产物，需要长期使用的能力应做成源码管理的树外插件。
