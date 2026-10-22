# DSH 双机配置与维护

用共用模板和选定依赖管理两台机器；各机保存自己的 MCP、模型、认证引用和专属插件。本仓库提供配置渲染、静态比对、依赖预览、只读诊断、隔离测试及显式更新入口。

## 从这里开始

需要 Node.js 24 与 pnpm 11.24.0。Nunjucks 作为本仓库的开发工具列在 `devDependencies`；使用包含开发依赖的完整安装，不使用 `--prod`。

```sh
pnpm install --frozen-lockfile --ignore-workspace
pnpm render examples/workstation-machine.yaml
pnpm test
```

已有私有参数时：

```sh
pnpm render --machine workstation
pnpm check --machine workstation
node scripts/dsh-config.mjs update --machine workstation
```

服务器使用自己的 `--machine server`，NAS 使用 `--machine nas`。机器名只选择 `private/machines/<name>/machine.yaml`，不连接远程机器。也可以直接传参数文件路径。生成结果位于 `generated/<name>/`，保留为私有文件。

- [正式安装与更新](docs/install.md)：机器参数、目标来源、doctor、显式 apply、精确豁免和维护切换。Doctor/update 默认突出变化与问题，`--verbose` 展开完整明细，`--json` 独立切换输出格式。
- [隔离成品测试](docs/testing.md)：源码聚焦验证、本地 tarball 测试副本及已有 smoke。
- [上游升级手册](<docs/upstream-upgrade.md>)：基线盘点、fork 文件、验证与 Actions 发布顺序、授权边界和已知阻塞。
- [rc.1 组合验收](docs/upgrade-rc1.md)：本次 PTC／子代理／Team 组合、已发布成品与隔离 Host 验证命令。

## 配置与依赖归属

| 位置 | 内容 |
|---|---|
| [shared/defaults.yaml](shared/defaults.yaml) | 共用默认配置 |
| [shared/providers.yaml](shared/providers.yaml) | 三机共用的 pi-ai provider 目录（纯数据，无 `!!js`） |
| [shared/dependencies.yaml](shared/dependencies.yaml) | 唯一选定版本、来源策略、安装归属和缺资产原因 |
| `templates/` | home/Web patch 文本模板；安装声明由脚本直接序列化 |
| `private/machines/<name>/machine.yaml` | 各机私有差异与部署位置 |
| `private/machines/<name>/snapshot/` | 未显式声明 installation 时使用的安装依赖输入 |
| `generated/` | 渲染、隔离测试与维护暂存 |
| `scripts/` | 命令入口与复用的诊断／部署逻辑 |

`private/`、`generated/` 和真实参数均被 Git 忽略。公开示例没有真实端点或凭据；新机器从示例开始，私有参数通过私有通道传递。会话、数据库、索引、缓存和 storages 不同步。

机器参数提供 `features`、`mcp`、`subagentModels`、`providers`、`rowOps`、`homePrivate`／`webPrivate`；启用额外提示词 preset 时提供 `promptSections`，见[提示词模块](plugins/README.md)。对话默认模型不在机器参数里：它属于会话与界面的状态。日用（id `standard-ptc`）、日用+Team 和日用+逆向 preset 共用模板，逆向模式追加提示词插件。preset 显示名可以随意改；id 写在已有会话里，改 id 会让旧会话找不到原 preset。provider 目录由 [shared/providers.yaml](shared/providers.yaml) 共用，机器只写 add／set／remove 差异：set 只覆盖该 provider 的顶层键，嵌套值（如 models）整体替换；专属 MCP 行仍保留为私有输入，不进行通用深合并。

共用 `klaude-openai.compat` 将 `maxConsecutiveWhitespaceChars` 和 `maxRepeatedPatternChars` 均设为 5000（5k），限制每个 Responses 输出项的连续空白与短周期重复；其他 provider 保持 pi-ai 默认阈值。对应 pi-ai 与 DSH 适配器的精确成品由依赖清单统一选择。

### 本地 JS 插件

[共用默认配置](<shared/defaults.yaml>)和机器参数的 `localPlugins` 将仓库内小型 ESM 模块纳入 render/check 和 update 文件计划；显式 apply 与配置 patch 一同备份、写入和回滚，不增加 npm 依赖。见[安装声明](<docs/install.md#本地-esm-插件>)、[中性示例](<examples/local-plugins-machine.yaml>)和[思源上传／双端同步工具](<plugins/siyuan-tools.md>)。源码不包含机器端点或凭据，认证继续引用目标机器已有 headers JSON。

共用 progressive-tools 配置使用有序 toolDisclosureRules：普通工具 eager，mcp__* 和 siyuan_* deferred。对应资产版本由[依赖清单](<shared/dependencies.yaml>)选定。

### 运行时工具指引

[runtime-tooling-guidance.mjs](<plugins/runtime-tooling-guidance.mjs>) 按当前工具模式、PTC 语言与子代理身份加入适用的简短指引，替代 agentsmd 中整段静态 tooling 说明。在[共用默认配置](<shared/defaults.yaml>)中声明一次，各机沿原 apply 流程部署到目标 home；配置和验证见[本地插件说明](<plugins/README.md#运行时工具指引>)；不改变工具权限或执行行为。

### Provider 路由提示词

[provider-prompt.mjs](<plugins/provider-prompt.mjs>) 通过各机已有 `localPlugins` 文件计划在 home 挂载一次，不安装 npm 包，也不依赖 Release。显式 `config.rules` 当前只面向 `klaude-cl` 的全部模型；其他路由不输出，空 `rules` 禁用。声明与验证见[本地插件说明](<plugins/README.md#provider-路由提示词>)和[公开示例](<examples/local-plugins-machine.yaml>)。

### 可视化插件

Web profile 统一启用 `@nagi-ovo/dsh-visualize`，使用依赖清单中的 npm 精确版本；其他 profile 不自动安装。插件由共用 Web patch 激活，不重复加载 bundle。OpenUI 不再由配置安装或激活，已安装的旧包在维护窗口通过 pnpm 卸载。

### 配置归属：模板、界面与机器

DSH 的设置页只能写带 `.volatile()` 的字段，并写进 **profile patch**（`profiles/<name>/cordis.patch.yml`）。因此本仓库遵循一条硬规则：**模板绝不渲染界面拥有的字段**，否则下一次 `update --apply` 会静默覆盖界面里的选择。

| 归属 | 内容 | 落点 |
|---|---|---|
| 模板独占 | 插件行、preset 定义、compaction、MCP 清单、`llm-pi-ai` providers、`llm-deepseek` 模型目录、`agent-loop`、`subagent-model-selection-settings` | `$DSH_HOME/cordis.patch.yml` |
| 界面独占 | `agent-default-model`、`agent-preset-registry.selectedDefault`、`ui-conversation.busyEnter`、`ui-settings-general.welcomeNoticeVersion`、`ui-chat`、`ui-theme`、`locale` 等 | profile patch，由界面写入 |
| 机器参数 | 共享目录的差异：provider 增删、MCP 端点与凭证路径、允许的子代理模型 | `private/machines/<name>/machine.yaml` |

`llm-pi-ai` 与 `llm-deepseek` 位于 base bundle，放进 home patch 对每个 profile 都成立。Models 页仍可管理凭据（写入 `$DSH_HOME/.credentials.yaml`，不在 patch 里），但已由模板声明的 provider 与模型目录是只读的；要改就改模板。

`update --apply` 写 patch 时是**保守覆盖**：先写模板产生的行，再把 live 文件里模板不产生的行原样追加保留（界面新增的行、手工实验的行因此不会丢），最后删除 `rowOps.<layer>.retire` 列出的行。预览会列出保留行与生效的移除锚点。

### 按 id 保留与删除顶层行（rowOps.retire）

模板只拥有它自己渲染的行；其余行在 apply 后继续留在文件里。需要让某行**真正消失**时，在机器参数里登记 id：

```yaml
rowOps:
  web:
    retire:
      - llm-pi-ai          # 已搬到 home patch，profile 侧留着会是死行
      - agent-loop
```

| 属性 | 行为 |
|---|---|
| 作用阶段 | 渲染时从模板输出里删（render/check 就能看到结果）；apply 时再从保留的 live 行里删 |
| 作用范围 | 仅顶层 patch 行：插件 insert 条目、`- id: x` 覆盖行、`{id, insert:[...]}` 分组行都可按 id 命中；**不进入 preset 的嵌套插件行** |
| 分层 | `rowOps.home` 与 `rowOps.web` 独立；同一 id 在两层各有一份时必须 retire 源层 |
| 匹配 | 精确 id，不支持路径、前缀或 glob |
| 幂等 | id 不存在时是 no-op，墓碑可以保留 |
| 不能表达 | `disabled`（用模板或 `presetRows` 表达）；嵌套行删除（用 `presetRows` 的 selector） |

两条使用规则：**从模板删行**只让它变成"保留行"，必须再加 retire 才会消失；**把行从 profile 搬到 home**（或反向）必须在源层 retire，否则旧副本会作为保留行长期存在。

`rowOps` 与 [preset 行禁用](#按机器禁用-preset-插件行)是两套独立词表：前者按顶层行 id 删除，后者按 preset 内的 selector 设 `disabled`，互不影响。

### 按机器禁用 preset 插件行

在 NAS 私有参数 `private/machines/nas/machine.yaml` 中配置：

```yaml
overrides:
  presetRows:
    all:
      tool-web: { disabled: true }
      delegation/tool-ralph: { disabled: true }
    presets:
      standard-ptc-team:
        tool-web: { disabled: false }
        delegation/tool-agent-team: { disabled: true }
```

`all` 应用于每个已生成 preset；`presets` 以 preset 的 `config.id` 为键，特化值优先于 `all`，即使两个 selector 用不同写法指向同一行。上例在日用和逆向禁用内置网页工具，在 Team 中重新启用；三个 preset 都禁用 Ralph，只有 Team 禁用 Team 工具。日用、Team、可选逆向继续使用同一模板宏。

selector 可以是 preset 内递归唯一的 entry `id`，或从根开始、以 `/` 分隔的完整 group 路径，例如 `delegation/tool-ralph`；group 行本身也可禁用。路径只写 group/entry id，不写 `config` 或 `plugins`。每个 selector 在每个适用 preset 内必须恰好匹配一行；Team 专属项放在 Team 的特化配置里。未知 preset、未匹配或歧义 selector、同一层多个 selector 指向同一行、非布尔 `disabled` 和额外字段均报错。

每项仅允许 `{ disabled: true | false }`，不合并或替换 `config`。未指定行保持原值，包括原有 `!!js` 表达式；显式布尔值可覆盖该行的表达式。未配置本功能时输出保持不变。NAS 参数就绪后，用 `node scripts/dsh-config.mjs check --machine nas` 做只读结构检查；`render --machine nas` 写入私有暂存，不部署或连接 NAS。

两机会话标题在 Home patch 中统一使用共用 `defaults.sessionTitle` 配置，Web profile 不重复声明，私有输入不再保留旧标题覆盖。标题固定为 `deepseek-official/deepseek-flash`，输入上限 65536 字节、输出上限 64 tokens、超时 60000 毫秒；沿用官方标题插件自动选择最低推理档位的行为（该模型为 `off`），不随聊天模型选择器变化。

`standard-ptc-team` 的 `spawn_teammate` 支持逐次指定 `provider`、`model` 和 `reasoning_effort`，通过 `list_agent_models` 查询可用路由。Team 与普通 Subagent 共用 Host 的 `subagent-model-selection-settings`，授权策略在新 Session 中确定并持久保存；更新后新建 Team Session 使用此能力。未指定模型时继承 Lead 当前设置，切换路由而未指定 effort 时使用目标模型默认值。

可选 `acp.pressureDefault: { nudgeAtRatio: 0.70, resetBelowRatio: 0.65 }` 为未列出模型设置最大上下文比例阈值；`pressureRoutes` 保持精确路由绝对 token 覆盖。`features.activeContext: true` 选择 ACP，与 `features.sessionTools` 独立；未填写或为 false 时保留 Basic。见[公开 ACP 示例](<examples/active-context-machine.yaml>)和[ACP 配置与验收](<docs/install.md#active-context-pruningacp>)。

可选 `installation.globalWorkspace`／`installation.webPackage` 提供安装输入；共用清单覆盖受管项，保留无关 overrides 和机器专属依赖。受管 fork／个人插件选择精确 Release URL，明确允许的官方包、普通库与第三方插件保留精确 registry pin。缺精确资产会阻塞正式更新，不自动换版本或回退本地来源。

`deployment` 可省略；doctor、update 默认预览和 apply 使用执行机器的 DSH_HOME／用户主目录及 pnpm 公共信息推导部署路径，显式路径支持 `~/` 和已定义环境变量。`update --offline`、render/check 只消费机器声明或快照，不引入执行机器的安装输入。共用本地模块要求明确的绝对 `deployment.home`，或沿已有一致的 `home/plugins` 目录；离线不展开 `~` 或环境变量，位置缺失或歧义会报错。具体默认和覆盖方式见[部署位置](docs/install.md#2-声明本机部署位置)。

`check` 根据当前机器参数和模板重新渲染，在内存中校验配置结构，无需先运行 render，也不读取已有生成结果；缺少 Release 资产时另外列出“待发布来源”。当前模板与机器参数决定目标配置；Host 加载与功能由成品 smoke 和实际维护验收确认。

## 生成文件与清理

- **渲染产物：** `render` 写入 `generated/<name>/`，供人工检查；可删除并重新生成。保存的 doctor/update 输出是当次报告，不是后续命令的输入。
- **测试暂存：** 自动测试和隔离测试各自拥有临时目录，在成功或失败结束后自动清理；测试日志与维护日志分开。
- **维护日志：** `generated/*-install.log` 供更新过程即时排障，操作结束后按诊断需要保留或删除。
- **更新备份：** `generated/<name>-backup-*` 保存更新前的真实文件，不能靠 render 重建。维护验收并确认不再需要回滚后，才删除对应备份。不要整体清空 generated 来代替分类清理。

`private/machines/<name>/snapshot/` 仅保留依赖解析仍使用的 `global-workspace.yaml` 与 `web.package.json`。旧配置 patch、profile 副本和 lockfile 不作为当前配置标准；真实更新的回滚文件保存在本次维护备份中。

## 表达式与凭据

Nunjucks 使用 `[[ ... ]]` 插值和 `[% ... %]` 控制块；关闭 HTML 转义，缺失插值报错。DSH 的 `{{model}}`、`{{provider}}` 等 prompt 变量与字面 `!!js` 保留到输出，由 Host 加载时解释。可用变量随上游版本变化，例如 0.2.x 已移除 `{{cwd}}`；未注册的变量会让第一次模型请求失败，profile smoke 会逐个 preset 渲染提示词来发现这类问题。生成器不读取凭据文件，也不求值表达式。API key、认证文件和凭据状态留在各机原位置；已有参数可能含内联认证值，因此私有输入与输出均不进入 Git。

## 提交与交付

本仓库在本地运行 `pnpm test` 验证改动；需要检查两机当前目标配置时，在持有私有参数的机器上运行 check。涉及已安装 DSH 的集成检查，使用本机准备好的 runtime。提交前检查暂存差异和 `git diff --cached --check`，不将私有参数或生成文件加入 Git。

源码仓库拥有功能、构建、成品 smoke 和不可变 Release workflow；本仓库维护个人两机安装与测试指南。发布、真实安装与 Host 切换分别授权。update 默认预览，只有显式 `--apply` 才执行变更，不启停 Host。

参考：[Nunjucks 模板语法](https://mozilla.github.io/nunjucks/templating.html)。
