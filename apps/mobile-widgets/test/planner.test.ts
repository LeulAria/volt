/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityContentState, chatView, type IAgentChatView } from '../src/agentState.ts';
import { applyPlan, DEFAULT_PLAN_OPTIONS, planActivities, planLaunchSweep, type ITrackedActivity } from '../src/planner.ts';
import { emptyStepState, foldStep } from '../src/steps.ts';
import { meta, NOW, running, thread } from './fixtures.ts';

function working(id: string, agoMs: number, step?: string): IAgentChatView {
	return chatView(id, { thread: running(id, agoMs), ...(step ? { step: foldStep(emptyStepState(), { type: 'tool.start', callId: step, name: step }) } : {}) }, NOW)!;
}

function tracked(view: IAgentChatView, sentAgoMs = 10_000, others = 0): ITrackedActivity {
	return { activityId: `act-${view.chatId}`, chatId: view.chatId, state: activityContentState(view, others), sentAt: NOW - sentAgoMs };
}

test('starts activities for working chats up to the cap, best first, and counts the rest', () => {
	const views = [working('a', 1000), working('b', 2000), working('c', 3000), working('d', 4000)];
	const plan = planActivities([], views, NOW, { ...DEFAULT_PLAN_OPTIONS, maxActivities: 2 }, 'http://mac.local:9800');
	assert.deepEqual(plan.actions.map(a => [a.kind, a.chatId]), [['start', 'a'], ['start', 'b']]);
	const start = plan.actions[0];
	assert.equal(start.kind, 'start');
	if (start.kind === 'start') {
		assert.equal(start.state.others, 2);
		assert.deepEqual(start.attributes, { chatId: 'a', provider: 'claude', server: 'http://mac.local:9800' });
		assert.equal(start.staleAt, (NOW + DEFAULT_PLAN_OPTIONS.staleAfterMs) / 1000);
	}
});

test('an unchanged chat sends nothing; step changes are rate limited, phase changes are not', () => {
	const view = working('a', 60_000, 'Read a.ts');
	assert.deepEqual(planActivities([tracked(view)], [view], NOW).actions, []);

	const stepped = working('a', 60_000, 'Read b.ts');
	const recent = tracked(view, 500);
	const deferred = planActivities([recent], [stepped], NOW);
	assert.deepEqual(deferred.actions, []);
	assert.equal(deferred.nextCheckAt, recent.sentAt + DEFAULT_PLAN_OPTIONS.minUpdateIntervalMs);
	assert.equal(planActivities([tracked(view, 5_000)], [stepped], NOW).actions[0]?.kind, 'update');

	const asking = chatView('a', { thread: running('a', 60_000, { inputs: [{ id: 'q', kind: 'question', at: NOW }] }), questions: [{ id: 'q', sessionId: 'a', questions: [{ prompt: 'Ship it?' }] }] }, NOW)!;
	const urgent = planActivities([recent], [asking], NOW).actions[0];
	assert.equal(urgent?.kind, 'update');
	if (urgent?.kind === 'update') {
		assert.equal(urgent.state.phase, 'input');
		assert.deepEqual(urgent.alert, { title: 'Question from the agent', body: 'New chat: Ship it?' });
		assert.equal(urgent.relevance, 100);
	}
});

test('finished chats end with their final state and linger per outcome; vanished chats end now', () => {
	const view = working('a', 60_000);
	const done = chatView('a', { meta: meta('a', { status: 'done' }), thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW } }) }, NOW)!;
	const [end] = planActivities([tracked(view)], [done], NOW).actions;
	assert.equal(end.kind, 'end');
	if (end.kind === 'end') {
		assert.equal(end.state?.phase, 'done');
		assert.equal(end.dismissAt, (NOW + DEFAULT_PLAN_OPTIONS.doneLingerMs) / 1000);
		assert.equal(end.alert?.title, 'Chat a');
	}
	const stopped = chatView('a', { thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'cancelled', at: NOW } }) }, NOW)!;
	const [stopEnd] = planActivities([tracked(view)], [stopped], NOW).actions;
	assert.equal(stopEnd.kind === 'end' && stopEnd.dismissAt, (NOW + DEFAULT_PLAN_OPTIONS.stoppedLingerMs) / 1000);
	assert.equal(stopEnd.kind === 'end' && stopEnd.alert, undefined);

	const [gone] = planActivities([tracked(view)], [], NOW).actions;
	assert.deepEqual(gone, { kind: 'end', activityId: 'act-a', chatId: 'a', dismissAt: 0 });
});

test('kept activities are not displaced by newer chats; duplicates for one chat are ended', () => {
	const old = working('old', 600_000);
	const views = [old, working('n1', 1000), working('n2', 2000), working('n3', 3000)];
	const plan = planActivities([tracked(old, 10_000, 3)], views, NOW, { ...DEFAULT_PLAN_OPTIONS, maxActivities: 2 });
	assert.deepEqual(plan.actions.map(a => [a.kind, a.chatId]), [['update', 'old'], ['start', 'n1']]);
	const update = plan.actions[0];
	assert.equal(update.kind === 'update' && update.state.others, 2);

	const dup = { ...tracked(old), activityId: 'act-old-2' };
	const dupPlan = planActivities([tracked(old), dup], [old], NOW);
	assert.deepEqual(dupPlan.actions.map(a => [a.kind, a.kind === 'start' ? undefined : a.activityId]), [['end', 'act-old-2']]);
});

test('applyPlan drops ended activities and records updates', () => {
	const a = working('a', 1000);
	const b = working('b', 1000);
	const next = applyPlan([tracked(a), tracked(b)], [
		{ kind: 'end', activityId: 'act-a', chatId: 'a', dismissAt: 0 },
		{ kind: 'update', activityId: 'act-b', chatId: 'b', state: { ...activityContentState(b, 0), step: 'X' }, staleAt: 0, relevance: 50 },
	], NOW);
	assert.equal(next.length, 1);
	assert.equal(next[0].state.step, 'X');
	assert.equal(next[0].sentAt, NOW);
});

test('a launch keeps only the activity of the best-ranked running turn and ends the rest', () => {
	const running1 = working('a', 1000);
	const finished = chatView('b', { meta: meta('b', { status: 'done' }), thread: thread('b', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW } }) }, NOW)!;
	const second = working('c', 3000);
	const list = [tracked(running1), tracked(finished), tracked(second), tracked(working('gone', 5000))];
	const plan = planLaunchSweep(list, [running1, finished, second]);
	assert.deepEqual(plan.actions.map(a => [a.kind, a.kind === 'end' ? a.activityId : '']), [
		['end', 'act-b'],
		['end', 'act-c'],
		['end', 'act-gone'],
	]);
	assert.ok(plan.actions.every(a => a.kind === 'end' && a.dismissAt === 0));
});

test('a launch ends every stale activity when no tracked chat is running, and keeps one per running chat', () => {
	const finished = chatView('b', { meta: meta('b', { status: 'done' }), thread: thread('b', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW } }) }, NOW)!;
	const none = planLaunchSweep([tracked(finished), tracked(working('gone', 1000))], [finished]);
	assert.deepEqual(none.actions.map(a => a.kind), ['end', 'end']);

	// Two activities for the running chat (an earlier launch raced a start): keep one, end the duplicate.
	const view = working('a', 1000);
	const dup = planLaunchSweep([tracked(view), { ...tracked(view), activityId: 'act-a-2' }], [view]);
	assert.deepEqual(dup.actions.map(a => a.kind === 'end' ? a.activityId : ''), ['act-a-2']);
});
