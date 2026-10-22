import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../plugins/', import.meta.url));

/** Resolve shared modules from declarations only; never discover this process's installation. */
export function resolveLocalPlugins(shared = [], machine, { home } = {}) {
  assert.ok(Array.isArray(shared), 'shared localPlugins must be an array');
  const ids = new Set();
  for (const entry of shared) {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid shared localPlugins entry');
    assert.ok(Object.keys(entry).every(key => ['id', 'module', 'config'].includes(key)), 'Shared localPlugins accepts only id/module/config');
    assert.ok(!ids.has(entry.id), 'Duplicate shared local plugin id');
    ids.add(entry.id);
  }
  const local = machine.localPlugins ?? [];
  // Keep the existing absolute-path contract and validation for machine declarations.
  planLocalPlugins(local);
  const inherited = shared.filter(entry => !local.some(row => row.id === entry.id));
  if (!inherited.length) return local;
  const declaredHome = machine.deployment?.home;
  const directories = new Set(local.map(entry => dirname(entry.modulePath)));
  let inferred;
  if (directories.size === 1) {
    const directory = [...directories][0];
    if (basename(directory) === 'plugins') inferred = dirname(directory);
  }
  if (home === undefined) {
    if (declaredHome !== undefined) {
      assert.ok(typeof declaredHome === 'string' && isAbsolute(declaredHome) && !/[$~]/.test(declaredHome),
        'Offline shared localPlugins requires a literal absolute deployment.home; do not expand the inspecting machine environment');
      home = declaredHome;
    } else {
      assert.ok(inferred, 'Shared localPlugins requires deployment.home or one existing absolute home/plugins directory');
      home = inferred;
    }
  } else {
    assert.ok(isAbsolute(home), 'Resolved deployment home must be absolute');
    if (declaredHome === undefined && inferred) assert.equal(resolve(home), resolve(inferred),
      'Resolved deployment home differs from existing localPlugins home; declare deployment.home explicitly');
  }
  const combined = [...inherited.map(entry => ({ ...entry, modulePath: join(home, 'plugins', entry.module ?? '') })), ...local];
  for (const entry of inherited) assert.equal(combined.filter(row => row.module === entry.module).length, 1,
    'Shared and machine localPlugins must not deploy the same module under different ids');
  return combined;
}

/** Plan repository-owned ESM files without importing them or reading credentials. */
export function planLocalPlugins(declarations = []) {
  assert.ok(Array.isArray(declarations), 'localPlugins must be an array');
  const ids = new Set(), paths = new Set();
  return declarations.map(entry => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid localPlugins entry');
    assert.ok(Object.keys(entry).every(key => ['id', 'module', 'modulePath', 'config'].includes(key)), 'Unknown localPlugins field');
    assert.match(entry.id ?? '', /^[a-zA-Z0-9_-]+$/, 'Invalid local plugin id');
    assert.match(entry.module ?? '', /^[a-zA-Z0-9_-]+[.]mjs$/, 'local plugin module must be a repository .mjs filename');
    const source = join(directory, entry.module);
    if (!existsSync(source)) throw new Error('Unknown or missing local plugin module: ' + entry.module);
    assert.ok(typeof entry.modulePath === 'string' && isAbsolute(entry.modulePath) && entry.modulePath.endsWith('.mjs'), 'local plugin modulePath must be an absolute .mjs path');
    assert.ok(entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config), 'local plugin config must be an object');
    assert.ok(!JSON.stringify(entry.config).includes('__jsExpr'), 'local plugin config must contain literal values');
    const path = resolve(entry.modulePath);
    assert.ok(!ids.has(entry.id) && !paths.has(path), 'Duplicate local plugin id or modulePath');
    ids.add(entry.id);
    paths.add(path);
    return { id: entry.id, path, source, contents: readFileSync(source, 'utf8'), stagePath: 'plugins/' + entry.id + '.mjs',
      row: { id: entry.id, name: path, config: entry.config } };
  });
}
