import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as Plugin from '../plugins/agent-instructions-reminder.mjs';

const root = resolve('/fixture/workspace');
const cwd = join(root, 'packages');
const block = text => Object.freeze({ type: 'text', text });
const message = (id, source, text) => Object.freeze({
  id, role: 'user', source: Object.freeze(source), content: Object.freeze([block(text)]),
});
const human = message('human', { kind: 'user' }, 'Continue.');
const runtime = message('runtime', { kind: 'runtime-context' }, 'Working directory changed.');
const instruction = (id, changes, baseline = false) => message(id, {
  kind: 'agent-instructions',
  form: 'instructions',
  changes: Object.freeze(changes),
  ...(baseline && { baseline: true, baselineIdentity: JSON.stringify({ projectRoot: relative(cwd, root) }) }),
}, 'Instructions from: fake/CLAUDE.md');
const enter = (...messages) => Object.freeze({ kind: 'enter', messages: Object.freeze(messages), startsRequestSeries: true });

function mount({ current = () => [], mounts = 1, producer } = {}) {
  const listeners = producer ? [producer] : [];
  const probes = [];
  const ctx = {
    on(event, listener, { prepend } = {}) {
      assert.equal(event, 'agent/pre-step');
      listeners[prepend ? 'unshift' : 'push'](listener);
    },
    workingDirectory: { get: () => cwd },
    fs: {
      resolve: async path => path,
      async stat(path) {
        probes.push(path);
        return path === join(root, '.git') ? { type: 'file' } : undefined;
      },
    },
  };
  for (let i = 0; i < mounts; i++) Plugin.apply(ctx);
  return {
    probes,
    dispatch(fallback) {
      const payload = { agent: { session: { deriveMessages: current } }, signal: new AbortController().signal };
      return listeners.reduceRight((next, listener) => () => listener(payload, next), fallback)();
    },
  };
}

function assertPaths(note, paths) {
  assert.equal(note.source.kind, Plugin.name);
  assert.equal(note.role, 'user');
  const [{ text }] = note.content;
  for (const [display, absolute] of paths) {
    assert.ok(text.includes(JSON.stringify(display)), text);
    assert.ok(text.includes(JSON.stringify(absolute)), text);
  }
  assert.match(text, /Do not read them with tools by relative or absolute path/);
  assert.match(text, /only if the user asks or you need to verify an edit you made/);
  assert.ok(!text.includes('fake/CLAUDE.md'), text);
}

test('wraps the existing producer and inserts a separate note with the loaded files', async t => {
  const agentsHome = resolve('/fixture/shared agents');
  // The symbolic label refers to the runtime home, not the project root.
  const previous = process.env.DSH_AGENTS_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previous;
  });
  process.env.DSH_AGENTS_HOME = agentsHome;
  const paths = [
    ['AGENTS.md', join(root, 'AGENTS.md')],
    [join('packages', 'CLAUDE.local.md'), join(cwd, 'CLAUDE.local.md')],
    ['$DSH_AGENTS_HOME/AGENTS.md', join(agentsHome, 'AGENTS.md')],
    ['~/.dsh/AGENTS.md', join(homedir(), '.dsh', 'AGENTS.md')],
  ];
  const injected = instruction('baseline', paths.map(([path]) => ({ action: 'set', path })), true);
  const { dispatch, probes } = mount({
    async producer(_event, next) {
      const decision = await next();
      return { ...decision, messages: decision.messages.toSpliced(1, 0, injected) };
    },
  });
  const result = await dispatch(() => enter(human, runtime));
  const [prompt, original, note, context] = result.messages;
  assert.equal(result.messages.length, 4);
  assert.equal(result.startsRequestSeries, true);
  assert.equal(prompt, human);
  assert.equal(original, injected);
  assert.equal(context, runtime);
  assert.notEqual(note.id, injected.id);
  assertPaths(note, paths);
  assert.deepEqual(probes, []);
});

test('unchanged steps, rejection, and removal-only decisions add no note', async () => {
  const old = instruction('old', [{ action: 'set', path: 'AGENTS.md' }], true);
  const removed = instruction('removed', [{ action: 'remove', path: 'AGENTS.md' }]);
  const { dispatch } = mount({ current: () => [old] });
  for (const decision of [enter(human), enter(human, removed), { kind: 'reject' }]) {
    assert.equal(await dispatch(() => decision), decision);
  }
});

test('composed wrappers add at most one note and list each injected path once', async () => {
  const path = 'AGENTS.md';
  const first = instruction('first', [{ action: 'set', path }], true);
  const updated = instruction('updated', [{ action: 'replace', path }]);
  const result = await mount({ mounts: 2 }).dispatch(() => enter(human, first, updated, runtime));
  const notes = result.messages.filter(({ source }) => source.kind === Plugin.name);
  assert.equal(notes.length, 1);
  assert.equal(result.messages.indexOf(notes[0]), result.messages.indexOf(updated) + 1);
  assert.equal(notes[0].content[0].text.split(JSON.stringify(path)).length - 1, 1);
});

test('resolves a later directory injection using the active baseline without re-listing it', async () => {
  const old = instruction('baseline', [{ action: 'set', path: 'AGENTS.md' }], true);
  const path = join('packages', 'new module', 'CLAUDE.md');
  const delta = instruction('delta', [{ action: 'set', path }]);
  const { dispatch, probes } = mount({ current: () => [old] });
  const result = await dispatch(() => enter(delta, runtime));
  const note = result.messages[1];
  assertPaths(note, [[path, join(root, path)]]);
  assert.ok(!note.content[0].text.includes(JSON.stringify(old.source.changes[0].path)));
  assert.deepEqual(probes, []);
  assert.equal(await dispatch(() => enter()).then(next => next.messages.length), 0);
});

test('resolves the first nested-only injection using the nearest Git marker', async () => {
  const path = join('packages', 'first child', 'AGENTS.md');
  const delta = instruction('delta', [{ action: 'set', path }]);
  const { dispatch, probes } = mount();
  const result = await dispatch(() => enter(delta));
  assertPaths(result.messages[1], [[path, join(root, path)]]);
  assert.deepEqual(probes, [join(cwd, '.git'), join(root, '.git')]);
});
