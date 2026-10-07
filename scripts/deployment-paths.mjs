import { homedir } from 'node:os';
import { dirname, join, isAbsolute, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

function pnpm(args) {
  const child = spawnSync('pnpm', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`Deployment discovery failed: pnpm ${args[0]}; check the local pnpm installation/configuration`);
  return child.stdout.trim();
}

// Expand path values only; never interpret shell syntax or recursively expand values.
export function expandDeploymentPath(value, field, env = process.env, userHome = homedir()) {
  if (typeof value !== 'string' || !value) throw new Error(`deployment.${field} must be a non-empty absolute path`);
  const expanded = value.replace(/^~(?=\/|$)/, () => userHome).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => {
    const name = braced ?? plain;
    if (env[name] === undefined) throw new Error(`Undefined environment variable ${name} in deployment.${field}`);
    return env[name];
  });
  if (!isAbsolute(expanded)) throw new Error(`deployment.${field} must resolve to an absolute path`);
  return expanded;
}

// This helper is used only for local live inspection/apply, never offline rendering.
export function normalizeDeployment(input = {}, { env = process.env, userHome = homedir(), query = pnpm } = {}) {
  const path = (value, field) => expandDeploymentPath(value, field, env, userHome);
  const home = path(input.home ?? env.DSH_HOME ?? join(userHome, '.dsh'), 'home');
  const globalWorkspacePath = path(input.globalWorkspacePath ?? join(query(['root', '-g']), 'pnpm-workspace.yaml'), 'globalWorkspacePath');
  const globalBinDir = path(input.globalBinDir ?? query(['bin', '-g']), 'globalBinDir');
  let globalDir = input.globalDir;
  if (globalDir === undefined) {
    // An explicit workspace must not borrow a different machine's pnpm configuration.
    const configured = input.globalWorkspacePath ? undefined : query(['config', 'get', 'global-dir']);
    const directory = dirname(globalWorkspacePath);
    globalDir = configured && !['undefined', 'null', ''].includes(configured)
      ? configured : /^v?\d+$/.test(basename(directory)) ? dirname(directory) : directory;
  }
  globalDir = path(globalDir, 'globalDir');
  let hostManifest = input.hostManifest;
  if (hostManifest === undefined) {
    const projects = JSON.parse(query([`--config.global-dir=${globalDir}`, '--ignore-workspace', 'list', '-g', '--depth', '0', '--json']));
    const anchors = projects.map(project => project.dependencies?.['@deepseek-ai/dsh']?.path).filter(Boolean);
    if (anchors.length !== 1) throw new Error('Deployment discovery requires one installed @deepseek-ai/dsh from pnpm list -g; install DSH or override deployment.hostManifest');
    hostManifest = join(anchors[0], 'package.json');
  }
  const profiles = {};
  for (const [name, profile] of Object.entries({ web: {}, ...input.profiles })) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid deployment profile name');
    const packagePath = path(profile.packagePath ?? join(home, 'profiles', name, 'package.json'), `profiles.${name}.packagePath`);
    profiles[name] = { ...profile, packagePath,
      patchPath: path(profile.patchPath ?? join(dirname(packagePath), 'cordis.patch.yml'), `profiles.${name}.patchPath`) };
  }
  return { ...input, home, globalWorkspacePath, globalBinDir, globalDir,
    hostManifest: path(hostManifest, 'hostManifest'),
    homePatchPath: path(input.homePatchPath ?? join(home, 'cordis.patch.yml'), 'homePatchPath'), profiles };
}
