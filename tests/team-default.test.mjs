import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { renderMachine, root, validatePatch } from '../scripts/lib.mjs';

test('the first request in a fresh root session includes Team task-board tools', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const require = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const url = path => pathToFileURL(path).href;
  const resolve = name => url(require.resolve(`@deepseek-ai/dsh-${name}`));
  const { Context, Service } = await import(url(require.resolve('@deepseek-ai/cordis')));
  const { default: Loader } = await import(url(require.resolve('@deepseek-ai/cordis-plugin-loader')));
  const { default: Include } = await import(url(require.resolve('@deepseek-ai/cordis-plugin-include')));
  const { LlmAdapter, createUserMessage } = await import(resolve('llm'));
  const folder = mkdtempSync(join(tmpdir(), 'team-default-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  class DirectoryFixture extends Service {
    constructor(ctx) { super(ctx, 'workingDirectory'); }
  }
  const { rendered } = renderMachine(join(root, 'examples/workstation-machine.yaml'), 'team-default', undefined, { stage: false });
  const team = validatePatch(rendered.home).find(({ entry }) => entry.id === 'agent-team')?.entry;
  const config = {
    'agent-loop': { agents: [] },
    'session-persistence-jsonl': { root: join(folder, 'sessions') },
    'agent-team': team?.config,
  };
  const plugins = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'tool-executor-native',
    'agent', 'agent-loop', 'session-persistence-jsonl', 'subagent', 'agent-team', 'tool-agent-team'];
  const yaml = join(folder, 'cordis.yml');
  writeFileSync(yaml, JSON.stringify(plugins.map(id => ({ id, name: resolve(id), config: config[id] }))));
  await ctx.plugin(DirectoryFixture);
  await ctx.plugin(Loader);
  await ctx.plugin(Include, { path: url(yaml) });
  await ctx.loader.await();

  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      requests.push(request);
      yield { type: 'text-delta', index: 0, text: 'Done.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fake'], new Adapter());
  const agent = await ctx.agentLoop.create(randomUUID(), { provider: 'fake', model: 'fixture' });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Go.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools?.map(tool => tool.name).filter(name => name.startsWith('team_task_')).sort(), [
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  ]);
});
