import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply, Config, name } from '../plugins/error-code-rules.mjs';

const rule = { providers: ['fixture-a', 'fixture-b'], match: '^outage:', code: 'SERVER' };
const validate = input => Config['~standard'].validate(input);
const stop = { type: 'finish', reason: { kind: 'stop' } };
const failure = (code, message = 'outage: temporarily unavailable') => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } });

function plugin(rules) {
  const listeners = new Map();
  const { value, issues } = validate({ rules });
  assert.equal(issues, undefined);
  apply({ on: (event, listener) => listeners.set(event, listener) }, value);
  return (provider, upstream) => listeners.get('llm/stream')({ provider }, () => upstream);
}

async function* source(...chunks) { yield* chunks; }

test('first matching rule changes only the failure code in a new finish chunk', async () => {
  const original = failure('PI_AI_ERROR');
  Object.assign(original.reason.failure, { status: 502, requestId: 'fixture-id', providerRetryAfterMs: 200 });
  const copy = structuredClone(original);
  const stream = plugin([
    { ...rule, providers: ['other'], code: 'AUTH' },
    { ...rule, match: '^different:', code: 'TIMEOUT' },
    rule,
    { ...rule, match: 'unavailable', code: 'RATE_LIMIT' },
  ]);
  for (const provider of rule.providers) {
    const [finish] = await Array.fromAsync(stream(provider, source(original)));
    assert.notEqual(finish, original);
    assert.deepEqual(original, copy);
    assert.deepEqual(finish, { ...copy, reason: { ...copy.reason, failure: { ...copy.reason.failure, code: rule.code } } });
  }
});

test('unlisted providers and empty rules return the original iterable', () => {
  const stream = plugin([rule]);
  for (const provider of ['other', 'Fixture-a', 'fixture-a-extra']) {
    const upstream = source(failure('PI_AI_ERROR'));
    assert.equal(stream(provider, upstream), upstream);
  }
  const upstream = source(failure('PI_AI_ERROR'));
  assert.equal(plugin([])('fixture-a', upstream), upstream);
});

test('non-finish chunks, unmatched messages, protected errors and aborted finishes retain identity', async () => {
  const stream = plugin([rule]);
  const aborted = { type: 'finish', reason: { ...failure('TRANSPORT').reason, kind: 'aborted' } };
  const delta = { type: 'text-delta', index: 0, text: 'outage: visible text' };
  for (const finish of [
    stop, aborted, failure('PI_AI_ERROR', 'wrapper: outage: temporarily unavailable'),
    ...['CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'IMAGE_OFFLOAD_REQUIRED', 'STREAM_LOOP_DETECTED'].map(code => failure(code)),
  ]) {
    const output = await Array.fromAsync(stream('fixture-a', source(delta, finish)));
    assert.equal(output.length, 2);
    assert.equal(output[0], delta);
    assert.equal(output[1], finish);
  }
});

test('config rejects malformed regexes, unsupported codes and unknown keys', () => {
  for (const [input, path] of [
    [{ rules: [{ ...rule, match: '[' }] }, ['rules', 0, 'match']],
    [{ rules: [{ ...rule, code: 'UNKNOWN' }] }, ['rules', 0, 'code']],
    [{ rules: [{ ...rule, after: false }] }, ['rules', 0]],
    [{ rules: [{ ...rule, providers: [] }] }, ['rules', 0, 'providers']],
    [{ rules: [rule], extra: true }, []],
  ]) {
    assert.deepEqual(validate(input).issues[0].path, path);
  }
});

test('installed Loader lets llm-retry consume the rewritten failure code', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const require = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const url = path => pathToFileURL(path).href;
  const load = id => import(url(require.resolve(id)));
  const pkg = id => `@deepseek-ai/dsh-${id}`;
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load('@deepseek-ai/cordis-plugin-include');
  const { LlmAdapter, createUserMessage, resolveRetryPolicy } = await load(pkg('llm'));
  const folder = mkdtempSync(join(tmpdir(), 'error-code-rules-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  const modulePath = join(folder, 'error-code-rules.mjs');
  copyFileSync(new URL('../plugins/error-code-rules.mjs', import.meta.url), modulePath);
  const yaml = join(folder, 'cordis.yml');
  const core = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'tool-executor-native', 'agent', 'agent-loop', 'llm-retry'];
  writeFileSync(yaml, JSON.stringify([
    ...core.map(id => ({ id, name: url(require.resolve(pkg(id))), ...(id === 'agent-loop' ? { config: { agents: [] } } : {}) })),
    { id: name, name: url(modulePath), config: { rules: [rule] } },
  ]));
  await ctx.plugin(Loader);
  await ctx.plugin(Include, { path: url(yaml) });
  await ctx.loader.await();

  const calls = [];
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 1, retryableCodes: [rule.code],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'fixture retryPolicy');
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    providerRetryPolicy() { return policy; }
    async *stream(request) {
      calls.push(request);
      if (calls.length === 1) {
        yield failure('PI_AI_ERROR');
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Recovered.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered.' } };
        yield stop;
      }
    }
  }
  const [provider] = rule.providers;
  ctx.llm.registerAdapter([provider], new Adapter());
  const agent = await ctx.agentLoop.create(randomUUID(), { provider, model: 'fixture' });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }));
  await agent.whenIdle();

  assert.equal(calls.length, 2);
  const retries = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry');
  assert.deepEqual(retries.map(event => event.data.failure), [failure(rule.code).reason.failure]);
  const last = agent.session.deriveMessages().at(-1);
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.content, [{ type: 'text', text: 'Recovered.' }]);
});
