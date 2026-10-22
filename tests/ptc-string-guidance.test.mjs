import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as Plugin from "../plugins/ptc-string-guidance.mjs";
import { root, readYaml, renderMachine, validatePatch } from "../scripts/lib.mjs";

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "ptc-guidance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validates wording and preserves source-level escaping", () => {
  const validate = Plugin.Config["~standard"].validate;
  assert.equal(validate({}).value.text, Plugin.DEFAULT_TEXT);
  assert.equal(validate({ text: "{{literal}}" }).value.text, "{{literal}}");
  for (const input of [null, [], { text: " " }, { text: 1 }, { unknown: true }]) assert.ok(validate(input).issues);
  const slash = String.fromCharCode(92);
  assert.ok(Plugin.DEFAULT_TEXT.includes('join("' + slash + 'n")'));
  assert.ok(Plugin.DEFAULT_TEXT.includes('quotes as ' + slash + '" and literal backslashes as ' + slash.repeat(2)));
});

test("render stages the module and activation row without writing the target", t => {
  const dir = temporary(t);
  const machine = readYaml(join(root, "examples/local-plugins-machine.yaml"));
  const declaration = machine.localPlugins.find(row => row.id === Plugin.name);
  assert.ok(declaration);
  declaration.modulePath = join(dir, "target/ptc-string-guidance.mjs");
  const input = join(dir, "machine.yaml");
  writeFileSync(input, JSON.stringify(machine));
  const result = renderMachine(input, "ptc-guidance", undefined, { generatedDir: join(dir, "generated") });
  const row = validatePatch(result.rendered.home).find(row => row.entry.id === Plugin.name);
  assert.deepEqual(row.entry, { id: Plugin.name, name: declaration.modulePath, config: {} });
  assert.equal(readFileSync(join(result.output, "plugins/ptc-string-guidance.mjs"), "utf8"), readFileSync(join(root, "plugins/ptc-string-guidance.mjs"), "utf8"));
  assert.equal(existsSync(declaration.modulePath), false);
});

test("installed Loader preserves tools and SDK, gates scopes and language, and disposes guidance", {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const persona = createRequire(runtime.resolve("@deepseek-ai/dsh-persona"));
  const load = async (resolver, name) => import(pathToFileURL(resolver.resolve(name)).href);
  const { Context } = await load(runtime, "@deepseek-ai/cordis");
  const { default: Loader } = await load(runtime, "@deepseek-ai/cordis-plugin-loader");
  const { default: Include } = await load(runtime, "@deepseek-ai/cordis-plugin-include");
  const { default: SystemPrompt, renderPrompt } = await load(persona, "@deepseek-ai/dsh-system-prompt");
  const { createScope } = await load(persona, "@deepseek-ai/dsh-scope");
  const { default: Tools, defineTool } = await load(runtime, "@deepseek-ai/dsh-tools");
  const toolResolver = createRequire(runtime.resolve("@deepseek-ai/dsh-tools"));
  const { PtcRuntime } = await load(toolResolver, "@deepseek-ai/dsh-ptc-runtime");
  class AssemblyRuntime extends PtcRuntime {
    language = "typescript";
    isolation = "test";
    run() { throw new Error("Assembly tests must not execute code"); }
  }
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, { mode: "native" });
  await ctx.plugin(AssemblyRuntime);
  for (const name of ["edit", "send_message"]) {
    ctx.tools.register(defineTool({
      name, description: "Fixture " + name, parameters: {},
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute() { throw new Error("Assembly tests must not execute tools"); },
    }));
  }
  const ptc = { agent: "ptc" }, native = { agent: "native" };
  let scope;
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, ptc); }, { inject: ["tools", "systemPrompt"] }));
  scope.ctx.tools.presentAs("ptc");
  const before = await ctx.systemPrompt.assemble({ scope: ptc });
  const dir = temporary(t);
  const modulePath = join(dir, "ptc-string-guidance.mjs");
  copyFileSync(join(root, "plugins/ptc-string-guidance.mjs"), modulePath);
  const yaml = join(dir, "cordis.yml");
  const wording = Plugin.DEFAULT_TEXT + "\n{{literal}}";
  writeFileSync(yaml, JSON.stringify([{ id: Plugin.name, name: pathToFileURL(modulePath).href, config: { text: wording } }]));
  const mounted = await ctx.plugin(Include, { path: pathToFileURL(yaml).href });
  const assemble = key => ctx.systemPrompt.assemble({ scope: key });
  const after = await assemble(ptc);
  const section = after.sections.find(row => row.name === Plugin.SECTION);
  assert.deepEqual(section, { name: Plugin.SECTION, text: wording, interpolate: false });
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.tools.map(tool => tool.name), ["run_code"]);
  const sdk = after.sections.find(row => row.name === "tools:sdk").text;
  for (const name of ["edit", "send_message"]) assert.ok(sdk.includes(name));
  assert.deepEqual(after.sections.filter(row => row.name !== Plugin.SECTION), before.sections);
  assert.ok(renderPrompt(after).includes("{{literal}}"));
  assert.equal((await assemble(native)).sections.some(row => row.name === Plugin.SECTION), false);
  assert.equal((await ctx.systemPrompt.assemble()).sections.some(row => row.name === Plugin.SECTION), false);
  ctx.ptcRuntime.language = "python";
  assert.equal((await assemble(ptc)).sections.some(row => row.name === Plugin.SECTION), false);
  ctx.ptcRuntime.language = "typescript";
  assert.deepEqual(await assemble(ptc), after);
  const complete = scope.ctx.systemPrompt.section({ name: "test:complete", order: 1, text: "Complete prompt", complete: true });
  assert.equal(renderPrompt(await assemble(ptc)), "Complete prompt");
  complete();
  await mounted.dispose();
  assert.deepEqual(await assemble(ptc), before);
});
