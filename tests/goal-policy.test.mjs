import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as Plugin from '../plugins/goal-policy.mjs';

function mount({ jobs = [], warnings = [], callers = [] } = {}) {
  const listeners = new Map();
  Plugin.apply({
    on(event, listener) { listeners.set(event, listener); },
    jobs: { list(caller) { callers.push(caller); return jobs; } },
    logger: { warn(message) { warnings.push(message); } },
  });
  return {
    preStep(messages, decision) {
      return listeners.get('agent/pre-step')({ agent: { session: { id: 'fixture-session' } }, messages }, async () => decision);
    },
    assemble(assembly) {
      return listeners.get('system-prompt/assemble')({ sections: [] }, {}, async () => assembly);
    },
  };
}

const message = source => ({ id: 'input', role: 'user', content: [{ type: 'text', text: 'Continue work' }], source });
const goalRound = message({ kind: 'goal', goalId: 'goal-1', revision: 4, round: 2 });
const enter = (...messages) => ({ kind: 'enter', messages });
const jobs = [
  { id: 'job-alpha', label: 'Compile fixture', status: 'running' },
  { id: 'job-beta', label: 'Check fixture', status: 'running' },
  { id: 'job-stopping', label: 'Interrupted fixture', status: 'stopping' },
  { id: 'job-done', label: 'Finished fixture', status: 'completed' },
];

test('accepts an empty config and rejects extra keys and non-objects', () => {
  const { validate } = Plugin.Config['~standard'];
  assert.deepEqual(validate({}).value, {});
  for (const invalid of [{ text: 'override' }, [], null, true]) assert.ok(validate(invalid).issues);
});

test('does not check jobs for human input or goal round zero', async () => {
  const callers = [];
  const { preStep } = mount({ jobs, callers });
  for (const source of [{ kind: 'human' }, { ...goalRound.source, round: 0 }]) {
    const submitted = message(source);
    const decision = enter(submitted);
    assert.equal(await preStep([submitted], decision), decision);
  }
  assert.deepEqual(callers, []);
});

test('returns the downstream goal decision unchanged when no job is running', async () => {
  const { preStep } = mount({ jobs: jobs.filter(job => job.status !== 'running') });
  const decision = enter(goalRound);
  assert.equal(await preStep([goalRound], decision), decision);
});

test('appends one in-turn wait reminder with only running jobs and preserves downstream fields and messages', async () => {
  const callers = [];
  const { preStep } = mount({ jobs, callers });
  const decision = { ...enter(goalRound, message({ kind: 'downstream' })), startsRequestSeries: true };
  const { messages, ...fields } = await preStep([goalRound], decision);
  assert.deepEqual(callers, ['fixture-session']);
  assert.deepEqual(fields, { kind: 'enter', startsRequestSeries: true });
  assert.equal(messages.length, decision.messages.length + 1);
  assert.deepEqual(messages.slice(0, -1), decision.messages);
  const reminder = messages.at(-1);
  assert.equal(reminder.role, 'user');
  assert.equal(reminder.source.kind, Plugin.name);
  assert.notEqual(reminder.id, goalRound.id);
  assert.equal(reminder.content[0].type, 'text');
  const { text } = reminder.content[0];
  for (const { id, label, status } of jobs) {
    assert.equal(text.includes(id), status === 'running');
    assert.equal(text.includes(label), status === 'running');
  }
  assert.match(text, /job_output.*wait: true/);
});

test('passes through a rejected goal round without checking jobs', async () => {
  const callers = [];
  const { preStep } = mount({ jobs, callers });
  const reject = { kind: 'reject' };
  assert.equal(await preStep([goalRound], reject), reject);
  assert.deepEqual(callers, []);
});

test('rewrites both sections in place in the downstream presentation', async () => {
  const unrelated = { name: 'unrelated', text: Plugin.SDK_CREATE_SENTENCE };
  const input = {
    contexts: ['downstream context'],
    sections: [
      { name: 'tools:sdk', text: '  /** Earlier sentence. ' + Plugin.SDK_CREATE_SENTENCE + ' */\n  create_goal: {', interpolate: false },
      { name: 'tool:goal', text: Plugin.GOAL_GUIDANCE_SENTENCE + ' Preserve the rest.' },
      unrelated,
    ],
  };
  const after = await mount().assemble(input);
  assert.equal(after.contexts, input.contexts);
  assert.deepEqual(after.sections.map(section => section.name), input.sections.map(section => section.name));
  const [sdk, guidance, other] = after.sections;
  assert.ok(!sdk.text.includes(Plugin.SDK_CREATE_SENTENCE));
  assert.ok(!guidance.text.includes(Plugin.GOAL_GUIDANCE_SENTENCE));
  assert.match(sdk.text, /^  \/\*\* Earlier sentence\. .* \*\/\n  create_goal: \{$/);
  assert.equal(sdk.interpolate, false);
  assert.ok(guidance.text.endsWith(' Preserve the rest.'));
  assert.equal(other, unrelated);
});

test('leaves unrelated assemblies unchanged and handles native guidance without an SDK', async () => {
  const warnings = [];
  const { assemble } = mount({ warnings });
  const input = { sections: [{ name: 'other', text: Plugin.GOAL_GUIDANCE_SENTENCE }] };
  assert.equal(await assemble(input), input);
  const native = await assemble({ sections: [{ name: 'tool:goal', text: Plugin.GOAL_GUIDANCE_SENTENCE }] });
  assert.ok(!native.sections[0].text.includes(Plugin.GOAL_GUIDANCE_SENTENCE));
  assert.deepEqual(warnings, []);
});

test('warns once on wording drift and leaves the drifted section unchanged', async () => {
  const warnings = [];
  const drifted = { sections: [{ name: 'tool:goal', text: 'New upstream goal guidance' }] };
  const { assemble } = mount({ warnings });
  assert.equal(await assemble(drifted), drifted);
  assert.equal(await assemble(drifted), drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /create_goal.*tool:goal/);
});

test('installed Loader rewrites the live PTC SDK and guidance from tool-goal', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const url = path => pathToFileURL(path).href;
  const load = (resolver, id) => import(url(resolver.resolve(id)));
  const { Context } = await load(runtime, '@deepseek-ai/cordis');
  const { default: Loader } = await load(runtime, '@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load(runtime, '@deepseek-ai/cordis-plugin-include');
  const toolResolver = createRequire(runtime.resolve('@deepseek-ai/dsh-tools'));
  const { PtcRuntime } = await load(toolResolver, '@deepseek-ai/dsh-ptc-runtime');
  const persona = createRequire(runtime.resolve('@deepseek-ai/dsh-persona'));
  const { createScope } = await load(persona, '@deepseek-ai/dsh-scope');
  class AssemblyRuntime extends PtcRuntime {
    language = 'typescript';
    isolation = 'test';
    run() { throw new Error('Assembly tests must not execute code'); }
  }
  const ctx = new Context();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-goal-policy-'));
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  await ctx.plugin(Loader);
  await ctx.plugin(AssemblyRuntime);
  // Tool registration needs these services, but an assembly must not call them.
  ctx.provide('agents', {});
  ctx.provide('goals', {});
  ctx.provide('jobs', {});
  async function include(context, file, rows) {
    const path = join(dir, file);
    writeFileSync(path, JSON.stringify(rows));
    const mounted = await context.plugin(Include, { path: url(path) });
    await ctx.loader.await();
    return mounted;
  }
  const installed = (id, resolver = runtime) => ({ id, name: url(resolver.resolve('@deepseek-ai/dsh-' + id)), config: {} });
  await include(ctx, 'core.yml', [installed('system-prompt', persona), installed('tools')]);
  const key = { agent: 'fixture' };
  let scope;
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key); }, { inject: ['tools', 'systemPrompt'] }));
  await include(scope.ctx, 'preset.yml', [installed('tool-executor-ptc'), installed('tool-goal')]);
  const assemble = () => ctx.systemPrompt.assemble({ scope: key });
  const before = await assemble();
  const policy = await include(ctx, 'policy.yml', [
    { id: Plugin.name, name: new URL('../plugins/goal-policy.mjs', import.meta.url).href, config: {} },
  ]);
  const after = await assemble();
  assert.deepEqual(after.tools.map(tool => tool.name), ['run_code']);
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.sections.map(section => section.name), before.sections.map(section => section.name));
  for (const [sectionName, target] of [['tools:sdk', Plugin.SDK_CREATE_SENTENCE], ['tool:goal', Plugin.GOAL_GUIDANCE_SENTENCE]]) {
    const original = before.sections.find(section => section.name === sectionName)?.text;
    assert.ok(original?.includes(target), 'Installed PTC match target drifted: ' + sectionName);
    const text = after.sections.find(section => section.name === sectionName).text;
    assert.ok(!text.includes(target));
  }
  await policy.dispose();
  assert.deepEqual(await assemble(), before);
});
