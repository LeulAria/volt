/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Permission } from '../../shared/rbac';
import { authClient } from '../lib/auth';
import { keys as kb } from '../lib/format';
import { resetQueries } from '../lib/query';
import { setThemePreference } from '../lib/theme';
import { type ActivityId, closeAllEditors, closeEditor, getWorkbench, openEditor, openQuick, showActivity, showPanel, toggleSidebar, togglePanel } from '../lib/workbench';
import type { CodiconName } from '../ui/icons';

/** Opening editors: one place, so lists, links, the palette and Quick Open open the same tab. */
export const open = {
	welcome: (pinned = true) => openEditor({ kind: 'welcome', title: 'Get Started', icon: 'rocket' }, { pinned }),
	overview: (pinned = true) => openEditor({ kind: 'overview', title: 'Overview', icon: 'dashboard' }, { pinned }),
	alerts: (pinned = true) => openEditor({ kind: 'alerts', title: 'Alerts', icon: 'bell' }, { pinned }),
	myAccess: (pinned = true) => openEditor({ kind: 'my-access', title: 'My Access', icon: 'workspace-trusted' }, { pinned }),
	members: (pinned = true) => openEditor({ kind: 'members', title: 'Members', icon: 'organization' }, { pinned }),
	member: (userId: string, name: string, pinned = false) => openEditor({ kind: 'member', title: name, icon: 'person', params: { userId } }, { pinned }),
	team: (teamId: string, name: string, pinned = false) => openEditor({ kind: 'team', title: name, icon: 'organization', params: { teamId }, description: 'team' }, { pinned }),
	invitations: (pinned = true) => openEditor({ kind: 'invitations', title: 'Invitations', icon: 'mail' }, { pinned }),
	credentials: (pinned = true) => openEditor({ kind: 'credentials', title: 'Provider Keys', icon: 'key' }, { pinned }),
	credential: (id: string, label: string, pinned = false) => openEditor({ kind: 'credential', title: label, icon: 'key', params: { id } }, { pinned }),
	models: (pinned = true) => openEditor({ kind: 'models', title: 'Models', icon: 'sparkle' }, { pinned }),
	policy: (scopeType: 'org' | 'team' | 'user', scopeId: string, label: string, pinned = false) =>
		openEditor({ kind: 'policy', title: label, icon: 'law', params: { scopeType, scopeId }, description: scopeType === 'org' ? 'organization policy' : scopeType === 'team' ? 'team policy' : 'member override' }, { pinned }),
	mcp: (pinned = true) => openEditor({ kind: 'mcp', title: 'MCP Registry', icon: 'mcp' }, { pinned }),
	mcpServer: (id: string, name: string, pinned = false) => openEditor({ kind: 'mcp-server', title: name, icon: 'plug', params: { id }, description: 'MCP server' }, { pinned }),
	skills: (pinned = true) => openEditor({ kind: 'skills', title: 'Skills & Rules', icon: 'library' }, { pinned }),
	skill: (id: string, name: string, pinned = false) => openEditor({ kind: 'skill', title: name, icon: 'book', params: { id } }, { pinned }),
	usage: (pinned = true) => openEditor({ kind: 'usage', title: 'Usage & Cost', icon: 'graph' }, { pinned }),
	requests: (pinned = true) => openEditor({ kind: 'requests', title: 'Gateway Requests', icon: 'pulse' }, { pinned }),
	playground: (pinned = true) => openEditor({ kind: 'playground', title: 'Gateway Playground', icon: 'beaker' }, { pinned }),
	activity: (pinned = true) => openEditor({ kind: 'activity', title: 'Agent Activity', icon: 'robot' }, { pinned }),
	devices: (pinned = true) => openEditor({ kind: 'devices', title: 'Devices', icon: 'device-desktop' }, { pinned }),
	audit: (pinned = true) => openEditor({ kind: 'audit', title: 'Audit Log', icon: 'history' }, { pinned }),
	identity: (pinned = true) => openEditor({ kind: 'identity', title: 'Identity (SSO & SCIM)', icon: 'shield' }, { pinned }),
	settings: (pinned = true) => openEditor({ kind: 'settings', title: 'Settings', icon: 'settings-gear' }, { pinned }),
};

export interface ICommand {
	readonly id: string;
	readonly title: string;
	readonly category: string;
	readonly icon?: CodiconName;
	readonly keys?: string;
	/** Hidden from the palette when the role lacks it. */
	readonly needs?: Permission;
	readonly run: () => void;
}

export async function signOut(): Promise<void> {
	await authClient.signOut();
	resetQueries();
	window.location.assign('/sign-in');
}

const view = (activity: ActivityId) => () => showActivity(activity);

export const COMMANDS: readonly ICommand[] = [
	{ id: 'workbench.action.showCommands', title: 'Show All Commands', category: 'View', keys: kb('⇧⌘P'), run: () => openQuick('commands') },
	{ id: 'workbench.action.quickOpen', title: 'Go to Member, Team, Skill, Server…', category: 'Go', keys: kb('⌘P'), run: () => openQuick('goto') },
	{ id: 'workbench.action.toggleSidebarVisibility', title: 'Toggle Primary Side Bar Visibility', category: 'View', icon: 'layout-sidebar-left', keys: kb('⌘B'), run: toggleSidebar },
	{ id: 'workbench.action.togglePanel', title: 'Toggle Panel Visibility', category: 'View', icon: 'layout-panel', keys: kb('⌘J'), run: togglePanel },
	{ id: 'workbench.actions.view.problems', title: 'Focus on Problems View', category: 'View', run: () => showPanel('problems') },
	{ id: 'workbench.view.gatewayLog', title: 'Show Gateway Log', category: 'View', run: () => showPanel('gateway') },
	{ id: 'workbench.view.auditTail', title: 'Show Audit Stream', category: 'View', run: () => showPanel('audit') },
	{ id: 'workbench.action.closeActiveEditor', title: 'Close Editor', category: 'View', keys: kb('⌘W'), run: () => { const id = getWorkbench().activeId; if (id) { closeEditor(id); } } },
	{ id: 'workbench.action.closeAllEditors', title: 'Close All Editors', category: 'View', run: closeAllEditors },
	{ id: 'view.overview', title: 'Show Overview', category: 'View', icon: 'dashboard', run: view('overview') },
	{ id: 'view.people', title: 'Show People', category: 'View', icon: 'organization', run: view('people') },
	{ id: 'view.models', title: 'Show Models & Keys', category: 'View', icon: 'key', run: view('models') },
	{ id: 'view.policies', title: 'Show Policies', category: 'View', icon: 'law', run: view('policies') },
	{ id: 'view.mcp', title: 'Show MCP Servers', category: 'View', icon: 'mcp', run: view('mcp') },
	{ id: 'view.skills', title: 'Show Skills & Rules', category: 'View', icon: 'library', run: view('skills') },
	{ id: 'view.insights', title: 'Show Insights', category: 'View', icon: 'graph', run: view('insights') },
	{ id: 'view.security', title: 'Show Security', category: 'View', icon: 'shield', run: view('security') },
	{ id: 'govern.getStarted', title: 'Get Started', category: 'Help', icon: 'rocket', run: () => open.welcome() },
	{ id: 'govern.overview', title: 'Open Overview', category: 'Govern', icon: 'dashboard', needs: { usage: ['read'] }, run: () => open.overview() },
	{ id: 'govern.myAccess', title: 'Open My Access', category: 'Govern', icon: 'workspace-trusted', run: () => open.myAccess() },
	{ id: 'govern.members', title: 'Open Members', category: 'People', icon: 'organization', run: () => open.members() },
	{ id: 'govern.invite', title: 'Invite Members…', category: 'People', icon: 'person-add', needs: { invitation: ['create'] }, run: () => { open.members(); window.dispatchEvent(new CustomEvent('govern:invite')); } },
	{ id: 'govern.credentials', title: 'Open Provider Keys', category: 'Models', icon: 'key', needs: { credential: ['read'] }, run: () => open.credentials() },
	{ id: 'govern.addCredential', title: 'Add Provider Key…', category: 'Models', icon: 'add', needs: { credential: ['create'] }, run: () => { open.credentials(); window.dispatchEvent(new CustomEvent('govern:add-credential')); } },
	{ id: 'govern.models', title: 'Open Model Catalog', category: 'Models', icon: 'sparkle', needs: { policy: ['read'] }, run: () => open.models() },
	{ id: 'govern.mcp', title: 'Open MCP Registry', category: 'MCP', icon: 'mcp', run: () => open.mcp() },
	{ id: 'govern.addMcp', title: 'Register MCP Server…', category: 'MCP', icon: 'add', needs: { mcp: ['create'] }, run: () => { open.mcp(); window.dispatchEvent(new CustomEvent('govern:add-mcp')); } },
	{ id: 'govern.skills', title: 'Open Skills & Rules', category: 'Skills', icon: 'library', run: () => open.skills() },
	{ id: 'govern.newSkill', title: 'New Skill…', category: 'Skills', icon: 'new-file', needs: { skill: ['create'] }, run: () => { open.skills(); window.dispatchEvent(new CustomEvent('govern:new-skill')); } },
	{ id: 'govern.usage', title: 'Open Usage & Cost', category: 'Insights', icon: 'graph', needs: { usage: ['read'] }, run: () => open.usage() },
	{ id: 'govern.requests', title: 'Open Gateway Requests', category: 'Insights', icon: 'pulse', needs: { usage: ['read'] }, run: () => open.requests() },
	{ id: 'govern.playground', title: 'Open Gateway Playground', category: 'Insights', icon: 'beaker', needs: { policy: ['update'] }, run: () => open.playground() },
	{ id: 'govern.activity', title: 'Open Agent Activity', category: 'Insights', icon: 'robot', needs: { usage: ['read'] }, run: () => open.activity() },
	{ id: 'govern.devices', title: 'Open Devices', category: 'Security', icon: 'device-desktop', needs: { device: ['read'] }, run: () => open.devices() },
	{ id: 'govern.audit', title: 'Open Audit Log', category: 'Security', icon: 'history', needs: { audit: ['read'] }, run: () => open.audit() },
	{ id: 'govern.exportAudit', title: 'Export Audit Log (NDJSON)', category: 'Security', icon: 'export', needs: { audit: ['read'] }, run: () => window.open('/api/govern/audit/export', '_blank') },
	{ id: 'govern.identity', title: 'Open Identity (SSO & SCIM)', category: 'Security', icon: 'shield', needs: { identity: ['read'] }, run: () => open.identity() },
	{ id: 'govern.settings', title: 'Open Organization Settings', category: 'Preferences', icon: 'settings-gear', keys: kb('⌘,'), needs: { settings: ['read'] }, run: () => open.settings() },
	{ id: 'govern.theme.dark', title: 'Color Theme: Volt Dark', category: 'Preferences', icon: 'eye', run: () => setThemePreference('dark') },
	{ id: 'govern.theme.light', title: 'Color Theme: Volt Light', category: 'Preferences', icon: 'eye', run: () => setThemePreference('light') },
	{ id: 'govern.theme.system', title: 'Color Theme: Follow System', category: 'Preferences', icon: 'eye', run: () => setThemePreference('system') },
	{ id: 'govern.switchOrg', title: 'Switch Organization…', category: 'Account', icon: 'organization', run: () => window.dispatchEvent(new CustomEvent('govern:switch-org')) },
	{ id: 'govern.connectVolt', title: 'Connect Volt on This Computer…', category: 'Account', icon: 'debug-disconnect', run: () => open.myAccess() },
	{ id: 'govern.signOut', title: 'Sign Out', category: 'Account', icon: 'sign-out', run: () => void signOut() },
];
