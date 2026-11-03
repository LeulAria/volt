/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/gitGraph.css';
import { $, addDisposableListener, append, Dimension, EventType, getWindow, isMouseEvent } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon, renderLabelWithIcons } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ITableContextMenuEvent } from '../../../../../base/browser/ui/table/table.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, IMenuService, isIMenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService, IScopedContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorPane, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentSurfaceHost, openSideChatBeside } from '../workspace/agentSurfaceHost.js';
import { hasSavedAgentTools } from '../workspace/agentToolsEditorPart.js';
import { ContextKeys } from '../../../scm/browser/scmViewPane.js';
import { ISCMHistoryItemRef } from '../../../scm/common/history.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createVoltDropdown, IVoltDropdown, IVoltDropdownOption } from '../ui/dropdown/voltDropdown.js';
import { DateRangePicker, IDateRange } from './gitGraphDatePicker.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { ActivityDay, GitGraphActivity, IActivityRange, startOfDay } from './gitGraphActivity.js';
import { GitGraphInspector, IGitGraphInspectorHost } from './gitGraphInspector.js';
import { dateRange, GitGraphChange, GitGraphDatePreset, GitGraphModel, GitGraphRow, GitGraphScope, IGitGraphCommitRow, isoSeconds } from './gitGraphModel.js';
import { GitGraphAgentAction } from './gitGraphPrompts.js';
import { AgentRenderer, AuthorRenderer, ChangesRenderer, DateRenderer, GIT_GRAPH_COLUMNS_MIN, GIT_GRAPH_ROW_HEIGHT, gitGraphColumns, GraphRenderer, IGitGraphCellHost, isCommitRow, MessageRenderer, RefsRenderer, ShaRenderer } from './gitGraphRenderers.js';

export const GIT_GRAPH_EDITOR_ID = 'workbench.editor.voltGitGraph';
const GIT_GRAPH_INPUT_ID = 'workbench.input.voltGitGraph';

/** Set inside the Git Graph tab, so menu items that open it hide there. */
export const InGitGraphContext = new RawContextKey<boolean>('voltInGitGraph', false);

export interface IGitGraphRequest {
	/** A search to run, in the history provider's query syntax (`author:`, `path:`, `lines:`…). */
	readonly query?: string;
	/** A commit to scroll to and select. */
	readonly reveal?: string;
}

export class GitGraphEditorInput extends EditorInput {

	static readonly TypeID = GIT_GRAPH_INPUT_ID;
	static readonly EditorID = GIT_GRAPH_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltGitGraph, path: '/graph' });

	/** The repository's root (fsPath); the active repository when unset. */
	repositoryRoot: string | undefined;
	private pending: IGitGraphRequest | undefined;

	private readonly _onDidRequest = this._register(new Emitter<void>());
	readonly onDidRequest = this._onDidRequest.event;

	override get typeId(): string { return GitGraphEditorInput.TypeID; }
	override get editorId(): string | undefined { return GitGraphEditorInput.EditorID; }

	override getName(): string {
		return localize('voltGitGraph.tab', "Git Graph");
	}

	override getTitle(): string {
		return this.repositoryRoot
			? localize('voltGitGraph.tabTitle', "Git Graph · {0}", basename(URI.file(this.repositoryRoot)))
			: this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.sourceControl;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof GitGraphEditorInput;
	}

	/** Asks the open pane (or the next one) to search or reveal. */
	request(request: IGitGraphRequest | undefined): void {
		this.pending = request;
		this._onDidRequest.fire();
	}

	takeRequest(): IGitGraphRequest | undefined {
		const request = this.pending;
		this.pending = undefined;
		return request;
	}
}

export class GitGraphEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		return input instanceof GitGraphEditorInput && input.repositoryRoot ? JSON.stringify({ root: input.repositoryRoot }) : '';
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(GitGraphEditorInput);
		try {
			const value = raw ? JSON.parse(raw) as { root?: unknown } : {};
			if (typeof value.root === 'string') {
				input.repositoryRoot = value.root;
			}
		} catch {
			// The active repository.
		}
		return input;
	}
}

type DatePreset = GitGraphDatePreset | 'custom';

const SCOPE_STORAGE = 'volt.gitGraph.scope';
const INSPECTOR_WIDTH_STORAGE = 'volt.gitGraph.inspectorWidth';
const INSPECTOR_MIN = 280;
const INSPECTOR_DEFAULT = 360;
/** The table keeps room for its columns' minimums beside the inspector; a narrower tab narrows the inspector instead. */
const TABLE_MIN = GIT_GRAPH_COLUMNS_MIN;
/** Narrower than this, the table shows the compact column set. */
const COMPACT_TABLE_WIDTH = 600;
/** Narrower than this, the table and the inspector can't share the row: the inspector floats over the table. */
const OVERLAY_INSPECTOR_BELOW = 560;
/** The graph's own right panel (a page's, not a chat's: see isPseudoToolsSession). */
const GIT_GRAPH_TOOLS_ID = 'volt-git-graph';
/** Rows left below the viewport when the next page starts loading. */
const PAGE_AHEAD = 40;

/**
 * The repository's commit graph as an editor tab, GitLens' Commit Graph laid out with Volt's
 * parts: branch/tag chips, the SCM view's lane drawing at a larger size, the agent that wrote each
 * commit (from its trailers), change bars, authors, dates and SHAs in a virtualized table, an
 * activity strip, search with date presets, and a commit inspector. Git work goes through the
 * SCM history provider and git's own commands; nothing here runs git itself.
 */
export class GitGraphEditor extends EditorPane implements IGitGraphInspectorHost {

	static readonly ID = GIT_GRAPH_EDITOR_ID;

	private frame!: HTMLElement;
	private root!: HTMLElement;
	private surfaceHost: AgentSurfaceHost | undefined;
	private toolsPresented = false;
	private readonly tableStore = this._register(new DisposableStore());
	/** A narrow table (the right panel beside a chat) drops Agent, Changes and SHA so the rest stay readable and resizable. */
	private compactColumns = false;
	private toolbar!: HTMLElement;
	private filters!: HTMLElement;
	private body!: HTMLElement;
	private tableHost!: HTMLElement;
	private status!: HTMLElement;
	private countLabel!: HTMLElement;
	private resizer!: HTMLElement;
	private search!: InputBox;
	private table!: WorkbenchTable<GitGraphRow>;
	private activity!: GitGraphActivity;
	private inspector!: GitGraphInspector;
	private graphContextKeyService!: IScopedContextKeyService;

	private readonly model = this._register(new MutableDisposable<GitGraphModel>());
	private readonly modelStore = this._register(new DisposableStore());
	private readonly toolbarStore = this._register(new DisposableStore());
	private readonly filtersStore = this._register(new DisposableStore());
	private readonly inputStore = this._register(new DisposableStore());
	private readonly menuStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly searchSoon = this._register(new RunOnceScheduler(() => this.applyQuery(), 300));
	private readonly renderToolbarSoon = this._register(new RunOnceScheduler(() => this.renderToolbar(), 50));
	private scopeHost!: HTMLElement;
	private dateHost!: HTMLElement;
	private rangeHost!: HTMLElement;
	private cellHost: IGitGraphCellHost | undefined;
	private readonly rangeStore = this._register(new DisposableStore());
	private readonly scopeStore = this._register(new DisposableStore());
	private shownRefsGeneration = -1;
	private keepSelection: string | undefined;

	private repository: ISCMRepository | undefined;
	private datePreset: DatePreset = 'all';
	private customRange: IDateRange | undefined;
	private dateDropdown: IVoltDropdown<DatePreset> | undefined;
	private dimension: Dimension | undefined;
	private inspectorWidth: number;
	private selectedIds: string[] = [];
	private pendingReveal: string | undefined;
	private readonly storage: IStorageService;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IMenuService private readonly menuService: IMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(GitGraphEditor.ID, group, telemetryService, themeService, storageService);
		this.storage = storageService;
		this.inspectorWidth = Math.max(INSPECTOR_MIN, storageService.getNumber(INSPECTOR_WIDTH_STORAGE, StorageScope.PROFILE, INSPECTOR_DEFAULT));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.frame = append(parent, $('.vgg-frame'));
		this.root = append(this.frame, $('.volt-git-graph'));
		this.root.tabIndex = -1;
		this.graphContextKeyService = this._register(this.contextKeyService.createScoped(this.root));
		InGitGraphContext.bindTo(this.graphContextKeyService).set(true);

		this.toolbar = append(this.root, $('.vgg-toolbar'));
		this.filters = append(this.root, $('.vgg-filters'));
		this.createFilters();
		this.activity = this._register(this.instantiationService.createInstance(GitGraphActivity, this.root, (day: number) => void this.revealDay(day)));
		this._register(this.activity.onDidChangeRange(range => void this.onRangeChange(range)));

		this.body = append(this.root, $('.vgg-body'));
		this.tableHost = append(this.body, $('.vgg-table'));
		this.status = append(this.tableHost, $('.vgg-status'));
		this.resizer = append(this.body, $('.vgg-resizer'));
		this.resizer.setAttribute('role', 'separator');
		this.resizer.setAttribute('aria-orientation', 'vertical');
		this._register(addDisposableListener(this.resizer, EventType.POINTER_DOWN, e => this.beginResize(e)));
		this.inspector = this._register(this.instantiationService.createInstance(GitGraphInspector, this.body, this));
		this.body.classList.add('no-inspector');

		this.createTable();

		// As a main tab the graph has a right panel of its own (like Customize's), where Explain and
		// Review open their side chat. The panel sizes the graph, so the table follows the graph's width.
		this.surfaceHost = this._register(this.instantiationService.createInstance(AgentSurfaceHost, this.frame, this.root));
		let observedWidth = -1;
		const resizeObserver = new (getWindow(this.root).ResizeObserver)(() => {
			const width = this.root.clientWidth;
			if (width !== observedWidth) {
				observedWidth = width;
				this.layoutBody();
			}
		});
		resizeObserver.observe(this.root);
		this._register({ dispose: () => resizeObserver.disconnect() });

		// Cmd/Ctrl+F searches the graph; Escape leaves the search box.
		this._register(addDisposableListener(this.root, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyF)) {
				event.preventDefault();
				event.stopPropagation();
				this.search.focus();
				this.search.select();
			}
		}));

		this._register(this.scmService.onDidAddRepository(() => this.onRepositoriesChanged()));
		this._register(this.scmService.onDidRemoveRepository(repository => {
			if (repository === this.repository) {
				this.setRepository(undefined);
			}
			this.onRepositoriesChanged();
		}));
	}

	private createTable(): void {
		const host: IGitGraphCellHost = {
			hoverService: this.hoverService,
			themeService: this.themeService,
			filterByAuthor: author => this.filterByAuthor(author),
			filterByRef: ref => this.filterByRef(ref),
			copy: text => void this.clipboardService.writeText(text),
			inRange: row => {
				const range = this.activity?.range;
				if (!range || row.kind !== 'commit') {
					return true;
				}
				const timestamp = row.vm.historyItem.timestamp ?? 0;
				return timestamp >= range.start && timestamp <= range.end;
			},
		};
		this.cellHost = host;
		this.buildTable();
	}

	/** The table with the full or the compact column set; its listeners live in tableStore. */
	private buildTable(): void {
		const host = this.cellHost!;
		const store = this.tableStore;
		const renderers = [RefsRenderer, GraphRenderer, MessageRenderer, AgentRenderer, ChangesRenderer, AuthorRenderer, DateRenderer, ShaRenderer]
			.map(Renderer => new Renderer(host));
		this.table = store.add(this.instantiationService.createInstance(WorkbenchTable<GitGraphRow>, 'VoltGitGraph', this.tableHost,
			{ headerRowHeight: 26, getHeight: () => GIT_GRAPH_ROW_HEIGHT },
			gitGraphColumns(this.compactColumns),
			renderers,
			{
				identityProvider: { getId: (row: GitGraphRow) => row.kind === 'wip' ? 'wip' : row.vm.historyItem.id },
				multipleSelectionSupport: true,
				horizontalScrolling: false,
				openOnSingleClick: false,
				accessibilityProvider: {
					getAriaLabel: (row: GitGraphRow) => row.kind === 'wip'
						? localize('voltGitGraph.wipAria', "Uncommitted changes, {0} files", row.files)
						: localize('voltGitGraph.rowAria', "{0}, {1}, {2}{3}", row.vm.historyItem.subject, row.vm.historyItem.author ?? '', row.vm.historyItem.displayId ?? row.vm.historyItem.id,
							row.agents.length ? localize('voltGitGraph.rowAriaAgents', ", written with {0}", row.agents.map(agent => agent.name).join(', ')) : ''),
					getWidgetAriaLabel: () => localize('voltGitGraph.aria', "Commit graph"),
				},
			}));
		this.tableHost.insertBefore(this.status, null);
		const element = this.table.getHTMLElement();
		store.add({ dispose: () => element.remove() });

		store.add(this.table.onDidChangeSelection(e => this.onSelection(e.elements)));
		store.add(this.table.onDidOpen(e => {
			const row = e.element;
			if (row?.kind === 'wip') {
				void this.commandService.executeCommand('workbench.view.scm');
			} else if (row) {
				this.openCommitChanges(row);
			}
		}));
		store.add(this.table.onContextMenu(e => this.onContextMenu(e)));
		store.add(this.table.onDidScroll(() => {
			// A row's hover left open under the pointer would take the wheel and stop the scroll.
			this.hoverService.hideHover(true);
			this.updateViewport();
			this.maybeLoadMore();
		}));
	}

	//#region Input

	override async setInput(input: GitGraphEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.inputStore.add(input.onDidRequest(() => this.takeRequest(input)));
		const repository = this.findRepository(input.repositoryRoot);
		if (repository !== this.repository || !this.model.value) {
			this.setRepository(repository);
		}
		this.takeRequest(input);
		if (hasSavedAgentTools(this.storage, GIT_GRAPH_TOOLS_ID) && this.hasOwnTools()) {
			this.presentTools();
		}
	}

	//#region Right panel

	/** The agent layout's main area: beside a chat the graph is a tab in that chat's panel instead. */
	private hasOwnTools(): boolean {
		return getLayoutMode(this.layoutService) === 'agent' && this.editorGroupsService.mainPart.groups.includes(this.group);
	}

	private presentTools(): void {
		if (!this.toolsPresented && this.surfaceHost) {
			this.toolsPresented = true;
			this.surfaceHost.present(GIT_GRAPH_TOOLS_ID);
		}
	}

	/**
	 * A new side chat beside the graph: in the chat's right panel the graph is a tab of (also full
	 * screen, with that chat out of sight), else in the graph's own right panel. Undefined in the IDE layout.
	 */
	async openSideChat(): Promise<IEditorPane | undefined> {
		const beside = openSideChatBeside(this.root);
		if (beside) {
			return beside;
		}
		const host = this.surfaceHost;
		if (!host || !this.hasOwnTools()) {
			return undefined;
		}
		this.presentTools();
		if (!host.canOpenTools()) {
			return undefined;
		}
		return host.openEditorInTools(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri()));
	}

	//#endregion

	override clearInput(): void {
		this.inputStore.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.model.value?.setVisible(visible);
	}

	override focus(): void {
		super.focus();
		this.table?.domFocus();
	}

	private takeRequest(input: GitGraphEditorInput): void {
		const request = input.takeRequest();
		if (!request) {
			return;
		}
		if (input.repositoryRoot && this.findRepository(input.repositoryRoot) !== this.repository) {
			this.setRepository(this.findRepository(input.repositoryRoot));
		}
		if (request.query !== undefined) {
			this.datePreset = 'all';
			this.renderDate();
			this.search.value = request.query;
			this.applyQuery();
		}
		if (request.reveal) {
			this.pendingReveal = request.reveal;
			void this.revealPending();
		}
	}

	private findRepository(root: string | undefined): ISCMRepository | undefined {
		const repositories = [...this.scmService.repositories].filter(repository => repository.provider.rootUri);
		if (root) {
			const target = URI.file(root).toString();
			const exact = repositories.find(repository => repository.provider.rootUri!.toString() === target);
			if (exact) {
				return exact;
			}
			// A folder inside a repository: the deepest repository that holds it.
			const holding = repositories
				.filter(repository => target.startsWith(repository.provider.rootUri!.toString() + '/'))
				.sort((a, b) => b.provider.rootUri!.toString().length - a.provider.rootUri!.toString().length);
			if (holding[0]) {
				return holding[0];
			}
		}
		return this.scmViewService.activeRepository.get() ?? repositories.find(repository => repository.provider.providerId === 'git') ?? repositories[0];
	}

	private onRepositoriesChanged(): void {
		if (!this.repository) {
			const input = this.input instanceof GitGraphEditorInput ? this.input : undefined;
			const repository = this.findRepository(input?.repositoryRoot);
			if (repository) {
				this.setRepository(repository);
				return;
			}
		}
		this.renderToolbar();
	}

	private setRepository(repository: ISCMRepository | undefined): void {
		this.repository = repository;
		this.modelStore.clear();
		this.model.clear();
		this.selectedIds = [];
		this.inspector.clear();
		this.setInspectorVisible(false);
		// A range belongs to one repository's history.
		this.activity?.setRange(undefined, false);
		if (this.rangeHost) {
			this.renderRangeChip(undefined);
		}
		if (this.input instanceof GitGraphEditorInput && repository?.provider.rootUri) {
			this.input.repositoryRoot = repository.provider.rootUri.fsPath;
		}
		ContextKeys.SCMProvider.bindTo(this.graphContextKeyService).set(repository?.provider.providerId);
		if (repository) {
			const model = new GitGraphModel(repository, this.loadScope(repository));
			this.model.value = model;
			model.setVisible(this.isVisible());
			this.modelStore.add(model.onDidChange(change => this.onModelChange(change)));
			this.modelStore.add(repository.provider.onDidChangeResources(() => this.renderToolbarSoon.schedule()));
			// Git's status-bar commands (branch, sync counts) follow its refs: redraw when they change, no polling.
			this.modelStore.add(autorun(reader => {
				const history = repository.provider.historyProvider.read(reader);
				history?.historyItemRef.read(reader);
				history?.historyItemRefChanges.read(reader);
				repository.provider.statusBarCommands.read(reader);
				this.renderToolbarSoon.schedule();
			}));
		}
		this.table?.splice(0, this.table.length, this.model.value?.rows ?? []);
		this.renderToolbar();
		this.renderScope();
		this.renderStatus();
		this.shownRefsGeneration = -1;
		this.activity?.setDays([]);
		this.applyQuery();
	}

	//#endregion

	//#region Model

	private onModelChange(change: GitGraphChange): void {
		const model = this.model.value;
		if (!model) {
			return;
		}
		const rows = model.rows;
		if (model.refsGeneration !== this.shownRefsGeneration) {
			this.shownRefsGeneration = model.refsGeneration;
			this.renderScope();
			void this.refreshActivity(model);
		}
		if (change === GitGraphChange.Reset) {
			this.table.splice(0, this.table.length, rows);
			// Keep the selected commit if the new rows have it; never page through history looking for it.
			this.keepSelection = this.selectedIds[0];
		} else if (change === GitGraphChange.Append) {
			if (rows.length > this.table.length) {
				this.table.splice(this.table.length, 0, rows.slice(this.table.length));
			}
			if (this.keepSelection) {
				const index = model.indexOfCommit(this.keepSelection);
				this.keepSelection = undefined;
				if (index >= 0) {
					this.table.setFocus([index]);
					this.table.setSelection([index]);
				}
			}
			void this.revealPending();
		} else if (rows[0]?.kind === 'wip' && this.table.length) {
			this.table.splice(0, 1, [rows[0]]);
		}
		if (change !== GitGraphChange.State) {
			this.activity.setMatches(model.query ? new Set(rows.filter(isCommitRow).map(row => startOfDay(row.vm.historyItem.timestamp ?? 0))) : undefined);
			this.updateViewport();
		}
		this.renderStatus();
		this.maybeLoadMore();
	}

	/** Full-history activity from git (one cheap pass over times and trailers); the loaded rows if git can't. */
	private async refreshActivity(model: GitGraphModel): Promise<void> {
		const root = this.repository?.provider.rootUri?.fsPath;
		let days: ActivityDay[] | undefined;
		try {
			days = await this.commandService.executeCommand<ActivityDay[]>('_volt.git.commitActivity', root, model.scope.kind === 'all' ? undefined : [...model.walkedRevisions]);
		} catch {
			// An older git extension: fall back below.
		}
		if (this.model.value !== model) {
			return;
		}
		if (!Array.isArray(days)) {
			const byDay = new Map<number, [number, number, number]>();
			for (const row of model.rows) {
				if (row.kind === 'commit' && row.vm.historyItem.timestamp) {
					const day = startOfDay(row.vm.historyItem.timestamp);
					const bucket = byDay.get(day) ?? [day, 0, 0];
					bucket[1]++;
					bucket[2] += row.agents.length ? 1 : 0;
					byDay.set(day, bucket);
				}
			}
			days = [...byDay.values()].sort((a, b) => a[0] - b[0]);
		}
		this.activity.setDays(days);
	}

	/** The on-screen rows' time span, for the strip's band. */
	private updateViewport(): void {
		const model = this.model.value;
		if (!model || !this.table?.length) {
			this.activity.setViewport(undefined, undefined);
			return;
		}
		const first = Math.max(0, Math.floor(this.table.scrollTop / GIT_GRAPH_ROW_HEIGHT));
		const last = Math.min(model.rows.length - 1, Math.ceil((this.table.scrollTop + this.table.renderHeight) / GIT_GRAPH_ROW_HEIGHT));
		let newest: number | undefined;
		let oldest: number | undefined;
		for (let i = first; i <= last; i++) {
			const row = model.rows[i];
			const timestamp = row?.kind === 'commit' ? row.vm.historyItem.timestamp : undefined;
			if (timestamp) {
				newest = Math.max(newest ?? timestamp, timestamp);
				oldest = Math.min(oldest ?? timestamp, timestamp);
			}
		}
		this.activity.setViewport(newest, oldest);
	}

	/**
	 * A range selected on the strip: rows outside it dim (lanes stay intact), history pages back far
	 * enough to hold it (bounded), and the table scrolls to its newest commit. The chip in the filter
	 * row shows it and clears it.
	 */
	private async onRangeChange(range: IActivityRange | undefined): Promise<void> {
		this.renderRangeChip(range);
		this.applyRangeDim();
		this.renderStatus();
		const model = this.model.value;
		if (!model || !range) {
			return;
		}
		await model.revealDay(startOfDay(range.start));
		if (this.model.value !== model || this.activity.range !== range) {
			return;
		}
		const index = model.rows.findIndex(row => row.kind === 'commit' && (row.vm.historyItem.timestamp ?? 0) <= range.end && (row.vm.historyItem.timestamp ?? 0) >= range.start);
		if (index >= 0) {
			this.table.reveal(index, 0.1);
			this.table.setFocus([index]);
		}
		this.renderStatus();
	}

	/** Re-dims the rows already drawn (only those, so it costs a few dozen class toggles); new rows dim as they render. */
	private applyRangeDim(): void {
		const model = this.model.value;
		const host = this.cellHost;
		if (!model || !host) {
			return;
		}
		for (const element of this.tableHost.querySelectorAll<HTMLElement>('.monaco-list-row')) {
			const row = model.rows[Number(element.getAttribute('data-index'))];
			const dim = !!row && !host.inRange(row);
			for (const cellElement of element.querySelectorAll('.vgg-cell')) {
				cellElement.classList.toggle('vgg-dim', dim);
			}
		}
	}

	private renderRangeChip(range: IActivityRange | undefined): void {
		this.rangeStore.clear();
		this.rangeHost.replaceChildren();
		this.rangeHost.style.display = range ? '' : 'none';
		if (!range) {
			return;
		}
		const chip = append(this.rangeHost, $('button.vgg-range-chip')) as HTMLButtonElement;
		chip.type = 'button';
		chip.appendChild(renderIcon(Codicon.calendar));
		append(chip, $('span')).textContent = this.activity.rangeLabel(range);
		const clear = append(chip, $('span.vgg-range-clear'));
		clear.appendChild(renderIcon(Codicon.close));
		chip.setAttribute('aria-label', localize('voltGitGraph.clearRange', "Clear the range {0}", this.activity.rangeLabel(range)));
		this.rangeStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), chip, localize('voltGitGraph.clearRangeHover', "Clear range (Esc on the timeline)")));
		this.rangeStore.add(addDisposableListener(chip, EventType.CLICK, () => this.activity.setRange(undefined, true)));
	}

	/** A day picked on the strip: page back to it (bounded) and select its newest commit. */
	private async revealDay(day: number): Promise<void> {
		const model = this.model.value;
		if (!model) {
			return;
		}
		const index = await model.revealDay(day);
		if (this.model.value === model && index >= 0) {
			this.revealRow(index, true);
		}
	}

	private maybeLoadMore(): void {
		const model = this.model.value;
		if (!model || model.loading || !model.hasMore || !this.table) {
			return;
		}
		const bottom = this.table.scrollTop + this.table.renderHeight;
		if (this.table.scrollHeight - bottom < PAGE_AHEAD * GIT_GRAPH_ROW_HEIGHT) {
			void model.loadMore();
		}
	}

	private async revealPending(): Promise<void> {
		const model = this.model.value;
		const id = this.pendingReveal;
		if (!model || !id) {
			return;
		}
		const index = await model.reveal(id);
		if (this.pendingReveal !== id || this.model.value !== model) {
			return;
		}
		this.pendingReveal = undefined;
		if (index >= 0) {
			this.revealRow(index, true);
		} else if (/^[0-9a-f]{7,64}$/i.test(id) && !model.query) {
			// Further back than paging goes: find it by SHA instead (one git call).
			this.search.value = id;
			this.applyQuery();
			this.pendingReveal = id;
		}
	}

	private revealRow(index: number, select: boolean): void {
		if (index < 0 || index >= this.table.length) {
			return;
		}
		this.table.reveal(index, 0.3);
		this.table.setFocus([index]);
		if (select) {
			this.table.setSelection([index]);
		}
	}

	private renderStatus(): void {
		const model = this.model.value;
		this.status.replaceChildren();
		let text: string | undefined;
		let icon: ThemeIcon | undefined;
		if (!this.repository) {
			text = localize('voltGitGraph.noRepository', "Open a folder with a Git repository to see its graph.");
			icon = Codicon.sourceControl;
		} else if (!model?.historyProvider) {
			text = localize('voltGitGraph.waiting', "Waiting for Git…");
			icon = ThemeIcon.modify(Codicon.loading, 'spin');
		} else if (model.error) {
			text = localize('voltGitGraph.error', "Couldn't read the history: {0}", model.error);
			icon = Codicon.error;
		} else if (!model.rows.some(isCommitRow)) {
			if (model.loading || model.hasMore) {
				text = model.query ? localize('voltGitGraph.searching', "Searching…") : localize('voltGitGraph.loading', "Loading history…");
				icon = ThemeIcon.modify(Codicon.loading, 'spin');
			} else {
				text = model.query ? localize('voltGitGraph.noMatches', "No commits match.") : localize('voltGitGraph.empty', "No commits yet.");
				icon = model.query ? Codicon.search : Codicon.gitCommit;
			}
		}
		this.status.classList.toggle('visible', !!text);
		if (text) {
			if (icon) {
				this.status.appendChild(renderIcon(icon));
			}
			append(this.status, $('span')).textContent = text;
		}
		const commits = model ? model.rows.filter(isCommitRow).length : 0;
		this.countLabel.replaceChildren();
		if (model?.loading && commits) {
			this.countLabel.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		}
		const range = this.activity?.range;
		if (range) {
			// In a range: git's count for those days (all walked refs), not just the rows loaded so far.
			const inRange = this.activity.countIn(range).commits;
			append(this.countLabel, $('span')).textContent = inRange === 1
				? localize('voltGitGraph.inRangeOne', "1 commit in range")
				: localize('voltGitGraph.inRange', "{0} commits in range", inRange);
		} else if (commits) {
			append(this.countLabel, $('span')).textContent = model?.query
				? (model.hasMore ? localize('voltGitGraph.resultsMore', "{0}+ results", commits) : localize('voltGitGraph.results', "{0} results", commits))
				: (model?.hasMore ? localize('voltGitGraph.commitsMore', "{0}+ commits", commits) : localize('voltGitGraph.commits', "{0} commits", commits));
		}
	}

	//#endregion

	//#region Toolbar and filters

	private renderToolbar(): void {
		this.toolbarStore.clear();
		this.toolbar.replaceChildren();
		const store = this.toolbarStore;
		const repositories = [...this.scmService.repositories].filter(repository => repository.provider.rootUri);

		const title = append(this.toolbar, $('.vgg-title'));
		const mark = append(title, $('span.vgg-title-mark'));
		mark.appendChild(renderIcon(Codicon.sourceControl));
		if (repositories.length > 1 && this.repository) {
			const options: IVoltDropdownOption<string>[] = repositories.map(repository => ({
				id: repository.provider.rootUri!.toString(),
				label: basename(repository.provider.rootUri!),
				description: repository.provider.rootUri!.fsPath,
				icon: Codicon.repo,
			}));
			createVoltDropdown(title, this.contextViewService, {
				options,
				value: this.repository.provider.rootUri!.toString(),
				ariaLabel: localize('voltGitGraph.repository', "Repository"),
				onChange: id => this.setRepository(repositories.find(repository => repository.provider.rootUri!.toString() === id)),
			}, store);
		} else {
			append(title, $('span.vgg-title-name')).textContent = this.repository?.provider.rootUri ? basename(this.repository.provider.rootUri) : localize('voltGitGraph.tab', "Git Graph");
		}

		// Git's own status bar commands: the branch picker and the sync counts, exactly as git reports them.
		const commands = this.repository?.provider.statusBarCommands.get() ?? [];
		if (commands.length) {
			append(this.toolbar, $('span.vgg-sep')).appendChild(renderIcon(Codicon.chevronRight));
		}
		for (const command of commands) {
			const button = append(this.toolbar, $('button.vgg-chip')) as HTMLButtonElement;
			button.type = 'button';
			button.append(...renderLabelWithIcons(command.title));
			if (command.tooltip) {
				button.title = command.tooltip;
			}
			store.add(addDisposableListener(button, EventType.CLICK, () => void this.commandService.executeCommand(command.id, ...(command.arguments ?? []))));
		}

		const files = this.model.value?.workingTreeFiles ?? 0;
		if (files) {
			const wip = append(this.toolbar, $('button.vgg-chip.wip')) as HTMLButtonElement;
			wip.type = 'button';
			wip.append(...renderLabelWithIcons(`$(diff) ${files === 1 ? localize('voltGitGraph.oneChange', "1 change") : localize('voltGitGraph.changes', "{0} changes", files)}`));
			store.add(addDisposableListener(wip, EventType.CLICK, () => void this.commandService.executeCommand('workbench.view.scm')));
		}

		append(this.toolbar, $('.vgg-spacer'));
		const provider = this.repository?.provider;
		const action = (icon: ThemeIcon, label: string, run: () => unknown, showLabel = true) => {
			const button = store.add(createVoltButton(this.toolbar, 'ghost', { supportIcons: true, ariaLabel: label, title: label }));
			button.element.classList.add('vgg-btn');
			button.element.classList.toggle('icon-only', !showLabel);
			button.label = showLabel ? `$(${icon.id}) ${label}` : `$(${icon.id})`;
			button.enabled = !!provider;
			store.add(button.onDidClick(() => void run()));
		};
		action(Codicon.repoFetch, localize('voltGitGraph.fetch', "Fetch"), () => this.commandService.executeCommand('git.fetch', provider));
		action(Codicon.repoPull, localize('voltGitGraph.pull', "Pull"), () => this.commandService.executeCommand('git.pull', provider));
		action(Codicon.repoPush, localize('voltGitGraph.push', "Push"), () => this.commandService.executeCommand('git.push', provider));
		action(Codicon.gitBranchCreate, localize('voltGitGraph.newBranch', "Create Branch"), () => this.commandService.executeCommand('git.branch', provider), false);
		action(Codicon.refresh, localize('voltGitGraph.refresh', "Refresh"), () => this.model.value?.reload(), false);
	}

	/** Which refs to walk; redrawn when the repository's refs or the scope change. */
	private renderScope(): void {
		const model = this.model.value;
		this.scopeStore.clear();
		this.scopeHost.replaceChildren();
		const store = this.scopeStore;
		const scope = model?.scope ?? { kind: 'all' };
		const refs = (model?.refs ?? []).filter(ref => ref.category !== undefined);
		const scopeOptions: IVoltDropdownOption<string>[] = [
			{ id: 'all', label: localize('voltGitGraph.scopeAll', "All Branches"), icon: Codicon.gitBranch },
			{ id: 'current', label: localize('voltGitGraph.scopeCurrent', "Current Branch"), description: localize('voltGitGraph.scopeCurrentDetail', "With its upstream and base"), icon: Codicon.target },
			...refs.map(ref => ({ id: `ref:${ref.id}`, label: ref.name, description: ref.category, icon: ThemeIcon.isThemeIcon(ref.icon) ? ref.icon : Codicon.gitBranch })),
		];
		const scopeId = scope.kind === 'ref' ? `ref:${scope.id}` : scope.kind;
		if (!scopeOptions.some(option => option.id === scopeId)) {
			scopeOptions.push({ id: scopeId, label: scope.kind === 'ref' ? scope.id.replace(/^refs\/(heads|remotes|tags)\//, '') : scopeId, icon: Codicon.gitBranch });
		}
		createVoltDropdown(this.scopeHost, this.contextViewService, {
			options: scopeOptions,
			value: scopeId,
			ariaLabel: localize('voltGitGraph.scope', "Branches"),
			searchFrom: 9,
			width: 280,
			onChange: id => this.setScope(id === 'all' ? { kind: 'all' } : id === 'current' ? { kind: 'current' } : { kind: 'ref', id: id.slice(4) }),
		}, store);
	}

	/** When: the date preset. Redrawn when a request resets it. */
	private renderDate(): void {
		this.filtersStore.clear();
		this.dateHost.replaceChildren();
		const custom = this.datePreset === 'custom' && this.customRange ? this.activity.rangeLabel(this.customRange) : undefined;
		this.dateDropdown = createVoltDropdown<DatePreset>(this.dateHost, this.contextViewService, {
			options: [
				{ id: 'all', label: localize('voltGitGraph.dateAll', "All Time"), icon: Codicon.calendar },
				{ id: 'hour', label: localize('voltGitGraph.dateHour', "Last Hour"), icon: Codicon.calendar },
				{ id: 'day', label: localize('voltGitGraph.dateDay', "Last 24 Hours"), icon: Codicon.calendar },
				{ id: 'today', label: localize('voltGitGraph.dateToday', "Today"), icon: Codicon.calendar },
				{ id: 'yesterday', label: localize('voltGitGraph.dateYesterday', "Yesterday"), icon: Codicon.calendar },
				{ id: 'week', label: localize('voltGitGraph.dateWeek', "Last 7 Days"), icon: Codicon.calendar },
				{ id: 'month', label: localize('voltGitGraph.dateMonth', "Last 30 Days"), icon: Codicon.calendar },
				{ id: 'quarter', label: localize('voltGitGraph.dateQuarter', "Last 90 Days"), icon: Codicon.calendar },
				{ id: 'custom', label: custom ?? localize('voltGitGraph.dateCustom', "Custom Range"), description: custom ? localize('voltGitGraph.dateCustomChange', "Pick other days") : localize('voltGitGraph.dateCustomDetail', "Pick days on a calendar"), icon: Codicon.calendar },
			],
			value: this.datePreset,
			ariaLabel: localize('voltGitGraph.date', "Date range"),
			width: 240,
			onChange: preset => {
				if (preset === 'custom') {
					this.openDatePicker();
					return;
				}
				this.datePreset = preset;
				this.applyQuery();
			},
		}, this.filtersStore);
	}

	/** Custom Range: a two-month range calendar under the date dropdown; Apply filters like a preset. */
	private openDatePicker(): void {
		const anchor = this.dateDropdown?.element;
		// Until Apply, the dropdown keeps showing the range in effect.
		this.renderDate();
		if (!anchor) {
			return;
		}
		let applied = false;
		const picker = new DateRangePicker({
			initial: this.customRange,
			count: range => this.activity.countIn(range).commits,
			onApply: range => {
				applied = true;
				this.customRange = range;
				this.datePreset = 'custom';
				this.contextViewService.hideContextView();
				this.renderDate();
				this.applyQuery();
			},
			onCancel: () => this.contextViewService.hideContextView(),
		});
		this.contextViewService.showContextView({
			getAnchor: () => this.dateDropdown?.element ?? anchor,
			anchorAlignment: AnchorAlignment.LEFT,
			render: container => {
				container.appendChild(picker.element);
				getWindow(container).setTimeout(() => picker.focus(), 0);
				return picker;
			},
			onHide: () => {
				picker.dispose();
				if (!applied) {
					this.dateDropdown?.element.focus();
				}
			},
		});
	}

	/** The filter row, built once: scope, date, search box, result count. */
	private createFilters(): void {
		this.scopeHost = append(this.filters, $('.vgg-filter-slot'));
		this.dateHost = append(this.filters, $('.vgg-filter-slot'));
		this.rangeHost = append(this.filters, $('.vgg-filter-slot'));
		this.rangeHost.style.display = 'none';
		this.renderScope();
		this.renderDate();

		const searchHost = append(this.filters, $('.vgg-search'));
		searchHost.appendChild(renderIcon(Codicon.search));
		this.search = this._register(new InputBox(searchHost, this.contextViewService, {
			placeholder: localize('voltGitGraph.searchPlaceholder', "Search commits: message, SHA, author:name, path:src/app.ts, after:2026-10-01"),
			ariaLabel: localize('voltGitGraph.searchAria', "Search commits"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.search.onDidChange(() => this.searchSoon.schedule()));
		this._register(addDisposableListener(this.search.inputElement, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Enter) {
				event.preventDefault();
				this.applyQuery();
			} else if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				event.stopPropagation();
				if (this.search.value) {
					this.search.value = '';
					this.applyQuery();
				} else {
					this.table.domFocus();
				}
			} else if (event.keyCode === KeyCode.DownArrow) {
				event.preventDefault();
				this.table.domFocus();
				if (!this.table.getFocus().length && this.table.length) {
					this.table.setFocus([0]);
				}
			}
		}));

		this.countLabel = append(this.filters, $('span.vgg-count'));
		this.countLabel.setAttribute('aria-live', 'polite');
	}

	private setScope(scope: GitGraphScope): void {
		const model = this.model.value;
		if (!model || !this.repository) {
			return;
		}
		this.saveScope(this.repository, scope);
		model.setScope(scope);
		this.renderScope();
	}

	private loadScope(repository: ISCMRepository): GitGraphScope {
		try {
			const saved = JSON.parse(this.storage.get(SCOPE_STORAGE, StorageScope.WORKSPACE, '{}')) as Record<string, GitGraphScope>;
			const scope = saved[repository.provider.rootUri?.toString() ?? ''];
			if (scope && (scope.kind === 'all' || scope.kind === 'current' || (scope.kind === 'ref' && typeof scope.id === 'string'))) {
				return scope;
			}
		} catch {
			// The default.
		}
		return { kind: 'all' };
	}

	private saveScope(repository: ISCMRepository, scope: GitGraphScope): void {
		let saved: Record<string, GitGraphScope> = {};
		try {
			saved = JSON.parse(this.storage.get(SCOPE_STORAGE, StorageScope.WORKSPACE, '{}'));
		} catch {
			// Start over.
		}
		saved[repository.provider.rootUri?.toString() ?? ''] = scope;
		this.storage.store(SCOPE_STORAGE, JSON.stringify(saved), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	/** The search box plus the date preset, as one query for the history provider. */
	private applyQuery(): void {
		this.searchSoon.cancel();
		const text = this.search?.value.trim() ?? '';
		const range = this.datePreset === 'custom'
			? (this.customRange ? { after: new Date(this.customRange.start), before: new Date(this.customRange.end + 1) } : undefined)
			: dateRange(this.datePreset, new Date());
		const parts = [text];
		if (range?.after) {
			parts.push(`after:${isoSeconds(range.after)}`);
		}
		if (range?.before) {
			parts.push(`before:${isoSeconds(range.before)}`);
		}
		this.model.value?.setQuery(parts.filter(Boolean).join(' '));
	}

	//#endregion

	//#region Filters from cells

	private filterByAuthor(author: string): void {
		const value = this.search.value.replace(/(^|\s)author:("[^"]*"|\S+)/g, '').trim();
		this.search.value = `${value} author:${/\s/.test(author) ? `"${author}"` : author}`.trim();
		this.applyQuery();
	}

	private filterByRef(ref: ISCMHistoryItemRef): void {
		this.setScope({ kind: 'ref', id: ref.id });
	}

	//#endregion

	//#region Selection and inspector

	private onSelection(rows: readonly GitGraphRow[]): void {
		const commits = rows.filter(isCommitRow);
		this.selectedIds = commits.map(row => row.vm.historyItem.id);
		const repository = this.repository;
		if (!repository || !commits.length) {
			if (!rows.length) {
				// Only hide: this runs inside the table's selection event, and setting the selection
				// again (even to the same empty value) fires it again, forever.
				this.hideInspector();
			}
			return;
		}
		this.activity.select(commits[0].vm.historyItem.timestamp);
		this.setInspectorVisible(true);
		if (commits.length === 2) {
			const [a, b] = commits;
			const newer = (a.vm.historyItem.timestamp ?? 0) >= (b.vm.historyItem.timestamp ?? 0) ? a : b;
			this.inspector.showCompare(newer, newer === a ? b : a);
		} else {
			this.inspector.showCommit(repository, commits[0]);
		}
	}

	/** The inspector's close button: clears the selection, which hides the inspector. */
	close(): void {
		if (this.table.getSelection().length) {
			this.table.setSelection([]);
		}
		this.hideInspector();
	}

	private hideInspector(): void {
		this.inspector.clear();
		this.setInspectorVisible(false);
		this.activity.select(undefined);
	}

	private setInspectorVisible(visible: boolean): void {
		if (this.body.classList.contains('no-inspector') === !visible) {
			return;
		}
		this.body.classList.toggle('no-inspector', !visible);
		this.layoutBody();
	}

	revealCommit(id: string): void {
		this.pendingReveal = id;
		void this.revealPending();
	}

	openCommitChanges(row: IGitGraphCommitRow): void {
		const provider = this.repository?.provider;
		if (provider) {
			void this.commandService.executeCommand('workbench.scm.action.graph.viewChanges', provider, row.vm.historyItem);
		}
	}

	compare(newer: IGitGraphCommitRow, older: IGitGraphCommitRow): void {
		const provider = this.repository?.provider;
		if (provider) {
			void this.commandService.executeCommand('workbench.scm.action.graph.viewChanges', provider, newer.vm.historyItem, older.vm.historyItem);
		}
	}

	askAgent(action: GitGraphAgentAction, row: IGitGraphCommitRow): void {
		void this.commandService.executeCommand(ASK_AGENT_COMMAND_ID, {
			repositoryRoot: this.repository?.provider.rootUri?.fsPath,
			action,
			commit: row.vm.historyItem.id,
		});
	}

	showCommitMenu(row: IGitGraphCommitRow, anchor: HTMLElement | StandardMouseEvent): void {
		const provider = this.repository?.provider;
		if (!provider) {
			return;
		}
		const store = new DisposableStore();
		this.menuStore.value = store;
		const item = row.vm.historyItem;

		// Git's ref actions (checkout / delete branch / delete tag) become submenus listing the commit's refs, as in the SCM graph.
		const refMenuItems = MenuRegistry.getMenuItems(MenuId.SCMHistoryItemRefContext).filter(isIMenuItem);
		if (refMenuItems.length && item.references?.length) {
			const refsByAction = new Map<string, ISCMHistoryItemRef[]>();
			for (const ref of item.references) {
				const overlay = this.graphContextKeyService.createOverlay([['scmHistoryItemRef', ref.id]]);
				for (const action of this.menuService.getMenuActions(MenuId.SCMHistoryItemRefContext, overlay).flatMap(group => group[1])) {
					refsByAction.set(action.id, [...refsByAction.get(action.id) ?? [], ref]);
				}
			}
			for (const menuItem of refMenuItems) {
				const actionId = menuItem.command.id;
				const refs = refsByAction.get(actionId);
				if (!refs) {
					continue;
				}
				const submenu = new MenuId(`voltGitGraph.${actionId}.${Date.now()}`);
				store.add(MenuRegistry.appendMenuItem(MenuId.SCMHistoryItemContext, { title: menuItem.command.title, submenu, group: menuItem.group, order: menuItem.order }));
				for (const ref of refs) {
					store.add(registerAction2(class extends Action2 {
						constructor() {
							super({ id: `${actionId}.voltGitGraph.${ref.id}`, title: ref.name, menu: { id: submenu, group: ref.category } });
						}
						override run(accessor: ServicesAccessor, ...args: unknown[]): void {
							void accessor.get(ICommandService).executeCommand(actionId, ...args, ref.id);
						}
					}));
				}
			}
		}

		const groups = this.menuService.getMenuActions(MenuId.SCMHistoryItemContext, this.graphContextKeyService, { arg: provider, shouldForwardArgs: true })
			.filter(group => group[0] !== 'inline');
		this.contextMenuService.showContextMenu({
			contextKeyService: this.graphContextKeyService,
			getAnchor: () => anchor,
			getActions: () => getFlatContextMenuActions(groups),
			getActionsContext: () => item,
			onHide: () => {
				if (this.menuStore.value === store) {
					// Let the picked action run before its registration goes away.
					getWindow(this.root).setTimeout(() => {
						if (this.menuStore.value === store) {
							this.menuStore.clear();
						}
					}, 0);
				}
			},
		});
	}

	private onContextMenu(e: ITableContextMenuEvent<GitGraphRow>): void {
		const row = e.element;
		if (!isCommitRow(row)) {
			return;
		}
		e.browserEvent.preventDefault();
		const anchor = isMouseEvent(e.browserEvent) ? new StandardMouseEvent(getWindow(this.root), e.browserEvent) : e.anchor as HTMLElement;
		this.showCommitMenu(row, anchor);
	}

	//#endregion

	//#region Layout

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.frame.style.width = `${dimension.width}px`;
		this.frame.style.height = `${dimension.height}px`;
		this.root.style.height = `${dimension.height}px`;
		// The right panel (when open) sets the graph's share of the row before the graph lays out in it.
		this.surfaceHost?.layout(dimension);
		this.layoutBody();
	}

	/** Swaps the column set, keeping the rows, the selection and the scroll position. */
	private rebuildTable(compact: boolean): void {
		const scrollTop = this.table.scrollTop;
		const selection = this.table.getSelection();
		const focus = this.table.getFocus();
		const hadFocus = this.table.getHTMLElement().contains(getWindow(this.root).document.activeElement);
		this.compactColumns = compact;
		this.tableStore.clear();
		this.buildTable();
		this.table.splice(0, 0, this.model.value?.rows ?? []);
		this.table.setFocus(focus.filter(index => index < this.table.length));
		this.table.setSelection(selection.filter(index => index < this.table.length));
		this.table.scrollTop = scrollTop;
		if (hadFocus) {
			this.table.domFocus();
		}
	}

	/** The graph's own width: the tab's, less its right panel when that is open. */
	private graphWidth(): number {
		return this.root.clientWidth || this.dimension?.width || 0;
	}

	/** The inspector's width range at a graph width: it gives way to the table in a narrow tab, but keeps a range to drag in. */
	private inspectorBounds(width: number): { min: number; max: number } {
		if (width < OVERLAY_INSPECTOR_BELOW) {
			// Floating, it may cover all but a strip of the table.
			const max = Math.max(200, width - 48);
			return { min: Math.min(240, max), max };
		}
		const max = Math.max(Math.min(INSPECTOR_MIN, Math.floor(width * 0.55)), width - TABLE_MIN);
		return { min: Math.min(240, max), max };
	}

	private layoutBody(): void {
		if (!this.dimension || !this.table) {
			return;
		}
		const width = this.graphWidth();
		this.root.classList.toggle('narrow', width < 820);
		const inspector = !this.body.classList.contains('no-inspector');
		// Too narrow to split (the right panel beside a chat): the inspector floats over the table's right side.
		const overlay = width < OVERLAY_INSPECTOR_BELOW;
		this.body.classList.toggle('overlay-inspector', overlay);
		const bounds = this.inspectorBounds(width);
		const inspectorWidth = inspector ? Math.max(bounds.min, Math.min(bounds.max, this.inspectorWidth)) : 0;
		this.inspector.element.style.width = `${inspectorWidth}px`;
		this.resizer.style.right = overlay ? `${inspectorWidth}px` : '';
		const tableWidth = overlay ? width : Math.max(0, width - inspectorWidth);
		// Some slack between the two widths, so a drag across the line doesn't flip the columns back and forth.
		const compact = this.compactColumns ? tableWidth < COMPACT_TABLE_WIDTH + 40 : tableWidth < COMPACT_TABLE_WIDTH;
		if (compact !== this.compactColumns && tableWidth > 0) {
			this.rebuildTable(compact);
		}
		this.activity.layout(width);
		const height = this.body.clientHeight || Math.max(0, this.dimension.height - this.toolbar.offsetHeight - this.filters.offsetHeight - this.activity.element.offsetHeight);
		this.table.layout(height, tableWidth);
		this.inspector.layout();
		this.maybeLoadMore();
	}

	private beginResize(event: PointerEvent): void {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = this.inspector.element.offsetWidth;
		const targetWindow = getWindow(this.root);
		this.resizer.setPointerCapture(event.pointerId);
		this.resizer.classList.add('active');
		const move = (e: PointerEvent) => {
			const bounds = this.inspectorBounds(this.graphWidth());
			this.inspectorWidth = Math.max(bounds.min, Math.min(bounds.max, startWidth + startX - e.clientX));
			this.layoutBody();
		};
		const up = () => {
			this.resizer.classList.remove('active');
			targetWindow.removeEventListener('pointermove', move);
			targetWindow.removeEventListener('pointerup', up);
			this.storage.store(INSPECTOR_WIDTH_STORAGE, this.inspectorWidth, StorageScope.PROFILE, StorageTarget.USER);
		};
		targetWindow.addEventListener('pointermove', move);
		targetWindow.addEventListener('pointerup', up);
	}

	//#endregion
}

/** Registered in gitGraph.contribution.ts: hands a commit (or lines of it) to the chat as a prompt. */
export const ASK_AGENT_COMMAND_ID = 'volt.gitGraph.askAgent';
