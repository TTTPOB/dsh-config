# Word 原生工具

`word.mjs` 提供 DSH 原生 `word_*` 工具及内置英文 `word` skill。工具请求发送给文档绑定的自有 Word 加载项；业务执行层来自显式提取的 Claude Word 客户端，本插件不调用 Claude 模型、账号或 agent loop。加载项与 helper 由执行 Word 的 Windows 机器运行；不要求保留 CDP。

## 接入

本机通过机器声明的 `localPlugins` 安装，与其他本地 ESM 插件走相同的 render/check/update 流程。不要另手工写 profile 行或复制 skill 到全局目录。

```yaml
localPlugins:
  - id: word
    module: word.mjs
    modulePath: /path/to/harness-home/plugins/word.mjs
    config:
      helperUrl: http://127.0.0.1:18770
      autoHide: true
      timeoutMs: 90000
      pdfRenderer: pdftoppm
      renderLongEdge: 1800
```

`helperUrl` 是 DSH 机器实际可访问的 loopback 或 SSH 转发入口。可选 `helperToken` 只在配置中保存，默认空。`pdfRenderer` 是 DSH 执行机器上的 Poppler `pdftoppm` 命令或绝对路径，`renderLongEdge` 为页面 PNG 的最长边像素。Windows helper 的通用 `/state` 和 COM `/render` 仍是 PowerPoint 查询；Word 使用 `/health`、`/eval` 和只读的 `/word/list-styles`，不调用这两条 PowerPoint 路由。创建列表前，Windows helper 按当前文档的内置样式 ID 读取 `NameLocal`，将实际名称传给原处理器；DSH 不硬编码英文或中文显示名称，也不缓存可能变化的名称。

打包：`node scripts/pack-word.mjs`，产物为 `generated/word-package/dsh-word-0.1.0.tgz`。这是独立安装包；当前 `localPlugins` 部署直接同步仓库中的同一份单文件模块。打包不安装、不应用配置、不发布。

## 可用工具

原客户端本地 handler：`word_verify_doc`、`word_read_doc_section`、`word_search_doc_text`、`word_edit_doc_text`、`word_edit_doc_list`、`word_collapse_blank_paragraphs`。它们保留原输入校验和 `{success,result?,error?}` 返回值；DSH 的 JSON Schema 是参数展示，运行时仍由原 schema 处理默认值与限制。

`word_execute_office_js` 在已有 `Word.run` 内执行异步函数体，直接提供 `context`、`Office`、`Word`、`DOMParser`、`XMLSerializer`、`JSZip`、`console`。代码显式 `await context.sync()`，成功返回 `{success:true,result:...}`。这是可信代码适配，不是原产品的 SES 或权限卡。

附加工具：

- `word_render_page`：一基页码，Word 导出真实 PDF，DSH 机器将指定页转成 PNG，并通过原生图片 attachment 返回。无需另读图片文件。
- `word_insert_image`：从 DSH 机器上的 `filePath` 或裸 `base64` 插入内联图片；无需 Windows 路径。`where` 可为 `documentStart`、`documentEnd`、`selection`，后者替换选区。尺寸单位 pt，单边尺寸锁定比例，两边均给时显式设置大小。
- `word_pane_visibility`：显隐加载项，不关闭运行时。`autoHide` 控制首次文档调用前是否自动隐藏；实际可用性由 Word 的加载项运行时支持决定。

## Zotero 原生引文

以下工具经 Windows helper 的 `POST /word/zotero` 操作原生 Zotero 字段，而不是生成静态引用文本：

- `word_zotero_insert_citation({items, anchor_text?, position?, style_id?, refresh?})`：每项为 `{uri, itemData, locator?, label?, prefix?, suffix?, suppressAuthor?}`。`uri` 和 CSL-JSON `itemData` 必须从已有 Zotero MCP 读取真实条目；不猜本地 itemID/libraryID，不编造元数据。没有 Zotero preferences 的文档必须提供 `style_id`，由 helper 校验；已有文档保留 preferences。
- `word_zotero_insert_bibliography({anchor_text?, position?, refresh?})`：插入原生参考文献表。
- `word_zotero_refresh({})`：刷新当前文档中的 Zotero 引文和参考文献表。
- `word_zotero_inspect({})`：读取当前文档、字段与 preferences；超时或结果不确定时先调用它，不盲目再次插入。
- `word_zotero_set_style({style_id, refresh?})`：显式切换 CSL 样式。

`position` 为 `before`、`after`、`replace`、`end` 或 `selection`；`anchor_text` 用于定位唯一锚点。插入和改样式时 `refresh` 默认 `true`，可显式设为 `false`。位置缺省规则与锚点校验由 helper 负责。

每次调用先从文档绑定的加载项求值 `(Office.context.document.url || "")`，再发送 `{action, documentUrl, ...args}`；helper 按 URL 绑定已保存的当前文档，不盲用另一活动窗口。结果包含 `document`、`fields:[{kind,text,start,citationID?,uris?}]`、`preferences`、`refreshTriggered`、`pendingFormatting`。`refreshTriggered` 仅表示已触发官方宏；`pendingFormatting` 仅检测空白和占位符，不证明样式更新完成。刷新后调用 inspect 核对预期的引文和书目文字。工具复用同一串行队列、认证、取消和不重试机制。

执行层使用 Windows PowerShell 和 Word COM；MSO 自定义文档属性通过静态反射访问，不依赖 Python 或 pywin32。需要运行 Zotero、加载官方 Word 模板并保存目标文档。当前插入支持正文中的 Field 引文，暂不支持脚注／尾注或 Bookmark 引文，也不自动操作官方 Add/Edit Citation 选文献弹窗。上述工具需要提供 `/word/zotero` 的 Windows helper；DSH 插件部署本身不安装或重启 helper 或 Zotero。

## 工作方式与限制

工具调用串行执行，避免多个 agent 同时改写同一选区。断线、超时或原处理器失败后先读回文档，工具不重放可能已应用的写入。页面渲染使用 Word 当前导出的 PDF；修订显示与 Word 的当前导出设置相关，应查看图片而不是据文本结果推测版式。

原 `verify_doc_visual`、`explain_edits` 依赖模型 reviewer/verifier；`read_attachment_pages` 依赖 Claude 上传附件存储；`propose_doc_edits` 和 `withdraw_doc_edits` 依赖原聊天审核卡片和会话状态。这五个名字不注册成原生工具。DSH 自己判断编辑并查看页面图片，不制造虚假的审核卡或 `pending_review` 状态。

skill 按 `word_*` 原生名称描述操作，保留原 Word 指导中的段落与 run 继承、修订粒度、列表、表格、字段、脚注、书签、批注、页眉页脚与分页知识，不引入原 Claude 的产品身份或模型工作流。运行中不重新解析 bundle。
