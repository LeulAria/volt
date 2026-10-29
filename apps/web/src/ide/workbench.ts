/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '@volt/client-core';
import { useSyncExternalStore } from 'react';
import { type DiffBase, navigate, type Route, routePath } from '../app/router';

/**
 * The web IDE's layout and open editors, laid out like the desktop workbench: an activity bar
 * and side bar on the left, editor tabs in the middle, the agent panel on the right and a status
 * bar along the bottom. The URL names the active editor; this store remembers the rest.
 */

export type ActivityId = 'chats' | 'explorer' | 'search' | 'scm';

export type EditorTab =
	| { readonly id: string; readonly kind: 'chat'; readonly chatId: string }
	| { readonly id: string; readonly kind: 'file'; readonly path: string }
	| { readonly id: string; readonly kind: 'diff'; readonly path: string; readonly base: DiffBase }
	| { readonly id: string; readonly kind: 'new'; readonly projectId?: string }
	| { readonly id: string; readonly kind: 'settings'; readonly section: string }
	| { readonly id: string; readonly kind: 'changes'; readonly chatId: string }
	| { readonly id: string; readonly kind: 'compare'; readonly groupId: string };

export interface ICursorInfo {
	readonly line: number;
	readonly column: number;
	readonly selected: number;
	readonly language: string;
	readonly tabSize: number;
	readonly insertSpaces: boolean;
	readonly eol: 'LF' | 'CRLF';
}

export type QuickMode = 'files' | 'commands' | 'chats' | 'line';

export interface IWorkbenchState {
	readonly tabs: readonly EditorTab[];
	readonly activeId?: string;
	/** The tab a single click opened (italic); the next single click replaces it. */
	readonly previewId?: string;
	readonly activity: ActivityId;
	readonly sidebarVisible: boolean;
	readonly sidebarWidth: number;
	readonly agentVisible: boolean;
	readonly agentWidth: number;
	/** The chat the agent panel shows (the last chat tab, unless picked there). */
	readonly agentChatId?: string;
	/** The project folder picked for the explorer, search and source control (else the open chat's). */
	readonly root?: string;
	/** The folder they use now (the picked one, or the one the open chat runs in). */
	readonly resolvedRoot?: string;
	readonly dirty: ReadonlySet<string>;
	readonly cursor?: ICursorInfo;
	readonly quick?: { readonly mode: QuickMode; readonly seed: number };
	/** Bumped when files may have changed on the computer (focus, an agent's edit). */
	readonly refresh: number;
	readonly wordWrap: boolean;
	readonly diffInline: boolean;
	/** Where the file in the active editor should reveal (a search hit, a link). */
	readonly reveal?: { readonly path: string; readonly line: number; readonly column?: number; readonly endColumn?: number; readonly seq: number };
}

const LAYOUT_KEY = 'volt.web.workbench';

interface IPersisted {
	readonly tabs?: EditorTab[];
	readonly activity?: ActivityId;
	readonly sidebarVisible?: boolean;
	readonly sidebarWidth?: number;
	readonly agentVisible?: boolean;
	readonly agentWidth?: number;
	readonly agentChatId?: string;
	readonly root?: string;
	readonly wordWrap?: boolean;
	readonly diffInline?: boolean;
}

function load(): IPersisted {
	try {
		const value = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{}') as IPersisted;
		return value && typeof value === 'object' ? value : {};
	} catch {
		return {};
	}
}

const saved = load();
let state: IWorkbenchState = {
	tabs: Array.isArray(saved.tabs) ? saved.tabs.filter(tab => tab && typeof tab.id === 'string').slice(0, 30) : [],
	activity: saved.activity ?? 'chats',
	sidebarVisible: saved.sidebarVisible ?? true,
	sidebarWidth: clamp(saved.sidebarWidth ?? 280, 200, 560),
	agentVisible: saved.agentVisible ?? true,
	agentWidth: clamp(saved.agentWidth ?? 420, 320, 760),
	...(saved.agentChatId ? { agentChatId: saved.agentChatId } : {}),
	...(saved.root ? { root: saved.root } : {}),
	dirty: new Set(),
	refresh: 0,
	wordWrap: saved.wordWrap ?? false,
	diffInline: saved.diffInline ?? false,
};

const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function set(patch: Partial<IWorkbenchState>): void {
	state = { ...state, ...patch };
	listeners.forEach(listener => listener());
	if (persistTimer) {
		clearTimeout(persistTimer);
	}
	persistTimer = setTimeout(() => {
		const persisted: IPersisted = {
			tabs: [...state.tabs],
			activity: state.activity,
			sidebarVisible: state.sidebarVisible,
			sidebarWidth: state.sidebarWidth,
			agentVisible: state.agentVisible,
			agentWidth: state.agentWidth,
			...(state.agentChatId ? { agentChatId: state.agentChatId } : {}),
			...(state.root ? { root: state.root } : {}),
			wordWrap: state.wordWrap,
			diffInline: state.diffInline,
		};
		try {
			window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(persisted));
		} catch {
			// private mode
		}
	}, 300);
}

export function getWorkbench(): IWorkbenchState {
	return state;
}

export function useWorkbench<T>(select: (s: IWorkbenchState) => T): T {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => select(state),
		() => select(state),
	);
}

//#region Tabs and routes

export type TabInput =
	| { readonly kind: 'chat'; readonly chatId: string }
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'diff'; readonly path: string; readonly base: DiffBase }
	| { readonly kind: 'new' }
	| { readonly kind: 'settings' }
	| { readonly kind: 'changes'; readonly chatId: string }
	| { readonly kind: 'compare'; readonly groupId: string };

export function tabId(tab: TabInput): string {
	switch (tab.kind) {
		case 'chat': return `chat:${tab.chatId}`;
		case 'file': return `file:${tab.path}`;
		case 'diff': return `diff:${tab.base.kind === 'head' ? 'head' : tab.base.chatId}:${tab.path}`;
		case 'new': return 'new';
		case 'settings': return 'settings';
		case 'changes': return `changes:${tab.chatId}`;
		case 'compare': return `compare:${tab.groupId}`;
	}
}

/** The editor a route opens; undefined for routes that are not editors (home, pair, files). */
export function tabForRoute(route: Route): EditorTab | undefined {
	switch (route.name) {
		case 'chat': return { id: tabId({ kind: 'chat', chatId: route.id }), kind: 'chat', chatId: route.id };
		case 'file': return { id: tabId({ kind: 'file', path: route.path }), kind: 'file', path: route.path };
		case 'diff': return { id: tabId({ kind: 'diff', path: route.path, base: route.base }), kind: 'diff', path: route.path, base: route.base };
		case 'new': return { id: 'new', kind: 'new', ...(route.projectId ? { projectId: route.projectId } : {}) };
		case 'settings': return { id: 'settings', kind: 'settings', section: route.section };
		case 'changes': return { id: tabId({ kind: 'changes', chatId: route.chatId }), kind: 'changes', chatId: route.chatId };
		case 'compare': return { id: tabId({ kind: 'compare', groupId: route.id }), kind: 'compare', groupId: route.id };
		default: return undefined;
	}
}

export function routeForTab(tab: EditorTab): Route {
	switch (tab.kind) {
		case 'chat': return { name: 'chat', id: tab.chatId };
		case 'file': return { name: 'file', path: tab.path };
		case 'diff': return { name: 'diff', path: tab.path, base: tab.base };
		case 'new': return tab.projectId ? { name: 'new', projectId: tab.projectId } : { name: 'new' };
		case 'settings': return { name: 'settings', section: tab.section };
		case 'changes': return { name: 'changes', chatId: tab.chatId };
		case 'compare': return { name: 'compare', id: tab.groupId };
	}
}

/**
 * Makes `tab` the active editor (called when the route changes). A preview tab is replaced by the
 * next preview unless it was edited; settings and the new chat page update in place.
 */
export function activateTab(tab: EditorTab, options: { readonly preview?: boolean } = {}): void {
	const tabs = [...state.tabs];
	const index = tabs.findIndex(t => t.id === tab.id);
	let previewId = state.previewId;
	if (index >= 0) {
		tabs[index] = tab;
		if (!options.preview && previewId === tab.id) {
			previewId = undefined;
		}
	} else {
		const active = tabs.findIndex(t => t.id === state.activeId);
		const replace = options.preview && previewId && !state.dirty.has(previewId) ? tabs.findIndex(t => t.id === previewId) : -1;
		if (replace >= 0) {
			tabs[replace] = tab;
		} else {
			tabs.splice(active >= 0 ? active + 1 : tabs.length, 0, tab);
		}
		previewId = options.preview ? tab.id : previewId;
	}
	set({ tabs, activeId: tab.id, previewId, ...(tab.kind === 'chat' ? { agentChatId: tab.chatId } : {}) });
}

export function clearActive(): void {
	if (state.activeId) {
		set({ activeId: undefined });
	}
}

/** Opens an editor: navigates to its route (the workbench activates it from there). */
export function openTab(route: Route, options: { readonly preview?: boolean } = {}): void {
	const path = routePath(route);
	if (path === `${window.location.pathname}${window.location.search}`) {
		// Already in front: opening it on purpose keeps it.
		if (!options.preview && state.activeId) {
			pinTab(state.activeId);
		}
		return;
	}
	pendingPreview = !!options.preview;
	navigate(path);
}

let pendingPreview = false;

/** Whether the navigation in flight asked for a preview tab (consumed once). */
export function takePreview(): boolean {
	const preview = pendingPreview;
	pendingPreview = false;
	return preview;
}

export function pinTab(id: string): void {
	if (state.previewId === id) {
		set({ previewId: undefined });
	}
}

/** Closes tabs; the active one hands over to its neighbour. False when unsaved changes were kept. */
export function closeTabs(ids: readonly string[], options: { readonly force?: boolean } = {}): boolean {
	const closing = new Set(ids);
	const remaining = state.tabs.filter(t => !closing.has(t.id));
	// A file's changes are lost only when no other tab (its diff) still shows it.
	const unsaved = [...new Set(state.tabs.filter(t => closing.has(t.id)).map(dirtyKey))]
		.filter((key): key is string => !!key && state.dirty.has(key) && !remaining.some(t => dirtyKey(t) === key));
	if (unsaved.length && !options.force) {
		const names = unsaved.map(id => basename(id.replace(/^file:/, ''))).join(', ');
		if (!window.confirm(`Discard unsaved changes in ${names}?`)) {
			return false;
		}
	}
	const before = state.tabs;
	const tabs = remaining;
	const dirty = new Set([...state.dirty].filter(id => !unsaved.includes(id)));
	unsaved.forEach(id => discardHandlers.get(id)?.());
	const patch: Partial<IWorkbenchState> = { tabs, dirty, ...(state.previewId && closing.has(state.previewId) ? { previewId: undefined } : {}) };
	if (state.activeId && closing.has(state.activeId)) {
		const index = before.findIndex(t => t.id === state.activeId);
		const next = tabs[Math.min(index, tabs.length - 1)];
		set({ ...patch, activeId: next?.id });
		navigate(next ? routePath(routeForTab(next)) : '/', { replace: true });
	} else {
		set(patch);
	}
	return true;
}

export function closeOthers(id: string): void {
	closeTabs(state.tabs.filter(t => t.id !== id).map(t => t.id));
}

export function moveTab(id: string, toIndex: number): void {
	const tabs = [...state.tabs];
	const from = tabs.findIndex(t => t.id === id);
	if (from < 0) {
		return;
	}
	const [tab] = tabs.splice(from, 1);
	tabs.splice(clamp(toIndex, 0, tabs.length), 0, tab);
	set({ tabs });
}

/** The next (or previous) tab, for ⌥⌘→ / ⌥⌘←. */
export function cycleTab(delta: 1 | -1): void {
	const { tabs, activeId } = state;
	if (!tabs.length) {
		return;
	}
	const index = tabs.findIndex(t => t.id === activeId);
	const next = tabs[(index + delta + tabs.length) % tabs.length];
	navigate(routePath(routeForTab(next)));
}

//#endregion

//#region Layout

export function setActivity(activity: ActivityId): void {
	// Clicking the open view's icon folds the side bar, as in the desktop.
	if (state.activity === activity && state.sidebarVisible) {
		set({ sidebarVisible: false });
	} else {
		set({ activity, sidebarVisible: true });
	}
}

export function showActivity(activity: ActivityId): void {
	set({ activity, sidebarVisible: true });
}

export function toggleSidebar(): void {
	set({ sidebarVisible: !state.sidebarVisible });
}

export function setSidebarWidth(width: number): void {
	set({ sidebarWidth: clamp(width, 200, 560) });
}

export function toggleAgentPanel(force?: boolean): void {
	set({ agentVisible: force ?? !state.agentVisible });
}

export function setAgentWidth(width: number): void {
	set({ agentWidth: clamp(width, 320, Math.max(320, window.innerWidth - 520)) });
}

export function setAgentChat(chatId: string | undefined): void {
	set({ agentChatId: chatId, agentVisible: true });
}

export function setRoot(root: string | undefined): void {
	if (root !== state.root) {
		set({ root });
	}
}

export function setResolvedRoot(root: string | undefined): void {
	if (root !== state.resolvedRoot) {
		set({ resolvedRoot: root });
	}
}

export function setDirty(id: string, dirty: boolean): void {
	if (state.dirty.has(id) === dirty) {
		return;
	}
	const next = new Set(state.dirty);
	if (dirty) {
		next.add(id);
		pinTab(id);
	} else {
		next.delete(id);
	}
	set({ dirty: next });
}

export function setCursor(cursor: ICursorInfo | undefined): void {
	set({ cursor });
}

export function openQuick(mode: QuickMode): void {
	set({ quick: { mode, seed: Date.now() } });
}

export function closeQuick(): void {
	if (state.quick) {
		set({ quick: undefined });
	}
}

export function bumpRefresh(): void {
	set({ refresh: state.refresh + 1 });
}

export function toggleWordWrap(): void {
	set({ wordWrap: !state.wordWrap });
}

export function toggleDiffInline(): void {
	set({ diffInline: !state.diffInline });
}

let revealSeq = 0;

/** Opens a file and puts the cursor on a line (search results, `path:line` links). */
export function revealInFile(path: string, line: number, column?: number, endColumn?: number): void {
	set({ reveal: { path, line, ...(column ? { column } : {}), ...(endColumn ? { endColumn } : {}), seq: ++revealSeq } });
	openTab({ name: 'file', path }, { preview: true });
}

//#endregion

//#region Editor hooks (registered by the editors, which load lazily)

const saveHandlers = new Map<string, () => Promise<boolean>>();
const discardHandlers = new Map<string, () => void>();

export function registerEditorHandlers(id: string, handlers: { readonly save: () => Promise<boolean>; readonly discard: () => void }): () => void {
	saveHandlers.set(id, handlers.save);
	discardHandlers.set(id, handlers.discard);
	return () => {
		if (saveHandlers.get(id) === handlers.save) {
			saveHandlers.delete(id);
			discardHandlers.delete(id);
		}
	};
}

/** The id unsaved changes are kept under: a diff edits the same file as its file tab. */
export function dirtyKey(tab: EditorTab | undefined): string | undefined {
	return tab?.kind === 'file' || tab?.kind === 'diff' ? `file:${tab.path}` : tab?.id;
}

export function saveActive(): Promise<boolean> {
	const id = dirtyKey(state.tabs.find(t => t.id === state.activeId));
	const save = id ? saveHandlers.get(id) : undefined;
	return save ? save() : Promise.resolve(false);
}

export function subscribeWorkbench(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export async function saveAll(): Promise<void> {
	for (const id of [...state.dirty]) {
		await saveHandlers.get(id)?.();
	}
}

//#endregion
