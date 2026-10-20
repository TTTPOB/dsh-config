import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../plugins/', import.meta.url));

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
