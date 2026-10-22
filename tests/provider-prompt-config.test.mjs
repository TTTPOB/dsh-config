import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, readYaml, readDependencyCatalog, renderMachine, validatePatch } from '../scripts/lib.mjs';
import { planLocalPlugins } from '../scripts/local-plugins.mjs';

const example = join(root, 'examples/local-plugins-machine.yaml');
const moduleName = 'provider-prompt.mjs';
const rows = rendered => validatePatch(rendered.home).map(row => row.entry).filter(row => row.id === 'provider-prompt');

test('provider prompt uses the existing localPlugins home file plan once, without a package dependency', () => {
  const machine = readYaml(example);
  const entry = machine.localPlugins.find(row => row.id === 'provider-prompt');
  assert.equal(entry.module, moduleName);
  const { rendered, localPlugins } = renderMachine(example, 'provider-prompt', undefined, { stage: false });
  assert.equal(rows(rendered).length, 1);
  assert.deepEqual(rows(rendered)[0], { id: entry.id, name: entry.modulePath, config: entry.config });
  const rule = rows(rendered)[0].config.rules[0];
  assert.deepEqual(rule.providers, ['klaude-cl']);
  assert.ok(!Object.hasOwn(rule, 'models'));
  for (const text of ['mcp__parking__run_code', 'mcp__parking__context_compress', 'tool_use', 'tools.bash', 'tools.read']) assert.ok(rule.text.includes(text));
  assert.equal(rows(rendered)[0].config.rules.length, 1);
  assert.equal(localPlugins.filter(row => row.id === entry.id).length, 1);
  assert.equal(localPlugins.find(row => row.id === entry.id).source, join(root, 'plugins', moduleName));
  assert.ok(!rendered.web.includes(moduleName));
  for (const row of validatePatch(rendered.home).map(row => row.entry).filter(row => row.name === '@deepseek-ai/dsh-agent-preset')) assert.ok(!JSON.stringify(row).includes(moduleName));
  assert.ok(!readDependencyCatalog().packages.some(row => row.package === 'dsh-provider-prompt'));
  assert.ok(!rendered.webPackage.includes('dsh-provider-prompt'));
  assert.ok(!rendered.globalWorkspace.includes('dsh-provider-prompt'));
});

test('local plugin configuration preserves empty rules, exact model lists and literal text without merging', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-provider-prompt-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const machine = readYaml(example);
  const modulePath = join(directory, 'home/plugins/provider-prompt.mjs');
  const path = join(directory, 'machine.yaml');
  for (const config of [{ rules: [] }, { rules: [{ providers: ['example-route'], models: ['exact-model'], text: '{{provider}} {{model}} [[ literal ]] ${literal}' }] }]) {
    machine.localPlugins = [{ id: 'provider-prompt', module: moduleName, modulePath, config }];
    writeFileSync(path, JSON.stringify(machine));
    const { rendered, localPlugins } = renderMachine(path, 'provider-prompt', undefined, { stage: false });
    assert.deepEqual(rows(rendered)[0].config, config);
    assert.equal(localPlugins[0].path, modulePath);
    assert.ok(!existsSync(modulePath));
  }
});

test('provider prompt requires an explicit local declaration, not a shared package fallback', () => {
  const machine = readYaml(example);
  const entry = machine.localPlugins.find(row => row.id === 'provider-prompt');
  const plan = planLocalPlugins([entry]);
  assert.equal(plan[0].row.name, entry.modulePath);
  for (const name of ['workstation', 'server', 'active-context', 'claude-image-recovery']) {
    const { rendered } = renderMachine(join(root, 'examples/' + name + '-machine.yaml'), 'provider-prompt-absent', undefined, { stage: false });
    assert.equal(rows(rendered).length, 0);
  }
});
