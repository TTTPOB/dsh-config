# 思源上传与同步工具

[siyuan-tools.mjs](<siyuan-tools.mjs>) 是小型 ESM 插件，只依赖 Node 内置 API 与 Host 的 tools 服务。笔记和资源读取继续使用已有 MCP。

## 配置

从[完整中性示例](<../examples/local-plugins-machine.yaml>)开始，在本机参数中设置：

```yaml
localPlugins:
  - id: siyuan-tools
    module: siyuan-tools.mjs
    modulePath: /path/to/harness-home/plugins/siyuan-tools.mjs
    config:
      self:
        baseURL: https://notes-self.example.invalid
        headersFile: /path/to/credentials/self-headers.json
      peer:
        baseURL: https://notes-peer.example.invalid
        headersFile: /path/to/credentials/peer-headers.json
      timeoutMs: 60000
      # Optional: overrides the default browser User-Agent and any value in headersFile.
      # userAgent: Mozilla/5.0 ...
```

- self 是当前默认思源实例；peer 是显式同步的对端。两个 baseURL 都必须提供，支持 HTTP(S) 和反向代理路径前缀，不接受 URL 内用户名、密码、query 或 fragment。
- headersFile 必须为绝对路径，直接引用执行机器已有的平铺 HTTP headers JSON（键和值都是字符串）。认证值和端点只保存在本机私有输入；不复制凭据、不做格式迁移。
- 凭据在每次工具调用时读取，支持已有文件原地换值。render/check/preview 和插件激活均不读取凭据。
- timeoutMs 默认 60000，为正整数毫秒；同时声明给 Host 的工具超时策略并用于 HTTP 请求期限。调用取消会传给 fetch；不自动重试。
- userAgent 默认浏览器 UA，适用于要求浏览器标识的 WAF；自定义值优先于凭据文件内任意大小写的 User-Agent。上传时移除已有 Content-Type，由 FormData 生成 boundary；同步设置 application/json。

## 三个工具

| 工具 | 参数 | 操作与结果 |
|---|---|---|
| siyuan_upload_asset | files：非空绝对路径列表 | 从 DSH 执行机器读取真实 bytes，向 self 的 /api/asset/upload 提交 multipart，包含 assetsDirPath=/assets/ 和多个 file[]；返回 assets 数组，每项为 file → assetPath。 |
| siyuan_sync_self | 空对象 | 向 self 的 /api/sync/performSync POST 空 JSON 对象。 |
| siyuan_sync_peer | 空对象 | 向 peer 的同一 API POST 空 JSON 对象。 |

上传路径必须在 **DSH 执行机器** 上可读，思源服务端无需能访问这些本地／WSL 路径。同批文件名必须各不相同，避免服务端按文件名返回的映射歧义；文件读取到内存后上传，适合少量附件，不用于大规模流式传输。

HTTP 非成功状态、无效 JSON、SiYuan code 非 0、上传 errFiles 或缺失映射都会明确失败。部分上传失败时可能已有附件写入，请先检查再决定是否手工重试；请求超时／取消也不能证明服务端没有执行。

同步结果仅报告 accepted: true 和“API 接受请求、未验证完成”。上传不触发同步，self 与 peer 不自动串联，不自动检查同步结束或监听 WebSocket。

## 加载与验证

三工具均带 deferLoading: true，使用 ctx.effect + ctx.tools.register 注册并在卸载时撤销。共用 progressive-tools 规则按顺序设置普通工具 eager、mcp__* 与 siyuan_* deferred；需要对应新版 progressive-tools 资产。

模块随 localPlugins 文件计划暂存和部署，见[安装指南](<../docs/install.md#本地-esm-插件>)。源文件更新后需要在维护窗口重新加载插件；不保证运行中 Host 或已有会话自动换版。

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test tests/siyuan-tools.test.mjs tests/local-plugins.test.mjs tests/deployment.test.mjs
DSH_CLI_PACKAGE=/path/to/installed/dsh/package.json node --test tests/siyuan-tools.test.mjs
```

测试仅用临时文件和 loopback mock HTTP；设置 DSH_CLI_PACKAGE 后还会用已安装 Cordis Loader 加载临时复制模块，验证作用域注册／卸载，不启动 Host、不调用模型或真实思源写接口。
