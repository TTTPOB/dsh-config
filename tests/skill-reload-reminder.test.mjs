import assert from "node:assert/strict";
import test from "node:test";
import * as Plugin from "../plugins/skill-reload-reminder.mjs";

const skill = { name: "fixture", provider: "fixture-provider", content: "First instruction.\nSecond instruction." };
const text = value => ({ type: "text", text: value });
const envelope = value => text(
  `<skill_content name="${value.name}">\n<skill_instructions>\n${value.content}\n</skill_instructions>\n</skill_content>`);
const toolMessage = content => ({ role: "tool", content });
const history = (visible, original = visible) => ({
  deriveMessages: () => visible,
  snapshotEvents: () => original.map(message => ({ type: "tool/result", data: { message } })),
});
const successful = value => ({ value, content: [envelope(value)], isError: false });
const accept = { kind: "accept" };

function reload(session, { value = skill, parent, result = successful(value), decision = accept } = {}) {
  let postExecute;
  Plugin.apply({ on(event, handler) {
    assert.equal(event, "tools/post-execute");
    postExecute = handler;
  } });
  const exec = { name: "skill", arguments: { name: value.name }, agent: { session }, parent };
  return postExecute(exec, result, async () => decision);
}

function assertReminder(decision) {
  assert.equal(decision.kind, "accept");
  const message = decision.additionalContexts.at(-1);
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, Plugin.name);
  assert.match(message.content[0].text, /already in context.*reuse/i);
}

test("first load does not mistake the skill catalog for instructions", async () => {
  const catalog = { role: "user", source: { kind: "skill-catalog" }, content: [text(skill.name)] };
  assert.equal(await reload(history([catalog])), accept);
});

test("unchanged native reload appends a reminder without losing earlier accepted context", async () => {
  const downstream = { kind: "accept", additionalContexts: [{ id: "other-plugin-context" }] };
  const result = successful(skill);
  const decision = await reload(history([toolMessage(result.content)]), { result, decision: downstream });
  assertReminder(decision);
  assert.deepEqual(decision.additionalContexts.slice(0, -1), downstream.additionalContexts);
});

test("a compacted load is absent even though the original result is still logged", async () => {
  const summary = { role: "user", source: { kind: "compact-checkpoint" }, content: [text("The fixture skill was loaded.")] };
  assert.equal(await reload(history([summary], [toolMessage([envelope(skill)])])), accept);
});

test("changed instructions are not a duplicate, even when they are a substring of the old output", async () => {
  const session = history([toolMessage([envelope(skill)]), toolMessage([text(skill.content)])]);
  assert.equal(await reload(session, { value: { ...skill, content: "First instruction." } }), accept);
});

test("a PTC subcall detects earlier output containing the full body", async () => {
  assertReminder(await reload(history([toolMessage([text(skill.content)])]), { parent: {} }));
});

test("a PTC subcall detects an earlier returned skill object", async () => {
  assertReminder(await reload(history([toolMessage([text(JSON.stringify(skill, null, 2))])]), { parent: {} }));
});

test("a PTC subcall detects an earlier compact JSON printout", async () => {
  assertReminder(await reload(history([toolMessage([text(JSON.stringify(skill))])]), { parent: {} }));
});

test("a user-invoked skill whose full envelope remains visible also counts", async () => {
  const invocation = { role: "user", source: { kind: "skill-invocation" }, content: [envelope(skill)] };
  assertReminder(await reload(history([invocation])));
});

test("a downstream block is returned unchanged even when the instructions are visible", async () => {
  const decision = { kind: "block", feedback: [text("Policy rejected the result.")] };
  assert.equal(await reload(history([toolMessage([envelope(skill)])]), { decision }), decision);
});
