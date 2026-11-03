/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IWorkflowNode, IWorkflowNodeType, WORKFLOW_NODE_COLORS, WorkflowNodeColor } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../../chrome/agentTooltip.js';
import { Vec } from './workflowCanvasGeometry.js';
import { colorClass, colorLabel, nodeColor } from './workflowCanvasNodes.js';

const MOD = isMacintosh ? '⌘' : 'Ctrl+';

export interface INodeToolbarActions {
	configure(nodeId: string): void;
	run(nodeId: string): void;
	ai(nodeId: string): void;
	/** `undefined` goes back to the type's colour. */
	setColor(nodeId: string, color: WorkflowNodeColor | undefined): void;
	toggleDisabled(nodeId: string): void;
	duplicate(nodeId: string): void;
	more(nodeId: string, anchor: HTMLElement): void;
	io(nodeId: string, which: 'input' | 'output'): void;
	focus(): void;
}

export function swatch(color: WorkflowNodeColor | undefined, fallback: WorkflowNodeColor = 'default'): HTMLElement {
	const dot = $(`span.volt-wf-swatch.${colorClass(color ?? fallback)}`);
	if (!color) {
		dot.classList.add('auto');
	}
	return dot;
}

/**
 * The opaque pill above the one selected node (configure, run, ask an agent, colour, enable,
 * duplicate, more), with an "Input | Output" chip under the node. Lives in screen space, so it
 * keeps its size at any zoom; the canvas places it once per frame from the node's computed box.
 */
export class WorkflowNodeToolbar extends Disposable {

	readonly element: HTMLElement;
	readonly chip: HTMLElement;
	private readonly main: HTMLElement;
	private readonly colors: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());
	private node: IWorkflowNode | undefined;
	private colorsOpen = false;

	constructor(parent: HTMLElement, private readonly actions: INodeToolbarActions) {
		super();
		this.element = append(parent, $('.volt-wf-toolbar.volt-wf-chrome.hidden'));
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('voltWorkflows.nodeToolbar', "Block actions"));
		this.colors = append(this.element, $('.volt-wf-toolbar-row.colors'));
		this.main = append(this.element, $('.volt-wf-toolbar-row.main'));
		this.chip = append(parent, $('.volt-wf-io-chip.volt-wf-chrome.hidden'));
		for (const el of [this.element, this.chip]) {
			// Keep pointer presses from selecting through to the canvas.
			this._register(addDisposableListener(el, 'pointerdown', e => e.stopPropagation()));
			this._register(addDisposableListener(el, 'dblclick', e => e.stopPropagation()));
		}
		this._register(toDisposable(() => {
			this.element.remove();
			this.chip.remove();
		}));
	}

	get visible(): boolean {
		return !!this.node;
	}

	show(node: IWorkflowNode, type: IWorkflowNodeType | undefined): void {
		if (this.node === node) {
			return;
		}
		const sameNode = this.node?.id === node.id;
		this.node = node;
		if (!sameNode) {
			this.colorsOpen = false;
		}
		this.render(node, type);
		this.element.classList.remove('hidden');
		this.chip.classList.remove('hidden');
	}

	hide(): void {
		if (!this.node) {
			return;
		}
		this.node = undefined;
		this.colorsOpen = false;
		this.element.classList.add('hidden');
		this.chip.classList.add('hidden');
		this.rendered.clear();
	}

	/** `top`: centre of the node's top edge on screen; `bottom`: centre under the node and its chips. */
	place(top: Vec, bottom: Vec): void {
		this.element.style.transform = `translate(${Math.round(top[0])}px, ${Math.round(top[1] - 10)}px) translate(-50%, -100%)`;
		this.chip.style.transform = `translate(${Math.round(bottom[0])}px, ${Math.round(bottom[1] + 8)}px) translateX(-50%)`;
	}

	private render(node: IWorkflowNode, type: IWorkflowNodeType | undefined): void {
		this.rendered.clear();
		clearNode(this.main);
		clearNode(this.colors);
		clearNode(this.chip);
		const id = node.id;
		const control = type?.control;
		const isStart = control === 'start';
		const button = (host: HTMLElement, icon: ThemeIcon | HTMLElement, label: string, shortcut: string | undefined, run: (b: HTMLButtonElement) => void, className = '') => {
			const b = append(host, $(`button.volt-wf-icon-button${className}`)) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			// An element has a string `id` too, so ThemeIcon.isThemeIcon cannot tell them apart.
			b.appendChild(isHTMLElement(icon) ? icon : renderIcon(icon));
			setAgentTooltip(b, label, shortcut, undefined, 'above');
			this.rendered.add(addDisposableListener(b, 'click', e => {
				e.stopPropagation();
				run(b);
			}));
			return b;
		};
		button(this.main, Codicon.gear, localize('voltWorkflows.configure', "Configure"), 'Enter', () => this.actions.configure(id));
		if (control === 'task' || isStart) {
			button(this.main, Codicon.play, isStart ? localize('voltWorkflows.runFromStart', "Run from here") : localize('voltWorkflows.runStep', "Run this step"), undefined, () => this.actions.run(id));
		}
		button(this.main, Codicon.commentDiscussion, localize('voltWorkflows.askAgent', "Ask an agent to change it"), undefined, () => this.actions.ai(id));
		const current = node.color;
		const colorButton = button(this.main, swatch(nodeColor(node, type)), localize('voltWorkflows.color', "Colour"), undefined, () => {
			this.colorsOpen = !this.colorsOpen;
			this.element.classList.toggle('colors-open', this.colorsOpen);
			colorButton.classList.toggle('active', this.colorsOpen);
		}, '.color');
		colorButton.classList.toggle('active', this.colorsOpen);
		if (!isStart) {
			button(this.main, node.disabled ? Codicon.eye : Codicon.circleSlash, node.disabled ? localize('voltWorkflows.enable', "Enable") : localize('voltWorkflows.disable', "Disable"), undefined, () => this.actions.toggleDisabled(id), node.disabled ? '.on' : '');
			button(this.main, Codicon.copy, localize('voltWorkflows.duplicate', "Duplicate"), `${MOD}D`, () => this.actions.duplicate(id));
		}
		append(this.main, $('span.volt-wf-toolbar-divider'));
		button(this.main, Codicon.ellipsis, localize('voltWorkflows.more', "More"), undefined, b => this.actions.more(id, b));

		const pick = (color: WorkflowNodeColor | undefined, label: string) => {
			const b = button(this.colors, swatch(color, type?.color), label, undefined, () => {
				this.actions.setColor(id, color);
				this.colorsOpen = false;
				this.element.classList.remove('colors-open');
				this.actions.focus();
			}, '.swatch');
			b.classList.toggle('checked', current === color);
			b.setAttribute('aria-pressed', String(current === color));
		};
		pick(undefined, localize('voltWorkflows.colorAuto', "Block type's colour"));
		for (const color of WORKFLOW_NODE_COLORS) {
			pick(color, colorLabel(color));
		}
		this.element.classList.toggle('colors-open', this.colorsOpen);

		const io = (which: 'input' | 'output', label: string) => {
			const b = append(this.chip, $(`button.volt-wf-io.${which}`)) as HTMLButtonElement;
			b.type = 'button';
			b.textContent = label;
			this.rendered.add(addDisposableListener(b, 'click', e => {
				e.stopPropagation();
				this.actions.io(id, which);
			}));
		};
		if (!isStart) {
			io('input', localize('voltWorkflows.input', "Input"));
			append(this.chip, $('span.volt-wf-io-divider'));
		}
		io('output', localize('voltWorkflows.output', "Output"));
	}
}

/** The "+" (insert a block) and "×" (delete) at the middle of the hovered connection. */
export class WorkflowEdgeTools extends Disposable {

	readonly element: HTMLElement;
	private edgeId: string | undefined;
	private hideTimer: number | undefined;

	constructor(parent: HTMLElement, private readonly onInsert: (edgeId: string, button: HTMLElement) => void, private readonly onDelete: (edgeId: string) => void, private readonly onLeave: () => void) {
		super();
		this.element = append(parent, $('.volt-wf-edge-tools.volt-wf-chrome.hidden'));
		const button = (icon: ThemeIcon, label: string, run: (b: HTMLButtonElement) => void, className: string) => {
			const b = append(this.element, $(`button.volt-wf-icon-button.${className}`)) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.appendChild(renderIcon(icon));
			setAgentTooltip(b, label, undefined, undefined, 'above');
			this._register(addDisposableListener(b, 'click', e => {
				e.stopPropagation();
				if (this.edgeId) {
					run(b);
				}
			}));
		};
		button(Codicon.add, localize('voltWorkflows.insertBlock', "Insert a block"), b => this.onInsert(this.edgeId!, b), 'insert');
		button(Codicon.close, localize('voltWorkflows.deleteConnection', "Delete connection"), () => this.onDelete(this.edgeId!), 'delete');
		this._register(addDisposableListener(this.element, 'pointerdown', e => e.stopPropagation()));
		this._register(addDisposableListener(this.element, 'pointerenter', () => this.cancelHide()));
		this._register(addDisposableListener(this.element, 'pointerleave', () => this.scheduleHide()));
		this._register(toDisposable(() => {
			this.cancelHide();
			this.element.remove();
		}));
	}

	get shownFor(): string | undefined {
		return this.edgeId;
	}

	show(edgeId: string): void {
		this.cancelHide();
		this.edgeId = edgeId;
		this.element.classList.remove('hidden');
	}

	place(screen: Vec): void {
		this.element.style.transform = `translate(${Math.round(screen[0])}px, ${Math.round(screen[1])}px) translate(-50%, -50%)`;
	}

	/** Leaving the edge: wait a moment so the pointer can reach the buttons. */
	scheduleHide(): void {
		this.cancelHide();
		this.hideTimer = getWindow(this.element).setTimeout(() => {
			this.hideTimer = undefined;
			this.hide();
			this.onLeave();
		}, 160);
	}

	cancelHide(): void {
		if (this.hideTimer !== undefined) {
			getWindow(this.element).clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
	}

	hide(): void {
		this.cancelHide();
		this.edgeId = undefined;
		this.element.classList.add('hidden');
	}
}
