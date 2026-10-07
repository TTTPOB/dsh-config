import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { root, readYaml, parseYaml, readDependencyCatalog, resolveDependencyTargets, renderMachine, validatePatch } from './lib.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function resolveInstalledHost(deployment) {
  const directory = dirname(deployment.globalWorkspacePath);
  // Flat installation projects have a stable explicit anchor; global projects use the current pnpm selection.
  if (existsSync(join(directory, 'package.json'))) return realpathSync(deployment.hostManifest);
  const globalDir = deployment.globalDir ?? dirname(directory);
  const argv = [`--config.global-dir=${globalDir}`, '--ignore-workspace', 'list', '--global', '--depth', '0', '--json'];
  const child = spawnSync('pnpm', argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error('Cannot discover current global DSH through pnpm list');
  const projects = JSON.parse(child.stdout);
  const anchors = projects.map(project => project.dependencies?.['@deepseek-ai/dsh']?.path).filter(Boolean);
  assert.equal(anchors.length, 1, 'Expected one current global DSH project');
  return realpathSync(join(anchors[0], 'package.json'));
}

export function globalInstallArguments(deployment) {
  const manifest = json(resolveInstalledHost(deployment));
  assert.equal(manifest.name, '@deepseek-ai/dsh', 'Global installation anchor must be official DSH');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Global runtime version must be exact');
  assert.ok(isAbsolute(deployment.globalBinDir ?? ''), 'Absolute deployment.globalBinDir required for global apply');
  const globalDir = deployment.globalDir ?? dirname(dirname(deployment.globalWorkspacePath));
  assert.ok(isAbsolute(globalDir), 'Global directory must be absolute');
  return ['pnpm', '--config.enable-global-virtual-store=false', `--config.global-dir=${globalDir}`,
    `--config.global-bin-dir=${deployment.globalBinDir}`, '--ignore-workspace', 'add', '--global', `@deepseek-ai/dsh@${manifest.version}`];
}

export function validateDeployment(deployment) {
  assert.ok(deployment, 'machine.deployment is required');
  for (const key of ['globalWorkspacePath', 'hostManifest', 'home']) assert.ok(isAbsolute(deployment[key] ?? ''), `Missing absolute deployment.${key}`);
  assert.ok(deployment.profiles?.web, 'deployment.profiles.web is required');
  for (const [name, profile] of Object.entries(deployment.profiles)) {
    assert.match(name, /^[a-zA-Z0-9_-]+$/, 'Invalid deployment profile');
    assert.ok(isAbsolute(profile.packagePath ?? ''), 'Missing absolute profile packagePath');
    if (profile.patchPath) assert.ok(isAbsolute(profile.patchPath), 'Profile patchPath must be absolute');
  }
  if (deployment.homePatchPath) assert.ok(isAbsolute(deployment.homePatchPath), 'homePatchPath must be absolute');
  return deployment;
}

export function deploymentTargets(machine, snapshotDir, catalog) {
  const installation = structuredClone(machine.installation ?? {});
  const deployment = machine.deployment;
  if (deployment?.globalWorkspacePath) {
    validateDeployment(deployment);
    const liveGlobal = readYaml(deployment.globalWorkspacePath);
    installation.globalWorkspace = { ...installation.globalWorkspace, ...liveGlobal,
      overrides: { ...installation.globalWorkspace?.overrides, ...liveGlobal.overrides } };
    installation.profiles ??= {};
    for (const [name, profile] of Object.entries(deployment.profiles)) {
      const declared = name === 'web' ? installation.webPackage : installation.profiles[name];
      const live = json(profile.packagePath);
      const merged = { ...declared, ...live, dependencies: { ...declared?.dependencies, ...live.dependencies } };
      if (name === 'web') installation.webPackage = merged;
      else installation.profiles[name] = merged;
    }
  }
  return resolveDependencyTargets(snapshotDir, installation, catalog);
}

// Only the installed Host's public resolution and compatibility policy are used.
export async function doctor(machine, targets) {
  const deployment = validateDeployment(machine.deployment);
  const hostManifest = resolveInstalledHost(deployment);
  const require = createRequire(hostManifest);
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { ModuleLoader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href);
  const loader = ModuleLoader.fromInternal();
  if (!loader) throw new Error('Installed Host module resolver is unavailable; use the supported Node/Host runtime');
  const issues = [];
  const globals = readYaml(deployment.globalWorkspacePath);
  for (const [name, location] of Object.entries(deployment.profiles)) {
    const profile = boot.loadProfileDirectory('dsh-config doctor', dirname(location.packagePath), hostManifest);
    const resolution = await boot.createRuntimeResolution({ installAnchor: hostManifest, profile, home: deployment.home });
    const ctx = new Context();
    await ctx.plugin(boot.PluginPackages, { resolution });
    try {
      const { exemptions, warnings } = boot.readProfileCompatibility(profile.dir);
      const requested = json(location.packagePath).dependencies ?? {};
      for (const reason of warnings) issues.push({ profile: name, status: 'compatibility-warning', reason });
      for (const target of targets.entries.filter(row => row.version && (row.scope === 'global-override' || row.profile === name))) {
        const sources = target.scope === 'profile' ? requested : globals.overrides ?? {};
        const declaredKeys = Object.keys(sources).filter(key => key === target.name || (target.scope === 'global-override' && key.startsWith(target.name + '@')));
        if (target.target && (!declaredKeys.length || declaredKeys.some(key => sources[key] !== target.target))) issues.push({ profile: name, name: target.name, status: 'declared-source-mismatch', expected: target.target });
        const anchor = target.scope === 'profile' ? location.packagePath : hostManifest;
        const parentURL = pathToFileURL(anchor).href;
        const installed = ctx.pluginPackages.packageOf(target.name, parentURL);
        if (!installed) {
          issues.push({ profile: name, name: target.name, status: 'missing-installed-package' });
          continue;
        }
        if (installed.version !== target.version) issues.push({ profile: name, name: target.name, status: 'installed-version-mismatch', expected: target.version, actual: installed.version });
        try {
          const selected = loader.version === 'v2'
            ? loader.resolveSync(parentURL, { specifier: target.name, attributes: {} })
            : loader.resolveSync(target.name, parentURL, {});
          const entry = fileURLToPath(selected.url);
          if (!existsSync(entry) || /\.tsx?$/.test(entry)) issues.push({ profile: name, name: target.name, status: 'invalid-built-entry' });
        } catch (error) {
          issues.push({ profile: name, name: target.name, status: 'missing-built-entry', reason: error.code ?? error.name });
        }
        const manifest = json(installed.manifestPath);
        const conflict = boot.evaluatePluginCompatibility(manifest, exemptions);
        if (conflict && !conflict.exempted) issues.push({ profile: name, name: target.name, status: 'compatibility-blocked', reason: boot.pluginCompatibilityWarning(conflict) });
      }
    } finally { await ctx.fiber.dispose(); }
  }
  return { issues, blocked: issues.length, next: issues.length ? 'Inspect the original compatibility reason; authorize only the exact supported package/runtime combination with the official dsh profile CLI, then rerun doctor.' : 'Resolution and public compatibility checks passed; no Host was started.' };
}

export function runStep(argv, cwd, env = process.env) {
  const child = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  // Tool output may contain private configuration. Keep it in a private step log.
  if (child.error || child.status !== 0) {
    const log = join(root, 'generated', 'last-step.log');
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    writeFileSync(log, (child.stdout ?? '') + (child.stderr ?? ''), { mode: 0o600 });
    throw new Error(`Step failed (${argv[0]}, exit ${child.status ?? child.error?.code}); private log: ${log}`);
  }
}

export async function updateMachine(machinePath, label, apply = false, dependencies = {}) {
  const machine = readYaml(machinePath);
  const targets = deploymentTargets(machine, join(dirname(machinePath), 'snapshot'), dependencies.catalog);
  const blocked = targets.entries.filter(row => row.status.startsWith('blocked'));
  const preview = { entries: targets.entries, blocked: blocked.length, apply: false, hostLifecycle: 'external-maintenance-window' };
  if (!apply) return preview;
  if (blocked.length) throw new Error(`Apply blocked: ${blocked.length} exact Release assets are missing; no files changed.`);
  const deployment = validateDeployment(machine.deployment);
  const { rendered } = renderMachine(machinePath, label, dependencies.catalog, { stage: false });
  const manifests = [
    [deployment.globalWorkspacePath, YAML.stringify(targets.globalWorkspace)],
    ...Object.entries(targets.profiles).map(([name, manifest]) => {
      assert.ok(deployment.profiles[name], `Missing deployment location for ${name}`);
      return [deployment.profiles[name].packagePath, JSON.stringify(manifest, null, 2) + '\n'];
    }),
  ];
  const patches = [
    [deployment.homePatchPath ?? join(deployment.home, 'cordis.patch.yml'), rendered.home],
    [deployment.profiles.web.patchPath ?? join(dirname(deployment.profiles.web.packagePath), 'cordis.patch.yml'), rendered.web],
  ];
  const inspect = dependencies.doctor ?? doctor;
  const before = await inspect(machine, targets);
  const manifestChanged = manifests.some(([path, contents]) => !existsSync(path) || !isDeepStrictEqual(readYaml(path), parseYaml(contents)));
  const patchesChanged = patches.some(([path, contents]) => !existsSync(path) || readFileSync(path, 'utf8') !== contents);
  const needsInstall = manifestChanged || before.issues.some(issue => ['missing-installed-package', 'installed-version-mismatch', 'declared-source-mismatch', 'missing-built-entry', 'invalid-built-entry'].includes(issue.status));
  if (!needsInstall && before.blocked) return { ...preview, issues: before.issues, blocked: before.blocked, next: before.next };
  if (!needsInstall && !patchesChanged) return { ...preview, apply: true, noOp: true, activation: 'No target changes; Host activation was not checked.' };
  const installArguments = needsInstall ? globalInstallArguments(deployment) : undefined;
  const backup = mkdtempSync(join(root, 'generated', `${label}-backup-`));
  const files = [...manifests, ...patches];
  const backupFiles = [...new Set([...files.map(([path]) => path),
    ...manifests.map(([path]) => join(dirname(path), 'pnpm-lock.yaml')),
    join(dirname(deployment.globalWorkspacePath), 'package.json'),
    ...Object.values(deployment.profiles).map(location => join(dirname(location.packagePath), 'compatibility.json'))])];
  for (const [index, path] of backupFiles.entries()) if (existsSync(path)) copyFileSync(path, join(backup, String(index)));
  writeFileSync(join(backup, 'files.json'), JSON.stringify(backupFiles), { mode: 0o600 });
  const execute = dependencies.runStep ?? runStep;
  try {
    if (needsInstall) {
      for (const [path, contents] of manifests) writeFileSync(path, contents, { mode: 0o600 });
      execute(installArguments, dirname(deployment.globalWorkspacePath), { ...process.env, PATH: deployment.globalBinDir + delimiter + process.env.PATH });
      for (const profile of Object.values(deployment.profiles)) execute(['pnpm', 'install', '--no-frozen-lockfile', '--ignore-workspace', '--config.auto-install-peers=false', '--config.enable-global-virtual-store=false'], dirname(profile.packagePath));
    }
    const report = needsInstall ? await inspect(machine, targets) : before;
    if (report.blocked) {
      writeFileSync(join(backup, 'doctor.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      throw new Error('Post-install doctor blocked configuration application; inspect doctor.json in the backup and authorize the exact supported combination externally');
    }
    for (const [path, contents] of patches) writeFileSync(path, contents, { mode: 0o600 });
  } catch (error) {
    throw new Error(`${error.message}; backup retained: ${backup}. Installation may have changed; Host was not started or stopped.`);
  }
  return { ...preview, apply: true, backup, activation: 'installed-not-activated; external Host restart and behavior verification required' };
}

export function isolatedTest(machinePath, label, tarballs = [], execute = runStep) {
  const machine = readYaml(machinePath);
  const smoke = machine.deployment?.smoke;
  assert.ok(Array.isArray(smoke?.argv) && smoke.argv.length && smoke.argv.every(arg => typeof arg === 'string'), 'Explicit smoke argv required');
  assert.ok(isAbsolute(smoke.cwd ?? ''), 'Absolute smoke cwd required');
  assert.ok(smoke.ownsInstallation === true || smoke.argv.some(arg => arg.includes('{testRoot}') || arg.includes('{home}')), 'Smoke must declare its own installation or receive the isolated root');
  if (!smoke.ownsInstallation) {
    validatePatch(smoke.homePatch);
    validatePatch(smoke.webPatch);
  }
  const catalog = structuredClone(readDependencyCatalog());
  const sources = new Map();
  for (const input of tarballs) {
    const separator = input?.indexOf('=') ?? -1;
    assert.ok(separator > 0, 'Tarball must be package=/absolute/file.tgz');
    const name = input.slice(0, separator), path = input.slice(separator + 1);
    assert.ok(isAbsolute(path) && path.endsWith('.tgz') && existsSync(path), 'Missing absolute local tarball');
    assert.ok(catalog.packages.some(item => item.package === name), 'Tarball package is not managed');
    sources.set(name, 'file:' + path);
  }
  // Missing Release sources can be supplied only in this independent test copy.
  const targets = deploymentTargets(machine, join(dirname(machinePath), 'snapshot'), catalog);
  const blocked = targets.entries.filter(row => row.status.startsWith('blocked') && !sources.has(row.name));
  if (blocked.length && !smoke.ownsInstallation) throw new Error(`Isolated test blocked: provide local tarballs for ${blocked.map(row => row.name).join(', ')}`);
  const { output } = renderMachine(machinePath, label);
  const testRoot = mkdtempSync(join(output, 'isolated-'));
  const copiedTarballs = new Map();
  for (const [name, source] of sources) {
    const destination = join(testRoot, name.replaceAll('/', '-').replace('@', '') + '.tgz');
    copyFileSync(source.slice(5), destination);
    copiedTarballs.set(name, destination);
  }
  for (const [name, path] of copiedTarballs) sources.set(name, 'file:' + path);
  for (const row of targets.entries.filter(row => row.version)) {
    if (!sources.has(row.name)) continue;
    const object = row.scope === 'global-override' ? targets.globalWorkspace.overrides : targets.profiles[row.profile].dependencies;
    const keys = row.scope === 'global-override' ? Object.keys(object).filter(key => key === row.name || key.startsWith(row.name + '@')) : [row.name];
    for (const key of keys.length ? keys : [row.name]) object[key] = sources.get(row.name);
  }
  const home = join(testRoot, 'home');
  mkdirSync(join(home, 'profiles/web'), { recursive: true, mode: 0o700 });
  mkdirSync(join(testRoot, 'installation'), { mode: 0o700 });
  const paths = { testRoot, home, globalWorkspace: join(testRoot, 'installation/pnpm-workspace.yaml'), webPackage: join(home, 'profiles/web/package.json'), homePatch: join(home, 'cordis.patch.yml'), webPatch: join(home, 'profiles/web/cordis.patch.yml') };
  writeFileSync(paths.globalWorkspace, YAML.stringify(targets.globalWorkspace), { mode: 0o600 });
  for (const [name, manifest] of Object.entries(targets.profiles)) {
    mkdirSync(join(home, 'profiles', name), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'profiles', name, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(home, 'profiles', name, '.npmrc'), 'auto-install-peers=false\n', { mode: 0o600 });
  }
  writeFileSync(paths.homePatch, smoke.homePatch ?? '[]\n', { mode: 0o600 });
  writeFileSync(paths.webPatch, smoke.webPatch ?? '[]\n', { mode: 0o600 });
  const argv = smoke.argv.map(arg => arg
    .replace(/\{tarball:([^}]+)\}/g, (_, name) => {
      assert.ok(copiedTarballs.has(name), `Missing smoke tarball: ${name}`);
      return copiedTarballs.get(name);
    })
    .replace(/\{(testRoot|home|globalWorkspace|webPackage|homePatch|webPatch)\}/g, (_, key) => paths[key]));
  execute(argv, smoke.cwd, { ...process.env, DSH_HOME: home, DSH_CONFIG_TEST_ROOT: testRoot });
  return { testRoot, smokeOwnsInstallation: smoke.ownsInstallation === true, renderedConfigurationVerified: false,
    unresolvedAssets: blocked.map(row => row.name),
    configuration: 'Normal render retained separately; only explicit controlled smoke patches staged. Smoke behavior determines which layout is verified.', hostStartedByConfig: false };
}
