import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as Plugin from "../plugins/runtime-tooling-guidance.mjs";

test("validates only six literal wording overrides", () => {
  const validate = Plugin.Config["~standard"].validate;
  assert.deepEqual(validate({}).value.text, Plugin.DEFAULT_TEXT);
  assert.equal(validate({ text: { native: "{{literal}}" } }).value.text.native, "{{literal}}");
  for (const input of [null, [], { text: null }, { text: "x" }, { text: { typo: "x" } },
    { text: { native: " " } }, { text: { child: 1 } }, { rules: [] }]) assert.ok(validate(input).issues);
});

test("installed Loader selects fresh runtime capabilities without changing tools or SDK", {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const persona = createRequire(runtime.resolve("@deepseek-ai/dsh-persona"));
  const load = async (resolver, name) => import(pathToFileURL(resolver.resolve(name)).href);
  const { Context, Service } = await load(runtime, "@deepseek-ai/cordis");
  const { default: Loader } = await load(runtime, "@deepseek-ai/cordis-plugin-loader");
  const { default: Include } = await load(runtime, "@deepseek-ai/cordis-plugin-include");
  const { default: SystemPrompt, renderPrompt } = await load(persona, "@deepseek-ai/dsh-system-prompt");
  const { createScope } = await load(persona, "@deepseek-ai/dsh-scope");
  const { default: Tools, defineTool } = await load(runtime, "@deepseek-ai/dsh-tools");
  const resolver = createRequire(runtime.resolve("@deepseek-ai/dsh-tools"));
  const { PtcRuntime } = await load(resolver, "@deepseek-ai/dsh-ptc-runtime");
  const { default: Agents } = await load(runtime, "@deepseek-ai/dsh-agent");
  const { default: Sessions } = await load(runtime, "@deepseek-ai/dsh-session");
  const subagentResolver = createRequire(runtime.resolve("@deepseek-ai/dsh-subagent"));
  const { default: SessionProjections } = await load(subagentResolver, "@deepseek-ai/dsh-session-projection");
  const { default: Subagents, SUBAGENT_DESCRIPTOR_VERSION } = await load(runtime, "@deepseek-ai/dsh-subagent");
  class AssemblyRuntime extends PtcRuntime {
    language = "typescript";
    isolation = "test";
    run() { throw new Error("No code execution in assembly tests"); }
  }
  class DirectoryFixture extends Service {
    constructor(ctx) { super(ctx, "workingDirectory"); }
  }
  const directory = mkdtempSync(join(tmpdir(), "runtime-guidance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(Tools, { mode: "native" });
  await ctx.plugin(AssemblyRuntime);
  await ctx.plugin(Sessions);
  await ctx.plugin(Agents);
  await ctx.plugin(SessionProjections);
  await ctx.plugin(DirectoryFixture);
  await ctx.plugin(Subagents, {});
  const disposers = {};
  function register(name, parameters = {}) {
    disposers[name] = ctx.tools.register(defineTool({
      name, description: "Fixture " + name, parameters,
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute() { throw new Error("No tool execution in assembly tests"); },
    }));
  }
  register("edit");
  register("bash", { run_in_background: { type: "boolean" } });
  for (const name of ["job_output", "job_kill"]) register(name, { job_id: { type: "string", required: true } });
  register("send_message", { agent_id: { type: "string", required: true }, message: { type: "string", required: true } });
  // Agent handles and model options are fixtures; no Host or model request is started.
  async function agent(id, header = {}, options = {}) {
    const key = {};
    let scope;
    await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key); }, { inject: ["systemPrompt", "tools"] }));
    const session = ctx.sessions.create(id, { meta: header, ...options });
    return { id, ctx: scope.ctx, scope, key, session, options: { provider: "same-mocked-provider", model: "mock" } };
  }
  const root = await agent("root-named-subagent");
  await ctx.agents.enter(root, undefined);
  const child = await agent("child", { parentSession: root.id, origin: "subagent" });
  await ctx.agents.enter(child, root);
  child.session.append("subagent/descriptor", { version: SUBAGENT_DESCRIPTOR_VERSION, mode: "continuable", provider: "fixture", label: "child" });
  const assemble = (agent = root) => ctx.systemPrompt.assemble({ scope: agent.key, agent });
  const before = await assemble();
  let baselineMode = child.ctx.tools.presentAs("ptc");
  const beforeTs = await assemble(child);
  ctx.ptcRuntime.language = "python";
  const beforePython = await assemble(child);
  ctx.ptcRuntime.language = "typescript";
  baselineMode();
  const modulePath = join(directory, "runtime-tooling-guidance.mjs");
  copyFileSync(new URL("../plugins/runtime-tooling-guidance.mjs", import.meta.url), modulePath);
  const yaml = join(directory, "cordis.yml");
  const wording = Object.fromEntries(Object.keys(Plugin.DEFAULT_TEXT).map(key => [key, "selected:" + key + " {{literal}}"]));
  writeFileSync(yaml, JSON.stringify([{ id: Plugin.name, name: pathToFileURL(modulePath).href, config: { text: wording } }]));
  const mounted = await ctx.plugin(Include, { path: pathToFileURL(yaml).href });
  const guidance = assembly => assembly.sections.find(row => row.name === Plugin.SECTION)?.text ?? "";
  function selected(assembly, keys) {
    const text = guidance(assembly);
    for (const key of Object.keys(wording)) assert.equal(text.includes(wording[key]), keys.includes(key), key + " in " + text);
    assert.equal(assembly.sections.filter(row => row.name === Plugin.SECTION).length, keys.length ? 1 : 0);
  }
  const native = await assemble();
  selected(native, ["native", "background"]);
  assert.deepEqual(native.tools, before.tools);
  assert.deepEqual(native.sections.filter(row => row.name !== Plugin.SECTION), before.sections);
  selected(await assemble(child), ["native", "background", "child"]);
  for (let i = 0; i < 3; i++) assert.deepEqual(await assemble(), native);
  let mode = child.ctx.tools.presentAs("ptc");
  const ts = await assemble(child);
  selected(ts, ["typescript", "output", "background", "child"]);
  assert.deepEqual(ts.tools.map(row => row.name), ["run_code"]);
  assert.deepEqual(ts.tools, beforeTs.tools);
  assert.deepEqual(ts.sections.filter(row => row.name !== Plugin.SECTION), beforeTs.sections);
  assert.ok(ts.sections.find(row => row.name === "tools:sdk").text.includes("send_message"));
  ctx.ptcRuntime.language = "python";
  const python = await assemble(child);
  selected(python, ["python", "output", "background", "child"]);
  assert.ok(!guidance(python).includes("Promise.all"));
  assert.deepEqual(python.tools, beforePython.tools);
  assert.deepEqual(python.sections.filter(row => row.name !== Plugin.SECTION), beforePython.sections);
  ctx.ptcRuntime.language = "typescript";
  assert.deepEqual(await assemble(child), ts);
  mode();
  selected(await assemble(child), ["native", "background", "child"]);
  const descriptor = mode => ({ version: SUBAGENT_DESCRIPTOR_VERSION, mode, provider: "fixture", label: "fixture" });
  const oneShot = await agent("one-shot", { parentSession: root.id, origin: "subagent" });
  oneShot.session.append("subagent/descriptor", descriptor("one-shot"));
  selected(await assemble(oneShot), ["native", "background"]);
  const orphan = await agent("orphan", { parentSession: "unreachable", origin: "subagent" });
  orphan.session.append("subagent/descriptor", descriptor("continuable"));
  selected(await assemble(orphan), ["native", "background"]);
  const seed = child.session.snapshotEvents();
  const inherited = await agent("fork-with-ancestor-identity", { parentSession: root.id, isSeeded: true },
    { seed, inheritedEventCount: seed.length });
  selected(await assemble(inherited), ["native", "background"]);
  const shadow = (name, parameters) => child.ctx.tools.register(defineTool({
    name, description: "Same name without the required capability", parameters,
    output: { schema: { type: "string" }, render: () => [] },
    execute() { throw new Error("No execution"); },
  }));
  const noBackgroundParameter = shadow("bash", {});
  selected(await assemble(child), ["native", "child"]);
  noBackgroundParameter();
  const noJobId = shadow("job_output", {});
  selected(await assemble(child), ["native", "child"]);
  noJobId();
  const noMessagingParameters = shadow("send_message", {});
  selected(await assemble(child), ["native", "background"]);
  noMessagingParameters();
  const hideBackground = child.ctx.tools.restrict({ deny: ["bash"] });
  selected(await assemble(child), ["native", "child"]);
  hideBackground();
  const restrict = child.ctx.tools.restrict({ deny: ["job_kill", "send_message"] });
  selected(await assemble(child), ["native"]);
  const restrictedMode = child.ctx.tools.presentAs("ptc");
  selected(await assemble(child), ["typescript", "output"]);
  restrictedMode(); restrict();
  const complete = child.ctx.systemPrompt.section({ name: "complete", order: 0, complete: true, interpolate: false, text: "authoritative" });
  assert.equal(renderPrompt(await assemble(child)), "authoritative");
  complete();
  const hideSdk = child.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const value = await next();
    return { ...value, sections: value.sections.filter(row => row.name !== "tools:sdk") };
  });
  mode = child.ctx.tools.presentAs("ptc");
  selected(await assemble(child), []);
  hideSdk(); mode();
  const hideAll = root.ctx.tools.restrict({ deny: Object.keys(disposers) });
  selected(await assemble(), []);
  hideAll();
  await mounted.dispose();
  assert.deepEqual(await assemble(), before);
  selected(await assemble(child), []);
});
