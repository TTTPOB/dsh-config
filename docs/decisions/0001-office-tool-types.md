# 0001 Office 工具的参数与返回值类型

状态：已采纳（2026-11-27）

## 背景

PTC 模式下，Harness 把每个工具的输入和输出 JSON Schema 渲染成 SDK 里的 TypeScript 声明。Harness 只支持一个子集：`type`、`oneOf`、`properties`、`required`、`additionalProperties`（只能是布尔值）、`items`、`enum`、`const`，以及 `description`、`title`、`default`、`examples`。参数 schema 超出子集时不会报错，只会在 SDK 里渲染成 `unknown`；输出 schema 超出子集则在注册时抛错，因为 `register()`（`packages/core/tools/src/index.ts`）只校验输出 schema。

一次 LLab3 上的 PowerPoint 会话暴露了两类问题：

- `powerpoint_execute_office_js` 的 `files` 用了 `propertyNames` 和对象形式的 `additionalProperties`，整个参数在 SDK 里成了 `unknown`。模型随后调用 `describe_tools` 想查 schema，却因为 Office 工具是直接声明（eager）的，不在延迟目录里，收到了“unknown or unavailable tool”。
- 目录工具的返回值统一声明为通用 JSON，模型只能猜字段：`verify_slides` 的数据在 `.result.slides`、`list_slide_shapes` 的 `.result` 是数组、`slide_id_update` 是旧 ID 到新 ID 的映射，这几处都猜错过；`duplicate_slide` 不返回新页 ID，模型每次复制后都要再读一次 `deck_info`。

上游讨论区有同类报告（#4916、#8817、#6876、#9875），都没有维护者回复。上游 0.2.3-alpha.2 的子集没有变化。

## 决定

1. **参数 schema 留在子集内。** `files` 写成 `{ type: 'object', additionalProperties: true }`，值的类型（DSH 机器上的绝对路径）写在 description 里；运行时校验键名和路径。Word 的 `word_execute_office_js` 直接返回代码的返回值，不再套 `{ success, result }`，与 PowerPoint 一致；ops 仓库里 helper 下发的 Word skill 同步修改。两端在未传 `files` 时都绑定空对象。
2. **为已知目录工具手写返回值 schema。** PowerPoint 15 个、Word 6 个，外层保持 helper 的 `{ success: true, ... }`：有数据的工具放在 `result` 下，`slide_id_update`、`new_slide_id` 等元数据与 `success` 同级，部分工具没有 `result`。helper 新增而插件不认识的工具仍用通用 JSON。只声明模型读回和判断时需要的字段，其余字段用开放对象放行。Word 目录工具报告 `success: false` 时，插件抛出工具错误。
3. **控制 SDK 体积。** 21 个输出类型相对通用 JSON 净增约 5.2K 字符（目标 4.5K）；连同两个执行工具修正后的参数和描述，SDK 比改动前共增加约 6.4K 字符，而且每次请求都会带上。再删就要删掉替换位置、跳过原因、图表样式等模型实际要读的字段，所以接受这个超出。
4. **`duplicate_slide` 返回 `new_slide_id`。** 插件在同一个串行队列里比较复制前后的页 ID。恰好多出一个时返回它；多出零个或几个，或者复制成功后读回失败，就原样返回、不抛错，避免模型再复制一次。读回有单独的短时限，不会让已完成的复制变成工具超时。
5. **`describe_tools` 对直接声明的工具给出明确提示**（dsh-progressive-tools），告诉模型直接调用该工具，而不是报未知工具。
6. **定位页面的工具同时接受页 ID 和一基页码。** `powerpoint_render_slide`、`powerpoint_insert_image`、`powerpoint_slide_outline` 接受 `slide_id` 或 `slide_index`；`powerpoint_verify_slides` 接受一基闭区间或 `slide_ids`，插件把它换算成 helper 的零基区间，只调用一次，再按 ID 过滤结果。两种定位方式出错的情况不同：OOXML 写回会把编辑后的页插到原页位置并删除原页，页码不变、ID 改变；增删或移动页面则相反。按 ID 定位时，旧 ID 会直接报错；按页码定位时，页码错了会悄悄指到另一页。所以两种都保留，由模型按场景选择。其余目录工具仍只接受 ID。插件不维护旧 ID 到新 ID 的自动映射，模型使用写回结果里的 `slide_id_update`。
7. **不在 Harness 侧改为 fail-loud。** 让 `register()` 拒绝子集外的参数 schema 需要改上游，这次不做；本仓库的测试在设置 `DSH_CLI_PACKAGE` 时，用 Harness 的实际渲染器检查两个执行工具的参数类型和目录工具的输出 schema。

## 考虑过的替代方案

- **在插件里把任意 JSON Schema 自动降级到子集**：社区有只处理 MCP 的 normalizer 插件。我们的工具数量少，schema 是手写的，直接写在子集内更简单，也不会悄悄丢掉约束。
- **只在 skill 里写返回结构，不声明返回值类型**：Native 模式不会把输出 schema 发给模型，skill 仍然需要速查表；但 PTC 模式下类型直接出现在 SDK 里，比 skill 更可靠。两者都做。
- **zotero-mcp 的先例**：那里曾认为 outputSchema 在 DSH 中没有效果（Native 不发送；Pydantic 生成的 `$ref`/`anyOf` 在 PTC 里会降级），因此搁置。本次情况不同：会话是 PTC，schema 是手写的子集，且有真实失败可以消除。

## 后果

- helper 改变已知工具的返回结构时，插件的输出 schema 要同步，否则 Harness 的输出校验会拒绝真实结果。`tests/office-catalog-output.test.mjs` 用样本覆盖这一点，但只在设置 `DSH_CLI_PACKAGE` 时运行。
- Harness 的子集不能表达带值类型的映射、递归和复用（没有 `$ref`）。这些信息只能写在 description 里。

## 未决事项

- 会话查询工具没有从尾部读取的方式，模型为读最近内容从头翻页了 99 次。
- Word skill 中我们自己总结的内容目前只能写进私有文件；是否拆成公开和私有两份。
