/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import type { IUsageReport, UsageGroup } from '../../shared/api';
import { api } from '../lib/api';
import { useOrg } from '../lib/data';
import { formatCount, formatMs, formatUsd } from '../lib/format';
import { useQuery } from '../lib/query';
import { Action, Select } from '../ui/controls';
import { ErrorView, type IColumn, Loading, MetricChart, Page, Section, Table } from '../ui/layout';
import { open } from '../workbench/commands';


const RANGES = [
	{ value: '7', label: 'Last 7 days' },
	{ value: '30', label: 'Last 30 days' },
	{ value: '90', label: 'Last 90 days' },
	{ value: 'month', label: 'This month' },
	{ value: 'last-month', label: 'Last month' },
];

type Row = IUsageReport['rows'][number];

/** Every UTC day of the range, zero where nothing happened, so the chart keeps its scale. */
function fillDays(from: string, to: string, rows: readonly Row[], value: (row: Row) => number): { label: string; value: number }[] {
	const byDay = new Map(rows.map(r => [r.label, r]));
	const out: { label: string; value: number }[] = [];
	for (let t = Date.parse(from.slice(0, 10)); t <= Date.parse(to); t += 86_400_000) {
		const label = new Date(t).toISOString().slice(0, 10);
		const row = byDay.get(label);
		out.push({ label, value: row ? value(row) : 0 });
	}
	return out;
}

const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function rangeOf(id: string): { from: string; to: string } {
	const now = new Date();
	if (id === 'month') {
		return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
	}
	if (id === 'last-month') {
		return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() };
	}
	return { from: new Date(Date.now() - Number(id) * 86_400_000).toISOString(), to: now.toISOString() };
}

export default function UsageEditor() {
	const { orgId } = useOrg();
	const [range, setRange] = useState('30');
	const [groupBy, setGroupBy] = useState<UsageGroup>('model');
	const { from, to } = rangeOf(range);
	const daily = useQuery(`${orgId}:usage:day:${range}`, () => api.get<IUsageReport>(`/usage?groupBy=day&from=${from}&to=${to}`));
	const report = useQuery(`${orgId}:usage:${groupBy}:${range}`, () => api.get<IUsageReport>(`/usage?groupBy=${groupBy}&from=${from}&to=${to}`));
	if (report.error) {
		return <ErrorView error={report.error} retry={report.refetch} />;
	}
	const t = report.data?.totals;
	const columns: IColumn<Row>[] = [
		{ id: 'label', title: groupBy === 'day' ? 'Day' : groupBy[0].toUpperCase() + groupBy.slice(1), sort: r => r.label, render: r => <span className={`cell-primary${groupBy === 'model' ? ' mono' : ''}`}>{r.label}</span> },
		{ id: 'requests', title: 'Requests', width: 100, align: 'right', sort: r => r.requests, render: r => formatCount(r.requests) },
		{ id: 'input', title: 'Input', width: 100, align: 'right', sort: r => r.inputTokens, render: r => formatCount(r.inputTokens) },
		{ id: 'cached', title: 'Cached', width: 100, align: 'right', sort: r => r.cacheReadTokens, render: r => formatCount(r.cacheReadTokens) },
		{ id: 'output', title: 'Output', width: 100, align: 'right', sort: r => r.outputTokens, render: r => formatCount(r.outputTokens) },
		{ id: 'tools', title: 'Tool calls', width: 100, align: 'right', sort: r => r.toolCalls, render: r => formatCount(r.toolCalls) },
		{ id: 'blocked', title: 'Blocked', width: 90, align: 'right', sort: r => r.blocked, render: r => r.blocked ? <span className="warn-text">{formatCount(r.blocked)}</span> : '0' },
		{ id: 'latency', title: 'Avg latency', width: 110, align: 'right', sort: r => r.avgLatencyMs, render: r => formatMs(r.avgLatencyMs) },
		{ id: 'cost', title: 'Cost', width: 100, align: 'right', sort: r => r.costMicros ?? -1, render: r => formatUsd(r.costMicros) },
	];
	return (
		<Page title="Usage & Cost" wide subtitle="Every request through the gateway, priced with the organization's price table (Settings → Prices). Requests with no matching price show no cost."
			actions={<>
				<Select compact value={range} onChange={setRange} options={RANGES} />
				<Action icon="refresh" label="Refresh" spin={report.loading} onClick={() => { void report.refetch(); void daily.refetch(); }} />
			</>}>
			{!report.data ? <Loading /> : (
				<>
					{daily.data ? (
						<MetricChart formatLabel={shortDay} metrics={[
							{ id: 'cost', label: 'Cost', icon: 'credit-card', value: formatUsd(t!.costMicros), sub: 'priced requests', points: fillDays(from, to, daily.data.rows, r => r.costMicros ?? 0), format: v => formatUsd(v) },
							{ id: 'requests', label: 'Requests', icon: 'pulse', value: formatCount(t!.requests), sub: `${formatCount(t!.errors)} errors · ${formatCount(t!.blocked)} blocked`, points: fillDays(from, to, daily.data.rows, r => r.requests), format: v => `${formatCount(Math.round(v))} requests` },
							{ id: 'tokens', label: 'Tokens', icon: 'symbol-key', value: formatCount(t!.inputTokens + t!.outputTokens + t!.cacheReadTokens), sub: `${formatCount(t!.cacheReadTokens)} from cache`, points: fillDays(from, to, daily.data.rows, r => r.inputTokens + r.outputTokens + r.cacheReadTokens), format: v => `${formatCount(Math.round(v))} tokens` },
							{ id: 'tools', label: 'Tool calls', icon: 'tools', value: formatCount(t!.toolCalls), sub: `avg latency ${formatMs(t!.avgLatencyMs)}`, points: fillDays(from, to, daily.data.rows, r => r.toolCalls), format: v => `${formatCount(Math.round(v))} tool calls` },
						]} />
					) : <Loading />}
					<Section title="Breakdown" actions={<Select compact value={groupBy} onChange={setGroupBy} options={[
						{ value: 'model', label: 'By model' }, { value: 'provider', label: 'By provider' }, { value: 'user', label: 'By member' },
						{ value: 'team', label: 'By team' }, { value: 'day', label: 'By day' }, { value: 'status', label: 'By outcome' },
					]} />}>
						{groupBy !== 'day' && groupBy !== 'status' && report.data.rows.length ? (() => {
							const top = Math.max(1, ...report.data.rows.map(r => r.costMicros ?? 0));
							return (
								<div className="card" style={{ marginBottom: 12 }}>
									<div className="rank">
										{[...report.data.rows].sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0)).slice(0, 6).map(r => (
											<div key={r.key} className="rank-row">
												<span className={`rank-label${groupBy === 'model' ? ' mono' : ''}`}>{r.label}</span>
												<span className="rank-value">{formatUsd(r.costMicros)} <span className="faint">· {formatCount(r.requests)} req</span></span>
												<div className="rank-bar"><span style={{ width: `${((r.costMicros ?? 0) / top) * 100}%` }} /></div>
											</div>
										))}
									</div>
								</div>
							);
						})() : null}
						<Table columns={columns} rows={report.data.rows} rowKey={r => r.key} initialSort={{ column: groupBy === 'day' ? 'label' : 'cost', desc: groupBy !== 'day' }}
							onRowClick={groupBy === 'user' ? r => open.member(r.key, r.label) : groupBy === 'team' ? r => open.team(r.key, r.label) : undefined}
							emptyIcon="graph" empty="No requests in this period." />
					</Section>
				</>
			)}
		</Page>
	);
}
