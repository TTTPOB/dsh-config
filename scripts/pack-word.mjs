/** Package the local Word plugin without publishing or touching a profile. */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'generated/word-package');
mkdirSync(directory, { recursive: true });
copyFileSync(join(root, 'plugins/word.mjs'), join(directory, 'word.mjs'));
copyFileSync(join(root, 'plugins/word.md'), join(directory, 'README.md'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'dsh-word', version: '0.1.0', type: 'module', main: 'word.mjs',
  description: 'Native DSH Word client tools with an embedded English skill provider',
  engines: { node: '>=24' },
  files: ['word.mjs', 'README.md', 'cordis.patch.yml'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n');
writeFileSync(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: word\n      name: dsh-word\n');
execFileSync('pnpm', ['pack', '--out', join(directory, 'dsh-word-0.1.0.tgz')], { cwd: directory, stdio: 'inherit' });
