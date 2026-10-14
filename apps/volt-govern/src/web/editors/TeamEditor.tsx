/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { ROLE_LABELS, type RoleName } from '../../shared/rbac';
import { authClient, unwrap } from '../lib/auth';
import { type IMember, keys, useMembers, useOrg, usePolicies, useTeamMembers, useTeams } from '../lib/data';
import { invalidate } from '../lib/query';
import { Avatar, Button, Select, Tag } from '../ui/controls';
import { Group, type IColumn, Loading, Page, Section, Setting, Table } from '../ui/layout';
import { attempt, confirm, promptText } from '../ui/overlays';
import { closeEditor } from '../lib/workbench';
import type { IEditorProps } from '../workbench/EditorPart';
import { open } from '../workbench/commands';

export default function TeamEditor({ input }: IEditorProps) {
	const teamId = input.params!.teamId;
	const { orgId, can } = useOrg();
	const teams = useTeams(orgId);
	const members = useMembers(orgId);
	const teamMembers = useTeamMembers(orgId, teams.data);
	const policies = usePolicies(can({ policy: ['read'] }) ? orgId : '');
	const [adding, setAdding] = useState('');
	const team = teams.data?.find(t => t.id === teamId);
	if (!teams.data || !members.data) {
		return <Loading page />;
	}
	if (!team) {
		return <div className="page"><div className="muted">This team no longer exists.</div></div>;
	}
	const ids = teamMembers.data?.get(teamId) ?? [];
	const inTeam = members.data.filter(m => ids.includes(m.userId));
	const outside = members.data.filter(m => !ids.includes(m.userId));
	const policy = policies.data?.find(p => p.scopeType === 'team' && p.scopeId === teamId);
	const refresh = () => invalidate(keys.teamMembers(orgId));
	const add = async (userId: string) => {
		await attempt(() => unwrap(authClient.organization.addTeamMember({ teamId, userId })));
		setAdding('');
		refresh();
	};
	const remove = async (m: IMember) => {
		await attempt(() => unwrap(authClient.organization.removeTeamMember({ teamId, userId: m.userId })));
		refresh();
	};
	const rename = async () => {
		const name = await promptText({ title: 'Rename Team', primary: 'Rename', value: team.name });
		if (name) {
			await attempt(() => unwrap(authClient.organization.updateTeam({ teamId, data: { name } })));
			invalidate(keys.teams(orgId));
			open.team(teamId, name, true);
		}
	};
	const destroy = async () => {
		if (await confirm({ title: `Delete team ${team.name}?`, message: 'Members stay in the organization. The team policy and its budget stop applying.', primary: 'Delete', danger: true })) {
			const ok = await attempt(() => unwrap(authClient.organization.removeTeam({ teamId, organizationId: orgId })), `Team ${team.name} deleted`);
			if (ok !== undefined) {
				invalidate(keys.teams(orgId), keys.policies(orgId));
				closeEditor(input.id);
			}
		}
	};
	const columns: IColumn<IMember>[] = [
		{
			id: 'name', title: 'Member', sort: m => m.user.name || m.user.email, render: m => (
				<span className="row" style={{ gap: 12 }}>
					<Avatar name={m.user.name || m.user.email} />
					<span className="cell-stack"><span className="cell-title" style={{ fontWeight: 500 }}>{m.user.name || m.user.email}</span>{m.user.name ? <span className="cell-sub">{m.user.email}</span> : null}</span>
				</span>
			),
		},
		{ id: 'role', title: 'Role', width: 120, render: m => ROLE_LABELS[m.role as RoleName]?.label ?? m.role },
		{ id: 'actions', title: '', width: 100, render: m => can({ team: ['update'] }) ? <span className="row-actions" onClick={e => e.stopPropagation()}><Button size="sm" variant="ghost" onClick={() => void remove(m)}>Remove</Button></span> : null },
	];
	return (
		<Page title={team.name} subtitle={`${inTeam.length} member${inTeam.length === 1 ? '' : 's'}. A team can narrow the organization policy and have its own budget and shared skills.`}
			actions={<>
				{can({ team: ['update'] }) ? <Button icon="edit" onClick={() => void rename()}>Rename</Button> : null}
				{can({ team: ['delete'] }) ? <Button variant="danger" icon="trash" onClick={() => void destroy()}>Delete</Button> : null}
			</>}>
			<Group title="Policy">
				<Setting title={policy ? 'Team policy' : 'No team policy'} tags={policy ? <Tag tone="info" icon="law">v{policy.version}</Tag> : undefined}
					description={policy ? 'Narrows the organization policy for these members, and can give them their own budget.' : 'Members get the organization policy as is.'}>
					{can({ policy: ['update'] }) ? <Button size="sm" icon="law" onClick={() => open.policy('team', teamId, `Team ${team.name}`, true)}>{policy ? 'Edit' : 'Add Policy'}</Button> : null}
				</Setting>
			</Group>
			<Section title="Members" actions={can({ team: ['update'] }) && outside.length ? (
				<Select compact value={adding} placeholder="Add member…" options={outside.map(m => ({ value: m.userId, label: m.user.name || m.user.email, detail: m.user.email }))} onChange={id => void add(id)} width={220} />
			) : undefined}>
				<Table columns={columns} rows={inTeam} rowKey={m => m.userId} onRowClick={m => open.member(m.userId, m.user.name || m.user.email)} empty="No members in this team." />
			</Section>
		</Page>
	);
}
