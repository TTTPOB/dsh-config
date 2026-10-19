import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPresetRowOverrides, validatePresetRows } from '../scripts/preset-rows.mjs';
import { root, readYaml, parseYaml, renderMachine, validatePatch, validateMachine } from '../scripts/lib.mjs';

const patch = `- insert:
    - id: preset-test
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: test
        plugins:
          - id: tool-web
            name: web
            config: { fetch: true }
          - id: first
            name: cordis:group
            group: true
            config:
              - id: nested
                name: cordis:group
                config:
                  - id: repeated
                    name: tool
                    disabled: !!js (() => { throw new Error('must not evaluate') })()
          - id: second
            group: true
            config:
              - id: repeated
                name: tool
`;
const plugins = text => parseYaml(text)[0].insert[0].config.plugins;

test('omitted and empty preset row overrides preserve text exactly', () => {
  for (const overrides of [undefined, {}, { all: {} }, { presets: {} }]) {
    assert.equal(applyPresetRowOverrides(patch, overrides), patch);
  }
});

test('unique ids, nested paths and groups support disabled true and false without merging config', () => {
  const result = applyPresetRowOverrides(patch, {
    all: { 'tool-web': { disabled: true }, 'first/nested/repeated': { disabled: true }, second: { disabled: true } },
    presets: { test: { 'first/nested/repeated': { disabled: false } } },
  });
  const rows = plugins(result);
  assert.equal(rows[0].disabled, true);
  assert.deepEqual(rows[0].config, { fetch: true });
  assert.equal(rows[1].config[0].config[0].disabled, false);
  assert.equal(rows[2].disabled, true);
  assert.equal(rows[2].config[0].disabled, undefined);
});

test('preset specificity wins by resolved row and untouched expressions stay literal', () => {
  const result = applyPresetRowOverrides(patch, {
    all: { 'first/nested': { disabled: true } }, presets: { test: { nested: { disabled: false } } },
  });
  assert.equal(plugins(result)[1].config[0].disabled, false);
  assert.match(result, /!!js/);
  assert.deepEqual(plugins(result)[1].config[0].config[0].disabled, plugins(patch)[1].config[0].config[0].disabled);
});

test('rejects unknown presets, unmatched or ambiguous ids and conflicting selectors', () => {
  for (const [overrides, error] of [
    [{ presets: { missing: {} } }, /unknown preset/],
    [{ all: { missing: { disabled: true } } }, /unmatched/],
    [{ all: { repeated: { disabled: true } } }, /ambiguous/],
    [{ all: { 'second/nested/repeated': { disabled: true } } }, /unmatched/],
    [{ all: { nested: { disabled: true }, 'first/nested': { disabled: false } } }, /multiple selectors/],
  ]) assert.throws(() => applyPresetRowOverrides(patch, overrides), error);
});

test('rejects wrong shapes, non-boolean disabled and unsupported fields', () => {
  for (const overrides of [null, [], true, { extra: {} }, { all: null }, { all: [] }, { presets: [] },
    { presets: { test: null } }, { all: { '': { disabled: true } } },
    { all: { 'first//nested': { disabled: true } } },
    ...[null, [], true, {}, { disabled: 'true' }, { disabled: 1 }, { disabled: { __jsExpr: 'true' } },
      { disabled: true, config: {} }].map(value => ({ all: { 'tool-web': value } })),
  ]) assert.throws(() => validatePresetRows(overrides), /presetRows/);
  const machine = readYaml(join(root, 'examples/workstation-machine.yaml'));
  machine.overrides.presetRows = { all: { 'tool-web': { disabled: 'true' } } };
  assert.throws(() => validateMachine(machine), /disabled: boolean/);
});

test('NAS overrides render daily, Team and reverse presets through the common template', t => {
  const directory = mkdtempSync(join(tmpdir(), 'preset-rows-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const machine = readYaml(join(root, 'examples/workstation-machine.yaml'));
  machine.features.promptOverlay = true;
  machine.promptSections = { modulePath: join(root, 'plugins/prompt-sections.mjs'),
    promptFile: join(directory, 'unread-prompt.md'), identityFile: join(directory, 'unread-identity.md') };
  machine.overrides.presetRows = {
    all: { 'tool-web': { disabled: true }, 'delegation/tool-ralph': { disabled: true } },
    presets: { 'standard-ptc-team': { 'tool-web': { disabled: false }, 'delegation/tool-agent-team': { disabled: true } } },
  };
  machine.homePrivate += '- id: literal-canary\n  config:\n    token: !!js (() => { throw new Error("never execute") })()\n';
  const path = join(directory, 'machine.yaml');
  writeFileSync(path, JSON.stringify(machine));
  const { rendered } = renderMachine(path, 'nas', undefined, { stage: false });
  const rows = validatePatch(rendered.home).map(row => row.entry);
  const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset');
  assert.equal(presets.length, 3);
  for (const { config } of presets) {
    assert.equal(config.plugins.find(row => row.id === 'tool-web').disabled, config.id !== 'standard-ptc-team');
    assert.deepEqual(config.plugins.find(row => row.id === 'tool-web').config, { fetch: true, searchTimeoutMs: 60000 });
    assert.deepEqual(config.plugins.find(row => row.id === 'tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" });
    const delegation = config.plugins.find(row => row.id === 'delegation');
    assert.equal(delegation.config.find(row => row.id === 'tool-ralph').disabled, true);
    if (config.id === 'standard-ptc-team') assert.equal(delegation.config.find(row => row.id === 'tool-agent-team').disabled, true);
  }
  assert.match(rendered.home, /!!js/);
  assert.match(rows.find(row => row.id === 'literal-canary').config.token.__jsExpr, /never execute/);
  assert.match(rendered.home, /{{model}}/);
});
