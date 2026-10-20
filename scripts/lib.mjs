import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import nunjucks from 'nunjucks';
import { validatePresetRows, applyPresetRowOverrides } from './preset-rows.mjs';
import { planLocalPlugins } from './local-plugins.mjs';

const templates = new nunjucks.Environment(new nunjucks.FileSystemLoader(fileURLToPath(new URL('../templates/', import.meta.url))), {
  autoescape: false,
  throwOnUndefined: true,
  tags: { variableStart: '[[', variableEnd: ']]', blockStart: '[%', blockEnd: '%]', commentStart: '[#', commentEnd: '#]' },
});
templates.addFilter('quote', value => JSON.stringify(value));

export const root = fileURLToPath(new URL('../', import.meta.url));
const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: expression => ({ __jsExpr: expression }),
};

// Editing documents must round-trip expressions as their source text, not as marker objects.
const rawJsTag = {
  tag: jsTag.tag,
  resolve: expression => expression,
};

// Expressions are data, never executable code in this repository.
export function parseYaml(text) {
  const document = YAML.parseDocument(text, { customTags: [jsTag] });
  if (document.errors.length || document.warnings.length) {
    throw new Error('Invalid YAML or unsupported YAML tag');
  }
  return document.toJS();
}

// External services stay out of disposable smokes; every other private row loads as written.
export function withoutExternalPrivateRows(text) {
  const document = YAML.parseDocument(text, { customTags: [{ tag: jsTag.tag, resolve: expression => expression }] });
  assert.ok(!document.errors.length && YAML.isSeq(document.contents), 'Invalid private patch YAML');
  const external = entry => /^(@deepseek-ai\/dsh-mcp-client|@firecrawl\/)/.test(String(entry.get('name') ?? ''));
  document.contents.items = document.contents.items.filter(row => {
    const insert = row.get('insert');
    if (!YAML.isSeq(insert)) return true;
    insert.items = insert.items.filter(entry => !external(entry));
    return insert.items.length > 0;
  });
  return document.contents.items.length ? document.toString() : '- insert: []\n';
}

export function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

export function validateMachine(machine) {
  assert.equal(machine.schemaVersion, 1, 'Unsupported machine schema');
  for (const key of ['sessionTools', 'promptOverlay']) {
    assert.equal(typeof machine.features?.[key], 'boolean', `Missing feature: ${key}`);
  }
  if (machine.features.activeContext !== undefined) assert.equal(typeof machine.features.activeContext, 'boolean', 'Invalid feature: activeContext');
  if (machine.acp?.pressureDefault !== undefined) {
    assert.equal(machine.features.activeContext, true, 'pressureDefault requires activeContext');
    const { nudgeAtRatio, resetBelowRatio } = machine.acp.pressureDefault;
    assert.ok(Number.isFinite(nudgeAtRatio) && Number.isFinite(resetBelowRatio)
      && 0 <= resetBelowRatio && resetBelowRatio < nudgeAtRatio && nudgeAtRatio < 1,
    'pressureDefault requires 0 <= resetBelowRatio < nudgeAtRatio < 1');
  }
  if (machine.acp?.pressureRoutes !== undefined) {
    assert.equal(machine.features.activeContext, true, 'pressureRoutes requires activeContext');
    assert.ok(Array.isArray(machine.acp.pressureRoutes), 'pressureRoutes must be an array');
    const routes = new Set();
    for (const route of machine.acp.pressureRoutes) {
      assert.ok(typeof route.provider === 'string' && route.provider.trim() && typeof route.model === 'string' && route.model.trim(), 'pressureRoutes requires provider/model');
      assert.ok(Number.isSafeInteger(route.nudgeAtTokens) && route.nudgeAtTokens > 0
        && Number.isSafeInteger(route.resetBelowTokens) && route.resetBelowTokens >= 0
        && route.resetBelowTokens < route.nudgeAtTokens, 'pressureRoutes requires 0 <= resetBelowTokens < nudgeAtTokens');
      const key = JSON.stringify([route.provider, route.model]);
      assert.ok(!routes.has(key), 'Duplicate pressure route');
      routes.add(key);
    }
  }
  if (machine.features.promptOverlay) {
    for (const field of ['modulePath', 'promptFile', 'identityFile']) {
      assert.ok(typeof machine.promptSections?.[field] === 'string' && isAbsolute(machine.promptSections[field]), `Missing absolute prompt path: ${field}`);
    }
  }
  assert.ok(machine.overrides && typeof machine.overrides === 'object', 'Missing overrides');
  validatePresetRows(machine.overrides.presetRows);
  planLocalPlugins(machine.localPlugins);
  if (machine.rowOps !== undefined) {
    assert.ok(machine.rowOps && typeof machine.rowOps === 'object' && !Array.isArray(machine.rowOps), 'rowOps must be an object');
    for (const [layer, ops] of Object.entries(machine.rowOps)) {
      assert.ok(['home', 'web'].includes(layer), `Invalid rowOps layer: ${layer}`);
      assert.ok(ops && typeof ops === 'object' && !Array.isArray(ops), `rowOps.${layer} must be an object`);
      for (const [key, ids] of Object.entries(ops)) {
        assert.ok(['retire'].includes(key), `Invalid rowOps op: ${key}`);
        assert.ok(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length), `rowOps.${layer}.${key} must be row ids`);
      }
    }
  }
  for (const [key, fields] of Object.entries({ siyuan: ['url', 'headersFile'], academicSource: ['url', 'apiKeyFile'] })) {
    for (const field of fields) {
      assert.ok(typeof machine.mcp?.[key]?.[field] === 'string' && machine.mcp[key][field].length, `Missing machine mcp input: ${key}.${field}`);
    }
  }
  assert.ok(Array.isArray(machine.subagentModels) && machine.subagentModels.length
    && machine.subagentModels.every(route => typeof route.provider === 'string' && route.provider.length && typeof route.model === 'string' && route.model.length),
  'subagentModels requires provider/model routes');
  if (machine.providers !== undefined) {
    assert.ok(machine.providers && typeof machine.providers === 'object' && !Array.isArray(machine.providers), 'providers must be an object');
    for (const [key, value] of Object.entries(machine.providers)) {
      assert.ok(['add', 'set', 'remove'].includes(key), `Invalid providers op: ${key}`);
      assert.ok(key === 'remove' ? Array.isArray(value) : value && typeof value === 'object', `Invalid providers.${key}`);
    }
  }
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

// A patch row's identity list: insert rows carry one id per entry.
function rowIdentity(row) {
  if (Array.isArray(row?.insert)) return row.insert.map(entry => entry?.id).filter(id => typeof id === 'string');
  return typeof row?.id === 'string' ? [row.id] : [];
}

/** Shared provider catalog plus this machine's deltas; whole-object replacement only. */
export function resolveProviders(sharedProviders, deltas = {}) {
  const providers = structuredClone(sharedProviders ?? {});
  for (const name of deltas.remove ?? []) {
    assert.ok(providers[name] !== undefined, 'providers.remove names an unknown provider: ' + name);
    delete providers[name];
  }
  for (const [name, value] of Object.entries(deltas.set ?? {})) {
    assert.ok(providers[name] !== undefined, 'providers.set names an unknown provider: ' + name);
    // Top-level keys only: a nested value such as models replaces the shared value whole.
    providers[name] = { ...providers[name], ...structuredClone(value) };
  }
  for (const [name, value] of Object.entries(deltas.add ?? {})) {
    assert.ok(providers[name] === undefined, 'providers.add duplicates a shared provider: ' + name);
    providers[name] = structuredClone(value);
  }
  return providers;
}

/** Indent a serialized YAML block so it nests under a template node. */
export function indentYaml(value, spaces) {
  const pad = ' '.repeat(spaces);
  return YAML.stringify(value).trimEnd().split('\n').map(line => line ? pad + line : line).join('\n');
}

/** Remove top-level rows whose identity is listed, preserving expression tags. */
export function dropRows(text, ids) {
  if (!ids?.length) return text;
  const document = YAML.parseDocument(text, { customTags: [rawJsTag] });
  assert.ok(!document.errors.length && YAML.isSeq(document.contents), 'Invalid patch YAML');
  const drop = new Set(ids);
  document.contents.items = document.contents.items.filter(row => !rowIdentity(row.toJSON()).some(id => drop.has(id)));
  return document.toString();
}

/**
 * Append live rows the template does not produce, so hand-edited or UI-owned rows survive
 * an apply. Row ids listed in retire are removed instead. Returns the ids it kept and removed.
 */
export function preserveLiveRows(renderedText, liveText, retire = []) {
  const rendered = parseYaml(renderedText);
  assert.ok(Array.isArray(rendered), 'Expected rendered patch list');
  const renderedIds = new Set(rendered.flatMap(rowIdentity));
  for (const id of retire) assert.ok(!renderedIds.has(id), 'retire names a rendered row: ' + id);
  if (liveText === undefined || liveText.trim() === '') return { text: renderedText, preserved: [], retired: [] };
  const live = YAML.parseDocument(liveText, { customTags: [rawJsTag] });
  if (live.errors.length) throw new Error('Invalid live patch YAML');
  if (!YAML.isSeq(live.contents)) return { text: renderedText, preserved: [], retired: [] };
  const retired = [];
  const preserved = [];
  const kept = [];
  for (const row of live.contents.items) {
    if (!YAML.isMap(row)) { kept.push(row); continue; }
    const id = row.get('id');
    if (id !== undefined && !row.has('insert')) {
      if (retire.includes(id)) { retired.push(id); continue; }
      if (renderedIds.has(id)) continue;
      preserved.push(id); kept.push(row); continue;
    }
    if (YAML.isSeq(row.get('insert'))) {
      if (id !== undefined && retire.includes(id)) { retired.push(id); continue; }
      const entries = row.get('insert');
      entries.items = entries.items.filter(entry => {
        const entryId = YAML.isMap(entry) ? entry.get('id') : undefined;
        if (entryId === undefined) return true;
        if (retire.includes(entryId)) { retired.push(entryId); return false; }
        if (renderedIds.has(entryId)) return false;
        preserved.push(entryId); return true;
      });
      if (entries.items.length) kept.push(row);
      continue;
    }
    kept.push(row);
  }
  live.contents.items = kept;
  const text = kept.length ? renderedText.replace(/\s+$/, '') + '\n' + live.toString() : renderedText;
  return { text, preserved, retired };
}

export function renderMachine(machinePath, label, catalog, { stage = true, generatedDir } = {}) {
  assert.match(label, /^[a-zA-Z0-9_-]+$/, 'Invalid output label');
  const machine = validateMachine(readYaml(machinePath));
  const targets = resolveDependencyTargets(join(dirname(machinePath), 'snapshot'), machine.installation, catalog, machine.features);
  machine.installation = { globalWorkspace: targets.globalWorkspace, webPackage: targets.profiles.web };
  const output = join(generatedDir ?? join(root, 'generated'), label);
  const shared = readYaml(join(root, 'shared/defaults.yaml'));
  for (const [key, value] of Object.entries(machine.installation)) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing installation object: ${key}`);
  }
  const providers = resolveProviders(readYaml(join(root, 'shared/providers.yaml')).providers, machine.providers);
  const templateData = { shared, machine, providersYaml: indentYaml(providers, 6) };
  const rowOps = machine.rowOps ?? {};
  const rendered = {
    home: dropRows(applyPresetRowOverrides(templates.render('home.patch.yml.njk', templateData), machine.overrides.presetRows), rowOps.home?.retire),
    web: dropRows(templates.render('web.patch.yml.njk', templateData), rowOps.web?.retire),
    globalWorkspace: JSON.stringify(machine.installation.globalWorkspace, null, 2) + '\n',
    webPackage: JSON.stringify(machine.installation.webPackage, null, 2) + '\n',
  };
  const localPlugins = planLocalPlugins(machine.localPlugins);
  if (localPlugins.length) rendered.home += '\n' + YAML.stringify([{ insert: localPlugins.map(file => file.row) }]);
  // Validate every patch before writing any staged output.
  validatePatch(rendered.home);
  validatePatch(rendered.web);
  if (stage) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    for (const [key, file] of Object.entries({ home: 'home.patch.yml', web: 'web.patch.yml', globalWorkspace: 'global-workspace.yaml', webPackage: 'web.package.json' })) {
      writeFileSync(join(output, file), rendered[key], { mode: 0o600 });
    }
  }
  if (stage) for (const file of localPlugins) {
    const path = join(output, file.stagePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.contents, { mode: 0o600 });
  }
  return { output, rendered, localPlugins };
}

const releaseUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readDependencyCatalog() {
  const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
  assert.equal(catalog.schemaVersion, 2, 'Dependency catalog requires schemaVersion: 2');
  if (catalog.runtimeVersion !== undefined) assert.match(catalog.runtimeVersion, exactVersion, 'Runtime version must be exact');
  assert.ok((catalog.retiredGlobalOverrides ?? []).every(name => typeof name === 'string' && name.length), 'Invalid retired overrides');
  for (const enabled of Object.values(catalog.allowBuilds ?? {})) assert.equal(typeof enabled, 'boolean', 'Invalid build policy');
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
    for (const flag of ['required', 'resetSelectors']) if (item[flag] !== undefined) assert.equal(typeof item[flag], 'boolean', `Invalid dependency flag: ${flag}`);
    if (item.profiles !== undefined) assert.ok(Array.isArray(item.profiles) && item.profiles.every(p => /^[a-zA-Z0-9_-]+$/.test(p)), 'Invalid profiles');
  }
  for (const [identity, runtimes] of Object.entries(catalog.verifiedCompatibility ?? {})) {
    const separator = identity.lastIndexOf('@');
    const name = identity.slice(0, separator), version = identity.slice(separator + 1);
    assert.ok(separator > 0 && catalog.packages.some(item => item.package === name && item.version === version), 'Verified compatibility must name a managed exact package version');
    assert.match(version, exactVersion, 'Verified package version must be exact');
    assert.ok(Array.isArray(runtimes) && runtimes.length && runtimes.every(runtime => typeof runtime === 'string' && exactVersion.test(runtime)), 'Verified runtime versions must be exact');
  }
  return catalog;
}

export function resolveDependencyTargets(snapshotDir, installation, catalog = readDependencyCatalog(), features = {}) {
  const snapshot = (file, fallback) => existsSync(join(snapshotDir, file)) ? readYaml(join(snapshotDir, file)) : fallback;
  const globalWorkspace = structuredClone(installation?.globalWorkspace ?? snapshot('global-workspace.yaml', { packages: ['.'] }));
  const profiles = structuredClone({ web: installation?.webPackage ?? snapshot('web.package.json', { private: true }), ...installation?.profiles });
  if (features.activeContext) {
    for (const [name, manifest] of Object.entries(profiles)) {
      if (name !== 'web' && !manifest.dependencies?.['dsh-active-context']) continue;
      manifest.dependencies ??= {};
      // The catalog resolves the placeholder; unpublished assets stay blockers.
      manifest.dependencies['dsh-active-context'] ??= '';
    }
  }
  const entries = [];
  const merge = (container, field, scope, profile) => {
    container[field] ??= {};
    if (scope === 'global-override') {
      for (const name of catalog.retiredGlobalOverrides ?? []) {
        for (const key of Object.keys(container[field]).filter(key => key === name || key.startsWith(name + '@'))) {
          delete container[field][key];
          entries.push({ scope, name: key, status: 'retired-override', changed: true, target: '(removed)' });
        }
      }
    }
    for (const item of catalog.packages.filter(item => item.scope === scope)) {
      if (scope === 'profile' && ((item.profiles && !item.profiles.includes(profile)) || (!item.required && !(item.package in container[field])))) continue;
      const matchingKeys = scope === 'global-override'
        ? Object.keys(container[field]).filter(key => key === item.package || key.startsWith(item.package + '@'))
        : [item.package];
      const reset = scope === 'global-override' && item.resetSelectors;
      const keys = !reset && matchingKeys.length ? matchingKeys : [item.package];
      const currentSources = (matchingKeys.length ? matchingKeys : keys).map(selector => ({ selector, source: container[field][selector] }));
      if (reset) for (const key of matchingKeys) delete container[field][key];
      const current = currentSources.map(row => row.source);
      const target = item.policy === 'registry' ? item.version : item.url;
      for (const key of keys) {
        if (target) container[field][key] = target;
        else delete container[field][key];
      }
      entries.push({ scope, ...(profile ? { profile } : {}), name: item.package, version: item.version,
        status: target ? (item.policy === 'release' ? 'verified-release' : item.package.startsWith('@deepseek-ai/') ? 'official-registry' : 'registry-pin') : 'blocked-missing-release',
        ...(target ? { target } : { reason: item.reason }),
        currentSources: currentSources.map(({ selector, source }) => ({ selector,
          source: source === undefined ? null : /^(file:|link:|workspace:|\/)/.test(source) ? '(local source)' : source })),
        changed: current.some(source => source !== target) || Boolean(reset && matchingKeys.some(key => key !== item.package)) });
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
  if (catalog.allowBuilds) globalWorkspace.allowBuilds = { ...globalWorkspace.allowBuilds, ...catalog.allowBuilds };
  // pnpm 11 otherwise rejects trusted Release overrides of transitive dependencies.
  if (entries.some(row => row.scope === 'global-override' && row.status === 'verified-release')) globalWorkspace.blockExoticSubdeps = false;
  for (const [profile, manifest] of Object.entries(profiles)) {
    merge(manifest, 'dependencies', 'profile', profile);
    const patchOnly = new Set(catalog.packages.filter(item => item.scope === 'profile' && item.patchOnly
      && (!item.profiles || item.profiles.includes(profile))).map(item => item.package));
    const bundles = manifest.dsh?.profile?.bundles;
    if (bundles) manifest.dsh.profile.bundles = bundles.filter(name => !patchOnly.has(name));
  }
  return { globalWorkspace, profiles, entries };
}

// A profile-owned fork may also have a global override even when the CLI never depends on it.
export function resolvesFromProfile(target, entries, profile) {
  return target.scope === 'profile' || entries.some(row => row.scope === 'profile' && row.profile === profile && row.name === target.name);
}

export function parseCommandArguments(args) {
  args = [...args];
  const command = args.shift();
  const usage = 'Usage: dsh-config <render|check|doctor|test|update|rollback> --machine <name> [--apply|--offline] [--json] [--verbose] [--tarball package=/absolute/file.tgz] [--backup /absolute/backup-dir]';
  if (!['render', 'check', 'doctor', 'test', 'update', 'rollback'].includes(command)) throw new Error(usage);
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
    else if (flag === '--json' && ['doctor', 'update'].includes(command)) options.json = true;
    else if (flag === '--verbose' && ['doctor', 'update'].includes(command)) options.verbose = true;
    else if (flag === '--tarball' && command === 'test') (options.tarballs ??= []).push(args.shift());
    else if (flag === '--backup' && command === 'rollback') options.backup = args.shift();
    else throw new Error(usage);
  }
  if (options.apply && options.offline) throw new Error('--offline cannot be combined with --apply');
  if (command === 'rollback' && !isAbsolute(options.backup ?? '')) throw new Error(usage);
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
