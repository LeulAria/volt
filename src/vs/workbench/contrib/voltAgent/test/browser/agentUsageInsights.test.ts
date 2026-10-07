/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltUsageBucket, IVoltUsageSnapshot } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { usageChartSpec, usageInsightsSpec } from '../../browser/usage/agentUsageInsights.js';
import { summarizeUsage } from '../../browser/usage/agentUsageModel.js';

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
		const spec = usageInsightsSpec(snapshot, summary, 'cost') as { charts: { type: string; title?: string; charts?: { title: string }[] }[] };
		const row = spec.charts.find(chart => chart.type === 'row')!;
		assert.deepStrictEqual(row.charts!.map(chart => chart.title), ['85% of tokens were cache reads', 'Cache hits averaged 86% of input']);
		const share = spec.charts.find(chart => chart.type === 'share')!;
		assert.strictEqual(share.title, 'claude-opus-5-5 handled 75% of your spend');
		const heat = spec.charts.find(chart => chart.type === 'heatmap')!;
		assert.ok(heat.title?.startsWith('Busiest on Tuesday around 3'), heat.title);
	});

	test('the main chart has one series per agent over every slot', () => {
		const summary = summarizeUsage(snapshot, '7d', 'tokens', now);
		const spec = usageChartSpec(summary, 'tokens', new Map([['claude', { label: 'Claude Code', color: 'var(--volt-usage-claude)' }]]), 280) as { unit: string; series: { name: string; data: [number, number][] }[] };
		assert.strictEqual(spec.unit, 'tokens');
		assert.deepStrictEqual(spec.series.map(series => [series.name, series.data.length]), [['Claude Code', 7]]);
		assert.strictEqual(spec.series[0].data.at(-1)![1], 9000 + 1000 + 100);
	});
});
