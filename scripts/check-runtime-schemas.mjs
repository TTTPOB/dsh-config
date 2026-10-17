#!/usr/bin/env node
// Run with the target checkout's tsx loader; this validates schemas without mounting plugins.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, renderMachine, validatePatch } from './lib.mjs';

const checkout = resolve(process.argv[2]);
const machinePath = process.argv[3] ?? join(root, 'examples/workstation-machine.yaml');
const sources = {
  'ptc-runtime': 'packages/ptc-runtime/ptc-runtime-node/src/index.ts',
  '@deepseek-ai/dsh-ptc-runtime-node': 'packages/ptc-runtime/ptc-runtime-node/src/index.ts',
  '@deepseek-ai/dsh-mcp-client': 'packages/mcp/mcp-client/src/index.ts',
  '@deepseek-ai/dsh-persona': 'packages/preset/persona/src/index.ts',
  '@deepseek-ai/dsh-agent-instructions': 'packages/context/agent-instructions/src/config.ts',
  '@deepseek-ai/dsh-tool-fs-search': 'packages/fs/tool-fs-search/src/index.ts',
  '@deepseek-ai/dsh-plan-mode': 'packages/plan/plan-mode/src/index.ts',
  '@deepseek-ai/dsh-compaction-basic': 'packages/compaction/compaction-basic/src/config.ts',
  '@deepseek-ai/dsh-compaction-tool-result-pruner': 'packages/compaction/compaction-tool-result-pruner/src/config.ts',
  '@deepseek-ai/dsh-tool-subagent': 'packages/subagent/tool-subagent/src/index.ts',
  '@deepseek-ai/dsh-workflow-ptc': 'packages/workflow/workflow-ptc/src/index.ts',
  '@deepseek-ai/dsh-tool-ralph': 'packages/experimental/tool-ralph/src/index.ts',
  '@deepseek-ai/dsh-tool-todo': 'packages/todo/tool-todo/src/index.ts',
  '@deepseek-ai/dsh-tool-web': 'packages/web/tool-web/src/index.ts',
  '@deepseek-ai/dsh-agent-tool-presentation': 'packages/core/agent-tool-presentation/src/index.ts',
  '@deepseek-ai/dsh-experimental-agent-team': 'packages/experimental/agent-team/src/index.ts',
  '@deepseek-ai/dsh-experimental-tool-agent-team': 'packages/experimental/tool-agent-team/src/index.ts',
  web: 'packages/web/web/src/index.ts',
  'ui-settings-general': 'packages/client/ui-settings-general/src/index.ts',
  'ui-conversation': 'packages/client/ui-conversation/src/index.ts',
  'llm-deepseek': 'packages/llm/llm-deepseek/src/config.ts',
  'agent-loop': 'packages/core/agent-loop/src/index.ts',
  'agent-preset-registry': 'packages/preset/agent-preset-registry/src/index.ts',
  'agent-default-model': 'packages/core/agent-default-model/src/index.ts',
};
const external = process.argv[4];
if (external) Object.assign(sources, {
  'dsh-progressive-tools': join(external, 'dsh-progressive-tools/src/index.ts'),
  'dsh-workspace-overlay': join(external, 'dsh-workspace-overlay/src/registry.ts'),
  'dsh-workspace-envrc': join(external, 'dsh-workspace-envrc/src/provider.ts'),
  'dsh-active-context': join(external, 'dsh-active-context/src/config.ts'),
});
const schemas = new Map();
let checked = 0;
async function check(rows) {
  for (const row of rows) {
    if (row.disabled === true) continue;
    if (row.name === '@deepseek-ai/dsh-agent-preset') {
      await check(row.config.plugins);
      continue;
    }
    if (row.group) {
      await check(row.config);
      continue;
    }
    if (row.config === undefined) continue;
    const source = row.id === 'prompt-overlay' ? join(root, 'plugins/prompt-sections.mjs') : sources[row.name ?? row.id];
    if (!source) {
      assert.ok(row.name && !row.name.startsWith('@deepseek-ai/'), `Missing official schema mapping: ${row.id}`);
      continue;
    }
    if (!schemas.has(source)) {
      const module = await import(pathToFileURL(resolve(checkout, source)).href);
      schemas.set(source, module.Config ?? module.default?.Config ?? module.resolveConfig);
    }
    const schema = schemas.get(source);
    if (typeof schema === 'function') schema(row.config);
    else {
      assert.ok(schema?.['~standard'], `Missing Config: ${row.id}`);
      assert.ok(!(await schema['~standard'].validate(row.config)).issues, `Invalid Config: ${row.id}`);
    }
    checked++;
  }
}
const { rendered } = renderMachine(machinePath, 'runtime-schema-check', undefined, { stage: false });
await check([...validatePatch(rendered.home), ...validatePatch(rendered.web)].map(row => row.entry));
console.log(`Runtime Config schemas passed: ${checked} rows, ${schemas.size} schemas; plugin activation is verified separately by profile smoke.`);
