# DSH 0.2.2-rc.5 组合验收

上游基线：`dsh-v0.2.2-rc.5`（`9c2670d3bc`）。公开配置和两份私有配置已通过隔离成品验收，未部署。

## 部署前同步私有配置

- 将服务器 `private/machines/server/machine.yaml` 的 `session-query-sqlite` 行同步到真实 `private/`：`openAt: startup`、`journalMode: wal`、`synchronous: normal`。该行会替换整份 `config`，须保留原有其他键；索引路径保持不变。
- NAS 的 `web-search-deepseek` 仍是 rc.5 基础组合包中的行标识符，无需改名。

## Release 资产与兼容性

[依赖清单](<../shared/dependencies.yaml>)记录包版本与精确 Release URL。通过 `gh release view` 核对资产后下载全部 32 个 tarball；每个文件的 SHA256 均与 GitHub 资产摘要一致。DSH 子包来自 `daily-driver-v0.2.2-rc.5-fork1` 至 `fork4`，其中 `dsh-subagent` 统一取 `fork3` 资产。`dsh-better-sidebar` 与 `dsh-claude-image-recovery` 沿用既有资产，未阻塞隔离安装和启动。

零豁免的隔离 Web 安装通过 pnpm，但 rc.5 的启动预检禁用了 8 个依赖 fork 精确 peer 的插件行，随后因必需服务缺失未能启动。只放行这 8 项后 Host 可启动，但加载 preset 时又禁用了 `dsh-tool-subagent-control`，导致 `send_message` 缺失。官方诊断格式为 `dsh: disabling profile plugin row "…": Plugin … is incompatible with dsh 0.2.2-rc.5: requirements …`，末尾为 `Exact-version exemption: not active.`。

[依赖清单的 `verifiedCompatibility`](<../shared/dependencies.yaml>) 只记录实际被拒的这 9 个精确包版本，限定运行时 `0.2.2-rc.5`。组合 smoke 以清单为准，在隔离 profile 内调用官方 `dsh plugin --profile web allow-version <包名@版本> --dsh-version 0.2.2-rc.5 --accept-risk`，不再默认放行所有 Release 包，未登记的本地版本也不会继承豁免。

## 组合验收结果

| 检查 | 结果 |
| --- | --- |
| `node scripts/dsh-config.mjs check --machine workstation\|server\|nas` | 三份机器输入通过只读结构检查。 |
| `prepare-profile-smoke.mjs` → `check` → `update --offline` → `run-profile-smoke.mjs` | 公开输入及 `--private workstation`、`--private server` 均通过。每套均检查 3 个 preset 在 Team 关闭与开启时的工具与提示，打开隔离 Web 首页，并在独立 Home 内执行 PTC 和 ACP 探针。 |
| Team 与工具 | 两种模式均有普通子代理工具（包括模型查询与等待）；仅开启时有任务看板工具和协作提示。`context_boundaries` 在 PTC SDK 中直接展示；顶层工具仍只有 `run_code` 和设定的原生例外。 |
| 搜索冷启动 | 使用 `fork1` 正式 tarball 运行 SQLite 的 `pack-smoke.mjs`：首次查询冷的 zstd 日志返回 `SESSION_QUERY_INDEX_WARMING`，重试命中已落盘的会话。私有 profile smoke 保留 SQLite 启动和同步选项，但将索引写入隔离 Home。 |

未覆盖：真实 Provider/MCP 请求、端到端实时选模、桌面与移动端浏览器交互，以及真实机器的启动耗时。

## 切换状态

仅完成只读检查与隔离验收；没有对真实安装执行 apply 或启停 Host。实际切换前按[正式安装与更新](<install.md>)运行目标机器的 doctor 和无 `--apply` 的 update 预览，审查兼容性和回滚入口。
