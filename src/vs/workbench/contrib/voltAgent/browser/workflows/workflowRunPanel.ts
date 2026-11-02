/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWorkflowLibrary.css';
import { $, addDisposableListener, append, clearNode, EventHelper, EventType, getWindow, isHTMLElement, isKeyboardEvent, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { ITableColumn, ITableRenderer, ITableVirtualDelegate } from '../../../../../base/browser/ui/table/table.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList, WorkbenchObjectTree, WorkbenchTable } from '../../../../../platform/list/browser/listService.js';
import { getWorkflowNodeType, nodeDisplayName } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowLogEntry, IWorkflowNode, IWorkflowRun, IWorkflowService, IWorkflowStepRecord, IWorkflowTokenUsage, WorkflowApprovalDecision, WorkflowControlKind, WorkflowLogLevel, WorkflowNodeState, WorkflowRunEvent, WorkflowRunStatus, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { iconButton } from '../automations/automationUi.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { WorkflowCodeEditor } from './workflowCodeEditor.js';

/**
 * The builder's executions panel, n8n's Logs panel in Volt's look: a header (tabs, what the run
 * is doing, Stop / Pause / Step), then Steps (every executed node on the left, the picked one's
 * input, output, config, variables and logs on the right), Timeline (a Gantt of the steps),
 * Executions (earlier runs) and Logs. It follows IWorkflowService's run events live: events are
 * batched per animation frame and only the rows that changed are spliced.
 */

//#region Formatting

export function formatRunDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.max(0, Math.round(ms))}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function compactNumber(n: number): string {
	if (n < 1000) {
		return String(Math.round(n));
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatTokens(tokens: IWorkflowTokenUsage | undefined): string | undefined {
	const total = tokens ? tokens.input + tokens.output : 0;
	return total ? localize('voltWorkflows.tokenCount', "{0} tokens", compactNumber(total)) : undefined;
}

export function formatCost(costUsd: number | undefined): string | undefined {
	if (!costUsd) {
		return undefined;
	}
	return costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}

function runTokens(run: IWorkflowRun): IWorkflowTokenUsage | undefined {
	if (run.tokens) {
		return run.tokens;
	}
	let input = 0, output = 0, cost = 0;
	for (const step of run.steps) {
		input += step.tokens?.input ?? 0;
		output += step.tokens?.output ?? 0;
		cost += step.tokens?.costUsd ?? 0;
	}
	return input || output || cost ? { input, output, costUsd: cost || undefined } : undefined;
}

export function isLiveRun(run: Pick<IWorkflowRun, 'status'>): boolean {
	return run.status === 'queued' || run.status === 'running' || run.status === 'paused' || run.status === 'waiting';
}

function stepDuration(step: IWorkflowStepRecord, now: number): number | undefined {
	return step.startedAt === undefined ? undefined : (step.finishedAt ?? now) - step.startedAt;
}

export function stepStateIcon(state: WorkflowNodeState): ThemeIcon {
	switch (state) {
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'success': return Codicon.check;
		case 'failed': return Codicon.close;
		case 'skipped': return Codicon.debugStepOver;
		case 'waiting': return Codicon.watch;
		case 'queued': return Codicon.clock;
		case 'cancelled': return Codicon.debugStop;
		default: return Codicon.circleLargeOutline;
	}
}

function runStatusIcon(status: IWorkflowRun['status']): ThemeIcon {
	switch (status) {
		case 'succeeded': return Codicon.check;
		case 'failed': return Codicon.close;
		case 'cancelled': return Codicon.debugStop;
		case 'paused': return Codicon.debugPause;
		case 'waiting': return Codicon.watch;
		default: return Codicon.circleFilled;
	}
}

function stepStateLabel(state: WorkflowNodeState): string {
	switch (state) {
		case 'running': return localize('voltWorkflows.stateRunning', "Running");
		case 'success': return localize('voltWorkflows.stateSuccess', "Success");
		case 'failed': return localize('voltWorkflows.stateFailed', "Failed");
		case 'skipped': return localize('voltWorkflows.stateSkipped', "Skipped");
		case 'waiting': return localize('voltWorkflows.stateWaiting', "Waiting");
		case 'queued': return localize('voltWorkflows.stateQueued', "Queued");
		case 'cancelled': return localize('voltWorkflows.stateCancelled', "Stopped");
		default: return localize('voltWorkflows.stateIdle', "Not run");
	}
}

export function runStatusLabel(status: WorkflowRunStatus): string {
	switch (status) {
		case 'queued': return localize('voltWorkflows.runQueued', "Queued");
		case 'running': return localize('voltWorkflows.runRunning', "Running");
		case 'paused': return localize('voltWorkflows.runPaused', "Paused");
		case 'waiting': return localize('voltWorkflows.runWaiting', "Waiting");
		case 'succeeded': return localize('voltWorkflows.runSucceeded', "Succeeded");
		case 'failed': return localize('voltWorkflows.runFailed', "Failed");
		case 'cancelled': return localize('voltWorkflows.runCancelled', "Stopped");
	}
}

/** "Succeeded in 1m 51s", "Failed in 7.5s", "Running for 12.4s". */
export function runOutcomeText(run: IWorkflowRun, now: number): string {
	const duration = formatRunDuration((run.finishedAt ?? now) - run.startedAt);
	switch (run.status) {
		case 'succeeded': return localize('voltWorkflows.succeededIn', "Succeeded in {0}", duration);
		case 'failed': return localize('voltWorkflows.failedIn', "Failed in {0}", duration);
		case 'cancelled': return localize('voltWorkflows.stoppedAfter', "Stopped after {0}", duration);
		case 'paused': return localize('voltWorkflows.pausedAfter', "Paused at {0}", duration);
		case 'waiting': return localize('voltWorkflows.waitingFor', "Waiting · {0}", duration);
		case 'queued': return localize('voltWorkflows.queued', "Queued");
		default: return localize('voltWorkflows.runningFor', "Running for {0}", duration);
	}
}

function runTriggerLabel(run: IWorkflowRun): string {
	if (run.trigger.label) {
		return run.trigger.label;
	}
	switch (run.trigger.kind) {
		case 'schedule': return localize('voltWorkflows.triggerSchedule', "Schedule");
		case 'event': return localize('voltWorkflows.triggerEvent', "Event");
		case 'automation': return localize('voltWorkflows.triggerAutomation', "Automation");
		case 'subworkflow': return localize('voltWorkflows.triggerSubworkflow', "Sub-workflow");
		case 'agent': return localize('voltWorkflows.triggerAgent', "Agent");
		default: return localize('voltWorkflows.triggerManual', "Manual");
	}
}

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatRunDate(at: number): string {
	return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** `{{ nodes.fetch.items[0].title }}`: what a template field reads the value at `path` with. */
export function workflowValueTemplate(prefix: readonly (string | number)[], path: readonly (string | number)[]): string {
	let out = '';
	for (const part of [...prefix, ...path]) {
		if (typeof part === 'number') {
			out += `[${part}]`;
		} else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
			out += out ? `.${part}` : part;
		} else {
			out += `[${JSON.stringify(part)}]`;
		}
	}
	return `{{ ${out} }}`;
}

function stringifyValue(value: WorkflowValue | undefined): string {
	if (value === undefined) {
		return '';
	}
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

//#endregion

//#region Value inspector (tree, table, raw JSON)

type ValueMode = 'tree' | 'table' | 'json';

type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

function jsonKind(value: WorkflowValue): JsonKind {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value === 'object' ? 'object' : typeof value as 'string' | 'number' | 'boolean';
}

function kindIcon(kind: JsonKind): ThemeIcon {
	switch (kind) {
		case 'string': return Codicon.symbolString;
		case 'number': return Codicon.symbolNumber;
		case 'boolean': return Codicon.symbolBoolean;
		case 'null': return Codicon.circleSlash;
		case 'array': return Codicon.symbolArray;
		case 'object': return Codicon.symbolObject;
	}
}

function childCount(value: WorkflowValue): number {
	if (Array.isArray(value)) {
		return value.length;
	}
	return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function preview(value: WorkflowValue): string {
	switch (jsonKind(value)) {
		case 'string': return JSON.stringify((value as string).length > 300 ? `${(value as string).slice(0, 300)}…` : value);
		case 'array': return localize('voltWorkflows.items', "[{0} items]", (value as readonly WorkflowValue[]).length);
		case 'object': return localize('voltWorkflows.keys', "{{0} keys}", Object.keys(value as object).length);
		default: return String(value);
	}
}

interface IJsonNode {
	readonly id: string;
	readonly key: string | number | undefined;
	readonly value: WorkflowValue;
	readonly path: readonly (string | number)[];
	/** Stands in for the rest of a long list or object. */
	readonly more?: number;
}

const JSON_ROW_HEIGHT = 22;
const MAX_JSON_CHILDREN = 200;
const MAX_JSON_NODES = 5000;
const MAX_RAW_JSON = 200_000;
const RAW_NOTE_HEIGHT = 22;

function jsonChildren(value: WorkflowValue, path: readonly (string | number)[], scope: string, budget: { left: number }, depth: number): IObjectTreeElement<IJsonNode>[] {
	const entries: [string | number, WorkflowValue][] = Array.isArray(value)
		? value.map((child, index) => [index, child])
		: Object.entries(value as { [key: string]: WorkflowValue });
	const shown = entries.slice(0, Math.max(0, Math.min(MAX_JSON_CHILDREN, budget.left)));
	const result: IObjectTreeElement<IJsonNode>[] = shown.map(([key, child]) => {
		budget.left--;
		const childPath = [...path, key];
		const count = childCount(child);
		return {
			element: { id: `${scope}|${JSON.stringify(childPath)}`, key, value: child, path: childPath },
			children: count && budget.left > 0 ? jsonChildren(child, childPath, scope, budget, depth + 1) : undefined,
			collapsible: count > 0,
			// The first level opens when it is small; what the user opened or closed stays that way.
			collapsed: depth === 0 && count <= 12 ? ObjectTreeElementCollapseState.PreserveOrExpanded : ObjectTreeElementCollapseState.PreserveOrCollapsed,
		};
	});
	if (entries.length > shown.length) {
		result.push({ element: { id: `${scope}|${JSON.stringify(path)}|more`, key: undefined, value: null, path, more: entries.length - shown.length } });
	}
	return result;
}

interface IJsonTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly key: HTMLElement;
	readonly value: HTMLElement;
	readonly copyValue: HTMLElement;
	readonly copyPath: HTMLElement;
	readonly store: DisposableStore;
	readonly ref: { current?: IJsonNode };
}

class JsonRenderer implements ITreeRenderer<IJsonNode, void, IJsonTemplate> {
	static readonly ID = 'voltWorkflowJson';
	readonly templateId = JsonRenderer.ID;

	constructor(private readonly onCopy: (node: IJsonNode, what: 'value' | 'path') => void) { }

	renderTemplate(container: HTMLElement): IJsonTemplate {
		const store = new DisposableStore();
		const ref: IJsonTemplate['ref'] = {};
		const row = append(container, $('.volt-wf-json-row'));
		const icon = append(row, $('span.volt-wf-json-icon'));
		const key = append(row, $('span.volt-wf-json-key'));
		const value = append(row, $('span.volt-wf-json-value'));
		const actions = append(row, $('span.volt-wf-json-actions'));
		const action = (glyph: ThemeIcon, label: string, what: 'value' | 'path') => {
			const element = append(actions, $('span.volt-wf-json-action'));
			element.setAttribute('role', 'button');
			element.setAttribute('aria-label', label);
			element.appendChild(renderIcon(glyph));
			setAgentTooltip(element, label);
			// The tree toggles rows on pointer events: the action keeps them to itself.
			for (const type of [EventType.MOUSE_DOWN, EventType.POINTER_DOWN, EventType.MOUSE_UP, EventType.DBLCLICK]) {
				store.add(addDisposableListener(element, type, e => EventHelper.stop(e, true)));
			}
			store.add(addDisposableListener(element, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				if (ref.current) {
					this.onCopy(ref.current, what);
				}
			}));
			return element;
		};
		const copyValue = action(Codicon.copy, localize('voltWorkflows.copyValue', "Copy value"), 'value');
		const copyPath = action(Codicon.bracket, localize('voltWorkflows.copyPath', "Copy as {{ }} path"), 'path');
		return { row, icon, key, value, copyValue, copyPath, store, ref };
	}

	renderElement(node: ITreeNode<IJsonNode, void>, _index: number, template: IJsonTemplate): void {
		const element = node.element;
		template.ref.current = element;
		template.icon.replaceChildren();
		template.row.classList.toggle('more', !!element.more);
		if (element.more) {
			template.key.textContent = '';
			template.value.textContent = localize('voltWorkflows.moreItems', "{0} more not shown", element.more);
			template.value.className = 'volt-wf-json-value muted';
			template.copyValue.style.display = 'none';
			template.copyPath.style.display = 'none';
			return;
		}
		const kind = jsonKind(element.value);
		template.icon.appendChild(renderIcon(kindIcon(kind)));
		template.icon.className = `volt-wf-json-icon kind-${kind}`;
		template.key.textContent = element.key === undefined ? '' : typeof element.key === 'number' ? `[${element.key}]` : element.key;
		template.key.classList.toggle('index', typeof element.key === 'number');
		template.value.textContent = preview(element.value);
		template.value.className = `volt-wf-json-value kind-${kind}`;
		template.copyValue.style.display = '';
		template.copyPath.style.display = element.path.length ? '' : 'none';
		if (kind === 'string' && (element.value as string).length > 60) {
			setAgentTooltip(template.value, (element.value as string).slice(0, 2000));
		} else {
			setAgentTooltip(template.value, undefined);
		}
	}

	disposeElement(_node: ITreeNode<IJsonNode, void>, _index: number, template: IJsonTemplate): void {
		template.ref.current = undefined;
	}

	disposeTemplate(template: IJsonTemplate): void {
		template.store.dispose();
	}
}

interface ITableRow {
	readonly index: number;
	readonly value: WorkflowValue;
}

/** One table column: each reads its own key of the row. */
class CellRenderer implements ITableRenderer<ITableRow, HTMLElement> {

	constructor(readonly templateId: string, private readonly read: (row: ITableRow) => WorkflowValue | undefined) { }

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('span.volt-wf-cell'));
	}

	renderElement(row: ITableRow, _index: number, element: HTMLElement): void {
		const value = this.read(row);
		if (value === undefined) {
			element.textContent = '';
			element.className = 'volt-wf-cell';
			return;
		}
		const kind = jsonKind(value);
		element.textContent = kind === 'string' ? value as string : kind === 'array' || kind === 'object' ? JSON.stringify(value) : String(value);
		element.className = `volt-wf-cell kind-${kind}`;
	}

	disposeTemplate(): void { }
}

/** Arrays of objects (or one object) as rows and columns; undefined when the value is not tabular. */
function tableOf(value: WorkflowValue | undefined): { readonly rows: ITableRow[]; readonly columns: string[] } | undefined {
	if (value === undefined || value === null || typeof value !== 'object') {
		return undefined;
	}
	const items: readonly WorkflowValue[] = Array.isArray(value) ? value : [value];
	if (!items.length) {
		return undefined;
	}
	const columns: string[] = [];
	const seen = new Set<string>();
	let objects = 0;
	for (const item of items.slice(0, 200)) {
		if (item && typeof item === 'object' && !Array.isArray(item)) {
			objects++;
			for (const key of Object.keys(item)) {
				if (!seen.has(key) && columns.length < 24) {
					seen.add(key);
					columns.push(key);
				}
			}
		}
	}
	return { rows: items.slice(0, 2000).map((item, index) => ({ index, value: item })), columns: objects ? columns : [] };
}

interface IInspectorHooks {
	copy(text: string, label: string): void;
	menu(anchor: HTMLElement | { x: number; y: number }, node: IJsonNode): void;
}

/** One value as a JSON explorer (typed glyphs, folding, copy), a table, or read-only raw JSON. */
class ValueInspector extends Disposable {

	readonly element: HTMLElement;
	private readonly treeHost: HTMLElement;
	private readonly tableHost: HTMLElement;
	private readonly jsonHost: HTMLElement;
	/** The JSON view: a read-only editor, made the first time it shows. */
	private raw: WorkflowCodeEditor | undefined;
	private readonly rawNote: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly tree: WorkbenchObjectTree<IJsonNode, void>;
	private readonly table = this._register(new MutableDisposable<WorkbenchTable<ITableRow>>());
	private tableSignature = '';
	private mode: ValueMode = 'tree';
	private value: WorkflowValue | undefined;
	private scope = '';
	private emptyText = '';
	private width = 0;
	private height = 0;
	private renderedKey: { value: WorkflowValue | undefined; mode: ValueMode; scope: string } | undefined;

	constructor(
		parent: HTMLElement,
		private readonly hooks: IInspectorHooks,
		private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(parent, $('.volt-wf-inspector'));
		this.treeHost = append(this.element, $('.volt-wf-json-tree'));
		this.tableHost = append(this.element, $('.volt-wf-json-table'));
		this.jsonHost = append(this.element, $('.volt-wf-json-raw'));
		this.rawNote = $('.volt-wf-json-raw-note.hidden');
		this.empty = append(this.element, $('.volt-wf-run-empty.small'));
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<IJsonNode, void>,
			'VoltWorkflowValue',
			this.treeHost,
			{ getHeight: () => JSON_ROW_HEIGHT, getTemplateId: () => JsonRenderer.ID },
			[new JsonRenderer((node, what) => this.copy(node, what))],
			{
				identityProvider: { getId: node => node.id },
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				indent: 14,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('voltWorkflows.valueAria', "Value"),
					getAriaLabel: node => node.more ? localize('voltWorkflows.moreItems', "{0} more not shown", node.more) : `${node.key ?? ''} ${preview(node.value)}`,
				},
			},
		));
		this._register(this.tree.onContextMenu(e => {
			if (e.element && !e.element.more) {
				EventHelper.stop(e.browserEvent, true);
				const anchor = e.anchor;
				this.hooks.menu(isHTMLElement(anchor) ? anchor : { x: anchor.posx, y: anchor.posy }, e.element);
			}
		}));
	}

	/** The scope prefixes copied paths (`nodes.fetch`). */
	private prefix: readonly (string | number)[] = [];

	set(value: WorkflowValue | undefined, scope: string, prefix: readonly (string | number)[], emptyText: string): void {
		this.value = value;
		this.scope = scope;
		this.prefix = prefix;
		this.emptyText = emptyText;
		this.render();
	}

	setMode(mode: ValueMode): void {
		if (mode !== this.mode) {
			this.mode = mode;
			this.render();
		}
	}

	get currentMode(): ValueMode {
		return this.mode;
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.element.style.height = `${height}px`;
		if (this.mode === 'tree') {
			this.tree.layout(height, width);
		} else if (this.mode === 'table' && this.table.value) {
			this.table.value.layout(height, width);
		} else if (this.mode === 'json') {
			this.raw?.setHeight(this.rawHeight());
		}
	}

	private rawHeight(): number {
		return Math.max(0, this.height - (this.rawNote.classList.contains('hidden') ? 0 : RAW_NOTE_HEIGHT));
	}

	private copy(node: IJsonNode, what: 'value' | 'path'): void {
		if (what === 'path') {
			this.hooks.copy(workflowValueTemplate(this.prefix, node.path), localize('voltWorkflows.copiedPath', "Path copied"));
		} else {
			this.hooks.copy(stringifyValue(node.value), localize('voltWorkflows.copiedValue', "Value copied"));
		}
	}

	copyNode(node: IJsonNode, what: 'value' | 'path'): void {
		this.copy(node, what);
	}

	private render(): void {
		const key = { value: this.value, mode: this.mode, scope: this.scope };
		if (this.renderedKey && this.renderedKey.value === key.value && this.renderedKey.mode === key.mode && this.renderedKey.scope === key.scope) {
			return;
		}
		this.renderedKey = key;
		const value = this.value;
		const show = (part: 'tree' | 'table' | 'json' | 'empty') => {
			this.treeHost.style.display = part === 'tree' ? '' : 'none';
			this.tableHost.style.display = part === 'table' ? '' : 'none';
			this.jsonHost.style.display = part === 'json' ? '' : 'none';
			this.empty.style.display = part === 'empty' ? '' : 'none';
		};
		if (value === undefined) {
			this.empty.textContent = this.emptyText;
			show('empty');
			this.tree.setChildren(null, []);
			return;
		}
		if (this.mode === 'json') {
			show('json');
			this.renderRaw(value);
			return;
		}
		if (this.mode === 'table') {
			const table = tableOf(value);
			if (!table) {
				this.empty.textContent = localize('voltWorkflows.notTabular', "A single value has no table. Use the tree or JSON view.");
				show('empty');
				return;
			}
			show('table');
			this.renderTable(table);
			return;
		}
		show('tree');
		const budget = { left: MAX_JSON_NODES };
		const children: IObjectTreeElement<IJsonNode>[] = childCount(value)
			? jsonChildren(value, [], this.scope, budget, 0)
			: [{ element: { id: `${this.scope}|root`, key: undefined, value, path: [] } }];
		this.tree.setChildren(null, children);
		this.tree.layout(this.height, this.width);
	}

	private renderTable(table: { readonly rows: ITableRow[]; readonly columns: string[] }): void {
		const signature = `${this.scope}|${table.columns.join('\u0000')}`;
		if (!this.table.value || signature !== this.tableSignature) {
			this.table.clear();
			clearNode(this.tableHost);
			this.tableSignature = signature;
			const delegate: ITableVirtualDelegate<ITableRow> = { headerRowHeight: 24, getHeight: () => 24 };
			const field = (key: string) => (row: ITableRow) => row.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as { [key: string]: WorkflowValue })[key] : undefined;
			const cells: { readonly label: string; readonly read: (row: ITableRow) => WorkflowValue | undefined; readonly index?: boolean }[] = [
				{ label: '#', read: row => row.index, index: true },
				...(table.columns.length
					? table.columns.map(column => ({ label: column, read: field(column) }))
					: [{ label: localize('voltWorkflows.valueColumn', "value"), read: (row: ITableRow) => row.value }]),
			];
			const columns: ITableColumn<ITableRow, ITableRow>[] = cells.map((cell, i) => ({
				label: cell.label,
				tooltip: cell.label,
				weight: cell.index ? 0 : 1,
				minimumWidth: cell.index ? 36 : 60,
				...(cell.index ? { maximumWidth: 48 } : {}),
				templateId: `cell${i}`,
				project: row => row,
			}));
			const renderers = cells.map((cell, i) => new CellRenderer(`cell${i}`, cell.read));
			this.table.value = this.instantiationService.createInstance(WorkbenchTable<ITableRow>, 'VoltWorkflowTable', this.tableHost, delegate, columns, renderers, {
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('voltWorkflows.tableAria', "Value as a table"),
					getAriaLabel: (row: ITableRow) => `${row.index}: ${preview(row.value)}`,
				},
			});
		}
		const widget = this.table.value;
		widget.splice(0, widget.length, table.rows);
		widget.layout(this.height, this.width);
	}

	private renderRaw(value: WorkflowValue): void {
		let text = JSON.stringify(value, null, 2) ?? '';
		const cut = text.length > MAX_RAW_JSON;
		if (cut) {
			text = text.slice(0, MAX_RAW_JSON);
		}
		this.rawNote.classList.toggle('hidden', !cut);
		this.rawNote.textContent = cut ? localize('voltWorkflows.truncated', "cut at {0} KB", Math.round(MAX_RAW_JSON / 1000)) : '';
		if (!this.raw) {
			this.raw = this._register(this.instantiationService.createInstance(WorkflowCodeEditor, this.jsonHost, { value: text, language: 'json', readOnly: true, ariaLabel: localize('voltWorkflows.jsonView', "JSON"), height: this.rawHeight() }));
			this.jsonHost.appendChild(this.rawNote);
		} else {
			this.raw.setValue(text);
		}
		this.raw.setHeight(this.rawHeight());
	}
}

//#endregion

//#region Logs list

const LOG_ROW_HEIGHT = 22;

interface ILogTemplate {
	readonly time: HTMLElement;
	readonly level: HTMLElement;
	readonly node: HTMLElement;
	readonly message: HTMLElement;
}

class LogRenderer implements IListRenderer<IWorkflowLogEntry, ILogTemplate> {
	static readonly ID = 'voltWorkflowLog';
	readonly templateId = LogRenderer.ID;

	constructor(private readonly nodeName: (nodeId: string) => string, private readonly runStart: () => number | undefined) { }

	renderTemplate(container: HTMLElement): ILogTemplate {
		const row = append(container, $('.volt-wf-log-row'));
		return {
			time: append(row, $('span.volt-wf-log-time')),
			level: append(row, $('span.volt-wf-log-level')),
			node: append(row, $('span.volt-wf-log-node')),
			message: append(row, $('span.volt-wf-log-message')),
		};
	}

	renderElement(entry: IWorkflowLogEntry, _index: number, template: ILogTemplate): void {
		const start = this.runStart();
		template.time.textContent = start !== undefined ? `+${formatRunDuration(entry.at - start)}` : formatClock(entry.at);
		setAgentTooltip(template.time, formatClock(entry.at));
		template.level.textContent = entry.level.toUpperCase();
		template.level.className = `volt-wf-log-level level-${entry.level}`;
		template.node.textContent = entry.nodeId ? this.nodeName(entry.nodeId) : '';
		template.node.style.display = entry.nodeId ? '' : 'none';
		const firstLine = entry.message.split('\n', 1)[0];
		template.message.textContent = firstLine;
		template.message.className = `volt-wf-log-message level-${entry.level}`;
		setAgentTooltip(template.message, entry.message.length > 80 || firstLine !== entry.message ? entry.message.slice(0, 4000) : undefined);
	}

	disposeTemplate(): void { }
}

/** Run logs as a list that keeps up with the run: new entries are appended, and it tails while at the bottom. */
class LogList extends Disposable {

	readonly element: HTMLElement;
	private readonly list: WorkbenchList<IWorkflowLogEntry>;
	private rows: IWorkflowLogEntry[] = [];
	private runId: string | undefined;
	private filterKey = '';
	private processed = 0;
	private height = 0;

	constructor(
		parent: HTMLElement,
		nodeName: (nodeId: string) => string,
		runStart: () => number | undefined,
		onOpen: (entry: IWorkflowLogEntry) => void,
		instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(parent, $('.volt-wf-log-list'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<IWorkflowLogEntry>, 'VoltWorkflowLogs', this.element, {
			getHeight: () => LOG_ROW_HEIGHT,
			getTemplateId: () => LogRenderer.ID,
		} satisfies IListVirtualDelegate<IWorkflowLogEntry>, [new LogRenderer(nodeName, runStart)], {
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltWorkflows.logsAria', "Run logs"),
				getAriaLabel: (entry: IWorkflowLogEntry) => `${entry.level} ${entry.nodeId ? nodeName(entry.nodeId) : ''} ${entry.message}`,
			},
		}));
		this._register(this.list.onDidOpen(e => e.element && onOpen(e.element)));
	}

	get length(): number {
		return this.rows.length;
	}

	set(runId: string | undefined, logs: readonly IWorkflowLogEntry[], filter: (entry: IWorkflowLogEntry) => boolean, filterKey: string): void {
		const atBottom = this.list.scrollTop + this.list.renderHeight >= this.list.scrollHeight - LOG_ROW_HEIGHT;
		if (runId !== this.runId || filterKey !== this.filterKey || logs.length < this.processed) {
			this.runId = runId;
			this.filterKey = filterKey;
			this.rows = logs.filter(filter);
			this.processed = logs.length;
			this.list.splice(0, this.list.length, this.rows);
		} else if (logs.length > this.processed) {
			const added = logs.slice(this.processed).filter(filter);
			this.processed = logs.length;
			if (added.length) {
				this.list.splice(this.rows.length, 0, added);
				this.rows.push(...added);
			}
		} else {
			return;
		}
		if (atBottom && this.rows.length && this.height) {
			this.list.reveal(this.rows.length - 1);
		}
	}

	layout(width: number, height: number): void {
		this.height = height;
		this.element.style.height = `${height}px`;
		this.list.layout(height, width);
	}
}

//#endregion

//#region Steps and executions lists

const STEP_ROW_HEIGHT = 28;
const EXEC_ROW_HEIGHT = 46;

interface INodeInfo {
	readonly name: string;
	readonly typeLabel: string;
	readonly icon: ThemeIcon;
	readonly control?: WorkflowControlKind;
	readonly node?: IWorkflowNode;
}

interface IStepTemplate {
	readonly row: HTMLElement;
	readonly state: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly badge: HTMLElement;
	readonly tokens: HTMLElement;
	readonly duration: HTMLElement;
}

class StepRenderer implements IListRenderer<IWorkflowStepRecord, IStepTemplate> {
	static readonly ID = 'voltWorkflowStep';
	readonly templateId = StepRenderer.ID;

	constructor(private readonly info: (nodeId: string) => INodeInfo) { }

	renderTemplate(container: HTMLElement): IStepTemplate {
		const row = append(container, $('.volt-wf-step-row'));
		return {
			row,
			state: append(row, $('span.volt-wf-step-state')),
			icon: append(row, $('span.volt-wf-step-icon')),
			name: append(row, $('span.volt-wf-step-name')),
			badge: append(row, $('span.volt-wf-step-badge')),
			tokens: append(row, $('span.volt-wf-step-tokens')),
			duration: append(row, $('span.volt-wf-step-duration')),
		};
	}

	renderElement(step: IWorkflowStepRecord, _index: number, template: IStepTemplate): void {
		const info = this.info(step.nodeId);
		template.row.className = `volt-wf-step-row state-${step.state}`;
		template.state.replaceChildren(renderIcon(stepStateIcon(step.state)));
		setAgentTooltip(template.state, stepStateLabel(step.state));
		template.icon.replaceChildren(renderIcon(info.icon));
		template.name.textContent = info.name;
		const badges = [
			step.iteration !== undefined ? `#${step.iteration + 1}` : '',
			step.attempt > 1 ? `\u21BB${step.attempt}` : '',
		].filter(Boolean).join(' ');
		template.badge.textContent = badges;
		template.badge.style.display = badges ? '' : 'none';
		template.tokens.textContent = step.tokens ? compactNumber(step.tokens.input + step.tokens.output) : '';
		setAgentTooltip(template.tokens, formatTokens(step.tokens));
		const duration = stepDuration(step, Date.now());
		template.duration.textContent = duration === undefined ? '' : formatRunDuration(duration);
		if (step.state === 'running' || step.state === 'waiting') {
			template.duration.dataset.liveStart = String(step.startedAt ?? '');
		} else {
			delete template.duration.dataset.liveStart;
		}
	}

	disposeTemplate(): void { }
}

interface IExecTemplate {
	readonly row: HTMLElement;
	readonly state: HTMLElement;
	readonly date: HTMLElement;
	readonly mode: HTMLElement;
	readonly outcome: HTMLElement;
	readonly trigger: HTMLElement;
	readonly retry: HTMLElement;
	readonly store: DisposableStore;
	readonly ref: { current?: IWorkflowRun };
}

class ExecutionRenderer implements IListRenderer<IWorkflowRun, IExecTemplate> {
	static readonly ID = 'voltWorkflowExecution';
	readonly templateId = ExecutionRenderer.ID;

	constructor(private readonly onRetry: (run: IWorkflowRun) => void) { }

	renderTemplate(container: HTMLElement): IExecTemplate {
		const store = new DisposableStore();
		const ref: IExecTemplate['ref'] = {};
		const row = append(container, $('.volt-wf-exec-row'));
		const state = append(row, $('span.volt-wf-exec-state'));
		const main = append(row, $('span.volt-wf-exec-main'));
		const top = append(main, $('span.volt-wf-exec-line'));
		const date = append(top, $('span.volt-wf-exec-date'));
		const mode = append(top, $('span.volt-wf-badge'));
		const bottom = append(main, $('span.volt-wf-exec-line'));
		const outcome = append(bottom, $('span.volt-wf-exec-outcome'));
		const trigger = append(bottom, $('span.volt-wf-exec-trigger'));
		const retry = append(row, $('span.volt-wf-row-action'));
		retry.setAttribute('role', 'button');
		retry.appendChild(renderIcon(Codicon.debugRestart));
		const label = localize('voltWorkflows.retryRun', "Retry from the failed step");
		retry.setAttribute('aria-label', label);
		setAgentTooltip(retry, label);
		for (const type of [EventType.MOUSE_DOWN, EventType.POINTER_DOWN, EventType.MOUSE_UP, EventType.DBLCLICK]) {
			store.add(addDisposableListener(retry, type, e => EventHelper.stop(e, true)));
		}
		store.add(addDisposableListener(retry, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			if (ref.current) {
				this.onRetry(ref.current);
			}
		}));
		return { row, state, date, mode, outcome, trigger, retry, store, ref };
	}

	renderElement(run: IWorkflowRun, _index: number, template: IExecTemplate): void {
		template.ref.current = run;
		template.row.className = `volt-wf-exec-row status-${run.status}`;
		template.state.replaceChildren(renderIcon(runStatusIcon(run.status)));
		setAgentTooltip(template.state, runStatusLabel(run.status));
		template.date.textContent = formatRunDate(run.startedAt);
		template.mode.textContent = run.mode === 'simulate' ? localize('voltWorkflows.simulation', "Simulation") : localize('voltWorkflows.realRun', "Run");
		template.mode.className = `volt-wf-badge mode-${run.mode}`;
		template.outcome.textContent = runOutcomeText(run, Date.now());
		if (run.status === 'running') {
			template.outcome.dataset.liveRun = String(run.startedAt);
		} else {
			delete template.outcome.dataset.liveRun;
		}
		template.trigger.textContent = runTriggerLabel(run);
		setAgentTooltip(template.outcome, run.error);
		template.retry.style.display = run.status === 'failed' && run.steps.some(step => step.state === 'failed') ? '' : 'none';
	}

	disposeElement(_run: IWorkflowRun, _index: number, template: IExecTemplate): void {
		template.ref.current = undefined;
	}

	disposeTemplate(template: IExecTemplate): void {
		template.store.dispose();
	}
}

//#endregion

//#region Step detail

/** A tab strip's underline under its active tab; it slides once it has a first position (no swoop in from 0). */
export function placeTabIndicator(indicator: HTMLElement, active: HTMLElement | undefined): void {
	if (!active?.offsetWidth) {
		return;
	}
	indicator.style.width = `${active.offsetWidth}px`;
	indicator.style.transform = `translateX(${active.offsetLeft}px)`;
	if (!indicator.classList.contains('placed')) {
		getWindow(indicator).requestAnimationFrame(() => indicator.classList.add('placed'));
	}
}

type StepView = 'input' | 'output' | 'config' | 'variables' | 'logs';

interface IStepDetailHost {
	info(nodeId: string): INodeInfo;
	inputPrefix(nodeId: string): readonly (string | number)[];
	retry(run: IWorkflowRun, nodeId: string): void;
	runNode(nodeId: string): void;
	openChat(threadId: string): void;
	resolveApproval(run: IWorkflowRun, nodeId: string, decision: WorkflowApprovalDecision): void;
	copy(text: string, label: string): void;
	valueMenu(anchor: HTMLElement | { x: number; y: number }, node: IJsonNode, inspector: ValueInspector): void;
	openLog(entry: IWorkflowLogEntry): void;
}

let lastStepView: StepView = 'output';
let lastValueMode: ValueMode = 'tree';

/** The picked step: what ran, how it went, and its input, output, config, variables and logs. */
class StepDetail extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLElement;
	private readonly alert: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly indicator: HTMLElement;
	private readonly content: HTMLElement;
	private readonly placeholder: HTMLElement;
	private readonly inspector: ValueInspector;
	private readonly logs: LogList;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly viewButtons = new Map<StepView, HTMLElement>();
	private readonly modeButtons = new Map<ValueMode, HTMLElement>();
	private view: StepView = lastStepView;
	private run: IWorkflowRun | undefined;
	private step: IWorkflowStepRecord | undefined;
	private nodeId: string | undefined;
	private width = 0;
	private height = 0;
	private variables: { readonly source: readonly unknown[]; readonly value: WorkflowValue } | undefined;

	constructor(parent: HTMLElement, private readonly host: IStepDetailHost, instantiationService: IInstantiationService) {
		super();
		this.element = append(parent, $('.volt-wf-step-detail'));
		this.head = append(this.element, $('.volt-wf-step-head'));
		this.alert = append(this.element, $('.volt-wf-step-alert'));
		this.toolbar = append(this.element, $('.volt-wf-step-toolbar'));
		const store = this._register(new DisposableStore());
		const views = append(this.toolbar, $('.volt-wf-seg'));
		views.setAttribute('role', 'tablist');
		const viewLabels: [StepView, string][] = [
			['input', localize('voltWorkflows.input', "Input")],
			['output', localize('voltWorkflows.output', "Output")],
			['config', localize('voltWorkflows.config', "Config")],
			['variables', localize('voltWorkflows.variables', "Variables")],
			['logs', localize('voltWorkflows.logs', "Logs")],
		];
		for (const [view, label] of viewLabels) {
			const element = append(views, $('button.volt-wf-seg-item')) as HTMLButtonElement;
			element.type = 'button';
			element.setAttribute('role', 'tab');
			element.textContent = label;
			store.add(addDisposableListener(element, EventType.CLICK, () => this.setView(view)));
			this.viewButtons.set(view, element);
		}
		this.indicator = append(views, $('.volt-wf-seg-indicator'));
		append(this.toolbar, $('span.volt-auto-spacer'));
		const modes = append(this.toolbar, $('.volt-wf-modes'));
		const modeLabels: [ValueMode, ThemeIcon, string][] = [
			['tree', Codicon.listTree, localize('voltWorkflows.modeTree', "Schema")],
			['table', Codicon.table, localize('voltWorkflows.modeTable', "Table")],
			['json', Codicon.json, localize('voltWorkflows.modeJson', "JSON")],
		];
		for (const [mode, icon, label] of modeLabels) {
			const element = iconButton(modes, icon, label, store, () => this.setMode(mode), 'volt-auto-icon-button.volt-wf-mode');
			this.modeButtons.set(mode, element);
		}
		this.content = append(this.element, $('.volt-wf-step-content'));
		this.placeholder = append(this.content, $('.volt-wf-run-empty.small'));
		this.inspector = this._register(new ValueInspector(this.content, {
			copy: (text, label) => this.host.copy(text, label),
			menu: (anchor, node) => this.host.valueMenu(anchor, node, this.inspector),
		}, instantiationService));
		this.inspector.setMode(lastValueMode);
		this.logs = this._register(new LogList(this.content, nodeId => this.host.info(nodeId).name, () => this.run?.startedAt, entry => this.host.openLog(entry), instantiationService));
		this.syncToolbar();
		this.renderHead();
		this.renderContent();
	}

	get shownStep(): IWorkflowStepRecord | undefined {
		return this.step;
	}

	/** `step` undefined with a `nodeId`: that node did not run in this run. */
	render(run: IWorkflowRun | undefined, step: IWorkflowStepRecord | undefined, nodeId: string | undefined): void {
		const target = step?.nodeId ?? nodeId;
		// The head holds buttons: redrawn only when the step itself changed, never per run event, so clicks land.
		const headChanged = step !== this.step || target !== this.nodeId || run?.id !== this.run?.id;
		this.run = run;
		this.step = step;
		this.nodeId = target;
		if (headChanged) {
			this.renderHead();
		}
		this.renderContent();
		this.layoutContent();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.placeIndicator();
		this.layoutContent();
	}

	/** Durations of a running step move every tick. */
	tick(now: number): void {
		const meta = this.head.querySelector<HTMLElement>('[data-live-start]');
		if (meta && this.step) {
			meta.textContent = this.metaText(this.step, now);
		}
	}

	private setView(view: StepView): void {
		this.view = lastStepView = view;
		this.syncToolbar();
		this.renderContent();
		this.layoutContent();
	}

	private setMode(mode: ValueMode): void {
		lastValueMode = mode;
		this.inspector.setMode(mode);
		this.syncToolbar();
		this.layoutContent();
	}

	private syncToolbar(): void {
		for (const [view, element] of this.viewButtons) {
			element.classList.toggle('active', view === this.view);
			element.setAttribute('aria-selected', String(view === this.view));
		}
		for (const [mode, element] of this.modeButtons) {
			element.classList.toggle('active', mode === this.inspector.currentMode);
		}
		this.toolbar.querySelector<HTMLElement>('.volt-wf-modes')!.style.visibility = this.view === 'logs' ? 'hidden' : '';
		this.placeIndicator();
	}

	private placeIndicator(): void {
		placeTabIndicator(this.indicator, this.viewButtons.get(this.view));
	}

	private metaText(step: IWorkflowStepRecord, now: number): string {
		const duration = stepDuration(step, now);
		const parts = [
			duration === undefined ? stepStateLabel(step.state) : localize('voltWorkflows.stateIn', "{0} in {1}", stepStateLabel(step.state), formatRunDuration(duration)),
			step.tokens ? `~${formatTokens(step.tokens)}` : undefined,
			formatCost(step.tokens?.costUsd),
			step.attempt > 1 ? localize('voltWorkflows.attempt', "attempt {0}", step.attempt) : undefined,
			step.iteration !== undefined ? localize('voltWorkflows.iteration', "pass {0}", step.iteration + 1) : undefined,
			step.port ? localize('voltWorkflows.leftThrough', "→ {0}", step.port) : undefined,
		];
		return parts.filter(Boolean).join(' · ');
	}

	private renderHead(): void {
		this.renderStore.clear();
		clearNode(this.head);
		clearNode(this.alert);
		this.alert.style.display = 'none';
		const run = this.run;
		const step = this.step;
		const nodeId = this.nodeId;
		this.element.classList.toggle('empty', !nodeId);
		if (!nodeId) {
			return;
		}
		const info = this.host.info(nodeId);
		const state = step?.state ?? 'idle';
		append(this.head, $(`span.volt-wf-step-state.state-${state}`)).appendChild(renderIcon(stepStateIcon(state)));
		append(this.head, $('span.volt-wf-step-icon')).appendChild(renderIcon(info.icon));
		const title = append(this.head, $('span.volt-wf-step-title'));
		title.textContent = info.name;
		setAgentTooltip(title, `${info.name} · ${info.typeLabel} (${nodeId})`);
		const meta = append(this.head, $(`span.volt-wf-step-meta.state-${state}`));
		if (step) {
			meta.textContent = this.metaText(step, Date.now());
			if (step.state === 'running' || step.state === 'waiting') {
				meta.dataset.liveStart = String(step.startedAt ?? '');
			}
		} else {
			meta.textContent = localize('voltWorkflows.didNotRun', "Did not run in this execution");
		}
		append(this.head, $('span.volt-auto-spacer'));
		const actions = append(this.head, $('.volt-wf-step-actions'));
		if (step?.threadId) {
			const threadId = step.threadId;
			iconButton(actions, Codicon.commentDiscussion, localize('voltWorkflows.openChat', "Open the agent's chat"), this.renderStore, () => this.host.openChat(threadId));
		}
		if (info.node) {
			iconButton(actions, Codicon.play, step ? localize('voltWorkflows.runAgain', "Run this step again") : localize('voltWorkflows.runThisStep', "Run this step"), this.renderStore, () => this.host.runNode(nodeId));
		}
		if (!run || !step) {
			return;
		}
		if (step.error) {
			this.alert.style.display = '';
			this.alert.className = 'volt-wf-step-alert error';
			const text = append(this.alert, $('.volt-wf-alert-text'));
			append(text, $('span.volt-wf-alert-icon')).appendChild(renderIcon(Codicon.error));
			append(text, $('span.volt-wf-alert-message')).textContent = step.error;
			const buttons = append(this.alert, $('.volt-wf-alert-actions'));
			this.smallButton(buttons, localize('voltWorkflows.retryStep', "Retry step"), Codicon.debugRestart, () => this.host.retry(this.run ?? run, step.nodeId), 'primary');
			if (step.threadId) {
				const threadId = step.threadId;
				this.smallButton(buttons, localize('voltWorkflows.openChatShort', "Open chat"), Codicon.commentDiscussion, () => this.host.openChat(threadId));
			}
			this.smallButton(buttons, localize('voltWorkflows.copyError', "Copy error"), Codicon.copy, () => this.host.copy(step.error ?? '', localize('voltWorkflows.copiedError', "Error copied")));
		} else if (step.state === 'waiting' && (info.control === 'approval' || /approv/i.test(step.waitingFor ?? ''))) {
			this.alert.style.display = '';
			this.alert.className = 'volt-wf-step-alert waiting';
			const text = append(this.alert, $('.volt-wf-alert-text'));
			append(text, $('span.volt-wf-alert-icon')).appendChild(renderIcon(Codicon.watch));
			append(text, $('span.volt-wf-alert-message')).textContent = step.waitingFor ?? localize('voltWorkflows.waitingApproval', "Waiting for approval");
			const buttons = append(this.alert, $('.volt-wf-alert-actions'));
			this.smallButton(buttons, localize('voltWorkflows.approve', "Approve"), Codicon.check, () => this.host.resolveApproval(this.run ?? run, step.nodeId, 'approve'), 'primary');
			this.smallButton(buttons, localize('voltWorkflows.reject', "Reject"), Codicon.close, () => this.host.resolveApproval(this.run ?? run, step.nodeId, 'reject'));
		} else if (step.state === 'waiting' && step.waitingFor) {
			this.alert.style.display = '';
			this.alert.className = 'volt-wf-step-alert waiting';
			const text = append(this.alert, $('.volt-wf-alert-text'));
			append(text, $('span.volt-wf-alert-icon')).appendChild(renderIcon(Codicon.watch));
			append(text, $('span.volt-wf-alert-message')).textContent = localize('voltWorkflows.waitingOn', "Waiting for {0}", step.waitingFor);
		}
	}

	private smallButton(parent: HTMLElement, label: string, icon: ThemeIcon, run: () => void, kind: 'primary' | 'secondary' = 'secondary'): void {
		const element = append(parent, $(`button.volt-auto-outline-button.small${kind === 'primary' ? '.primary' : ''}`)) as HTMLButtonElement;
		element.type = 'button';
		element.appendChild(renderIcon(icon));
		append(element, $('span.label')).textContent = label;
		this.renderStore.add(addDisposableListener(element, EventType.CLICK, e => {
			e.stopPropagation();
			run();
		}));
	}

	private renderContent(): void {
		const run = this.run;
		const step = this.step;
		const nodeId = this.nodeId;
		const showPart = (part: 'inspector' | 'logs' | 'placeholder') => {
			this.inspector.element.style.display = part === 'inspector' ? '' : 'none';
			this.logs.element.style.display = part === 'logs' ? '' : 'none';
			this.placeholder.style.display = part === 'placeholder' ? '' : 'none';
		};
		this.toolbar.style.display = nodeId ? '' : 'none';
		if (!nodeId) {
			this.placeholder.textContent = run
				? localize('voltWorkflows.pickStep', "Select a step to see its input and output.")
				: localize('voltWorkflows.noRunDetail', "Run details show here.");
			showPart('placeholder');
			return;
		}
		const info = this.host.info(nodeId);
		switch (this.view) {
			case 'logs': {
				showPart('logs');
				const stepId = step?.id;
				this.logs.set(run?.id, run?.logs ?? [], entry => stepId ? entry.stepId === stepId || (!entry.stepId && entry.nodeId === nodeId) : entry.nodeId === nodeId, `step:${stepId ?? nodeId}`);
				if (!this.logs.length) {
					this.placeholder.textContent = localize('voltWorkflows.noStepLogs', "This step wrote no logs.");
					showPart('placeholder');
				}
				return;
			}
			case 'input':
				showPart('inspector');
				this.inspector.set(step?.input, `input:${nodeId}`, this.host.inputPrefix(nodeId), step
					? localize('voltWorkflows.noInput', "No input: this step got nothing from upstream.")
					: localize('voltWorkflows.noInputYet', "Input shows once the step runs."));
				return;
			case 'output':
				showPart('inspector');
				this.inspector.set(step?.output ?? (step ? undefined : info.node?.pinnedOutput), `output:${nodeId}`, ['nodes', nodeId], !step
					? localize('voltWorkflows.noOutputYet', "Output shows once the step runs.")
					: step.state === 'running' || step.state === 'waiting' || step.state === 'queued'
						? localize('voltWorkflows.outputPending', "Still running…")
						: localize('voltWorkflows.noOutput', "No output."));
				return;
			case 'config':
				showPart('inspector');
				this.inspector.set(step?.resolvedConfig ?? info.node?.config, `config:${nodeId}`, ['nodes', nodeId, 'config'], localize('voltWorkflows.noConfig', "No settings."));
				return;
			case 'variables': {
				showPart('inspector');
				const source = run ? [run.variables, run.inputs, run.trigger] : [];
				if (!this.variables || this.variables.source.length !== source.length || this.variables.source.some((part, i) => part !== source[i])) {
					this.variables = {
						source,
						value: run ? { vars: run.variables, inputs: run.inputs, trigger: run.trigger.payload ?? null } : null,
					};
				}
				this.inspector.set(run ? this.variables.value : undefined, 'variables', [], localize('voltWorkflows.noVariables', "Variables show once the workflow runs."));
				return;
			}
		}
	}

	private layoutContent(): void {
		if (!this.width || !this.height) {
			return;
		}
		const used = this.head.offsetHeight + this.alert.offsetHeight + this.toolbar.offsetHeight;
		const height = Math.max(0, this.height - used);
		this.content.style.height = `${height}px`;
		this.inspector.layout(this.width, height);
		this.logs.layout(this.width, height);
	}
}

//#endregion

//#region Timeline

/** A round step for the time axis: about `target` ticks across `span` ms. */
function tickStep(span: number, target = 6): number {
	const raw = Math.max(1, span / target);
	const power = 10 ** Math.floor(Math.log10(raw));
	for (const multiple of [1, 2, 5]) {
		if (raw <= multiple * power) {
			return multiple * power;
		}
	}
	return 10 * power;
}

//#endregion

export type WorkflowRunPanelTab = 'steps' | 'timeline' | 'executions' | 'logs';

export interface IWorkflowRunPanelOptions {
	readonly workflowId: () => string | undefined;
	readonly onSelectNode: (nodeId: string) => void;
	readonly onShowRun: (run: IWorkflowRun | undefined) => void;
	readonly onRetryStep: (run: IWorkflowRun, nodeId: string) => void;
	readonly onRunNode: (nodeId: string) => void;
	/** The builder's definition (unsaved edits included) for node names and icons; the saved one when absent. */
	readonly definition?: () => IWorkflowDefinition | undefined;
	/** Hides the panel (the builder docks it under the canvas). */
	readonly onClose?: () => void;
}

const HEAD_HEIGHT = 36;
const ALL_LEVELS: readonly WorkflowLogLevel[] = ['debug', 'info', 'warn', 'error'];

let lastTab: WorkflowRunPanelTab = 'steps';

export class WorkflowRunPanel extends Disposable {

	readonly element: HTMLElement;
	private readonly tabButtons = new Map<WorkflowRunPanelTab, HTMLElement>();
	private readonly tabIndicator: HTMLElement;
	private readonly bodies = new Map<WorkflowRunPanelTab, HTMLElement>();
	private readonly tools = new Map<WorkflowRunPanelTab, HTMLElement>();
	private readonly status: HTMLElement;
	private readonly controls: HTMLElement;
	private readonly controlStore = this._register(new DisposableStore());
	private readonly stepsEmpty: HTMLElement;
	private readonly stepsSplit: HTMLElement;
	private readonly stepsHost: HTMLElement;
	private readonly stepsList: WorkbenchList<IWorkflowStepRecord>;
	private readonly detail: StepDetail;
	private readonly timeline: HTMLElement;
	private readonly runsHost: HTMLElement;
	private readonly runsEmpty: HTMLElement;
	private readonly runsList: WorkbenchList<IWorkflowRun>;
	private readonly logList: LogList;
	private readonly logsEmpty: HTMLElement;
	private readonly logSearch: HTMLInputElement;
	private readonly levelButton: HTMLButtonElement;
	private readonly frame = this._register(new MutableDisposable());
	private readonly ticker = this._register(new MutableDisposable());

	private tab: WorkflowRunPanelTab = lastTab;
	private run: IWorkflowRun | undefined;
	private stepRows: IWorkflowStepRecord[] = [];
	private runRows: IWorkflowRun[] = [];
	private selectedStepId: string | undefined;
	/** The node picked on the canvas that has no step in this run. */
	private focusedNodeId: string | undefined;
	/** The user picked a step: stop following the live one until the next run. */
	private pinnedStep = false;
	private pending: IWorkflowRun | undefined;
	private runsDirty = false;
	private namesDirty = false;
	private levels = new Set<WorkflowLogLevel>(['info', 'warn', 'error']);
	private nodes = new Map<string, IWorkflowNode>();
	private definitionRef: IWorkflowDefinition | undefined;
	private width = 0;
	private height = 0;
	private controlSignature = '';
	/** Runs this panel has heard of: only a run never seen before is followed on its own. */
	private readonly seenRuns = new Set<string>();
	private timelineView: { readonly runId: string; readonly scale: HTMLElement; readonly grid: HTMLElement; readonly rows: HTMLElement; readonly lanes: Map<string, HTMLElement>; readonly bars: Map<string, HTMLElement> } | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: IWorkflowRunPanelOptions,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		const store = this._register(new DisposableStore());
		this.element = append(container, $('.volt-wf-run-panel'));

		// Header: tabs, the run's state, tab tools and run controls.
		const head = append(this.element, $('.volt-wf-run-head'));
		const tabs = append(head, $('.volt-wf-seg.volt-wf-run-tabs'));
		tabs.setAttribute('role', 'tablist');
		const tabLabels: [WorkflowRunPanelTab, string][] = [
			['steps', localize('voltWorkflows.tabSteps', "Steps")],
			['timeline', localize('voltWorkflows.tabTimeline', "Timeline")],
			['executions', localize('voltWorkflows.tabExecutions', "Executions")],
			['logs', localize('voltWorkflows.tabLogs', "Logs")],
		];
		for (const [tab, label] of tabLabels) {
			const element = append(tabs, $('button.volt-wf-seg-item')) as HTMLButtonElement;
			element.type = 'button';
			element.setAttribute('role', 'tab');
			append(element, $('span.label')).textContent = label;
			append(element, $('span.volt-wf-tab-count'));
			store.add(addDisposableListener(element, EventType.CLICK, () => this.setTab(tab)));
			this.tabButtons.set(tab, element);
		}
		this.tabIndicator = append(tabs, $('.volt-wf-seg-indicator'));
		this.status = append(head, $('.volt-wf-run-status'));
		append(head, $('span.volt-auto-spacer'));
		const toolsHost = append(head, $('.volt-wf-run-tools'));
		this.controls = append(head, $('.volt-wf-run-controls'));
		if (options.onClose) {
			const close = append(head, $('.volt-wf-run-controls.volt-wf-run-close'));
			iconButton(close, Codicon.close, localize('voltWorkflows.closePanel', "Close panel"), store, options.onClose);
		}

		const body = append(this.element, $('.volt-wf-run-body'));
		for (const [tab] of tabLabels) {
			this.bodies.set(tab, append(body, $(`.volt-wf-run-tab.tab-${tab}`)));
			this.tools.set(tab, append(toolsHost, $(`.volt-wf-run-tab-tools.tab-${tab}`)));
		}

		// Steps: the executed nodes, and the picked one's detail.
		const steps = this.bodies.get('steps')!;
		this.stepsEmpty = append(steps, $('.volt-wf-run-empty'));
		this.renderTeachingEmpty(this.stepsEmpty);
		this.stepsSplit = append(steps, $('.volt-wf-steps-split'));
		this.stepsHost = append(this.stepsSplit, $('.volt-wf-steps-list'));
		this.stepsList = this._register(instantiationService.createInstance(WorkbenchList<IWorkflowStepRecord>, 'VoltWorkflowSteps', this.stepsHost, {
			getHeight: () => STEP_ROW_HEIGHT,
			getTemplateId: () => StepRenderer.ID,
		} satisfies IListVirtualDelegate<IWorkflowStepRecord>, [new StepRenderer(nodeId => this.info(nodeId))], {
			identityProvider: { getId: (step: IWorkflowStepRecord) => step.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltWorkflows.stepsAria', "Executed steps"),
				getAriaLabel: (step: IWorkflowStepRecord) => `${this.info(step.nodeId).name}, ${stepStateLabel(step.state)}`,
			},
		}));
		this._register(this.stepsList.onDidOpen(e => e.element && this.pickStep(e.element)));
		// Arrow keys walk the steps like n8n's list: the detail follows the focus.
		this._register(this.stepsList.onDidChangeFocus(e => {
			if (isKeyboardEvent(e.browserEvent) && e.elements[0]) {
				this.pickStep(e.elements[0]);
			}
		}));
		this.detail = this._register(new StepDetail(this.stepsSplit, {
			info: nodeId => this.info(nodeId),
			inputPrefix: nodeId => this.inputPrefix(nodeId),
			retry: (run, nodeId) => this.options.onRetryStep(run, nodeId),
			runNode: nodeId => this.options.onRunNode(nodeId),
			openChat: threadId => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId),
			resolveApproval: (run, nodeId, decision) => this.execution(run)?.resolveApproval(nodeId, decision),
			copy: (text, label) => this.copy(text, label),
			valueMenu: (anchor, node, inspector) => this.showValueMenu(anchor, node, inspector),
			openLog: entry => this.openLog(entry),
		}, instantiationService));

		// Timeline.
		this.timeline = append(this.bodies.get('timeline')!, $('.volt-wf-timeline'));
		store.add(addDisposableListener(this.timeline, EventType.CLICK, e => this.onTimelineActivate(e)));
		store.add(addDisposableListener(this.timeline, EventType.KEY_DOWN, e => this.onTimelineActivate(e)));

		// Executions.
		const executions = this.bodies.get('executions')!;
		this.runsEmpty = append(executions, $('.volt-wf-run-empty'));
		this.runsHost = append(executions, $('.volt-wf-exec-list'));
		this.runsList = this._register(instantiationService.createInstance(WorkbenchList<IWorkflowRun>, 'VoltWorkflowExecutions', this.runsHost, {
			getHeight: () => EXEC_ROW_HEIGHT,
			getTemplateId: () => ExecutionRenderer.ID,
		} satisfies IListVirtualDelegate<IWorkflowRun>, [new ExecutionRenderer(run => this.retryRun(run))], {
			identityProvider: { getId: (run: IWorkflowRun) => run.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltWorkflows.executionsAria', "Executions"),
				getAriaLabel: (run: IWorkflowRun) => `${formatRunDate(run.startedAt)}, ${runOutcomeText(run, Date.now())}, ${run.mode === 'simulate' ? localize('voltWorkflows.simulation', "Simulation") : localize('voltWorkflows.realRun', "Run")}`,
			},
		}));
		this._register(this.runsList.onDidOpen(e => {
			if (e.element) {
				this.showRun(e.element);
				this.options.onShowRun(e.element);
				this.setTab('steps');
			}
		}));
		const clearHistory = this.toolButton(this.tools.get('executions')!, localize('voltWorkflows.clearHistory', "Clear History"), Codicon.trash, store, () => void this.clearHistory());
		clearHistory.classList.add('volt-wf-clear-history');

		// Logs: level filter and search in the header.
		const logTools = this.tools.get('logs')!;
		const searchBox = append(logTools, $('label.volt-wf-run-search'));
		append(searchBox, $('span.icon')).appendChild(createHomeSearchIcon());
		this.logSearch = append(searchBox, $('input.volt-wf-run-search-input')) as HTMLInputElement;
		this.logSearch.placeholder = localize('voltWorkflows.searchLogs', "Search logs");
		this.logSearch.setAttribute('aria-label', localize('voltWorkflows.searchLogs', "Search logs"));
		store.add(addDisposableListener(this.logSearch, EventType.INPUT, () => this.syncLogs()));
		store.add(addDisposableListener(this.logSearch, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.logSearch.value) {
				EventHelper.stop(e, true);
				this.logSearch.value = '';
				this.syncLogs();
			}
		}));
		this.levelButton = this.toolButton(logTools, '', Codicon.filter, store, () => this.showLevelMenu());
		const logsBody = this.bodies.get('logs')!;
		this.logsEmpty = append(logsBody, $('.volt-wf-run-empty'));
		this.logList = this._register(new LogList(logsBody, nodeId => this.info(nodeId).name, () => this.run?.startedAt, entry => this.openLog(entry), instantiationService));

		this._register(this.workflows.onDidChangeRun(event => this.onRunEvent(event)));
		this._register(this.workflows.onDidChange(() => {
			// A save can rename nodes: the rows read names at render time.
			this.definitionRef = undefined;
			this.namesDirty = true;
			this.runsDirty = true;
			this.schedule();
		}));
		void this.workflows.whenReady.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.syncRuns();
			// Opened while a run goes: show it.
			const workflowId = this.options.workflowId();
			const active = workflowId ? this.workflows.activeExecution(workflowId)?.run : undefined;
			if (!this.run && active) {
				this.showRun(active);
				this.options.onShowRun(active);
			}
		});
		this.setTab(this.tab);
		this.showRun(undefined);
	}

	//#region Public API

	/** Shows a run (undefined: none). Does not call `onShowRun`: the caller already knows. */
	showRun(run: IWorkflowRun | undefined): void {
		const changed = run?.id !== this.run?.id;
		this.run = run;
		if (run) {
			this.seenRuns.add(run.id);
		}
		if (changed) {
			this.selectedStepId = undefined;
			this.focusedNodeId = undefined;
			this.pinnedStep = false;
			this.stepRows = [];
			this.stepsList.splice(0, this.stepsList.length, []);
		}
		this.definitionRef = undefined;
		this.update();
		this.syncRunSelection();
	}

	/** The canvas picked a node: select its latest step (or say it did not run). */
	focusNode(nodeId: string): void {
		const current = this.stepRows.find(step => step.id === this.selectedStepId);
		if (current?.nodeId === nodeId) {
			return;
		}
		const step = [...this.stepRows].reverse().find(candidate => candidate.nodeId === nodeId);
		this.pinnedStep = true;
		this.selectedStepId = step?.id;
		this.focusedNodeId = step ? undefined : nodeId;
		if (this.tab !== 'steps' && this.tab !== 'logs') {
			this.setTab('steps');
		}
		this.syncStepSelection(true);
		this.renderDetail();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		const bodyHeight = Math.max(0, height - HEAD_HEIGHT);
		const listWidth = Math.round(Math.min(340, Math.max(200, width * 0.32)));
		this.stepsHost.style.width = `${listWidth}px`;
		this.stepsHost.style.height = `${bodyHeight}px`;
		this.stepsList.layout(bodyHeight, listWidth);
		this.detail.layout(Math.max(0, width - listWidth - 1), bodyHeight);
		this.runsHost.style.height = `${bodyHeight}px`;
		this.runsList.layout(bodyHeight, width);
		this.logList.layout(width, bodyHeight);
		this.timeline.style.height = `${bodyHeight}px`;
		placeTabIndicator(this.tabIndicator, this.tabButtons.get(this.tab));
	}

	//#endregion

	//#region Live updates

	private onRunEvent(event: WorkflowRunEvent): void {
		const run = event.run;
		const workflowId = this.options.workflowId();
		const ours = run.id === this.run?.id || (!!workflowId && run.workflowId === workflowId && (run.depth ?? 0) === 0);
		if (!ours) {
			return;
		}
		if (event.kind === 'run' || !this.runRows.some(row => row.id === run.id)) {
			this.runsDirty = true;
		}
		const isNew = !this.seenRuns.has(run.id);
		this.seenRuns.add(run.id);
		if (run.id === this.run?.id || this.pending?.id === run.id) {
			this.pending = run;
		} else if (isNew && (!this.run || !isLiveRun(this.run))) {
			// A run that just started (an automation, the library) is followed unless one is on screen
			// and still going; an older run the user picked stays until a new one starts.
			this.pending = run;
		}
		this.schedule();
	}

	private schedule(): void {
		if (!this.frame.value) {
			this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.frame.clear();
				this.flush();
			});
		}
	}

	private flush(): void {
		const run = this.pending;
		this.pending = undefined;
		if (run) {
			if (run.id !== this.run?.id) {
				this.showRun(run);
				this.options.onShowRun(run);
			} else {
				this.run = run;
				this.update();
			}
		}
		if (this.runsDirty) {
			this.runsDirty = false;
			this.syncRuns();
		}
		if (this.namesDirty) {
			this.namesDirty = false;
			this.stepsList.rerender();
			this.timelineView = undefined;
			if (this.tab === 'timeline') {
				this.renderTimeline();
			}
		}
	}

	/** Brings every part up to `this.run`, splicing only what changed. */
	private update(): void {
		const run = this.run;
		this.syncSteps(run?.steps ?? []);
		this.autoSelectStep();
		this.syncStepSelection(false);
		this.renderDetail();
		this.renderStatus();
		this.renderControls();
		this.syncLogs();
		if (this.tab === 'timeline') {
			this.renderTimeline();
		}
		const hasRun = !!run;
		this.stepsEmpty.style.display = hasRun ? 'none' : '';
		this.stepsSplit.style.display = hasRun ? '' : 'none';
		this.syncTicker();
	}

	private syncSteps(steps: readonly IWorkflowStepRecord[]): void {
		const old = this.stepRows;
		let i = 0;
		while (i < old.length && i < steps.length && old[i].id === steps[i].id) {
			if (old[i] !== steps[i]) {
				this.stepsList.splice(i, 1, [steps[i]]);
			}
			i++;
		}
		if (i < old.length || i < steps.length) {
			this.stepsList.splice(i, old.length - i, steps.slice(i));
		}
		this.stepRows = [...steps];
		this.setCount('steps', steps.length ? String(steps.length) : '');
	}

	/** While the user has not picked one, the detail follows the run: the running step, then the failed one. */
	private autoSelectStep(): void {
		if (this.pinnedStep || this.focusedNodeId) {
			return;
		}
		const steps = this.stepRows;
		const failed = steps.find(step => step.state === 'failed');
		const live = [...steps].reverse().find(step => step.state === 'running' || step.state === 'waiting');
		const pick = (this.run && !isLiveRun(this.run) && failed) || live || failed || steps.at(-1);
		this.selectedStepId = pick?.id;
	}

	private syncStepSelection(reveal: boolean): void {
		const index = this.selectedStepId ? this.stepRows.findIndex(step => step.id === this.selectedStepId) : -1;
		if (index < 0) {
			if (this.stepsList.getSelection().length) {
				this.stepsList.setSelection([]);
			}
			return;
		}
		if (this.stepsList.getSelection()[0] !== index) {
			this.stepsList.setFocus([index]);
			this.stepsList.setSelection([index]);
		}
		if (reveal || !this.pinnedStep) {
			this.stepsList.reveal(index);
		}
	}

	private pickStep(step: IWorkflowStepRecord): void {
		this.pinnedStep = true;
		this.focusedNodeId = undefined;
		if (this.selectedStepId !== step.id) {
			this.selectedStepId = step.id;
			this.syncStepSelection(false);
			this.renderDetail();
		}
		this.options.onSelectNode(step.nodeId);
	}

	private renderDetail(): void {
		const step = this.selectedStepId ? this.stepRows.find(candidate => candidate.id === this.selectedStepId) : undefined;
		this.detail.render(this.run, step, step ? undefined : this.focusedNodeId);
	}

	private syncRuns(): void {
		const workflowId = this.options.workflowId();
		const runs = workflowId ? this.workflows.runs(workflowId).filter(run => (run.depth ?? 0) === 0) : [];
		const old = this.runRows;
		if (runs.length === old.length && runs.every((run, i) => run.id === old[i].id)) {
			runs.forEach((run, i) => {
				if (run !== old[i]) {
					this.runsList.splice(i, 1, [run]);
				}
			});
		} else {
			this.runsList.splice(0, this.runsList.length, runs);
		}
		this.runRows = [...runs];
		for (const run of runs) {
			this.seenRuns.add(run.id);
		}
		this.runsEmpty.style.display = runs.length ? 'none' : '';
		this.runsHost.style.display = runs.length ? '' : 'none';
		if (!runs.length) {
			this.renderRunsEmpty();
		}
		this.setCount('executions', runs.length ? String(runs.length) : '');
		this.tools.get('executions')!.querySelector<HTMLButtonElement>('.volt-wf-clear-history')!.disabled = !runs.length || runs.some(isLiveRun);
		this.syncRunSelection();
		this.syncTicker();
	}

	private syncRunSelection(): void {
		const index = this.run ? this.runRows.findIndex(row => row.id === this.run!.id) : -1;
		this.runsList.setSelection(index >= 0 ? [index] : []);
	}

	private logFilter(): { readonly key: string; readonly test: (entry: IWorkflowLogEntry) => boolean } {
		const query = this.logSearch.value.trim().toLowerCase();
		const levels = new Set(this.levels);
		return {
			key: `${[...levels].sort().join(',')}|${query}`,
			test: entry => levels.has(entry.level) && (!query || entry.message.toLowerCase().includes(query) || (!!entry.nodeId && this.info(entry.nodeId).name.toLowerCase().includes(query))),
		};
	}

	private syncLogs(): void {
		const run = this.run;
		const filter = this.logFilter();
		this.logList.set(run?.id, run?.logs ?? [], filter.test, filter.key);
		const errors = run?.logs.filter(entry => entry.level === 'error').length ?? 0;
		this.setCount('logs', errors ? String(errors) : '', errors > 0);
		const label = this.levels.size === ALL_LEVELS.length
			? localize('voltWorkflows.allLevels', "All levels")
			: ALL_LEVELS.filter(level => this.levels.has(level)).map(level => level[0].toUpperCase() + level.slice(1)).join(', ') || localize('voltWorkflows.noLevels', "No levels");
		this.levelButton.querySelector('.label')!.textContent = label;
		const empty = !this.logList.length;
		this.logsEmpty.style.display = empty ? '' : 'none';
		this.logList.element.style.display = empty ? 'none' : '';
		if (empty) {
			this.logsEmpty.textContent = !run
				? localize('voltWorkflows.logsEmpty', "Logs appear here while a run goes: what each step did, warnings and errors.")
				: run.logs.length
					? localize('voltWorkflows.logsNoMatch', "No logs match the filter.")
					: localize('voltWorkflows.logsNone', "This run wrote no logs yet.");
		}
	}

	/** Running durations move every 100ms; nothing ticks when nothing runs. */
	private syncTicker(): void {
		const live = (!!this.run && isLiveRun(this.run)) || this.runRows.some(run => run.status === 'running');
		if (live && !this.ticker.value) {
			const win = getWindow(this.element);
			const handle = win.setInterval(() => this.tick(), 100);
			this.ticker.value = { dispose: () => win.clearInterval(handle) };
		} else if (!live) {
			this.ticker.clear();
		}
	}

	private tick(): void {
		const now = Date.now();
		for (const cell of this.stepsHost.querySelectorAll<HTMLElement>('[data-live-start]')) {
			const start = Number(cell.dataset.liveStart);
			if (start) {
				cell.textContent = formatRunDuration(now - start);
			}
		}
		for (const cell of this.runsHost.querySelectorAll<HTMLElement>('[data-live-run]')) {
			cell.textContent = localize('voltWorkflows.runningFor', "Running for {0}", formatRunDuration(now - Number(cell.dataset.liveRun)));
		}
		this.detail.tick(now);
		this.renderStatus();
		if (this.tab === 'timeline' && this.run && isLiveRun(this.run)) {
			this.renderTimeline();
		}
	}

	//#endregion

	//#region Header

	private setTab(tab: WorkflowRunPanelTab): void {
		this.tab = lastTab = tab;
		for (const [id, element] of this.tabButtons) {
			element.classList.toggle('active', id === tab);
			element.setAttribute('aria-selected', String(id === tab));
		}
		for (const [id, element] of this.bodies) {
			element.style.display = id === tab ? '' : 'none';
		}
		for (const [id, element] of this.tools) {
			element.style.display = id === tab ? '' : 'none';
		}
		if (tab === 'timeline') {
			this.renderTimeline();
		}
		if (this.width) {
			this.layout(this.width, this.height);
		}
	}

	private setCount(tab: WorkflowRunPanelTab, text: string, alert = false): void {
		const count = this.tabButtons.get(tab)?.querySelector<HTMLElement>('.volt-wf-tab-count');
		if (count && count.textContent !== text) {
			count.textContent = text;
			// The tab's width changed: the underline follows it.
			placeTabIndicator(this.tabIndicator, this.tabButtons.get(this.tab));
		}
		count?.classList.toggle('alert', alert);
	}

	private renderStatus(): void {
		const run = this.run;
		clearNode(this.status);
		if (!run) {
			this.status.className = 'volt-wf-run-status';
			return;
		}
		const now = Date.now();
		this.status.className = `volt-wf-run-status status-${run.status}`;
		append(this.status, $('span.volt-wf-run-status-icon')).appendChild(renderIcon(runStatusIcon(run.status)));
		const text = append(this.status, $('span.volt-wf-run-status-text'));
		const tokens = runTokens(run);
		const extras = [formatTokens(tokens), formatCost(tokens?.costUsd)];
		let parts: (string | undefined)[];
		switch (run.status) {
			case 'succeeded':
				parts = [runOutcomeText(run, now), ...extras];
				break;
			case 'failed': {
				const failed = run.steps.find(step => step.state === 'failed');
				parts = [failed ? localize('voltWorkflows.failedAt', "Failed at {0}", this.info(failed.nodeId).name) : runOutcomeText(run, now), formatRunDuration((run.finishedAt ?? now) - run.startedAt), ...extras];
				break;
			}
			case 'cancelled':
				parts = [runOutcomeText(run, now), ...extras];
				break;
			default: {
				const total = this.definition()?.nodes.filter(node => !node.disabled).length;
				const done = new Set(run.steps.filter(step => step.state === 'success' || step.state === 'failed' || step.state === 'skipped').map(step => step.nodeId)).size;
				const next = run.status === 'paused' ? run.steps.find(step => step.state === 'queued' || step.state === 'idle') : undefined;
				parts = [
					next ? localize('voltWorkflows.pausedBefore', "Paused before {0}", this.info(next.nodeId).name) : runStatusLabel(run.status),
					total ? localize('voltWorkflows.stepsOf', "{0}/{1} steps", done, total) : localize('voltWorkflows.stepsDone', "{0} steps", done),
					formatRunDuration(now - run.startedAt),
					...extras,
				];
			}
		}
		text.textContent = parts.filter(Boolean).join(' · ');
		if (run.error) {
			setAgentTooltip(text, run.error);
		}
		if (run.mode === 'simulate') {
			append(this.status, $('span.volt-wf-badge.mode-simulate')).textContent = localize('voltWorkflows.simulation', "Simulation");
		}
	}

	private execution(run: IWorkflowRun | undefined = this.run): ReturnType<IWorkflowService['activeExecution']> {
		if (!run) {
			return undefined;
		}
		const execution = this.workflows.activeExecution(run.workflowId);
		return execution?.run.id === run.id ? execution : undefined;
	}

	private renderControls(): void {
		const run = this.run;
		const execution = this.execution();
		const live = !!run && !!execution && isLiveRun(run);
		const paused = live && (execution!.paused || run!.status === 'paused');
		// Rebuilt only when what they offer changes: a button replaced mid-click loses the click.
		const signature = `${run?.id ?? ''}|${live}|${paused}`;
		if (signature === this.controlSignature) {
			return;
		}
		this.controlSignature = signature;
		this.controlStore.clear();
		clearNode(this.controls);
		if (run && execution && live) {
			if (paused) {
				iconButton(this.controls, Codicon.debugStepOver, localize('voltWorkflows.step', "Step: run the next node, then pause"), this.controlStore, () => execution.step());
				iconButton(this.controls, Codicon.debugContinue, localize('voltWorkflows.resume', "Resume"), this.controlStore, () => execution.resume());
			} else {
				iconButton(this.controls, Codicon.debugPause, localize('voltWorkflows.pause', "Pause before the next node"), this.controlStore, () => execution.pause());
			}
			const stop = iconButton(this.controls, Codicon.debugStop, localize('voltWorkflows.stop', "Stop the run"), this.controlStore, () => execution.cancel());
			stop.classList.add('volt-wf-stop');
		} else if (run) {
			iconButton(this.controls, Codicon.clearAll, localize('voltWorkflows.clear', "Clear: hide this run"), this.controlStore, () => {
				this.showRun(undefined);
				this.options.onShowRun(undefined);
			});
		}
	}

	private toolButton(parent: HTMLElement, label: string, icon: ThemeIcon, store: DisposableStore, onClick: () => void): HTMLButtonElement {
		const element = append(parent, $('button.volt-auto-outline-button.small')) as HTMLButtonElement;
		element.type = 'button';
		element.appendChild(renderIcon(icon));
		append(element, $('span.label')).textContent = label;
		store.add(addDisposableListener(element, EventType.CLICK, e => {
			e.stopPropagation();
			if (!element.disabled) {
				onClick();
			}
		}));
		return element;
	}

	private showLevelMenu(): void {
		const label = (level: WorkflowLogLevel) => {
			switch (level) {
				case 'debug': return localize('voltWorkflows.levelDebug', "Debug");
				case 'info': return localize('voltWorkflows.levelInfo', "Info");
				case 'warn': return localize('voltWorkflows.levelWarn', "Warnings");
				case 'error': return localize('voltWorkflows.levelError', "Errors");
			}
		};
		const handle = showVoltMenu<WorkflowLogLevel>(this.contextView, {
			anchor: this.levelButton,
			align: 'right',
			gap: 4,
			width: 180,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltWorkflows.logLevels', "Log levels"),
			sections: () => [{
				id: 'levels',
				title: localize('voltWorkflows.show', "Show"),
				items: ALL_LEVELS.map(level => ({ id: level, label: label(level), checked: this.levels.has(level), keepOpen: true, data: level })),
			}],
			onPick: item => {
				if (this.levels.has(item.data)) {
					this.levels.delete(item.data);
				} else {
					this.levels.add(item.data);
				}
				this.syncLogs();
				handle.refresh();
			},
		});
	}

	//#endregion

	//#region Empty states

	private renderTeachingEmpty(parent: HTMLElement): void {
		clearNode(parent);
		const box = append(parent, $('.volt-wf-teach'));
		append(box, $('span.volt-wf-teach-icon')).appendChild(renderIcon(Codicon.debugStart));
		append(box, $('.volt-wf-teach-title')).textContent = localize('voltWorkflows.teachTitle', "Simulate to test the workflow without side effects.");
		const keys = append(box, $('.volt-wf-teach-keys'));
		const key = (text: string, label: string) => {
			const row = append(keys, $('span.volt-wf-teach-key'));
			append(row, $('kbd')).textContent = text;
			append(row, $('span')).textContent = label;
		};
		key(isMacintosh ? '⇧⌘\u21B5' : 'Shift+Ctrl+Enter', localize('voltWorkflows.teachSimulate', "Simulate"));
		key(isMacintosh ? '⌘\u21B5' : 'Ctrl+Enter', localize('voltWorkflows.teachRun', "Run for real"));
		append(box, $('.volt-wf-teach-hint')).textContent = localize('voltWorkflows.teachHint', "Simulations use sample payloads and pinned outputs, so agents, shell and git steps do nothing real. Pick a node and use Run this step to try one node on its own.");
	}

	private renderRunsEmpty(): void {
		clearNode(this.runsEmpty);
		const box = append(this.runsEmpty, $('.volt-wf-teach'));
		append(box, $('span.volt-wf-teach-icon')).appendChild(renderIcon(Codicon.history));
		append(box, $('.volt-wf-teach-title')).textContent = localize('voltWorkflows.noExecutions', "No executions yet.");
		append(box, $('.volt-wf-teach-hint')).textContent = this.options.workflowId()
			? localize('voltWorkflows.noExecutionsHint', "Every simulation and run is kept here (the last 50) with its inputs, outputs and logs.")
			: localize('voltWorkflows.noExecutionsUnsaved', "Save the workflow to keep its executions.");
	}

	//#endregion

	//#region Timeline

	/**
	 * One lane per node in the order they first ran; loops and retries add bars to a lane. Lanes and
	 * bars are kept by id and moved in place while the run goes (percentages of the run's span), so a
	 * hovered bar keeps its tooltip; only the axis is redrawn as the span grows.
	 */
	private renderTimeline(): void {
		const run = this.run;
		const started = run?.steps.filter(step => step.startedAt !== undefined) ?? [];
		if (!run || !started.length) {
			this.timelineView = undefined;
			clearNode(this.timeline);
			const empty = append(this.timeline, $('.volt-wf-run-empty'));
			empty.textContent = run
				? localize('voltWorkflows.timelineWaiting', "The timeline fills in as steps start.")
				: localize('voltWorkflows.timelineEmpty', "Run or simulate to see when each step ran, what ran in parallel, waits and retries.");
			return;
		}
		if (this.timelineView?.runId !== run.id) {
			clearNode(this.timeline);
			const axis = append(this.timeline, $('.volt-wf-tl-axis'));
			append(axis, $('.volt-wf-tl-label'));
			const scale = append(axis, $('.volt-wf-tl-track'));
			const rows = append(this.timeline, $('.volt-wf-tl-rows'));
			const grid = append(rows, $('.volt-wf-tl-grid'));
			this.timelineView = { runId: run.id, scale, grid, rows, lanes: new Map(), bars: new Map() };
		}
		const view = this.timelineView;
		const now = Date.now();
		const start = run.startedAt;
		const end = Math.max(run.finishedAt ?? now, ...started.map(step => step.finishedAt ?? now), start + 1);
		const span = end - start;
		const percent = (at: number) => `${Math.max(0, Math.min(100, ((at - start) / span) * 100))}%`;

		clearNode(view.scale);
		clearNode(view.grid);
		const step = tickStep(span);
		for (let at = 0; at <= span; at += step) {
			const tick = append(view.scale, $('span.volt-wf-tl-tick'));
			tick.style.left = percent(start + at);
			tick.textContent = at === 0 ? '0' : formatRunDuration(at);
			append(view.grid, $('span.volt-wf-tl-gridline')).style.left = percent(start + at);
		}
		if (isLiveRun(run)) {
			append(view.grid, $('span.volt-wf-tl-now')).style.left = percent(now);
		}

		for (const record of started) {
			const info = this.info(record.nodeId);
			let track = view.lanes.get(record.nodeId);
			if (!track) {
				const row = append(view.rows, $('.volt-wf-tl-row'));
				const label = append(row, $('.volt-wf-tl-label'));
				append(label, $('span.volt-wf-step-icon')).appendChild(renderIcon(info.icon));
				append(label, $('span.volt-wf-tl-name')).textContent = info.name;
				append(label, $('span.volt-wf-tl-state')).textContent = stepStateLabel('skipped');
				setAgentTooltip(label, `${info.name} (${record.nodeId})`);
				track = append(row, $('.volt-wf-tl-track'));
				view.lanes.set(record.nodeId, track);
			}
			// A skipped step took no time: no bar, the row says so (and still opens the step).
			const row = track.parentElement!;
			if (record.state === 'skipped') {
				if (!track.childElementCount) {
					row.classList.add('skipped');
					row.dataset.stepId = record.id;
				}
				continue;
			}
			row.classList.remove('skipped');
			delete row.dataset.stepId;
			let bar = view.bars.get(record.id);
			if (!bar) {
				bar = append(track, $('span.volt-wf-tl-bar'));
				bar.setAttribute('role', 'button');
				bar.tabIndex = 0;
				bar.dataset.stepId = record.id;
				view.bars.set(record.id, bar);
			}
			const from = record.startedAt!;
			const to = record.finishedAt ?? now;
			bar.className = `volt-wf-tl-bar state-${record.state}`;
			bar.classList.toggle('selected', record.id === this.selectedStepId);
			bar.style.left = percent(from);
			bar.style.width = `max(3px, ${((to - from) / span) * 100}%)`;
			const marks = [record.iteration !== undefined ? `#${record.iteration + 1}` : '', record.attempt > 1 ? `\u21BB${record.attempt}` : ''].filter(Boolean).join(' ');
			if (bar.textContent !== marks) {
				clearNode(bar);
				if (marks) {
					append(bar, $('span.volt-wf-tl-mark')).textContent = marks;
				}
			}
			setAgentTooltip(bar, [
				`${info.name} · ${stepStateLabel(record.state)}`,
				localize('voltWorkflows.tlStarted', "Started at +{0}, took {1}", formatRunDuration(from - start), formatRunDuration(to - from)),
				record.waitingFor ? localize('voltWorkflows.tlWaiting', "Waiting for {0}", record.waitingFor) : undefined,
				record.attempt > 1 ? localize('voltWorkflows.tlAttempt', "Attempt {0}", record.attempt) : undefined,
				record.iteration !== undefined ? localize('voltWorkflows.tlIteration', "Loop pass {0}", record.iteration + 1) : undefined,
				formatTokens(record.tokens),
				record.error,
			].filter(Boolean).join('\n'));
		}
	}

	/** Bars are drawn by the timeline, so one listener on it opens them. */
	private onTimelineActivate(e: MouseEvent | KeyboardEvent): void {
		if (isKeyboardEvent(e) && e.key !== 'Enter' && e.key !== ' ') {
			return;
		}
		const bar = (e.target as HTMLElement | null)?.closest<HTMLElement>('.volt-wf-tl-bar, .volt-wf-tl-row.skipped');
		const record = bar?.dataset.stepId ? this.stepRows.find(step => step.id === bar.dataset.stepId) : undefined;
		if (!record) {
			return;
		}
		e.preventDefault();
		this.setTab('steps');
		this.pickStep(record);
		this.syncStepSelection(true);
	}

	//#endregion

	//#region Helpers

	private definition(): IWorkflowDefinition | undefined {
		const workflowId = this.run?.workflowId ?? this.options.workflowId();
		const editing = this.options.definition?.();
		const definition = editing && (!workflowId || editing.id === workflowId || !this.options.workflowId()) ? editing : workflowId ? this.workflows.get(workflowId) : undefined;
		if (definition !== this.definitionRef) {
			this.definitionRef = definition;
			this.nodes = new Map((definition?.nodes ?? []).map(node => [node.id, node]));
		}
		return definition;
	}

	private info(nodeId: string): INodeInfo {
		this.definition();
		const node = this.nodes.get(nodeId);
		const type = getWorkflowNodeType(node?.type ?? '');
		return {
			name: node ? nodeDisplayName(node) : nodeId,
			typeLabel: type?.label ?? node?.type ?? localize('voltWorkflows.removedNode', "removed node"),
			icon: type ? ThemeIcon.fromId(type.icon) : Codicon.symbolMisc,
			control: type?.control,
			node,
		};
	}

	/** What `{{ }}` reads a step's input as: the upstream node's output, or every upstream node's after a join. */
	private inputPrefix(nodeId: string): readonly (string | number)[] {
		const definition = this.definition();
		const node = this.nodes.get(nodeId);
		if (node?.type === 'start') {
			return ['trigger'];
		}
		const from = [...new Set((definition?.edges ?? []).filter(edge => edge.to === nodeId).map(edge => edge.from))];
		return from.length === 1 ? ['nodes', from[0]] : ['nodes'];
	}

	private copy(text: string, _label: string): void {
		void this.clipboard.writeText(text);
	}

	private showValueMenu(anchor: HTMLElement | { x: number; y: number }, node: IJsonNode, inspector: ValueInspector): void {
		type Pick = 'value' | 'path';
		const target = isHTMLElement(anchor) ? anchor : (() => {
			// The menu anchors to an element: a 1px probe where the pointer was.
			const probe = append(this.element, $('span.volt-wf-menu-probe'));
			const box = this.element.getBoundingClientRect();
			probe.style.left = `${anchor.x - box.left}px`;
			probe.style.top = `${anchor.y - box.top}px`;
			return probe;
		})();
		showVoltMenu<Pick>(this.contextView, {
			anchor: target,
			gap: 2,
			width: 200,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltWorkflows.valueActions', "Value actions"),
			sections: [{
				id: 'copy',
				items: [
					{ id: 'value', label: localize('voltWorkflows.copyValue', "Copy value"), icon: Codicon.copy, data: 'value' },
					...(node.path.length ? [{ id: 'path', label: localize('voltWorkflows.copyPath', "Copy as {{ }} path"), icon: Codicon.bracket, data: 'path' as Pick }] : []),
				],
			}],
			onPick: item => inspector.copyNode(node, item.data),
			onHide: () => {
				if (target !== anchor) {
					target.remove();
				}
			},
		});
	}

	private openLog(entry: IWorkflowLogEntry): void {
		const step = entry.stepId ? this.stepRows.find(candidate => candidate.id === entry.stepId) : entry.nodeId ? [...this.stepRows].reverse().find(candidate => candidate.nodeId === entry.nodeId) : undefined;
		if (step) {
			this.setTab('steps');
			this.pickStep(step);
			this.syncStepSelection(true);
		} else if (entry.nodeId) {
			this.options.onSelectNode(entry.nodeId);
		}
	}

	private retryRun(run: IWorkflowRun): void {
		const failed = [...run.steps].reverse().find(step => step.state === 'failed');
		if (failed) {
			this.options.onRetryStep(run, failed.nodeId);
		}
	}

	private async clearHistory(): Promise<void> {
		const workflowId = this.options.workflowId();
		if (!workflowId) {
			return;
		}
		const { confirmed } = await this.dialogs.confirm({
			message: localize('voltWorkflows.clearHistoryConfirm', "Clear this workflow's executions?"),
			detail: localize('voltWorkflows.clearHistoryDetail', "Their inputs, outputs and logs are deleted. Chats that agent steps started stay."),
			primaryButton: localize('voltWorkflows.clearHistoryButton', "Clear"),
		});
		if (!confirmed) {
			return;
		}
		await this.workflows.clearRuns(workflowId);
		if (this.run && !isLiveRun(this.run)) {
			this.showRun(undefined);
			this.options.onShowRun(undefined);
		}
		this.syncRuns();
	}

	//#endregion
}
