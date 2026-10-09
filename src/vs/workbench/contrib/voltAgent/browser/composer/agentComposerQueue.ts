/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { AgentTooltip, setAgentTooltip } from '../chrome/agentTooltip.js';
import { groupSummary, isLiveSubagentState, ISubagentView, renderCursorCardRow, tickSubagentClocks } from '../chrome/agentSubagents.js';
import { ITasksCard } from '../chrome/agentTimeline.js';
import { AgentTasksCard } from './agentTasksCard.js';

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
	/** Load a queued prompt into the composer to change it (Cursor's "Edit queued message"). */
	onEdit?(id: string): void;
	/** Send this prompt now: steer the running agent, interrupt it, or just send when idle. */
	onSendNow?(id: string): void;
	/** The queue was paused by an error or left idle: send the next prompt and keep draining. */
	onResume?(): void;
	onCancelEdit?(): void;
	/** A subagent row was clicked: open its chat beside this one. */
	onOpenAgent?(view: ISubagentView): void;
	onStopAgent?(view: ISubagentView): void;
	/** Stop every running subagent of this chat. */
	onStopAllAgents?(): void;
}

/** Subagents shown in the card, with the conflicts between them. */
export interface IAgentComposerAgents {
	readonly views: readonly ISubagentView[];
	readonly conflicts: readonly { readonly path: string; readonly titles: readonly string[] }[];
}

/** Why the queue is not draining on its own: stopped, an error, a restart, or too many automatic wake-ups. */
export type QueuePause = 'stopped' | 'failed' | 'interrupted' | 'wakeups';

export interface IAgentComposerQueueState {
	readonly paused?: QueuePause;
	/** The queued prompt loaded into the composer for editing. */
	readonly editingId?: string;
	/** An agent is running; "Send now" acts on it. */
	readonly running: boolean;
	/** The running agent takes messages without stopping (native inbox); otherwise Send now interrupts it. */
	readonly steer: boolean;
}

/** The "Send now" button's label and tooltip, as Cursor words them. */
export function queueSendNowLabels(state: Pick<IAgentComposerQueueState, 'running' | 'steer'>): { readonly label: string; readonly tooltip: string } {
	if (!state.running) {
		return { label: localize('voltAgent.queue.sendNow', "Send now"), tooltip: localize('voltAgent.queue.sendNow', "Send now") };
	}
	return state.steer
		? { label: localize('voltAgent.queue.steer', "Steer"), tooltip: localize('voltAgent.queue.steerHint', "Sends without interrupting the agent") }
		: { label: localize('voltAgent.queue.sendNow', "Send now"), tooltip: localize('voltAgent.queue.interruptHint', "Sends now, interrupting the agent") };
}

export function queuePauseLabel(pause: QueuePause): string {
	switch (pause) {
		case 'failed': return localize('voltAgent.queue.pausedError', "Paused after an error");
		case 'interrupted': return localize('voltAgent.queue.pausedRestart', "Paused after a restart");
		case 'wakeups': return localize('voltAgent.queue.pausedWakeups', "Paused");
		case 'stopped': return localize('voltAgent.queue.pausedStop', "Paused");
	}
}

function queuePauseHint(pause: QueuePause): string {
	switch (pause) {
		case 'failed': return localize('voltAgent.queue.pausedErrorHint', "The last run failed, so queued prompts wait for you instead of going to the same provider.");
		case 'interrupted': return localize('voltAgent.queue.pausedRestartHint', "Volt restarted while this chat worked. Nothing resumes on its own: Resume continues.");
		case 'wakeups': return localize('voltAgent.queue.pausedWakeupsHint', "Subagent reports woke this chat many times in a row without you. Resume to keep going.");
		case 'stopped': return localize('voltAgent.queue.pausedStopHint', "Nothing is running, so queued prompts wait for you.");
	}
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
	/** The agent's to-dos, last in the stack so it tucks under the input box. */
	private readonly tasksCard: AgentTasksCard;
	private readonly listeners = this._register(new DisposableStore());
	private readonly dragListeners = this._register(new DisposableStore());
	private items: IQueuedPrompt[] = [];
	private agents: IAgentComposerAgents = { views: [], conflicts: [] };
	private agentsSignature = '';
	/** The dock beside the chat is open and lists the finished agents: the card shows only the working ones. */
	private agentsInDock = false;
	private agentsCollapsed = false;
	private queueCollapsed = false;
	private readonly agentTooltip = this._register(new AgentTooltip());
	private readonly clockStore = this._register(new DisposableStore());
	private state: IAgentComposerQueueState = { running: false, steer: false };
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
		this.tasksCard = this._register(new AgentTasksCard(() => this.syncStackClass()));
		append(this.element, this.tasksCard.element);
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

	setState(state: IAgentComposerQueueState): void {
		const current = this.state;
		if (current.paused === state.paused && current.editingId === state.editingId && current.running === state.running && current.steer === state.steer) {
			return;
		}
		this.state = state;
		this.render();
	}

	/** The latest to-do list, or undefined to hide the Tasks card. */
	setTasks(card: ITasksCard | undefined): void {
		this.tasksCard.set(card);
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

	/** Subagents of this chat (live ones and the latest batch). Rows redraw only when something they show changed. */
	setAgents(agents: IAgentComposerAgents): void {
		const signature = JSON.stringify([agents.views.map(view => [view.key, view.title, view.state, view.detail, view.modelLabel, view.startedAt, view.endedAt, view.cancellable]), agents.conflicts]);
		if (signature === this.agentsSignature) {
			return;
		}
		this.agentsSignature = signature;
		this.agents = agents;
		this.render();
	}

	setAgentsInDock(inDock: boolean): void {
		if (inDock === this.agentsInDock) {
			return;
		}
		this.agentsInDock = inDock;
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
		this.clockStore.clear();
		this.queueEl.replaceChildren();
		const count = this.items.length;
		const agents = this.shownAgents().length || (this.agentsInDock ? this.agents.conflicts.length : 0);
		this.queueEl.classList.toggle('hidden', count === 0 && agents === 0);
		this.syncStackClass();
		this.queueEl.classList.toggle('paused', false);
		this.queueEl.classList.toggle('editing', false);
		if (agents) {
			this.renderAgents(append(this.queueEl, $('.volt-agent-work-section.agents')));
		}
		if (count) {
			this.renderQueue(append(this.queueEl, $('.volt-agent-work-section.queue')));
		}
		this.renderTerminals();
	}

	private syncStackClass(): void {
		const cards = this.items.length > 0 || this.shownAgents().length > 0 || (this.agentsInDock && this.agents.conflicts.length > 0);
		this.element.classList.toggle('has-stack', cards || this.tasksCard.visible);
		this.element.classList.toggle('has-tasks', this.tasksCard.visible);
	}

	/** With the dock open, finished agents sit under its "Previous agents": the card keeps the working ones. */
	private shownAgents(): readonly ISubagentView[] {
		return this.agentsInDock ? this.agents.views.filter(view => isLiveSubagentState(view.state)) : this.agents.views;
	}

	private renderAgents(section: HTMLElement): void {
		const views = this.shownAgents();
		const live = views.filter(view => isLiveSubagentState(view.state));
		const head = append(section, $('.volt-agent-work-head'));
		const toggle = append(head, $('button.volt-agent-work-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!this.agentsCollapsed));
		toggle.appendChild(renderIcon(this.agentsCollapsed ? Codicon.chevronRight : Codicon.chevronDown));
		append(toggle, $('span')).textContent = live.length
			? (live.length === 1 ? localize('voltAgent.work.oneRunning', "1 subagent running") : localize('voltAgent.work.manyRunning', "{0} subagents running", live.length))
			: (views.length === 1 ? localize('voltAgent.work.one', "1 subagent") : localize('voltAgent.work.many', "{0} subagents", views.length));
		const finished = views.length - live.length;
		if (finished && live.length) {
			const summary = append(head, $('span.volt-agent-queue-paused'));
			summary.style.color = 'inherit';
			summary.style.opacity = '0.6';
			summary.textContent = groupSummary(views.filter(view => !isLiveSubagentState(view.state)));
		}
		this.listeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.agentsCollapsed = !this.agentsCollapsed;
			this.render();
		}));
		const actions = append(head, $('.volt-agent-queue-head-actions'));
		if (this.state.paused && !this.items.length && !this.state.running) {
			// Reports wait (a restart, an error) with nothing queued: the subagents' header offers Resume.
			const paused = append(head, $('span.volt-agent-queue-paused'));
			paused.textContent = queuePauseLabel(this.state.paused);
			setAgentTooltip(paused, queuePauseHint(this.state.paused));
			head.insertBefore(paused, actions);
			if (this.options.onResume) {
				const resume = append(actions, $('button.volt-agent-queue-text-btn.primary')) as HTMLButtonElement;
				resume.type = 'button';
				resume.textContent = localize('voltAgent.queue.resume', "Resume");
				setAgentTooltip(resume, localize('voltAgent.work.resumeHint', "Send the subagents' reports to the agent"));
				this.listeners.add(addDisposableListener(resume, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.options.onResume?.();
				}));
			}
		}
		if (live.some(view => view.cancellable) && this.options.onStopAllAgents) {
			const stop = append(actions, $('button.volt-agent-queue-text-btn')) as HTMLButtonElement;
			stop.type = 'button';
			stop.textContent = localize('voltAgent.work.stopAll', "Stop all");
			setAgentTooltip(stop, localize('voltAgent.work.stopAllHint', "Stop every running subagent of this chat"));
			this.listeners.add(addDisposableListener(stop, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onStopAllAgents?.();
			}));
		}
		if (this.agentsCollapsed) {
			return;
		}
		const list = append(section, $('.volt-agent-work-agents'));
		const now = Date.now();
		for (const view of views) {
			renderCursorCardRow(list, view, {
				store: this.listeners,
				now,
				tooltip: this.agentTooltip,
				onOpen: this.options.onOpenAgent,
				onStop: this.options.onStopAgent,
			});
		}
		for (const conflict of this.agents.conflicts) {
			const line = append(section, $('.volt-agent-work-conflict'));
			line.appendChild(renderIcon(Codicon.warning));
			append(line, $('span')).textContent = localize('voltAgent.work.conflict', "{0} is being changed by {1} at once", conflict.path.split(/[\\/]/).pop() ?? conflict.path, conflict.titles.join(', '));
			setAgentTooltip(line, conflict.path);
		}
		tickSubagentClocks(list, this.clockStore);
	}

	private renderQueue(card: HTMLElement): void {
		const count = this.items.length;
		const editing = this.state.editingId !== undefined && this.items.some(item => item.id === this.state.editingId);
		this.queueEl.classList.toggle('paused', !!this.state.paused && !editing);
		this.queueEl.classList.toggle('editing', editing);
		const head = append(card, $('.volt-agent-queue-head'));
		const title = append(head, $('button.volt-agent-work-toggle.volt-agent-queue-title')) as HTMLButtonElement;
		title.type = 'button';
		title.setAttribute('aria-expanded', String(!this.queueCollapsed || editing));
		title.appendChild(renderIcon(this.queueCollapsed && !editing ? Codicon.chevronRight : Codicon.chevronDown));
		append(title, $('span')).textContent = editing
			? localize('voltAgent.queue.editingTitle', "Editing queued message")
			: count === 1 ? localize('voltAgent.queuedOne', "1 Queued Message") : localize('voltAgent.queuedCountN', "{0} Queued", count);
		this.listeners.add(addDisposableListener(title, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.queueCollapsed = !this.queueCollapsed;
			this.render();
		}));
		if (!editing && this.state.paused) {
			const paused = append(head, $('span.volt-agent-queue-paused'));
			paused.textContent = queuePauseLabel(this.state.paused);
			setAgentTooltip(paused, queuePauseHint(this.state.paused));
		}

		const actions = append(head, $('.volt-agent-queue-head-actions'));
		if (editing) {
			const cancel = append(actions, $('button.volt-agent-queue-text-btn')) as HTMLButtonElement;
			cancel.type = 'button';
			cancel.textContent = localize('voltAgent.queue.cancelEdit', "Cancel");
			this.listeners.add(addDisposableListener(cancel, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onCancelEdit?.();
			}));
		} else if (this.state.paused && !this.state.running && this.options.onResume) {
			const resume = append(actions, $('button.volt-agent-queue-text-btn.primary')) as HTMLButtonElement;
			resume.type = 'button';
			resume.textContent = localize('voltAgent.queue.resume', "Resume");
			setAgentTooltip(resume, localize('voltAgent.queue.resumeHint', "Send the next queued prompt"));
			this.listeners.add(addDisposableListener(resume, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onResume?.();
			}));
		}
		if (!editing && this.mode !== 'Multitask') {
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

		if (this.queueCollapsed && !editing) {
			return;
		}
		const list = append(card, $('.volt-agent-queue-list'));
		const sendNow = queueSendNowLabels(this.state);
		for (const item of this.items) {
			const row = append(list, $('.volt-agent-queue-item'));
			row.dataset.queueId = item.id;
			const isEditing = item.id === this.state.editingId;
			row.classList.toggle('editing', isEditing);
			// Cursor marks a queued message with a circle; it turns into the drag grip on hover.
			append(row, $('span.volt-agent-queue-circle'));
			const grip = append(row, createGripIcon());
			setAgentTooltip(grip, localize('voltAgent.reorderQueue', "Drag to reorder"));
			const text = append(row, $('span.volt-agent-queue-text'));
			const preview = (item.preview ?? item.text).trim().replace(/\s+/g, ' ');
			text.textContent = preview;
			setAgentTooltip(text, preview);
			const onEdit = this.options.onEdit;
			const onSendNow = this.options.onSendNow;
			if (!isEditing && onEdit) {
				this.appendRowAction(row, Codicon.edit, localize('voltAgent.queue.edit', "Edit queued message"), () => onEdit(item.id));
			}
			if (!isEditing && onSendNow) {
				this.appendRowAction(row, Codicon.arrowUp, sendNow.tooltip, () => onSendNow(item.id), 'send-now', sendNow.label);
			}
			this.appendRowAction(row, Codicon.trash, localize('voltAgent.removeQueued', "Remove from queue"), () => this.options.onRemove(item.id));
			this.listeners.add(addDisposableListener(grip, 'pointerdown', e => {
				if (e.button !== 0 || this.items.length < 2) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.beginDrag(e, list, row, grip);
			}));
		}
	}

	private appendRowAction(row: HTMLElement, icon: ThemeIcon, tooltip: string, run: () => void, extraClass?: string, ariaLabel?: string): void {
		const button = append(row, $(extraClass ? `button.volt-agent-queue-remove.${extraClass}` : 'button.volt-agent-queue-remove')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', ariaLabel ?? tooltip);
		setAgentTooltip(button, tooltip);
		button.appendChild(renderIcon(icon));
		this.listeners.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
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
