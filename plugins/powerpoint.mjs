// Generated from plugins-src/powerpoint; run pnpm build:powerpoint. Do not edit directly.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
//#region plugins-src/powerpoint/src/config.ts
var name = "dsh-powerpoint";
var Config = { "~standard": {
	version: 1,
	vendor: name,
	validate(input) {
		const value = {
			catalogRefreshMs: 3e5,
			catalogRetryInitialMs: 1e3,
			catalogRetryMaxMs: 3e4,
			helperUrl: "http://127.0.0.1:18766",
			helperToken: "",
			timeoutMs: 9e4,
			renderBackend: "officejs",
			renderWidth: 1280,
			renderHeight: 720,
			autoHide: true,
			...input
		};
		const issues = [];
		for (const key of [
			"catalogRefreshMs",
			"catalogRetryInitialMs",
			"catalogRetryMaxMs"
		]) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) issues.push({
			message: key + " must be a positive integer",
			path: [key]
		});
		if (value.catalogRetryMaxMs < value.catalogRetryInitialMs) issues.push({
			message: "catalogRetryMaxMs must be at least catalogRetryInitialMs",
			path: ["catalogRetryMaxMs"]
		});
		for (const key of [
			"backend",
			"endpoint",
			"targetUrl",
			"powershell"
		]) if (key in input) issues.push({
			message: key + " is no longer supported; use helperUrl",
			path: [key]
		});
		if (!["officejs", "com"].includes(value.renderBackend)) issues.push({
			message: "renderBackend must be officejs or com",
			path: ["renderBackend"]
		});
		if (typeof value.helperToken !== "string") issues.push({
			message: "helperToken must be a string",
			path: ["helperToken"]
		});
		for (const key of ["helperUrl"]) try {
			if (!["http:", "https:"].includes(new URL(value[key]).protocol)) throw new Error("protocol");
		} catch (error) {
			issues.push({
				message: key + " must be an HTTP(S) URL",
				path: [key]
			});
		}
		for (const key of [
			"timeoutMs",
			"renderWidth",
			"renderHeight"
		]) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) issues.push({
			message: key + " must be a positive integer",
			path: [key]
		});
		if (typeof value.autoHide !== "boolean") issues.push({
			message: "autoHide must be boolean",
			path: ["autoHide"]
		});
		return issues.length ? { issues } : { value };
	}
} };
//#endregion
//#region plugins-src/powerpoint/src/files.ts
/** Read binary inputs privately and expose only base64 inside the taskpane code. */
async function officeArgs(args, signal) {
	const files = Object.create(null);
	if (args.files !== void 0 && (!args.files || typeof args.files !== "object" || Array.isArray(args.files))) throw new Error("files must map identifiers to absolute file paths on the DSH machine");
	for (const [key, filePath] of Object.entries(args.files ?? {})) {
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) throw new Error("Invalid files identifier: " + key);
		if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new Error("files." + key + " must be an absolute file path on the DSH machine");
		try {
			files[key] = (await readFile(filePath, { signal })).toString("base64");
		} catch (error) {
			throw new Error("Cannot read files." + key + " (" + filePath + "): " + error.message, { cause: error });
		}
	}
	return { code: "const files = JSON.parse(" + JSON.stringify(JSON.stringify(files)) + ");\n" + args.code };
}
//#endregion
//#region plugins-src/powerpoint/src/transport.ts
function helperSignal(config, signal) {
	const deadline = AbortSignal.timeout(config.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	combined.throwIfAborted();
	return combined;
}
async function helperRequest(config, route, body, signal, binary = false) {
	const headers = { "content-type": "application/json" };
	if (config.helperToken) headers.authorization = "Bearer " + config.helperToken;
	const response = await fetch(new URL(route, config.helperUrl), {
		method: body === void 0 ? "GET" : "POST",
		headers,
		...body === void 0 ? {} : { body: JSON.stringify(body) },
		signal: helperSignal(config, signal)
	}).catch((error) => {
		throw new Error("PowerPoint helper not connected: " + String(error), { cause: error });
	});
	if (!response.ok) {
		let detail = null;
		try {
			detail = (await response.json()).error;
		} catch {
			detail = null;
		}
		throw paneError(detail ?? {
			code: "HTTP " + response.status,
			message: "request failed"
		});
	}
	return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
/** Keep presentation-selection errors actionable without discarding the helper's pane list. */
function paneError(detail) {
	const selection = [
		"target-not-found",
		"multiple-panes",
		"taskpane-not-open"
	].includes(detail.code);
	return /* @__PURE__ */ new Error("dsh-powerpoint helper " + detail.code + ": " + detail.message + (detail.panes ? " Panes: " + JSON.stringify(detail.panes) : "") + (selection ? " Call powerpoint_list_presentations, then powerpoint_select_presentation with a pane sessionId." : ""));
}
/** Evaluate once; never retry writes whose completion is unknown. */
async function evaluate(config, expression, signal, target) {
	return (await helperRequest(config, "/eval", {
		code: expression,
		...target === void 0 ? {} : { target }
	}, signal)).value ?? null;
}
//#endregion
//#region plugins-src/powerpoint/src/expressions.ts
var helpers = `
async function slides(ctx) {
  const collection = ctx.presentation.slides;
  collection.load('items/id'); await ctx.sync(); return collection.items;
}
function at(items, index) {
  if (!Number.isInteger(index) || index < 1 || index > items.length) throw new Error('Slide index outside 1..' + items.length);
  return items[index - 1];
}
async function rows(ctx, slide) {
  slide.shapes.load('items/id,items/name,items/type,items/left,items/top,items/width,items/height');
  await ctx.sync();
  const pairs = slide.shapes.items.map(shape => ({ shape, frame: shape.getTextFrameOrNullObject() }));
  for (const { frame } of pairs) frame.load('isNullObject');
  await ctx.sync();
  for (const { frame } of pairs) if (!frame.isNullObject) frame.load('textRange/text');
  await ctx.sync();
  return pairs.map(({shape: s, frame: f}) => ({id:s.id,name:s.name,type:String(s.type),left:s.left,top:s.top,width:s.width,height:s.height,text:f.isNullObject ? '' : f.textRange.text}));
}
`;
var office = (body) => "(async () => {" + helpers + "; return await PowerPoint.run(async ctx => {" + body + "});})()";
/** Read deck metadata without COM or local file paths. */
function infoExpression() {
	return office(`const items = await slides(ctx);
    const page = ctx.presentation.pageSetup; page.load('slideWidth,slideHeight');
    const masters = ctx.presentation.slideMasters; masters.load('items/id'); await ctx.sync();
    for (const master of masters.items) master.layouts.load('items/id,items/name'); await ctx.sync();
    return { slideCount: items.length, slideIds: items.map(s=>s.id), page: {widthPt:page.slideWidth,heightPt:page.slideHeight},
      masters: masters.items.map(m=>({id:m.id,layouts:m.layouts.items.map(l=>({id:l.id,name:l.name}))})) };`);
}
/** Build one-slide or whole-deck summaries. Indices are one-based. */
function outlineExpression(slide, compact = false) {
	return office(`const items = await slides(ctx); const index = ${JSON.stringify(slide ?? null)};
    const selected = index === null ? items.map((s,i)=>({s,i:i+1})) : [{s:at(items,index),i:index}];
    const result=[]; for (const {s,i} of selected) { const shapes=await rows(ctx,s);
      result.push({slide:i,id:s.id,shapes:${compact ? "shapes.map(s=>({...s,text:s.text.slice(0,200)}))" : "shapes"}}); } return result;`);
}
/** Deck size, used to refuse rendering a different PowerPoint window. */
function deckSizeExpression(slide) {
	return office(`const items = await slides(ctx); at(items, ${JSON.stringify(slide)}); return {slideCount: items.length};`);
}
/** Encode the public Office image insertion API; send bytes through the selected backend. */
function imageExpression(slide, base64, placement) {
	return "(async () => {" + helpers + `
    await PowerPoint.run(async ctx=>at(await slides(ctx),${slide}));
    await new Promise((resolve,reject)=>Office.context.document.goToByIdAsync(${slide},Office.GoToType.Index,r=>r.error?reject(new Error(r.error.message)):resolve()));
    await new Promise((resolve,reject)=>Office.context.document.setSelectedDataAsync(${JSON.stringify(base64)},${JSON.stringify({
		coercionType: "image",
		...placement
	})},r=>r.error?reject(new Error(r.error.message)):resolve()));
    return {slide:${slide},inserted:true}; })()`;
}
/** Build a dispatch request without interpreting model-supplied argument strings as code. */
function clientCallExpression(name, args = {}) {
	return "(async()=>{if(!globalThis.OfficeClientRuntime) throw new Error(\"Client execution runtime is not loaded. Open the independent Office Helper add-in.\");return await globalThis.OfficeClientRuntime.execute(" + JSON.stringify(name) + "," + JSON.stringify(args) + ");})()";
}
//#endregion
//#region plugins-src/powerpoint/src/render.ts
var PNG_MAGIC = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
/** Render the taskpane-bound slide through Office.js, or opt into the COM transport. */
async function renderSlide(config, slide, options = {}) {
	if (!Number.isSafeInteger(slide) || slide < 1) throw new Error("slide must be a positive integer");
	if (config.renderBackend === "officejs") {
		const encoded = await evaluate(config, office("const items=await slides(ctx);const slide=at(items," + JSON.stringify(slide) + ");if(typeof slide.getImageAsBase64!==\"function\") throw new Error(\"This Office runtime does not support slide images; select renderBackend: com.\");const image=slide.getImageAsBase64({width:" + config.renderWidth + "});await ctx.sync();return image.value;"), options.signal, options.target);
		const bytes = Buffer.from(encoded, "base64");
		if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("Office.js did not return a PNG");
		return bytes;
	}
	const expected = Number(options.expectSlides ?? 0);
	const bytes = await helperRequest(config, "/render", {
		slide,
		width: config.renderWidth,
		height: config.renderHeight,
		expectSlides: expected,
		...options.target === void 0 ? {} : { target: options.target }
	}, options.signal, true);
	if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("dsh-powerpoint helper did not return a PNG");
	return bytes;
}
//#endregion
//#region plugins-src/shared/catalog.ts
/** Validate the helper response before preparing any registry changes. */
function parseCatalog(value, host) {
	const catalog = value;
	if (!catalog || catalog.host !== host || !/^[a-f0-9]{64}$/.test(catalog.revision) || !/^[a-f0-9]{64}$/.test(catalog.source?.bundleSha256) || !Array.isArray(catalog.tools)) throw new Error(host + " helper returned an invalid catalog");
	if (catalog.skill !== void 0 && (!catalog.skill || catalog.skill.name !== "word" || host !== "Word" || typeof catalog.skill.description !== "string" || typeof catalog.skill.content !== "string")) throw new Error(host + " helper returned an invalid catalog skill");
	const names = /* @__PURE__ */ new Set();
	for (const tool of catalog.tools) {
		if (!tool || typeof tool.clientName !== "string" || !/^[A-Za-z0-9_-]+$/.test(tool.clientName) || names.has(tool.clientName) || typeof tool.description !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== "object") throw new Error(host + " helper returned an invalid or duplicate catalog tool");
		names.add(tool.clientName);
	}
	return catalog;
}
/** Fetch first, then swap a complete prepared generation; offline helpers retain their tools. */
function startCatalog(ctx, host, policy, fetchCatalog, prepare) {
	const controller = new AbortController();
	let timer;
	let disposers = [];
	let revision;
	let current;
	let retryMs = policy.catalogRetryInitialMs;
	let pending;
	const schedule = (delay) => {
		if (controller.signal.aborted) return;
		timer = setTimeout(() => {
			timer = void 0;
			refresh();
		}, delay);
		timer.unref();
	};
	const refresh = () => {
		if (controller.signal.aborted) return Promise.resolve();
		if (pending) return pending;
		if (timer) clearTimeout(timer);
		timer = void 0;
		pending = (async () => {
			try {
				const catalog = parseCatalog(await fetchCatalog(controller.signal), host);
				if (controller.signal.aborted) return;
				if (catalog.revision !== revision) {
					const next = prepare(catalog.tools);
					if (new Set(next.map((tool) => tool.name)).size !== next.length) throw new Error(host + " catalog maps multiple tools to the same public name");
					for (const dispose of disposers) dispose();
					disposers = [];
					revision = void 0;
					try {
						for (const definition of next) disposers.push(ctx.tools.register(definition));
					} catch (error) {
						for (const dispose of disposers) dispose();
						disposers = [];
						throw error;
					}
					revision = catalog.revision;
					current = catalog;
				}
				retryMs = policy.catalogRetryInitialMs;
				schedule(policy.catalogRefreshMs);
			} catch (error) {
				if (controller.signal.aborted) return;
				ctx.logger?.warn(host + " helper catalog refresh failed; retrying: " + String(error));
				schedule(retryMs);
				retryMs = Math.min(retryMs * 2, policy.catalogRetryMaxMs);
			}
		})().finally(() => {
			pending = void 0;
		});
		return pending;
	};
	ctx.effect(() => () => {
		controller.abort();
		if (timer) clearTimeout(timer);
		for (const dispose of disposers) dispose();
		disposers = [];
	});
	return {
		ready: refresh(),
		refresh,
		current: () => current
	};
}
//#endregion
//#region plugins-src/shared/catalog-schema.ts
var keywords = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"examples"
]);
/** Retain DSH-supported keywords and convert disjoint scalar unions without weakening them. */
function normalizeSchema(input, describe) {
	const output = {};
	for (const [key, value] of Object.entries(input)) if (key === "anyOf") {
		const branches = value;
		const types = branches.map((branch) => branch.type);
		if (types.some((type) => ![
			"string",
			"number",
			"boolean",
			"null"
		].includes(type ?? "")) || new Set(types).size !== types.length) throw new Error("Office catalog anyOf cannot be converted to disjoint oneOf");
		output.oneOf = branches.map((branch) => normalizeSchema(branch, describe));
	} else if (!keywords.has(key)) continue;
	else if (key === "properties") output.properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, normalizeSchema(schema, describe)]));
	else if (key === "oneOf") output.oneOf = value.map((schema) => normalizeSchema(schema, describe));
	else if (key === "items") output.items = normalizeSchema(value, describe);
	else if (key === "additionalProperties" && typeof value !== "boolean") throw new Error("Office catalog schema-valued additionalProperties is not supported by DSH");
	else output[key] = key === "description" ? describe(value) : value;
	return output;
}
/** Resolve only whole raw tool-name references, leaving already-qualified names untouched. */
function qualifyDescriptions(prefix, clientNames) {
	const names = new Set(clientNames);
	return (text) => text.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, (name) => names.has(name) ? prefix + name : name);
}
//#endregion
//#region plugins-src/powerpoint/src/catalog-overrides.ts
var slideIdDescription = "Current slide ID from powerpoint_deck_info.slideIds, in presentation order, or powerpoint_verify_slides. Do not use a page number as an ID. After a writeback, use the returned slide_id_update before editing again.";
var descriptions = { edit_slide_master: "Edit the master and layouts associated with the FIRST slide via OOXML. Applies layout migration only to pages using that original master; preserves other masters. The callback receives the first slide's exported package and its master/layout/theme dependencies, not an arbitrary master ID or the complete deck. Call markDirty() only after changing files; use returned ID mappings after replacement." };
var suffixes = { edit_slide_xml: " Read-only callbacks that do not call markDirty() never import a replacement. DOMParser and XMLSerializer are available. Modified writebacks return slide_id_update; use the new ID in subsequent calls." };
var fieldDescriptions = { edit_slide_master: { code: "The JSZip archive includes the first slide and its associated master/layout/theme parts. DOMParser, XMLSerializer and escapeXml(text) are available. Call markDirty() after changing files." } };
/** DSH-owned references and writeback guidance; runtime prose comes from the catalog. */
function catalogDefinitions(tools) {
	const describe = qualifyDescriptions("powerpoint_", [...tools.map((tool) => tool.clientName), "execute_office_js"]);
	return tools.map((tool) => {
		const parameters = normalizeSchema(tool.inputSchema, describe);
		for (const [key, field] of Object.entries(parameters.properties ?? {})) {
			if ([
				"slide_id",
				"from_slide_id",
				"to_slide_id"
			].includes(key)) field.description = slideIdDescription;
			if (key === "slide_ids" && field.items) field.items.description = slideIdDescription;
			const replacement = fieldDescriptions[tool.clientName]?.[key];
			if (replacement) field.description = (field.description?.split(". ")[0] ?? "") + ". " + replacement;
		}
		let description = descriptions[tool.clientName] ?? describe(tool.description);
		if (tool.clientName === "edit_slide_text") description = description.replace(/See the .*?system prompt for editing rules\./, "Preserve existing text, paragraph styles and formatting outside the requested change.");
		description += suffixes[tool.clientName] ?? "";
		return {
			...tool,
			description,
			inputSchema: parameters
		};
	});
}
//#endregion
//#region plugins-src/powerpoint/src/office-tool.ts
/** DSH-owned execution tool, including local binary file inputs. */
var officeTool = {
	description: "Run trusted asynchronous code against the selected PowerPoint presentation. Start document work with PowerPoint.run and return a JSON-compatible value. Available globals: PowerPoint, Office, DOMParser, JSZip, XMLSerializer, insertImage. Supply binary inputs through the optional files map using absolute DSH-side paths; the code can read their base64 bytes from files.<identifier>. Do not paste encoded images or presentations into code or tool arguments.",
	parameters: {
		type: "object",
		properties: {
			code: { type: "string" },
			files: {
				type: "object",
				description: "Local binary inputs keyed by a JavaScript identifier. Each value is an absolute DSH-side filename; files.<identifier> exposes its encoded bytes to your code.",
				propertyNames: { pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" },
				additionalProperties: { type: "string" }
			}
		},
		required: ["code"]
	}
};
//#endregion
//#region plugins-src/powerpoint/src/schemas.ts
var objectSchema = {
	type: "object",
	additionalProperties: true
};
var jsonSchema = { oneOf: [
	{
		type: "object",
		additionalProperties: true
	},
	{
		type: "array",
		items: {}
	},
	{ type: "string" },
	{ type: "number" },
	{ type: "boolean" },
	{ type: "null" }
] };
var textRender = (_args, value) => [{
	type: "text",
	text: JSON.stringify(value)
}];
var slideParam = {
	type: "integer",
	description: "One-based slide index in the current deck."
};
var imageSchema = {
	type: "object",
	properties: {
		attachmentId: { type: "string" },
		mediaType: { type: "string" },
		bytes: { type: "integer" },
		width: { type: "integer" },
		height: { type: "integer" },
		name: { type: "string" },
		originalDimensions: {
			type: "object",
			properties: {
				width: { type: "integer" },
				height: { type: "integer" }
			},
			required: ["width", "height"],
			additionalProperties: false
		}
	},
	required: [
		"attachmentId",
		"mediaType",
		"bytes",
		"width",
		"height"
	],
	additionalProperties: false
};
//#endregion
//#region plugins-src/powerpoint/SKILL.md?raw
var SKILL_default = "# PowerPoint editing\n\nUse the `powerpoint_*` tools to read, edit, and check the presentation that is currently open. Work from the real deck, make the smallest change that meets the request, then read back and render what you changed. Slide text and replies follow the user's language, not the language of this document.\n\nEach tool's own description and schema are the authority for its parameters. This document covers how to choose between tools, the mechanics worth remembering, and working patterns. Code examples are argument bodies for `powerpoint_execute_office_js`, `powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, or `powerpoint_edit_slide_master`, not shell snippets.\n\n## 1. Workflow\n\n1. **Inspect.** Start with `powerpoint_deck_info` (slide count and size, slide IDs in presentation order, masters, layouts). Use `powerpoint_slide_outline` to locate slides; it shows only the first 200 characters of each shape's text. `powerpoint_list_slide_shapes` returns refs, names, types, and geometry for one slide. `powerpoint_read_slide_text` returns full text and paragraph XML for one shape. Read only the shapes you will touch.\n2. **Choose the mechanism** (section 3).\n3. **Edit.** Preserve the user's wording, template, theme, fonts, layouts, and unrelated objects. Keep text, shapes, tables, diagrams, and charts as native editable objects. Do not replace them with pictures, and do not imitate a quantitative chart with geometric shapes.\n4. **Batch related changes.** Several text edits on one slide belong in one `powerpoint_edit_slide_xml` call, because every OOXML write re-imports the slide.\n5. **Check.** Read back what you changed, run `powerpoint_verify_slides`, and render each affected slide with `powerpoint_render_slide`. Look at the image for overflow, overlap, clipping, misalignment, uneven spacing, and font or colour inconsistency. Fix what you see and render again. `powerpoint_verify_slides` is a heuristic for geometry and contrast; use it as a pointer to look, not as proof the slide is right.\n6. **After an error or timeout**, a slide may be partly changed. Re-read it, determine what landed, and apply the smallest correction instead of re-running the whole edit.\n7. **Report** which slides you changed and checked, what you changed, and anything you could not do. Say \"all slides\" only if you inspected all of them.\n\nTools act on the only connected presentation. When several are connected, call `powerpoint_list_presentations`, pick the target by `label` or `documentUrl`, and pass its `sessionId` to `powerpoint_select_presentation` before step 1. The selection lasts for this DSH session. If the selected presentation closes, tools fail instead of switching to another one; list and select again.\n\nRe-read the deck after the user switches documents, reloads the add-in, or edits it themselves; do not rely on earlier results.\n\n## 2. Identifiers, indices, and units\n\n| Where | What it takes |\n|---|---|\n| Most slide tools (`slide_id` parameter) | An opaque current slide ID from `powerpoint_deck_info.slideIds` (presentation order) or `powerpoint_verify_slides`. Not a page number. |\n| `powerpoint_render_slide`, `powerpoint_insert_image`, `powerpoint_slide_outline` | A positive one-based `slide` index. |\n| `powerpoint_verify_slides` (`from_slide`, `to_slide`) | Zero-based, inclusive range. Slide 1 is `0`; this differs from the one-based `slide` parameters above. |\n| `powerpoint_read_slide_text`, `powerpoint_edit_slide_text` | The exact `ref` returned by `powerpoint_list_slide_shapes`. Refs encode slide and shape; never build one by hand. |\n| `powerpoint_copy_image_between_slides` | Slide IDs plus the `cNvPr` shape id from `powerpoint_list_slide_shapes`. |\n| `autosize_shape_ids` | An array of shape `cNvPr` IDs on the target slide. |\n| `chart_index` | A zero-based chart index on the target slide. |\n\nRaw shape ids are unique only within their slide. A slide's index changes when slides move; its ID is the stable handle. An OOXML write may replace the slide and return `slide_id_update`; use the new ID afterwards.\n\nThe `code` parameter means different things by tool. For `powerpoint_edit_slide_text` it is raw `<a:p>` paragraph XML, not JavaScript. For `powerpoint_execute_office_js`, `powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, and `powerpoint_edit_slide_master` it is the body of an async JavaScript function.\n\nUnits: Office.js positions, sizes, image placement, and icon sizes are points. Chart `spec.position` is EMU (1 pt = 12700 EMU). OOXML `a:off`/`a:ext` are EMU. Use the actual slide size from `powerpoint_deck_info`; do not assume 16:9.\n\nShape names, layout names, and placeholder names follow the Office UI language. Identify objects by ID, ref, or layout ID, and by type or position when that is all you have.\n\n## 3. Choosing a mechanism\n\n- **Office.js (`powerpoint_execute_office_js`)**: slides (add, move, apply layout, delete), shapes (text boxes, geometric shapes, lines), z-order, geometry, tables, fills, fonts, selection, masters and layouts listing. Default choice for ordinary edits.\n- **Dedicated tools**: `powerpoint_edit_slide_text` (one shape's paragraphs), `powerpoint_find_and_replace` (deck-wide text, notes), `powerpoint_duplicate_slide`, `powerpoint_copy_image_between_slides`, `powerpoint_insert_image`, `powerpoint_search_icons` / `powerpoint_insert_icon`, and the chart tools. Use these when they fit; they handle details that are easy to get wrong by hand.\n- **OOXML (`powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, `powerpoint_edit_slide_master`)**: use for properties Office.js does not expose or formatting it cannot preserve adequately: exact paragraph and run properties, notes, chart internals, theme/master parts, SVG recolouring, and detailed diagram anchoring. Use native Office.js shapes for ordinary editable diagrams.\n\nPrefer the narrowest tool. Moving a box is Office.js; changing one word in a styled paragraph is `powerpoint_find_and_replace` or OOXML; a pie chart is `powerpoint_edit_slide_chart`.\n\n## 4. Office.js\n\n`powerpoint_execute_office_js` runs your code as an async function body. Available globals: `Office`, `PowerPoint`, `JSZip`, `DOMParser`, `XMLSerializer`, `insertImage`, and `files`. Supply `files: { image: \"/absolute/path/image.png\", deck: \"/absolute/path/deck.pptx\" }` alongside `code`; the plugin reads these DSH-machine paths and exposes raw base64 as `files.image` and `files.deck`. Never put base64 literals in `code`. There is no implicit `context`; open one with `PowerPoint.run`. Return a JSON-serializable value.\n\nRead shapes on a slide:\n\n```js\n// powerpoint_execute_office_js code argument\nreturn await PowerPoint.run(async (ctx) => {\n  const slides = ctx.presentation.slides;\n  slides.load(\"items/id\");\n  await ctx.sync();\n  const shapes = slides.items[0].shapes;\n  shapes.load(\"items/id,items/name,items/type,items/left,items/top,items/width,items/height\");\n  await ctx.sync();\n  return shapes.items.map(s => ({ id: s.id, name: s.name, type: s.type,\n    left: s.left, top: s.top, width: s.width, height: s.height }));\n});\n```\n\nRules:\n\n- Keep the proxy returned by a getter in a variable: `load()` its properties, `await ctx.sync()`, then read that same variable. Re-calling the getter yields an unloaded proxy. Loaded values are snapshots; reload after a write before branching on them.\n- Call `sync()` after writes, and await every async helper you call.\n- `slides.add(...)` returns nothing. Sync, reload `slides.items`, then pick up the new slide and its ID. Layout IDs come from `ctx.presentation.slideMasters` / `layouts`, not from names.\n- Colour setters differ: `shape.fill.setSolidColor(\"C2532E\")` takes a bare hex; `slide.background.fill.setSolidFill({ color: \"#FAF8F5\" })` takes an object. If a call throws, check the exact form in the tool or API reference.\n- Text frames: use `shape.getTextFrameOrNullObject()`, load `isNullObject`, sync, and read `textRange` only when it is false.\n- Assigning `textRange.text` can discard formatting within the range. For text with mixed runs or a template style, use `powerpoint_edit_slide_text` or XML.\n- Labels inside a simple shape go in that shape's own text frame: centre horizontally, middle vertically, set margins deliberately, and disable auto-size when the shape must keep its size. A separate overlaid text box tends to drift.\n- Add shapes with `shapes.addTextBox`, `shapes.addGeometricShape`, `shapes.addTable`; reorder with `shape.setZOrder`. Selected slides come from `ctx.presentation.getSelectedSlides()`. Use `slide.moveTo(i)` and `slide.applyLayout(layout)` for ordering and layout changes.\n- Grouping and z-order: use the grouping API only if the Office.js version in the add-in exposes it (check before relying on it); otherwise leave objects ungrouped and order them with `setZOrder`, or group in XML with `<p:grpSp>`.\n- Tabular data belongs in a native table (`shapes.addTable`), not a grid of text boxes.\n\nAPIs that do not cross hosts:\n\n| Task | PowerPoint API / approach | Do not borrow |\n|---|---|---|\n| Table cell | `table.getCellOrNullObject(row, column)`; load/sync its null status | Word's `getCell()` |\n| Collection count | `collection.load(\"items\")`, sync, then `collection.items.length` | `getCount()` |\n| Slide package | `powerpoint_edit_slide_xml` to read/modify exported parts | `slide.getAsBase64()` does not exist |\n\nTargeted edit by ID, loading fresh state before and after the write:\n\n```js\n// powerpoint_execute_office_js code argument\nreturn await PowerPoint.run(async (ctx) => {\n  const slideId = \"PASTE_ID_FROM_powerpoint_deck_info\";   // current ID, not an index\n  const slide = ctx.presentation.slides.getItem(slideId);\n  const shapes = slide.shapes;\n  shapes.load(\"items/id,items/name,items/left,items/top,items/width\");\n  await ctx.sync();\n  const target = shapes.items.find(s => s.id === \"PASTE_SHAPE_ID\");\n  if (!target) return { error: \"shape not found\", ids: shapes.items.map(s => s.id) };\n  target.left = 72; target.top = 120;                      // points\n  target.fill.setSolidColor(\"2F5D8A\");\n  await ctx.sync();\n  target.load(\"left,top,width\");                           // reload after writing\n  await ctx.sync();\n  return { left: target.left, top: target.top, width: target.width };\n});\n```\n\nIf the slide ID was returned by an earlier OOXML writeback, use the `slide_id_update` value. If `getItem` fails, call `powerpoint_deck_info` again for the current IDs.\n\nExample: add a slide from a layout, then clean up its placeholders from a fresh read:\n\n```js\nreturn await PowerPoint.run(async (ctx) => {\n  const layoutId = \"PASTE_LAYOUT_ID_FROM_powerpoint_deck_info\";\n  ctx.presentation.slides.add({ layoutId });\n  await ctx.sync();\n  const slides = ctx.presentation.slides;\n  slides.load(\"items/id\");\n  await ctx.sync();\n  const slide = slides.items[slides.items.length - 1];\n  slide.shapes.load(\"items/id,items/name,items/type\");\n  await ctx.sync();\n  return { slideId: slide.id, shapes: slide.shapes.items.map(s => ({ id: s.id, name: s.name })) };\n});\n```\n\nThen fill or delete each unused placeholder in a second step. Do not decide what to delete from values loaded before your own write.\n\n### Tables\n\n- Table text, fills, fonts, and alignment are reached through `shape.getTable()` and its rows and cells, not `shape.textFrame`.\n- Table height follows row heights and cell content. Writing the graphic frame's `height` (or `<a:ext cy>`) does not resize it reliably. Set `table.rows.getItemAt(i).height`, reduce cell font size, or shorten text, and pass the table's shape id in `autosize_shape_ids` for XML edits.\n- Cell text written through Office.js may not persist on some hosts. Read the cell back after writing; if the value is not there, write it in the slide XML (`<a:tbl>/<a:tr>/<a:tc>/<a:txBody>`), keeping the cell's `<a:tcPr>` and run properties.\n\n### Images and imported slides\n\n- Use `powerpoint_insert_image` for new pictures: provide required `filePath` (a PNG, JPEG, GIF, or BMP path on the machine running DSH), a `slide` index, and positions in points. Give width or height, not both, to keep the aspect ratio; to fit a box, compute the scaled size from the image's natural ratio and centre it (letterbox) rather than stretching. To crop to fill, crop with the picture's crop properties instead of distorting. Inserting changes the selected slide.\n- Inside `powerpoint_execute_office_js`, `insertImage(files.image, { imageLeft, imageTop, imageWidth, imageHeight })` places an image on the currently selected slide. Navigate to the target first (for example `Office.context.document.goToByIdAsync(slideNumber, Office.GoToType.Index, cb)`, 1-based) and await completion before calling it.\n- Reuse an existing picture on another slide with `powerpoint_copy_image_between_slides`; it re-registers media and relationships and keeps crops, filters, and alt text.\n- `ctx.presentation.insertSlidesFromBase64(files.deck, { sourceSlideIds, targetSlideId })` must be awaited; pass only the slides you need. For an externally generated `.pptx`, import one slide first and verify it before importing more. On `InvalidArgument`, isolate the failing slide instead of replaying the whole package. Depending on the source and target, the source's master, layouts, and theme may be imported alongside the deck's own. After importing, list `slideMasters` and layouts and check which master the new slides use. To make an imported template primary, move the existing slides onto it or edit the first master's parts with `powerpoint_edit_slide_master`.\n\n## 5. Text, bullets, and run formatting\n\nChoosing the tool:\n\n- One shape: `powerpoint_read_slide_text` then `powerpoint_edit_slide_text` with `<a:p>` paragraph XML. Body properties and list styles on the shape are left as they were.\n- Several shapes on one slide: a single `powerpoint_edit_slide_xml` call.\n- The same replacement in many places: start with `powerpoint_find_and_replace` and `dry_run: true`, then apply it. Use hand-written Office.js only for reported skips or conditional logic. `cell.textRuns` can be null; preserve mixed-format cell runs rather than applying the first run's formatting to the whole cell. It covers shapes, groups, placeholders, tables, and notes; text replaced within a single run retains its formatting; text spanning several runs adopts the formatting of the first. It skips fields, chart and SmartArt text, and layout/master text.\n\nParagraph XML rules:\n\n- Read the existing paragraph first. Preserve its `<a:pPr>` and `<a:rPr>` while changing the requested content or properties; dropping an explicit attribute can change the inherited formatting.\n- Keep `<a:schemeClr>` colours and theme fonts. Hard-coded `<a:srgbClr>` or `<a:latin typeface=...>` override the theme and stop following later theme edits, and a named font may be missing on the machine. Add them only when the user asked or the existing runs already use them.\n- Bullets are `<a:buChar>` in `<a:pPr>`, not a typed \"•\". Top level is `lvl=\"0\"` (or omitted); sub-bullets use `lvl=\"1\"`. A heading in a list uses `<a:buNone/>`.\n- Copy `marL` and `indent` from the existing list. For a new list, `marL=\"457200\" indent=\"-457200\"` (second level `marL=\"914400\"`) keeps text clear of the bullet.\n- Escape user text with `escapeXml(...)` before putting it in a template string; a bare `&` or `<` breaks the XML.\n- Superscript: `font.superscript = true` in Office.js, or `baseline=\"30000\"` on `<a:rPr>`. Footnote text is usually small and muted, starting with the same number at normal baseline.\n- Font size is `sz` in hundredths of a point (`2400` = 24 pt). Offsets and extents are EMU; paragraph spacing uses `<a:spcPts val>` in hundredths of a point or `<a:spcPct>` in thousandths of a percent. Give new runs a `lang` that matches the surrounding text or the user's language (copy it from existing runs); `en-US` in the examples is only illustrative. Keep `dirty=\"0\"` on new runs.\n\nParagraph replacement example (`powerpoint_edit_slide_text` code argument), changing one run's text and keeping the original properties:\n\n```xml\n<a:p>\n  <a:pPr marL=\"342900\" indent=\"-342900\"><a:buFont typeface=\"Arial\"/><a:buChar char=\"•\"/></a:pPr>\n  <a:r><a:rPr lang=\"en-US\" sz=\"1800\" dirty=\"0\"/><a:t>Revenue grew 12% year over year</a:t></a:r>\n</a:p>\n```\n\n(Use the real `pPr`/`rPr` read from the shape. This only illustrates the shape of the result. Apply `escapeXml` to inserted text when generating the string in code.)\n\n## 6. Raw OOXML\n\n`powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, and `powerpoint_edit_slide_master` run your code body with `{ zip, markDirty }` plus `DOMParser`, `XMLSerializer`, and `escapeXml`. `powerpoint_edit_slide_chart` also provides `buildChart(spec)` and async `insertChart(zip, spec)`.\n\nMechanics:\n\n- The zip is an exported package. The slide is always `ppt/slides/slide1.xml`, regardless of the slide's position or ID. Its master, layout, theme, notes, charts, and media are found through relationship files (`ppt/slides/_rels/slide1.xml.rels`, then the layout's and master's rels). Do not assume `slideMaster1.xml` or `theme1.xml`; decks with several masters differ.\n- The edited ZIP is imported only when the callback calls `markDirty()`. Omit it for inspection; call it after changing ZIP entries.\n- A writeback may replace the slide and return `slide_id_update`; use it afterwards.\n- Pass `autosize_shape_ids` with the `cNvPr` ids of shapes whose text you changed or tables whose content changed. For shapes already set to shape-to-fit-text, the tool re-applies that setting so the layout recalculates; other auto-size modes are left alone. For tables it rewrites each row height to trigger frame re-layout, since font-only edits don't reflow the frame. Omit it when you changed no text.\n- XML child order is strict. Keep existing elements; modify them in place rather than appending duplicates.\n- After a write, read the XML back, check the changed text and relationships, and render the slide.\n\nRead-only inspection:\n\n```js\n// powerpoint_edit_slide_xml code argument (no markDirty: nothing is written)\nconst xml = await zip.file(\"ppt/slides/slide1.xml\").async(\"string\");\nconst rels = await zip.file(\"ppt/slides/_rels/slide1.xml.rels\").async(\"string\");\nreturn { xmlLength: xml.length, rels };\n```\n\nMutating example: replace text in one shape and mark the change.\n\n```js\n// powerpoint_edit_slide_xml code argument\nconst path = \"ppt/slides/slide1.xml\";\nconst doc = new DOMParser().parseFromString(await zip.file(path).async(\"string\"), \"application/xml\");\nconst A = \"http://schemas.openxmlformats.org/drawingml/2006/main\";\nconst P = \"http://schemas.openxmlformats.org/presentationml/2006/main\";\nconst shapeId = \"4\"; // substitute the ID returned by powerpoint_list_slide_shapes\nconst shape = Array.from(doc.getElementsByTagNameNS(P, \"sp\")).find(sp =>\n  sp.getElementsByTagNameNS(P, \"cNvPr\")[0]?.getAttribute(\"id\") === shapeId);\nif (!shape) throw new Error(\"Target text shape not found: \" + shapeId);\nconst text = shape.getElementsByTagNameNS(A, \"t\")[0];\nif (!text) throw new Error(\"Target shape has no text run\");\ntext.textContent = \"Q3 results\"; // preserves the run and paragraph properties; DOM assignment escapes XML\nzip.file(path, new XMLSerializer().serializeToString(doc));\nmarkDirty();\nreturn { shapeId, text: text.textContent };\n```\n\nIn the tool call, pass `autosize_shape_ids: [\"4\"]` and, on success, use the returned `slide_id_update` for the next call. Then re-read the shape's text and render the slide. This sample edits a single-run shape; if the text has several runs, write the new text into the first run and clear the others only when that is what the request means.\n\n### Speaker notes\n\nEdit existing notes text with `powerpoint_find_and_replace` when the change is a text substitution. For anything structural, work in XML.\n\n1. Read the slide rels and look for a relationship whose `Type` ends in `/notesSlide`.\n2. If present, open the target part (for example `ppt/notesSlides/notesSlide1.xml`). Notes text lives in the body placeholder shape (`<p:ph type=\"body\"`); the slide-image and slide-number placeholders are not text content. Edit only the body placeholder's paragraphs, keeping its `<a:pPr>`/`<a:rPr>` and the part's relationships.\n\n```js\n// powerpoint_edit_slide_xml code argument (read-only: no markDirty)\nconst rels = await zip.file(\"ppt/slides/_rels/slide1.xml.rels\").async(\"string\");\nconst relationships = new DOMParser().parseFromString(rels, \"application/xml\");\nconst R = \"http://schemas.openxmlformats.org/package/2006/relationships\";\nconst notesRel = Array.from(relationships.getElementsByTagNameNS(R, \"Relationship\"))\n  .find(rel => rel.getAttribute(\"Type\")?.endsWith(\"/notesSlide\"));\nif (!notesRel) return { notes: null };\nconst partPath = decodeURIComponent(new URL(notesRel.getAttribute(\"Target\"),\n  \"https://package.invalid/ppt/slides/slide1.xml\").pathname.slice(1));\nconst xml = await zip.file(partPath).async(\"string\");\nconst doc = new DOMParser().parseFromString(xml, \"application/xml\");\nconst P = \"http://schemas.openxmlformats.org/presentationml/2006/main\";\nconst A = \"http://schemas.openxmlformats.org/drawingml/2006/main\";\nconst body = Array.from(doc.getElementsByTagNameNS(P, \"sp\")).find(sp =>\n  sp.getElementsByTagNameNS(P, \"ph\")[0]?.getAttribute(\"type\") === \"body\");\nconst paragraphs = body ? Array.from(body.getElementsByTagNameNS(A, \"p\")).map(p =>\n  Array.from(p.getElementsByTagNameNS(A, \"t\")).map(t => t.textContent).join(\"\")) : [];\nreturn { partPath, paragraphs };\n```\n\n3. If the slide has no notes part, add a notes-slide XML part with a body placeholder, a slide-to-notes relationship, the notes part's relationship back to its slide, and a notes-slide override in `[Content_Types].xml`. Allocate unused part names and relationship IDs. Preserve or reuse the package's notes-master/theme wiring when present. If you introduce a notes master, include its part, theme dependencies, content types, and presentation-level registration as well; every relationship must target a part actually included in the package. A missing notes part or notes master in the export is a package-construction task, not evidence that notes cannot be added.\n4. After any write, re-run the read example, confirm the text, and check the slide still renders.\n\n### Media and relationships\n\nAdding a picture or other part needs the file under `ppt/media/`, a relationship in the slide rels with a unique `rId`, a default or override content type for the extension, and the `<p:pic>` referencing the `r:embed`. Prefer `powerpoint_insert_image` or `powerpoint_copy_image_between_slides`, which do this.\n\n### Icons\n\n`powerpoint_search_icons` takes one literal noun per query and needs network access. `powerpoint_insert_icon` inserts SVG with a PNG fallback, accepts a `color`, and returns the placed shape's ref, id, and geometry. To recolour an icon already on a slide, follow its `<asvg:svgBlip r:embed>` through the slide rels to `ppt/media/imageN.svg` and set the fill on the SVG paths; `shape.fill` colours only the box behind the icon. If the package holds both an SVG and a PNG fallback for the icon, recolour both (or re-insert the icon with `powerpoint_insert_icon` and its `color`), so renderers that use the PNG match.\n\n## 7. Placeholders and new slides\n\nA new slide inherits its layout's placeholders, even when they render empty. List the new slide's shapes, then fill or delete each unused placeholder before adding other content. Measure the title placeholder's bottom edge before placing content under it; title bands vary by template. Delete only placeholders on slides you just added. On an existing slide, a placeholder that holds text is the user's content. Do not delete content to make a verifier warning go away, and do not leave invisible empty boxes behind.\n\n## 8. Themes, masters, and rebranding\n\nIdentify the deck type from `powerpoint_deck_info` and from reading a finished slide:\n\n- **Blank or default deck**: define theme colours, heading and body fonts, background, and text styles in the master first, then let slides inherit. Put repeated graphics (logo, rule) on the master or layouts.\n- **Hand-styled deck on the default master**: the finished slides are the design system. Match their background, fonts, sizes, colours, and shape styling slide by slide, and do not restructure the master as a side effect.\n- **Templated deck**: use its layouts, theme colours (`themePalette`), and fonts; keep it.\n- **Deck-wide footer notes/source lines**: use the layout's Footer placeholder, keeping each slide's own text, instead of free text boxes. After converting, remove local position and font overrides and verify that layout inheritance controls the result.\n\n`powerpoint_edit_slide_master` works on the master associated with the first slide, along with its layouts and theme. Slides using that master migrate with it and other masters stay. It cannot select an arbitrary master, and its package is not the whole deck, so it cannot show you every slide's direct formatting.\n\nRules for master and theme XML:\n\n- Edit existing `<p:txStyles>`, `<a:clrScheme>`, and `<a:fontScheme>` in place; do not append duplicates.\n- A background is `<p:bg>` inside `<p:cSld>`, before `<p:spTree>`; edit an existing one rather than adding a second.\n- Theme fonts are in `<a:fontScheme>` (`<a:majorFont>`, `<a:minorFont>`); read them to match existing typography.\n- A theme-only request (\"change accent2 to gold\", \"swap the heading font\") is one theme or master edit; content that inherits follows. Do not restyle shapes one by one.\n\nDirect `<a:srgbClr>` colours and explicit fonts on slides do not follow theme changes. For a full palette change:\n\n1. Find where the old colours live: inherited (theme/master/layout) versus direct (on slide shapes, charts, tables).\n2. In one `powerpoint_edit_slide_master` call, replace the old hex values across the `.xml` parts in that exported master package (the first slide's master, its layouts, and its theme). That package does not contain every slide or chart in the deck, so this step only covers what it includes.\n3. Fix direct colours on each affected slide with `powerpoint_edit_slide_xml`, and update chart colours through `powerpoint_edit_slide_chart` or `powerpoint_edit_built_chart` per chart. Other masters need their own pass, since `powerpoint_edit_slide_master` only reaches the first slide's master.\n4. Render samples from each layout type.\n\n## 9. Charts\n\nTools:\n\n- `powerpoint_create_slide_chart`: declarative builder for column, bar, line, slope, stacked column (with totals), 100% stacked (Likert) bar, waterfall, scatter, and big number. It writes chart XML and its cache.\n- `powerpoint_read_chart_style`: reads each chart's form, fonts, fills, series colours, legend, value axis, gridlines, and title as fields you can pass back.\n- `powerpoint_edit_built_chart`: replaces a built chart's content with a new full spec, keeping the same object, position, and shape id. It refuses combo, 3D, pie, and secondary-axis charts.\n- `powerpoint_edit_slide_chart`: raw chart OOXML for unsupported forms and fine changes.\n\nPractice:\n\n- If the deck already has charts, call `powerpoint_read_chart_style` first and pass its style (accent, font, background, neutrals) and construction (legend, value axis, gridlines) on the new spec so the charts match. A native chart title is the top-level `title` field of the spec, not part of construction; pass it when the existing charts have one (`has_native_title`). Use the returned accent and font rather than guessing. Where there are no charts, pass the deck's accent colour and body font; without a style the builder falls back to its own default palette.\n- `powerpoint_edit_built_chart` takes the whole replacement spec and drops anything not in it. Carry over the style and construction from `powerpoint_read_chart_style` together with the new data.\n- Numbers: give raw numbers and put the unit in the format: `\"$\"#,##0\"M\"` reads $42M, `0\"%\"` reads 38%. For stacked charts the totals format carries the unit and the segment format is bare. A bare number leaves the reader guessing.\n- Axis scale: leave it unset unless you need round numbers or a scale shared with another chart.\n- Line charts: keep categories short (`Q1`, `Jan`) and put years in `category_groups`. Short series names. Put values in `end_label` or `point_labels` (start, end, and the turning point). Use `callouts` only when the slide's message is a change in trajectory.\n- Forecast: `forecast_from` dashes or hatches projected values; also suffix those category labels with `E`.\n- Growth arrows: only for significant changes; the builder draws them as grouped elbow shapes.\n- Chart `spec.position` is in EMU; omit it for the full-slide default.\n- Chart XML from the builder carries no embedded workbook. If the user needs editable data in Excel or you edit an existing workbook, say what you did and check the chart renders and the data is right.\n- Keep the chart as a native chart object. Do not draw a quantitative chart from rectangles or lines.\n- Choosing a form: column for comparison across a few periods or categories; bar for ranked or long-label categories; line for trends over time; stacked column for composition with totals; Likert (100% stacked bar) for survey distributions; waterfall for a bridge from a start to an end value; scatter for relationships between two numbers; slope for before/after across items; big number for a single headline figure. Emphasise the one category or point that carries the message and keep the rest neutral; do not colour every series differently without reason.\n- Use `accent_index` only when the deck's existing charts use a single accent colour. If they colour every bar the same, leave it unset.\n\n## 10. Design and content\n\n- For a substantial new deck, settle the brief first: audience, purpose, whether it is presented live or read on its own (a read-ahead deck can carry more text), and the key message. Draft a storyboard (one line per slide giving its message) before building. For a small edit, use the brief already established by the deck and request.\n- Content slides carry one main message, and their titles state the conclusion. Title, agenda, and section-divider slides can use plain label titles.\n- Match the existing deck's look. When the user supplies no style and the deck has none, choose fonts and colours that suit the content and use them consistently.\n- Keep type hierarchy consistent. Size body text for the actual canvas and viewing distance. If text overflows, resize the container, trim your own copy, or split the slide; shrink only as far as stays readable. User-written text may be reduced a little, and tell the user if it ends up very small.\n- Leave 10–15 pt between text and the edge of its card or container. Align objects, keep spacing even, and keep titles in the same position across slides in the same layout.\n- Title alignment follows the layout (centred on title and section layouts, left on content layouts); a template's own placeholder alignment wins. The title band's height varies by template, so read the title placeholder's geometry and start content below its bottom edge.\n- Preserve the user's wording. Rewrite only on request.\n- Reuse the master for repeated elements instead of copying them onto every slide.\n\n## 11. Checking and runtime notes\n\n- `powerpoint_verify_slides` reports overlap, out-of-bounds shapes, and low text contrast, with a `slideId` per result. For large decks use `from_slide` and `to_slide` (0-based). Fix flagged items within the scope of the request; if the flagged shapes are outside what the user asked to change, report them.\n- `powerpoint_render_slide` renders a real slide image. The default backend uses Office.js image export. If the environment is configured for COM, it renders the active presentation, so confirm the intended deck is active.\n- `powerpoint_pane_visibility` hides or shows the task pane. Hiding keeps the runtime available; closing a borrowed pane may drop it.\n- `powerpoint_deck_info` reads the live document. If a tool fails because the runtime is unavailable, ask the user to open or restore the add-in rather than repeating write calls.\n";
//#endregion
//#region plugins-src/powerpoint/src/apply.ts
var inject = [
	"tools",
	"skills",
	"attachments"
];
/** Register tools and the embedded provider; serialize operations across agents sharing the deck. */
function apply(ctx, config) {
	let tail = Promise.resolve();
	const serial = (fn) => {
		const result = tail.then(fn);
		tail = result.catch(() => {});
		return result;
	};
	const selections = /* @__PURE__ */ new Map();
	const hidden = /* @__PURE__ */ new Set();
	const sessionKey = (exec) => exec.agent?.session?.id ?? null;
	const selected = (exec) => selections.get(sessionKey(exec));
	const panes = (exec) => {
		return helperRequest(config, "/panes", void 0, exec.signal);
	};
	const paneKey = async (exec) => {
		if (selected(exec) !== void 0) return selected(exec);
		const data = await panes(exec);
		return data.panes.length === 1 ? data.panes[0].sessionId : void 0;
	};
	const evaluateNow = async (code, exec) => {
		if (config.autoHide) {
			const key = await paneKey(exec);
			if (!hidden.has(key)) {
				await evaluate(config, "(async()=>{await Office.addin.hide();return true;})()", exec.signal, selected(exec));
				hidden.add(key);
			}
		}
		return evaluate(config, code, exec.signal, selected(exec));
	};
	const makeTool = (toolName, description, parameters, schema, execute, render = textRender) => {
		return {
			name: toolName,
			deferLoading: true,
			description,
			timeoutMs: config.timeoutMs,
			parameters,
			output: {
				schema,
				render
			},
			execute: (args, exec) => serial(() => {
				exec.signal?.throwIfAborted();
				const slide = args.slide;
				if (slide !== void 0 && (!Number.isSafeInteger(slide) || slide < 1)) throw new Error("slide must be a positive integer");
				return execute(args, exec);
			})
		};
	};
	const register = (...args) => {
		ctx.effect(() => ctx.tools.register(makeTool(...args)));
	};
	const add = (toolName, description, properties, required, schema, execute, render) => {
		register(toolName, description, {
			type: "object",
			properties,
			required,
			additionalProperties: false
		}, schema, execute, render);
	};
	add("powerpoint_list_presentations", "List connected PowerPoint presentations with pane sessionId, label, documentUrl and connectedAt, plus selectedTarget for this DSH session (null when unset). Requires the helper backend.", {}, [], objectSchema, async (_args, exec) => ({
		...await panes(exec),
		selectedTarget: selected(exec) ?? null
	}));
	add("powerpoint_select_presentation", "Select a connected PowerPoint presentation for subsequent tools in this DSH session. Use a sessionId from powerpoint_list_presentations; a disconnected target is never replaced automatically. Requires the helper backend.", { target: {
		type: "string",
		description: "Pane sessionId from powerpoint_list_presentations."
	} }, ["target"], objectSchema, async (args, exec) => {
		const data = await panes(exec);
		if (!data.panes.some((pane) => pane.sessionId === args.target)) throw paneError({
			code: "target-not-found",
			message: "The requested PowerPoint taskpane is not connected.",
			panes: data.panes
		});
		selections.set(sessionKey(exec), args.target);
		return {
			...data,
			selectedTarget: args.target
		};
	});
	register("powerpoint_execute_office_js", officeTool.description, officeTool.parameters, jsonSchema, async (args, exec) => evaluateNow(clientCallExpression("execute_office_js", await officeArgs(args, exec.signal)), exec));
	const staticNames = new Set([
		"execute_office_js",
		"list_presentations",
		"select_presentation",
		"pane_visibility",
		"deck_info",
		"slide_outline",
		"insert_image",
		"render_slide"
	]);
	startCatalog(ctx, "PowerPoint", config, (signal) => helperRequest(config, "/catalog", void 0, signal), (tools) => catalogDefinitions(tools.filter((tool) => tool.clientName !== "execute_office_js")).map((tool) => {
		if (staticNames.has(tool.clientName)) throw new Error("PowerPoint catalog conflicts with a DSH-owned tool: " + tool.clientName);
		return makeTool("powerpoint_" + tool.clientName, tool.description, tool.inputSchema, jsonSchema, (args, exec) => evaluateNow(clientCallExpression(tool.clientName, args), exec));
	}));
	add("powerpoint_pane_visibility", "Hide or show the Office taskpane. Hiding keeps the document runtime available.", { visible: { type: "boolean" } }, ["visible"], objectSchema, async (a, e) => {
		const key = await paneKey(e);
		const result = await evaluate(config, "(async()=>{await Office.addin." + (a.visible ? "showAsTaskpane" : "hide") + "();return {visible:" + a.visible + "};})()", e.signal, selected(e));
		hidden.add(key);
		return result;
	});
	add("powerpoint_deck_info", "Read the live PowerPoint deck slide IDs, dimensions, masters and layouts. Use before editing; the document runtime must be loaded.", {}, [], objectSchema, (_a, e) => evaluateNow(infoExpression(), e));
	add("powerpoint_slide_outline", "Read compact shape geometry and text (first 200 characters per shape). Omit slide for whole deck.", { slide: slideParam }, [], {
		type: "array",
		items: objectSchema
	}, (a, e) => evaluateNow(outlineExpression(a.slide, true), e));
	add("powerpoint_insert_image", "Insert a PNG/JPEG/GIF/BMP file from the DSH machine onto a slide via Office.js. filePath is required; no Windows path or inline binary data. Coordinates are points; omitted height preserves aspect ratio. Changes the selected slide.", {
		slide: slideParam,
		filePath: { type: "string" },
		left: { type: "number" },
		top: { type: "number" },
		width: { type: "number" },
		height: { type: "number" }
	}, ["slide", "filePath"], objectSchema, async (a, e) => {
		const base64 = (await readFile(a.filePath, { signal: e.signal })).toString("base64");
		for (const key of ["width", "height"]) if (a[key] !== void 0 && (!Number.isFinite(a[key]) || a[key] <= 0)) throw new Error(key + " must be positive");
		const placement = {};
		for (const [key, target] of [
			["left", "imageLeft"],
			["top", "imageTop"],
			["width", "imageWidth"],
			["height", "imageHeight"]
		]) if (a[key] !== void 0) placement[target] = a[key];
		return evaluateNow(imageExpression(a.slide, base64, placement), e);
	});
	add("powerpoint_render_slide", "Render the taskpane-bound slide through Office.js and return PNG directly for visual inspection. When explicitly configured renderBackend: com, render through the Windows helper; that mode uses ActivePresentation and requires the intended deck to stay active.", { slide: slideParam }, ["slide"], {
		type: "object",
		properties: {
			slide: slideParam,
			image: imageSchema
		},
		required: ["slide", "image"],
		additionalProperties: false
	}, async (a, e) => {
		const guard = await evaluateNow(deckSizeExpression(a.slide), e);
		const data = await renderSlide(config, a.slide, {
			signal: e.signal,
			expectSlides: guard?.slideCount,
			target: selected(e)
		});
		const image = await ctx.attachments.saveImage({
			data,
			mediaType: "image/png",
			name: "slide-" + a.slide + ".png"
		});
		return {
			slide: a.slide,
			image: {
				...image,
				attachmentId: String(image.attachmentId)
			}
		};
	}, (_a, v) => [{
		type: "text",
		text: JSON.stringify({
			slide: v.slide,
			width: v.image.width,
			height: v.image.height
		})
	}, {
		type: "image",
		attachment: v.image
	}]);
	const summary = {
		name: "powerpoint",
		description: "Create, edit, and inspect the current PowerPoint presentation using native powerpoint_* tools. Covers Office.js, OOXML, text formatting, charts, masters, notes, images, and rendered slide review.",
		provider: name,
		source: "bundled",
		invocation: {
			modelInvocable: true,
			userInvocable: true
		}
	};
	ctx.effect(() => ctx.skills.registerProvider(() => ({
		name,
		list: async () => [{
			...summary,
			rank: 600,
			locator: "embedded"
		}],
		get: async () => ({
			...summary,
			content: SKILL_default
		})
	})));
}
//#endregion
export { Config, apply, clientCallExpression, deckSizeExpression, evaluate, imageExpression, infoExpression, inject, name, outlineExpression, renderSlide };
