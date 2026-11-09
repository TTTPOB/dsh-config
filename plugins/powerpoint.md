# PowerPoint 原生工具

[powerpoint.mjs](<powerpoint.mjs>) 提供 PowerPoint 文稿读写、OOXML 编辑、图表和页面检查工具，并内置英文 powerpoint skill。模块由 [TypeScript 源码](<../plugins-src/powerpoint/src/index.ts>) 和 [SKILL.md](<../plugins-src/powerpoint/SKILL.md>) 生成；修改与构建见[本地插件源码](<../plugins-src/README.md>)，不要直接编辑生成模块。

使用前提：Windows 上运行 Office helper，并在目标文稿中打开 PowerPoint Helper 加载项。

## 接入

通过 [localPlugins 安装流程](<../docs/install.md#本地-esm-插件>) 部署 powerpoint.mjs。需要独立 tarball 时，运行 [pack-powerpoint.mjs](<../scripts/pack-powerpoint.mjs>)，按包内 README 安装。

插件只连接 helper；将 config.helperUrl 指向 DSH 能访问的 Windows helper 地址。机器专用地址保存在私有参数中。配置字段与默认值以 [Config](<powerpoint.mjs>) 为准：

| 配置 | 用途 |
|---|---|
| helperUrl | helper 的 HTTP 入口，可使用 loopback 或 SSH 转发 |
| helperToken | 非空时发送 Authorization: Bearer 请求头；当前 helper 不校验此头，只有前置代理实现校验时才提供 token 访问控制 |
| timeoutMs | 工具请求超时 |
| autoHide | 每个任务窗格首次文档操作前自动隐藏；显式显示后保持显示 |
| renderBackend | officejs 从所选文稿渲染；com 使用活动文稿 |
| renderWidth / renderHeight | 渲染尺寸；Office.js 按宽度保持比例，COM 使用两项尺寸 |

helper 的部署与接口见 ops 仓库的 Office Helper 文档。旧配置中的 backend、endpoint、targetUrl、powershell 均会报不再支持，需删除；COM 渲染也由 helper 完成，不需要本机 PowerShell。目录发现和重试配置见[源码说明](<../plugins-src/README.md#helper-目录与生命周期>)。

## 操作流程

1. 加载 powerpoint skill，按请求确定要读取、修改或检查的页面。
2. 只连了一个文稿时直接操作。连了多个时，先用 powerpoint_list_presentations 查看，再用 powerpoint_select_presentation 选定；选择按 DSH 会话记住。选定的文稿关闭后工具会报错，不会换到别的文稿。
3. 读取 powerpoint_deck_info 和所需页面信息。页与形状引用使用工具返回的当前值；写回替换页面后使用返回的新页 ID。
4. 按需编辑；修改后读回，再用 powerpoint_render_slide 检查受影响页面。

工具参数以运行时 schema 为准。

## 文稿与页面工具

| 工具 | 用途与重要限制 |
|---|---|
| powerpoint_list_presentations | 列出已连接文稿和当前选择 |
| powerpoint_select_presentation | 选择后续操作的文稿 |
| powerpoint_deck_info | 读取页面、尺寸、母版和版式信息 |
| powerpoint_slide_outline | 读取文稿或单页的形状摘要 |
| powerpoint_list_slide_shapes | 读取形状引用和几何信息 |
| powerpoint_read_slide_text | 读取形状的文本及段落格式 |
| powerpoint_edit_slide_text | 修改形状内的段落 |
| powerpoint_find_and_replace | 批量替换文字，覆盖支持的备注范围 |
| powerpoint_duplicate_slide | 复制页面 |
| powerpoint_edit_slide_xml | 读取或修改单页 OOXML；调用 markDirty 后才替换页面 |
| powerpoint_edit_slide_master | 编辑首张页所属母版，只迁移该母版关联页，保留其他母版 |
| powerpoint_copy_image_between_slides | 跨页复制图片及其媒体关系 |
| powerpoint_insert_image | 插入 DSH 机器上的图片或图片字节 |
| powerpoint_execute_office_js | 执行可信异步 Office.js 代码 |
| powerpoint_verify_slides | 检查布局、边界与文字对比度；仍需结合渲染检查 |
| powerpoint_render_slide | 渲染页面并返回图片 |
| powerpoint_pane_visibility | 显示或隐藏任务窗格，保留运行时 |

## 图表与图标工具

| 工具 | 用途与重要限制 |
|---|---|
| powerpoint_create_slide_chart | 创建原生可编辑图表 |
| powerpoint_read_chart_style | 读取已有图表的样式 |
| powerpoint_edit_built_chart | 替换模板支持的图表内容，保留图表对象 |
| powerpoint_edit_slide_chart | 修改图表 OOXML |
| powerpoint_search_icons | 搜索公开图标服务，需要网络 |
| powerpoint_insert_icon | 插入搜索结果中的矢量图标 |

图表模板生成 chart XML 和数据缓存，不自动生成内嵌 XLSX。修改已有内嵌工作簿时仍受 workbook 验证器约束。

## 写入与渲染

超时、断线或失败后先读回文稿：修改可能已经生效，工具不会自动重试。powerpoint_execute_office_js 运行的是可信代码，能访问 Office 宿主的全部能力。

默认用 Office.js 渲染所选文稿。`renderBackend: com` 渲染的是 PowerPoint 当前激活的文稿：页数不一致时会报 presentation-mismatch，但页数相同并不代表是同一份文稿，渲染前要确认目标文稿处于激活状态。

隐藏保留文稿运行时；关闭加载项后，操作工具会报告任务窗格未连接，但已发现的工具仍保留。
