/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getActiveElement, getWindow, isHTMLElement, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AUTOMATION_PROVIDERS, AutomationProvider, eventOption } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { outgoingEdges } from '../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { getWorkflowNodeType, nodeDisplayName, nodeOutputs } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowFieldDef, IWorkflowInputDef, IWorkflowIssue, IWorkflowNode, IWorkflowNodeType, IWorkflowPortDef, IWorkflowRun, IWorkflowSettings, IWorkflowStepRecord, IWorkflowTrigger, WORKFLOW_DEFAULT_CONCURRENCY, WORKFLOW_DEFAULT_MAX_STEPS, WORKFLOW_HARD_MAX_STEPS, WORKFLOW_ID_PATTERN, WORKFLOW_NODE_COLORS, WorkflowApprovalDecision, WorkflowErrorMode, WorkflowInputType, WorkflowNodeColor, WorkflowRecord, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { WorkflowCodeEditor } from './workflowCodeEditor.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { toggleSwitch } from '../automations/automationUi.js';
import { describeWorkflowTrigger, showWorkflowTriggerMenu, workflowTriggerIcon } from './workflowBlockPicker.js';
import { asText, fieldShell, formatDuration, IWorkflowFieldContext, IWorkflowFieldSources, parseDuration, renderIssueLines, renderJsonEditor, renderKeyValueEditor, renderListEditor, renderModelField, renderWorkflowField, renderWorkflowRowList, sameValue, showRepositoryPickMenu, showTimezoneMenu, WorkflowFieldCommit, workflowColorVar, workflowIconTile, workflowInput, workflowPickerButton, workflowPortColorVar, workflowScopeSuggestions, workflowTextarea, workflowTypeIcon } from './workflowFieldEditors.js';

/**
 * The right panel's form. A selected node: its header, id and name, every field of its type (by
 * kind, advanced ones folded), error handling, pinned output, where each port leads and what it
 * offers to templates, notes. Nothing selected: the workflow itself (trigger, inputs, variables,
 * settings, unwired ports, Describe, issues). Every edit goes through the editor model; typing
 * coalesces into one undo step per field, and redraws keep focus where it was.
 */

export interface IWorkflowInspectorOptions {
	readonly sources: IWorkflowFieldSources;
	readonly workflowId: () => string | undefined;
	readonly onRevealNode: (nodeId: string) => void;
	readonly onRevealIssue: (issue: IWorkflowIssue) => void;
	readonly onRunNode: (nodeId: string) => void;
	readonly onApprove: (nodeId: string, decision: WorkflowApprovalDecision) => void;
	readonly onDescribe: (text: string) => void;
	readonly onBrowseTemplates: () => void;
	readonly onAutoLayoutSelection: () => void;
}

const ROW = 28;
const TWO_LINE_ROW = 44;

function compact<T extends object>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined && entry !== '' && !(Array.isArray(entry) && entry.length === 0)) {
			out[key] = entry;
		}
	}
	return out as T;
}

function lastStep(run: IWorkflowRun | undefined, nodeId: string): IWorkflowStepRecord | undefined {
	if (!run) {
		return undefined;
	}
	for (let i = run.steps.length - 1; i >= 0; i--) {
		if (run.steps[i].nodeId === nodeId) {
			return run.steps[i];
		}
	}
	return undefined;
}

function fieldVisible(field: IWorkflowFieldDef, config: WorkflowRecord, fields: readonly IWorkflowFieldDef[]): boolean {
	const when = field.visibleWhen;
	if (!when) {
		return true;
	}
	const value = config[when.key] ?? fields.find(entry => entry.key === when.key)?.default;
	return when.equals.some(expected => sameValue(expected, value));
}

export class WorkflowInspector extends Disposable {

	readonly element: HTMLElement;
	private readonly scroll: DomScrollableElement;
	private readonly viewport: HTMLElement;
	private readonly content: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	/** Issue lines drawn per field (`''`: the node or workflow), updated in place as validation runs. */
	private readonly issueSlots = new Map<string, HTMLElement>();
	private issuesSection: { readonly host: HTMLElement; readonly store: DisposableStore } | undefined;
	private runSlot: HTMLElement | undefined;
	private readonly openSections = new Map<string, boolean>();
	private issues: readonly IWorkflowIssue[] = [];
	private run: IWorkflowRun | undefined;
	private runSignature = '';
	private signature = '';
	private quiet = 0;
	private redrawPending = false;
	private describing = false;
	private describeDraft = '';
	private editingPin: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly model: WorkflowEditorModel,
		private readonly options: IWorkflowInspectorOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super();
		this.element = append(container, $('.volt-wfb-inspector'));
		// The scrollable measures its viewport from the element it scrolls, so that one has the
		// pane's height and the form is drawn inside it.
		this.viewport = $('.volt-wfb-insp-viewport');
		this.content = append(this.viewport, $('.volt-wfb-insp-content'));
		this.scroll = this._register(createAgentScrollable(this.viewport));
		append(this.element, this.scroll.getDomNode());
		// Rows added in place, a resized textarea, a section opening: the form grows without a redraw.
		const observer = new (getWindow(container).ResizeObserver)(() => this.scroll.scanDomNode());
		observer.observe(this.content);
		this._register(toDisposable(() => observer.disconnect()));
		// Focusing a field below the fold scrolls the viewport natively; keep the scrollbar with it.
		this._register(addDisposableListener(this.viewport, 'scroll', () => {
			if (this.viewport.scrollTop !== this.scroll.getScrollPosition().scrollTop) {
				this.scroll.setScrollPosition({ scrollTop: this.viewport.scrollTop });
			}
		}));
		this._register(model.onDidChange(() => {
			if (!this.quiet) {
				this.scheduleRedraw();
			}
		}));
		this._register(model.onDidChangeSelection(() => {
			this.editingPin = undefined;
			this.redraw(true);
		}));
		this.redraw(true);
	}

	layout(width: number, height: number): void {
		// The side panel draws a 1px border inside its width; the content gets an explicit width so
		// nothing (grids, long hints) can grow it past the visible pane.
		const inner = Math.max(0, width - 1);
		this.element.style.width = `${inner}px`;
		this.viewport.style.width = `${inner}px`;
		this.element.style.height = `${height}px`;
		this.viewport.style.height = `${height}px`;
		this.scroll.getDomNode().style.height = `${height}px`;
		this.scroll.scanDomNode();
	}

	focus(): void {
		(this.content.querySelector<HTMLElement>('input, textarea, button') ?? this.element).focus();
	}

	/** Puts focus in a field of the selected node (the canvas's "configure"). */
	focusField(key: string): void {
		this.content.querySelector<HTMLElement>(`[data-wf-focus="field:${CSS.escape(key)}"]`)?.focus();
	}

	setIssues(issues: readonly IWorkflowIssue[]): void {
		this.issues = issues;
		for (const [key, slot] of this.issueSlots) {
			clearNode(slot);
			renderIssueLines(slot, this.slotIssues(key));
		}
		this.renderIssuesList();
		this.scroll.scanDomNode();
	}

	setRun(run: IWorkflowRun | undefined): void {
		this.run = run;
		const selected = this.model.selection.length === 1 ? this.model.selection[0] : undefined;
		const step = selected ? lastStep(run, selected) : undefined;
		const signature = step ? `${run?.id}:${step.id}:${step.state}:${step.waitingFor ?? ''}:${step.error ?? ''}` : '';
		if (signature !== this.runSignature) {
			this.runSignature = signature;
			this.renderRunSlot();
		}
	}

	setDescribing(busy: boolean): void {
		if (busy !== this.describing) {
			this.describing = busy;
			if (!busy) {
				this.describeDraft = '';
			}
			this.redraw(true);
		}
	}

	//#region Drawing

	private quietly(change: () => void): void {
		this.quiet++;
		try {
			change();
		} finally {
			this.quiet--;
		}
	}

	private scheduleRedraw(): void {
		if (this.redrawPending) {
			return;
		}
		this.redrawPending = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.redrawPending = false;
			if (!this._store.isDisposed) {
				this.redraw(false);
			}
		});
	}

	/** What the panel shows, minus positions: a drag on the canvas does not redraw the form. */
	private viewSignature(): string {
		const definition = this.model.definition;
		const selection = this.model.selection;
		const strip = (node: IWorkflowNode) => ({ ...node, position: undefined });
		if (selection.length === 1) {
			const node = this.model.node(selection[0]);
			return JSON.stringify({
				selection,
				node: node && strip(node),
				edges: node ? outgoingEdges(definition, node.id) : [],
				names: definition.nodes.map(entry => [entry.id, entry.name, entry.type]),
				trigger: node?.type === 'start' ? definition.trigger : undefined,
				inputs: node?.type === 'start' ? definition.inputs : undefined,
				pin: this.editingPin,
				describing: this.describing,
			});
		}
		return JSON.stringify({ selection, definition: { ...definition, nodes: definition.nodes.map(strip) }, describing: this.describing });
	}

	private redraw(force: boolean): void {
		const signature = this.viewSignature();
		if (!force && signature === this.signature) {
			return;
		}
		this.signature = signature;
		const active = getActiveElement();
		const focusKey = isHTMLElement(active) && this.content.contains(active) ? active.dataset.wfFocus : undefined;
		const range = isHTMLInputElement(active) || isHTMLTextAreaElement(active) ? [active.selectionStart, active.selectionEnd] as const : undefined;
		const scrollTop = this.scroll.getScrollPosition().scrollTop;

		this.renderStore.clear();
		this.issueSlots.clear();
		this.issuesSection = undefined;
		this.runSlot = undefined;
		clearNode(this.content);

		const nodes = this.model.selection.map(id => this.model.node(id)).filter((node): node is IWorkflowNode => !!node);
		if (nodes.length > 1) {
			this.drawMulti(nodes);
		} else if (nodes.length === 1) {
			this.drawNode(nodes[0]);
		} else {
			this.drawWorkflow();
		}

		this.scroll.scanDomNode();
		this.scroll.setScrollPosition({ scrollTop });
		if (focusKey) {
			const target = this.content.querySelector<HTMLElement>(`[data-wf-focus="${CSS.escape(focusKey)}"]`);
			target?.focus();
			if (range && (isHTMLInputElement(target) || isHTMLTextAreaElement(target))) {
				target.setSelectionRange(range[0], range[1]);
			}
		}
	}

	private fieldContext(nodeId: string | undefined): IWorkflowFieldContext {
		return {
			store: this.renderStore,
			contextView: this.contextView,
			instantiationService: this.instantiationService,
			sources: this.options.sources,
			suggestions: () => workflowScopeSuggestions(this.model.definition, nodeId),
			workflowId: this.options.workflowId(),
		};
	}

	/** The panel's title: the icon on its own (no tile), the name, and what it is under it. */
	private head(icon: ThemeIcon, color: string | undefined, name: string, kind: string): HTMLElement {
		const head = append(this.content, $('.volt-wfb-insp-head'));
		const glyph = append(head, $('span.volt-wfb-insp-icon'));
		glyph.appendChild(renderIcon(icon));
		if (color) {
			glyph.style.color = color;
		}
		const titles = append(head, $('.volt-wfb-insp-titles'));
		append(titles, $('.volt-wfb-insp-name')).textContent = name;
		append(titles, $('.volt-wfb-insp-type')).textContent = kind;
		return head;
	}

	/**
	 * A titled group with a header like VS Code's sidebar sections (and the node picker's categories).
	 * Every group folds unless it says otherwise, and remembers whether it was open.
	 */
	private section(parent: HTMLElement, id: string, title: string, options: { readonly collapsible?: boolean; readonly open?: boolean; readonly count?: number; readonly className?: string } = {}): HTMLElement {
		const section = append(parent, $(`.volt-wfb-section${options.className ? `.${options.className}` : ''}`));
		const collapsible = options.collapsible ?? true;
		const open = collapsible ? this.openSections.get(id) ?? options.open ?? true : true;
		section.classList.toggle('collapsed', !open);
		const head = append(section, $(collapsible ? 'button.volt-wfb-section-head.collapsible' : '.volt-wfb-section-head'));
		if (collapsible) {
			(head as HTMLButtonElement).type = 'button';
			head.setAttribute('aria-expanded', String(open));
			head.appendChild(renderIcon(open ? Codicon.chevronDown : Codicon.chevronRight)).classList.add('chevron');
			this.renderStore.add(addDisposableListener(head, 'click', () => {
				this.openSections.set(id, !open);
				this.redraw(true);
			}));
		} else {
			append(head, $('span.chevron-space'));
		}
		append(head, $('span.volt-wfb-section-title')).textContent = title;
		if (options.count !== undefined) {
			append(head, $('span.volt-wfb-section-count')).textContent = String(options.count);
		}
		const body = append(section, $('.volt-wfb-section-body'));
		if (!open) {
			body.classList.add('hidden');
		}
		return body;
	}

	private issueSlot(parent: HTMLElement, key: string): void {
		const slot = append(parent, $('.volt-wfb-issue-slot'));
		this.issueSlots.set(key, slot);
		renderIssueLines(slot, this.slotIssues(key));
	}

	/** `node:<id>:<field>`, `node:<id>`, `workflow`. */
	private slotIssues(key: string): readonly IWorkflowIssue[] {
		if (key === 'workflow') {
			return this.issues.filter(issue => !issue.nodeId && !issue.edgeId && issue.code !== 'yaml-syntax');
		}
		const [, nodeId, field] = key.split(':');
		return this.issues.filter(issue => issue.nodeId === nodeId && (field ? issue.field === field : !issue.field));
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: (button: HTMLButtonElement) => void, className = ''): HTMLButtonElement {
		const element = append(parent, $(`button.volt-wfb-icon-button${className ? `.${className}` : ''}`)) as HTMLButtonElement;
		element.type = 'button';
		element.appendChild(renderIcon(icon));
		element.setAttribute('aria-label', label);
		setAgentTooltip(element, label);
		this.renderStore.add(addDisposableListener(element, 'click', e => {
			e.stopPropagation();
			run(element);
		}));
		return element;
	}

	private textButton(parent: HTMLElement, label: string, kind: 'primary' | 'secondary' | 'ghost' | 'danger', run: () => void, icon?: ThemeIcon): void {
		const button = this.renderStore.add(createVoltButton(parent, kind, { supportIcons: !!icon }));
		button.label = icon ? `$(${icon.id}) ${label}` : label;
		this.renderStore.add(button.onDidClick(run));
	}

	//#endregion

	//#region Node

	private drawNode(node: IWorkflowNode): void {
		const type = getWorkflowNodeType(node.type);
		const head = this.head(workflowTypeIcon(node.type), workflowColorVar(node.color ?? type?.color), nodeDisplayName(node), type?.label ?? node.type);
		const actions = append(head, $('.volt-wfb-insp-actions'));
		if (type?.control !== 'start') {
			this.iconButton(actions, Codicon.play, localize('voltWorkflows.runStep', "Run this step"), () => this.options.onRunNode(node.id));
		}
		this.iconButton(actions, Codicon.ellipsis, localize('voltWorkflows.nodeMore', "More"), anchor => this.showNodeMenu(node, anchor));
		if (type?.control !== 'start' || this.model.definition.nodes.filter(entry => entry.type === 'start').length > 1) {
			this.iconButton(actions, Codicon.trash, localize('voltWorkflows.deleteNode', "Delete node"), () => this.model.removeNodes([node.id]), 'danger');
		}
		if (node.disabled) {
			append(this.content, $('.volt-wfb-insp-note')).textContent = localize('voltWorkflows.disabledNote', "Disabled: runs skip this node and pass its input on.");
		}
		this.runSlot = append(this.content, $('.volt-wfb-run-slot'));
		this.renderRunSlot();
		this.issueSlot(this.content, `node:${node.id}`);

		if (!type) {
			append(this.content, $('.volt-wfb-insp-note.warning')).textContent = localize('voltWorkflows.unknownType', "Unknown node type \"{0}\". Its config is kept as written.", node.type);
		}

		const general = this.section(this.content, 'general', localize('voltWorkflows.general', "General"));
		this.renderIdField(general, node);
		const nameShell = fieldShell(general, localize('voltWorkflows.name', "Name"));
		const name = workflowInput(nameShell.body, node.name ?? '', { placeholder: type?.label ?? node.id, ariaLabel: localize('voltWorkflows.nodeName', "Node name"), focusKey: 'node:name' });
		this.renderStore.add(addDisposableListener(name, 'input', () => this.quietly(() => this.model.updateNode(node.id, { name: name.value.trim() ? name.value : undefined }, 'inspector', `name:${node.id}`, 'Rename node'))));

		if (type?.control === 'start') {
			this.renderTriggerSection(this.content);
			this.renderInputsSection(this.content, true);
		}

		if (type) {
			const visible = type.fields.filter(field => fieldVisible(field, node.config, type.fields));
			const basic = visible.filter(field => !field.advanced);
			const advanced = visible.filter(field => field.advanced);
			if (basic.length) {
				const body = this.section(this.content, `fields:${type.type}`, localize('voltWorkflows.settings', "Settings"));
				for (const field of basic) {
					this.renderNodeField(body, node, field);
				}
			}
			if (advanced.length) {
				const body = this.section(this.content, 'advanced', localize('voltWorkflows.advanced', "Advanced"), { collapsible: true, open: advanced.some(field => node.config[field.key] !== undefined && !sameValue(node.config[field.key], field.default)), count: advanced.length });
				for (const field of advanced) {
					this.renderNodeField(body, node, field);
				}
			}
			const unknown = Object.keys(node.config).filter(key => !type.fields.some(field => field.key === key));
			if (unknown.length) {
				append(this.content, $('.volt-wfb-insp-note')).textContent = localize('voltWorkflows.extraKeys', "Also set in YAML: {0}", unknown.join(', '));
			}
		} else {
			const body = this.section(this.content, 'config', localize('voltWorkflows.config', "Config"));
			const shell = fieldShell(body, localize('voltWorkflows.configJson', "Config (JSON)"));
			const error = append(shell.box, $('.volt-wfb-field-error.hidden'));
			renderJsonEditor(shell.body, node.config, localize('voltWorkflows.config', "Config"), '{ }', this.fieldContext(node.id), value => this.quietly(() => this.model.updateNode(node.id, { config: (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as WorkflowRecord }, 'inspector', `config:${node.id}`, 'Edit config')), message => {
				error.textContent = message ?? '';
				error.classList.toggle('hidden', !message);
			}, 'node:config');
		}

		if (type && type.control !== 'start' && type.control !== 'end') {
			this.renderErrorHandling(node, type);
			this.renderPinnedOutput(node);
		}
		if (type) {
			this.renderPorts(node, type);
			this.renderOutputDocs(node, type);
		}
		const notes = this.section(this.content, 'notes', localize('voltWorkflows.notes', "Notes"), { collapsible: true, open: !!node.notes });
		const area = workflowTextarea(notes, node.notes ?? '', { placeholder: localize('voltWorkflows.notesPlaceholder', "What this step is for, for whoever reads it next"), ariaLabel: localize('voltWorkflows.notes', "Notes"), focusKey: 'node:notes', min: 56 }, this.renderStore);
		this.renderStore.add(addDisposableListener(area, 'input', () => this.quietly(() => this.model.updateNode(node.id, { notes: area.value.trim() ? area.value : undefined }, 'inspector', `notes:${node.id}`, 'Edit notes'))));
	}

	private renderIdField(parent: HTMLElement, node: IWorkflowNode): void {
		const shell = fieldShell(parent, localize('voltWorkflows.id', "ID"), { description: localize('voltWorkflows.idHint', "Used in templates: {{ nodes.{0}.… }}", node.id) });
		const input = workflowInput(shell.body, node.id, { ariaLabel: localize('voltWorkflows.nodeId', "Node id"), mono: true, focusKey: 'node:id' });
		const error = append(shell.box, $('.volt-wfb-field-error.hidden'));
		const check = (): string | undefined => {
			const next = input.value.trim();
			if (next === node.id) {
				return undefined;
			}
			if (!WORKFLOW_ID_PATTERN.test(next)) {
				return localize('voltWorkflows.badId', "Lower-case letters, digits, _ and -, starting with a letter.");
			}
			if (this.model.definition.nodes.some(entry => entry.id === next)) {
				return localize('voltWorkflows.idTaken', "Another node already has this id.");
			}
			return undefined;
		};
		const show = (message: string | undefined) => {
			error.textContent = message ?? '';
			error.classList.toggle('hidden', !message);
			shell.box.classList.toggle('invalid', !!message);
		};
		const commit = () => {
			const next = input.value.trim();
			const problem = check();
			if (problem || next === node.id) {
				if (!problem) {
					show(undefined);
				}
				return;
			}
			this.model.renameNodeId(node.id, next);
		};
		this.renderStore.add(addDisposableListener(input, 'input', () => show(check())));
		this.renderStore.add(addDisposableListener(input, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				input.value = node.id;
				show(undefined);
			}
		}));
		this.renderStore.add(addDisposableListener(input, 'change', commit));
	}

	private renderNodeField(parent: HTMLElement, node: IWorkflowNode, field: IWorkflowFieldDef): void {
		const commit: WorkflowFieldCommit = (value, discrete) => {
			if (discrete) {
				this.model.setNodeConfig(node.id, field.key, value);
			} else {
				this.quietly(() => this.model.setNodeConfig(node.id, field.key, value));
			}
		};
		const box = renderWorkflowField(parent, field, node.config[field.key], this.fieldContext(node.id), commit);
		this.issueSlot(box, `node:${node.id}:${field.key}`);
	}

	private showNodeMenu(node: IWorkflowNode, anchor: HTMLElement): void {
		type Pick = { readonly kind: 'color'; readonly color: WorkflowNodeColor | undefined } | { readonly kind: 'disable' } | { readonly kind: 'copy-id' } | { readonly kind: 'copy-ref' };
		const type = getWorkflowNodeType(node.type);
		showVoltMenu<Pick>(this.contextView, {
			anchor,
			gap: 4,
			width: 240,
			align: 'right',
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.nodeMore', "More"),
			sections: [
				{
					id: 'node',
					items: [
						{
							id: 'color', label: localize('voltWorkflows.color', "Color"), icon: Codicon.symbolColor, data: { kind: 'color', color: undefined },
							submenu: {
								width: 180,
								className: 'volt-auto-menu volt-wfb-menu',
								sections: [{
									id: 'colors',
									items: [
										{ id: 'auto', label: localize('voltWorkflows.typeColor', "Type color"), checked: !node.color, icon: () => this.swatch(type?.color), data: { kind: 'color', color: undefined } },
										...WORKFLOW_NODE_COLORS.filter(color => color !== 'default').map(color => ({ id: color, label: color[0].toUpperCase() + color.slice(1), checked: node.color === color, icon: () => this.swatch(color), data: { kind: 'color' as const, color } })),
									],
								}],
							},
						},
						...(type?.control === 'start' ? [] : [{ id: 'disable', label: node.disabled ? localize('voltWorkflows.enable', "Enable") : localize('voltWorkflows.disable', "Disable"), icon: node.disabled ? Codicon.check : Codicon.circleSlash, data: { kind: 'disable' as const } }]),
					],
				},
				{
					id: 'copy',
					items: [
						{ id: 'copy-id', label: localize('voltWorkflows.copyId', "Copy ID"), icon: Codicon.copy, data: { kind: 'copy-id' } },
						{ id: 'copy-ref', label: localize('voltWorkflows.copyRef', "Copy Template Reference"), icon: Codicon.symbolVariable, data: { kind: 'copy-ref' } },
					],
				},
			],
			onPick: item => {
				const data = item.data;
				switch (data.kind) {
					case 'color':
						this.model.updateNode(node.id, { color: data.color }, 'inspector', undefined, 'Change color');
						break;
					case 'disable':
						this.model.updateNode(node.id, { disabled: node.disabled ? undefined : true }, 'inspector', undefined, node.disabled ? 'Enable node' : 'Disable node');
						break;
					case 'copy-id':
						void this.clipboard.writeText(node.id);
						break;
					case 'copy-ref':
						void this.clipboard.writeText(`{{ nodes.${node.id} }}`);
						break;
				}
			},
		});
	}

	private swatch(color: WorkflowNodeColor | undefined): HTMLElement {
		const dot = $('span.volt-wfb-swatch-dot');
		dot.style.setProperty('--volt-wfb-color', workflowColorVar(color));
		return dot;
	}

	/** The selected node in the shown run: waiting for an approval, failed, or done. */
	private renderRunSlot(): void {
		const slot = this.runSlot;
		const nodeId = this.model.selection.length === 1 ? this.model.selection[0] : undefined;
		if (!slot || !nodeId) {
			return;
		}
		clearNode(slot);
		const step = lastStep(this.run, nodeId);
		if (!step) {
			return;
		}
		const type = getWorkflowNodeType(this.model.node(nodeId)?.type ?? '');
		const box = append(slot, $(`.volt-wfb-run-note.${step.state}`));
		const line = append(box, $('.volt-wfb-run-note-line'));
		const icon = step.state === 'failed' ? Codicon.error : step.state === 'success' ? Codicon.passFilled : step.state === 'waiting' ? Codicon.clock : step.state === 'running' ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.circleLargeOutline;
		line.appendChild(renderIcon(icon));
		const label = step.state === 'waiting' && type?.control === 'approval'
			? localize('voltWorkflows.waitingApproval', "Waiting for your approval")
			: step.state === 'waiting' ? localize('voltWorkflows.waitingFor', "Waiting: {0}", step.waitingFor ?? '')
				: step.state === 'failed' ? localize('voltWorkflows.stepFailed', "Failed in the last run")
					: step.state === 'success' ? localize('voltWorkflows.stepDone', "Succeeded in the last run{0}", step.port ? ` → ${step.port}` : '')
						: localize('voltWorkflows.stepState', "Last run: {0}", step.state);
		append(line, $('span')).textContent = label;
		if (step.error) {
			append(box, $('.volt-wfb-run-note-detail')).textContent = step.error;
		}
		if (step.state === 'waiting' && type?.control === 'approval') {
			const buttons = append(box, $('.volt-wfb-inline-actions'));
			this.textButton(buttons, localize('voltWorkflows.approve', "Approve"), 'primary', () => this.options.onApprove(nodeId, 'approve'), Codicon.check);
			this.textButton(buttons, localize('voltWorkflows.reject', "Reject"), 'danger', () => this.options.onApprove(nodeId, 'reject'), Codicon.close);
		}
		this.scroll.scanDomNode();
	}

	private renderErrorHandling(node: IWorkflowNode, type: IWorkflowNodeType): void {
		const configured = !!node.retry?.attempts || node.timeoutMs !== undefined || (node.onError ?? 'fail') !== 'fail';
		const body = this.section(this.content, 'errors', localize('voltWorkflows.errorHandling', "Error handling"), { collapsible: true, open: configured });
		const grid = append(body, $('.volt-wfb-grid'));

		const attemptsShell = fieldShell(grid, localize('voltWorkflows.retries', "Retries"));
		const attempts = workflowInput(attemptsShell.body, node.retry?.attempts ? String(node.retry.attempts) : '', { placeholder: '0', ariaLabel: localize('voltWorkflows.retries', "Retries"), focusKey: 'node:retries', className: 'number' });
		this.renderStore.add(addDisposableListener(attempts, 'input', () => {
			const count = Math.max(0, Math.min(10, Math.round(Number(attempts.value) || 0)));
			this.quietly(() => this.model.updateNode(node.id, { retry: count ? { ...node.retry, attempts: count } : undefined }, 'inspector', `retry:${node.id}`, 'Edit retries'));
		}));

		const delayShell = fieldShell(grid, localize('voltWorkflows.retryDelay', "First retry after"));
		const delay = workflowInput(delayShell.body, node.retry?.delayMs ? formatDuration(node.retry.delayMs) : '', { placeholder: '5s', ariaLabel: localize('voltWorkflows.retryDelay', "First retry after"), focusKey: 'node:delay', className: 'duration' });
		this.renderStore.add(addDisposableListener(delay, 'input', () => {
			const parsed = parseDuration(delay.value);
			if (!parsed.error) {
				const current = this.model.node(node.id)?.retry;
				this.quietly(() => this.model.updateNode(node.id, { retry: compact({ attempts: current?.attempts ?? 1, delayMs: parsed.ms, maxDelayMs: current?.maxDelayMs }) }, 'inspector', `retry:${node.id}`, 'Edit retries'));
			}
		}));

		const timeoutShell = fieldShell(grid, localize('voltWorkflows.timeout', "Timeout"));
		const timeout = workflowInput(timeoutShell.body, node.timeoutMs ? formatDuration(node.timeoutMs) : '', { placeholder: localize('voltWorkflows.noLimit', "No limit"), ariaLabel: localize('voltWorkflows.timeout', "Timeout"), focusKey: 'node:timeout', className: 'duration' });
		this.renderStore.add(addDisposableListener(timeout, 'input', () => {
			const parsed = parseDuration(timeout.value);
			if (!parsed.error) {
				this.quietly(() => this.model.updateNode(node.id, { timeoutMs: parsed.ms }, 'inspector', `timeout:${node.id}`, 'Edit timeout'));
			}
		}));

		const hasFailedPort = type.outputs(node.config).some(port => port.kind === 'failure' || port.id === 'failed');
		const modeShell = fieldShell(body, localize('voltWorkflows.onError', "When it fails"));
		createVoltDropdown<WorkflowErrorMode>(modeShell.body, this.contextView, {
			options: [
				{ id: 'fail', label: localize('voltWorkflows.failRun', "Fail the run"), description: localize('voltWorkflows.failRunDesc', "The run stops as failed.") },
				{ id: 'continue', label: localize('voltWorkflows.continueRun', "Continue"), description: localize('voltWorkflows.continueRunDesc', "Mark the node failed and go on down its first port.") },
				{ id: 'route', label: localize('voltWorkflows.routeFailed', "Take the failed port"), description: hasFailedPort ? localize('voltWorkflows.routeFailedDesc', "Go on down the node's failed port.") : localize('voltWorkflows.routeNoPort', "This node has no failed port: behaves like Fail.") },
			],
			value: node.onError ?? 'fail',
			ariaLabel: localize('voltWorkflows.onError', "When it fails"),
			align: 'left',
			onChange: mode => this.model.updateNode(node.id, { onError: mode === 'fail' ? undefined : mode }, 'inspector', undefined, 'Edit error handling'),
		}, this.renderStore);
		this.issueSlot(body, `node:${node.id}:onError`);
	}

	private renderPinnedOutput(node: IWorkflowNode): void {
		const pinned = node.pinnedOutput !== undefined;
		const body = this.section(this.content, 'pinned', localize('voltWorkflows.pinnedOutput', "Pinned output"), { collapsible: true, open: pinned || this.editingPin === node.id, className: pinned ? 'pinned' : '' });
		if (this.editingPin === node.id) {
			const error = $('.volt-wfb-field-error.hidden');
			let draft: WorkflowValue | undefined = node.pinnedOutput ?? lastStep(this.run, node.id)?.output ?? {};
			const area = renderJsonEditor(body, draft, localize('voltWorkflows.pinnedOutput', "Pinned output"), '{ }', this.fieldContext(node.id), value => draft = value, message => {
				error.textContent = message ?? '';
				error.classList.toggle('hidden', !message);
			}, 'node:pin');
			body.appendChild(error);
			const buttons = append(body, $('.volt-wfb-inline-actions'));
			this.textButton(buttons, localize('voltWorkflows.pin', "Pin"), 'primary', () => {
				if (!error.classList.contains('hidden')) {
					return;
				}
				this.editingPin = undefined;
				this.model.updateNode(node.id, { pinnedOutput: draft ?? {} }, 'inspector', undefined, 'Pin output');
			});
			this.textButton(buttons, localize('voltWorkflows.cancel', "Cancel"), 'ghost', () => {
				this.editingPin = undefined;
				this.redraw(true);
			});
			getWindow(area).requestAnimationFrame(() => area.focus());
			return;
		}
		if (pinned) {
			append(body, $('.volt-wfb-hint')).textContent = localize('voltWorkflows.pinnedHint', "Simulations and single-step runs use this instead of running the node.");
			const text = JSON.stringify(node.pinnedOutput, null, 2) ?? '';
			const lines = Math.min(12, text.split('\n').length);
			this.renderStore.add(this.instantiationService.createInstance(WorkflowCodeEditor, body, { value: text, language: 'json', readOnly: true, ariaLabel: localize('voltWorkflows.pinnedOutput', "Pinned output"), height: lines * 18 + 16 }));
		} else {
			append(body, $('.volt-wfb-hint')).textContent = localize('voltWorkflows.notPinnedHint', "Pin an output to simulate this node with exact data, or to skip it while testing later steps.");
		}
		const buttons = append(body, $('.volt-wfb-inline-actions'));
		this.textButton(buttons, pinned ? localize('voltWorkflows.editPin', "Edit") : localize('voltWorkflows.pinOutput', "Pin output"), 'secondary', () => {
			this.editingPin = node.id;
			this.openSections.set('pinned', true);
			this.redraw(true);
		}, Codicon.pinned);
		const last = lastStep(this.run, node.id);
		if (last?.output !== undefined && last.state === 'success') {
			this.textButton(buttons, localize('voltWorkflows.pinLast', "Pin last run's output"), 'ghost', () => this.model.updateNode(node.id, { pinnedOutput: last.output }, 'inspector', undefined, 'Pin output'));
		}
		if (pinned) {
			this.textButton(buttons, localize('voltWorkflows.clearPin', "Clear"), 'ghost', () => this.model.updateNode(node.id, { pinnedOutput: undefined }, 'inspector', undefined, 'Clear pinned output'));
		}
	}

	private renderPorts(node: IWorkflowNode, type: IWorkflowNodeType): void {
		const ports = type.outputs(node.config);
		if (!ports.length) {
			return;
		}
		const definition = this.model.definition;
		const body = this.section(this.content, 'ports', localize('voltWorkflows.outputPorts', "Output ports"), { count: ports.length, className: 'flush' });
		type PortRow = { readonly port: IWorkflowPortDef; readonly targets: readonly IWorkflowNode[] };
		const rows: PortRow[] = ports.map(port => ({ port, targets: outgoingEdges(definition, node.id, port.id).map(edge => definition.nodes.find(entry => entry.id === edge.to)).filter((entry): entry is IWorkflowNode => !!entry) }));
		renderWorkflowRowList<PortRow>(body, rows, {
			id: 'VoltWorkflowPorts',
			ariaLabel: localize('voltWorkflows.outputPorts', "Output ports"),
			rowHeight: ROW,
			identity: row => row.port.id,
			rowLabel: row => `${row.port.label} → ${row.targets.length ? row.targets.map(nodeDisplayName).join(', ') : localize('voltWorkflows.endsRun', "ends the run")}`,
			render: (row, element) => {
				element.classList.add('volt-wfb-port-row');
				const dot = append(element, $('span.volt-wfb-port-dot'));
				dot.style.setProperty('--volt-wfb-port', workflowPortColorVar(row.port.kind));
				append(element, $('span.volt-wfb-port-label')).textContent = row.port.label;
				element.appendChild(renderIcon(Codicon.arrowRight)).classList.add('volt-wfb-port-arrow');
				const target = append(element, $('span.volt-wfb-port-target'));
				if (row.targets.length) {
					target.textContent = row.targets.map(nodeDisplayName).join(', ');
				} else {
					target.textContent = localize('voltWorkflows.endsRun', "ends the run");
					target.classList.add('muted');
				}
				element.title = row.port.description ?? '';
			},
			onOpen: row => row.targets[0] && this.options.onRevealNode(row.targets[0].id),
		}, this.instantiationService, this.renderStore);
	}

	private renderOutputDocs(node: IWorkflowNode, type: IWorkflowNodeType): void {
		if (!type.outputDocs.length) {
			return;
		}
		const body = this.section(this.content, 'outputs', localize('voltWorkflows.outputsForTemplates', "Outputs for templates"), { collapsible: true, open: true, count: type.outputDocs.length, className: 'flush' });
		renderWorkflowRowList(body, type.outputDocs, {
			id: 'VoltWorkflowOutputs',
			ariaLabel: localize('voltWorkflows.outputsForTemplates', "Outputs for templates"),
			rowHeight: TWO_LINE_ROW,
			identity: doc => doc.key,
			rowLabel: doc => `nodes.${node.id}.${doc.key}, ${doc.description}`,
			render: (doc, element, store) => {
				element.classList.add('volt-wfb-output-row');
				const text = append(element, $('.volt-wfb-output-text'));
				const reference = `{{ nodes.${node.id}.${doc.key} }}`;
				append(text, $('code.volt-wfb-output-code')).textContent = reference;
				append(text, $('span.volt-wfb-output-desc')).textContent = doc.description;
				const copy = append(element, $('button.volt-wfb-icon-button.small.volt-wfb-row-action')) as HTMLButtonElement;
				copy.type = 'button';
				copy.appendChild(renderIcon(Codicon.copy));
				copy.setAttribute('aria-label', localize('voltWorkflows.copyReference', "Copy {0}", reference));
				copy.title = localize('voltWorkflows.copy', "Copy");
				store.add(addDisposableListener(copy, 'click', e => {
					e.stopPropagation();
					void this.clipboard.writeText(reference);
					copy.replaceChildren(renderIcon(Codicon.check));
					getWindow(copy).setTimeout(() => copy.replaceChildren(renderIcon(Codicon.copy)), 1000);
				}));
			},
			onOpen: doc => void this.clipboard.writeText(`{{ nodes.${node.id}.${doc.key} }}`),
		}, this.instantiationService, this.renderStore);
	}

	//#endregion

	//#region Several nodes

	private drawMulti(nodes: readonly IWorkflowNode[]): void {
		this.head(Codicon.multipleWindows, undefined, localize('voltWorkflows.nNodes', "{0} nodes", nodes.length), localize('voltWorkflows.selection', "Selection"));
		const buttons = append(this.content, $('.volt-wfb-inline-actions.padded'));
		this.textButton(buttons, localize('voltWorkflows.tidy', "Auto-layout"), 'secondary', () => this.options.onAutoLayoutSelection(), Codicon.layout);
		this.textButton(buttons, localize('voltWorkflows.group', "Group"), 'secondary', () => this.model.groupNodes(nodes.map(node => node.id)), Codicon.groupByRefType);
		this.textButton(buttons, localize('voltWorkflows.delete', "Delete"), 'danger', () => this.model.removeNodes(nodes.map(node => node.id)), Codicon.trash);
		const body = this.section(this.content, 'selected', localize('voltWorkflows.selectedNodes', "Selected"), { count: nodes.length, className: 'flush' });
		renderWorkflowRowList(body, nodes, {
			id: 'VoltWorkflowSelection',
			ariaLabel: localize('voltWorkflows.selectedNodes', "Selected"),
			rowHeight: ROW + 4,
			identity: node => node.id,
			rowLabel: node => nodeDisplayName(node),
			render: (node, element) => {
				element.classList.add('volt-wfb-node-row');
				workflowIconTile(element, workflowTypeIcon(node.type), node.color ?? getWorkflowNodeType(node.type)?.color, 'small');
				append(element, $('span.volt-wfb-node-row-name')).textContent = nodeDisplayName(node);
				append(element, $('span.volt-wfb-node-row-id')).textContent = node.id;
			},
			onOpen: node => {
				this.model.setSelection([node.id]);
				this.options.onRevealNode(node.id);
			},
		}, this.instantiationService, this.renderStore);
	}

	//#endregion

	//#region Workflow

	private applyDefinition(label: string, coalesce: string | undefined, quiet: boolean, mutate: (definition: IWorkflowDefinition) => IWorkflowDefinition): void {
		const run = () => this.model.apply(label, mutate, 'inspector', coalesce);
		if (quiet) {
			this.quietly(run);
		} else {
			run();
		}
	}

	private drawWorkflow(): void {
		const definition = this.model.definition;
		this.head(Codicon.typeHierarchySub, undefined, definition.name || localize('voltWorkflows.untitled', "Untitled workflow"), localize('voltWorkflows.workflow', "Workflow"));
		this.issueSlot(this.content, 'workflow');

		const general = this.section(this.content, 'wf:general', localize('voltWorkflows.general', "General"));
		const nameShell = fieldShell(general, localize('voltWorkflows.name', "Name"));
		const name = workflowInput(nameShell.body, definition.name, { placeholder: localize('voltWorkflows.namePlaceholder', "Name this workflow"), ariaLabel: localize('voltWorkflows.workflowName', "Workflow name"), focusKey: 'wf:name' });
		this.renderStore.add(addDisposableListener(name, 'input', () => this.applyDefinition('Rename workflow', 'wf:name', true, current => ({ ...current, name: name.value }))));
		const descriptionShell = fieldShell(general, localize('voltWorkflows.description', "Description"));
		const description = workflowTextarea(descriptionShell.body, definition.description ?? '', { placeholder: localize('voltWorkflows.descriptionPlaceholder', "What it does and when it runs"), ariaLabel: localize('voltWorkflows.description', "Description"), focusKey: 'wf:description', min: 48 }, this.renderStore);
		this.renderStore.add(addDisposableListener(description, 'input', () => this.applyDefinition('Edit description', 'wf:description', true, current => compact({ ...current, description: description.value.trim() ? description.value : undefined }))));
		const tagsShell = fieldShell(general, localize('voltWorkflows.tags', "Tags"));
		renderListEditor(tagsShell.body, [...(definition.tags ?? [])], { key: 'tags', label: localize('voltWorkflows.tag', "Tag") }, this.fieldContext(undefined), (tags, discrete) => this.applyDefinition('Edit tags', 'wf:tags', !discrete, current => compact({ ...current, tags })), 'wf:tags');

		this.renderTriggerSection(this.content);
		this.renderInputsSection(this.content, false);
		this.renderVariablesSection();
		this.renderSettingsSection();
		this.renderUnwired();
		this.renderDescribe();
		const issuesHost = append(this.content, $('.volt-wfb-issues-host'));
		this.issuesSection = { host: issuesHost, store: this.renderStore.add(new DisposableStore()) };
		this.renderIssuesList();
	}

	private renderTriggerSection(parent: HTMLElement): void {
		const trigger = this.model.definition.trigger;
		const body = this.section(parent, 'wf:trigger', localize('voltWorkflows.trigger', "Trigger"));
		const setTrigger = (next: IWorkflowTrigger, coalesce: string | undefined, quiet: boolean) => this.applyDefinition('Edit trigger', coalesce, quiet, current => ({ ...current, trigger: compact(next) }));
		const typeShell = fieldShell(body, localize('voltWorkflows.startsWhen', "Starts"));
		const summary = append(typeShell.body, $('.volt-wfb-trigger-row'));
		createVoltDropdown<IWorkflowTrigger['type']>(summary, this.contextView, {
			options: [
				{ id: 'manual', label: localize('voltWorkflows.manually', "Manually"), description: localize('voltWorkflows.manuallyDesc', "Run from here, a chat or an automation."), icon: () => providerIconOf('manual') },
				{ id: 'schedule', label: localize('voltWorkflows.onSchedule', "On a schedule"), description: localize('voltWorkflows.onScheduleDesc', "Cron or every few minutes, in a time zone."), icon: () => workflowTriggerIcon({ type: 'schedule' })() },
				{ id: 'event', label: localize('voltWorkflows.onEvent', "On an event"), description: localize('voltWorkflows.onEventDesc', "A GitHub, Slack, Linear… webhook."), icon: Codicon.zap },
			],
			value: trigger.type,
			ariaLabel: localize('voltWorkflows.triggerType', "Trigger type"),
			align: 'left',
			onChange: type => {
				if (type === 'manual') {
					setTrigger({ type: 'manual', samplePayload: trigger.samplePayload }, undefined, false);
				} else if (type === 'schedule') {
					setTrigger({ type: 'schedule', cron: '0 9 * * 1-5', timezone: trigger.timezone }, undefined, false);
				} else {
					setTrigger({ type: 'event', provider: 'github', event: 'pr.opened', samplePayload: trigger.samplePayload }, undefined, false);
				}
			},
		}, this.renderStore);
		append(summary, $('span.volt-wfb-trigger-summary')).textContent = describeWorkflowTrigger(trigger);
		const ctx = this.fieldContext(undefined);

		if (trigger.type === 'schedule') {
			const every = trigger.everyMinutes !== undefined && !trigger.cron;
			const modeShell = fieldShell(body, localize('voltWorkflows.repeat', "Repeat"));
			createVoltDropdown<'cron' | 'every'>(modeShell.body, this.contextView, {
				options: [
					{ id: 'cron', label: localize('voltWorkflows.cronMode', "Cron expression") },
					{ id: 'every', label: localize('voltWorkflows.everyMode', "Every N minutes") },
				],
				value: every ? 'every' : 'cron',
				ariaLabel: localize('voltWorkflows.repeat', "Repeat"),
				align: 'left',
				onChange: mode => setTrigger(mode === 'every' ? { type: 'schedule', everyMinutes: trigger.everyMinutes ?? 15, timezone: trigger.timezone } : { type: 'schedule', cron: trigger.cron ?? '0 9 * * 1-5', timezone: trigger.timezone }, undefined, false),
			}, this.renderStore);
			if (every) {
				const shell = fieldShell(body, localize('voltWorkflows.everyMinutesLabel', "Minutes between runs"));
				const input = workflowInput(shell.body, String(trigger.everyMinutes ?? 15), { ariaLabel: localize('voltWorkflows.everyMinutesLabel', "Minutes between runs"), focusKey: 'wf:every', className: 'number' });
				this.renderStore.add(addDisposableListener(input, 'input', () => {
					const minutes = Math.round(Number(input.value));
					if (minutes >= 1) {
						setTrigger({ ...this.model.definition.trigger, everyMinutes: minutes, cron: undefined }, 'wf:trigger:every', true);
					}
				}));
			} else {
				renderWorkflowField(body, { key: 'cron', label: localize('voltWorkflows.cron', "Cron"), kind: 'cron', placeholder: '0 9 * * 1-5', description: localize('voltWorkflows.cronHint', "minute hour day month weekday, or @hourly, @daily") }, trigger.cron, ctx, value => setTrigger({ ...this.model.definition.trigger, cron: asText(value) || undefined, everyMinutes: undefined }, 'wf:trigger:cron', true));
			}
			const zoneShell = fieldShell(body, localize('voltWorkflows.timezone', "Time zone"));
			const zone = workflowPickerButton(zoneShell.body, trigger.timezone ?? localize('voltWorkflows.localTimeZone', "Local time ({0})", Intl.DateTimeFormat().resolvedOptions().timeZone), { icon: Codicon.globe, placeholder: !trigger.timezone, ariaLabel: localize('voltWorkflows.timezone', "Time zone"), focusKey: 'wf:zone' });
			this.renderStore.add(addDisposableListener(zone, 'click', () => showTimezoneMenu(ctx, zone, trigger.timezone, timezone => setTrigger({ ...this.model.definition.trigger, timezone }, undefined, false))));
		} else if (trigger.type === 'event') {
			const eventShell = fieldShell(body, localize('voltWorkflows.eventLabel', "Event"));
			const label = trigger.provider ? describeWorkflowTrigger(trigger) : localize('voltWorkflows.chooseEvent', "Choose an event");
			const button = workflowPickerButton(eventShell.body, label, { icon: workflowTriggerIcon(trigger), placeholder: !trigger.provider, ariaLabel: localize('voltWorkflows.eventLabel', "Event"), focusKey: 'wf:event' });
			this.renderStore.add(addDisposableListener(button, 'click', () => showWorkflowTriggerMenu(this.contextView, button, this.model)));
			const provider = (AUTOMATION_PROVIDERS as readonly string[]).includes(trigger.provider ?? '') ? trigger.provider as AutomationProvider : undefined;
			const option = provider && trigger.event ? eventOption(provider, trigger.event) : undefined;
			if (option) {
				const shell = fieldShell(body, option.label);
				const input = workflowInput(shell.body, trigger.option ?? '', { placeholder: option.placeholder, ariaLabel: option.label, focusKey: 'wf:option' });
				this.renderStore.add(addDisposableListener(input, 'input', () => setTrigger({ ...this.model.definition.trigger, option: input.value.trim() || undefined }, 'wf:trigger:option', true)));
			}
			const filtersShell = fieldShell(body, localize('voltWorkflows.filters', "Filters"), { description: localize('voltWorkflows.filtersHint', "Only payloads that match every filter start a run: path op value.") });
			renderListEditor(filtersShell.body, [...(trigger.filters ?? [])], { key: 'filters', label: localize('voltWorkflows.filter', "Filter"), placeholder: 'pull_request.base.ref == main' }, ctx, filters => setTrigger({ ...this.model.definition.trigger, filters }, undefined, false), 'wf:filters');
		}
		if (trigger.type !== 'manual' || trigger.samplePayload !== undefined) {
			const shell = fieldShell(body, localize('voltWorkflows.samplePayload', "Sample payload"), { description: localize('voltWorkflows.samplePayloadHint', "What simulations receive as {{ trigger.payload }}.") });
			const error = append(shell.box, $('.volt-wfb-field-error.hidden'));
			renderJsonEditor(shell.body, trigger.samplePayload, localize('voltWorkflows.samplePayload', "Sample payload"), '{ "pull_request": { "number": 1 } }', ctx, value => setTrigger({ ...this.model.definition.trigger, samplePayload: value }, 'wf:trigger:payload', true), message => {
				error.textContent = message ?? '';
				error.classList.toggle('hidden', !message);
			}, 'wf:payload');
		}
	}

	/** `foldWhenEmpty` (the start node): starts folded while there are none; the workflow's starts open. */
	private renderInputsSection(parent: HTMLElement, foldWhenEmpty: boolean): void {
		const inputs = [...(this.model.definition.inputs ?? [])];
		const body = this.section(parent, 'wf:inputs', localize('voltWorkflows.inputs', "Inputs"), { count: inputs.length, open: !foldWhenEmpty || inputs.length > 0 });
		append(body, $('.volt-wfb-hint')).textContent = localize('voltWorkflows.inputsHint', "Asked for when the workflow runs; read them as {{ inputs.name }}.");
		const save = (next: IWorkflowInputDef[], quiet: boolean) => this.applyDefinition('Edit inputs', 'wf:inputs', quiet, current => compact({ ...current, inputs: next }));
		inputs.forEach((input, index) => {
			const card = append(body, $('.volt-wfb-input-card'));
			const top = append(card, $('.volt-wfb-input-card-top'));
			const name = workflowInput(top, input.name, { placeholder: 'name', ariaLabel: localize('voltWorkflows.inputName', "Input name"), mono: true, focusKey: `wf:input:${index}:name` });
			this.renderStore.add(addDisposableListener(name, 'input', () => {
				const value = name.value.trim().replace(/[^A-Za-z0-9_]/g, '_');
				if (value) {
					inputs[index] = { ...inputs[index], name: value };
					save([...inputs], true);
				}
			}));
			createVoltDropdown<WorkflowInputType>(top, this.contextView, {
				options: [
					{ id: 'string', label: localize('voltWorkflows.typeText', "Text") },
					{ id: 'number', label: localize('voltWorkflows.typeNumber', "Number") },
					{ id: 'boolean', label: localize('voltWorkflows.typeBoolean', "Yes/No") },
					{ id: 'json', label: localize('voltWorkflows.typeJson', "JSON") },
				],
				value: input.type,
				ariaLabel: localize('voltWorkflows.inputType', "Input type"),
				align: 'right',
				width: 160,
				onChange: type => {
					inputs[index] = { ...inputs[index], type };
					save([...inputs], false);
				},
			}, this.renderStore);
			this.iconButton(top, Codicon.close, localize('voltWorkflows.removeInput', "Remove input"), () => save(inputs.filter((_, i) => i !== index), false), 'small');
			const descriptionInput = workflowInput(card, input.description ?? '', { placeholder: localize('voltWorkflows.inputDescription', "Description"), ariaLabel: localize('voltWorkflows.inputDescription', "Description"), focusKey: `wf:input:${index}:description` });
			this.renderStore.add(addDisposableListener(descriptionInput, 'input', () => {
				inputs[index] = compact({ ...inputs[index], description: descriptionInput.value.trim() ? descriptionInput.value : undefined });
				save([...inputs], true);
			}));
			const bottom = append(card, $('.volt-wfb-input-card-bottom'));
			const fallback = workflowInput(bottom, input.default === undefined ? '' : asText(input.default), { placeholder: localize('voltWorkflows.inputDefault', "Default"), ariaLabel: localize('voltWorkflows.inputDefault', "Default"), focusKey: `wf:input:${index}:default` });
			this.renderStore.add(addDisposableListener(fallback, 'input', () => {
				const text = fallback.value;
				let value: WorkflowValue | undefined = text === '' ? undefined : text;
				if (text !== '' && inputs[index].type === 'number' && Number.isFinite(Number(text))) {
					value = Number(text);
				} else if (inputs[index].type === 'boolean' && (text === 'true' || text === 'false')) {
					value = text === 'true';
				}
				inputs[index] = compact({ ...inputs[index], default: value });
				save([...inputs], true);
			}));
			const required = append(bottom, $('.volt-wfb-required-toggle'));
			append(required, $('span')).textContent = localize('voltWorkflows.requiredLabel', "Required");
			const toggle = toggleSwitch(required, !!input.required, localize('voltWorkflows.requiredLabel', "Required"), this.renderStore, on => {
				inputs[index] = compact({ ...inputs[index], required: on || undefined });
				save([...inputs], false);
			});
			toggle.dataset.wfFocus = `wf:input:${index}:required`;
		});
		const add = append(body, $('button.volt-wfb-add-row')) as HTMLButtonElement;
		add.type = 'button';
		add.dataset.wfFocus = 'wf:inputs:add';
		add.appendChild(renderIcon(Codicon.add));
		append(add, $('span')).textContent = localize('voltWorkflows.addInput', "Add input");
		this.renderStore.add(addDisposableListener(add, 'click', () => {
			let name = 'input';
			for (let n = 2; inputs.some(input => input.name === name); n++) {
				name = `input_${n}`;
			}
			save([...inputs, { name, type: 'string' }], false);
		}));
	}

	private renderVariablesSection(): void {
		const variables = this.model.definition.variables ?? {};
		const body = this.section(this.content, 'wf:vars', localize('voltWorkflows.variables', "Variables"), { collapsible: true, open: Object.keys(variables).length > 0, count: Object.keys(variables).length });
		append(body, $('.volt-wfb-hint')).textContent = localize('voltWorkflows.varsHint', "Starting values of {{ vars.name }}; Set Variable nodes change them during a run.");
		renderKeyValueEditor(body, { ...variables }, localize('voltWorkflows.variable', "Variable"), this.fieldContext(undefined), (record, discrete) => this.applyDefinition('Edit variables', 'wf:vars', !discrete, current => compact({ ...current, variables: Object.keys(record).length ? record : undefined })), 'wf:vars');
	}

	private renderSettingsSection(): void {
		const settings = this.model.definition.settings ?? {};
		const body = this.section(this.content, 'wf:settings', localize('voltWorkflows.runSettings', "Run settings"), { collapsible: true, open: true });
		const set = (patch: Partial<IWorkflowSettings>, coalesce: string | undefined, quiet: boolean) => this.applyDefinition('Edit settings', coalesce, quiet, current => {
			const next = compact({ ...(current.settings ?? {}), ...patch });
			return compact({ ...current, settings: Object.keys(next).length ? next : undefined });
		});
		const grid = append(body, $('.volt-wfb-grid'));
		const concurrencyShell = fieldShell(grid, localize('voltWorkflows.concurrency', "Parallel steps"));
		const concurrency = workflowInput(concurrencyShell.body, settings.concurrency ? String(settings.concurrency) : '', { placeholder: String(WORKFLOW_DEFAULT_CONCURRENCY), ariaLabel: localize('voltWorkflows.concurrency', "Parallel steps"), focusKey: 'wf:concurrency', className: 'number' });
		this.renderStore.add(addDisposableListener(concurrency, 'input', () => {
			const value = Math.round(Number(concurrency.value));
			set({ concurrency: value >= 1 ? Math.min(value, 32) : undefined }, 'wf:settings:concurrency', true);
		}));
		const stepsShell = fieldShell(grid, localize('voltWorkflows.maxSteps', "Step budget"));
		const steps = workflowInput(stepsShell.body, settings.maxSteps ? String(settings.maxSteps) : '', { placeholder: String(WORKFLOW_DEFAULT_MAX_STEPS), ariaLabel: localize('voltWorkflows.maxSteps', "Step budget"), focusKey: 'wf:maxSteps', className: 'number' });
		this.renderStore.add(addDisposableListener(steps, 'input', () => {
			const value = Math.round(Number(steps.value));
			set({ maxSteps: value >= 1 ? Math.min(value, WORKFLOW_HARD_MAX_STEPS) : undefined }, 'wf:settings:steps', true);
		}));
		const timeoutShell = fieldShell(grid, localize('voltWorkflows.runTimeout', "Run timeout"));
		const timeout = workflowInput(timeoutShell.body, settings.timeoutMs ? formatDuration(settings.timeoutMs) : '', { placeholder: localize('voltWorkflows.noLimit', "No limit"), ariaLabel: localize('voltWorkflows.runTimeout', "Run timeout"), focusKey: 'wf:timeout', className: 'duration' });
		this.renderStore.add(addDisposableListener(timeout, 'input', () => {
			const parsed = parseDuration(timeout.value);
			if (!parsed.error) {
				set({ timeoutMs: parsed.ms }, 'wf:settings:timeout', true);
			}
		}));
		const ctx = this.fieldContext(undefined);
		const repoShell = fieldShell(body, localize('voltWorkflows.repository', "Repository"), { description: localize('voltWorkflows.repositoryHint', "Where agent, shell and git steps work (an automation can pick another).") });
		const choice = this.options.sources.repositories().find(entry => entry.root === settings.repository);
		const repoLabel = choice?.label ?? (settings.repository ? settings.repository.split('/').filter(Boolean).pop() ?? settings.repository : localize('voltWorkflows.activeProject', "The active project"));
		const repo = workflowPickerButton(repoShell.body, repoLabel, { icon: Codicon.folder, placeholder: !settings.repository, ariaLabel: localize('voltWorkflows.repository', "Repository"), focusKey: 'wf:repo' });
		this.renderStore.add(addDisposableListener(repo, 'click', () => showRepositoryPickMenu(ctx, repo, settings.repository, localize('voltWorkflows.activeProject', "The active project"), root => set({ repository: root }, undefined, false))));
		const modelShell = fieldShell(body, localize('voltWorkflows.defaultModel', "Default model"), { description: localize('voltWorkflows.defaultModelHint', "Agent steps that pick none run on it.") });
		renderModelField(modelShell.body, settings.modelRef, ctx, value => set({ modelRef: typeof value === 'string' ? value : undefined }, undefined, false), 'wf:model', localize('voltWorkflows.auto', "Auto"), localize('voltWorkflows.autoDesc', "Run on the default model"));
	}

	private renderUnwired(): void {
		const definition = this.model.definition;
		type Loose = { readonly node: IWorkflowNode; readonly port: IWorkflowPortDef };
		const loose: Loose[] = [];
		for (const node of definition.nodes) {
			for (const port of nodeOutputs(node)) {
				if (!definition.edges.some(edge => edge.from === node.id && edge.port === port.id)) {
					loose.push({ node, port });
				}
			}
		}
		if (!loose.length) {
			return;
		}
		const body = this.section(this.content, 'wf:unwired', localize('voltWorkflows.unwired', "Unwired: ends the run"), { collapsible: true, open: loose.length <= 8, count: loose.length, className: 'flush' });
		renderWorkflowRowList(body, loose, {
			id: 'VoltWorkflowUnwired',
			ariaLabel: localize('voltWorkflows.unwired', "Unwired: ends the run"),
			rowHeight: ROW,
			identity: entry => `${entry.node.id}.${entry.port.id}`,
			rowLabel: entry => `${entry.node.id}.${entry.port.id}`,
			render: (entry, element) => {
				element.classList.add('volt-wfb-port-row');
				const dot = append(element, $('span.volt-wfb-port-dot'));
				dot.style.setProperty('--volt-wfb-port', workflowPortColorVar(entry.port.kind));
				append(element, $('code.volt-wfb-port-ref')).textContent = `${entry.node.id}.${entry.port.id}`;
				append(element, $('span.volt-wfb-port-target.muted')).textContent = nodeDisplayName(entry.node);
			},
			onOpen: entry => this.options.onRevealNode(entry.node.id),
		}, this.instantiationService, this.renderStore);
	}

	private renderDescribe(): void {
		const body = this.section(this.content, 'wf:describe', localize('voltWorkflows.describeTitle', "Build from a description"), { collapsible: true, open: this.model.definition.nodes.length <= 1 || this.describing });
		const box = append(body, $('.volt-wfb-describe'));
		const area = workflowTextarea(box, this.describeDraft, { placeholder: localize('voltWorkflows.describePlaceholder', "When a pull request opens, review it with an agent, run the tests, and post a summary to Slack if anything fails."), ariaLabel: localize('voltWorkflows.describeTitle', "Build from a description"), focusKey: 'wf:describe', min: 80 }, this.renderStore);
		area.disabled = this.describing;
		this.renderStore.add(addDisposableListener(area, 'input', () => this.describeDraft = area.value));
		const submit = () => {
			const text = area.value.trim();
			if (text && !this.describing) {
				this.options.onDescribe(text);
			}
		};
		this.renderStore.add(addDisposableListener(area, 'keydown', e => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submit();
			}
		}));
		const actions = append(box, $('.volt-wfb-inline-actions'));
		if (this.describing) {
			const busy = append(actions, $('span.volt-wfb-busy'));
			busy.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			append(busy, $('span')).textContent = localize('voltWorkflows.building', "Building the workflow");
		} else {
			this.textButton(actions, localize('voltWorkflows.build', "Build"), 'primary', submit);
		}
		this.textButton(actions, localize('voltWorkflows.browseTemplates', "Browse templates"), 'ghost', () => this.options.onBrowseTemplates(), Codicon.library);
	}

	private renderIssuesList(): void {
		const section = this.issuesSection;
		if (!section) {
			return;
		}
		section.store.clear();
		clearNode(section.host);
		const issues = this.issues;
		if (!issues.length) {
			return;
		}
		const errors = issues.filter(issue => issue.severity === 'error').length;
		const body = this.section(section.host, 'wf:issues', errors ? localize('voltWorkflows.problems', "Problems") : localize('voltWorkflows.warnings', "Warnings"), { count: issues.length, className: 'flush' });
		const nodes = this.model.definition.nodes;
		renderWorkflowRowList(body, issues, {
			id: 'VoltWorkflowIssues',
			ariaLabel: localize('voltWorkflows.problems', "Problems"),
			rowHeight: TWO_LINE_ROW,
			identity: issue => `${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.line ?? ''}:${issue.message}`,
			rowLabel: issue => `${issue.severity}: ${issue.message}`,
			render: (issue, element) => {
				element.classList.add('volt-wfb-issue-row', issue.severity);
				element.appendChild(renderIcon(issue.severity === 'error' ? Codicon.error : issue.severity === 'warning' ? Codicon.warning : Codicon.info)).classList.add('volt-wfb-issue-icon');
				const text = append(element, $('.volt-wfb-issue-text'));
				append(text, $('span.volt-wfb-issue-message')).textContent = issue.message;
				const node = issue.nodeId ? nodes.find(entry => entry.id === issue.nodeId) : undefined;
				const where = [node ? nodeDisplayName(node) : issue.nodeId, issue.field, issue.line ? localize('voltWorkflows.line', "line {0}", issue.line) : undefined].filter(Boolean).join(' · ');
				append(text, $('span.volt-wfb-issue-where')).textContent = where || localize('voltWorkflows.wholeWorkflow', "Workflow");
				element.title = issue.message;
			},
			onOpen: issue => this.options.onRevealIssue(issue),
		}, this.instantiationService, section.store);
	}

	//#endregion
}

function providerIconOf(kind: 'manual'): HTMLElement | SVGElement {
	return workflowTriggerIcon({ type: kind })();
}
