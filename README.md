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

服务器使用自己的 `--machine server`。机器名只选择 `private/machines/<name>/machine.yaml`，不连接远程机器。也可以直接传参数文件路径。生成结果位于 `generated/<name>/`，保留为私有文件。

- [正式安装与更新](docs/install.md)：机器参数、目标来源、doctor、显式 apply、精确豁免和维护切换。
- [隔离成品测试](docs/testing.md)：源码聚焦验证、本地 tarball 测试副本及已有 smoke。

## 配置与依赖归属

| 位置 | 内容 |
|---|---|
| [shared/defaults.yaml](shared/defaults.yaml) | 共用默认配置 |
| [shared/dependencies.yaml](shared/dependencies.yaml) | 唯一选定版本、来源策略、安装归属和缺资产原因 |
| `templates/` | home/Web patch 文本模板；安装声明由脚本直接序列化 |
| `private/machines/<name>/machine.yaml` | 各机私有差异与部署位置 |
| `private/machines/<name>/snapshot/` | 首次迁移配置与依赖基线 |
| `generated/` | 渲染、隔离测试与维护暂存 |
| `scripts/` | 命令入口与复用的诊断／部署逻辑 |

`private/`、`generated/` 和真实参数均被 Git 忽略。公开示例没有真实端点或凭据；新机器从示例开始，私有参数通过私有通道传递。会话、数据库、索引、缓存和 storages 不同步。

机器参数提供 `features`、`overrides.defaultModel`、`homePrivate`／`webPrivate`；启用额外提示词 preset 时提供 `promptSections`，见[提示词模块](plugins/README.md)。标准＋PTC 和逆向 preset 共用模板，逆向模式追加提示词插件。机器专属 provider／MCP 完整行保留为私有输入，不进行通用深合并。

可选 `installation.globalWorkspace`／`installation.webPackage` 提供安装输入；共用清单覆盖受管项，保留无关 overrides 和机器专属依赖。受管 fork／个人插件选择精确 Release URL，明确允许的官方包、普通库与第三方插件保留精确 registry pin。缺精确资产会阻塞正式更新，不自动换版本或回退本地来源。

`deployment` 可省略；doctor、update 默认预览和 apply 使用执行机器的 DSH_HOME／用户主目录及 pnpm 公共信息推导部署路径，显式路径支持 `~/` 和已定义环境变量。`update --offline`、render/check 只消费机器 installation 参数或快照，不引入执行机器的安装输入。具体默认和覆盖方式见[部署位置](docs/install.md#2-声明本机部署位置)。

`check` 根据当前机器参数和模板重新渲染，在内存中校验并与首次迁移快照比较，无需先运行 render，也不读取已有生成结果。比较保留表达式源码和嵌套插件顺序，忽略顶层行顺序与 insert 分组。这是静态等价检查；Host 加载与功能由成品 smoke 和实际维护验收确认。

## 生成文件与清理

- **渲染产物：** `render` 写入 `generated/<name>/`，供人工检查；可删除并重新生成。保存的 doctor/update 输出是当次报告，不是后续命令的输入。
- **测试暂存：** 自动测试和隔离测试各自拥有临时目录，在成功或失败结束后自动清理；测试日志与维护日志分开。
- **维护日志：** `generated/*-install.log` 供更新过程即时排障，操作结束后按诊断需要保留或删除。
- **更新备份：** `generated/<name>-backup-*` 保存更新前的真实文件，不能靠 render 重建。维护验收并确认不再需要回滚后，才删除对应备份。不要整体清空 generated 来代替分类清理。

`private/machines/<name>/snapshot/` 是持久基线，不参与上述清理。配置比较使用其中的 home/Web patch；依赖解析可使用 global workspace 和 Web manifest。某台机器额外捕获的 profile、lockfile 等文件保留其历史参考用途，不要求所有机器的快照文件数一致。

## 表达式与凭据

Nunjucks 使用 `[[ ... ]]` 插值和 `[% ... %]` 控制块；关闭 HTML 转义，缺失插值报错。DSH 的 `{{cwd}}`、`{{model}}` 与字面 `!!js` 保留到输出，由 Host 加载时解释。生成器不读取凭据文件，也不求值表达式。API key、认证文件和凭据状态留在各机原位置；已有参数可能含内联认证值，因此私有输入与输出均不进入 Git。

## 提交与交付

CI 使用匿名示例；真实双机比对在持有私有参数的机器运行。提交前检查暂存差异和 `git diff --cached --check`，不将私有参数或生成文件加入 Git。

源码仓库拥有功能、构建、成品 smoke 和不可变 Release workflow；本仓库维护个人两机安装与测试指南。发布、真实安装与 Host 切换分别授权。update 默认预览，只有显式 `--apply` 才执行变更，不启停 Host。

参考：[Nunjucks 模板语法](https://mozilla.github.io/nunjucks/templating.html)。
