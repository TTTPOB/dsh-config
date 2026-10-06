# DSH 双机配置

本地维护共用配置，服务器部署选定的稳定提交。每台机器保留自己的 MCP 地址、凭据引用、模型选择和专属插件。

## 从哪里开始

需要 Node.js 24、pnpm 11.24.0 和 chezmoi。模板已使用 chezmoi 2.73.0 验证。

```sh
pnpm install --frozen-lockfile --ignore-workspace
pnpm render examples/workstation-machine.yaml
```

结果写入仓库内的 `generated/workstation-machine/`。此仓库当前只生成暂存配置、检查内容和列出依赖来源；应用配置与安装包需要后续部署步骤。

## 目录

```text
shared/
  defaults.yaml               共用默认配置
  dependencies.yaml           核对过的 Release 资产与迁移缺口
templates/
  home.patch.yml.tmpl         共用工具、workspace 能力和 preset
  web.patch.yml.tmpl          共用 Web 行为、模型选择
examples/
  workstation-machine.yaml    可公开的工作机示例
  server-machine.yaml         可公开的服务器示例
plugins/
  prompt-sections.mjs         无包依赖的提示词注册模块
prompts/
  DONT_READ_THIS_IF_YOU_ARE_AGENT.extra.md       共用额外提示词
  DONT_READ_THIS_IF_YOU_ARE_AGENT.identity.md    共用身份文本
private/                      Git 忽略，各机器自行保存
  machines/
    workstation/machine.yaml  工作机私有参数
    server/machine.yaml       服务器私有参数
    <machine>/snapshot/       捕获的配置与依赖基线
  tools/                      本地渲染工具
generated/                    Git 忽略，渲染结果
scripts/                      渲染、检查和来源清单
```

`private/` 里的真实参数与快照只保存在初始化机器上。公开仓库提供示例；另一台机器首次使用时需通过私有通道取得自己的参数文件。生成的配置也应作为私有文件保存。

## 本机差异怎么保留

`--machine NAME` 选择 `private/machines/NAME/machine.yaml`；名称支持字母、数字、下划线和连字符。`workstation`、`server` 是示例标签，不会连接远程机器。也可以直接传入参数文件路径。

`machine.yaml` 包含：

- `features`：session-tools、额外提示词 preset 和旧 session-query 工具的开关；`promptOverlay` 控制额外提示词 preset。
- `promptSections`：启用额外提示词时，本机模块入口与两份文本运行副本的绝对路径，见[提示词模块](plugins/README.md)。
- `overrides.defaultModel`：本机默认模型；省略时跟随 `shared/defaults.yaml`。
- `homePrivate` / `webPrivate`：本机专属的原生 YAML 行，包括 MCP、provider、relay 和认证引用。

初始化时保留完整的专属插件行，便于保持现状。以后可逐项提炼成地址、路径等小参数；提炼后应通过基线检查。模型 provider 定义目前也保留在私有行中，尚未统一成共用模型清单。

新机器可以从示例开始：

```sh
mkdir -p private/machines/workstation
cp examples/workstation-machine.yaml private/machines/workstation/machine.yaml
# Edit private/machines/workstation/machine.yaml for this machine.
pnpm render --machine workstation
pnpm check --machine workstation
```

为已有私有参数生成并检查配置：

```sh
pnpm render --machine workstation
pnpm check --machine workstation
pnpm render --machine server
pnpm check --machine server
```

检查会比较捕获快照与生成结果的插件行内容，包含表达式源码及嵌套插件顺序；忽略顶层行顺序和 insert 分组。该检查是静态配置检查，Host 加载与运行行为需在部署时另行验收。

标准＋PTC 与逆向模式由同一份 preset 模板生成，逆向模式仅追加提示词插件；机器参数提供模块与文本文件的路径。已有日用配置的机器专属行保存在 `homePrivate` / `webPrivate`，共用行由模板生成。`snapshot/` 可保留首次迁移的比对基线和原始依赖文件。

## 模板与凭据

chezmoi 使用 `[[ ... ]]`。DSH 的 `{{cwd}}`、`{{model}}` 留在输出中。`!!js` 在生成阶段作为文本保存，由 DSH 加载配置时求值。

生成器不读取凭据文件。实际 API key、请求头文件和认证状态留在各机器原位置；参数文件只保存运行时引用。当前捕获的配置可能包含内联认证值，因此 `private/` 与 `generated/` 都不进入 Git。

## GitHub Release 依赖

`shared/dependencies.yaml` 记录通过 GitHub Release API 核对的资产地址。受管 fork 和个人插件的正式交付使用精确 Release URL；官方 DSH 包与普通库可使用精确 registry 版本。

查看当前安装来源的迁移清单：

```sh
node scripts/dsh-config.mjs plan --machine workstation
node scripts/dsh-config.mjs plan --machine server
```

清单区分已核对的 Release、可匹配同名资产的迁移候选，以及尚缺精确资产的依赖。存在未解决项时返回退出码 2。资产目录记录不等于本地 tarball 内容比对，也不会自动替换版本。

初始盘点发现部分现用 tarball 没有在已查仓库找到同名资产；`pending` 列表保留这些缺口。确定发布地址后补充清单，再安排安装。清单不包含源码路径，也不自动选择“最新版本”。

## 维护与发布

```sh
pnpm test
# Inspect intended public changes, then stage them.
git add README.md AGENTS.md package.json pnpm-lock.yaml .gitignore .github shared templates examples plugins prompts scripts tests
git diff --cached --check
```

发布前人工检查暂存差异，确认实际机器信息只保存在 Git 忽略的目录中。CI 使用匿名示例验证模板；真实双机基线只在持有私有快照的机器运行。

修改共用配置后先在本地验证，再让服务器选择对应 Git 提交。依赖更新、配置应用和必要的 Host 重启是部署步骤，不由本仓库当前命令执行。会话、数据库、缓存与 storages 不在同步范围内。

参考：[chezmoi 多机差异](https://www.chezmoi.io/user-guide/manage-machine-to-machine-differences/) · [自定义模板分隔符](https://www.chezmoi.io/reference/templates/directives/)。
