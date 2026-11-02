/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { describeCron, nextCronRun, parseCron } from '../../../../services/voltRuntime/common/automations/automationCron.js';
import { IVoltMcpServerStatus } from '../../../../services/voltRuntime/common/runtime.js';
import { parseExpression, scopeSuggestions, WorkflowScopeSuggestionKind } from '../../../../services/voltRuntime/common/workflows/workflowExpressions.js';
import { getWorkflowNodeType, nodeDisplayName } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowFieldDef, IWorkflowIssue, IWorkflowSummary, WorkflowNodeColor, WorkflowPortKind, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { AgentModelPicker } from '../picker/agentModelPicker.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { toggleSwitch } from '../automations/automationUi.js';

/**
 * The inspector's form controls, one per field kind, built from Volt's own pieces (inputs, the
 * Volt dropdown and menus, the composer's model picker). Every control reports through `commit`:
 * typing commits quietly (the inspector keeps the field as is), picks commit as `discrete` (the
 * inspector redraws, since other fields or the ports may depend on them).
 */

//#region Sources and context

export interface IWorkflowSkillChoice {
	readonly name: string;
	readonly summary: string;
	readonly location?: string;
}

export interface IWorkflowRepositoryChoice {
	/** Stored URI string of the folder. */
	readonly root: string;
	readonly label: string;
	readonly detail?: string;
}

/** What pickers list: the user's skills, MCP servers, workflows and folders. The page supplies them. */
export interface IWorkflowFieldSources {
	skills(): Promise<readonly IWorkflowSkillChoice[]>;
	mcpServers(): Promise<readonly IVoltMcpServerStatus[]>;
	workflows(): readonly IWorkflowSummary[];
	repositories(): readonly IWorkflowRepositoryChoice[];
	/** The folder dialog; a stored URI string. */
	pickFolder(): Promise<string | undefined>;
}

export interface IWorkflowFieldContext {
	readonly store: DisposableStore;
	readonly contextView: IContextViewService;
	readonly instantiationService: IInstantiationService;
	readonly sources: IWorkflowFieldSources;
	/** `{{ }}` values the field can use (upstream nodes first). */
	readonly suggestions: () => readonly IWorkflowScopeSuggestion[];
	/** The workflow being edited: sub-workflow pickers leave it out. */
	readonly workflowId?: string;
}

/** `discrete`: a pick, not typing; the inspector redraws after it. */
export type WorkflowFieldCommit = (value: WorkflowValue | undefined, discrete?: boolean) => void;

//#endregion

//#region Small helpers

export function asText(value: WorkflowValue | undefined): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return JSON.stringify(value);
}

export function asStringList(value: WorkflowValue | undefined): string[] {
	if (Array.isArray(value)) {
		return value.map(entry => asText(entry)).filter(entry => entry.length > 0);
	}
	return typeof value === 'string' && value ? [value] : [];
}

export function asRecord(value: WorkflowValue | undefined): Record<string, WorkflowValue> {
	return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, WorkflowValue>) } : {};
}

export function sameValue(a: WorkflowValue | undefined, b: WorkflowValue | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "⌘S" on a Mac, "Ctrl+S" elsewhere. */
export function shortcut(key: string, options: { readonly shift?: boolean; readonly alt?: boolean; readonly mod?: boolean } = {}): string {
	const mod = options.mod !== false;
	if (isMacintosh) {
		return `${options.alt ? '⌥' : ''}${options.shift ? '⇧' : ''}${mod ? '⌘' : ''}${key}`;
	}
	return [mod ? 'Ctrl' : '', options.shift ? 'Shift' : '', options.alt ? 'Alt' : '', key].filter(Boolean).join('+');
}

/**
 * Node colours as theme colours: YAML names a colour, the theme decides how it looks. The same
 * mapping as the canvas's `.volt-wf-c-*` classes, so a tile here matches the node's tile there.
 */
export function workflowColorVar(color: WorkflowNodeColor | undefined): string {
	switch (color) {
		case 'blue': return 'var(--vscode-charts-blue, #3794ff)';
		case 'green': return 'var(--vscode-charts-green, #89d185)';
		case 'yellow': return 'var(--vscode-charts-yellow, #cca700)';
		case 'orange': return 'var(--vscode-charts-orange, #d18616)';
		case 'red': return 'var(--vscode-charts-red, #f14c4c)';
		case 'pink': return 'var(--vscode-terminal-ansiMagenta, #d670d6)';
		case 'purple': return 'var(--vscode-charts-purple, #b180d7)';
		case 'teal': return 'var(--vscode-terminal-ansiCyan, #29b8db)';
		default: return 'var(--vscode-descriptionForeground, #8b8b8b)';
	}
}

export function workflowPortColorVar(kind: WorkflowPortKind | undefined): string {
	switch (kind) {
		case 'success': return 'var(--vscode-charts-green)';
		case 'failure': return 'var(--vscode-charts-red)';
		case 'loop': return 'var(--vscode-charts-yellow)';
		default: return 'color-mix(in srgb, var(--vscode-foreground) 60%, transparent)';
	}
}

/** The square icon tile of a node type (pickers, the inspector header), tinted with the node's colour. */
export function workflowIconTile(parent: HTMLElement, icon: ThemeIcon | (() => HTMLElement | SVGElement), color: WorkflowNodeColor | undefined, size: 'small' | 'medium' | 'large' = 'medium'): HTMLElement {
	const tile = append(parent, $(`span.volt-wfb-tile.${size}`));
	tile.style.setProperty('--volt-wfb-color', workflowColorVar(color));
	tile.appendChild(ThemeIcon.isThemeIcon(icon) ? renderIcon(icon) : icon());
	return tile;
}

export function workflowTypeIcon(type: string): ThemeIcon {
	const icon = getWorkflowNodeType(type)?.icon;
	return icon ? ThemeIcon.fromId(icon) : Codicon.circleLargeOutline;
}

const DURATION_UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s", "5m", "1h 30m", "250ms"; a plain number is milliseconds. */
export function parseDuration(text: string): { readonly ms?: number; readonly error?: string } {
	const source = text.trim().toLowerCase();
	if (!source) {
		return {};
	}
	if (/^\d+(\.\d+)?$/.test(source)) {
		return { ms: Math.round(Number(source)) };
	}
	let total = 0;
	let matched = false;
	const rest = source.replace(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\b/g, (_all, amount: string, unit: string) => {
		total += Number(amount) * DURATION_UNITS[unit];
		matched = true;
		return '';
	});
	if (!matched || rest.trim()) {
		return { error: localize('voltWorkflows.badDuration', "Use a duration like 30s, 5m or 1h 30m.") };
	}
	return { ms: Math.round(total) };
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return ms === 0 ? '0s' : '';
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const parts: string[] = [];
	let rest = ms;
	for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
		if (rest >= size) {
			const amount = Math.floor(rest / size);
			parts.push(`${amount}${unit}`);
			rest -= amount * size;
		}
	}
	if (rest) {
		parts.push(`${rest}ms`);
	}
	return parts.join(' ');
}

/** The next few times a cron expression fires, local time ("Mon 09:00"). */
export function nextCronTimes(cron: string, count = 3, now = Date.now()): number[] {
	const parsed = parseCron(cron);
	if (!parsed.schedule) {
		return [];
	}
	const times: number[] = [];
	let after = now;
	for (let i = 0; i < count; i++) {
		const next = nextCronRun(parsed.schedule, after);
		if (next === undefined) {
			break;
		}
		times.push(next);
		after = next;
	}
	return times;
}

export function formatWhen(at: number): string {
	const date = new Date(at);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	return sameDay ? localize('voltWorkflows.todayAt', "Today {0}", time) : `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function formatAgo(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) {
		return localize('voltWorkflows.justNow', "just now");
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return localize('voltWorkflows.minutesAgo', "{0}m ago", minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('voltWorkflows.hoursAgo', "{0}h ago", hours);
	}
	return localize('voltWorkflows.daysAgo', "{0}d ago", Math.round(hours / 24));
}

/** A text input in the builder's look. `data-wf-focus` lets a redraw put focus back. */
export function workflowInput(parent: HTMLElement, value: string, options: { readonly placeholder?: string; readonly ariaLabel: string; readonly mono?: boolean; readonly focusKey?: string; readonly className?: string }): HTMLInputElement {
	const input = append(parent, $(`input.volt-wfb-input${options.mono ? '.mono' : ''}${options.className ? `.${options.className}` : ''}`)) as HTMLInputElement;
	input.type = 'text';
	input.value = value;
	input.spellcheck = false;
	input.placeholder = options.placeholder ?? '';
	input.setAttribute('aria-label', options.ariaLabel);
	if (options.focusKey) {
		input.dataset.wfFocus = options.focusKey;
	}
	return input;
}

/** A textarea that grows with its text (between `min` and `max` px). */
export function workflowTextarea(parent: HTMLElement, value: string, options: { readonly placeholder?: string; readonly ariaLabel: string; readonly mono?: boolean; readonly focusKey?: string; readonly min?: number; readonly max?: number; readonly className?: string }, store: DisposableStore): HTMLTextAreaElement {
	const area = append(parent, $(`textarea.volt-wfb-textarea${options.mono ? '.mono' : ''}${options.className ? `.${options.className}` : ''}`)) as HTMLTextAreaElement;
	area.value = value;
	area.spellcheck = false;
	area.placeholder = options.placeholder ?? '';
	area.setAttribute('aria-label', options.ariaLabel);
	if (options.focusKey) {
		area.dataset.wfFocus = options.focusKey;
	}
	const min = options.min ?? 56;
	const max = options.max ?? 320;
	const fit = () => {
		area.style.height = 'auto';
		area.style.height = `${Math.min(Math.max(area.scrollHeight + 2, min), max)}px`;
	};
	store.add(addDisposableListener(area, 'input', fit));
	getWindow(parent).requestAnimationFrame(fit);
	return area;
}

/** A button that opens a menu: icon, label (muted when it is a placeholder), chevron. */
export function workflowPickerButton(parent: HTMLElement, label: string, options: { readonly icon?: ThemeIcon | (() => HTMLElement | SVGElement); readonly placeholder?: boolean; readonly ariaLabel: string; readonly focusKey?: string; readonly mono?: boolean }): HTMLButtonElement {
	const element = append(parent, $('button.volt-wfb-pick')) as HTMLButtonElement;
	element.type = 'button';
	element.setAttribute('aria-haspopup', 'menu');
	element.setAttribute('aria-label', options.ariaLabel);
	if (options.focusKey) {
		element.dataset.wfFocus = options.focusKey;
	}
	if (options.icon) {
		const icon = append(element, $('span.volt-wfb-pick-icon'));
		icon.appendChild(ThemeIcon.isThemeIcon(options.icon) ? renderIcon(options.icon) : options.icon());
	}
	const text = append(element, $(`span.volt-wfb-pick-label${options.placeholder ? '.placeholder' : ''}${options.mono ? '.mono' : ''}`));
	text.textContent = label;
	element.appendChild(renderIcon(Codicon.chevronDown)).classList.add('volt-wfb-pick-chevron');
	return element;
}

/** An issue line under a field or a section. */
export function renderIssueLines(parent: HTMLElement, issues: readonly IWorkflowIssue[]): void {
	for (const issue of issues) {
		const line = append(parent, $(`.volt-wfb-issue-line.${issue.severity}`));
		line.appendChild(renderIcon(issue.severity === 'error' ? Codicon.error : issue.severity === 'warning' ? Codicon.warning : Codicon.info));
		append(line, $('span')).textContent = issue.message;
	}
}

//#endregion

//#region Row lists

export interface IWorkflowRowListOptions<T> {
	readonly id: string;
	readonly ariaLabel: string;
	readonly rowHeight: number;
	readonly className?: string;
	readonly identity: (row: T) => string;
	readonly rowLabel: (row: T) => string;
	readonly render: (row: T, element: HTMLElement, store: DisposableStore) => void;
	readonly onOpen?: (row: T) => void;
}

interface IRowTemplate {
	readonly element: HTMLElement;
	readonly store: DisposableStore;
}

class WorkflowRowRenderer<T> implements IListRenderer<T, IRowTemplate> {
	static readonly ID = 'volt-wfb-row';
	readonly templateId = WorkflowRowRenderer.ID;
	constructor(private readonly options: IWorkflowRowListOptions<T>) { }
	renderTemplate(container: HTMLElement): IRowTemplate {
		return { element: append(container, $('.volt-wfb-row')), store: new DisposableStore() };
	}
	renderElement(row: T, _index: number, template: IRowTemplate): void {
		template.store.clear();
		clearNode(template.element);
		this.options.render(row, template.element, template.store);
	}
	disposeTemplate(template: IRowTemplate): void {
		template.store.dispose();
	}
}

/**
 * A short, fixed list of rows (ports, outputs, issues) as a WorkbenchList sized to its rows, so it
 * never scrolls on its own and runs edge to edge in its section (volt-lists).
 */
export function renderWorkflowRowList<T>(parent: HTMLElement, rows: readonly T[], options: IWorkflowRowListOptions<T>, instantiationService: IInstantiationService, store: DisposableStore): WorkbenchList<T> {
	const host = append(parent, $('.volt-wfb-row-list'));
	if (options.className) {
		host.classList.add(...options.className.split(' '));
	}
	const delegate: IListVirtualDelegate<T> = { getHeight: () => options.rowHeight, getTemplateId: () => WorkflowRowRenderer.ID };
	const list = store.add(instantiationService.createInstance(WorkbenchList<T>, options.id, host, delegate, [new WorkflowRowRenderer<T>(options)], {
		identityProvider: { getId: (row: T) => options.identity(row) },
		multipleSelectionSupport: false,
		horizontalScrolling: false,
		alwaysConsumeMouseWheel: false,
		setRowLineHeight: false,
		accessibilityProvider: {
			getWidgetAriaLabel: () => options.ariaLabel,
			getAriaLabel: (row: T) => options.rowLabel(row),
		},
	}));
	const height = rows.length * options.rowHeight;
	host.style.height = `${height}px`;
	list.layout(height);
	list.splice(0, 0, [...rows]);
	if (options.onOpen) {
		const open = options.onOpen;
		store.add(list.onDidOpen(e => e.element && open(e.element)));
	}
	return list;
}

//#endregion

//#region Template values

export interface IWorkflowScopeSuggestion {
	/** `nodes.work.summary`, `inputs.task`. */
	readonly path: string;
	readonly description?: string;
	/** Menu section: Inputs, Trigger, a node's name, Variables, Loop, Run. */
	readonly group: string;
}

function suggestionGroup(kind: WorkflowScopeSuggestionKind, nodeId: string | undefined, definition: IWorkflowDefinition): string {
	switch (kind) {
		case 'input': return localize('voltWorkflows.scopeInputs', "Inputs");
		case 'trigger': return localize('voltWorkflows.scopeTrigger', "Trigger");
		case 'variable': return localize('voltWorkflows.scopeVars', "Variables");
		case 'loop': return localize('voltWorkflows.scopeLoop', "Loop");
		case 'run': return localize('voltWorkflows.scopeRun', "Run");
		case 'function': return localize('voltWorkflows.scopeFunctions', "Functions");
		case 'node': {
			const node = nodeId ? definition.nodes.find(entry => entry.id === nodeId) : undefined;
			return node ? `${nodeDisplayName(node)} · ${node.id}` : localize('voltWorkflows.scopeNodes', "Nodes");
		}
	}
}

/**
 * What `{{ }}` can read: at a node, the engine's own answer (upstream outputs nearest first, loop
 * values only inside a loop, variables Set upstream); for workflow-level fields, everything.
 */
export function workflowScopeSuggestions(definition: IWorkflowDefinition, nodeId: string | undefined): IWorkflowScopeSuggestion[] {
	if (nodeId && definition.nodes.some(node => node.id === nodeId)) {
		return scopeSuggestions(definition, nodeId).map(suggestion => ({
			path: suggestion.path,
			...(suggestion.description ? { description: suggestion.description } : {}),
			group: suggestionGroup(suggestion.kind, suggestion.nodeId, definition),
		}));
	}
	const out: IWorkflowScopeSuggestion[] = [];
	const inputsGroup = localize('voltWorkflows.scopeInputs', "Inputs");
	for (const input of definition.inputs ?? []) {
		out.push({ path: `inputs.${input.name}`, description: input.description ?? input.type, group: inputsGroup });
	}
	const triggerGroup = localize('voltWorkflows.scopeTrigger', "Trigger");
	out.push({ path: 'trigger.payload', description: localize('voltWorkflows.scopeTriggerAll', "The trigger payload"), group: triggerGroup });
	const sample = definition.trigger.samplePayload;
	if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
		for (const key of Object.keys(sample).slice(0, 30)) {
			out.push({ path: `trigger.payload.${key}`, group: triggerGroup });
		}
	}
	const varsGroup = localize('voltWorkflows.scopeVars', "Variables");
	for (const name of Object.keys(definition.variables ?? {})) {
		out.push({ path: `vars.${name}`, group: varsGroup });
	}
	for (const node of definition.nodes) {
		const type = getWorkflowNodeType(node.type);
		if (type?.control === 'start') {
			continue;
		}
		const group = `${nodeDisplayName(node)} · ${node.id}`;
		for (const doc of type?.outputDocs ?? []) {
			out.push({ path: `nodes.${node.id}.${doc.key}`, description: doc.description, group });
		}
		if (!type?.outputDocs.length) {
			out.push({ path: `nodes.${node.id}`, description: localize('voltWorkflows.scopeNodeOutput', "The node's output"), group });
		}
	}
	const loopGroup = localize('voltWorkflows.scopeLoop', "Loop");
	out.push({ path: 'item', description: localize('voltWorkflows.scopeItem', "For each: the current item"), group: loopGroup });
	out.push({ path: 'loop.index', description: localize('voltWorkflows.scopeLoopIndex', "The pass number, from 0"), group: loopGroup });
	const runGroup = localize('voltWorkflows.scopeRun', "Run");
	out.push({ path: 'run.id', group: runGroup }, { path: 'run.mode', description: 'simulate | execute', group: runGroup });
	return out;
}

/** The values menu: sections by group, searchable. */
export function showValuesMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, onPick: (path: string) => void, onHide?: () => void): void {
	const groups = new Map<string, IVoltMenuItem<string>[]>();
	for (const suggestion of ctx.suggestions()) {
		let items = groups.get(suggestion.group);
		if (!items) {
			items = [];
			groups.set(suggestion.group, items);
		}
		items.push({ id: suggestion.path, label: suggestion.path, ...(suggestion.description ? { detail: suggestion.description } : {}), data: suggestion.path });
	}
	const sections: IVoltMenuSection<string>[] = [...groups].map(([title, items]) => ({ id: title, title, items }));
	showVoltMenu<string>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 360,
		className: 'volt-auto-menu volt-wfb-menu volt-wfb-values-menu',
		ariaLabel: localize('voltWorkflows.insertValue', "Insert value"),
		search: { placeholder: localize('voltWorkflows.searchValues', "Search values"), icon: true },
		emptyMessage: localize('voltWorkflows.noValues', "No values yet. Add inputs or nodes first."),
		sections,
		onPick: item => onPick(item.data),
		...(onHide ? { onHide } : {}),
	});
}

function insertText(area: HTMLTextAreaElement | HTMLInputElement, start: number, end: number, text: string): void {
	area.focus();
	area.setRangeText(text, start, end, 'end');
	area.dispatchEvent(new Event('input'));
}

/**
 * `{{` opens the values menu, `/` (at the start of a word) the skills, `@` the MCP servers; the pick
 * replaces the trigger characters. The menus have their own search field, so typing goes there.
 */
export function attachTemplateAssist(area: HTMLTextAreaElement | HTMLInputElement, ctx: IWorkflowFieldContext, options: { readonly skills?: boolean; readonly tools?: boolean; readonly raw?: boolean }): void {
	const menu = ctx.store.add(new MutableDisposable());
	ctx.store.add(addDisposableListener(area, 'input', () => {
		const caret = area.selectionStart ?? area.value.length;
		const before = area.value.slice(0, caret);
		const refocus = () => area.focus();
		if (!options.raw && before.endsWith('{{')) {
			showValuesMenu(ctx, area, path => insertText(area, caret - 2, caret, `{{ ${path} }}`), refocus);
			return;
		}
		if (options.skills && /(^|\s)\/$/.test(before)) {
			menu.value = showSkillMenu(ctx, area, undefined, name => insertText(area, caret - 1, caret, `/${name} `), refocus);
			return;
		}
		if (options.tools && /(^|\s)@$/.test(before)) {
			menu.value = showMcpMenu(ctx, area, [], server => insertText(area, caret - 1, caret, `@${server} `), refocus);
		}
	}));
}

/** "Insert value": puts `{{ path }}` (or the bare path, in expressions) at the caret. */
export function insertValueButton(parent: HTMLElement, area: HTMLTextAreaElement | HTMLInputElement, ctx: IWorkflowFieldContext, raw: boolean): HTMLButtonElement {
	const element = append(parent, $('button.volt-wfb-ghost-button')) as HTMLButtonElement;
	element.type = 'button';
	element.appendChild(renderIcon(Codicon.symbolVariable));
	append(element, $('span.label')).textContent = localize('voltWorkflows.value', "Value");
	element.setAttribute('aria-label', localize('voltWorkflows.insertValue', "Insert value"));
	element.title = raw ? localize('voltWorkflows.insertPathTip', "Insert a value path") : localize('voltWorkflows.insertValueTip', "Insert a value (or type {{)");
	ctx.store.add(addDisposableListener(element, 'click', e => {
		e.stopPropagation();
		const start = area.selectionStart ?? area.value.length;
		const end = area.selectionEnd ?? start;
		showValuesMenu(ctx, element, path => insertText(area, start, end, raw ? path : `{{ ${path} }}`));
	}));
	return element;
}

//#endregion

//#region Pickers

export function showSkillMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, current: string | undefined, onPick: (name: string) => void, onHide?: () => void, allowNone = false): { dispose(): void } {
	return showVoltMenu<string>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 340,
		className: 'volt-auto-menu volt-wfb-menu',
		ariaLabel: localize('voltWorkflows.skills', "Skills"),
		search: { placeholder: localize('voltWorkflows.searchSkills', "Search skills"), icon: true },
		sections: async () => {
			const skills = await ctx.sources.skills().catch(() => []);
			return [
				...(allowNone ? [{ id: 'none', items: [{ id: '__none', label: localize('voltWorkflows.noSkill', "No skill"), checked: !current, data: '' }] }] : []),
				{
					id: 'skills',
					title: localize('voltWorkflows.yourSkills', "Your skills"),
					emptyMessage: localize('voltWorkflows.noSkills', "No skills found. Add one in Customize."),
					items: skills.map(skill => ({ id: skill.name, label: `/${skill.name}`, subtitle: skill.summary || undefined, keywords: `${skill.summary} ${skill.location ?? ''}`, checked: skill.name === current, data: skill.name })),
				},
			];
		},
		onPick: item => onPick(item.data),
		...(onHide ? { onHide } : {}),
	});
}

export function showMcpMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, current: readonly string[], onPick: (server: string) => void, onHide?: () => void, allowNone = false): { dispose(): void } {
	return showVoltMenu<string>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 300,
		className: 'volt-auto-menu volt-wfb-menu',
		ariaLabel: localize('voltWorkflows.mcpServers', "MCP servers"),
		search: { placeholder: localize('voltWorkflows.searchServers', "Search MCP servers"), icon: true },
		sections: async () => {
			const servers = await ctx.sources.mcpServers().catch(() => []);
			const item = (server: IVoltMcpServerStatus): IVoltMenuItem<string> => ({ id: server.name, label: server.name, detail: server.state === 'error' ? localize('voltWorkflows.mcpError', "error") : undefined, checked: current.includes(server.name), data: server.name });
			return [
				...(allowNone ? [{ id: 'none', items: [{ id: '__none', label: localize('voltWorkflows.noServer', "No server"), checked: !current.length, data: '' }] }] : []),
				{ id: 'user', title: localize('voltWorkflows.mcpUser', "User"), items: servers.filter(server => server.scope === 'user').map(item) },
				{ id: 'project', title: localize('voltWorkflows.mcpProject', "Project"), items: servers.filter(server => server.scope === 'project').map(item) },
			];
		},
		emptyMessage: localize('voltWorkflows.noMcp', "No MCP servers configured."),
		onPick: item => onPick(item.data),
		...(onHide ? { onHide } : {}),
	});
}

export function showWorkflowPickMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, current: string | undefined, onPick: (id: string) => void): void {
	showVoltMenu<string>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 320,
		className: 'volt-auto-menu volt-wfb-menu',
		ariaLabel: localize('voltWorkflows.workflows', "Workflows"),
		search: { placeholder: localize('voltWorkflows.searchWorkflows', "Search workflows"), icon: true },
		sections: [{
			id: 'workflows',
			emptyMessage: localize('voltWorkflows.noOtherWorkflows', "No other saved workflows yet."),
			items: ctx.sources.workflows().filter(summary => summary.id !== ctx.workflowId).map(summary => ({
				id: summary.id,
				label: summary.name,
				description: summary.id,
				icon: Codicon.typeHierarchy,
				checked: summary.id === current,
				data: summary.id,
			})),
		}],
		onPick: item => onPick(item.data),
	});
}

export function showRepositoryPickMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, current: string | undefined, noneLabel: string, onPick: (root: string | undefined) => void): void {
	type Pick = { readonly kind: 'none' } | { readonly kind: 'root'; readonly root: string } | { readonly kind: 'browse' };
	const choices = ctx.sources.repositories();
	const items: IVoltMenuItem<Pick>[] = choices.map(choice => ({ id: choice.root, label: choice.label, description: choice.detail, icon: Codicon.folder, checked: choice.root === current, data: { kind: 'root', root: choice.root } }));
	if (current && !choices.some(choice => choice.root === current)) {
		items.unshift({ id: current, label: current.split('/').filter(Boolean).pop() ?? current, description: current, icon: Codicon.folder, checked: true, data: { kind: 'root', root: current } });
	}
	showVoltMenu<Pick>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 320,
		className: 'volt-auto-menu volt-wfb-menu',
		ariaLabel: localize('voltWorkflows.repository', "Repository"),
		search: { placeholder: localize('voltWorkflows.searchRepos', "Search folders"), icon: true },
		sections: [
			{ id: 'none', items: [{ id: '__none', label: noneLabel, icon: Codicon.home, checked: !current, data: { kind: 'none' } }] },
			{ id: 'repos', title: localize('voltWorkflows.projects', "Projects"), emptyMessage: localize('voltWorkflows.noProjects', "No projects yet."), items },
		],
		footer: [{ id: 'browse', label: localize('voltWorkflows.chooseFolder', "Choose Folder"), icon: Codicon.folderOpened, data: { kind: 'browse' } }],
		onPick: async item => {
			const data = item.data;
			if (data.kind === 'none') {
				onPick(undefined);
			} else if (data.kind === 'root') {
				onPick(data.root);
			} else {
				const root = await ctx.sources.pickFolder();
				if (root) {
					onPick(root);
				}
			}
		},
	});
}

/** IANA zones from the runtime, local time first. */
export function showTimezoneMenu(ctx: IWorkflowFieldContext, anchor: HTMLElement, current: string | undefined, onPick: (zone: string | undefined) => void): void {
	const supported = (Intl as unknown as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.('timeZone') ?? [];
	const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
	showVoltMenu<string>(ctx.contextView, {
		anchor,
		gap: 4,
		width: 300,
		className: 'volt-auto-menu volt-wfb-menu',
		ariaLabel: localize('voltWorkflows.timezone', "Time zone"),
		search: { placeholder: localize('voltWorkflows.searchZones', "Search time zones"), icon: true },
		sections: [
			{ id: 'local', items: [{ id: '__local', label: localize('voltWorkflows.localTime', "Local time"), description: local, checked: !current, data: '' }] },
			{ id: 'zones', items: supported.map(zone => ({ id: zone, label: zone.replace(/_/g, ' '), keywords: zone, checked: zone === current, data: zone })) },
		],
		onPick: item => onPick(item.data || undefined),
	});
}

//#endregion

//#region Field editors

/** The label row of a field: label, required mark, and the description as a hint line. */
export function fieldShell(parent: HTMLElement, label: string, options: { readonly required?: boolean; readonly description?: string; readonly className?: string } = {}): { readonly box: HTMLElement; readonly head: HTMLElement; readonly body: HTMLElement } {
	const box = append(parent, $(`.volt-wfb-field${options.className ? `.${options.className}` : ''}`));
	const head = append(box, $('.volt-wfb-field-head'));
	append(head, $('label.volt-wfb-field-label')).textContent = label;
	if (options.required) {
		const mark = append(head, $('span.volt-wfb-field-required'));
		mark.textContent = '*';
		mark.title = localize('voltWorkflows.required', "Required");
	}
	const body = append(box, $('.volt-wfb-field-body'));
	if (options.description) {
		append(box, $('.volt-wfb-field-hint')).textContent = options.description;
	}
	return { box, head, body };
}

/** One config field, drawn by its kind. */
export function renderWorkflowField(parent: HTMLElement, field: IWorkflowFieldDef, value: WorkflowValue | undefined, ctx: IWorkflowFieldContext, commit: WorkflowFieldCommit, issues: readonly IWorkflowIssue[] = []): HTMLElement {
	const shell = fieldShell(parent, field.label, { required: field.required, description: field.kind === 'boolean' ? undefined : field.description, className: `kind-${field.kind}` });
	const focusKey = `field:${field.key}`;
	const placeholder = field.placeholder ?? (field.default !== undefined && typeof field.default !== 'object' ? String(field.default) : '');
	const error = append(shell.box, $('.volt-wfb-field-error.hidden'));
	const setError = (message: string | undefined) => {
		error.textContent = message ?? '';
		error.classList.toggle('hidden', !message);
		shell.box.classList.toggle('invalid', !!message);
	};
	switch (field.kind) {
		case 'text': {
			const input = workflowInput(shell.body, asText(value), { placeholder, ariaLabel: field.label, focusKey });
			ctx.store.add(addDisposableListener(input, 'input', () => commit(input.value === '' ? undefined : input.value)));
			if (field.templates) {
				attachTemplateAssist(input, ctx, {});
				insertValueButton(shell.head, input, ctx, false);
			}
			break;
		}
		case 'number': {
			const input = workflowInput(shell.body, asText(value), { placeholder, ariaLabel: field.label, focusKey, className: 'number' });
			input.inputMode = 'decimal';
			ctx.store.add(addDisposableListener(input, 'input', () => {
				const text = input.value.trim();
				if (!text) {
					setError(undefined);
					commit(undefined);
					return;
				}
				const number = Number(text);
				if (!Number.isFinite(number)) {
					setError(localize('voltWorkflows.notANumber', "Enter a number."));
					return;
				}
				if (field.min !== undefined && number < field.min || field.max !== undefined && number > field.max) {
					setError(localize('voltWorkflows.outOfRange', "Between {0} and {1}.", field.min ?? '-\u221E', field.max ?? '\u221E'));
					return;
				}
				setError(undefined);
				commit(number);
			}));
			break;
		}
		case 'duration': {
			const keepText = typeof value === 'string' || typeof field.default === 'string';
			const input = workflowInput(shell.body, typeof value === 'number' ? formatDuration(value) : asText(value), { placeholder: placeholder && typeof field.default === 'number' ? formatDuration(field.default) : placeholder || '30s, 5m, 1h', ariaLabel: field.label, focusKey, className: 'duration' });
			ctx.store.add(addDisposableListener(input, 'input', () => {
				const parsed = parseDuration(input.value);
				setError(parsed.error);
				if (!parsed.error) {
					commit(parsed.ms === undefined ? undefined : keepText ? input.value.trim() : parsed.ms);
				}
			}));
			break;
		}
		case 'multiline': {
			const area = workflowTextarea(shell.body, asText(value), { placeholder, ariaLabel: field.label, focusKey }, ctx.store);
			ctx.store.add(addDisposableListener(area, 'input', () => commit(area.value === '' ? undefined : area.value)));
			if (field.templates) {
				attachTemplateAssist(area, ctx, {});
				insertValueButton(shell.head, area, ctx, false);
			}
			break;
		}
		case 'prompt':
			renderPromptEditor(shell.body, field, value, ctx, commit, focusKey);
			break;
		case 'code': {
			const area = workflowTextarea(shell.body, asText(value), { placeholder, ariaLabel: field.label, focusKey, mono: true, min: 72, max: 360 }, ctx.store);
			area.wrap = 'off';
			ctx.store.add(addDisposableListener(area, 'keydown', e => {
				// Tab indents in code, as an editor would; Shift+Tab leaves the field.
				if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
					e.preventDefault();
					area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
					area.dispatchEvent(new Event('input'));
				}
			}));
			ctx.store.add(addDisposableListener(area, 'input', () => commit(area.value === '' ? undefined : area.value)));
			if (field.templates) {
				attachTemplateAssist(area, ctx, {});
				insertValueButton(shell.head, area, ctx, false);
			}
			break;
		}
		case 'expression': {
			const input = workflowInput(shell.body, asText(value), { placeholder: placeholder || 'nodes.check.exitCode == 0', ariaLabel: field.label, focusKey, mono: true });
			const check = () => {
				const text = input.value.trim();
				setError(text ? parseExpression(text).error : undefined);
			};
			check();
			ctx.store.add(addDisposableListener(input, 'input', () => {
				check();
				commit(input.value.trim() === '' ? undefined : input.value);
			}));
			insertValueButton(shell.head, input, ctx, true);
			break;
		}
		case 'boolean': {
			const row = append(shell.body, $('.volt-wfb-switch-row'));
			if (field.description) {
				append(row, $('span.volt-wfb-switch-text')).textContent = field.description;
			}
			const toggle = toggleSwitch(row, value === true || (value === undefined && field.default === true), field.label, ctx.store, on => commit(on, true));
			toggle.dataset.wfFocus = focusKey;
			break;
		}
		case 'select': {
			const options = (field.options ?? []).map(option => ({ id: option.value, label: option.label, ...(option.description ? { description: option.description } : {}) }));
			const current = asText(value ?? field.default);
			if (current && !options.some(option => option.id === current)) {
				options.push({ id: current, label: current });
			}
			if (!options.length) {
				options.push({ id: '', label: localize('voltWorkflows.none', "None") });
			}
			const dropdown = createVoltDropdown(shell.body, ctx.contextView, {
				options,
				value: current || options[0].id,
				ariaLabel: field.label,
				align: 'left',
				onChange: id => commit(id, true),
			}, ctx.store);
			dropdown.element.dataset.wfFocus = focusKey;
			break;
		}
		case 'model':
			renderModelField(shell.body, value, ctx, commit, focusKey, localize('voltWorkflows.workflowDefault', "Workflow default"), localize('voltWorkflows.workflowDefaultDesc', "Use the workflow's default model"));
			break;
		case 'skill': {
			const name = asText(value);
			const button = workflowPickerButton(shell.body, name ? `/${name}` : localize('voltWorkflows.chooseSkill', "Choose a skill"), { icon: Codicon.symbolKeyword, placeholder: !name, ariaLabel: field.label, focusKey });
			ctx.store.add(addDisposableListener(button, 'click', () => showSkillMenu(ctx, button, name || undefined, picked => commit(picked || undefined, true), undefined, !field.required)));
			break;
		}
		case 'mcpServer': {
			const name = asText(value);
			const button = workflowPickerButton(shell.body, name || localize('voltWorkflows.chooseServer', "Choose a server"), { icon: Codicon.server, placeholder: !name, ariaLabel: field.label, focusKey });
			ctx.store.add(addDisposableListener(button, 'click', () => showMcpMenu(ctx, button, name ? [name] : [], picked => commit(picked || undefined, true), undefined, !field.required)));
			break;
		}
		case 'workflow': {
			const id = asText(value);
			const summary = ctx.sources.workflows().find(entry => entry.id === id);
			const button = workflowPickerButton(shell.body, summary?.name ?? (id || localize('voltWorkflows.chooseWorkflow', "Choose a workflow")), { icon: Codicon.typeHierarchy, placeholder: !id, ariaLabel: field.label, focusKey });
			ctx.store.add(addDisposableListener(button, 'click', () => showWorkflowPickMenu(ctx, button, id || undefined, picked => commit(picked, true))));
			break;
		}
		case 'repository': {
			const root = asText(value);
			const choice = ctx.sources.repositories().find(entry => entry.root === root);
			const label = choice?.label ?? (root ? root.split('/').filter(Boolean).pop() ?? root : localize('voltWorkflows.workflowRepo', "Workflow repository"));
			const button = workflowPickerButton(shell.body, label, { icon: Codicon.folder, placeholder: !root, ariaLabel: field.label, focusKey });
			ctx.store.add(addDisposableListener(button, 'click', () => showRepositoryPickMenu(ctx, button, root || undefined, localize('voltWorkflows.workflowRepo', "Workflow repository"), picked => commit(picked, true))));
			break;
		}
		case 'cron':
			renderCronEditor(shell.body, asText(value), placeholder || '0 9 * * 1-5', ctx, text => commit(text || undefined), setError, focusKey);
			break;
		case 'keyValue':
			renderKeyValueEditor(shell.body, asRecord(value), field.label, ctx, (record, discrete) => commit(Object.keys(record).length ? record : undefined, discrete), focusKey);
			break;
		case 'list':
			renderListEditor(shell.body, asStringList(value), field, ctx, (items, discrete) => commit(items.length ? items : undefined, discrete), focusKey);
			break;
		case 'json': {
			const allowText = !!field.templates;
			const area = renderJsonEditor(shell.body, value, field.label, placeholder || '{ }', ctx, next => commit(next), setError, focusKey, allowText);
			if (allowText) {
				insertValueButton(shell.head, area, ctx, false);
			}
			break;
		}
	}
	renderIssueLines(shell.box, issues);
	return shell.box;
}

/** The composer-like prompt box: a growing textarea and a footer with Value, Skill and Tool. */
function renderPromptEditor(parent: HTMLElement, field: IWorkflowFieldDef, value: WorkflowValue | undefined, ctx: IWorkflowFieldContext, commit: WorkflowFieldCommit, focusKey: string): void {
	const box = append(parent, $('.volt-wfb-prompt'));
	const area = workflowTextarea(box, asText(value), { placeholder: field.placeholder ?? localize('voltWorkflows.promptPlaceholder', "Type / for skills, @ for tools, {{ for values"), ariaLabel: field.label, focusKey, min: 96, max: 420, className: 'volt-wfb-prompt-input' }, ctx.store);
	ctx.store.add(addDisposableListener(area, 'input', () => commit(area.value === '' ? undefined : area.value)));
	attachTemplateAssist(area, ctx, { skills: true, tools: true });
	const footer = append(box, $('.volt-wfb-prompt-footer'));
	insertValueButton(footer, area, ctx, false);
	const insertAtCaret = (text: string) => {
		const start = area.selectionStart ?? area.value.length;
		const end = area.selectionEnd ?? start;
		const before = area.value.slice(0, start);
		insertText(area, start, end, `${before && !/\s$/.test(before) ? ' ' : ''}${text}`);
	};
	const skill = append(footer, $('button.volt-wfb-ghost-button')) as HTMLButtonElement;
	skill.type = 'button';
	skill.appendChild(renderIcon(Codicon.symbolKeyword));
	append(skill, $('span.label')).textContent = localize('voltWorkflows.skill', "Skill");
	skill.title = localize('voltWorkflows.insertSkillTip', "Insert a skill (or type /)");
	ctx.store.add(addDisposableListener(skill, 'click', e => {
		e.stopPropagation();
		showSkillMenu(ctx, skill, undefined, name => insertAtCaret(`/${name} `));
	}));
	const tool = append(footer, $('button.volt-wfb-ghost-button')) as HTMLButtonElement;
	tool.type = 'button';
	tool.appendChild(renderIcon(Codicon.server));
	append(tool, $('span.label')).textContent = localize('voltWorkflows.tool', "Tool");
	tool.title = localize('voltWorkflows.insertToolTip', "Mention an MCP server (or type @)");
	ctx.store.add(addDisposableListener(tool, 'click', e => {
		e.stopPropagation();
		showMcpMenu(ctx, tool, [], server => insertAtCaret(`@${server} `));
	}));
	append(footer, $('span.volt-wfb-spacer'));
	const count = append(footer, $('span.volt-wfb-prompt-count'));
	const sync = () => count.textContent = area.value.length ? localize('voltWorkflows.chars', "{0} chars", area.value.length) : '';
	sync();
	ctx.store.add(addDisposableListener(area, 'input', sync));
	ctx.store.add(addDisposableListener(area, 'focus', () => box.classList.add('focused')));
	ctx.store.add(addDisposableListener(area, 'blur', () => box.classList.remove('focused')));
}

/** The composer's model picker as a ghost button (no fill): "Opus 5.5 Extra High" with its chevron. */
export function renderModelField(parent: HTMLElement, value: WorkflowValue | undefined, ctx: IWorkflowFieldContext, commit: WorkflowFieldCommit, focusKey: string, autoLabel: string, autoDescription: string): void {
	let current = typeof value === 'string' && value ? value : undefined;
	const button = append(parent, $('button.volt-agent-model.volt-wfb-model-button')) as HTMLButtonElement;
	button.type = 'button';
	button.dataset.wfFocus = focusKey;
	button.setAttribute('aria-haspopup', 'dialog');
	button.setAttribute('aria-label', localize('voltWorkflows.model', "Model"));
	const picker = ctx.store.add(ctx.instantiationService.createInstance(AgentModelPicker, {
		binding: {
			get: () => current,
			set: ref => {
				current = ref;
				commit(ref, true);
			},
			autoLabel,
			autoDescription,
		},
		onDidChange: () => paint(),
	}));
	const paint = () => {
		button.replaceChildren();
		picker.renderTrigger(button);
		button.appendChild(renderIcon(Codicon.chevronDown)).classList.add('volt-wfb-model-chevron');
	};
	paint();
	ctx.store.add(addDisposableListener(button, 'click', () => picker.show(button, () => paint())));
}

function renderCronEditor(parent: HTMLElement, value: string, placeholder: string, ctx: IWorkflowFieldContext, commit: (text: string) => void, setError: (message: string | undefined) => void, focusKey: string): void {
	const input = workflowInput(parent, value, { placeholder, ariaLabel: localize('voltWorkflows.cron', "Cron expression"), mono: true, focusKey });
	const preview = append(parent, $('.volt-wfb-cron-preview'));
	const sync = () => {
		clearNode(preview);
		const text = input.value.trim();
		if (!text) {
			setError(undefined);
			return;
		}
		const parsed = parseCron(text);
		setError(parsed.error);
		if (!parsed.schedule) {
			return;
		}
		append(preview, $('.volt-wfb-cron-desc')).textContent = describeCron(text);
		const times = nextCronTimes(text);
		if (times.length) {
			append(preview, $('.volt-wfb-cron-next')).textContent = localize('voltWorkflows.nextRuns', "Next: {0}", times.map(formatWhen).join(' · '));
		}
	};
	sync();
	ctx.store.add(addDisposableListener(input, 'input', () => {
		sync();
		if (!parseCron(input.value.trim()).error || !input.value.trim()) {
			commit(input.value.trim());
		}
	}));
}

/** Ordered `key: value` rows; empty keys are dropped. Values keep their JSON type when they parse. */
export function renderKeyValueEditor(parent: HTMLElement, value: Record<string, WorkflowValue>, label: string, ctx: IWorkflowFieldContext, commit: (record: Record<string, WorkflowValue>, discrete: boolean) => void, focusKey: string): void {
	const box = append(parent, $('.volt-wfb-kv'));
	const rows = append(box, $('.volt-wfb-kv-rows'));
	const read = (): Record<string, WorkflowValue> => {
		const record: Record<string, WorkflowValue> = {};
		for (const row of rows.querySelectorAll<HTMLElement>('.volt-wfb-kv-row')) {
			const [keyInput, valueInput] = row.querySelectorAll<HTMLInputElement>('input');
			const key = keyInput.value.trim();
			if (key) {
				record[key] = typedValue(valueInput.value);
			}
		}
		return record;
	};
	const addRow = (key: string, text: string, index: number): HTMLInputElement => {
		const row = append(rows, $('.volt-wfb-kv-row'));
		const keyInput = workflowInput(row, key, { placeholder: localize('voltWorkflows.key', "Key"), ariaLabel: localize('voltWorkflows.keyOf', "{0} key", label), mono: true, focusKey: `${focusKey}:k${index}` });
		const valueInput = workflowInput(row, text, { placeholder: localize('voltWorkflows.valuePlaceholder', "Value"), ariaLabel: localize('voltWorkflows.valueOf', "{0} value", label), focusKey: `${focusKey}:v${index}` });
		attachTemplateAssist(valueInput, ctx, {});
		ctx.store.add(addDisposableListener(keyInput, 'input', () => commit(read(), false)));
		ctx.store.add(addDisposableListener(valueInput, 'input', () => commit(read(), false)));
		const remove = append(row, $('button.volt-wfb-icon-button.small')) as HTMLButtonElement;
		remove.type = 'button';
		remove.appendChild(renderIcon(Codicon.close));
		remove.setAttribute('aria-label', localize('voltWorkflows.removeRow', "Remove"));
		remove.title = localize('voltWorkflows.removeRow', "Remove");
		ctx.store.add(addDisposableListener(remove, 'click', () => {
			row.remove();
			commit(read(), true);
		}));
		return keyInput;
	};
	let index = 0;
	for (const [key, entry] of Object.entries(value)) {
		addRow(key, typeof entry === 'string' ? entry : JSON.stringify(entry), index++);
	}
	const add = append(box, $('button.volt-wfb-add-row')) as HTMLButtonElement;
	add.type = 'button';
	add.dataset.wfFocus = `${focusKey}:add`;
	add.appendChild(renderIcon(Codicon.add));
	append(add, $('span')).textContent = localize('voltWorkflows.addPair', "Add");
	ctx.store.add(addDisposableListener(add, 'click', () => addRow('', '', index++).focus()));
}

/** "true", "3", "[1,2]" keep their type; everything else is text. */
function typedValue(text: string): WorkflowValue {
	const trimmed = text.trim();
	if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/s.test(trimmed)) {
		try {
			return JSON.parse(trimmed) as WorkflowValue;
		} catch {
			// Text after all.
		}
	}
	return text;
}

/** Chips with × and an input that adds on Enter or comma; options or suggestions add from a menu. */
export function renderListEditor(parent: HTMLElement, items: string[], field: Pick<IWorkflowFieldDef, 'key' | 'label' | 'placeholder' | 'options'>, ctx: IWorkflowFieldContext, commit: (items: string[], discrete: boolean) => void, focusKey: string): void {
	const box = append(parent, $('.volt-wfb-chips'));
	let current = [...items];
	const input = workflowInput(box, '', { placeholder: field.placeholder ?? localize('voltWorkflows.addItem', "Add {0}", field.label.toLowerCase()), ariaLabel: field.label, focusKey: `${focusKey}:add`, className: 'volt-wfb-chip-input' });
	const draw = () => {
		for (const chip of box.querySelectorAll('.volt-wfb-chip')) {
			chip.remove();
		}
		current.forEach((item, index) => {
			const chip = $('span.volt-wfb-chip');
			box.insertBefore(chip, input);
			const option = field.options?.find(entry => entry.value === item);
			append(chip, $('span.label')).textContent = option?.label ?? item;
			const remove = append(chip, $('button.volt-wfb-chip-remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.appendChild(renderIcon(Codicon.close));
			remove.setAttribute('aria-label', localize('voltWorkflows.removeItem', "Remove {0}", item));
			ctx.store.add(addDisposableListener(remove, 'click', e => {
				e.stopPropagation();
				current = current.filter((_, i) => i !== index);
				draw();
				commit(current, true);
			}));
		});
	};
	const addValue = (raw: string) => {
		const next = raw.split(',').map(entry => entry.trim()).filter(entry => entry && !current.includes(entry));
		if (next.length) {
			current = [...current, ...next];
			draw();
			commit(current, true);
		}
	};
	draw();
	ctx.store.add(addDisposableListener(box, 'mousedown', e => {
		if (e.target === box) {
			e.preventDefault();
			input.focus();
		}
	}));
	ctx.store.add(addDisposableListener(input, 'keydown', e => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addValue(input.value);
			input.value = '';
		} else if (e.key === 'Backspace' && !input.value && current.length) {
			current = current.slice(0, -1);
			draw();
			commit(current, true);
		}
	}));
	ctx.store.add(addDisposableListener(input, 'blur', () => {
		if (input.value.trim()) {
			addValue(input.value);
			input.value = '';
		}
	}));
	const suggest = field.options?.length ? 'options' : /mcp/i.test(field.key) ? 'mcp' : /skill/i.test(field.key) ? 'skills' : undefined;
	if (suggest) {
		const more = append(box, $('button.volt-wfb-icon-button.small.volt-wfb-chip-add')) as HTMLButtonElement;
		more.type = 'button';
		more.appendChild(renderIcon(Codicon.add));
		more.setAttribute('aria-label', localize('voltWorkflows.addFrom', "Add {0}", field.label.toLowerCase()));
		more.title = more.getAttribute('aria-label')!;
		ctx.store.add(addDisposableListener(more, 'click', e => {
			e.stopPropagation();
			if (suggest === 'mcp') {
				showMcpMenu(ctx, more, current, server => addValue(server));
			} else if (suggest === 'skills') {
				showSkillMenu(ctx, more, undefined, name => addValue(name));
			} else {
				showVoltMenu<string>(ctx.contextView, {
					anchor: more,
					gap: 4,
					width: 240,
					className: 'volt-auto-menu volt-wfb-menu',
					ariaLabel: field.label,
					sections: [{ id: 'options', items: (field.options ?? []).map(option => ({ id: option.value, label: option.label, subtitle: option.description, checked: current.includes(option.value), keepOpen: false, data: option.value })) }],
					onPick: item => current.includes(item.data) ? undefined : addValue(item.data),
				});
			}
		}));
	}
}

/**
 * JSON in a monospace box. Valid JSON is committed as its value; with `allowText` (template
 * fields) anything else is kept as text, so `{{ nodes.find.files }}` or one item per line work.
 * Otherwise only valid JSON is committed and the error shows under it.
 */
export function renderJsonEditor(parent: HTMLElement, value: WorkflowValue | undefined, label: string, placeholder: string, ctx: IWorkflowFieldContext, commit: (value: WorkflowValue | undefined) => void, setError: (message: string | undefined) => void, focusKey: string, allowText = false): HTMLTextAreaElement {
	const shown = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	const area = workflowTextarea(parent, shown, { placeholder, ariaLabel: label, mono: true, focusKey, min: 72, max: 360 }, ctx.store);
	area.wrap = 'off';
	ctx.store.add(addDisposableListener(area, 'input', () => {
		const text = area.value.trim();
		if (!text) {
			setError(undefined);
			commit(undefined);
			return;
		}
		try {
			const parsed = JSON.parse(text) as WorkflowValue;
			setError(undefined);
			commit(parsed);
		} catch (err) {
			if (allowText) {
				setError(undefined);
				commit(area.value);
			} else {
				setError(localize('voltWorkflows.badJson', "Not valid JSON: {0}", err instanceof Error ? err.message : String(err)));
			}
		}
	}));
	if (allowText) {
		attachTemplateAssist(area, ctx, {});
	}
	return area;
}

//#endregion
