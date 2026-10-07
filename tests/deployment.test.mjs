import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { root, readYaml, resolveDependencyTargets, parseCommandArguments, renderMachine } from '../scripts/lib.mjs';
import { deploymentTargets, updateMachine, isolatedTest } from '../scripts/deployment.mjs';

const url = 'https://github.com/example/plugin/releases/download/v2.0.0/plugin-2.0.0.tgz';
const catalog = { schemaVersion: 2, packages: [
  { package: 'managed-runtime', scope: 'global-override', policy: 'registry', version: '2.0.0' },
  { package: 'managed-plugin', scope: 'profile', policy: 'release', version: '2.0.0', url },
  { package: 'workstation-plugin', scope: 'profile', policy: 'registry', version: '1.0.0' },
] };
const read = path => readFileSync(path, 'utf8');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function fixture() {
  mkdirSync(join(root, 'generated'), { recursive: true });
  const directory = mkdtempSync(join(root, 'generated', 'deployment-test-'));
  const globalDirectory = join(directory, 'installation');
  const home = join(directory, 'home');
  const profileDirectory = join(home, 'profiles/web');
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(profileDirectory, { recursive: true });
  const machine = readYaml(join(root, 'examples/server-machine.yaml'));
  machine.installation = {
    globalWorkspace: { overrides: { 'managed-runtime@1.0.0': 'file:old.tgz', 'declared-unrelated': '1.0.0' } },
    webPackage: { private: true, dependencies: { 'managed-plugin': 'file:old.tgz' } },
  };
  machine.deployment = {
    globalWorkspacePath: join(globalDirectory, 'pnpm-workspace.yaml'),
    hostManifest: join(globalDirectory, 'package.json'), home, globalBinDir: join(directory, 'bin'),
    profiles: { web: { packagePath: join(profileDirectory, 'package.json') } },
  };
  writeJson(machine.deployment.globalWorkspacePath, { overrides: { 'managed-runtime@1.0.0': 'file:old.tgz', 'live-unrelated': '4.0.0' } });
  writeJson(machine.deployment.hostManifest, { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', private: true });
  writeJson(machine.deployment.profiles.web.packagePath, { private: true, dependencies: { 'managed-plugin': 'file:old.tgz', 'live-profile-plugin': '4.0.0' } });
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profileDirectory, 'cordis.patch.yml'), '[]\n');
  const machinePath = join(directory, 'machine.yaml');
  writeJson(machinePath, machine);
  return { directory, home, machine, machinePath };
}

const healthy = async () => ({ issues: [], blocked: 0 });

test('shared selections replace duplicate versions, preserve selectors and do not activate absent exclusive plugins', () => {
  const target = resolveDependencyTargets('unused', {
    globalWorkspace: { overrides: { 'managed-runtime@1.0.0': 'file:/private/old.tgz', other: '^3.0.0' } },
    webPackage: { dependencies: { 'managed-plugin': 'file:/private/old.tgz', 'dsh-mcp-panel': '0.6.19' } },
  }, catalog);
  assert.equal(target.globalWorkspace.overrides['managed-runtime@1.0.0'], '2.0.0');
  assert.equal(target.globalWorkspace.overrides.other, '^3.0.0');
  assert.equal(target.profiles.web.dependencies['managed-plugin'], url);
  assert.ok(!('workstation-plugin' in target.profiles.web.dependencies));
  assert.ok(!target.entries.some(row => row.name === 'workstation-plugin'));
  assert.equal(target.entries.find(row => row.name === 'dsh-mcp-panel').status, 'unmanaged-registry-pin');
  assert.ok(!JSON.stringify(target.entries).includes('/private/'));
});

test('explicit consuming profiles share managed versions without installing absent plugins', () => {
  const target = resolveDependencyTargets('unused', {
    webPackage: { dependencies: { 'managed-plugin': 'file:old.tgz' } },
    profiles: { headless: { dependencies: { 'managed-plugin': 'file:other.tgz' } },
      research: { dependencies: { other: '1.0.0' } } },
  }, catalog);
  assert.equal(target.profiles.headless.dependencies['managed-plugin'], url);
  assert.ok(!('managed-plugin' in target.profiles.research.dependencies));
  const webOnly = { packages: [{ ...catalog.packages[1], profiles: ['web'] }] };
  const restricted = resolveDependencyTargets('unused', { profiles: { headless: { dependencies: { 'managed-plugin': 'file:other.tgz' } } } }, webOnly);
  assert.equal(restricted.profiles.headless.dependencies['managed-plugin'], 'file:other.tgz');
});

test('missing assets remain visible blockers without a file fallback and patch rendering still succeeds', () => {
  const { machine, machinePath } = fixture();
  const missing = { schemaVersion: 2, packages: [{ ...catalog.packages[1], url: undefined, reason: 'not published' }] };
  const target = deploymentTargets(machine, 'unused', missing);
  assert.equal(target.entries.find(row => row.name === 'managed-plugin').status, 'blocked-missing-release');
  assert.ok(!('managed-plugin' in target.profiles.web.dependencies));
  const { rendered } = renderMachine(machinePath, 'test-missing-release', missing);
  assert.ok(rendered.home.includes('!!js'));
});

test('machine deployment reads live unrelated dependencies even when stale installation inputs are present', () => {
  const { machine } = fixture();
  const targets = deploymentTargets(machine, 'unused', catalog);
  assert.equal(targets.globalWorkspace.overrides['live-unrelated'], '4.0.0');
  assert.equal(targets.profiles.web.dependencies['live-profile-plugin'], '4.0.0');
});

test('preview and blocked apply cannot call installers or touch target files', async () => {
  const { machine, machinePath } = fixture();
  const before = read(machine.deployment.globalWorkspacePath);
  const dependencies = { catalog, runStep: () => assert.fail('preview installed'), doctor: () => assert.fail('preview inspected installation') };
  const preview = await updateMachine(machinePath, 'test-preview', false, dependencies);
  assert.equal(preview.apply, false);
  const missing = { packages: [{ ...catalog.packages[0], policy: 'release', reason: 'missing' }] };
  await assert.rejects(updateMachine(machinePath, 'test-preview', true, { ...dependencies, catalog: missing }), /Apply blocked/);
  assert.equal(read(machine.deployment.globalWorkspacePath), before);
});

test('apply backs up manifests and lockfiles; a second aligned apply does no installation or target write', async () => {
  const { machine, machinePath, home, directory } = fixture();
  const label = basename(directory) + '-render';
  const lock = join(home, 'profiles/web/pnpm-lock.yaml');
  writeFileSync(lock, 'original-lock\n');
  const calls = [];
  const dependencies = { catalog, doctor: healthy, runStep: (argv, cwd) => calls.push({ argv, cwd }) };
  const first = await updateMachine(machinePath, label, true, dependencies);
  assert.ok(first.backup);
  assert.equal(calls.length, 2);
  const backupPaths = JSON.parse(read(join(first.backup, 'files.json')));
  assert.equal(read(join(first.backup, String(backupPaths.indexOf(lock)))), 'original-lock\n');
  const patch = join(home, 'cordis.patch.yml');
  const mtime = statSync(patch).mtimeMs;
  const backups = readdirSync(join(root, 'generated')).filter(name => name.startsWith(label + '-backup-')).length;
  const second = await updateMachine(machinePath, label, true, dependencies);
  assert.equal(second.noOp, true);
  assert.ok(!existsSync(join(root, 'generated', label)), 'aligned apply does not create staging files');
  assert.equal(calls.length, 2);
  assert.equal(statSync(patch).mtimeMs, mtime);
  assert.equal(readdirSync(join(root, 'generated')).filter(name => name.startsWith(label + '-backup-')).length, backups);
  assert.equal(readYaml(machine.deployment.globalWorkspacePath).overrides['live-unrelated'], '4.0.0');
  assert.equal(readYaml(machine.deployment.profiles.web.packagePath).dependencies['live-profile-plugin'], '4.0.0');
});

test('matching manifests do not conceal missing actual packages', async () => {
  const { machinePath } = fixture();
  let installs = 0;
  await updateMachine(machinePath, 'test-missing-actual', true, { catalog, doctor: healthy, runStep: () => installs++ });
  let inspections = 0;
  const report = await updateMachine(machinePath, 'test-missing-actual', true, {
    catalog, runStep: () => installs++, doctor: async () => ++inspections === 1
      ? { issues: [{ status: 'missing-installed-package', name: 'managed-plugin' }], blocked: 1 }
      : { issues: [], blocked: 0 },
  });
  assert.equal(installs, 4);
  assert.equal(report.noOp, undefined);
});

test('post-install compatibility denial retains backups and untouched patches; authorized retry only applies configuration', async () => {
  const { machinePath, home, machine } = fixture();
  const patch = join(home, 'cordis.patch.yml');
  let installs = 0;
  await assert.rejects(updateMachine(machinePath, 'test-retry', true, { catalog,
    runStep: () => installs++, doctor: async () => ({ blocked: 1, issues: [{ status: 'compatibility-blocked', reason: 'official original reason' }] }),
  }), /backup retained/);
  assert.equal(read(patch), '[]\n');
  assert.equal(installs, 2);
  const report = await updateMachine(machinePath, 'test-retry', true, { catalog, runStep: () => assert.fail('retry reinstalled healthy packages'), doctor: healthy });
  assert.equal(report.apply, true);
  assert.ok(read(patch).includes('preset-standard-ptc'));
  assert.equal(readYaml(machine.deployment.profiles.web.packagePath).dependencies['live-profile-plugin'], '4.0.0');
});

test('isolated entry copies local tarballs and passes exact argv to an existing smoke without mutating formal input', () => {
  const directory = mkdtempSync(join(root, 'generated', 'smoke-entry-test-'));
  const machine = readYaml(join(root, 'examples/server-machine.yaml'));
  machine.installation = { webPackage: { private: true, dependencies: { 'dsh-session-tools': 'file:old.tgz' } } };
  machine.deployment = { smoke: { ownsInstallation: true, cwd: directory, argv: [process.execPath, 'existing-smoke.mjs', '{tarball:dsh-session-tools}'] } };
  const machinePath = join(directory, 'machine.yaml');
  writeJson(machinePath, machine);
  const tarball = join(directory, 'plugin.tgz');
  writeFileSync(tarball, 'tarball-canary');
  const before = read(machinePath);
  const result = isolatedTest(machinePath, 'test-smoke-entry', [`dsh-session-tools=${tarball}`], (argv, cwd, env) => {
    assert.equal(argv[1], 'existing-smoke.mjs');
    assert.notEqual(argv[2], tarball);
    assert.equal(read(argv[2]), 'tarball-canary');
    assert.equal(cwd, directory);
    assert.ok(env.DSH_HOME.startsWith(env.DSH_CONFIG_TEST_ROOT));
    assert.equal(read(join(env.DSH_HOME, 'cordis.patch.yml')), '[]\n');
    assert.ok(readYaml(join(env.DSH_HOME, 'profiles/web/package.json')).dependencies['dsh-session-tools'].startsWith('file:'));
  });
  assert.equal(result.smokeOwnsInstallation, true);
  assert.equal(result.renderedConfigurationVerified, false);
  assert.equal(read(machinePath), before);
});

test('CLI accepts apply only for update and local tarballs only for test', () => {
  assert.deepEqual(parseCommandArguments(['update', '--machine', 'server', '--apply']), { command: 'update', machineArgument: 'server', apply: true });
  assert.deepEqual(parseCommandArguments(['test', '--machine', 'server', '--tarball', 'plugin=/example/plugin.tgz']), { command: 'test', machineArgument: 'server', tarballs: ['plugin=/example/plugin.tgz'] });
  assert.throws(() => parseCommandArguments(['plan', '--machine', 'server', '--apply']));
});
