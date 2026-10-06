import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, isAbsolute } from 'node:path';
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
  if (machine.literalPatches !== undefined) {
    for (const name of ['home', 'web']) {
      assert.equal(typeof machine.literalPatches?.[name], 'string', `Missing literal patch: ${name}`);
      validatePatch(machine.literalPatches[name]);
    }
    return machine;
  }
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

export function renderMachine(machinePath, label) {
  assert.match(label, /^[a-zA-Z0-9_-]+$/, 'Invalid output label');
  const machine = validateMachine(readYaml(machinePath));
  const output = join(root, 'generated', label);
  if (machine.literalPatches !== undefined) {
    // Captured patches replace templates entirely; expressions remain literal text.
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const rendered = { home: machine.literalPatches.home, web: machine.literalPatches.web };
    for (const [name, text] of Object.entries(rendered)) {
      writeFileSync(join(output, `${name}.patch.yml`), text, { mode: 0o600 });
    }
    return { output, rendered };
  }
  const shared = readYaml(join(root, 'shared/defaults.yaml'));
  const defaultModel = machine.overrides.defaultModel ?? shared.defaults.model;
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    assert.equal(typeof defaultModel[key], 'string', `Missing model field: ${key}`);
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const dataPath = join(output, 'chezmoi.json');
  writeFileSync(dataPath, JSON.stringify({ data: { shared, machine, effective: { defaultModel } } }), { mode: 0o600 });
  const privateTools = join(root, 'private/tools/chezmoi');
  const binary = process.env.CHEZMOI_BIN || (existsSync(privateTools) ? privateTools : 'chezmoi');
  const rendered = {};
  // Validate every output before writing either patch.
  for (const name of ['home', 'web']) {
    const child = spawnSync(binary, [
      '--config', dataPath, '--config-format', 'json',
      '--source', join(root, 'templates'), '--destination', output,
      '--cache', join(root, 'private/chezmoi-cache'),
      '--persistent-state', join(root, 'private/chezmoi-state.boltdb'),
      'execute-template', '--left-delimiter', '[[', '--right-delimiter', ']]',
      '--file', join(root, `templates/${name}.patch.yml.tmpl`),
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (child.error || child.status !== 0) {
      // Do not forward template data or subprocess stderr into logs.
      throw new Error(`chezmoi failed for ${name}; check tool installation and template syntax`);
    }
    validatePatch(child.stdout);
    rendered[name] = child.stdout;
  }
  for (const [name, text] of Object.entries(rendered)) {
    writeFileSync(join(output, `${name}.patch.yml`), text, { mode: 0o600 });
  }
  return { output, rendered };
}

export function compareSnapshot(rendered, snapshotDir) {
  for (const name of ['home', 'web']) {
    const original = readFileSync(join(snapshotDir, `${name}.patch.yml`), 'utf8');
    assert.deepEqual(canonicalPatch(rendered[name]), canonicalPatch(original), `${name} differs from captured baseline`);
  }
}

export function buildSourcePlan(snapshotDir) {
  const inventory = readYaml(join(root, 'shared/dependencies.yaml')).packages;
  const profile = JSON.parse(readFileSync(join(snapshotDir, 'web.package.json'), 'utf8'));
  const globals = readYaml(join(snapshotDir, 'global-workspace.yaml'));
  const entries = [
    ...Object.entries(profile.dependencies ?? {}).map(([name, source]) => ({ scope: 'profile', name, source })),
    ...Object.entries(globals.overrides ?? {}).map(([name, source]) => ({ scope: 'global-override', name, source })),
  ];
  return entries.map(({ scope, name, source }) => {
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/.test(source)) {
      const known = inventory.find(item => item.url === source);
      return { scope, name, status: known ? 'verified-release' : 'unverified-release', target: source };
    }
    const asset = source.startsWith('file:') && source.endsWith('.tgz') ? basename(source.slice(5)) : undefined;
    const packageName = name.startsWith('@') ? name.split('@').slice(0, 2).join('@') : name;
    const candidates = asset ? inventory.filter(item => item.asset === asset && item.package === packageName) : [];
    if (candidates.length === 1) return { scope, name, status: 'release-migration-candidate', target: candidates[0].url };
    if (candidates.length > 1) return { scope, name, status: 'blocked-release-choice-needed', candidates: candidates.map(item => item.url) };
    if (name.startsWith('@deepseek-ai/') && /^\d+\.\d+\.\d+/.test(source)) {
      return { scope, name, status: 'official-registry', target: source };
    }
    if (/^\d+\.\d+\.\d+/.test(source) && !name.startsWith('dsh-')) {
      return { scope, name, status: 'registry-pin', target: source };
    }
    return { scope, name, status: 'blocked-needs-exact-release', asset: asset ?? null };
  });
}

export function parseCommandArguments(args) {
  const [command, selector, machine, ...extra] = args;
  const usage = 'Usage: node scripts/dsh-config.mjs <render|check|plan> --machine <name> (or a machine.yaml path)';
  if (!['render', 'check', 'plan'].includes(command)) throw new Error(usage);
  if (selector === '--machine') {
    if (typeof machine !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(machine) || extra.length) throw new Error(usage);
    return { command, machineArgument: machine };
  }
  if (!selector || selector.startsWith('-') || machine !== undefined) throw new Error(usage);
  return { command, machineArgument: selector };
}

export function resolveMachineArgument(arg) {
  const label = arg;
  if (/^[a-zA-Z0-9_-]+$/.test(label)) {
    return { path: join(root, 'private/machines', label, 'machine.yaml'), label };
  }
  return { path: resolve(arg), label: basename(arg).replace(/\.yaml$/, '').replace(/[^a-zA-Z0-9_-]/g, '-') };
}
