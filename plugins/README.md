# 本机 JS 模块

仓库模块可以通过 localPlugins 纳入配置部署文件计划，见[安装指南](<../docs/install.md#本地-esm-插件>)。

- [Word 与 Zotero 原生工具](<word.md>)
- [PowerPoint 原生工具](<powerpoint.md>)

Office 插件可沿本仓库的 `localPlugins` 流程部署，也可用 `scripts/pack-word.mjs` 或 `scripts/pack-powerpoint.mjs` 生成独立 tarball。包内 README 说明独立安装步骤；两种方式选一种。

Word 的 TypeScript 源码位于 [plugins-src/word](<../plugins-src/README.md>)；修改后运行 `pnpm build:word`，部署和打包仍读取已提交的 [word.mjs](<word.mjs>)。Word skill 由私有 helper 目录提供，公开模块不含正文；PowerPoint skill 继续本地内嵌。

## 运行时工具指引

[runtime-tooling-guidance.mjs](<runtime-tooling-guidance.mjs>) 根据当前工具模式、PTC 语言和子代理身份注册适用章节，使用 `interpolate: false`。`config: {}` 使用模块内默认文案；`config.text` 对象可分别覆盖 `native`、`typescript`、`python`、`grep`、`output`、`background`、`child`、`sdkMessage`。工具 schema 和运行时权限仍决定实际可调用能力。

`grep` 提示仅在当前可见的工具含 `grep.pattern` 时加入：11 月 11–21 日的三机审计中，ripgrep 拒绝了 152 次调用，其中 132 次报分组未闭合，因此提示重点说明字面元字符的转义。

各段的出现条件：

| 段 | 出现条件 | 内容 |
| --- | --- | --- |
| `background` | 可用后台 job，或可见 `subagent`，或可见 `send_message` | job、委派的 agent 和发给自己的消息都会开启下一轮；只剩等待时结束本轮，不轮询 |
| `child` | 当前 Agent 是 continuable 子代理、父代理在线，且可见的 `send_message` 有 `agent` 和 `message` 参数 | 用 `send_message` 按身份段中的名字把报告发给父代理，再以极短确认结束 |
| `sdkMessage` | PTC SDK 模式且已选中 `child` | `send_message` 是 SDK 绑定，须在程序内调用 |

**为什么先发消息再简短确认：** rc.5 本地子代理等 Agent 活动和待处理输入都结束后才关闭接纳，自动送达的是最后一轮普通轮次的输出。写报告时若收到消息并再开一轮，父代理收到的就是新一轮的输出，原报告可能没有送达。用 `send_message` 显式发送的报告不依赖最后一轮输出；当最后一个动作是给父代理发消息时，rc.5 会通过 `omitClosingText` 在完成通知中省略最终答复，因此发完只需简短确认，不必重述报告正文。

依据：rc.5 的 [Activation settlement](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/subagent/subagent/README.md#activation-settlement) 与 [`withResultDeliveryGuidance`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/subagent/subagent/src/continuation-messages.ts#L83-L95)。上述时序按代码和文档推断，未用真实模型复现。

## Team 协作提示

[team-collaboration-notes.mjs](<team-collaboration-notes.mjs>) 仅在当前 Agent 的根会话开启 Team 模式时提示：同级或非直接子代理完成时不会通知当前 Agent；若需要结果，请对方完成后用 `send_message` 发送。插件额外注册独立提示段，不改写上游文案或工具描述。

### 部署

共用声明、机器覆盖和路径规则见[本地 ESM 插件](<../docs/install.md#本地-esm-插件>)。

### 本地验证

```sh
node --test tests/runtime-tooling-guidance.test.mjs tests/runtime-tooling-config.test.mjs tests/local-plugins.test.mjs
node scripts/dsh-config.mjs check --machine workstation
node scripts/dsh-config.mjs update --machine workstation --offline
```

server、nas 使用各自机器名；check 和离线预览只消费本地输入，不连接这些机器。配置测试的 apply／回滚只操作自动清理的隔离 fixture。

## 流式循环拦截

[stream-loop-guard.mjs](<stream-loop-guard.mjs>) 在 Host 层挂载一次，覆盖所有 preset。它只检查带会话 ID 的模型流，分别累计每个文本块、推理块及工具调用的参数增量。默认使用 `cross2`：每个分支的得分须连续 `consecutive` 次达到阈值才算命中，任一分支命中即停止读取上游，并以 `STREAM_LOOP_DETECTED` 结束这次响应。已经收到但尚未转发的触发增量不会进入下游。失败响应只留在尝试日志中，不进入对话历史，不执行其中的工具。

同一会话的同一步最多因此重试五次。每次重试前写入一条来源为 `stream-loop-guard` 的用户消息，指出被拦截的位置并附两个短片段；消息留在会话历史里，不为后续请求再次写入，也不重发运行时上下文快照。第六次命中不追加提示、不再重试，这一步以 `STREAM_LOOP_DETECTED` 错误结束。

`config: {}` 使用下表的默认参数。`disabledProviders` 接受按精确 ID 匹配的提供方列表，默认为空。`excerptLimit` 限制两个 JSON 字符串片段的总长度（含引号和转义，以 UTF-16 码元计，默认 600，最小 4），不含说明文字。`rules` 可按表中名称逐项覆盖参数；窗长和采样间隔以 UTF-16 码元计，压缩比用 UTF-8 字节计算，并包含压缩格式开销。

| `rules` | 压缩器 | `window` | `step` | `consecutive` | `threshold` | `shortWindow` / `gain` |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `B2` | Brotli，质量 2 | 250 | 250 | 2 | 2.80 | — |
| `RLE` | deflate，级别 1 + `Z_RLE` | 250 | 250 | 6 | 2.00 | — |
| `Z1` | zstd，级别 1 | 250 | 250 | 2 | 3.30 | — |
| `D6` | deflate，级别 6 | 1000 | 250 | 3 | 4.75 | 500 / 2.5 |

前三个分支以尾窗压缩比为得分；`D6` 取长窗压缩比与 `gain × 长窗压缩比 ÷ 短窗压缩比` 中较小者。三机 30 天校准回放中，`cross2` 在 185,653 个非空完成块上没有观测到误报，150 个已知循环全部在日志记录的最后一个增量之前命中；另一个真实的递增计数循环在循环开始后 500 码元处命中。它在 1,900 码元内命中 1,216 / 1,302 个合成阳性；实测中位 CPU 成本为 433 ms/MB。阈值在同一批数据上校准，没有用另外的数据检验；长整数列表也可能触发，时间戳、UUID 片段及带随机扰动的循环可能漏检。

运行 `node --test tests/stream-loop-guard.test.mjs` 验证检测和重试。设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 package.json 路径后，同一测试还会用真实 Loader 跑进程内 AgentLoop；不启动 Host、不调用真实模型。

## 工具调用纠错重试

[tool-call-hint.mjs](<tool-call-hint.mjs>) 在 Host 层挂载一次，使用 `config: {}`。网关因顶层工具不在 schema 中，或因调用了未开放的原生工具而拒绝整条响应时，插件在重试前追加一条来源为 `tool-call-hint` 的英文用户消息，提示使用 schema 中的完整顶层名称或在 `run_code` 内调用 `tools.<name>(...)`。被拒绝响应中的工具没有执行。

同一会话的同一轮和同一步最多因此重试三次。第四次匹配不追加消息，交给后续错误处理。

运行 `node --test tests/tool-call-hint.test.mjs` 验证。设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 package.json 路径，可额外用真实 Loader 跑进程内 AgentLoop，并用本地模拟网关验证 pi-ai 错误分类。不启动 Host，不调用真实模型。

## 错误码改写

[error-code-rules.mjs](<error-code-rules.mjs>) 按错误消息改写模型请求失败时的错误码，`llm-retry` 再按改写后的错误码决定是否重试。它取代了 Pi 适配器 fork 里的 provider 字段 `errorCodeRules`，在 home 挂载一次，覆盖所有 preset。

`config.rules` 中每条规则写 `providers`（精确的 provider ID 列表）、`match`（正则源码）和 `code`（新错误码）。同一请求按顺序取第一条命中的规则。只有分类器给出的 8 种错误码会被改写：`AUTH`、`QUOTA_EXCEEDED`、`RATE_LIMIT`、`INVALID_REQUEST`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`PI_AI_ERROR`；新错误码也只能是这 8 种之一。上下文超限、空响应、流式循环等专用错误码和中止的请求保持原样。`config: { rules: [] }` 禁用插件。

[共享配置](<../shared/defaults.yaml>)目前有两条规则：

- Klaude 两个网关的 `upstream_error` 改为 `SERVER`，按路由的重试策略重试。
- `klaude-cl` 拒绝未开放工具的错误改为 `PI_AI_ERROR`。不改的话，内建分类器会把 `web_fetch` 里的 "fetch" 当成网络错误（`TRANSPORT`），`llm-retry` 会直接重发同一请求，[tool-call-hint](<tool-call-hint.mjs>) 就没有机会提示模型纠正工具名。

运行 `node --test tests/error-code-rules.test.mjs tests/tool-call-hint.test.mjs` 验证。设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 package.json 路径后，测试还会用真实 Loader 确认 `llm-retry` 读到改写后的错误码，并用本地模拟网关确认工具名错误交给了 tool-call-hint。测试不启动 Host，也不调用真实模型。

## Provider 路由提示词

[provider-prompt.mjs](<provider-prompt.mjs>) 的 `config.rules` 写在对应插件项内。部署规则见[安装指南](<../docs/install.md#本地-esm-插件>)，声明见[本地插件示例](<../examples/local-plugins-machine.yaml>)。

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

默认指引只有两条规则：多行或含引号、反斜杠、反引号的文本使用原始文本字面量；shell 脚本通过带引号的 stdin heredoc 或先写文件传入，不能在 ssh／python -c 中嵌套脚本。三个 Wrong／Right 示例分别覆盖 write、edit 和远程 Python，Markdown 围栏示例展示四反引号分隔符。原始文本以 `@` 加 N≥2 个反引号开头，以最大连续长度恰为 N 的反引号结束；内容不转义、不插值，开头紧随的一次换行被移除。必须先发布并安装 lexer-aware Node PTC 运行时，再部署本指引和下述提醒插件。

部署见[安装指南](<../docs/install.md#本地-esm-插件>)，声明见[本地插件示例](<../examples/local-plugins-machine.yaml>)。已有和后续 Agent 按各自组装结果判断。可通过 `config.text` 整体替换默认指引；不接受空白文本或未知配置键。

每个 TypeScript PTC 请求增加固定指引文本；相同配置下内容稳定，不逐轮累积。指引是提示词约定，不是语法校验器。

模块随现有 localPlugins 文件计划暂存、预览和显式部署，无 npm 依赖。卸载清理章节与监听器；更改源码或配置需重新加载模块。完整 `complete` 提示词仍由核心恢复，本插件不向其追加内容。

验证：`node --test tests/ptc-string-guidance.test.mjs tests/local-plugins.test.mjs`。设置 `DSH_CLI_PACKAGE` 为已安装 CLI 的 manifest 路径，可运行真实 Loader 与 ToolRuntime 的进程内组装测试；不启动 Host、不调用模型、不执行 PTC 代码。未设置时集成用例明确 skip。`node scripts/dsh-config.mjs update --machine workstation` 只预览，不能加 `--apply`，除非另获部署授权。

## PTC 原始文本提醒

[ptc-raw-text-reminder.mjs](<ptc-raw-text-reminder.mjs>) 是无 npm 依赖的单文件 ESM，通过 `tools/post-execute` 监听 `exec.name === 'run_code' && exec.parent === undefined` 的根调用。它先调用 `next()`，保留下游 accept／block 决策及其 additionalContexts，再追加一条带 `source.kind: ptc-raw-text-reminder` 的 user 消息；不改工具返回值或正文。消息由核心写入日志并送往下一步 inbox。

检测使用内嵌的 MIT js-tokens 9.0.1 原版源码，先以等长、保留换行的占位符屏蔽已有原始文本，再检查五类写法：引号字符串中至少两次换行转义；长度超过 80 的引号字符串含转义引号；模板中转义反引号或插值起始符；纯字符串数组接换行 join；String.raw。注释、正则和普通字符串中的原始文本起始序列不当作原始文本。检测是建议性的，误报／漏报只影响是否提醒。

成功且命中时，提醒明确说“已经成功，不要重跑”，报告首个命中的行号；可可靠解码时，把实际值重排为原始文本，最多展示前三行／300 字符并标明省略，分隔符长于值中最长反引号段。其余命中只追加数量。失败若命中复杂文本，或错误是 SyntaxError、Unterminated raw string literal、包含 Location (JavaScript parse 的 strip 错误，则追加单行改写建议；有命中时附行号和最多 80 字符片段。其他失败不提醒。

`config: {}` 可用。配置字段：`enabled`（默认 true）、`newlineEscapeThreshold`（默认 2）、`escapedQuoteLengthThreshold`（默认 80）；文本可分别覆盖 `successText`、`suggestionText`、`failureText`、`moreText`，均须非空。阈值须为正整数，未知配置键被拒绝。声明见[本地插件示例](<../examples/local-plugins-machine.yaml>)，只在 home 挂载一次。部署顺序：先发布并安装 lexer-aware 运行时，再沿现有 localPlugins 显式部署流程安装两个插件；本仓库示例不自动更新真实安装。

插件没有冷却、限流或跨调用状态，每个符合条件的调用增加一条短 user 消息及对应输入 token；成功预览有长度限制，不把提醒写入固定系统提示词。重复命中会继续增加会话文本。卸载时 Cordis 清理监听器。

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test tests/ptc-string-guidance.test.mjs tests/ptc-raw-text-reminder.test.mjs tests/local-plugins.test.mjs
```

设置 `DSH_CLI_PACKAGE` 为 `pnpm list -g --depth 0 --json` 中 `@deepseek-ai/dsh` 安装目录下的 package.json 绝对路径，可运行真实 Loader／ToolRuntime 集成测试。测试通过临时配置加载模块，执行内建根 run_code 传输，检查提醒、嵌套过滤和卸载。run_code 是核心保留名称，不能手工注册；测试只以受控 PtcRuntime 替代实际程序执行器，不启动 Host、不调用模型，不证明真实 Node PTC 解析或下一步会话日志投递。

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
