#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { root, renderMachine, resolveMachineArgument, parseCommandArguments, compareSnapshot, buildSourcePlan, validatePatch } from './lib.mjs';

try {
  const { command, machineArgument } = parseCommandArguments(process.argv.slice(2));
  const { path, label } = resolveMachineArgument(machineArgument);
  const snapshotDir = join(dirname(path), 'snapshot');
  if (command === 'render') {
    const { output, rendered } = renderMachine(path, label);
    console.log(`Rendered ${label}: home=${validatePatch(rendered.home).length} rows, web=${validatePatch(rendered.web).length} rows`);
    console.log(`Private staging output: ${output}`);
  } else if (command === 'check') {
    const output = join(root, 'generated', label);
    const rendered = Object.fromEntries(['home', 'web'].map(name => [name, readFileSync(join(output, `${name}.patch.yml`), 'utf8')]));
    for (const text of Object.values(rendered)) validatePatch(text);
    if (existsSync(join(snapshotDir, 'home.patch.yml'))) {
      compareSnapshot(rendered, snapshotDir);
      console.log(`${label}: patch row contents match captured baseline (including literal expressions)`);
    } else {
      console.log(`${label}: static YAML checks passed; no captured baseline available`);
    }
  } else {
    const plan = buildSourcePlan(snapshotDir);
    const blocked = plan.filter(row => row.status.startsWith('blocked') || row.status === 'unverified-release');
    // No private source paths or configuration values are printed.
    console.log(JSON.stringify({ machine: label, installEnabled: false, entries: plan, blocked: blocked.length }, null, 2));
    if (blocked.length) process.exitCode = 2;
  }
} catch (error) {
  // Assertion details can contain full config objects; never forward them.
  console.error(error?.code === 'ERR_ASSERTION' ? 'Validation failed; inspect private staging output locally.' : error.message);
  process.exitCode = 1;
}
