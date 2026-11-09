// Generated from plugins-src/word; run pnpm build:word. Do not edit directly.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
//#region plugins-src/word/src/config.ts
var name = "dsh-word";
/** Deployment settings; no package or bundle parsing occurs during tool calls. */
var Config = { "~standard": {
	version: 1,
	vendor: name,
	validate(input) {
		const value = {
			catalogRefreshMs: 3e5,
			catalogRetryInitialMs: 1e3,
			catalogRetryMaxMs: 3e4,
			helperUrl: "http://127.0.0.1:18770",
			helperToken: "",
			timeoutMs: 9e4,
			autoHide: true,
			renderLongEdge: 1800,
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
		try {
			if (!["http:", "https:"].includes(new URL(value.helperUrl).protocol)) throw new Error("protocol");
		} catch (error) {
			issues.push({
				message: "helperUrl must be an HTTP(S) URL",
				path: ["helperUrl"]
			});
		}
		for (const key of ["timeoutMs", "renderLongEdge"]) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) issues.push({
			message: key + " must be a positive integer",
			path: [key]
		});
		if (typeof value.helperToken !== "string") issues.push({
			message: "helperToken must be a string",
			path: ["helperToken"]
		});
		if (typeof value.autoHide !== "boolean") issues.push({
			message: "autoHide must be boolean",
			path: ["autoHide"]
		});
		return issues.length ? { issues } : { value };
	}
} };
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
//#region plugins-src/word/src/catalog-overrides.ts
var descriptions = {
	verify_doc: "Fast structural check of the current Word document: paragraph style distribution, list numbering sequence, and table row/cell structure. Use between edits to locate numbering restarts, table breaks or changed styles. For fonts, spacing and pagination, render affected pages with word_render_page.",
	edit_doc_text: "Replace one exact text span in place. Only the matched characters change, which keeps word/sentence-level tracked revisions instead of whole-paragraph delete+insert. Read first, match the intended text uniquely, and keep unchanged context verbatim. Use word_execute_office_js for structural edits such as inserting paragraphs, changing styles and tables."
};
var sentenceReplacements = { read_doc_section: {
	index: 1,
	text: "Locate an unfamiliar section with word_search_doc_text first, then read its heading or returned paragraph range."
} };
/** Replace app-only state/review instructions with DSH-owned reading and rendering guidance. */
function catalogDefinitions(tools) {
	const describe = qualifyDescriptions("word_", [...tools.map((tool) => tool.clientName), "execute_office_js"]);
	return tools.map((tool) => {
		const parameters = normalizeSchema(tool.inputSchema, describe);
		let description = descriptions[tool.clientName] ?? describe(tool.description);
		const replacement = sentenceReplacements[tool.clientName];
		if (replacement) {
			const sentences = description.split(/(?<=\.) /);
			sentences[replacement.index] = replacement.text;
			description = sentences.join(" ");
		}
		if (tool.clientName === "read_doc_section" && parameters.properties?.heading?.description) parameters.properties.heading.description = parameters.properties.heading.description.replace(/\(exact match[^)]*\)/, "(exact match against a heading read from the document)");
		if (tool.clientName === "search_doc_text") description = description.replace(/\(does not search[^)]*\)/, "(does not search headers or footers; read those explicitly with Word Office.js)");
		return {
			...tool,
			description,
			inputSchema: parameters
		};
	});
}
//#endregion
//#region plugins-src/word/src/office-tool.ts
/** DSH-owned execution tool, including local binary file inputs. */
var officeTool = {
	description: "Run a trusted asynchronous function against the chosen Word document. Its body executes within Word.run and receives context; call context.sync() to flush edits. Available globals: Word, Office, JSZip, console, DOMParser, XMLSerializer. The result envelope is {success:true,result}. For binary inputs, set files to a map of JavaScript identifiers and absolute DSH-side filenames; files.<identifier> then contains base64 bytes, not a data URL. Never paste encoded binary content into code. This execution environment has no Claude application services, uploaded-file storage, model orchestration, attachImage, Conductor, or SES isolation.",
	parameters: {
		type: "object",
		properties: {
			code: { type: "string" },
			files: {
				type: "object",
				description: "Local binary inputs keyed by JavaScript identifier. Give an absolute DSH-side filename for each entry; your code reads its encoded contents as files.<identifier>.",
				additionalProperties: { type: "string" }
			}
		},
		required: ["code"]
	}
};
//#endregion
//#region plugins-src/word/src/transport.ts
/** Send one helper request without retrying possibly applied document writes. */
async function requestHelper(config, path, payload, signal) {
	const timeout = AbortSignal.timeout(config.timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	combined.throwIfAborted();
	const headers = { "content-type": "application/json" };
	if (config.helperToken) headers.authorization = "Bearer " + config.helperToken;
	const response = await fetch(new URL(path, config.helperUrl), {
		method: payload === void 0 ? "GET" : "POST",
		headers,
		...payload === void 0 ? {} : { body: JSON.stringify(payload) },
		signal: combined
	}).catch((error) => {
		throw new Error("Word helper not connected: " + String(error), { cause: error });
	});
	const body = await response.json();
	if (!response.ok) throw paneError(body.error ?? {
		code: response.status,
		message: "request failed"
	});
	return body;
}
/** Keep document-selection failures actionable without discarding the helper's pane list. */
function paneError(detail) {
	const selection = [
		"target-not-found",
		"multiple-panes",
		"taskpane-not-open"
	].includes(detail.code);
	return /* @__PURE__ */ new Error("Word helper " + detail.code + ": " + (detail.message ?? "request failed") + (detail.pageCount === void 0 ? "" : " Page count: " + detail.pageCount + ".") + (detail.panes ? " Panes: " + JSON.stringify(detail.panes) : "") + (selection ? " Call word_list_documents, then word_select_document with a pane sessionId." : ""));
}
/** Evaluate one expression in the document-bound Word taskpane. */
async function evaluate(config, code, signal, target) {
	return (await requestHelper(config, "/eval", {
		code,
		...target === void 0 ? {} : { target }
	}, signal)).value ?? null;
}
/** Quote model arguments as data rather than evaluating their contents as source code. */
function clientCallExpression(clientName, args = {}, options = {}) {
	return "(async()=>{if(!globalThis.WordClientRuntime) throw new Error(\"Word client runtime is not loaded. Open the Word Helper add-in.\");return await globalThis.WordClientRuntime.call(" + JSON.stringify(clientName) + "," + JSON.stringify(args) + "," + JSON.stringify(options) + ");})()";
}
//#endregion
//#region plugins-src/word/src/files.ts
/** Insert bytes into Word without exposing a Windows-local file path. */
function imageExpression(base64, where, size) {
	return "(async()=>{return await Word.run(async ctx=>{const target=" + (where === "selection" ? "ctx.document.getSelection()" : "ctx.document.body") + ";const image=target.insertInlinePictureFromBase64(" + JSON.stringify(base64) + "," + JSON.stringify(where === "documentStart" ? "Start" : where === "selection" ? "Replace" : "End") + ");const size=" + JSON.stringify(size) + ";image.lockAspectRatio=!(size.width!==undefined && size.height!==undefined);if(size.width!==undefined)image.width=size.width;if(size.height!==undefined)image.height=size.height;await ctx.sync();image.load(\"width,height\");await ctx.sync();return {inserted:true,width:image.width,height:image.height};});})()";
}
/** Load binary inputs privately; caller arguments retain only DSH file paths. */
async function officeCode(args, signal) {
	if (args.files === void 0) return args.code;
	if (args.files === null || typeof args.files !== "object" || Array.isArray(args.files)) throw new Error("files must map JavaScript identifiers to absolute file paths on the DSH machine");
	const entries = [];
	for (const [identifier, filePath] of Object.entries(args.files)) {
		if (!/^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(identifier)) throw new Error("Invalid files identifier: " + identifier + "; expected JavaScript identifier syntax");
		if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new Error("files." + identifier + " must be an absolute file path on the DSH machine");
		let data;
		try {
			data = await readFile(filePath, { signal });
		} catch (error) {
			throw new Error("Cannot read files." + identifier + " at " + filePath + ": " + error.message, { cause: error });
		}
		entries.push([identifier, data.toString("base64")]);
	}
	return "const files = Object.fromEntries(" + JSON.stringify(entries) + ");\n" + args.code;
}
//#endregion
//#region plugins-src/word/src/schemas.ts
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
//#region plugins-src/word/src/zotero.ts
function registerZoteroTools(add, config, evaluateNow, targetBody) {
	const zoteroPosition = {
		anchor_text: {
			type: "string",
			description: "Unique document text used as the insertion anchor."
		},
		position: {
			type: "string",
			enum: [
				"before",
				"after",
				"replace",
				"end",
				"selection"
			],
			description: "Placement relative to anchor_text, document end, or the current selection."
		}
	};
	const zoteroRefresh = {
		type: "boolean",
		description: "Refresh with Zotero after the change; defaults to true."
	};
	const zoteroStyle = {
		type: "string",
		description: "Zotero CSL style ID. Required for a citation in a document without Zotero preferences; existing preferences are preserved."
	};
	const zoteroStatus = " Returns document, compact fields (kind/text/start, citationID/uris for citations), preferences, refreshTriggered and pendingFormatting. refreshTriggered means the official macro was dispatched, not that formatting finished. pendingFormatting detects blank or placeholder results, not style-update completion. Call word_zotero_inspect to read back the expected formatted text. After a timeout inspect before retrying; writes are never automatically replayed.";
	const zotero = (action, properties, required, description) => add("word_zotero_" + action, description + zoteroStatus, properties, required, objectSchema, async (args, exec) => {
		const documentUrl = await evaluateNow("(Office.context.document.url || \"\")", exec);
		const payload = {
			...args,
			action,
			documentUrl,
			...targetBody(exec)
		};
		if (action === "insert_citation" || action === "insert_bibliography" || action === "set_style") payload.refresh = args.refresh ?? true;
		return requestHelper(config, "/word/zotero", payload, exec.signal);
	});
	zotero("insert_citation", {
		items: {
			type: "array",
			description: "Real Zotero item URIs and CSL-JSON read from the existing Zotero MCP; never invent metadata or guess local itemID/libraryID.",
			items: {
				type: "object",
				properties: {
					uri: { type: "string" },
					itemData: {
						type: "object",
						additionalProperties: true
					},
					locator: { type: "string" },
					label: { type: "string" },
					prefix: { type: "string" },
					suffix: { type: "string" },
					suppressAuthor: { type: "boolean" }
				},
				required: ["uri", "itemData"],
				additionalProperties: false
			}
		},
		...zoteroPosition,
		style_id: zoteroStyle,
		refresh: zoteroRefresh
	}, ["items"], "Insert a native Zotero citation into the taskpane-bound Word document. Supply real item data from Zotero MCP. The helper requires style_id when the document has no Zotero preferences and preserves existing preferences. Does not automate the Add/Edit Citation picker.");
	zotero("insert_bibliography", {
		...zoteroPosition,
		refresh: zoteroRefresh
	}, [], "Insert a native Zotero bibliography into the taskpane-bound Word document.");
	zotero("refresh", {}, [], "Refresh native Zotero citations and bibliography in the taskpane-bound Word document.");
	zotero("inspect", {}, [], "Inspect native Zotero fields and document preferences in the taskpane-bound Word document without inserting fields. Use this after uncertain or timed-out writes.");
	zotero("set_style", {
		style_id: zoteroStyle,
		refresh: zoteroRefresh
	}, ["style_id"], "Set the native Zotero CSL style for the taskpane-bound Word document.");
}
//#endregion
//#region plugins-src/word/src/images.ts
function registerImageTools(add, ctx, config, hideOnce, targetBody, evaluateNow) {
	add("word_render_page", "Render one page of the current Word document and return PNG directly for visual inspection. page is one-based. The Windows helper exports and rasterizes the selected document; no PDF renderer is needed on the DSH machine. Returns pageCount with the image; does not call a reviewer model.", { page: {
		type: "integer",
		description: "One-based page number in the paginated Word document."
	} }, ["page"], {
		type: "object",
		properties: {
			page: { type: "integer" },
			pageCount: { type: "integer" },
			image: imageSchema
		},
		required: [
			"page",
			"pageCount",
			"image"
		],
		additionalProperties: false
	}, async (args, exec) => {
		if (!Number.isSafeInteger(args.page) || args.page < 1) throw new Error("page must be a positive one-based integer");
		await hideOnce(exec);
		const rendered = await requestHelper(config, "/word/render", {
			page: args.page,
			longEdge: config.renderLongEdge,
			...targetBody(exec)
		}, exec.signal);
		const data = Buffer.from(rendered.base64, "base64");
		const image = await ctx.attachments.saveImage({
			data,
			mediaType: rendered.mimeType,
			name: "word-page-" + args.page + ".png"
		});
		return {
			page: args.page,
			pageCount: rendered.pageCount,
			image: {
				...image,
				attachmentId: String(image.attachmentId)
			}
		};
	}, (_args, value) => [{
		type: "text",
		text: JSON.stringify({
			page: value.page,
			pageCount: value.pageCount,
			width: value.image.width,
			height: value.image.height
		})
	}, {
		type: "image",
		attachment: value.image
	}]);
	add("word_insert_image", "Insert an inline image into Word from required filePath on the DSH machine; no Windows path is required. where defaults to documentEnd; selection replaces the selected range. Sizes are points.", {
		filePath: { type: "string" },
		where: {
			type: "string",
			enum: [
				"documentStart",
				"documentEnd",
				"selection"
			]
		},
		width: { type: "number" },
		height: { type: "number" }
	}, ["filePath"], objectSchema, async (args, exec) => {
		if (typeof args.filePath !== "string" || !args.filePath) throw new Error("filePath is required on the DSH machine");
		const base64 = (await readFile(args.filePath, { signal: exec.signal })).toString("base64");
		for (const key of ["width", "height"]) if (args[key] !== void 0 && (!Number.isFinite(args[key]) || args[key] <= 0)) throw new Error(key + " must be positive");
		return evaluateNow(imageExpression(base64, args.where ?? "documentEnd", {
			width: args.width,
			height: args.height
		}), exec);
	});
}
//#endregion
//#region plugins-src/word/src/apply.ts
var inject = [
	"tools",
	"skills",
	"attachments"
];
/** Register static tools and a catalog-backed skill provider; serialize document operations. */
function apply(ctx, config) {
	let tail = Promise.resolve();
	const selections = /* @__PURE__ */ new Map();
	const hidden = /* @__PURE__ */ new Set();
	const sessionKey = (exec) => exec.agent?.session?.id ?? null;
	const selected = (exec) => selections.get(sessionKey(exec));
	const targetBody = (exec) => selected(exec) === void 0 ? {} : { target: selected(exec) };
	const panes = (exec) => requestHelper(config, "/panes", void 0, exec.signal);
	const paneKey = async (exec) => {
		if (selected(exec) !== void 0) return selected(exec);
		const data = await panes(exec);
		return data.panes.length === 1 ? data.panes[0].sessionId : void 0;
	};
	const serial = (fn) => {
		const result = tail.then(fn);
		tail = result.catch(() => {});
		return result;
	};
	const hideOnce = async (exec) => {
		if (config.autoHide) {
			const key = await paneKey(exec);
			if (!hidden.has(key)) {
				await evaluate(config, "(async()=>{await Office.addin.hide();return true;})()", exec.signal, selected(exec));
				hidden.add(key);
			}
		}
	};
	const evaluateNow = async (code, exec) => {
		await hideOnce(exec);
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
	add("word_list_documents", "List connected Word documents with pane sessionId, label, documentUrl and connectedAt, plus selectedTarget for this DSH session (null when unset).", {}, [], objectSchema, async (_args, exec) => ({
		...await panes(exec),
		selectedTarget: selected(exec) ?? null
	}));
	add("word_select_document", "Select a connected Word document for subsequent tools in this DSH session. Use a sessionId from word_list_documents; a disconnected target is never replaced automatically.", { target: {
		type: "string",
		description: "Pane sessionId from word_list_documents."
	} }, ["target"], objectSchema, async (args, exec) => {
		const data = await panes(exec);
		if (!data.panes.some((pane) => pane.sessionId === args.target)) throw paneError({
			code: "target-not-found",
			message: "The requested Word taskpane is not connected.",
			panes: data.panes
		});
		selections.set(sessionKey(exec), args.target);
		return {
			...data,
			selectedTarget: args.target
		};
	});
	register("word_execute_office_js", officeTool.description, officeTool.parameters, jsonSchema, async (args, exec) => evaluateNow(clientCallExpression("execute_office_js", args.files === void 0 ? args : { code: await officeCode(args, exec.signal) }), exec));
	const staticNames = new Set([
		"execute_office_js",
		"list_documents",
		"select_document",
		"pane_visibility",
		"insert_image",
		"render_page",
		"zotero_insert_citation",
		"zotero_insert_bibliography",
		"zotero_refresh",
		"zotero_inspect",
		"zotero_set_style"
	]);
	const catalog = startCatalog(ctx, "Word", config, (signal) => requestHelper(config, "/catalog", void 0, signal), (tools) => catalogDefinitions(tools.filter((tool) => tool.clientName !== "execute_office_js")).map((tool) => {
		if (staticNames.has(tool.clientName)) throw new Error("Word catalog conflicts with a DSH-owned tool: " + tool.clientName);
		return makeTool("word_" + tool.clientName, tool.description, tool.inputSchema, jsonSchema, async (input, exec) => {
			const args = input;
			const options = tool.clientName === "edit_doc_list" && args.action === "create_list" ? { listStyles: await requestHelper(config, "/word/list-styles" + (selected(exec) === void 0 ? "" : "?target=" + encodeURIComponent(selected(exec))), void 0, exec.signal) } : {};
			return evaluateNow(clientCallExpression(tool.clientName, args, options), exec);
		});
	}));
	registerZoteroTools(add, config, evaluateNow, targetBody);
	add("word_pane_visibility", "Hide or show the Word taskpane without closing its document runtime.", { visible: { type: "boolean" } }, ["visible"], objectSchema, async (args, exec) => {
		const key = await paneKey(exec);
		const result = await evaluate(config, "(async()=>{await Office.addin." + (args.visible ? "showAsTaskpane" : "hide") + "();return {visible:" + args.visible + "};})()", exec.signal, selected(exec));
		hidden.add(key);
		return result;
	});
	registerImageTools(add, ctx, config, hideOnce, targetBody, evaluateNow);
	const summary = {
		provider: name,
		source: "bundled",
		invocation: {
			modelInvocable: true,
			userInvocable: true
		}
	};
	ctx.effect(() => ctx.skills.registerProvider(() => ({
		name,
		list: async () => {
			const skill = catalog.current()?.skill;
			return skill ? [{
				...summary,
				name: skill.name,
				description: skill.description,
				rank: 600,
				locator: "catalog"
			}] : [];
		},
		get: async () => {
			const skill = catalog.current()?.skill;
			if (!skill) throw new Error("Word skill unavailable: helper catalog has no skill");
			return {
				...summary,
				...skill
			};
		}
	})));
}
//#endregion
export { Config, apply, clientCallExpression, evaluate, imageExpression, inject, name };
