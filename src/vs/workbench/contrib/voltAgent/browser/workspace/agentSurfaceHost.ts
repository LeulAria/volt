/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { CodeDataTransfers, containsDragType, extractEditorsDropData, LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService, OpenExternalOptions, OpenInternalOptions } from '../../../../../platform/opener/common/opener.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITerminalProfile, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { DraggedEditorIdentifier } from '../../../../browser/dnd.js';
import { IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { limitTabLabel } from '../../../../browser/parts/editor/editorTabsControl.js';
import { getLayoutMode, LayoutModeContext, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { createPrimarySidebarToggleIcon } from '../../../../browser/parts/titlebar/sidebarToggleIcon.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { IEditorPane } from '../../../../common/editor.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService, ITerminalService, TerminalDataTransfers } from '../../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import { ITerminalProfileService } from '../../../terminal/common/terminal.js';
import { getTerminalResourcesFromDragEvent } from '../../../terminal/browser/terminalUri.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { BROWSER_PRESENT_EVENT, BROWSER_PRESENTATION_EVENT, BrowserPresentation, DEFAULT_BROWSER_URL, VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { sanitizeBrowserUrl } from '../preview/localPreview.js';
import { AgentChangesEditorInput, isAgentChangesDiffFor, openAgentChangesDiff } from '../review/agentChangesEditor.js';
import { AgentChangesScope } from '../review/agentSessionChanges.js';
import { AgentFilesSidebar, AgentFilesSidebarView } from './agentFilesSidebar.js';
import { AgentSurfaceAddMenu, IAgentSurfaceAddMenuHost } from './agentSurfaceAddMenu.js';
import { type AgentSurfaceMenuActionId } from './agentSurfaceMenu.js';
import { AgentToolsEditorPart, AgentToolsPartContext, hasSavedAgentTools } from './agentToolsEditorPart.js';
import { attachSessionToProject } from './agentShell.js';
import { registerAgentFileEditorRouting } from './agentFileEditorRouting.js';
import { IAgentChatView, IAgentSurface, IAgentWorkspaceService } from './agentWorkspace.js';

export { chooseAgentBrowserSurfaceMount, type AgentBrowserSurfaceMount } from './agentBrowserMount.js';
export { shouldHideAgentQuickOpenRail, surfaceKindForMenuAction, agentSurfaceMenuItems } from './agentSurfaceMenu.js';

const MIN_PANE = 240;
/** While the files sidebar sits beside the tabs, the chat takes this part of its usual share, and the tabs the rest. */
const SIDEBAR_CHAT_SHARE = 0.8;
/** Matches `.volt-agent-surface-sash`: a 1px line with an invisible grab area around it. */
const SASH_WIDTH = 1;
/** The tools area's grab strip, centered on the split line. Matches `.volt-agent-tools-grip`. */
const GRIP_WIDTH = 7;
const GRIP_OFFSET = Math.floor(GRIP_WIDTH / 2);
/** Tools areas kept alive for chats you switched away from. Older ones are saved and dropped. */
const MAX_LIVE_TOOL_PARTS = 8;
const OPEN_TOOLS_ADD_MENU_ID = 'workbench.action.voltAgentTools.add';
/** Called by the git extension; keep the id in step with extensions/git/src/gitEditor.ts. */
const EDIT_IN_AGENT_TOOLS_COMMAND_ID = '_volt.agentTools.editUntilClosed';
const TOGGLE_TOOLS_FULLSCREEN_ID = 'workbench.action.voltAgentTools.toggleFullScreen';
const TOGGLE_TOOLS_PANEL_ID = 'workbench.action.voltAgentTools.togglePanel';
/** Opens the Explorer in the files sidebar of the chat on screen. */
export const SHOW_AGENT_FILES_COMMAND_ID = 'workbench.action.voltAgentTools.showFiles';
export const SHOW_AGENT_SCM_COMMAND_ID = 'workbench.action.voltAgentTools.showSourceControl';
/** The floating preview's gap to the chat's edges, and its smallest size. */
const FLOAT_MARGIN = 12;
const FLOAT_MIN_WIDTH = 260;
const FLOAT_MIN_HEIGHT = 180;

/** Where the floating preview sits, from the chat's top-right corner. Shared by every chat in the window. */
interface IFloatRect {
	readonly right: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}
let floatRect: IFloatRect | undefined;

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

/**
 * How the files sidebar shares the row: not there, the whole tools area (no tab beside it), or
 * beside the tabs, where the chat and the tabs split what is left at the chat's ratio.
 */
interface IFilesSidebarSplit {
	readonly mode: 'none' | 'fills' | 'beside';
	readonly width: number;
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

/**
 * A tools area that belongs to a page instead of a chat (Customize keeps its right panel under
 * `volt-customize`). Chat session ids are UUIDs, so the prefix cannot collide with one.
 */
export function isPseudoToolsSession(sessionId: string | undefined): boolean {
	return !!sessionId && sessionId.startsWith('volt-');
}

/** A host showing a chat's tools, not a page's. Code looking for "the chat on screen" only considers these. */
function isChatToolsHost(host: AgentSurfaceHost): boolean {
	return !isPseudoToolsSession(host.currentSessionId);
}

export function openAgentToolsPanel(): void {
	for (const host of hosts) {
		if (isChatToolsHost(host) && host.openToolsPanel()) {
			return;
		}
	}
}

/** Opens or closes the right panel beside the chat on screen; false outside the agent layout. */
export function toggleAgentToolsPanel(): boolean {
	for (const host of hosts) {
		if (host.toggleToolsPanel()) {
			return true;
		}
	}
	return false;
}
/** Each chat's tools area, shared by every chat view: it moves to whichever view shows the chat. */
const toolParts = new Map<string, IToolsPart>();
const toolEditorsEmitter = new Emitter<void>();
/** Fired when a tab opens, closes, or moves in a chat's tools area. The editor service does not report those areas. */
export const onDidChangeAgentToolEditors = toolEditorsEmitter.event;

function notifyAgentToolEditors(): void {
	toolEditorsEmitter.fire();
}

/** Tabs showing in a tools area on screen: the right-side browser, terminal, files, and changes. */
export function shownAgentToolEditors(): EditorInput[] {
	const editors: EditorInput[] = [];
	const seen = new Set<EditorInput>();
	for (const entry of toolParts.values()) {
		if (entry.element.classList.contains('hidden')) {
			continue;
		}
		for (const group of entry.part.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput || seen.has(editor)) {
					continue;
				}
				seen.add(editor);
				editors.push(editor);
			}
		}
	}
	return editors;
}

type BorrowedBrowserResolver = (sessionId: string) => { input: VoltBrowserEditorInput; group: IEditorGroup } | undefined;
let borrowedBrowser: BorrowedBrowserResolver | undefined;

/**
 * The IDE layout shows a chat's tools as tabs in the middle. While it does, the chat's agent
 * still drives its browser there: this finds it.
 */
export function setBorrowedAgentBrowserResolver(resolver: BorrowedBrowserResolver): IDisposable {
	borrowedBrowser = resolver;
	return toDisposable(() => {
		if (borrowedBrowser === resolver) {
			borrowedBrowser = undefined;
		}
	});
}

/**
 * Shows a side chat in the tools of the chat it belongs to. False when no view shows that chat,
 * so the caller opens the parent first.
 */
export function revealAgentSideChat(parentSessionId: string, chatSessionId: string): boolean {
	for (const host of hosts) {
		if (host.showsSession(parentSessionId) && host.revealSideChat(chatSessionId)) {
			return true;
		}
	}
	return false;
}

/** Side chat tabs in live tools areas: side chat session id to the chat whose tools hold it. */
export function agentSideChatParents(): Map<string, string> {
	const parents = new Map<string, string>();
	for (const entry of toolParts.values()) {
		for (const group of entry.part.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput && editor.sessionId !== entry.sessionId) {
					parents.set(editor.sessionId, entry.sessionId);
				}
			}
		}
	}
	return parents;
}

/** A chat's tools area if it is alive now. */
export function liveAgentToolsPart(sessionId: string): AgentToolsEditorPart | undefined {
	return toolParts.get(sessionId)?.part;
}

/**
 * A chat's tools area, made from its saved tabs when it is not alive. The IDE layout takes the
 * tabs out of it and puts them back. Undefined while no chat view exists to host the area.
 */
export function ensureAgentToolsPart(sessionId: string): AgentToolsEditorPart | undefined {
	const live = toolParts.get(sessionId);
	if (live) {
		live.lastUsed = ++partClock;
		return live.part;
	}
	for (const host of hosts) {
		const part = host.hostToolsPart(sessionId);
		if (part) {
			return part;
		}
	}
	return undefined;
}

/** The right panel is open on this chat with Source Control (its sidebar, or a Changes tab) in front. */
/** Source Control shows for `sessionId` in a tools files sidebar on screen. */
export function isAgentScmShown(sessionId: string): boolean {
	return [...hosts].some(host => host.showsScmFor(sessionId));
}

export function isAgentChangesShown(sessionId: string): boolean {
	for (const host of hosts) {
		if (host.showsChangesFor(sessionId)) {
			return true;
		}
	}
	return false;
}

/**
 * Opens `input` as a tab in the tools of the chat on screen (preferring `sessionId`'s). False when
 * no chat can show tools (the IDE layout): callers open it as a normal editor instead.
 */
export function openInAgentTools(input: EditorInput, sessionId?: string, options?: IEditorOptions): Promise<IEditorPane | undefined> | undefined {
	const candidates = [...hosts].filter(host => host.canOpenTools());
	const host = (sessionId ? candidates.find(candidate => candidate.showsSession(sessionId)) : undefined) ?? candidates.find(isChatToolsHost);
	return host?.openEditorInTools(input, options);
}

/** The chat whose tools are on screen, if any. */
export function agentToolsSessionOnScreen(): string | undefined {
	return [...hosts].find(host => host.canOpenTools() && isChatToolsHost(host))?.currentSessionId;
}

function toolGroupFor(editor: EditorInput): { entry: IToolsPart; group: IEditorGroup } | undefined {
	const resource = editor.resource?.toString();
	for (const entry of toolParts.values()) {
		const group = entry.part.groups.find(candidate => candidate.editors.includes(editor)
			|| (!!resource && candidate.editors.some(open => open.resource?.toString() === resource)));
		if (group) {
			return { entry, group };
		}
	}
	return undefined;
}

/** Open the right panel on a tab that already lives there. Same open path as the panel button. */
export function revealAgentToolEditor(editor: EditorInput): boolean {
	const located = toolGroupFor(editor);
	const host = (located && [...hosts].find(candidate => candidate.showsSession(located.entry.sessionId)))
		?? [...hosts].find(candidate => candidate.canOpenTools() && isChatToolsHost(candidate));
	const opened = host?.openToolsPanel() ?? false;
	if (!opened) {
		openAgentToolsPanel();
	}
	if (!located) {
		return opened;
	}
	const target = located.group.editors.find(open => open === editor)
		?? located.group.editors.find(open => !!editor.resource && open.resource?.toString() === editor.resource.toString())
		?? editor;
	void located.group.openEditor(target, { pinned: true });
	return true;
}
/** Close a tab that lives in a chat's tools area. False when no tools area holds it. */
export function closeAgentToolEditor(editor: EditorInput): boolean {
	const located = toolGroupFor(editor);
	if (!located) {
		return false;
	}
	const target = located.group.editors.find(open => open === editor)
		?? located.group.editors.find(open => !!editor.resource && open.resource?.toString() === editor.resource.toString());
	if (!target) {
		return false;
	}
	void located.group.closeEditor(target);
	return true;
}

/**
 * The browser tab the agent of `sessionId` drives: the one showing in its tools area, else the
 * most recent browser tab there. Undefined until the chat's tools area holds a browser.
 */
export function agentSessionBrowser(sessionId: string): { input: VoltBrowserEditorInput; group: IEditorGroup } | undefined {
	const entry = toolParts.get(sessionId);
	if (!entry) {
		return borrowedBrowser?.(sessionId);
	}
	const groups = [entry.part.activeGroup, ...entry.part.groups.filter(group => group !== entry.part.activeGroup)];
	for (const group of groups) {
		if (group.activeEditor instanceof VoltBrowserEditorInput) {
			return { input: group.activeEditor, group };
		}
	}
	for (const group of groups) {
		const input = group.editors.filter((editor): editor is VoltBrowserEditorInput => editor instanceof VoltBrowserEditorInput).at(-1);
		if (input) {
			return { input, group };
		}
	}
	return borrowedBrowser?.(sessionId);
}

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
	private toolsHidden = false;
	/** How the tools are drawn: beside the chat, floating over it (a preview), or across the whole window. */
	private presentation: BrowserPresentation = 'split';
	private readonly closePanelButton: HTMLButtonElement;
	private readonly fullscreenButton: HTMLButtonElement;
	/** Explorer, Source Control or Search at the right edge of the tools. */
	private readonly filesSidebar: AgentFilesSidebar;
	/** Full screen: room for the window's traffic lights, then the chat's own tab. */
	private readonly lead: HTMLElement;
	private readonly leadTitle: HTMLElement;
	private floatBarTimer: number | undefined;
	private floatDrag: { kind: string; startX: number; startY: number; start: IFloatRect } | undefined;
	/** A preview is opening to float: the area has its tab before that tab is the active one. */
	private openingFloat = false;
	private ratio = 0.5;
	/** How the files sidebar took its room at the last sync, so a change lays out the split again. */
	private lastSidebarSplit: IFilesSidebarSplit = { mode: 'none', width: 0 };
	private dragging = false;
	private disposed = false;
	private announcedOpen = false;
	/** place() retries while a just-opened panel still measures 0. */
	private placeAttempts = 0;
	private openToolsButtonFrame: number | undefined;
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
		this.closePanelButton = $('button.volt-agent-tools-close-panel') as HTMLButtonElement;
		this.closePanelButton.type = 'button';
		const closeLabel = localize('voltAgent.tools.closePanel', "Close Right Panel");
		this.closePanelButton.setAttribute('aria-label', closeLabel);
		setAgentTooltip(this.closePanelButton, closeLabel);
		const closeIcon = createPrimarySidebarToggleIcon(this.closePanelButton, 'open');
		// The shared glyph locks a 1.5 stroke to the screen. Here it should scale on the 24-grid, like the expand icon beside it.
		for (const shape of closeIcon.querySelectorAll('rect, path')) {
			shape.removeAttribute('vector-effect');
		}
		this.closePanelButton.appendChild(closeIcon);
		this._register(addDisposableListener(this.closePanelButton, 'click', () => {
			this.toolsHidden = true;
			this.syncOpen();
			this.chat.focus();
		}));
		this.fullscreenButton = $('button.volt-agent-tools-fullscreen') as HTMLButtonElement;
		this.fullscreenButton.type = 'button';
		this._register(addDisposableListener(this.fullscreenButton, 'click', () => this.toggleFullscreen()));
		this.grip = append(this.area, $('.volt-agent-tools-grip'));
		this.grip.title = this.sash.title;
		this.partsHost = append(this.area, $('.volt-agent-tools-parts'));
		this.filesSidebar = this._register(this.instantiationService.createInstance(AgentFilesSidebar, this.area));
		this._register(AgentFilesSidebar.onDidChange(() => this.onDidChangeFilesSidebar()));
		this.lead = append(this.area, $('.volt-agent-tools-lead'));
		append(this.lead, $('.volt-agent-tools-lead-lights'));
		const leadSidebar = append(this.lead, $('button.volt-agent-tools-lead-button.sidebar')) as HTMLButtonElement;
		leadSidebar.type = 'button';
		leadSidebar.appendChild(createPrimarySidebarToggleIcon(leadSidebar, 'open'));
		setAgentTooltip(leadSidebar, localize('voltAgent.tools.exitFullScreenSidebar', "Show Sidebar"));
		this._register(addDisposableListener(leadSidebar, 'click', () => this.setPresentation('split')));
		const leadChat = append(this.lead, $('button.volt-agent-tools-lead-button.chat')) as HTMLButtonElement;
		leadChat.type = 'button';
		leadChat.appendChild(renderIcon(Codicon.commentDiscussion));
		this.leadTitle = append(leadChat, $('span.volt-agent-tools-lead-title'));
		setAgentTooltip(leadChat, localize('voltAgent.tools.backToChat', "Back to Chat"));
		this._register(addDisposableListener(leadChat, 'click', () => this.setPresentation('split')));
		this.createFloatChrome();
		this._register(addDisposableListener(this.area, BROWSER_PRESENT_EVENT, e => {
			const mode = (e as CustomEvent<{ mode?: BrowserPresentation }>).detail?.mode;
			if (mode) {
				this.setPresentation(mode);
			}
		}));
		this.layoutService.mainContainer.appendChild(this.area);
		this.syncFullscreenButton();

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
		this._register(onDidChangeLayoutMode(() => this.syncOpen()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.place()));
		this._register(registerAgentFileEditorRouting(this.editorGroupsService, {
			getSessionId: () => getLayoutMode(this.layoutService) === 'agent' && this.canOpenTools() ? this.sessionId : undefined,
			openToolsGroup: () => this.toolsGroup(),
		}));
		this._register(toDisposable(() => this.teardown()));
	}

	//#region Chat-facing API

	/** Makes `sessionId`'s tools area here, out of sight, for code that moves tabs in or out of it. */
	hostToolsPart(sessionId: string): AgentToolsEditorPart | undefined {
		if (this.disposed || this.nested()) {
			return undefined;
		}
		return (toolParts.get(sessionId) ?? this.createPart(sessionId)).part;
	}

	/** The chat on screen that owns this tools area. */
	showsSession(sessionId: string): boolean {
		return this.canOpenTools() && this.sessionId === sessionId;
	}

	/** Its right panel is open on `sessionId` with Source Control, or a tab of the chat's changes. */
	showsChangesFor(sessionId: string): boolean {
		const entry = this.shown;
		return !!entry && entry.sessionId === sessionId && this.announcedOpen
			&& (this.filesSidebar.showsScmFor(sessionId) || entry.part.groups.some(group => group.activeEditor instanceof AgentChangesEditorInput
				|| group.editors.some(editor => isAgentChangesDiffFor(editor, sessionId))));
	}

	/** Its right panel is open on `sessionId` with Source Control: in the files sidebar, or the Changes tab in front. */
	showsScmFor(sessionId: string): boolean {
		const entry = this.shown;
		return !!entry && entry.sessionId === sessionId && this.announcedOpen
			&& (this.filesSidebar.showsScmFor(sessionId) || entry.part.groups.some(group => group.activeEditor instanceof AgentChangesEditorInput));
	}

	/** The chat this host shows. */
	get currentSessionId(): string | undefined {
		return this.sessionId;
	}

	/** A chat the user can see, so a click in its dock can open the right panel. */
	canOpenTools(): boolean {
		return !this.disposed && !this.nested() && !!this.sessionId && this.isOnScreen();
	}

	openToolsPanel(): boolean {
		if (this.disposed || this.nested() || !this.isOnScreen() || !this.sessionId) {
			return false;
		}
		const group = this.toolsGroup();
		if (this.shown?.part.groups.some(candidate => candidate.count > 0)) {
			this.setPresentation('split');
			group?.focus();
		} else {
			this.openBrowser();
		}
		return true;
	}

	/** Closes the right panel like its Close Right Panel button when it shows, else opens it like the title bar button. */
	toggleToolsPanel(): boolean {
		if (getLayoutMode(this.layoutService) !== 'agent' || !this.canOpenTools()) {
			return false;
		}
		if (!this.hasTools()) {
			return this.openToolsPanel();
		}
		this.toolsHidden = true;
		this.setPresentation('split');
		this.chat.focus();
		return true;
	}

	present(sessionId: string | undefined): void {
		if (this.nested()) {
			this.sessionId = sessionId;
			return;
		}
		if (this.sessionId !== sessionId) {
			this.toolsHidden = false;
			this.setPresentation('split', false);
			this.hidePart();
			this.sessionId = sessionId;
			this.ratio = (sessionId ? this.workspace.get(sessionId)?.layout.splitRatio : undefined) ?? 0.5;
		}
		if (sessionId) {
			const saved = toolParts.get(sessionId)
				?? (hasSavedAgentTools(this.storageService, sessionId) || this.pendingSurfaces(sessionId).length || this.filesSidebarOpen() ? this.createPart(sessionId) : undefined);
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
		// A chat in its own worktree works there: its file search, file dialog and terminals start in it.
		const worktree = this.history.get(sessionId)?.worktreePath;
		if (worktree) {
			return URI.file(worktree);
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

	/** Opens `resource` as a tab in this chat's tools and gives back the tab's editor. */
	async openFileTab(resource: URI): Promise<EditorInput | undefined> {
		const group = this.toolsGroup();
		const pane = group ? await this.editorService.openEditor({ resource, options: { pinned: true } }, group) : undefined;
		return pane?.input;
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

	/** Shows a terminal the agent started (a chip click) as a tab in this chat's tools. Its process is untouched. */
	revealTerminal(instance: ITerminalInstance, preserveFocus: boolean): void {
		void this.target()?.showTerminalInTools(instance, preserveFocus);
	}

	/** Opens a tools terminal and runs a CLI login, such as `claude auth login`. */
	runLogin(command: string): void {
		void this.target()?.runCommandInTerminal(command);
	}

	/** Runs a command from the chat (a reply's shell block) in the chat's terminal, in its worktree or project. */
	runCommand(command: string): void {
		void this.target()?.runCommandInTerminal(command);
	}

	openBrowser(url?: string, title?: string, reuse = false): void {
		void this.target()?.openBrowserInTools(url, title, reuse, false);
	}

	/** Without a scope, Source Control in the files sidebar; with one, that scope's diff as a tab. */
	openChanges(scope?: AgentChangesScope): void {
		const owner = this.target();
		if (scope) {
			void owner?.openChangesInTools(false, scope);
		} else {
			owner?.showFilesSidebar('scm');
		}
	}

	/** Opens `input` as a tab in this chat's tools; a tab already showing the same resource comes to the front. */
	openEditorInTools(input: EditorInput, options?: IEditorOptions): Promise<IEditorPane | undefined> {
		const owner = this.target();
		if (!owner || !owner.requireSession()) {
			return Promise.resolve(undefined);
		}
		const resource = input.resource?.toString();
		const existing = resource ? owner.findInShown(editor => editor.resource?.toString() === resource) : undefined;
		if (existing) {
			return existing.group.openEditor(existing.editor, { ...options, pinned: true });
		}
		const group = owner.toolsGroup();
		return group ? group.openEditor(input, { ...options, pinned: true }) : Promise.resolve(undefined);
	}

	/** Opens the files sidebar at the right edge of the tools on `view`. */
	showFilesSidebar(view: AgentFilesSidebarView): void {
		AgentFilesSidebar.show(this.storageService, view);
		// Already open on that view: the tools may still be closed.
		this.onDidChangeFilesSidebar();
	}

	/** Opening the sidebar opens the tools beside the chat on screen, even with no tab in them. */
	private onDidChangeFilesSidebar(): void {
		if (this.filesSidebarOpen() && this.canOpenTools() && (!this.open || this.toolsHidden)) {
			this.toolsGroup();
			return;
		}
		this.syncOpen();
	}

	/** New agent tab in the tools, bound to the same project as the parent chat. */
	openSideChat(): Promise<IEditorPane | undefined> {
		const owner = this.target();
		const sessionId = owner?.requireSession();
		if (!owner || !sessionId) {
			return Promise.resolve(undefined);
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		owner.bindSideChatProject(sessionId, input.sessionId);
		return owner.openInTools(input, false);
	}

	/** Brings a side chat to the front of this chat's tools, opening its tab when it is not there. */
	revealSideChat(chatSessionId: string): Promise<IEditorPane | undefined> | undefined {
		const sessionId = this.sessionId;
		if (!sessionId || !this.canOpenTools()) {
			return undefined;
		}
		const group = this.toolsGroup();
		const existing = this.findInShown(editor => editor instanceof AgentEditorInput && editor.sessionId === chatSessionId);
		if (existing) {
			return existing.group.openEditor(existing.editor, { pinned: true });
		}
		if (!group) {
			return undefined;
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(chatSessionId));
		this.bindSideChatProject(sessionId, chatSessionId);
		return this.openInTools(input, false);
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
		this.toolsHidden = false;
		const entry = toolParts.get(sessionId) ?? this.createPart(sessionId);
		this.showPart(entry);
		// After Close Right Panel the tabs are still there: re-opening one that is already in front
		// changes no group, so nothing else would reopen the panel.
		this.syncOpen();
		return entry.part.activeGroup;
	}

	private createPart(sessionId: string): IToolsPart {
		const store = new DisposableStore();
		const element = append(this.partsHost, $('.part.editor.volt-agent-tools-part.hidden'));
		// A browser tab finds its chat through this, to send it prompts.
		element.dataset.sessionId = sessionId;
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
			enablePreview: false,
			closeEmptyGroups: true,
			editorActionsLocation: 'default',
		}));
		// The editor service does not report editor changes in areas made after startup, so watch each group.
		const groupListeners = store.add(new DisposableMap<number>());
		const entry: IToolsPart = { sessionId, part, element, store, lastUsed: ++partClock, holder: undefined };
		const watchGroup = (group: IEditorGroup) => {
			if (!groupListeners.has(group.id)) {
				groupListeners.set(group.id, group.onDidModelChange(() => {
					entry.holder?.syncOpen();
					notifyAgentToolEditors();
				}));
			}
		};
		part.groups.forEach(watchGroup);
		store.add(part.onDidAddGroup(group => {
			watchGroup(group);
			entry.holder?.syncOpen();
			notifyAgentToolEditors();
		}));
		store.add(part.onDidRemoveGroup(group => {
			groupListeners.deleteAndDispose(group.id);
			entry.holder?.syncOpen();
			notifyAgentToolEditors();
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
			notifyAgentToolEditors();
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
		notifyAgentToolEditors();
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
		notifyAgentToolEditors();
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

	/** The Explorer/Source Control sidebar is a chat's; a page's tools area (Customize) leaves it out. */
	private filesSidebarOpen(): boolean {
		return !isPseudoToolsSession(this.sessionId) && AgentFilesSidebar.isOpen(this.storageService);
	}

	private isOnScreen(): boolean {
		const box = this.container.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	}

	/** Whether the shown area has a tab to show, and the user has not closed it. */
	private hasTools(): boolean {
		const entry = this.shown;
		// In the IDE layout a chat's tools are tabs in the middle (see agentIdeWorkspace), not a split beside it.
		return !this.toolsHidden && !this.nested() && !!entry && entry.sessionId === this.sessionId
			&& (entry.part.groups.some(group => group.count > 0) || this.filesSidebarOpen())
			&& getLayoutMode(this.layoutService) === 'agent';
	}

	/** The split is open while the shown area has at least one tab, unless that tab floats over the chat. */
	private syncOpen(): void {
		if (this.disposed) {
			return;
		}
		const hasTools = this.hasTools();
		if (!hasTools && this.presentation !== 'split') {
			this.setPresentation('split', false);
		} else if (this.presentation === 'floating' && !this.openingFloat && !(this.shown?.part.activeGroup.activeEditor instanceof VoltBrowserEditorInput)) {
			// Only a preview floats; another tool coming to the front docks the area beside the chat.
			this.setPresentation('split', false);
		}
		const open = hasTools && this.presentation !== 'floating';
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
		} else if (open && !this.dragging) {
			const split = this.filesSidebarSplit();
			const last = this.lastSidebarSplit;
			if (split.mode === 'beside' && last.mode === 'beside' && split.width !== last.width) {
				// Resized by its own edge: the chat stays put and the tabs give up the room.
				this.applySplitAt(this.chat.getBoundingClientRect().width);
			} else if (split.mode !== last.mode || split.width !== last.width) {
				this.applySplit(this.ratio);
			}
		}
		const columnBefore = this.lastSidebarSplit.mode === 'beside';
		this.lastSidebarSplit = this.filesSidebarSplit();
		this.place();
		if (this.announcedOpen && columnBefore !== (this.lastSidebarSplit.mode === 'beside')) {
			// The files sidebar took or gave back a column beside the tabs: the window weighs again
			// whether the agents list still fits (agentNeedsSidebarDrawer), now that it is laid out.
			this.layoutService.mainContainer.dispatchEvent(new CustomEvent(AGENT_TOOLS_VISIBILITY_EVENT));
		}
	}

	private filesSidebarSplit(): IFilesSidebarSplit {
		const entry = this.shown;
		if (!this.open || this.presentation !== 'split' || !entry || !this.filesSidebarOpen()) {
			return { mode: 'none', width: 0 };
		}
		const fills = !entry.part.groups.some(group => group.count > 0);
		return { mode: fills ? 'fills' : 'beside', width: AgentFilesSidebar.preferredWidth(this.storageService) };
	}

	/** The room the chat and the tabs split: the row less the split line and a sidebar beside the tabs. */
	private splitRoom(width: number, min: number): number {
		const split = this.filesSidebarSplit();
		const reserved = split.mode === 'beside' ? split.width : 0;
		return Math.max(width - SASH_WIDTH - reserved, min * 2);
	}

	/** The part of the chat's share it keeps: less while the files sidebar sits beside the tabs. */
	private chatShare(): number {
		return this.filesSidebarSplit().mode === 'beside' ? SIDEBAR_CHAT_SHARE : 1;
	}

	/** Puts the split line `chat` pixels from the left. */
	private applySplitAt(chat: number): void {
		const width = this.container.clientWidth || this.lastDimension?.width || MIN_PANE * 2;
		const min = Math.min(MIN_PANE, Math.max(120, Math.floor((width - SASH_WIDTH) / 2)));
		this.applySplit(chat / (this.splitRoom(width, min) * this.chatShare()));
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
		const split = this.filesSidebarSplit();
		if (split.mode === 'fills') {
			// The tools are the sidebar alone, at its own width; the chat keeps its ratio for when tabs open.
			const chat = Math.max(min, Math.min(width - SASH_WIDTH - split.width, width - SASH_WIDTH - min));
			this.chat.style.flex = `0 0 ${chat}px`;
			this.chat.style.width = `${chat}px`;
			return;
		}
		const available = this.splitRoom(width, min);
		const share = this.chatShare();
		let chat = Math.round(available * ratio * share);
		chat = Math.max(min, Math.min(chat, available - min));
		this.chat.style.flex = `0 0 ${chat}px`;
		this.chat.style.width = `${chat}px`;
		// The ratio is the chat's usual share, so it stays in bounds once the sidebar closes.
		this.ratio = Math.min(chat / (available * share), (available - min) / available);
	}

	/** Lays the tools area over the tools' share of the row, and over the title bar above it in agent layout. */
	/** The window layout weighs whether the agent list still fits beside the chat and the tools. */
	private announceVisibility(): void {
		const open = !this.area.classList.contains('hidden') && this.presentation !== 'floating';
		if (open !== this.announcedOpen) {
			this.announcedOpen = open;
			this.layoutService.mainContainer.dispatchEvent(new CustomEvent(AGENT_TOOLS_VISIBILITY_EVENT));
		}
	}

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
		if (entry && this.hasTools() && this.isOnScreen()) {
			if (this.presentation === 'floating') {
				this.placeFloating(entry);
				return;
			}
			if (this.presentation === 'fullscreen') {
				this.placeFullscreen(entry);
				return;
			}
		}
		let box = this.panel.getBoundingClientRect();
		// The spacer was just unhidden and can still measure 0. Lay the overlay on the chat's right side anyway.
		if (this.open && entry && (box.width <= 0 || box.height <= 0)) {
			const host = this.container.getBoundingClientRect();
			if (host.width > 0 && host.height > 0 && this.placeAttempts < 2) {
				this.placeAttempts++;
				this.applySplit(this.ratio);
				box = this.panel.getBoundingClientRect();
			}
			if (box.width <= 0 || box.height <= 0) {
				if (host.width > 0 && host.height > 0) {
					const width = this.container.clientWidth || host.width;
					const chat = Math.round(width * this.ratio);
					const left = Math.round(host.left + chat);
					const toolsWidth = Math.max(0, Math.round(host.right - left));
					const top = host.top;
					const height = Math.max(0, Math.round(host.height));
					this.setAreaBounds(left, top, toolsWidth, height);
					this.mountTitleButtons(entry);
					this.announceVisibility();
					const partWidth = toolsWidth - GRIP_OFFSET - SASH_WIDTH - this.layoutFilesSidebar(entry, toolsWidth - GRIP_OFFSET - SASH_WIDTH, height);
					if (partWidth > 0 && height > 0) {
						entry.part.layout(partWidth, height, 0, 0);
					}
					this.placeAttempts = 0;
					return;
				}
				if (this.placeAttempts < 4) {
					this.placeAttempts++;
					getWindow(this.container).requestAnimationFrame(() => this.place());
					return;
				}
			}
		}
		this.placeAttempts = 0;
		if (!this.open || !entry || box.width <= 0 || box.height <= 0) {
			this.filesSidebar.hide();
			this.area.classList.add('hidden');
			this.releaseTitlebar();
			this.announceVisibility();
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
		this.setAreaBounds(left, top, width, height);
		this.mountTitleButtons(entry);
		this.announceVisibility();
		this.partsHost.style.removeProperty('top');
		this.partsHost.style.removeProperty('left');
		const partWidth = width - GRIP_OFFSET - SASH_WIDTH - this.layoutFilesSidebar(entry, width - GRIP_OFFSET - SASH_WIDTH, height);
		if (partWidth > 0 && height > 0) {
			entry.part.layout(partWidth, height, 0, 0);
		}
	}

	/**
	 * Lays the files sidebar at the right edge of `available` pixels of tools and narrows the tabs
	 * beside it. Its icon row lines up with the tabs' first row. Returns the width it takes.
	 */
	private layoutFilesSidebar(entry: IToolsPart, available: number, height: number): number {
		const open = this.presentation !== 'floating' && this.filesSidebarOpen();
		// No tab beside it: the sidebar is the whole tools area, without an empty editor group next to it.
		const fills = open && !entry.part.groups.some(group => group.count > 0);
		const width = fills ? available : open ? this.filesSidebar.widthFor(available) : 0;
		this.partsHost.classList.toggle('hidden', fills);
		// The sidebar is see-through like the chat; only the tabs keep the area's solid fill (agentEditor.css).
		this.area.classList.toggle('with-files-sidebar', width > 0);
		// The grip draws the split line; through the see-through area this one would double it.
		this.sash.classList.toggle('under-grip', width > 0);
		if (width <= 0) {
			this.partsHost.style.removeProperty('right');
			this.filesSidebar.hide();
			return 0;
		}
		this.partsHost.style.right = `${width}px`;
		// The tabs' first row only, not the breadcrumbs under it, so the icons center on the editor actions.
		const title = entry.element.querySelector<HTMLElement>('.editor-group-container > .title');
		const row = title?.querySelector<HTMLElement>(':scope > .tabs-and-actions-container') ?? title;
		this.filesSidebar.layout(entry.sessionId, width, height, row?.offsetHeight || 35, fills);
		return width;
	}

	private setAreaBounds(left: number, top: number, width: number, height: number): void {
		this.area.style.left = `${Math.round(left)}px`;
		this.area.style.top = `${Math.round(top)}px`;
		this.area.style.width = `${Math.round(width)}px`;
		this.area.style.height = `${Math.round(height)}px`;
		this.area.classList.remove('hidden');
	}

	/** Full screen and Close Right Panel sit at the end of the tools' first tab row. */
	private mountTitleButtons(entry: IToolsPart): void {
		const actions = entry.element.querySelector('.editor-group-container.active > .title .editor-actions')
			?? entry.element.querySelector('.editor-group-container > .title .editor-actions');
		if (!isHTMLElement(actions)) {
			return;
		}
		const toggle = this.filesSidebar.toggleButton;
		toggle.style.display = isPseudoToolsSession(this.sessionId) ? 'none' : '';
		if (toggle.parentElement !== actions || this.fullscreenButton.parentElement !== actions || this.closePanelButton.parentElement !== actions
			|| toggle.nextSibling !== this.fullscreenButton || this.fullscreenButton.nextSibling !== this.closePanelButton) {
			actions.append(toggle, this.fullscreenButton, this.closePanelButton);
		}
		this.scheduleOpenToolsButton(entry);
	}

	/** Tab widths land on the next frame, so the button is placed again after that layout. */
	private scheduleOpenToolsButton(entry: IToolsPart): void {
		this.placeOpenToolsButton(entry);
		if (this.openToolsButtonFrame !== undefined) {
			return;
		}
		const win = getWindow(this.container);
		this.openToolsButtonFrame = win.requestAnimationFrame(() => {
			this.openToolsButtonFrame = win.requestAnimationFrame(() => {
				this.openToolsButtonFrame = undefined;
				if (!this.disposed) {
					this.placeOpenToolsButton(entry);
				}
			});
		});
	}

	/** The editor toolbar rebuilds its buttons after layout. Watch the tab row so the + is measured again. */
	private watchOpenToolsBar(entry: IToolsPart, bar: HTMLElement): void {
		if (bar.dataset.voltOpenToolsWatch === '1') {
			return;
		}
		bar.dataset.voltOpenToolsWatch = '1';
		let frame = 0;
		let again = false;
		const win = getWindow(bar);
		const run = () => {
			frame = 0;
			this.placeOpenToolsButton(entry);
			if (again) {
				again = false;
				frame = win.requestAnimationFrame(run);
			}
		};
		const observer = new MutationObserver(() => {
			if (frame) {
				again = true;
				return;
			}
			frame = win.requestAnimationFrame(run);
		});
		observer.observe(bar, { childList: true, subtree: true });
		entry.store.add(toDisposable(() => {
			observer.disconnect();
			if (frame) {
				win.cancelAnimationFrame(frame);
			}
		}));
	}

	/**
	 * Open in Tools sits just after the last tab. Once the tabs fill the row, the tab strip gives up the
	 * button's width at its right end and the + sits there, so it never covers a tab's close button.
	 */
	private placeOpenToolsButton(entry: IToolsPart): void {
		for (const bar of entry.element.querySelectorAll<HTMLElement>('.editor-group-container > .title > .tabs-and-actions-container')) {
			this.watchOpenToolsBar(entry, bar);
			const scroller = bar.querySelector(':scope > .monaco-scrollable-element');
			const tabs = scroller?.querySelector(':scope > .tabs-container');
			const add = bar.querySelector('.editor-actions .action-item:has(.codicon-add)');
			if (!isHTMLElement(scroller) || !isHTMLElement(tabs) || !isHTMLElement(add)) {
				continue;
			}
			if (tabs.dataset.voltOpenTools !== '1') {
				tabs.dataset.voltOpenTools = '1';
				tabs.addEventListener('scroll', () => entry.holder?.placeOpenToolsButton(entry));
			}
			const tabNodes = tabs.querySelectorAll<HTMLElement>(':scope > .tab');
			const last = tabNodes.item(tabNodes.length - 1);
			const reserved = Number.parseFloat(scroller.style.marginRight) || 0;
			if (!isHTMLElement(last)) {
				delete bar.dataset.voltOpenToolsReady;
				this.reserveOpenToolsSpace(entry, bar, scroller, reserved, 0);
				continue;
			}
			const button = add.getBoundingClientRect().width || 28;
			const barLeft = bar.getBoundingClientRect().left;
			// A small gap so the + does not sit flush against the last tab.
			const tabGap = 5;
			// Measured against the strip's full width, so reserving the space does not change the answer.
			const overflowing = tabs.scrollWidth + tabGap + button > scroller.clientWidth + reserved + 1;
			const edge = overflowing
				? scroller.getBoundingClientRect().right + reserved - button
				: last.getBoundingClientRect().right + tabGap;
			bar.style.setProperty('--volt-open-tools-x', `${Math.max(0, Math.round(edge - barLeft))}px`);
			bar.dataset.voltOpenToolsReady = '1';
			this.reserveOpenToolsSpace(entry, bar, scroller, reserved, overflowing ? Math.ceil(button) : 0);
		}
	}

	/**
	 * Narrows the tab strip by the + button's width. The tab control measures the strip only when it
	 * lays out, so the group lays out again; it then scrolls the active tab clear of the button.
	 */
	private reserveOpenToolsSpace(entry: IToolsPart, bar: HTMLElement, scroller: HTMLElement, current: number, width: number): void {
		if (current === width) {
			return;
		}
		scroller.style.marginRight = width ? `${width}px` : '';
		const container = bar.closest('.editor-group-container');
		entry.part.groups.find(group => group.element === container)?.relayout();
	}

	//#region Floating and full screen

	/** Switches how the tools are drawn. Each browser tab in the area hears about it (toolbar, composer dock). */
	setPresentation(mode: BrowserPresentation, sync = true): void {
		if (mode !== 'split' && (this.nested() || !this.sessionId)) {
			return;
		}
		if (this.presentation !== mode) {
			this.presentation = mode;
			this.area.classList.toggle('floating', mode === 'floating');
			this.area.classList.toggle('fullscreen', mode === 'fullscreen');
			this.area.classList.remove('show-float-bar');
			if (mode !== 'split') {
				this.toolsHidden = false;
				this.addMenu.hide();
			}
			if (mode === 'floating') {
				this.focusPreview();
			}
			this.syncFullscreenButton();
			for (const view of this.area.querySelectorAll('.volt-browser-view')) {
				view.dispatchEvent(new CustomEvent(BROWSER_PRESENTATION_EVENT, { detail: { mode } }));
			}
			this.announceVisibility();
		}
		if (sync) {
			this.syncOpen();
		}
	}

	toggleFullscreen(): boolean {
		if (this.disposed || this.nested() || !this.isOnScreen() || !this.hasTools()) {
			return false;
		}
		this.setPresentation(this.presentation === 'fullscreen' ? 'split' : 'fullscreen');
		return true;
	}

	private syncFullscreenButton(): void {
		const on = this.presentation === 'fullscreen';
		const label = on ? localize('voltAgent.tools.exitFullScreen', "Exit Full Screen") : localize('voltAgent.tools.enterFullScreen', "Enter Full Screen");
		this.fullscreenButton.setAttribute('aria-label', label);
		setAgentTooltip(this.fullscreenButton, label, formatAgentTooltipShortcut({ meta: true, shift: true, key: 'M' }));
		this.fullscreenButton.replaceChildren(createExpandIcon(this.fullscreenButton.ownerDocument, on));
	}

	/** Brings a browser tab to the front of the area, for floating (only a preview floats). */
	private focusPreview(): void {
		const part = this.shown?.part;
		if (!part || part.activeGroup.activeEditor instanceof VoltBrowserEditorInput) {
			return;
		}
		for (const group of [part.activeGroup, ...part.groups]) {
			const browser = group.editors.find(editor => editor instanceof VoltBrowserEditorInput);
			if (browser) {
				void group.openEditor(browser, { preserveFocus: true });
				return;
			}
		}
	}

	/** Across the whole window, over the agents sidebar and the chat; the chat's tab leads the tab row. */
	private placeFullscreen(entry: IToolsPart): void {
		const root = this.layoutService.mainContainer.getBoundingClientRect();
		const titlebar = this.titlebarAbove();
		const top = titlebar ? titlebar.getBoundingClientRect().top : root.top;
		this.releaseTitlebar();
		this.setAreaBounds(root.left, top, root.width, root.bottom - top);
		this.mountTitleButtons(entry);
		const chat = this.sessionId ? this.editorService.editors.find(editor => editor instanceof AgentEditorInput && editor.sessionId === this.sessionId) : undefined;
		this.leadTitle.textContent = limitTabLabel(chat?.getName() || localize('voltAgent.chat', "Agent"));
		this.partsHost.style.removeProperty('top');
		this.partsHost.style.left = '0px';
		// The tab row starts after the traffic lights and the chat's tab.
		const lead = Math.ceil(this.lead.getBoundingClientRect().width);
		this.area.style.setProperty('--volt-tools-lead', `${lead}px`);
		this.markLeadingGroup(entry);
		this.announceVisibility();
		const height = Math.round(root.bottom - top);
		const partWidth = Math.round(root.width) - this.layoutFilesSidebar(entry, Math.round(root.width), height);
		entry.part.layout(partWidth, height, 0, 0);
	}

	/** Only the top-left group's tab row makes room for the lead; split groups keep theirs. */
	private markLeadingGroup(entry: IToolsPart): void {
		const box = entry.element.getBoundingClientRect();
		for (const title of entry.element.querySelectorAll<HTMLElement>('.editor-group-container > .title')) {
			const container = title.parentElement;
			const rect = container?.getBoundingClientRect();
			const leading = !!rect && Math.abs(rect.left - box.left) < 2 && Math.abs(rect.top - box.top) < 2;
			container?.classList.toggle('volt-tools-leading-group', leading);
		}
	}

	/** A preview over the chat's top-right corner, without its tab row or address bar. */
	private placeFloating(entry: IToolsPart): void {
		const box = this.container.getBoundingClientRect();
		this.releaseTitlebar();
		const rect = this.floatBounds(box);
		this.setAreaBounds(rect.left, rect.top, rect.width, rect.height);
		// The tab row is slid out of view above the preview's top edge.
		const title = entry.element.querySelector<HTMLElement>('.editor-group-container.active > .title') ?? entry.element.querySelector<HTMLElement>('.editor-group-container > .title');
		const titleHeight = title?.offsetHeight ?? 35;
		this.partsHost.style.top = `${-titleHeight}px`;
		this.partsHost.style.left = '0px';
		this.layoutFilesSidebar(entry, 0, 0);
		this.announceVisibility();
		entry.part.layout(Math.round(rect.width), Math.round(rect.height + titleHeight), 0, 0);
	}

	private floatBounds(box: DOMRect): { left: number; top: number; width: number; height: number } {
		const maxWidth = Math.max(FLOAT_MIN_WIDTH, box.width - FLOAT_MARGIN * 2);
		const maxHeight = Math.max(FLOAT_MIN_HEIGHT, box.height - FLOAT_MARGIN * 2);
		let rect = floatRect;
		if (!rect) {
			const width = Math.min(640, Math.max(320, Math.round(box.width * 0.42)));
			rect = { right: FLOAT_MARGIN, top: FLOAT_MARGIN, width, height: Math.round(width * 0.98) };
		}
		const width = Math.min(maxWidth, Math.max(FLOAT_MIN_WIDTH, rect.width));
		const height = Math.min(maxHeight, Math.max(FLOAT_MIN_HEIGHT, rect.height));
		const right = Math.min(Math.max(FLOAT_MARGIN, rect.right), Math.max(FLOAT_MARGIN, box.width - width - FLOAT_MARGIN));
		const top = Math.min(Math.max(FLOAT_MARGIN, rect.top), Math.max(FLOAT_MARGIN, box.height - height - FLOAT_MARGIN));
		return { left: box.right - right - width, top: box.top + top, width, height };
	}

	/**
	 * The floating preview's own chrome: edges that resize it (the top edge moves it), and a small
	 * bar of actions that appears when the pointer nears an edge.
	 */
	/** Floating: Move to Side Panel, Open in Separate Window and Close, shown when the pointer nears an edge. */
	private createFloatChrome(): void {
		const bar = append(this.area, $('.volt-agent-float-bar'));
		const action = (icon: HTMLElement | SVGElement, label: string, run: () => void) => {
			const button = append(bar, $('button.volt-agent-float-action')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			setAgentTooltip(button, label);
			button.appendChild(icon);
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				run();
			}));
		};
		action(createPanelRightIcon(bar.ownerDocument), localize('voltAgent.float.dock', "Move to Side Panel"), () => this.setPresentation('split'));
		action(createPopOutIcon(bar.ownerDocument), localize('voltAgent.float.window', "Open in Separate Window"), () => void this.popOutPreview());
		action(renderIcon(Codicon.close), localize('voltAgent.float.close', "Close Floating Preview"), () => {
			this.toolsHidden = true;
			this.setPresentation('split');
		});
		const reveal = () => {
			getWindow(this.area).clearTimeout(this.floatBarTimer);
			this.area.classList.add('show-float-bar');
		};
		const conceal = () => {
			const win = getWindow(this.area);
			win.clearTimeout(this.floatBarTimer);
			this.floatBarTimer = win.setTimeout(() => this.area.classList.remove('show-float-bar'), 900);
		};
		this._register(addDisposableListener(bar, 'pointerenter', reveal));
		this._register(addDisposableListener(bar, 'pointerleave', conceal));
		for (const edge of ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
			const handle = append(this.area, $(`.volt-agent-float-edge.${edge}`));
			this._register(addDisposableListener(handle, 'pointerenter', reveal));
			this._register(addDisposableListener(handle, 'pointerleave', conceal));
			this._register(addDisposableListener(handle, 'pointerdown', e => this.beginFloatDrag(e, edge)));
		}
		this._register(toDisposable(() => getWindow(this.area).clearTimeout(this.floatBarTimer)));
	}

	private beginFloatDrag(event: PointerEvent, kind: string): void {
		if (this.presentation !== 'floating' || event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const box = this.container.getBoundingClientRect();
		const current = this.floatBounds(box);
		this.floatDrag = {
			kind,
			startX: event.clientX,
			startY: event.clientY,
			start: { right: box.right - current.left - current.width, top: current.top - box.top, width: current.width, height: current.height },
		};
		// The page would take the pointer as it passes over it.
		this.area.classList.add('float-dragging');
		const store = new DisposableStore();
		const move = (e: PointerEvent) => {
			const drag = this.floatDrag;
			if (!drag) {
				return;
			}
			const dx = e.clientX - drag.startX;
			const dy = e.clientY - drag.startY;
			let { right, top, width, height } = drag.start;
			if (drag.kind === 'move') {
				right -= dx;
				top += dy;
			} else {
				if (drag.kind.includes('e')) {
					width += dx;
					right -= dx;
				}
				if (drag.kind.includes('w')) {
					width -= dx;
				}
				if (drag.kind.includes('s')) {
					height += dy;
				}
				if (drag.kind.includes('n')) {
					height -= dy;
					top += dy;
				}
				// Past the minimum the opposite edge stays put.
				if (width < FLOAT_MIN_WIDTH) {
					if (drag.kind.includes('e')) {
						right -= FLOAT_MIN_WIDTH - width;
					}
					width = FLOAT_MIN_WIDTH;
				}
				if (height < FLOAT_MIN_HEIGHT) {
					if (drag.kind.includes('n')) {
						top -= FLOAT_MIN_HEIGHT - height;
					}
					height = FLOAT_MIN_HEIGHT;
				}
			}
			floatRect = { right, top, width, height };
			this.place();
		};
		const end = () => {
			store.dispose();
			this.floatDrag = undefined;
			this.area.classList.remove('float-dragging');
			// Keep what was clamped, so the next drag starts from what is on screen.
			const settled = this.floatBounds(this.container.getBoundingClientRect());
			const now = this.container.getBoundingClientRect();
			floatRect = { right: now.right - settled.left - settled.width, top: settled.top - now.top, width: settled.width, height: settled.height };
		};
		store.add(addDisposableListener(handle, 'pointermove', move));
		store.add(addDisposableListener(handle, 'pointerup', end));
		store.add(addDisposableListener(handle, 'pointercancel', end));
		store.add(addDisposableListener(handle, 'lostpointercapture', end));
	}

	/** Moves the preview into a window of its own. The page reloads once there. */
	private async popOutPreview(): Promise<void> {
		const part = this.shown?.part;
		const group = part?.activeGroup;
		const editor = group?.activeEditor;
		if (!group || !(editor instanceof VoltBrowserEditorInput)) {
			return;
		}
		this.setPresentation('split', false);
		const target = await this.editorGroupsService.createAuxiliaryEditorPart();
		group.moveEditor(editor, target.activeGroup);
		this.syncOpen();
	}

	//#endregion

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

	private async openInTools(input: EditorInput, preserveFocus: boolean): Promise<IEditorPane | undefined> {
		return this.toolsGroup()?.openEditor(input, { pinned: true, preserveFocus });
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

	/**
	 * Opens a terminal as an editor tab in the tools group, same as the browser.
	 * `location: { viewColumn }` is a column index in the main editor grid, not this
	 * group's id, so it cannot target the tools part.
	 */
	private async openTerminalInTools(cwd?: string, reuseExisting = false): Promise<ITerminalInstance | undefined> {
		const group = this.toolsGroup();
		if (!group) {
			return undefined;
		}
		if (reuseExisting) {
			const existing = this.terminalInTools();
			if (existing) {
				await existing.group.openEditor(existing.editor, { pinned: true });
				this.syncOpen();
				existing.instance.setVisible(true);
				return existing.instance;
			}
		}
		const instance = await this.createToolsTerminal(cwd ?? this.executionRoot()?.fsPath);
		const input = this.terminalEditorService.getInputFromResource(this.terminalEditorService.resolveResource(instance));
		input.setGroup(group);
		await group.openEditor(input, { pinned: true });
		this.syncOpen();
		instance.setVisible(true);
		return instance;
	}

	/** Opens an existing terminal as a tab in the tools, or brings its tab forward where it already is. */
	private async showTerminalInTools(instance: ITerminalInstance, preserveFocus: boolean): Promise<void> {
		if (instance.isDisposed) {
			return;
		}
		const input = this.terminalEditorService.getInputFromResource(this.terminalEditorService.resolveResource(instance));
		const open = this.editorGroupsService.groups.find(candidate => candidate.contains(input));
		const group = open ?? this.toolsGroup();
		if (!group) {
			return;
		}
		if (!open) {
			input.setGroup(group);
		}
		await group.openEditor(input, { pinned: true, preserveFocus });
		this.syncOpen();
		instance.setVisible(true);
		if (!preserveFocus) {
			await instance.focusWhenReady(true);
		}
	}

	/** A terminal tab already in this chat's tools. Panel terminals are left alone. */
	private terminalInTools(): { group: IEditorGroup; editor: TerminalEditorInput; instance: ITerminalInstance } | undefined {
		const part = this.shown?.part;
		if (!part) {
			return undefined;
		}
		const groups = [part.activeGroup, ...part.groups.filter(candidate => candidate !== part.activeGroup)];
		for (const group of groups) {
			const editors = group.activeEditor
				? [group.activeEditor, ...group.editors.filter(editor => editor !== group.activeEditor)]
				: [...group.editors];
			for (const editor of editors) {
				if (!(editor instanceof TerminalEditorInput)) {
					continue;
				}
				const instance = editor.terminalInstance;
				if (instance && !instance.isDisposed) {
					return { group, editor, instance };
				}
			}
		}
		return undefined;
	}

	/** Builds an editor terminal without showing it. The caller opens that editor in the tools group. */
	private createToolsTerminal(cwd: string | undefined): Promise<ITerminalInstance> {
		return this.instantiationService.invokeFunction(async accessor => {
			const profiles = accessor.get(ITerminalProfileService);
			const instances = accessor.get(ITerminalInstanceService);
			if (profiles.availableProfiles.length === 0) {
				await profiles.profilesReady;
			}
			let profile: ITerminalProfile | undefined;
			try {
				profile = profiles.getDefaultProfile();
			} catch {
				profile = undefined;
			}
			const launch = profile?.path
				? instances.convertProfileToShellLaunchConfig(profile, cwd)
				: { cwd };
			return instances.createInstance(launch, TerminalLocation.Editor);
		});
	}

	private async runCommandInTerminal(command: string): Promise<void> {
		const instance = await this.openTerminalInTools(undefined, true);
		if (!instance) {
			return;
		}
		await instance.focusWhenReady(true);
		await instance.processReady;
		await instance.sendText(command, true);
	}

	/** `float`: the agent opened it while the chat has no tools beside it, so it floats over the chat. */
	private async openBrowserInTools(url: string | undefined, title: string | undefined, reuse: boolean, preserveFocus: boolean, float = false): Promise<void> {
		const floating = float && !this.open && this.presentation === 'split' && !this.nested() && this.isOnScreen();
		if (floating) {
			// Before the tab opens, so the split never flashes open first.
			this.presentation = 'floating';
			this.area.classList.add('floating');
			this.syncFullscreenButton();
			this.openingFloat = true;
		}
		try {
			await this.openBrowserTab(url, title, reuse, preserveFocus);
		} finally {
			if (floating) {
				this.openingFloat = false;
				this.syncOpen();
			}
		}
	}

	private async openBrowserTab(url: string | undefined, title: string | undefined, reuse: boolean, preserveFocus: boolean): Promise<void> {
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

	/** One scope of the chat's changes (Review) as a diff tab. Source Control itself is in the files sidebar. */
	private async openChangesInTools(preserveFocus: boolean, scope: AgentChangesScope): Promise<void> {
		const sessionId = this.sessionId;
		const group = this.toolsGroup();
		if (group && sessionId) {
			await openAgentChangesDiff(this.instantiationService, group, sessionId, scope, preserveFocus);
		}
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
				void this.openBrowserInTools(surface.url, surface.title, false, true, !!surface.floating);
				return;
			case 'changes':
				this.showFilesSidebar('scm');
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
		this.history.pinSessionParent(chatSessionId, parentSessionId);
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
				this.showFilesSidebar('explorer');
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
				void this.openSideChat();
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
		// With no tab open the tools are the files sidebar alone: the line is its edge and sizes it.
		const sizesSidebar = this.filesSidebarSplit().mode === 'fills';
		const move = (e: PointerEvent) => {
			const chat = e.clientX - this.container.getBoundingClientRect().left;
			if (sizesSidebar) {
				AgentFilesSidebar.setWidth(this.storageService, (this.container.clientWidth || 1) - SASH_WIDTH - chat, false);
				this.applySplit(this.ratio);
			} else {
				this.applySplitAt(chat);
			}
			this.place();
		};
		const up = () => {
			this.dragging = false;
			this.setSashState('active', false);
			targetWindow.removeEventListener('pointermove', move);
			targetWindow.removeEventListener('pointerup', up);
			if (sizesSidebar) {
				AgentFilesSidebar.setWidth(this.storageService, AgentFilesSidebar.preferredWidth(this.storageService), true);
				return;
			}
			const sessionId = this.sessionId;
			// A page's tools area keeps its split for the session only; the workspace records are per chat.
			if (sessionId && !isPseudoToolsSession(sessionId)) {
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
		this.closePanelButton.remove();
		this.fullscreenButton.remove();
		this.filesSidebar.hide();
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

registerAction2(class ShowAgentFilesAction extends Action2 {
	constructor() {
		super({
			id: SHOW_AGENT_FILES_COMMAND_ID,
			title: localize2('voltAgent.tools.showFiles', "Show Files in Tools"),
			f1: true,
			precondition: LayoutModeContext.isEqualTo('agent'),
		});
	}

	override run(_accessor: ServicesAccessor): void {
		const host = [...hosts].find(candidate => candidate.canOpenTools());
		host?.showFilesSidebar('explorer');
	}
});

registerAction2(class ShowAgentSourceControlAction extends Action2 {
	constructor() {
		super({
			id: SHOW_AGENT_SCM_COMMAND_ID,
			title: localize2('voltAgent.tools.showScm', "Show Source Control in Tools"),
			f1: true,
			precondition: LayoutModeContext.isEqualTo('agent'),
		});
	}

	override run(_accessor: ServicesAccessor): void {
		const host = [...hosts].find(candidate => candidate.canOpenTools());
		host?.showFilesSidebar('scm');
	}
});

/** Opens the right sidebar on `view` beside the chat on screen; false when no chat can open tools (IDE layout). */
export function showAgentFilesSidebar(view: AgentFilesSidebarView): boolean {
	const host = [...hosts].find(candidate => candidate.canOpenTools());
	host?.showFilesSidebar(view);
	return !!host;
}

registerAction2(class ToggleAgentToolsFullScreenAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_TOOLS_FULLSCREEN_ID,
			title: localize2('voltAgent.tools.toggleFullScreen', "Toggle Tools Full Screen"),
			f1: true,
			precondition: LayoutModeContext.isEqualTo('agent'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM,
				// Above View: Toggle Problems, which owns the chord in the IDE layout.
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: LayoutModeContext.isEqualTo('agent'),
			},
		});
	}

	override run(_accessor: ServicesAccessor): void {
		for (const host of hosts) {
			if (host.toggleFullscreen()) {
				return;
			}
		}
	}
});

registerAction2(class ToggleAgentToolsPanelAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_TOOLS_PANEL_ID,
			title: localize2('voltAgent.tools.togglePanel', "Toggle Right Panel"),
			f1: true,
			precondition: LayoutModeContext.isEqualTo('agent'),
			keybinding: [{
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				// Toggle Agents Side Bar in the IDE layout. Add to Chat (+80) still wins with a code selection.
				weight: KeybindingWeight.WorkbenchContrib + 75,
				when: LayoutModeContext.isEqualTo('agent'),
			}, {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB,
				// Toggle Secondary Side Bar in the IDE layout.
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: LayoutModeContext.isEqualTo('agent'),
			}],
		});
	}

	override run(_accessor: ServicesAccessor): void {
		toggleAgentToolsPanel();
	}
});

/**
 * In the agent layout a web link opens as a browser tab in the tools of the chat on screen, wherever
 * it is clicked: code, terminals, hovers, Source Control, any view. (Links in the chat itself already
 * do, through their own handler.) "Open in System Browser" and extensions' openExternal ask for the
 * system browser explicitly and still get it.
 */
class AgentBrowserLinkOpener extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentBrowserLinks';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IAgentWorkspaceService workspace: IAgentWorkspaceService,
	) {
		super();
		this._register(openerService.registerOpener({
			open: async (resource: URI | string, options?: OpenInternalOptions | OpenExternalOptions) => {
				if ((options as OpenExternalOptions | undefined)?.openExternal || getLayoutMode(layoutService) !== 'agent') {
					return false;
				}
				let target: URI;
				try {
					target = typeof resource === 'string' ? URI.parse(resource) : resource;
				} catch {
					return false;
				}
				if (target.scheme !== Schemas.http && target.scheme !== Schemas.https) {
					return false;
				}
				const active = workspace.active?.sessionId;
				const candidates = [...hosts].filter(host => host.canOpenTools());
				const host = candidates.find(candidate => !!active && candidate.showsSession(active)) ?? candidates[0];
				if (!host) {
					return false;
				}
				// The same page clicked twice comes back to its tab.
				host.openBrowser(typeof resource === 'string' ? resource : target.toString(true), undefined, true);
				return true;
			},
		}));
	}
}

registerWorkbenchContribution2(AgentBrowserLinkOpener.ID, AgentBrowserLinkOpener, WorkbenchPhase.AfterRestored);

/**
 * Git's editor (extensions/git/src/gitEditor.ts): in the agent layout a commit message
 * (COMMIT_EDITMSG, MERGE_MSG, a rebase todo) opens as a new tab in the right panel of the chat on
 * screen, not over the chat. Resolves true once that tab is closed, so git goes on with the saved
 * message; false when no chat can take it, and git opens the file itself.
 */
CommandsRegistry.registerCommand(EDIT_IN_AGENT_TOOLS_COMMAND_ID, async (accessor, resource: UriComponents | undefined) => {
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const activeSession = accessor.get(IAgentWorkspaceService).active?.sessionId;
	if (!resource || getLayoutMode(layoutService) !== 'agent') {
		return false;
	}
	const candidates = [...hosts].filter(host => host.canOpenTools());
	const host = candidates.find(candidate => !!activeSession && candidate.showsSession(activeSession)) ?? candidates[0];
	const input = await host?.openFileTab(URI.revive(resource));
	if (!input) {
		return false;
	}
	// Closed in every group: the editor is disposed. Moving the tab to another group keeps it.
	if (!input.isDisposed()) {
		await Event.toPromise(input.onWillDispose);
	}
	return true;
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 16px stroked glyph on a 24-unit grid, like the tools' other title actions. */
function strokeIcon(doc: Document, paths: readonly string[], rects: readonly { x: number; y: number; width: number; height: number; rx: number }[] = []): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.6');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const rect of rects) {
		const el = doc.createElementNS(SVG_NS, 'rect');
		for (const [name, value] of Object.entries(rect)) {
			el.setAttribute(name, String(value));
		}
		svg.appendChild(el);
	}
	for (const d of paths) {
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

// allow-any-unicode-next-line
/** Cursor's ↗↙ (enter full screen) and ↙↗ inward (exit). */
function createExpandIcon(doc: Document, exit: boolean): SVGSVGElement {
	return exit
		? strokeIcon(doc, ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'])
		: strokeIcon(doc, ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']);
}

function createPanelRightIcon(doc: Document): SVGSVGElement {
	return strokeIcon(doc, ['M15 3v18'], [{ x: 3, y: 3, width: 18, height: 18, rx: 2.5 }]);
}

function createPopOutIcon(doc: Document): SVGSVGElement {
	return strokeIcon(doc, ['M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4'], [{ x: 12, y: 13, width: 10, height: 7, rx: 1.5 }]);
}

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
