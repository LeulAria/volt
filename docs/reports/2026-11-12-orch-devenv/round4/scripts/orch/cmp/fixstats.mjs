// Per-fix numbers from the saved Volt traces (raw/<id>.traces.json), one row per arm and task (medians over runs):
//   node fixstats.mjs <data dir> [arm,arm]
// - pre: the parent's tool calls before its first delegate_task (ToolSearch = the deferred-load request);
// - args: bytes of the delegate_task arguments (all calls of the run);
// - first: Enter (parent run.start) -> the first subagent run.start, s;
// - endGap: per editing subagent run, run.end minus its final usage event (the turn end), s: the sandbox overlay merge wait;
// - warm: subagent runs whose agent came from the pool / all subagent runs;
// - report: characters of each task's report (median);
// - refused: delegate_task results saying "not a task of this chat" (the `after` refusal);
// - testsTool: calls of Volt's tests tool.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const [dir, armsArg] = process.argv.slice(2);
const arms = armsArg ? new Set(armsArg.split(',')) : undefined;
const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
	.filter(r => r.arm.startsWith('volt') && (!arms || arms.has(r.arm)) && r.task !== 't0');
const med = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b); if (!s.length) { return undefined; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f1 = x => x === undefined ? '–' : x.toFixed(1);

function stats(r) {
	const file = join(dir, 'raw', `${r.id}.traces.json`);
	if (!existsSync(file)) { return undefined; }
	const { tree, traces } = JSON.parse(readFileSync(file, 'utf8'));
	if (traces[0]?.chat !== r.chat) { return undefined; }
	const ev = lines => lines.filter(l => l.kind === 'event');
	const P = ev(traces[0].lines);
	const start = P.find(l => l.event.type === 'run.start')?.ts;
	const firstDelegate = P.findIndex(l => l.event.type === 'tool.start' && /delegate_task/.test(l.event.name));
	const pre = P.slice(0, firstDelegate < 0 ? P.length : firstDelegate).filter(l => l.event.type === 'tool.start').map(l => l.event.name.replace(/^mcp__volt__/, ''));
	const args = P.filter(l => l.event.type === 'host.tool' && l.event.name === 'delegate_task').reduce((n, l) => n + JSON.stringify(l.event.args ?? {}).length, 0);
	const refused = P.filter(l => l.event.type === 'tool.end' && /not a task of this chat/.test(JSON.stringify(l.event.result ?? ''))).length;
	const testsTool = traces.flatMap(t => ev(t.lines)).filter(l => l.event.type === 'tool.start' && /(^|__)tests$/.test(l.event.name)).length;
	const childStarts = [];
	const endGaps = [];
	let warm = 0;
	let runs = 0;
	for (const t of traces.slice(1)) {
		const E = ev(t.lines);
		for (const runId of new Set(E.map(l => l.runId))) {
			const R = E.filter(l => l.runId === runId);
			const s = R.find(l => l.event.type === 'run.start');
			const endIdx = R.findIndex(l => l.event.type === 'run.end');
			if (s) { childStarts.push(s.ts); }
			// The run's final usage (the turn's totals, sent when the agent's turn ended) -> run.end, editing runs only.
			if (endIdx > 0 && s?.event.mode === 'agent') {
				const last = R.slice(0, endIdx).filter(l => l.event.type === 'usage' && l.event.used === undefined).at(-1);
				if (last) { endGaps.push((R[endIdx].ts - last.ts) / 1000); }
			}
			const m = t.lines.find(l => l.kind === 'metrics' && l.runId === runId);
			if (m) { runs++; if (m.metrics?.agentSource === 'pool') { warm++; } }
		}
	}
	const reports = (tree?.tasks ?? []).map(t => t.result?.length).filter(Boolean);
	return { pre, args, first: childStarts.length && start ? (Math.min(...childStarts) - start) / 1000 : undefined, endGap: med(endGaps), maxEndGap: endGaps.length ? Math.max(...endGaps) : undefined, warm, runs, report: med(reports), refused, testsTool };
}

console.log('| Arm | Task | n | Tool calls before delegating | delegate_task args, bytes | Enter → first subagent, s | Subagent run.end gap, s (max) | Warm subagent starts | Report chars | `after` refusals | tests-tool calls |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
const groups = new Map();
for (const r of rows) {
	const s = stats(r);
	if (!s) { continue; }
	const k = `${r.arm}|${r.task}`;
	groups.set(k, [...(groups.get(k) ?? []), s]);
}
for (const [k, ss] of [...groups].sort()) {
	const [arm, task] = k.split('|');
	const pre = [...new Set(ss.flatMap(s => s.pre))];
	const preCount = ss.map(s => s.pre.length);
	console.log(`| ${arm} | ${task} | ${ss.length} | ${med(preCount)}${pre.length ? ` (${pre.join(', ')})` : ''} | ${med(ss.map(s => s.args))} | ${f1(med(ss.map(s => s.first)))} | ${f1(med(ss.map(s => s.endGap)))} (${f1(Math.max(...ss.map(s => s.maxEndGap ?? 0)))}) | ${ss.reduce((n, s) => n + s.warm, 0)}/${ss.reduce((n, s) => n + s.runs, 0)} | ${med(ss.map(s => s.report))} | ${ss.reduce((n, s) => n + s.refused, 0)} | ${ss.reduce((n, s) => n + s.testsTool, 0)} |`);
}
