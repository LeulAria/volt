/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './scratchAgentBridge.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { SCRATCH_AGENT_TOOLS_SETTING, SCRATCH_ENABLED_SETTING, SCRATCH_HIDE_CHATS_SETTING } from '../../common/canvasScratchSettings.js';
import { ScratchBoardToolProvider } from './scratchAgentTools.js';
import { ScratchBoardEditor } from './scratchBoardEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { ensureAgentToolsPart, openInAgentTools } from '../workspace/agentSurfaceHost.js';
import { OPEN_SCRATCH_IN_TOOLS_COMMAND_ID } from '../workspace/agentSurfaceMenu.js';
import { IScratchSessionLinks } from './scratchSessionLinks.js';
import { NEW_SCRATCH_BOARD_COMMAND_ID, OPEN_FRESH_SCRATCH_BOARD_COMMAND_ID, OPEN_SCRATCH_BOARD_BESIDE_COMMAND_ID, OPEN_SCRATCH_BOARD_COMMAND_ID, SCRATCH_BOARD_EDITOR_ID, ScratchBoardEditorInput, ScratchBoardEditorInputSerializer } from './scratchBoardInput.js';
import { IScratchBoardService } from './scratchBoardService.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ScratchBoardEditor, SCRATCH_BOARD_EDITOR_ID, localize('voltScratch.editorLabel', "Scratch")),
	[new SyncDescriptor(ScratchBoardEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ScratchBoardEditorInput.TypeID, ScratchBoardEditorInputSerializer);

/** Settings > Canvas & Scratch can turn Scratch off: its buttons go and its commands stop. */
const SCRATCH_ENABLED = ContextKeyExpr.equals(`config.${SCRATCH_ENABLED_SETTING}`, true);

/**
 * Opens the Scratch page (on `boardId` when given) in the main panel, in place of the chat. With
 * `sessionId` (back from that chat), its run is the one the dock shows, and comes into view.
 */
export async function openScratchBoard(accessor: ServicesAccessor, boardId?: string, sessionId?: string, showChat = false): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const main = editorGroupsService.mainPart;
	const group = main.groups.find(g => g.editors.some(e => e instanceof ScratchBoardEditorInput)) ?? main.activeGroup;
	const input = group.editors.find((e): e is ScratchBoardEditorInput => e instanceof ScratchBoardEditorInput)
		?? editorService.editors.find((e): e is ScratchBoardEditorInput => e instanceof ScratchBoardEditorInput)
		?? instantiationService.createInstance(ScratchBoardEditorInput);
	const showing = editorService.activeEditor === input;
	if (boardId && !showing) {
		input.boardId = boardId;
	}
	const pane = await editorService.openEditor(input, { pinned: true }, group);
	if (boardId && pane instanceof ScratchBoardEditor) {
		await pane.openBoard(boardId);
		if (sessionId && pane.canvas?.model?.id === boardId) {
			if (showChat) {
				pane.showRun(sessionId);
			} else {
				pane.focusRun(sessionId);
			}
		}
	}
}

/**
 * The Scratch button: a clean board to draw on. The board last opened, or the newest one, is reused
 * while nothing was ever drawn on it, so pressing the button again does not pile up empty boards.
 */
export async function openFreshScratchBoard(accessor: ServicesAccessor): Promise<void> {
	const id = await cleanScratchBoard(accessor.get(IScratchBoardService));
	await accessor.get(IInstantiationService).invokeFunction(openScratchBoard, id);
}

/** A board with nothing drawn on it: the last opened or newest while untouched, else a new one. */
async function cleanScratchBoard(boards: IScratchBoardService): Promise<string> {
	await boards.whenReady;
	const untouched = (id: string | undefined) => {
		const meta = id ? boards.getBoard(id) : undefined;
		return meta && !meta.deleted && !meta.archived && meta.elementCount === 0 && meta.edited === meta.created ? meta.id : undefined;
	};
	const newest = [...boards.index.boards].filter(b => !b.deleted && !b.archived).sort((a, b) => b.created - a.created)[0];
	return untouched(boards.index.lastOpened) ?? untouched(newest?.id) ?? await boards.createBoard();
}

/**
 * The right panel's + menu: chat `sessionId`'s own board with its drawing in view, else a clean
 * board, as a tab beside the chat. The board's agents run in the chat's project.
 */
export async function openScratchInTools(accessor: ServicesAccessor, sessionId: string | undefined): Promise<boolean> {
	const boards = accessor.get(IScratchBoardService);
	const links = accessor.get(IScratchSessionLinks);
	const instantiationService = accessor.get(IInstantiationService);
	await boards.whenReady;
	const linkedId = sessionId ? links.boardFor(sessionId) : undefined;
	const linked = linkedId ? boards.getBoard(linkedId) : undefined;
	const boardId = linked && !linked.deleted ? linked.id : await cleanScratchBoard(boards);
	const input = instantiationService.createInstance(ScratchBoardEditorInput);
	input.boardId = boardId;
	const pane = await openInAgentTools(input, sessionId);
	if (!(pane instanceof ScratchBoardEditor)) {
		return false;
	}
	await pane.openBoard(boardId);
	if (sessionId && linked && pane.canvas?.model?.id === boardId) {
		pane.focusRun(sessionId);
	}
	return true;
}

registerAction2(class OpenScratchInToolsAction extends Action2 {
	constructor() {
		super({ id: OPEN_SCRATCH_IN_TOOLS_COMMAND_ID, title: localize2('voltScratch.openInTools', "Open Scratch Beside Chat"), precondition: SCRATCH_ENABLED });
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<boolean> {
		return openScratchInTools(accessor, typeof sessionId === 'string' ? sessionId : undefined);
	}
});

registerAction2(class OpenFreshScratchBoardAction extends Action2 {
	constructor() {
		super({ id: OPEN_FRESH_SCRATCH_BOARD_COMMAND_ID, title: localize2('voltScratch.openFresh', "Open a Clean Scratch Board"), precondition: SCRATCH_ENABLED });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openFreshScratchBoard(accessor);
	}
});

/**
 * Opens `boardId` as a tab in the right panel of chat `sessionId` (on screen), with that chat's run
 * in view: the board's drawing sits beside the conversation that made it. False when no chat on
 * screen can show tabs.
 */
export async function openScratchBoardBeside(accessor: ServicesAccessor, sessionId: string, boardId: string): Promise<boolean> {
	const input = accessor.get(IInstantiationService).createInstance(ScratchBoardEditorInput);
	input.boardId = boardId;
	const pane = await openInAgentTools(input, sessionId);
	if (!(pane instanceof ScratchBoardEditor)) {
		return false;
	}
	await pane.openBoard(boardId);
	if (pane.canvas?.model?.id === boardId) {
		pane.focusRun(sessionId);
	}
	return true;
}

registerAction2(class OpenScratchBoardBesideAction extends Action2 {
	constructor() {
		super({ id: OPEN_SCRATCH_BOARD_BESIDE_COMMAND_ID, title: localize2('voltScratch.openBeside', "Open Scratch Board Beside Chat") });
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown, boardId?: unknown): Promise<boolean> {
		return typeof sessionId === 'string' && typeof boardId === 'string' ? openScratchBoardBeside(accessor, sessionId, boardId) : false;
	}
});

registerAction2(class OpenScratchBoardAction extends Action2 {
	constructor() {
		super({
			id: OPEN_SCRATCH_BOARD_COMMAND_ID,
			title: localize2('voltScratch.open', "Open Scratch"),
			category: localize2('voltAgent.category', "Agent"),
			precondition: SCRATCH_ENABLED,
			f1: true,
		});
	}

	/** `showChat`: that chat opens in the board's dock (picked in the chats list while the board shows). */
	override async run(accessor: ServicesAccessor, boardId?: unknown, sessionId?: unknown, showChat?: unknown): Promise<void> {
		await openScratchBoard(accessor, typeof boardId === 'string' ? boardId : undefined, typeof sessionId === 'string' ? sessionId : undefined, showChat === true);
	}
});

registerAction2(class NewScratchBoardAction extends Action2 {
	constructor() {
		super({
			id: NEW_SCRATCH_BOARD_COMMAND_ID,
			title: localize2('voltScratch.newCommand', "New Scratch Board"),
			category: localize2('voltAgent.category', "Agent"),
			precondition: SCRATCH_ENABLED,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const boards = accessor.get(IScratchBoardService);
		const instantiationService = accessor.get(IInstantiationService);
		const id = await boards.createBoard();
		await instantiationService.invokeFunction(openScratchBoard, id);
	}
});

const HID_AGENTS_LIST_KEY = 'volt.scratchBoard.hidAgentsList';
const SCRATCH_OPEN_CLASS = 'volt-scratch-open';
const SCRATCH_DISABLED_CLASS = 'volt-scratch-disabled';

/**
 * Scratch is a full-page canvas: in the agent layout it puts the chats list away while it shows
 * (the boards list takes that side) and brings it back on leaving, unless the user opened or
 * closed it themselves in between. The root class lets the chrome hide what belongs to a chat.
 */
class ScratchFullCanvasContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltScratchFullCanvas';

	/** Whether Scratch showed at the last sync; unset until the first sync in the agent layout. */
	private open: boolean | undefined;
	private hidList: boolean;
	private applying = false;
	private listVisible: boolean;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const syncEnabled = () => this.layoutService.mainContainer.classList.toggle(SCRATCH_DISABLED_CLASS, this.configurationService.getValue(SCRATCH_ENABLED_SETTING) === false);
		syncEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SCRATCH_ENABLED_SETTING)) {
				syncEnabled();
			}
		}));
		this.hidList = storageService.getBoolean(HID_AGENTS_LIST_KEY, StorageScope.WORKSPACE, false);
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.sync()));
		this._register(onDidChangeLayoutMode(() => this.sync()));
		this.listVisible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		this._register(this.layoutService.onDidChangePartVisibility(() => {
			const visible = this.layoutService.isVisible(Parts.AUXILIARYBAR_PART);
			if (visible !== this.listVisible && !this.applying && this.open) {
				// The user took the list back (or put it away again): theirs from here on.
				this.setHidList(false);
			}
			this.listVisible = visible;
		}));
		this.sync();
	}

	/** On screen in the main panel; focus in another group (the right panel) does not count as leaving. */
	private scratchShowing(): boolean {
		return this.editorGroupsService.mainPart.groups.some(group => group.activeEditor instanceof ScratchBoardEditorInput)
			&& this.editorService.visibleEditors.some(editor => editor instanceof ScratchBoardEditorInput);
	}

	private sync(): void {
		const agent = getLayoutMode(this.layoutService) === 'agent';
		const open = agent && this.scratchShowing();
		this.layoutService.mainContainer.classList.toggle(SCRATCH_OPEN_CLASS, open);
		if (!agent) {
			// The list belongs to the agent layout: it is put back when that layout returns.
			this.open = undefined;
			return;
		}
		if (open === this.open) {
			return;
		}
		this.open = open;
		if (open) {
			if (this.configurationService.getValue(SCRATCH_HIDE_CHATS_SETTING) !== false && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.setListHidden(true);
				this.setHidList(true);
			}
		} else if (this.hidList) {
			this.setHidList(false);
			if (agent && !this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				this.setListHidden(false);
			}
		}
	}

	private setListHidden(hidden: boolean): void {
		this.applying = true;
		try {
			this.layoutService.setPartHidden(hidden, Parts.AUXILIARYBAR_PART);
		} finally {
			this.applying = false;
		}
	}

	private setHidList(hid: boolean): void {
		this.hidList = hid;
		this.storageService.store(HID_AGENTS_LIST_KEY, hid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(ScratchFullCanvasContribution.ID, ScratchFullCanvasContribution, WorkbenchPhase.AfterRestored);

const BOARD_TAB_ADDED_KEY = 'volt.scratchBoard.boardTabAdded';
const MAX_BOARD_TAB_ADDED = 500;

/**
 * A chat that belongs to a Scratch board (started from it, or drawn on it) gets the board as the
 * first tab of its right panel, on its own drawing. Once per chat: a tab the user closed stays closed.
 */
class ScratchBoardTabContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltScratchBoardTab';

	private added: string[];
	private readonly pending = new Set<string>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IScratchSessionLinks private readonly links: IScratchSessionLinks,
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.added = this.readAdded();
		this._register(this.editorService.onDidActiveEditorChange(() => void this.sync()));
		// A chat that gets its board while it shows (its first send from the board, a scratch_draw).
		this._register(this.links.onDidChange(() => void this.sync()));
		void this.sync();
	}

	private readAdded(): string[] {
		try {
			const raw = JSON.parse(this.storageService.get(BOARD_TAB_ADDED_KEY, StorageScope.PROFILE, '[]'));
			return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return [];
		}
	}

	private markAdded(sessionId: string): void {
		this.added = [...this.added.filter(id => id !== sessionId), sessionId].slice(-MAX_BOARD_TAB_ADDED);
		this.storageService.store(BOARD_TAB_ADDED_KEY, JSON.stringify(this.added), StorageScope.PROFILE, StorageTarget.USER);
	}

	private async sync(): Promise<void> {
		if (this.configurationService.getValue(SCRATCH_ENABLED_SETTING) === false) {
			return;
		}
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		if (!(active instanceof AgentEditorInput)) {
			return;
		}
		const sessionId = active.sessionId;
		const boardId = this.links.boardFor(sessionId);
		if (!boardId || this.pending.has(sessionId) || this.added.includes(sessionId)) {
			return;
		}
		this.pending.add(sessionId);
		try {
			await this.boards.whenReady;
			const board = this.boards.getBoard(boardId);
			const part = ensureAgentToolsPart(sessionId);
			if (!board || board.deleted || !part) {
				return;
			}
			await part.whenRestored;
			this.markAdded(sessionId);
			if (part.groups.some(group => group.editors.some(editor => editor instanceof ScratchBoardEditorInput))) {
				return;
			}
			const group = part.activeGroup;
			const input = this.instantiationService.createInstance(ScratchBoardEditorInput);
			input.boardId = boardId;
			input.revealSessionId = sessionId;
			// First, and in front only when the panel has nothing else open: the user's tabs keep their place.
			await group.openEditor(input, { index: 0, pinned: true, inactive: group.count > 0, preserveFocus: true });
		} finally {
			this.pending.delete(sessionId);
		}
	}
}

registerWorkbenchContribution2(ScratchBoardTabContribution.ID, ScratchBoardTabContribution, WorkbenchPhase.AfterRestored);

/**
 * Puts scratch_read and scratch_draw on Volt's MCP server, so agents can answer on the board,
 * while Scratch and its agent tools are on.
 */
class ScratchBoardToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltScratchBoardTools';

	private readonly registration = this._register(new MutableDisposable());

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		const provider = this._register(instantiationService.createInstance(ScratchBoardToolProvider));
		const sync = () => {
			const on = configurationService.getValue(SCRATCH_ENABLED_SETTING) !== false && configurationService.getValue(SCRATCH_AGENT_TOOLS_SETTING) !== false;
			if (on && !this.registration.value) {
				this.registration.value = hostTools.registerToolProvider(provider);
			} else if (!on) {
				this.registration.clear();
			}
		};
		sync();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SCRATCH_ENABLED_SETTING) || e.affectsConfiguration(SCRATCH_AGENT_TOOLS_SETTING)) {
				sync();
			}
		}));
	}
}

// Before any agent connects, like the visual tools.
registerWorkbenchContribution2(ScratchBoardToolsContribution.ID, ScratchBoardToolsContribution, WorkbenchPhase.BlockRestore);
