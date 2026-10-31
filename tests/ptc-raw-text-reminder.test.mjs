import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as Plugin from "../plugins/ptc-raw-text-reminder.mjs";

const defaults = Plugin.Config["~standard"].validate({}).value;
const complex = 'const text = "a\\nb\\nc";';
const detect = code => Plugin.detectComplexText(code);

function listener(config = defaults) {
  let hook;
  Plugin.apply({ on(name, fn) { assert.equal(name, "tools/post-execute"); hook = fn; } }, config);
  return hook;
}
const exec = code => ({ name: "run_code", arguments: { code } });
const success = { value: "ok", content: [{ type: "text", text: "ok" }] };
const failure = text => ({ isError: true, error: { message: text }, content: [{ type: "text", text }] });

test("configuration defaults and validation", () => {
  assert.deepEqual(defaults, Plugin.DEFAULTS);
  const validate = Plugin.Config["~standard"].validate;
  for (const input of [null, [], { unknown: true }, { enabled: 1 }, { newlineEscapeThreshold: 0 }, { escapedQuoteLengthThreshold: 1.5 }, { successText: " " }]) assert.ok(validate(input).issues);
  assert.equal(validate({ enabled: false, failureText: "custom" }).value.failureText, "custom");
  assert.equal(Plugin.detectComplexText(complex, { ...defaults, newlineEscapeThreshold: 3 }).length, 0);
  assert.equal(Plugin.detectComplexText('"a\\\"b"', { ...defaults, escapedQuoteLengthThreshold: 3 }).length, 1);
});

test("detects each escaped-text idiom with decoded values and source lines", () => {
  assert.equal(detect("\n" + complex)[0].line, 2);
  assert.equal(detect(complex)[0].value, "a\nb\nc");
  assert.equal(detect('"' + "a".repeat(81) + '\\"b"').length, 1);
  assert.equal(detect("'" + "a".repeat(81) + "\\'b'").length, 1);
  assert.equal(detect('`a\\`b`')[0].value, "a`b");
  assert.equal(detect('`a\\${b}`')[0].value, "a${b}");
  assert.equal(detect('["a", "b",].join("\\n")')[0].value, "a\nb");
  assert.equal(detect("['a', 'b'].join('\\n')")[0].value, "a\nb");
  assert.equal(detect('String.raw`a\\n`')[0].value, "a\\n");
  assert.equal(detect('String /* gap */ . raw`hi`').length, 1);
});

test("ignores ordinary literals, comments, regexes and existing raw literals", () => {
  for (const code of [
    '"short"', '"a\\nb"', '"a\\\\nb\\\\nc"', '"a\\\"b"',
    '// "a\\nb\\nc"\nreturn 1;', '/* String.raw`hi` */',
    'const regex = /a\\nb\\nc/;', 'const regex = /@``/;',
    'const literal = "@``";', '// @``\n' + complex,
    'const text = @``\n"a\\nb\\nc"\n``;',
    'const text = @```\n`` and ```` and String.raw`hi`\n```;',
    '[value, "b"].join("\\n")', '["a", "b"].join(",")',
  ]) {
    const expected = code.startsWith('// @') ? 1 : 0;
    assert.equal(detect(code).length, expected, code);
  }
  const raw = '@``\r\nhello\n``;\n' + complex;
  const masked = Plugin.maskRawLiterals(raw);
  assert.equal(masked.length, raw.length);
  assert.deepEqual(masked.match(/[\r\n]/g), raw.match(/[\r\n]/g));
  assert.equal(detect(raw)[0].line, 4);
});

test("decodes common escapes without executing expressions", () => {
  assert.equal(Plugin.decodeLiteral('"\\n\\t\\r\\\\\\\"\\\'\\`\\x41\\u0042\\u{1f600}"'), "\n\t\r\\\"'`AB😀");
  for (const code of ['"\\q"', '"\\xGG"', '"\\u{110000}"', '`a${code}`', '"unterminated']) assert.equal(Plugin.decodeLiteral(code), undefined);
  assert.equal(detect('["\\q", "b"].join("\\n")')[0].value, undefined);
});

test("renders safe delimiters and bounded previews", () => {
  assert.equal(Plugin.renderRawLiteral("plain"), '@``\nplain``');
  assert.equal(Plugin.renderRawLiteral('```code```'), '@````\n```code```\n````');
  assert.equal(Plugin.renderRawLiteral("a\nb\nc\nd"), '@``\na\nb\nc`` (truncated)');
  assert.equal(Plugin.renderRawLiteral("a".repeat(301)), '@``\n' + "a".repeat(300) + '`` (truncated)');
});

test("uncertain decoding skips the preview and failure snippets stay bounded", async () => {
  const call = exec('"\\q\\n\\n"');
  const accepted = await listener()(call, success, async () => ({ kind: "accept" }));
  assert.equal(accepted.additionalContexts[0].content[0].text.includes("\n"), false);
  const preserved = { id: "downstream" };
  const blocked = { kind: "block", feedback: [{ type: "text", text: "blocked" }], additionalContexts: [preserved] };
  const result = await listener()(exec('"' + "a".repeat(100) + '\\n\\n"'), failure("ENOENT"), async () => blocked);
  assert.equal(result.kind, "block");
  assert.equal(result.feedback, blocked.feedback);
  assert.equal(result.additionalContexts[0], preserved);
  const message = result.additionalContexts[1].content[0].text;
  assert.equal(message.slice(message.indexOf("Line 1: ") + 8).length, 80);
  assert.equal(Plugin.renderRawLiteral("a\rb\rc\rd"), '@``\na\rb\rc`` (truncated)');
});

test("root-only and enabled filtering always delegates exactly once", async () => {
  for (const [call, config] of [
    [{ ...exec(complex), parent: Symbol("parent") }, defaults],
    [{ ...exec(complex), name: "write" }, defaults],
    [exec("return 1;"), defaults], [exec(complex), { ...defaults, enabled: false }],
  ]) {
    let calls = 0;
    const decision = { kind: "accept" };
    assert.equal(await listener(config)(call, success, async () => { calls++; return decision; }), decision);
    assert.equal(calls, 1);
  }
});

test("success preserves accept/block decisions and contexts, adds valid fresh messages every time", async () => {
  for (const downstream of [
    { kind: "accept", value: "replacement", additionalContexts: [{ id: "existing" }] },
    { kind: "accept", content: [{ type: "text", text: "replacement" }] },
    { kind: "block", feedback: [{ type: "text", text: "blocked" }], additionalContexts: [{ id: "existing" }] },
  ]) {
    const hook = listener();
    const invoke = () => hook(exec(complex + '\nString.raw`hi`'), success, async () => downstream);
    const result = await invoke();
    const { additionalContexts, ...decision } = result;
    const { additionalContexts: old, ...expected } = downstream;
    assert.deepEqual(decision, expected);
    assert.deepEqual(additionalContexts.slice(0, -1), old ?? []);
    const message = additionalContexts.at(-1);
    assert.match(message.id, /^[\da-f-]{36}$/);
    assert.equal(message.role, "user");
    assert.deepEqual(message.source, { kind: Plugin.name });
    assert.equal(message.content[0].type, "text");
    assert.ok(message.content[0].text.includes('succeeded; do not rerun it. Line 1'));
    assert.ok(message.content[0].text.includes('@``\na\nb\nc``'));
    assert.ok(message.content[0].text.includes('1 additional hits.'));
    assert.notEqual((await invoke()).additionalContexts.at(-1).id, message.id);
  }
});

test("failure syntax formats trigger; unrelated failures only trigger for complex code", async () => {
  for (const text of ['SyntaxError: Unexpected token', 'SyntaxError at 2:4: Unexpected token', 'code run failed (exception): SyntaxError at 2:4: Unexpected token', 'Unterminated raw string literal', 'strip error\nLocation (JavaScript parse, approximate):\nline']) {
    const result = await listener()(exec('return 1;'), failure(text), async () => ({ kind: "accept" }));
    assert.equal(result.additionalContexts[0].content[0].text, defaults.failureText);
  }
  for (const text of ["Timeout", "ENOENT", "Missing file"]) {
    const downstream = { kind: "accept" };
    assert.equal(await listener()(exec("return 1;"), failure(text), async () => downstream), downstream);
    const result = await listener()(exec(complex), failure(text), async () => downstream);
    assert.match(result.additionalContexts[0].content[0].text, /Line 1: /);
    assert.equal(result.additionalContexts[0].content[0].text.includes("\n"), false);
  }
  const custom = await listener({ ...defaults, failureText: "custom" })(exec("return 1;"), failure("SyntaxError"), async () => ({ kind: "accept" }));
  assert.equal(custom.additionalContexts[0].content[0].text, "custom");
});

test("installed Loader registers and disposes hook; built-in root run_code executes once", { skip: !process.env.DSH_CLI_PACKAGE }, async t => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const load = async name => import(pathToFileURL(runtime.resolve(name)).href);
  const { Context } = await load("@deepseek-ai/cordis");
  const { default: Loader } = await load("@deepseek-ai/cordis-plugin-loader");
  const { default: Include } = await load("@deepseek-ai/cordis-plugin-include");
  const { default: Tools } = await load("@deepseek-ai/dsh-tools");
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  const persona = createRequire(runtime.resolve("@deepseek-ai/dsh-persona"));
  const { default: SystemPrompt } = await import(pathToFileURL(persona.resolve("@deepseek-ai/dsh-system-prompt")).href);
  await ctx.plugin(SystemPrompt, {});
  const toolResolver = createRequire(runtime.resolve("@deepseek-ai/dsh-tools"));
  const { PtcRuntime } = await import(pathToFileURL(toolResolver.resolve("@deepseek-ai/dsh-ptc-runtime")).href);
  let executions = 0;
  class FixtureRuntime extends PtcRuntime {
    language = "typescript";
    isolation = "test";
    resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: null }; }
    async run(spec) { assert.equal(spec.program, complex); executions++; return { logs: [], value: "fixture" }; }
  }
  await ctx.plugin(FixtureRuntime);
  await ctx.plugin(Tools, { mode: "ptc" });
  const dir = mkdtempSync(join(tmpdir(), "ptc-reminder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modulePath = join(dir, "ptc-raw-text-reminder.mjs");
  copyFileSync(new URL("../plugins/ptc-raw-text-reminder.mjs", import.meta.url), modulePath);
  const yaml = join(dir, "cordis.yml");
  writeFileSync(yaml, JSON.stringify([{ id: Plugin.name, name: pathToFileURL(modulePath).href, config: {} }]));
  const mounted = await ctx.plugin(Include, { path: pathToFileURL(yaml).href });
  const run = parent => ctx.tools.execute({ ...exec(complex), arguments: { code: complex, description: "Fixture execution" }, callId: "fixture-call", signal: new AbortController().signal, ...(parent === undefined ? {} : { parent }) });
  const result = await run();
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { logs: [], result: "fixture" });
  assert.equal(result.additionalContexts.length, 1);
  assert.ok(result.additionalContexts[0].content[0].text.includes("do not rerun it"));
  assert.equal(executions, 1);
  assert.equal((await run(Symbol("nested"))).additionalContexts, undefined);
  await mounted.dispose();
  assert.equal((await run()).additionalContexts, undefined);
  assert.equal(executions, 3);
});
