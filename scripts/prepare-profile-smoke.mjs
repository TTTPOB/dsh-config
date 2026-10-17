#!/usr/bin/env node
// Prepare public, credential-free smoke input; this command does not install or start a Host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { root, readYaml, readDependencyCatalog, renderMachine, validatePatch, resolvesFromProfile } from './lib.mjs';

const tarballDir = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? join(root, 'generated/profile-smoke-input'));
const catalog = readDependencyCatalog();
const assets = new Map();
for (const file of readdirSync(tarballDir).filter(name => name.endsWith('.tgz'))) {
  const path = join(tarballDir, file);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }));
  assert.ok(!assets.has(manifest.name), `Duplicate tarballs: ${manifest.name}`);
  assets.set(manifest.name, { path, version: manifest.version });
}
const missing = [];
for (const item of catalog.packages.filter(item => item.policy === 'release')) {
  const asset = assets.get(item.package);
  if (!asset) missing.push(item.package);
  else assert.equal(asset.version, item.version, `Catalog/tarball version differs: ${item.package}`);
}
assert.equal(missing.length, 0, `Missing required smoke tarballs: ${missing.join(', ')}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const machine = readYaml(join(root, 'examples/workstation-machine.yaml'));
machine.features = { sessionTools: true, activeContext: true, promptOverlay: true };
machine.acp = { pressureDefault: { nudgeAtRatio: 0.70, resetBelowRatio: 0.65 }, pressureRoutes: [] };
machine.promptSections = { modulePath: join(root, 'plugins/prompt-sections.mjs'),
  promptFile: join(output, 'smoke-prompt.md'), identityFile: join(output, 'smoke-identity.md') };
writeFileSync(machine.promptSections.promptFile, 'This is a disposable profile composition smoke.\n', { mode: 0o600 });
writeFileSync(machine.promptSections.identityFile, 'You are a profile composition test agent.\n', { mode: 0o600 });
machine.homePrivate = '- insert: []\n'; machine.webPrivate = '- insert: []\n';
machine.installation = { globalWorkspace: { packages: ['.'] }, webPackage: { private: true,
  dependencies: Object.fromEntries(catalog.packages.filter(item => item.scope === 'profile').map(item => [item.package, item.version])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-mobile', 'dsh-mcp-panel'] } } } };
const machinePath = join(output, 'machine.yaml');
writeFileSync(machinePath, YAML.stringify(machine), { mode: 0o600 });
const { rendered } = renderMachine(machinePath, 'profile-smoke', catalog, { stage: false });
const homeRows = validatePatch(rendered.home).map(row => row.entry);
const presets = homeRows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => row.config.id);
const expectedEntries = catalog.packages.map(item => ({ name: item.package, version: item.version, scope: item.scope,
  ...(item.scope === 'profile' ? { profile: 'web' } : {}) }));
const config = { runtimeVersion: catalog.runtimeVersion, presets, acp: true,
  pressureDefault: machine.acp.pressureDefault, expectedBasic: readYaml(join(root, 'shared/defaults.yaml')).defaults.compaction,
  expectedPackages: [...expectedEntries.map(item => ({ ...item, profileOwned: resolvesFromProfile(item, expectedEntries, 'web') })),
    { name: '@deepseek-ai/dsh-client-ui-settings', version: catalog.runtimeVersion, scope: 'global-override' }],
  compatibility: [...new Set(catalog.packages.filter(item => item.policy === 'release').map(item => `${item.package}@${item.version}`))] };
const controlledHome = rendered.home.replace('    - id: mcp-codegraph\n', '    - id: mcp-codegraph\n      disabled: true\n') + YAML.stringify([
  { insert: [{ id: 'profile-smoke-probe', name: join(root, 'scripts/profile-smoke-probe.mjs'), config }] },
]);
const controlledWeb = rendered.web + YAML.stringify([
  { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'none' } },
  { id: 'directory-picker', disabled: true },
  { insert: [
    { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
  ] },
  { insert: [{ id: 'firecrawl-fetch-smoke', name: '@firecrawl/dsh-firecrawl/fetch', config: { apiKey: 'smoke-unused-key' } }] },
]);
machine.deployment = { smoke: { cwd: root, resultFile: 'profile-smoke-report.json', argv: [process.execPath, join(root, 'scripts/profile-smoke.mjs'), '{testRoot}', '{home}'],
  homePatch: controlledHome, webPatch: controlledWeb } };
writeFileSync(machinePath, YAML.stringify(machine), { mode: 0o600 });
const argv = [process.execPath, join(root, 'scripts/dsh-config.mjs'), 'test', machinePath];
for (const name of [...new Set(catalog.packages.filter(item => item.policy === 'release').map(item => item.package))]) {
  argv.push('--tarball', `${name}=${assets.get(name).path}`);
}
writeFileSync(join(output, 'argv.json'), JSON.stringify(argv, null, 2) + '\n', { mode: 0o600 });
console.log(`Prepared ${presets.length} presets and ${assets.size} tarballs. Next: node scripts/run-profile-smoke.mjs ${JSON.stringify(join(output, 'argv.json'))}`);
