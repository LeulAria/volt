// Where a Volt run's wall time goes: Volt's own overhead on the critical path vs model + tool time.
//   node breakdown.mjs [arm,arm] [--json]
// From the saved traces of each run (raw/<id>.traces.json: task tree + root and child traces):
// - preRun: Enter -> the parent's run.start (composer, checkpoint, routing);
// - parentPrompt: run.start -> prompt written to the agent (adopt a spare or cold start, session setup);
// - per delegation wave (child runs starting within 5 s of each other), the run that ended last:
//   start gap (task started -> its run.start: queue, sandbox, checkpoint) + its prompt time (agent
//   spawn and setup); a re-run of a live child (message_task) counts from the parent's call;
// - delivery: wave end -> the parent's next tool.end/run.start (the report reaching the parent).
// Everything else is "model + tools": the model's requests and the tools it ran (file reads, tests).
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CMP_DATA ?? join(here, '../../../data/orch/cmp');
const armsArg = process.argv[2] && !process.argv[2].startsWith('--') ? new Set(process.argv[2].split(',')) : undefined;
const excluded = new Set(JSON.parse(readFileSync(join(DATA, 'excluded.json'), 'utf8')).rows.map(r => `${r.id}@${r.at}`));
const rows = readFileSync(join(DATA, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
	.filter(r => r.arm.startsWith('volt') && (!armsArg || armsArg.has(r.arm)) && !excluded.has(`${r.id}@${r.at.slice(0, 19)}`));

function runsOf(lines) {
	const metrics = lines.filter(l => l.kind === 'metrics').map(l => l.metrics);
	const ends = new Map(lines.filter(l => l.kind === 'event' && l.event.type === 'run.end').map(l => [l.event.runId, l.ts]));
	return metrics.map(m => ({ ...m, endAt: ends.get(m.runId) ?? m.startedAt + (m.totalMs ?? 0), promptAt: m.startedAt + (m.promptMs ?? m.firstEventMs ?? m.agentReadyMs ?? 0) }));
}

const out = [];
for (const r of rows) {
	const file = join(DATA, 'raw', `${r.id}.traces.json`);
	if (!existsSync(file)) {
		continue;
	}
	// The latest rows win: a re-run overwrote raw/<id>.traces.json, so match it by its root chat.
	const { tree, traces } = JSON.parse(readFileSync(file, 'utf8'));
	if (traces[0]?.chat !== r.chat) {
		continue;
	}
	const sentAt = Date.parse(r.at);
	const root = traces[0].lines;
	const parentRuns = runsOf(root);
	const parentEvents = root.filter(l => l.kind === 'event');
	const p0 = parentRuns[0];
	const preRun = p0 ? p0.startedAt - sentAt : 0;
	const parentPrompt = p0 ? p0.promptAt - p0.startedAt : 0;
	const tasks = (tree?.tasks ?? []).filter(t => t.childId);
	const messageCalls = parentEvents.filter(l => l.event.type === 'host.tool' && l.event.name === 'message_task').map(l => l.ts);
	const childRuns = [];
	for (const t of tasks) {
		const lines = traces.find(x => x.chat === t.childId)?.lines ?? [];
		runsOf(lines).forEach((run, i) => {
			// The first run starts from the task's start; a later one from the parent's message_task just before it.
			const from = i === 0 ? (t.startedAt ?? t.createdAt) : (messageCalls.filter(ts => ts <= run.startedAt).at(-1) ?? run.startedAt);
			childRuns.push({ task: t.title, i, source: run.agentSource, startGap: Math.max(0, run.startedAt - from), prompt: run.promptAt - run.startedAt, start: run.startedAt, end: run.endAt });
		});
	}
	childRuns.sort((a, b) => a.start - b.start);
	const waves = [];
	for (const c of childRuns) {
		const w = waves.at(-1);
		if (w && c.start - w.start < 5000) {
			w.runs.push(c);
		} else {
			waves.push({ start: c.start, runs: [c] });
		}
	}
	let spawn = 0;
	let gaps = 0;
	let delivery = 0;
	const waveInfo = [];
	waves.forEach((w, k) => {
		const last = w.runs.reduce((a, b) => b.end > a.end ? b : a);
		spawn += last.prompt;
		gaps += last.startGap;
		const next = parentEvents.find(l => l.ts > last.end && (l.event.type === 'tool.end' || l.event.type === 'run.start'));
		// A wave that hands straight to the next one (a dependent task) reports to the parent later, with that wave.
		const handsOn = waves[k + 1] && (!next || waves[k + 1].start < next.ts);
		const lag = next && !handsOn ? Math.min(next.ts - last.end, 10_000) : 0;
		delivery += lag;
		waveInfo.push({ n: w.runs.length, sources: w.runs.map(x => x.source).join('/'), critical: last.task, startGap: last.startGap, prompt: last.prompt, maxPrompt: Math.max(...w.runs.map(x => x.prompt)), delivery: lag });
	});
	const overhead = preRun + parentPrompt + gaps + spawn + delivery;
	out.push({ id: r.id, arm: r.arm, task: r.task, at: r.at, load: r.load, wallMs: r.wallMs, preRun, parentPrompt, parentSource: p0?.agentSource, childStartGaps: gaps, childSpawn: spawn, delivery, overhead, modelAndTools: r.wallMs - overhead, overheadPct: Math.round(overhead / r.wallMs * 1000) / 10, waves: waveInfo });
}

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(out, null, 1));
} else {
	const s = ms => (ms / 1000).toFixed(1);
	console.log('| Run | Wall s | Enter→run.start | Parent agent ready | Child start gaps | Child agent ready (critical) | Report delivery | Volt overhead s (%) | Model + tools s | Waves (n: sources) |');
	console.log('|---|---|---|---|---|---|---|---|---|---|');
	for (const o of out) {
		console.log(`| ${o.id} | ${s(o.wallMs)} | ${s(o.preRun)} | ${s(o.parentPrompt)} (${o.parentSource}) | ${s(o.childStartGaps)} | ${s(o.childSpawn)} | ${s(o.delivery)} | ${s(o.overhead)} (${o.overheadPct}%) | ${s(o.modelAndTools)} | ${o.waves.map(w => `${w.n}: ${w.sources}`).join('; ') || '–'} |`);
	}
}
