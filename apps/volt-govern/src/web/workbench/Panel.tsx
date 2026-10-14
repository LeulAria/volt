/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useAudit, useCredentials, useMcp, useOrg, useOverview, useRequests } from '../lib/data';
import { formatCount, formatMs, formatUsd } from '../lib/format';
import { type PanelTab, togglePanel, useWorkbench, getWorkbench, showPanel } from '../lib/workbench';
import { Action, CountBadge } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { open } from './commands';

export interface IProblem {
	readonly id: string;
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly source: string;
	readonly run?: () => void;
}

/**
 * What needs an admin's attention, VS Code Problems style: setup gaps that leave developers
 * without access or the organization exposed, pending MCP requests, and unacknowledged alerts.
 */
export function useProblems(): IProblem[] {
	const { orgId, can } = useOrg();
	const overview = useOverview(can({ usage: ['read'] }) ? orgId : '');
	const credentials = useCredentials(can({ credential: ['read'] }) ? orgId : '');
	const mcp = useMcp(orgId);
	const problems: IProblem[] = [];
	const o = overview.data;
	if (credentials.data && !credentials.data.some(c => c.status === 'active')) {
		problems.push({ id: 'no-key', severity: 'error', message: 'No active provider key: developers cannot reach any model through the gateway.', source: 'Models & Keys', run: () => open.credentials() });
	}
	if (o && !o.setup.sso) {
		problems.push({ id: 'no-sso', severity: 'warning', message: 'Single sign-on is not configured: people sign in with passwords.', source: 'Identity', run: () => open.identity() });
	}
	if (o && !o.setup.scim) {
		problems.push({ id: 'no-scim', severity: 'info', message: 'SCIM provisioning is off: people leaving the company keep access until removed by hand.', source: 'Identity', run: () => open.identity() });
	}
	if (o && !o.setup.policy) {
		problems.push({ id: 'default-policy', severity: 'info', message: 'The organization runs on the default policy. Review models, MCP and data rules.', source: 'Policies', run: () => open.policy('org', orgId, 'Organization Policy', true) });
	}
	const pending = mcp.data?.filter(s => s.status === 'pending') ?? [];
	for (const s of pending) {
		problems.push({ id: `mcp-${s.id}`, severity: 'info', message: `MCP server "${s.name}" is waiting for review${s.requestReason ? `: ${s.requestReason}` : ''}.`, source: 'MCP', run: () => open.mcpServer(s.id, s.name, true) });
	}
	for (const a of o?.alerts ?? []) {
		problems.push({ id: `alert-${a.id}`, severity: a.severity === 'error' ? 'error' : a.severity === 'warning' ? 'warning' : 'info', message: a.message, source: a.kind === 'budget' ? 'Budgets' : 'Alerts', run: () => open.alerts() });
	}
	return problems;
}

function ProblemsView() {
	const problems = useProblems();
	if (!problems.length) {
		return <div className="list-empty">No problems have been detected in the organization.</div>;
	}
	return (
		<div>
			{problems.map(p => (
				<div key={p.id} className="problem" role="button" tabIndex={0} onClick={p.run} onKeyDown={e => e.key === 'Enter' && p.run?.()}>
					<Codicon name={p.severity} className={p.severity} />
					<span className="grow ellipsis">{p.message}</span>
					<span className="problem-src">{p.source}</span>
				</div>
			))}
		</div>
	);
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour12: false });

function GatewayLog() {
	const { orgId, can } = useOrg();
	const { data } = useRequests(can({ usage: ['read'] }) ? orgId : '');
	if (!can({ usage: ['read'] })) {
		return <div className="list-empty">Your role cannot read gateway usage.</div>;
	}
	if (!data?.length) {
		return <div className="list-empty">No gateway requests yet. Requests appear here as developers use Volt.</div>;
	}
	return (
		<div>
			{data.slice(0, 200).map(r => (
				<div key={r.id} className="log-row">
					<span className="log-time">{time(r.createdAt)}</span>
					<span className={`log-kind${r.status === 'blocked' ? ' blocked' : r.status === 'error' ? ' err' : ''}`}>[{r.status}] {r.provider}/{r.model}</span>
					<span className="log-msg">
						{r.userName ?? r.userId} · {formatCount(r.inputTokens)}→{formatCount(r.outputTokens)} tok · {formatUsd(r.costMicros)} · {formatMs(r.latencyMs)}
						{r.toolCalls ? ` · ${r.toolCalls} tool calls` : ''}{r.dlpFindings ? ` · ${r.dlpFindings} redacted` : ''}{r.reason ? ` · ${r.reason}` : ''}
					</span>
				</div>
			))}
		</div>
	);
}

function AuditTail() {
	const { orgId, can } = useOrg();
	const { data } = useAudit(can({ audit: ['read'] }) ? orgId : '');
	if (!can({ audit: ['read'] })) {
		return <div className="list-empty">Your role cannot read the audit log.</div>;
	}
	if (!data?.length) {
		return <div className="list-empty">The audit log is empty.</div>;
	}
	return (
		<div>
			{data.slice(0, 200).map(e => (
				<div key={e.id} className="log-row">
					<span className="log-time">{time(e.createdAt)}</span>
					<span className={`log-kind${e.action.includes('blocked') || e.action.includes('revoke') || e.action.includes('delete') ? ' warn' : ''}`}>{e.action}</span>
					<span className="log-msg">{e.actorName ?? e.actorType}{e.targetId ? ` → ${e.targetType}:${e.targetId}` : ''} {Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''}</span>
				</div>
			))}
		</div>
	);
}

export function Panel() {
	const tab = useWorkbench(s => s.panelTab);
	const problems = useProblems();
	const tabs: { id: PanelTab; label: string; badge?: number }[] = [
		{ id: 'problems', label: 'Problems', badge: problems.length },
		{ id: 'gateway', label: 'Gateway' },
		{ id: 'audit', label: 'Audit' },
	];
	return (
		<section className="panel" aria-label="Panel">
			<div className="panel-head">
				<div className="panel-tabs" role="tablist">
					{tabs.map(t => (
						<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`panel-tab${tab === t.id ? ' on' : ''}`} onClick={() => showPanel(t.id)}>
							{t.label}{t.badge ? <CountBadge count={t.badge} /> : null}
						</button>
					))}
				</div>
				<span className="actions">
					{tab === 'gateway' ? <Action icon="link-external" label="Open Gateway Requests" onClick={() => open.requests()} /> : null}
					{tab === 'audit' ? <Action icon="link-external" label="Open Audit Log" onClick={() => open.audit()} /> : null}
					<Action icon="close" label="Hide Panel" onClick={() => getWorkbench().panelVisible && togglePanel()} />
				</span>
			</div>
			<div className="panel-body">
				{tab === 'problems' ? <ProblemsView /> : tab === 'gateway' ? <GatewayLog /> : <AuditTail />}
			</div>
		</section>
	);
}
