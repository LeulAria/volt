/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';

/**
 * One session workspace: the chat's files, terminals, browsers, and split.
 * Live widgets stay outside this record. Switching sessions selects a record.
 */

export interface IAgentWorkspaceTerminal {
	readonly id: string;
	readonly title?: string;
	readonly cwd?: string;
}

export interface IAgentWorkspaceFile {
	/** Serialized URI. */
	readonly resource: string;
	readonly pinned?: boolean;
}

export interface IAgentWorkspaceBrowser {
	readonly id: string;
	readonly url: string;
	readonly title?: string;
}

export interface IAgentChatView {
	readonly followTail: boolean;
	readonly scrollTop?: number;
}

export interface IAgentWorkspaceLayout {
	/** Which right-dock surface is showing (changes, browser, terminal, files). */
	readonly dock?: string;
	readonly dockCollapsed?: boolean;
	/** Free-form sizes keyed by surface id. */
	readonly sizes?: Readonly<Record<string, number>>;
	/** Share of the main panel used by the conversation, between 0.25 and 0.75. */
	readonly splitRatio?: number;
	readonly activeSurfaceId?: string;
	/** The bottom panel as this chat left it: open or not, and which view it showed. */
	readonly panel?: IAgentPanelState;
}

export interface IAgentPanelState {
	readonly visible: boolean;
	/** View container id, such as the terminal or problems. */
	readonly container?: string;
}

export interface IAgentFileSurface {
	readonly kind: 'file';
	readonly id: string;
	readonly resource: string;
	readonly title?: string;
	readonly viewState?: unknown;
}

export interface IAgentTerminalSurface {
	readonly kind: 'terminal';
	readonly id: string;
	readonly title?: string;
	readonly cwd?: string;
	/** Terminal instance id while that process is still in this window. */
	readonly terminalInstanceId?: number;
}

export interface IAgentBrowserSurface {
	readonly kind: 'browser';
	readonly id: string;
	readonly url: string;
	readonly title?: string;
	/** Opened by the agent: floats over the chat when no tools are open beside it. Not saved. */
	readonly floating?: boolean;
}

export interface IAgentChangesSurface {
	readonly kind: 'changes';
	readonly id: string;
	readonly title?: string;
}

/** A nested agent chat tab in this session's tools pane (same project binding). */
export interface IAgentChatSurface {
	readonly kind: 'chat';
	readonly id: string;
	readonly title?: string;
	/** Session id of the side chat (its own AgentEditorInput). */
	readonly sessionId: string;
}

export type IAgentSurface = IAgentFileSurface | IAgentTerminalSurface | IAgentBrowserSurface | IAgentChangesSurface | IAgentChatSurface;

export type IAgentSurfaceDraft =
	| { readonly kind: 'file'; readonly resource: string; readonly title?: string }
	| { readonly kind: 'terminal'; readonly title?: string; readonly cwd?: string; readonly terminalInstanceId?: number }
	| { readonly kind: 'browser'; readonly url: string; readonly title?: string; readonly floating?: boolean }
	| { readonly kind: 'changes'; readonly title?: string }
	| { readonly kind: 'chat'; readonly sessionId: string; readonly title?: string };

export interface IAgentProjectBinding {
	readonly projectId: string;
	readonly root: string;
	readonly authority: string;
}

export interface IAgentWorkspaceState {
	readonly sessionId: string;
	readonly projectId?: string;
	readonly root?: string;
	readonly authority?: string;
	readonly createdAt: number;
	readonly lastActiveAt: number;
	/** Last local change. Windows share one stored map and merge by this, newest record wins. */
	readonly updatedAt?: number;
	readonly layout: IAgentWorkspaceLayout;
	readonly chat: IAgentChatView;
	readonly surfaces: readonly IAgentSurface[];
	readonly terminals: readonly IAgentWorkspaceTerminal[];
	readonly files: readonly IAgentWorkspaceFile[];
	readonly browsers: readonly IAgentWorkspaceBrowser[];
	/** Scratch memory scoped to this agent's panel. Values must be JSON-safe and small. */
	readonly memory: Readonly<Record<string, unknown>>;
}

export type AgentWorkspaceSlot = 'layout' | 'terminals' | 'files' | 'browsers' | 'memory' | 'surfaces' | 'chat' | 'binding';

export interface IAgentWorkspaceChangeEvent {
	readonly sessionId: string;
	readonly slot: AgentWorkspaceSlot | undefined;
}

export const IAgentWorkspaceService = createDecorator<IAgentWorkspaceService>('voltAgentWorkspaceService');

export interface IAgentWorkspaceService {
	readonly _serviceBrand: undefined;

	/** Fires when the main panel switches to another agent. */
	readonly onDidChangeActive: Event<IAgentWorkspaceState | undefined>;
	/** Fires when any slot of any workspace changes. */
	readonly onDidChange: Event<IAgentWorkspaceChangeEvent>;

	readonly active: IAgentWorkspaceState | undefined;

	get(sessionId: string): IAgentWorkspaceState | undefined;
	/** The agent's workspace, created clean the first time it is asked for. */
	getOrCreate(sessionId: string): IAgentWorkspaceState;
	/** Make this agent's workspace the one the main panel shows. */
	activate(sessionId: string): IAgentWorkspaceState;
	bindProject(sessionId: string, binding: IAgentProjectBinding): IAgentWorkspaceState;
	openSurface(sessionId: string, draft: IAgentSurfaceDraft, reuse: boolean): IAgentSurface;
	closeSurface(sessionId: string, surfaceId: string): void;
	focusSurface(sessionId: string, surfaceId: string): void;
	setSplitRatio(sessionId: string, ratio: number): void;
	setChatView(sessionId: string, chat: IAgentChatView): void;
	setFileViewState(sessionId: string, surfaceId: string, viewState: unknown): void;
	setTerminalInstance(sessionId: string, surfaceId: string, terminalInstanceId: number): void;
	setBrowserLocation(sessionId: string, surfaceId: string, url: string, title?: string): void;
	setSurfaceTitle(sessionId: string, surfaceId: string, title: string): void;
	update<K extends Exclude<AgentWorkspaceSlot, 'binding'>>(sessionId: string, slot: K, value: IAgentWorkspaceState[K]): void;
	setMemory(sessionId: string, key: string, value: unknown): void;
	delete(sessionId: string): void;
}

const STORAGE_KEY = 'volt.agent.workspaces';
const ACTIVE_KEY = 'volt.agent.workspaces.active';
/** Layout records are durable. The cap only bounds a runaway map, oldest first. */
const MAX_WORKSPACES = 200;
const MAX_MEMORY_KEYS = 32;
const MAX_MEMORY_VALUE = 8_192;
const MAX_MEMORY_CHARS = 32_768;
const SAVE_DELAY_MS = 50;

export function createAgentWorkspace(sessionId: string, now: number): IAgentWorkspaceState {
	return {
		sessionId,
		createdAt: now,
		lastActiveAt: now,
		layout: {},
		chat: { followTail: true },
		surfaces: [],
		terminals: [],
		files: [],
		browsers: [],
		memory: {},
	};
}

export function boundAgentMemory(memory: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(memory)) {
		if (Object.keys(next).length >= MAX_MEMORY_KEYS) {
			break;
		}
		let encoded: string;
		try {
			encoded = JSON.stringify(value);
		} catch {
			continue;
		}
		if (!encoded || encoded.length > MAX_MEMORY_VALUE) {
			continue;
		}
		next[key] = JSON.parse(encoded);
	}
	while (JSON.stringify(next).length > MAX_MEMORY_CHARS) {
		const keys = Object.keys(next);
		if (!keys.length) {
			break;
		}
		delete next[keys[keys.length - 1]];
	}
	return next;
}

export function createSurface(draft: IAgentSurfaceDraft, id = generateUuid()): IAgentSurface {
	switch (draft.kind) {
		case 'file':
			return { kind: 'file', id, resource: draft.resource, title: draft.title };
		case 'terminal':
			return draft.terminalInstanceId === undefined
				? { kind: 'terminal', id, title: draft.title, cwd: draft.cwd }
				: { kind: 'terminal', id, title: draft.title, cwd: draft.cwd, terminalInstanceId: draft.terminalInstanceId };
		case 'browser':
			return draft.floating
				? { kind: 'browser', id, url: draft.url, title: draft.title, floating: true }
				: { kind: 'browser', id, url: draft.url, title: draft.title };
		case 'changes':
			return { kind: 'changes', id, title: draft.title };
		case 'chat':
			return { kind: 'chat', id, sessionId: draft.sessionId, title: draft.title };
		default: {
			const unknown: never = draft;
			return unknown;
		}
	}
}

export function clampSplitRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) {
		return 0.5;
	}
	return Math.min(0.75, Math.max(0.25, ratio));
}

function sameSurface(existing: IAgentSurface, incoming: IAgentSurface): boolean {
	if (existing.kind === 'file' && incoming.kind === 'file') {
		return existing.resource === incoming.resource;
	}
	if (existing.kind === 'browser' && incoming.kind === 'browser') {
		return existing.url === incoming.url;
	}
	if (existing.kind === 'changes' && incoming.kind === 'changes') {
		return true;
	}
	if (existing.kind === 'chat' && incoming.kind === 'chat') {
		return existing.sessionId === incoming.sessionId;
	}
	return false;
}

/** Adds a surface, or focuses the file or browser that is already open when reuse is set. */
export function withSurface(state: IAgentWorkspaceState, incoming: IAgentSurface, reuse: boolean): { state: IAgentWorkspaceState; surface: IAgentSurface } {
	const existing = reuse ? state.surfaces.find(surface => sameSurface(surface, incoming)) : undefined;
	const surface = existing ?? incoming;
	const surfaces = existing ? state.surfaces : [...state.surfaces, incoming];
	return {
		surface,
		state: {
			...state,
			surfaces,
			layout: { ...state.layout, activeSurfaceId: surface.id },
			...legacyFromSurfaces(surfaces),
		},
	};
}

export function withoutSurface(state: IAgentWorkspaceState, surfaceId: string): IAgentWorkspaceState {
	const surfaces = state.surfaces.filter(surface => surface.id !== surfaceId);
	const activeSurfaceId = state.layout.activeSurfaceId === surfaceId ? surfaces.at(-1)?.id : state.layout.activeSurfaceId;
	return {
		...state,
		surfaces,
		layout: { ...state.layout, activeSurfaceId },
		...legacyFromSurfaces(surfaces),
	};
}

export function withActiveSurface(state: IAgentWorkspaceState, surfaceId: string): IAgentWorkspaceState {
	if (!state.surfaces.some(surface => surface.id === surfaceId)) {
		return state;
	}
	return { ...state, layout: { ...state.layout, activeSurfaceId: surfaceId } };
}

function mapSurface(state: IAgentWorkspaceState, surfaceId: string, map: (surface: IAgentSurface) => IAgentSurface): IAgentWorkspaceState {
	const surfaces = state.surfaces.map(surface => surface.id === surfaceId ? map(surface) : surface);
	return { ...state, surfaces, ...legacyFromSurfaces(surfaces) };
}

export function withFileViewState(state: IAgentWorkspaceState, surfaceId: string, viewState: unknown): IAgentWorkspaceState {
	return mapSurface(state, surfaceId, surface => surface.kind === 'file' ? { ...surface, viewState } : surface);
}

export function withTerminalInstance(state: IAgentWorkspaceState, surfaceId: string, terminalInstanceId: number): IAgentWorkspaceState {
	return mapSurface(state, surfaceId, surface => surface.kind === 'terminal' ? { ...surface, terminalInstanceId } : surface);
}

export function withBrowserLocation(state: IAgentWorkspaceState, surfaceId: string, url: string, title?: string): IAgentWorkspaceState {
	return mapSurface(state, surfaceId, surface => surface.kind === 'browser' ? { ...surface, url, title: title ?? surface.title } : surface);
}

export function withSurfaceTitle(state: IAgentWorkspaceState, surfaceId: string, title: string): IAgentWorkspaceState {
	return mapSurface(state, surfaceId, surface => ({ ...surface, title }));
}

function legacyFromSurfaces(surfaces: readonly IAgentSurface[]): Pick<IAgentWorkspaceState, 'files' | 'terminals' | 'browsers'> {
	return {
		files: surfaces.filter((surface): surface is IAgentFileSurface => surface.kind === 'file').map(surface => ({ resource: surface.resource })),
		terminals: surfaces.filter((surface): surface is IAgentTerminalSurface => surface.kind === 'terminal').map(surface => ({ id: surface.id, title: surface.title, cwd: surface.cwd })),
		browsers: surfaces.filter((surface): surface is IAgentBrowserSurface => surface.kind === 'browser').map(surface => ({ id: surface.id, url: surface.url, title: surface.title })),
	};
}

function isSurface(value: unknown): value is IAgentSurface {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const surface = value as IAgentSurface;
	if (typeof surface.id !== 'string' || !surface.id) {
		return false;
	}
	switch (surface.kind) {
		case 'file':
			return typeof surface.resource === 'string' && !!surface.resource;
		case 'terminal':
			return true;
		case 'browser':
			return typeof surface.url === 'string' && !!surface.url;
		case 'changes':
			return true;
		case 'chat':
			return typeof surface.sessionId === 'string' && !!surface.sessionId;
		default:
			return false;
	}
}

/**
 * Terminal instance ids restart with every window load, so a stored id can name
 * an unrelated terminal. Only the surface's own cwd and title survive a reload.
 */
function withoutLiveHandles(surface: IAgentSurface): IAgentSurface {
	if (surface.kind === 'terminal' && surface.terminalInstanceId !== undefined) {
		return { kind: 'terminal', id: surface.id, title: surface.title, cwd: surface.cwd };
	}
	return surface;
}

function surfacesFromLegacy(item: Partial<IAgentWorkspaceState>): IAgentSurface[] {
	if (Array.isArray(item.surfaces)) {
		return item.surfaces.filter(isSurface).map(withoutLiveHandles);
	}
	const surfaces: IAgentSurface[] = [];
	for (const file of item.files ?? []) {
		if (file && typeof file.resource === 'string' && file.resource) {
			surfaces.push({ kind: 'file', id: `file-${file.resource}`, resource: file.resource });
		}
	}
	for (const terminal of item.terminals ?? []) {
		if (terminal && typeof terminal.id === 'string' && terminal.id) {
			surfaces.push({ kind: 'terminal', id: terminal.id, title: terminal.title, cwd: terminal.cwd });
		}
	}
	for (const browser of item.browsers ?? []) {
		if (browser && typeof browser.id === 'string' && browser.id && typeof browser.url === 'string') {
			surfaces.push({ kind: 'browser', id: browser.id, url: browser.url, title: browser.title });
		}
	}
	return surfaces;
}

/** Drops malformed and overflow entries. Idle sessions stay: this is the durable layout copy. */
export function reviveAgentWorkspaces(raw: unknown, now: number): Map<string, IAgentWorkspaceState> {
	const result = new Map<string, IAgentWorkspaceState>();
	if (!Array.isArray(raw)) {
		return result;
	}
	const valid = raw.filter((item: Partial<IAgentWorkspaceState> | null): item is IAgentWorkspaceState =>
		!!item && typeof item === 'object'
		&& typeof item.sessionId === 'string' && !!item.sessionId
		&& typeof item.lastActiveAt === 'number');
	valid.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	for (const item of valid.slice(0, MAX_WORKSPACES)) {
		const fresh = createAgentWorkspace(item.sessionId, item.createdAt ?? now);
		const surfaces = surfacesFromLegacy(item);
		result.set(item.sessionId, {
			...fresh,
			projectId: typeof item.projectId === 'string' ? item.projectId : undefined,
			root: typeof item.root === 'string' ? item.root : undefined,
			authority: typeof item.authority === 'string' ? item.authority : undefined,
			lastActiveAt: item.lastActiveAt,
			updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : item.lastActiveAt,
			layout: item.layout && typeof item.layout === 'object' ? item.layout : fresh.layout,
			chat: item.chat && typeof item.chat === 'object' && typeof item.chat.followTail === 'boolean' ? item.chat : fresh.chat,
			surfaces,
			...legacyFromSurfaces(surfaces),
			memory: item.memory && typeof item.memory === 'object' ? boundAgentMemory(item.memory) : fresh.memory,
		});
	}
	return result;
}

/**
 * Merges this window's records into what another window stored. A record this
 * window changed since its last save always wins; otherwise the newer one does.
 */
export function mergeAgentWorkspaces(
	stored: ReadonlyMap<string, IAgentWorkspaceState>,
	local: ReadonlyMap<string, IAgentWorkspaceState>,
	changedHere: ReadonlySet<string>,
	deletedHere: ReadonlySet<string>,
): Map<string, IAgentWorkspaceState> {
	const merged = new Map(stored);
	for (const [id, record] of local) {
		const other = merged.get(id);
		if (!other || changedHere.has(id) || (record.updatedAt ?? record.lastActiveAt) >= (other.updatedAt ?? other.lastActiveAt)) {
			merged.set(id, record);
		}
	}
	for (const id of deletedHere) {
		merged.delete(id);
	}
	return merged;
}

export class AgentWorkspaceService extends Disposable implements IAgentWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActive = this._register(new Emitter<IAgentWorkspaceState | undefined>());
	readonly onDidChangeActive = this._onDidChangeActive.event;

	private readonly _onDidChange = this._register(new Emitter<IAgentWorkspaceChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly workspaces: Map<string, IAgentWorkspaceState>;
	private activeId: string | undefined;
	private dirty = false;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly changedHere = new Set<string>();
	private readonly deletedHere = new Set<string>();
	private saving = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.workspaces = reviveAgentWorkspaces(this.readStored(), Date.now());
		const active = this.storageService.get(ACTIVE_KEY, StorageScope.APPLICATION, '')
			|| this.storageService.get(ACTIVE_KEY, StorageScope.WORKSPACE, '');
		this.activeId = active && this.workspaces.has(active) ? active : undefined;
		this._register(storageService.onWillSaveState(e => {
			if (this.dirty || e.reason === WillSaveStateReason.SHUTDOWN) {
				this.save();
			}
		}));
		const listeners = this._register(new DisposableStore());
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, STORAGE_KEY, listeners)(e => {
			if (e.external && !this.saving) {
				this.absorbStored();
			}
		}));
	}

	/** Another window saved: take its newer records, keep the ones changed here. */
	private absorbStored(): void {
		const stored = reviveAgentWorkspaces(this.readStored(), Date.now());
		const merged = mergeAgentWorkspaces(stored, this.workspaces, this.changedHere, this.deletedHere);
		for (const [id, record] of merged) {
			if (this.workspaces.get(id) !== record) {
				this.workspaces.set(id, record);
				this._onDidChange.fire({ sessionId: id, slot: 'surfaces' });
			}
		}
	}

	private put(sessionId: string, workspace: IAgentWorkspaceState): void {
		this.workspaces.set(sessionId, { ...workspace, updatedAt: Date.now() });
		this.changedHere.add(sessionId);
		this.deletedHere.delete(sessionId);
	}

	get active(): IAgentWorkspaceState | undefined {
		return this.activeId ? this.workspaces.get(this.activeId) : undefined;
	}

	get(sessionId: string): IAgentWorkspaceState | undefined {
		return this.workspaces.get(sessionId);
	}

	getOrCreate(sessionId: string): IAgentWorkspaceState {
		let workspace = this.workspaces.get(sessionId);
		if (!workspace) {
			workspace = createAgentWorkspace(sessionId, Date.now());
			this.put(sessionId, workspace);
			this.scheduleSave();
		}
		return workspace;
	}

	activate(sessionId: string): IAgentWorkspaceState {
		const workspace = { ...this.getOrCreate(sessionId), lastActiveAt: Date.now() };
		this.put(sessionId, workspace);
		this.scheduleSave();
		if (this.activeId !== sessionId) {
			this.activeId = sessionId;
			this._onDidChangeActive.fire(workspace);
		}
		return workspace;
	}

	bindProject(sessionId: string, binding: IAgentProjectBinding): IAgentWorkspaceState {
		const workspace = {
			...this.getOrCreate(sessionId),
			projectId: binding.projectId,
			root: binding.root,
			authority: binding.authority,
		};
		this.put(sessionId, workspace);
		this.scheduleSave();
		this._onDidChange.fire({ sessionId, slot: 'binding' });
		return workspace;
	}

	openSurface(sessionId: string, draft: IAgentSurfaceDraft, reuse: boolean): IAgentSurface {
		const opened = withSurface(this.getOrCreate(sessionId), createSurface(draft), reuse);
		this.commit(sessionId, { ...opened.state, lastActiveAt: Date.now() }, 'surfaces');
		return opened.surface;
	}

	closeSurface(sessionId: string, surfaceId: string): void {
		const workspace = this.get(sessionId);
		if (!workspace) {
			return;
		}
		this.commit(sessionId, withoutSurface(workspace, surfaceId), 'surfaces');
	}

	focusSurface(sessionId: string, surfaceId: string): void {
		const workspace = this.get(sessionId);
		if (!workspace) {
			return;
		}
		const next = withActiveSurface(workspace, surfaceId);
		if (next === workspace) {
			return;
		}
		this.commit(sessionId, next, 'layout');
	}

	setSplitRatio(sessionId: string, ratio: number): void {
		const workspace = this.getOrCreate(sessionId);
		this.commit(sessionId, { ...workspace, layout: { ...workspace.layout, splitRatio: clampSplitRatio(ratio) } }, 'layout');
	}

	setChatView(sessionId: string, chat: IAgentChatView): void {
		const workspace = this.get(sessionId) ?? this.getOrCreate(sessionId);
		if (workspace.chat.followTail === chat.followTail && workspace.chat.scrollTop === chat.scrollTop) {
			return;
		}
		this.put(sessionId, { ...workspace, chat });
		this.scheduleSave();
	}

	setFileViewState(sessionId: string, surfaceId: string, viewState: unknown): void {
		const workspace = this.get(sessionId);
		if (!workspace) {
			return;
		}
		let encoded: unknown;
		try {
			encoded = JSON.parse(JSON.stringify(viewState));
		} catch {
			return;
		}
		this.put(sessionId, withFileViewState(workspace, surfaceId, encoded));
		this.scheduleSave();
	}

	setTerminalInstance(sessionId: string, surfaceId: string, terminalInstanceId: number): void {
		const workspace = this.get(sessionId);
		if (!workspace) {
			return;
		}
		this.commit(sessionId, withTerminalInstance(workspace, surfaceId, terminalInstanceId), 'surfaces');
	}

	setBrowserLocation(sessionId: string, surfaceId: string, url: string, title?: string): void {
		const workspace = this.get(sessionId);
		if (!workspace) {
			return;
		}
		this.commit(sessionId, withBrowserLocation(workspace, surfaceId, url, title), 'surfaces');
	}

	setSurfaceTitle(sessionId: string, surfaceId: string, title: string): void {
		const workspace = this.get(sessionId);
		if (!workspace || !title) {
			return;
		}
		const surface = workspace.surfaces.find(item => item.id === surfaceId);
		if (!surface || surface.title === title) {
			return;
		}
		this.commit(sessionId, withSurfaceTitle(workspace, surfaceId, title), 'surfaces');
	}

	update<K extends Exclude<AgentWorkspaceSlot, 'binding'>>(sessionId: string, slot: K, value: IAgentWorkspaceState[K]): void {
		const workspace = this.getOrCreate(sessionId);
		const next: IAgentWorkspaceState = slot === 'memory' && value && typeof value === 'object'
			? { ...workspace, memory: boundAgentMemory(value as Readonly<Record<string, unknown>>) }
			: { ...workspace, [slot]: value };
		this.commit(sessionId, next, slot);
	}

	setMemory(sessionId: string, key: string, value: unknown): void {
		const memory = { ...this.getOrCreate(sessionId).memory };
		if (value === undefined) {
			delete memory[key];
		} else {
			memory[key] = value;
		}
		this.update(sessionId, 'memory', boundAgentMemory(memory));
	}

	delete(sessionId: string): void {
		if (!this.workspaces.delete(sessionId)) {
			return;
		}
		this.changedHere.delete(sessionId);
		this.deletedHere.add(sessionId);
		this.scheduleSave();
		this._onDidChange.fire({ sessionId, slot: undefined });
		if (this.activeId === sessionId) {
			this.activeId = undefined;
			this._onDidChangeActive.fire(undefined);
		}
	}

	private commit(sessionId: string, workspace: IAgentWorkspaceState, slot: AgentWorkspaceSlot): void {
		this.put(sessionId, workspace);
		this.scheduleSave();
		this._onDidChange.fire({ sessionId, slot });
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer !== undefined) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.save();
		}, SAVE_DELAY_MS);
	}

	private readStored(): unknown {
		const application = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '');
		const raw = application || this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, '[]');
		try {
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	private save(): void {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		this.dirty = false;
		// Read-merge-write so a save here never replaces what another window stored since.
		const stored = reviveAgentWorkspaces(this.readStored(), Date.now());
		const merged = mergeAgentWorkspaces(stored, this.workspaces, this.changedHere, this.deletedHere);
		for (const [id, record] of merged) {
			if (!this.workspaces.has(id) || this.workspaces.get(id) !== record) {
				this.workspaces.set(id, record);
			}
		}
		this.changedHere.clear();
		this.saving = true;
		try {
			this.storageService.store(STORAGE_KEY, JSON.stringify([...merged.values()]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} finally {
			this.saving = false;
		}
		if (this.activeId) {
			this.storageService.store(ACTIVE_KEY, this.activeId, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(ACTIVE_KEY, StorageScope.APPLICATION);
		}
	}
}

registerSingleton(IAgentWorkspaceService, AgentWorkspaceService, InstantiationType.Delayed);
