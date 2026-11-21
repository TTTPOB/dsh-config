import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply, Config, FAILURE_CODE, name } from '../plugins/stream-loop-guard.mjs';

const fixture = file => JSON.parse(readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8'));
const stop = { type: 'finish', reason: { kind: 'stop' } };
const route = { sessionId: 'fixture', provider: 'fake' };
const looping = 'abc'.repeat(1000);
function deltas(text, size, fields = { type: 'text-delta', index: 0 }) {
  const chunks = [];
  for (let at = 0; at < text.length; at += size) {
    const delta = text.slice(at, at + size);
    chunks.push({ ...fields, [fields.type === 'tool-call-delta' ? 'argumentsDelta' : 'text']: delta });
  }
  return chunks;
}
function noise(size) {
  let seed = 27;
  return Array.from({ length: size }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(32 + seed % 95);
  }).join('');
}
function plugin(input = {}) {
  const listeners = new Map();
  const { value, issues } = Config['~standard'].validate(input);
  assert.equal(issues, undefined);
  apply({ on: (event, listener) => listeners.set(event, listener), effect: () => {} }, value);
  return listeners;
}
function source(chunks) {
  const state = { pulled: 0, closed: false };
  const iterable = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (state.pulled === chunks.length) return { done: true };
      return { done: false, value: chunks[state.pulled++] };
    },
    async return() { state.closed = true; return { done: true }; },
  };
  return { iterable, state };
}
async function consume(listeners, chunks, options = route) {
  const { iterable, state } = source(chunks);
  const output = await Array.fromAsync(listeners.get('llm/stream')(options, () => iterable));
  return { output, state };
}

// Only the actual counter tail is retained; the omitted private prefix is replaced at the original alignment.
test('a real counter loop trips soon after onset with fixed sampling across chunk sizes', async () => {
  const { start, tail } = fixture('stream-loop-noop');
  const listeners = plugin();
  const failures = [];
  for (const size of [31, 67, 8192]) {
    const { output } = await consume(listeners, [...deltas(noise(start) + tail, size), stop]);
    const { kind, failure } = output.at(-1).reason;
    assert.equal(kind, 'error');
    assert.equal(failure.code, FAILURE_CODE);
    const at = Number(failure.message.match(/at character (\d+)/)?.[1]);
    assert.ok(at > start && at <= start + 1000, `detected at ${at}`);
    failures.push(failure);
  }
  assert.deepEqual(failures.slice(1), [failures[0], failures[0]]);
});

test('sanitized completed arguments and a synthetic high-entropy block pass unchanged', async () => {
  const listeners = plugin();
  for (const text of [...fixture('stream-loop-normal'), noise(7500)]) {
    const chunks = [...deltas(text, 73, { type: 'tool-call-delta', index: 1, id: 'call' }), stop];
    const { output, state } = await consume(listeners, chunks);
    assert.deepEqual(output, chunks);
    assert.equal(state.closed, false);
  }
});

test('an intercepted stream closes its upstream, keeps sent deltas, and drops subsequent chunks', async () => {
  const abort = new AbortController();
  const chunks = [...deltas(looping, 91, { type: 'reasoning-delta', index: 0 }), stop];
  const { output, state } = await consume(plugin(), chunks, { ...route, signal: abort.signal });
  assert.ok(state.closed && state.pulled < chunks.length);
  assert.equal(abort.signal.aborted, false);
  assert.deepEqual(output.slice(0, -1), chunks.slice(0, state.pulled - 1));
  assert.equal(output.at(-1).reason.failure.code, FAILURE_CODE);
  assert.match(output.at(-1).reason.failure.message, /reasoning.*compression ratio.*threshold/);
});

test('deltas from different block indexes, types and tool IDs do not combine', async () => {
  const listeners = plugin();
  const records = [
    { type: 'text-delta', index: 1 }, { type: 'text-delta', index: 2 },
    { type: 'reasoning-delta', index: 1 },
    { type: 'tool-call-delta', index: 1, id: 'first' }, { type: 'tool-call-delta', index: 1, id: 'second' },
  ];
  const parts = records.map(record => deltas('x'.repeat(300), 50, record));
  const variants = [[parts[0], parts[1]], [parts[0], parts[2]], [parts[3], parts[4]]];
  for (const [a, b] of variants) {
    const chunks = [...a.flatMap((item, i) => [item, b[i]]), stop];
    assert.deepEqual((await consume(listeners, chunks)).output, chunks);
  }
  const start = { type: 'block-start', index: 1, blockType: 'text' };
  const end = { type: 'block-end', index: 1, block: { type: 'text', text: 'x'.repeat(300) } };
  const reset = [...parts[0], end, start, ...parts[0], stop];
  assert.deepEqual((await consume(listeners, reset)).output, reset);
});

test('provider opt-out and calls without session IDs bypass detection', async () => {
  const listeners = plugin({ disabledProviders: ['fake'] });
  const chunks = [...deltas(looping, 40), stop];
  for (const options of [route, { provider: 'other' }]) {
    assert.deepEqual((await consume(listeners, chunks, options)).output, chunks);
  }
  const { output } = await consume(listeners, chunks, { ...route, provider: 'other' });
  assert.equal(output.at(-1).reason.failure.code, FAILURE_CODE);
});

test('validated overrides alter behavior; an invalid short window is rejected', async () => {
  assert.ok(Config['~standard'].validate({ rules: { D6: { shortWindow: 1001 } } }).issues);
  const rules = Object.fromEntries(['B2', 'Z1', 'RLE', 'D6'].map(codec => [codec, { threshold: 10000 }]));
  const chunks = [...deltas(looping, 60), stop];
  assert.deepEqual((await consume(plugin({ rules }), chunks)).output, chunks);
});

test('retry is bounded per session, turn and step; appended hints obey the escaped excerpt limit', async () => {
  const excerptLimit = 80;
  const listeners = plugin({ excerptLimit });
  const text = noise(700) + '🧪\\"\n\t'.repeat(400);
  const chunks = deltas(text, 63, { type: 'tool-call-delta', index: 4, id: 'tool', name: 'calculate' });
  const appendCalls = [];
  const session = { id: route.sessionId, append: (...args) => appendCalls.push(args) };
  const retry = listeners.get('agent/request-error');
  const base = { agent: { session }, turn: 2, step: 3, signal: new AbortController().signal };
  const next = () => 'delegated';
  assert.equal(await retry({ ...base, failure: { code: 'OTHER' } }, next), 'delegated');
  async function attempt(overrides = {}) {
    const sessionId = overrides.agent?.session.id ?? session.id;
    const { output } = await consume(listeners, chunks, { ...route, sessionId, signal: base.signal });
    const { failure } = output.at(-1).reason;
    return retry({ ...base, failure: structuredClone(failure), ...overrides }, next);
  }
  for (let i = 0; i < 5; i++) assert.deepEqual(await attempt(), { kind: 'retry' });
  assert.equal(await attempt(), 'delegated');
  assert.equal(appendCalls.length, 5);
  const [event, message, options] = appendCalls[0];
  assert.equal(event, 'user/message');
  assert.equal(options.surfaceOp, 'append');
  assert.equal(message.source.kind, name);
  assert.match(message.content[0].text, /turn 2, step 3.*calculate/);
  const excerpts = message.content[0].text.split('\n').slice(-2).map(line => line.slice(line.indexOf(': ') + 2));
  assert.ok(excerpts.join('').length <= excerptLimit);
  assert.ok(JSON.parse(excerpts[0]).length > 0);
  assert.ok(JSON.parse(excerpts[1]).includes('🧪'));
  assert.deepEqual(await attempt({ agent: { session: { ...session, id: 'other' } } }), { kind: 'retry' });
  assert.deepEqual(await attempt({ step: 4 }), { kind: 'retry' });
  assert.deepEqual(await attempt({ turn: 3 }), { kind: 'retry' });
  listeners.get('session/disposed')(session);
  assert.deepEqual(await attempt(), { kind: 'retry' });
});
test('installed Loader retries with one logged hint and runs only the recovered tool call', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const require = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const url = path => pathToFileURL(path).href;
  const load = id => import(url(require.resolve(id)));
  const pkg = name => `@deepseek-ai/dsh-${name}`;
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load('@deepseek-ai/cordis-plugin-include');
  const { LlmAdapter, createUserMessage } = await load(pkg('llm'));
  const { defineTool } = await load(pkg('tools'));
  const folder = mkdtempSync(join(tmpdir(), 'stream-loop-guard-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  const modulePath = join(folder, 'guard.mjs');
  copyFileSync(new URL('../plugins/stream-loop-guard.mjs', import.meta.url), modulePath);
  const yaml = join(folder, 'cordis.yml');
  const core = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'tool-executor-native', 'agent', 'agent-loop'];
  writeFileSync(yaml, JSON.stringify([
    ...core.map(id => ({ id, name: url(require.resolve(pkg(id))), ...(id === 'agent-loop' ? { config: { agents: [] } } : {}) })),
    { id: name, name: url(modulePath), config: {} },
  ]));
  await ctx.plugin(Loader);
  await ctx.plugin(Include, { path: url(yaml) });
  await ctx.loader.await();

  const requests = [];
  const executed = [];
  const adapterClosed = [];
  function* tool(id, value) {
    const args = JSON.stringify({ value });
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield* deltas(args, 32, { type: 'tool-call-delta', index: 0, id, name: 'record' });
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'record', arguments: args } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      requests.push(request);
      const attempt = requests.length;
      try {
        if (attempt === 1) yield* tool('discarded', looping);
        else if (attempt === 2) yield* tool('kept', 'accepted');
        else { yield* deltas('Done.', 20); yield stop; }
      } finally { adapterClosed.push(attempt); }
    }
  }
  ctx.llm.registerAdapter(['fake'], new Adapter());
  ctx.tools.register(defineTool({
    name: 'record', description: 'Record a test value',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args) { executed.push(args.value); return args.value; },
  }));
  const agent = await ctx.agentLoop.create(randomUUID(), { provider: 'fake', model: 'fixture' });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const events = agent.session.snapshotEvents();
  assert.equal(requests.length, 3);
  assert.deepEqual(adapterClosed, [1, 2, 3]);
  assert.deepEqual(executed, ['accepted']);
  assert.equal(events.filter(event => event.type === 'assistant/attempt').length, 1);
  const last = requests[1].messages.at(-1);
  assert.equal(last.source.kind, name);
  assert.match(last.content[0].text, /turn 1, step 1.*record tool call/);
  const hints = messages => messages.filter(message => message.source?.kind === name);
  assert.deepEqual(hints(requests[0].messages), []);
  assert.deepEqual(hints(requests[2].messages), [last]);
  const logged = events.filter(event => event.type === 'user/message' && event.data.source.kind === name);
  assert.deepEqual(logged.map(event => event.data), [last]);
  assert.deepEqual(hints(agent.session.deriveMessages()), [last]);
});
