/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { setAgentTooltip } from './agentTooltip.js';

export interface IQueuedPrompt {
	id: string;
	text: string;
	preview?: string;
}

export interface IAgentComposerQueueOptions {
	onRemove(id: string): void;
	onClear(): void;
	onMultitask(): void;
	onReorder(ids: readonly string[]): void;
}

function createGripIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.grip');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 10 16');
	svg.setAttribute('width', '10');
	svg.setAttribute('height', '16');
	svg.setAttribute('aria-hidden', 'true');
	for (const [x, y] of [[2, 3], [7, 3], [2, 8], [7, 8], [2, 13], [7, 13]]) {
		const dot = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		dot.setAttribute('cx', String(x));
		dot.setAttribute('cy', String(y));
		dot.setAttribute('r', '1.15');
		dot.setAttribute('fill', 'currentColor');
		svg.appendChild(dot);
	}
	el.appendChild(svg);
	return el;
}

export class AgentComposerQueue extends Disposable {

	readonly element: HTMLElement;

	private readonly queueEl: HTMLElement;
	private readonly listeners = this._register(new DisposableStore());
	private readonly dragListeners = this._register(new DisposableStore());
	private items: IQueuedPrompt[] = [];
	private mode = 'Agent';
	/** True while a row is being dragged; re-renders are deferred until the drop lands. */
	private dragging = false;
	private renderPending = false;

	constructor(
		private readonly options: IAgentComposerQueueOptions,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this.element = $('.volt-agent-composer-stack');
		this.queueEl = append(this.element, $('.volt-agent-queue-card.hidden'));
		this._register(this.terminalService.onDidChangeInstances(() => this.render()));
		this._register(this.terminalService.onAnyInstancePrimaryStatusChange(() => this.render()));
	}

	setMode(mode: string): void {
		if (this.mode === mode) {
			return;
		}
		this.mode = mode;
		this.render();
	}

	setQueue(items: readonly IQueuedPrompt[]): void {
		// The editor re-syncs the queue on every thread render (each streaming
		// tick). Skip the rebuild when nothing changed so in-flight interaction
		// on the rows (hover, drag) is never torn down needlessly.
		if (this.sameItems(items)) {
			return;
		}
		this.items = items.slice();
		this.render();
	}

	private sameItems(items: readonly IQueuedPrompt[]): boolean {
		if (items.length !== this.items.length) {
			return false;
		}
		return items.every((item, index) => {
			const current = this.items[index];
			return current.id === item.id && current.text === item.text && current.preview === item.preview;
		});
	}

	private terminals(): number {
		return this.terminalService.instances.filter(instance => instance.hasChildProcesses).length;
	}

	private render(): void {
		if (this.dragging) {
			this.renderPending = true;
			return;
		}
		this.renderPending = false;
		this.listeners.clear();
		this.queueEl.replaceChildren();
		const count = this.items.length;
		this.queueEl.classList.toggle('hidden', count === 0);
		this.element.classList.toggle('has-stack', count > 0);
		if (!count) {
			return;
		}
		const head = append(this.queueEl, $('.volt-agent-queue-head'));
		const title = append(head, $('span.volt-agent-queue-title'));
		title.textContent = localize('voltAgent.queuedCountN', "{0} Queued", count);

		const actions = append(head, $('.volt-agent-queue-head-actions'));
		if (this.mode !== 'Multitask') {
			const multi = append(actions, $('button.volt-agent-queue-multitask')) as HTMLButtonElement;
			multi.type = 'button';
			multi.textContent = localize('voltAgent.startMultitasking', "Start Multitasking");
			this.listeners.add(addDisposableListener(multi, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onMultitask();
			}));
		}
		const clear = append(actions, $('button.volt-agent-queue-remove')) as HTMLButtonElement;
		clear.type = 'button';
		setAgentTooltip(clear, localize('voltAgent.clearQueue', "Clear queue"));
		clear.appendChild(renderIcon(Codicon.close));
		this.listeners.add(addDisposableListener(clear, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onClear();
		}));

		const list = append(this.queueEl, $('.volt-agent-queue-list'));
		for (const item of this.items) {
			const row = append(list, $('.volt-agent-queue-item'));
			row.dataset.queueId = item.id;
			const grip = append(row, createGripIcon());
			setAgentTooltip(grip, localize('voltAgent.reorderQueue', "Drag to reorder"));
			const text = append(row, $('span.volt-agent-queue-text'));
			const preview = (item.preview ?? item.text).trim().replace(/\s+/g, ' ');
			text.textContent = preview;
			setAgentTooltip(text, preview);
			const remove = append(row, $('button.volt-agent-queue-remove')) as HTMLButtonElement;
			remove.type = 'button';
			setAgentTooltip(remove, localize('voltAgent.removeQueued', "Remove from queue"));
			remove.appendChild(renderIcon(Codicon.close));
			this.listeners.add(addDisposableListener(remove, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onRemove(item.id);
			}));
			this.listeners.add(addDisposableListener(grip, 'pointerdown', e => {
				if (e.button !== 0 || this.items.length < 2) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.beginDrag(e, list, row, grip);
			}));
		}

		this.renderTerminals();
	}

	/**
	 * Pointer-driven reordering. Native HTML5 drag-and-drop is avoided on
	 * purpose: it needs `draggable` toggling, fights the workbench's global
	 * drop handlers, and is killed the moment the rows are rebuilt.
	 */
	private beginDrag(start: PointerEvent, list: HTMLElement, row: HTMLElement, grip: HTMLElement): void {
		this.dragListeners.clear();
		const targetWindow = row.ownerDocument.defaultView;
		if (!targetWindow) {
			return;
		}
		const pointerId = start.pointerId;
		const startY = start.clientY;
		const grabOffset = startY - row.getBoundingClientRect().top;
		const rowsOf = () => Array.from(list.children) as HTMLElement[];
		let active = false;

		const rowIndexAt = (clientY: number): number => {
			const rows = rowsOf();
			for (let i = 0; i < rows.length; i++) {
				if (rows[i] === row) {
					continue;
				}
				const rect = rows[i].getBoundingClientRect();
				if (clientY < rect.top + rect.height / 2) {
					return i;
				}
			}
			return rows.length;
		};

		const followPointer = (clientY: number) => {
			const listRect = list.getBoundingClientRect();
			const rect = row.getBoundingClientRect();
			// Unshifted top of the row's current slot.
			const slotTop = rect.top - (parseFloat(row.style.getPropertyValue('--volt-drag-shift')) || 0);
			const minY = listRect.top;
			const maxY = listRect.bottom - rect.height;
			const wanted = Math.min(maxY, Math.max(minY, clientY - grabOffset));
			const shift = wanted - slotTop;
			row.style.setProperty('--volt-drag-shift', `${shift}px`);
			row.style.transform = `translateY(${shift}px)`;
		};

		const activate = () => {
			active = true;
			this.dragging = true;
			row.classList.add('dragging');
			list.classList.add('reordering');
			try {
				grip.setPointerCapture(pointerId);
			} catch {
				// Pointer may already be gone; fall back to window listeners below.
			}
		};

		const finish = (commit: boolean) => {
			this.dragListeners.clear();
			try {
				if (grip.hasPointerCapture(pointerId)) {
					grip.releasePointerCapture(pointerId);
				}
			} catch {
				// ignore
			}
			if (!active) {
				return;
			}
			row.classList.remove('dragging');
			list.classList.remove('reordering');
			row.style.transform = '';
			row.style.removeProperty('--volt-drag-shift');
			for (const other of rowsOf()) {
				other.style.transform = '';
				other.style.transition = '';
			}
			this.dragging = false;
			const order = rowsOf().map(el => el.dataset.queueId).filter((id): id is string => !!id);
			const changed = order.some((id, index) => id !== this.items[index]?.id);
			if (commit && changed) {
				// Mirror the order locally so the pending re-render is a no-op diff.
				const byId = new Map(this.items.map(item => [item.id, item]));
				this.items = order.map(id => byId.get(id)).filter((item): item is IQueuedPrompt => !!item);
				this.options.onReorder(order);
			} else if (!commit && changed) {
				this.renderPending = true;
			}
			if (this.renderPending) {
				this.render();
			}
		};

		const onMove = (e: PointerEvent) => {
			if (e.pointerId !== pointerId) {
				return;
			}
			if (!active) {
				if (Math.abs(e.clientY - startY) < 3) {
					return;
				}
				activate();
			}
			e.preventDefault();
			const rows = rowsOf();
			const from = rows.indexOf(row);
			let to = rowIndexAt(e.clientY);
			if (to > from) {
				to -= 1;
			}
			if (to !== from) {
				const before = new Map(rows.map(el => [el, el.getBoundingClientRect().top]));
				const anchor = rows[to > from ? to + 1 : to] ?? null;
				list.insertBefore(row, anchor);
				// FLIP the displaced neighbours so they glide into their new slots.
				for (const other of rowsOf()) {
					if (other === row) {
						continue;
					}
					const delta = (before.get(other) ?? 0) - other.getBoundingClientRect().top;
					if (Math.abs(delta) < 0.5) {
						continue;
					}
					other.style.transition = 'none';
					other.style.transform = `translateY(${delta}px)`;
					targetWindow.requestAnimationFrame(() => {
						other.style.transition = 'transform 140ms ease';
						other.style.transform = '';
					});
				}
			}
			followPointer(e.clientY);
		};

		this.dragListeners.add(addDisposableListener(targetWindow, 'pointermove', onMove, true));
		this.dragListeners.add(addDisposableListener(targetWindow, 'pointerup', e => {
			if (e.pointerId === pointerId) {
				finish(true);
			}
		}, true));
		this.dragListeners.add(addDisposableListener(targetWindow, 'pointercancel', e => {
			if (e.pointerId === pointerId) {
				finish(false);
			}
		}, true));
		this.dragListeners.add(addDisposableListener(targetWindow, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finish(false);
			}
		}, true));
		this.dragListeners.add(addDisposableListener(targetWindow, 'blur', () => finish(false)));
	}

	private renderTerminals(): void {
		const terminals = this.terminals();
		if (terminals > 0) {
			const chips = append(this.queueEl, $('.volt-agent-queue-chips'));
			const chip = append(chips, $('span.volt-agent-queue-chip'));
			append(chip, $('span.volt-agent-composer-chip-dot'));
			append(chip, $('span')).textContent = terminals === 1
				? localize('voltAgent.oneTerminal', "1 Terminal")
				: localize('voltAgent.manyTerminals', "{0} Terminals", terminals);
		}
	}
}
