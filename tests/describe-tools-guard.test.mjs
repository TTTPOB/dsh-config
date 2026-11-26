import assert from "node:assert/strict";
import test from "node:test";
import * as Plugin from "../plugins/describe-tools-guard.mjs";

const search = {
  name: "fixture_search", description: "Search the fixture catalog.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  output: { type: "array", items: { type: "string" } },
};
const fetch = { ...search, name: "fixture_fetch" };
const text = value => ({ type: "text", text: value });
const disclose = (...entries) => JSON.stringify({ tools: entries }, null, 2);
const exchange = (name, printed, { id = name, isError = false } = {}) => [
  { role: "assistant", content: [{ type: "tool-call", id, name }] },
  { role: "tool", toolCallId: id, content: [text(printed)], isError },
];
const history = (visible, logged = visible) => ({
  deriveMessages: () => visible,
  snapshotEvents: () => logged.map(message => ({ type: "tool/result", data: { message } })),
});

async function call(names, session, { parent, current = [search, fetch] } = {}) {
  const listeners = new Map();
  const toolSet = {};
  const agent = { session };
  Plugin.apply({
    on(event, handler) { listeners.set(event, handler); },
    tools: { executable(name, scope, admission) {
      assert.equal(scope, agent);
      assert.equal(admission, toolSet);
      const entry = current.find(entry => entry.name === name);
      if (entry) return { ...entry, output: { schema: entry.output } };
    } },
  });
  const exec = { name: "describe_tools", arguments: { names }, agent, toolSet, parent };
  const dispatched = [];
  const allow = async () => {
    dispatched.push(exec.arguments);
    return { isError: false, value: { tools: names.map(name => current.find(entry => entry.name === name)) } };
  };
  const dispatchedResult = await listeners.get("tools/execute")(exec, allow);
  // Like ToolRuntime, render the canonical value before invoking post-execute.
  const result = { ...dispatchedResult, content: [text(JSON.stringify(dispatchedResult.value))] };
  const decision = await listeners.get("tools/post-execute")(exec, result, async () => ({ kind: "accept" }));
  return { ...result, ...decision, dispatched };
}

function assertPass(result, names) {
  assert.deepEqual(result.dispatched, [{ names }]);
  assert.equal(result.additionalContexts, undefined);
}

function assertReuse(block, names) {
  assert.ok(block.text.startsWith(`Already described in context: ${names.join(", ")}.`));
  assert.match(block.text, /use those schemas.*compacted away/i);
}

test("unchanged descriptions from earlier Native calls short-circuit the entire batch", async () => {
  const earlier = [...exchange("describe_tools", disclose(fetch)),
    ...exchange("describe_tools", disclose(search), { id: "another-describe" })];
  const names = [search.name, fetch.name];
  const result = await call(names, history(earlier));
  assert.deepEqual(result.dispatched, []);
  assert.equal(result.isError, false);
  assertReuse(result.content[0], names);
});

test("a subset of an earlier Native batch can reuse its full description", async () => {
  const result = await call([search.name], history(exchange("describe_tools", disclose(search, fetch))));
  assert.deepEqual(result.dispatched, []);
  assertReuse(result.content[0], [search.name]);
});

test("partial overlap dispatches all names unchanged", async () => {
  const names = [search.name, fetch.name];
  const result = await call(names, history(exchange("describe_tools", disclose(search))));
  assertPass(result, names);
  assert.deepEqual(result.value.tools, [search, fetch]);
});

test("the search catalog is not an initial description", async () => {
  const names = [search.name];
  const catalog = JSON.stringify({ matches: [{ name: search.name, description: search.description }] });
  assertPass(await call(names, history(exchange("search_tools", catalog))), names);
});

test("a compacted description does not count even if it remains in the log", async () => {
  const names = [search.name];
  const summary = { role: "user", source: { kind: "compact-checkpoint" }, content: [text(`Described ${search.name}.`)] };
  assertPass(await call(names, history([summary], exchange("describe_tools", disclose(search)))), names);
});

for (const [field, value] of Object.entries({
  description: "Revised help text.", parameters: { type: "object" }, output: { type: "string" },
})) {
  test(`a changed ${field} dispatches the current description`, async () => {
    const names = [search.name];
    const before = history(exchange("describe_tools", disclose(search)));
    const revised = { ...search, [field]: value };
    const result = await call(names, before, { current: [revised] });
    assertPass(result, names);
    assert.deepEqual(result.value.tools, [revised]);
  });
}

test("a PTC child reuses printed JSON and forwards a notice without requiring the program to print it", async () => {
  const printed = `Looking up a schema\n${disclose(search)}\nFinished`;
  const names = [search.name];
  const result = await call(names, history(exchange("run_code", printed)), { parent: Symbol("run_code") });
  assert.deepEqual(result.dispatched, []);
  assert.equal(result.isError, false);
  assert.deepEqual(result.value.tools, []);
  const [notice] = result.additionalContexts;
  assert.equal(notice.role, "user");
  assert.equal(notice.source.kind, Plugin.name);
  assertReuse(notice.content[0], names);
});

test("a compact PTC return of selected descriptors remains reusable", async () => {
  const names = [search.name, fetch.name];
  const printed = JSON.stringify([search, fetch]);
  const result = await call(names, history(exchange("run_code", printed)));
  assert.deepEqual(result.dispatched, []);
  assertReuse(result.content[0], names);
});

test("a PTC print missing the output schema is not a description", async () => {
  const names = [search.name];
  const { output: _output, ...inputOnly } = search;
  assertPass(await call(names, history(exchange("run_code", disclose(inputOnly)))), names);
});

test("a PTC dispatch never printed by the parent is not visible", async () => {
  const names = [search.name];
  const logged = exchange("describe_tools", disclose(search));
  const visible = exchange("run_code", "(run_code completed with no output)");
  assertPass(await call(names, history(visible, logged), { parent: Symbol("run_code") }), names);
});

test("identical-looking output from an unrelated tool does not count", async () => {
  const names = [search.name];
  assertPass(await call(names, history(exchange("read", disclose(search)))), names);
});
