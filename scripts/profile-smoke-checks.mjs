import assert from 'node:assert/strict';

export function verifyToolCatalog(id, schemas, assembly, { acp = true } = {}) {
  const names = schemas.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, `${id}: duplicate tool names`);
  const team = id === 'standard-ptc-team';
  const required = team
    ? ['spawn_teammate', 'list_agent_models', 'send_message', 'list_agents', 'interrupt_agent', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
    : ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent'];
  for (const name of [...required, 'run_code', 'workflow', 'ralph']) assert.ok(names.includes(name), `${id}: missing ${name}`);
  for (const name of team ? ['subagent', 'subagent_fork'] : ['spawn_teammate', 'wait_agent', 'team_task_create']) {
    assert.ok(!names.includes(name), `${id}: unexpected ${name}`);
  }
  if (team) {
    const spawn = schemas.find(tool => tool.name === 'spawn_teammate');
    for (const field of ['provider', 'model', 'reasoning_effort']) {
      assert.ok(spawn.parameters.properties[field], `${id}: missing spawn model field ${field}`);
    }
  }
  const send = schemas.find(tool => tool.name === 'send_message');
  assert.ok(send.parameters.properties[team ? 'target' : 'agent_id'], `${id}: wrong send_message implementation`);
  assert.ok(!send.parameters.properties[team ? 'agent_id' : 'target'], `${id}: mixed send_message implementations`);
  assert.ok(assembly.tools.some(tool => tool.name === 'run_code'), `${id}: PTC transport is not model-visible`);
  if (acp) {
    assert.ok(names.includes('context_compress'), `${id}: ACP is not registered`);
    const sdk = assembly.sections.filter(section => section.name === 'tools:sdk').map(section => section.text).join('\n');
    assert.match(sdk, /context_compress/, `${id}: ACP is missing from the PTC SDK`);
  }
  assert.ok(!names.includes('present'), `${id}: present is disabled for every preset`);
  return { id, tools: names.sort(), ptc: true, acp };
}

// Model requests render the prompt only after assembly; unknown {{variables}} fail there.
export function verifyPromptRendering(id, render) {
  let rendered;
  try {
    rendered = render();
  } catch (error) {
    throw new Error(`${id}: system prompt rendering failed: ${error.message}`);
  }
  assert.ok(rendered.prompt.length > 0, `${id}: rendered system prompt is empty`);
  return { promptChars: rendered.prompt.length, contextChars: rendered.context.length };
}

export function verifyDumpConfiguration(rows, expectedPresets, pressureDefault, expectedBasic) {
  const entries = rows.flatMap(row => row.insert ?? [row]);
  for (const id of expectedPresets) {
    const preset = entries.find(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config.id === id);
    assert.ok(preset, `dump-config: missing preset ${id}`);
    assert.equal(preset.config.plugins.find(row => row.id === 'tool-presentation')?.config.mode, 'ptc');
    if (pressureDefault) {
      const compaction = preset.config.plugins.find(row => row.id === 'compaction');
      const acp = compaction?.config.find(row => row.id === 'active-context');
      assert.deepEqual(acp?.config.acp.pressureDefault, pressureDefault, `${id}: ACP default ratios`);
      assert.deepEqual(acp?.config.acp.pressureRoutes ?? [], [], `${id}: unexpected exact ACP routes`);
      assert.deepEqual(acp?.config.basic, expectedBasic, `${id}: incomplete native Basic policy`);
    }
  }
  const runtime = entries.find(row => row.id === 'ptc-runtime');
  assert.equal(runtime?.name, '@deepseek-ai/dsh-ptc-runtime-node');
  assert.equal(runtime?.config.executionMode, 'per-call');
  assert.ok(!runtime.disabled, 'dump-config: Node PTC runtime is disabled');
  const webserver = entries.find(row => row.id === 'webserver');
  assert.equal(webserver?.config.host, '127.0.0.1');
  assert.equal(webserver?.config.port, 0);
  assert.ok(!entries.some(row => row.id === 'tool-agent-team' && !row.disabled), 'dump-config: global Team tools enabled');
}
