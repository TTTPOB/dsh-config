import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, parseYaml, readYaml, validateMachine, validatePatch, renderMachine, resolveDependencyTargets, parseCommandArguments, resolveMachineArgument, resolvesFromProfile, preserveLiveRows } from '../scripts/lib.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-config-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const example = join(root, 'examples/workstation-machine.yaml');

test('Visualize is installed and activated once in Web only, replacing OpenUI', () => {
  for (const machine of ['workstation', 'server']) {
    const { rendered } = renderMachine(join(root, 'examples/' + machine + '-machine.yaml'), 'visualize', undefined, { stage: false });
    const web = validatePatch(rendered.web).map(row => row.entry);
    const home = validatePatch(rendered.home).map(row => row.entry);
    assert.equal(web.filter(row => row.name === '@nagi-ovo/dsh-visualize').length, 1);
    assert.ok(!web.some(row => row.name === 'dsh-openui'));
    assert.ok(!home.some(row => row.name === '@nagi-ovo/dsh-visualize'));
    const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
    assert.ok(!catalog.packages.some(row => row.package === 'dsh-openui'));
    const selected = catalog.packages.find(row => row.package === '@nagi-ovo/dsh-visualize');
    const target = resolveDependencyTargets('unused', {
      webPackage: { dsh: { profile: { bundles: ['@nagi-ovo/dsh-visualize'] } } },
      profiles: { headless: {} },
    }, catalog);
    assert.equal(target.profiles.web.dependencies[selected.package], selected.url ?? selected.version);
    assert.ok(!target.profiles.web.dsh.profile.bundles.includes(selected.package));
    assert.ok(!target.profiles.headless.dependencies[selected.package]);
  }
});

for (const machine of ['workstation', 'server']) {
  test(`${machine} titles use the shared Flash route independently of the conversation model`, () => {
    const { rendered } = renderMachine(join(root, `examples/${machine}-machine.yaml`), 'title-model', undefined, { stage: false });
    const rows = validatePatch(rendered.home).map(row => row.entry);
    assert.ok(!validatePatch(rendered.web).some(row => row.entry.id === 'session-title-llm'));
    assert.deepEqual(rows.find(row => row.id === 'session-title-llm').config, {
      provider: 'deepseek-official', model: 'deepseek-flash',
      targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 65536,
      maxOutputTokens: 64, timeoutMs: 60000,
    });
  });
}

test('rc.1 presets separate ordinary delegation and Team tools without present', () => {
  const { rendered } = renderMachine(example, 'rc1-presets', undefined, { stage: false });
  const rows = validatePatch(rendered.home).map(row => row.entry);
  const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset');
  const byId = id => presets.find(row => row.config.id === id).config.plugins;
  const delegation = plugins => plugins.find(row => row.id === 'delegation').config;
  assert.deepEqual(presets.map(row => row.config.id).sort(), ['standard-ptc', 'standard-ptc-team']);
  for (const id of ['standard-ptc']) {
    const plugins = byId(id), tools = delegation(plugins);
    const spawn = tools.find(row => row.id === 'tool-subagent').config;
    assert.deepEqual(spawn, { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true });
    assert.deepEqual(tools.find(row => row.id === 'tool-subagent-fork').config,
      { provider: 'fork', toolName: 'subagent_fork' });
    assert.ok(!tools.some(row => row.id === 'tool-agent-team'));
    assert.equal(plugins.find(row => row.id === 'tool-presentation').config.mode, 'ptc');
  }
  for (const preset of presets) assert.ok(!preset.config.plugins.some(row => row.id === 'present'));
  const teamTools = delegation(byId('standard-ptc-team'));
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']) {
    assert.ok(!teamTools.some(row => row.id === id));
  }
  assert.deepEqual(teamTools.find(row => row.id === 'tool-agent-team').config, { freshProvider: 'spawn', forkProvider: 'fork', modelSelectionSettings: true });
  for (const preset of presets) for (const id of ['workflow-ptc', 'tool-workflow', 'tool-ralph']) {
    assert.ok(delegation(preset.config.plugins).some(row => row.id === id));
  }
  assert.deepEqual(rows.find(row => row.id === 'tools').config, {
    mode: 'native', maxParallelSubCalls: 10, ptcNativeTools: ['context_compress'],
  });
  assert.equal(rows.find(row => row.id === 'ptc-runtime').config.executionMode, 'per-call');
  assert.ok(!rows.some(row => row.id === 'ptc-runtime-personal'));
  assert.equal(rows.filter(row => row.id === 'agent-team').length, 1);
  assert.equal(rows.filter(row => row.id === 'ui-agent-team').length, 1);
  assert.ok(!rows.some(row => row.id === 'tool-agent-team'));
});

test('rc.1 dependency migration removes retired overrides and resets obsolete Pi selectors', () => {
  const catalog = { packages: [{ package: '@earendil-works/pi-ai', scope: 'global-override', policy: 'release',
    version: '1.1.0-fork1', resetSelectors: true, reason: '待发布来源' }],
    retiredGlobalOverrides: ['@deepseek-ai/dsh-client-ui-settings'] };
  const source = { globalWorkspace: { overrides: {
    '@deepseek-ai/dsh-client-ui-settings': 'file:old-ui.tgz',
    '@deepseek-ai/dsh-client-ui-settings@0.1.7-rc.2': 'file:old-ui.tgz',
    '@earendil-works/pi-ai@0.85.1': 'file:old-pi.tgz',
    unrelated: '1.0.0',
  } } };
  const target = resolveDependencyTargets('unused', source, catalog);
  assert.deepEqual(target.globalWorkspace.overrides, { unrelated: '1.0.0' });
  assert.equal(target.entries.filter(row => row.status === 'retired-override').length, 2);
  assert.ok(target.entries.some(row => row.status === 'blocked-missing-release'));
  catalog.packages[0].url = 'https://github.com/example/pi/releases/download/v1.1.0-fork1/pi.tgz';
  assert.deepEqual(resolveDependencyTargets('unused', source, catalog).globalWorkspace.overrides,
    { unrelated: '1.0.0', '@earendil-works/pi-ai': catalog.packages[0].url });
  assert.ok(source.globalWorkspace.overrides['@earendil-works/pi-ai@0.85.1']);
});

test('rc.1 catalog normalizes old core and native selectors to effective package-wide overrides', () => {
  const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
  const targets = resolveDependencyTargets('unused', { globalWorkspace: { overrides: {
    '@deepseek-ai/dsh-session@0.1.7-rc.2': 'file:old-session.tgz',
    'node-addon-require-builtin@0.1.6': '0.1.6',
  } } }, catalog);
  assert.ok(!('@deepseek-ai/dsh-session@0.1.7-rc.2' in targets.globalWorkspace.overrides));
  assert.ok(!('node-addon-require-builtin@0.1.6' in targets.globalWorkspace.overrides));
  assert.equal(targets.globalWorkspace.overrides['node-addon-require-builtin'], '0.1.9');
});

test('required Team packages are installed without activating the official global-tool bundle', () => {
  const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
  const target = resolveDependencyTargets('unused', { webPackage: { dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-agent-team-profile',
  ] } } } }, catalog);
  const team = catalog.packages.find(row => row.package === '@deepseek-ai/dsh-experimental-agent-team' && row.scope === 'profile');
  assert.ok(team.url);
  assert.equal(target.profiles.web.dependencies[team.package], team.url);
  assert.equal(target.globalWorkspace.overrides[team.package], team.url);
  const tool = catalog.packages.find(row => row.package === '@deepseek-ai/dsh-experimental-tool-agent-team');
  assert.ok(target.entries.some(row => row.name === tool.package
    && row.scope === 'profile' && row.status === 'verified-release' && row.target === tool.url));
  assert.equal(target.profiles.web.dependencies[tool.package], tool.url);
  assert.equal(target.globalWorkspace.overrides[tool.package], tool.url);
  assert.deepEqual(target.profiles.web.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
});


test('profile-owned official forks resolve from the actual consumer even when a global override is also declared', () => {
  const entries = [{ name: 'team-tool', scope: 'global-override' }, { name: 'team-tool', scope: 'profile', profile: 'web' }];
  assert.equal(resolvesFromProfile(entries[0], entries, 'web'), true);
  assert.equal(resolvesFromProfile(entries[0], entries, 'headless'), false);
  assert.equal(resolvesFromProfile({ name: 'core', scope: 'global-override' }, entries, 'web'), false);
});

test('machine selector resolves private directories and preserves file path input', () => {
  for (const machine of ['workstation', 'server', 'nas', 'research-box_2']) {
    assert.deepEqual(parseCommandArguments(['render', '--machine', machine]), { command: 'render', machineArgument: machine });
    assert.deepEqual(resolveMachineArgument(machine), { path: join(root, 'private/machines', machine, 'machine.yaml'), label: machine });
  }
  assert.deepEqual(parseCommandArguments(['check', example]), { command: 'check', machineArgument: example });
  assert.equal(resolveMachineArgument(example).path, example);
  assert.throws(() => parseCommandArguments(['render', '--machine', '../other']));
  assert.throws(() => parseCommandArguments(['render', '--machine', 'workstation', 'extra']));
});

test('parses !!js as expression data without evaluating it', () => {
  const text = '- id: canary\n  config:\n    value: !!js (() => { throw new Error("must not run") })()\n';
  const value = parseYaml(text)[0].config.value;
  assert.match(value.__jsExpr, /must not run/);
});

test('rejects unsupported tags and malformed YAML', () => {
  assert.throws(() => parseYaml('value: !execute foo'));
  assert.throws(() => parseYaml('value: [unterminated'));
});

test('rejects incomplete machine config', () => {
  assert.throws(() => validateMachine({ schemaVersion: 1 }));
  const machine = readYaml(example);
  delete machine.features.sessionTools;
  assert.throws(() => validateMachine(machine));
});

test('keeps template-like text in literal machine rows without evaluating it', t => {
  const machine = readYaml(example);
  const literal = '[[ secret ]] [% if true %] [# comment #] {{cwd}} <>& "quoted"';
  machine.homePrivate = `- id: x\n  config:\n    value: ${JSON.stringify(literal)}\n`;
  assert.equal(validateMachine(machine), machine);
  const directory = fixture(t);
  const path = join(directory, 'literal-delimiters.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-literal-delimiters', undefined, { generatedDir: directory });
  assert.equal(validatePatch(rendered.home).find(row => row.entry.id === 'x').entry.config.value, literal);
  // The conversation default belongs to the UI model picker; the template no longer pins it.
  assert.ok(!validatePatch(rendered.web).some(row => row.entry.id === 'agent-default-model'));
});

test('rejects duplicate ids and expressions in metadata', () => {
  assert.throws(() => validatePatch('- id: x\n- insert:\n    - id: x\n'));
  assert.throws(() => validatePatch('- id: x\n  name: !!js "computed"\n'));
});

for (const role of ['workstation', 'server', 'active-context']) {
  test(`renders valid configuration from the ${role} example`, t => {
    const { rendered } = renderMachine(join(root, `examples/${role}-machine.yaml`), `test-example-${role}`, undefined, { generatedDir: fixture(t) });
    assert.ok(validatePatch(rendered.home).length > 0);
    assert.ok(validatePatch(rendered.web).length > 0);
    for (const value of [rendered.globalWorkspace, rendered.webPackage]) {
      const parsed = JSON.parse(value);
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    }
  });
}

test('offline render ignores unresolved deployment overrides', t => {
  const machine = readYaml(example);
  machine.deployment = { home: '$OFFLINE_UNDEFINED_ENV', globalWorkspacePath: '/missing/local/path' };
  const directory = fixture(t);
  const path = join(directory, 'offline-deployment.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-offline-deployment', undefined, { generatedDir: directory });
  assert.ok(validatePatch(rendered.home).length > 0);
});

test('enabled optional features render valid configuration', t => {
  const machine = readYaml(example);
  machine.features.promptOverlay = true;
  assert.throws(() => validateMachine(machine));
  const directory = fixture(t);
  machine.promptSections = {
    modulePath: join(root, 'plugins/prompt-sections.mjs'),
    promptFile: join(directory, 'extra.md'),
    identityFile: join(directory, 'identity.md'),
  };
  machine.features.sessionTools = true;
  const path = join(directory, 'prompt-machine.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-prompt-preset', undefined, { generatedDir: directory });
  assert.ok(validatePatch(rendered.home).length > 0);
  assert.ok(validatePatch(rendered.web).length > 0);
});

test('active context is optional and independent of history tools', () => {
  const machine = readYaml(example);
  delete machine.features.activeContext;
  assert.equal(validateMachine(machine), machine);
  machine.features.activeContext = 'yes';
  assert.throws(() => validateMachine(machine), /activeContext/);
  machine.features.activeContext = true;
  assert.equal(machine.features.sessionTools, false);
  assert.equal(validateMachine(machine), machine);
});

test('active context replaces Basic inside every declared preset and keeps the native policy', t => {
  const machine = readYaml(example);
  machine.features.sessionTools = true;
  machine.features.activeContext = true;
  machine.features.promptOverlay = true;
  const directory = fixture(t);
  machine.promptSections = {
    modulePath: join(root, 'plugins/prompt-sections.mjs'),
    promptFile: join(directory, 'extra.md'),
    identityFile: join(directory, 'identity.md'),
  };
  const path = join(directory, 'active-context.yaml');
  writeFileSync(path, JSON.stringify(machine));
  const { rendered } = renderMachine(path, 'active-context', undefined, { stage: false });
  const presets = validatePatch(rendered.home).filter(row => row.entry.name === '@deepseek-ai/dsh-agent-preset');
  assert.equal(presets.length, 3);
  for (const { operation, entry } of presets) {
    assert.equal(operation, 'insert');
    const group = entry.config.plugins.find(row => row.id === 'compaction');
    assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true });
    const basic = group.config.find(row => row.id === 'compaction-basic');
    assert.equal(basic.disabled, true);
    const active = group.config.find(row => row.id === 'active-context');
    assert.equal(active.name, 'dsh-active-context');
    assert.deepEqual(active.config.basic, readYaml(join(root, 'shared/defaults.yaml')).defaults.compaction);
    assert.deepEqual(active.config.acp, { pressureRoutes: [] });
    assert.equal(group.config.filter(row => !row.disabled && ['dsh-active-context', '@deepseek-ai/dsh-compaction-basic'].includes(row.name)).length, 1);
    assert.ok(group.config.some(row => row.id === 'command-compact'));
    assert.ok(group.config.some(row => row.id === 'tool-result-pruner'));
  }
  for (const pressureRoutes of [
    [{ provider: 'example-provider', model: 'example-model', nudgeAtTokens: 60000, resetBelowTokens: 50000 }],
    [{ provider: 'other-provider', model: 'other-model', nudgeAtTokens: 42000, resetBelowTokens: 31000 }],
  ]) {
    machine.acp = { pressureDefault: { nudgeAtRatio: 0.7, resetBelowRatio: 0.65 }, pressureRoutes };
    writeFileSync(path, JSON.stringify(machine));
    const configured = validatePatch(renderMachine(path, 'active-pressure', undefined, { stage: false }).rendered.home)
      .filter(row => row.entry.name === '@deepseek-ai/dsh-agent-preset');
    for (const { entry } of configured) {
      const group = entry.config.plugins.find(row => row.id === 'compaction');
      assert.deepEqual(group.config.find(row => row.id === 'active-context').config, {
        acp: machine.acp, basic: readYaml(join(root, 'shared/defaults.yaml')).defaults.compaction,
      });
      assert.equal(group.config.filter(row => !row.disabled && ['dsh-active-context', '@deepseek-ai/dsh-compaction-basic'].includes(row.name)).length, 1);
    }
  }
  const disabled = readYaml(example);
  const disabledPath = join(directory, 'basic.yaml');
  writeFileSync(disabledPath, JSON.stringify(disabled));
  const basicPresets = validatePatch(renderMachine(disabledPath, 'basic', undefined, { stage: false }).rendered.home)
    .filter(row => row.entry.name === '@deepseek-ai/dsh-agent-preset');
  for (const { entry } of basicPresets) {
    const children = entry.config.plugins.find(row => row.id === 'compaction').config;
    assert.ok(!children.some(row => row.name === 'dsh-active-context'));
    assert.deepEqual(children.find(row => row.id === 'compaction-basic').config, readYaml(join(root, 'shared/defaults.yaml')).defaults.compaction);
  }
});

test('pressure route parameters reject malformed thresholds and duplicate exact routes', () => {
  const machine = readYaml(join(root, 'examples/active-context-machine.yaml'));
  assert.equal(validateMachine(machine), machine);
  for (const resetBelowRatio of [0.7, 0.8]) {
    machine.acp.pressureDefault.resetBelowRatio = resetBelowRatio;
    assert.throws(() => validateMachine(machine), /resetBelowRatio < nudgeAtRatio/);
  }
  const route = { provider: 'example-provider', model: 'example-model', nudgeAtTokens: 60000, resetBelowTokens: 50000 };
  machine.acp = { pressureRoutes: [route] };
  assert.equal(validateMachine(machine), machine);
  for (const invalid of [null, {}, { ...route, provider: '' }, { ...route, nudgeAtTokens: 1.5 },
    { ...route, resetBelowTokens: -1 }, { ...route, resetBelowTokens: 60000 }]) {
    machine.acp.pressureRoutes = [invalid];
    assert.throws(() => validateMachine(machine));
  }
  machine.acp.pressureRoutes = {};
  assert.throws(() => validateMachine(machine), /array/);
  machine.acp.pressureRoutes = [route, { ...route }];
  assert.throws(() => validateMachine(machine), /Duplicate/);
  machine.acp.pressureRoutes = [route];
  machine.features.activeContext = false;
  assert.throws(() => validateMachine(machine), /requires activeContext/);
});

test('active context adds exact catalog targets only to prepared consumer profiles', () => {
  const catalog = { schemaVersion: 2, packages: [
    { package: 'dsh-session-tools', scope: 'profile', policy: 'release', version: '0.2.0', reason: 'Not published' },
    { package: 'dsh-active-context', scope: 'profile', policy: 'release', version: '0.1.0', reason: 'Not published' },
  ] };
  const installation = { webPackage: { private: true }, profiles: {
    prepared: { dependencies: { 'dsh-active-context': '0.1.0' } },
    historyOnly: { dependencies: { 'dsh-session-tools': '0.1.5' } },
    other: { dependencies: { unrelated: '1.0.0' } },
  } };
  const targets = resolveDependencyTargets('unused-snapshot-directory', installation, catalog, { activeContext: true });
  assert.equal(targets.entries.filter(row => row.status === 'blocked-missing-release').length, 3);
  for (const profile of ['web', 'prepared']) {
    assert.ok(targets.entries.some(row => row.profile === profile && row.name === 'dsh-active-context'));
    assert.ok(!('dsh-active-context' in targets.profiles[profile].dependencies));
  }
  assert.ok(!targets.entries.some(row => ['other', 'historyOnly'].includes(row.profile) && row.name === 'dsh-active-context'));
  for (const profile of ['web', 'prepared']) assert.ok(!targets.entries.some(row => row.profile === profile && row.name === 'dsh-session-tools'));
  assert.ok(!installation.webPackage.dependencies);
  const unselected = resolveDependencyTargets('unused-snapshot-directory', installation, catalog);
  assert.ok(!unselected.entries.some(row => row.profile === 'web' && row.name === 'dsh-active-context'));
  assert.ok(unselected.entries.some(row => row.profile === 'prepared' && row.name === 'dsh-active-context'));
});

test('credential-shaped references remain literal through rendering', t => {
  const machine = readYaml(example);
  machine.homePrivate = '- id: literal-test\n  config:\n    value: !!js (() => { throw new Error("render must not evaluate") })()\n';
  const directory = fixture(t);
  const path = join(directory, 'machine.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-literal', undefined, { generatedDir: directory });
  assert.match(rendered.home, /render must not evaluate/);
});

test('declared installation files render beside shared patches and drive source planning', t => {
  const machine = readYaml(example);
  machine.installation = {
    globalWorkspace: { packages: ['.'], overrides: { '@deepseek-ai/dsh-example': '0.1.7-rc.2' } },
    webPackage: { private: true, dependencies: { 'example-plugin': '1.0.0' } },
  };
  const directory = fixture(t);
  const path = join(directory, 'installation-machine.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { output, rendered } = renderMachine(path, 'test-installation', undefined, { generatedDir: directory });
  assert.deepEqual(readdirSync(output).sort(), ['global-workspace.yaml', 'home.patch.yml', 'web.package.json', 'web.patch.yml']);
  assert.equal(readYaml(join(output, 'global-workspace.yaml')).overrides['@deepseek-ai/dsh-example'], '0.1.7-rc.2');
  assert.equal(parseYaml(rendered.globalWorkspace).blockExoticSubdeps, false);
  assert.equal(JSON.parse(readFileSync(join(output, 'web.package.json'), 'utf8')).dependencies['example-plugin'], '1.0.0');
  assert.ok(validatePatch(rendered.home).length > 0);
  const plan = resolveDependencyTargets('unused-snapshot-directory', machine.installation).entries;
  assert.ok(plan.some(row => row.name === 'example-plugin' && row.status === 'unmanaged-registry-pin'));
  assert.ok(plan.some(row => row.name === '@deepseek-ai/dsh-example'));
});

test('release catalog distinguishes selected URLs, explicit registry pins and missing assets', () => {
  const catalog = readYaml(join(root, 'shared/dependencies.yaml'));
  assert.equal(catalog.schemaVersion, 2);
  for (const entry of catalog.packages) {
    assert.match(entry.version, /^\d+\.\d+\.\d+/);
    if (entry.policy === 'release') {
      if (entry.url === undefined) {
        assert.equal(typeof entry.reason, 'string', `Missing pending source reason for ${entry.package}`);
        assert.ok(entry.reason.trim());
      } else {
        assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/);
      }
    }
  }
  assert.ok(!readFileSync(join(root, 'shared/dependencies.yaml'), 'utf8').includes('file:'));
});

test('managed Release overrides select pnpm transitive URL policy without changing machine inputs', () => {
  const installation = { globalWorkspace: { blockExoticSubdeps: true, autoInstallPeers: false } };
  const managed = { packages: [{ package: 'managed-runtime', scope: 'global-override', policy: 'release', version: '1.0.0',
    url: 'https://github.com/example/runtime/releases/download/v1.0.0/runtime-1.0.0.tgz' }] };
  const selected = resolveDependencyTargets('unused-snapshot-directory', installation, managed);
  assert.equal(selected.globalWorkspace.blockExoticSubdeps, false);
  assert.equal(selected.globalWorkspace.autoInstallPeers, false);
  assert.equal(installation.globalWorkspace.blockExoticSubdeps, true);
  const registry = { packages: [{ ...managed.packages[0], policy: 'registry', url: undefined }] };
  assert.equal(resolveDependencyTargets('unused-snapshot-directory', installation, registry).globalWorkspace.blockExoticSubdeps, true);
});

test('source planning does not guess missing Release assets', () => {
  const catalog = { schemaVersion: 2, packages: [
    { package: 'unpublished-plugin', scope: 'profile', policy: 'release', version: '1.0.0', reason: 'Not published' },
    { package: 'published-plugin', scope: 'profile', policy: 'release', version: '1.0.0', url: 'https://github.com/example/plugin/releases/download/v1.0.0/plugin-1.0.0.tgz' },
  ] };
  const targets = resolveDependencyTargets('unused-snapshot-directory', {
    webPackage: { dependencies: { 'unpublished-plugin': 'file:/private/unpublished.tgz', 'published-plugin': 'file:/private/published.tgz' } },
  }, catalog);
  assert.ok(targets.entries.some(row => row.status === 'blocked-missing-release'));
  assert.ok(targets.entries.some(row => row.status === 'verified-release'));
  assert.ok(!JSON.stringify(targets.entries).includes('/private/'));
});

test('check renders current input without requiring or creating staged patches', t => {
  const directory = fixture(t);
  const path = join(directory, 'current-input.yaml');
  const machine = readYaml(example);
  writeFileSync(path, JSON.stringify(machine));
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/dsh-config.mjs'), 'check', path], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const snapshot = join(directory, 'snapshot');
  mkdirSync(snapshot);
  for (const name of ['home', 'web']) writeFileSync(join(snapshot, `${name}.patch.yml`), '- id: obsolete-configuration\n');
  const current = run();
  assert.equal(current.status, 0);
  assert.match(current.stdout, /current configuration checks passed/);
  const generatedDir = join(directory, 'output');
  renderMachine(path, 'current-input', undefined, { stage: false, generatedDir });
  assert.ok(!existsSync(generatedDir));
  machine.features.sessionTools = 'invalid-current-input';
  writeFileSync(path, JSON.stringify(machine));
  assert.equal(run().status, 1);
});
test('UI-owned configuration is never rendered, so live picks survive an apply', t => {
  const { rendered } = renderMachine(example, 'ui-owned', undefined, { generatedDir: fixture(t) });
  const web = validatePatch(rendered.web).map(row => row.entry);
  for (const id of ['agent-default-model', 'ui-settings-general', 'ui-conversation', 'ui-chat']) {
    assert.ok(!web.some(row => row.id === id), 'UI-owned row is rendered: ' + id);
  }
  const registry = web.find(row => row.id === 'agent-preset-registry');
  assert.equal(registry.config.selectedDefault, undefined);
  assert.equal(registry.config.default, 'standard-ptc');
});

test('shared provider catalog and home-owned rows render once', t => {
  const machine = readYaml(example);
  machine.providers = { add: { extra: { api: 'openai-responses', baseURL: 'https://extra.example.invalid/v1', models: [{ id: 'm', name: 'M', contextWindow: 1000, maxTokens: 100 }] } } };
  const directory = fixture(t);
  const path = join(directory, 'providers.yaml');
  writeFileSync(path, JSON.stringify(machine));
  const { rendered } = renderMachine(path, 'providers', undefined, { generatedDir: directory });
  const home = validatePatch(rendered.home).map(row => row.entry);
  const pi = home.find(row => row.id === 'llm-pi-ai');
  assert.deepEqual(Object.keys(pi.config.providers).sort(), ['extra', 'klaude-cl', 'klaude-openai']);
  assert.equal(pi.config.providers['klaude-openai'].compat.maxConsecutiveWhitespaceChars, 5000);
  assert.equal(pi.config.providers['klaude-openai'].compat.maxRepeatedPatternChars, 5000);
  assert.equal(pi.config.providers['klaude-cl'].compat.maxConsecutiveWhitespaceChars, undefined);
  assert.equal(pi.config.providers['klaude-cl'].compat.maxRepeatedPatternChars, undefined);
  const deepseek = home.find(row => row.id === 'llm-deepseek');
  assert.deepEqual(deepseek.config.models, [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }]);
  assert.equal(deepseek.config.models[0].imagePixelBudget, undefined);
  assert.equal(deepseek.config.models[0].imageMaxBytes, undefined);
  assert.ok(!validatePatch(rendered.web).some(row => row.id === 'llm-pi-ai' || row.id === 'llm-deepseek'));
});

test('klaude-cl retries gateway tool protocol errors without changing other providers', () => {
  const { rendered } = renderMachine(example, 'tool-protocol-retry', undefined, { stage: false });
  const providers = validatePatch(rendered.home).find(row => row.entry.id === 'llm-pi-ai').entry.config.providers;
  const classify = (provider, message) => providers[provider].errorCodeRules
    .find(rule => new RegExp(rule.match).test(message))?.code;
  assert.equal(classify('klaude-cl', 'tool_protocol_error: Model called an unavailable tool: grep.'), 'SERVER');
  assert.equal(classify('klaude-cl', 'tool_protocol_error: Model called an unavailable tool: bash.'), 'SERVER');
  assert.equal(classify('klaude-cl', 'upstream_error: overloaded'), 'SERVER');
  assert.equal(classify('klaude-cl', 'tool_protocol_error: Model attempted a blocked native tool.'), undefined);
  assert.equal(classify('klaude-cl', 'invalid_request_error: invalid tool schema'), undefined);
  assert.equal(classify('klaude-cl', 'Some other error mentioning tool_protocol_error:'), undefined);
  assert.equal(classify('klaude-openai', 'tool_protocol_error: Model called an unavailable tool: grep.'), undefined);
});

test('retire removes a rendered row and ignores ids the template does not render', t => {
  const machine = readYaml(example);
  const directory = fixture(t);
  const path = join(directory, 'retire.yaml');
  machine.rowOps = { web: { retire: ['agent-preset-registry', 'already-gone'] } };
  writeFileSync(path, JSON.stringify(machine));
  const { rendered } = renderMachine(path, 'retire', undefined, { generatedDir: directory });
  assert.ok(!validatePatch(rendered.web).some(row => row.entry.id === 'agent-preset-registry'));
  assert.throws(() => validateMachine({ ...machine, rowOps: { web: { remove: ['x'] } } }));
});

test('apply keeps rows the template does not produce and drops retired ids', () => {
  const rendered = ['- id: a', '  config:', '    x: 1', ''].join('\n');
  const live = ['- id: a', '  config:', '    x: 1', '- id: picked', '  config:', '    source: ui', '- id: stale', '  disabled: true', ''].join('\n');
  const first = preserveLiveRows(rendered, live, ['stale']);
  assert.deepEqual(first.preserved, ['picked']);
  assert.deepEqual(first.retired, ['stale']);
  assert.deepEqual(validatePatch(first.text).map(row => row.entry.id), ['a', 'picked']);
  // A second pass is stable: the preserved row is already a live row the template does not render.
  assert.equal(preserveLiveRows(rendered, first.text, ['stale']).text, first.text);
  // Without a live file nothing is invented.
  assert.equal(preserveLiveRows(rendered, undefined, []).text, rendered);
});

test('preserved rows keep their expressions verbatim', () => {
  const result = preserveLiveRows('- id: a\n', '- id: kept\n  config:\n    path: !!js dshHomePath("x")\n', []);
  assert.match(result.text, /!!js dshHomePath\("x"\)/);
  assert.deepEqual(result.preserved, ['kept']);
});
