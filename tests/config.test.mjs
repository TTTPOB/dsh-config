import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, parseYaml, readYaml, validateMachine, validatePatch, canonicalPatch, renderMachine, resolveDependencyTargets, parseCommandArguments, resolveMachineArgument } from '../scripts/lib.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-config-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const example = join(root, 'examples/workstation-machine.yaml');

test('machine selector resolves private directories and preserves file path input', () => {
  for (const machine of ['workstation', 'server', 'research-box_2']) {
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
  machine.overrides.defaultModel = { provider: literal, model: literal, reasoningEffort: literal };
  assert.equal(validateMachine(machine), machine);
  const directory = fixture(t);
  const path = join(directory, 'literal-delimiters.yaml');
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-literal-delimiters', undefined, { generatedDir: directory });
  assert.equal(validatePatch(rendered.home).find(row => row.entry.id === 'x').entry.config.value, literal);
  assert.deepEqual(validatePatch(rendered.web).find(row => row.entry.id === 'agent-default-model').entry.config, machine.overrides.defaultModel);
});

test('rejects duplicate ids and expressions in metadata', () => {
  assert.throws(() => validatePatch('- id: x\n- insert:\n    - id: x\n'));
  assert.throws(() => validatePatch('- id: x\n  name: !!js "computed"\n'));
});

test('canonicalization preserves expressions and nested plugin order', () => {
  const a = '- insert:\n    - id: b\n      disabled: !!js process.platform === "win32"\n- id: a\n  config:\n    value: [1, 2]\n';
  const b = '- id: a\n  config:\n    value: [1, 2]\n- insert:\n    - id: b\n      disabled: !!js process.platform === "win32"\n';
  assert.deepEqual(canonicalPatch(a), canonicalPatch(b));
  assert.notDeepEqual(canonicalPatch(a), canonicalPatch(b.replace('[1, 2]', '[2, 1]')));
});

for (const role of ['workstation', 'server']) {
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
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'web.package.json'), 'utf8')), machine.installation.webPackage);
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
    if (entry.policy === 'release' && entry.url) assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/);
    else if (entry.policy === 'release') assert.equal(typeof entry.reason, 'string');
  }
  assert.ok(!readFileSync(join(root, 'shared/dependencies.yaml'), 'utf8').includes('file:'));
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
  const generatedDir = join(directory, 'output');
  renderMachine(path, 'current-input', undefined, { stage: false, generatedDir });
  assert.ok(!existsSync(generatedDir));
  machine.features.sessionTools = 'invalid-current-input';
  writeFileSync(path, JSON.stringify(machine));
  assert.equal(run().status, 1);
});
