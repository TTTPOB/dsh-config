/** Package the local Word plugin without publishing or touching a profile. */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const version = '0.1.0';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'generated/word-package');
mkdirSync(directory, { recursive: true });
copyFileSync(join(root, 'plugins/word.mjs'), join(directory, 'word.mjs'));
const readme = `# dsh-word

在消费此插件的 DSH profile 目录安装生成的 tarball（把路径替换为实际产物）：

~~~sh
pnpm add /path/to/dsh-word-${version}.tgz
~~~

profile 的 pnpm workspace 需要设置 autoInstallPeers: false，让插件与 Host 共用同一份服务依赖。
在 profile 的 package.json 中将 dsh-word 加入 dsh.profile.bundles，保留其他已有项：

~~~json
{
  "dsh": { "profile": { "bundles": ["dsh-word"] } }
}
~~~

在同一 profile 的 cordis.patch.yml 配置包内插件行：

~~~yaml
- id: word
  config:
    helperUrl: http://127.0.0.1:<helper-port>
~~~

helperUrl 替换为 DSH 能访问的 Windows helper 地址。Windows 端先部署 helper，并在目标文档中打开对应 Helper 加载项。

使用说明：https://github.com/TTTPOB/dsh-config/blob/main/plugins/word.md

这是独立包安装方式；使用 dsh-config 的 localPlugins 文件同步时，无需安装此包或重复加载 bundle。
`;
writeFileSync(join(directory, 'README.md'), readme);

writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'dsh-word', version, type: 'module', main: 'word.mjs',
  description: 'Dynamic DSH Word tools and a helper-provided skill',
  engines: { node: '>=24' },
  files: ['word.mjs', 'README.md', 'cordis.patch.yml'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n');
writeFileSync(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: word\n      name: dsh-word\n');
execFileSync('pnpm', ['pack', '--out', join(directory, `dsh-word-${version}.tgz`)], { cwd: directory, stdio: 'inherit' });
