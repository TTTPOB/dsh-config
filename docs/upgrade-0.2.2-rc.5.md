# DSH 0.2.2-rc.5 组合验收

上游基线：`dsh-v0.2.2-rc.5`（`9c2670d3bc`）。当前状态：配置迁移，正式 Release 成品验收待完成，未部署。

## 部署前同步私有配置

- 将服务器 `private/machines/server/machine.yaml` 的 `session-query-sqlite` 行同步到真实 `private/`：`openAt: startup`、`journalMode: wal`、`synchronous: normal`。该行会替换整份 `config`，须保留原有其他键；索引路径保持不变。
- NAS 的 `web-search-deepseek` 仍是 rc.5 基础组合包中的行标识符，无需改名。

## Release 资产与兼容性

待填：源码提交、Actions run、不可变 tag、包版本、精确 URL 和 SHA256。验收所用版本与来源记录在[依赖清单](<../shared/dependencies.yaml>)；只为官方运行时拒绝且已通过行为验收的精确组合登记兼容例外。

## 组合验收结果

待填：公开输入与私有输入的检查、离线更新预览、隔离 profile smoke 和 Web 验收结果。对每个 preset 验证 Team 开关、普通子代理工具和提示渲染；另验证搜索预热、实时选模与 PTC。列出未覆盖项，不把预览结果当作部署结果。

## 切换状态

待填：各机只读 doctor／update 预览、恢复入口及用户授权后实际切换结果。流程见[正式安装与更新](<install.md>)。
