/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef } from 'react';
import { useClient, useStatus } from '../app/client';
import { navigate, routePath, useRoute } from '../app/router';
import { setThemePreference } from '../app/theme';
import { type IMenuItem } from '../ui/overlays';
import { AgentPanel } from './AgentPanel';
import { ActivityBar, keys, SideBar, StatusBar, TitleBar } from './Chrome';
import { EditorArea } from './EditorArea';
import { type ICommand, QuickInput, rememberRecentFile } from './QuickInput';
import { Sash } from './Sash';
import {
	activateTab, bumpRefresh, clearActive, closeTabs, cycleTab, getWorkbench, openQuick, openTab, routeForTab, saveActive, saveAll, setActivity, setAgentWidth, setSidebarWidth,
	showActivity, subscribeWorkbench, tabForRoute, takePreview, toggleAgentPanel, toggleDiffInline, toggleSidebar, toggleWordWrap, useWorkbench
} from './workbench';

/**
 * Volt's web IDE, laid out like the desktop workbench: title bar, activity bar, side bar (chats,
 * explorer, search, source control), editor tabs (chats, files in Monaco, diffs, reviews), the
 * agent panel on the right and the status bar.
 */
export function Workbench({ onSignedOut }: { readonly onSignedOut: () => void }) {
	const client = useClient();
	const status = useStatus();
	const route = useRoute();
	const sidebarVisible = useWorkbench(s => s.sidebarVisible);
	const sidebarWidth = useWorkbench(s => s.sidebarWidth);
	const agentVisible = useWorkbench(s => s.agentVisible);
	const agentWidth = useWorkbench(s => s.agentWidth);
	const activeId = useWorkbench(s => s.activeId);
	const routeKey = routePath(route);
	const restored = useRef(false);

	// The URL names the active editor; the store keeps the tabs.
	useEffect(() => {
		const tab = tabForRoute(route);
		if (tab) {
			activateTab(tab, { preview: takePreview() });
			if (tab.kind === 'file') {
				rememberRecentFile(tab.path);
			}
		} else if (route.name === 'files') {
			showActivity('explorer');
			navigate('/', { replace: true });
		} else if (route.name === 'home') {
			// A fresh page at `/` reopens the editor that was in front last time.
			const last = !restored.current ? lastActive() : undefined;
			if (last) {
				navigate(routePath(routeForTab(last)), { replace: true });
			} else {
				clearActive();
			}
		}
		restored.current = true;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeKey]);

	useEffect(() => {
		try {
			if (activeId) {
				window.localStorage.setItem(ACTIVE_KEY, activeId);
			}
		} catch {
			// private mode
		}
	}, [activeId]);

	// Files may have changed on the computer: when the page comes back, and when agents edit.
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const soon = () => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(bumpRefresh, 1200);
		};
		const onFocus = () => bumpRefresh();
		window.addEventListener('focus', onFocus);
		const unsubscribe = [client.subscribe('col:edits', soon), client.subscribe('col:checkpoints', soon)];
		return () => {
			window.removeEventListener('focus', onFocus);
			unsubscribe.forEach(u => u());
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, [client]);

	// Open files nobody edited here follow what the agent writes.
	useEffect(() => {
		let last = getWorkbench().refresh;
		return subscribeWorkbench(() => {
			const { refresh, tabs } = getWorkbench();
			if (refresh !== last) {
				last = refresh;
				if (tabs.some(t => t.kind === 'file' || t.kind === 'diff')) {
					void import('./monaco/Editors').then(m => m.refreshFiles());
				}
			}
		});
	}, []);

	useEffect(() => {
		if (status.live) {
			bumpRefresh();
		}
	}, [status.live]);

	const commands = useMemo((): ICommand[] => [
		{ id: 'new-chat', category: 'Volt', label: 'New Chat', keybinding: keys('⇧⌘O'), icon: 'add', run: () => openTab({ name: 'new' }) },
		{ id: 'go-chat', category: 'Volt', label: 'Go to Chat…', keybinding: '#', icon: 'comment-discussion', run: () => openQuick('chats') },
		{ id: 'agent', category: 'View', label: 'Toggle Agent Panel', keybinding: keys('⌘L'), icon: 'layout-sidebar-right', run: () => toggleAgentPanel() },
		{ id: 'go-file', category: 'Go', label: 'Go to File…', keybinding: keys('⌘P'), icon: 'go-to-file', run: () => openQuick('files') },
		{ id: 'go-line', category: 'Go', label: 'Go to Line…', keybinding: keys('⌃G'), icon: 'arrow-right', run: () => openQuick('line') },
		{ id: 'save', category: 'File', label: 'Save', keybinding: keys('⌘S'), icon: 'save', run: () => void saveActive() },
		{ id: 'save-all', category: 'File', label: 'Save All', keybinding: keys('⌥⌘S'), icon: 'save', run: () => void saveAll() },
		{ id: 'close', category: 'View', label: 'Close Editor', keybinding: keys('⌥⌘W'), icon: 'close', run: () => closeActive() },
		{ id: 'close-all', category: 'View', label: 'Close All Editors', icon: 'close-all', run: () => closeTabs(getWorkbench().tabs.map(t => t.id)) },
		{ id: 'next', category: 'View', label: 'Open Next Editor', keybinding: keys('⌥⌘→'), icon: 'arrow-right', run: () => cycleTab(1) },
		{ id: 'prev', category: 'View', label: 'Open Previous Editor', keybinding: keys('⌥⌘←'), icon: 'arrow-left', run: () => cycleTab(-1) },
		{ id: 'sidebar', category: 'View', label: 'Toggle Primary Side Bar', keybinding: keys('⌘B'), icon: 'layout-sidebar-left', run: toggleSidebar },
		{ id: 'chats', category: 'View', label: 'Show Chats', keybinding: keys('⇧⌘A'), icon: 'comment-discussion', run: () => showActivity('chats') },
		{ id: 'explorer', category: 'View', label: 'Show Explorer', keybinding: keys('⇧⌘E'), icon: 'files', run: () => showActivity('explorer') },
		{ id: 'search', category: 'View', label: 'Show Search', keybinding: keys('⇧⌘F'), icon: 'search', run: () => showActivity('search') },
		{ id: 'scm', category: 'View', label: 'Show Source Control', keybinding: keys('⌃⇧G'), icon: 'source-control', run: () => showActivity('scm') },
		{ id: 'wrap', category: 'View', label: 'Toggle Word Wrap', keybinding: keys('⌥Z'), icon: 'word-wrap', run: toggleWordWrap },
		{ id: 'inline', category: 'Diff', label: 'Toggle Inline View', icon: 'list-flat', run: toggleDiffInline },
		{ id: 'refresh', category: 'Files', label: 'Refresh Explorer and Source Control', icon: 'refresh', run: bumpRefresh },
		{ id: 'stop', category: 'Volt', label: 'Stop the Agent', icon: 'debug-stop', run: () => {
			const chatId = getWorkbench().agentChatId;
			if (chatId) {
				void client.stop(chatId);
			}
		} },
		{ id: 'review', category: 'Volt', label: 'Review Changes in This Chat', icon: 'git-compare', run: () => {
			const chatId = getWorkbench().agentChatId;
			if (chatId) {
				openTab({ name: 'changes', chatId });
			}
		} },
		{ id: 'settings', category: 'Preferences', label: 'Open Settings', keybinding: keys('⌘,'), icon: 'settings-gear', run: () => openTab({ name: 'settings', section: 'general' }) },
		{ id: 'models', category: 'Preferences', label: 'Models and Providers', icon: 'robot', run: () => openTab({ name: 'settings', section: 'models' }) },
		{ id: 'pair', category: 'Volt', label: 'Pair a Phone or Browser…', icon: 'device-mobile', run: () => openTab({ name: 'settings', section: 'devices' }) },
		{ id: 'dark', category: 'Preferences', label: 'Color Theme: Volt Dark', icon: 'color-mode', run: () => setThemePreference('dark') },
		{ id: 'light', category: 'Preferences', label: 'Color Theme: Volt Light', icon: 'color-mode', run: () => setThemePreference('light') },
		{ id: 'system', category: 'Preferences', label: 'Color Theme: Follow the System', icon: 'color-mode', run: () => setThemePreference('system') },
		{ id: 'reconnect', category: 'Volt', label: 'Reconnect', icon: 'plug', run: () => client.reconnect() },
		{ id: 'reload', category: 'Developer', label: 'Reload Window', icon: 'refresh', run: () => window.location.reload() },
	], [client]);

	const appMenu = useMemo((): IMenuItem[] => [
		{ id: 'h1', label: 'File', header: true },
		{ id: 'new', label: 'New Chat', icon: 'compose', detail: keys('⇧⌘O'), onSelect: () => openTab({ name: 'new' }) },
		{ id: 'open', label: 'Go to File…', icon: 'search', detail: keys('⌘P'), onSelect: () => openQuick('files') },
		{ id: 'save', label: 'Save', icon: 'check', detail: keys('⌘S'), onSelect: () => void saveActive() },
		{ id: 'save-all', label: 'Save All', icon: 'check', detail: keys('⌥⌘S'), onSelect: () => void saveAll() },
		{ id: 's1', label: '', separator: true },
		{ id: 'h2', label: 'View', header: true },
		{ id: 'commands', label: 'Command Palette…', icon: 'menu', detail: keys('⇧⌘P'), onSelect: () => openQuick('commands') },
		{ id: 'explorer', label: 'Explorer', icon: 'folder', detail: keys('⇧⌘E'), onSelect: () => showActivity('explorer') },
		{ id: 'search', label: 'Search', icon: 'search', detail: keys('⇧⌘F'), onSelect: () => showActivity('search') },
		{ id: 'scm', label: 'Source Control', icon: 'branch', detail: keys('⌃⇧G'), onSelect: () => showActivity('scm') },
		{ id: 'agent', label: 'Agent Panel', icon: 'sidebar', detail: keys('⌘L'), onSelect: () => toggleAgentPanel() },
		{ id: 's2', label: '', separator: true },
		{ id: 'settings', label: 'Settings', icon: 'settings', detail: keys('⌘,'), onSelect: () => openTab({ name: 'settings', section: 'general' }) },
	], []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			const key = e.key.toLowerCase();
			const handled = (run: () => void) => {
				e.preventDefault();
				e.stopPropagation();
				run();
			};
			if (getWorkbench().quick) {
				return;
			}
			if (mod && e.shiftKey && key === 'p') {
				handled(() => openQuick('commands'));
			} else if (mod && !e.shiftKey && key === 'p') {
				handled(() => openQuick('files'));
			} else if (mod && e.shiftKey && key === 'o') {
				handled(() => openTab({ name: 'new' }));
			} else if (mod && !e.shiftKey && !e.altKey && key === 'b') {
				handled(toggleSidebar);
			} else if (mod && !e.shiftKey && !e.altKey && key === 'l') {
				handled(() => toggleAgentPanel());
			} else if (mod && e.shiftKey && key === 'e') {
				handled(() => setActivity('explorer'));
			} else if (mod && e.shiftKey && key === 'f') {
				handled(() => showActivity('search'));
			} else if (mod && e.shiftKey && key === 'a') {
				handled(() => setActivity('chats'));
			} else if (e.ctrlKey && e.shiftKey && key === 'g') {
				handled(() => setActivity('scm'));
			} else if (e.ctrlKey && !e.shiftKey && !e.metaKey && key === 'g') {
				handled(() => openQuick('line'));
			} else if (mod && !e.shiftKey && key === 's') {
				handled(() => void (e.altKey ? saveAll() : saveActive()));
			} else if (mod && e.altKey && (key === 'w' || e.code === 'KeyW')) {
				handled(closeActive);
			} else if (mod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
				handled(() => cycleTab(e.key === 'ArrowRight' ? 1 : -1));
			} else if (mod && key === ',') {
				handled(() => openTab({ name: 'settings', section: 'general' }));
			} else if (e.altKey && !mod && e.code === 'KeyZ') {
				handled(toggleWordWrap);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	// Unsaved files are not lost to a closed tab or a reload.
	useEffect(() => {
		const onUnload = (e: BeforeUnloadEvent) => {
			if (getWorkbench().dirty.size) {
				e.preventDefault();
			}
		};
		window.addEventListener('beforeunload', onUnload);
		return () => window.removeEventListener('beforeunload', onUnload);
	}, []);

	return (
		<div className="workbench">
			<TitleBar appMenu={appMenu} />
			<div className="wb-main">
				<ActivityBar />
				{sidebarVisible ? (
					<>
						<div className="sidebar-slot" style={{ width: sidebarWidth }}><SideBar /></div>
						<Sash side="left" width={sidebarWidth} onResize={setSidebarWidth} onReset={() => setSidebarWidth(280)} />
					</>
				) : null}
				<main className="editor-part">
					{!status.live && status.ready ? <OfflineStrip /> : null}
					<EditorArea onSignedOut={onSignedOut} />
				</main>
				{agentVisible ? (
					<>
						<Sash side="right" width={agentWidth} onResize={setAgentWidth} onReset={() => setAgentWidth(420)} />
						<div className="agent-slot" style={{ width: agentWidth }}><AgentPanel /></div>
					</>
				) : null}
			</div>
			<StatusBar />
			<QuickInput commands={commands} />
		</div>
	);
}

const ACTIVE_KEY = 'volt.web.activeTab';

function lastActive() {
	try {
		const id = window.localStorage.getItem(ACTIVE_KEY);
		return getWorkbench().tabs.find(t => t.id === id);
	} catch {
		return undefined;
	}
}

function closeActive(): void {
	const id = getWorkbench().activeId;
	if (id) {
		closeTabs([id]);
	}
}

function OfflineStrip() {
	const client = useClient();
	return (
		<div className="offline-banner">
			<span>Showing what Volt last sent. Changes go out when {client.environment.label} is back.</span>
			<button type="button" onClick={() => client.reconnect()}>Retry now</button>
		</div>
	);
}
