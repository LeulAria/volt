/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Metrics of one live Volt orchestration run from a test profile: the root chat's event trace
// (User/voltTraces/<chat>.jsonl) and its saved tree (User/voltOrchestrator/roots/<chat>.json),
// plus the traces of Volt subagent chats (delegate_task children).
// Usage: node scripts/volt-e2e/orch/analyzeVolt.mjs <profile/User> <rootChatId> [--json]
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const [user, rootId] = process.argv.slice(2);
const readTrace = id => {
	const file = join(user, 'voltTraces', `${id}.jsonl`);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
};
const tree = JSON.parse(readFileSync(join(user, 'voltOrchestrator', 'roots', `${rootId}.json`), 'utf8'));
const root = tree.threads.find(thread => thread.id === rootId);
const lines = readTrace(rootId);
const events = lines.filter(line => line.kind === 'event');
const runs = [...new Set(events.map(line => line.runId))];
const t0 = Math.min(...tree.events.filter(e => e.event.type === 'turn.dispatched' && e.event.threadId === rootId).map(e => e.at), events[0]?.ts ?? Infinity);
const end = Math.max(...events.filter(line => line.event.type === 'run.end').map(line => line.ts));
const firstUsage = events.find(line => line.event.type === 'usage');
const firstTool = events.find(line => line.event.type === 'tool.start');
const childStarts = [
	...events.filter(line => line.event.type === 'subagent.spawned').map(line => line.ts),
	...tree.tasks.filter(task => task.source === 'volt' && task.startedAt).map(task => task.startedAt),
];
const childEnds = tree.tasks.map(task => task.endedAt).filter(Boolean);
// Cost: Claude reports a cumulative session cost per run; the last report of each run is its total.
let costUsd = 0;
const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const addRun = (traceEvents) => {
	for (const runId of new Set(traceEvents.map(line => line.runId))) {
		const usage = traceEvents.filter(line => line.runId === runId && line.event.type === 'usage');
		const cost = usage.map(line => line.event.costUsd).filter(value => typeof value === 'number');
		if (cost.length) {
			costUsd += cost.at(-1);
		}
		const last = usage.filter(line => line.event.billed).at(-1)?.event.billed;
		if (last) {
			for (const key of Object.keys(billed)) {
				billed[key] += last[key] ?? 0;
			}
		}
	}
};
addRun(events);
// Volt subagents run in their own chats: their spend is in their traces (sessions differ, so costs add).
const voltChildren = tree.tasks.filter(task => task.source === 'volt' && task.childId);
let childToolCalls = 0;
for (const task of voltChildren) {
	const childEvents = readTrace(task.childId).filter(line => line.kind === 'event');
	childToolCalls += childEvents.filter(line => line.event.type === 'tool.start').length;
	addRun(childEvents);
}
const count = type => events.filter(line => line.event.type === type).length;
const sec = ms => Math.round(ms / 100) / 10;
const result = {
	chat: rootId,
	model: events.find(line => line.event.type === 'run.start')?.event.providerRef,
	parentTurns: runs.length,
	wallS: sec(end - t0),
	firstModelOutputS: firstUsage ? sec(firstUsage.ts - t0) : null,
	firstToolS: firstTool ? sec(firstTool.ts - t0) : null,
	firstSubagentS: childStarts.length ? sec(Math.min(...childStarts) - t0) : null,
	lastChildDoneToEndS: childEnds.length ? sec(end - Math.max(...childEnds)) : null,
	subagents: tree.tasks.length,
	subagentKinds: [...new Set(tree.tasks.map(task => `${task.source}:${task.kind ?? task.role}`))],
	parentToolCalls: count('tool.start'),
	subagentToolCalls: events.filter(line => line.event.type === 'subagent.event' && line.event.event?.type === 'tool.start').length + childToolCalls,
	approvals: count('access.ask'),
	sandboxDenials: count('sandbox.denial'),
	contextAtFirstAnswer: firstUsage?.event.used ?? null,
	costUsd: Math.round(costUsd * 10000) / 10000,
	billedTokens: billed,
};
console.log(process.argv.includes('--json') ? JSON.stringify(result) : JSON.stringify(result, null, 1));
