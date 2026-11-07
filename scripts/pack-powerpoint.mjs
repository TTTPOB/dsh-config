/** Package the dependency-free local plugin without publishing or touching a profile. */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'generated/powerpoint-package');
mkdirSync(directory, { recursive: true });
copyFileSync(join(root, 'plugins/powerpoint.mjs'), join(directory, 'powerpoint.mjs'));
copyFileSync(join(root, 'plugins/powerpoint.md'), join(directory, 'README.md'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'dsh-powerpoint', version: '0.1.0', type: 'module', main: 'powerpoint.mjs',
  description: 'Native DSH PowerPoint client tools with an embedded skill provider',
  engines: { node: '>=24' },
  files: ['powerpoint.mjs', 'README.md', 'cordis.patch.yml'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n');
writeFileSync(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: powerpoint\n      name: dsh-powerpoint\n');
execFileSync('pnpm', ['pack', '--out', join(directory, 'dsh-powerpoint-0.1.0.tgz')], { cwd: directory, stdio: 'inherit' });
