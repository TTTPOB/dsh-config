# 本地插件源码

Word 与 PowerPoint 的 TypeScript 源码位于本目录；部署和打包消费已提交的 [word.mjs](<../plugins/word.mjs>)、[powerpoint.mjs](<../plugins/powerpoint.mjs>)，消费端仅需 Node 内置模块。不要手改生成模块；源码与对应产物一起提交。

## 编辑与构建

在仓库根目录安装开发依赖，使用默认用户级 pnpm store/cache；不新增 workspace，也不创建项目内依赖缓存。

~~~sh
NODE_OPTIONS=--max-old-space-size=4096 pnpm install --frozen-lockfile --ignore-workspace
NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck:word
NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck:powerpoint
NODE_OPTIONS=--max-old-space-size=4096 pnpm build:word
NODE_OPTIONS=--max-old-space-size=4096 pnpm build:powerpoint
NODE_OPTIONS=--max-old-space-size=4096 node --test tests/word.test.mjs tests/powerpoint.test.mjs tests/office-catalog.test.mjs tests/office-catalog-schema.test.mjs tests/plugin-builds.test.mjs
NODE_OPTIONS=--max-old-space-size=4096 pnpm check:plugins
~~~

新鲜度检查在自动清理的临时目录重建并按字节比较，不覆盖部署产物，不请求 helper，不需要 Word skill 文件或客户端 bundle。PowerPoint 的英文 skill 编辑 [powerpoint/SKILL.md](<powerpoint/SKILL.md>)；Vite 的 `?raw` 将其嵌入产物。Word skill 只由私有 helper 的目录响应提供，本仓库不保存副本。

## helper 目录与生命周期

两插件只使用 helper。启动时立即注册自有工具与 skill provider，然后异步 GET 配置的 helperUrl 下的 `/catalog`，沿用 helperToken 与 timeoutMs；不需要打开任务窗格即可发现工具。具体文档操作仍要求目标任务窗格已连接。

目录提供 host、revision、source.bundleSha256、tools；每个工具包含 clientName、description、inputSchema。Word 可同时提供 skill 的 name、description、content；PowerPoint skill 保持本地内嵌。revision 是递归排序对象键、保留数组顺序的 `{tools, skill?}` 紧凑 JSON 的 UTF-8 SHA256。DSH 保留这个 revision 作为换代标记，不自行改写 helper 数据。

[shared/catalog.ts](<shared/catalog.ts>) 负责发现、校验、重试和换代。获取失败不阻塞激活，重试间隔从 catalogRetryInitialMs 指数增加到 catalogRetryMaxMs，并持续重试；成功后每 catalogRefreshMs 检查一次。默认分别为 1 秒、30 秒、5 分钟，均可配置。只在 revision 变化时先构造完整下一代，再注销旧代并注册新代；请求或构造失败保留现有工具和 Word skill。同 revision 保持工具对象不变。外部工具名冲突导致注册失败时回滚本次已注册工具，不留下半套工具，之后继续重试。

helper 断开不会注销已发现工具，调用报告连接错误；写入永不自动重试。卸载时取消目录请求、停止计时器并注销工具。Word provider 在目录无 skill 时 list 返回空、get 报不可用；有 skill 后使用已缓存内容，离线继续保留它。

## Schema 与自有覆盖

[shared/catalog-schema.ts](<shared/catalog-schema.ts>) 统一保留 DSH 支持的 type、oneOf、properties、required、additionalProperties、items、enum、const，以及 description、title、default、examples；删除 `$schema`、数值／长度／数量／正则约束等不受支持项，因为 DSH 的 assertSupportedJsonSchema 会拒绝它们。互斥的标量 anyOf 转为 oneOf；有重叠或无法表达的组合拒绝本次更新，保留上一代。default 是注解，不会替调用补默认参数；两宿主都保留它。

工具公开名称由前缀 powerpoint_／word_ 与 clientName 拼接；描述内的完整工具引用同步加前缀。只在 [PowerPoint 覆盖表](<powerpoint/src/catalog-overrides.ts>)、[Word 覆盖表](<word/src/catalog-overrides.ts>) 保存 DSH 自有说明，例如文稿 ID、写回行为、渲染工具和不适用的应用状态引用；其余描述和 schema 只来自目录，不保存提取快照。

## 源码位置

- [powerpoint/src/apply.ts](<powerpoint/src/apply.ts>)、[word/src/apply.ts](<word/src/apply.ts>)：静态工具、目录接线、会话选择和共享串行队列。
- [powerpoint/src/office-tool.ts](<powerpoint/src/office-tool.ts>)、[word/src/office-tool.ts](<word/src/office-tool.ts>)：自有 Office.js 执行工具和本地二进制文件参数。
- 各宿主的 config.ts、transport.ts、files.ts：配置、helper 请求和二进制输入；PowerPoint 的 render.ts 与 Word 的 images.ts 负责渲染，Word 的 zotero.ts 提供自有引文工具。
- [shared/types.ts](<shared/types.ts>)：最小 Host 服务接口与静态参数推导；[shared/vite.ts](<shared/vite.ts>)：独立的单文件 ESM 构建配置。

新增源码插件时复用共享类型与构建配置，并把 id 加入 [新鲜度检查](<../scripts/check-plugin-builds.mjs>)；现有手写插件不需要变动。测试只使用小型合成目录，不复制真实工具描述或 Word skill。
