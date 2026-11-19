/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpAutomation.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';
import { IObjectTreeElement, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { raceCancellation, RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { HTTP_METHODS } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import {
	describeHttpFlow, duplicateHttpFlowStep, findHttpFlowStep, HTTP_FLOW_ASSERT_OPS, HTTP_FLOW_ASSERT_TARGETS, HTTP_FLOW_EXTRACT_SOURCES, HTTP_FLOW_FILE_SUFFIX, HTTP_FLOW_SYSTEM_PROMPT, HttpFlowAssertOp, HttpFlowAssertTarget, HttpFlowBodyType,
	HttpFlowExtractSource, HttpFlowGroupRole, httpFlowCatalogRequest, httpFlowGenerationPrompt, httpFlowHtml, httpFlowJUnit, httpFlowMarkdown, httpFlowReportJson, httpFlowRunText, HttpFlowStepKind, httpFlowStepLabel, httpFlowStepsOf, HttpFlowStepStatus,
	IHttpFlow, IHttpFlowAssert, IHttpFlowCatalogCollection, IHttpFlowProblem, IHttpFlowRequestStep, IHttpFlowStep, inferHttpJsonSchema, isHttpFlowContainer, listHttpJsonPaths, moveHttpFlowStep, newHttpFlowRefStep, newHttpFlowStep, newHttpFlowStepId,
	parseHttpFlowAnswer, parseHttpFlowData, removeHttpFlowStep, serializeHttpFlow,
} from '../common/httpAutomation.js';
import { httpRequestLabel, httpRequestsOf, IHttpCollection, IHttpItem } from '../common/httpCollection.js';
import { httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { IVoltHttpCollections } from './voltHttpCollections.js';
import { HttpFlowRun, HttpFlowStepRun, httpFlowRefFor, IHttpFlowResolvedRef, IVoltHttpAutomations, resolveHttpFlowRef } from './voltHttpAutomations.js';
import { IHttpExchange } from './voltHttpService.js';
import { IHttpToolPage, IHttpToolPageHost, IHttpToolTabState } from './voltHttpToolPages.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { createHttpCheck, createHttpDropdown, createHttpIconButton, createHttpVariableField, formatHttpDuration, HttpKeyValueTable, httpStatusClass, renderHttpReadOnlyTable, renderHttpTabs, showHttpActionMenu } from './voltHttpWidgets.js';

type AutomationTab = 'steps' | 'runs' | 'settings';
type RequestTab = 'request' | 'extract' | 'assert' | 'options';
type ReportFormat = 'junit' | 'html' | 'json' | 'markdown';
type DataMode = 'none' | 'rows' | 'file';
type RepeatMode = 'times' | 'forEach' | 'until';

const NARROW = 720;
const STEP_ROW = 28;
const PICK_ROW = 26;
const RESULT_ROW = 28;
const MAX_PICK_ROWS = 10;
const MAX_NARROW_ROWS = 12;
const AI_TIMEOUT_MS = 180_000;
const PREVIEW_CHARS = 4000;
const SELECTED_ENVIRONMENT = '__selected__';

const TARGET_LABELS: Readonly<Record<HttpFlowAssertTarget, string>> = {
	status: localize('voltHttp.autoTargetStatus', "Status"),
	time: localize('voltHttp.autoTargetTime', "Response Time"),
	header: localize('voltHttp.autoTargetHeader', "Header"),
	json: localize('voltHttp.autoTargetJson', "JSON Body"),
	text: localize('voltHttp.autoTargetText', "Body Text"),
	size: localize('voltHttp.autoTargetSize', "Size"),
	contentType: localize('voltHttp.autoTargetContentType', "Content Type"),
	schema: localize('voltHttp.autoTargetSchema', "JSON Schema"),
	variable: localize('voltHttp.autoTargetVariable', "Variable"),
};

const OP_LABELS: Readonly<Record<HttpFlowAssertOp, string>> = {
	equals: localize('voltHttp.autoOpEquals', "equals"),
	notEquals: localize('voltHttp.autoOpNotEquals', "does not equal"),
	contains: localize('voltHttp.autoOpContains', "contains"),
	notContains: localize('voltHttp.autoOpNotContains', "does not contain"),
	matches: localize('voltHttp.autoOpMatches', "matches regex"),
	exists: localize('voltHttp.autoOpExists', "exists"),
	notExists: localize('voltHttp.autoOpNotExists', "does not exist"),
	gt: localize('voltHttp.autoOpGt', "greater than"),
	gte: localize('voltHttp.autoOpGte', "at least"),
	lt: localize('voltHttp.autoOpLt', "less than"),
	lte: localize('voltHttp.autoOpLte', "at most"),
	in: localize('voltHttp.autoOpIn', "is one of"),
	type: localize('voltHttp.autoOpType', "is of type"),
	length: localize('voltHttp.autoOpLength', "has length"),
	schema: localize('voltHttp.autoOpSchema', "matches schema"),
};

const SOURCE_LABELS: Readonly<Record<HttpFlowExtractSource, string>> = {
	json: localize('voltHttp.autoSourceJson', "JSON Path"),
	header: localize('voltHttp.autoSourceHeader', "Header"),
	status: localize('voltHttp.autoSourceStatus', "Status"),
	text: localize('voltHttp.autoSourceText', "Body Text"),
	regex: localize('voltHttp.autoSourceRegex', "Regex"),
	cookie: localize('voltHttp.autoSourceCookie', "Cookie"),
	time: localize('voltHttp.autoSourceTime', "Response Time"),
};

const KIND_LABELS: Readonly<Record<HttpFlowStepKind, string>> = {
	request: localize('voltHttp.autoKindRequest', "Request"),
	delay: localize('voltHttp.autoKindDelay', "Delay"),
	set: localize('voltHttp.autoKindSet', "Set Variables"),
	group: localize('voltHttp.autoKindGroup', "Group"),
	condition: localize('voltHttp.autoKindCondition', "Condition"),
	repeat: localize('voltHttp.autoKindRepeat', "Repeat"),
};

const STATUS_LABELS: Readonly<Record<HttpFlowStepStatus, string>> = {
	queued: localize('voltHttp.autoStatusQueued', "Queued"),
	running: localize('voltHttp.autoStatusRunning', "Running"),
	passed: localize('voltHttp.autoStatusPassed', "Passed"),
	failed: localize('voltHttp.autoStatusFailed', "Failed"),
	skipped: localize('voltHttp.autoStatusSkipped', "Skipped"),
	error: localize('voltHttp.autoStatusError', "Error"),
};

function kindIcon(step: IHttpFlowStep): ThemeIcon {
	switch (step.kind) {
		case 'request': return Codicon.arrowSwap;
		case 'delay': return Codicon.watch;
		case 'set': return Codicon.symbolVariable;
		case 'group': return step.role === 'setup' ? Codicon.tools : step.role === 'teardown' ? Codicon.clearAll : Codicon.folder;
		case 'condition': return Codicon.filter;
		case 'repeat': return Codicon.sync;
	}
}

function statusIcon(status: HttpFlowStepStatus): ThemeIcon {
	switch (status) {
		case 'passed': return Codicon.passFilled;
		case 'failed': return Codicon.error;
		case 'error': return Codicon.warning;
		case 'skipped': return Codicon.circleSlash;
		case 'running': return Codicon.loading;
		case 'queued': return Codicon.circleLargeOutline;
	}
}

/** A status icon; a running one spins its box, never the glyph. */
function appendStatus(parent: HTMLElement, status: HttpFlowStepStatus): void {
	parent.dataset.status = status;
	setAgentTooltip(parent, STATUS_LABELS[status]);
	if (status === 'running') {
		append(parent, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
	} else {
		parent.appendChild(renderIcon(statusIcon(status)));
	}
}

/** A value typed in a field: numbers, booleans, null, lists and objects as JSON, anything else as text. */
function parseValue(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	if (/^(?:-?\d+(?:\.\d+)?|true|false|null)$/.test(trimmed) || /^[[{]/.test(trimmed)) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// Not JSON after all: the text itself.
		}
	}
	return text;
}

function valueText(value: unknown): string {
	return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

function safeJson(text: string | undefined): unknown {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n${localize('voltHttp.autoCut', "({0} more characters)", text.length - max)}` : text;
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: readonly Record<string, string>[]): string {
	const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
	if (!columns.length) {
		return '';
	}
	return [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column] ?? '')).join(','))].join('\n');
}

/** A variable name for what a JSON path or header points at. */
function nameFor(path: string): string {
	const last = path.replace(/\[\d+\]$/g, '').split(/[.[\]'"]+/).filter(Boolean).at(-1) ?? 'value';
	const name = last.replace(/[^A-Za-z0-9_]+(.)?/g, (_match, next: string | undefined) => next ? next.toUpperCase() : '');
	return /^[A-Za-z_]/.test(name) ? name : `value${name}`;
}

// --- Rows ------------------------------------------------------------------------------------------

interface IStepNode {
	readonly step: IHttpFlowStep;
	readonly parentId: string | undefined;
}

interface IStepTemplate {
	readonly row: HTMLElement;
	readonly status: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly time: HTMLElement;
	readonly store: DisposableStore;
}

interface IPickNode {
	readonly kind: 'collection' | 'folder' | 'request';
	readonly id: string;
	readonly label: string;
	readonly collection: URI;
	readonly requestId?: string;
	readonly method?: string;
	readonly badgeKey?: string;
	/** The request keys under it (itself for a request). */
	readonly keys: readonly string[];
	readonly children: IPickNode[];
}

interface IPickTemplate {
	readonly check: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
}

type ResultNode = { readonly kind: 'iteration'; readonly key: string; readonly iteration: number; readonly status: HttpFlowStepStatus; readonly children: ResultNode[] } | { readonly kind: 'step'; readonly key: string; readonly step: HttpFlowStepRun; readonly children: ResultNode[] };

interface IResultTemplate {
	readonly status: HTMLElement;
	readonly label: HTMLElement;
	readonly code: HTMLElement;
	readonly attempts: HTMLElement;
	readonly time: HTMLElement;
}

// --- The page --------------------------------------------------------------------------------------

/**
 * An automation's tab: Steps (the step tree, drag to reorder or nest, and the selected step's
 * editor), Runs (the run in progress or the last one, each step's result and a short history) and
 * Settings. The run itself lives in `IVoltHttpAutomations`, so this page can come and go.
 */
export class HttpAutomationPage extends Disposable implements IHttpToolPage {

	private readonly uri: URI;
	private readonly element: HTMLElement;
	private readonly nameInput: HTMLInputElement;
	private readonly progressEl: HTMLElement;
	private readonly envSlot: HTMLElement;
	private readonly envStore = this._register(new DisposableStore());
	private readonly runButton: ReturnType<typeof createVoltButton>;
	private readonly tabsEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly view = this._register(new DisposableStore());
	private readonly menu = this._register(new MutableDisposable());
	private readonly progress: RunOnceScheduler;
	private readonly problemCheck: RunOnceScheduler;
	private readonly frame = this._register(new MutableDisposable());
	private readonly aiRun = this._register(new MutableDisposable());
	private wasRunning = false;
	private width = 0;
	private environments: string[] = [];
	private problems: readonly IHttpFlowProblem[] = [];
	private readonly resolved = new Map<string, IHttpFlowResolvedRef | string>();
	private readonly resolving = new Set<string>();

	/** Steps tab. */
	private stepTree: WorkbenchObjectTree<IStepNode> | undefined;
	private stepHost: HTMLElement | undefined;
	private toolbarEl: HTMLElement | undefined;
	private readonly toolbarStore = this._register(new DisposableStore());
	private readonly blankStore = this._register(new DisposableStore());
	private pickerEl: HTMLElement | undefined;
	private readonly pickerStore = this._register(new DisposableStore());
	private pickTree: WorkbenchObjectTree<IPickNode> | undefined;
	private pickHost: HTMLElement | undefined;
	private picked = new Set<string>();
	private aiEl: HTMLElement | undefined;
	private readonly aiStore = this._register(new DisposableStore());
	private editorEl: HTMLElement | undefined;
	private readonly editorStore = this._register(new DisposableStore());
	private renaming: string | undefined;

	/** Runs tab. */
	private resultTree: WorkbenchObjectTree<ResultNode> | undefined;
	private resultHost: HTMLElement | undefined;
	private summaryEl: HTMLElement | undefined;
	private detailEl: HTMLElement | undefined;
	private readonly detailStore = this._register(new DisposableStore());
	private historyEl: HTMLElement | undefined;
	private detailKey: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpToolTabState,
		private readonly host: IHttpToolPageHost,
		@IVoltHttpAutomations private readonly automations: IVoltHttpAutomations,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this.uri = state.uri;
		this.element = append(parent, $('.volt-http-page.volt-http-auto'));

		const head = append(this.element, $('.volt-http-auto-head'));
		append(head, $('span.volt-http-auto-head-icon')).appendChild(renderIcon(Codicon.checklist));
		this.nameInput = append(head, $('input.volt-http-auto-name')) as HTMLInputElement;
		this.nameInput.type = 'text';
		this.nameInput.spellcheck = false;
		this.nameInput.setAttribute('aria-label', localize('voltHttp.autoName', "Automation name"));
		this._register(addDisposableListener(this.nameInput, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				this.nameInput.blur();
			} else if (event.key === 'Escape') {
				this.nameInput.value = this.flow?.name ?? '';
				this.nameInput.blur();
			}
		}));
		this._register(addDisposableListener(this.nameInput, EventType.BLUR, () => {
			const name = this.nameInput.value.trim();
			if (name && this.flow && name !== this.flow.name) {
				void this.automations.rename(this.uri, name).then(() => this.host.tabChanged(), err => this.fail(err));
			} else {
				this.nameInput.value = this.flow?.name ?? '';
			}
		}));
		this.progressEl = append(head, $('span.volt-http-auto-progress'));
		this.progressEl.setAttribute('role', 'status');
		const actions = append(head, $('.volt-http-auto-head-actions'));
		this.envSlot = append(actions, $('.volt-http-auto-env'));
		createHttpIconButton(actions, Codicon.ellipsis, localize('voltHttp.autoMore', "More Actions"), button => this.showMore(button));
		this.runButton = this._register(createVoltButton(actions, 'primary'));
		this._register(this.runButton.onDidClick(() => this.toggleRun()));

		this.tabsEl = append(this.element, $('.volt-http-tabs.volt-http-auto-tabs'));
		this.body = append(this.element, $('.volt-http-auto-body'));

		this.progress = this._register(new RunOnceScheduler(() => this.onRunProgress(), 120));
		this.problemCheck = this._register(new RunOnceScheduler(() => void this.checkProblems(), 400));
		this._register(automations.onDidChangeRun(uri => {
			if (uri.toString() !== this.uri.toString()) {
				return;
			}
			// The start and the end show at once; what lies between, a few times a second.
			if (automations.isRunning(this.uri) !== this.wasRunning) {
				this.progress.cancel();
				this.onRunProgress();
			} else {
				this.progress.schedule();
			}
		}));
		this._register(automations.onDidChangeFlow(change => {
			if (change.uri.toString() === this.uri.toString()) {
				this.onFlowChanged(change.origin === this);
			}
		}));
		this._register(collections.onDidChangeEnvironments(() => void this.loadEnvironments()));
		this._register(collections.onDidChange(() => {
			this.resolved.clear();
			this.problemCheck.schedule();
			if (this.tab === 'steps') {
				this.refreshTree();
			}
		}));
		this.wasRunning = automations.isRunning(this.uri);
		this.renderHead();
		void automations.load(this.uri).then(() => {
			if (!this._store.isDisposed) {
				this.renderTab();
				void this.loadEnvironments();
				void this.checkProblems();
			}
		});
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	// --- State -----------------------------------------------------------------------------------

	private get flow(): IHttpFlow | undefined {
		const entry = this.automations.get(this.uri);
		return entry && !entry.error ? entry.flow : undefined;
	}

	private get run(): HttpFlowRun | undefined {
		return this.automations.runOf(this.uri);
	}

	private get running(): boolean {
		return this.automations.isRunning(this.uri);
	}

	private get tab(): AutomationTab {
		const tab = this.state.memory.tab;
		return tab === 'runs' || tab === 'settings' ? tab : 'steps';
	}

	private setTab(tab: AutomationTab): void {
		if (this.state.memory.tab !== tab || !this.body.childElementCount) {
			this.state.memory.tab = tab;
			this.renderTab();
		}
	}

	private get selectedId(): string | undefined {
		return typeof this.state.memory.selected === 'string' ? this.state.memory.selected : undefined;
	}

	private get collapsed(): Set<string> {
		const value = this.state.memory.collapsed;
		if (value instanceof Set) {
			return value as Set<string>;
		}
		const set = new Set<string>();
		this.state.memory.collapsed = set;
		return set;
	}

	private filePath(): string {
		return (this.host.root && relativePath(this.host.root, this.uri)) || this.uri.fsPath;
	}

	private fail(err: unknown): void {
		if (!this._store.isDisposed) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	/** Changes the flow; the page's own edits are told apart from everyone else's. */
	private edit(mutate: (flow: IHttpFlow) => void): void {
		void this.automations.update(this.uri, mutate, this).catch(err => this.fail(err));
	}

	private editStep(id: string, mutate: (step: IHttpFlowStep) => void): void {
		this.edit(flow => {
			const found = findHttpFlowStep(flow, id);
			if (found) {
				mutate(found.step);
			}
		});
	}

	private editRequest(id: string, mutate: (step: IHttpFlowRequestStep) => void): void {
		this.editStep(id, step => {
			if (step.kind === 'request') {
				mutate(step);
			}
		});
	}

	/** The last result of a step in the run shown (its last round or iteration). */
	private lastResultOf(stepId: string): HttpFlowStepRun | undefined {
		const steps = this.run?.steps ?? [];
		for (let index = steps.length - 1; index >= 0; index--) {
			if (steps[index].stepId === stepId) {
				return steps[index];
			}
		}
		return undefined;
	}

	/** The last response a step got, from the run shown. */
	private lastExchangeOf(stepId: string): IHttpExchange | undefined {
		const steps = this.run?.steps ?? [];
		for (let index = steps.length - 1; index >= 0; index--) {
			if (steps[index].stepId === stepId && steps[index].exchange?.response) {
				return steps[index].exchange;
			}
		}
		return undefined;
	}

	private refKey(step: IHttpFlowRequestStep): string | undefined {
		return step.ref ? `${step.ref.collection}\n${step.ref.path.join('\n')}` : undefined;
	}

	/** The saved request a step points at, once looked up (the tree redraws when it is). */
	private resolvedOf(step: IHttpFlowRequestStep): IHttpFlowResolvedRef | string | undefined {
		const key = this.refKey(step);
		if (!key || !step.ref) {
			return undefined;
		}
		if (this.resolved.has(key)) {
			return this.resolved.get(key);
		}
		if (!this.resolving.has(key)) {
			this.resolving.add(key);
			void resolveHttpFlowRef(this.collections, step.ref, this.uri, this.host.root).then(result => {
				this.resolving.delete(key);
				this.resolved.set(key, result);
				if (this._store.isDisposed) {
					return;
				}
				this.stepTree?.rerender();
				// The selected step's source card waits for it, unless someone is typing there.
				const selected = this.flow && this.selectedId ? findHttpFlowStep(this.flow, this.selectedId)?.step : undefined;
				const typing = !!this.editorEl?.contains(this.element.ownerDocument.activeElement);
				if (selected?.kind === 'request' && this.refKey(selected) === key && !typing) {
					this.renderEditor();
				}
			});
		}
		return undefined;
	}

	private collectionRef(uri: URI): string {
		const root = this.host.root;
		return (root && isEqualOrParent(uri, root) ? relativePath(root, uri) : undefined) ?? relativePath(dirname(this.uri), uri) ?? uri.fsPath;
	}

	private async checkProblems(): Promise<void> {
		const problems = await this.automations.problems(this.uri, this.host.root).catch(() => []);
		if (this._store.isDisposed) {
			return;
		}
		this.problems = problems;
		if (this.tab === 'steps') {
			this.renderToolbar();
			this.stepTree?.rerender();
		}
	}

	private async loadEnvironments(): Promise<void> {
		const entries = await this.collections.environments(this.host.root).catch(() => []);
		if (this._store.isDisposed) {
			return;
		}
		this.environments = [...new Set(entries.filter(entry => !entry.globals && !entry.shared).map(entry => entry.environment.name))];
		this.renderEnvironment();
	}

	// --- Changes ---------------------------------------------------------------------------------

	private onFlowChanged(own: boolean): void {
		this.renderHead();
		this.problemCheck.schedule();
		if (own) {
			// The page made it: the fields being typed in stay as they are; the tree shows the new names.
			if (this.tab === 'steps') {
				this.refreshTree();
			}
			return;
		}
		this.renderTab();
	}

	private onRunProgress(): void {
		if (this._store.isDisposed) {
			return;
		}
		const running = this.running;
		const ended = this.wasRunning && !running;
		this.wasRunning = running;
		this.renderHead();
		if (this.tab === 'runs') {
			this.refreshRuns();
		} else if (this.tab === 'steps') {
			this.stepTree?.rerender();
			if (ended) {
				// The pick-from-response helpers and the schema quick-add read the new answers.
				this.renderEditor();
			}
		}
	}

	// --- Head ------------------------------------------------------------------------------------

	private renderHead(): void {
		const flow = this.flow;
		const entry = this.automations.get(this.uri);
		if (this.element.ownerDocument.activeElement !== this.nameInput) {
			this.nameInput.value = entry ? entry.flow.name : basename(this.uri).slice(0, -HTTP_FLOW_FILE_SUFFIX.length);
		}
		this.nameInput.readOnly = !flow;
		const running = this.running;
		this.runButton.label = running ? localize('voltHttp.autoStop', "Stop") : localize('voltHttp.autoRun', "Run");
		this.runButton.enabled = !!flow && (running || flow.steps.length > 0);
		clearNode(this.progressEl);
		setAgentTooltip(this.progressEl, '');
		const run = this.run;
		if (running && run) {
			append(this.progressEl, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
			const done = run.totals.passed + run.totals.failed + run.totals.errors + run.totals.skipped;
			const text = run.iterations > 1
				? localize('voltHttp.autoProgressIterations', "Iteration {0} of {1}, {2} steps done", run.iteration + 1, run.iterations, done)
				: localize('voltHttp.autoProgress', "{0} steps done", done);
			append(this.progressEl, $('span')).textContent = run.totals.failed + run.totals.errors ? `${text}, ${localize('voltHttp.autoProgressFailed', "{0} failed", run.totals.failed + run.totals.errors)}` : text;
		} else if (entry?.error) {
			append(this.progressEl, $('span.error')).textContent = localize('voltHttp.autoUnreadableHead', "This file cannot be read: {0}", entry.error);
		} else if (run) {
			const state = append(this.progressEl, $('span.volt-http-auto-state'));
			state.dataset.state = run.state;
			state.textContent = run.state === 'passed' ? localize('voltHttp.autoStatePassed', "Passed") : run.state === 'failed' ? localize('voltHttp.autoStateFailed', "Failed") : run.state === 'stopped' ? localize('voltHttp.autoStateStopped', "Stopped") : localize('voltHttp.autoStateError', "Error");
			append(this.progressEl, $('span')).textContent = localize('voltHttp.autoLastRun', "{0} of {1} passed, {2}, {3}", run.totals.passed, run.totals.steps, formatHttpDuration(run.durationMs), fromNow(run.startedAt, true));
			setAgentTooltip(this.progressEl, new Date(run.startedAt).toLocaleString());
		}
		const runs = this.run;
		renderHttpTabs(this.tabsEl, [
			{ id: 'steps', label: localize('voltHttp.autoTabSteps', "Steps"), ...(flow ? { count: httpFlowStepsOf(flow.steps).filter(step => !isHttpFlowContainer(step)).length } : {}) },
			{ id: 'runs', label: localize('voltHttp.autoTabRuns', "Runs"), ...(runs && !running && runs.state !== 'error' ? { badge: { text: `${runs.totals.passed}/${runs.totals.steps}`, kind: runs.state === 'passed' ? 'ok' as const : 'error' as const } } : {}), ...(running ? { dot: true } : {}) },
			{ id: 'settings', label: localize('voltHttp.autoTabSettings', "Settings") },
		], this.tab, id => this.setTab(id));
	}

	private renderEnvironment(): void {
		this.envStore.clear();
		clearNode(this.envSlot);
		const flow = this.flow;
		if (!flow) {
			return;
		}
		const names = flow.environment && !this.environments.includes(flow.environment) ? [...this.environments, flow.environment] : this.environments;
		createHttpDropdown<string>(this.envSlot, this.contextViewService, {
			options: [
				{ id: SELECTED_ENVIRONMENT, label: localize('voltHttp.autoEnvSelected', "Selected Environment"), description: localize('voltHttp.autoEnvSelectedDesc', "The one picked in the client when the run starts") },
				...names.map(name => ({ id: name, label: name })),
			],
			value: flow.environment ?? SELECTED_ENVIRONMENT,
			ariaLabel: localize('voltHttp.autoEnvAria', "Environment the run uses"),
			align: 'right',
			width: 260,
			leadingIcon: Codicon.layers,
			onChange: value => this.edit(next => {
				if (value === SELECTED_ENVIRONMENT) {
					delete next.environment;
				} else {
					next.environment = value;
				}
			}),
		}, this.envStore);
	}

	private toggleRun(): void {
		if (this.running) {
			this.automations.stop(this.uri);
			return;
		}
		this.state.memory.tab = 'runs';
		this.state.memory.result = undefined;
		this.startRun({});
		this.renderTab();
	}

	private startRun(options: { readonly fromStepId?: string; readonly onlyStepId?: string }): void {
		void this.automations.run(this.uri, { ...(this.host.root ? { root: this.host.root } : {}), ...options }).catch(err => this.fail(err));
	}

	private showMore(anchor: HTMLElement): void {
		const action = (id: string, label: string, run: () => void, enabled = true) => new Action(id, label, undefined, enabled, async () => run());
		const done = !!this.run && !this.running && this.run.state !== 'error';
		this.menu.value = showHttpActionMenu(this.contextViewService, anchor, this.element, [
			action('auto.generate', localize('voltHttp.autoGenerate', "Generate with AI"), () => this.openAi(), !!this.flow),
			action('auto.chat', localize('voltHttp.autoAddToChat', "Add to Chat"), () => this.addToChat(), !!this.flow),
			action('auto.copy', localize('voltHttp.autoCopyJson', "Copy Flow as JSON"), () => this.flow && void this.clipboardService.writeText(serializeHttpFlow(this.flow)), !!this.flow),
			new Separator(),
			action('auto.junit', localize('voltHttp.autoExportJunit', "Export Report as JUnit XML"), () => void this.export('junit'), done),
			action('auto.html', localize('voltHttp.autoExportHtml', "Export Report as HTML"), () => void this.export('html'), done),
			action('auto.json', localize('voltHttp.autoExportJson', "Export Report as JSON"), () => void this.export('json'), done),
			action('auto.markdown', localize('voltHttp.autoExportMarkdown', "Export Report as Markdown"), () => void this.export('markdown'), done),
			new Separator(),
			action('auto.reveal', localize('voltHttp.autoReveal', "Reveal File"), () => this.host.revealFile(this.uri)),
		], localize('voltHttp.autoMoreAria', "Automation actions"));
	}

	private async export(format: ReportFormat): Promise<void> {
		const run = this.run;
		if (!run) {
			return;
		}
		const extension = format === 'junit' ? 'xml' : format === 'markdown' ? 'md' : format;
		const text = format === 'junit' ? httpFlowJUnit(run) : format === 'html' ? httpFlowHtml(run) : format === 'json' ? httpFlowReportJson(run) : httpFlowMarkdown(run);
		const stem = basename(this.uri).slice(0, -HTTP_FLOW_FILE_SUFFIX.length) || 'automation';
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltHttp.autoExportTitle', "Export Automation Report"),
			defaultUri: joinPath(dirname(this.uri), `${stem}-report${format === 'junit' ? '.junit' : ''}.${extension}`),
			filters: [{ name: format === 'junit' ? 'JUnit XML' : format.toUpperCase(), extensions: [extension] }],
		});
		if (!target) {
			return;
		}
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(text));
			this.notificationService.info(localize('voltHttp.autoExported', "Report saved to {0}.", basename(target)));
		} catch (err) {
			this.notificationService.error(localize('voltHttp.autoExportFailed', "The report could not be saved: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private addToChat(): void {
		const flow = this.flow;
		if (!flow) {
			return;
		}
		const run = this.run;
		this.host.addToChat(localize('voltHttp.autoChatLabel', "Automation: {0}", flow.name), [
			`Volt Client automation (an end-to-end API test flow) "${flow.name}", file ${this.filePath()}.`,
			'',
			describeHttpFlow(flow),
			...(run && !this.running ? ['', 'Last run:', httpFlowRunText(run, { maxValue: 200 })] : []),
			'',
			`You can read, change and run it with the \`ide http\` ops automation_get, automation_save and automation_run (path: ${this.filePath()}).`,
		].join('\n'));
	}

	// --- Tabs ------------------------------------------------------------------------------------

	private clearView(): void {
		this.view.clear();
		this.toolbarStore.clear();
		this.blankStore.clear();
		this.pickerStore.clear();
		this.aiStore.clear();
		this.editorStore.clear();
		this.detailStore.clear();
		this.stepTree = this.pickTree = this.resultTree = undefined;
		this.stepHost = this.toolbarEl = this.pickerEl = this.pickHost = this.aiEl = this.editorEl = undefined;
		this.resultHost = this.summaryEl = this.detailEl = this.historyEl = undefined;
		this.detailKey = undefined;
		clearNode(this.body);
	}

	private renderTab(): void {
		this.clearView();
		this.renderHead();
		this.renderEnvironment();
		this.body.dataset.tab = this.tab;
		const entry = this.automations.get(this.uri);
		if (!entry) {
			// allow-any-unicode-next-line
			append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.autoLoading', "Loading…");
			return;
		}
		if (entry.error) {
			const empty = append(this.body, $('.volt-http-empty.center.volt-http-auto-broken'));
			append(empty, $('span')).textContent = localize('voltHttp.autoBroken', "{0} is not an automation Volt can read: {1}", basename(this.uri), entry.error);
			const reveal = append(empty, $('button.volt-http-link')) as HTMLButtonElement;
			reveal.type = 'button';
			reveal.textContent = localize('voltHttp.autoRevealFile', "Open the File");
			this.view.add(addDisposableListener(reveal, EventType.CLICK, () => this.host.revealFile(this.uri)));
			return;
		}
		switch (this.tab) {
			case 'steps': this.renderSteps(); break;
			case 'runs': this.renderRuns(); break;
			case 'settings': this.renderSettings(); break;
		}
		this.scheduleLayout();
	}

	layout(width: number, _height: number): void {
		this.width = width;
		this.element.classList.toggle('narrow', width < NARROW);
		this.layoutTrees();
	}

	private get narrow(): boolean {
		return this.width > 0 && this.width < NARROW;
	}

	private scheduleLayout(): void {
		this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => this.layoutTrees());
	}

	private layoutTrees(): void {
		if (this.stepTree && this.stepHost) {
			if (this.narrow) {
				const height = Math.max(3 * STEP_ROW, Math.min(this.stepTree.contentHeight, MAX_NARROW_ROWS * STEP_ROW));
				this.stepHost.style.height = `${height}px`;
				this.stepTree.layout(height);
			} else {
				this.stepHost.style.height = '';
				this.stepTree.layout(this.stepHost.clientHeight);
			}
		}
		if (this.pickTree && this.pickHost) {
			const height = Math.min(this.pickTree.contentHeight, MAX_PICK_ROWS * PICK_ROW);
			this.pickHost.style.height = `${height}px`;
			this.pickTree.layout(height);
		}
		if (this.resultTree && this.resultHost) {
			if (this.narrow) {
				const height = Math.max(2 * RESULT_ROW, Math.min(this.resultTree.contentHeight, MAX_NARROW_ROWS * RESULT_ROW));
				this.resultHost.style.height = `${height}px`;
				this.resultTree.layout(height);
			} else {
				this.resultHost.style.height = '';
				this.resultTree.layout(this.resultHost.clientHeight);
			}
		}
	}

	// --- Steps -----------------------------------------------------------------------------------

	private renderSteps(): void {
		const page = append(this.body, $('.volt-http-auto-steps'));
		this.aiEl = append(page, $('.volt-http-auto-ai'));
		const split = append(page, $('.volt-http-auto-split'));
		const column = append(split, $('.volt-http-auto-tree-column'));
		this.toolbarEl = append(column, $('.volt-http-auto-toolbar'));
		this.pickerEl = append(column, $('.volt-http-auto-picker'));
		this.stepHost = append(column, $('.volt-http-auto-tree'));
		this.editorEl = append(split, $('.volt-http-auto-editor'));
		this.renderToolbar();
		this.renderAi();
		this.buildStepTree();
		if (this.state.memory.picking === true) {
			void this.openPicker();
		}
	}

	private renderToolbar(): void {
		const parent = this.toolbarEl;
		if (!parent) {
			return;
		}
		this.toolbarStore.clear();
		clearNode(parent);
		const add = this.toolbarStore.add(createVoltButton(parent, 'secondary'));
		add.label = localize('voltHttp.autoAddStep', "Add Step");
		add.element.classList.add('volt-http-auto-add');
		this.toolbarStore.add(add.onDidClick(() => this.showAddMenu(add.element)));
		append(parent, $('.volt-http-spacer'));
		const problems = this.problems;
		if (problems.length) {
			const errors = problems.filter(problem => problem.severity === 'error').length;
			const toggle = append(parent, $('button.volt-http-link.volt-http-auto-problem-link')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.classList.toggle('error', errors > 0);
			toggle.appendChild(renderIcon(errors ? Codicon.error : Codicon.warning));
			append(toggle, $('span')).textContent = problems.length === 1 ? localize('voltHttp.autoOneProblem', "1 problem") : localize('voltHttp.autoProblems', "{0} problems", problems.length);
			toggle.setAttribute('aria-expanded', String(this.state.memory.problemsOpen === true));
			this.toolbarStore.add(addDisposableListener(toggle, EventType.CLICK, () => {
				this.state.memory.problemsOpen = this.state.memory.problemsOpen !== true;
				this.renderToolbar();
			}));
		}
		const generate = this.toolbarStore.add(createVoltButton(parent, 'ghost'));
		generate.label = localize('voltHttp.autoGenerateShort', "Generate with AI");
		this.toolbarStore.add(generate.onDidClick(() => this.openAi()));
		if (problems.length && this.state.memory.problemsOpen === true) {
			const list = append(parent, $('.volt-http-auto-problem-list'));
			for (const problem of problems.slice(0, 12)) {
				const line = append(list, $('.volt-http-auto-problem'));
				line.classList.toggle('error', problem.severity === 'error');
				append(line, $('span.volt-http-auto-problem-path')).textContent = problem.path || localize('voltHttp.autoProblemFile', "file");
				append(line, $('span')).textContent = problem.message;
				if (problem.stepId) {
					const stepId = problem.stepId;
					line.classList.add('link');
					this.toolbarStore.add(addDisposableListener(line, EventType.CLICK, () => this.select(stepId)));
				}
			}
			if (problems.length > 12) {
				append(list, $('.volt-http-note')).textContent = localize('voltHttp.autoMoreProblems', "{0} more", problems.length - 12);
			}
		}
	}

	/** Where a new step goes: into the selected container, else after the selected step, else at the end. */
	private insertionPoint(flow: IHttpFlow): { readonly parentId: string | undefined; readonly index: number | undefined } {
		const id = this.selectedId;
		const found = id ? findHttpFlowStep(flow, id) : undefined;
		if (!found) {
			return { parentId: undefined, index: undefined };
		}
		if (isHttpFlowContainer(found.step)) {
			return { parentId: found.step.id, index: undefined };
		}
		return { parentId: found.ancestors.at(-1)?.id, index: found.index + 1 };
	}

	private insertSteps(steps: IHttpFlowStep[]): void {
		if (!steps.length) {
			return;
		}
		this.edit(flow => {
			const taken = new Set(httpFlowStepsOf(flow.steps).map(step => step.id));
			for (const step of httpFlowStepsOf(steps)) {
				if (taken.has(step.id)) {
					step.id = newHttpFlowStepId(taken);
				}
				taken.add(step.id);
			}
			const { parentId, index } = this.insertionPoint(flow);
			const parent = parentId ? findHttpFlowStep(flow, parentId)?.step : undefined;
			const list = parent && isHttpFlowContainer(parent) ? parent.steps : flow.steps;
			list.splice(index ?? list.length, 0, ...steps);
			if (parentId) {
				this.collapsed.delete(parentId);
			}
		});
		this.state.memory.selected = steps[steps.length - 1].id;
		this.refreshTree();
		this.renderEditor();
	}

	private showAddMenu(anchor: HTMLElement): void {
		type Pick = HttpFlowStepKind | 'saved';
		const item = (id: Pick, label: string, description: string, icon: ThemeIcon) => ({ id, label, description, icon, data: id });
		this.menu.value = showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			className: 'volt-http-menu',
			align: 'left',
			width: 300,
			ariaLabel: localize('voltHttp.autoAddAria', "Add a step"),
			sections: [
				{
					id: 'requests', items: [
						item('saved', localize('voltHttp.autoAddSaved', "Request from a Collection"), localize('voltHttp.autoAddSavedDesc', "Send saved requests, with their auth and scripts"), Codicon.library),
						item('request', localize('voltHttp.autoAddInline', "New Inline Request"), localize('voltHttp.autoAddInlineDesc', "A request written in the flow itself"), Codicon.arrowSwap),
					],
				},
				{
					id: 'flow', items: [
						item('delay', KIND_LABELS.delay, localize('voltHttp.autoAddDelayDesc', "Wait before the next step"), Codicon.watch),
						item('set', KIND_LABELS.set, localize('voltHttp.autoAddSetDesc', "Give variables values for the steps after"), Codicon.symbolVariable),
						item('group', KIND_LABELS.group, localize('voltHttp.autoAddGroupDesc', "Steps together: setup, steps or teardown"), Codicon.folder),
						item('condition', KIND_LABELS.condition, localize('voltHttp.autoAddConditionDesc', "Run the steps inside only when a check holds"), Codicon.filter),
						item('repeat', KIND_LABELS.repeat, localize('voltHttp.autoAddRepeatDesc', "Repeat N times, for each item of a list, or until"), Codicon.sync),
					],
				},
			],
			onPick: picked => {
				if (picked.data === 'saved') {
					void this.openPicker();
				} else {
					const flow = this.flow;
					this.insertSteps([newHttpFlowStep(picked.data, flow ? new Set(httpFlowStepsOf(flow.steps).map(step => step.id)) : undefined)]);
				}
			},
		});
	}

	// --- The step tree ---------------------------------------------------------------------------

	private stepDetail(step: IHttpFlowStep): string {
		switch (step.kind) {
			case 'request': {
				const parts: string[] = [];
				if (step.assert.length) {
					parts.push(step.assert.length === 1 ? localize('voltHttp.autoOneAssert', "1 assert") : localize('voltHttp.autoAsserts', "{0} asserts", step.assert.length));
				}
				if (step.extract.length) {
					parts.push(step.extract.length === 1 ? localize('voltHttp.autoOneExtract', "1 extract") : localize('voltHttp.autoExtracts', "{0} extracts", step.extract.length));
				}
				if (step.retry?.until) {
					parts.push(localize('voltHttp.autoPolls', "polls"));
				} else if (step.retry?.times) {
					parts.push(localize('voltHttp.autoRetries', "{0} retries", step.retry.times));
				}
				return parts.join(', ');
			}
			case 'set': return step.variables.length === 1 ? localize('voltHttp.autoOneVariable', "1 variable") : localize('voltHttp.autoVariables', "{0} variables", step.variables.length);
			case 'delay': return '';
			default: return step.steps.length === 1 ? localize('voltHttp.autoOneInside', "1 step") : localize('voltHttp.autoInside', "{0} steps", step.steps.length);
		}
	}

	private buildStepTree(): void {
		const host = this.stepHost!;
		const delegate: IListVirtualDelegate<IStepNode> = { getHeight: () => STEP_ROW, getTemplateId: () => 'step' };
		const renderer: ITreeRenderer<IStepNode, void, IStepTemplate> = {
			templateId: 'step',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-auto-step-row'));
				return {
					row,
					status: append(row, $('span.volt-http-auto-status')),
					icon: append(row, $('span.volt-http-row-icon')),
					method: append(row, $('span.volt-http-row-method')),
					label: append(row, $('span.volt-http-row-label')),
					detail: append(row, $('span.volt-http-row-detail')),
					time: append(row, $('span.volt-http-auto-time')),
					store: new DisposableStore(),
				};
			},
			renderElement: (node: ITreeNode<IStepNode, void>, _index, template) => this.renderStepRow(node.element.step, template),
			disposeElement: (_node, _index, template) => template.store.clear(),
			disposeTemplate: template => template.store.dispose(),
		};
		const tree = this.stepTree = this.view.add(this.instantiationService.createInstance(WorkbenchObjectTree<IStepNode>, 'VoltHttpAutomationSteps', host, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => {
					const result = this.lastResultOf(node.step.id);
					return `${KIND_LABELS[node.step.kind]}: ${httpFlowStepLabel(node.step)}${node.step.disabled ? `, ${localize('voltHttp.autoDisabled', "disabled")}` : ''}${result ? `, ${STATUS_LABELS[result.status]}` : ''}`;
				},
				getWidgetAriaLabel: () => localize('voltHttp.autoStepsAria', "Steps"),
			},
			identityProvider: { getId: node => node.step.id },
			dnd: this.dragAndDrop(),
			multipleSelectionSupport: false,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => httpFlowStepLabel(node.step) },
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(tree.onDidChangeSelection(event => {
			const [node] = event.elements;
			if (node && node.step.id !== this.selectedId) {
				this.state.memory.selected = node.step.id;
				this.renderEditor();
			}
		}));
		this.view.add(tree.onDidChangeCollapseState(event => {
			const node = event.node.element;
			if (node) {
				if (event.node.collapsed) {
					this.collapsed.add(node.step.id);
				} else {
					this.collapsed.delete(node.step.id);
				}
			}
		}));
		this.view.add(tree.onContextMenu(event => {
			if (event.element) {
				event.browserEvent.preventDefault();
				this.menu.value = showHttpActionMenu(this.contextViewService, isHTMLElement(event.anchor) ? event.anchor : { x: event.anchor.posx, y: event.anchor.posy }, this.element, this.stepActions(event.element.step), localize('voltHttp.autoStepMenu', "Step actions"));
			}
		}));
		this.view.add(tree.onKeyDown(event => {
			const [node] = tree.getFocus();
			if (!node || this.renaming) {
				return;
			}
			if (event.key === 'F2') {
				event.preventDefault();
				this.startRename(node.step.id);
			} else if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) {
				event.preventDefault();
				void this.removeStep(node.step.id);
			}
		}));
		this.view.add(tree.onDidChangeContentHeight(() => {
			if (this.narrow) {
				this.layoutTrees();
			}
		}));
		this.refreshTree();
		this.renderEditor();
	}

	private renderStepRow(step: IHttpFlowStep, template: IStepTemplate): void {
		template.store.clear();
		clearNode(template.status);
		clearNode(template.icon);
		clearNode(template.label);
		template.row.classList.toggle('disabled', !!step.disabled);
		template.row.classList.toggle('container', isHttpFlowContainer(step));
		const problems = this.problems.filter(problem => problem.stepId === step.id);
		template.row.classList.toggle('problem', problems.length > 0);
		setAgentTooltip(template.row, problems.map(problem => problem.message).join('\n'));
		const result = this.lastResultOf(step.id);
		if (result) {
			appendStatus(template.status, result.status);
		} else {
			template.status.removeAttribute('data-status');
			setAgentTooltip(template.status, '');
		}
		let method: string | undefined;
		let badgeKey: string | undefined;
		if (step.kind === 'request') {
			if (step.inline && !step.ref) {
				method = step.inline.method.toUpperCase();
				badgeKey = method;
			} else {
				const resolved = this.resolvedOf(step);
				if (resolved && typeof resolved !== 'string') {
					method = httpRequestBadge(resolved.request);
					badgeKey = httpRequestBadgeKey(resolved.request);
				} else if (typeof resolved === 'string') {
					template.row.classList.add('problem');
					setAgentTooltip(template.row, resolved);
				}
			}
		}
		template.method.textContent = method ?? '';
		if (badgeKey) {
			template.method.dataset.method = badgeKey;
		} else {
			template.method.removeAttribute('data-method');
		}
		if (!method) {
			template.icon.appendChild(renderIcon(step.kind === 'request' && typeof this.resolvedOf(step) === 'string' ? Codicon.warning : kindIcon(step)));
		}
		template.icon.classList.toggle('none', !!method);
		template.row.classList.toggle('group', step.kind === 'group');
		if (this.renaming === step.id) {
			const input = append(template.label, $('input.volt-http-rename')) as HTMLInputElement;
			input.value = step.name ?? httpFlowStepLabel(step);
			input.spellcheck = false;
			input.setAttribute('aria-label', localize('voltHttp.autoRenameAria', "Step name"));
			let done = false;
			const finish = (save: boolean) => {
				if (done) {
					return;
				}
				done = true;
				const value = input.value.trim();
				this.renaming = undefined;
				if (save && value !== (step.name ?? httpFlowStepLabel(step))) {
					this.editStep(step.id, next => {
						if (value) {
							next.name = value;
						} else {
							delete next.name;
						}
					});
					this.renderEditor();
				}
				this.stepTree?.rerender();
				this.stepTree?.domFocus();
			};
			template.store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				event.stopPropagation();
				if (event.key === 'Enter') {
					event.preventDefault();
					finish(true);
				} else if (event.key === 'Escape') {
					event.preventDefault();
					finish(false);
				}
			}));
			template.store.add(addDisposableListener(input, EventType.BLUR, () => finish(true)));
			template.store.add(addDisposableListener(input, EventType.MOUSE_DOWN, (event: MouseEvent) => event.stopPropagation()));
			template.store.add(scheduleAtNextAnimationFrame(getWindow(input), () => {
				input.focus();
				input.select();
			}));
		} else {
			template.label.textContent = httpFlowStepLabel(step);
		}
		template.detail.textContent = step.disabled ? localize('voltHttp.autoDisabledDetail', "disabled") : this.stepDetail(step);
		template.time.textContent = result && result.status !== 'skipped' && result.status !== 'queued' && result.durationMs ? formatHttpDuration(result.durationMs) : '';
	}

	private refreshTree(): void {
		const tree = this.stepTree;
		const flow = this.flow;
		if (!tree || !flow) {
			return;
		}
		const collapsed = this.collapsed;
		const toElement = (step: IHttpFlowStep, parentId: string | undefined): IObjectTreeElement<IStepNode> => ({
			element: { step, parentId },
			...(isHttpFlowContainer(step) ? { children: step.steps.map(child => toElement(child, step.id)), collapsible: true, collapsed: collapsed.has(step.id) } : {}),
		});
		tree.setChildren(null, flow.steps.map(step => toElement(step, undefined)));
		this.stepHost?.classList.toggle('empty', !flow.steps.length);
		this.renderBlank(flow);
		if (!this.selectedId || !findHttpFlowStep(flow, this.selectedId)) {
			// Something is always selected while there are steps: the editor is never blank for no reason.
			this.state.memory.selected = flow.steps[0]?.id;
		}
		const selected = this.selectedId;
		const node = selected ? this.findNode(selected) : undefined;
		if (node && tree.getSelection()[0]?.step.id !== selected) {
			tree.setSelection([node]);
			tree.setFocus([node]);
		}
		this.layoutTrees();
	}

	private findNode(id: string): IStepNode | undefined {
		const tree = this.stepTree;
		if (!tree) {
			return undefined;
		}
		const visit = (node: ITreeNode<IStepNode | null, void>): IStepNode | undefined => {
			for (const child of node.children) {
				if (child.element?.step.id === id) {
					return child.element;
				}
				const found = visit(child);
				if (found) {
					return found;
				}
			}
			return undefined;
		};
		return visit(tree.getNode(null));
	}

	private select(id: string): void {
		const flow = this.flow;
		const found = flow ? findHttpFlowStep(flow, id) : undefined;
		if (!found) {
			return;
		}
		for (const ancestor of found.ancestors) {
			this.collapsed.delete(ancestor.id);
		}
		this.state.memory.selected = id;
		this.refreshTree();
		const node = this.findNode(id);
		if (node && this.stepTree) {
			this.stepTree.reveal(node);
		}
		this.renderEditor();
	}

	/** The empty flow's invitation, laid over the empty tree. */
	private renderBlank(flow: IHttpFlow): void {
		const host = this.stepHost;
		if (!host) {
			return;
		}
		this.blankStore.clear();
		host.querySelector('.volt-http-auto-blank')?.remove();
		if (flow.steps.length || this.state.memory.picking === true) {
			return;
		}
		const blank = append(host, $('.volt-http-auto-blank'));
		append(blank, $('.volt-http-auto-blank-title')).textContent = localize('voltHttp.autoBlankTitle', "No steps yet");
		append(blank, $('.volt-http-note')).textContent = localize('voltHttp.autoBlankText', "Chain requests into an end-to-end test: each step can take values from the answers before it and check its own answer.");
		const actions = append(blank, $('.volt-http-auto-blank-actions'));
		const add = this.blankStore.add(createVoltButton(actions, 'primary'));
		add.label = localize('voltHttp.autoBlankAdd', "Add Request");
		this.blankStore.add(add.onDidClick(() => void this.openPicker()));
		const ai = this.blankStore.add(createVoltButton(actions, 'secondary'));
		ai.label = localize('voltHttp.autoGenerateShort', "Generate with AI");
		this.blankStore.add(ai.onDidClick(() => this.openAi()));
	}

	private dragAndDrop(): ITreeDragAndDrop<IStepNode> {
		const dragged = (data: IDragAndDropData): IStepNode | undefined => data instanceof ElementsDragAndDropData ? (data.elements as IStepNode[])[0] : undefined;
		const target = (source: IStepNode, over: IStepNode | undefined, sector: ListViewTargetSector | undefined): { parentId: string | undefined; index: number | undefined; position: ListDragOverEffectPosition } | undefined => {
			const flow = this.flow;
			if (!flow) {
				return undefined;
			}
			if (!over) {
				// Below the last row: to the end of the flow.
				return { parentId: undefined, index: undefined, position: ListDragOverEffectPosition.Over };
			}
			if (over.step.id === source.step.id) {
				return undefined;
			}
			const found = findHttpFlowStep(flow, over.step.id);
			if (!found || found.ancestors.some(step => step.id === source.step.id)) {
				return undefined;
			}
			const top = sector === ListViewTargetSector.TOP || sector === ListViewTargetSector.CENTER_TOP;
			if (isHttpFlowContainer(over.step) && sector !== ListViewTargetSector.TOP && sector !== ListViewTargetSector.BOTTOM) {
				return { parentId: over.step.id, index: undefined, position: ListDragOverEffectPosition.Over };
			}
			return { parentId: found.ancestors.at(-1)?.id, index: found.index + (top ? 0 : 1), position: top ? ListDragOverEffectPosition.Before : ListDragOverEffectPosition.After };
		};
		return {
			getDragURI: node => this.renaming ? null : `volt-http-flow-step:${node.step.id}`,
			getDragLabel: nodes => nodes[0] ? httpFlowStepLabel(nodes[0].step) : undefined,
			onDragStart: () => { },
			onDragOver: (data, over, _index, sector): boolean | ITreeDragOverReaction => {
				const source = dragged(data);
				const to = source && target(source, over, sector);
				return to ? { accept: true, effect: { type: ListDragOverEffectType.Move, position: to.position }, autoExpand: true } : false;
			},
			drop: (data, over, _index, sector) => {
				const source = dragged(data);
				const to = source && target(source, over, sector);
				if (!source || !to) {
					return;
				}
				if (to.parentId) {
					this.collapsed.delete(to.parentId);
				}
				this.edit(flow => moveHttpFlowStep(flow, source.step.id, to.parentId, to.index));
				this.state.memory.selected = source.step.id;
			},
			dispose: () => { },
		};
	}

	private stepActions(step: IHttpFlowStep): IAction[] {
		const action = (id: string, label: string, run: () => void, enabled = true) => new Action(id, label, undefined, enabled, async () => run());
		const running = this.running;
		return [
			action('step.runFrom', localize('voltHttp.autoRunFrom', "Run From Here"), () => this.startRun({ fromStepId: step.id }), !running),
			action('step.runOnly', localize('voltHttp.autoRunOnly', "Run Only This"), () => this.startRun({ onlyStepId: step.id }), !running),
			new Separator(),
			action('step.rename', localize('voltHttp.autoRename', "Rename"), () => this.startRename(step.id)),
			action('step.duplicate', localize('voltHttp.autoDuplicate', "Duplicate"), () => this.duplicateStep(step.id)),
			action('step.toggle', step.disabled ? localize('voltHttp.autoEnable', "Enable") : localize('voltHttp.autoDisable', "Disable"), () => this.editStep(step.id, next => {
				if (next.disabled) {
					delete next.disabled;
				} else {
					next.disabled = true;
				}
			})),
			new Separator(),
			action('step.delete', localize('voltHttp.autoDelete', "Delete"), () => void this.removeStep(step.id)),
		];
	}

	private startRename(id: string): void {
		const node = this.findNode(id);
		if (!node || !this.stepTree) {
			return;
		}
		this.renaming = id;
		this.stepTree.reveal(node);
		this.stepTree.rerender(node);
	}

	private duplicateStep(id: string): void {
		// The change is made at once (the write follows): the copy is there to select.
		const made: { copy?: IHttpFlowStep } = {};
		this.edit(flow => made.copy = duplicateHttpFlowStep(flow, id));
		if (made.copy) {
			this.select(made.copy.id);
		}
	}

	private async removeStep(id: string): Promise<void> {
		const flow = this.flow;
		const found = flow ? findHttpFlowStep(flow, id) : undefined;
		if (!found) {
			return;
		}
		if (isHttpFlowContainer(found.step) && found.step.steps.length) {
			const inside = httpFlowStepsOf(found.step.steps).length;
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('voltHttp.autoDeleteContainer', "Delete \"{0}\" and the {1} steps inside it?", httpFlowStepLabel(found.step), inside),
				primaryButton: localize('voltHttp.autoDeleteConfirm', "Delete"),
			});
			if (!confirmed || this._store.isDisposed) {
				return;
			}
		}
		const next = found.siblings[found.index + 1] ?? found.siblings[found.index - 1] ?? found.ancestors.at(-1);
		this.state.memory.selected = next?.id;
		this.edit(target => removeHttpFlowStep(target, id));
		this.renderEditor();
	}

	// --- Adding saved requests -------------------------------------------------------------------

	private closePicker(): void {
		this.state.memory.picking = false;
		this.pickerStore.clear();
		this.pickTree = undefined;
		this.pickHost = undefined;
		if (this.pickerEl) {
			clearNode(this.pickerEl);
			this.pickerEl.classList.remove('open');
		}
		const flow = this.flow;
		if (flow) {
			this.renderBlank(flow);
		}
		this.layoutTrees();
	}

	private async openPicker(): Promise<void> {
		const parent = this.pickerEl;
		if (!parent) {
			return;
		}
		this.state.memory.picking = true;
		this.pickerStore.clear();
		clearNode(parent);
		this.stepHost?.querySelector('.volt-http-auto-blank')?.remove();
		parent.classList.add('open');
		const head = append(parent, $('.volt-http-auto-picker-head'));
		append(head, $('span.volt-http-auto-picker-title')).textContent = localize('voltHttp.autoPickTitle', "Add saved requests");
		append(head, $('.volt-http-spacer'));
		createHttpIconButton(head, Codicon.close, localize('voltHttp.autoPickClose', "Close"), () => this.closePicker());
		const host = this.pickHost = append(parent, $('.volt-http-auto-pick-tree'));
		const footer = append(parent, $('.volt-http-auto-picker-foot'));
		const count = append(footer, $('span.volt-http-note'));
		append(footer, $('.volt-http-spacer'));
		const cancel = this.pickerStore.add(createVoltButton(footer, 'ghost'));
		cancel.label = localize('voltHttp.autoPickCancel', "Cancel");
		this.pickerStore.add(cancel.onDidClick(() => this.closePicker()));
		const add = this.pickerStore.add(createVoltButton(footer, 'primary'));
		const paint = () => {
			const picked = this.picked.size;
			add.label = picked === 1 ? localize('voltHttp.autoPickAddOne', "Add 1 Request") : localize('voltHttp.autoPickAdd', "Add {0} Requests", picked);
			add.enabled = picked > 0;
			count.textContent = picked ? localize('voltHttp.autoPickHint', "Added in the order shown, after the selected step.") : localize('voltHttp.autoPickNone', "Pick requests, or a folder to add all of it.");
		};
		this.picked = new Set();
		paint();

		const entries = await this.collections.collections(this.host.root).catch(() => []);
		if (this._store.isDisposed || this.pickHost !== host) {
			return;
		}
		const nodes: IPickNode[] = [];
		const requests = new Map<string, { readonly uri: URI; readonly collection: IHttpCollection; readonly id: string }>();
		for (const entry of entries) {
			if (entry.error) {
				continue;
			}
			const walk = (items: readonly IHttpItem[]): IPickNode[] => items.map(item => {
				const id = `${entry.uri.toString()}#${item.id}`;
				if (item.kind === 'request') {
					requests.set(id, { uri: entry.uri, collection: entry.collection, id: item.id });
					return { kind: 'request', id, label: httpRequestLabel(item), collection: entry.uri, requestId: item.id, method: httpRequestBadge(item), badgeKey: httpRequestBadgeKey(item), keys: [id], children: [] };
				}
				const children = walk(item.items);
				return { kind: 'folder', id, label: item.name, collection: entry.uri, keys: children.flatMap(child => child.keys), children };
			});
			const children = walk(entry.collection.items);
			if (children.length) {
				nodes.push({ kind: 'collection', id: entry.uri.toString(), label: entry.collection.format === 'postman' ? entry.collection.name : this.collectionRef(entry.uri), collection: entry.uri, keys: children.flatMap(child => child.keys), children });
			}
		}
		if (!nodes.length) {
			append(host, $('.volt-http-empty.volt-http-auto-pick-empty')).textContent = localize('voltHttp.autoPickEmpty', "No saved requests in this project yet. Save a request to a collection, or add a New Inline Request.");
			return;
		}
		const delegate: IListVirtualDelegate<IPickNode> = { getHeight: () => PICK_ROW, getTemplateId: () => 'pick' };
		const renderer: ITreeRenderer<IPickNode, void, IPickTemplate> = {
			templateId: 'pick',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-auto-pick-row'));
				return { check: append(row, $('span.volt-http-check')), icon: append(row, $('span.volt-http-row-icon')), method: append(row, $('span.volt-http-row-method')), label: append(row, $('span.volt-http-row-label')), detail: append(row, $('span.volt-http-row-detail')) };
			},
			renderElement: (node: ITreeNode<IPickNode, void>, _index, template) => {
				const element = node.element;
				const picked = element.keys.filter(key => this.picked.has(key)).length;
				const all = picked > 0 && picked === element.keys.length;
				template.check.classList.toggle('checked', picked > 0);
				template.check.replaceChildren(renderIcon(all || !picked ? Codicon.check : Codicon.dash));
				template.icon.replaceChildren();
				if (element.kind !== 'request') {
					template.icon.appendChild(renderIcon(element.kind === 'collection' ? Codicon.library : Codicon.folder));
				}
				template.method.textContent = element.method ?? '';
				if (element.badgeKey) {
					template.method.dataset.method = element.badgeKey;
				} else {
					template.method.removeAttribute('data-method');
				}
				template.label.textContent = element.label;
				template.detail.textContent = element.kind === 'request' ? '' : localize('voltHttp.autoPickedOf', "{0} of {1}", picked, element.keys.length);
			},
			disposeTemplate: () => { },
		};
		const tree = this.pickTree = this.pickerStore.add(this.instantiationService.createInstance(WorkbenchObjectTree<IPickNode>, 'VoltHttpAutomationPicker', host, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => `${node.method ? `${node.method} ` : ''}${node.label}`,
				getWidgetAriaLabel: () => localize('voltHttp.autoPickAria', "Saved requests to add"),
				getRole: () => 'checkbox',
				isChecked: node => node.keys.length > 0 && node.keys.every(key => this.picked.has(key)),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: node => node.id },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.label },
			alwaysConsumeMouseWheel: false,
		}));
		const toggle = (node: IPickNode) => {
			const all = node.keys.every(key => this.picked.has(key));
			for (const key of node.keys) {
				if (all) {
					this.picked.delete(key);
				} else {
					this.picked.add(key);
				}
			}
			tree.rerender();
			paint();
		};
		this.pickerStore.add(tree.onMouseClick(event => {
			const element = event.element;
			const target = event.browserEvent.target;
			if (element && (element.kind === 'request' || (target instanceof Element && !!target.closest('.volt-http-check')))) {
				toggle(element);
			}
		}));
		this.pickerStore.add(tree.onKeyDown(event => {
			if (event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				const [focused] = tree.getFocus();
				if (focused) {
					toggle(focused);
				}
			}
		}));
		this.pickerStore.add(tree.onDidChangeContentHeight(() => this.layoutTrees()));
		this.pickerStore.add(add.onDidClick(() => {
			const flow = this.flow;
			if (!flow) {
				return;
			}
			const taken = new Set(httpFlowStepsOf(flow.steps).map(step => step.id));
			const steps: IHttpFlowStep[] = [];
			const walk = (items: readonly IPickNode[]) => {
				for (const item of items) {
					if (item.kind === 'request') {
						const found = this.picked.has(item.id) ? requests.get(item.id) : undefined;
						const ref = found && httpFlowRefFor(this.uri, this.host.root, found.uri, found.collection, found.id);
						if (ref) {
							const step = newHttpFlowRefStep(ref, taken);
							taken.add(step.id);
							steps.push(step);
						}
					} else {
						walk(item.children);
					}
				}
			};
			walk(nodes);
			this.closePicker();
			this.insertSteps(steps);
		}));
		const toElement = (node: IPickNode): IObjectTreeElement<IPickNode> => ({ element: node, children: node.children.map(toElement), collapsible: node.kind !== 'request', collapsed: node.kind === 'folder' });
		tree.setChildren(null, nodes.map(toElement));
		this.layoutTrees();
	}

	// --- The step editor -------------------------------------------------------------------------

	private field(parent: HTMLElement, label: string, hint?: string): HTMLElement {
		const row = append(parent, $('.volt-http-auto-field'));
		append(row, $('label.volt-http-auto-field-label')).textContent = label;
		const body = append(row, $('.volt-http-auto-field-body'));
		if (hint) {
			append(row, $('.volt-http-auto-field-hint')).textContent = hint;
		}
		return body;
	}

	private textInput(parent: HTMLElement, value: string, ariaLabel: string, onChange: (value: string) => void, options: { readonly placeholder?: string; readonly code?: boolean; readonly live?: boolean } = {}): HTMLInputElement {
		const input = append(parent, $('input.volt-http-input.volt-http-auto-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.value = value;
		input.setAttribute('aria-label', ariaLabel);
		input.classList.toggle('code', !!options.code);
		if (options.placeholder) {
			input.placeholder = options.placeholder;
		}
		this.editorStore.add(addDisposableListener(input, options.live === false ? EventType.CHANGE : EventType.INPUT, () => onChange(input.value)));
		return input;
	}

	private numberInput(parent: HTMLElement, value: number | undefined, ariaLabel: string, onChange: (value: number) => void, options: { readonly min?: number; readonly max?: number; readonly placeholder?: string; readonly store?: DisposableStore } = {}): HTMLInputElement {
		const input = append(parent, $('input.volt-http-input.short.volt-http-auto-number')) as HTMLInputElement;
		input.type = 'number';
		input.min = String(options.min ?? 0);
		if (options.max !== undefined) {
			input.max = String(options.max);
		}
		input.value = value === undefined ? '' : String(value);
		input.setAttribute('aria-label', ariaLabel);
		if (options.placeholder) {
			input.placeholder = options.placeholder;
		}
		(options.store ?? this.editorStore).add(addDisposableListener(input, EventType.INPUT, () => {
			const parsed = Number(input.value);
			if (input.value.trim() === '' || Number.isFinite(parsed)) {
				const clamped = Math.max(options.min ?? 0, Math.min(options.max ?? Number.MAX_SAFE_INTEGER, Math.round(Number.isFinite(parsed) ? parsed : 0)));
				onChange(clamped);
			}
		}));
		return input;
	}

	private check(parent: HTMLElement, checked: boolean, label: string, onChange: (checked: boolean) => void, store = this.editorStore): void {
		const wrap = append(parent, $('.volt-http-auto-check'));
		const box = createHttpCheck(wrap, checked, label, onChange);
		const text = append(wrap, $('span.volt-http-auto-check-label'));
		text.textContent = label;
		store.add(addDisposableListener(text, EventType.CLICK, () => box.element.click()));
	}

	private renderEditor(): void {
		const parent = this.editorEl;
		if (!parent) {
			return;
		}
		this.editorStore.clear();
		clearNode(parent);
		const flow = this.flow;
		const found = flow && this.selectedId ? findHttpFlowStep(flow, this.selectedId) : undefined;
		parent.classList.toggle('none', !found);
		if (!found) {
			if (flow?.steps.length) {
				append(parent, $('.volt-http-empty.center')).textContent = localize('voltHttp.autoSelectStep', "Select a step to edit it.");
			}
			return;
		}
		const step = found.step;
		const head = append(parent, $('.volt-http-auto-editor-head'));
		append(head, $('span.volt-http-auto-editor-kind')).textContent = KIND_LABELS[step.kind];
		// The name a step goes by without one of its own, as the field's placeholder.
		const unnamed = structuredClone(step);
		delete unnamed.name;
		const name = this.textInput(head, step.name ?? '', localize('voltHttp.autoStepName', "Step name"), value => {
			this.editStep(step.id, next => {
				if (value.trim()) {
					next.name = value;
				} else {
					delete next.name;
				}
			});
		}, { placeholder: httpFlowStepLabel(unnamed) });
		name.classList.add('volt-http-auto-step-name');
		this.check(head, !step.disabled, localize('voltHttp.autoEnabled', "Enabled"), checked => this.editStep(step.id, next => {
			if (checked) {
				delete next.disabled;
			} else {
				next.disabled = true;
			}
		}));
		const problems = this.problems.filter(problem => problem.stepId === step.id);
		for (const problem of problems) {
			const line = append(parent, $('.volt-http-auto-inline-problem'));
			line.classList.toggle('error', problem.severity === 'error');
			line.textContent = problem.message;
		}
		const result = this.lastResultOf(step.id);
		if (result?.error && result.status !== 'passed') {
			const line = append(parent, $('.volt-http-auto-inline-problem'));
			line.classList.toggle('error', result.status === 'failed' || result.status === 'error');
			line.textContent = localize('voltHttp.autoLastRunSaid', "Last run: {0}", result.error);
		}
		const content = append(parent, $('.volt-http-auto-editor-body'));
		switch (step.kind) {
			case 'request': this.renderRequestEditor(content, step); break;
			case 'delay': {
				const form = append(content, $('.volt-http-auto-form'));
				this.numberInput(this.field(form, localize('voltHttp.autoDelayMs', "Wait (ms)")), step.ms, localize('voltHttp.autoDelayMs', "Wait (ms)"), value => this.editStep(step.id, next => {
					if (next.kind === 'delay') {
						next.ms = value;
					}
				}), { max: 600_000 });
				break;
			}
			case 'set': {
				append(content, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoSetHint', "Each value may use {{variables}}; the steps after see the new values.");
				this.editorStore.add(new HttpKeyValueTable(content, {
					rows: step.variables,
					variables: this.host.variables,
					keyLabel: localize('voltHttp.autoVariable', "Variable"),
					valueLabel: localize('voltHttp.autoValue', "Value"),
					onChange: rows => this.editStep(step.id, next => {
						if (next.kind === 'set') {
							next.variables = rows;
						}
					}),
				}));
				break;
			}
			case 'group': {
				const form = append(content, $('.volt-http-auto-form'));
				createHttpDropdown<HttpFlowGroupRole>(this.field(form, localize('voltHttp.autoRole', "Role")), this.contextViewService, {
					options: [
						{ id: 'steps', label: localize('voltHttp.autoRoleSteps', "Steps"), description: localize('voltHttp.autoRoleStepsDesc', "Steps kept together") },
						{ id: 'setup', label: localize('voltHttp.autoRoleSetup', "Setup"), description: localize('voltHttp.autoRoleSetupDesc', "A failure here stops the run") },
						{ id: 'teardown', label: localize('voltHttp.autoRoleTeardown', "Teardown"), description: localize('voltHttp.autoRoleTeardownDesc', "Runs even after a failure: clean up here") },
					],
					value: step.role,
					ariaLabel: localize('voltHttp.autoRole', "Role"),
					onChange: value => {
						this.editStep(step.id, next => {
							if (next.kind === 'group') {
								next.role = value;
							}
						});
						this.renderEditor();
					},
				}, this.editorStore);
				append(content, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoGroupHint', "Drag steps onto the group to put them inside it.");
				break;
			}
			case 'condition': {
				append(content, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoConditionHint', "The steps inside run only when this holds, on the variables and the last response.");
				this.assertRow(content, step.if, change => this.editStep(step.id, next => {
					if (next.kind === 'condition') {
						change(next.if);
					}
				}));
				break;
			}
			case 'repeat': this.renderRepeatEditor(content, step); break;
		}
	}

	private renderRepeatEditor(parent: HTMLElement, step: Extract<IHttpFlowStep, { kind: 'repeat' }>): void {
		const form = append(parent, $('.volt-http-auto-form'));
		const mode: RepeatMode = step.forEach !== undefined ? 'forEach' : step.until ? 'until' : 'times';
		const edit = (mutate: (next: Extract<IHttpFlowStep, { kind: 'repeat' }>) => void) => this.editStep(step.id, next => {
			if (next.kind === 'repeat') {
				mutate(next);
			}
		});
		createHttpDropdown<RepeatMode>(this.field(form, localize('voltHttp.autoRepeatMode', "Repeat")), this.contextViewService, {
			options: [
				{ id: 'times', label: localize('voltHttp.autoRepeatTimes', "A number of times") },
				{ id: 'forEach', label: localize('voltHttp.autoRepeatForEach', "For each item of a list"), description: localize('voltHttp.autoRepeatForEachDesc', "A variable holding a JSON array, such as an extracted $.items") },
				{ id: 'until', label: localize('voltHttp.autoRepeatUntil', "Until a check holds"), description: localize('voltHttp.autoRepeatUntilDesc', "Checked after each round, on the last response") },
			],
			value: mode,
			ariaLabel: localize('voltHttp.autoRepeatMode', "Repeat"),
			onChange: value => {
				edit(next => {
					delete next.forEach;
					delete next.as;
					delete next.until;
					if (value === 'times') {
						next.times = next.times ?? 3;
					} else {
						delete next.times;
						if (value === 'forEach') {
							next.forEach = '';
							next.as = 'item';
						} else {
							next.until = { target: 'status', op: 'equals', value: 200 };
						}
					}
				});
				this.renderEditor();
			},
		}, this.editorStore);
		if (mode === 'times') {
			this.numberInput(this.field(form, localize('voltHttp.autoTimes', "Times")), step.times, localize('voltHttp.autoTimes', "Times"), value => edit(next => next.times = Math.max(1, value)), { min: 1, max: 1000 });
		} else if (mode === 'forEach') {
			this.textInput(this.field(form, localize('voltHttp.autoListVariable', "List variable"), localize('voltHttp.autoListVariableHint', "Its value must be a JSON array.")), step.forEach ?? '', localize('voltHttp.autoListVariable', "List variable"), value => edit(next => next.forEach = value.trim().replace(/^\{\{\s*|\s*\}\}$/g, '')), { placeholder: 'items', code: true });
			this.textInput(this.field(form, localize('voltHttp.autoItemVariable', "Each item as"), localize('voltHttp.autoItemVariableHint', "Use {{item}} in the steps inside; its position is {{itemIndex}}.")), step.as ?? '', localize('voltHttp.autoItemVariable', "Each item as"), value => edit(next => {
				if (value.trim()) {
					next.as = value.trim();
				} else {
					delete next.as;
				}
			}), { placeholder: 'item', code: true });
		} else if (step.until) {
			append(form, $('.volt-http-auto-field-label.block')).textContent = localize('voltHttp.autoUntil', "Until");
			this.assertRow(form, step.until, change => edit(next => {
				if (next.until) {
					change(next.until);
				}
			}));
		}
		this.numberInput(this.field(form, localize('voltHttp.autoMaxRounds', "At most"), localize('voltHttp.autoMaxRoundsHint', "Rounds, whatever the mode.")), step.max, localize('voltHttp.autoMaxRounds', "At most"), value => edit(next => next.max = Math.max(1, value)), { min: 1, max: 1000 });
	}

	private get requestTab(): RequestTab {
		const tab = this.state.memory.requestTab;
		return tab === 'extract' || tab === 'assert' || tab === 'options' ? tab : 'request';
	}

	private renderRequestEditor(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		const tabs = append(parent, $('.volt-http-tabs.volt-http-auto-subtabs'));
		const body = append(parent, $('.volt-http-auto-subtab-body'));
		renderHttpTabs<RequestTab>(tabs, [
			{ id: 'request', label: localize('voltHttp.autoSubRequest', "Request") },
			{ id: 'extract', label: localize('voltHttp.autoSubExtract', "Extract"), ...(step.extract.length ? { count: step.extract.length } : {}) },
			{ id: 'assert', label: localize('voltHttp.autoSubAssert', "Assert"), ...(step.assert.length ? { count: step.assert.length } : {}) },
			{ id: 'options', label: localize('voltHttp.autoSubOptions', "Options"), ...(step.retry || step.timeoutMs || step.continueOnFailure || step.runScripts === false ? { dot: true } : {}) },
		], this.requestTab, id => {
			this.state.memory.requestTab = id;
			this.renderEditor();
		});
		switch (this.requestTab) {
			case 'request': this.renderRequestSource(body, step); break;
			case 'extract': this.renderExtract(body, step); break;
			case 'assert': this.renderAssert(body, step); break;
			case 'options': this.renderOptions(body, step); break;
		}
	}

	private renderRequestSource(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		if (step.ref) {
			const ref = step.ref;
			const source = append(parent, $('.volt-http-auto-source'));
			const resolved = this.resolvedOf(step);
			const line = append(source, $('.volt-http-auto-source-line'));
			if (resolved && typeof resolved !== 'string') {
				const method = append(line, $('span.volt-http-row-method'));
				method.textContent = httpRequestBadge(resolved.request);
				method.dataset.method = httpRequestBadgeKey(resolved.request);
			}
			append(line, $('span.volt-http-auto-source-path')).textContent = ref.path.join(' / ');
			append(source, $('.volt-http-auto-source-collection')).textContent = ref.collection;
			if (typeof resolved === 'string') {
				append(source, $('.volt-http-auto-inline-problem.error')).textContent = resolved;
			} else if (resolved) {
				append(source, $('.volt-http-auto-source-url')).textContent = resolved.request.url;
			}
			const actions = append(source, $('.volt-http-auto-actions'));
			const open = this.editorStore.add(createVoltButton(actions, 'secondary'));
			open.label = localize('voltHttp.autoOpenRequest', "Open Request");
			open.enabled = !!resolved && typeof resolved !== 'string';
			this.editorStore.add(open.onDidClick(() => {
				const target = this.resolvedOf(step);
				if (target && typeof target !== 'string') {
					this.host.openRequest(target.collection, target.request.id, this.lastExchangeOf(step.id));
				}
			}));
			const inline = this.editorStore.add(createVoltButton(actions, 'ghost'));
			inline.label = localize('voltHttp.autoMakeInline', "Copy into the Flow");
			setAgentTooltip(inline.element, localize('voltHttp.autoMakeInlineHint', "Make this step an inline request with the saved request's method, URL, headers and body. Its auth and scripts stay behind."));
			inline.enabled = !!resolved && typeof resolved !== 'string';
			this.editorStore.add(inline.onDidClick(() => {
				const target = this.resolvedOf(step);
				if (!target || typeof target === 'string') {
					return;
				}
				const request = target.request;
				const raw = request.body.mode === 'raw' ? request.body.raw : request.body.mode === 'urlencoded' ? request.body.urlencoded.filter(row => row.enabled).map(row => `${row.key}=${row.value}`).join('&') : '';
				const language = request.body.mode === 'raw' ? request.body.language : undefined;
				const bodyType: HttpFlowBodyType = request.body.mode === 'urlencoded' ? 'form' : request.body.mode === 'raw' ? (language === 'json' || language === 'xml' ? language : 'text') : 'none';
				this.editRequest(step.id, next => {
					next.inline = { method: request.method, url: request.url, headers: request.headers.filter(row => row.key).map(row => ({ key: row.key, value: row.value, enabled: row.enabled })), body: raw, bodyType };
					if (!next.name) {
						next.name = request.name;
					}
					delete next.ref;
				});
				this.renderEditor();
			}));
		} else {
			this.renderInline(parent, step);
		}
		append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.autoStepVariables', "Variables for this step");
		append(parent, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoStepVariablesHint', "Values for this send only; they win over the environment and the flow's own. {{variables}} are filled in from the steps before.");
		this.editorStore.add(new HttpKeyValueTable(parent, {
			rows: step.variables,
			variables: this.host.variables,
			keyLabel: localize('voltHttp.autoVariable', "Variable"),
			valueLabel: localize('voltHttp.autoValue', "Value"),
			onChange: rows => this.editRequest(step.id, next => next.variables = rows),
		}));
	}

	private renderInline(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		const inline = step.inline ?? { method: 'GET', url: '', headers: [], body: '', bodyType: 'none' as const };
		const editInline = (mutate: (next: NonNullable<IHttpFlowRequestStep['inline']>) => void) => this.editRequest(step.id, next => {
			next.inline ??= { method: 'GET', url: '', headers: [], body: '', bodyType: 'none' };
			mutate(next.inline);
		});
		const bar = append(parent, $('.volt-http-auto-urlbar'));
		const method = append(bar, $('.volt-http-auto-method'));
		method.dataset.method = inline.method.toUpperCase();
		createHttpDropdown<string>(method, this.contextViewService, {
			options: HTTP_METHODS.map(id => ({ id, label: id })),
			value: inline.method.toUpperCase(),
			ariaLabel: localize('voltHttp.autoMethod', "Method"),
			width: 160,
			onChange: value => {
				method.dataset.method = value;
				editInline(next => next.method = value);
				this.stepTree?.rerender();
			},
		}, this.editorStore);
		const url = append(bar, $('.volt-http-auto-url'));
		createHttpVariableField(url, {
			value: inline.url,
			placeholder: '{{baseUrl}}/orders',
			ariaLabel: localize('voltHttp.autoUrl', "URL"),
			variables: this.host.variables,
			onChange: value => editInline(next => next.url = value),
		}, this.editorStore);
		append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.autoHeaders', "Headers");
		this.editorStore.add(new HttpKeyValueTable(parent, {
			rows: inline.headers,
			variables: this.host.variables,
			keyLabel: localize('voltHttp.autoHeader', "Header"),
			valueLabel: localize('voltHttp.autoValue', "Value"),
			onChange: rows => editInline(next => next.headers = rows),
		}));
		const bodyHead = append(parent, $('.volt-http-auto-body-head'));
		append(bodyHead, $('span.volt-http-sublabel')).textContent = localize('voltHttp.autoBody', "Body");
		createHttpDropdown<HttpFlowBodyType>(bodyHead, this.contextViewService, {
			options: [
				{ id: 'none', label: localize('voltHttp.autoBodyNone', "None") },
				{ id: 'json', label: 'JSON' },
				{ id: 'text', label: localize('voltHttp.autoBodyText', "Text") },
				{ id: 'xml', label: 'XML' },
				{ id: 'form', label: localize('voltHttp.autoBodyForm', "Form (urlencoded)"), description: 'a=1&b={{value}}' },
			],
			value: inline.bodyType,
			ariaLabel: localize('voltHttp.autoBodyType', "Body type"),
			onChange: value => {
				editInline(next => next.bodyType = value);
				this.renderEditor();
			},
		}, this.editorStore);
		if (inline.bodyType !== 'none') {
			const text = append(parent, $('textarea.volt-http-textarea.volt-http-auto-code')) as HTMLTextAreaElement;
			text.spellcheck = false;
			text.rows = 8;
			text.value = inline.body;
			text.placeholder = inline.bodyType === 'json' ? '{ "email": "{{email}}" }' : inline.bodyType === 'form' ? 'email={{email}}&password={{password}}' : '';
			text.setAttribute('aria-label', localize('voltHttp.autoBody', "Body"));
			this.editorStore.add(addDisposableListener(text, EventType.INPUT, () => editInline(next => next.body = text.value)));
		}
	}

	private renderExtract(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		append(parent, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoExtractHint', "Values taken from the answer become {{variables}} for every later step. A value that is missing fails the step unless it has a default.");
		const grid = append(parent, $('.volt-http-auto-grid.extract'));
		const head = append(grid, $('.volt-http-auto-grid-row.head'));
		for (const title of [localize('voltHttp.autoExtractName', "Variable"), localize('voltHttp.autoExtractFrom', "From"), localize('voltHttp.autoExtractPath', "Path or pattern"), localize('voltHttp.autoExtractDefault', "Default"), '']) {
			append(head, $('span')).textContent = title;
		}
		const result = this.lastResultOf(step.id);
		step.extract.forEach((item, index) => {
			const row = append(grid, $('.volt-http-auto-grid-row'));
			const edit = (mutate: (next: IHttpFlowRequestStep['extract'][number]) => void) => this.editRequest(step.id, next => {
				const target = next.extract[index];
				if (target) {
					mutate(target);
				}
			});
			this.textInput(row, item.name, localize('voltHttp.autoExtractName', "Variable"), value => edit(next => next.name = value.trim()), { placeholder: 'token', code: true });
			createHttpDropdown<HttpFlowExtractSource>(row, this.contextViewService, {
				options: HTTP_FLOW_EXTRACT_SOURCES.map(id => ({ id, label: SOURCE_LABELS[id] })),
				value: item.from,
				ariaLabel: localize('voltHttp.autoExtractFrom', "From"),
				width: 200,
				onChange: value => {
					edit(next => next.from = value);
					this.renderEditor();
				},
			}, this.editorStore);
			const needsPath = item.from === 'json' || item.from === 'header' || item.from === 'regex' || item.from === 'cookie';
			const path = this.textInput(row, item.path ?? '', localize('voltHttp.autoExtractPath', "Path or pattern"), value => edit(next => {
				if (value) {
					next.path = value;
				} else {
					delete next.path;
				}
			}), { placeholder: item.from === 'json' ? '$.data.id' : item.from === 'header' ? 'Location' : item.from === 'regex' ? 'id=(\\d+)' : item.from === 'cookie' ? 'session' : '', code: true });
			path.disabled = !needsPath;
			this.textInput(row, item.default ?? '', localize('voltHttp.autoExtractDefault', "Default"), value => edit(next => {
				if (value) {
					next.default = value;
				} else {
					delete next.default;
				}
			}), { placeholder: localize('voltHttp.autoOptional', "optional") });
			createHttpIconButton(row, Codicon.close, localize('voltHttp.autoRemove', "Remove"), () => {
				this.editRequest(step.id, next => next.extract.splice(index, 1));
				this.renderEditor();
			});
			const value = result?.extracted.find(extracted => extracted.name === item.name);
			if (value) {
				const seen = append(grid, $('.volt-http-auto-grid-value'));
				seen.classList.toggle('missing', !value.found);
				seen.textContent = value.found ? localize('voltHttp.autoExtractedLast', "Last run: {0}", cut(value.value ?? '', 200)) : localize('voltHttp.autoExtractedMissing', "Last run: {0}", value.error ?? localize('voltHttp.autoNotFound', "not found"));
			}
		});
		const actions = append(parent, $('.volt-http-auto-actions'));
		const add = this.editorStore.add(createVoltButton(actions, 'secondary'));
		add.label = localize('voltHttp.autoAddExtract', "Add Extraction");
		this.editorStore.add(add.onDidClick(() => {
			this.editRequest(step.id, next => next.extract.push({ name: '', from: 'json', path: '$.' }));
			this.renderEditor();
		}));
		const exchange = this.lastExchangeOf(step.id);
		const pick = this.editorStore.add(createVoltButton(actions, 'ghost'));
		pick.label = localize('voltHttp.autoPickFromResponse', "Pick from Last Response");
		pick.enabled = !!exchange?.response;
		if (!exchange?.response) {
			setAgentTooltip(pick.element, localize('voltHttp.autoPickNeedsRun', "Run the step once to pick values from its answer."));
		}
		this.editorStore.add(pick.onDidClick(() => exchange && this.showResponsePicker(pick.element, exchange, (source, path) => {
			this.editRequest(step.id, next => next.extract.push({ name: nameFor(path), from: source, path }));
			this.renderEditor();
		})));
	}

	/** A searchable menu of the last answer's JSON paths and headers. */
	private showResponsePicker(anchor: HTMLElement, exchange: IHttpExchange, onPick: (source: 'json' | 'header', path: string) => void): void {
		const response = exchange.response;
		if (!response) {
			return;
		}
		type Pick = { readonly source: 'json' | 'header'; readonly path: string };
		const json = safeJson(response.body);
		const paths = json === undefined ? [] : listHttpJsonPaths(json, 300);
		this.menu.value = showVoltMenu<Pick>(this.contextViewService, {
			anchor,
			className: 'volt-http-menu',
			align: 'left',
			width: 360,
			ariaLabel: localize('voltHttp.autoPickResponseAria', "Values of the last response"),
			search: { placeholder: localize('voltHttp.autoPickSearch', "Filter paths and headers") },
			emptyMessage: localize('voltHttp.autoPickNothing', "The last response has no JSON body or headers."),
			sections: [
				...(paths.length ? [{ id: 'json', title: localize('voltHttp.autoPickJson', "Body"), items: paths.map(item => ({ id: `json:${item.path}`, label: item.path, description: item.preview, data: { source: 'json' as const, path: item.path } })) }] : []),
				{ id: 'headers', title: localize('voltHttp.autoPickHeaders', "Headers"), items: Object.entries(response.headers).map(([key, value]) => ({ id: `header:${key}`, label: key, description: value, data: { source: 'header' as const, path: key } })) },
			],
			onPick: item => onPick(item.data.source, item.data.path),
		});
	}

	/** One assertion: target, path, operator and value, on one line. */
	private assertRow(parent: HTMLElement, assert: IHttpFlowAssert, change: (mutate: (next: IHttpFlowAssert) => void) => void, onRemove?: () => void): void {
		const row = append(parent, $('.volt-http-auto-assert'));
		createHttpDropdown<HttpFlowAssertTarget>(row, this.contextViewService, {
			options: HTTP_FLOW_ASSERT_TARGETS.map(id => ({ id, label: TARGET_LABELS[id] })),
			value: assert.target,
			ariaLabel: localize('voltHttp.autoAssertTarget', "What to check"),
			width: 200,
			onChange: value => {
				change(next => {
					next.target = value;
					if (value === 'schema') {
						next.op = 'schema';
						if (typeof next.value !== 'object' || next.value === null) {
							next.value = { type: 'object' };
						}
					} else if (next.op === 'schema') {
						next.op = 'equals';
						delete next.value;
					}
				});
				this.renderEditor();
			},
		}, this.editorStore);
		const hasPath = assert.target === 'json' || assert.target === 'header' || assert.target === 'variable' || assert.target === 'schema';
		if (hasPath) {
			this.textInput(row, assert.path ?? '', localize('voltHttp.autoAssertPath', "Path"), value => change(next => {
				if (value) {
					next.path = value;
				} else {
					delete next.path;
				}
			}), { placeholder: assert.target === 'json' ? '$.user.id' : assert.target === 'header' ? 'Content-Type' : assert.target === 'variable' ? 'orderId' : localize('voltHttp.autoAssertSchemaPath', "$ (whole body)"), code: true }).classList.add('path');
		}
		const schema = assert.target === 'schema' || assert.op === 'schema';
		if (assert.target !== 'schema') {
			createHttpDropdown<HttpFlowAssertOp>(row, this.contextViewService, {
				options: HTTP_FLOW_ASSERT_OPS.map(id => ({ id, label: OP_LABELS[id] })),
				value: assert.op,
				ariaLabel: localize('voltHttp.autoAssertOp', "Operator"),
				width: 180,
				onChange: value => {
					change(next => {
						next.op = value;
						if (value === 'exists' || value === 'notExists') {
							delete next.value;
						} else if (value === 'schema' && (typeof next.value !== 'object' || next.value === null)) {
							next.value = { type: 'object' };
						}
					});
					this.renderEditor();
				},
			}, this.editorStore);
		}
		if (!schema && assert.op !== 'exists' && assert.op !== 'notExists') {
			this.textInput(row, valueText(assert.value), localize('voltHttp.autoAssertValue', "Expected value"), value => change(next => {
				const parsed = parseValue(value);
				if (parsed === undefined) {
					delete next.value;
				} else {
					next.value = parsed;
				}
			}), { placeholder: assert.op === 'type' ? 'string' : assert.op === 'length' ? '>0' : assert.op === 'in' ? '[200, 201]' : assert.target === 'time' ? '500' : '200', code: true }).classList.add('value');
		}
		if (onRemove) {
			createHttpIconButton(row, Codicon.close, localize('voltHttp.autoRemove', "Remove"), onRemove);
		}
		if (schema) {
			const text = append(parent, $('textarea.volt-http-textarea.volt-http-auto-code.volt-http-auto-schema')) as HTMLTextAreaElement;
			text.spellcheck = false;
			text.rows = 6;
			text.value = JSON.stringify(assert.value ?? { type: 'object' }, undefined, 2);
			text.setAttribute('aria-label', localize('voltHttp.autoSchema', "JSON Schema"));
			this.editorStore.add(addDisposableListener(text, EventType.INPUT, () => {
				const parsed = safeJson(text.value);
				const valid = parsed !== undefined && typeof parsed === 'object' && parsed !== null;
				text.classList.toggle('invalid', !valid);
				if (valid) {
					change(next => next.value = parsed);
				}
			}));
		}
	}

	private renderAssert(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		append(parent, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoAssertHint', "Every check must hold for the step to pass. Values may use {{variables}}.");
		const result = this.lastResultOf(step.id);
		const list = append(parent, $('.volt-http-auto-asserts'));
		step.assert.forEach((assert, index) => {
			this.assertRow(list, assert, mutate => this.editRequest(step.id, next => {
				const target = next.assert[index];
				if (target) {
					mutate(target);
				}
			}), () => {
				this.editRequest(step.id, next => next.assert.splice(index, 1));
				this.renderEditor();
			});
			const outcome = result?.asserts[index];
			if (outcome) {
				const seen = append(list, $('.volt-http-auto-grid-value'));
				seen.classList.toggle('missing', !outcome.passed);
				seen.textContent = outcome.passed ? localize('voltHttp.autoAssertPassedLast', "Last run: passed") : localize('voltHttp.autoAssertFailedLast', "Last run: {0}", outcome.message);
			}
		});
		const exchange = this.lastExchangeOf(step.id);
		const json = safeJson(exchange?.response?.body);
		const add = (assert: IHttpFlowAssert) => {
			this.editRequest(step.id, next => next.assert.push(assert));
			this.renderEditor();
		};
		const actions = append(parent, $('.volt-http-auto-actions'));
		const more = this.editorStore.add(createVoltButton(actions, 'secondary'));
		more.label = localize('voltHttp.autoAddAssert', "Add Check");
		this.editorStore.add(more.onDidClick(() => add({ target: 'status', op: 'equals', value: 200 })));
		const quick = append(parent, $('.volt-http-auto-quick'));
		append(quick, $('span.volt-http-note')).textContent = localize('voltHttp.autoQuickAdd', "Quick add:");
		const quickLink = (label: string, run: (button: HTMLButtonElement) => void, enabled = true, title?: string) => {
			const button = append(quick, $('button.volt-http-link')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.disabled = !enabled;
			if (title) {
				setAgentTooltip(button, title);
			}
			this.editorStore.add(addDisposableListener(button, EventType.CLICK, () => run(button)));
		};
		quickLink(localize('voltHttp.autoQuickStatus', "Status is 200"), () => add({ target: 'status', op: 'equals', value: 200 }));
		quickLink(localize('voltHttp.autoQuickTime', "Time under 500 ms"), () => add({ target: 'time', op: 'lt', value: 500 }));
		quickLink(localize('voltHttp.autoQuickField', "Has JSON Field"), button => {
			if (exchange?.response && json !== undefined) {
				this.showResponsePicker(button, exchange, (source, path) => add(source === 'json' ? { target: 'json', path, op: 'exists' } : { target: 'header', path, op: 'exists' }));
			} else {
				add({ target: 'json', path: '$.id', op: 'exists' });
			}
		});
		quickLink(localize('voltHttp.autoQuickSchema', "Matches the Last Response's Schema"), () => add({ target: 'schema', op: 'schema', value: inferHttpJsonSchema(json) }), json !== undefined, json === undefined ? localize('voltHttp.autoQuickSchemaNeedsRun', "Run the step once: the schema is read from its JSON answer.") : undefined);
	}

	private renderOptions(parent: HTMLElement, step: IHttpFlowRequestStep): void {
		const form = append(parent, $('.volt-http-auto-form'));
		const retry = step.retry;
		const editRetry = (mutate: (next: NonNullable<IHttpFlowRequestStep['retry']>) => void) => this.editRequest(step.id, next => {
			next.retry ??= { times: 0, delayMs: 1000, backoff: 1 };
			mutate(next.retry);
			if (!next.retry.times && !next.retry.until) {
				delete next.retry;
			}
		});
		this.numberInput(this.field(form, localize('voltHttp.autoRetryTimes', "Retries"), localize('voltHttp.autoRetryTimesHint', "Sends again after a failure (or until the poll condition holds). 0 sends once.")), retry?.times ?? 0, localize('voltHttp.autoRetryTimes', "Retries"), value => editRetry(next => next.times = value), { max: 100 });
		this.numberInput(this.field(form, localize('voltHttp.autoRetryDelay', "Wait between (ms)")), retry?.delayMs ?? 1000, localize('voltHttp.autoRetryDelay', "Wait between (ms)"), value => editRetry(next => next.delayMs = value), { max: 60_000 });
		const backoff = append(this.field(form, localize('voltHttp.autoBackoff', "Backoff"), localize('voltHttp.autoBackoffHint', "The wait grows by this factor after each attempt; 1 keeps it the same.")), $('input.volt-http-input.short.volt-http-auto-number')) as HTMLInputElement;
		backoff.type = 'number';
		backoff.min = '1';
		backoff.max = '10';
		backoff.step = '0.5';
		backoff.value = String(retry?.backoff ?? 1);
		backoff.setAttribute('aria-label', localize('voltHttp.autoBackoff', "Backoff"));
		this.editorStore.add(addDisposableListener(backoff, EventType.INPUT, () => {
			const value = Number(backoff.value);
			if (Number.isFinite(value)) {
				editRetry(next => next.backoff = Math.max(1, Math.min(10, value)));
			}
		}));
		const poll = this.field(form, localize('voltHttp.autoPoll', "Poll"));
		this.check(poll, !!retry?.until, localize('voltHttp.autoPollLabel', "Send again until a check holds"), checked => {
			editRetry(next => {
				if (checked) {
					next.until = { target: 'json', path: '$.status', op: 'equals', value: 'done' };
					next.times = Math.max(next.times, 10);
				} else {
					delete next.until;
				}
			});
			this.renderEditor();
		});
		if (retry?.until) {
			this.assertRow(form, retry.until, mutate => editRetry(next => {
				if (next.until) {
					mutate(next.until);
				}
			}));
		}
		this.numberInput(this.field(form, localize('voltHttp.autoTimeout', "Timeout (ms)"), localize('voltHttp.autoTimeoutHint', "0 uses the flow's default.")), step.timeoutMs ?? 0, localize('voltHttp.autoTimeout', "Timeout (ms)"), value => this.editRequest(step.id, next => {
			if (value) {
				next.timeoutMs = value;
			} else {
				delete next.timeoutMs;
			}
		}), { max: 3_600_000 });
		const flags = this.field(form, localize('voltHttp.autoOnFailure', "Behavior"));
		this.check(flags, !!step.continueOnFailure, localize('voltHttp.autoContinue', "Continue the run when this step fails"), checked => this.editRequest(step.id, next => {
			if (checked) {
				next.continueOnFailure = true;
			} else {
				delete next.continueOnFailure;
			}
		}));
		this.check(flags, step.runScripts !== false, localize('voltHttp.autoRunScripts', "Count the request's own tests (pm.test)"), checked => this.editRequest(step.id, next => {
			if (checked) {
				delete next.runScripts;
			} else {
				next.runScripts = false;
			}
		}));
	}

	// --- Generate with AI ------------------------------------------------------------------------

	private openAi(): void {
		this.state.memory.aiOpen = true;
		if (this.tab !== 'steps') {
			this.setTab('steps');
		} else {
			this.renderAi();
		}
		this.aiEl?.querySelector('textarea')?.focus();
	}

	private modelRef(): string | undefined {
		return httpAiModelRef(this.instantiationService);
	}

	/** The project's saved requests as the model is told about them: names, methods, URLs and body fields, never values. */
	private async catalog(): Promise<IHttpFlowCatalogCollection[]> {
		const entries = await this.collections.collections(this.host.root).catch(() => []);
		return entries.filter(entry => !entry.error).map(entry => ({
			collection: this.collectionRef(entry.uri),
			name: entry.collection.name,
			requests: httpRequestsOf(entry.collection.items).map(({ request, ancestors }) => httpFlowCatalogRequest([...ancestors.map(folder => folder.name), request.name], request)),
		})).filter(collection => collection.requests.length);
	}

	private async generate(wish: string): Promise<void> {
		const flow = this.flow;
		if (!flow) {
			return;
		}
		this.state.memory.aiError = undefined;
		this.state.memory.aiProposal = undefined;
		const ref = this.modelRef();
		if (!ref) {
			this.state.memory.aiError = localize('voltHttp.autoAiNoModel', "No model is set up. Add one in Settings, Providers & Models.");
			this.renderAi();
			return;
		}
		const cancel = new CancellationTokenSource();
		const timer = setTimeout(() => cancel.cancel(), AI_TIMEOUT_MS);
		this.aiRun.value = toDisposable(() => {
			clearTimeout(timer);
			cancel.dispose(true);
		});
		this.renderAi();
		let answer = '';
		let failure: string | undefined;
		try {
			const replace = flow.steps.length > 0 && this.state.memory.aiMode === 'replace';
			this.state.memory.aiProposalReplaces = replace;
			const prompt = httpFlowGenerationPrompt(await this.catalog(), wish, flow, replace ? 'rewrite' : 'add');
			if (this.runtime.resolveCatalogItem(ref)?.kind === 'agent') {
				const text = await raceCancellation(this.runtime.generateText(prompt, { ref, systemPrompt: HTTP_FLOW_SYSTEM_PROMPT, timeoutMs: AI_TIMEOUT_MS - 5000 }), cancel.token);
				if (text === undefined && !cancel.token.isCancellationRequested) {
					failure = localize('voltHttp.autoAiAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", this.runtime.resolveCatalogItem(ref)?.label ?? ref);
				}
				answer = text ?? '';
			} else {
				for await (const event of this.runtime.streamModel(ref, [{ role: 'system', content: HTTP_FLOW_SYSTEM_PROMPT }, { role: 'user', content: prompt }], this.runtime.getModelOptions(ref), cancel.token, 'code')) {
					if (cancel.token.isCancellationRequested) {
						break;
					}
					if (event.type === 'text.delta' && event.delta) {
						answer += event.delta;
					} else if (event.type === 'error') {
						failure = event.message;
						break;
					}
				}
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}
		const cancelled = cancel.token.isCancellationRequested;
		this.aiRun.clear();
		if (this._store.isDisposed) {
			return;
		}
		if (!failure && !(cancelled && !answer)) {
			const parsed = parseHttpFlowAnswer(answer, flow.name);
			if (parsed.flow) {
				this.state.memory.aiProposal = parsed.flow;
				this.state.memory.aiProblems = parsed.problems.map(problem => problem.message);
			} else {
				failure = parsed.error;
			}
		}
		this.state.memory.aiError = failure ?? (cancelled && !answer ? localize('voltHttp.autoAiStopped', "Stopped.") : undefined);
		this.renderAi();
	}

	/** `replace` swaps the flow's steps for the proposal's; otherwise they go after the selection (or at the end). */
	private applyProposal(proposal: IHttpFlow, replace: boolean): void {
		const flow = this.flow;
		if (!flow) {
			return;
		}
		this.edit(next => {
			if (replace) {
				next.steps.length = 0;
			}
			const known = new Set(next.variables.map(row => row.key));
			for (const row of proposal.variables) {
				if (row.key && !known.has(row.key)) {
					next.variables.push({ ...row });
				}
			}
			if (!next.description && proposal.description) {
				next.description = proposal.description;
			}
		});
		this.state.memory.aiProposal = undefined;
		this.state.memory.aiOpen = false;
		this.state.memory.selected = undefined;
		this.insertSteps(structuredClone(proposal.steps));
		this.renderAi();
	}

	/** The proposal as an outline: each step's kind, name, and what it sends, checks and keeps. */
	private renderProposalOutline(parent: HTMLElement, proposal: IHttpFlow): void {
		const box = append(parent, $('.volt-http-auto-ai-outline'));
		if (proposal.description) {
			append(box, $('.volt-http-auto-ai-summary')).textContent = proposal.description;
		}
		const visit = (steps: readonly IHttpFlowStep[], depth: number) => {
			for (const step of steps) {
				const row = append(box, $('.volt-http-auto-ai-step'));
				row.style.paddingLeft = `${depth * 18}px`;
				row.classList.toggle('container', isHttpFlowContainer(step));
				row.classList.toggle('disabled', !!step.disabled);
				append(row, $('span.volt-http-auto-ai-step-icon')).appendChild(renderIcon(kindIcon(step)));
				const text = append(row, $('.volt-http-auto-ai-step-text'));
				append(text, $('span.volt-http-auto-ai-step-name')).textContent = httpFlowStepLabel(step);
				const facts: string[] = [];
				if (step.kind === 'request') {
					facts.push(step.ref ? step.ref.path.join(' / ') : `${step.inline?.method ?? 'GET'} ${step.inline?.url ?? ''}`);
					if (step.assert.length) {
						facts.push(step.assert.length === 1 ? localize('voltHttp.autoOneAssert', "1 assert") : localize('voltHttp.autoAsserts', "{0} asserts", step.assert.length));
					}
					if (step.extract.length) {
						facts.push(localize('voltHttp.autoAiExtracts', "extracts {0}", step.extract.map(item => item.name).join(', ')));
					}
				}
				if (facts.length) {
					append(text, $('span.volt-http-auto-ai-step-facts')).textContent = facts.join(' \u00b7 ');
				}
				if (isHttpFlowContainer(step)) {
					visit(step.steps, depth + 1);
				}
			}
		};
		visit(proposal.steps, 0);
	}

	private renderAi(): void {
		const parent = this.aiEl;
		if (!parent) {
			return;
		}
		this.aiStore.clear();
		clearNode(parent);
		const open = this.state.memory.aiOpen === true;
		parent.classList.toggle('hidden', !open);
		if (!open) {
			this.layoutTrees();
			return;
		}
		const running = !!this.aiRun.value;
		const head = append(parent, $('.volt-http-auto-ai-head'));
		append(head, $('span.volt-http-auto-ai-title')).textContent = localize('voltHttp.autoAiTitle', "Generate steps with AI");
		append(head, $('.volt-http-spacer'));
		this.modelButton(head, this.aiStore);
		createHttpIconButton(head, Codicon.close, localize('voltHttp.autoAiClose', "Close"), () => {
			this.aiRun.clear();
			this.state.memory.aiOpen = false;
			this.renderAi();
		});
		const proposal = this.state.memory.aiProposal as IHttpFlow | undefined;
		if (proposal && !running) {
			const count = httpFlowStepsOf(proposal.steps).filter(step => !isHttpFlowContainer(step)).length;
			append(parent, $('.volt-http-note')).textContent = count === 1 ? localize('voltHttp.autoAiOne', "The model proposes 1 step. Check it, then apply it.") : localize('voltHttp.autoAiMany', "The model proposes {0} steps. Check them, then apply them.", count);
			this.renderProposalOutline(parent, proposal);
			const problems = Array.isArray(this.state.memory.aiProblems) ? this.state.memory.aiProblems as string[] : [];
			for (const problem of problems.slice(0, 5)) {
				append(parent, $('.volt-http-auto-inline-problem')).textContent = problem;
			}
			const actions = append(parent, $('.volt-http-auto-actions'));
			// The model was asked either for steps to add or for the whole flow again; Apply does the same.
			const hasSteps = !!this.flow?.steps.length;
			const replaces = hasSteps && this.state.memory.aiProposalReplaces === true;
			const apply = this.aiStore.add(createVoltButton(actions, 'primary'));
			apply.label = replaces ? localize('voltHttp.autoAiReplace', "Replace Steps") : hasSteps ? localize('voltHttp.autoAiAdd', "Add Steps") : localize('voltHttp.autoAiApply', "Apply");
			setAgentTooltip(apply.element, replaces ? localize('voltHttp.autoAiReplaceTitle', "Use these steps instead of the flow's current ones") : hasSteps ? localize('voltHttp.autoAiAddTitle', "Add these after the selected step, or at the end") : '');
			this.aiStore.add(apply.onDidClick(() => this.applyProposal(proposal, replaces)));
			const discard = this.aiStore.add(createVoltButton(actions, 'ghost'));
			discard.label = localize('voltHttp.autoAiDiscard', "Discard");
			this.aiStore.add(discard.onDidClick(() => {
				this.state.memory.aiProposal = undefined;
				this.renderAi();
			}));
			this.layoutTrees();
			return;
		}
		const wish = append(parent, $('textarea.volt-http-textarea.volt-http-auto-ai-wish')) as HTMLTextAreaElement;
		wish.rows = 3;
		wish.value = typeof this.state.memory.aiWish === 'string' ? this.state.memory.aiWish : '';
		wish.placeholder = localize('voltHttp.autoAiPlaceholder', "What to test, e.g. sign up, log in, create an order, pay it, check it shows in the order list, then delete it");
		wish.setAttribute('aria-label', localize('voltHttp.autoAiWish', "What to test"));
		wish.disabled = running;
		this.aiStore.add(addDisposableListener(wish, EventType.INPUT, () => this.state.memory.aiWish = wish.value));
		const foot = append(parent, $('.volt-http-auto-actions'));
		const go = this.aiStore.add(createVoltButton(foot, running ? 'secondary' : 'primary'));
		go.label = running ? localize('voltHttp.autoAiStop', "Stop") : localize('voltHttp.autoAiGo', "Generate");
		this.aiStore.add(go.onDidClick(() => running ? this.aiRun.clear() : void this.generate(wish.value)));
		if (this.flow?.steps.length) {
			const mode = createHttpDropdown<'add' | 'replace'>(append(foot, $('.volt-http-auto-ai-mode')), this.contextViewService, {
				options: [
					{ id: 'add', label: localize('voltHttp.autoAiModeAdd', "Add to the flow"), description: localize('voltHttp.autoAiModeAddDesc', "New steps go after the current ones") },
					{ id: 'replace', label: localize('voltHttp.autoAiModeReplace', "Rewrite the flow"), description: localize('voltHttp.autoAiModeReplaceDesc', "The model writes every step again; they replace the current ones") },
				],
				value: this.state.memory.aiMode === 'replace' ? 'replace' : 'add',
				ariaLabel: localize('voltHttp.autoAiMode', "What the model writes"),
				width: 300,
				onChange: value => this.state.memory.aiMode = value,
			}, this.aiStore);
			mode.element.disabled = running;
		}
		const note = append(foot, $('span.volt-http-note'));
		// allow-any-unicode-next-line
		note.textContent = running ? localize('voltHttp.autoAiWorking', "Writing the flow…") : localize('voltHttp.autoAiPrivacy', "The model is shown the project's request names, methods, URLs and body field names; never values or secrets.");
		if (running) {
			const spinner = $('span.volt-http-spinner');
			spinner.appendChild(renderIcon(Codicon.loading));
			note.prepend(spinner);
		}
		const error = this.state.memory.aiError;
		if (typeof error === 'string' && error) {
			append(parent, $('.volt-http-auto-inline-problem.error')).textContent = error;
		}
		this.layoutTrees();
	}

	/** The button that shows and picks the model. */
	private modelButton(parent: HTMLElement, store: DisposableStore): void {
		createHttpAiModelButton(parent, this.instantiationService, store, localize('voltHttp.autoAiModel', "The model that writes the steps"), AnchorAlignment.RIGHT);
	}

	// --- Runs ------------------------------------------------------------------------------------

	private renderRuns(): void {
		const page = append(this.body, $('.volt-http-auto-runs'));
		this.summaryEl = append(page, $('.volt-http-auto-summary'));
		const split = append(page, $('.volt-http-auto-split'));
		const column = append(split, $('.volt-http-auto-tree-column'));
		this.resultHost = append(column, $('.volt-http-auto-tree.volt-http-auto-results'));
		this.historyEl = append(column, $('.volt-http-auto-history'));
		this.detailEl = append(split, $('.volt-http-auto-editor.volt-http-auto-detail'));

		const delegate: IListVirtualDelegate<ResultNode> = { getHeight: () => RESULT_ROW, getTemplateId: () => 'result' };
		const renderer: ITreeRenderer<ResultNode, void, IResultTemplate> = {
			templateId: 'result',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-auto-result-row'));
				return {
					status: append(row, $('span.volt-http-auto-status')),
					label: append(row, $('span.volt-http-row-label')),
					code: append(row, $('span.volt-http-pill.volt-http-auto-code-pill')),
					attempts: append(row, $('span.volt-http-row-detail')),
					time: append(row, $('span.volt-http-auto-time')),
				};
			},
			renderElement: (node: ITreeNode<ResultNode, void>, _index, template) => {
				const element = node.element;
				clearNode(template.status);
				if (element.kind === 'iteration') {
					appendStatus(template.status, element.status);
					template.label.textContent = localize('voltHttp.autoIteration', "Iteration {0}", element.iteration + 1);
					template.code.textContent = '';
					template.code.className = 'volt-http-pill volt-http-auto-code-pill';
					template.attempts.textContent = '';
					template.time.textContent = '';
					return;
				}
				const step = element.step;
				appendStatus(template.status, step.status);
				template.label.textContent = step.name;
				template.code.textContent = step.statusCode !== undefined ? String(step.statusCode) : '';
				template.code.className = `volt-http-pill volt-http-auto-code-pill ${step.statusCode !== undefined ? httpStatusClass(step.statusCode) : ''}`;
				template.attempts.textContent = step.attempts > 1 ? localize('voltHttp.autoAttempts', "{0} tries", step.attempts) : '';
				template.time.textContent = step.status !== 'skipped' && step.durationMs ? formatHttpDuration(step.durationMs) : '';
			},
			disposeTemplate: () => { },
		};
		const tree = this.resultTree = this.view.add(this.instantiationService.createInstance(WorkbenchObjectTree<ResultNode>, 'VoltHttpAutomationResults', this.resultHost, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => node.kind === 'iteration' ? `${localize('voltHttp.autoIteration', "Iteration {0}", node.iteration + 1)}, ${STATUS_LABELS[node.status]}` : `${node.step.name}, ${STATUS_LABELS[node.step.status]}${node.step.statusCode !== undefined ? `, ${node.step.statusCode}` : ''}`,
				getWidgetAriaLabel: () => localize('voltHttp.autoResultsAria', "Step results"),
			},
			identityProvider: { getId: node => node.key },
			multipleSelectionSupport: false,
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(tree.onDidChangeSelection(event => {
			const [node] = event.elements;
			if (node?.kind === 'step' && node.key !== this.state.memory.result) {
				this.state.memory.result = node.key;
				this.renderDetail();
			}
		}));
		this.view.add(tree.onDidChangeContentHeight(() => {
			if (this.narrow) {
				this.layoutTrees();
			}
		}));
		this.refreshRuns();
	}

	private resultNodes(run: HttpFlowRun): ResultNode[] {
		const byParent = new Map<string, HttpFlowStepRun[]>();
		for (const step of run.steps) {
			const key = step.parentKey ?? `#${step.iteration}`;
			const list = byParent.get(key) ?? [];
			list.push(step);
			byParent.set(key, list);
		}
		const toNode = (step: HttpFlowStepRun): ResultNode => ({ kind: 'step', key: step.key, step, children: (byParent.get(step.key) ?? []).map(toNode) });
		if (run.iterations <= 1) {
			return (byParent.get('#0') ?? []).map(toNode);
		}
		const out: ResultNode[] = [];
		for (let iteration = 0; iteration < run.iterations; iteration++) {
			const steps = byParent.get(`#${iteration}`);
			if (!steps) {
				continue;
			}
			const all = run.steps.filter(step => step.iteration === iteration);
			const status: HttpFlowStepStatus = all.some(step => step.status === 'running') ? 'running' : all.some(step => step.status === 'failed' || step.status === 'error') ? 'failed' : all.every(step => step.status === 'skipped') ? 'skipped' : 'passed';
			out.push({ kind: 'iteration', key: `#${iteration}`, iteration, status, children: steps.map(toNode) });
		}
		return out;
	}

	private refreshRuns(): void {
		const tree = this.resultTree;
		if (!tree) {
			return;
		}
		this.renderSummary();
		this.renderHistory();
		const run = this.run;
		const toElement = (node: ResultNode): IObjectTreeElement<ResultNode> => ({ element: node, ...(node.children.length ? { children: node.children.map(toElement), collapsible: true, collapsed: false } : {}) });
		tree.setChildren(null, run ? this.resultNodes(run).map(toElement) : []);
		this.resultHost?.classList.toggle('empty', !run?.steps.length);
		let key = typeof this.state.memory.result === 'string' ? this.state.memory.result : undefined;
		let selected = key ? run?.steps.find(step => step.key === key) : undefined;
		if (!selected && run) {
			// The first step that went wrong, else the one running, else the first.
			selected = run.steps.find(step => (step.status === 'failed' || step.status === 'error') && step.kind === 'request') ?? run.steps.find(step => step.status === 'running' && step.kind === 'request') ?? run.steps.find(step => step.kind === 'request') ?? run.steps[0];
			key = selected?.key;
		}
		if (selected && key) {
			const node = this.findResult(key);
			if (node) {
				this.state.memory.result = undefined;
				tree.setSelection([node]);
				tree.setFocus([node]);
				this.state.memory.result = key;
			}
		}
		this.layoutTrees();
		this.renderDetail();
	}

	private findResult(key: string): ResultNode | undefined {
		const tree = this.resultTree;
		if (!tree) {
			return undefined;
		}
		const visit = (node: ITreeNode<ResultNode | null, void>): ResultNode | undefined => {
			for (const child of node.children) {
				if (child.element?.key === key) {
					return child.element;
				}
				const found = visit(child);
				if (found) {
					return found;
				}
			}
			return undefined;
		};
		return visit(tree.getNode(null));
	}

	private renderSummary(): void {
		const parent = this.summaryEl!;
		clearNode(parent);
		const run = this.run;
		// Without a run there are no step results to list: the earlier runs sit right under the note.
		const page = parent.parentElement;
		if (page && page.classList.contains('no-run') !== !run) {
			page.classList.toggle('no-run', !run);
			this.layoutTrees();
		}
		if (!run) {
			const empty = append(parent, $('.volt-http-auto-empty-state'));
			append(empty, $('.volt-http-auto-blank-title')).textContent = localize('voltHttp.autoNoRun', "No run yet");
			append(empty, $('.volt-http-note')).textContent = localize('voltHttp.autoNoRunHint', "Press Run to send every step in order. Each step's answer, checks and extracted values show here.");
			return;
		}
		const state = append(parent, $('span.volt-http-auto-state.big'));
		state.dataset.state = run.state;
		state.textContent = run.state === 'running' ? localize('voltHttp.autoStateRunning', "Running") : run.state === 'passed' ? localize('voltHttp.autoStatePassed', "Passed") : run.state === 'failed' ? localize('voltHttp.autoStateFailed', "Failed") : run.state === 'stopped' ? localize('voltHttp.autoStateStopped', "Stopped") : localize('voltHttp.autoStateError', "Error");
		const stat = (value: string, label: string, kind?: string) => {
			const item = append(parent, $('span.volt-http-auto-stat'));
			if (kind) {
				item.dataset.kind = kind;
			}
			append(item, $('b')).textContent = value;
			append(item, $('span')).textContent = label;
		};
		const totals = run.totals;
		stat(String(totals.passed), localize('voltHttp.autoStatPassed', "passed"), 'passed');
		stat(String(totals.failed + totals.errors), localize('voltHttp.autoStatFailed', "failed"), totals.failed + totals.errors ? 'failed' : undefined);
		stat(String(totals.skipped), localize('voltHttp.autoStatSkipped', "skipped"));
		stat(`${totals.asserts - totals.assertsFailed}/${totals.asserts}`, localize('voltHttp.autoStatChecks', "checks"));
		stat(String(totals.requests), localize('voltHttp.autoStatRequests', "requests"));
		stat(formatHttpDuration(run.durationMs), localize('voltHttp.autoStatTime', "total"));
		if (run.iterations > 1) {
			stat(`${Math.min(run.iteration + 1, run.iterations)}/${run.iterations}`, localize('voltHttp.autoStatIteration', "iteration"));
		}
		if (run.environment) {
			append(parent, $('span.volt-http-note')).textContent = localize('voltHttp.autoStatEnv', "Environment {0}", run.environment);
		}
		if (run.error) {
			append(parent, $('.volt-http-auto-inline-problem.error.full')).textContent = run.error;
		}
	}

	private renderHistory(): void {
		const parent = this.historyEl;
		if (!parent) {
			return;
		}
		clearNode(parent);
		const history = this.automations.historyOf(this.uri);
		if (!history.length) {
			parent.classList.add('hidden');
			return;
		}
		parent.classList.remove('hidden');
		const passed = history.filter(item => item.state === 'passed').length;
		const head = append(parent, $('.volt-http-auto-history-head'));
		append(head, $('span.volt-http-sublabel.inline')).textContent = localize('voltHttp.autoHistory', "Last {0} runs", history.length);
		append(head, $('span.volt-http-note')).textContent = localize('voltHttp.autoPassRate', "{0}% passed", Math.round(passed / history.length * 100));
		const bars = append(parent, $('.volt-http-auto-bars'));
		bars.setAttribute('role', 'img');
		bars.setAttribute('aria-label', localize('voltHttp.autoHistoryAria', "{0} of the last {1} runs passed", passed, history.length));
		const longest = Math.max(1, ...history.map(item => item.durationMs));
		for (const item of history) {
			const bar = append(bars, $('span.volt-http-auto-bar'));
			bar.dataset.state = item.state;
			bar.style.height = `${Math.max(12, Math.round(item.durationMs / longest * 100))}%`;
			setAgentTooltip(bar, `${new Date(item.at).toLocaleString()}\n${localize('voltHttp.autoHistoryBar', "{0}: {1} of {2} passed, {3}", item.state, item.passed, item.total, formatHttpDuration(item.durationMs))}`);
		}
	}

	private renderDetail(): void {
		const parent = this.detailEl;
		if (!parent) {
			return;
		}
		const run = this.run;
		const key = typeof this.state.memory.result === 'string' ? this.state.memory.result : undefined;
		const step = key ? run?.steps.find(item => item.key === key) : undefined;
		// The same finished result as drawn: leave it (and the reader's place) alone.
		const signature = step ? `${step.key}|${step.status}|${step.attempts}|${step.exchange?.id ?? ''}` : '';
		if (this.detailKey === signature && signature && step?.status !== 'running') {
			return;
		}
		this.detailKey = signature;
		this.detailStore.clear();
		clearNode(parent);
		parent.classList.toggle('none', !step);
		if (!step) {
			if (run?.steps.length) {
				append(parent, $('.volt-http-empty.center')).textContent = localize('voltHttp.autoSelectResult', "Select a step to see its result.");
			}
			return;
		}
		const head = append(parent, $('.volt-http-auto-editor-head'));
		const status = append(head, $('span.volt-http-auto-status'));
		appendStatus(status, step.status);
		append(head, $('span.volt-http-auto-detail-title')).textContent = step.name;
		append(head, $('.volt-http-spacer'));
		if (step.collection && step.requestId) {
			const open = this.detailStore.add(createVoltButton(head, 'secondary'));
			open.label = localize('voltHttp.autoOpenInTab', "Open in Request Tab");
			const collection = URI.parse(step.collection);
			const id = step.requestId;
			this.detailStore.add(open.onDidClick(() => this.host.openRequest(collection, id, step.exchange)));
		}
		const select = createHttpIconButton(head, Codicon.listSelection, localize('voltHttp.autoShowStep', "Show the Step"), () => {
			this.state.memory.tab = 'steps';
			this.state.memory.selected = step.stepId;
			this.renderTab();
		});
		select.classList.add('volt-http-auto-show-step');
		if (step.method || step.url) {
			const line = append(parent, $('.volt-http-auto-source-line'));
			const method = append(line, $('span.volt-http-row-method'));
			method.textContent = step.method ?? '';
			method.dataset.method = (step.method ?? '').toUpperCase();
			append(line, $('span.volt-http-auto-source-url')).textContent = step.url ?? '';
		}
		const facts = append(parent, $('.volt-http-auto-facts'));
		const fact = (label: string, value: string) => {
			const item = append(facts, $('span'));
			append(item, $('span.muted')).textContent = `${label} `;
			append(item, $('span')).textContent = value;
		};
		fact(localize('voltHttp.autoFactStatus', "Result"), STATUS_LABELS[step.status]);
		if (step.statusCode !== undefined) {
			fact(localize('voltHttp.autoFactCode', "Status"), `${step.statusCode}${step.exchange?.response?.statusText ? ` ${step.exchange.response.statusText}` : ''}`);
		}
		if (step.durationMs) {
			fact(localize('voltHttp.autoFactTime', "Time"), formatHttpDuration(step.durationMs));
		}
		if (step.attempts > 1) {
			fact(localize('voltHttp.autoFactAttempts', "Attempts"), String(step.attempts));
		}
		if (run && run.iterations > 1) {
			fact(localize('voltHttp.autoFactIteration', "Iteration"), String(step.iteration + 1));
		}
		if (step.error) {
			const error = append(parent, $('.volt-http-auto-inline-problem'));
			error.classList.toggle('error', step.status !== 'skipped');
			error.textContent = step.error;
		}
		if (step.asserts.length) {
			append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.autoChecks', "Checks");
			const list = append(parent, $('.volt-http-auto-check-results'));
			for (const assert of step.asserts) {
				const line = append(list, $('.volt-http-auto-check-result'));
				line.classList.toggle('failed', !assert.passed);
				const badge = append(line, $('span.volt-http-test-badge'));
				badge.classList.add(assert.passed ? 'pass' : 'fail');
				badge.textContent = assert.passed ? localize('voltHttp.autoPass', "PASS") : localize('voltHttp.autoFail', "FAIL");
				append(line, $('span.volt-http-auto-check-text')).textContent = assert.passed ? assert.label : assert.message;
			}
		}
		if (step.extracted.length) {
			append(parent, $('.volt-http-sublabel')).textContent = step.kind === 'set' ? localize('voltHttp.autoSetValues', "Values set") : localize('voltHttp.autoExtracted', "Extracted");
			renderHttpReadOnlyTable(parent, [localize('voltHttp.autoVariable', "Variable"), localize('voltHttp.autoValue', "Value")], step.extracted.map(item => [item.name, item.found ? cut(item.value ?? '', 400) : `${item.value !== undefined ? `${cut(item.value, 400)} ` : ''}(${item.error ?? localize('voltHttp.autoNotFound', "not found")})`]));
		}
		const exchange = step.exchange;
		if (exchange) {
			append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.autoRequestSent', "Request");
			append(parent, $('pre.volt-http-auto-pre')).textContent = cut([`${exchange.method} ${exchange.url}`, ...exchange.headers.map(([name, value]) => `${name}: ${value}`), ...(exchange.body ? ['', exchange.body] : [])].join('\n'), PREVIEW_CHARS);
			const response = exchange.response;
			append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.autoResponse', "Response");
			if (response) {
				const json = safeJson(response.body);
				const body = json !== undefined ? JSON.stringify(json, undefined, 2) : response.body;
				append(parent, $('pre.volt-http-auto-pre')).textContent = cut([`HTTP ${response.status} ${response.statusText}`, ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`), ...(body ? ['', body] : [])].join('\n'), PREVIEW_CHARS);
			} else {
				append(parent, $('.volt-http-note')).textContent = exchange.error ?? localize('voltHttp.autoNoResponse', "No response.");
			}
		}
	}

	// --- Settings --------------------------------------------------------------------------------

	private renderSettings(): void {
		const flow = this.flow!;
		const store = this.view;
		const page = append(this.body, $('.volt-http-auto-settings'));
		const form = append(page, $('.volt-http-auto-form'));
		const description = append(this.field(form, localize('voltHttp.autoDescription', "Description")), $('textarea.volt-http-textarea.volt-http-auto-description')) as HTMLTextAreaElement;
		description.rows = 2;
		description.value = flow.description;
		description.placeholder = localize('voltHttp.autoDescriptionPlaceholder', "What this flow checks (optional)");
		description.setAttribute('aria-label', localize('voltHttp.autoDescription', "Description"));
		store.add(addDisposableListener(description, EventType.INPUT, () => this.edit(next => next.description = description.value)));

		const number = (label: string, hint: string | undefined, value: number, max: number, set: (flow: IHttpFlow, value: number) => void, min = 0) => {
			this.numberInput(this.field(form, label, hint), value, label, next => this.edit(target => set(target, next)), { min, max, store });
		};
		number(localize('voltHttp.autoIterations', "Iterations"), localize('voltHttp.autoIterationsHint', "Runs the whole flow this many times. A data set runs it once per row instead."), flow.settings.iterations, 1000, (target, value) => target.settings.iterations = Math.max(1, value), 1);
		number(localize('voltHttp.autoDelay', "Delay between requests (ms)"), undefined, flow.settings.delayMs, 600_000, (target, value) => target.settings.delayMs = value);
		number(localize('voltHttp.autoDefaultTimeout', "Request timeout (ms)"), localize('voltHttp.autoDefaultTimeoutHint', "0 leaves the client's own limit."), flow.settings.timeoutMs, 3_600_000, (target, value) => target.settings.timeoutMs = value);
		const behavior = this.field(form, localize('voltHttp.autoRunBehavior', "Run"));
		this.check(behavior, flow.settings.stopOnFailure, localize('voltHttp.autoStopOnFailure', "Stop at the first failure (teardown still runs)"), checked => this.edit(next => next.settings.stopOnFailure = checked), store);
		this.check(behavior, flow.settings.persistVariables, localize('voltHttp.autoPersist', "Keep extracted values in the environment after the run"), checked => this.edit(next => next.settings.persistVariables = checked), store);

		append(page, $('.volt-http-sublabel.volt-http-auto-settings-label')).textContent = localize('voltHttp.autoFlowVariables', "Flow variables");
		append(page, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoFlowVariablesHint', "Every step sees these; extracted values and data columns of the same name replace them during a run.");
		store.add(new HttpKeyValueTable(append(page, $('.volt-http-auto-settings-table')), {
			rows: flow.variables,
			variables: this.host.variables,
			keyLabel: localize('voltHttp.autoVariable', "Variable"),
			valueLabel: localize('voltHttp.autoValue', "Value"),
			onChange: rows => this.edit(next => next.variables = rows),
		}));

		append(page, $('.volt-http-sublabel.volt-http-auto-settings-label')).textContent = localize('voltHttp.autoData', "Data set");
		const data = append(page, $('.volt-http-auto-data'));
		this.renderData(data);
	}

	private renderData(parent: HTMLElement): void {
		const store = new DisposableStore();
		this.view.add(store);
		const redraw = () => {
			store.dispose();
			clearNode(parent);
			this.renderData(parent);
		};
		const flow = this.flow!;
		const mode: DataMode = flow.data?.file !== undefined ? 'file' : flow.data?.rows ? 'rows' : 'none';
		append(parent, $('.volt-http-note.volt-http-auto-lead')).textContent = localize('voltHttp.autoDataHint', "One iteration per row; each column is a {{variable}} in every step (data-driven testing).");
		const form = append(parent, $('.volt-http-auto-form'));
		createHttpDropdown<DataMode>(this.field(form, localize('voltHttp.autoDataSource', "Rows from")), this.contextViewService, {
			options: [
				{ id: 'none', label: localize('voltHttp.autoDataNone', "No data set") },
				{ id: 'rows', label: localize('voltHttp.autoDataRows', "Rows in the flow"), description: localize('voltHttp.autoDataRowsDesc', "Typed below as CSV or JSON") },
				{ id: 'file', label: localize('voltHttp.autoDataFile', "A CSV or JSON file"), description: localize('voltHttp.autoDataFileDesc', "Read when the run starts") },
			],
			value: mode,
			ariaLabel: localize('voltHttp.autoDataSource', "Rows from"),
			onChange: value => {
				this.edit(next => {
					if (value === 'none') {
						delete next.data;
					} else if (value === 'rows') {
						next.data = { rows: next.data?.rows ?? [] };
					} else {
						next.data = { file: next.data?.file ?? '' };
					}
				});
				redraw();
			},
		}, store);
		if (mode === 'rows') {
			const text = append(parent, $('textarea.volt-http-textarea.volt-http-auto-code.volt-http-auto-data-text')) as HTMLTextAreaElement;
			text.rows = 6;
			text.spellcheck = false;
			text.value = rowsToCsv(flow.data?.rows ?? []);
			text.placeholder = 'email,password\nqa1@example.com,{{password}}';
			text.setAttribute('aria-label', localize('voltHttp.autoDataRowsAria', "Data rows as CSV or JSON"));
			const status = append(parent, $('.volt-http-note'));
			store.add(addDisposableListener(text, EventType.CHANGE, () => {
				const value = text.value.trim();
				const parsed = parseHttpFlowData(value, value.startsWith('[') ? 'rows.json' : 'rows.csv');
				status.classList.toggle('error', !!parsed.error);
				status.textContent = parsed.error ?? (parsed.rows.length === 1 ? localize('voltHttp.autoDataOneRow', "1 row") : localize('voltHttp.autoDataRowCount', "{0} rows", parsed.rows.length));
				if (!parsed.error) {
					this.edit(next => next.data = { rows: parsed.rows });
					void this.renderDataPreview(preview);
				}
			}));
		} else if (mode === 'file') {
			const row = append(form, $('.volt-http-auto-field'));
			append(row, $('label.volt-http-auto-field-label')).textContent = localize('voltHttp.autoDataPath', "File");
			const body = append(row, $('.volt-http-auto-field-body'));
			const input = append(body, $('input.volt-http-input.volt-http-auto-input.code')) as HTMLInputElement;
			input.type = 'text';
			input.spellcheck = false;
			input.value = flow.data?.file ?? '';
			input.placeholder = 'users.csv';
			input.setAttribute('aria-label', localize('voltHttp.autoDataPath', "File"));
			store.add(addDisposableListener(input, EventType.CHANGE, () => {
				this.edit(next => next.data = { file: input.value.trim() });
				void this.renderDataPreview(preview);
			}));
			const choose = store.add(createVoltButton(body, 'secondary'));
			choose.label = localize('voltHttp.autoDataChoose', "Choose File");
			store.add(choose.onDidClick(async () => {
				const picked = await this.fileDialogService.showOpenDialog({
					title: localize('voltHttp.autoDataChooseTitle', "Choose a Data File"),
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					defaultUri: dirname(this.uri),
					filters: [{ name: localize('voltHttp.autoDataFilter', "CSV or JSON"), extensions: ['csv', 'json'] }],
				});
				if (!picked?.[0] || this._store.isDisposed) {
					return;
				}
				const file = relativePath(dirname(this.uri), picked[0]) ?? picked[0].fsPath;
				input.value = file;
				this.edit(next => next.data = { file });
				void this.renderDataPreview(preview);
			}));
			append(row, $('.volt-http-auto-field-hint')).textContent = localize('voltHttp.autoDataPathHint', "Relative to the flow file or the project. CSV needs a header row; JSON is a list of objects.");
		}
		const preview = append(parent, $('.volt-http-auto-data-preview'));
		void this.renderDataPreview(preview);
	}

	private async renderDataPreview(parent: HTMLElement): Promise<void> {
		// What is typed goes to the model first: the preview reads what the run will.
		await this.automations.flush(this.uri).catch(() => undefined);
		const data = await this.automations.dataRows(this.uri, this.host.root).catch(err => ({ rows: [] as Record<string, string>[], error: err instanceof Error ? err.message : String(err) }));
		if (this._store.isDisposed || !parent.isConnected) {
			return;
		}
		clearNode(parent);
		const flow = this.flow;
		if (!flow?.data) {
			return;
		}
		if (data.error) {
			if (flow.data.file) {
				append(parent, $('.volt-http-auto-inline-problem.error')).textContent = data.error;
			}
			return;
		}
		if (!data.rows.length) {
			return;
		}
		const columns = [...new Set(data.rows.flatMap(row => Object.keys(row)))].slice(0, 8);
		append(parent, $('.volt-http-note')).textContent = data.rows.length > 5
			? localize('voltHttp.autoDataPreviewMore', "{0} rows, so {0} iterations. The first 5:", data.rows.length)
			: data.rows.length === 1 ? localize('voltHttp.autoDataPreviewOne', "1 row, so 1 iteration.") : localize('voltHttp.autoDataPreview', "{0} rows, so {0} iterations.", data.rows.length);
		renderHttpReadOnlyTable(parent, columns, data.rows.slice(0, 5).map(row => columns.map(column => row[column] ?? '')));
	}
}
