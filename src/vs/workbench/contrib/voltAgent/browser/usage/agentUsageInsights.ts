/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IVoltUsageSnapshot, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { IUsageSummary, metricValue, UsageMetric } from './agentUsageModel.js';

/**
 * Chart specs for the Usage page, drawn by the same engine as agent visuals: the main chart
 * (usage per day or hour by agent) and the Insights below it, each titled with what it found.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface IUsageSeriesStyle {
	readonly label: string;
	readonly color: string;
}

function localMidnight(ms: number): number {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function unitOf(metric: UsageMetric): string {
	return metric === 'cost' ? 'usd' : 'tokens';
}

/** Usage over the range, one line per agent, with a tooltip that lists each agent at the hovered day. */
export function usageChartSpec(summary: IUsageSummary, metric: UsageMetric, styles: ReadonlyMap<VoltUsageProvider, IUsageSeriesStyle>, height: number): object {
	const providers = summary.providers.map(row => row.provider).filter(provider => styles.has(provider));
	return {
		type: 'area',
		height,
		unit: unitOf(metric),
		x: { type: 'time' },
		legend: false,
		highlight: providers.length === 1 ? 'max' : 'none',
		empty: {
			title: localize('voltUsage.chart.emptyTitle', "No usage yet"),
			message: localize('voltUsage.chart.emptyMessage', "Usage will appear as your agents run."),
		},
		series: providers.map(provider => ({
			name: styles.get(provider)!.label,
			color: styles.get(provider)!.color,
			data: summary.slots.map(slot => {
				const totals = slot.byProvider.get(provider);
				return [slot.start, totals ? metricValue(totals, metric) : 0];
			}),
		})),
	};
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function weekdayName(day: number, long: boolean): string {
	// 2023-01-01 was a Sunday.
	return new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday: long ? 'long' : 'short' });
}

function hourName(hour: number): string {
	return new Date(2023, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s/g, '').toLowerCase();
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** One Insights card: a chart spec, and whether it takes the whole row. */
export interface IUsageInsight {
	readonly spec: { readonly type: string; readonly title: string } & Record<string, unknown>;
	readonly wide: boolean;
}

/**
 * The Insights cards, empty when the range has nothing to say. Each chart's title is the finding
 * ("Busiest on Tuesdays around 3pm"), its subtitle what was measured. Token kinds use the colors
 * of the "Tokens by type" bar above them.
 */
export function usageInsights(snapshot: IVoltUsageSnapshot, summary: IUsageSummary, metric: UsageMetric): IUsageInsight[] {
	if (!summary.providers.length) {
		return [];
	}
	const charts: IUsageInsight[] = [];
	const measure = metric === 'cost' ? localize('voltUsage.insights.spend', "spend") : localize('voltUsage.insights.tokens', "tokens");
	const starts = summary.slots.map(slot => slot.start);
	const index = new Map(starts.map((start, at) => [start, at]));
	const slotOf = (hour: number) => index.get(summary.hourly ? hour : localMidnight(hour));

	// Token mix and cache hit rate, per slot.
	const mix = { cached: starts.map(() => 0), uncached: starts.map(() => 0), cacheWrite: starts.map(() => 0), output: starts.map(() => 0) };
	summary.slots.forEach((slot, at) => {
		for (const totals of slot.byProvider.values()) {
			mix.cached[at] += totals.cached;
			mix.uncached[at] += totals.uncached;
			mix.cacheWrite[at] += totals.cacheWrite;
			mix.output[at] += totals.output;
		}
	});
	const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
	const allTokens = sum(mix.cached) + sum(mix.uncached) + sum(mix.cacheWrite) + sum(mix.output);
	const step = summary.hourly ? 'hour' : 'day';
	const x = { start: starts[0], step };
	if (allTokens > 0) {
		charts.push({
			wide: false, spec: {
				type: 'stacked-area',
				title: localize('voltUsage.insights.mixTitle', "{0} of tokens were cache reads", percent(sum(mix.cached) / allTokens)),
				subtitle: summary.hourly ? localize('voltUsage.insights.mixHourly', "Tokens per hour by kind") : localize('voltUsage.insights.mixDaily', "Tokens per day by kind"),
				unit: 'tokens',
				height: 180,
				x,
				endLabels: false,
				series: [
					{ name: localize('voltUsage.insights.cacheReads', "Cache read"), data: mix.cached, color: '--volt-usage-type-cache-read' },
					{ name: localize('voltUsage.insights.input', "Input"), data: mix.uncached, color: '--volt-usage-type-input' },
					{ name: localize('voltUsage.insights.cacheWrites', "Cache write"), data: mix.cacheWrite, color: '--volt-usage-type-cache-write' },
					{ name: localize('voltUsage.insights.output', "Output"), data: mix.output, color: '--volt-usage-type-output' },
				],
			}
		});
	}
	const input = starts.map((_, at) => mix.cached[at] + mix.uncached[at] + mix.cacheWrite[at]);
	// Only slots that had input: an idle day is no reading, and the line runs straight across it.
	const hitRate = starts.flatMap((start, at) => input[at] > 0 ? [[start, mix.cached[at] / input[at]]] : []);
	const totalInput = sum(input);
	if (totalInput > 0) {
		const average = sum(mix.cached) / totalInput;
		charts.push({
			wide: false, spec: {
				type: 'line',
				title: localize('voltUsage.insights.cacheTitle', "Cache hits averaged {0} of input", percent(average)),
				subtitle: localize('voltUsage.insights.cacheSubtitle', "Share of input read from the prompt cache. Higher is cheaper."),
				unit: 'ratio',
				height: 180,
				y: { min: 0, max: 1 },
				x: { type: 'time' },
				legend: false,
				rules: [{ y: average, label: localize('voltUsage.insights.average', "Average") }],
				series: [{ name: localize('voltUsage.insights.hitRate', "Cache hit rate"), data: hitRate, color: '--volt-usage-type-cache-read' }],
			}
		});
	}

	// Models over the range, as shares: the top five and the rest.
	const byModel = new Map<string, number[]>();
	for (const bucket of snapshot.buckets) {
		const at = slotOf(bucket.hour);
		if (at === undefined) {
			continue;
		}
		const value = metric === 'cost' ? bucket.costUsd : bucket.uncached + bucket.cached + bucket.cacheWrite + bucket.output;
		let values = byModel.get(bucket.model);
		if (!values) {
			values = starts.map(() => 0);
			byModel.set(bucket.model, values);
		}
		values[at] += value;
	}
	const models = [...byModel].map(([model, values]) => ({ model, values, total: sum(values) })).filter(item => item.total > 0).sort((a, b) => b.total - a.total);
	if (models.length > 1 && starts.length > 1) {
		const top = models.slice(0, 5);
		const rest = models.slice(5);
		const whole = sum(models.map(item => item.total));
		const lines = top.map(item => ({ name: item.model, values: item.values, color: undefined as string | undefined }));
		if (rest.length) {
			lines.push({ name: localize('voltUsage.insights.other', "Other"), values: starts.map((_, at) => sum(rest.map(item => item.values[at]))), color: 'muted' });
		}
		// A 100% bar per slot rather than a smoothed band: idle days stay empty instead of bridging
		// into blocks, and a day carried by one small model reads as one day.
		const slotTotals = starts.map((_, at) => sum(lines.map(line => line.values[at])));
		const series = lines.map(line => ({
			name: line.name,
			color: line.color,
			data: line.values.map((value, at) => slotTotals[at] > 0 ? (value / slotTotals[at]) * 100 : null),
		}));
		charts.push({
			wide: true, spec: {
				type: 'stacked-bar',
				title: localize('voltUsage.insights.modelsTitle', "{0} handled {1} of your {2}", top[0].model, percent(top[0].total / whole), measure),
				subtitle: localize('voltUsage.insights.modelsSubtitle', "Share of {0} per {1}, by model.", measure, summary.hourly ? localize('voltUsage.insights.hour', "hour") : localize('voltUsage.insights.day', "day")),
				unit: 'percent',
				height: 200,
				y: { min: 0, max: 100 },
				x,
				series,
			}
		});
	}

	// When you work: the whole history, by weekday and hour in local time.
	const grid = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
	let gridTotal = 0;
	for (const bucket of snapshot.buckets) {
		const date = new Date(bucket.hour);
		const value = metric === 'cost' ? bucket.costUsd : bucket.uncached + bucket.cached + bucket.cacheWrite + bucket.output;
		grid[WEEKDAYS.indexOf(date.getDay())][date.getHours()] += value;
		gridTotal += value;
	}
	if (gridTotal > 0) {
		let peakRow = 0;
		let peakHour = 0;
		grid.forEach((line, r) => line.forEach((value, hour) => {
			if (value > grid[peakRow][peakHour]) {
				peakRow = r;
				peakHour = hour;
			}
		}));
		const weekdays = sum(grid.slice(0, 5).map(sum)) / 5;
		const weekends = sum(grid.slice(5).map(sum)) / 2;
		charts.push({
			wide: true, spec: {
				type: 'heatmap',
				title: localize('voltUsage.insights.peakTitle', "Busiest on {0} around {1}", weekdayName(WEEKDAYS[peakRow], true), hourName(peakHour)),
				subtitle: weekdays > 0
					? localize('voltUsage.insights.peakSubtitle', "{0} by weekday and hour in your time zone, last {1} days. Weekends run at {2} of weekdays.", measure.charAt(0).toUpperCase() + measure.slice(1), Math.round((snapshot.generatedAt - snapshot.sinceMs) / (24 * HOUR_MS)), percent(weekends / weekdays))
					: localize('voltUsage.insights.peakSubtitleShort', "{0} by weekday and hour in your time zone.", measure.charAt(0).toUpperCase() + measure.slice(1)),
				unit: unitOf(metric),
				rows: WEEKDAYS.map(day => weekdayName(day, false)),
				columns: Array.from({ length: 24 }, (_, hour) => hourName(hour)),
				values: grid,
			}
		});
	}
	return charts;
}
