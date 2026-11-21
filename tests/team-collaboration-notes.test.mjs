import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renderMachine, root, validatePatch } from '../scripts/lib.mjs';
import { apply } from '../plugins/team-collaboration-notes.mjs';

function mount(getService) {
  let section;
  apply({ get: getService, systemPrompt: { getSectionOrder: () => 10, section: value => { section = value; } } });
  return agent => section.text({ agent });
}

test('Team collaboration notes follow the caller tree’s live mode', () => {
  const rootAgent = {}, child = {}, other = {};
  let enabled = false;
  const text = mount(() => ({ isEnabled: agent => (agent === child || agent === rootAgent) && enabled }));
  assert.equal(text(child), '');
  enabled = true;
  assert.equal(text(other), '');
  assert.equal(text(), '');
  assert.equal(text(child), text(rootAgent));
  assert.match(text(child), /not notified/);
  assert.match(text(child), /send_message\b(?!\s*\()/);
  enabled = false;
  assert.equal(text(child), '');
});

test('optional Team service or an independently resumed child leaves the prompt unchanged', () => {
  assert.equal(mount(() => undefined)({}), '');
  const error = new Error('root unavailable');
  error.name = 'SubagentError';
  error.code = 'UNAUTHORIZED';
  const text = mount(() => ({ isEnabled: () => { throw error; } }));
  assert.equal(text({}), '');
  error.code = 'OTHER';
  assert.throws(() => text({}), error);
});

test('the configured local collaboration plugin is staged and referenced by the home patch', () => {
  const { localPlugins, rendered } = renderMachine(join(root, 'examples/workstation-machine.yaml'), 'team-notes', undefined, { stage: false });
  const file = localPlugins.find(item => item.row.id === 'team-collaboration-notes');
  const row = validatePatch(rendered.home).map(item => item.entry).find(item => item.id === file.row.id);
  assert.equal(row.name, file.path);
});
