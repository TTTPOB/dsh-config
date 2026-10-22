import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as Plugin from '../plugins/provider-prompt.mjs';

const rule = (text, extra = {}) => ({ providers: ['claude-gateway'], text, ...extra });
const validate = input => Plugin.Config['~standard'].validate(input);

test('explicit rules validate nonempty providers, optional models and literal text', () => {
  for (const rules of [[], [rule('literal {{}} {{missing}}')], [rule('model', { models: ['model-a'] })]]) {
    assert.deepEqual(validate({ rules }), { value: { rules } });
  }
  const invalid = [undefined, null, [], {}, { rules: null }, { rules: {} }, { rules: [], unknown: true },
    ...[null, [], {}, rule('x', { providers: undefined }), rule('x', { providers: [] }),
      rule('x', { providers: 'claude-gateway' }), rule('x', { providers: [''] }), rule('x', { providers: [' '] }),
      rule('x', { providers: [1] }), rule('x', { models: [] }), rule('x', { models: null }),
      rule('x', { models: 'model-a' }), rule('x', { models: [''] }), rule('x', { models: [1] }),
      rule(''), rule('  '), rule(123), rule('x', { typo: true })].map(value => ({ rules: [value] }))];
  for (const input of invalid) assert.ok(validate(input).issues, JSON.stringify(input));
});

test('dynamic text matches exact providers/models in order without caching', () => {
  let section;
  let dispose;
  Plugin.apply({
    effect(register) { dispose = register(); },
    systemPrompt: {
      getSectionOrder: () => 100,
      section(value) { section = value; return () => { section = undefined; }; },
    },
  }, validate({ rules: [rule('first'), rule('literal {{}} {{missing}}', { models: ['model-a'] }), rule('last')] }).value);
  assert.equal(section.interpolate, false);
  assert.equal(section.text({}), '');
  const current = { options: { provider: 'claude-gateway', model: 'model-a' } };
  const context = { agent: current };
  for (let i = 0; i < 3; i++) assert.equal(section.text(context), 'first\n\nliteral {{}} {{missing}}\n\nlast');
  current.options.model = 'model-b';
  assert.equal(section.text(context), 'first\n\nlast');
  delete current.options.model;
  assert.equal(section.text(context), 'first\n\nlast');
  for (const provider of ['other', 'Claude-gateway', 'claude-gateway-extra', undefined]) {
    current.options.provider = provider;
    assert.equal(section.text(context), '');
  }
  dispose();
  assert.equal(section, undefined);
});

test('installed Loader composes copied module, replaces config, preserves complete, scopes and disposal', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const persona = createRequire(runtime.resolve('@deepseek-ai/dsh-persona'));
  const load = async (resolver, name) => import(pathToFileURL(resolver.resolve(name)).href);
  const { Context } = await load(runtime, '@deepseek-ai/cordis');
  const { default: Loader } = await load(runtime, '@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load(runtime, '@deepseek-ai/cordis-plugin-include');
  const { default: SystemPrompt, renderPrompt } = await load(persona, '@deepseek-ai/dsh-system-prompt');
  const { createScope } = await load(persona, '@deepseek-ai/dsh-scope');
  const directory = mkdtempSync(join(tmpdir(), 'provider-prompt-plugin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modulePath = join(directory, 'provider-prompt.mjs');
  copyFileSync(new URL('../plugins/provider-prompt.mjs', import.meta.url), modulePath);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  const entries = [];
  ctx.on('loader/entry-init', entry => { entries.push(entry); });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'fixture', description: 'Fixture tool', parameters: { type: 'object', properties: {} } }] }));
  const key = {};
  let scope;
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key); }, { inject: ['systemPrompt'] }));
  const current = { options: { provider: 'claude-gateway', model: 'model-a' } };
  const assemble = (extra = {}) => ctx.systemPrompt.assemble({ scope: key, agent: current, ...extra });
  const baseline = await assemble();
  const yaml = join(directory, 'cordis.yml');
  writeFileSync(yaml, JSON.stringify([{ id: 'provider-prompt', name: pathToFileURL(modulePath).href, config: {
    rules: [rule('first {{missing}}'), rule('model', { models: ['model-a'] }), rule('last')],
  } }]));
  const mounted = await scope.ctx.plugin(Include, { path: pathToFileURL(yaml).href });
  const after = await assemble();
  assert.equal(renderPrompt(after), 'first {{missing}}\n\nmodel\n\nlast');
  assert.deepEqual(after.tools, baseline.tools);
  assert.deepEqual(after.contexts, baseline.contexts);
  assert.deepEqual(after.sections.filter(section => section.name !== Plugin.SECTION), baseline.sections);
  for (let i = 0; i < 3; i++) assert.deepEqual(await assemble(), after);
  current.options.model = 'model-b';
  assert.equal(renderPrompt(await assemble()), 'first {{missing}}\n\nlast');
  current.options.provider = 'other';
  assert.equal(renderPrompt(await assemble()), '');
  current.options.provider = 'claude-gateway';
  current.options.model = 'model-a';
  assert.deepEqual(await assemble(), after);
  assert.equal(renderPrompt(await ctx.systemPrompt.assemble()), '');
  assert.equal(renderPrompt(await assemble({ scope: {} })), '');
  const complete = scope.ctx.systemPrompt.section({ name: 'test:complete', order: 0, text: 'Complete prompt', complete: true });
  assert.equal(renderPrompt(await assemble()), 'Complete prompt');
  complete();
  const entry = entries.find(entry => entry.options.id === 'provider-prompt');
  assert.ok(entry?.fiber);
  await entry.parent.tree.update('provider-prompt', { config: { rules: [rule('replacement')] } });
  await entry.parent.tree.await();
  assert.equal(renderPrompt(await assemble()), 'replacement');
  await entry.parent.tree.update('provider-prompt', { config: { rules: [] } });
  await entry.parent.tree.await();
  assert.equal(renderPrompt(await assemble()), '');
  await entry.parent.tree.update('provider-prompt', { config: { rules: [rule('restored')] } });
  await entry.parent.tree.await();
  assert.equal(renderPrompt(await assemble()), 'restored');
  await mounted.dispose();
  assert.deepEqual(await assemble(), baseline);
  writeFileSync(yaml, JSON.stringify([{ id: 'invalid-prompt', name: pathToFileURL(modulePath).href, config: { rules: [rule('x', { providers: [] })] } }]));
  const invalid = await scope.ctx.plugin(Include, { path: pathToFileURL(yaml).href });
  await entry.parent.tree.await();
  const failed = entries.find(entry => entry.options.id === 'invalid-prompt');
  assert.ok(failed?.fiber);
  assert.equal(failed.fiber.state, 3); // Cordis 4.0.5 FiberState.FAILED is a compile-time enum.
  assert.deepEqual(await assemble(), baseline);
  await invalid.dispose();
});
