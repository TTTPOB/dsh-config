import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readYaml, root } from '../scripts/lib.mjs';
import { globalInstallArguments, resolveInstalledHost, doctor, updateMachine } from '../scripts/deployment.mjs';

// Local test tarballs are consumed only by this independent pnpm global root.
test('one apply upgrades the real pnpm global layout, grants a verified pair and converges', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pnpm-global-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const globalDir = join(directory, 'global');
  const bin = join(directory, 'bin');
  const globalRoot = join(globalDir, 'v11');
  mkdirSync(globalRoot, { recursive: true });
  mkdirSync(bin);
  const packageDirectory = join(directory, 'package');
  mkdirSync(packageDirectory);
  const pack = marker => {
    const version = marker === 'first' ? '0.1.7-rc.2' : '0.1.7-rc.2-fork1';
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version, type: 'module', exports: { '.': './index.js', './package.json': './package.json' }, bin: { 'dsh-test-fixture': 'index.js' }, files: ['index.js'],
      ...(marker === 'second' ? { peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.7-rc.2-fork999' } } : {}),
    }));
    writeFileSync(join(packageDirectory, 'index.js'), '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(marker) + ')\n');
    const target = join(directory, marker);
    mkdirSync(target);
    execFileSync('pnpm', ['pack', '--pack-destination', target], { cwd: packageDirectory, stdio: 'pipe' });
    return join(target, `deepseek-ai-dsh-base-${version}.tgz`);
  };
  const first = pack('first');
  const second = pack('second');
  const workspace = join(globalRoot, 'pnpm-workspace.yaml');
  // Install the real peer version while retaining the fixture manifest's deliberate compatibility rejection.
  writeFileSync(workspace, JSON.stringify({ overrides: { '@deepseek-ai/dsh-base': 'file:' + first, '@deepseek-ai/dsh-base>@deepseek-ai/dsh-tools': '0.1.7-rc.2' } }));
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  const argv = ['--config.enable-global-virtual-store=false', `--config.global-dir=${globalDir}`, `--config.global-bin-dir=${bin}`, 'add', '--global', '@deepseek-ai/dsh@0.1.7-rc.2'];
  execFileSync('pnpm', argv, { cwd: globalRoot, env, stdio: 'pipe', timeout: 120000 });
  const deployment = { globalWorkspacePath: workspace, globalDir, globalBinDir: bin, hostManifest: join(directory, 'stale-host.json') };
  const oldAnchor = resolveInstalledHost(deployment);
  assert.ok(readFileSync(join(dirname(createRequire(oldAnchor).resolve('@deepseek-ai/dsh-base/package.json')), 'index.js'), 'utf8').includes('first'));
  const home = join(directory, 'home');
  const profile = join(home, 'profiles/web');
  mkdirSync(profile, { recursive: true });
  const packagePath = join(profile, 'package.json');
  writeFileSync(packagePath, JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  const machine = readYaml(join(root, 'examples/server-machine.yaml'));
  machine.installation = {};
  machine.deployment = { ...deployment, hostManifest: oldAnchor, home, profiles: { web: { packagePath } } };
  const machinePath = join(directory, 'machine.yaml');
  writeFileSync(machinePath, JSON.stringify(machine));
  const catalog = { packages: [{ package: '@deepseek-ai/dsh-base', scope: 'global-override', policy: 'release', version: '0.1.7-rc.2-fork1', url: 'file:' + second }],
    verifiedCompatibility: { '@deepseek-ai/dsh-base@0.1.7-rc.2-fork1': ['0.1.7-rc.2'] } };
  const options = { catalog, generatedDir: join(directory, 'generated') };
  const before = await doctor(machine, { entries: [{ name: '@deepseek-ai/dsh-base', scope: 'global-override', version: '0.1.7-rc.2', target: 'file:' + first }] });
  assert.deepEqual(before.issues, []);
  assert.equal(globalInstallArguments(deployment).at(-1), '@deepseek-ai/dsh@0.1.7-rc.2');
  const applied = await updateMachine(machinePath, 'global-upgrade', true, options);
  assert.equal(applied.granted.length, 1, 'one apply upgrades an old installation and grants the verified pair');
  const after = await doctor(machine, { entries: [{ name: '@deepseek-ai/dsh-base', scope: 'global-override', version: '0.1.7-rc.2-fork1', target: 'file:' + second }] });
  assert.deepEqual(after.issues, []);
  assert.notEqual(before.checks[0].entry, after.checks[0].entry, 'inspection follows the new installation layout');
  assert.ok(readFileSync(after.checks[0].entry, 'utf8').includes('second'));
  assert.equal((await updateMachine(machinePath, 'global-upgrade', true, options)).noOp, true);
  const current = resolveInstalledHost({ ...deployment, hostManifest: oldAnchor });
  assert.ok(readFileSync(join(dirname(createRequire(current).resolve('@deepseek-ai/dsh-base/package.json')), 'index.js'), 'utf8').includes('second'));
  assert.equal(readYaml(workspace).overrides['@deepseek-ai/dsh-base'], 'file:' + second);
  const plugin = join(profile, 'node_modules/dsh-fixture-plugin');
  mkdirSync(plugin, { recursive: true });
  const pluginManifest = { name: 'dsh-fixture-plugin', version: '1.0.0', type: 'module', exports: { '.': { import: './index.js' } } };
  writeFileSync(join(plugin, 'package.json'), JSON.stringify(pluginManifest));
  writeFileSync(join(plugin, 'index.js'), 'throw new Error("doctor must not import plugins")\n');
  writeFileSync(packagePath, JSON.stringify({ private: true, dependencies: { 'dsh-fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } } }));
  machine.deployment.hostManifest = current;
  const targets = { entries: [{ name: 'dsh-fixture-plugin', scope: 'profile', profile: 'web', version: '1.0.0', target: '1.0.0' }] };
  const healthy = await doctor(machine, targets);
  assert.deepEqual(healthy.issues, [], 'ordinary profile package with import-only exports resolves through the formal Host resolver');
  const changed = await doctor(machine, { entries: [{ ...targets.entries[0], version: '2.0.0' }] });
  assert.equal(changed.issues[0].status, 'installed-version-mismatch');
  renameSync(join(plugin, 'index.js'), join(plugin, 'missing.js'));
  const missing = await doctor(machine, targets);
  assert.ok(missing.issues.some(issue => ['invalid-built-entry', 'missing-built-entry'].includes(issue.status)
    && (issue.entry === join(plugin, 'index.js') || issue.detail?.includes(join(plugin, 'index.js')))), JSON.stringify(missing.issues));
  writeFileSync(join(plugin, 'source.ts'), 'export const fixture = true;\n');
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ ...pluginManifest, exports: { '.': './source.ts' } }));
  const sourceEntry = await doctor(machine, targets);
  assert.ok(sourceEntry.issues.some(issue => issue.entry === join(plugin, 'source.ts') && issue.reason === 'resolved-to-typescript-source'));
  renameSync(join(plugin, 'missing.js'), join(plugin, 'index.js'));
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ ...pluginManifest, peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.7-rc.2-fork999' } }));
  const denied = await doctor(machine, targets);
  assert.ok(denied.issues.some(issue => issue.status === 'compatibility-blocked' && issue.reason.includes('0.1.7-rc.2-fork999')));
});
