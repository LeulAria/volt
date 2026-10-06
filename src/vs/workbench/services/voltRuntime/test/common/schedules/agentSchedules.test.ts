/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { decideScheduleRun, describeSchedule, IAgentSchedule, nextScheduleRun, parseScheduleSpec, parseSchedulesFile, recordScheduleRun, SCHEDULE_MISSED_GRACE_MS, scheduledRunPrompt } from '../../../common/schedules/agentSchedules.js';

/** A local wall-clock time, as the user's machine reads it. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

function task(extra: Partial<IAgentSchedule> = {}): IAgentSchedule {
	return {
		id: 's-1',
		title: 'CI check',
		prompt: 'Check CI',
		enabled: true,
		schedule: { type: 'interval', everyMs: 3_600_000 },
		target: { kind: 'thread', threadId: 'chat' },
		createdAt: 0,
		createdBy: 'user',
		runs: [],
		runCount: 0,
		...extra,
	};
}

suite('Volt scheduled tasks: schedule math', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a fixed time runs later today if it has not passed, else on the next allowed weekday', () => {
		// Tuesday 6 October 2026.
		const tuesdayMorning = local(2026, 10, 6, 8, 0);
		assert.strictEqual(nextScheduleRun({ type: 'fixed_time', timeOfDay: '09:30' }, tuesdayMorning), local(2026, 10, 6, 9, 30));
		assert.strictEqual(nextScheduleRun({ type: 'fixed_time', timeOfDay: '07:00' }, tuesdayMorning), local(2026, 10, 7, 7, 0));
		assert.strictEqual(nextScheduleRun({ type: 'fixed_time', timeOfDay: '09:30' }, local(2026, 10, 6, 9, 30)), local(2026, 10, 7, 9, 30), 'strictly after: the slot just fired is not next');
		// Friday evening, weekdays only: Monday.
		assert.strictEqual(nextScheduleRun({ type: 'fixed_time', timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5] }, local(2026, 10, 9, 18, 0)), local(2026, 10, 12, 9, 0));
		assert.strictEqual(nextScheduleRun({ type: 'interval', everyMs: 60_000 }, 1_000), 61_000);
		assert.strictEqual(nextScheduleRun({ type: 'fixed_time', timeOfDay: '25:00' }, 0), undefined);
	});

	test('a missed interval runs once and counts on from now; a fixed time missed past the grace is skipped', () => {
		const now = local(2026, 10, 6, 12, 0);
		const interval = task({ nextRunAt: now - 5 * 3_600_000 });
		assert.deepStrictEqual(decideScheduleRun(interval, now), { kind: 'run', nextRunAt: now + 3_600_000 });

		const daily = task({ schedule: { type: 'fixed_time', timeOfDay: '09:00' }, nextRunAt: local(2026, 10, 6, 9, 0) });
		assert.deepStrictEqual(decideScheduleRun(daily, now), { kind: 'skip', nextRunAt: local(2026, 10, 7, 9, 0) });
		const justLate = local(2026, 10, 6, 9, 0) + SCHEDULE_MISSED_GRACE_MS - 1;
		assert.deepStrictEqual(decideScheduleRun(daily, justLate), { kind: 'run', nextRunAt: local(2026, 10, 7, 9, 0) });

		assert.deepStrictEqual(decideScheduleRun(task({ nextRunAt: now + 1 }), now), { kind: 'wait' });
		assert.deepStrictEqual(decideScheduleRun(task({ nextRunAt: now - 1, enabled: false }), now), { kind: 'wait' }, 'a paused task never runs');
	});

	test('a run is recorded with its outcome; skips do not count as runs', () => {
		let current = recordScheduleRun(task(), { at: 1, status: 'started', threadId: 'chat' }, 100);
		current = recordScheduleRun(current, { at: 2, status: 'skipped' }, 200);
		assert.strictEqual(current.runCount, 1);
		assert.strictEqual(current.nextRunAt, 200);
		assert.strictEqual(current.lastRunAt, 2);
		assert.strictEqual(recordScheduleRun(current, { at: 3, status: 'failed' }, undefined).nextRunAt, undefined);
	});
});

suite('Volt scheduled tasks: input and storage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('schedules come as T3-style objects or a few words, and bad ones say why', () => {
		assert.deepStrictEqual(parseScheduleSpec({ type: 'interval', everyMs: 3_600_000 }).spec, { type: 'interval', everyMs: 3_600_000 });
		assert.match(parseScheduleSpec({ type: 'interval', everyMs: 1_000 }).error ?? '', /at least 60000/);
		assert.deepStrictEqual(parseScheduleSpec({ type: 'fixed_time', timeOfDay: '9:05', weekdays: [5, 1, 1] }).spec, { type: 'fixed_time', timeOfDay: '09:05', weekdays: [1, 5] });
		assert.deepStrictEqual(parseScheduleSpec({ type: 'fixed_time', timeOfDay: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] }).spec, { type: 'fixed_time', timeOfDay: '09:00' }, 'every day needs no list');
		assert.match(parseScheduleSpec({ type: 'fixed_time', timeOfDay: '09:00', weekdays: [7] }).error ?? '', /0 \(Sunday\)/);
		assert.deepStrictEqual(parseScheduleSpec('every 2 hours').spec, { type: 'interval', everyMs: 7_200_000 });
		assert.deepStrictEqual(parseScheduleSpec('every 30 minutes').spec, { type: 'interval', everyMs: 1_800_000 });
		assert.deepStrictEqual(parseScheduleSpec('daily at 09:00').spec, { type: 'fixed_time', timeOfDay: '09:00' });
		assert.deepStrictEqual(parseScheduleSpec('weekdays at 18:30').spec, { type: 'fixed_time', timeOfDay: '18:30', weekdays: [1, 2, 3, 4, 5] });
		assert.deepStrictEqual(parseScheduleSpec('mon and wed at 8:15').spec, { type: 'fixed_time', timeOfDay: '08:15', weekdays: [1, 3] });
		assert.ok(parseScheduleSpec('whenever').error);
	});

	test('descriptions read like T3 and Cursor', () => {
		assert.strictEqual(describeSchedule({ type: 'interval', everyMs: 3_600_000 }), 'Every hour');
		assert.strictEqual(describeSchedule({ type: 'interval', everyMs: 2 * 86_400_000 }), 'Every 2 days');
		assert.strictEqual(describeSchedule({ type: 'interval', everyMs: 15 * 60_000 }), 'Every 15 minutes');
		assert.strictEqual(describeSchedule({ type: 'fixed_time', timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5] }), 'Weekdays at 09:00');
		assert.strictEqual(describeSchedule({ type: 'fixed_time', timeOfDay: '08:15', weekdays: [0, 3] }), 'Wed, Sun at 08:15');
		assert.ok(scheduledRunPrompt(task(), 0).endsWith('Check CI'));
	});

	test('the file round-trips, and damaged tasks are dropped one by one', () => {
		const good = task({ nextRunAt: 5, runs: [{ at: 1, status: 'started', threadId: 'chat' }], runCount: 1 });
		const parsed = parseSchedulesFile(JSON.parse(JSON.stringify({ version: 1, tasks: [good, { id: 'bad' }, { ...good, id: 's-2', schedule: { type: 'weekly' } }] })));
		assert.deepStrictEqual(parsed, [good]);
		assert.deepStrictEqual(parseSchedulesFile(undefined), []);
	});
});
