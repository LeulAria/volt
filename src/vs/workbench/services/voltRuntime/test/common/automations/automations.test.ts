/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	defaultSchedule, describeSchedule, dueSchedules, IAutomation, IAutomationTrigger, nextScheduleAt, parseSchedule, parseScheduleText, planNextRuns, SCHEDULE_MISSED_GRACE_MS,
	scheduleKindOf, scheduleSaveError, validateSchedule,
} from '../../../common/automations/automations.js';

const HOUR = 3_600_000;
const local = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

function withTrigger(trigger: IAutomationTrigger, nextRuns: Record<string, number> = {}): IAutomation {
	return { id: 'a', name: 'A', instructions: '', enabled: true, triggers: [trigger], repositories: [], tools: [], createdAt: 0, updatedAt: 0, createdBy: 'You', nextRuns, runs: [], runCount: 0 };
}

suite('Volt automation schedules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('one-time: next run, validation, description, persistence', () => {
		const at = local(4, 9);
		const once = { type: 'once', at } as const;
		assert.strictEqual(nextScheduleAt(once, at - 1), at);
		assert.strictEqual(nextScheduleAt(once, at), undefined);
		assert.strictEqual(validateSchedule(once), undefined);
		assert.strictEqual(validateSchedule(once, at + 1), 'This time has passed.');
		assert.strictEqual(validateSchedule({ type: 'once', at: Number.NaN }), 'Pick a date and time.');
		// 2026-11-04 is a Wednesday.
		assert.strictEqual(describeSchedule(once, undefined, local(2)), 'Once on Wed, Nov 4 at 09:00');
		assert.strictEqual(describeSchedule(once, undefined, new Date(2027, 0, 1).getTime()), 'Once on Wed, Nov 4, 2026 at 09:00');
		assert.deepStrictEqual(parseSchedule({ type: 'once', at }), once);
		assert.strictEqual(parseSchedule({ type: 'once', at: 'soon' }), undefined);
		assert.strictEqual(scheduleKindOf(once), 'once');
		assert.deepStrictEqual(defaultSchedule('once', local(2, 10, 17)), { type: 'once', at: local(2, 11) });
	});

	test('one-time on Save: new or moved into the past is an error, one that already ran is kept', () => {
		const trigger: IAutomationTrigger = { id: 't', provider: 'schedule', event: 'once', schedule: { type: 'once', at: local(2, 9) } };
		const now = local(3);
		assert.strictEqual(scheduleSaveError(trigger, undefined, now), 'This time has passed.');
		assert.strictEqual(scheduleSaveError(trigger, [trigger], now), undefined);
		assert.strictEqual(scheduleSaveError(trigger, [{ ...trigger, schedule: { type: 'once', at: local(1, 9) } }], now), 'This time has passed.');
		assert.strictEqual(scheduleSaveError({ ...trigger, schedule: { type: 'once', at: local(4, 9) } }, undefined, now), undefined);
	});

	test('one-time: planned while ahead, run once, never again; missed past the grace is skipped', () => {
		const at = local(4, 9);
		const trigger: IAutomationTrigger = { id: 't', provider: 'schedule', event: 'once', schedule: { type: 'once', at } };
		assert.deepStrictEqual(planNextRuns(withTrigger(trigger), local(3)), { t: at });
		assert.deepStrictEqual(planNextRuns(withTrigger(trigger), at + 1), {});
		assert.deepStrictEqual(dueSchedules(withTrigger(trigger, { t: at }), at + 1000), [{ triggerId: 't', kind: 'run', next: undefined, due: at }]);
		assert.deepStrictEqual(dueSchedules(withTrigger(trigger, { t: at }), at + SCHEDULE_MISSED_GRACE_MS + HOUR), [{ triggerId: 't', kind: 'skip', next: undefined, due: at }]);
		// After it ran (no next run), an edit elsewhere does not plan it again.
		assert.deepStrictEqual(planNextRuns(withTrigger(trigger), at + HOUR, { triggers: [trigger], nextRuns: {} }), {});
		// A zone change re-plans even when the schedule is the same.
		const daily: IAutomationTrigger = { id: 'd', provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '09:00' } };
		const kept = planNextRuns(withTrigger(daily), local(3), { triggers: [daily], nextRuns: { d: local(5, 9) } });
		assert.deepStrictEqual(kept, { d: local(5, 9) });
		const moved = planNextRuns(withTrigger({ ...daily, timezone: 'Pacific/Kiritimati' }), local(3), { triggers: [daily], nextRuns: { d: local(5, 9) } });
		assert.notStrictEqual(moved.d, local(5, 9));
	});

	test('intervals: minute-level, missed ones run once and go on from now', () => {
		const trigger: IAutomationTrigger = { id: 't', provider: 'schedule', event: 'minutes', schedule: { type: 'interval', everyMs: 5 * 60_000 } };
		const now = local(4, 12);
		assert.deepStrictEqual(planNextRuns(withTrigger(trigger), now), { t: now + 5 * 60_000 });
		// Volt was closed for two days: one run, then every 5 minutes from now.
		assert.deepStrictEqual(dueSchedules(withTrigger(trigger, { t: now - 48 * HOUR }), now), [{ triggerId: 't', kind: 'run', next: now + 5 * 60_000, due: now - 48 * HOUR }]);
		assert.strictEqual(validateSchedule({ type: 'interval', everyMs: 30_000 }), 'Runs at most once a minute.');
		assert.strictEqual(scheduleKindOf({ type: 'interval', everyMs: 60_000 }), 'minutes');
		// "Every few minutes" starts at 15 minutes (as #64 chose); 1-minute steps stay a pick away.
		assert.deepStrictEqual(defaultSchedule('minutes'), { type: 'interval', everyMs: 15 * 60_000 });
		assert.strictEqual(describeSchedule({ type: 'interval', everyMs: 15 * 60_000 }), 'Every 15 minutes');
	});

	test('schedules from words: minutes, one-time dates, relative times', () => {
		const now = local(2, 10, 7);
		assert.deepStrictEqual(parseScheduleText('every 5 minutes', now).schedule, { type: 'interval', everyMs: 5 * 60_000 });
		assert.deepStrictEqual(parseScheduleText('every minute', now).schedule, { type: 'interval', everyMs: 60_000 });
		assert.deepStrictEqual(parseScheduleText('every 15m', now).schedule, { type: 'interval', everyMs: 15 * 60_000 });
		assert.deepStrictEqual(parseScheduleText('once at 2026-11-04 09:00', now).schedule, { type: 'once', at: local(4, 9) });
		assert.deepStrictEqual(parseScheduleText('on 2026-11-04 at 9:30', now).schedule, { type: 'once', at: local(4, 9, 30) });
		assert.deepStrictEqual(parseScheduleText('tomorrow at 08:15', now).schedule, { type: 'once', at: local(3, 8, 15) });
		assert.deepStrictEqual(parseScheduleText('in 30 minutes', now).schedule, { type: 'once', at: local(2, 10, 37) });
		assert.ok(parseScheduleText('once at 2026-11-01 09:00', now).error?.includes('already passed'));
		assert.ok(parseScheduleText('once at 2026-02-30 09:00', now).error?.startsWith('Could not read'));
		assert.deepStrictEqual(parseScheduleText('*/5 * * * *', now).schedule, { type: 'cron', expr: '*/5 * * * *' });
	});
});
