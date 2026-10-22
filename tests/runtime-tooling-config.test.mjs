import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { root, readYaml, renderMachine, validatePatch, readDependencyCatalog, resolveDependencyTargets } from '../scripts/lib.mjs';
import { resolveLocalPlugins, planLocalPlugins } from '../scripts/local-plugins.mjs';
import { normalizeDeployment, updateMachine, rollbackMachine } from '../scripts/deployment.mjs';

const id = 'runtime-tooling-guidance';
const module = id + '.mjs';
const shared = readYaml(join(root, 'shared/defaults.yaml')).localPlugins;
const source = join(root, 'plugins', module);
const read = path => readFileSync(path, 'utf8');
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const catalog = { schemaVersion: 2, packages: [] };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-guidance-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const machine = readYaml(join(root, 'examples/server-machine.yaml'));
  const home = join(dir, 'home');
  machine.installation = { globalWorkspace: { packages: ['.'] }, webPackage: { private: true } };
  machine.deployment = { home, globalWorkspacePath: join(dir, 'installation/pnpm-workspace.yaml'),
    globalBinDir: join(dir, 'bin'), hostManifest: join(dir, 'installation/package.json'),
    profiles: { web: { packagePath: join(home, 'profiles/web/package.json') } } };
  mkdirSync(dirname(machine.deployment.globalWorkspacePath), { recursive: true });
  mkdirSync(dirname(machine.deployment.profiles.web.packagePath), { recursive: true });
  const targets = resolveDependencyTargets(join(dir, 'snapshot'), machine.installation, catalog, machine.features);
  write(machine.deployment.globalWorkspacePath, targets.globalWorkspace);
  write(machine.deployment.profiles.web.packagePath, targets.profiles.web);
  write(machine.deployment.hostManifest, { name: '@deepseek-ai/dsh', version: '0.1.0' });
  const input = join(dir, 'machine.yaml');
  write(input, machine);
  return { dir, home, machine, input };
}

test('one public declaration stages source and activates once in home without target writes or dependencies', t => {
  const { dir, home, input } = fixture(t);
  assert.deepEqual(shared, [{ id, module, config: {} }]);
  const result = renderMachine(input, 'runtime-guidance', catalog, { generatedDir: join(dir, 'generated') });
  const path = join(home, 'plugins', module);
  const rows = validatePatch(result.rendered.home).map(row => row.entry);
  assert.deepEqual(rows.filter(row => row.id === id), [{ id, name: path, config: {} }]);
  assert.ok(!result.rendered.web.includes(module));
  for (const row of rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')) assert.ok(!JSON.stringify(row).includes(module));
  assert.equal(result.localPlugins.filter(row => row.id === id).length, 1);
  assert.equal(read(join(result.output, 'plugins', module)), read(source));
  assert.equal(existsSync(path), false);
  assert.ok(!readDependencyCatalog().packages.some(row => row.package.includes(id)));
});

test('live and offline file plans agree; fixture apply backs up source and rollback restores it without installers', async t => {
  const { dir, home, input } = fixture(t);
  const path = join(home, 'plugins', module);
  const options = { catalog, generatedDir: join(dir, 'generated'),
    discovery: { query: () => assert.fail('explicit paths must not query pnpm') },
    doctor: async () => ({ issues: [], blocked: 0 }), runStep: () => assert.fail('must not install') };
  for (const offline of [false, true]) {
    const preview = await updateMachine(input, 'runtime-guidance', false, { ...options, offline });
    assert.equal(preview.files.filter(file => file.path === path).length, 1);
    assert.equal(preview.files.find(file => file.path === path).source, source);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(options.generatedDir), false);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '// original fixture source\n');
  const applied = await updateMachine(input, 'runtime-guidance', true, options);
  assert.equal(read(path), read(source));
  assert.equal(validatePatch(read(join(home, 'cordis.patch.yml'))).filter(row => row.entry.id === id).length, 1);
  assert.ok(JSON.parse(read(join(applied.backup, 'files.json'))).includes(path));
  const again = await updateMachine(input, 'runtime-guidance', true, options);
  assert.equal(again.noOp, true);
  await rollbackMachine(input, applied.backup, { runStep: () => {} });
  assert.equal(read(path), '// original fixture source\n');
});

test('machine same-id entry replaces the whole shared declaration; another id cannot copy the same module', () => {
  const local = { id, module, modulePath: '/neutral/custom/guidance.mjs', config: { text: { native: 'machine text' } } };
  const configured = [{ id, module, config: { text: { output: 'shared text' } } }];
  assert.deepEqual(resolveLocalPlugins(configured, { localPlugins: [local] }), [local]);
  assert.equal(planLocalPlugins(resolveLocalPlugins(configured, { localPlugins: [local] })).length, 1);
  assert.throws(() => resolveLocalPlugins(shared, { deployment: { home: '/neutral/home' }, localPlugins: [{ ...local, id: 'another-id' }] }), /same module/);
});

test('declarative homes never borrow inspecting HOME and disagreeing live defaults block instead of redirecting', () => {
  const fixed = { globalWorkspacePath: '/neutral/pnpm/pnpm-workspace.yaml', globalBinDir: '/neutral/bin', hostManifest: '/neutral/host/package.json' };
  for (const userHome of ['/neutral/first-user', '/neutral/second-user']) {
    const live = normalizeDeployment(fixed, { userHome, env: {}, query: () => assert.fail('queried pnpm') });
    const machine = { localPlugins: [{ id: 'provider-prompt', module: 'provider-prompt.mjs', modulePath: join(live.home, 'plugins/provider-prompt.mjs'), config: {} }] };
    const offline = planLocalPlugins(resolveLocalPlugins(shared, machine));
    const online = planLocalPlugins(resolveLocalPlugins(shared, machine, { home: live.home }));
    assert.equal(offline[0].path, join(live.home, 'plugins', module));
    assert.equal(online[0].path, offline[0].path);
    assert.throws(() => resolveLocalPlugins(shared, machine, { home: '/neutral/different-home' }), /differs/);
  }
  const home = '/neutral/explicit-home';
  const machine = { deployment: { home } };
  const live = normalizeDeployment({ ...fixed, home }, { userHome: '/neutral/unrelated-user', env: { DSH_HOME: '/neutral/unrelated-home' }, query: () => assert.fail('queried pnpm') });
  assert.deepEqual(resolveLocalPlugins(shared, machine), resolveLocalPlugins(shared, machine, { home: live.home }));
  const expanded = normalizeDeployment({ ...fixed, home: '$TARGET_HOME' }, { env: { TARGET_HOME: home }, query: () => assert.fail('queried pnpm') });
  assert.equal(resolveLocalPlugins(shared, { deployment: { home: '$TARGET_HOME' } }, { home: expanded.home })[0].modulePath, join(home, 'plugins', module));
});

test('missing or ambiguous offline homes and modulePath expressions fail, never silently expand', () => {
  assert.throws(() => resolveLocalPlugins(shared, {}), /requires deployment.home/);
  for (const home of ['~/.dsh', '$HOME/.dsh', '/neutral/$TARGET', { __jsExpr: 'process.env.DSH_HOME' }]) {
    assert.throws(() => resolveLocalPlugins(shared, { deployment: { home } }), /literal absolute/);
  }
  const entry = { id: 'provider-prompt', module: 'provider-prompt.mjs', config: {} };
  assert.throws(() => resolveLocalPlugins(shared, { localPlugins: [{ ...entry, modulePath: '/neutral/one/plugins/a.mjs' }, { ...entry, id: 'second', modulePath: '/neutral/two/plugins/b.mjs' }] }), /requires deployment.home/);
  for (const modulePath of ['$DSH_HOME/plugins/a.mjs', { __jsExpr: 'process.env.DSH_HOME' }]) {
    assert.throws(() => planLocalPlugins([{ ...entry, modulePath }]), /absolute/);
  }
  assert.throws(() => resolveLocalPlugins([{ id, module, modulePath: { __jsExpr: 'home' }, config: {} }], { deployment: { home: '/neutral/home' } }), /accepts only/);
});
