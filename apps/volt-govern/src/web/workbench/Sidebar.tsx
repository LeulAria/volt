/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ComponentType, useState } from 'react';
import type { SkillKind } from '../../shared/api';
import { ROLE_LABELS, type RoleName } from '../../shared/rbac';
import { authClient, unwrap } from '../lib/auth';
import { keys, useAlerts, useCredentials, useInvitations, useMcp, useMembers, useOrg, usePolicies, useSkills, useTeams } from '../lib/data';
import { invalidate } from '../lib/query';
import { type ActivityId, useWorkbench } from '../lib/workbench';
import { Action, Avatar, CountBadge, FilterInput } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { type IListItem, List, Pane, usePanes } from '../ui/layout';
import { attempt, confirm, promptText, showContextMenu } from '../ui/overlays';
import { open } from './commands';

const TITLES: Record<ActivityId, string> = {
	overview: 'Overview', people: 'People', models: 'Models & Keys', policies: 'Policies', mcp: 'MCP Servers', skills: 'Skills & Rules', insights: 'Insights', security: 'Security',
};

/** The editor id currently active, so lists can show it selected (like the Explorer follows the editor). */
function useActiveParams(): { readonly kind?: string; readonly params?: Readonly<Record<string, string>> } {
	// Select the editor object itself: the store hands back the same reference until it changes.
	const editor = useWorkbench(s => s.editors.find(x => x.id === s.activeId));
	return { kind: editor?.kind, params: editor?.params };
}

function NavList({ items, label }: { readonly items: readonly (IListItem & { readonly open: (pinned: boolean) => void; readonly kind: string })[]; readonly label: string }) {
	const active = useWorkbench(s => s.editors.find(x => x.id === s.activeId)?.kind);
	return <List label={label} items={items} selected={items.find(i => i.kind === active)?.id} onOpen={(id, pinned) => items.find(i => i.id === id)?.open(pinned)} />;
}

//#region Overview

function OverviewView() {
	const { orgId, can } = useOrg();
	const alerts = useAlerts(can({ usage: ['read'] }) ? orgId : '');
	const open_ = alerts.data?.filter(a => !a.acknowledgedAt).length ?? 0;
	const [panes, toggle] = usePanes('overview', { nav: true });
	const items = [
		...(can({ usage: ['read'] }) ? [{ id: 'overview', kind: 'overview', label: 'Dashboard', icon: 'dashboard' as const, open: (p: boolean) => open.overview(p) }] : []),
		{ id: 'welcome', kind: 'welcome', label: 'Get Started', icon: 'rocket' as const, open: (p: boolean) => open.welcome(p) },
		{ id: 'my-access', kind: 'my-access', label: 'My Access', icon: 'workspace-trusted' as const, description: 'what you can use', open: (p: boolean) => open.myAccess(p) },
		...(can({ usage: ['read'] }) ? [{ id: 'alerts', kind: 'alerts', label: 'Alerts', icon: 'bell' as const, meta: open_ ? <CountBadge count={open_} tone="warn" /> : undefined, open: (p: boolean) => open.alerts(p) }] : []),
	];
	return (
		<Pane title="Organization" expanded={panes.nav} onToggle={() => toggle('nav')}>
			<NavList label="Overview" items={items} />
		</Pane>
	);
}

//#endregion

//#region People

function PeopleView() {
	const { orgId, can } = useOrg();
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const invitations = useInvitations(can({ invitation: ['create'] }) ? orgId : '');
	const [filter, setFilter] = useState('');
	const [panes, toggle] = usePanes('people', { members: true, teams: true, invitations: false });
	const active = useActiveParams();
	const q = filter.toLowerCase();
	const memberItems: IListItem[] = (members.data ?? [])
		.filter(m => !q || m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q))
		.sort((a, b) => (a.user.name || a.user.email).localeCompare(b.user.name || b.user.email))
		.map(m => ({ id: m.userId, label: m.user.name || m.user.email, icon: <Avatar name={m.user.name || m.user.email} small />, description: m.user.name ? m.user.email : undefined, meta: m.role !== 'member' ? ROLE_LABELS[m.role as RoleName]?.label ?? m.role : undefined }));
	const pending = (invitations.data ?? []).filter(i => i.status === 'pending');
	const createTeam = async () => {
		const name = await promptText({ title: 'New Team', message: 'Teams group people for policies, budgets and shared skills.', primary: 'Create Team', placeholder: 'Platform' });
		if (name) {
			const team = await attempt(() => unwrap(authClient.organization.createTeam({ name, organizationId: orgId })), `Team ${name} created`);
			invalidate(keys.teams(orgId));
			if (team) {
				const t = team as unknown as { id: string; name: string };
				open.team(t.id, t.name, true);
			}
		}
	};
	return (
		<>
			<Pane title="Members" expanded={panes.members} onToggle={() => toggle('members')} badge={members.data ? <CountBadge count={members.data.length} /> : undefined}
				actions={<>
					{can({ invitation: ['create'] }) ? <Action icon="person-add" label="Invite Members" onClick={() => { open.members(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:invite')), 0); }} /> : null}
					<Action icon="refresh" label="Refresh" onClick={() => invalidate(keys.members(orgId))} />
				</>}>
				<div className="pane-filter"><FilterInput value={filter} onChange={setFilter} placeholder="Filter members" /></div>
				<List label="Members" items={memberItems} selected={active.kind === 'member' ? active.params?.userId : undefined}
					onOpen={(id, pinned) => { const m = members.data?.find(x => x.userId === id); if (m) { open.member(id, m.user.name || m.user.email, pinned); } }}
					emptyText={filter ? 'No members match.' : 'No members yet.'} />
			</Pane>
			<Pane title="Teams" expanded={panes.teams} onToggle={() => toggle('teams')} badge={teams.data ? <CountBadge count={teams.data.length} /> : undefined}
				actions={can({ team: ['create'] }) ? <Action icon="add" label="New Team" onClick={() => void createTeam()} /> : undefined}>
				<List label="Teams" selected={active.kind === 'team' ? active.params?.teamId : undefined}
					items={(teams.data ?? []).map(t => ({ id: t.id, label: t.name, icon: 'organization' }))}
					onOpen={(id, pinned) => { const t = teams.data?.find(x => x.id === id); if (t) { open.team(id, t.name, pinned); } }}
					onContextMenu={(id, e) => {
						const t = teams.data?.find(x => x.id === id);
						if (!t) { return; }
						showContextMenu(e, [
							{ id: 'open', label: 'Open', run: () => open.team(t.id, t.name, true) },
							{ id: 'policy', label: 'Edit Team Policy', icon: 'law', disabled: !can({ policy: ['update'] }), run: () => open.policy('team', t.id, `Team ${t.name}`, true) },
							{ id: 's', separator: true },
							{ id: 'rename', label: 'Rename…', disabled: !can({ team: ['update'] }), run: async () => {
								const name = await promptText({ title: 'Rename Team', primary: 'Rename', value: t.name });
								if (name) {
									await attempt(() => unwrap(authClient.organization.updateTeam({ teamId: t.id, data: { name } })));
									invalidate(keys.teams(orgId));
								}
							} },
							{ id: 'delete', label: 'Delete Team', danger: true, disabled: !can({ team: ['delete'] }), run: async () => {
								if (await confirm({ title: `Delete team ${t.name}?`, message: 'Members stay in the organization. The team policy and its budget stop applying.', primary: 'Delete', danger: true })) {
									await attempt(() => unwrap(authClient.organization.removeTeam({ teamId: t.id, organizationId: orgId })), `Team ${t.name} deleted`);
									invalidate(keys.teams(orgId), keys.policies(orgId));
								}
							} },
						]);
					}}
					emptyText={can({ team: ['create'] }) ? <>No teams. <button type="button" className="link-btn" onClick={() => void createTeam()}>Create a team</button> to scope policies and budgets.</> : 'No teams.'} />
			</Pane>
			{can({ invitation: ['create'] }) ? (
				<Pane title="Invitations" expanded={panes.invitations} onToggle={() => toggle('invitations')} badge={pending.length ? <CountBadge count={pending.length} /> : undefined}>
					<List label="Invitations" items={pending.map(i => ({ id: i.id, label: i.email, icon: 'mail', meta: ROLE_LABELS[i.role as RoleName]?.label ?? i.role }))}
						onOpen={() => open.invitations()} emptyText="No pending invitations." />
				</Pane>
			) : null}
		</>
	);
}

//#endregion

//#region Models & keys

function ModelsView() {
	const { orgId, can } = useOrg();
	const credentials = useCredentials(can({ credential: ['read'] }) ? orgId : '');
	const [panes, toggle] = usePanes('models', { keys: true, catalog: true });
	const active = useActiveParams();
	if (!can({ credential: ['read'] })) {
		return <div className="list-empty">Your role cannot see provider keys. <button type="button" className="link-btn" onClick={() => open.myAccess()}>See the models you can use</button>.</div>;
	}
	return (
		<>
			<Pane title="Provider Keys" expanded={panes.keys} onToggle={() => toggle('keys')} badge={credentials.data ? <CountBadge count={credentials.data.length} /> : undefined}
				actions={can({ credential: ['create'] }) ? <Action icon="add" label="Add Provider Key" onClick={() => { open.credentials(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:add-credential')), 0); }} /> : undefined}>
				<List label="Provider keys" selected={active.kind === 'credential' ? active.params?.id : undefined}
					items={(credentials.data ?? []).map(c => ({ id: c.id, label: c.label, icon: <span className={`dot ${c.status === 'active' ? 'ok' : ''}`} />, description: c.provider, meta: <span className="mono">{c.hint}</span> }))}
					onOpen={(id, pinned) => { const c = credentials.data?.find(x => x.id === id); if (c) { open.credential(id, c.label, pinned); } }}
					emptyText={<>No provider keys. Developers reach models only through keys the organization adds here. <button type="button" className="link-btn" onClick={() => { open.credentials(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:add-credential')), 0); }}>Add a key</button></>} />
			</Pane>
			<Pane title="Catalog" expanded={panes.catalog} onToggle={() => toggle('catalog')}>
				<NavList label="Catalog" items={[
					{ id: 'models', kind: 'models', label: 'Model Catalog', icon: 'sparkle', description: 'allowed per policy', open: p => open.models(p) },
					{ id: 'credentials', kind: 'credentials', label: 'All Provider Keys', icon: 'key', open: p => open.credentials(p) },
				]} />
			</Pane>
		</>
	);
}

//#endregion

//#region Policies

function PoliciesView() {
	const { orgId, orgName, can } = useOrg();
	const policies = usePolicies(can({ policy: ['read'] }) ? orgId : '');
	const teams = useTeams(orgId);
	const members = useMembers(orgId);
	const [panes, toggle] = usePanes('policies', { org: true, teams: true, members: true });
	const active = useActiveParams();
	if (!can({ policy: ['read'] })) {
		return <div className="list-empty">Your role cannot read policies. <button type="button" className="link-btn" onClick={() => open.myAccess()}>See your effective access</button>.</div>;
	}
	const has = (type: string, id: string) => policies.data?.some(p => p.scopeType === type && p.scopeId === id && p.version > 0);
	const overrides = (policies.data ?? []).filter(p => p.scopeType === 'user');
	const selected = active.kind === 'policy' ? `${active.params?.scopeType}:${active.params?.scopeId}` : undefined;
	return (
		<>
			<Pane title="Organization" expanded={panes.org} onToggle={() => toggle('org')}>
				<List label="Organization policy" selected={selected}
					items={[{ id: `org:${orgId}`, label: orgName, icon: 'law', description: has('org', orgId) ? 'organization policy' : 'defaults' }]}
					onOpen={(_, pinned) => open.policy('org', orgId, 'Organization Policy', pinned)} />
			</Pane>
			<Pane title="Teams" expanded={panes.teams} onToggle={() => toggle('teams')}>
				<List label="Team policies" selected={selected}
					items={(teams.data ?? []).map(t => ({ id: `team:${t.id}`, label: t.name, icon: 'organization', description: has('team', t.id) ? 'narrows the organization' : 'inherits' }))}
					onOpen={(id, pinned) => { const t = teams.data?.find(x => `team:${x.id}` === id); if (t) { open.policy('team', t.id, `Team ${t.name}`, pinned); } }}
					emptyText="No teams. Team policies narrow the organization policy for a group." />
			</Pane>
			<Pane title="Member Overrides" expanded={panes.members} onToggle={() => toggle('members')} badge={overrides.length ? <CountBadge count={overrides.length} /> : undefined}
				actions={can({ policy: ['update'] }) ? <Action icon="add" label="Add Member Override" onClick={() => open.members()} /> : undefined}>
				<List label="Member overrides" selected={selected}
					items={overrides.map(p => ({ id: `user:${p.scopeId}`, label: members.data?.find(m => m.userId === p.scopeId)?.user.name ?? p.scopeId, icon: 'person' }))}
					onOpen={(id, pinned) => { const userId = id.slice(5); const m = members.data?.find(x => x.userId === userId); open.policy('user', userId, m ? `${m.user.name || m.user.email} (override)` : 'Member override', pinned); }}
					emptyText="No member overrides. Open a member to give them a narrower policy." />
			</Pane>
		</>
	);
}

//#endregion

//#region MCP

function McpView() {
	const { orgId, can } = useOrg();
	const mcp = useMcp(orgId);
	const [panes, toggle] = usePanes('mcp', { pending: true, approved: true, blocked: false });
	const active = useActiveParams();
	const group = (status: 'pending' | 'approved' | 'blocked') => (mcp.data ?? []).filter(s => s.status === status).map(s => ({
		id: s.id, label: s.name, icon: 'plug' as const, description: s.transport === 'http' ? s.url ?? 'http' : s.command ?? 'stdio',
		meta: s.tools.some(t => t.blocked) ? <span title="Some tools blocked"><Codicon name="circle-slash" size={13} /></span> : undefined,
	}));
	const selected = active.kind === 'mcp-server' ? active.params?.id : undefined;
	const openServer = (id: string, pinned: boolean) => { const s = mcp.data?.find(x => x.id === id); if (s) { open.mcpServer(id, s.name, pinned); } };
	const pending = group('pending');
	return (
		<>
			<Pane title="Requests" expanded={panes.pending} onToggle={() => toggle('pending')} badge={pending.length ? <CountBadge count={pending.length} tone="info" /> : undefined}
				actions={can({ mcp: ['create'] }) ? <Action icon="add" label="Register MCP Server" onClick={() => { open.mcp(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:add-mcp')), 0); }} /> : undefined}>
				<List label="MCP requests" items={pending} selected={selected} onOpen={openServer} emptyText="No servers waiting for review. Developers request servers from Volt." />
			</Pane>
			<Pane title="Approved" expanded={panes.approved} onToggle={() => toggle('approved')}>
				<List label="Approved MCP servers" items={group('approved')} selected={selected} onOpen={openServer} emptyText="No approved servers: agents can call no MCP tools (the default policy is an allowlist)." />
			</Pane>
			<Pane title="Blocked" expanded={panes.blocked} onToggle={() => toggle('blocked')}>
				<List label="Blocked MCP servers" items={group('blocked')} selected={selected} onOpen={openServer} emptyText="Nothing blocked." />
			</Pane>
		</>
	);
}

//#endregion

//#region Skills

const KIND_TITLES: Record<SkillKind, string> = { skill: 'Skills', rule: 'Rules', prompt: 'Prompts', agent: 'Agents' };
const KIND_ICON = { skill: 'book', rule: 'law', prompt: 'comment-discussion', agent: 'robot' } as const;

function SkillsView() {
	const { orgId, can } = useOrg();
	const skills = useSkills(orgId);
	const [panes, toggle] = usePanes('skills', { skill: true, rule: true, prompt: false, agent: false });
	const active = useActiveParams();
	return (
		<>
			{(Object.keys(KIND_TITLES) as SkillKind[]).map(kind => {
				const items = (skills.data ?? []).filter(s => s.kind === kind);
				return (
					<Pane key={kind} title={KIND_TITLES[kind]} expanded={!!panes[kind]} onToggle={() => toggle(kind)} badge={items.length ? <CountBadge count={items.length} /> : undefined}
						actions={can({ skill: ['create'] }) ? <Action icon="new-file" label={`New ${KIND_TITLES[kind].slice(0, -1)}`} onClick={() => { open.skills(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:new-skill', { detail: kind })), 0); }} /> : undefined}>
						<List label={KIND_TITLES[kind]} selected={active.kind === 'skill' ? active.params?.id : undefined}
							items={items.map(s => ({ id: s.id, label: s.name, icon: KIND_ICON[kind], description: s.description, meta: s.status === 'published' ? `v${s.version}` : s.status }))}
							onOpen={(id, pinned) => { const s = skills.data?.find(x => x.id === id); if (s) { open.skill(id, s.name, pinned); } }}
							emptyText={`No shared ${KIND_TITLES[kind].toLowerCase()}.`} />
					</Pane>
				);
			})}
		</>
	);
}

//#endregion

//#region Insights, security

function InsightsView() {
	const { can } = useOrg();
	const [panes, toggle] = usePanes('insights', { nav: true });
	const items = [
		{ id: 'usage', kind: 'usage', label: 'Usage & Cost', icon: 'graph' as const, needs: can({ usage: ['read'] }), open: (p: boolean) => open.usage(p) },
		{ id: 'requests', kind: 'requests', label: 'Gateway Requests', icon: 'pulse' as const, needs: can({ usage: ['read'] }), open: (p: boolean) => open.requests(p) },
		{ id: 'playground', kind: 'playground', label: 'Gateway Playground', icon: 'beaker' as const, needs: can({ policy: ['update'] }), open: (p: boolean) => open.playground(p) },
		{ id: 'activity', kind: 'activity', label: 'Agent Activity', icon: 'robot' as const, needs: can({ usage: ['read'] }), open: (p: boolean) => open.activity(p) },
		{ id: 'devices', kind: 'devices', label: 'Devices', icon: 'device-desktop' as const, needs: can({ device: ['read'] }), open: (p: boolean) => open.devices(p) },
	].filter(i => i.needs);
	return (
		<Pane title="Reports" expanded={panes.nav} onToggle={() => toggle('nav')}>
			<NavList label="Insights" items={items} />
			{!items.length ? <div className="list-empty">Your role has no insight reports. <button type="button" className="link-btn" onClick={() => open.myAccess()}>See your own usage</button>.</div> : null}
		</Pane>
	);
}

function SecurityView() {
	const { orgId, can } = useOrg();
	const [panes, toggle] = usePanes('security', { nav: true });
	const items = [
		{ id: 'audit', kind: 'audit', label: 'Audit Log', icon: 'history' as const, needs: can({ audit: ['read'] }), open: (p: boolean) => open.audit(p) },
		{ id: 'identity', kind: 'identity', label: 'Identity (SSO & SCIM)', icon: 'shield' as const, needs: can({ identity: ['read'] }), open: (p: boolean) => open.identity(p) },
		{ id: 'devices', kind: 'devices', label: 'Devices', icon: 'device-desktop' as const, needs: can({ device: ['read'] }), open: (p: boolean) => open.devices(p) },
		{ id: 'data', kind: 'policy', label: 'Data Rules & DLP', icon: 'eye-closed' as const, description: 'organization policy', needs: can({ policy: ['read'] }), open: (p: boolean) => open.policy('org', orgId, 'Organization Policy', p) },
		{ id: 'settings', kind: 'settings', label: 'Retention & Logging', icon: 'settings-gear' as const, needs: can({ settings: ['read'] }), open: (p: boolean) => open.settings(p) },
	].filter(i => i.needs);
	return (
		<Pane title="Security" expanded={panes.nav} onToggle={() => toggle('nav')}>
			<NavList label="Security" items={items} />
			{!items.length ? <div className="list-empty">Your role has no security views.</div> : null}
		</Pane>
	);
}

//#endregion

export function Sidebar() {
	const activity = useWorkbench(s => s.activity);
	const { orgId } = useOrg();
	const views: Record<ActivityId, ComponentType> = {
		overview: OverviewView, people: PeopleView, models: ModelsView, policies: PoliciesView, mcp: McpView, skills: SkillsView, insights: InsightsView, security: SecurityView,
	};
	const View = views[activity];
	return (
		<aside className="sidebar" aria-label={TITLES[activity]}>
			<div className="sidebar-title">
				<span>{TITLES[activity]}</span>
				<span className="actions">
					<Action icon="refresh" label="Refresh" onClick={() => invalidate(`${orgId}:`)} />
				</span>
			</div>
			<div className="sidebar-body"><View /></div>
		</aside>
	);
}
