// Coverage report for the Claude Code compatibility matrix: JSON for machines,
// Markdown (feature × version) for people. `node scripts/cc-matrix/report.mjs
// merge <out-dir> <report.json...>` combines per-version CI reports into one.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from './versions.mjs';

const MARK = { pass: '✅ pass', fail: '❌ fail', skip: '➖ n/a', 'not-covered': '⬜ not covered' };

export function renderMarkdown(report, features) {
  const runs = [...report.runs].sort((a, b) => compareVersions(a.version, b.version));
  const featureIds = features?.map(feature => feature.id) ?? [...new Set(runs.flatMap(run => Object.keys(run.features)))];
  const title = id => features?.find(feature => feature.id === id)?.title ?? report.features?.[id] ?? id;
  const lines = [`# Claude Code compatibility matrix`, '', `Generated ${report.generatedAt} on ${report.platform}, Lectern ${report.appVersion}.`, ''];
  lines.push(`| Feature | ${runs.map(run => run.version + (run.tags?.length ? ` (${run.tags.join(', ')})` : '')).join(' | ')} |`);
  lines.push(`| --- | ${runs.map(() => '---').join(' | ')} |`);
  for (const id of featureIds) lines.push(`| ${title(id)} | ${runs.map(run => MARK[run.features[id]?.status ?? 'not-covered']).join(' | ')} |`);
  lines.push('', '| Version | Result | Duration | Requests | Blocked external hosts | Native one-time prompts seen (the app handles them) |', '| --- | --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const counts = Object.values(run.features).reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
    lines.push(`| ${run.version} | ${counts.fail ? `${counts.fail} failed` : 'ok'} (${counts.pass ?? 0} pass) | ${Math.round(run.durationMs / 1000)} s | ${run.api?.requests ?? 0} | ${(run.api?.externalHosts ?? []).join(', ') || '—'} | ${(run.nudges ?? []).join(', ') || '—'} |`);
  }
  const failures = runs.flatMap(run => Object.entries(run.features).filter(([, item]) => item.status === 'fail').map(([id, item]) => ({ version: run.version, id, item })));
  if (failures.length) {
    lines.push('', '## Failures', '');
    for (const { version, id, item } of failures) lines.push(`- **${version} · ${title(id)}**: ${String(item.error ?? '').split('\n')[0].slice(0, 400)}`);
  }
  const notes = runs.flatMap(run => Object.entries(run.features).filter(([, item]) => item.status === 'skip' && item.reason).map(([id, item]) => `- ${run.version} · ${title(id)}: ${item.reason}`));
  if (notes.length) lines.push('', '## Not applicable', '', ...notes);
  // Observations worth comparing across releases.
  const shown = { 'onboarding.screens': 'First-run screens answered', 'new-chat.models': 'Model list', 'permission.bash-options': 'Bash permission options' };
  const observed = runs.flatMap(run => Object.entries(shown).filter(([key]) => run.notes?.[key]).map(([key, label]) => `- ${run.version} · ${label}: ${JSON.stringify(run.notes[key])}`));
  if (observed.length) lines.push('', '## Observed', '', ...observed);
  lines.push('', '| Version | Scenario durations (s) |', '| --- | --- |');
  for (const run of runs) lines.push(`| ${run.version} | ${Object.entries(run.scenarios ?? {}).map(([id, item]) => `${id} ${Math.round(item.ms / 1000)}${item.ok ? '' : '✗'}`).join(', ')} |`);
  return lines.join('\n') + '\n';
}

export async function writeReport(dir, report, features) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(dir, 'report.md'), renderMarkdown(report, features));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'merge') {
  const [, , , out, ...files] = process.argv;
  const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  if (!reports.length) { console.error('no reports to merge'); process.exit(2); }
  const merged = { ...reports[0], generatedAt: new Date().toISOString(), runs: reports.flatMap(report => report.runs),
    features: Object.assign({}, ...reports.map(report => report.features)) };
  const features = Object.entries(merged.features).map(([id, title]) => ({ id, title }));
  await writeReport(out, merged, features);
  console.log(renderMarkdown(merged, features));
}
