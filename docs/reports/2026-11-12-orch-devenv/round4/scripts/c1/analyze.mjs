// Where a C1 run's time and tokens went, from its saved capture rows and (Volt) traces.
//   node analyze.mjs <id> [--json]
// Sessions: each Claude Code client session in the capture (lead = the one whose thread is the C1 task, workers =
// other sessions with coding tools that answered a tool, side = the rest). Gaps: stretches of the run with no
// model request in flight (a waiting lead and no worker at work). Volt only: the lead's tools and the tasks.
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { DATA, isCompletion } from './common.mjs';

const [id] = process.argv.slice(2);
const asJson = process.argv.includes('--json');
const gz = file => existsSync(file) ? gunzipSync(readFileSync(file)).toString('utf8') : undefined;
const rowsOf = file => existsSync(join(DATA, file)) ? readFileSync(join(DATA, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const row = [...rowsOf('c1-runs.jsonl'), ...rowsOf('smoke-runs.jsonl')].filter(r => r.id === id).at(-1);
if (!row) { throw new Error(`no row for ${id}`); }
const t0 = Date.parse(row.at);
const end = t0 + row.minutes * 60_000;
const rows = gz(join(DATA, `${id}.capture.jsonl.gz`)).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.t >= t0 && r.t + (r.ms ?? 0) <= end + 1);
const sum = u => u ? (u.input ?? 0) + (u.cache_write ?? 0) + (u.cache_read ?? 0) + (u.output ?? 0) : 0;
const s = ms => +(ms / 1000).toFixed(1);

// ---------- sessions ----------
const sessions = new Map();
const side = new Map();
for (const r of rows.filter(isCompletion)) {
	const m = r.meta ?? {};
	const key = m.session ?? '-';
	const entry = sessions.get(key) ?? { session: key, task: false, coding: false, answers: 0, requests: 0, tokens: 0, output: 0, cacheWrite: 0, prompt: [], first: r.t, last: r.t + r.ms, firstUser: m.firstUser, sideCalls: 0, sideTokens: 0 };
	sessions.set(key, entry);
	entry.task ||= !!m.task;
	entry.first = Math.min(entry.first, r.t);
	entry.last = Math.max(entry.last, r.t + r.ms);
	// A request with no coding tools in a working session is a side call of that client (title, predictor, summary).
	if (!m.coding) {
		entry.sideCalls++;
		entry.sideTokens += sum(r.usage);
		const kind = `${r.model} ${(m.firstUser ?? '').replace(/\s+/g, ' ').slice(0, 60)}`;
		const sideEntry = side.get(kind) ?? { kind, calls: 0, tokens: 0 };
		sideEntry.calls++;
		sideEntry.tokens += sum(r.usage);
		side.set(kind, sideEntry);
		continue;
	}
	entry.coding = true;
	entry.requests++;
	entry.answers += m.answersTool ? 1 : 0;
	entry.tokens += sum(r.usage);
	entry.output += r.usage?.output ?? 0;
	entry.cacheWrite += r.usage?.cache_write ?? 0;
	entry.prompt.push((r.usage?.input ?? 0) + (r.usage?.cache_write ?? 0) + (r.usage?.cache_read ?? 0));
}
// The lead is the session of the first request that carries the C1 task; a worker's brief can quote the task too.
const leadSession = rows.filter(isCompletion).sort((a, b) => a.t - b.t).find(r => r.meta?.task)?.meta?.session;
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const sessionRows = [...sessions.values()].map(e => ({
	role: e.session === leadSession ? 'lead' : e.coding && e.answers ? 'worker' : 'other', quotesTask: e.task,
	session: e.session.slice(0, 8), start: s(e.first - t0), end: s(e.last - t0), requests: e.requests, toolAnswers: e.answers,
	tokens: e.tokens, output: e.output, cacheWrite: e.cacheWrite, promptMedian: median(e.prompt), promptMax: Math.max(0, ...e.prompt),
	sideCalls: e.sideCalls, sideTokens: e.sideTokens, firstUser: (e.firstUser ?? '').replace(/\s+/g, ' ').slice(0, 70),
})).sort((a, b) => a.start - b.start);

// ---------- gaps with nothing in flight ----------
const spans = rows.filter(isCompletion).map(r => [r.t, r.t + r.ms]).sort((a, b) => a[0] - b[0]);
const gaps = [];
let cursor = t0;
for (const [a, b] of spans) {
	if (a - cursor > 3000) { gaps.push({ from: s(cursor - t0), to: s(a - t0), seconds: s(a - cursor) }); }
	cursor = Math.max(cursor, b);
}
if (end - cursor > 3000) { gaps.push({ from: s(cursor - t0), to: s(end - t0), seconds: s(end - cursor), tail: true }); }

// ---------- Volt: lead tools and tasks ----------
let lead = [];
let tasks = [];
const traces = gz(join(DATA, `${id}.traces.json.gz`));
if (traces) {
	const { tree, traces: list } = JSON.parse(traces);
	const root = list.find(t => t.chat === tree?.rootId) ?? list[0];
	const open = new Map();
	for (const l of root.lines.filter(l => l.kind === 'event')) {
		const e = l.event;
		if (e.type === 'tool.start') { open.set(e.callId, { name: e.name, start: l.ts }); }
		if (e.type === 'tool.end' && open.has(e.callId)) {
			const o = open.get(e.callId);
			const text = JSON.stringify(e.result ?? '');
			lead.push({ tool: o.name.replace(/^mcp__volt__/, ''), start: s(o.start - t0), seconds: s(l.ts - o.start), resultChars: text.length });
			open.delete(e.callId);
		}
		if (e.type === 'host.tool' && e.name === 'delegate_task') {
			lead.push({ tool: 'delegate_task(args)', start: s(l.ts - t0), argsChars: JSON.stringify(e.args ?? {}).length });
		}
		if (e.type === 'run.start' || e.type === 'run.end') { lead.push({ tool: e.type, start: s(l.ts - t0), reason: e.reason }); }
	}
	lead.sort((a, b) => a.start - b.start);
	tasks = (tree?.tasks ?? []).map(t => ({
		title: t.title?.slice(0, 50), state: t.state, isolation: t.isolation, model: t.modelLabel, branch: t.worktreeBranch,
		created: s(t.createdAt - t0), started: t.startedAt && s(t.startedAt - t0), ended: t.endedAt && s(t.endedAt - t0),
		runSeconds: t.startedAt && t.endedAt && s(t.endedAt - t.startedAt), steps: t.steps, briefChars: (t.brief ?? '').length, reportChars: (t.result ?? '').length,
		usage: t.usage?.tokens,
	}));
}
const lastTaskEnd = Math.max(0, ...tasks.map(t => t.ended ?? 0));
const out = {
	id, minutes: row.minutes, shipped: row.shipped, handoff: row.handoff, tokensTotal: row.tokensTotal, usd: row.usd,
	fanOut: row.fanOut, agents: row.agents?.agents, requests: rows.length,
	tail: tasks.length ? { lastTaskEnd, end: s(end - t0), leadAfterWorkers: +(s(end - t0) - lastTaskEnd).toFixed(1) } : undefined,
	sessions: sessionRows, side: [...side.values()].sort((a, b) => b.tokens - a.tokens), gaps, lead, tasks,
};
if (asJson) {
	console.log(JSON.stringify(out, null, 1));
} else {
	console.log(`${id}: ${row.minutes} min, shipped ${row.shipped}/5, handoff ${row.handoff}/4, ${row.tokensTotal} tokens, $${row.usd}, fan-out ${JSON.stringify(row.fanOut)}, ${rows.length} requests`);
	if (out.tail) { console.log('tail', JSON.stringify(out.tail)); }
	console.table(sessionRows);
	console.table(out.side.slice(0, 12));
	console.table(gaps);
	if (lead.length) { console.table(lead); }
	if (tasks.length) { console.table(tasks); }
}
