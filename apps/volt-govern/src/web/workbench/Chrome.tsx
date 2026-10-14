/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';
import { ROLE_LABELS, type RoleName } from '../../shared/rbac';
import { authClient } from '../lib/auth';
import { useAlerts, useMcp, useMe, useOrg, useOverview } from '../lib/data';
import { formatCount, formatUsd, keys } from '../lib/format';
import { setThemePreference, useThemePreference } from '../lib/theme';
import { type ActivityId, openQuick, resetEditors, selectActivity, showPanel, toggleSidebar, togglePanel, useWorkbench } from '../lib/workbench';
import { Avatar, Kbd } from '../ui/controls';
import { Bolt, ChevronsUpDown, Codicon, type CodiconName } from '../ui/icons';
import { attempt, type IMenuItem, MenuButton } from '../ui/overlays';
import { COMMANDS, open, signOut } from './commands';
import { useProblems } from './Panel';

/** Like VS Code switching workspaces: the window reloads into the other organization. */
export async function switchOrganization(organizationId: string): Promise<void> {
	await attempt(async () => {
		const { error } = await authClient.organization.setActive({ organizationId });
		if (error) {
			throw new Error(error.message);
		}
		resetEditors();
		window.location.assign('/');
	});
}

function useOrgMenu(): IMenuItem[] {
	const { data: me } = useMe();
	return [
		{ id: 'h', header: 'Organizations' },
		...(me?.organizations ?? []).map(o => ({ id: o.id, label: o.name, checked: o.id === me?.organization?.id, run: () => void switchOrganization(o.id) })),
		{ id: 's1', separator: true },
		{ id: 'new', label: 'Create Organization…', icon: 'add' as CodiconName, run: () => window.location.assign('/onboarding') },
	];
}

/** The account menu: who is signed in, their access, organizations, sign out. */
function useAccountMenu(): IMenuItem[] {
	const { me, role } = useOrg();
	const orgMenu = useOrgMenu();
	return [
		{ id: 'who', header: `${me.user.name || me.user.email} · ${ROLE_LABELS[role as RoleName]?.label ?? role}` },
		{ id: 'email', label: me.user.email, icon: 'mail', disabled: true },
		{ id: 'access', label: 'My Access', icon: 'workspace-trusted', run: () => open.myAccess() },
		{ id: 's', separator: true },
		...orgMenu,
		{ id: 's2', separator: true },
		{ id: 'out', label: 'Sign Out', icon: 'sign-out', run: () => void signOut() },
	];
}

//#region Title bar

export function TitleBar() {
	const { orgName, can, me } = useOrg();
	const orgMenu = useOrgMenu();
	const accountMenu = useAccountMenu();
	const sidebar = useWorkbench(s => s.sidebarVisible);
	const panel = useWorkbench(s => s.panelVisible);
	const theme = useThemePreference();
	const cmd = (id: string) => COMMANDS.find(c => c.id === id)!;
	const item = (id: string, label?: string): IMenuItem => {
		const c = cmd(id);
		return { id, label: label ?? c.title, icon: c.icon, keys: c.keys, disabled: c.needs ? !can(c.needs) : false, run: c.run };
	};
	const menus: { label: string; items: IMenuItem[] }[] = [
		{ label: 'Govern', items: [item('govern.overview', 'Overview'), item('govern.myAccess', 'My Access'), { id: 's', separator: true }, item('govern.invite'), item('govern.addCredential'), item('govern.addMcp'), item('govern.newSkill'), { id: 's2', separator: true }, item('govern.settings', 'Settings'), item('govern.switchOrg'), { id: 's3', separator: true }, item('govern.signOut')] },
		{ label: 'View', items: [item('workbench.action.showCommands', 'Command Palette…'), { id: 's', separator: true }, item('view.overview', 'Overview'), item('view.people', 'People'), item('view.models', 'Models & Keys'), item('view.policies', 'Policies'), item('view.mcp', 'MCP Servers'), item('view.skills', 'Skills & Rules'), item('view.insights', 'Insights'), item('view.security', 'Security'), { id: 's2', separator: true }, item('workbench.action.toggleSidebarVisibility', 'Primary Side Bar'), item('workbench.action.togglePanel', 'Panel'), item('workbench.actions.view.problems', 'Problems')] },
		{ label: 'Go', items: [item('workbench.action.quickOpen', 'Go to…'), { id: 's', separator: true }, item('govern.members', 'Members'), item('govern.credentials', 'Provider Keys'), item('govern.mcp', 'MCP Registry'), item('govern.skills', 'Skills & Rules'), item('govern.usage', 'Usage & Cost'), item('govern.requests', 'Gateway Requests'), item('govern.playground', 'Gateway Playground'), item('govern.audit', 'Audit Log')] },
		{ label: 'Help', items: [item('govern.getStarted'), item('govern.connectVolt'), { id: 's', separator: true }, { id: 'docs', label: 'Volt Documentation', icon: 'link-external', run: () => window.open('https://volt.leularia.com/docs', '_blank') }, { id: 'about', label: 'About Volt Govern', icon: 'info', run: () => open.welcome() }] },
	];
	return (
		<header className="titlebar">
			<div className="titlebar-left">
				<span className="titlebar-brand" title="Volt Govern"><span className="titlebar-mark"><Bolt /></span></span>
				<span className="titlebar-slash" aria-hidden="true" />
				<MenuButton className="org-switcher" title="Switch organization" items={orgMenu}>
					<span className="org-avatar">{orgName.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>
					<span className="org-name">{orgName}</span>
					<ChevronsUpDown />
				</MenuButton>
				<span className="titlebar-divider" aria-hidden="true" />
				{menus.map(m => <MenuButton key={m.label} className="titlebar-menu" items={m.items}>{m.label}</MenuButton>)}
				{/* Narrow windows fold the menu bar into one Application Menu, as VS Code does. */}
				<MenuButton className="titlebar-btn titlebar-hamburger" title="Application Menu"
					items={menus.flatMap((m, i) => [...(i ? [{ id: `sep-${m.label}`, separator: true }] : []), { id: `h-${m.label}`, header: m.label }, ...m.items.filter(x => !x.separator).map(x => ({ ...x, id: `${m.label}-${x.id}` }))])}>
					<Codicon name="menu" />
				</MenuButton>
			</div>
			<button type="button" className="command-center" onClick={() => openQuick('goto')} title={`Search members, teams, skills and commands (${keys('⌘P')})`}>
				<Codicon name="search" size={14} />
				<span className="command-center-label">Search {orgName}</span>
				<Kbd>{keys('⌘P')}</Kbd>
			</button>
			<div className="titlebar-right">
				<button type="button" className={`titlebar-btn${sidebar ? ' on' : ''}`} title={`Toggle Primary Side Bar (${keys('⌘B')})`} onClick={toggleSidebar}><Codicon name={sidebar ? 'layout-sidebar-left' : 'layout-sidebar-left-off'} /></button>
				<button type="button" className={`titlebar-btn${panel ? ' on' : ''}`} title={`Toggle Panel (${keys('⌘J')})`} onClick={togglePanel}><Codicon name={panel ? 'layout-panel' : 'layout-panel-off'} /></button>
				<MenuButton className="titlebar-btn" title="Color Theme" placement="bottom-end" items={[
					{ id: 'dark', label: 'Volt Dark', checked: theme === 'dark', run: () => setThemePreference('dark') },
					{ id: 'light', label: 'Volt Light', checked: theme === 'light', run: () => setThemePreference('light') },
					{ id: 'system', label: 'Follow System', checked: theme === 'system', run: () => setThemePreference('system') },
				]}><Codicon name="color-mode" /></MenuButton>
				<MenuButton className="titlebar-avatar" title="Account" placement="bottom-end" items={accountMenu}><Avatar name={me.user.name || me.user.email} /></MenuButton>
			</div>
		</header>
	);
}

//#endregion

//#region Activity bar

interface IActivity {
	readonly id: ActivityId;
	readonly icon: CodiconName;
	readonly label: string;
}

const ACTIVITIES: readonly IActivity[] = [
	{ id: 'overview', icon: 'dashboard', label: 'Overview' },
	{ id: 'people', icon: 'organization', label: 'People' },
	{ id: 'models', icon: 'key', label: 'Models & Keys' },
	{ id: 'policies', icon: 'law', label: 'Policies' },
	{ id: 'mcp', icon: 'mcp', label: 'MCP Servers' },
	{ id: 'skills', icon: 'library', label: 'Skills & Rules' },
	{ id: 'insights', icon: 'graph', label: 'Insights' },
	{ id: 'security', icon: 'shield', label: 'Security' },
];

export function ActivityBar() {
	const { orgId, can } = useOrg();
	const accountMenu = useAccountMenu();
	const activity = useWorkbench(s => s.activity);
	const visible = useWorkbench(s => s.sidebarVisible);
	const mcp = useMcp(orgId);
	const alerts = useAlerts(can({ usage: ['read'] }) ? orgId : '');
	const pending = mcp.data?.filter(s => s.status === 'pending').length ?? 0;
	const unacked = can({ usage: ['read'] }) ? alerts.data?.filter(a => !a.acknowledgedAt).length ?? 0 : 0;
	const badges: Partial<Record<ActivityId, { n: number; warn?: boolean }>> = {
		mcp: pending && can({ mcp: ['approve'] }) ? { n: pending } : undefined,
		overview: unacked ? { n: unacked, warn: true } : undefined,
	};
	return (
		<nav className="activitybar" aria-label="Activity Bar">
			<div className="activity-group">
				{ACTIVITIES.map(a => (
					<button key={a.id} type="button" className={`activity${activity === a.id && visible ? ' on' : ''}`} title={a.label} aria-label={a.label} aria-pressed={activity === a.id && visible}
						onClick={() => selectActivity(a.id)}>
						<Codicon name={a.icon} />
						{badges[a.id] ? <span className={`activity-badge${badges[a.id]!.warn ? ' warn' : ''}`}>{badges[a.id]!.n}</span> : null}
					</button>
				))}
			</div>
			<div className="activity-group">
				<MenuButton className="activity" title="Accounts" placement="right-start" items={accountMenu}><Codicon name="account" /></MenuButton>
				<MenuButton className="activity" title="Manage" placement="right-start" items={[
					{ id: 'cmd', label: 'Command Palette…', keys: keys('⇧⌘P'), run: () => openQuick('commands') },
					{ id: 's', separator: true },
					{ id: 'settings', label: 'Settings', icon: 'settings-gear', keys: keys('⌘,'), disabled: !can({ settings: ['read'] }), run: () => open.settings() },
					{ id: 'identity', label: 'Identity (SSO & SCIM)', icon: 'shield', disabled: !can({ identity: ['read'] }), run: () => open.identity() },
					{ id: 's2', separator: true },
					{ id: 'theme-dark', label: 'Color Theme: Volt Dark', run: () => setThemePreference('dark') },
					{ id: 'theme-light', label: 'Color Theme: Volt Light', run: () => setThemePreference('light') },
				]}><Codicon name="settings-gear" /></MenuButton>
			</div>
		</nav>
	);
}

//#endregion

//#region Status bar

export function StatusBar() {
	const { orgId, orgName, role, can } = useOrg();
	const overview = useOverview(can({ usage: ['read'] }) ? orgId : '');
	const problems = useProblems();
	const errors = problems.filter(p => p.severity === 'error').length;
	const warnings = problems.filter(p => p.severity === 'warning').length;
	const orgMenu = useOrgMenu();
	const o = overview.data;
	return (
		<footer className="statusbar">
			<div className="status-left">
				<MenuButton className="status-item remote" title="Switch organization" placement="top-start" items={orgMenu}>
					<Codicon name="organization" /> {orgName}
				</MenuButton>
				<button type="button" className="status-item" title="Problems" onClick={() => showPanel('problems')}>
					<Codicon name="error" /> {errors} <Codicon name="warning" /> {warnings}
				</button>
				{o ? (
					<button type="button" className="status-item" title="Gateway, last 30 days" onClick={() => open.usage()}>
						<Codicon name="pulse" /> {formatCount(o.requests30d)} requests · {formatUsd(o.spend30dMicros)}
					</button>
				) : null}
				{o && o.blocked30d ? <button type="button" className="status-item warn" title="Blocked by policy, last 30 days" onClick={() => open.requests()}><Codicon name="circle-slash" /> {formatCount(o.blocked30d)} blocked</button> : null}
			</div>
			<div className="status-right">
				<span className="status-item" title="Your role in this organization"><Codicon name="workspace-trusted" /> {ROLE_LABELS[role as RoleName]?.label ?? role}</span>
				<button type="button" className="status-item" title="Command Palette" onClick={() => openQuick('commands')}><Codicon name="zap" /></button>
				<button type="button" className="status-item" title="Notifications" onClick={() => can({ usage: ['read'] }) ? open.alerts() : showPanel('problems')}><Codicon name={problems.length ? 'bell-dot' : 'bell'} /></button>
			</div>
		</footer>
	);
}

//#endregion

/** VS Code's global keybindings for the console. */
export function useGlobalKeys(): void {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) {
				return;
			}
			const k = e.key.toLowerCase();
			const run = (id: string) => {
				e.preventDefault();
				COMMANDS.find(c => c.id === id)?.run();
			};
			if (k === 'p' && e.shiftKey) { run('workbench.action.showCommands'); }
			else if (k === 'p') { run('workbench.action.quickOpen'); }
			else if (k === 'b' && !e.shiftKey) { run('workbench.action.toggleSidebarVisibility'); }
			else if (k === 'j' && !e.shiftKey) { run('workbench.action.togglePanel'); }
			else if (k === ',') { run('govern.settings'); }
			else if (k === 'w' && !e.shiftKey && !e.altKey) { run('workbench.action.closeActiveEditor'); }
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);
}
