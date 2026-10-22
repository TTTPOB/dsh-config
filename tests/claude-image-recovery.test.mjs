import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root, readDependencyCatalog, renderMachine, validatePatch, resolveDependencyTargets } from '../scripts/lib.mjs';

const name = 'dsh-claude-image-recovery';

for (const example of ['workstation', 'server', 'active-context', 'claude-image-recovery']) {
  test(example + ' mounts recovery once in shared home with an explicit route', () => {
    const { rendered } = renderMachine(join(root, 'examples/' + example + '-machine.yaml'), 'recovery', undefined, { stage: false });
    const home = validatePatch(rendered.home).map(row => row.entry);
    const recovery = home.filter(row => row.name === name);
    assert.equal(recovery.length, 1);
    assert.deepEqual(recovery[0].config, { providers: ['klaude-cl'] });
    assert.ok(!rendered.web.includes(name));
    for (const row of home.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')) {
      assert.ok(!JSON.stringify(row).includes(name));
    }
    // Native image-offload is already supplied by the base bundle.
    assert.ok(!rendered.home.includes('@deepseek-ai/dsh-compaction-image-offload'));
  });
}

test('recovery is required in consumer profiles, patch-only, and blocks unpublished assets', () => {
  const item = readDependencyCatalog().packages.find(item => item.package === name);
  assert.equal(item.version, '0.1.0');
  assert.equal(item.scope, 'profile');
  assert.equal(item.required, true);
  assert.equal(item.patchOnly, true);
  const installation = { webPackage: { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', name] } } }, profiles: { headless: {} } };
  const pending = { ...item, url: undefined, reason: 'Pending test asset' };
  const blocked = resolveDependencyTargets('unused', installation, { packages: [pending] });
  assert.equal(blocked.entries.filter(row => row.status === 'blocked-missing-release').length, 2);
  assert.ok(!blocked.profiles.web.dependencies[name]);
  assert.deepEqual(blocked.profiles.web.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
  assert.ok(!blocked.globalWorkspace.overrides[name]);
  const url = 'https://github.com/example/recovery/releases/download/v0.1.0/recovery.tgz';
  const ready = resolveDependencyTargets('unused', installation, { packages: [{ ...item, url }] });
  for (const profile of ['web', 'headless']) assert.equal(ready.profiles[profile].dependencies[name], url);
  assert.ok(installation.webPackage.dsh.profile.bundles.includes(name));
});
