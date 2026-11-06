import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDependencyTargets } from '../scripts/lib.mjs';

const name = 'dsh-claude-image-recovery';

test('a required patch-only profile package installs in every consumer profile and blocks unpublished assets', () => {
  const item = { package: name, scope: 'profile', policy: 'release', version: '0.1.0', required: true, patchOnly: true };
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
