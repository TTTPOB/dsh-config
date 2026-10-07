#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { root, renderMachine, resolveMachineArgument, parseCommandArguments, compareSnapshot, validatePatch, readYaml } from './lib.mjs';
import { deploymentTargets, doctor, isolatedTest, updateMachine, normalizeDeployment } from './deployment.mjs';

try {
  const { command, machineArgument, apply, live, tarballs } = parseCommandArguments(process.argv.slice(2));
  const { path, label } = resolveMachineArgument(machineArgument);
  if (!existsSync(path)) throw new Error('Machine configuration not found; provide --machine with an existing private machine name or a machine YAML path');
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
  } else if (command === 'update') {
    const report = await updateMachine(path, label, apply, { live });
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
