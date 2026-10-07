import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import YAML from 'yaml';

export const root = fileURLToPath(new URL('../', import.meta.url));
const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: expression => ({ __jsExpr: expression }),
};

// Expressions are data, never executable code in this repository.
export function parseYaml(text) {
  const document = YAML.parseDocument(text, { customTags: [jsTag] });
  if (document.errors.length || document.warnings.length) {
    throw new Error('Invalid YAML or unsupported YAML tag');
  }
  return document.toJS();
}

export function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

export function validateMachine(machine) {
  assert.equal(machine.schemaVersion, 1, 'Unsupported machine schema');
  for (const key of ['sessionTools', 'promptOverlay', 'legacySessionQuery']) {
    assert.equal(typeof machine.features?.[key], 'boolean', `Missing feature: ${key}`);
  }
  if (machine.features.promptOverlay) {
    for (const field of ['modulePath', 'promptFile', 'identityFile']) {
      assert.ok(typeof machine.promptSections?.[field] === 'string' && isAbsolute(machine.promptSections[field]), `Missing absolute prompt path: ${field}`);
    }
  }
  assert.ok(machine.overrides && typeof machine.overrides === 'object', 'Missing overrides');
  for (const key of ['homePrivate', 'webPrivate']) {
    assert.equal(typeof machine[key], 'string', `Missing literal YAML: ${key}`);
    assert.ok(Array.isArray(parseYaml(machine[key])), `Expected patch array: ${key}`);
  }
  return machine;
}

export function flattenPatch(text) {
  const rows = parseYaml(text);
  assert.ok(Array.isArray(rows), 'Expected a patch array');
  return rows.flatMap(row => {
    assert.ok(row && typeof row === 'object', 'Invalid patch row');
    if ('insert' in row) {
      assert.ok(Array.isArray(row.insert), 'Invalid insert list');
      return row.insert.map(entry => ({ operation: 'insert', entry }));
    }
    return [{ operation: 'patch', entry: row }];
  });
}

export function validatePatch(text) {
  const rows = flattenPatch(text);
  const ids = new Set();
  for (const { entry } of rows) {
    assert.equal(typeof entry.id, 'string', 'Every row needs an id');
    assert.ok(!ids.has(entry.id), `Duplicate top-level id: ${entry.id}`);
    ids.add(entry.id);
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'config' || key === 'disabled') continue;
      assert.ok(!JSON.stringify(value).includes('__jsExpr'), `Expression in metadata: ${key}`);
    }
  }
  return rows;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

// Compare row contents, including expression source and nested plugin order.
// Top-level order/insert grouping is ignored; no runtime activation claim is made.
export function canonicalPatch(text) {
  return stable(validatePatch(text).sort((a, b) => a.entry.id.localeCompare(b.entry.id)));
}

export function renderMachine(machinePath, label, catalog, { stage = true } = {}) {
  assert.match(label, /^[a-zA-Z0-9_-]+$/, 'Invalid output label');
  const machine = validateMachine(readYaml(machinePath));
  const targets = resolveDependencyTargets(join(dirname(machinePath), 'snapshot'), machine.installation, catalog);
  machine.installation = { globalWorkspace: targets.globalWorkspace, webPackage: targets.profiles.web };
  const output = join(root, 'generated', label);
  const shared = readYaml(join(root, 'shared/defaults.yaml'));
  const defaultModel = machine.overrides.defaultModel ?? shared.defaults.model;
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    assert.equal(typeof defaultModel[key], 'string', `Missing model field: ${key}`);
  }
  const templateData = { shared, machine, effective: { defaultModel } };
  const data = JSON.stringify({ data: templateData });
  const dataPath = join(output, 'chezmoi.json');
  if (stage) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(dataPath, data, { mode: 0o600 });
  }
  const privateTools = join(root, 'private/tools/chezmoi');
  const binary = process.env.CHEZMOI_BIN || (existsSync(privateTools) ? privateTools : 'chezmoi');
  const rendered = {};
  const outputs = [
    { key: 'home', file: 'home.patch.yml', patch: true },
    { key: 'web', file: 'web.patch.yml', patch: true },
  ];
  if (machine.installation) outputs.push(
    { key: 'globalWorkspace', file: 'global-workspace.yaml', patch: false },
    { key: 'webPackage', file: 'web.package.json', patch: false },
  );
  // Validate all staged files before writing them.
  for (const { key, file, patch } of outputs) {
    const child = spawnSync(binary, [
      ...(stage ? ['--config', dataPath, '--config-format', 'json']
        : ['--config', '/dev/null', '--config-format', 'yaml', '--override-data', JSON.stringify(templateData)]),
      '--source', join(root, 'templates'), '--destination', output,
      '--cache', join(root, 'private/chezmoi-cache'),
      '--persistent-state', join(root, 'private/chezmoi-state.boltdb'),
      'execute-template', '--left-delimiter', '[[', '--right-delimiter', ']]',
      '--file', join(root, `templates/${file}.tmpl`),
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (child.error || child.status !== 0) {
      // Do not forward template data or subprocess stderr into logs.
      throw new Error(`chezmoi failed for ${file}; check tool installation and template syntax`);
    }
    if (patch) validatePatch(child.stdout);
    else {
      const value = parseYaml(child.stdout);
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing installation object: ${key}`);
    }
    rendered[key] = child.stdout;
  }
  if (stage) {
    for (const { key, file } of outputs) writeFileSync(join(output, file), rendered[key], { mode: 0o600 });
  }
  return { output, rendered };
}

export function compareSnapshot(rendered, snapshotDir) {
  for (const name of ['home', 'web']) {
    const original = readFileSync(join(snapshotDir, `${name}.patch.yml`), 'utf8');
    assert.deepEqual(canonicalPatch(rendered[name]), canonicalPatch(original), `${name} differs from captured baseline`);
  }
}

const releaseUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readDependencyCatalog() {
  const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
  assert.equal(catalog.schemaVersion, 2, 'Dependency catalog requires schemaVersion: 2');
  const keys = new Set();
  for (const item of catalog.packages) {
    assert.ok(['global-override', 'profile'].includes(item.scope), 'Invalid dependency scope');
    assert.ok(['release', 'registry'].includes(item.policy), 'Invalid dependency policy');
    assert.match(item.version, exactVersion, 'Dependency version must be exact');
    assert.equal(typeof item.package, 'string', 'Missing package name');
    const key = item.scope + ':' + item.package;
    assert.ok(!keys.has(key), 'Duplicate managed dependency');
    keys.add(key);
    if (item.policy === 'release' && item.url !== undefined) assert.match(item.url, releaseUrl, 'Invalid Release URL');
    if (item.policy === 'release' && !item.url) assert.equal(typeof item.reason, 'string', 'Missing asset reason required');
    if (item.profiles !== undefined) assert.ok(Array.isArray(item.profiles) && item.profiles.every(p => /^[a-zA-Z0-9_-]+$/.test(p)), 'Invalid profiles');
  }
  return catalog;
}

export function resolveDependencyTargets(snapshotDir, installation, catalog = readDependencyCatalog()) {
  const snapshot = (file, fallback) => existsSync(join(snapshotDir, file)) ? readYaml(join(snapshotDir, file)) : fallback;
  const globalWorkspace = structuredClone(installation?.globalWorkspace ?? snapshot('global-workspace.yaml', { packages: ['.'] }));
  const profiles = structuredClone({ web: installation?.webPackage ?? snapshot('web.package.json', { private: true }), ...installation?.profiles });
  const entries = [];
  const merge = (container, field, scope, profile) => {
    container[field] ??= {};
    for (const item of catalog.packages.filter(item => item.scope === scope)) {
      if (scope === 'profile' && ((item.profiles && !item.profiles.includes(profile)) || !(item.package in container[field]))) continue;
      const matchingKeys = scope === 'global-override'
        ? Object.keys(container[field]).filter(key => key === item.package || key.startsWith(item.package + '@'))
        : [item.package];
      const keys = matchingKeys.length ? matchingKeys : [item.package];
      const current = container[field][keys[0]];
      const target = item.policy === 'registry' ? item.version : item.url;
      for (const key of keys) {
        if (target) container[field][key] = target;
        else delete container[field][key];
      }
      entries.push({ scope, ...(profile ? { profile } : {}), name: item.package, version: item.version,
        status: target ? (item.policy === 'release' ? 'verified-release' : item.package.startsWith('@deepseek-ai/') ? 'official-registry' : 'registry-pin') : 'blocked-missing-release',
        ...(target ? { target } : { reason: item.reason }),
        changed: current !== target });
    }
    const managed = new Set(entries.filter(row => row.scope === scope && row.profile === profile).map(row => row.name));
    for (const [name, source] of Object.entries(container[field])) {
      if ([...managed].some(item => name === item || (scope === 'global-override' && name.startsWith(item + '@')))) continue;
      const status = exactVersion.test(source) ? 'unmanaged-registry-pin' : releaseUrl.test(source) ? 'unmanaged-release' : 'unmanaged-local-or-range';
      // Unmanaged values remain private and are never proposed as managed targets.
      entries.push({ scope, ...(profile ? { profile } : {}), name, status });
    }
  };
  merge(globalWorkspace, 'overrides', 'global-override');
  for (const [profile, manifest] of Object.entries(profiles)) {
    merge(manifest, 'dependencies', 'profile', profile);
    const patchOnly = new Set(catalog.packages.filter(item => item.scope === 'profile' && item.patchOnly
      && (!item.profiles || item.profiles.includes(profile))).map(item => item.package));
    const bundles = manifest.dsh?.profile?.bundles;
    if (bundles) manifest.dsh.profile.bundles = bundles.filter(name => !patchOnly.has(name));
  }
  return { globalWorkspace, profiles, entries };
}

export function parseCommandArguments(args) {
  args = [...args];
  const command = args.shift();
  const usage = 'Usage: dsh-config <render|check|doctor|test|update> --machine <name> [--apply|--offline] [--tarball package=/absolute/file.tgz]';
  if (!['render', 'check', 'doctor', 'test', 'update'].includes(command)) throw new Error(usage);
  const selector = args.shift();
  const machineArgument = selector === '--machine' ? args.shift() : selector;
  if (selector === '--machine' && !/^[a-zA-Z0-9_-]+$/.test(machineArgument ?? '')) throw new Error(usage);
  // File-path selectors are supported alongside named private machines.
  if (!machineArgument || machineArgument.startsWith('-')) throw new Error(usage);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--apply' && command === 'update') options.apply = true;
    else if (flag === '--offline' && command === 'update') options.offline = true;
    else if (flag === '--tarball' && command === 'test') (options.tarballs ??= []).push(args.shift());
    else throw new Error(usage);
  }
  if (options.apply && options.offline) throw new Error('--offline cannot be combined with --apply');
  if (machineArgument.includes('..') && !isAbsolute(machineArgument)) throw new Error(usage);
  return { command, machineArgument, ...options };
}

export function resolveMachineArgument(arg) {
  const label = arg;
  if (/^[a-zA-Z0-9_-]+$/.test(label)) {
    return { path: join(root, 'private/machines', label, 'machine.yaml'), label };
  }
  return { path: resolve(arg), label: basename(arg).replace(/\.yaml$/, '').replace(/[^a-zA-Z0-9_-]/g, '-') };
}
