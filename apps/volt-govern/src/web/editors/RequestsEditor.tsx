/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { IRequestLog } from '../../shared/api';
import { api } from '../lib/api';
import { useOrg, useRequests, useSettings } from '../lib/data';
import { formatCount, formatDateTime, formatMs, formatUsd } from '../lib/format';
import { Action, Callout, Person, Select, Tag } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt, Modal } from '../ui/overlays';
import { open } from '../workbench/commands';

function PromptModal({ request, onClose }: { readonly request: IRequestLog; readonly onClose: () => void }) {
	const [data, setData] = useState<{ request: unknown; response: string } | null | undefined>(undefined);
	useEffect(() => {
		void attempt(() => api.get<{ request: unknown; response: string }>(`/usage/requests/${request.id}/prompt`)).then(d => setData(d ?? null));
	}, [request.id]);
	return (
		<Modal title={`${request.provider}/${request.model} · ${formatDateTime(request.createdAt)}`} onClose={onClose} wide>
			<Callout tone="warn">Viewing a logged prompt is recorded in the audit log.</Callout>
			{data === undefined ? <Loading /> : data === null ? <div className="muted" style={{ marginTop: 10 }}>No prompt was kept for this request.</div> : (
				<div className="stack" style={{ marginTop: 10 }}>
					<div className="field-label">Request (as sent, after redaction)</div>
					<pre className="secret-box" style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(data.request, null, 2)}</pre>
					<div className="field-label">Answer text</div>
					<pre className="secret-box" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{data.response || '(no text)'}</pre>
				</div>
			)}
		</Modal>
	);
}

export default function RequestsEditor() {
	const { orgId, can } = useOrg();
	const [status, setStatus] = useState('');
	const { data, error, refetch, loading } = useRequests(orgId, status);
	const settings = useSettings(can({ settings: ['read'] }) ? orgId : '');
	const [viewing, setViewing] = useState<IRequestLog>();
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	const logging = settings.data?.promptLogging;
	const columns: IColumn<IRequestLog>[] = [
		{ id: 'time', title: 'Time', width: 132, sort: r => r.createdAt, render: r => <span title={formatDateTime(r.createdAt)}>{formatDateTime(r.createdAt)}</span> },
		{
			id: 'model', title: 'Request', sort: r => `${r.provider}/${r.model}`, render: r => (
				<span className="cell-stack">
					<span className="mono cell-title">{r.provider}/{r.model}</span>
					<span className="cell-sub" title={r.reason ?? r.client ?? ''}>{r.reason ?? [r.toolCalls ? `${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}` : '', r.client ?? ''].filter(Boolean).join(' · ')}</span>
				</span>
			),
		},
		{ id: 'user', title: 'Member', width: 170, sort: r => r.userName ?? '', render: r => <Person name={r.userName ?? r.userId.slice(0, 8)} onOpen={() => open.member(r.userId, r.userName ?? r.userId)} /> },
		{ id: 'status', title: 'Outcome', width: 104, sort: r => r.status, render: r => <Tag tone={r.status === 'ok' ? 'ok' : r.status === 'blocked' ? 'err' : 'warn'} title={r.reason ?? undefined}>{r.status}</Tag> },
		{ id: 'tokens', title: 'In → Out', width: 124, align: 'right', render: r => `${formatCount(r.inputTokens)} → ${formatCount(r.outputTokens)}` },
		{ id: 'dlp', title: 'Redacted', width: 88, align: 'right', sort: r => r.dlpFindings, render: r => r.dlpFindings ? <Tag tone="warn" icon="eye-closed">{r.dlpFindings}</Tag> : <span className="faint">—</span> },
		{ id: 'latency', title: 'Latency', width: 84, align: 'right', sort: r => r.latencyMs, render: r => formatMs(r.latencyMs) },
		{ id: 'cost', title: 'Cost', width: 88, align: 'right', sort: r => r.costMicros ?? -1, render: r => formatUsd(r.costMicros) },
	];
	return (
		<Page title="Gateway Requests" wide subtitle={`The latest 300 requests. ${logging === 'redacted' || logging === 'full' ? 'Prompts are kept: open a request to read it (audited).' : 'Prompts are not kept (Settings → Prompt Logging).'}`}
			actions={<>
				<Select compact value={status} onChange={setStatus} options={[{ value: '', label: 'All outcomes' }, { value: 'ok', label: 'Succeeded' }, { value: 'blocked', label: 'Blocked by policy' }, { value: 'error', label: 'Provider errors' }]} />
				<Action icon="refresh" label="Refresh" spin={loading} onClick={() => void refetch()} />
			</>}>
			{!data ? <Loading /> : (
				<Table columns={columns} rows={data} rowKey={r => r.id} initialSort={{ column: 'time', desc: true }} maxHeight="calc(100vh - 230px)"
					onRowClick={can({ audit: ['read'] }) && (logging === 'redacted' || logging === 'full') ? r => setViewing(r) : undefined}
					emptyIcon="pulse" empty="No requests yet." />
			)}
			{viewing ? <PromptModal request={viewing} onClose={() => setViewing(undefined)} /> : null}
		</Page>
	);
}
