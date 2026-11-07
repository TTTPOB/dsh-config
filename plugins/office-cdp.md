# Office CDP 原生工具

此本地插件通过已打开的 PowerPoint Office 侧栏执行 Office.js，不使用 Claude 模型或 agent loop。插件无第三方运行时依赖，并内置 `ppt-officejs` skill provider；手册使用原生工具名，不需要命令行脚本。

## 接入

在机器私有配置的 `localPlugins` 中声明，目标路径替换为本机 Harness home 下的文件路径：

```yaml
localPlugins:
  - id: office-cdp
    module: office-cdp.mjs
    modulePath: /path/to/harness-home/plugins/office-cdp.mjs
    config:
      endpoint: http://127.0.0.1:9224
      autoHide: true
```

先执行 `node scripts/dsh-config.mjs update --machine <机器名>` 预览，再加 `--apply` 同步。应用通过既有本地插件同步流程写入源文件和配置，不启停 Host。如果运行中的 Host 没有热加载该行，由用户重启。

## 使用

| 工具 | 用途 |
|---|---|
| `office_deck_info` | 文档页数、尺寸、母版和版式 ID |
| `office_slide_outline` | 全文档或单页形状摘要，文本截至 200 字符 |
| `office_slide_shapes` | 单页完整文本及几何信息 |
| `office_run_js` | 执行异步 Office.js 函数体，使用 `return` 返回 JSON 数据 |
| `office_run_ooxml` | 单页 ZIP 读写，显式 `markDirty()` 后才替换页面 |
| `office_client_catalog` | 查看自有加载项实际加载的客户端工具和参数 |
| `office_client_tool` | 按原客户端工具名调用已提取的执行实现 |
| `office_insert_image` | 读取 DSH 机器上的文件，或接收裸 base64，按 pt 插图 |
| `office_render_slide` | 默认 Office.js 渲染 PNG，直接返回原生图片附件；可显式选 COM |
| `office_verify_layout` | 边界、空占位符和潜在重叠提示 |
| `office_pane_visibility` | `visible: false` 隐藏，`true` 恢复侧栏 |

默认首次文档调用自动隐藏侧栏；显式恢复显示后，本插件实例不会再次自动隐藏。隐藏保留运行时。自有加载项使用 long shared runtime，可按文档显式设置自动启动；借用的旧 CDP 侧栏关闭后可能销毁运行时。实例重新加载后会重新执行一次自动隐藏。

模型通过 `skill` 工具加载 `ppt-officejs`，再进行“读页面 → 修改 → 渲染检查”。工具按需披露；所有文档操作在本插件实例内排队执行，避免多个 agent 同时改选中页。超时和异常不自动重试，修改可能已经部分完成，应先读取现状。

## 配置与限制

- `backend`：`cdp`（默认）在本机直连 CDP 并用本机 PowerShell 渲染；`helper` 把所有文档操作发给 Windows helper，远端只需一个端口。
- `endpoint`：CDP HTTP(S) 地址；默认本地 9224。WebSocket 主机和端口使用该地址，支持端口转发。
- `helperUrl`：`backend: helper` 时的 helper 地址，默认 `http://127.0.0.1:18766`。
- `helperToken`：非空时以 `Authorization: Bearer` 发送；默认空，依赖 SSH 隧道鉴权。
- `targetUrl`：匹配 Office 页面的 URL 前缀；默认 Claude Office 侧栏站点。匹配零个或多个页面都报错，需要保持一个目标侧栏或收窄前缀。
- `timeoutMs`：每个工具及请求超时，默认 90000。
- `autoHide`：首次文档调用自动隐藏，默认 `true`。
- `powershell`：`backend: cdp` 时使用的本机 PowerShell，默认 `powershell.exe`。
- `renderBackend`：默认 `officejs`，对侧栏绑定的当前文档调用 `getImageAsBase64`；旧宿主可显式改为 `com`。
- `renderWidth` / `renderHeight`：默认 1280 × 720。Office.js 使用宽度并保持原页比例；COM 使用两项尺寸。

默认渲染使用当前文档的 Office.js，不需要 COM 或 Windows 文件路径。显式使用 `renderBackend: com` 时，导出前比对 `ActivePresentation` 的页数，不一致时报 `presentation-mismatch`；这一备用模式在 `backend: cdp` 下需要 DSH 机器能调用 PowerShell，远端则由 helper 执行。

`backend: helper` 时远端只连接 Windows helper。helper 的 `transport: addin` 使用自有加载项主动发起的 WebSocket，不需要 Claude 侧栏、登录或 CDP；旧 `transport: cdp` 仍可借用调试侧栏。文档状态始终由 PowerPoint 持有，COM 仅用于当前渲染接口；打开文档或重新加载侧栏无需重启 helper。

`office_run_js` 直接运行 Office 页面代码，不提供 Claude 的 SES 沙箱或 `insertImage`、`blobs`、`JSZip` 私有 helper。该插件具有本机文档控制权，只给可信 agent 使用；CDP 端口不要直接暴露到公网。

几何检查只是启发式提示，完整包含关系会被忽略；零告警不代表没有遮挡、文字溢出或视觉问题。客户端执行能力以 `office_client_catalog` 为准：自有加载项必须加载相应提取模块才能使用；只有八个基础 Office.js 工具的旧加载项会明确报客户端运行时未加载，不会静默改用薄封装。OOXML 写回的 `slide_id_update` 必须用于后续操作，出错后应先读当前文档，不盲目重试。

## 客户端执行能力

自有加载项加载当前 bundle 提取的 15 个本地业务 handler：形状、单页 XML、母版、图表创建／读取样式／替换／原始 XML、文字段落读写、批量替换含备注、复制页、跨页图片复制、几何检查及图标搜索／插入。原输入 schema、默认值和预处理保留；调用前按原 schema 校验。

`office_client_catalog` 默认只返回摘要，传 `name` 获取单项完整 schema。`office_client_tool` 接受原工具名和 `arguments`。单页 JavaScript 操作可直接用 `office_run_ooxml`，只读不调用 `markDirty()`；修改后必须读取 `slide_id_update`。母版工具按原实现针对第 1 页所属母版，保留条件迁移与清理，不是任意母版 ID 编辑器。

原 `verify_slide_visual` 需要模型 reviewer，原 `export_deck_outline` 向 Conductor 广播；两者在离线客户端中明确不可用，分别使用 DSH 自身看图与本地摘要能力替代。通用代码编译明确改为可信 AsyncFunction，未搬 SES、Claude Files blobs、Conductor、产品权限 UI 或模型 loop。图表模板生成 chart XML 和缓存；已有内嵌 XLSX 修改保留原始 workbook 验证器，不等于模板自动生成 Excel 工作簿。

图标客户端通过 helper 的同源代理请求原公开图标服务，仍依赖网络；不把接口数据缓存当作本地自有图标库。完整源提取与生成入口归属于 Windows helper 的 extraction 目录，插件自身不在每次调用时下载或解析 bundle。

## 本地打包

`node scripts/pack-office-cdp.mjs` 使用 pnpm 将单文件插件、bundle patch 和本说明打包到忽略的 `generated/office-cdp-package/`。这份 tarball 可独立保存；本仓库本机接入仍使用上面的 `localPlugins`，不需要安装额外 npm 依赖，也不发布 Release。
