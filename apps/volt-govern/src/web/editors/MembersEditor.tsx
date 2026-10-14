/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { ROLE_LABELS, ROLE_NAMES, type RoleName } from '../../shared/rbac';
import { authClient, unwrap } from '../lib/auth';
import { type IInvitation, type IMember, keys, useInvitations, useMembers, useOrg, useTeamMembers, useTeams } from '../lib/data';
import { formatDateTime, timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { Avatar, Button, Callout, CopyAction, Field, FilterInput, Select, Tag, TagInput } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { ErrorView, type IColumn, Loading, Page, Section, Table } from '../ui/layout';
import { attempt, confirm, Modal, type IMenuItem, MenuButton, notify, showContextMenu } from '../ui/overlays';
import { open } from '../workbench/commands';

type InviteRole = Exclude<RoleName, 'owner'>;
const INVITE_ROLES = ROLE_NAMES.filter((r): r is InviteRole => r !== 'owner');
const roleOption = <R extends RoleName>(r: R) => ({ value: r, label: ROLE_LABELS[r].label, detail: ROLE_LABELS[r].detail });
const inviteRoleOptions = INVITE_ROLES.map(roleOption);
const roleOptions = (withOwner: boolean) => (withOwner ? ROLE_NAMES : INVITE_ROLES as readonly RoleName[]).map(roleOption);

export const inviteLink = (id: string) => `${window.location.origin}/accept-invite/${id}`;

function InviteModal({ onClose }: { readonly onClose: () => void }) {
	const { orgId } = useOrg();
	const teams = useTeams(orgId);
	const [emails, setEmails] = useState<string[]>([]);
	const [role, setRole] = useState<InviteRole>('member');
	const [team, setTeam] = useState<string>('');
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState<{ email: string; id?: string; error?: string }[]>();
	const invalid = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
	const send = async () => {
		setBusy(true);
		const results = [];
		for (const email of emails) {
			try {
				const inv = await unwrap(authClient.organization.inviteMember({ email, role, organizationId: orgId, ...(team ? { teamId: team } : {}) }));
				results.push({ email, id: (inv as unknown as { id: string }).id });
			} catch (err) {
				results.push({ email, error: err instanceof Error ? err.message : String(err) });
			}
		}
		setBusy(false);
		setSent(results);
		invalidate(keys.invitations(orgId), keys.overview(orgId));
	};
	if (sent) {
		return (
			<Modal title="Invitations" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>} wide>
				<Callout tone="info">No mail transport is configured, so share each link with the person it is for. Links expire in 7 days.</Callout>
				<div className="stack" style={{ marginTop: 12 }}>
					{sent.map(s => (
						<div key={s.email} className="row">
							<span className="grow ellipsis">{s.email}</span>
							{s.id ? <><code className="faint ellipsis" style={{ maxWidth: 360 }}>{inviteLink(s.id)}</code><CopyAction value={inviteLink(s.id)} label="Copy invitation link" /></> : <span className="err-text">{s.error}</span>}
						</div>
					))}
				</div>
			</Modal>
		);
	}
	return (
		<Modal title="Invite Members" onClose={onClose} wide footer={<>
			<Button onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!emails.length || invalid.length > 0} onClick={() => void send()}>Send {emails.length > 1 ? `${emails.length} Invitations` : 'Invitation'}</Button>
		</>}>
			<Field label="Email addresses" hint="Press Enter or comma after each address. People who sign in with your SSO domain join without an invitation." error={invalid.length ? `Not an email address: ${invalid.join(', ')}` : undefined}>
				<TagInput values={emails} onChange={setEmails} placeholder="ada@company.com, grace@company.com" />
			</Field>
			<div className="field-row">
				<Field label="Role"><Select value={role} options={inviteRoleOptions} onChange={setRole} /></Field>
				<Field label="Team (optional)">
					<Select value={team} options={[{ value: '', label: 'No team' }, ...(teams.data ?? []).map(t => ({ value: t.id, label: t.name }))]} onChange={setTeam} />
				</Field>
			</div>
		</Modal>
	);
}

/** The members table: roles edited inline, teams at a glance, open a member for everything else. */
export default function MembersEditor() {
	const { orgId, can, me } = useOrg();
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const teamMembers = useTeamMembers(orgId, teams.data);
	const [inviting, setInviting] = useState(false);
	const [filter, setFilter] = useState('');
	const [roleFilter, setRoleFilter] = useState<string>('all');

	useEffect(() => {
		const onInvite = () => setInviting(true);
		window.addEventListener('govern:invite', onInvite);
		return () => window.removeEventListener('govern:invite', onInvite);
	}, []);

	if (members.error) {
		return <ErrorView error={members.error} retry={members.refetch} />;
	}
	if (!members.data) {
		return <Loading page />;
	}
	const teamsOf = (userId: string) => (teams.data ?? []).filter(t => teamMembers.data?.get(t.id)?.includes(userId));
	const myRole = members.data.find(m => m.userId === me.user.id)?.role;
	const changeRole = async (m: IMember, role: RoleName) => {
		await attempt(() => unwrap(authClient.organization.updateMemberRole({ memberId: m.id, role, organizationId: orgId })), `${m.user.name || m.user.email} is now ${ROLE_LABELS[role].label}`);
		invalidate(keys.members(orgId));
	};
	const remove = async (m: IMember) => {
		if (await confirm({ title: `Remove ${m.user.name || m.user.email}?`, message: 'They lose access to the organization at once: their Volt devices are revoked and gateway credentials stop working.', primary: 'Remove', danger: true })) {
			await attempt(() => unwrap(authClient.organization.removeMember({ memberIdOrEmail: m.id, organizationId: orgId })), 'Member removed');
			invalidate(keys.members(orgId), keys.overview(orgId));
		}
	};
	const menu = (m: IMember): IMenuItem[] => [
		{ id: 'open', label: 'Open Member', icon: 'person', run: () => open.member(m.userId, m.user.name || m.user.email, true) },
		{ id: 'policy', label: 'Edit Member Override', icon: 'law', disabled: !can({ policy: ['update'] }), run: () => open.policy('user', m.userId, `${m.user.name || m.user.email} (override)`, true) },
		{ id: 'copy', label: 'Copy Email', icon: 'copy', run: () => void navigator.clipboard.writeText(m.user.email) },
		{ id: 's', separator: true },
		{ id: 'remove', label: 'Remove from Organization', icon: 'trash', danger: true, disabled: !can({ member: ['delete'] }) || m.userId === me.user.id || m.role === 'owner', run: () => void remove(m) },
	];
	const q = filter.toLowerCase();
	const rows = members.data.filter(m => (roleFilter === 'all' || m.role.split(',').includes(roleFilter)) && (!q || `${m.user.name} ${m.user.email}`.toLowerCase().includes(q)));
	const columns: IColumn<IMember>[] = [
		{
			id: 'name', title: 'Member', sort: m => m.user.name || m.user.email, render: m => (
				<span className="row" style={{ gap: 12 }}>
					<Avatar name={m.user.name || m.user.email} />
					<span className="cell-stack">
						<span className="cell-title row" style={{ gap: 6 }}><span className="ellipsis" style={{ fontWeight: 500 }}>{m.user.name || m.user.email}</span>{m.userId === me.user.id ? <Tag>you</Tag> : null}</span>
						{m.user.name ? <span className="cell-sub">{m.user.email}</span> : null}
					</span>
				</span>
			),
		},
		{
			id: 'role', title: 'Role', width: 170, sort: m => m.role, render: m => can({ member: ['update'] }) && m.userId !== me.user.id && (m.role !== 'owner' || myRole === 'owner')
				? <span onClick={e => e.stopPropagation()}><Select compact value={m.role as RoleName} options={roleOptions(myRole === 'owner')} onChange={r => void changeRole(m, r)} /></span>
				: <span style={{ paddingLeft: 8 }}>{ROLE_LABELS[m.role as RoleName]?.label ?? m.role}</span>,
		},
		{ id: 'teams', title: 'Teams', render: m => <span className="tag-list">{teamsOf(m.userId).map(t => <Tag key={t.id}>{t.name}</Tag>)}</span> },
		{ id: 'joined', title: 'Joined', width: 120, sort: m => m.createdAt, render: m => <span title={formatDateTime(m.createdAt)}>{timeAgo(m.createdAt)}</span> },
		{ id: 'actions', title: '', width: 44, render: m => <span className="row-actions" onClick={e => e.stopPropagation()}><MenuButton items={() => menu(m)} title="More Actions…" placement="bottom-end"><Codicon name="ellipsis" /></MenuButton></span> },
	];
	return (
		<Page title="Members" subtitle="Everyone in the organization. Roles decide what people can do in this console; policies decide what they can do in Volt." wide
			actions={can({ invitation: ['create'] }) ? <Button variant="primary" icon="person-add" onClick={() => setInviting(true)}>Invite Members</Button> : undefined}>
			<div className="row" style={{ marginBottom: 10 }}>
				<div style={{ width: 280 }}><FilterInput value={filter} onChange={setFilter} placeholder="Filter by name or email" /></div>
				<Select compact value={roleFilter} onChange={setRoleFilter} options={[{ value: 'all', label: 'All roles' }, ...ROLE_NAMES.map(r => ({ value: r, label: ROLE_LABELS[r].label }))]} />
				<span className="spacer" />
				<span className="faint">{rows.length} of {members.data.length}</span>
			</div>
			<Table columns={columns} rows={rows} rowKey={m => m.userId} initialSort={{ column: 'name' }}
				onRowClick={m => open.member(m.userId, m.user.name || m.user.email, false)}
				onRowContextMenu={(m, e) => showContextMenu(e, menu(m))} empty="No members match." />
			{inviting ? <InviteModal onClose={() => setInviting(false)} /> : null}
		</Page>
	);
}

/** Pending invitations with links to share (no mail transport by default). */
export function InvitationsEditor() {
	const { orgId, can } = useOrg();
	const invitations = useInvitations(orgId);
	const teams = useTeams(orgId);
	const [inviting, setInviting] = useState(false);
	if (invitations.error) {
		return <ErrorView error={invitations.error} retry={invitations.refetch} />;
	}
	if (!invitations.data) {
		return <Loading page />;
	}
	const cancel = async (i: IInvitation) => {
		await attempt(() => unwrap(authClient.organization.cancelInvitation({ invitationId: i.id })), 'Invitation cancelled');
		invalidate(keys.invitations(orgId));
	};
	const columns: IColumn<IInvitation>[] = [
		{ id: 'email', title: 'Email', sort: i => i.email, render: i => <span className="cell-primary">{i.email}</span> },
		{ id: 'role', title: 'Role', width: 120, render: i => ROLE_LABELS[i.role as RoleName]?.label ?? i.role },
		{ id: 'team', title: 'Team', width: 140, render: i => teams.data?.find(t => t.id === i.teamId)?.name ?? '—' },
		{ id: 'status', title: 'Status', width: 124, sort: i => i.status, render: i => <Tag tone={i.status === 'pending' ? 'info' : i.status === 'accepted' ? 'ok' : undefined}>{i.status}</Tag> },
		{ id: 'expires', title: 'Expires', width: 130, sort: i => i.expiresAt, render: i => i.status === 'pending' ? timeAgo(i.expiresAt) : <span className="faint">—</span> },
		{
			id: 'actions', title: '', width: 120, render: i => i.status === 'pending' ? (
				<span className="row-actions" onClick={e => e.stopPropagation()}>
					<CopyAction value={inviteLink(i.id)} label="Copy invitation link" />
					{can({ invitation: ['cancel'] }) ? <Button size="sm" variant="ghost" onClick={() => void cancel(i)}>Cancel</Button> : null}
				</span>
			) : null,
		},
	];
	return (
		<Page title="Invitations" subtitle="Share each link with the person it is for. Accepting requires signing in with the invited email." wide
			actions={can({ invitation: ['create'] }) ? <Button variant="primary" icon="person-add" onClick={() => setInviting(true)}>Invite Members</Button> : undefined}>
			<Section title="All invitations">
				<Table columns={columns} rows={invitations.data} rowKey={i => i.id} initialSort={{ column: 'expires', desc: true }} emptyIcon="mail" empty="No invitations." />
			</Section>
			{inviting ? <InviteModal onClose={() => { setInviting(false); notify('info', 'Invitations update in the list.'); }} /> : null}
		</Page>
	);
}
