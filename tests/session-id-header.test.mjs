import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, Config } from '../plugins/session-id-header.mjs';

const validate = input => Config['~standard'].validate(input);

function plugin(providers) {
  const listeners = new Map();
  const { value, issues } = validate({ providers });
  assert.equal(issues, undefined);
  apply({ on: (event, listener) => listeners.set(event, listener) }, value);
  return (request, headers) => listeners.get('llm-pi-ai/request-headers')(request, headers, () => headers);
}

test('listed providers with a session ID receive session_id alongside existing headers', () => {
  const prepare = plugin(['fixture-a', 'fixture-b']);
  for (const provider of ['fixture-a', 'fixture-b']) {
    const headers = new Headers({ 'x-existing': 'kept' });
    const result = prepare({ provider, model: 'm', baseURL: 'https://example.invalid', sessionId: `session-${provider}` }, headers);
    assert.equal(result.get('session_id'), `session-${provider}`);
    assert.equal(result.get('x-existing'), 'kept');
  }
});

test('unlisted providers and requests without a session ID are left unchanged', () => {
  const prepare = plugin(['fixture-a']);
  for (const request of [
    { provider: 'other', sessionId: 'session-1' },
    { provider: 'Fixture-a', sessionId: 'session-1' },
    { provider: 'fixture-a' },
  ]) {
    const result = prepare({ model: 'm', baseURL: 'https://example.invalid', ...request }, new Headers());
    assert.equal(result.has('session_id'), false);
  }
});

test('config rejects missing, empty and malformed provider lists', () => {
  for (const input of [null, {}, { providers: [] }, { providers: [''] }, { providers: [1] }, { providers: ['a'], extra: true }]) {
    assert.ok(validate(input).issues);
  }
});
