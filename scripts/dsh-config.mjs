#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderMachine, resolveMachineArgument, parseCommandArguments, validatePatch, readYaml, resolveDependencyTargets } from './lib.mjs';
import { deploymentTargets, doctor, isolatedTest, updateMachine, rollbackMachine, normalizeDeployment } from './deployment.mjs';
import { formatDoctor, formatUpdate, selectReport } from './report.mjs';

try {
  const { command, machineArgument, apply, offline, json, verbose, tarballs, backup } = parseCommandArguments(process.argv.slice(2));
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
    const machine = readYaml(path);
    const pending = resolveDependencyTargets(snapshotDir, machine.installation, undefined, machine.features).entries
      .filter(row => row.status.startsWith('blocked'));
    if (pending.length) console.log(`待发布来源（结构检查不验证安装）：${[...new Set(pending.map(row => row.name))].join(', ')}`);
  } else if (command === 'update') {
    const report = selectReport(await updateMachine(path, label, apply, { offline }), verbose);
    console.log(json ? JSON.stringify(report, null, 2) : formatUpdate(report, verbose));
    if (report.blocked) process.exitCode = 2;
  } else if (command === 'rollback') {
    console.log(JSON.stringify(await rollbackMachine(path, backup), null, 2));
  } else if (command === 'test') {
    console.log(JSON.stringify(isolatedTest(path, label, tarballs), null, 2));
  } else if (command === 'doctor') {
    const machine = readYaml(path);
    machine.deployment = normalizeDeployment(machine.deployment);
    const targets = deploymentTargets(machine, snapshotDir);
    const report = await doctor(machine, targets);
    const unresolvedAssets = targets.entries.filter(row => row.status.startsWith('blocked'));
    const result = selectReport({ ...report, unresolvedAssets, blocked: report.blocked + unresolvedAssets.length,
      ...(unresolvedAssets.length ? { next: '补齐清单中缺少的精确发布资产，并处理上述安装问题。' } : {}),
    }, verbose);
    console.log(json ? JSON.stringify(result, null, 2) : formatDoctor(result, verbose));
    if (report.blocked || targets.entries.some(row => row.status.startsWith('blocked'))) process.exitCode = 2;
  }
} catch (error) {
  // Assertion details can contain full config objects; never forward them.
  console.error(error?.code === 'ERR_ASSERTION' ? 'Validation failed; inspect private staging output locally.' : error.message);
  process.exitCode = 1;
}
