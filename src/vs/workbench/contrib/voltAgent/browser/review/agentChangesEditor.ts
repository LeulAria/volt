/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentChangesEditor.css';
import { $, append, Dimension, getWindow } from '../../../../../base/browser/dom.js';
import { PixelRatio } from '../../../../../base/browser/pixelRatio.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, observableFromEvent } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDiffEditorOptions, IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { EditorZoom } from '../../../../../editor/common/config/editorZoom.js';
import { BareFontInfo } from '../../../../../editor/common/config/fontInfo.js';
import { FontMeasurements } from '../../../../../editor/browser/config/fontMeasurements.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILentPaneCompositePart, IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IMultiDiffEditorHeader, IMultiDiffEditorLook, setMultiDiffEditorLookProvider } from '../../../multiDiffEditor/browser/multiDiffEditor.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { VIEWLET_ID as SCM_VIEWLET_ID } from '../../../scm/common/scm.js';
import { AGENT_EDITOR_ID } from '../editor/agentEditorInput.js';
import { AgentChangesScope, IAgentChangesTurn } from './agentSessionChanges.js';
import { getAgentChangesSourceUri, parseAgentChangesSourceUri } from './agentSessionChangesService.js';
import { AgentChangesHeader, AgentChangesHeaderTarget, getAgentCommitDiffTarget } from './agentChangesHeader.js';
import { AgentScmRepositoryFocus } from './agentScmRepository.js';
import { setAgentChangesSession } from './agentTurnsView.js';

export const AGENT_CHANGES_EDITOR_ID = 'workbench.editor.voltAgentChanges';
export const AGENT_CHANGES_INPUT_ID = 'workbench.input.voltAgentChanges';
export const OPEN_AGENT_CHANGES_COMMAND_ID = 'workbench.action.voltAgent.openChanges';

const ChangesIcon = registerIcon('volt-agent-changes-editor-label-icon', Codicon.diffMultiple, localize('voltAgentChangesIcon', 'Icon of the agent changes review tab.'));

/** Characters the line number column holds, as Better Hub's 40px column at 11px. */
const LINE_NUMBER_CHARS = 6;

const SPLIT_DIFF_KEY = 'voltAgent.changes.splitDiff';

/**
 * Better Hub's diff in Monaco: one column of line numbers, a column of +/- signs, no gutter
 * menu, no overview ruler. Inline unless the user picks Split (and the pane is wide enough).
 * Inline, agentChangesEditor.css lays the original editor's numbers over that column, so a
 * deleted line shows its old number where the other lines show theirs.
 */
function reviewDiffOptions(split: boolean): IDiffEditorOptions {
	return {
		renderSideBySide: split,
		useInlineViewWhenSpaceIsLimited: true,
		// Split stays split down to a narrow pane: each side still gets ~175px.
		renderSideBySideInlineBreakpoint: 350,
		renderIndicators: true,
		renderMarginRevertIcon: false,
		renderGutterMenu: false,
		glyphMargin: false,
		folding: false,
		lineNumbersMinChars: LINE_NUMBER_CHARS,
		lineDecorationsWidth: 24,
		renderLineHighlight: 'none',
		renderLineHighlightOnlyWhenFocus: false,
		overviewRulerLanes: 0,
		overviewRulerBorder: false,
		hideCursorInOverviewRuler: true,
	};
}

/**
 * The diff's line height and line number column width, computed as Monaco does: the CSS draws
 * the column's divider and hunk bars to match, and hides the empty line a created file is
 * diffed against.
 */
function applyReviewDiffMetrics(element: HTMLElement, configurationService: IConfigurationService): void {
	const settings = configurationService.getValue<ICodeEditorOptions>('editor');
	const targetWindow = getWindow(element);
	const fontInfo = FontMeasurements.readFontInfo(targetWindow, BareFontInfo.createFromRawSettings(settings ?? {}, PixelRatio.getInstance(targetWindow).value));
	element.style.setProperty('--volt-changes-line-height', `${fontInfo.lineHeight}px`);
	element.style.setProperty('--volt-changes-gutter-width', `${Math.round(LINE_NUMBER_CHARS * fontInfo.maxDigitWidth)}px`);
}

/** Scope the review's diff CSS (agentChangesEditor.css) to another editor. */
const REVIEW_DIFF_CLASSES = ['volt-agent-review-diff', 'volt-agent-changes-widget'];

/**
 * The Changes review's diff style on a multi-diff editor in the agent window's tools, such as
 * git's "Open Changes": the review's options, its CSS (scoped by these classes) and its columns.
 */
class AgentReviewDiffLook extends Disposable implements IMultiDiffEditorLook {

	readonly diffEditorOptions: IObservable<IDiffEditorOptions>;

	constructor(
		container: HTMLElement,
		@IStorageService storage: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		container.classList.add(...REVIEW_DIFF_CLASSES);
		this._register(toDisposable(() => {
			container.classList.remove(...REVIEW_DIFF_CLASSES);
			container.style.removeProperty('--volt-changes-line-height');
			container.style.removeProperty('--volt-changes-gutter-width');
		}));
		// Split or unified as the Changes tab's layout button last set it.
		const split = observableFromEvent(
			this,
			storage.onDidChangeValue(StorageScope.PROFILE, SPLIT_DIFF_KEY, this._store),
			() => storage.getBoolean(SPLIT_DIFF_KEY, StorageScope.PROFILE, false),
		);
		this.diffEditorOptions = derived(this, reader => reviewDiffOptions(split.read(reader)));
		const metrics = () => applyReviewDiffMetrics(container, configurationService);
		metrics();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				metrics();
			}
		}));
		this._register(EditorZoom.onDidChangeZoomLevel(metrics));
	}

	/** A chat's changes (and commits picked from their header) get the scope, branch and Commit & Push bar. */
	createHeader(input: MultiDiffEditorInput, group: IEditorGroup): IMultiDiffEditorHeader | undefined {
		const source = input.resource && parseAgentChangesSourceUri(input.resource);
		const target: AgentChangesHeaderTarget | undefined = source
			? { kind: 'scope', sessionId: source.sessionId, scope: source.scope }
			: getAgentCommitDiffTarget(input);
		return target && this.instantiationService.createInstance(AgentChangesHeader, input, group, target);
	}
}


/**
 * The review's diff style for a multi-diff widget a view hosts itself (a pull request's Code tab):
 * scopes the review CSS to `container` and gives the options for the widget's files.
 */
export function createAgentReviewDiffLook(instantiationService: IInstantiationService, container: HTMLElement): IMultiDiffEditorLook {
	return instantiationService.createInstance(AgentReviewDiffLook, container);
}

/** Multi-diff editors in the agent window's tools take the review's diff style. */
export class AgentReviewDiffLookContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentReviewDiffLook';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(setMultiDiffEditorLookProvider((container, current) => {
			if (!container.closest('.volt-agent-tools-part')) {
				return undefined;
			}
			return current ?? instantiationService.createInstance(AgentReviewDiffLook, container);
		}));
	}
}

export function agentChangesScopeLabel(scope: AgentChangesScope, turn?: IAgentChangesTurn): string {
	switch (scope) {
		case 'pending':
			return localize('voltAgent.changes.pending', "Pending Changes");
		case 'lastTurn':
			return localize('voltAgent.changes.lastTurn', "Last Agent Turn");
		case 'staged':
			return localize('voltAgent.changes.staged', "Staged");
		case 'unstaged':
			return localize('voltAgent.changes.unstaged', "Unstaged");
		case 'uncommitted':
			return localize('voltAgent.changes.uncommitted', "Uncommitted");
		default:
			return turn
				? localize('voltAgent.changes.turnNumber', "Turn {0}", turn.number)
				: localize('voltAgent.changes.turn', "Turn");
	}
}

/**
 * Marks `host` `all-panes-collapsed` while every view of the side bar lent into it is collapsed, for
 * the headers-at-the-bottom layout in agentChangesEditor.css. Stands in for
 * `.monaco-pane-view:not(:has(.pane.expanded))`, which restyled the whole side bar whenever one of
 * its lists added a row (every scroll).
 */
export function trackLentPanesCollapsed(paneCompositeService: IPaneCompositePartService, viewDescriptorService: IViewDescriptorService, id: string, host: HTMLElement): IDisposable {
	const store = new DisposableStore();
	const container = viewDescriptorService.getViewContainerById(id);
	const location = container ? viewDescriptorService.getViewContainerLocation(container) : null;
	const composite = location !== null ? paneCompositeService.getActivePaneComposite(location) : undefined;
	const views = composite?.getId() === id ? composite.getViewPaneContainer() : undefined;
	const sync = () => {
		const collapsed = !!views && views.views.length > 0
			&& views.views.every(view => !((view as { isExpanded?(): boolean }).isExpanded?.() ?? view.isBodyVisible()));
		host.classList.toggle('all-panes-collapsed', collapsed);
	};
	if (views) {
		store.add(views.onDidAddViews(sync));
		store.add(views.onDidRemoveViews(sync));
		// Fires as a view expands or collapses (its body shows or hides).
		store.add(views.onDidChangeViewVisibility(sync));
	}
	sync();
	store.add(toDisposable(() => host.classList.remove('all-panes-collapsed')));
	return store;
}

export async function openAgentChanges(
	instantiationService: IInstantiationService,
	editorService: IEditorService,
	editorGroupsService: IEditorGroupsService,
	sessionId: string,
	scope: AgentChangesScope = 'uncommitted',
): Promise<void> {
	const existing = editorService.editors.find((editor): editor is AgentChangesEditorInput =>
		editor instanceof AgentChangesEditorInput && editor.sessionId === sessionId);
	if (existing) {
		existing.setScope(scope);
		await editorService.openEditor(existing, { pinned: true, revealIfOpened: true });
		return;
	}
	const input = instantiationService.createInstance(AgentChangesEditorInput, sessionId, scope);
	const target = editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
		.find(group => group.activeEditorPane?.getId() !== AGENT_EDITOR_ID)
		?? editorGroupsService.activeGroup;
	await editorService.openEditor(input, { pinned: true, revealIfOpened: true }, target);
}

/**
 * Opens one scope of a chat's changes (its last turn, its pending edits) as a diff in `group`; in
 * the agent window's tools it takes the review's look (AgentReviewDiffLook).
 */
export async function openAgentChangesDiff(
	instantiationService: IInstantiationService,
	group: IEditorGroup,
	sessionId: string,
	scope: AgentChangesScope,
	preserveFocus?: boolean,
): Promise<void> {
	const input = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
		multiDiffSource: getAgentChangesSourceUri(sessionId, scope),
		label: agentChangesScopeLabel(scope),
	}, instantiationService);
	await group.openEditor(input, { pinned: true, preserveFocus });
}

/** `editor` is a diff of `sessionId`'s changes: a scope, or a commit picked from its header. */
export function isAgentChangesDiffFor(editor: EditorInput | undefined, sessionId: string): boolean {
	if (!(editor instanceof MultiDiffEditorInput)) {
		return false;
	}
	const source = editor.resource && parseAgentChangesSourceUri(editor.resource);
	return (source?.sessionId ?? getAgentCommitDiffTarget(editor)?.sessionId) === sessionId;
}

export class AgentChangesEditorInput extends EditorInput {

	static readonly TypeID = AGENT_CHANGES_INPUT_ID;
	static readonly EditorID = AGENT_CHANGES_EDITOR_ID;

	private readonly _onDidChangeScope = this._register(new Emitter<void>());
	readonly onDidChangeScope = this._onDidChangeScope.event;

	private _scope: AgentChangesScope;
	private _resource: URI;

	constructor(
		readonly sessionId: string,
		scope: AgentChangesScope = 'uncommitted',
	) {
		super();
		this._scope = scope;
		this._resource = getAgentChangesSourceUri(sessionId, scope);
	}

	get scope(): AgentChangesScope {
		return this._scope;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get typeId(): string {
		return AgentChangesEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentChangesEditorInput.EditorID;
	}

	/** The tab is always "Changes"; the scope picker inside the editor names the scope. */
	override getName(): string {
		return localize('voltAgent.changes.tab', "Changes");
	}

	override getIcon(): ThemeIcon {
		return ChangesIcon;
	}

	setScope(scope: AgentChangesScope): void {
		if (this._scope === scope) {
			return;
		}
		this._scope = scope;
		this._resource = getAgentChangesSourceUri(this.sessionId, scope);
		this._onDidChangeLabel.fire();
		this._onDidChangeScope.fire();
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other)
			|| (other instanceof AgentChangesEditorInput && other.sessionId === this.sessionId);
	}
}

export class AgentChangesEditorInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof AgentChangesEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof AgentChangesEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ sessionId: editor.sessionId, scope: editor.scope });
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serialized) as { sessionId?: string; scope?: AgentChangesScope };
			if (!data.sessionId) {
				return undefined;
			}
			return instantiationService.createInstance(AgentChangesEditorInput, data.sessionId, data.scope ?? 'uncommitted');
		} catch {
			return undefined;
		}
	}
}

/**
 * The Changes tab: the workbench's Source Control side bar, moved in (see borrowScmView), with the
 * chat's repository shown alone and the chat's turns in Agent Turns. A scope of the chat's changes
 * (its last turn, its pending edits) opens as a diff instead: {@link openAgentChangesDiff}.
 */
export class AgentChangesEditor extends EditorPane {

	static readonly ID = AGENT_CHANGES_EDITOR_ID;

	private container!: HTMLElement;
	private scmHost!: HTMLElement;
	/** The workbench's own Source Control side bar, moved in here while the Changes tab shows it. */
	private readonly scmPanel = this._register(new MutableDisposable<ILentPaneCompositePart>());
	private readonly scmPanesCollapsed = this._register(new MutableDisposable());
	/** Shows the chat's repository in the view once git has opened it. */
	private readonly scmRepository: AgentScmRepositoryFocus;
	private dimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(AgentChangesEditor.ID, group, telemetryService, themeService, storage);
		this.scmRepository = this._register(instantiationService.createInstance(AgentScmRepositoryFocus));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-agent-changes-editor'));
		this.scmHost = append(this.container, $('.volt-agent-changes-scm'));
		const unavailable = append(this.scmHost, $('.volt-agent-changes-scm-unavailable'));
		unavailable.textContent = localize('voltAgent.changes.scmUnavailable', "Source Control is open in another part of the window.");
		// Back in agent layout the side bar is hidden again, so the tab can take it back.
		this._register(this.layoutService.onDidChangePartVisibility(() => {
			if (!this.scmPanel.value) {
				this.borrowScmView();
				this.layoutScm();
			}
		}));
	}

	/**
	 * Moves the Source Control side bar in: the same part, view container and views the IDE layout
	 * shows (title, toolbars, commit box, every view), not copies. Agent layout keeps that part
	 * hidden, so it can sit here; it goes back when the tab hides or the workbench shows it again.
	 */
	private borrowScmView(): void {
		if (this.scmPanel.value || !this.isVisible()) {
			return;
		}
		const container = this.viewDescriptorService.getViewContainerById(SCM_VIEWLET_ID);
		const location = container ? this.viewDescriptorService.getViewContainerLocation(container) : null;
		const lent = location !== null ? this.paneCompositeService.lendPaneComposite(SCM_VIEWLET_ID, location, this.scmHost) : undefined;
		this.scmHost.classList.toggle('unavailable', !lent);
		if (!lent) {
			return;
		}
		this.scmPanel.value = lent;
		this.scmPanesCollapsed.value = trackLentPanesCollapsed(this.paneCompositeService, this.viewDescriptorService, SCM_VIEWLET_ID, this.scmHost);
		Event.once(lent.onDidReturn)(() => {
			if (this.scmPanel.value === lent) {
				this.scmPanesCollapsed.clear();
				this.scmPanel.clear();
				// Shown by the workbench again: say where it is.
				this.borrowScmView();
			}
		});
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.borrowScmView();
			if (this.input instanceof AgentChangesEditorInput) {
				setAgentChangesSession(this.input.sessionId);
				this.showScmRepository(this.input);
			}
			this.layoutScm();
		} else {
			this.scmPanesCollapsed.clear();
			this.scmPanel.clear();
			setAgentChangesSession(undefined);
		}
	}

	override async setInput(input: AgentChangesEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.isVisible()) {
			setAgentChangesSession(input.sessionId);
			this.showScmRepository(input);
		}
	}

	private showScmRepository(input: AgentChangesEditorInput): void {
		void this.scmRepository.show(input.sessionId, () => this.input === input && this.isVisible());
	}

	override clearInput(): void {
		this.scmRepository.clear();
		setAgentChangesSession(undefined);
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.container.style.height = `${dimension.height}px`;
		this.layoutScm();
	}

	private layoutScm(): void {
		if (this.dimension) {
			this.scmPanel.value?.layout(this.dimension.width, this.dimension.height);
		}
	}
}
