import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { root } from '../scripts/lib.mjs';
import * as Plugin from '../plugins/prompt-sections.mjs';

function fixture(t) {
  const parent = join(root, 'generated/prompt-tests');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const promptFile = join(dir, 'extra.md');
  const identityFile = join(dir, 'identity.md');
  writeFileSync(promptFile, '  Neutral extra {{literal}}.\n');
  writeFileSync(identityFile, 'Neutral identity.\n');
  return { dir, promptFile, identityFile };
}

function validate(input) {
  const result = Plugin.Config['~standard'].validate(input);
  assert.ok(!result.issues, 'Valid fixture config rejected');
  return result.value;
}

function recorder() {
  const sections = [];
  const disposers = [];
  return {
    sections,
    ctx: {
      effect(register) { disposers.push(register()); },
      systemPrompt: {
        section(section) {
          sections.push(section);
          return () => sections.splice(sections.indexOf(section), 1);
        },
        getSectionOrder: () => -1000,
      },
    },
    dispose() { for (const dispose of disposers.reverse()) dispose(); },
  };
}

test('normalizes defaults and rejects invalid paths/order/toggles', t => {
  const files = fixture(t);
  const config = validate(files);
  assert.equal(config.order, 100);
  assert.equal(config.shadowHarnessIdentity, true);
  for (const changed of [{ promptFile: 'relative.md' }, { order: Infinity }, { shadowHarnessIdentity: 'yes' }]) {
    assert.ok(Plugin.Config['~standard'].validate({ ...files, ...changed }).issues);
  }
  assert.ok(Plugin.Config['~standard'].validate({}).issues);
});

test('registers literal sections and removes them on disposal', t => {
  const files = fixture(t);
  const capture = recorder();
  Plugin.apply(capture.ctx, validate(files));
  assert.deepEqual(capture.sections.map(section => [section.name, section.interpolate]), [
    ['dsh-prompt-overlay:kernel', false], ['harness:identity', false],
  ]);
  assert.equal(capture.sections[0].text, 'Neutral extra {{literal}}.');
  assert.equal(capture.sections[1].order, -1000);
  capture.dispose();
  assert.equal(capture.sections.length, 0);
});

test('identity override can be disabled without reading its file', t => {
  const files = fixture(t);
  const capture = recorder();
  Plugin.apply(capture.ctx, validate({ promptFile: files.promptFile, shadowHarnessIdentity: false }));
  assert.equal(capture.sections.length, 1);
});

test('a missing identity file fails before registering either section', t => {
  const files = fixture(t);
  const capture = recorder();
  assert.throws(() => Plugin.apply(capture.ctx, validate({ ...files, identityFile: join(files.dir, 'absent.md') })), /ENOENT/);
  assert.equal(capture.sections.length, 0);
});

test('empty text fails explicitly; reactivation rereads modified text', t => {
  const files = fixture(t);
  writeFileSync(files.promptFile, '  \n');
  assert.throws(() => Plugin.apply(recorder().ctx, validate(files)), /empty/);
  writeFileSync(files.promptFile, 'Updated neutral text.');
  const capture = recorder();
  Plugin.apply(capture.ctx, validate(files));
  assert.equal(capture.sections[0].text, 'Updated neutral text.');
});

test('installed Loader mounts the file in one scope and disposes its sections', {
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
  const files = fixture(t);
  const pluginFile = process.env.DSH_PROMPT_MODULE || join(root, 'plugins/prompt-sections.mjs');
  const yamlFile = join(files.dir, 'cordis.yml');
  writeFileSync(yamlFile, JSON.stringify([{ id: 'prompt-file', name: pathToFileURL(pluginFile).href, config: {
    promptFile: files.promptFile, identityFile: files.identityFile,
  } }]));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt, {});
  const key = { agent: 'with-prompt-file' };
  const scope = createScope(ctx, key);
  const include = await scope.ctx.plugin(Include, { path: pathToFileURL(yamlFile).href });
  const rendered = () => ctx.systemPrompt.assemble({ scope: key }).then(renderPrompt);
  assert.equal(await rendered(), 'Neutral identity.\n\nNeutral extra {{literal}}.');
  assert.ok(!(await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'dsh-prompt-overlay:kernel'));
  const other = { agent: 'unaffected' };
  assert.match(renderPrompt(await ctx.systemPrompt.assemble({ scope: other })), /DeepSeek Harness/);
  await include.dispose();
  assert.ok(!((await ctx.systemPrompt.assemble({ scope: key })).sections.some(section => section.name === 'dsh-prompt-overlay:kernel')));
  assert.match(await rendered(), /DeepSeek Harness/);
});
