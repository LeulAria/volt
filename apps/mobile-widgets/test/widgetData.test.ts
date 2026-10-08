/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatView } from '../src/agentState.ts';
import { limitPace, poolLimits, shortWindowLabel, snapshotFingerprint, widgetSnapshot, widgetUsage } from '../src/widgetData.ts';
import type { IUsageReportLike } from '../src/serverShapes.ts';
import { meta, NOW, running, thread } from './fixtures.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const REPORT: IUsageReportLike = {
	machineName: 'Studio',
	limits: [
		{ provider: 'codex', plan: 'Plus', checkedAt: NOW - 60_000, windows: [
			{ id: 'secondary', label: 'Weekly limit', usedPercent: 35, resetsAt: NOW + 5 * DAY, windowMs: 7 * DAY },
			{ id: 'primary', label: '5-hour limit', usedPercent: 18, resetsAt: NOW + 4 * HOUR, windowMs: 5 * HOUR },
		] },
		{ provider: 'claude', account: { id: 'claude:1' }, plan: 'Max 5x', checkedAt: NOW - 30_000, resetCredits: 1, windows: [
			{ id: 'five_hour', label: 'Current session', usedPercent: 80, resetsAt: NOW + HOUR, windowMs: 5 * HOUR },
			{ id: 'seven_day', label: 'Current week', scope: 'All models', usedPercent: 40, resetsAt: NOW + 3 * DAY, windowMs: 7 * DAY },
		] },
		{ provider: 'claude', account: { id: 'claude:2' }, plan: 'Max 5x', checkedAt: NOW - 90_000, windows: [
			{ id: 'five_hour', label: 'Current session', usedPercent: 20, resetsAt: NOW + 2 * HOUR, windowMs: 5 * HOUR },
		] },
		{ provider: 'cursor', checkedAt: NOW, windows: [], error: 'Sign in to Cursor to see limits.' },
	],
};

test('pools accounts per provider like the Usage page: averaged use, soonest reset, Usage page order', () => {
	const pools = poolLimits(REPORT.limits);
	assert.deepEqual(pools.map(p => p.provider), ['claude', 'codex', 'cursor']);
	const session = pools[0].windows.find(w => w.id === 'five_hour')!;
	assert.equal(session.usedPercent, 50);
	assert.equal(session.accounts, 2);
	assert.equal(session.resetsAt, NOW + HOUR);
	assert.equal(pools[0].resetCredits, 1);
	assert.equal(pools[0].checkedAt, NOW - 90_000);
});

test('pace: ahead of the refill rate, and when the window runs out before reset', () => {
	// 4 of 5 hours gone, 80% used: on pace.
	const pace = limitPace({ id: 'w', label: 'x', usedPercent: 80, resetsAt: NOW + 1 * HOUR, windowMs: 5 * HOUR }, NOW);
	assert.equal(pace?.ahead, false);
	assert.equal(pace?.runsOutInMs, undefined, '80% used at 80% of the window is on pace');
	const fast = limitPace({ id: 'w', label: 'x', usedPercent: 60, resetsAt: NOW + 3.5 * HOUR, windowMs: 5 * HOUR }, NOW);
	assert.equal(fast?.ahead, true);
	assert.ok(fast?.runsOutInMs && fast.runsOutInMs < 3.5 * HOUR);
	assert.equal(limitPace({ id: 'w', label: 'x', usedPercent: 10, resetsAt: NOW + 4.99 * HOUR, windowMs: 5 * HOUR }, NOW), undefined);
});

test('widget usage: shortest window first, short names, seconds, expired windows back to zero', () => {
	const [claude, codex, cursor] = widgetUsage(REPORT, NOW);
	assert.equal(claude.label, 'Claude');
	assert.equal(claude.plan, 'Max 5x');
	assert.deepEqual(codex.windows.map(w => w.short), ['5h', 'Week']);
	assert.equal(codex.windows[0].resetsAt, (NOW + 4 * HOUR) / 1000);
	assert.equal(codex.windows[0].windowSeconds, 5 * 3600);
	assert.equal(cursor.error, 'Sign in to Cursor to see limits.');
	const expired = widgetUsage({ limits: [{ provider: 'codex', checkedAt: NOW - DAY, windows: [{ id: 'p', label: '5-hour limit', usedPercent: 90, resetsAt: NOW - HOUR, windowMs: 5 * HOUR }] }] }, NOW);
	assert.equal(expired[0].windows[0].usedPercent, 0);
	assert.equal(expired[0].windows[0].resetsAt, undefined);
	assert.equal(shortWindowLabel({ id: 'm', label: 'Monthly', usedPercent: 0, windowMs: 30 * DAY }), 'Month');
	assert.equal(shortWindowLabel({ id: 'x', label: 'Limit', usedPercent: 0 }), 'Limit');
	assert.equal(shortWindowLabel({ id: 'x', label: '2-day', usedPercent: 0, windowMs: 2 * DAY }), '2d');
});

test('snapshot lists chats needing input first, then working, then recently finished', () => {
	const views = [
		chatView('w', { meta: meta('w', { title: 'Refactor billing' }), thread: running('w', 60_000) }, NOW)!,
		chatView('q', { thread: running('q', 600_000, { inputs: [{ id: 'i', kind: 'approval', at: NOW }] }), approvals: [{ id: 'i', sessionId: 'q', action: 'shell', resource: { value: 'rm -rf dist' }, createdAt: NOW }] }, NOW)!,
		chatView('d', { thread: thread('d', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW - 60_000 } }), meta: meta('d', { lastPromptAt: NOW - 120_000 }) }, NOW)!,
		chatView('old', { thread: thread('old', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: NOW - 2 * HOUR } }) }, NOW)!,
	];
	const snapshot = widgetSnapshot({ now: NOW, views, report: REPORT, reportAt: NOW - 1000, connected: true });
	assert.deepEqual(snapshot.agents.items.map(i => i.chatId), ['q', 'w', 'd']);
	assert.equal(snapshot.agents.working, 1);
	assert.equal(snapshot.agents.needsInput, 1);
	assert.equal(snapshot.agents.items[0].step, 'Run rm -rf dist');
	assert.equal(snapshot.agents.items[0].url, 'volt://chat/q');
	assert.equal(snapshot.server?.name, 'Studio');
	assert.equal(snapshot.usage?.checkedAt, (NOW - 1000) / 1000);
	assert.deepEqual(snapshot.links, { home: 'volt://', usage: 'volt://settings', newChat: 'volt://chat/new' });

	const later = widgetSnapshot({ now: NOW + 5000, views, report: REPORT, reportAt: NOW - 1000, connected: true });
	assert.notEqual(later.generatedAt, snapshot.generatedAt);
	assert.equal(snapshotFingerprint(later), snapshotFingerprint(snapshot));
	assert.notEqual(snapshotFingerprint(widgetSnapshot({ now: NOW, views, connected: false })), snapshotFingerprint(snapshot));
});
