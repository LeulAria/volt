/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { IMcpServer } from '../../shared/api';
import { api } from '../lib/api';
import { keys, memberName, useMcp, useMembers, useOrg } from '../lib/data';
import { timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { closeEditor } from '../lib/workbench';
import { Action, Button, Callout, Input, Tag, TextArea, Toggle } from '../ui/controls';
import { Group, Loading, Page, SaveBar, Section, Setting } from '../ui/layout';
import { attempt, confirm } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { useDirty } from './common';
import { MCP_TONE, setMcpStatus } from './McpEditor';

export default function McpServerEditor({ input }: IEditorProps) {
	const id = input.params!.id;
	const { orgId, can } = useOrg();
	const mcp = useMcp(orgId);
	const members = useMembers(orgId);
	const server = mcp.data?.find(s => s.id === id);
	const [description, setDescription] = useState('');
	const [command, setCommand] = useState('');
	const [url, setUrl] = useState('');
	const [tools, setTools] = useState<{ name: string; blocked: boolean }[]>([]);
	const [newTool, setNewTool] = useState('');

	useEffect(() => {
		if (server) {
			setDescription(server.description);
			setCommand(server.command ?? '');
			setUrl(server.url ?? '');
			setTools(server.tools.map(t => ({ ...t })));
		}
	}, [server]);

	const dirty = !!server && (description !== server.description || command !== (server.command ?? '') || url !== (server.url ?? '') || JSON.stringify(tools) !== JSON.stringify(server.tools));
	useDirty(input.id, dirty);

	if (!mcp.data) {
		return <Loading page />;
	}
	if (!server) {
		return <div className="page"><div className="muted">This server was removed from the registry.</div></div>;
	}
	const editable = can({ mcp: ['update'] });
	const approver = can({ mcp: ['approve'] });
	const discard = () => {
		setDescription(server.description);
		setCommand(server.command ?? '');
		setUrl(server.url ?? '');
		setTools(server.tools.map(t => ({ ...t })));
	};
	const save = async () => {
		const ok = await attempt(() => api.patch<IMcpServer>(`/mcp/${id}`, { description, command: server.transport === 'stdio' ? command : null, url: server.transport === 'http' ? url : null, tools }), 'Saved');
		if (ok) {
			invalidate(keys.mcp(orgId));
		}
	};
	const remove = async () => {
		if (await confirm({ title: `Remove ${server.name} from the registry?`, message: 'Under an allowlist policy its tools stop working for everyone.', primary: 'Remove', danger: true })) {
			const ok = await attempt(() => api.delete(`/mcp/${id}`), 'Removed');
			if (ok) {
				invalidate(keys.mcp(orgId));
				closeEditor(input.id);
			}
		}
	};
	const addTool = () => {
		const name = newTool.trim();
		if (name && !tools.some(t => t.name === name)) {
			setTools([...tools, { name, blocked: true }]);
		}
		setNewTool('');
	};
	return (
		<Page title={<span className="mono">{server.name}</span>} badge={<Tag tone={MCP_TONE[server.status]}>{server.status}</Tag>}
			subtitle={`${server.transport === 'http' ? 'Remote server' : 'Local process'} · ${server.requestedBy ? `requested by ${memberName(members.data, server.requestedBy)} · ` : ''}updated ${timeAgo(server.updatedAt)}${server.reviewedBy ? ` · reviewed by ${memberName(members.data, server.reviewedBy)}` : ''}`}
			actions={<>
				{approver && server.status !== 'approved' ? <Button icon="pass" onClick={() => void setMcpStatus(orgId, server, 'approved')}>Approve</Button> : null}
				{approver && server.status !== 'blocked' ? <Button variant="danger" icon="circle-slash" onClick={() => void setMcpStatus(orgId, server, 'blocked')}>Block</Button> : null}
			</>}>
			{server.requestReason ? <Section title="Request"><Callout icon="quote">{server.requestReason}</Callout></Section> : null}
			<fieldset disabled={!editable}>
				<Group title="Server">
					<Setting title="Description" modified={description !== server.description} wide>
						<TextArea rows={2} value={description} placeholder="What the server gives agents" onChange={e => setDescription(e.target.value)} />
					</Setting>
					{server.transport === 'stdio'
						? <Setting title="Command" wide description="What Volt runs on developers' machines when the server is approved." modified={command !== (server.command ?? '')}><Input mono value={command} onChange={e => setCommand(e.target.value)} /></Setting>
						: <Setting title="URL" wide description="The remote endpoint Volt connects to." modified={url !== (server.url ?? '')}><Input mono value={url} onChange={e => setUrl(e.target.value)} /></Setting>}
				</Group>
				<Group title="Tools" hint={<>Block individual tools of an approved server (<code>delete_repository</code>, <code>merge_pull_request</code>). The gateway removes blocked tools from model requests; Volt hides them.</>}>
					{tools.map((t, i) => (
						<Setting key={t.name} title={<span className="mono" style={{ fontWeight: 400 }}>{t.name}</span>} modified={JSON.stringify(t) !== JSON.stringify(server.tools.find(x => x.name === t.name))}
							tags={t.blocked ? <Tag tone="err">blocked</Tag> : null}>
							<Toggle checked={!t.blocked} title={t.blocked ? 'Blocked' : 'Allowed'} onChange={on => setTools(tools.map((x, j) => j === i ? { ...x, blocked: !on } : x))} />
							<Action icon="trash" label="Forget tool" onClick={() => setTools(tools.filter((_, j) => j !== i))} />
						</Setting>
					))}
					<Setting title="Block another tool" description="Tools Volt has not reported yet can be blocked by name.">
						<Input mono value={newTool} placeholder="tool_name" style={{ width: 200 }} onChange={e => setNewTool(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTool()} />
						<Button size="sm" icon="add" disabled={!newTool.trim()} onClick={addTool}>Add</Button>
					</Setting>
				</Group>
			</fieldset>
			{can({ mcp: ['delete'] }) ? (
				<Group title="Danger zone" danger>
					<Setting title="Remove from registry" description="Under an allowlist policy its tools stop working for everyone.">
						<Button variant="danger" icon="trash" onClick={() => void remove()}>Remove</Button>
					</Setting>
				</Group>
			) : null}
			<SaveBar dirty={dirty && editable} onSave={() => void save()} onDiscard={discard} />
		</Page>
	);
}
