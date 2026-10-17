#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { verifyDumpConfiguration } from './profile-smoke-checks.mjs';
import { readDependencyCatalog } from './lib.mjs';

export const allowBuilds = readDependencyCatalog().allowBuilds;

export function prepareInstallation(testRoot, home) {
  const child = relative(testRoot, home);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Smoke home must be inside its owned test root');
  const installation = join(testRoot, 'installation');
  const staged = YAML.parse(readFileSync(join(installation, 'pnpm-workspace.yaml'), 'utf8'));
  const workspace = { ...staged, packages: ['.'], blockExoticSubdeps: false,
    autoInstallPeers: true, enableGlobalVirtualStore: false, allowBuilds: { ...staged.allowBuilds, ...allowBuilds } };
  const homePatch = YAML.parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'));
  const options = homePatch.flatMap(row => row.insert ?? [row]).find(row => row.id === 'profile-smoke-probe')?.config;
  assert.ok(options, 'Missing controlled profile-smoke-probe configuration');
  assert.equal(options.runtimeVersion, '0.2.1-rc.1');
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ name: 'dsh-profile-smoke', private: true,
    type: 'module', packageManager: 'pnpm@11.28.5', dependencies: { '@deepseek-ai/dsh': options.runtimeVersion } }), { mode: 0o600 });
  writeFileSync(join(installation, 'pnpm-workspace.yaml'), YAML.stringify(workspace), { mode: 0o600 });
  const profile = join(home, 'profiles/web');
  // Profile dependencies need the same transitive overrides as the CLI installation.
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), YAML.stringify({ ...workspace, autoInstallPeers: false }), { mode: 0o600 });
  return { installation, profile, options };
}

export function runSmokeCommand(argv, cwd, env) {
  const child = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`Smoke command failed: ${argv[0]} (${child.error?.code ?? child.status})\n${[child.stdout, child.stderr].filter(Boolean).join('\n').slice(-8000)}`);
  return child.stdout;
}

export async function launchHost(argv, cwd, env) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = join(env.DSH_CONFIG_TEST_ROOT, 'host.log');
  writeFileSync(logPath, '', { mode: 0o600 });
  const { appendFileSync } = await import('node:fs');
  let stopped = false;
  const interrupted = () => { void stop().finally(() => process.exit(143)); };
  const stop = async () => {
    process.removeListener('SIGTERM', interrupted);
    process.removeListener('SIGINT', interrupted);
    if (stopped || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const kill = signal => process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal);
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated Host startup timed out')), 120000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Isolated Host exited before startup (${code}); inspect its private smoke log`)));
      let output = '';
      child.stdout.on('data', chunk => {
        appendFileSync(logPath, chunk);
        output = (output + chunk).slice(-16384);
        const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr.on('data', chunk => appendFileSync(logPath, chunk));
    });
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function openSmokePage(url, request = fetch) {
  const login = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const cookie = login.headers?.get('set-cookie')?.split(';')[0];
  const headers = cookie ? { cookie } : {};
  const page = login.status === 303
    ? await request(new URL(login.headers.get('location') ?? '/', url).href, { headers, signal: AbortSignal.timeout(30000) })
    : login;
  assert.equal(page.status, 200, 'Isolated Web page did not open');
  assert.match(await page.text(), /__DSH_BOOT__/, 'Missing supported Web boot payload');
  return headers;
}

export async function runProfileSmoke(testRoot, home, dependencies = {}) {
  testRoot = resolve(testRoot); home = resolve(home);
  assert.equal(process.env.DSH_CONFIG_TEST_ROOT, testRoot, 'Only deployment.test-owned roots may run this smoke');
  assert.equal(process.env.DSH_HOME, home, 'Smoke must use its independent DSH_HOME');
  const { installation, profile, options } = prepareInstallation(testRoot, home);
  const inherited = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'PNPM_HOME', 'SHELL', 'LANG', 'LC_ALL',
    'TMPDIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'SYSTEMROOT', 'COMSPEC']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const temporary = join(testRoot, 'tmp');
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const env = { ...inherited, TMPDIR: temporary, DSH_HOME: home, DSH_CONFIG_TEST_ROOT: testRoot, NODE_OPTIONS: '--max-old-space-size=4096' };
  const execute = dependencies.run ?? runSmokeCommand;
  const install = ['pnpm', '--config.verify-deps-before-run=false', '--config.enable-global-virtual-store=false',
    'install', '--no-frozen-lockfile'];
  execute([...install, '--config.auto-install-peers=true'], installation, env);
  execute([...install, '--config.auto-install-peers=false'], profile, env);
  const cli = dependencies.resolveCli?.(installation) ?? (() => {
    const require = createRequire(join(installation, 'package.json'));
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, options.runtimeVersion, 'Unexpected installed CLI version');
    env.DSH_SMOKE_HOST_MANIFEST = manifestPath;
    return join(manifestPath, '..', typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh);
  })();
  // Risk acceptance here is confined to this disposable installation, not the verified catalog.
  for (const identity of options.compatibility) execute([process.execPath, cli, 'plugin', '--profile', 'web',
    'allow-version', identity, '--dsh-version', options.runtimeVersion, '--accept-risk'], installation, env);
  const dump = execute([process.execPath, cli, '--profile', 'web', '--dump-config'], installation, env);
  writeFileSync(join(testRoot, 'dump-config.yml'), dump, { mode: 0o600 });
  verifyDumpConfiguration(YAML.parse(dump), options.presets);
  const host = await (dependencies.launch ?? launchHost)([process.execPath, cli, '--profile', 'web', '--no-open'], installation, env);
  try {
    const request = dependencies.fetch ?? fetch;
    const headers = await openSmokePage(host.url, request);
    const response = await request(new URL('/__dsh-config-smoke', host.url).href, { headers, signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.presets.length, options.presets.length);
    assert.equal(result.loaded, true);
    const browserArgv = process.env.DSH_CONFIG_BROWSER_SMOKE_ARGV ? JSON.parse(process.env.DSH_CONFIG_BROWSER_SMOKE_ARGV) : undefined;
    if (browserArgv) {
      assert.ok(Array.isArray(browserArgv) && browserArgv.length && browserArgv.every(arg => typeof arg === 'string'));
      execute(browserArgv.map(arg => arg.replaceAll('{url}', host.url)), installation, { ...env, DSH_SMOKE_URL: host.url });
    }
    return { ...result, runtimeVersion: options.runtimeVersion, dumpConfig: true, isolatedHost: true,
      webPageOpened: true, browserChecked: Boolean(browserArgv) };
  } finally {
    await host.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportPath = join(resolve(process.argv[2]), 'profile-smoke-report.json');
  try {
    const result = await runProfileSmoke(process.argv[2], process.argv[3]);
    writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    writeFileSync(reportPath, JSON.stringify({ error: error.message }) + '\n', { mode: 0o600 });
    console.error(error.message);
    process.exitCode = 1;
  }
}
