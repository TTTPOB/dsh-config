/** Package the dependency-free local plugin without publishing or touching a profile. */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'generated/office-cdp-package');
mkdirSync(directory, { recursive: true });
copyFileSync(join(root, 'plugins/office-cdp.mjs'), join(directory, 'office-cdp.mjs'));
copyFileSync(join(root, 'plugins/office-cdp.md'), join(directory, 'README.md'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'dsh-office-cdp', version: '0.1.0', type: 'module', main: 'office-cdp.mjs',
  description: 'Native DSH PowerPoint CDP tools with an embedded skill provider',
  engines: { node: '>=24' },
  files: ['office-cdp.mjs', 'README.md', 'cordis.patch.yml'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n');
writeFileSync(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: office-cdp\n      name: dsh-office-cdp\n');
execFileSync('pnpm', ['pack', '--out', join(directory, 'dsh-office-cdp-0.1.0.tgz')], { cwd: directory, stdio: 'inherit' });
