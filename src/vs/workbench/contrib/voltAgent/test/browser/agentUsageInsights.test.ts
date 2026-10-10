/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltUsageBucket, IVoltUsageSnapshot } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { usageChartSpec, usageInsights } from '../../browser/usage/agentUsageInsights.js';
import { summarizeUsage } from '../../browser/usage/agentUsageModel.js';
import { usageCalendar } from '../../browser/usage/agentUsageCalendar.js';

function bucket(hour: number, model: string, cached: number, uncached: number, costUsd: number): IVoltUsageBucket {
	return {
		provider: 'claude', model, hour, uncached, cached, cacheWrite: 0, output: 100, costUsd, savingsUsd: 0, unpriced: false,
		inputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: 0, fastCostUsd: 0, ultrafastCostUsd: 0, speedPremiumUsd: 0,
	};
}

suite('Usage insights', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Tuesday 2026-10-06 15:00 local and the day before.
	const now = new Date(2026, 9, 6, 18).getTime();
	const tuesday3pm = new Date(2026, 9, 6, 15).getTime();
	const monday9am = new Date(2026, 9, 5, 9).getTime();
	const snapshot: IVoltUsageSnapshot = {
		generatedAt: now, sinceMs: now - 90 * 86_400_000, sessionCount: 2, notes: [], pricingSource: 'test',
		buckets: [bucket(tuesday3pm, 'claude-opus-5-5', 9000, 1000, 6), bucket(monday9am, 'claude-sonnet-5-5', 3000, 1000, 2)],
		activity: [{ provider: 'claude', hour: tuesday3pm, sessions: [0] }, { provider: 'claude', hour: monday9am, sessions: [1] }],
	};

	test('titles each insight with its finding', () => {
		const summary = summarizeUsage(snapshot, '7d', 'cost', now);
		const insights = usageInsights(snapshot, summary, 'cost');
		assert.deepStrictEqual(insights.filter(insight => !insight.wide).map(insight => insight.spec.title), ['85% of tokens were cache reads', 'Cache hits averaged 86% of input']);
		const models = insights.find(insight => insight.spec.type === 'stacked-bar')!;
		assert.strictEqual(models.spec.title, 'claude-opus-5-5 handled 75% of your spend');
		assert.ok(models.wide);
	});

	test('the activity calendar lays days out in Sunday-first weeks with streaks and peaks', () => {
		const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
		const days: IVoltUsageSnapshot = {
			...snapshot,
			// Oct 1-3 in a row, Oct 5 the busiest, nothing on Oct 4 or today (Oct 6).
			buckets: [bucket(at(1, 10), 'a', 10, 0, 1), bucket(at(2, 10), 'a', 10, 0, 2), bucket(at(3, 10), 'a', 10, 0, 3), bucket(at(5, 15), 'a', 10, 0, 40)],
		};
		const calendar = usageCalendar(days, now);
		assert.strictEqual(calendar.activeDays, 4);
		assert.strictEqual(calendar.longestStreak, 3);
		// Today is empty, so the streak runs back from yesterday.
		assert.strictEqual(calendar.currentStreak, 1);
		assert.strictEqual(calendar.busiest?.start, new Date(2026, 9, 5).getTime());
		assert.deepStrictEqual(calendar.peak, { weekday: 1, hour: 15 });
		assert.ok(calendar.weeks.every(week => week.length === 7));
		// Today (a Tuesday) is the last day; the rest of its week is outside the history.
		const last = calendar.weeks.at(-1)!;
		assert.strictEqual(last[2]?.start, new Date(2026, 9, 6).getTime());
		assert.strictEqual(last[3], undefined);
		const levels = calendar.weeks.flat().filter(day => day && day.level).map(day => day!.level);
		assert.deepStrictEqual(levels, [1, 2, 3, 4]);
	});

	test('the main chart has one series per agent over every slot', () => {
		const summary = summarizeUsage(snapshot, '7d', 'tokens', now);
		const spec = usageChartSpec(summary, 'tokens', new Map([['claude', { label: 'Claude Code', color: 'var(--volt-usage-claude)' }]]), 280) as { unit: string; series: { name: string; data: [number, number][] }[] };
		assert.strictEqual(spec.unit, 'tokens');
		assert.deepStrictEqual(spec.series.map(series => [series.name, series.data.length]), [['Claude Code', 7]]);
		assert.strictEqual(spec.series[0].data.at(-1)![1], 9000 + 1000 + 100);
	});
});
