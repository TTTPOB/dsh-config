import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readYaml, parseYaml, validatePatch } from './lib.mjs';

// Report row identities, never configuration values that may contain credentials.
export function summarizeFiles(manifests, patches, localPlugins = []) {
  return [
    ...manifests.map(([path, contents]) => ({ path, kind: 'installation',
      changed: !existsSync(path) || !isDeepStrictEqual(readYaml(path), parseYaml(contents)) })),
    ...localPlugins.map(({ path, source, contents }) => ({ path, source, kind: 'local-plugin',
      changed: !existsSync(path) || readFileSync(path, 'utf8') !== contents })),
    ...patches.map(([path, contents, meta]) => {
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
      // Compare meaning, not formatting: preserved rows are re-emitted by the YAML writer.
      const changed = !isDeepStrictEqual(parseYaml(previous || '[]'), parseYaml(contents));
      const preserved = meta?.preserved ?? [];
      const retired = meta?.retired ?? [];
      const extra = { ...(preserved.length ? { preserved } : {}), ...(retired.length ? { retired } : {}) };
      if (!changed) return { path, kind: 'configuration', changed, ...extra };
      const before = new Map(validatePatch(previous || '[]').map(row => [row.entry.id, row]));
      const after = new Map(validatePatch(contents).map(row => [row.entry.id, row]));
      return { path, kind: 'configuration', changed, ...extra,
        added: [...after.keys()].filter(id => !before.has(id)),
        removed: [...before.keys()].filter(id => !after.has(id)),
        modified: [...after.keys()].filter(id => before.has(id) && !isDeepStrictEqual(before.get(id), after.get(id))),
        orderChanged: !isDeepStrictEqual([...before.keys()], [...after.keys()]),
      };
    }),
  ];
}

const scopeOf = row => row.profile ?? 'global';
const sourceOf = source => source ?? '(未声明)';

export function selectReport(report, verbose = false) {
  if (report.entries) {
    const summary = {
      changed: report.entries.filter(row => row.changed && !row.status.startsWith('blocked')).length,
      unchanged: report.entries.filter(row => row.changed === false && !row.status.startsWith('blocked')).length,
      unmanaged: report.entries.filter(row => row.status.startsWith('unmanaged')).length,
      blocked: report.entries.filter(row => row.status.startsWith('blocked')).length,
    };
    return { ...report, summary,
      entries: verbose ? report.entries : report.entries.filter(row => row.changed || row.status.startsWith('blocked')),
      ...(report.files ? { files: verbose ? report.files : report.files.filter(row => row.changed || row.planned) } : {}),
    };
  }
  const { checks, hostManifest, ...summary } = report;
  return verbose ? report : summary;
}

export function formatUpdate(report, verbose = false) {
  const changed = report.entries.filter(row => row.changed && !row.status.startsWith('blocked'));
  const blocked = report.entries.filter(row => row.status.startsWith('blocked'));
  const unchanged = report.summary.unchanged;
  const unmanaged = report.summary.unmanaged;
  const files = report.files ?? [];
  const heading = report.apply ? (report.noOp ? '无需更新' : '更新已完成') : '更新预览（未执行）';
  const lines = [`${heading} · ${report.input}`, `依赖：${changed.length} 项声明变化，${unchanged} 项不变，${unmanaged} 项非受管保留，${blocked.length} 项阻塞`];
  if (report.runtime) lines.push(`CLI runtime: ${report.runtime.installedVersion ?? '(离线未检查)'} → ${report.runtime.targetVersion}${report.runtime.changed === false ? '（不变）' : ''}`);
  for (const row of blocked) lines.push(`! [${scopeOf(row)}] ${row.name}: ${row.status} — ${row.reason ?? '缺少精确发布资产'}`);
  for (const row of changed) {
    lines.push(`~ [${scopeOf(row)}] ${row.name} → ${row.status === 'retired-override' ? '(移除旧 override)' : row.version}`);
    for (const old of row.currentSources ?? []) lines.push(`  原 ${old.selector}: ${sourceOf(old.source)}`);
    lines.push(`  新: ${row.target}`);
  }
  for (const file of files.filter(row => row.changed)) {
    lines.push(`~ ${file.kind === 'configuration' ? '配置' : file.kind === 'local-plugin' ? '本地插件' : '安装声明'}: ${file.path}`);
    for (const [key, label] of [['added', '新增'], ['removed', '移除'], ['modified', '修改']]) {
      if (file[key]?.length) lines.push(`  ${label}行: ${file[key].join(', ')}`);
    }
    if (file.kind === 'configuration' && !file.added.length && !file.removed.length && !file.modified.length) {
      lines.push(file.orderChanged ? '  行顺序变化' : '  仅文本格式变化');
    }
    if (file.preserved?.length) lines.push('  保留行（模板不产生，原样留在文件中）: ' + file.preserved.join(', '));
    if (file.retired?.length) lines.push('  移除锚点生效: ' + file.retired.join(', '));
  }
  for (const file of files.filter(row => row.planned)) lines.push('计划本地插件: ' + file.source + ' → ' + file.path);
  if (report.input === 'offline') lines.push('离线计划：与声明／快照比较，未检查本机安装与配置。');
  else lines.push('依赖差异与本机声明比较；实际安装版本和入口由 doctor 验收。');
  if (report.granted?.length) lines.push(`已授权 ${report.granted.length} 个清单验证的精确兼容组合。`);
  if (report.backup) lines.push(`备份: ${report.backup}`);
  if (report.apply) lines.push(report.noOp ? '未执行安装或写入；未检查 Host 激活状态。' : '已安装，未确认激活；未启停 Host。');
  if (verbose) {
    for (const row of report.entries.filter(row => !row.changed && !row.status.startsWith('blocked'))) lines.push(`= [${scopeOf(row)}] ${row.name}: ${row.target ?? row.status}`);
    for (const file of files.filter(row => row.changed === false)) lines.push(`= 文件不变: ${file.path}`);
  }
  lines.push('更多明细：--verbose；JSON 格式：--json');
  return lines.join('\n');
}

export function formatDoctor(report, verbose = false) {
  const lines = [`Doctor：${report.blocked ? `${report.blocked} 项问题` : '检查通过'} · runtime ${report.runtimeVersion}`];
  if (report.checked !== undefined) lines.push(`已检查 ${report.checked} 个包／profile 组合；通过项不逐项显示。`);
  for (const issue of report.issues) {
    lines.push(`! [${scopeOf(issue)}] ${issue.name ?? 'profile'}: ${issue.status}`);
    if (issue.actual !== undefined || issue.expected !== undefined) lines.push(`  当前: ${sourceOf(issue.actual)} → 目标: ${sourceOf(issue.expected)}`);
    if (issue.entry) lines.push(`  解析入口: ${issue.entry}`);
    if (issue.manifestPath) lines.push(`  包声明: ${issue.manifestPath}`);
    if (issue.reason) lines.push(`  原因: ${issue.reason}`);
    if (issue.detail) lines.push(`  详情: ${issue.detail}`);
  }
  for (const row of report.unresolvedAssets ?? []) lines.push(`! [${scopeOf(row)}] ${row.name}: ${row.status} — ${row.reason}`);
  if (verbose) {
    if (report.hostManifest) lines.push(`Host: ${report.hostManifest}`);
    for (const check of report.checks ?? []) {
      lines.push(`= [${scopeOf(check)}] ${check.name}: ${check.installedVersion ?? '(未安装)'} → ${check.targetVersion}`);
      if (check.entry) lines.push(`  入口: ${check.entry}`);
    }
  }
  lines.push(report.next, '更多明细：--verbose；JSON 格式：--json');
  return lines.join('\n');
}
