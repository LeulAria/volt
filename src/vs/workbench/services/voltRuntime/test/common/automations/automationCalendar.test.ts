/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { expandCalendar, layoutLanes, localDays, moveBlocker, movedSchedule } from '../../../common/automations/automationCalendar.js';
import { AutomationSchedule, IAutomation, IAutomationRun } from '../../../common/automations/automations.js';

/** Local time, so the suite reads the same in every zone (mid-November: no daylight saving change nearby). */
const local = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const MIN = 60_000;

function automation(id: string, schedule: AutomationSchedule | undefined, options: { enabled?: boolean; next?: number; runs?: IAutomationRun[] } = {}): IAutomation {
	return {
		id, name: id, instructions: '', enabled: options.enabled ?? true, repositories: [], tools: [],
		triggers: schedule ? [{ id: `${id}-t`, provider: 'schedule', event: schedule.type, schedule }] : [],
		createdAt: 0, updatedAt: 0, createdBy: 'You',
		nextRuns: options.next !== undefined ? { [`${id}-t`]: options.next } : {},
		runs: options.runs ?? [], runCount: options.runs?.length ?? 0,
	};
}

suite('Volt automation calendar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a dense interval is one band per day, counted, not listed', () => {
		const every5 = automation('a', { type: 'interval', everyMs: 5 * MIN }, { next: local(10, 0, 5) });
		const entries = expandCalendar([every5], { from: local(10), to: local(12), now: local(10) });
		assert.deepStrictEqual(entries.map(entry => [entry.kind, entry.day, entry.count, entry.label]), [
			['band', local(10), 287, 'Every 5 minutes'],
			['band', local(11), 288, 'Every 5 minutes'],
		]);
		// Bands keep their ids from one redraw to the next.
		assert.deepStrictEqual(expandCalendar([every5], { from: local(10), to: local(12), now: local(10) }).map(entry => entry.id), entries.map(entry => entry.id));
		// A sparse interval is listed.
		const every4h = automation('b', { type: 'interval', everyMs: 4 * 60 * MIN }, { next: local(10, 2) });
		assert.deepStrictEqual(expandCalendar([every4h], { from: local(10), to: local(11), now: local(10) }).map(entry => entry.start), [2, 6, 10, 14, 18, 22].map(hour => local(10, hour)));
	});

	test('one-time runs: shown until they run, then only the run', () => {
		const at = local(12, 9);
		const pending = automation('a', { type: 'once', at }, { next: at });
		assert.deepStrictEqual(expandCalendar([pending], { from: local(9), to: local(16), now: local(10) }).map(entry => [entry.kind, entry.start, entry.status]), [['occurrence', at, 'upcoming']]);
		const ran = automation('a', { type: 'once', at }, { runs: [{ id: 'r1', at: at + 2000, slotAt: at, triggerId: 'a-t', status: 'succeeded', provider: 'schedule', label: 'Once', threadId: 'th' }] });
		const after = expandCalendar([ran], { from: local(9), to: local(16), now: local(13) });
		assert.deepStrictEqual(after.map(entry => [entry.kind, entry.status, entry.threadId]), [['run', 'succeeded', 'th']]);
		// Off: where it would run, flagged.
		const off = automation('a', { type: 'once', at }, { enabled: false });
		assert.deepStrictEqual(expandCalendar([off], { from: local(9), to: local(16), now: local(10) }).map(entry => [entry.start, entry.disabled]), [[at, true]]);
	});

	test('weekly and cron occurrences in the range', () => {
		// 2026-11-09 is a Monday.
		const weekly = automation('w', { type: 'weekly', weekdays: [1, 3], time: '09:00' }, { enabled: false });
		assert.deepStrictEqual(expandCalendar([weekly], { from: local(9), to: local(16), now: local(8) }).map(entry => [entry.start, entry.disabled]), [[local(9, 9), true], [local(11, 9), true]]);
		const cron = automation('c', { type: 'cron', expr: '30 8 * * 1-5' }, { next: local(9, 8, 30) });
		assert.deepStrictEqual(expandCalendar([cron], { from: local(9), to: local(16), now: local(8) }).map(entry => entry.start), [9, 10, 11, 12, 13].map(day => local(day, 8, 30)));
		// Every 15 minutes in work hours: one band per weekday with 9 hours × 4 runs.
		const busy = automation('d', { type: 'cron', expr: '*/15 9-17 * * 1-5' }, { next: local(9, 9) });
		const bands = expandCalendar([busy], { from: local(9), to: local(16), now: local(8) });
		assert.deepStrictEqual(bands.map(entry => [entry.kind, entry.day, entry.count]), [9, 10, 11, 12, 13].map(day => ['band', local(day), 36]));
		// Counted from the next run on the first day: 17:00, 17:15, 17:30, 17:45.
		const late = automation('d', { type: 'cron', expr: '*/15 9-17 * * 1-5' }, { next: local(9, 17) });
		const today = expandCalendar([late], { from: local(9), to: local(10), now: local(9, 16, 50) });
		assert.deepStrictEqual(today.map(entry => entry.count), [4]);
	});

	test('a run takes its slot; earlier runs show with their status', () => {
		const daily = automation('a', { type: 'daily', time: '09:00' }, {
			next: local(10, 9),
			runs: [
				{ id: 'r0', at: local(9, 9), slotAt: local(9, 9), triggerId: 'a-t', status: 'failed', provider: 'schedule', label: 'Every day at 09:00', error: 'boom' },
				{ id: 'r1', at: local(10, 9) + 3000, slotAt: local(10, 9), triggerId: 'a-t', status: 'running', provider: 'schedule', label: 'Every day at 09:00' },
				{ id: 'r2', at: local(10, 13), status: 'succeeded', provider: 'manual', label: 'Run now' },
			],
		});
		const entries = expandCalendar([daily], { from: local(9), to: local(12), now: local(10, 9, 1) });
		assert.deepStrictEqual(entries.map(entry => [entry.kind, entry.start, entry.status]), [
			['run', local(9, 9), 'failed'],
			['run', local(10, 9) + 3000, 'running'],
			['run', local(10, 13), 'succeeded'],
			['occurrence', local(11, 9), 'upcoming'],
		]);
		assert.strictEqual(entries[0].error, 'boom');
	});

	test('a storm of event runs in one day collapses into a band', () => {
		const runs: IAutomationRun[] = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, at: local(10, 8) + index * MIN, status: index === 3 ? 'failed' : 'succeeded', provider: 'github', label: 'Pull request opened' }));
		const entries = expandCalendar([automation('a', undefined, { runs })], { from: local(9), to: local(12), now: local(11) });
		assert.deepStrictEqual(entries.map(entry => [entry.kind, entry.count, entry.failed, entry.status]), [['band', 30, 1, 'failed']]);
	});

	test('dragging: what moves, and the schedule it becomes', () => {
		// 2026-11-10 is a Tuesday, the 12th a Thursday.
		const from = local(10, 9);
		const to = local(12, 10, 30);
		assert.deepStrictEqual(movedSchedule({ type: 'once', at: from }, undefined, from, to), { type: 'once', at: to });
		assert.deepStrictEqual(movedSchedule({ type: 'daily', time: '09:00' }, undefined, from, to), { type: 'daily', time: '10:30' });
		assert.deepStrictEqual(movedSchedule({ type: 'hourly', minute: 0 }, undefined, from, to), { type: 'hourly', minute: 30 });
		assert.deepStrictEqual(movedSchedule({ type: 'weekly', weekdays: [1, 2], time: '09:00' }, undefined, from, to), { type: 'weekly', weekdays: [1, 4], time: '10:30' });
		assert.deepStrictEqual(movedSchedule({ type: 'cron', expr: '0 9 * * 1-5' }, undefined, from, local(10, 11)), { type: 'cron', expr: '0 11 * * 1-5' });
		assert.deepStrictEqual(movedSchedule({ type: 'cron', expr: '0 9 * * 2' }, undefined, from, to), { type: 'cron', expr: '30 10 * * 4' });
		assert.strictEqual(movedSchedule({ type: 'cron', expr: '*/5 * * * *' }, undefined, from, to), undefined);
		assert.strictEqual(movedSchedule({ type: 'daily', time: '09:00' }, undefined, from, local(12, 9)), undefined);
		assert.strictEqual(moveBlocker({ kind: 'occurrence', schedule: { type: 'interval', everyMs: MIN } }, false), 'interval');
		assert.strictEqual(moveBlocker({ kind: 'occurrence', schedule: { type: 'daily', time: '09:00' } }, true), 'everyDay');
		assert.strictEqual(moveBlocker({ kind: 'occurrence', schedule: { type: 'daily', time: '09:00' } }, false), undefined);
		assert.strictEqual(moveBlocker({ kind: 'occurrence', schedule: { type: 'cron', expr: '0 9 1 * *' } }, false), 'cron');
		assert.strictEqual(moveBlocker({ kind: 'occurrence', schedule: { type: 'cron', expr: '0 9 * * 1,3' } }, true), undefined);
		assert.strictEqual(moveBlocker({ kind: 'run', schedule: { type: 'once', at: from } }, false), 'run');
	});

	test('lanes: overlapping entries side by side, others full width', () => {
		const entries = [{ start: 0, end: 60, id: 'a' }, { start: 30, end: 90, id: 'b' }, { start: 60, end: 120, id: 'c' }, { start: 200, end: 260, id: 'd' }];
		const laid = layoutLanes(entries, entry => entry.end);
		assert.deepStrictEqual(laid.map(item => [item.entry.id, item.lane, item.lanes]), [['a', 0, 2], ['b', 1, 2], ['c', 0, 2], ['d', 0, 1]]);
		assert.deepStrictEqual(localDays(local(9), local(12)), [local(9), local(10), local(11)]);
	});
});
