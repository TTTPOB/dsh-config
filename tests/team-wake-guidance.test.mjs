import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as Plugin from "../plugins/team-wake-guidance.mjs";
import { root, readYaml, renderMachine, validatePatch } from "../scripts/lib.mjs";
import { join } from "node:path";

const start = "Before wait_agent, use list_agents";
const end = "The Lead must wait for required teammates before giving the final answer.";
const policy = { name: "team:policy", text: `Prefix. ${start} synthetic obsolete guidance. ${end} Archive suffix.\n\nOptional model selection.`, order: 7 };

function hook() {
  let callback;
  Plugin.apply({ on(event, handler) {
    assert.equal(event, "system-prompt/assemble");
    callback = handler;
  } });
  return async assembled => {
    let called = false;
    const result = await callback({ sections: [] }, {}, async () => { called = true; return assembled; });
    assert.ok(called, "must transform the downstream assembly");
    return result;
  };
}

const assemble = (...sections) => ({ sections, metadata: "preserved" });

test("Config accepts only an empty object", () => {
  const validate = Plugin.Config["~standard"].validate;
  assert.deepEqual(validate({}).value, {});
  for (const value of [undefined, null, [], "", 1, { text: "override" }]) assert.ok(validate(value).issues);
});

test("without team:policy the downstream result is returned unchanged", async () => {
  const input = assemble({ name: "tools:sdk", text: "wait_agent: unknown upstream description" });
  assert.equal(await hook()(input), input);
});

test("policy replacement preserves prefix, archive/model suffix, section metadata and unrelated sections", async () => {
  const other = { name: "other", text: "untouched" };
  const input = assemble(other, policy);
  const output = await hook()(input);
  assert.equal(output.metadata, input.metadata);
  assert.equal(output.sections[0], other);
  assert.deepEqual(output.sections[1], { ...policy, text: `Prefix.\n\n${Plugin.TEAM_TEXT}\n\nArchive suffix.\n\nOptional model selection.` });
  assert.equal(input.sections[1], policy, "must not mutate the upstream result");
});

test("missing or reversed policy anchors fail loudly", async () => {
  for (const text of ["", start, end, `${end} then ${start}`]) {
    await assert.rejects(hook()(assemble({ ...policy, text })), /team:policy.*update team-wake-guidance/);
  }
});

test("absent, empty and non-wait SDK sections are untouched", async () => {
  for (const sdk of [undefined, { name: "tools:sdk", text: "  " }, { name: "tools:sdk", text: "send_message: (args: unknown) => void;" }]) {
    const output = await hook()(assemble(policy, ...(sdk ? [sdk] : [])));
    if (sdk) assert.equal(output.sections[1], sdk);
  }
});

test("wait_agent binding with an unexpected description fails loudly", async () => {
  await assert.rejects(hook()(assemble(policy, { name: "tools:sdk", text: "/** changed */ wait_agent: (args: unknown) => void;" })), /wait_agent description.*update team-wake-guidance/);
});

test("shared declaration stages and activates the plugin exactly once without changing the target", () => {
  const shared = readYaml(join(root, "shared/defaults.yaml")).localPlugins;
  const declaration = shared.find(row => row.id === Plugin.name);
  assert.ok(declaration);
  const output = renderMachine(join(root, "examples/workstation-machine.yaml"), "team-wake-guidance", undefined, { stage: false });
  const files = output.localPlugins.filter(file => file.id === Plugin.name);
  assert.equal(files.length, 1);
  assert.equal(files[0].source, join(root, "plugins", declaration.module));
  const entries = validatePatch(output.rendered.home).map(row => row.entry).filter(row => row.id === Plugin.name);
  assert.deepEqual(entries, [{ id: declaration.id, name: files[0].path, config: declaration.config }]);
  assert.ok(!output.rendered.web.includes(declaration.module));
});

test("installed Agent Teams policy and wait description remain compatible", {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async () => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const source = readFileSync(runtime.resolve("@deepseek-ai/dsh-experimental-tool-agent-team"), "utf8");
  // Evaluate only the standalone wording function; never mount a Host or execute tools.
  const functionSource = source.match(/function teamPolicy\([^]*?\n\}/)?.[0];
  assert.ok(functionSource, "installed teamPolicy function changed; update the compatibility fixture");
  const teamPolicy = runInNewContext(`(${functionSource})`, {}, { timeout: 1000 });
  const waitLiteral = source.match(/name:\s*["']wait_agent["'],\s*description:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)?.[1];
  assert.ok(waitLiteral, "installed wait_agent declaration changed; update the compatibility fixture");
  const description = runInNewContext(waitLiteral, {}, { timeout: 1000 });
  const otherBinding = "/** send fixture unchanged */ send_message: (args: unknown) => void;";
  for (const interrupt of [false, true]) for (const modelSelection of [false, true]) {
    const original = teamPolicy(interrupt, modelSelection);
    const sdk = `interface ToolArgsMap {\n${otherBinding}\n/** ${description} */\nwait_agent: (args: unknown) => void;\n}`;
    const output = await hook()(assemble({ ...policy, text: original }, { name: "tools:sdk", text: sdk }));
    const prefix = original.slice(0, original.indexOf(start)).trimEnd();
    const suffix = original.slice(original.indexOf(end) + end.length).trimStart();
    assert.equal(output.sections[0].text, `${prefix}\n\n${Plugin.TEAM_TEXT}\n\n${suffix}`);
    assert.equal(output.sections[1].text, sdk.replace(description, Plugin.WAIT_DESCRIPTION));
    assert.ok(output.sections[1].text.includes(otherBinding));
    assert.ok(!output.sections.some(section => section.text.includes("Re-list after wakeup or timeout")));
  }
});
