import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { root, readYaml, resolveDependencyTargets, parseCommandArguments, renderMachine as render } from '../scripts/lib.mjs';
import { deploymentTargets, updateMachine as update, isolatedTest, runStep, grantVerifiedCompatibility } from '../scripts/deployment.mjs';

const url = 'https://github.com/example/plugin/releases/download/v2.0.0/plugin-2.0.0.tgz';
const catalog = { schemaVersion: 2, packages: [
  { package: 'managed-runtime', scope: 'global-override', policy: 'registry', version: '2.0.0' },
  { package: 'managed-plugin', scope: 'profile', policy: 'release', version: '2.0.0', url },
  { package: 'workstation-plugin', scope: 'profile', policy: 'registry', version: '1.0.0' },
] };
const read = path => readFileSync(path, 'utf8');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

const updateMachine = (path, label, apply, options = {}) => update(path, label, apply, { ...options, generatedDir: join(dirname(path), 'generated') });
const renderMachine = (path, label, catalog) => render(path, label, catalog, { generatedDir: join(dirname(path), 'generated') });

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-deployment-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t) {
  const directory = temporaryDirectory(t);
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

const verifiedCatalog = { ...catalog, verifiedCompatibility: { 'managed-plugin@2.0.0': ['0.1.7-rc.2'] } };
const denied = { runtimeVersion: '0.1.7-rc.2', blocked: 1, issues: [
  { profile: 'web', name: 'managed-plugin', version: '2.0.0', status: 'compatibility-blocked' },
] };

test('apply grants a recorded installed exact pair, rechecks doctor and then converges without more writes', async t => {
  const { machinePath, directory, home } = fixture(t);
  let accepted = false, installs = 0, grants = 0, inspections = 0;
  const dependencies = { catalog: verifiedCatalog, runStep: () => installs++,
    doctor: async () => { inspections++; return accepted ? healthy() : denied; },
    grantExemption: async (profile, identity, runtime, enabled, acceptRisk) => {
      assert.equal(profile, join(home, 'profiles/web'));
      assert.equal(identity, 'managed-plugin@2.0.0');
      assert.equal(runtime, '0.1.7-rc.2');
      assert.equal(enabled, true); assert.equal(acceptRisk, true);
      grants++; accepted = true;
    },
  };
  const label = basename(directory) + '-verified';
  await updateMachine(machinePath, label, false, dependencies);
  assert.equal(inspections + installs + grants, 0, 'preview stays read-only');
  const first = await updateMachine(machinePath, label, true, dependencies);
  assert.equal(first.apply, true); assert.equal(first.granted.length, 1);
  assert.equal(inspections, 3); assert.equal(installs, 2); assert.equal(grants, 1);
  const mtime = statSync(join(home, 'cordis.patch.yml')).mtimeMs;
  const second = await updateMachine(machinePath, label, true, dependencies);
  assert.equal(second.noOp, true); assert.equal(installs, 2); assert.equal(grants, 1);
  assert.equal(statSync(join(home, 'cordis.patch.yml')).mtimeMs, mtime);
});

test('unknown installed version, runtime or source finding cannot acquire a recorded exemption', async t => {
  const { machine, machinePath } = fixture(t);
  const targets = deploymentTargets(machine, 'unused', verifiedCatalog);
  const grant = () => assert.fail('unverified pair was granted');
  await assert.rejects(updateMachine(machinePath, 'test-unknown-pair', true, {
    catalog, doctor: async () => denied, runStep: () => {}, grantExemption: grant,
  }), /doctor blocked/);
  const newer = { ...denied, issues: [{ ...denied.issues[0], version: '2.0.1' }] };
  assert.deepEqual(await grantVerifiedCompatibility(machine, targets, newer, verifiedCatalog, grant), []);
  assert.deepEqual(await grantVerifiedCompatibility(machine, targets, { ...denied, runtimeVersion: '0.1.7-rc.3' }, verifiedCatalog, grant), []);
  assert.deepEqual(await grantVerifiedCompatibility(machine, targets, { ...denied, issues: [...denied.issues, { status: 'declared-source-mismatch' }] }, verifiedCatalog, grant), []);
});

test('installer output is already visible in the private log before the command exits unsuccessfully', t => {
  const directory = temporaryDirectory(t);
  const log = join(directory, 'profile-install.log');
  const program = 'console.log("installation-progress"); const fs=require("node:fs"); if (!fs.readFileSync(process.argv[1],"utf8").includes("installation-progress")) process.exit(99); console.error("installation-failed"); process.exit(7);';
  assert.throws(() => runStep([process.execPath, '-e', program, log], directory, process.env, { logDir: directory }), /profile-install, 7/);
  assert.match(read(log), /installation-progress/);
  assert.match(read(log), /installation-failed/);
});

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

test('patch-only plugins keep dependencies but remove duplicate bundle activation', () => {
  const selected = { packages: [{ ...catalog.packages[1], patchOnly: true }] };
  const target = resolveDependencyTargets('unused', { webPackage: { dependencies: { 'managed-plugin': 'file:old.tgz' },
    dsh: { profile: { bundles: ['official-base', 'managed-plugin', 'client-only-bundle'] } } } }, selected);
  assert.equal(target.profiles.web.dependencies['managed-plugin'], url);
  assert.deepEqual(target.profiles.web.dsh.profile.bundles, ['official-base', 'client-only-bundle']);
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

test('missing assets remain visible blockers without a file fallback and patch rendering still succeeds', t => {
  const { machine, machinePath } = fixture(t);
  const missing = { schemaVersion: 2, packages: [{ ...catalog.packages[1], url: undefined, reason: 'not published' }] };
  const target = deploymentTargets(machine, 'unused', missing);
  assert.equal(target.entries.find(row => row.name === 'managed-plugin').status, 'blocked-missing-release');
  assert.ok(!('managed-plugin' in target.profiles.web.dependencies));
  const { rendered } = renderMachine(machinePath, 'test-missing-release', missing);
  assert.ok(rendered.home.includes('!!js'));
});

test('machine deployment reads live unrelated dependencies even when stale installation inputs are present', t => {
  const { machine } = fixture(t);
  const targets = deploymentTargets(machine, 'unused', catalog);
  assert.equal(targets.globalWorkspace.overrides['live-unrelated'], '4.0.0');
  assert.equal(targets.profiles.web.dependencies['live-profile-plugin'], '4.0.0');
});

test('preview and blocked apply cannot call installers or touch target files', async t => {
  const { machine, machinePath } = fixture(t);
  const before = read(machine.deployment.globalWorkspacePath);
  const dependencies = { catalog, offline: true, runStep: () => assert.fail('preview installed'), doctor: () => assert.fail('preview inspected installation') };
  const { apply } = parseCommandArguments(['update', '--machine', 'server']);
  const preview = await updateMachine(machinePath, 'test-preview', apply, dependencies);
  assert.equal(preview.apply, false);
  const missing = { packages: [{ ...catalog.packages[0], policy: 'release', reason: 'missing' }] };
  await assert.rejects(updateMachine(machinePath, 'test-preview', true, { ...dependencies, offline: false, catalog: missing }), /Apply blocked/);
  assert.equal(read(machine.deployment.globalWorkspacePath), before);
});

test('apply backs up manifests and lockfiles; a second aligned apply does no installation or target write', async t => {
  const { machine, machinePath, home, directory } = fixture(t);
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
  const backups = readdirSync(join(directory, 'generated')).filter(name => name.startsWith(label + '-backup-')).length;
  const second = await updateMachine(machinePath, label, true, dependencies);
  assert.equal(second.noOp, true);
  assert.ok(!existsSync(join(directory, 'generated', label)), 'aligned apply does not create staging files');
  assert.equal(calls.length, 2);
  assert.equal(statSync(patch).mtimeMs, mtime);
  assert.equal(readdirSync(join(directory, 'generated')).filter(name => name.startsWith(label + '-backup-')).length, backups);
  assert.equal(readYaml(machine.deployment.globalWorkspacePath).overrides['live-unrelated'], '4.0.0');
  assert.equal(readYaml(machine.deployment.profiles.web.packagePath).dependencies['live-profile-plugin'], '4.0.0');
});

test('apply with omitted deployment discovers fixture targets and remains idempotent', async t => {
  const { machine, machinePath, home, directory } = fixture(t);
  const paths = machine.deployment;
  delete machine.deployment;
  writeJson(machinePath, machine);
  let calls = 0;
  const dependencies = { catalog, doctor: healthy, runStep: () => calls++, discovery: {
    env: { DSH_HOME: home }, userHome: directory, query: args => {
      if (args[0] === 'root') return join(directory, 'installation');
      if (args[0] === 'bin') return paths.globalBinDir;
      if (args[0] === 'config') return join(directory, 'installation');
      return JSON.stringify([{ dependencies: { '@deepseek-ai/dsh': { path: join(directory, 'installation') } } }]);
    },
  } };
  const label = basename(directory) + '-defaults';
  const preview = await updateMachine(machinePath, label, false, dependencies);
  assert.equal(calls, 0);
  const applied = await updateMachine(machinePath, label, true, dependencies);
  assert.deepEqual(preview.entries, applied.entries);
  const result = await updateMachine(machinePath, label, true, dependencies);
  assert.equal(result.input, 'live');
  assert.equal(result.noOp, true);
  assert.equal(calls, 2);
});

test('matching manifests do not conceal missing actual packages', async t => {
  const { machinePath } = fixture(t);
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

test('post-install compatibility denial retains backups and untouched patches; authorized retry only applies configuration', async t => {
  const { machinePath, home, machine } = fixture(t);
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

test('isolated entry copies local tarballs and passes exact argv to an existing smoke without mutating formal input', t => {
  const directory = temporaryDirectory(t);
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
  }, { generatedDir: join(directory, 'generated') });
  assert.equal(result.cleaned, true);
  assert.deepEqual(readdirSync(join(directory, 'generated')), []);
  assert.throws(() => isolatedTest(machinePath, 'test-smoke-failure', [`dsh-session-tools=${tarball}`], () => { throw new Error('controlled smoke failure'); }, { generatedDir: join(directory, 'generated') }), /controlled smoke failure/);
  assert.deepEqual(readdirSync(join(directory, 'generated')), []);
  machine.deployment.smoke.argv = [process.execPath, '-e', 'console.log("controlled smoke")'];
  writeJson(machinePath, machine);
  assert.equal(isolatedTest(machinePath, 'test-smoke-log', [], undefined, { generatedDir: join(directory, 'generated') }).cleaned, true);
  assert.deepEqual(readdirSync(join(directory, 'generated')), []);
  machine.deployment.smoke.argv = [process.execPath, '-e', 'process.exit(7)'];
  writeJson(machinePath, machine);
  assert.throws(() => isolatedTest(machinePath, 'test-smoke-log-failure', [], undefined, { generatedDir: join(directory, 'generated') }), /profile-install, 7.*cleaned/);
  assert.deepEqual(readdirSync(join(directory, 'generated')), []);
  writeFileSync(machinePath, before);
  assert.equal(result.smokeOwnsInstallation, true);
  assert.equal(result.renderedConfigurationVerified, false);
  assert.equal(read(machinePath), before);
});

test('offline update ignores deployment paths and never invokes local discovery', async t => {
  const { machine, machinePath } = fixture(t);
  machine.deployment = { home: '$UNDEFINED_OFFLINE_VAR', globalWorkspacePath: '/missing/local/workspace' };
  writeJson(machinePath, machine);
  const result = await updateMachine(machinePath, 'test-offline-preview', false, {
    catalog, offline: true, discovery: { query: () => assert.fail('offline queried pnpm') },
  });
  assert.equal(result.input, 'offline');
  assert.ok(!result.entries.some(row => row.name === 'live-unrelated'));
  assert.ok(result.entries.some(row => row.name === 'declared-unrelated'));
  await assert.rejects(updateMachine(machinePath, 'test-offline-preview', true, { catalog, offline: true }), /cannot be combined/);
});

test('default live preview reads targets but never invokes doctor or installation', async t => {
  const { machinePath } = fixture(t);
  const result = await updateMachine(machinePath, 'test-live-preview', false, {
    catalog, doctor: () => assert.fail('live preview inspected'), runStep: () => assert.fail('live preview installed'),
  });
  assert.equal(result.input, 'live');
  assert.ok(result.entries.some(row => row.name === 'live-unrelated'));
});

test('live preview reports a missing local target with field context', async t => {
  const { machine, machinePath } = fixture(t);
  machine.deployment.globalWorkspacePath = '/missing/deployment-target/pnpm-workspace.yaml';
  writeJson(machinePath, machine);
  await assert.rejects(updateMachine(machinePath, 'test-missing-target', false, { catalog }), /Missing local deployment.globalWorkspacePath target/);
});

test('CLI rejects plan without a compatibility alias', () => {
  assert.throws(() => parseCommandArguments(['plan', '--machine', 'server']), /Usage: dsh-config <render\|check\|doctor\|test\|update>/);
});

test('CLI accepts apply only for update and local tarballs only for test', () => {
  assert.deepEqual(parseCommandArguments(['update', '--machine', 'server', '--apply']), { command: 'update', machineArgument: 'server', apply: true });
  assert.deepEqual(parseCommandArguments(['test', '--machine', 'server', '--tarball', 'plugin=/example/plugin.tgz']), { command: 'test', machineArgument: 'server', tarballs: ['plugin=/example/plugin.tgz'] });
  assert.deepEqual(parseCommandArguments(['update', '--machine', 'server', '--offline']), { command: 'update', machineArgument: 'server', offline: true });
  assert.throws(() => parseCommandArguments(['render', '--machine', 'server', '--offline']));
  assert.throws(() => parseCommandArguments(['update', '--machine', 'server', '--offline', '--apply']), /cannot be combined/);
  assert.throws(() => parseCommandArguments(['update', '--machine', 'server', '--live']));
  assert.throws(() => parseCommandArguments(['doctor', '--machine', 'server', '--apply']));
  assert.throws(() => parseCommandArguments(['update', '--machine', 'server', '--tarball', 'plugin=/example/plugin.tgz']));
});
