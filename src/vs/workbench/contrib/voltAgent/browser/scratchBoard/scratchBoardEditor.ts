/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { fromNow, safeIntl } from '../../../../../base/common/date.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { IScratchBoardMeta } from '../../common/scratchBoard/scratchTypes.js';
import { ScratchAgentDock } from './scratchAgentDock.js';
import { IScratchBoardService, IScratchSnapshot } from './scratchBoardService.js';
import { ScratchBoardEditorInput, SCRATCH_BOARD_EDITOR_ID } from './scratchBoardInput.js';
import { ScratchCanvas } from './scratchCanvas.js';

interface ISnapshotPick extends IQuickPickItem {
	readonly snapshot: IScratchSnapshot;
}

/**
 * The canvas, and the dock with the board's agents under it. The page decides which board the canvas
 * shows: the one asked for, else the last opened, else the newest, else a new one. A board deleted
 * while open (here or in another window) gives way to the next. Other boards open from the chat's
 * side toolbar and the composer's @ menu.
 */
class ScratchBoardPage extends Disposable {

	private readonly _canvas: ScratchCanvas;
	private readonly element: HTMLElement;
	private readonly main: HTMLElement;
	private readonly dock: ScratchAgentDock;
	private width = 0;
	private height = 0;
	private wanted: string | undefined;
	private opening: Promise<void> = Promise.resolve();
	private creating: Promise<string> | undefined;
	private readonly indexScheduler: RunOnceScheduler;

	constructor(
		parent: HTMLElement,
		private readonly onDidOpenBoard: (boardId: string) => void,
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
	) {
		super();
		this.element = append(parent, $('.sx-page'));
		this.main = append(this.element, $('.sx-page-main'));

		// The canvas calls back while it is still being built: the callbacks go through activeBoardId().
		this._canvas = this._register(instantiationService.createInstance(ScratchCanvas, this.main, {
			boardTitle: () => {
				const meta = this.activeMeta();
				return meta ? boardDisplayTitle(meta) : '';
			},
			setBoardTitle: title => {
				const id = this.activeBoardId();
				if (id) {
					this.boards.renameBoard(id, title);
				}
			},
			agentProjectId: () => this.agentProjectId(),
			newBoard: () => void this.createAndOpen(null),
			showVersionHistory: () => void this.showVersionHistory(),
			openRun: sessionId => this.dock.showSession(sessionId),
			closeRun: () => this.dock.close(),
		}));
		// Beside the canvas, not in it: keys, clipboard and wheel in the chat never reach the board.
		this.dock = this._register(instantiationService.createInstance(ScratchAgentDock, this.main, this._canvas));
		this._register(this.canvas.onDidChangeModel(() => {
			const id = this.canvas.model?.id;
			this.canvas.refreshChrome();
			if (id) {
				this.onDidOpenBoard(id);
			}
		}));
		this.indexScheduler = this._register(new RunOnceScheduler(() => this.onIndexChanged(), 0));
		this._register(this.boards.onDidChangeIndex(() => this.indexScheduler.schedule()));
		this.canvas.refreshChrome();
	}

	/** Shows `boardId` when it still exists, else the board the page would pick. */
	async show(boardId: string | undefined): Promise<void> {
		await this.boards.whenReady;
		if (this._store.isDisposed) {
			return;
		}
		const id = this.pick(boardId) ?? await this.newBoard(null);
		if (id) {
			await this.openBoard(id);
		}
	}

	setVisible(visible: boolean): void {
		this.canvas.setVisible(visible);
		// The dock works wherever the board is, beside a chat too: a run chip always opens its chat here.
		this.dock.setVisible(visible);
	}

	/** In a chat's right panel (its tools area), next to that chat. */
	private besideChat(): boolean {
		return !!this.element.closest('.volt-agent-tools-part, .volt-agent-tools-area');
	}

	/**
	 * The project the board's chats run in: the chat's beside it, as its composer shows it; else (the
	 * full page, a new chat not bound yet) the project the window has selected.
	 */
	private agentProjectId(): string | undefined {
		const chat = this.besideChat() ? this.editorGroupsService.mainPart.activeGroup.activeEditor : undefined;
		const binding = chat instanceof AgentEditorInput ? this.sessionContext.bindingFor(chat.sessionId) : undefined;
		if (binding) {
			// A chat in a scratch folder of its own has no project: the board's chats get their own too.
			return this.sessionContext.getProject(binding.projectId)?.scratch ? undefined : binding.projectId;
		}
		return this.sessionContext.activeProject?.id;
	}

	/** Shows the run of chat `sessionId` (coming back from that chat). */
	focusRun(sessionId: string): void {
		this.dock.focusSession(sessionId);
	}

	showRun(sessionId: string): void {
		this.dock.focusSession(sessionId);
		this.dock.showSession(sessionId);
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.relayout();
	}

	focus(): void {
		this.canvas.focus();
	}

	get canvas(): ScratchCanvas {
		return this._canvas;
	}

	private activeBoardId(): string | undefined {
		return this._canvas ? this._canvas.model?.id : undefined; // unset while the canvas builds
	}

	private activeMeta(): IScratchBoardMeta | undefined {
		const id = this.activeBoardId();
		return id ? this.boards.getBoard(id) : undefined;
	}

	/** The board to show: `preferred`, the last opened, the newest, an archived one. */
	private pick(preferred: string | undefined, exclude?: string): string | undefined {
		const usable = (id: string | undefined) => !!id && id !== exclude && !!this.boards.getBoard(id);
		if (usable(preferred)) {
			return preferred;
		}
		const index = this.boards.index;
		if (usable(index.lastOpened)) {
			return index.lastOpened;
		}
		const live = index.boards.filter(b => !b.deleted && b.id !== exclude);
		const newest = (list: readonly IScratchBoardMeta[]) => list.reduce<IScratchBoardMeta | undefined>((best, b) => !best || (b.edited || b.created) > (best.edited || best.created) ? b : best, undefined);
		return (newest(live.filter(b => !b.archived)) ?? newest(live))?.id;
	}

	/** Opens boards in the order asked; a request overtaken by a later one is skipped. */
	private openBoard(boardId: string): Promise<void> {
		this.wanted = boardId;
		this.opening = this.opening.then(async () => {
			if (this.wanted !== boardId || this._store.isDisposed) {
				return;
			}
			try {
				if (this.boards.getBoard(boardId)) {
					await this.canvas.open(boardId);
				}
			} catch (err) {
				this.logService.error(`[volt scratch] could not open board ${boardId}`, err);
				this.notificationService.error(localize('voltScratch.openFailed', "Could not open the board."));
			} finally {
				if (this.wanted === boardId) {
					this.wanted = undefined;
					// Deleted meanwhile (or never there): move on from it.
					this.indexScheduler.schedule();
				}
			}
		});
		return this.opening;
	}

	/** One new board at a time, however many clicks ask for one. */
	private newBoard(folderId: string | null): Promise<string | undefined> {
		if (!this.creating) {
			const creating = this.boards.createBoard({ folderId });
			this.creating = creating;
			const clear = () => {
				if (this.creating === creating) {
					this.creating = undefined;
				}
			};
			creating.then(clear, clear);
		}
		return this.creating.then(id => id, err => {
			this.logService.error('[volt scratch] could not create a board', err);
			this.notificationService.error(localize('voltScratch.createFailed', "Could not create a board."));
			return undefined;
		});
	}

	private async createAndOpen(folderId: string | null): Promise<void> {
		const id = await this.newBoard(folderId);
		if (!id) {
			return;
		}
		await this.openBoard(id);
		this.canvas.focus();
	}

	private onIndexChanged(): void {
		this.canvas.refreshChrome();
		const id = this.canvas.model?.id;
		// A board being opened is checked when it lands.
		if (!id || this.boards.getBoard(id) || this.wanted) {
			return;
		}
		const next = this.pick(undefined, id);
		if (next) {
			void this.openBoard(next);
		} else {
			void this.createAndOpen(null);
		}
	}

	private relayout(): void {
		if (!this.width || !this.height) {
			return;
		}
		this.canvas.layout(this.width, this.height);
		this.dock.layout(this.height);
	}

	private async showVersionHistory(): Promise<void> {
		const meta = this.activeMeta();
		const model = this.canvas.model;
		if (!meta || !model) {
			return;
		}
		const snapshots = await this.boards.listSnapshots(meta.id);
		if (!snapshots.length) {
			this.notificationService.info(localize('voltScratch.noVersions', "No earlier versions of this board yet. Scratch keeps one every ten minutes while you work."));
			return;
		}
		const format = safeIntl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).value;
		const picks: ISnapshotPick[] = snapshots.map(snapshot => ({
			label: format.format(snapshot.time),
			description: fromNow(snapshot.time, true),
			snapshot,
		}));
		const picked = await this.quickInputService.pick(picks, {
			title: localize('voltScratch.versionHistoryTitle', "Version History: {0}", boardDisplayTitle(meta)),
			placeHolder: localize('voltScratch.versionHistoryPlaceholder', "Restore an earlier version of this board"),
			matchOnDescription: true,
		});
		if (!picked || this.canvas.model !== model) {
			this.canvas.focus();
			return;
		}
		const restored = await this.boards.restoreSnapshot(meta.id, picked.snapshot.name);
		this.canvas.focus();
		if (!restored) {
			this.notificationService.error(localize('voltScratch.restoreFailed', "Could not read that version of the board."));
			return;
		}
		this.notificationService.prompt(Severity.Info, localize('voltScratch.restored', "Restored the version from {0}.", picked.label), [{
			label: localize('voltScratch.undoRestore', "Undo"),
			run: () => {
				if (this.canvas.model === model) {
					this.canvas.undo();
				}
			},
		}]);
	}
}

/** The Scratch tab: a full-page whiteboard. */
export class ScratchBoardEditor extends EditorPane {

	static readonly ID = SCRATCH_BOARD_EDITOR_ID;

	private page: ScratchBoardPage | undefined;
	private container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ScratchBoardEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const container = this.container = append(parent, $('.sx-editor'));
		this.page = this._register(this.instantiationService.createInstance(ScratchBoardPage, container, (boardId: string) => {
			if (this.input instanceof ScratchBoardEditorInput) {
				this.input.boardId = boardId;
			}
		}));
	}

	override async setInput(input: ScratchBoardEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!token.isCancellationRequested) {
			await this.page?.show(input.boardId);
			const reveal = input.revealSessionId;
			if (reveal && !token.isCancellationRequested && this.canvas?.model?.id === input.boardId) {
				input.revealSessionId = undefined;
				this.page?.focusRun(reveal);
			}
		}
	}

	/** Shows another board in the open tab. */
	async openBoard(boardId: string): Promise<void> {
		await this.page?.show(boardId);
	}

	/** Brings chat `sessionId`'s run into view on the board shown. */
	focusRun(sessionId: string): void {
		this.page?.focusRun(sessionId);
	}

	/** Opens chat `sessionId` in the board's dock, its run in view. */
	showRun(sessionId: string): void {
		this.page?.showRun(sessionId);
	}

	get canvas(): ScratchCanvas | undefined {
		return this.page?.canvas;
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		this.page?.layout(dimension.width, dimension.height);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.page?.setVisible(visible);
	}

	override focus(): void {
		super.focus();
		this.page?.focus();
	}
}
