# 本机 JS 模块

仓库模块可以通过 localPlugins 纳入配置部署文件计划，见[安装指南](<../docs/install.md#本地-esm-插件>)。思源工具配置与行为见[上传和双端同步](<siyuan-tools.md>)。

## 运行时工具指引

[runtime-tooling-guidance.mjs](<runtime-tooling-guidance.mjs>) 根据当前工具模式、PTC 语言和子代理身份注册适用章节，使用 `interpolate: false`。`config: {}` 使用模块内默认文案；`config.text` 对象可分别覆盖 `native`、`typescript`、`python`、`output`、`background`、`child`。工具 schema 和运行时权限仍决定实际可调用能力。

### 一处共用声明

[共用默认配置](<../shared/defaults.yaml>) 已声明此模块，无需在各机私有输入重复添加：

```yaml
localPlugins:
  - id: runtime-tooling-guidance
    module: runtime-tooling-guidance.mjs
    config: {}
```

共用数组只接受 `id`、`module`、`config`，目标固定为 DSH home 下的 `plugins/<module>`。机器级 `localPlugins` 保留原有绝对 `modulePath` 接口；不接受 `!!js`、相对路径或待求值的表达式。机器与共用项同 id 时，机器声明**整项替换**，包括模块、路径和整个 config，不深合并；同一共用模块不能用另一个 id 再部署一份。

路径规则：

1. live update/apply 使用 `normalizeDeployment` 已解析的目标 home。
2. render/check 和 `update --offline` 使用机器声明的字面绝对 `deployment.home`；省略时，仅从已有本地插件统一的 `home/plugins` 目录推导。路径缺失或有歧义则报错；不查询 pnpm、真实安装或检查者的 HOME，不展开环境变量或 `~`。
3. 省略 `deployment.home` 时，live 解析的 home 若与现有模块目录不一致会阻塞，须明确声明目标 home。这样不会将另一机器的离线检查路径误当本机部署位置。公开示例使用中性绝对路径。

模块只在 home 激活一次，源码沿现有文件计划暂存、预览、备份和部署。Git 同步后，在各目标机器运行原有显式 apply 流程即可更新；模块重新加载和 Host 激活仍属于既有维护流程。

### 本地验证

```sh
node --test tests/runtime-tooling-guidance.test.mjs tests/runtime-tooling-config.test.mjs tests/local-plugins.test.mjs
node scripts/dsh-config.mjs check --machine workstation
node scripts/dsh-config.mjs update --machine workstation --offline
```

server、nas 使用各自机器名；check 和离线预览只消费本地输入，不连接这些机器。配置测试的 apply／回滚只操作自动清理的隔离 fixture。

## Provider 路由提示词

[provider-prompt.mjs](<provider-prompt.mjs>) 使用现有 `localPlugins` 声明部署：每机只添加一项 `id: provider-prompt`、`module: provider-prompt.mjs`、`modulePath: /path/to/harness-home/plugins/provider-prompt.mjs`，`config.rules` 写在该项内。完整示例见[本地插件参数](<../examples/local-plugins-machine.yaml>)。每机的 `modulePath` 沿已有本地插件目录设置；不需要包依赖、公开仓库或 Release，也没有共享配置的隐式合并或 fallback。

插件在 home 只挂载一次，不重复放进 preset 或 Web patch。规则为 `{ providers: string[], models?: string[], text: string }`：provider 精确匹配，省略 models 适用于该 provider 的所有模型；提供 models 时必须是非空精确模型列表；text 不插值。当前声明仅 `providers: [klaude-cl]`，省略 models；其他路由不输出。`config: { rules: [] }` 禁用。

提示词只说明真实外层工具名与 run_code 内部绑定的区别，不改变工具可见性或调用权限；实际工具 schema 优先。声明通过现有文件计划进行 check、离线预览及显式部署，真实安装与 Host 激活仍需另行授权。

```sh
node --test tests/provider-prompt.test.mjs tests/provider-prompt-config.test.mjs tests/local-plugins.test.mjs
node scripts/dsh-config.mjs check --machine workstation
node scripts/dsh-config.mjs update --machine workstation --offline
```

设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 package.json 绝对路径后，测试会用正式 Loader 加载临时复制的模块，验证路由切换、配置替换、作用域与卸载；未设置时明确跳过此集成用例，不启动 Host。

server、nas 使用各自的机器名；这些命令只检查本地输入，不连接对应机器。不要添加 `--apply`。离线预览只与声明／快照比较，不验证真实安装或 Host 已加载模块。

## PTC 字符串构造指引

[ptc-string-guidance.mjs](ptc-string-guidance.mjs) 注册独立的 `dsh-config:ptc-string-guidance` 章节，排在 SDK 后，使用 `interpolate: false`。仅当当前组装具有非空 `tools:sdk` 且运行时语言为 TypeScript 时保留；Native 和 Python 不输出。它不替换 SDK、不修改工具描述、可见性或执行权限；`edit` 和 `send_message` 保持原有 PTC 路径。

通过机器参数的 `localPlugins` 在 home 层挂载一次，已有和后续 Agent 按各自组装结果判断。声明示例见[本地插件参数](../examples/local-plugins-machine.yaml)：`id: ptc-string-guidance`、`module: ptc-string-guidance.mjs`、`modulePath: /path/to/harness-home/plugins/ptc-string-guidance.mjs`、`config: {}`。可通过 `config.text` 整体替换默认指引；不接受空白文本或未知配置键。

默认指引区分工具 JSON 编码与解码后的 TypeScript 源码，要求长文本采用双引号逐行数组和 `.join("\n")`，保留空行及末尾换行，避免任意 Markdown 使用模板字符串。它是提示词约定，不是语法校验器，不保证模型不再出错。每个 TypeScript PTC 请求增加固定指引文本；相同配置下内容稳定，不逐轮累积。

模块随现有 localPlugins 文件计划暂存、预览和显式部署，无 npm 依赖。卸载清理章节与监听器；更改源码或配置需重新加载模块。完整 `complete` 提示词仍由核心恢复，本插件不向其追加内容。

验证：`node --test tests/ptc-string-guidance.test.mjs tests/local-plugins.test.mjs`。设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 manifest 路径，可运行真实 Loader 与 ToolRuntime 的进程内组装测试；不启动 Host、不调用模型、不执行 PTC 代码。未设置时集成用例明确 skip。`node scripts/dsh-config.mjs update --machine workstation` 只预览，不能加 `--apply`，除非另获部署授权。

## 提示词模块

[prompt-sections.mjs](prompt-sections.mjs) 把文本注册到挂载它的 preset 作用域。模块只依赖 Node 内置文件 API 和 Host 的 `systemPrompt` 服务，无需安装 npm 包。

## 文件与配置

在目标机器上复制模块与仓库中的提示词：

```sh
home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$home/plugins" "$home/prompts"
cp plugins/prompt-sections.mjs "$home/plugins/prompt-sections.mjs"
cp prompts/DONT_READ_THIS_IF_YOU_ARE_AGENT*.md "$home/prompts/"
```

共用文本保存在仓库的 [额外文本](../prompts/DONT_READ_THIS_IF_YOU_ARE_AGENT.extra.md) 和 [身份文本](../prompts/DONT_READ_THIS_IF_YOU_ARE_AGENT.identity.md)，随 Git 同步；本机运行副本保存在 Harness home。修改仓库文本后，在目标机器重新复制并挂载 preset。为本机参数配置绝对路径：

```yaml
features:
  sessionTools: true
  promptOverlay: true
  legacySessionQuery: false
promptSections:
  modulePath: /path/to/harness-home/plugins/prompt-sections.mjs
  promptFile: /path/to/harness-home/prompts/DONT_READ_THIS_IF_YOU_ARE_AGENT.extra.md
  identityFile: /path/to/harness-home/prompts/DONT_READ_THIS_IF_YOU_ARE_AGENT.identity.md
```

渲染模板会把这些路径写入额外提示词 preset。模块加载时读取并 trim 文本；缺失或空文本会让该模块加载失败。模块导出 Cordis 支持的 Standard Schema，检查路径、顺序与开关，无额外 schema 包依赖。

## 行为

- `promptFile`：注册额外提示词 section，`order` 默认 100。
- `identityFile`：在本作用域覆盖 `harness:identity`。原生模块配置可设 `shadowHarnessIdentity: false`，只注册额外提示词且不读取身份文件；当前 preset 模板启用身份覆盖。
- 两份文本都使用 `interpolate: false`，`{{…}}` 原样保留。
- 文本在激活时读取一次。修改文本后需重新挂载该 preset；代码更新也需要重新加载模块，不保证运行中会话自动换版。
- 卸载时清理 section。标准 preset、其它作用域和其它提示词 section 保持独立。

## 验证

```sh
node --test tests/prompt-sections.test.mjs
```

测试使用中性文本。设置 `DSH_CLI_PACKAGE` 为当前安装版 CLI 的 package.json 路径，可额外运行实际 Loader、作用域隔离及卸载测试；设置 `DSH_PROMPT_MODULE` 可指定已复制的模块文件。测试不启动 Host，不调用模型，也不读取用户私有提示词。
