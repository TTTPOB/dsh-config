# Word 原生工具

[word.mjs](<word.mjs>) 提供读写 Word 文档、页面检查和 Zotero 原生引文工具，并内置英文 word skill。

使用前提：Windows 上运行 Office helper，并在目标文档中打开 Word Helper 加载项。

## 接入

通过 [localPlugins 安装流程](<../docs/install.md#本地-esm-插件>) 部署 word.mjs。需要独立 tarball 时，运行 [pack-word.mjs](<../scripts/pack-word.mjs>)，按包内 README 安装。

插件项的 config 设置 helperUrl，指向 DSH 能访问的 Windows helper 地址；机器专用地址保存在私有参数中。配置字段与默认值以 [Config](<word.mjs#L7>) 为准：

| 配置 | 用途 |
|---|---|
| helperUrl | Windows helper 的 HTTP 入口，可使用 loopback 或 SSH 转发 |
| helperToken | 非空时发送 Authorization: Bearer 请求头；当前 helper 不校验此头，只有前置代理实现校验时才提供 token 访问控制 |
| timeoutMs | 工具请求超时 |
| autoHide | 每个任务窗格首次文档操作前自动隐藏；显式显示后保持显示 |
| renderLongEdge | 页面 PNG 的最长边像素 |

helper 的部署与接口见 ops 仓库的 Office Helper 文档。页面在 Windows 侧渲染，DSH 所在机器不需要安装 PDF 工具。

## 操作流程

1. 加载 word skill，按请求确定要读取、修改或检查的内容。
2. 只连了一个文档时直接操作。连了多个时，先用 word_list_documents 查看，再用 word_select_document 选定；选择按 DSH 会话记住。选定的文档关闭后工具会报错，不会换到别的文档。
3. 用 word_search_doc_text 定位，再用 word_read_doc_section 读取目标段落或章节。大文档优先按范围读取，避免一次枚举全文。
4. 修改最小必要范围，读回文字与格式；排版变化用 word_render_page 查看。

工具参数以运行时 schema 为准。

## 文档工具

| 工具 | 用途与重要限制 |
|---|---|
| word_list_documents | 列出已连接文档和当前选择 |
| word_select_document | 选择后续操作的文档 |
| word_search_doc_text | 按文字查找正文，返回段落位置；不搜索页眉页脚 |
| word_read_doc_section | 按章节或段落范围读取最终文字；读取干净副本无需接受修订 |
| word_edit_doc_text | 精确替换唯一匹配的文字，保留范围外的内容与修订 |
| word_edit_doc_list | 创建普通列表或插入列表项；多级编号用 Office.js |
| word_collapse_blank_paragraphs | 合并连续空段落，保留携带结构内容的段落 |
| word_verify_doc | 检查样式分布、编号和表格结构；视觉效果需看渲染 |
| word_execute_office_js | 在 Word.run 内执行可信异步代码；直接使用 context，修改后显式同步 |
| word_render_page | 把指定页面渲染成 PNG，并返回总页数 |
| word_insert_image | 插入 DSH 机器上的图片或图片字节；选区插入会替换选区 |
| word_pane_visibility | 显示或隐藏任务窗格，保留运行时 |

## Zotero 原生引文

先运行 Zotero、加载官方 Word 模板，并保存目标文档。引文项的 URI 和 CSL-JSON 从 Zotero 读取。没有 Zotero preferences 的文档首次插入需指定 CSL 样式；已有 preferences 保留。当前支持正文 Field 引文，脚注、尾注和 Bookmark 引文插入不支持。

| 工具 | 用途 |
|---|---|
| word_zotero_insert_citation | 插入原生 Zotero 引文字段 |
| word_zotero_insert_bibliography | 插入原生参考文献表 |
| word_zotero_refresh | 触发官方 Zotero 刷新 |
| word_zotero_inspect | 读取文档、字段和 preferences |
| word_zotero_set_style | 切换 CSL 样式 |

refreshTriggered 只表示官方宏已触发，不代表刷新完成；pendingFormatting 只检测空白或占位符。刷新或改样式后用 inspect 核对实际引文与书目文字。

## 写入与检查

超时、断线或失败后先读回文档：修改可能已经生效，工具不会自动重试。word_execute_office_js 运行的是可信代码，能访问 Office 宿主的全部能力。页面图片来自 Word 的 PDF 导出，修订标记是否显示取决于 Word 当前的导出设置。
