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
3. **控制 SDK 体积。** 按 e2db647 实测（43 个工具全部直接声明），SDK 比改动前（4f1b55c）多约 4.9K 字符，每次请求都会带上。其中 21 个输出类型相对通用 JSON 多约 5.4K（目标 4.5K），缩短描述等改动抵掉了一部分。这些数字会随后续修改变化。再删就要删掉替换位置、跳过原因、图表样式等模型实际要读的字段，所以接受这个超出。
4. **`duplicate_slide` 返回 `new_slide_id`。** 插件在同一个串行队列里比较复制前后的页 ID。恰好多出一个时返回它；多出零个或几个，或者复制成功后读回失败，就原样返回、不抛错，避免模型再复制一次。读回有单独的短时限，不会让已完成的复制变成工具超时。
5. **`describe_tools` 对直接声明的工具给出明确提示**（dsh-progressive-tools），告诉模型直接调用该工具，而不是报未知工具。
6. **定位页面的工具同时接受页 ID 和一基页码。** `powerpoint_render_slide`、`powerpoint_insert_image`、`powerpoint_slide_outline` 接受 `slide_id` 或 `slide_index`；`powerpoint_verify_slides` 接受一基闭区间或 `slide_ids`，插件把它换算成 helper 的零基区间，只调用一次，再按 ID 过滤结果。两种定位方式出错的情况不同：OOXML 写回会把编辑后的页插到原页位置并删除原页，页码不变、ID 改变；增删或移动页面则相反。在这四个工具里按 ID 定位时，旧 ID 会直接报错（其余目录工具收到旧 ID 时，由 helper 按它记录的旧→新映射处理）；按页码定位时，页码错了会悄悄指到另一页。所以两种都保留，由模型按场景选择。计数规则只有一条：界面上显示编号的东西（幻灯片、Word 页面）从 1 开始，其他序号（模型自己传入的数组下标、`chart_index`、Word 段落序号、Office.js 集合）和 JavaScript 一样从 0 开始。Office.js 本身从 0 开始，无法做到全部一基；全部一基反而会让数组下标和传给 Office.js 的段落序号差一位。其余目录工具仍只接受 ID。插件自有工具和插件定义参数的工具会拒绝未声明的参数名，避免写错参数名时悄悄扩大到整份文稿。插件不维护旧 ID 到新 ID 的自动映射，模型使用写回结果里的 `slide_id_update`。
7. **不在 Harness 侧改为 fail-loud。** 让 `register()` 拒绝子集外的参数 schema 需要改上游，这次不做；本仓库的测试在设置 `DSH_CLI_PACKAGE` 时，用 Harness 的实际渲染器检查两个执行工具和四个定位工具的参数类型，并用 Harness 的输出校验器检查目录工具的返回样本。

## 考虑过的替代方案

- **在插件里把任意 JSON Schema 自动降级到子集**：社区有只处理 MCP 的 normalizer 插件。我们的工具数量少，schema 是手写的，直接写在子集内更简单，也不会悄悄丢掉约束。
- **只在 skill 里写返回结构，不声明返回值类型**：Native 模式不会把输出 schema 发给模型，skill 仍然需要速查表；但 PTC 模式下类型直接出现在 SDK 里，比 skill 更可靠。两者都做。
- **zotero-mcp 的先例**：那里曾认为 outputSchema 在 DSH 中没有效果（Native 不发送；Pydantic 生成的 `$ref`/`anyOf` 在 PTC 里会降级），因此搁置。本次情况不同：会话是 PTC，schema 是手写的子集，且有真实失败可以消除。

## 后果

- helper 改变已知工具的返回结构时，插件的输出 schema 要同步，否则 Harness 的输出校验会拒绝真实结果。`tests/office-catalog-output.test.mjs` 用样本覆盖这一点，但只在设置 `DSH_CLI_PACKAGE` 时运行。
- Harness 的子集不能表达带值类型的映射、递归和复用（没有 `$ref`）。这些信息只能写在 description 里。

## 未决事项

- 会话查询工具没有从尾部读取的方式，模型为读最近内容从头翻页了 99 次。
- Word skill 暂时保持在 ops 私有仓库，由 helper 下发。原 prompt 由提取器在本地生成，不提交；私有 skill 已大部分改写，但仍有少量原句。等 Word 经验积累更多后，再决定是否全部改写成我们自己的文字并搬进 dsh-config 公开。用 diff 渲染的方案不采用：diff 的上下文行仍是原文，原插件更新后补丁也会失效。
