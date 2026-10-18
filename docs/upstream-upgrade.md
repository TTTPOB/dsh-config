# 上游升级手册

供下次升级 DSH／Pi 及配套插件的维护者或 agent 使用。先记录当前已安装基线与目标上游 tag，再动源码。源码升级、发布、配置选版、真实安装、Host 激活是不同阶段；完成前一阶段不代表后一阶段已完成。

安装命令与维护切换见[正式安装与更新](<install.md>)，成品验证入口见[隔离测试](<testing.md>)。本页中的版本仅作命名示例，实际目标以本次核实的 tag、manifest 和[依赖清单](<../shared/dependencies.yaml>)为准。

## 1. 先确定授权与范围

- **源码工作：** 明确允许处理的仓库、目标版本、工作分支和临时 worktree；reset／reclone 另须授权。默认不改真实 installation、profile、lockfile、会话或 storages。
- **远端写入：** push 分支、创建／推送新 tag、触发 Release、合并默认分支分别确认授权范围。只推个人 fork 的明确分支与新 tag；不推上游、不 force push、不覆盖既有 tag／Release、不 npm publish。
- **运行验证：** 启动隔离 Host 需要明确授权，独立 `DSH_HOME` 与端口，只停止自己创建的进程。真实 provider／MCP／付费模型请求另行授权。
- **正式切换：** 真实 `update --apply` 由用户执行；Host 停启由用户另行安排独立运维流程，不能从承载本次会话的 Host 内启停自身。Doctor 和不带 `--apply` 的预览保持只读。
- **清理：** 只删除本次明确创建、且不再被安装或回滚方案引用的 worktree、临时分支和测试输入；确认提交已保留、工作树无未交付改动后再清理。

分派 worker 时给出交付物、允许改动的文件、验证命令与权限，并明确：**只处理实际会发生的问题，不测理论竞态，不防同机同用户进程。**

## 2. 按顺序推进

| 步骤 | 操作与产物 | 完成判据 |
|---|---|---|
| 1. 固定基线 | 核实上游 tag／commit、旧 fork 基线、当前分支和干净状态；保存各仓库版本与来源表 | 明确“已安装版本”和“计划目标”，不用记忆或 `latest` 代替证据 |
| 2. 盘点自定义 | 逐仓库列出 fork 相对旧上游基线的提交、受影响包与配套插件；用 `git merge-tree` 估冲突。对比新旧上游 tag 的各 bundle `cordis.patch.yml` 与 `systemPrompt.variable` 注册，列出改名或删除的服务名（如 `webRuntime`→`webStartup`）和 prompt 变量（如 `cwd`），在 templates 与两机 `private/` 中逐项搜索 | 每项自定义都有保留／上游已覆盖可撤／需适配的判断及依据；改名清单在两机配置中已无残留 |
| 3. 划分交付 | 按能力组决定 DSH 子包、Pi 和插件的依赖顺序、版本、tag、测试与负责人 | 交付表覆盖依赖闭包，没有把无关包一起重发 |
| 4. 独立实施 | 各仓库在专用 worktree／升级分支开发和测试；核对下节 fork 文件；用包管理器生成 lockfile | 无遗失的 fork workflow、测试或补丁，diff 只含本次改动 |
| 5. 源码与成品验证 | 所有参与仓库运行其相关 typecheck／build／test／pack smoke；检查脱离源码树后的入口、共享 resolver 与受影响行为 | 每仓库有实际执行命令与结果，必要的 pre-push gate 通过；本地包只用于测试 |
| 6. 合并发布分支 | 验证通过的升级分支合并进长期发布分支（DSH 为 `daily-driver`），推送后在该分支跑 CI；两边分叉时用合并提交，不 reset、不 force push | 发布分支 CI 通过；待发布 commit 位于发布分支上 |
| 7. Actions 发布 | 只从合并后的发布分支 commit 打 tag。先 Pi，再依赖它的 DSH 能力组，再发布消费核心资产的插件；插件间依赖也按顺序发布 | 每项有成功 Actions run、源码 commit、不可变 tag、资产包名／版本、精确 URL 和 SHA256 |
| 8. 配置选版 | 把已下载核验的精确 Release 资产 URL 填入依赖清单，更新必要的 runtime／pins／retired overrides；先完成组合验收，再登记兼容例外 | 无猜测 URL 或缺来源阻塞；`verifiedCompatibility` 仅含 runtime 真正拒绝且行为已验证的精确 package/runtime 组合 |
| 9. 成品组合验收 | 从正式 Release 下载全套输入，运行 prepare → check → 离线 update 预览 → 隔离 profile smoke → Playwright；profile smoke 另用 `--private workstation` 与 `--private server` 各跑一次真实私有配置 | 独立 Home／端口，实际版本和 preset／工具行为正确，每个 preset 的提示词都能渲染；手机与桌面关键路径有证据；未测项单列，测试 Host 和暂存已清理 |
| 10. 真实只读预览 | 在目标机器执行 doctor 与不带 `--apply` 的 live update，审查版本／来源、移除项、配置变化和阻塞 | 保存脱敏摘要；明确“预览未应用”，不把离线或隔离结果当作真实部署 |
| 11. 用户切换与收尾 | 向用户交付选定提交、预览、风险和恢复入口；用户按安装指南 apply 并安排 Host 激活，验收后清理临时 worktree／分支 | 分别报告已发布／已安装／已激活状态；有实际 doctor 与原服务／页面验收才宣称部署完成 |

真实工作机的只读命令从工作区根执行：

```sh
node dsh-config/scripts/dsh-config.mjs doctor --machine workstation
node dsh-config/scripts/dsh-config.mjs update --machine workstation --verbose
```

测试范围按当前组合决定，不沿用旧版本的 preset 数量或旧包清单。[rc.1 组合验收](<upgrade-rc1.md>)保留一次具体升级的组合、命令与覆盖范围，可作为实例，不能直接当成未来版本的完成证明。

## 3. 每次重建分支都核对的 fork 文件

下列路径相对**各自源码仓库根**。从旧 fork 到新基线逐项核对、移植或适配；不能只 cherry-pick 产品代码。确已被上游覆盖的项记录撤除依据，不机械复制旧实现。

**DeepSeek Harness：**

```text
.github/workflows/daily-driver-verify.yml
.github/workflows/daily-driver-release.yml
scripts/README.daily-driver.md
scripts/daily-driver.mjs                 scripts/daily-driver.test.mjs
scripts/daily-driver-plan.mjs
scripts/daily-driver-source.mjs          scripts/daily-driver-source.test.mjs
scripts/daily-driver-pi.mjs              scripts/daily-driver-pi.test.mjs
scripts/upgrade-daily-driver.mjs         scripts/upgrade-daily-driver.test.mjs
pnpm-workspace.yaml                     pnpm-lock.yaml
```

另核对能力组所列包的 manifest、源码改动、fork 专用回归及必要配套包。根 workspace 必须固定已发布 Pi fork URL，并删除针对官方 Pi 的失效 `patchedDependencies` 条目，再由 pnpm 更新 lockfile。官方 Pi patch 文件不能替代 fork 成品。

**Pi：**

```text
.github/workflows/dsh-ci.yml
.github/workflows/dsh-release.yml
packages/ai/package.json
packages/ai/scripts/smoke-dsh-fork.mjs
packages/ai/test/final-tool-arguments.test.ts
packages/ai/test/openai-responses-fork-compat.test.ts
```

从上游重建 Pi 分支会丢掉 fork 自有的两个 workflow，必须从旧 fork 搬回并适配触发分支、版本、离线构建和消费者 smoke。模型数据校验、hash 与生成脚本按目标 Pi 实际结构一起核对；保持 Pi 原有 npm 工具链，不套用 DSH 的 pnpm 安装方式。

**各插件：**

```text
.github/workflows/release.yml
package.json
pnpm-workspace.yaml / pnpm-lock.yaml（仓库实际采用的文件）
.github/release-dependencies.json（采用该固定依赖入口的仓库）
```

同时保留各仓库的 pack／consumer／Loader smoke 脚本、发布说明和许可声明。此检查覆盖 Session tools、Progressive tools、Workspace overlay、Workspace envrc、Firecrawl、Mobile Workbench、Active Context；Mobile Workbench 也已有 Actions Release，不能恢复手工上传流程。配置仓库保留依赖清单、安装逻辑与组合 smoke 入口，版本变更要与其断言同步。

## 4. 发布规则

**发布只能走各源码仓库的 GitHub Actions Release workflow，且只从长期发布分支发布。** 开发和测试可以在任意新分支完成；发布前必须合并到发布分支（DSH 为 `daily-driver`）并在该分支通过 CI。 本地可以构建、测试和 pack，但不能把本地产物上传为正式 Release。源码交付脚本即使暴露本地 `release` 命令，也不作为本工作区的发布入口。

| 仓库 | tag 规则 | 注意事项 |
|---|---|---|
| DeepSeek Harness | `daily-driver-v<上游版本>-forkN`，如 `daily-driver-v0.2.1-rc.1-fork1` | 按能力组拆分 fork1／fork2／fork3 等源码快照；tag 序号不等于包自身 fork 号 |
| Pi | `pi-ai-v<版本>-forkN`，如 `pi-ai-v1.1.0-fork1` | 与 Pi 包 manifest 的完整版本对应 |
| 独立插件 | `v<semver>`，如 `v0.4.0` 或 `v0.2.0-fork1` | 使用各插件独立版本，不套用 DSH tag |

先读目标分支的 workflow：DSH 使用手动 dispatch，并选择包含 workflow 的源码 ref、同 commit 的既有新 tag、能力组和所需包；Pi／插件按各自 tag 触发规则执行。不要从旧 checkout 推断当前 inputs 或能力组。

发布失败时先确认 tag、Release／draft 和已上传资产状态，不重复覆盖或移动 tag；需要修订时使用新的版本／tag。下载正式资产后核对 tarball manifest 与 GitHub digest；有校验文件的再核对 SHA256SUMS／`.sha256`。把 run、commit、tag、URL、校验值与验证结果写入本次报告；不把凭据、机器端点、用户名或私有绝对路径写进公开文档。

## 5. 常见阻塞与处理

| 现象 | 处理 |
|---|---|
| pnpm 11 安装失败、native／spawn-helper 不可用或 peer 重复 | 按[长期 pnpm 11 规则](<install.md#pnpm-11-安装规则>)检查 workspace overrides、allowBuilds、exotic subdeps 与两层 peer 策略；不要靠 `--ignore-workspace` 跳过承载 overrides 的 workspace |
| DSH pre-push 报 Pi 类型缺失，如 `systemPromptFormat` | 检查根 workspace 和实际解析是否命中 Pi fork Release；移除失效官方 Pi patch 条目，正规重生成 lock，再跑相关检查，不绕 hook |
| 官方 `dsh-llm-pi-ai` 可安装但缺 fork serializer 行为 | 官方包不会携带个人 pnpm patch，Pi 必须独立 fork、发布并被 override；fork-compat serializer 测试应按实际 Pi 是否为 fork 条件执行，fork qualification 中必须运行，官方基线不要求 fork-only 行为 |
| 插件发布消费者向 registry 请求未发布 fork 版本 | pack 可能把 `workspace:*` 固化为精确 fork peer；临时消费者 workspace 补齐 Session／Query／SQLite 等间接依赖的精确 overrides。正式安装已有用户级全局 overrides，不因测试布局失败就改正式依赖归属 |
| 新分支缺 workflow 或仍走手工上传 | 按上一节清单恢复 fork 自有文件；每个实际发布的源码仓库都必须具备 Actions Release，发布前先补齐 |
| compatibility 拒绝已验证 fork | 读取官方原始拒绝原因；只记录通过成品行为验证的精确组合，授权方法见[精确兼容豁免](<install.md#精确兼容豁免>)，不批量放行所有 fork |

最终报告至少给出：各仓库分支／commit／push 状态、Actions 与资产清单、实际测试及未覆盖项、配置提交、真实只读预览、是否 apply／激活、待用户执行的步骤和可清理范围。
