/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CALENDAR_FREQUENT_PER_DAY, daySlots, packColumns, pullRequestNumber, runPullRequest, runsBetween, scheduleSlotsOnDay } from '../../../common/automations/automationCalendar.js';
import { defaultSchedule, describeSchedule, IAutomation, IAutomationRun, parseScheduleText, scheduleKindOf } from '../../../common/automations/automations.js';
import { eventLabel } from '../../../common/automations/automationTriggers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Local midnight of 2026-11-02 (a Monday). */
const MONDAY = new Date(2026, 10, 2).getTime();

function at(day: number, hour: number, minute = 0): number {
	return new Date(new Date(day).getFullYear(), new Date(day).getMonth(), new Date(day).getDate(), hour, minute).getTime();
}

function clock(value: number): string {
	const date = new Date(value);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function automation(id: string, patch: Partial<IAutomation>): IAutomation {
	return {
		id,
		name: id,
		instructions: '',
		enabled: true,
		triggers: [],
		repositories: [],
		tools: [],
		createdAt: 0,
		updatedAt: 0,
		createdBy: 'You',
		nextRuns: {},
		runs: [],
		runCount: 0,
		...patch,
	};
}

suite('Volt automation calendar slots', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('slots of each schedule kind on one day', () => {
		assert.deepStrictEqual(scheduleSlotsOnDay({ type: 'daily', time: '09:30' }, MONDAY, 50).map(clock), ['09:30']);
		assert.deepStrictEqual(scheduleSlotsOnDay({ type: 'weekly', weekdays: [1, 3], time: '18:00' }, MONDAY, 50).map(clock), ['18:00']);
		assert.deepStrictEqual(scheduleSlotsOnDay({ type: 'weekly', weekdays: [2], time: '18:00' }, MONDAY, 50), []);
		const hourly = scheduleSlotsOnDay({ type: 'hourly', minute: 15 }, MONDAY, 50);
		assert.strictEqual(hourly.length, 24);
		assert.strictEqual(clock(hourly[0]), '00:15');
		assert.deepStrictEqual(scheduleSlotsOnDay({ type: 'cron', expr: '0 9,17 * * 1-5' }, MONDAY, 50).map(clock), ['09:00', '17:00']);
		assert.deepStrictEqual(scheduleSlotsOnDay({ type: 'cron', expr: '0 9 * * 0' }, MONDAY, 50), []);
		// A cap stops an every-minute cron early instead of listing 1440 slots.
		assert.strictEqual(scheduleSlotsOnDay({ type: 'cron', expr: '* * * * *' }, MONDAY, 13).length, 13);
	});

	test('an interval counts whole steps from its anchor, either side of it', () => {
		const anchor = at(MONDAY, 10, 5);
		const slots = scheduleSlotsOnDay({ type: 'interval', everyMs: 4 * HOUR }, MONDAY, 50, anchor).map(clock);
		assert.deepStrictEqual(slots, ['02:05', '06:05', '10:05', '14:05', '18:05', '22:05']);
		assert.strictEqual(scheduleSlotsOnDay({ type: 'interval', everyMs: 15 * MINUTE }, MONDAY, 1440, MONDAY).length, 96);
	});

	test('a day keeps rare slots as slots and folds frequent ones into a repeat with a count', () => {
		const now = at(MONDAY, 12, 0);
		const daily = automation('daily', { triggers: [{ id: 'a', provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '15:00' } }] });
		const morning = automation('morning', { triggers: [{ id: 'b', provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '08:00' } }] });
		const busy = automation('busy', { triggers: [{ id: 'c', provider: 'schedule', event: 'minutes', schedule: { type: 'interval', everyMs: 15 * MINUTE } }], nextRuns: { c: at(MONDAY, 12, 10) } });
		const result = daySlots([daily, morning, busy], MONDAY, now);
		assert.deepStrictEqual(result.slots.map(slot => `${slot.automationId} ${clock(slot.at)}`), ['daily 15:00'], 'past slots (08:00) are left to the runs');
		assert.strictEqual(result.repeats.length, 1);
		assert.strictEqual(result.repeats[0].automationId, 'busy');
		assert.strictEqual(clock(result.repeats[0].first), '12:10');
		assert.strictEqual(result.repeats[0].count, 48, '12:10 to 23:55 every 15 minutes');
		assert.ok(result.repeats[0].count > CALENDAR_FREQUENT_PER_DAY);
		// Tomorrow: everything ahead, and the interval keeps its rhythm from the anchor.
		const tomorrow = daySlots([busy], MONDAY + 24 * HOUR, now);
		assert.strictEqual(clock(tomorrow.repeats[0].first), '00:10');
		assert.strictEqual(tomorrow.repeats[0].count, 96);
		// A day already over has nothing ahead.
		assert.deepStrictEqual(daySlots([daily], MONDAY - 24 * HOUR, now), { slots: [], repeats: [] });
	});

	test('runs in a range, oldest first, a running one ends now', () => {
		const now = at(MONDAY, 12, 0);
		const runs: IAutomationRun[] = [
			{ id: 'r2', at: at(MONDAY, 11, 0), status: 'running', provider: 'schedule', label: 'Every hour', startedAt: at(MONDAY, 11, 1) },
			{ id: 'r1', at: at(MONDAY, 9, 0), status: 'succeeded', provider: 'github', label: 'Pull request opened', startedAt: at(MONDAY, 9, 3), finishedAt: at(MONDAY, 9, 20), tools: [{ kind: 'pull_request', status: 'success', detail: 'https://github.com/acme/app/pull/132', at: 0 }] },
			{ id: 'r0', at: at(MONDAY, -2, 0), status: 'failed', provider: 'manual', label: 'Run now' },
		];
		const list = runsBetween([automation('a', { runs })], MONDAY, MONDAY + 24 * HOUR, now);
		assert.deepStrictEqual(list.map(entry => entry.run.id), ['r1', 'r2']);
		assert.strictEqual(list[1].endedAt, now);
		assert.strictEqual(list[0].endedAt, at(MONDAY, 9, 20));
		assert.deepStrictEqual(runPullRequest(list[0].run), { label: '#132', url: 'https://github.com/acme/app/pull/132' });
		assert.strictEqual(runPullRequest(list[1].run), undefined);
	});

	test('pull request numbers from GitHub, GitLab and Bitbucket links', () => {
		assert.strictEqual(pullRequestNumber('https://github.com/a/b/pull/7'), '#7');
		assert.strictEqual(pullRequestNumber('https://gitlab.com/a/b/-/merge_requests/12'), '#12');
		assert.strictEqual(pullRequestNumber('https://bitbucket.org/a/b/pull-requests/3'), '#3');
		assert.strictEqual(pullRequestNumber('opened #45 for review'), '#45');
		assert.strictEqual(pullRequestNumber('no link'), undefined);
	});

	test('overlapping blocks share the column width, widen into free columns, separate groups keep it', () => {
		const columns = packColumns([
			{ start: 0, end: 60 },
			{ start: 0, end: 20 },
			{ start: 10, end: 30 },
			{ start: 40, end: 60 },
			{ start: 200, end: 230 },
		]);
		assert.deepStrictEqual(columns, [
			{ column: 0, columns: 3, span: 1 },
			{ column: 1, columns: 3, span: 1 },
			{ column: 2, columns: 3, span: 1 },
			{ column: 1, columns: 3, span: 2 },
			{ column: 0, columns: 1, span: 1 },
		]);
	});

	test('every few minutes: an interval schedule with its own trigger kind', () => {
		assert.deepStrictEqual(defaultSchedule('minutes'), { type: 'interval', everyMs: 15 * MINUTE });
		assert.strictEqual(scheduleKindOf({ type: 'interval', everyMs: 5 * MINUTE }), 'minutes');
		assert.strictEqual(eventLabel('schedule', 'minutes'), 'Every few minutes');
		assert.strictEqual(describeSchedule({ type: 'interval', everyMs: 5 * MINUTE }), 'Every 5 minutes');
		assert.deepStrictEqual(parseScheduleText('every 10 minutes').schedule, { type: 'interval', everyMs: 10 * MINUTE });
	});
});
