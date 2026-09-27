/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { CodeDataTransfers, containsDragType, extractEditorsDropData, LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { DraggedEditorIdentifier } from '../../../../browser/dnd.js';
import { IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService, TerminalDataTransfers } from '../../../terminal/browser/terminal.js';
import { getTerminalResourcesFromDragEvent } from '../../../terminal/browser/terminalUri.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { DEFAULT_BROWSER_URL, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { sanitizeBrowserUrl } from '../preview/localPreview.js';
import { AgentChangesEditorInput } from '../review/agentChangesEditor.js';
import { AgentSurfaceAddMenu, IAgentSurfaceAddMenuHost } from './agentSurfaceAddMenu.js';
import { type AgentSurfaceMenuActionId } from './agentSurfaceMenu.js';
import { AgentToolsEditorPart, AgentToolsPartContext, hasSavedAgentTools } from './agentToolsEditorPart.js';
import { attachSessionToProject } from './agentShell.js';
import { IAgentChatView, IAgentSurface, IAgentWorkspaceService } from './agentWorkspace.js';

export { chooseAgentBrowserSurfaceMount, type AgentBrowserSurfaceMount } from './agentBrowserMount.js';
export { shouldHideAgentQuickOpenRail, surfaceKindForMenuAction, agentSurfaceMenuItems } from './agentSurfaceMenu.js';

const MIN_PANE = 240;
/** Matches `.volt-agent-surface-sash`: a 1px line with an invisible grab area around it. */
const SASH_WIDTH = 1;
/** The tools area's grab strip, centered on the split line. Matches `.volt-agent-tools-grip`. */
const GRIP_WIDTH = 7;
const GRIP_OFFSET = Math.floor(GRIP_WIDTH / 2);
/** Tools areas kept alive for chats you switched away from. Older ones are saved and dropped. */
const MAX_LIVE_TOOL_PARTS = 8;
const OPEN_TOOLS_ADD_MENU_ID = 'workbench.action.voltAgentTools.add';

/** What a drag carries that a session surface can take. */
export interface IAgentSurfaceDragKinds {
	readonly terminals: boolean;
	readonly editorTabs: boolean;
	readonly files: boolean;
}

/**
 * With the tools closed, only a dragged tab or terminal opens beside the chat.
 * A dragged file still becomes a mention in the composer, as before.
 */
export function surfaceDropAccepted(kinds: IAgentSurfaceDragKinds, panelOpen: boolean, overPanel: boolean, overRightHalf: boolean): boolean {
	if (panelOpen && overPanel) {
		return kinds.terminals || kinds.editorTabs || kinds.files;
	}
	return !panelOpen && overRightHalf && (kinds.terminals || kinds.editorTabs);
}

/** The tools pane splits beside chat only while at least one surface tab remains. */
export function shouldOpenSurfaceSplit(surfaceCount: number): boolean {
	return surfaceCount > 0;
}

/** Closing this tab closes the tools pane: it is the only one open. */
export function isLastOpenSurface(surfaceIds: readonly string[], surfaceId: string): boolean {
	return surfaceIds.length === 1 && surfaceIds[0] === surfaceId;
}

/** 1-based line range to reveal once a file surface has its editor. */
export interface IAgentFileReveal {
	readonly startLine: number;
	readonly endLine?: number;
}

interface IToolsPart {
	readonly sessionId: string;
	readonly part: AgentToolsEditorPart;
	readonly element: HTMLElement;
	readonly store: DisposableStore;
	lastUsed: number;
	/** The chat view showing this area now. A chat can move between views, e.g. on a layout switch. */
	holder: AgentSurfaceHost | undefined;
}

/** Every live host, so the tools + action and a side chat can find the one they belong to. */
const hosts = new Set<AgentSurfaceHost>();
/** Each chat's tools area, shared by every chat view: it moves to whichever view shows the chat. */
const toolParts = new Map<string, IToolsPart>();
/** The host whose tools currently run up into the primary title bar. */
let titlebarOwner: AgentSurfaceHost | undefined;
let partClock = 0;

/**
 * The right half of one agent window: a real editor area per chat, so its tabs
 * have the IDE's tab menu, drag to reorder, and drag to split into groups.
 * In agent layout the area also takes the title bar row above it, so its first
 * tab row sits in the title bar. Areas stay alive when the chat changes, so a
 * terminal or browser keeps running and is not loaded again on the way back.
 */
export class AgentSurfaceHost extends Disposable {

	private readonly sash: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly dropOverlay: HTMLElement;
	/** Fixed over the right side of the window, outside the editor's clipping. */
	private readonly area: HTMLElement;
	private readonly grip: HTMLElement;
	private readonly partsHost: HTMLElement;
	private readonly addMenu: AgentSurfaceAddMenu;
	private readonly titlebarWatch = this._register(new MutableDisposable());
	private titlebar: HTMLElement | undefined;
	private sessionId: string | undefined;
	private shown: IToolsPart | undefined;
	private open = false;
	private ratio = 0.5;
	private dragging = false;
	private disposed = false;
	private consuming = false;
	private lastDimension: Dimension | undefined;
	private lastPointerTarget: HTMLElement | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly chat: HTMLElement,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		hosts.add(this);
		this.sash = append(container, $('.volt-agent-surface-sash.hidden'));
		this.sash.title = localize('voltAgent.resizeSurfaces', "Resize chat and tools");
		// Holds the tools' share of the row; the tools area is laid over it.
		this.panel = append(container, $('.volt-agent-surfaces.hidden'));
		this.dropOverlay = append(container, $('.volt-agent-surface-drop.hidden'));

		this.area = $('.volt-agent-tools-area.hidden');
		this.grip = append(this.area, $('.volt-agent-tools-grip'));
		this.grip.title = this.sash.title;
		this.partsHost = append(this.area, $('.volt-agent-tools-parts'));
		this.layoutService.mainContainer.appendChild(this.area);

		for (const handle of [this.sash, this.grip]) {
			this._register(addDisposableListener(handle, 'pointerdown', e => this.beginDrag(e)));
			this._register(addDisposableListener(handle, 'pointerenter', () => this.setSashState('hover', true)));
			this._register(addDisposableListener(handle, 'pointerleave', () => this.setSashState('hover', false)));
		}
		this.installTitlebarClickFix();

		this.addMenu = this._register(this.instantiationService.createInstance(AgentSurfaceAddMenu, this.addMenuHost(), () => undefined));
		this._register(this.workspace.onDidChange(e => {
			if (e.sessionId === this.sessionId && e.slot === 'surfaces') {
				this.consumeSurfaces(e.sessionId);
			}
		}));
		this._register(this.editorService.onDidEditorsChange(() => this.syncOpen()));
		const resize = new ResizeObserver(() => this.place());
		resize.observe(this.container);
		this._register(toDisposable(() => resize.disconnect()));
		this._register(onDidChangeLayoutMode(() => this.place()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.place()));
		this._register(toDisposable(() => this.teardown()));
	}

	//#region Chat-facing API

	present(sessionId: string | undefined): void {
		if (this.nested()) {
			this.sessionId = sessionId;
			return;
		}
		if (this.sessionId !== sessionId) {
			this.hidePart();
			this.sessionId = sessionId;
			this.ratio = (sessionId ? this.workspace.get(sessionId)?.layout.splitRatio : undefined) ?? 0.5;
		}
		if (sessionId) {
			const saved = toolParts.get(sessionId)
				?? (hasSavedAgentTools(this.storageService, sessionId) || this.pendingSurfaces(sessionId).length ? this.createPart(sessionId) : undefined);
			// A view off screen does not take the area from the view showing it.
			if (saved && (!saved.holder || saved.holder === this || !saved.holder.isOnScreen() || this.isOnScreen())) {
				this.showPart(saved);
			}
			this.consumeSurfaces(sessionId);
		}
		this.syncOpen();
	}

	layout(dimension: Dimension): void {
		this.lastDimension = dimension;
		if (this.container.closest('.volt-agent-tools-area')) {
			return;
		}
		this.applySplit(this.open ? this.ratio : undefined);
		this.place();
	}

	executionRoot(): URI | undefined {
		const sessionId = this.requireSession();
		if (!sessionId) {
			return undefined;
		}
		const root = this.workspace.get(sessionId)?.root;
		if (root) {
			try {
				return URI.parse(root);
			} catch {
				return undefined;
			}
		}
		return this.sessionContext.rootFor(sessionId);
	}

	chatView(sessionId: string): IAgentChatView {
		return this.workspace.get(sessionId)?.chat ?? { followTail: true };
	}

	rememberChat(sessionId: string, chat: IAgentChatView): void {
		this.workspace.setChatView(sessionId, chat);
	}

	openFile(resource: URI, reveal?: IAgentFileReveal): void {
		void this.target()?.openFileInTools(resource, reveal, false);
	}

	async openFileFromDialog(): Promise<void> {
		const root = this.executionRoot();
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: root,
			title: localize('voltAgent.openFile', "Open File"),
			openLabel: localize('voltAgent.openFile', "Open File"),
		});
		const file = picked?.[0];
		if (file) {
			this.openFile(file);
		}
	}

	openTerminal(): void {
		void this.target()?.openTerminalInTools();
	}

	openBrowser(url?: string, title?: string, reuse = false): void {
		void this.target()?.openBrowserInTools(url, title, reuse, false);
	}

	/** One Changes tab per chat; a second open focuses the existing tab. */
	openChanges(): void {
		void this.target()?.openChangesInTools(false);
	}

	/** New agent tab in the tools, bound to the same project as the parent chat. */
	openSideChat(): void {
		const owner = this.target();
		const sessionId = owner?.requireSession();
		if (!owner || !sessionId) {
			return;
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		owner.bindSideChatProject(sessionId, input.sessionId);
		void owner.openInTools(input, false);
	}

	//#endregion

	//#region Drag and drop onto the chat

	private dragKinds(e: DragEvent): IAgentSurfaceDragKinds {
		return {
			terminals: containsDragType(e, TerminalDataTransfers.Terminals),
			editorTabs: LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().hasData(DraggedEditorIdentifier.prototype),
			files: containsDragType(e, CodeDataTransfers.EDITORS, CodeDataTransfers.FILES, DataTransfers.RESOURCES, DataTransfers.FILES),
		};
	}

	/** Where a drop would open. Undefined when the chat should take it (a mention). The open tools take their own drops. */
	private dropZone(e: DragEvent): DOMRect | undefined {
		if (!this.requireSession() || this.nested() || this.open) {
			return undefined;
		}
		const box = this.container.getBoundingClientRect();
		const overRightHalf = e.clientX >= box.left + box.width / 2;
		if (!surfaceDropAccepted(this.dragKinds(e), false, false, overRightHalf)) {
			return undefined;
		}
		return new DOMRect(box.left + box.width / 2, box.top, box.width / 2, box.height);
	}

	/** Shows where the drop lands. Returns whether this host takes the drop. */
	onDragOver(e: DragEvent): boolean {
		const zone = this.dropZone(e);
		if (!zone) {
			this.clearDropFeedback();
			return false;
		}
		const box = this.container.getBoundingClientRect();
		this.dropOverlay.style.left = `${zone.left - box.left}px`;
		this.dropOverlay.style.top = `${zone.top - box.top}px`;
		this.dropOverlay.style.width = `${zone.width}px`;
		this.dropOverlay.style.height = `${zone.height}px`;
		this.dropOverlay.classList.remove('hidden');
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		return true;
	}

	clearDropFeedback(): void {
		this.dropOverlay.classList.add('hidden');
	}

	/** Opens dragged tabs and terminals as tools of this chat. Returns false to leave the drop to the chat. */
	handleDrop(e: DragEvent): boolean {
		const accepted = !!this.dropZone(e);
		this.clearDropFeedback();
		if (!accepted) {
			return false;
		}
		const group = this.toolsGroup();
		if (!group) {
			return false;
		}
		const handled = new Set<string>();
		for (const resource of getTerminalResourcesFromDragEvent(e) ?? []) {
			this.adoptTerminal(this.terminalService.getInstanceFromResource(resource), group);
			handled.add(resource.toString());
		}
		const transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
		if (transfer.hasData(DraggedEditorIdentifier.prototype)) {
			for (const { identifier } of transfer.getData(DraggedEditorIdentifier.prototype) ?? []) {
				const source = this.editorGroupsService.getGroup(identifier.groupId);
				const resource = identifier.editor.resource;
				if (resource) {
					handled.add(resource.toString());
				}
				// The chat itself stays where it is; any other tab moves over like a split drop.
				if (source && source.id !== group.id && !(identifier.editor instanceof AgentEditorInput && source.activeEditor === identifier.editor && source === this.editorGroupsService.mainPart.activeGroup)) {
					source.moveEditor(identifier.editor, group);
				}
			}
			transfer.clearData(DraggedEditorIdentifier.prototype);
		}
		for (const dragged of extractEditorsDropData(e)) {
			const resource = dragged.resource;
			if (!resource || handled.has(resource.toString())) {
				continue;
			}
			handled.add(resource.toString());
			if (resource.scheme === Schemas.vscodeTerminal) {
				this.adoptTerminal(this.terminalService.getInstanceFromResource(resource), group);
			} else if (this.fileService.hasProvider(resource)) {
				void this.openFileIfNotFolder(resource);
			}
		}
		return true;
	}

	private async openFileIfNotFolder(resource: URI): Promise<void> {
		try {
			if ((await this.fileService.stat(resource)).isDirectory) {
				return;
			}
		} catch {
			return;
		}
		this.openFile(resource);
	}

	/** Moves a terminal into the tools. The process keeps running. */
	private adoptTerminal(instance: ITerminalInstance | undefined, group: IEditorGroup): void {
		if (!instance || instance.isDisposed) {
			return;
		}
		if (instance.target !== TerminalLocation.Editor) {
			this.terminalService.moveToEditor(instance, group.id);
			return;
		}
		const input = this.terminalEditorService.getInputFromResource(instance.resource);
		const source = this.editorGroupsService.groups.find(candidate => candidate.contains(input));
		if (source && source.id !== group.id) {
			source.moveEditor(input, group);
		}
	}

	//#endregion

	//#region Tools area

	/** A side chat hosted in another chat's tools: it hands its tool requests to that chat. */
	private nested(): boolean {
		return !!this.container.closest('.volt-agent-tools-area');
	}

	private target(): AgentSurfaceHost | undefined {
		if (!this.nested()) {
			return this;
		}
		for (const host of hosts) {
			if (host !== this && host.area.contains(this.container)) {
				return host;
			}
		}
		return undefined;
	}

	private requireSession(): string | undefined {
		return this.sessionId ?? this.workspace.active?.sessionId;
	}

	private pendingSurfaces(sessionId: string): readonly IAgentSurface[] {
		return this.workspace.get(sessionId)?.surfaces ?? [];
	}

	/** The group new tools open in: the chat's tools area, made on first use. */
	private toolsGroup(): IEditorGroup | undefined {
		const sessionId = this.sessionId;
		if (!sessionId || this.disposed) {
			return undefined;
		}
		const entry = toolParts.get(sessionId) ?? this.createPart(sessionId);
		this.showPart(entry);
		return entry.part.activeGroup;
	}

	private createPart(sessionId: string): IToolsPart {
		const store = new DisposableStore();
		const element = append(this.partsHost, $('.part.editor.volt-agent-tools-part.hidden'));
		// Scope `voltAgentToolsPart` to this area, so its group titles get the tools actions.
		const contextKeyService = store.add(this.contextKeyService.createScoped(element));
		AgentToolsPartContext.bindTo(contextKeyService).set(true);
		const instantiationService = store.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
		const partsView = this.editorGroupsService as unknown as IEditorPartsView;
		const part = instantiationService.createInstance(AgentToolsEditorPart, partsView, sessionId);
		const registration = partsView.registerPart(part);
		part.create(element, { restorePreviousState: true });
		store.add(part.enforcePartOptions({
			showTabs: 'multiple',
			closeEmptyGroups: true,
			editorActionsLocation: 'default',
		}));
		// The editor service does not report editor changes in areas made after startup, so watch each group.
		const groupListeners = store.add(new DisposableMap<number>());
		const entry: IToolsPart = { sessionId, part, element, store, lastUsed: ++partClock, holder: undefined };
		const watchGroup = (group: IEditorGroup) => {
			if (!groupListeners.has(group.id)) {
				groupListeners.set(group.id, group.onDidModelChange(() => entry.holder?.syncOpen()));
			}
		};
		part.groups.forEach(watchGroup);
		store.add(part.onDidAddGroup(group => {
			watchGroup(group);
			entry.holder?.syncOpen();
		}));
		store.add(part.onDidRemoveGroup(group => {
			groupListeners.deleteAndDispose(group.id);
			entry.holder?.syncOpen();
		}));
		store.add(toDisposable(() => {
			entry.holder?.dropPart(entry);
			part.persist();
			registration.dispose();
			part.dispose();
			element.remove();
			if (toolParts.get(sessionId) === entry) {
				toolParts.delete(sessionId);
			}
		}));
		toolParts.set(sessionId, entry);
		this.evictParts();
		return entry;
	}

	/** Keeps the most recently shown areas alive; the rest are saved and dropped. */
	private evictParts(): void {
		if (toolParts.size <= MAX_LIVE_TOOL_PARTS) {
			return;
		}
		const idle = [...toolParts.values()]
			.filter(entry => !entry.holder && entry.sessionId !== this.sessionId)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const entry of idle.slice(0, toolParts.size - MAX_LIVE_TOOL_PARTS)) {
			entry.store.dispose();
		}
	}

	/** Shows the area here, taking it from the view that had it. */
	private showPart(entry: IToolsPart): void {
		entry.lastUsed = ++partClock;
		if (this.shown === entry && entry.holder === this) {
			return;
		}
		this.hidePart();
		if (entry.holder && entry.holder !== this) {
			entry.holder.dropPart(entry);
		}
		entry.holder = this;
		if (entry.element.parentElement !== this.partsHost) {
			this.partsHost.appendChild(entry.element);
		}
		this.shown = entry;
		entry.element.classList.remove('hidden');
		entry.part.setVisible(true);
	}

	private hidePart(): void {
		const entry = this.shown;
		if (!entry) {
			return;
		}
		this.shown = undefined;
		if (entry.holder === this) {
			entry.holder = undefined;
		}
		entry.part.setVisible(false);
		entry.element.classList.add('hidden');
	}

	/** Another view took this area, or it is being dropped. */
	private dropPart(entry: IToolsPart): void {
		if (entry.holder === this) {
			entry.holder = undefined;
		}
		if (this.shown === entry) {
			this.shown = undefined;
			this.syncOpen();
		}
	}

	private isOnScreen(): boolean {
		const box = this.container.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	}

	/** The split is open while the shown area has at least one tab. */
	private syncOpen(): void {
		if (this.disposed) {
			return;
		}
		const entry = this.shown;
		const open = !this.nested() && !!entry && entry.sessionId === this.sessionId && entry.part.groups.some(group => group.count > 0);
		if (open !== this.open) {
			this.open = open;
			this.container.classList.toggle('has-surfaces', open);
			this.panel.classList.toggle('hidden', !open);
			this.sash.classList.toggle('hidden', !open);
			if (!open) {
				this.dragging = false;
				this.addMenu.hide();
			}
			if (!this.dragging) {
				this.applySplit(open ? this.ratio : undefined);
			}
		}
		this.place();
	}

	private applySplit(ratio: number | undefined): void {
		if (ratio === undefined) {
			// Explicit full-size chat: clearing alone can leave a prior `0 0 Npx` gap.
			this.chat.style.flex = '1 1 auto';
			this.chat.style.width = '100%';
			return;
		}
		const width = this.container.clientWidth || this.lastDimension?.width || MIN_PANE * 2;
		const min = Math.min(MIN_PANE, Math.max(120, Math.floor((width - SASH_WIDTH) / 2)));
		const available = Math.max(width - SASH_WIDTH, min * 2);
		let chat = Math.round(available * ratio);
		chat = Math.max(min, Math.min(chat, available - min));
		this.chat.style.flex = `0 0 ${chat}px`;
		this.chat.style.width = `${chat}px`;
		this.ratio = chat / available;
	}

	/** Lays the tools area over the tools' share of the row, and over the title bar above it in agent layout. */
	private place(): void {
		if (this.disposed) {
			return;
		}
		// This view came on screen showing a chat whose area another view still holds (a layout switch).
		const waiting = !this.shown && this.sessionId ? toolParts.get(this.sessionId) : undefined;
		if (waiting && !this.nested() && this.isOnScreen() && (!waiting.holder || !waiting.holder.isOnScreen())) {
			this.showPart(waiting);
			this.syncOpen();
			return;
		}
		const entry = this.shown;
		const box = this.panel.getBoundingClientRect();
		if (!this.open || !entry || box.width <= 0 || box.height <= 0) {
			this.area.classList.add('hidden');
			this.releaseTitlebar();
			return;
		}
		const line = this.sash.getBoundingClientRect().left;
		let top = box.top;
		const titlebar = this.titlebarAbove();
		if (titlebar) {
			const bar = titlebar.getBoundingClientRect();
			top = bar.top;
			this.claimTitlebar(titlebar, Math.max(0, Math.round(bar.right - line)));
		} else {
			this.releaseTitlebar();
		}
		const left = Math.round(line - GRIP_OFFSET);
		const width = Math.max(0, Math.round(box.right - left));
		const height = Math.max(0, Math.round(box.bottom - top));
		this.area.style.left = `${left}px`;
		this.area.style.top = `${Math.round(top)}px`;
		this.area.style.width = `${width}px`;
		this.area.style.height = `${height}px`;
		this.area.classList.remove('hidden');
		const partWidth = width - GRIP_OFFSET - SASH_WIDTH;
		if (partWidth > 0 && height > 0) {
			entry.part.layout(partWidth, height, 0, 0);
		}
	}

	/** The primary title bar in agent layout. The right panel's tab row sits in that bar. */
	private titlebarAbove(): HTMLElement | undefined {
		// A chat hosted inside another chat's tools keeps its own tabs in that panel.
		if (this.nested()) {
			return undefined;
		}
		const titlebar = this.container.closest('.monaco-workbench.volt-layout-agent')?.querySelector('.part.titlebar > .titlebar-container');
		return isHTMLElement(titlebar) ? titlebar : undefined;
	}

	/** The title bar's own controls end at the split line; the tools area takes the rest of the row. */
	private claimTitlebar(titlebar: HTMLElement, toolsWidth: number): void {
		if (titlebarOwner && titlebarOwner !== this) {
			titlebarOwner.releaseTitlebar();
		}
		titlebarOwner = this;
		if (this.titlebar !== titlebar) {
			this.releaseTitlebar();
			this.titlebar = titlebar;
			titlebarOwner = this;
			titlebar.classList.add('has-agent-tools');
			const observer = new ResizeObserver(() => this.place());
			observer.observe(titlebar);
			this.titlebarWatch.value = toDisposable(() => observer.disconnect());
		}
		titlebar.style.paddingRight = `${toolsWidth}px`;
		this.area.classList.add('in-titlebar');
	}

	private releaseTitlebar(): void {
		if (titlebarOwner === this) {
			titlebarOwner = undefined;
		}
		this.area.classList.remove('in-titlebar');
		const titlebar = this.titlebar;
		if (!titlebar) {
			return;
		}
		this.titlebar = undefined;
		this.titlebarWatch.clear();
		titlebar.classList.remove('has-agent-tools');
		titlebar.style.paddingRight = '';
	}

	/**
	 * On macOS the title bar row only delivers mouse-down to the page, never the click.
	 * The primary title bar clicks its own controls on mouse-down; the tools' tab row
	 * sits in that row too, so its tab close buttons and title actions get the same fix.
	 */
	private installTitlebarClickFix(): void {
		let suppressClick = false;
		this._register(addDisposableListener(this.area, 'mousedown', e => {
			this.lastPointerTarget = isHTMLElement(e.target) ? e.target : undefined;
			if (e.button !== 0 || !this.area.classList.contains('in-titlebar') || !isHTMLElement(e.target)) {
				return;
			}
			const band = this.titlebar?.getBoundingClientRect().height ?? 0;
			if (e.clientY - this.area.getBoundingClientRect().top > band) {
				return;
			}
			const item = e.target.closest('.action-item');
			if (!isHTMLElement(item) || item.classList.contains('disabled') || !this.area.contains(item)) {
				return;
			}
			suppressClick = true;
			item.click();
		}, true));
		this._register(addDisposableListener(this.area, 'click', e => {
			if (!suppressClick) {
				return;
			}
			suppressClick = false;
			e.preventDefault();
			e.stopPropagation();
		}, true));
	}

	//#endregion

	//#region Opening tools

	private async openInTools(input: EditorInput, preserveFocus: boolean): Promise<void> {
		const group = this.toolsGroup();
		if (group) {
			await group.openEditor(input, { pinned: true, preserveFocus });
		}
	}

	private async openFileInTools(resource: URI, reveal: IAgentFileReveal | undefined, preserveFocus: boolean): Promise<void> {
		const group = this.toolsGroup();
		if (!group) {
			return;
		}
		const selection = reveal
			? { startLineNumber: reveal.startLine, startColumn: 1, endLineNumber: reveal.endLine ?? reveal.startLine, endColumn: 1 }
			: undefined;
		await this.editorService.openEditor({ resource, options: { pinned: true, preserveFocus, selection } }, group);
	}

	private async openTerminalInTools(cwd?: string): Promise<void> {
		const group = this.toolsGroup();
		if (!group) {
			return;
		}
		await this.terminalService.createTerminal({
			cwd: cwd ?? this.executionRoot()?.fsPath,
			location: { viewColumn: group.id },
		});
	}

	private async openBrowserInTools(url: string | undefined, title: string | undefined, reuse: boolean, preserveFocus: boolean): Promise<void> {
		const group = this.toolsGroup();
		if (!group) {
			return;
		}
		const page = normalizePageUrl(url) ?? DEFAULT_BROWSER_URL;
		if (reuse) {
			const existing = this.findInShown(editor => editor instanceof VoltBrowserEditorInput && editor.url === page);
			if (existing) {
				await existing.group.openEditor(existing.editor, { preserveFocus });
				return;
			}
		}
		const input = this.instantiationService.createInstance(VoltBrowserEditorInput, VoltBrowserEditorInput.getNewEditorUri());
		input.url = page;
		input.setTitle(title || browserTitle(page));
		await group.openEditor(input, { pinned: true, preserveFocus });
	}

	private async openChangesInTools(preserveFocus: boolean): Promise<void> {
		const sessionId = this.sessionId;
		const group = this.toolsGroup();
		if (!group || !sessionId) {
			return;
		}
		const existing = this.findInShown(editor => editor instanceof AgentChangesEditorInput && editor.sessionId === sessionId);
		if (existing) {
			await existing.group.openEditor(existing.editor, { preserveFocus });
			return;
		}
		await group.openEditor(this.instantiationService.createInstance(AgentChangesEditorInput, sessionId, 'lastTurn'), { pinned: true, preserveFocus });
	}

	private findInShown(match: (editor: EditorInput) => boolean): { group: IEditorGroup; editor: EditorInput } | undefined {
		for (const group of this.shown?.part.groups ?? []) {
			const editor = group.editors.find(match);
			if (editor) {
				return { group, editor };
			}
		}
		return undefined;
	}

	/**
	 * Tools recorded on the chat instead of opened here: ones saved before the tools
	 * became an editor area, and browsers opened by commands and the agent. Each opens
	 * as a tab once, then leaves the record.
	 */
	private consumeSurfaces(sessionId: string): void {
		if (this.consuming || sessionId !== this.sessionId || this.nested() || this.disposed) {
			return;
		}
		const surfaces = this.pendingSurfaces(sessionId);
		if (!surfaces.length) {
			return;
		}
		this.consuming = true;
		try {
			for (const surface of surfaces) {
				this.openRecorded(sessionId, surface);
				this.workspace.closeSurface(sessionId, surface.id);
			}
		} finally {
			this.consuming = false;
		}
	}

	private openRecorded(sessionId: string, surface: IAgentSurface): void {
		switch (surface.kind) {
			case 'file':
				try {
					void this.openFileInTools(URI.parse(surface.resource), undefined, true);
				} catch {
					// A malformed saved resource is dropped with its record.
				}
				return;
			case 'terminal': {
				const live = typeof surface.terminalInstanceId === 'number' ? this.terminalService.getInstanceFromId(surface.terminalInstanceId) : undefined;
				const group = this.toolsGroup();
				if (live && group) {
					this.adoptTerminal(live, group);
				} else {
					void this.openTerminalInTools(surface.cwd);
				}
				return;
			}
			case 'browser':
				// Each record is its own tab; "Open Browser" twice means two browsers.
				void this.openBrowserInTools(surface.url, surface.title, false, true);
				return;
			case 'changes':
				void this.openChangesInTools(true);
				return;
			case 'chat': {
				const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(surface.sessionId));
				this.bindSideChatProject(sessionId, input.sessionId);
				void this.openInTools(input, true);
				return;
			}
			default: {
				const unknown: never = surface;
				return unknown;
			}
		}
	}

	private bindSideChatProject(parentSessionId: string, chatSessionId: string): void {
		const parent = this.workspace.get(parentSessionId);
		let project = (parent?.projectId ? this.sessionContext.getProject(parent.projectId) : undefined) ?? this.sessionContext.activeProject;
		if (!project && parent?.root) {
			try {
				const root = URI.parse(parent.root);
				project = this.sessionContext.registerProject(root, basename(root));
			} catch {
				project = undefined;
			}
		}
		if (project) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, chatSessionId, project);
		}
	}

	//#endregion

	//#region + menu

	private addMenuHost(): IAgentSurfaceAddMenuHost {
		const host = this;
		return {
			get root() {
				return host.executionRoot();
			},
			get browserTabs() {
				const tabs: { id: string; title: string; url: string }[] = [];
				for (const group of host.shown?.part.groups ?? []) {
					for (const editor of group.editors) {
						if (editor instanceof VoltBrowserEditorInput) {
							tabs.push({ id: editor.resource.toString(), title: editor.getName(), url: editor.url });
						}
					}
				}
				return tabs;
			},
			runAction: id => host.runMenuAction(id),
			openFile: resource => host.openFile(resource),
			openBrowser: url => host.openBrowser(url, undefined, true),
			focusSurface: id => {
				const found = host.findInShown(editor => editor.resource?.toString() === id);
				if (found) {
					void found.group.openEditor(found.editor);
				}
			},
		};
	}

	/** Opens the + menu from the tools title action, under the + that was pressed. */
	showAddMenu(): boolean {
		const entry = this.shown;
		if (!entry || !this.open) {
			return false;
		}
		const pressed = this.lastPointerTarget?.closest('.action-item');
		let anchor = isHTMLElement(pressed) && this.area.contains(pressed) ? pressed : undefined;
		if (!anchor) {
			if (!entry.part.groups.some(group => group.id === this.editorGroupsService.activeGroup.id)) {
				return false;
			}
			const fallback = entry.element.querySelector('.editor-group-container.active .editor-actions .codicon-add')?.closest('.action-item');
			anchor = isHTMLElement(fallback) ? fallback : undefined;
		}
		if (!anchor) {
			return false;
		}
		if (this.addMenu.isVisible) {
			this.addMenu.hide();
		} else {
			this.addMenu.show(anchor);
		}
		this.lastPointerTarget = undefined;
		return true;
	}

	private runMenuAction(id: AgentSurfaceMenuActionId): void {
		switch (id) {
			case 'file':
				void this.openFileFromDialog();
				return;
			case 'terminal':
				this.openTerminal();
				return;
			case 'browser':
				this.openBrowser();
				return;
			case 'changes':
				this.openChanges();
				return;
			case 'sideChat':
				this.openSideChat();
				return;
			default: {
				const unknown: never = id;
				return unknown;
			}
		}
	}

	//#endregion

	private beginDrag(event: PointerEvent): void {
		if (!this.open) {
			return;
		}
		event.preventDefault();
		this.dragging = true;
		this.setSashState('active', true);
		const target = event.currentTarget;
		if (isHTMLElement(target)) {
			target.setPointerCapture(event.pointerId);
		}
		const targetWindow = getWindow(this.container);
		const move = (e: PointerEvent) => {
			const width = this.container.clientWidth || 1;
			this.applySplit((e.clientX - this.container.getBoundingClientRect().left) / width);
			this.place();
		};
		const up = () => {
			this.dragging = false;
			this.setSashState('active', false);
			targetWindow.removeEventListener('pointermove', move);
			targetWindow.removeEventListener('pointerup', up);
			const sessionId = this.sessionId;
			if (sessionId) {
				this.workspace.setSplitRatio(sessionId, this.ratio);
			}
		};
		targetWindow.addEventListener('pointermove', move);
		targetWindow.addEventListener('pointerup', up);
	}

	/** Hovering or dragging either handle lights the whole split line. */
	private setSashState(state: 'hover' | 'active', on: boolean): void {
		this.sash.classList.toggle(state, on);
		this.grip.classList.toggle(state, on);
	}

	private teardown(): void {
		this.disposed = true;
		hosts.delete(this);
		this.addMenu.hide();
		this.releaseTitlebar();
		// The areas outlive this view; another view showing the chat picks them up.
		this.hidePart();
		for (const entry of toolParts.values()) {
			if (entry.holder === this) {
				entry.holder = undefined;
			}
		}
		this.area.remove();
	}
}

registerAction2(class OpenAgentToolsAddMenuAction extends Action2 {
	constructor() {
		super({
			id: OPEN_TOOLS_ADD_MENU_ID,
			title: localize2('voltAgent.toolsAdd', "Open in Tools"),
			icon: Codicon.add,
			f1: false,
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: -1000, when: AgentToolsPartContext },
		});
	}

	override run(_accessor: ServicesAccessor): void {
		for (const host of hosts) {
			if (host.showAddMenu()) {
				return;
			}
		}
	}
});

function browserTitle(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

function normalizePageUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	return sanitizeBrowserUrl(trimmed) ?? sanitizeBrowserUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}
