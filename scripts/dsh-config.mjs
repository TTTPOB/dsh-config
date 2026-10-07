#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderMachine, resolveMachineArgument, parseCommandArguments, validatePatch, readYaml } from './lib.mjs';
import { deploymentTargets, doctor, isolatedTest, updateMachine, normalizeDeployment } from './deployment.mjs';

try {
  const { command, machineArgument, apply, offline, tarballs } = parseCommandArguments(process.argv.slice(2));
  const { path, label } = resolveMachineArgument(machineArgument);
  if (!existsSync(path)) throw new Error('Machine configuration not found; provide --machine with an existing private machine name or a machine YAML path');
  const snapshotDir = join(dirname(path), 'snapshot');
  if (command === 'render') {
    const { output, rendered } = renderMachine(path, label);
    console.log(`Rendered ${label}: home=${validatePatch(rendered.home).length} rows, web=${validatePatch(rendered.web).length} rows`);
    console.log(`Private staging output: ${output}`);
  } else if (command === 'check') {
    renderMachine(path, label, undefined, { stage: false });
    console.log(`${label}: current configuration checks passed`);
  } else if (command === 'update') {
    const report = await updateMachine(path, label, apply, { offline });
    console.log(JSON.stringify(report, null, 2));
    if (report.blocked) process.exitCode = 2;
  } else if (command === 'test') {
    console.log(JSON.stringify(isolatedTest(path, label, tarballs), null, 2));
  } else if (command === 'doctor') {
    const machine = readYaml(path);
    machine.deployment = normalizeDeployment(machine.deployment);
    const targets = deploymentTargets(machine, snapshotDir);
    const report = await doctor(machine, targets);
    console.log(JSON.stringify({ ...report, unresolvedAssets: targets.entries.filter(row => row.status.startsWith('blocked')) }, null, 2));
    if (report.blocked || targets.entries.some(row => row.status.startsWith('blocked'))) process.exitCode = 2;
  }
} catch (error) {
  // Assertion details can contain full config objects; never forward them.
  console.error(error?.code === 'ERR_ASSERTION' ? 'Validation failed; inspect private staging output locally.' : error.message);
  process.exitCode = 1;
}
