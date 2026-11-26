import test from 'node:test';
import assert from 'node:assert/strict';
import * as Plugin from '../plugins/agent-instructions-reminder.mjs';

const block = text => Object.freeze({ type: 'text', text });
const message = (id, source, text) => Object.freeze({
  id, role: 'user', source: Object.freeze(source), content: Object.freeze([block(text)]),
});
const human = message('human', { kind: 'user' }, 'Continue.');
const runtime = message('runtime', { kind: 'runtime-context' }, 'Working directory changed.');
const instruction = (id, changes) => message(id, {
  kind: 'agent-instructions', form: 'instructions', changes: Object.freeze(changes),
}, 'Instructions from: fake/CLAUDE.md');
const enter = (...messages) => Object.freeze({ kind: 'enter', messages: Object.freeze(messages), startsRequestSeries: true });

function mount({ mounts = 1, producer } = {}) {
  const listeners = producer ? [producer] : [];
  const ctx = {
    on(event, listener, { prepend } = {}) {
      assert.equal(event, 'agent/pre-step');
      listeners[prepend ? 'unshift' : 'push'](listener);
    },
  };
  for (let i = 0; i < mounts; i++) Plugin.apply(ctx);
  return fallback => listeners.reduceRight((next, listener) => () => listener({}, next), fallback)();
}

test('wraps the existing producer and inserts a separate note listing the loaded files', async () => {
  const paths = ['AGENTS.md', 'packages/CLAUDE.local.md', '~/.dsh/AGENTS.md'];
  const injected = instruction('baseline', paths.map(path => ({ action: 'set', path })));
  const dispatch = mount({
    async producer(_event, next) {
      const decision = await next();
      return { ...decision, messages: decision.messages.toSpliced(1, 0, injected) };
    },
  });
  const result = await dispatch(() => enter(human, runtime));
  const [prompt, original, note, context] = result.messages;
  assert.equal(result.messages.length, 4);
  assert.equal(prompt, human);
  assert.equal(original, injected);
  assert.equal(context, runtime);
  assert.equal(note.source.kind, Plugin.name);
  for (const path of paths) assert.ok(note.content[0].text.includes(JSON.stringify(path)));
  assert.ok(!note.content[0].text.includes('fake/CLAUDE.md'));
});

test('unchanged steps, rejection, and removal-only decisions add no note', async () => {
  const removed = instruction('removed', [{ action: 'remove', path: 'AGENTS.md' }]);
  const dispatch = mount();
  for (const decision of [enter(human), enter(human, removed), { kind: 'reject' }]) {
    assert.equal(await dispatch(() => decision), decision);
  }
});

test('composed wrappers add at most one note and list each injected path once', async () => {
  const path = 'AGENTS.md';
  const first = instruction('first', [{ action: 'set', path }]);
  const updated = instruction('updated', [{ action: 'replace', path }, { action: 'set', path: 'sub/AGENTS.md' }]);
  const result = await mount({ mounts: 2 })(() => enter(human, first, updated, runtime));
  const notes = result.messages.filter(({ source }) => source.kind === Plugin.name);
  assert.equal(notes.length, 1);
  assert.equal(result.messages.indexOf(notes[0]), result.messages.indexOf(updated) + 1);
  assert.equal(notes[0].content[0].text.split(JSON.stringify(path)).length - 1, 1);
});
