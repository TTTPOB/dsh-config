import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, readDependencyCatalog, readYaml, validatePatch } from '../scripts/lib.mjs';
import { verifyToolCatalog, verifyDumpConfiguration } from '../scripts/profile-smoke-checks.mjs';
import { runProfileSmoke, launchHost, runSmokeCommand, openSmokePage } from '../scripts/profile-smoke.mjs';
import { probeInvalidCompression, createProbeAgent } from '../scripts/profile-smoke-probe.mjs';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-profile-smoke-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('failed smoke commands retain package-manager diagnostics written to stdout', t => {
  const directory = temporary(t);
  assert.throws(() => runSmokeCommand([process.execPath, '-e', 'console.log("ERR_PNPM_fixture"); process.exit(1)'], directory, process.env), /ERR_PNPM_fixture/);
});

test('probe Agent creation explicitly mounts its selected preset before publication', async () => {
  const scoped = {}, calls = [];
  const ctx = { agents: { create: async options => {
    assert.deepEqual(options.meta, { cwd: '/owned/workspace', agentPreset: 'standard-ptc-team' });
    await options.setup(scoped); calls.push('published'); return 'handle';
  } }, agentPresets: { mount: async (context, id) => {
    assert.equal(context, scoped); calls.push(id);
  } } };
  assert.equal(await createProbeAgent(ctx, 'standard-ptc-team', '/owned/workspace'), 'handle');
  assert.deepEqual(calls, ['standard-ptc-team', 'published']);
});

function catalog(team) {
  return [...(team ? ['spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'] : ['subagent', 'subagent_fork']),
    'send_message', 'list_agents', 'interrupt_agent', 'run_code', 'workflow', 'ralph', 'context_compress']
    .map(name => ({ name, parameters: { type: 'object', properties: name === 'send_message' ? { [team ? 'target' : 'agent_id']: {} } : {} } }));
}
const runtimeRows = [{ id: 'ptc-runtime',
  name: '@deepseek-ai/dsh-ptc-runtime-node', config: { executionMode: 'per-call' } }];
const assembly = { tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', text: 'tools.context_compress' }] };

test('Web smoke exchanges the launch token and sends its cookie to the clean index', async () => {
  const urls = [];
  const headers = await openSmokePage('http://127.0.0.1:49152/?token=fixture', async (url, options) => {
    urls.push(url);
    if (urls.length === 1) return { status: 303, headers: new Headers({ 'set-cookie': 'fixture=value; HttpOnly', location: './' }) };
    assert.equal(options.headers.cookie, 'fixture=value');
    return { status: 200, text: async () => '<script>window.__DSH_BOOT__={}</script>' };
  });
  assert.equal(urls[1], 'http://127.0.0.1:49152/');
  assert.equal(headers.cookie, 'fixture=value');
});

test('profile assertions reject Team leakage, wrong message implementation and absent ACP SDK', () => {
  assert.equal(verifyToolCatalog('standard-ptc', catalog(false), assembly).ptc, true);
  assert.equal(verifyToolCatalog('standard-ptc-team', catalog(true), assembly).acp, true);
  assert.throws(() => verifyToolCatalog('standard-ptc', [...catalog(false), { name: 'spawn_teammate' }], assembly), /unexpected spawn_teammate/);
  const wrong = catalog(true);
  wrong.find(row => row.name === 'send_message').parameters = { type: 'object', properties: { agent_id: {} } };
  assert.throws(() => verifyToolCatalog('standard-ptc-team', wrong, assembly), /wrong send_message/);
  assert.throws(() => verifyToolCatalog('standard-ptc', catalog(false), { ...assembly, sections: [] }), /PTC SDK/);
  assert.throws(() => verifyToolCatalog('standard-ptc', catalog(false), { ...assembly, sections: [
    { name: 'active-context', text: 'Use context_compress for completed work.' },
    { name: 'tools:sdk', text: 'tools.list_agents' },
  ] }), /PTC SDK/);
  assert.throws(() => verifyToolCatalog('standard-ptc', [...catalog(false), catalog(false)[0]], assembly), /duplicate/);
});

test('dump assertions require the isolated bind and reject global Team tools', () => {
  const rows = [...runtimeRows, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard-ptc', plugins: [{ id: 'tool-presentation', config: { mode: 'ptc' } }] } }];
  verifyDumpConfiguration(rows, ['standard-ptc']);
  assert.throws(() => verifyDumpConfiguration([...rows, { id: 'tool-agent-team' }], ['standard-ptc']), /global Team/);
  assert.throws(() => verifyDumpConfiguration([...runtimeRows, { ...rows[1], config: { host: '127.0.0.1', port: 53083 } }, rows[2]], ['standard-ptc']));
});

test('smoke orchestration preserves workspace overrides, never ignores build policy and always stops its Host', async t => {
  const directory = temporary(t), home = join(directory, 'home'), installation = join(directory, 'installation');
  mkdirSync(join(home, 'profiles/web'), { recursive: true });
  mkdirSync(installation);
  const options = { runtimeVersion: '0.2.1-rc.1', presets: ['standard-ptc'], compatibility: ['fixture@1.0.0-fork1'] };
  writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'profile-smoke-probe', config: options }] }]));
  writeFileSync(join(installation, 'pnpm-workspace.yaml'), JSON.stringify({ overrides: { fixture: 'file:/owned/fixture.tgz' } }));
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_CONFIG_TEST_ROOT: process.env.DSH_CONFIG_TEST_ROOT, DSH_SECRET_CANARY: process.env.DSH_SECRET_CANARY };
  Object.assign(process.env, { DSH_HOME: home, DSH_CONFIG_TEST_ROOT: directory, DSH_SECRET_CANARY: 'must-not-reach-host' });
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let stopped = 0, launched = 0;
  const commands = [];
  const dependencies = {
    run: (argv, cwd, env) => {
      commands.push(argv);
      assert.equal(env.DSH_HOME, home);
      assert.equal(env.TMPDIR, join(directory, 'tmp'));
      assert.equal(env.DSH_SECRET_CANARY, undefined);
      assert.ok(cwd.startsWith(directory));
      assert.ok(!argv.includes('--ignore-workspace'));
      return JSON.stringify([...runtimeRows, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
        { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard-ptc', plugins: [{ id: 'tool-presentation', config: { mode: 'ptc' } }] } }]);
    },
    resolveCli: () => join(installation, 'fixture-cli.mjs'),
    launch: async () => { launched++; return { url: 'http://127.0.0.1:49152', stop: async () => { stopped++; } }; },
    fetch: async () => ({ status: 200, text: async () => '<script>window.__DSH_BOOT__={}</script>',
      json: async () => ({ loaded: true, presets: [{ id: 'standard-ptc' }] }) }),
  };
  assert.equal((await runProfileSmoke(directory, home, dependencies)).isolatedHost, true);
  assert.equal(launched, 1); assert.equal(stopped, 1);
  for (const path of [join(installation, 'pnpm-workspace.yaml'), join(home, 'profiles/web/pnpm-workspace.yaml')]) {
    const workspace = readYaml(path);
    assert.equal(workspace.overrides.fixture, 'file:/owned/fixture.tgz');
    assert.equal(workspace.allowBuilds.koffi, true);
    assert.equal(workspace.allowBuilds['@deepseek-ai/dsh-subprocess-local'], true);
    assert.equal(workspace.blockExoticSubdeps, false);
    assert.equal(workspace.autoInstallPeers, path.startsWith(installation));
  }
  assert.ok(commands.some(argv => argv.includes('allow-version') && argv.includes('fixture@1.0.0-fork1')));
  await assert.rejects(runProfileSmoke(directory, home, { ...dependencies, fetch: async () => { throw new Error('probe failed'); } }), /probe failed/);
  assert.equal(stopped, 2);
  await assert.rejects(runProfileSmoke(directory, join(directory, '..', 'unowned-home'), dependencies));
});

test('ACP process probe requires canonical input validation and an unchanged Surface', async () => {
  const events = [];
  const session = { surface: { nodes: [] }, snapshotEvents: () => events,
    append(type, data, options) {
      const event = { type, data, seq: events.length };
      events.push(event);
      if (options?.surfaceOp === 'append') session.surface.nodes.push(event.seq);
      return event;
    } };
  const agent = { session };
  const messages = { createAssistantMessage: value => value, createToolResultMessage: value => value };
  const ctx = { tools: { execute: async execution => {
    assert.equal(execution.arguments.code, 'return await tools.context_compress({"regions":[]});');
    return { isError: true, content: [{ type: 'text', text: 'ACP: submit 1-16 non-overlapping regions' }] };
  } } };
  assert.equal((await probeInvalidCompression(ctx, agent, messages)).surfaceUnchanged, true);
  assert.equal(events.at(-1).type, 'turn/end');
  ctx.tools.execute = async () => ({ isError: true, content: [{ type: 'text', text: 'ACP: independent call required' }] });
  await assert.rejects(probeInvalidCompression(ctx, agent, messages), /did not reach ACP input validation/);
});

test('managed process helper stops its own child and removes signal handlers, including startup failure', async t => {
  const directory = temporary(t);
  const env = { ...process.env, DSH_CONFIG_TEST_ROOT: directory };
  const listeners = process.listenerCount('SIGTERM');
  const child = await launchHost([process.execPath, '-e', 'console.log("dsh web: http://127.0.0.1:49152/?token=fixture"); setInterval(() => {}, 1000)'], directory, env);
  t.after(() => child.stop());
  assert.equal(child.url, 'http://127.0.0.1:49152/?token=fixture');
  await child.stop();
  await child.stop();
  assert.equal(process.listenerCount('SIGTERM'), listeners);
  await assert.rejects(launchHost([process.execPath, '-e', 'process.exit(7)'], directory, env), /exited before startup/);
  assert.equal(process.listenerCount('SIGTERM'), listeners);
});

test('preparation stages credential-free full preset input and an executable tarball argv without installing', t => {
  const directory = temporary(t), assets = join(directory, 'assets'), packageDir = join(directory, 'package');
  mkdirSync(assets); mkdirSync(packageDir);
  const packages = new Map(readDependencyCatalog().packages.filter(item => item.policy === 'release').map(item => [item.package, item]));
  let index = 0;
  for (const item of packages.values()) {
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: item.package, version: item.version }));
    execFileSync('tar', ['-czf', join(assets, `${index++}.tgz`), '-C', directory, 'package']);
  }
  const output = join(directory, 'output');
  execFileSync(process.execPath, [join(root, 'scripts/prepare-profile-smoke.mjs'), assets, output], { encoding: 'utf8' });
  const machine = readYaml(join(output, 'machine.yaml'));
  const rows = validatePatch(machine.deployment.smoke.homePatch).map(row => row.entry);
  assert.equal(rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').length, 3);
  assert.equal(rows.find(row => row.id === 'mcp-codegraph').disabled, true);
  assert.ok(!rows.some(row => row.id === 'mcp-playwright'));
  assert.ok(!machine.deployment.smoke.ownsInstallation);
  const webRows = validatePatch(machine.deployment.smoke.webPatch).map(row => row.entry);
  assert.equal(webRows.find(row => row.id === 'webserver').config.port, 0);
  assert.equal(webRows.find(row => row.id === 'directory-picker').disabled, true);
  assert.equal(webRows.find(row => row.id === 'ui-directory-picker-browse').name, '@deepseek-ai/dsh-client-ui-directory-picker-browse');
  const argv = JSON.parse(readFileSync(join(output, 'argv.json'), 'utf8'));
  assert.equal(argv.filter(arg => arg === '--tarball').length, packages.size);
  assert.ok(!argv.includes('--apply'));
});
