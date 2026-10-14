/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import type { IAuditEvent } from '../../shared/api';
import { useAudit, useOrg } from '../lib/data';
import { formatDateTime } from '../lib/format';
import { Action, Button, Person, Select, Tag } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { Modal } from '../ui/overlays';

const FILTERS = [
	{ value: '', label: 'All events' },
	{ value: 'gateway.', label: 'Gateway enforcement' },
	{ value: 'policy.', label: 'Policy changes' },
	{ value: 'credential.', label: 'Provider keys' },
	{ value: 'member.', label: 'Membership' },
	{ value: 'invitation.', label: 'Invitations' },
	{ value: 'mcp.', label: 'MCP' },
	{ value: 'skill.', label: 'Skills' },
	{ value: 'device.', label: 'Devices' },
	{ value: 'sso.', label: 'SSO' },
	{ value: 'scim.', label: 'SCIM' },
	{ value: 'settings.', label: 'Settings' },
	{ value: 'prompt.', label: 'Prompt views' },
];

function tone(action: string): 'ok' | 'warn' | 'err' | 'info' | undefined {
	if (/blocked|revoke|delete|remove|deprovision/.test(action)) {
		return 'err';
	}
	if (/enforced|rotate|prompt\.view|export/.test(action)) {
		return 'warn';
	}
	if (/create|approve|publish|provision|register|add/.test(action)) {
		return 'ok';
	}
	return undefined;
}

/** An event's detail as words: `strippedTools: mcp__x · redactions: 1`, not raw JSON. */
function summary(detail: Readonly<Record<string, unknown>>): string {
	return Object.entries(detail)
		.filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
		.map(([k, v]) => `${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
		.join(' · ');
}

export default function AuditEditor() {
	const { orgId } = useOrg();
	const [filter, setFilter] = useState('');
	const { data, error, refetch, loading } = useAudit(orgId, filter);
	const [detail, setDetail] = useState<IAuditEvent>();
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	const columns: IColumn<IAuditEvent>[] = [
		{ id: 'time', title: 'Time', width: 132, sort: e => e.createdAt, render: e => formatDateTime(e.createdAt) },
		{
			id: 'action', title: 'Event', width: 290, sort: e => e.action, render: e => (
				<span className="cell-stack">
					<span><Tag mono tone={tone(e.action)}>{e.action}</Tag></span>
					{e.targetId ? <span className="cell-sub mono" title={`${e.targetType}:${e.targetId}`}>{e.targetType}:{e.targetId}</span> : null}
				</span>
			),
		},
		{ id: 'actor', title: 'Actor', width: 190, sort: e => e.actorName ?? e.actorType, render: e => e.actorName ? <span className="row"><Person name={e.actorName} />{e.actorType !== 'user' ? <span className="faint" style={{ fontSize: 11.5 }}>{e.actorType}</span> : null}</span> : <span className="faint">{e.actorType}</span> },
		{ id: 'detail', title: 'Details', render: e => { const text = summary(e.detail); return <span className="cell-stack"><span className="cell-title" style={{ fontSize: 12.5, color: 'var(--fg2)' }} title={text}>{text || '—'}</span>{e.ip ? <span className="cell-sub mono">{e.ip}</span> : null}</span>; } },
	];
	return (
		<Page title="Audit Log" wide subtitle="Append-only record of every administrative action and every gateway enforcement (blocked requests, removed tools, redactions). Retention is set in Settings."
			actions={<>
				<Select compact value={filter} onChange={setFilter} options={FILTERS} />
				<Action icon="refresh" label="Refresh" spin={loading} onClick={() => void refetch()} />
				<Button icon="export" onClick={() => window.open('/api/govern/audit/export', '_blank')}>Export</Button>
			</>}>
			{!data ? <Loading /> : <Table columns={columns} rows={data} rowKey={e => e.id} initialSort={{ column: 'time', desc: true }} onRowClick={setDetail} maxHeight="calc(100vh - 230px)" empty="No events." />}
			{detail ? (
				<Modal title={detail.action} onClose={() => setDetail(undefined)} wide>
					<dl className="kv">
						<dt>Time</dt><dd>{formatDateTime(detail.createdAt)}</dd>
						<dt>Actor</dt><dd>{detail.actorName ?? detail.actorType} <span className="faint mono">{detail.actorId}</span></dd>
						<dt>Target</dt><dd className="mono">{detail.targetType}:{detail.targetId}</dd>
						<dt>IP</dt><dd className="mono">{detail.ip ?? '—'}</dd>
					</dl>
					<pre className="secret-box" style={{ marginTop: 16, whiteSpace: 'pre-wrap', alignItems: 'flex-start', padding: 14 }}>{JSON.stringify(detail.detail, null, 2)}</pre>
				</Modal>
			) : null}
		</Page>
	);
}
