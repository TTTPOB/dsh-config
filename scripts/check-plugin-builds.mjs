/** Rebuild offline without helper catalogs or Word skill files; never overwrite deployable modules. */
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
let build;
try {
  ({ build } = await import('vite'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error('vite is not installed. Run `pnpm install --frozen-lockfile --ignore-workspace` in this repository first.');
  process.exit(1);
}

for (const id of ['word', 'powerpoint']) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-plugin-build-'));
  try {
    await build({
      configFile: fileURLToPath(new URL('../plugins-src/' + id + '/vite.config.ts', import.meta.url)),
      configLoader: 'runner',
      logLevel: 'silent',
      build: { outDir: directory },
    });
    const files = await readdir(directory);
    if (files.length !== 1 || files[0] !== id + '.mjs') {
      throw new Error(id + ' must build to a single self-contained .mjs file');
    }
    const [rebuilt, committed] = await Promise.all([
      readFile(join(directory, id + '.mjs')),
      readFile(new URL('../plugins/' + id + '.mjs', import.meta.url)),
    ]);
    if (!rebuilt.equals(committed)) {
      throw new Error('plugins/' + id + '.mjs is stale; run pnpm build:' + id + ' and commit the result');
    }
    console.log('plugins/' + id + '.mjs is up to date');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
