/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { IMcpServer, McpStatus } from '../../shared/api';
import { api } from '../lib/api';
import { keys, memberName, useMcp, useMembers, useOrg } from '../lib/data';
import { timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { Button, Callout, Field, Input, Segmented, Select, Tag, TextArea } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Section, Table } from '../ui/layout';
import { attempt, Modal, showContextMenu } from '../ui/overlays';
import { open } from '../workbench/commands';

export const MCP_TONE: Record<McpStatus, 'ok' | 'err' | 'info'> = { approved: 'ok', blocked: 'err', pending: 'info' };

export async function setMcpStatus(orgId: string, server: IMcpServer, status: McpStatus): Promise<void> {
	await attempt(() => api.patch(`/mcp/${server.id}`, { status }), `${server.name} ${status === 'approved' ? 'approved' : status === 'blocked' ? 'blocked' : 'marked for review'}`);
	invalidate(keys.mcp(orgId), keys.overview(orgId));
}

function RegisterModal({ onClose }: { readonly onClose: () => void }) {
	const { orgId, can } = useOrg();
	const [name, setName] = useState('');
	const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
	const [command, setCommand] = useState('');
	const [url, setUrl] = useState('');
	const [description, setDescription] = useState('');
	const [status, setStatus] = useState<McpStatus>(can({ mcp: ['approve'] }) ? 'approved' : 'pending');
	const [busy, setBusy] = useState(false);
	const valid = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name);
	const save = async () => {
		setBusy(true);
		const created = await attempt(() => api.post<IMcpServer>('/mcp', { name, transport, command: transport === 'stdio' ? command : null, url: transport === 'http' ? url : null, description, status }), `${name} registered`);
		setBusy(false);
		if (created) {
			invalidate(keys.mcp(orgId));
			onClose();
			open.mcpServer(created.id, created.name, true);
		}
	};
	return (
		<Modal title="Register MCP Server" onClose={onClose} wide footer={<>
			<Button onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>Register</Button>
		</>}>
			<Field label="Name" hint={<>Lowercase, digits, - and _. Agents see its tools as <code>mcp__{name || 'name'}__tool</code>, which is how the gateway recognizes them.</>} error={name && !valid ? 'Use lowercase letters, digits, - and _' : undefined}>
				<Input mono value={name} placeholder="github" onChange={e => setName(e.target.value.toLowerCase())} />
			</Field>
			<Field label="Transport">
				<div><Segmented value={transport} onChange={setTransport} options={[{ value: 'stdio', label: 'Local process (stdio)' }, { value: 'http', label: 'Remote (HTTP)' }]} /></div>
			</Field>
			{transport === 'stdio'
				? <Field label="Command" hint="What Volt runs on the developer's machine."><Input mono value={command} placeholder="npx -y @modelcontextprotocol/server-github" onChange={e => setCommand(e.target.value)} /></Field>
				: <Field label="URL"><Input mono value={url} placeholder="https://mcp.linear.app/sse" onChange={e => setUrl(e.target.value)} /></Field>}
			<Field label="Description"><TextArea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></Field>
			<Field label="Status">
				<Select value={status} onChange={setStatus} options={[
					{ value: 'approved', label: 'Approved', disabled: !can({ mcp: ['approve'] }) },
					{ value: 'pending', label: 'Pending review' },
					{ value: 'blocked', label: 'Blocked', disabled: !can({ mcp: ['approve'] }) },
				]} />
			</Field>
		</Modal>
	);
}

export default function McpEditor() {
	const { orgId, can } = useOrg();
	const { data, error, refetch } = useMcp(orgId);
	const members = useMembers(orgId);
	const [registering, setRegistering] = useState(false);
	useEffect(() => {
		const onAdd = () => setRegistering(true);
		window.addEventListener('govern:add-mcp', onAdd);
		return () => window.removeEventListener('govern:add-mcp', onAdd);
	}, []);
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const approver = can({ mcp: ['approve'] });
	const pending = data.filter(s => s.status === 'pending');
	const columns: IColumn<IMcpServer>[] = [
		{ id: 'name', title: 'Server', sort: s => s.name, render: s => <span className="cell-primary mono">{s.name}</span> },
		{ id: 'status', title: 'Status', width: 110, sort: s => s.status, render: s => <Tag tone={MCP_TONE[s.status]}>{s.status}</Tag> },
		{ id: 'transport', title: 'Runs', render: s => <span className="mono faint">{s.transport === 'http' ? s.url : s.command}</span> },
		{ id: 'tools', title: 'Blocked tools', width: 120, align: 'right', render: s => s.tools.filter(t => t.blocked).length || '—' },
		{ id: 'updated', title: 'Updated', width: 120, sort: s => s.updatedAt, render: s => timeAgo(s.updatedAt) },
		{
			id: 'actions', title: '', width: 170, render: s => approver ? (
				<span className="row-actions" onClick={e => e.stopPropagation()}>
					{s.status !== 'approved' ? <Button size="sm" onClick={() => void setMcpStatus(orgId, s, 'approved')}>Approve</Button> : null}
					{s.status !== 'blocked' ? <Button size="sm" variant="danger" onClick={() => void setMcpStatus(orgId, s, 'blocked')}>Block</Button> : null}
				</span>
			) : null,
		},
	];
	return (
		<Page title="MCP Registry" wide subtitle="The MCP servers agents may use. Approved servers reach developers' Volt; requests from developers wait here. The gateway removes tools of unapproved servers from every model request."
			actions={can({ mcp: ['create'] }) ? <Button variant="primary" icon="add" onClick={() => setRegistering(true)}>Register Server</Button> : undefined}>
			{pending.length && approver ? (
				<Section title={`Waiting for review (${pending.length})`}>
					<div className="stack">
						{pending.map(s => (
							<div key={s.id} className="card">
								<div className="card-title"><span className="mono">{s.name}</span><Tag tone="info">pending</Tag>
									<span className="actions">
										<Button size="sm" variant="primary" onClick={() => void setMcpStatus(orgId, s, 'approved')}>Approve</Button>
										<Button size="sm" variant="danger" onClick={() => void setMcpStatus(orgId, s, 'blocked')}>Block</Button>
										<Button size="sm" variant="ghost" onClick={() => open.mcpServer(s.id, s.name, true)}>Details</Button>
									</span>
								</div>
								<div className="muted" style={{ fontSize: 12.5 }}>
									Requested by {memberName(members.data, s.requestedBy)} {timeAgo(s.createdAt)}{s.requestReason ? <>: “{s.requestReason}”</> : null}
								</div>
								<div className="mono faint" style={{ fontSize: 12, marginTop: 4 }}>{s.transport === 'http' ? s.url : s.command}</div>
							</div>
						))}
					</div>
				</Section>
			) : null}
			<Section title="All servers">
				{!data.some(s => s.status === 'approved') ? <div style={{ marginBottom: 10 }}><Callout tone="info">No approved servers yet. With the default allowlist policy, agents can call no MCP tools until you approve some.</Callout></div> : null}
				<Table columns={columns} rows={data} rowKey={s => s.id} initialSort={{ column: 'name' }} onRowClick={s => open.mcpServer(s.id, s.name)}
					onRowContextMenu={(s, e) => showContextMenu(e, [
						{ id: 'open', label: 'Open', run: () => open.mcpServer(s.id, s.name, true) },
						{ id: 's', separator: true },
						{ id: 'approve', label: 'Approve', disabled: !approver || s.status === 'approved', run: () => void setMcpStatus(orgId, s, 'approved') },
						{ id: 'block', label: 'Block', danger: true, disabled: !approver || s.status === 'blocked', run: () => void setMcpStatus(orgId, s, 'blocked') },
					])}
					emptyIcon="mcp" empty="No servers registered." />
			</Section>
			{registering ? <RegisterModal onClose={() => setRegistering(false)} /> : null}
		</Page>
	);
}
