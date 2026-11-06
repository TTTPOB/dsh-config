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
| `office_run_js` | 执行异步函数体，使用 `return` 返回 JSON 数据 |
| `office_insert_image` | 读取 DSH 机器上的文件，或接收裸 base64，按 pt 插图 |
| `office_render_slide` | PowerPoint COM 渲染 PNG，直接返回原生图片附件 |
| `office_verify_layout` | 边界、空占位符和潜在重叠提示 |
| `office_pane_visibility` | `visible: false` 隐藏，`true` 恢复侧栏 |

默认首次文档调用自动隐藏侧栏；显式恢复显示后，本插件实例不会再次自动隐藏。隐藏不关闭 Office.js 运行时；不要点击侧栏 ×。实例重新加载后会重新执行一次自动隐藏。

模型通过 `skill` 工具加载 `ppt-officejs`，再进行“读页面 → 修改 → 渲染检查”。工具按需披露；所有文档操作在本插件实例内排队执行，避免多个 agent 同时改选中页。超时和异常不自动重试，修改可能已经部分完成，应先读取现状。

## 配置与限制

- `endpoint`：CDP HTTP(S) 地址；默认本地 9224。WebSocket 主机和端口使用该地址，支持端口转发。
- `targetUrl`：匹配 Office 页面的 URL 前缀；默认 Claude Office 侧栏站点。匹配零个或多个页面都报错，需要保持一个目标侧栏或收窄前缀。
- `timeoutMs`：每个工具及 CDP 请求超时，默认 90000。
- `autoHide`：首次文档调用自动隐藏，默认 `true`。
- `powershell`：本机 PowerShell 可执行文件，默认 `powershell.exe`。
- `renderWidth` / `renderHeight`：COM 导出像素尺寸，默认 1280 × 720。

CDP 能读写侧栏绑定的文档；渲染使用 COM 的 `ActivePresentation`。当前版本不处理多窗口，必须保持目标演示文稿为活动文档。远端只转发 CDP 不会同时转发 COM，不能宣称远端渲染已支持。

`office_run_js` 直接运行 Office 页面代码，不提供 Claude 的 SES 沙箱或 `insertImage`、`blobs`、`JSZip` 私有 helper。该插件具有本机文档控制权，只给可信 agent 使用；CDP 端口不要直接暴露到公网。

几何检查只是启发式提示，完整包含关系会被忽略；零告警不代表没有遮挡、文字溢出或视觉问题。当前没有封装 OOXML 图表、母版修改或图标检索专用工具。

## 本地打包

`node scripts/pack-office-cdp.mjs` 使用 pnpm 将单文件插件、bundle patch 和本说明打包到忽略的 `generated/office-cdp-package/`。这份 tarball 可独立保存；本仓库本机接入仍使用上面的 `localPlugins`，不需要安装额外 npm 依赖，也不发布 Release。
