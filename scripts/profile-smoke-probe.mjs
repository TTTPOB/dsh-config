// This local Loader plugin is mounted only by the disposable profile smoke.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { verifyPromptRendering, verifyToolCatalog } from './profile-smoke-checks.mjs';

export const name = 'dsh-config-profile-smoke';
export const inject = ['loader', 'webServer', 'agents', 'agentPresets', 'agentDefaultModel', 'tools', 'systemPrompt', 'ptcRuntime', 'pluginPackages'];

export function apply(ctx, config) {
  let result;
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__dsh-config-smoke', handler: async (_request, response) => {
    result ??= inspect(ctx, config);
    try {
      const value = await result;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  } }));
}

export async function probeInvalidCompression(ctx, agent, { createAssistantMessage, createToolResultMessage }) {
  const session = agent.session;
  const callId = `smoke-acp-${randomUUID()}`;
  const args = { code: 'return await tools.context_compress({"regions":[]});', description: 'Verify ACP invalid input before compression' };
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: JSON.stringify(args) }],
    source: { provider: 'profile-smoke', model: 'scripted-no-request' },
  }) }, { surfaceOp: 'append' });
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'run_code', arguments: JSON.stringify(args) });
  const surface = [...session.surface.nodes];
  const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary').length;
  try {
    const result = await ctx.tools.execute({ callId, name: 'run_code', arguments: args, agent, signal: AbortSignal.timeout(30000) });
    assert.equal(result.isError, true, 'Empty ACP regions unexpectedly succeeded');
    assert.match(JSON.stringify(result), /ACP: submit 1-\d+ non-overlapping regions/,
      'Canonical per-call program did not reach ACP input validation');
    assert.deepEqual([...session.surface.nodes], surface, 'Invalid ACP call changed the existing Surface');
    assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, summaries);
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: result.content, isError: result.isError }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
    return { rejectedBeforeCompression: true, surfaceUnchanged: true, runtime: 'typescript/function-body/per-call' };
  } finally {
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  }
}

async function probeSuccessfulCompression(ctx, agent, { createAssistantMessage, createToolResultMessage, createUserMessage }) {
  const session = agent.session;
  const callId = 'smoke-acp-success-' + randomUUID();
  const anchor = 'Completed smoke history ' + randomUUID();
  const summary = 'Smoke summary ' + randomUUID() + ': completed work preserved.';
  const input = { regions: [{ range: [{ text: anchor, role: 'assistant' }, { text: anchor, role: 'assistant' }], summary }] };
  const args = { code: 'return await tools.context_compress(' + JSON.stringify(input) + ');', description: 'Compress completed smoke history' };
  const source = { provider: 'profile-smoke', model: 'scripted-no-request' };
  session.append('turn/start', { turn: 2 });
  session.append('step/start', { turn: 2, step: 1 });
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'text', text: anchor + '. Completed evidence and details. '.repeat(200) }], source,
  }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 2, step: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Preserve this current smoke task.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 2, step: 2 });
  const assistant = session.append('assistant/message', { turn: 2, step: 2, stream: [], message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: JSON.stringify(args) }], source,
  }) }, { surfaceOp: 'append' });
  const call = session.append('tool/call', { turn: 2, step: 2, callId, name: 'run_code', arguments: JSON.stringify(args) });
  try {
    const signal = AbortSignal.timeout(30000);
    const result = await ctx.tools.execute({ callId, name: 'run_code', arguments: args, agent, signal });
    assert.equal(result.isError, false, 'Canonical per-call compression failed: ' + JSON.stringify(result));
    const resultEvent = session.append('tool/result', { turn: 2, step: 2, message: createToolResultMessage({ callId,
      content: result.content, isError: result.isError }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
    const summaries = () => session.snapshotEvents().filter(event => event.type === 'compaction/summary');
    assert.equal(summaries().length, 1, 'Compression did not commit exactly one summary');
    assert.ok(JSON.stringify(summaries()[0]).includes(summary), 'Committed summary is missing');
    session.append('step/end', { turn: 2, step: 2 });
    // Run the mounted production pre-step chain without asking a model for another reply.
    await agent.ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 2, step: 3, signal },
      async () => ({ kind: 'enter', messages: [] }));
    session.append('step/start', { turn: 2, step: 3 });
    const maintenance = session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'acp-maintenance' && event.sourceEventSeqs?.includes(call.seq));
    assert.ok(maintenance && session.surface.nodes.includes(maintenance.seq), 'Successful root pair was not archived at the next step');
    assert.ok(!session.surface.nodes.includes(assistant.seq) && !session.surface.nodes.includes(resultEvent.seq), 'Root run_code call/result remains on the Surface');
    const messages = session.surface.nodes.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean);
    assert.equal(JSON.stringify(messages).split(summary).length - 1, 1, 'Summary appears more than once on the Surface');
    assert.equal(summaries().length, 1, 'Maintenance committed an extra summary');
    session.append('step/end', { turn: 2, step: 3 });
    return { summaryCommitted: true, rootPairArchivedNextStep: true, summaryOccurrences: 1,
      runtime: 'typescript/function-body/per-call' };
  } finally {
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  }
}

export async function createProbeAgent(ctx, id, cwd) {
  // Agent metadata records the choice; the caller's setup composes its plugins. Like a Web
  // session, the Agent starts on the default model so {{provider}}/{{model}} render.
  const { provider, model } = ctx.agentDefaultModel.currentSelection();
  return ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider, model }, meta: { cwd, agentPreset: id },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, id).then(() => undefined) });
}

async function inspect(ctx, config) {
  await ctx.loader.await();
  const hostRequire = createRequire(process.env.DSH_SMOKE_HOST_MANIFEST);
  const load = name => import(pathToFileURL(hostRequire.resolve(name)).href);
  const [{ auditStartupEntries }, { assembleContextFor }, { scopeOf }, { renderPrompt, renderContextSnapshot }] = await Promise.all([
    load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-system-prompt'),
  ]);
  await auditStartupEntries(ctx.root, 'dsh-config profile smoke', () => {});
  for (const service of ['workspaceCordis', 'workspaceEnvrc', 'agentTeams']) {
    if (!ctx.get(service)) throw new Error(`Missing profile service: ${service}`);
  }
  const packages = config.expectedPackages.map(expected => {
    const anchor = expected.profileOwned ? join(process.env.DSH_HOME, 'profiles/web/package.json') : process.env.DSH_SMOKE_HOST_MANIFEST;
    const selected = ctx.pluginPackages.packageOf(expected.name, pathToFileURL(anchor).href);
    assert.equal(selected?.version, expected.version, `${expected.name}: resolver selected an unexpected package version`);
    return { name: expected.name, scope: expected.scope, version: selected.version };
  });
  const roster = await ctx.agentPresets.list();
  const results = [];
  const handles = [];
  try {
    // Keep all presets alive together to catch cross-preset Team-tool leakage.
    for (const id of config.presets) {
      const declaration = roster.find(row => row.id === id);
      if (!declaration || declaration.broken) throw new Error(`${id}: ${declaration?.broken ?? 'missing preset'}`);
      handles.push(await createProbeAgent(ctx, id, process.env.DSH_CONFIG_TEST_ROOT));
    }
    for (const { agent } of handles) {
      const id = agent.session.header.agentPreset;
      const runtime = agent.ctx.get('ptcRuntime');
      if (runtime?.language !== 'typescript' || runtime.programFormat !== 'function-body') {
        throw new Error(`${id}: expected TypeScript function-body PTC runtime`);
      }
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent));
      const schemas = ctx.tools.schemas(scopeOf(agent.ctx));
      for (const name of ['session_list', 'session_event_list', 'session_event_read', 'search_tools', 'describe_tools']) {
        if (!schemas.some(tool => tool.name === name)) throw new Error(`${id}: missing profile plugin tool ${name}`);
      }
      // Mirror the Agent step: render the static prompt, then refresh and render runtime context.
      const prompt = verifyPromptRendering(id, () => ({ prompt: renderPrompt(assembly),
        context: renderContextSnapshot(ctx.systemPrompt.refreshContext(assembly, assembleContextFor(agent))) }));
      results.push({ ...verifyToolCatalog(id, schemas, assembly, { acp: config.acp }), prompt });
      const code = 'return { agents: await tools.list_agents({}) };';
      const execution = await ctx.tools.execute({ callId: `smoke-${randomUUID()}`, name: 'run_code',
        arguments: { code, description: 'Verify scoped profile tool SDK' }, agent, signal: AbortSignal.timeout(30000) });
      if (execution.isError) throw new Error(`${id}: run_code failed: ${JSON.stringify(execution.content)}`);
    }
    const messages = config.acp ? await load('@deepseek-ai/dsh-llm') : undefined;
    const acpInvalidCall = config.acp ? await probeInvalidCompression(ctx, handles[0].agent, messages) : undefined;
    const acpSuccessfulCall = config.acp ? await probeSuccessfulCompression(ctx, handles[0].agent, messages) : undefined;
    return { presets: results, packages, loaded: true, modelRequests: 0, privateMachine: config.privateMachine ?? null,
      acpInvalidCall, acpSuccessfulCall };
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
  }
}
