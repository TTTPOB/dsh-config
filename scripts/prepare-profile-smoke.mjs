#!/usr/bin/env node
// Prepare smoke input without installing or starting a Host. By default the input is public and
// credential-free; --private <machine> loads that machine's private rows except external services.
// --local package=/absolute/file.tgz replaces a managed package with an unpublished build for this
// smoke only; the dependency catalog itself is never changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { root, readYaml, readDependencyCatalog, renderMachine, validatePatch, resolvesFromProfile,
  withoutExternalPrivateRows } from './lib.mjs';

const args = process.argv.slice(2);
const privateIndex = args.indexOf('--private');
const privateMachine = privateIndex < 0 ? undefined : args.splice(privateIndex, 2)[1];
assert.ok(privateIndex < 0 || ['workstation', 'server', 'nas'].includes(privateMachine), '--private expects workstation, server or nas');
const locals = new Map();
for (let index; (index = args.indexOf('--local')) >= 0;) {
  const spec = args.splice(index, 2)[1] ?? '';
  const path = spec.slice(spec.indexOf('=') + 1);
  assert.ok(spec.indexOf('=') > 0 && isAbsolute(path) && path.endsWith('.tgz') && existsSync(path), '--local expects package=/absolute/file.tgz');
  locals.set(spec.slice(0, spec.indexOf('=')), path);
}
const tarballDir = resolve(args[0]);
const output = resolve(args[1] ?? join(root, `generated/profile-smoke-input${privateMachine ? `-${privateMachine}` : ''}`));
const catalog = structuredClone(readDependencyCatalog());
const manifestOf = path => JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }));
const assets = new Map();
for (const file of readdirSync(tarballDir).filter(name => name.endsWith('.tgz'))) {
  const path = join(tarballDir, file);
  const manifest = manifestOf(path);
  assert.ok(!assets.has(manifest.name), `Duplicate tarballs: ${manifest.name}`);
  assets.set(manifest.name, { path, version: manifest.version });
}
// A local build wins over the Release asset and its version becomes the expected one.
for (const [name, path] of locals) {
  const manifest = manifestOf(path);
  assert.equal(manifest.name, name, `--local tarball contains ${manifest.name}, not ${name}`);
  const items = catalog.packages.filter(item => item.package === name);
  assert.ok(items.length, `--local package is not managed: ${name}`);
  for (const item of items) item.version = manifest.version;
  assets.set(name, { path, version: manifest.version });
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
if (privateMachine) {
  const real = readYaml(join(root, 'private/machines', privateMachine, 'machine.yaml'));
  machine.overrides = real.overrides;
  machine.homePrivate = withoutExternalPrivateRows(real.homePrivate);
  machine.webPrivate = withoutExternalPrivateRows(real.webPrivate);
  // Real prompt files catch retired {{variables}}; paths from another machine keep the smoke files.
  for (const field of ['promptFile', 'identityFile']) {
    const path = real.promptSections?.[field];
    if (path && existsSync(path)) machine.promptSections[field] = path;
  }
}
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
const config = { runtimeVersion: catalog.runtimeVersion, presets, acp: true, privateMachine: privateMachine ?? null,
  pressureDefault: machine.acp.pressureDefault, expectedBasic: readYaml(join(root, 'shared/defaults.yaml')).defaults.compaction,
  expectedPackages: [...expectedEntries.map(item => ({ ...item, profileOwned: resolvesFromProfile(item, expectedEntries, 'web') })),
    { name: '@deepseek-ai/dsh-client-ui-settings', version: catalog.runtimeVersion, scope: 'global-override' }],
  compatibility: [...new Set(catalog.packages.filter(item => item.policy === 'release').map(item => `${item.package}@${item.version}`))] };
const controlledHome = rendered.home + YAML.stringify([
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
for (const name of new Set([...catalog.packages.filter(item => item.policy === 'release').map(item => item.package), ...locals.keys()])) {
  argv.push('--tarball', `${name}=${assets.get(name).path}`);
}
writeFileSync(join(output, 'argv.json'), JSON.stringify(argv, null, 2) + '\n', { mode: 0o600 });
console.log(`Prepared ${presets.length} presets and ${assets.size} tarballs (${locals.size} local). Next: node scripts/run-profile-smoke.mjs ${JSON.stringify(join(output, 'argv.json'))}`);
