/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';
import type { CodiconName } from '../ui/icons';

/**
 * The workbench model: which activity the side bar shows, the editor tabs (VS Code semantics:
 * one italic preview tab that the next single-click replaces; double-click, editing or Enter pins
 * it), the panel, and their sizes. Layout and open editors survive a reload.
 */
export type ActivityId = 'overview' | 'people' | 'models' | 'policies' | 'mcp' | 'skills' | 'insights' | 'security';

export type EditorKind =
	| 'welcome' | 'overview' | 'alerts' | 'my-access'
	| 'members' | 'member' | 'team' | 'invitations'
	| 'credentials' | 'credential' | 'models'
	| 'policy'
	| 'mcp' | 'mcp-server'
	| 'skills' | 'skill'
	| 'usage' | 'requests' | 'activity' | 'devices' | 'playground'
	| 'audit' | 'identity' | 'settings';

export interface IEditorInput {
	readonly id: string;
	readonly kind: EditorKind;
	readonly title: string;
	readonly icon: CodiconName;
	readonly params?: Readonly<Record<string, string>>;
	readonly description?: string;
	readonly preview?: boolean;
	readonly dirty?: boolean;
}

export type PanelTab = 'problems' | 'gateway' | 'audit';
export type QuickMode = 'commands' | 'goto' | undefined;

interface IState {
	readonly activity: ActivityId;
	readonly sidebarVisible: boolean;
	readonly sidebarWidth: number;
	readonly panelVisible: boolean;
	readonly panelHeight: number;
	readonly panelTab: PanelTab;
	readonly editors: readonly IEditorInput[];
	readonly activeId: string | undefined;
	readonly quick: QuickMode;
}

const KEY = 'volt.govern.workbench';
export const DEFAULT_SIDEBAR = 280;
export const DEFAULT_PANEL = 220;

function restore(): IState {
	const fallback: IState = { activity: 'overview', sidebarVisible: true, sidebarWidth: DEFAULT_SIDEBAR, panelVisible: false, panelHeight: DEFAULT_PANEL, panelTab: 'problems', editors: [], activeId: undefined, quick: undefined };
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<IState>;
		return { ...fallback, ...saved, editors: (saved.editors ?? []).map(e => ({ ...e, dirty: false })), quick: undefined };
	} catch {
		return fallback;
	}
}

let state: IState = restore();
const listeners = new Set<() => void>();

function set(patch: Partial<IState>): void {
	state = { ...state, ...patch };
	listeners.forEach(l => l());
	try {
		const { quick: _quick, ...rest } = state;
		localStorage.setItem(KEY, JSON.stringify(rest));
	} catch {
		// Private mode: layout lasts for the page.
	}
}

export function useWorkbench<T>(select: (s: IState) => T): T {
	return useSyncExternalStore(l => (listeners.add(l), () => listeners.delete(l)), () => select(state));
}

export function getWorkbench(): IState {
	return state;
}

export function editorId(kind: EditorKind, params?: Readonly<Record<string, string>>): string {
	return params ? `${kind}:${Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&')}` : kind;
}

/** Opens (or focuses) an editor. `pinned: false` opens it as the preview tab. */
export function openEditor(input: Omit<IEditorInput, 'id' | 'preview' | 'dirty'>, options?: { readonly pinned?: boolean }): void {
	const id = editorId(input.kind, input.params);
	const pinned = options?.pinned ?? true;
	const existing = state.editors.find(e => e.id === id);
	if (existing) {
		set({
			activeId: id,
			editors: state.editors.map(e => e.id === id ? { ...e, title: input.title, icon: input.icon, description: input.description, preview: e.preview && !pinned } : e),
		});
		return;
	}
	const next: IEditorInput = { ...input, id, preview: !pinned };
	const editors = [...state.editors];
	const previewAt = editors.findIndex(e => e.preview && !e.dirty);
	const activeAt = editors.findIndex(e => e.id === state.activeId);
	if (!pinned && previewAt >= 0) {
		editors[previewAt] = next;
	} else {
		editors.splice(activeAt >= 0 ? activeAt + 1 : editors.length, 0, next);
	}
	set({ editors, activeId: id });
}

export function pinEditor(id: string): void {
	set({ editors: state.editors.map(e => e.id === id ? { ...e, preview: false } : e) });
}

export function setEditorDirty(id: string, dirty: boolean): void {
	const e = state.editors.find(x => x.id === id);
	if (e && !!e.dirty !== dirty) {
		set({ editors: state.editors.map(x => x.id === id ? { ...x, dirty, preview: dirty ? false : x.preview } : x) });
	}
}

export function setActiveEditor(id: string): void {
	set({ activeId: id });
}

export function closeEditor(id: string): void {
	const i = state.editors.findIndex(e => e.id === id);
	if (i < 0) {
		return;
	}
	const editors = state.editors.filter(e => e.id !== id);
	const activeId = state.activeId === id ? (editors[i] ?? editors[i - 1])?.id : state.activeId;
	set({ editors, activeId });
}

export function closeEditors(filter: (e: IEditorInput) => boolean): void {
	const editors = state.editors.filter(e => !filter(e));
	set({ editors, activeId: editors.some(e => e.id === state.activeId) ? state.activeId : editors.at(-1)?.id });
}

export function closeAllEditors(): void {
	set({ editors: state.editors.filter(e => e.dirty), activeId: state.editors.find(e => e.dirty)?.id });
}

/** Clicking the active activity hides the side bar; another shows it with that view (VS Code). */
export function selectActivity(activity: ActivityId): void {
	if (state.activity === activity && state.sidebarVisible) {
		set({ sidebarVisible: false });
	} else {
		set({ activity, sidebarVisible: true });
	}
}

export function showActivity(activity: ActivityId): void {
	set({ activity, sidebarVisible: true });
}

export const toggleSidebar = () => set({ sidebarVisible: !state.sidebarVisible });
export const setSidebarWidth = (sidebarWidth: number) => set({ sidebarWidth });
export const togglePanel = () => set({ panelVisible: !state.panelVisible });
export const showPanel = (panelTab: PanelTab) => set({ panelVisible: true, panelTab });
export const setPanelHeight = (panelHeight: number) => set({ panelHeight });
export const openQuick = (quick: QuickMode) => set({ quick });
export const closeQuick = () => set({ quick: undefined });

/** On organization switch the open editors belong to the old one. */
export function resetEditors(): void {
	set({ editors: [], activeId: undefined });
}
