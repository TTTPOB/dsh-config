import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, readYaml, renderMachine, validatePatch } from '../scripts/lib.mjs';
import { planLocalPlugins } from '../scripts/local-plugins.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-local-plugins-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const machine = readYaml(join(root, 'examples/server-machine.yaml'));
  const target = { baseURL: 'https://notes.example.invalid', headersFile: join(dir, 'unread-headers.json') };
  machine.localPlugins = [{ id: 'siyuan-tools', module: 'siyuan-tools.mjs', modulePath: join(dir, 'home/plugins/siyuan-tools.mjs'), config: { self: target, peer: target } }];
  const machinePath = join(dir, 'machine.yaml');
  writeFileSync(machinePath, JSON.stringify(machine));
  return { dir, machine, machinePath };
}

test('render/check plan and stage module source without importing modules, reading creds or writing the target', t => {
  const { dir, machine, machinePath } = fixture(t);
  const generatedDir = join(dir, 'generated');
  const options = { generatedDir, stage: false };
  const checked = renderMachine(machinePath, 'local-plugin', undefined, options);
  const row = validatePatch(checked.rendered.home).find(row => row.entry.id === 'siyuan-tools');
  assert.equal(row.operation, 'insert');
  assert.deepEqual(row.entry, { id: 'siyuan-tools', name: machine.localPlugins[0].modulePath, config: machine.localPlugins[0].config });
  assert.equal(checked.localPlugins[0].source, join(root, 'plugins/siyuan-tools.mjs'));
  assert.ok(!existsSync(generatedDir));
  const cli = spawnSync(process.execPath, [join(root, 'scripts/dsh-config.mjs'), 'check', machinePath], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /checks passed/);
  assert.ok(!existsSync(generatedDir));
  const staged = renderMachine(machinePath, 'local-plugin', undefined, { generatedDir });
  assert.equal(readFileSync(join(staged.output, 'plugins/siyuan-tools.mjs'), 'utf8'), readFileSync(checked.localPlugins[0].source, 'utf8'));
  assert.ok(!existsSync(machine.localPlugins[0].modulePath));
});

test('unknown/missing modules, traversal, duplicate targets and unsupported declarations fail before staging', t => {
  const { dir, machine, machinePath } = fixture(t);
  const entry = machine.localPlugins[0];
  for (const localPlugins of [null, {}, [{ ...entry, module: 'missing.mjs' }], [{ ...entry, module: '../plugins/siyuan-tools.mjs' }], [{ ...entry, modulePath: 'relative.mjs' }], [entry, entry], [{ ...entry, extra: true }], [{ ...entry, config: [] }]]) {
    writeFileSync(machinePath, JSON.stringify({ ...machine, localPlugins }));
    assert.throws(() => renderMachine(machinePath, 'invalid', undefined, { generatedDir: join(dir, 'generated') }));
    assert.ok(!existsSync(join(dir, 'generated')));
  }
  assert.deepEqual(planLocalPlugins(), []);
});

test('local plugin IDs cannot shadow existing home rows', t => {
  const { dir, machine, machinePath } = fixture(t);
  machine.localPlugins[0].id = 'progressive-tools';
  writeFileSync(machinePath, JSON.stringify(machine));
  assert.throws(() => renderMachine(machinePath, 'duplicate', undefined, { generatedDir: join(dir, 'generated') }), /Duplicate top-level id/);
  assert.ok(!existsSync(join(dir, 'generated')));
});

test('shared progressive disclosure keeps ordinary tools eager and MCP/SiYuan deferred', () => {
  const { rendered } = renderMachine(join(root, 'examples/server-machine.yaml'), 'disclosure', undefined, { stage: false });
  const config = validatePatch(rendered.home).find(row => row.entry.id === 'progressive-tools').entry.config;
  assert.equal(config.deferTools, undefined);
  assert.deepEqual(config.toolDisclosureRules, [
    { glob: '*', disclosure: 'eager' }, { glob: 'mcp__*', disclosure: 'deferred' }, { glob: 'siyuan_*', disclosure: 'deferred' },
  ]);
});
