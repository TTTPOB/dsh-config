# 本机提示词模块

[prompt-sections.mjs](prompt-sections.mjs) 把文本注册到挂载它的 preset 作用域。模块只依赖 Node 内置文件 API 和 Host 的 `systemPrompt` 服务，无需安装 npm 包。

## 文件与配置

在目标机器上复制模块与仓库中的提示词：

```sh
home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$home/plugins" "$home/prompts"
cp plugins/prompt-sections.mjs "$home/plugins/prompt-sections.mjs"
cp prompts/extra.md "$home/prompts/extra.md"
cp prompts/identity.md "$home/prompts/identity.md"
```

共用文本保存在仓库的 [extra.md](../prompts/extra.md) 和 [identity.md](../prompts/identity.md)，随 Git 同步；本机运行副本保存在 Harness home。修改仓库文本后，在目标机器重新复制并挂载 preset。为本机参数配置绝对路径：

```yaml
features:
  sessionTools: true
  promptOverlay: true
  legacySessionQuery: false
promptSections:
  modulePath: /path/to/harness-home/plugins/prompt-sections.mjs
  promptFile: /path/to/harness-home/prompts/extra.md
  identityFile: /path/to/harness-home/prompts/identity.md
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
