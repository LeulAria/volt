// Where the seconds go, Claude Code and Volt on the same clock (Enter = 0), per arm and task, medians:
//   node phases.mjs <data dir> [arm,arm] [--max-load N]
// - lead: Enter -> the first subagent starts (the parent reads the request and writes its delegation);
// - sub: the first subagent's start -> the last subagent's end (all waves, incl. the parent's turns between waves);
// - tail: the last subagent's end -> the run's end (the report reaching the parent and its final answer).
// Claude Code: its stream (raw/<id>.jsonl, `at` = ms since the CLI started): a subagent starts at the parent's
// Task/Agent tool_use and ends at its tool_result. Volt: the saved task tree in runs.jsonl (startedAt/endedAt,
// ms since Enter).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const dir = args[0];
const arms = args[1] && !args[1].startsWith('--') ? new Set(args[1].split(',')) : undefined;
const maxLoad = args.includes('--max-load') ? Number(args[args.indexOf('--max-load') + 1]) : Infinity;
const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
	.filter(r => r.task !== 't0' && (!arms || arms.has(r.arm)) && Number(String(r.load).split(' ')[0]) <= maxLoad);
const med = xs => { const s = xs.filter(x => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b); if (!s.length) { return undefined; } const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f1 = x => x === undefined ? '–' : (x / 1000).toFixed(1);

function ccSpans(id) {
	const file = join(dir, 'raw', `${id}.jsonl`);
	if (!existsSync(file)) {
		return undefined;
	}
	const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
	const start = new Map();
	const spans = [];
	for (const { at, m } of lines) {
		const content = Array.isArray(m?.message?.content) ? m.message.content : [];
		for (const c of content) {
			if (m.type === 'assistant' && !m.parent_tool_use_id && c.type === 'tool_use' && /^(Task|Agent)$/.test(c.name)) {
				start.set(c.id, at);
			}
			if (m.type === 'user' && c.type === 'tool_result' && start.has(c.tool_use_id)) {
				spans.push([start.get(c.tool_use_id), at]);
			}
		}
	}
	// The CLI's own start-up before the request is not part of Enter -> answer in wallMs: align on the end.
	const result = lines.find(l => l.m?.type === 'result');
	return { spans, end: result?.at };
}

const groups = new Map();
for (const r of rows) {
	let lead, sub, tail;
	if (r.arm.startsWith('volt')) {
		const ts = (r.tasks ?? []).filter(t => t.startedAt !== undefined && t.endedAt !== undefined);
		if (!ts.length) {
			continue;
		}
		const first = Math.min(...ts.map(t => t.startedAt));
		const last = Math.max(...ts.map(t => t.endedAt));
		[lead, sub, tail] = [first, last - first, r.wallMs - last];
	} else {
		const s = ccSpans(r.id);
		if (!s?.spans.length || s.end === undefined) {
			continue;
		}
		const first = Math.min(...s.spans.map(x => x[0]));
		const last = Math.max(...s.spans.map(x => x[1]));
		const zero = s.end - r.wallMs;
		[lead, sub, tail] = [first - zero, last - first, s.end - last];
	}
	const key = `${r.arm} ${r.task}`;
	if (!groups.has(key)) {
		groups.set(key, []);
	}
	groups.get(key).push({ lead, sub, tail, wall: r.wallMs });
}
console.log('| Arm, task | n | Enter → first subagent, s | Subagents running, s | Last subagent → answer, s | Wall, s |');
console.log('|---|---|---|---|---|---|');
for (const [key, g] of [...groups].sort(([a], [b]) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b))) {
	console.log(`| ${key} | ${g.length} | ${f1(med(g.map(x => x.lead)))} | ${f1(med(g.map(x => x.sub)))} | ${f1(med(g.map(x => x.tail)))} | ${f1(med(g.map(x => x.wall)))} |`);
}
