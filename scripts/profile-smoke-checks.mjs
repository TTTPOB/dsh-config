import assert from 'node:assert/strict';

export function verifyToolCatalog(id, schemas, assembly, { acp = true } = {}) {
  const names = schemas.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, `${id}: duplicate tool names`);
  const team = id === 'standard-ptc-team';
  const required = team
    ? ['spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent', 'wait_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
    : ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent'];
  for (const name of [...required, 'run_code', 'workflow', 'ralph']) assert.ok(names.includes(name), `${id}: missing ${name}`);
  for (const name of team ? ['subagent', 'subagent_fork'] : ['spawn_teammate', 'wait_agent', 'team_task_create']) {
    assert.ok(!names.includes(name), `${id}: unexpected ${name}`);
  }
  const send = schemas.find(tool => tool.name === 'send_message');
  assert.ok(send.parameters[team ? 'target' : 'agent_id'], `${id}: wrong send_message implementation`);
  assert.ok(!send.parameters[team ? 'agent_id' : 'target'], `${id}: mixed send_message implementations`);
  assert.ok(assembly.tools.some(tool => tool.name === 'run_code'), `${id}: PTC transport is not model-visible`);
  if (acp) {
    assert.ok(names.includes('context_compress'), `${id}: ACP is not registered`);
    const sdk = assembly.sections.map(section => section.text).join('\n');
    assert.match(sdk, /context_compress/, `${id}: ACP is missing from the PTC SDK`);
  }
  if (id.endsWith('-child')) assert.ok(!names.includes('present'), `${id}: spawn child exposes present`);
  return { id, tools: names.sort(), ptc: true, acp };
}

export function verifyDumpConfiguration(rows, expectedPresets) {
  const entries = rows.flatMap(row => row.insert ?? [row]);
  for (const id of expectedPresets) {
    const preset = entries.find(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config.id === id);
    assert.ok(preset, `dump-config: missing preset ${id}`);
    assert.equal(preset.config.plugins.find(row => row.id === 'tool-presentation')?.config.mode, 'ptc');
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
