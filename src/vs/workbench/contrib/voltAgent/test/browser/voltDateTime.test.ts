/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	addDays,
	addMonths,
	calendarWeeks,
	combineDayAndTime,
	minutesOfDay,
	parseTimeInput,
	roundUpToStep,
	sameDay,
	startOfDay,
	timeSlots,
	weekdayLabels,
} from '../../browser/ui/dateTime/voltDateTime.js';

suite('Volt date and time fields model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const at = (year: number, month: number, day: number, hours = 0, minutes = 0) => new Date(year, month, day, hours, minutes).getTime();

	test('a month is six full weeks from the locale week start', () => {
		const now = at(2026, 9, 4, 10, 16);
		const monday = calendarWeeks(at(2026, 9, 15), { now, weekStart: 1 });
		assert.strictEqual(monday.length, 6);
		assert.ok(monday.every(week => week.length === 7));
		// October 2026 starts on a Thursday: Mon Sep 28 opens the grid.
		assert.strictEqual(monday[0][0].date, at(2026, 8, 28));
		assert.deepStrictEqual(monday[0].map(day => day.inMonth), [false, false, false, true, true, true, true]);
		assert.strictEqual(monday[0][6].day, 4);
		assert.ok(monday[0][6].today);
		assert.strictEqual(monday.flat().filter(day => day.today).length, 1);

		const sunday = calendarWeeks(at(2026, 9, 1), { now, weekStart: 0 });
		assert.strictEqual(sunday[0][0].date, at(2026, 8, 27));

		// A month that starts on the week start still leads with its first day.
		const february = calendarWeeks(at(2026, 1, 10), { now, weekStart: 0 });
		assert.strictEqual(february[0][0].date, at(2026, 1, 1));
	});

	test('days before the minimum are disabled', () => {
		const now = at(2026, 9, 4, 10, 16);
		const days = calendarWeeks(now, { now, min: now, weekStart: 1 }).flat();
		assert.ok(days.filter(day => day.date < at(2026, 9, 4)).every(day => day.disabled));
		assert.ok(days.filter(day => day.date >= at(2026, 9, 4)).every(day => !day.disabled));
	});

	test('calendar steps are calendar units, also across DST', () => {
		// US DST began 2026-03-08; a day is still one calendar day.
		assert.strictEqual(addDays(at(2026, 2, 7), 1), at(2026, 2, 8));
		assert.strictEqual(addDays(at(2026, 2, 8), 1), at(2026, 2, 9));
		assert.strictEqual(addDays(at(2026, 0, 1), -1), at(2025, 11, 31));
		assert.strictEqual(addMonths(at(2026, 0, 31), 1), at(2026, 1, 28), 'clamps to the end of February');
		assert.strictEqual(addMonths(at(2026, 11, 15), 1), at(2027, 0, 15));
		assert.ok(sameDay(at(2026, 9, 4, 0, 0), at(2026, 9, 4, 23, 59)));
		assert.strictEqual(startOfDay(at(2026, 9, 4, 18, 30)), at(2026, 9, 4));
	});

	test('day and time combine in local time', () => {
		assert.strictEqual(combineDayAndTime(at(2026, 9, 4), 11 * 60 + 30), at(2026, 9, 4, 11, 30));
		assert.strictEqual(combineDayAndTime(at(2026, 9, 4, 15, 0), 0), at(2026, 9, 4), 'any moment of the day works');
		assert.strictEqual(minutesOfDay(at(2026, 9, 4, 18, 45)), 18 * 60 + 45);
	});

	test('rounding up to the next quarter hour', () => {
		assert.strictEqual(roundUpToStep(at(2026, 9, 4, 11, 16), 15), at(2026, 9, 4, 11, 30));
		assert.strictEqual(roundUpToStep(at(2026, 9, 4, 11, 30), 15), at(2026, 9, 4, 11, 30));
		assert.strictEqual(roundUpToStep(at(2026, 9, 4, 11, 30) + 5_000, 15), at(2026, 9, 4, 11, 45), 'seconds past count');
		assert.strictEqual(roundUpToStep(at(2026, 9, 4, 23, 50), 15), at(2026, 9, 5, 0, 0), 'rolls into tomorrow');
	});

	test('time slots every step, with an off-step pick kept in order', () => {
		const slots = timeSlots(15);
		assert.strictEqual(slots.length, 96);
		assert.strictEqual(slots[1], 15);
		assert.strictEqual(slots.at(-1), 23 * 60 + 45);
		const withPick = timeSlots(15, 11 * 60 + 16);
		assert.strictEqual(withPick.length, 97);
		assert.strictEqual(withPick[withPick.indexOf(11 * 60 + 16) - 1], 11 * 60 + 15);
		assert.strictEqual(timeSlots(15, 11 * 60 + 15).length, 96, 'an on-step pick is not added twice');
	});

	test('typed times', () => {
		const cases: [string, number | undefined][] = [
			['9', 9 * 60],
			['09', 9 * 60],
			['21', 21 * 60],
			['930', 9 * 60 + 30],
			['2130', 21 * 60 + 30],
			['9:30', 9 * 60 + 30],
			['09.30', 9 * 60 + 30],
			['21h30', 21 * 60 + 30],
			['9pm', 21 * 60],
			['9 PM', 21 * 60],
			['9:30 p.m.', 21 * 60 + 30],
			['9:30a', 9 * 60 + 30],
			['12am', 0],
			['12:15 AM', 15],
			['12pm', 12 * 60],
			['11:16 AM', 11 * 60 + 16],
			['noon', 12 * 60],
			['Midnight', 0],
			['0:00', 0],
			['23:59', 23 * 60 + 59],
			['24:00', undefined],
			['13pm', undefined],
			['0am', undefined],
			['9:60', undefined],
			['9:5', undefined],
			['12345', undefined],
			['pm', undefined],
			['', undefined],
			['soon', undefined],
		];
		for (const [text, expected] of cases) {
			assert.strictEqual(parseTimeInput(text), expected, text);
		}
	});

	test('weekday headers follow the week start', () => {
		const monday = weekdayLabels(1, 'en-US');
		assert.strictEqual(monday.length, 7);
		assert.strictEqual(monday[0].long, 'Monday');
		assert.strictEqual(monday[6].long, 'Sunday');
		assert.strictEqual(weekdayLabels(0, 'en-US')[0].long, 'Sunday');
	});
});
