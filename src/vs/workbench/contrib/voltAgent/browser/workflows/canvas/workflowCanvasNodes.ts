/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { getWorkflowNodeType, nodeDisplayName } from '../../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowIssue, IWorkflowNode, IWorkflowNodeType, IWorkflowRun, IWorkflowTrigger, WorkflowNodeColor, WorkflowNodeState } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../../chrome/agentTooltip.js';
import { HEAD_HEIGHT, INodeLayout, layoutNode, PORT_ROW, ROUND_SIZE } from './workflowCanvasGeometry.js';

/** What the canvas shows of a node's part in a run. */
export interface INodeRunView {
	readonly state: WorkflowNodeState;
	/** Executions in the run (loops run a node several times). */
	readonly count: number;
	readonly durationMs?: number;
	readonly error?: string;
	readonly waitingFor?: string;
}

/** Per node: its latest step's state, how often it ran, and how long the last run took. */
export function runViews(run: IWorkflowRun | undefined): Map<string, INodeRunView> {
	const views = new Map<string, INodeRunView>();
	if (!run) {
		return views;
	}
	const ids = new Map<string, Set<string>>();
	for (const step of run.steps) {
		let seen = ids.get(step.nodeId);
		if (!seen) {
			seen = new Set();
			ids.set(step.nodeId, seen);
		}
		seen.add(step.id);
		views.set(step.nodeId, {
			state: step.state,
			count: seen.size,
			durationMs: step.startedAt !== undefined && step.finishedAt !== undefined ? Math.max(0, step.finishedAt - step.startedAt) : undefined,
			error: step.error,
			waitingFor: step.waitingFor,
		});
	}
	return views;
}

function runKey(view: INodeRunView | undefined): string {
	return view ? `${view.state}|${view.count}|${view.durationMs ?? ''}|${view.error ?? ''}|${view.waitingFor ?? ''}` : '';
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return localize('voltWorkflows.durationMs', "{0} ms", Math.round(ms));
	}
	if (ms < 60_000) {
		return localize('voltWorkflows.durationS', "{0} s", (ms / 1000).toFixed(ms < 10_000 ? 1 : 0));
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return localize('voltWorkflows.durationM', "{0}m {1}s", minutes, String(seconds).padStart(2, '0'));
}

/** The colour class of a node: its own colour, else its type's. */
export function nodeColor(node: Pick<IWorkflowNode, 'color' | 'type'>, type = getWorkflowNodeType(node.type)): WorkflowNodeColor {
	return node.color ?? type?.color ?? 'default';
}

export function colorClass(color: WorkflowNodeColor): string {
	return `volt-wf-c-${color}`;
}

export function colorLabel(color: WorkflowNodeColor): string {
	switch (color) {
		case 'default': return localize('voltWorkflows.color.default', "Grey");
		case 'blue': return localize('voltWorkflows.color.blue', "Blue");
		case 'green': return localize('voltWorkflows.color.green', "Green");
		case 'yellow': return localize('voltWorkflows.color.yellow', "Yellow");
		case 'orange': return localize('voltWorkflows.color.orange', "Orange");
		case 'red': return localize('voltWorkflows.color.red', "Red");
		case 'pink': return localize('voltWorkflows.color.pink', "Pink");
		case 'purple': return localize('voltWorkflows.color.purple', "Purple");
		case 'teal': return localize('voltWorkflows.color.teal', "Teal");
	}
}

/** A codicon for a type; never the sparkle (Volt does not use it anywhere). */
export function nodeIcon(type: IWorkflowNodeType | undefined): ThemeIcon {
	const id = type?.icon;
	if (!id) {
		return Codicon.question;
	}
	return id.startsWith('sparkle') || id === 'copilot' ? Codicon.robot : ThemeIcon.fromId(id);
}

export function triggerSummary(trigger: IWorkflowTrigger): string {
	switch (trigger.type) {
		case 'schedule':
			if (trigger.everyMinutes) {
				return localize('voltWorkflows.trigger.every', "Every {0} min", trigger.everyMinutes);
			}
			return trigger.cron ? localize('voltWorkflows.trigger.cron', "Schedule · {0}", trigger.cron) : localize('voltWorkflows.trigger.schedule', "Schedule");
		case 'event':
			return [trigger.provider, trigger.event].filter(Boolean).join(' · ') || localize('voltWorkflows.trigger.event', "Event");
		default:
			return localize('voltWorkflows.trigger.manual', "Manual · Run button");
	}
}

function subtitleOf(node: IWorkflowNode, type: IWorkflowNodeType | undefined): string {
	if (!type) {
		return localize('voltWorkflows.unknownType', "Unknown block type \"{0}\"", node.type);
	}
	let summary: string | undefined;
	try {
		summary = type.summary?.(node.config);
	} catch {
		summary = undefined;
	}
	if (summary) {
		return summary;
	}
	return node.name && node.name.trim() !== type.label ? type.label : type.description;
}

/** A node's flags the canvas sets (selection, gestures); kept across re-renders. */
export type NodeFlag = 'selected' | 'dragging' | 'connect-target' | 'connect-invalid' | 'renaming' | 'port-active';

/**
 * One node on the canvas: a card (a header with the icon tile in the node's colour, name and
 * summary, then one labelled row per output port), a round end, a pill, or the start block.
 * Re-renders only when its node object, run view or issues change; moving it only writes the
 * transform.
 */
export class WorkflowNodeView {

	readonly element: HTMLElement;
	private nodeValue: IWorkflowNode;
	private type: IWorkflowNodeType | undefined;
	private layoutValue: INodeLayout;
	private trigger: IWorkflowTrigger;
	private x = Number.NaN;
	private y = Number.NaN;
	private readonly flags = new Set<NodeFlag>();
	private run: INodeRunView | undefined;
	private runSignature = '';
	private issues: readonly IWorkflowIssue[] = [];
	private issueSignature = '';
	private wired: ReadonlySet<string> = new Set();
	/** Issue dot, run count and state marks, in the header (or beside a round node's name). */
	private status!: HTMLElement;
	private below!: HTMLElement;
	private belowHeight = 0;
	private title!: HTMLElement;
	private readonly pluses = new Map<string, HTMLElement>();
	private activePort: string | undefined;
	private triggerButton: HTMLElement | undefined;

	constructor(node: IWorkflowNode, trigger: IWorkflowTrigger, private readonly readOnly: boolean) {
		this.element = $('.volt-wf-node');
		this.nodeValue = node;
		this.type = getWorkflowNodeType(node.type);
		this.layoutValue = layoutNode(node);
		this.trigger = trigger;
		this.element.dataset.node = node.id;
		this.render();
		this.setPosition(node.position.x, node.position.y);
	}

	get id(): string {
		return this.nodeValue.id;
	}

	get node(): IWorkflowNode {
		return this.nodeValue;
	}

	get nodeType(): IWorkflowNodeType | undefined {
		return this.type;
	}

	get layout(): INodeLayout {
		return this.layoutValue;
	}

	get position(): { readonly x: number; readonly y: number } {
		return { x: this.x, y: this.y };
	}

	get isStart(): boolean {
		return this.type?.control === 'start';
	}

	/** World px under the box taken by the round label and the run chips (the I/O chip goes below). */
	get extentBelow(): number {
		return this.layoutValue.below + (this.belowHeight ? this.belowHeight + 6 : 0);
	}

	get titleElement(): HTMLElement {
		return this.title;
	}

	get triggerElement(): HTMLElement | undefined {
		return this.triggerButton;
	}

	/** Takes the latest node object; re-renders unless only the position moved. */
	update(node: IWorkflowNode, trigger: IWorkflowTrigger): void {
		const previous = this.nodeValue;
		this.nodeValue = node;
		const contentChanged = previous.type !== node.type || previous.name !== node.name || previous.config !== node.config
			|| previous.color !== node.color || previous.disabled !== node.disabled || previous.id !== node.id
			|| (this.isStart && trigger !== this.trigger);
		this.trigger = trigger;
		if (contentChanged) {
			this.type = getWorkflowNodeType(node.type);
			this.layoutValue = layoutNode(node);
			this.element.dataset.node = node.id;
			this.render();
		}
	}

	setPosition(x: number, y: number): void {
		if (x === this.x && y === this.y) {
			return;
		}
		this.x = x;
		this.y = y;
		this.element.style.transform = `translate(${x}px, ${y}px)`;
	}

	setFlag(flag: NodeFlag, on: boolean): void {
		if (on === this.flags.has(flag)) {
			return;
		}
		if (on) {
			this.flags.add(flag);
		} else {
			this.flags.delete(flag);
		}
		this.element.classList.toggle(flag, on);
	}

	/** Lights the output port a connection is being drawn from. */
	setActivePort(port: string | undefined): void {
		if (port === this.activePort) {
			return;
		}
		this.activePort = port;
		for (const el of this.element.querySelectorAll<HTMLElement>('[data-port]')) {
			el.classList.toggle('active', el.dataset.port === port);
		}
		this.setFlag('port-active', !!port);
	}

	setRun(view: INodeRunView | undefined): void {
		const signature = runKey(view);
		if (signature === this.runSignature) {
			return;
		}
		this.run = view;
		this.runSignature = signature;
		this.applyClasses();
		this.renderBadges();
	}

	setIssues(issues: readonly IWorkflowIssue[]): void {
		const signature = issues.map(issue => `${issue.severity}:${issue.message}`).join('\n');
		if (signature === this.issueSignature) {
			return;
		}
		this.issues = issues;
		this.issueSignature = signature;
		this.renderBadges();
	}

	/** Output ports with an edge: their "+" hides. */
	setWired(ports: ReadonlySet<string>, hidePluses: boolean): void {
		this.wired = ports;
		for (const [port, plus] of this.pluses) {
			plus.classList.toggle('hidden', hidePluses || ports.has(port));
		}
	}

	private applyClasses(): void {
		const state = this.run?.state;
		const classes = ['volt-wf-node', `shape-${this.layoutValue.shape}`, colorClass(nodeColor(this.nodeValue, this.type))];
		if (state && state !== 'idle') {
			classes.push(`s-${state}`);
		}
		if (this.nodeValue.disabled) {
			classes.push('disabled');
		}
		if (!this.type) {
			classes.push('unknown');
		}
		classes.push(...this.flags);
		this.element.className = classes.join(' ');
	}

	private render(): void {
		const el = this.element;
		clearNode(el);
		this.pluses.clear();
		this.activePort = undefined;
		this.triggerButton = undefined;
		this.applyClasses();
		const layout = this.layoutValue;
		const node = this.nodeValue;
		const type = this.type;
		el.style.width = `${layout.width}px`;
		el.style.height = `${layout.height}px`;
		// The running outline: dashes turning around the card (shown by `.s-running` only).
		append(el, $('.volt-wf-node-run'));
		append(el, $('.volt-wf-node-box'));
		const name = nodeDisplayName(node);
		el.setAttribute('aria-label', name);
		if (layout.shape === 'round') {
			const tile = append(el, $('.volt-wf-node-tile'));
			tile.appendChild(renderIcon(nodeIcon(type)));
			const label = append(el, $('.volt-wf-round-label'));
			label.style.top = `${ROUND_SIZE + 6}px`;
			const line = append(label, $('.volt-wf-round-line'));
			this.status = append(line, $('span.volt-wf-node-status'));
			this.title = append(line, $('span.volt-wf-node-title'));
			this.title.textContent = name;
			const sub = append(label, $('.volt-wf-node-sub'));
			sub.textContent = subtitleOf(node, type);
		} else {
			const head = append(el, $('.volt-wf-node-head'));
			head.style.height = `${layout.shape === 'pill' ? layout.height : HEAD_HEIGHT}px`;
			const tile = append(head, $('.volt-wf-node-tile'));
			tile.appendChild(renderIcon(nodeIcon(type)));
			const text = append(head, $('.volt-wf-node-text'));
			this.title = append(text, $('.volt-wf-node-title'));
			this.title.textContent = name;
			if (layout.shape === 'start' && !this.readOnly) {
				// The trigger is the start node's subtitle, and the place to change it (Postman's "Change trigger").
				const button = append(text, $('button.volt-wf-node-sub.volt-wf-trigger')) as HTMLButtonElement;
				button.type = 'button';
				button.dataset.trigger = '';
				append(button, $('span.volt-wf-trigger-text')).textContent = triggerSummary(this.trigger);
				button.appendChild(renderIcon(Codicon.chevronDown));
				setAgentTooltip(button, localize('voltWorkflows.changeTrigger', "Change trigger"));
				this.triggerButton = button;
			} else if (layout.shape !== 'pill') {
				const sub = append(text, $('.volt-wf-node-sub'));
				sub.textContent = layout.shape === 'start' ? triggerSummary(this.trigger) : subtitleOf(node, type);
			}
			this.status = append(head, $('span.volt-wf-node-status'));
		}
		if (layout.rows) {
			const divider = append(el, $('.volt-wf-node-divider'));
			divider.style.top = `${HEAD_HEIGHT}px`;
			for (const port of layout.outputs) {
				const row = append(el, $(`.volt-wf-port-row.k-${port.kind}`));
				row.dataset.port = port.id;
				row.style.top = `${port.y - PORT_ROW / 2}px`;
				append(row, $('span.label')).textContent = layout.shape === 'start' ? localize('voltWorkflows.startRow', "Payload and inputs") : port.label;
			}
		}
		if (layout.input) {
			const input = append(el, $('span.volt-wf-node-in'));
			input.dataset.input = 'in';
			input.style.top = `${layout.input[1]}px`;
		}
		for (const port of layout.outputs) {
			const dot = append(el, $(`span.volt-wf-port-dot.k-${port.kind}`));
			dot.dataset.port = port.id;
			dot.style.left = `${port.x}px`;
			dot.style.top = `${port.y}px`;
			if (!layout.rows) {
				setAgentTooltip(dot, port.label);
			}
			if (!this.readOnly) {
				const plus = append(el, $('span.volt-wf-plus'));
				plus.dataset.plus = port.id;
				plus.style.left = `${port.x + 14}px`;
				plus.style.top = `${port.y}px`;
				plus.appendChild(renderIcon(Codicon.add));
				setAgentTooltip(plus, localize('voltWorkflows.addAfterPort', "Add a block after \"{0}\"", port.label));
				plus.classList.toggle('hidden', this.wired.has(port.id));
				this.pluses.set(port.id, plus);
			}
		}
		this.below = append(el, $('.volt-wf-node-below'));
		this.below.style.top = `${layout.height + layout.below + 6}px`;
		this.renderBadges();
	}

	/** Issues, run count, disabled and run state as small marks in the header; error and wait chips and the duration under the node. */
	private renderBadges(): void {
		const status = this.status;
		const below = this.below;
		if (!status || !below) {
			return;
		}
		clearNode(status);
		clearNode(below);
		const run = this.run;
		const errors = this.issues.filter(issue => issue.severity === 'error');
		const warnings = this.issues.filter(issue => issue.severity !== 'error');
		if (errors.length || warnings.length) {
			const dot = append(status, $(`span.volt-wf-status-dot.${errors.length ? 'error' : 'warning'}`));
			dot.setAttribute('role', 'img');
			dot.setAttribute('aria-label', errors.length ? localize('voltWorkflows.hasErrors', "Has problems") : localize('voltWorkflows.hasWarnings', "Has warnings"));
			setAgentTooltip(dot, [...errors, ...warnings].map(issue => issue.message).join('\n'));
		}
		if (run && run.count > 1) {
			const count = append(status, $('span.volt-wf-status-count'));
			count.textContent = `×${run.count}`;
			setAgentTooltip(count, localize('voltWorkflows.ranTimes', "Ran {0} times in this run", run.count));
		}
		const mark = (kind: string, icon: ThemeIcon, tooltip: string) => {
			const m = append(status, $(`span.volt-wf-status-icon.${kind}`));
			m.appendChild(renderIcon(icon));
			setAgentTooltip(m, tooltip);
		};
		if (this.nodeValue.disabled) {
			mark('disabled', Codicon.circleSlash, localize('voltWorkflows.disabledBadge', "Disabled: runs skip it and pass its input on"));
		}
		switch (run?.state) {
			case 'success': mark('success', Codicon.check, localize('voltWorkflows.stateSuccess', "Succeeded")); break;
			case 'failed': mark('failed', Codicon.close, localize('voltWorkflows.stateFailed', "Failed")); break;
			case 'waiting': mark('waiting', Codicon.clock, localize('voltWorkflows.stateWaiting', "Waiting")); break;
		}
		let height = 0;
		const chip = (kind: string, text: string, tooltip?: string) => {
			const c = append(below, $(`span.volt-wf-chip.${kind}`));
			c.textContent = text;
			if (tooltip) {
				setAgentTooltip(c, tooltip);
			}
			height += height ? 24 : 20;
		};
		if (run?.state === 'failed' && run.error) {
			chip('error', run.error, run.error);
		} else if (run?.state === 'waiting') {
			const what = run.waitingFor || localize('voltWorkflows.approval', "approval");
			chip('waiting', localize('voltWorkflows.waitingFor', "Waiting for {0}", what.charAt(0).toLowerCase() + what.slice(1)));
		}
		if (run?.durationMs !== undefined && run.state !== 'running' && run.state !== 'queued' && run.state !== 'waiting') {
			chip('duration', formatDuration(run.durationMs));
		}
		this.belowHeight = height;
	}
}
