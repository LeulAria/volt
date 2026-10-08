/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityContentState, chatView, type IAgentChatView } from '../src/agentState.ts';
import { runPlan, type IActivityHost } from '../src/driver.ts';
import { DEFAULT_PLAN_OPTIONS, planActivities, type ITrackedActivity } from '../src/planner.ts';
import { meta, NOW, running, thread } from './fixtures.ts';

function working(id: string): IAgentChatView {
	return chatView(id, { thread: running(id, 60_000) }, NOW)!;
}

function finished(id: string): IAgentChatView {
	return chatView(id, {
		meta: meta(id, { status: 'done' }),
		thread: thread(id, { last: { turnId: `turn-${id}`, kind: 'prompt', outcome: 'done', at: NOW - 1_000 } }),
	}, NOW)!;
}

function recorder(refuseStarts = false) {
	const calls: string[] = [];
	const host: IActivityHost = {
		async start(action) {
			calls.push(`start ${action.chatId}`);
			return refuseStarts ? undefined : 'iOS-1';
		},
		async update(action) {
			calls.push(`update ${action.activityId}${action.alert ? ' alert' : ''}`);
		},
		async end(action) {
			calls.push(`end ${action.activityId} at ${action.dismissAt}`);
		},
	};
	return { host, calls };
}

test('a started activity is tracked under the id iOS returns', async () => {
	const view = working('a');
	const plan = planActivities([], [view], NOW, DEFAULT_PLAN_OPTIONS, 'http://mac.local:9800');
	const { host, calls } = recorder();
	const tracked = await runPlan([], plan.actions, host, NOW);
	assert.deepEqual(calls, ['start a']);
	assert.deepEqual(tracked, [{ activityId: 'iOS-1', chatId: 'a', state: activityContentState(view, 0), sentAt: NOW }]);
});

test('a refused start is not tracked, so the next plan starts it again', async () => {
	const plan = planActivities([], [working('a')], NOW);
	const { host } = recorder(true);
	const tracked = await runPlan([], plan.actions, host, NOW);
	assert.deepEqual(tracked, []);
	assert.equal(planActivities(tracked, [working('a')], NOW).actions[0].kind, 'start');
});

test('finishing a chat sends the end with its dismissal and drops it from the tracked list', async () => {
	const view = working('a');
	const tracked: ITrackedActivity[] = [{ activityId: 'iOS-1', chatId: 'a', state: activityContentState(view, 0), sentAt: NOW - 60_000 }];
	const plan = planActivities(tracked, [finished('a')], NOW);
	const { host, calls } = recorder();
	const next = await runPlan(tracked, plan.actions, host, NOW);
	assert.deepEqual(calls, [`end iOS-1 at ${(NOW + DEFAULT_PLAN_OPTIONS.doneLingerMs) / 1000}`]);
	assert.deepEqual(next, []);
});

test('an update that changes the phase is sent at once and records when', async () => {
	const view = working('a');
	const tracked: ITrackedActivity[] = [{ activityId: 'iOS-1', chatId: 'a', state: activityContentState(view, 0), sentAt: NOW - 500 }];
	const asking = chatView('a', { thread: { ...running('a', 60_000), inputs: [{ id: 'q1', kind: 'question', at: NOW - 100 }] } }, NOW)!;
	const plan = planActivities(tracked, [asking], NOW);
	const { host, calls } = recorder();
	const next = await runPlan(tracked, plan.actions, host, NOW);
	assert.deepEqual(calls, ['update iOS-1 alert']);
	assert.equal(next[0].activityId, 'iOS-1');
	assert.equal(next[0].sentAt, NOW);
	assert.equal(next[0].state.phase, 'input');
});
