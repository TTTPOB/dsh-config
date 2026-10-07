import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeployment, expandDeploymentPath } from '../scripts/deployment-paths.mjs';

const discovery = (env = {}) => ({ env, userHome: '/users/example', query: args => {
  if (args[0] === 'root') return '/pnpm/global/v11';
  if (args[0] === 'bin') return '/pnpm/bin';
  if (args[0] === 'config') return 'undefined';
  return JSON.stringify([{ dependencies: { '@deepseek-ai/dsh': { path: '/pnpm/current/dsh' } } }]);
} });

test('omitted deployment discovers public pnpm paths and defaults only web', () => {
  const result = normalizeDeployment(undefined, discovery());
  assert.equal(result.home, '/users/example/.dsh');
  assert.equal(result.globalWorkspacePath, '/pnpm/global/v11/pnpm-workspace.yaml');
  assert.equal(result.globalDir, '/pnpm/global');
  assert.equal(result.globalBinDir, '/pnpm/bin');
  assert.equal(result.hostManifest, '/pnpm/current/dsh/package.json');
  assert.deepEqual(Object.keys(result.profiles), ['web']);
  assert.equal(result.profiles.web.patchPath, '/users/example/.dsh/profiles/web/cordis.patch.yml');
  assert.equal(normalizeDeployment({}, discovery({ DSH_HOME: '/custom/home' })).home, '/custom/home');
});

test('explicit paths expand defined variables and additional profiles without discovery', () => {
  const result = normalizeDeployment({ home: '${HOME}/chosen', globalWorkspacePath: '~/global/v11/pnpm-workspace.yaml',
    globalBinDir: '$BIN', hostManifest: '$DSH_HOME/host/package.json', homePatchPath: '~/patch.yml',
    profiles: { web: { packagePath: '$HOME/web/package.json' }, headless: {} } }, {
    env: { HOME: '/users/example', DSH_HOME: '/anchor', BIN: '/bin/custom' }, userHome: '/users/example',
    query: () => assert.fail('explicit overrides must not query pnpm'),
  });
  assert.equal(result.home, '/users/example/chosen');
  assert.equal(result.globalDir, '/users/example/global');
  assert.equal(result.hostManifest, '/anchor/host/package.json');
  assert.equal(result.profiles.headless.packagePath, '/users/example/chosen/profiles/headless/package.json');
  assert.equal(result.profiles.web.packagePath, '/users/example/web/package.json');
  assert.equal(result.profiles.web.patchPath, '/users/example/web/cordis.patch.yml');
  assert.equal(result.homePatchPath, '/users/example/patch.yml');
});

test('public global-dir configuration takes precedence over root inference', () => {
  const options = discovery();
  const original = options.query;
  options.query = args => args[0] === 'config' ? '/configured/global' : original(args);
  assert.equal(normalizeDeployment({}, options).globalDir, '/configured/global');
});

test('undefined variables identify the deployment field without printing environment values', () => {
  assert.throws(() => expandDeploymentPath('${ABSENT}/x', 'home', {}), /Undefined environment variable ABSENT in deployment.home/);
  assert.throws(() => expandDeploymentPath('$ABSENT/x', 'profiles.web.packagePath', {}), /ABSENT in deployment.profiles.web.packagePath/);
  assert.throws(() => expandDeploymentPath('relative/path', 'home', {}), /absolute path/);
  assert.equal(expandDeploymentPath('$VALUE/x', 'home', { VALUE: '/literal/$OTHER' }), '/literal/$OTHER/x');
});

test('missing global DSH discovery gives actionable context', () => {
  const options = discovery();
  const original = options.query;
  options.query = args => args.includes('list') ? '[]' : original(args);
  assert.throws(() => normalizeDeployment({}, options), /install DSH or override deployment.hostManifest/);
});
