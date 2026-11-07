# dsh-powerpoint：当前 PowerPoint 文档原生工具

`dsh-powerpoint` 通过 PowerPoint 加载项操作当前打开的演示文稿，提供 21 个 `powerpoint_*` 原生工具和 `powerpoint` skill。模型按需发现并直接调用具名工具，不需要预先加载全部工具说明；通用分派仅保留在插件内部。

## 接入与打包

插件源文件为 [powerpoint.mjs](powerpoint.mjs)。在机器私有配置中声明以下本地插件；`modulePath` 替换为目标 Harness home 下的路径：

```yaml
localPlugins:
  - id: powerpoint
    module: powerpoint.mjs
    modulePath: /path/to/harness-home/plugins/powerpoint.mjs
    config:
      backend: helper
      helperUrl: http://127.0.0.1:18766
      renderBackend: officejs
      autoHide: true
```

Windows helper 使用 `transport: addin` 时，由自有加载项主动建立 WebSocket 连接，不需要 Claude 登录、Claude 侧栏或 CDP。helper 的 `transport: cdp` 路径仍可用于连接调试侧栏。加载项必须加载完整客户端 runtime；工具执行仍由该 runtime 完成。

使用 `node scripts/dsh-config.mjs update --machine <机器名>` 预览同步，只有用户授权后才加 `--apply`。同步不负责启停 Host；运行中的 Host 未热加载插件时，由用户决定何时重启。

`node scripts/pack-powerpoint.mjs` 使用 pnpm 打包，产物为 `generated/powerpoint-package/dsh-powerpoint-0.1.0.tgz`。本机接入使用上述 `localPlugins`，目标插件文件为 `/path/to/harness-home/plugins/powerpoint.mjs`。

## 操作流程

1. 加载 `powerpoint` skill，读取 `powerpoint_deck_info` 和所需页面信息。
2. 按需发现目标工具并读取完整 schema；使用当前文档返回的页 ID、形状 ID 和版式信息。
3. 普通操作优先使用 Office.js。图表、备注或属性等 Office.js 覆盖不足的操作，使用对应客户端 OOXML 工具。
4. 修改后读回结果，再用 `powerpoint_render_slide` 渲染受影响页面并检查视觉效果。

PowerPoint 持有真实文档状态，不以模型记忆或预先生成的结构替代读回。同一插件实例内的文档操作排队执行；超时或异常不会自动重试，因为修改可能已部分完成，应先读取现状。

## 21 个原生工具

### 客户端工具（16 个）

原始客户端 Zod schema 负责完整参数校验、默认值及预处理；主插件投影出的原生 schema 只负责工具发现和初步校验。它保留字段、必填项、枚举和图表分支，将互斥 number/null 的 anyOf 改为 oneOf；长度、数值范围、正则等约束继续由客户端校验。投影随插件固化，不在每次调用时下载或解析源 bundle。具体参数以按需获取的工具 schema 为准。

| 工具 | 用途与范围 |
|---|---|
| `powerpoint_list_slide_shapes` | 读取形状引用、名称、类型和几何信息；正文用 `powerpoint_read_slide_text` 读取 |
| `powerpoint_create_slide_chart` | 创建图表 |
| `powerpoint_read_chart_style` | 读取图表样式 |
| `powerpoint_edit_built_chart` | 修改已构建图表 |
| `powerpoint_edit_slide_chart` | 修改页面图表的 OOXML |
| `powerpoint_edit_slide_master` | 编辑首张页所属母版；只迁移该母版关联页，保留其他母版 |
| `powerpoint_edit_slide_xml` | 读取或修改单页 OOXML；显式标记修改后才替换页面 |
| `powerpoint_duplicate_slide` | 复制页面 |
| `powerpoint_verify_slides` | 检查页面几何布局，提供启发式提示 |
| `powerpoint_read_slide_text` | 读取页面文本及段落结构 |
| `powerpoint_edit_slide_text` | 编辑页面文本及段落 |
| `powerpoint_find_and_replace` | 查找替换，包括工具支持的备注范围 |
| `powerpoint_search_icons` | 通过 helper 同源代理搜索公开图标服务 |
| `powerpoint_insert_icon` | 插入公开图标服务提供的图标 |
| `powerpoint_copy_image_between_slides` | 跨页复制图片 |
| `powerpoint_execute_office_js` | 执行可信异步 Office.js 代码 |

### 独立本机工具（5 个）

| 工具 | 用途与范围 |
|---|---|
| `powerpoint_deck_info` | 读取页数、尺寸、页 ID、母版及版式信息 |
| `powerpoint_slide_outline` | 读取全稿或单页形状摘要；每个形状文本截取前 200 字符 |
| `powerpoint_insert_image` | 从 DSH 机器路径或裸 base64 插图；坐标单位为 pt |
| `powerpoint_render_slide` | 渲染当前文档页面，返回图片附件 |
| `powerpoint_pane_visibility` | 隐藏或显示加载项侧栏，保留隐藏侧栏的运行时 |

## 配置

| 字段 | 说明 |
|---|---|
| `backend` | `cdp`（默认）直连 CDP；`helper` 将文档操作发给 Windows helper |
| `endpoint` | CDP HTTP(S) 地址；默认 `http://127.0.0.1:9224`，可经端口转发连接 |
| `helperUrl` | helper 地址；默认 `http://127.0.0.1:18766` |
| `helperToken` | 非空时发送 Bearer 鉴权；默认空，可由 SSH 隧道提供访问控制 |
| `targetUrl` | CDP 页面 URL 匹配前缀；需要唯一匹配，零个或多个匹配均报错 |
| `timeoutMs` | 工具和请求超时，默认 90000 毫秒 |
| `autoHide` | 首次文档调用自动隐藏侧栏，默认 `true` |
| `powershell` | 本机 CDP 后端使用的 PowerShell，默认 `powershell.exe` |
| `renderBackend` | 默认 `officejs`；备用 COM 必须显式配置为 `com` |
| `renderWidth` / `renderHeight` | 默认 1280 × 720；Office.js 按宽度保持页面比例，COM 使用两项尺寸 |

默认渲染调用当前加载项绑定文档的 `getImageAsBase64`，不依赖 COM。备用 COM 由本机 PowerShell或 Windows helper 执行，要求预期文档处于活动状态；导出前比对 `ActivePresentation` 页数，不一致时报 `presentation-mismatch`。页数相同本身不足以证明文档身份，使用者仍应确认活动文档。

显式显示侧栏后，本插件实例不再自动隐藏；实例重新加载后重新进行首次自动隐藏。自有加载项的 long shared runtime 可按文档设置 `startupLoad`，不能据此保证全新文档静默自动启动。关闭调试侧栏可能销毁其运行时；隐藏与关闭不同。

## 使用边界

- `powerpoint_edit_slide_xml` 只读且不调用 `markDirty()` 时不替换页面。修改写回返回的 `slide_id_update` 是后续操作必须采用的新页 ID；写回失败或超时后先重新读取文档。
- `powerpoint_edit_slide_master` 仅针对首张页所属母版，不接受“任意母版编辑”的能力假设；只迁移该母版关联页，并保留其他母版。
- `powerpoint_execute_office_js` 以可信 `AsyncFunction` 执行代码，不提供 SES 沙箱、Claude blobs、Conductor 或模型 reviewer。仅允许可信 agent 使用，不向公网直接开放文档控制端口。
- 图表模板生成的是 chart XML 和缓存，不自动生成 XLSX。已有内嵌工作簿的修改仍受客户端 workbook 验证器约束。
- 图标依赖 helper 同源代理和公开服务网络连接，不是离线图标库。
- `powerpoint_insert_image` 的 `filePath` 指 DSH 机器路径，不是 Windows helper 路径；也可使用裸 base64。省略高度时保持图片比例。
- `powerpoint_verify_slides` 是几何启发式检查，不提供模型视觉审阅；某些有意布局也可能触发提示，零告警不能证明没有遮挡、文字溢出或其他视觉问题。必须结合真实渲染检查。
