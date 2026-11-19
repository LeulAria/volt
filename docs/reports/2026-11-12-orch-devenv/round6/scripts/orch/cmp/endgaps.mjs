// The 3 s end gap of editing subagents against the trace's `file.change` events, per arm and task.
//   node endgaps.mjs <data dir> [arm,arm]
// For every editing (mode `agent`) subagent run: gap = run.end minus its final usage event (the turn end).
// A run counts as "3 s" when the gap is at least 2.9 s; "file.change" when the run has such an event.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const [dir, armsArg] = process.argv.slice(2);
const arms = armsArg ? new Set(armsArg.split(',')) : undefined;
const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
	.filter(r => r.arm.startsWith('volt') && (!arms || arms.has(r.arm)) && r.task !== 't0');
const groups = new Map();
for (const r of rows) {
	const file = join(dir, 'raw', `${r.id}.traces.json`);
	if (!existsSync(file)) { continue; }
	const { traces } = JSON.parse(readFileSync(file, 'utf8'));
	if (traces[0]?.chat !== r.chat) { continue; }
	for (const t of traces.slice(1)) {
		const E = t.lines.filter(l => l.kind === 'event');
		for (const runId of new Set(E.map(l => l.runId))) {
			const R = E.filter(l => l.runId === runId);
			const s = R.find(l => l.event.type === 'run.start');
			const endIdx = R.findIndex(l => l.event.type === 'run.end');
			if (endIdx <= 0 || s?.event.mode !== 'agent') { continue; }
			const last = R.slice(0, endIdx).filter(l => l.event.type === 'usage' && l.event.used === undefined).at(-1);
			if (!last) { continue; }
			const gap = (R[endIdx].ts - last.ts) / 1000;
			const fc = R.some(l => l.event.type === 'file.change');
			const k = `${r.arm} ${r.task}`;
			const g = groups.get(k) ?? { runs: 0, gap3: 0, fc: 0, fcGap3: 0, noFcGap3: 0, gaps: [] };
			g.runs++;
			if (gap >= 2.9) { g.gap3++; g.gaps.push(gap); }
			if (fc) { g.fc++; if (gap >= 2.9) { g.fcGap3++; } } else if (gap >= 2.9) { g.noFcGap3++; }
			groups.set(k, g);
		}
	}
}
console.log('| Arm, task | Editing subagent runs | Ending ≥ 2.9 s after the turn (gaps, s) | With `file.change` | 3 s gap with / without `file.change` |');
console.log('|---|---|---|---|---|');
for (const [k, g] of [...groups].sort()) {
	console.log(`| ${k} | ${g.runs} | ${g.gap3}${g.gaps.length ? ` (${g.gaps.map(x => x.toFixed(2)).join(', ')})` : ''} | ${g.fc} | ${g.fcGap3}/${g.fc} · ${g.noFcGap3}/${g.runs - g.fc} |`);
}
