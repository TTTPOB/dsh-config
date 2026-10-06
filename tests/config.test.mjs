import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, parseYaml, readYaml, validateMachine, validatePatch, canonicalPatch, renderMachine, compareSnapshot, buildSourcePlan } from '../scripts/lib.mjs';

const example = join(root, 'examples/local-machine.yaml');

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

test('rejects accidental template syntax in literal machine rows', () => {
  const machine = readYaml(example);
  machine.homePrivate = '- id: x\n  config:\n    value: "[[ secret ]]"\n';
  assert.throws(() => validateMachine(machine));
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

for (const role of ['local', 'server']) {
  test(`chezmoi renders sanitized ${role} example and keeps DSH placeholders`, () => {
    const { rendered } = renderMachine(join(root, `examples/${role}-machine.yaml`), `test-example-${role}`);
    assert.ok(rendered.home.includes('{{cwd}}'));
    assert.ok(rendered.home.includes('{{model}}'));
    assert.ok(rendered.home.includes('!!js'));
    assert.ok(!rendered.home.includes('chezmoi:template:'));
    assert.ok(!rendered.web.includes('[['));
    const model = validatePatch(rendered.web).find(row => row.entry.id === 'agent-default-model').entry.config.model;
    assert.equal(model, role === 'local' ? 'gpt-6.1-sol' : 'gpt-6-astra');
  });
  const machinePath = join(root, `local/${role}/machine.yaml`);
  test(`private ${role} baseline preserves all captured row contents`, { skip: !existsSync(machinePath) }, () => {
    const { rendered } = renderMachine(machinePath, `test-${role}`);
    compareSnapshot(rendered, join(root, `local/${role}/snapshot`));
  });
}

test('enabled prompt preset renders file paths without a package dependency', () => {
  const machine = readYaml(example);
  machine.features.promptOverlay = true;
  assert.throws(() => validateMachine(machine));
  machine.promptSections = {
    modulePath: join(root, 'plugins/prompt-sections.mjs'),
    promptFile: join(root, 'generated/example-prompts/extra.md'),
    identityFile: join(root, 'generated/example-prompts/identity.md'),
  };
  const path = join(root, 'generated/test-input/prompt-machine.yaml');
  mkdirSync(join(root, 'generated/test-input'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-prompt-preset');
  const preset = validatePatch(rendered.home).find(row => row.entry.id === 'preset-standard-ptc-redteam').entry;
  const overlay = preset.config.plugins.find(row => row.id === 'prompt-overlay');
  assert.equal(overlay.name, machine.promptSections.modulePath);
  assert.equal(overlay.config.promptFile, machine.promptSections.promptFile);
  assert.equal(overlay.config.identityFile, machine.promptSections.identityFile);
  assert.ok(!rendered.home.includes("name: 'dsh-prompt-overlay'"));
});

test('credential-shaped references remain literal through rendering', () => {
  const machine = readYaml(example);
  machine.homePrivate = '- id: literal-test\n  config:\n    value: !!js (() => { throw new Error("render must not evaluate") })()\n';
  const path = join(root, 'generated/test-input/machine.yaml');
  mkdirSync(join(root, 'generated/test-input'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(machine), { mode: 0o600 });
  const { rendered } = renderMachine(path, 'test-literal');
  assert.match(rendered.home, /render must not evaluate/);
});

test('release catalog contains exact asset URLs and no local references', () => {
  const release = readYaml(join(root, 'config/releases.yaml'));
  for (const entry of release.packages) {
    assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/);
    assert.equal(new URL(entry.url).pathname.split('/').pop(), entry.asset);
    assert.match(entry.version, /^\d+\.\d+\.\d+/);
    assert.equal(entry.asset, `${entry.package.replace(/^@/, '').replace('/', '-')}-${entry.version}.tgz`);
  }
  assert.ok(!readFileSync(join(root, 'config/releases.yaml'), 'utf8').includes('file:'));
});

test('source planning does not guess missing Release assets', { skip: !existsSync(join(root, 'local/local/snapshot/web.package.json')) }, () => {
  const plan = buildSourcePlan(join(root, 'local/local/snapshot'));
  assert.ok(plan.some(row => row.status === 'blocked-needs-exact-release'));
  assert.ok(plan.some(row => row.status === 'verified-release'));
  assert.ok(!JSON.stringify(plan).includes('/home/'));
});
