/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatCounts } from '@volt/client-core';
import { type ReactNode, useMemo } from 'react';
import { useChatItems, useClient, useNow, useStatus } from '../app/client';
import { navigate } from '../app/router';
import { setThemePreference, useThemePreference } from '../app/theme';
import { connectionText, Sidebar } from '../home/Sidebar';
import { type IMenuItem, MenuButton } from '../ui/overlays';
import { Explorer } from './Explorer';
import { useGitStatus } from './git';
import { Codicon, type CodiconName } from './icons';
import { useActiveRoot } from './roots';
import { ScmView } from './ScmView';
import { SearchView } from './SearchView';
import {
	type ActivityId, openQuick, openTab, setActivity, showActivity, toggleAgentPanel, toggleSidebar, useWorkbench
} from './workbench';

function isMac(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function keys(mac: string): string {
	return isMac() ? mac : mac.replace('⌃', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+').replace('⌘', 'Ctrl+');
}

//#region Title bar

export function TitleBar({ appMenu }: { readonly appMenu: readonly IMenuItem[] }) {
	const client = useClient();
	const { root } = useActiveRoot();
	const sidebarVisible = useWorkbench(s => s.sidebarVisible);
	const agentVisible = useWorkbench(s => s.agentVisible);
	return (
		<header className="titlebar">
			<div className="titlebar-left">
				<span className="titlebar-mark" title="Volt"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /></svg></span>
				<MenuButton className="titlebar-btn" items={appMenu} placement="bottom-start" width={280} label="Application Menu"><Codicon name="menu" /></MenuButton>
			</div>
			<div className="titlebar-center">
				<button type="button" className="titlebar-btn nav" title="Go Back" onClick={() => window.history.back()}><Codicon name="arrow-left" /></button>
				<button type="button" className="titlebar-btn nav" title="Go Forward" onClick={() => window.history.forward()}><Codicon name="arrow-right" /></button>
				<button type="button" className="command-center" onClick={() => openQuick('files')} title={`Search files, commands and chats (${keys('⌘P')})`}>
					<Codicon name="search" />
					<span className="command-center-label">{root ? `${root.name}` : 'Volt'} — {client.environment.label}</span>
				</button>
			</div>
			<div className="titlebar-right">
				<button type="button" className={`titlebar-btn${sidebarVisible ? ' on' : ''}`} title={`Toggle Primary Side Bar (${keys('⌘B')})`} onClick={toggleSidebar}><Codicon name={sidebarVisible ? 'layout-sidebar-left' : 'layout-sidebar-left-off'} /></button>
				<button type="button" className={`titlebar-btn${agentVisible ? ' on' : ''}`} title={`Toggle Agent Panel (${keys('⌘L')})`} onClick={() => toggleAgentPanel()}><Codicon name={agentVisible ? 'layout-sidebar-right' : 'layout-sidebar-right-off'} /></button>
			</div>
		</header>
	);
}

//#endregion

//#region Activity bar

const ACTIVITIES: readonly { readonly id: ActivityId; readonly icon: CodiconName; readonly label: string; readonly keys: string }[] = [
	{ id: 'chats', icon: 'comment-discussion', label: 'Chats', keys: '⇧⌘A' },
	{ id: 'explorer', icon: 'files', label: 'Explorer', keys: '⇧⌘E' },
	{ id: 'search', icon: 'search', label: 'Search', keys: '⇧⌘F' },
	{ id: 'scm', icon: 'source-control', label: 'Source Control', keys: '⌃⇧G' },
];

export function ActivityBar() {
	const activity = useWorkbench(s => s.activity);
	const visible = useWorkbench(s => s.sidebarVisible);
	const counts = chatCounts(useChatItems());
	const { root } = useActiveRoot();
	const git = useGitStatus(root?.path);
	const theme = useThemePreference();
	const badges: Partial<Record<ActivityId, { readonly count: number; readonly tone?: string }>> = {
		chats: counts.attention ? { count: counts.attention, tone: 'warn' } : counts.working ? { count: counts.working, tone: 'busy' } : undefined,
		scm: git?.changes.length ? { count: git.changes.length } : undefined,
	};
	const settingsItems: IMenuItem[] = [
		{ id: 'commands', label: 'Command Palette…', icon: 'search', detail: keys('⇧⌘P'), onSelect: () => openQuick('commands') },
		{ id: 'settings', label: 'Settings', icon: 'settings', detail: keys('⌘,'), onSelect: () => openTab({ name: 'settings', section: 'general' }) },
		{ id: 'models', label: 'Models and Providers', icon: 'cpu', onSelect: () => openTab({ name: 'settings', section: 'models' }) },
		{ id: 'devices', label: 'Pair a Phone or Browser…', icon: 'qr', onSelect: () => openTab({ name: 'settings', section: 'devices' }) },
		{ id: 's', label: '', separator: true },
		{ id: 'h', label: 'Color Theme', header: true },
		{ id: 'dark', label: 'Volt Dark', icon: 'moon', checked: theme === 'dark', onSelect: () => setThemePreference('dark') },
		{ id: 'light', label: 'Volt Light', icon: 'sun', checked: theme === 'light', onSelect: () => setThemePreference('light') },
		{ id: 'system', label: 'Follow the System', icon: 'contrast', checked: theme === 'system', onSelect: () => setThemePreference('system') },
	];
	return (
		<nav className="activitybar" aria-label="Views">
			<div className="activity-top">
				{ACTIVITIES.map(a => {
					const badge = badges[a.id];
					const on = visible && activity === a.id;
					return (
						<button key={a.id} type="button" className={`activity${on ? ' on' : ''}`} title={`${a.label} (${keys(a.keys)})`} aria-pressed={on} onClick={() => setActivity(a.id)}>
							<Codicon name={a.icon} size={24} />
							{badge ? <span className={`activity-badge${badge.tone ? ` ${badge.tone}` : ''}`}>{badge.count > 99 ? '99+' : badge.count}</span> : null}
						</button>
					);
				})}
			</div>
			<div className="activity-bottom">
				<button type="button" className="activity" title="Pair a Phone or Browser" onClick={() => openTab({ name: 'settings', section: 'devices' })}><Codicon name="device-mobile" size={22} /></button>
				<MenuButton className="activity" items={settingsItems} placement="top-start" width={260} label="Manage"><Codicon name="settings-gear" size={22} /></MenuButton>
			</div>
		</nav>
	);
}

//#endregion

//#region Side bar

export function SideBar() {
	const activity = useWorkbench(s => s.activity);
	const activeId = useWorkbench(s => s.activeId);
	const client = useClient();
	const counts = chatCounts(useChatItems());
	const chatId = activeId?.startsWith('chat:') ? activeId.slice(5) : undefined;
	const titles: Record<ActivityId, string> = { chats: 'Chats', explorer: 'Explorer', search: 'Search', scm: 'Source Control' };
	let actions: ReactNode = null;
	if (activity === 'chats') {
		actions = <>
			<button type="button" className="ide-icon-btn" title={`New Chat (${keys('⇧⌘O')})`} onClick={() => openTab({ name: 'new' })}><Codicon name="add" /></button>
			{counts.attention ? <button type="button" className="ide-icon-btn" title="Mark All as Read" onClick={() => void client.markAllRead()}><Codicon name="check" /></button> : null}
		</>;
	}
	return (
		<div className="sidebar-part">
			<div className="sidebar-title">
				<span>{titles[activity]}</span>
				<span className="view-actions">{actions}</span>
			</div>
			<div className="sidebar-content">
				{activity === 'chats' ? <Sidebar activeChatId={chatId} embedded /> : null}
				{activity === 'explorer' ? <Explorer /> : null}
				{activity === 'search' ? <SearchView /> : null}
				{activity === 'scm' ? <ScmView /> : null}
			</div>
		</div>
	);
}

//#endregion

//#region Status bar

export function StatusBar() {
	const client = useClient();
	const status = useStatus();
	const now = useNow(1000, status.connection.phase === 'waiting');
	const conn = connectionText(status, now || Date.now());
	const cursor = useWorkbench(s => s.cursor);
	const items = useChatItems();
	const counts = useMemo(() => chatCounts(items), [items]);
	const { root } = useActiveRoot();
	const git = useGitStatus(root?.path);
	return (
		<footer className={`statusbar conn-${conn.tone}`}>
			<div className="status-left">
				<button type="button" className="status-item remote" title={conn.tone === 'ok' ? `Connected to Volt on ${client.environment.label}` : 'Reconnect now'} onClick={() => conn.tone !== 'ok' && client.reconnect()}>
					<Codicon name={conn.tone === 'ok' ? 'remote' : conn.tone === 'busy' ? 'sync' : 'debug-disconnect'} spin={conn.tone === 'busy'} />
					<span>{conn.tone === 'ok' ? client.environment.label : conn.text}</span>
				</button>
				{git?.branch ? (
					<button type="button" className="status-item" title={`${root?.name}: ${git.branch}`} onClick={() => showActivity('scm')}>
						<Codicon name="git-branch" /><span>{git.branch}</span>
						{git.changes.length ? <span className="status-dim">{git.changes.length}</span> : null}
					</button>
				) : null}
				{counts.working ? (
					<button type="button" className="status-item" title="Chats working" onClick={() => showActivity('chats')}>
						<Codicon name="loading" spin /><span>{counts.working} working</span>
					</button>
				) : null}
				{counts.attention ? (
					<button type="button" className="status-item attention" title="Chats waiting on you" onClick={() => showActivity('chats')}>
						<Codicon name="bell" /><span>{counts.attention} {counts.attention === 1 ? 'needs' : 'need'} you</span>
					</button>
				) : null}
			</div>
			<div className="status-right">
				{cursor ? <>
					<button type="button" className="status-item" title="Go to Line" onClick={() => openQuick('line')}>Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</button>
					<span className="status-item">{cursor.insertSpaces ? 'Spaces' : 'Tab Size'}: {cursor.tabSize}</span>
					<span className="status-item">UTF-8</span>
					<span className="status-item">{cursor.eol}</span>
					<span className="status-item">{cursor.language}</span>
				</> : null}
				<button type="button" className="status-item" title="Command Palette" onClick={() => openQuick('commands')}><Codicon name="bell" /></button>
			</div>
		</footer>
	);
}

//#endregion

export function goHome(): void {
	navigate('/');
}
