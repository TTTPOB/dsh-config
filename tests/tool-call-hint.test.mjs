import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply, name } from '../plugins/tool-call-hint.mjs';

const tool = 'job_output';
const unavailable = { code: 'FIXTURE_ERROR', message: `tool_protocol_error: Model called an unavailable tool: ${tool}.\r ` };
const blocked = { code: 'PI_AI_ERROR', message: 'native_tool_blocked: native_tool_blocked' };
const delegated = Symbol('delegated');

function fixture() {
  const listeners = new Map();
  apply({ on: (event, listener) => listeners.set(event, listener), effect: () => {} });
  const calls = [];
  const session = { id: 'fixture', append: (...args) => calls.push(args) };
  const base = { agent: { session }, turn: 2, step: 3, failure: unavailable, signal: new AbortController().signal };
  return {
    calls,
    session,
    attempt: overrides => listeners.get('agent/request-error')({ ...base, ...overrides }, () => delegated),
    dispose: () => listeners.get('session/disposed')(session),
  };
}

for (const [label, failure, instruction] of [
  ['unavailable tool', unavailable, new RegExp(`tools\\.${tool}\\(`)],
  ['blocked native tool', blocked, /mcp__parking__run_code/],
]) {
  test(`${label} appends a corrective user hint then retries`, async () => {
    const { attempt, calls } = fixture();
    assert.deepEqual(await attempt({ failure }), { kind: 'retry' });
    assert.equal(calls.length, 1);
    const [event, message, options] = calls[0];
    assert.equal(event, 'user/message');
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, name);
    assert.equal(options.surfaceOp, 'append');
    assert.match(message.content[0].text, /turn 2, step 3/);
    assert.match(message.content[0].text, instruction);
    assert.match(message.content[0].text, /discarded/);
  });
}

test('unrelated and aborted failures delegate without appending', async () => {
  const { attempt, calls } = fixture();
  for (const message of ['upstream_error: failed', 'native_tool_blocked_extra']) {
    assert.equal(await attempt({ failure: { code: blocked.code, message } }), delegated);
  }
  assert.equal(await attempt({ signal: AbortSignal.abort() }), delegated);
  assert.deepEqual(calls, []);
});

test('the retry budget is shared by both failures and scoped to the session, turn and step', async () => {
  const { attempt, calls, session } = fixture();
  for (const failure of [unavailable, blocked, unavailable]) {
    assert.deepEqual(await attempt({ failure }), { kind: 'retry' });
  }
  assert.equal(await attempt({ failure: blocked }), delegated);
  assert.equal(calls.length, 3);
  assert.deepEqual(await attempt({ agent: { session: { ...session, id: 'another' } } }), { kind: 'retry' });
  assert.deepEqual(await attempt({ step: 4 }), { kind: 'retry' });
  assert.deepEqual(await attempt({ step: 4, turn: 3 }), { kind: 'retry' });
});

test('disposing a session clears its exhausted retry budget', async () => {
  const { attempt, dispose } = fixture();
  for (let i = 0; i < 3; i++) assert.deepEqual(await attempt(), { kind: 'retry' });
  assert.equal(await attempt(), delegated);
  dispose();
  assert.deepEqual(await attempt(), { kind: 'retry' });
});

test('installed Loader delivers each logged hint in the next model request', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const require = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const url = path => pathToFileURL(path).href;
  const load = id => import(url(require.resolve(id)));
  const pkg = id => `@deepseek-ai/dsh-${id}`;
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load('@deepseek-ai/cordis-plugin-include');
  const { LlmAdapter, createUserMessage } = await load(pkg('llm'));
  const folder = mkdtempSync(join(tmpdir(), 'tool-call-hint-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  const modulePath = join(folder, 'hint.mjs');
  copyFileSync(new URL('../plugins/tool-call-hint.mjs', import.meta.url), modulePath);
  const yaml = join(folder, 'cordis.yml');
  const core = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'tool-executor-native', 'agent', 'agent-loop', 'llm-retry'];
  writeFileSync(yaml, JSON.stringify([
    ...core.map(id => ({ id, name: url(require.resolve(pkg(id))), ...(id === 'agent-loop' ? { config: { agents: [] } } : {}) })),
    { id: name, name: url(modulePath), config: {} },
  ]));
  await ctx.plugin(Loader);
  await ctx.plugin(Include, { path: url(yaml) });
  await ctx.loader.await();

  const requests = [];
  const failures = [{ ...unavailable, code: blocked.code }, blocked];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      const failure = failures[requests.length];
      requests.push(request);
      if (failure) {
        yield { type: 'finish', reason: { kind: 'error', failure } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Done.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['fake'], new Adapter());
  const agent = await ctx.agentLoop.create(randomUUID(), { provider: 'fake', model: 'fixture' });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }));
  await agent.whenIdle();

  assert.equal(requests.length, 3);
  const events = agent.session.snapshotEvents();
  const logged = events.filter(event => event.type === 'user/message' && event.data.source.kind === name).map(event => event.data);
  assert.equal(logged.length, 2);
  const hints = request => request.messages.filter(message => message.source?.kind === name);
  assert.deepEqual(hints(requests[0]), []);
  assert.deepEqual(hints(requests[1]), logged.slice(0, 1));
  assert.deepEqual(hints(requests[2]), logged);
  assert.equal(events.filter(event => event.type === 'assistant/attempt').length, 2);
  assert.ok(!events.some(event => event.type === 'llm/retry'));
});

test('installed pi-ai classifies gateway tool rejections as non-retryable', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const require = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const load = id => import(pathToFileURL(require.resolve(id)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: LlmRuntime } = await load('@deepseek-ai/dsh-llm');
  const piAi = await load('@deepseek-ai/dsh-llm-pi-ai');
  const { root, renderMachine, validatePatch } = await import('../scripts/lib.mjs');
  const { rendered } = renderMachine(join(root, 'examples/workstation-machine.yaml'), 'tool-call-hint', undefined, { stage: false });
  const { 'klaude-cl': profile } = validatePatch(rendered.home).find(row => row.entry.id === 'llm-pi-ai').entry.config.providers;
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());

  const cases = [
    ['tool_protocol_error', 'Model called an unavailable tool: timeout.', 'PI_AI_ERROR'],
    ['tool_protocol_error', 'Model called an unavailable tool: fetch.', 'PI_AI_ERROR'],
    ['native_tool_blocked', 'native_tool_blocked', 'PI_AI_ERROR'],
    ['upstream_error', 'upstream temporarily unavailable', 'SERVER'],
    ['tool_protocol_error', 'Tool result timeout', 'TIMEOUT'],
  ];
  const pending = [...cases];
  const server = createServer((req, res) => {
    req.resume();
    const [code, message] = pending.shift() ?? ['unexpected', 'Unexpected extra request'];
    const event = { type: 'response.failed', response: { status: 'failed', error: { code, message } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const key = 'DSH_CONFIG_TOOL_CALL_HINT_TEST_KEY';
  const oldKey = process.env[key];
  process.env[key] = 'fixture-key';
  t.after(() => {
    if (oldKey === undefined) delete process.env[key];
    else process.env[key] = oldKey;
  });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(piAi, { providers: { 'klaude-cl': {
    ...profile, baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: key,
  } } });
  for (const [wireCode, message, code] of cases) {
    let finish;
    for await (const chunk of ctx.llm.stream({ provider: 'klaude-cl', model: profile.models[0].id, messages: [] })) {
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    assert.equal(finish?.kind, 'error');
    assert.ok(finish.failure.message.includes(`${wireCode}: ${message}`), finish.failure.message);
    assert.equal(finish.failure.code, code, finish.failure.message);
  }
});
