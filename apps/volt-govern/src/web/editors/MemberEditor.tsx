/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDevice, IEffectivePolicyPreview, IRequestLog, IUsageReport } from '../../shared/api';
import { ROLE_LABELS, type RoleName } from '../../shared/rbac';
import { api } from '../lib/api';
import { authClient, unwrap } from '../lib/auth';
import { keys, useMembers, useOrg, usePolicies, useTeamMembers, useTeams } from '../lib/data';
import { formatCount, formatDateTime, formatMs, formatUsd, platformName, timeAgo } from '../lib/format';
import { invalidate, useQuery } from '../lib/query';
import { Avatar, Button, Tag, Toggle } from '../ui/controls';
import { Group, type IColumn, Loading, Page, Section, Setting, Table, Tile } from '../ui/layout';
import { attempt, confirm } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { open } from '../workbench/commands';
import { EffectivePolicyView } from './common';

export default function MemberEditor({ input }: IEditorProps) {
	const userId = input.params!.userId;
	const { orgId, can } = useOrg();
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const teamMembers = useTeamMembers(orgId, teams.data);
	const policies = usePolicies(can({ policy: ['read'] }) ? orgId : '');
	const effective = useQuery(can({ policy: ['read'] }) ? `${orgId}:effective:${userId}` : undefined, () => api.get<IEffectivePolicyPreview>(`/policies/effective/${userId}`));
	const month = new Date();
	const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)).toISOString();
	const usage = useQuery(can({ usage: ['read'] }) ? `${orgId}:usage:user:${userId}` : undefined, () => api.get<IUsageReport>(`/usage?groupBy=model&userId=${userId}&from=${from}`));
	const requests = useQuery(can({ usage: ['read'] }) ? `${orgId}:requests:user:${userId}` : undefined, () => api.get<IRequestLog[]>(`/usage/requests?limit=50&userId=${userId}`));
	const devices = useQuery(can({ device: ['read'] }) ? keys.devices(orgId) : undefined, () => api.get<IDevice[]>('/devices'));

	const member = members.data?.find(m => m.userId === userId);
	if (!members.data) {
		return <Loading page />;
	}
	if (!member) {
		return <div className="page"><div className="muted">This person is no longer a member.</div></div>;
	}
	const name = member.user.name || member.user.email;
	const hasOverride = policies.data?.some(p => p.scopeType === 'user' && p.scopeId === userId);
	const toggleTeam = async (teamId: string, on: boolean) => {
		await attempt(async () => {
			if (on) {
				await unwrap(authClient.organization.addTeamMember({ teamId, userId }));
			} else {
				await unwrap(authClient.organization.removeTeamMember({ teamId, userId }));
			}
		});
		invalidate(keys.teamMembers(orgId), `${orgId}:effective:${userId}`);
	};
	const myDevices = (devices.data ?? []).filter(d => d.userId === userId);
	const revoke = async (d: IDevice) => {
		if (await confirm({ title: `Revoke ${d.name}?`, message: 'Volt on that computer stops working for this organization at once. The member can sign in again to register it anew.', primary: 'Revoke', danger: true })) {
			await attempt(() => api.post(`/devices/${d.id}/revoke`), 'Device revoked');
			invalidate(keys.devices(orgId));
		}
	};
	const requestColumns: IColumn<IRequestLog>[] = [
		{ id: 'time', title: 'Time', width: 150, render: r => formatDateTime(r.createdAt) },
		{ id: 'model', title: 'Model', render: r => `${r.provider}/${r.model}` },
		{ id: 'status', title: 'Status', width: 90, render: r => <Tag tone={r.status === 'ok' ? 'ok' : r.status === 'blocked' ? 'err' : 'warn'}>{r.status}</Tag> },
		{ id: 'tokens', title: 'Tokens', width: 110, align: 'right', render: r => formatCount(r.inputTokens + r.outputTokens) },
		{ id: 'cost', title: 'Cost', width: 90, align: 'right', render: r => formatUsd(r.costMicros) },
		{ id: 'latency', title: 'Latency', width: 90, align: 'right', render: r => formatMs(r.latencyMs) },
	];
	return (
		<Page title={<><Avatar name={name} large /> {name}</>} subtitle={`${member.user.email} · ${ROLE_LABELS[member.role as RoleName]?.label ?? member.role} · joined ${timeAgo(member.createdAt)}`}
			actions={can({ policy: ['update'] }) ? <Button icon="law" onClick={() => open.policy('user', userId, `${name} (override)`, true)}>{hasOverride ? 'Edit Override' : 'Add Override'}</Button> : undefined}>
			{usage.data ? (
				<div className="tiles" style={{ marginBottom: 6 }}>
					<Tile icon="pulse" label="Requests this month" value={formatCount(usage.data.totals.requests)} />
					<Tile icon="credit-card" label="Spend this month" value={formatUsd(usage.data.totals.costMicros)} />
					<Tile icon="circle-slash" label="Blocked" value={formatCount(usage.data.totals.blocked)} />
					<Tile icon="device-desktop" label="Devices" value={formatCount(myDevices.filter(d => !d.revokedAt).length)} />
				</div>
			) : null}
			<Group title="Teams" hint="Team policies narrow what this member can do; team budgets count their spend.">
				{teams.data?.length ? teams.data.map(t => (
					<Setting key={t.id} title={t.name}>
						<Toggle checked={!!teamMembers.data?.get(t.id)?.includes(userId)} disabled={!can({ team: ['update'] })} title={`Member of ${t.name}`} onChange={on => void toggleTeam(t.id, on)} />
					</Setting>
				)) : <Setting title="No teams" description="Create teams in People to scope policies, budgets and shared skills." />}
			</Group>
			{effective.data ? (
				<Group title="Effective policy" hint="What Volt allows this member, after merging every layer that applies.">
					<div className="group-pad"><EffectivePolicyView policy={effective.data.policy} layers={effective.data.layers} /></div>
				</Group>
			) : null}
			{can({ device: ['read'] }) ? (
				<Section title="Devices">
					<Table columns={[
						{ id: 'name', title: 'Device', render: (d: IDevice) => <span className="cell-primary">{d.name}</span> },
						{ id: 'platform', title: 'Platform', width: 120, render: (d: IDevice) => `${platformName(d.platform)}${d.appVersion ? ` · Volt ${d.appVersion}` : ''}` },
						{ id: 'seen', title: 'Last seen', width: 130, render: (d: IDevice) => timeAgo(d.lastSeenAt) },
						{ id: 'state', title: '', width: 120, render: (d: IDevice) => d.revokedAt ? <Tag tone="err">revoked</Tag> : can({ device: ['revoke'] }) ? <Button size="sm" variant="danger" onClick={() => void revoke(d)}>Revoke</Button> : <Tag tone="ok">active</Tag> },
					]} rows={myDevices} rowKey={d => d.id} empty="No devices registered." />
				</Section>
			) : null}
			{requests.data ? (
				<Section title="Recent gateway requests">
					<Table columns={requestColumns} rows={requests.data} rowKey={r => r.id} maxHeight={360} empty="No requests yet." />
				</Section>
			) : null}
		</Page>
	);
}
