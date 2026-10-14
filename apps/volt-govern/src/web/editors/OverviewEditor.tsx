/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useOrg, useOverview, useRequests } from '../lib/data';
import { formatCount, formatMs, formatUsd, timeAgo } from '../lib/format';
import { Action, Button, Tag } from '../ui/controls';
import { Codicon, type CodiconName } from '../ui/icons';
import { ErrorView, Loading, MetricChart, Page, Sparkline } from '../ui/layout';
import { open } from '../workbench/commands';

const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function StatTile({ icon, label, value, sub, trend, onClick }: { readonly icon: CodiconName; readonly label: string; readonly value: string; readonly sub?: string; readonly trend?: readonly number[]; readonly onClick: () => void }) {
	return (
		<button type="button" className="tile" onClick={onClick}>
			<div className="tile-label"><Codicon name={icon} />{label}<Codicon name="arrow-right" className="go" /></div>
			<div className="tile-value">{value}</div>
			{sub ? <div className="tile-sub">{sub}</div> : null}
			{trend ? <Sparkline values={trend} /> : null}
		</button>
	);
}

export default function OverviewEditor() {
	const { orgId, orgName, can } = useOrg();
	const { data, error, refetch, loading } = useOverview(orgId);
	const requests = useRequests(can({ usage: ['read'] }) ? orgId : '');
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const steps = Object.values(data.setup);
	const done = steps.filter(Boolean).length;
	const blockedShare = data.requests30d ? Math.round((data.blocked30d / data.requests30d) * 100) : 0;
	const topSpend = Math.max(1, ...data.topModels.map(m => m.costMicros));
	const orgRows: { icon: CodiconName; label: string; value: number; sub?: string; run: () => void }[] = [
		{ icon: 'organization', label: 'Members', value: data.members, run: () => open.members() },
		{ icon: 'type-hierarchy', label: 'Teams', value: data.teams, run: () => open.members() },
		{ icon: 'key', label: 'Provider keys', value: data.credentials, run: () => open.credentials() },
		{ icon: 'library', label: 'Published skills', value: data.skills, run: () => open.skills() },
	];
	return (
		<Page title={orgName} subtitle="Gateway activity across the organization over the last 30 days." wide
			actions={<>
				<Action icon="refresh" label="Refresh" spin={loading} onClick={() => void refetch()} />
				<Button icon="beaker" onClick={() => open.playground()}>Try the Gateway</Button>
			</>}>
			{done < steps.length ? (
				<div className="setup-banner">
					<span className="setup-icon"><Codicon name="rocket" /></span>
					<div className="setup-text">
						<div className="setup-title">Finish setting up {orgName}</div>
						<div className="setup-sub">{steps.length - done} step{steps.length - done === 1 ? '' : 's'} left: single sign-on, provisioning and the policy keep developers on governed access.</div>
					</div>
					<span className="setup-count">{done} of {steps.length}</span>
					<div className="progress-line"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
					<Button size="sm" variant="primary" onClick={() => open.welcome()}>Continue</Button>
				</div>
			) : null}

			<MetricChart formatLabel={shortDay} metrics={[
				{ id: 'spend', label: 'Spend', icon: 'credit-card', value: formatUsd(data.spend30dMicros), sub: 'priced requests', points: data.daily.map(d => ({ label: d.day, value: d.costMicros })), format: v => formatUsd(v) },
				{ id: 'requests', label: 'Requests', icon: 'pulse', value: formatCount(data.requests30d), sub: `${formatCount(data.blocked30d)} blocked`, points: data.daily.map(d => ({ label: d.day, value: d.requests })), format: v => `${formatCount(Math.round(v))} requests` },
				{ id: 'tokens', label: 'Tokens', icon: 'symbol-key', value: formatCount(data.tokens30d), sub: 'input, output and cache', points: data.daily.map(d => ({ label: d.day, value: d.tokens })), format: v => `${formatCount(Math.round(v))} tokens` },
			]} />

			<div className="tiles four" style={{ marginTop: 12 }}>
				<StatTile icon="person" label="Active developers" value={formatCount(data.activeUsers30d)} sub={`of ${formatCount(data.members)} members`} onClick={() => open.members()} />
				<StatTile icon="circle-slash" label="Blocked by policy" value={formatCount(data.blocked30d)} sub={`${blockedShare}% of requests`} onClick={() => open.requests()} />
				<StatTile icon="device-desktop" label="Devices" value={formatCount(data.devices)} sub="signed in to Volt" onClick={() => open.devices()} />
				<StatTile icon="mcp" label="MCP servers" value={formatCount(data.mcpApproved)} sub={data.mcpPending ? `${data.mcpPending} waiting for review` : 'approved'} onClick={() => open.mcp()} />
			</div>

			<div className="grid-2" style={{ marginTop: 12 }}>
				<div className="card">
					<div className="card-title">Top models <span className="card-sub">by spend</span><span className="actions"><Button size="sm" variant="ghost" onClick={() => open.usage()}>Usage</Button></span></div>
					{data.topModels.length ? (
						<div className="rank">
							{[...data.topModels].sort((a, b) => b.costMicros - a.costMicros).slice(0, 6).map(m => (
								<div key={m.model} className="rank-row">
									<span className="rank-label mono">{m.model}</span>
									<span className="rank-value">{formatUsd(m.costMicros)} <span className="faint">· {formatCount(m.requests)}</span></span>
									<div className="rank-bar"><span style={{ width: `${(m.costMicros / topSpend) * 100}%` }} /></div>
								</div>
							))}
						</div>
					) : <div className="muted" style={{ fontSize: 12.5 }}>No model traffic yet.</div>}
				</div>
				<div className="card">
					<div className="card-title">Recent requests <span className="actions"><Button size="sm" variant="ghost" onClick={() => open.requests()}>View All</Button></span></div>
					{requests.data?.length ? (
						<div className="rank">
							{requests.data.slice(0, 6).map(r => (
								<div key={r.id} className="feed-row">
									<Tag tone={r.status === 'ok' ? 'ok' : r.status === 'blocked' ? 'err' : 'warn'}>{r.status}</Tag>
									<div className="feed-main">
										<span className="feed-title mono" style={{ fontSize: 12 }}>{r.provider}/{r.model}</span>
										<span className="feed-sub">{r.userName ?? r.userId.slice(0, 8)} · {r.reason ?? `${formatCount(r.inputTokens)} → ${formatCount(r.outputTokens)} tokens · ${formatMs(r.latencyMs)}`}</span>
									</div>
									<span className="feed-meta">{formatUsd(r.costMicros)}<br /><span className="faint">{timeAgo(r.createdAt)}</span></span>
								</div>
							))}
						</div>
					) : <div className="muted" style={{ fontSize: 12.5 }}>Requests appear here as developers use Volt, or as you try the gateway.</div>}
				</div>
			</div>

			<div className="grid-2" style={{ marginTop: 12 }}>
				<div className="card">
					<div className="card-title">Alerts <span className="actions"><Button size="sm" variant="ghost" onClick={() => open.alerts()}>All Alerts</Button></span></div>
					{data.alerts.length ? (
						<div className="rank">
							{data.alerts.slice(0, 5).map(a => (
								<div key={a.id} className="feed-row">
									<Codicon name={a.severity === 'error' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'} className={a.severity === 'error' ? 'err-text' : a.severity === 'warning' ? 'warn-text' : 'muted'} />
									<div className="feed-main"><span className="feed-title" style={{ whiteSpace: 'normal' }}>{a.message}</span></div>
								</div>
							))}
						</div>
					) : (
						<div className="row" style={{ fontSize: 12.5, color: 'var(--fg2)' }}>
							<Codicon name="pass" className="ok-text" /> All clear. Budgets raise alerts here at 80% and 100%.
						</div>
					)}
				</div>
				<div className="card">
					<div className="card-title">Organization</div>
					<div>
						{orgRows.map(r => (
							<button key={r.label} type="button" className="link-row" onClick={r.run}>
								<Codicon name={r.icon} />{r.label}
								<span className="link-value">{formatCount(r.value)}</span>
								<Codicon name="chevron-right" className="chev" />
							</button>
						))}
					</div>
				</div>
			</div>
		</Page>
	);
}
