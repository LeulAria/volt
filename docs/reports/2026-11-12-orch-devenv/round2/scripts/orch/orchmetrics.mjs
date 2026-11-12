// Metrics of one orchestration run from a Volt test profile: node orchmetrics.mjs <userDataDir> <rootChatId> [sentAt]
// Reads the root chat's trace, its saved tree and every child chat's trace (subagents, team
// members, council seats). Times are ms from the user's send (sentAt) unless named otherwise.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [ud, rootId, sentArg] = process.argv.slice(2);
const user = join(ud, 'User');
const readTrace = id => {
	const file = join(user, 'voltTraces', `${id}.jsonl`);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean) : [];
};
const tree = JSON.parse(readFileSync(join(user, 'voltOrchestrator', 'roots', `${rootId}.json`), 'utf8'));
const rootLines = readTrace(rootId);
const ev = (lines, type) => lines.filter(l => l.kind === 'event' && l.event?.type === type);
const sentAt = +(sentArg || ev(rootLines, 'run.start')[0]?.ts || 0);
const rel = ts => ts === undefined ? null : Math.round(ts - sentAt);

/** Claude's reported cost is cumulative per session across runs: add each run's growth. */
function costOf(lines) {
	let cost = 0, session = 0;
	for (const runId of new Set(lines.filter(l => l.kind === 'event').map(l => l.runId))) {
		const c = ev(lines, 'usage').filter(l => l.runId === runId).map(l => l.event.costUsd).filter(v => typeof v === 'number');
		if (c.length) { const last = c.at(-1); cost += last >= session ? last - session : last; session = last; }
	}
	return cost;
}
function runsOf(lines) {
	const starts = ev(lines, 'run.start'), ends = ev(lines, 'run.end');
	return starts.map(s => ({ runId: s.runId, start: s.ts, end: ends.find(e => e.runId === s.runId)?.ts, metrics: lines.find(l => l.kind === 'metrics' && l.runId === s.runId)?.metrics }));
}
const denials = lines => ev(lines, 'sandbox.denial').map(l => l.event.denial);

const rootRuns = runsOf(rootLines);
const delegateStart = rootLines.find(l => l.kind === 'event' && l.event?.type === 'tool.start' && /delegate_task|spawn_team|council/.test(JSON.stringify(l.event).slice(0, 400)));
const delegateTool = ev(rootLines, 'host.tool').find(l => /^(delegate_task|spawn_team|council)$/.test(l.event.name) && !l.event.error);
const refused = ev(rootLines, 'host.tool').filter(l => /^(delegate_task|spawn_team|council)$/.test(l.event.name) && l.event.error).map(l => l.event.error.slice(0, 160));
const startedAt = new Map(tree.events.filter(e => e.event.type === 'task.started').map(e => [e.event.taskId, e.at]));
const tasks = tree.tasks.map(task => {
	const lines = task.childId ? readTrace(task.childId) : [];
	const runs = runsOf(lines);
	const first = runs[0];
	const firstUsage = ev(lines, 'usage').find(l => typeof l.event.used === 'number');
	const firstEvent = lines.find(l => l.kind === 'event' && l.runId === first?.runId && !['run.start', 'lane', 'lifecycle', 'notice', 'sandbox.denial'].includes(l.event.type));
	return {
		title: task.title, state: task.state, model: task.modelRef?.replace(/^agent:seed-/, ''), role: task.role,
		started: rel(startedAt.get(task.id) ?? task.startedAt), runStart: rel(first?.start), firstEvent: rel(firstEvent?.ts), ended: rel(task.endedAt),
		agentSource: first?.metrics?.agentSource, agentReadyMs: first?.metrics?.agentReadyMs, firstTextMs: first?.metrics?.firstTextMs, totalMs: first?.metrics?.totalMs,
		promptTokens: firstUsage?.event.used ?? null, requests: runs.reduce((s, r) => s + (r.metrics?.usage?.requests ?? 0), 0), tools: runs.reduce((s, r) => s + (r.metrics?.tools?.count ?? 0), 0),
		costUsd: +costOf(lines).toFixed(4), denials: denials(lines).length, error: task.error?.slice?.(0, 160) ?? task.lastError?.slice?.(0, 160),
	};
});
const childDenials = tree.tasks.flatMap(task => task.childId ? denials(readTrace(task.childId)) : []);
const allDenials = [...denials(rootLines), ...childDenials];
const byKind = {};
for (const d of allDenials) {
	const k = `${d.kind} ${d.process ?? ''} ${(d.target ?? '').replace(/^\/Users\/[^/]+/, '~').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\.tmp\.[0-9a-f]+$/, '.tmp.<n>')}`;
	byKind[k] = (byKind[k] ?? 0) + 1;
}
const ends = tasks.map(t => t.ended).filter(v => v !== null);
const lastEnd = ends.length ? Math.max(...ends) : null;
const wakes = rootRuns.slice(1).map(run => {
	const endedBefore = tasks.map(t => t.ended).filter(v => v !== null && v <= rel(run.start));
	return { start: rel(run.start), afterLastEndMs: endedBefore.length ? rel(run.start) - Math.max(...endedBefore) : null, ms: run.end && run.start ? run.end - run.start : null };
});
const rootCost = costOf(rootLines);
let title;
try { title = JSON.parse(readFileSync(join(user, 'agentSessions', 'index.json'), 'utf8')).sessions.find(entry => entry.id === rootId)?.title; } catch { }
const out = {
	chat: rootId,
	title,
	parentModel: ev(rootLines, 'run.start')[0]?.event.providerRef,
	e2eMs: rel(rootRuns.at(-1)?.end),
	parentFirstTurnMs: rootRuns[0]?.end ? rootRuns[0].end - rootRuns[0].start : null,
	parentPromptTokens: ev(rootLines, 'usage').find(l => typeof l.event.used === 'number')?.event.used ?? null,
	delegateCallStart: rel(delegateStart?.ts), delegateAccepted: rel(delegateTool?.ts), refusedCalls: refused,
	firstChildStart: tasks.length ? Math.min(...tasks.map(t => t.started ?? Infinity)) : null,
	lastChildEnd: lastEnd,
	criticalPathMs: delegateTool && lastEnd !== null ? lastEnd - rel(delegateTool.ts) : null,
	parentRuns: rootRuns.length, wakes,
	tasks,
	failures: tasks.filter(t => !['completed', 'done'].includes(t.state)).length,
	costUsd: { parent: +rootCost.toFixed(4), children: +tasks.reduce((s, t) => s + t.costUsd, 0).toFixed(4) },
	sandboxDenials: allDenials.length, denialsByKind: byKind,
};
console.log(JSON.stringify(out));
