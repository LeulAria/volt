/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { describeCron, nextCronRun, parseCron } from '../../../common/automations/automationCron.js';
import { describeTrigger, nextRunsPreview, nextScheduleAt } from '../../../common/automations/automations.js';
import { formatGmtOffset, isLocalTimeZone, isValidTimeZone, timeZoneLabel, timeZoneList, wallClock } from '../../../common/automations/automationTime.js';

const utc = (text: string) => Date.parse(text);

suite('Volt automation time zones', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wall clock in a zone: parts, offsets, and the moment a wall time names', () => {
		const ny = wallClock('America/New_York');
		assert.deepStrictEqual(ny.parts(utc('2026-07-01T13:05:09Z')), { year: 2026, month: 7, day: 1, hour: 9, minute: 5, second: 9, weekday: 3 });
		assert.strictEqual(ny.offset(utc('2026-01-15T12:00:00Z')), -300);
		assert.strictEqual(ny.offset(utc('2026-07-15T12:00:00Z')), -240);
		assert.strictEqual(wallClock('Europe/Berlin').epoch(2026, 7, 1, 9, 0), utc('2026-07-01T07:00:00Z'));
		assert.strictEqual(wallClock('Asia/Kolkata').epoch(2026, 11, 2, 9, 30), utc('2026-11-02T04:00:00Z'));
		// Overflow carries: hour 24 is the next day's midnight.
		assert.strictEqual(wallClock('Europe/Berlin').epoch(2026, 1, 31, 24, 0), utc('2026-01-31T23:00:00Z'));
	});

	test('daylight saving: a skipped time moves forward, a repeated one takes its first pass', () => {
		const ny = wallClock('America/New_York');
		// 2026-03-08 02:00 EST jumps to 03:00 EDT: 02:30 does not exist and lands at 03:30 EDT.
		assert.strictEqual(ny.epoch(2026, 3, 8, 2, 30), utc('2026-03-08T07:30:00Z'));
		assert.strictEqual(ny.parts(ny.epoch(2026, 3, 8, 2, 30)).hour, 3);
		// 2026-11-01 02:00 EDT falls back to 01:00 EST: 01:30 happens twice; the first is EDT.
		assert.strictEqual(ny.epoch(2026, 11, 1, 1, 30), utc('2026-11-01T05:30:00Z'));
		assert.strictEqual(ny.epoch(2026, 11, 1, 3, 0), utc('2026-11-01T08:00:00Z'));
	});

	test('zone names: validity, labels, the list', () => {
		assert.ok(isValidTimeZone('Europe/Berlin'));
		assert.ok(!isValidTimeZone('Mars/Olympus_Mons'));
		assert.ok(!isValidTimeZone(''));
		assert.ok(isLocalTimeZone(undefined));
		assert.strictEqual(timeZoneLabel('Europe/Berlin', utc('2026-01-15T12:00:00Z')), 'GMT+1 · Berlin');
		assert.strictEqual(timeZoneLabel('America/New_York', utc('2026-07-15T12:00:00Z')), 'GMT-4 · New York');
		assert.strictEqual(timeZoneLabel('Asia/Kolkata', 0), 'GMT+5:30 · Kolkata');
		assert.strictEqual(timeZoneLabel('UTC', 0), 'GMT');
		assert.strictEqual(formatGmtOffset(-570), 'GMT-9:30');
		const zones = timeZoneList();
		assert.strictEqual(zones[0], 'UTC');
		assert.ok(zones.includes('America/New_York') && zones.includes('Asia/Tokyo'));
		// An unknown zone reads as local time instead of failing.
		assert.strictEqual(wallClock('Nope/Nowhere').zone, undefined);
	});

	test('cron in a zone: every 5 minutes, weekdays at 09:00, a skipped 02:30', () => {
		const every5 = parseCron('*/5 * * * *').schedule!;
		assert.strictEqual(nextCronRun(every5, utc('2026-11-02T10:03:20Z'), 'Asia/Kolkata'), utc('2026-11-02T10:05:00Z'));
		assert.strictEqual(nextCronRun(every5, utc('2026-11-02T10:05:00Z'), 'Asia/Kolkata'), utc('2026-11-02T10:10:00Z'));
		const weekdays = parseCron('0 9 * * 1-5').schedule!;
		// Friday 2026-11-06 10:00 in New York: next is Monday 09:00 EST.
		assert.strictEqual(nextCronRun(weekdays, utc('2026-11-06T15:00:00Z'), 'America/New_York'), utc('2026-11-09T14:00:00Z'));
		const nightly = parseCron('30 2 * * *').schedule!;
		// 02:30 does not exist on 2026-03-08 in New York; the next one is the day after, in EDT.
		assert.strictEqual(nextCronRun(nightly, utc('2026-03-07T12:00:00Z'), 'America/New_York'), utc('2026-03-09T06:30:00Z'));
	});

	test('schedules in a zone across daylight saving', () => {
		// Berlin leaves summer time on 2026-10-25: 09:00 is 07:00Z the day before, 08:00Z that day.
		assert.strictEqual(nextScheduleAt({ type: 'daily', time: '09:00' }, utc('2026-10-24T06:00:00Z'), 'Europe/Berlin'), utc('2026-10-24T07:00:00Z'));
		assert.strictEqual(nextScheduleAt({ type: 'daily', time: '09:00' }, utc('2026-10-24T08:00:00Z'), 'Europe/Berlin'), utc('2026-10-25T08:00:00Z'));
		// Hourly at :30 through New York's repeated hour runs at both 01:30s.
		const hourly = { type: 'hourly', minute: 30 } as const;
		assert.strictEqual(nextScheduleAt(hourly, utc('2026-11-01T05:00:00Z'), 'America/New_York'), utc('2026-11-01T05:30:00Z'));
		assert.strictEqual(nextScheduleAt(hourly, utc('2026-11-01T05:40:00Z'), 'America/New_York'), utc('2026-11-01T06:30:00Z'));
		// Weekly in Tokyo: Monday 09:00 JST is Sunday 00:00Z.
		assert.strictEqual(nextScheduleAt({ type: 'weekly', weekdays: [1], time: '09:00' }, utc('2026-11-04T00:00:00Z'), 'Asia/Tokyo'), utc('2026-11-09T00:00:00Z'));
	});

	test('nextRunsPreview', () => {
		const after = utc('2026-11-02T10:00:00Z');
		assert.deepStrictEqual(nextRunsPreview({ type: 'interval', everyMs: 5 * 60_000 }, after, 3), [after + 300_000, after + 600_000, after + 900_000]);
		assert.deepStrictEqual(nextRunsPreview({ type: 'cron', expr: '0 9 * * *' }, after, 3, 'Asia/Tokyo'), [utc('2026-11-03T00:00:00Z'), utc('2026-11-04T00:00:00Z'), utc('2026-11-05T00:00:00Z')]);
		assert.deepStrictEqual(nextRunsPreview({ type: 'once', at: after + 60_000 }, after, 3), [after + 60_000]);
		assert.deepStrictEqual(nextRunsPreview({ type: 'cron', expr: 'nope' }, after, 3), []);
	});

	test('describeTrigger names a zone that is not local; describeCron reads minute-level shapes', () => {
		const at = utc('2026-11-02T10:00:00Z');
		const zoned = describeTrigger({ id: 't', provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '09:00' }, timezone: 'Pacific/Kiritimati' }, at);
		assert.strictEqual(zoned, isLocalTimeZone('Pacific/Kiritimati') ? 'Every day at 09:00' : 'Every day at 09:00 (GMT+14 · Kiritimati)');
		assert.strictEqual(describeTrigger({ id: 't', provider: 'schedule', event: 'minutes', schedule: { type: 'interval', everyMs: 300_000 }, timezone: 'Pacific/Kiritimati' }, at), 'Every 5 minutes');
		assert.strictEqual(describeCron('*/5 * * * *'), 'Every 5 minutes');
		assert.strictEqual(describeCron('* * * * *'), 'Every minute');
		assert.strictEqual(describeCron('*/15 9-17 * * 1-5'), 'Every 15 minutes, 9:00–17:59 on weekdays');
		assert.strictEqual(describeCron('30 * * * *'), 'At :30 every hour');
		assert.strictEqual(describeCron('0 */2 * * *'), 'Every 2 hours');
		assert.strictEqual(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
		assert.strictEqual(describeCron('0 9,17 * * *'), 'Every day at 09:00 and 17:00');
		assert.strictEqual(describeCron('0 9 * * 1'), 'Every Monday at 09:00');
		assert.strictEqual(describeCron('0 9 * * 1,3,5'), 'Mon, Wed, Fri at 09:00');
		assert.strictEqual(describeCron('0 9 1 * *'), 'Monthly on day 1 at 09:00');
		assert.strictEqual(describeCron('*/5 * * * 0,6'), 'Every 5 minutes on weekends');
		assert.strictEqual(describeCron('@daily'), 'Every day at 00:00');
		assert.strictEqual(describeCron('0 0 1 1 *'), 'Cron 0 0 1 1 *');
		assert.strictEqual(describeCron('61 * * * *'), '61 * * * *');
	});
});
