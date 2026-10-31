/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AgentTooltip, bindTruncatedHoverTooltip, setAgentTooltip } from '../chrome/agentTooltip.js';
import { groupSummary, isLiveSubagentState, ISubagentView, renderCursorCardRow, tickSubagentClocks } from '../chrome/agentSubagents.js';
import { ITasksCard } from '../chrome/agentTimeline.js';
import { AgentTasksCard, closeOnOutsideClick } from './agentTasksCard.js';
import { createQueueSendIcon } from '../home/agentHomeIcons.js';
import type { IAgentDisplayMention } from './agentMentions.js';

export interface IQueuedPrompt {
	id: string;
	text: string;
	preview?: string;
	/** The model a multitask agent for this message runs with; undefined is the chat's default. */
	modelRef?: string;
	modelLabel?: string;
}

export interface IAgentComposerQueueOptions {
	onRemove(id: string): void;
	onClear(): void;
	onMultitask(): void;
	/**
	 * With this, Start Multitasking is a toggle: on, every queued message gets a checkbox (all ticked)
	 * and this hears the ticked ids on every change; the host starts them on Send. Undefined when it
	 * turns off. Without it, Start Multitasking starts the whole queue at once (`onMultitask`).
	 */
	onMultitaskPick?(ids: readonly string[] | undefined): void;
	/** Configure: the picked row's model, chosen from a menu anchored on its trigger. */
	onPickModel?(id: string, anchor: HTMLElement): void;
	onReorder(ids: readonly string[]): void;
	/** Load a queued prompt into the composer to change it (Cursor's "Edit queued message"). */
	onEdit?(id: string): void;
	/** Send this prompt now: steer the running agent, interrupt it, or just send when idle. */
	onSendNow?(id: string): void;
	/** Send this prompt in a new chat, whose agent starts with this chat's conversation as a condensed handoff. */
	onSendToNewChat?(id: string): void;
	/** The queue was paused by an error or left idle: send the next prompt and keep draining. */
	onResume?(): void;
	onCancelEdit?(): void;
	/** A subagent row was clicked: open its chat beside this one. */
	onOpenAgent?(view: ISubagentView): void;
	onStopAgent?(view: ISubagentView): void;
	/** Resume on a failed or stopped agent: it continues where it ended. */
	onResumeAgent?(view: ISubagentView): void;
	/** Stop every running subagent of this chat. */
	onStopAllAgents?(): void;
	/** A conflicting file's name was clicked: open it. */
	onOpenFile?(path: string): void;
}

export interface IAgentQueueEditContent {
	readonly text: string;
	readonly mentions: IAgentDisplayMention[];
}

/** A composer other than the chat's own that a queued prompt can be edited in (the browser dock's). */
export interface IAgentQueueEditSurface {
	content(): IAgentQueueEditContent;
	setContent(text: string, mentions: readonly IAgentDisplayMention[] | undefined): void;
	focus(): void;
}

/** The chat a queue card acts on (its editor). */
export interface IAgentQueueHost {
	removeQueuedPrompt(id: string): void;
	clearPromptQueue(): void;
	reorderQueuedPrompts(ids: readonly string[]): void;
	editQueuedPrompt(id: string, surface?: IAgentQueueEditSurface): void;
	cancelQueueEdit(): void;
	sendQueuedNow(id: string): void;
	sendQueuedToNewChat(id: string): void;
	resumeQueue(): void;
}

/**
 * What a queued row does, the same in the chat's card and in the browser dock's: remove, clear,
 * reorder, edit (in `surface`, else the chat's composer), send now, send in a new chat, resume.
 */
export function queueRowActions(host: () => IAgentQueueHost | undefined, surface?: IAgentQueueEditSurface): Pick<IAgentComposerQueueOptions, 'onRemove' | 'onClear' | 'onReorder' | 'onEdit' | 'onCancelEdit' | 'onSendNow' | 'onSendToNewChat' | 'onResume'> {
	return {
		onRemove: id => host()?.removeQueuedPrompt(id),
		onClear: () => host()?.clearPromptQueue(),
		onReorder: ids => host()?.reorderQueuedPrompts(ids),
		onEdit: id => host()?.editQueuedPrompt(id, surface),
		onCancelEdit: () => host()?.cancelQueueEdit(),
		onSendNow: id => host()?.sendQueuedNow(id),
		onSendToNewChat: id => host()?.sendQueuedToNewChat(id),
		onResume: () => host()?.resumeQueue(),
	};
}

/** Subagents shown in the card, with the conflicts between them. */
export interface IAgentComposerAgents {
	readonly views: readonly ISubagentView[];
	readonly conflicts: readonly { readonly path: string; readonly titles: readonly string[]; readonly taskIds?: readonly string[] }[];
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
		case 'failed': return localize('voltAgent.queue.pausedErrorHint', "The last run failed, so queued prompts wait instead of going to the same provider right away. Resume sends them now.");
		case 'interrupted': return localize('voltAgent.queue.pausedRestartHint', "Volt restarted while this chat worked. Resume continues now.");
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

	/** Queued prompts (and, in the browser's dock, the to-dos): the stack right above the input. */
	readonly element: HTMLElement;
	/**
	 * "N subagents running": its own card, drawn like the Tasks card. The chat puts it over the
	 * chip row, under its Tasks card; nothing shows it where it is never placed (the dock).
	 */
	readonly agentsElement: HTMLElement;

	private readonly queueEl: HTMLElement;
	/** The agent's to-dos, last in the stack so it tucks under the input box. */
	private readonly tasksCard: AgentTasksCard;
	private readonly listeners = this._register(new DisposableStore());
	private readonly dragListeners = this._register(new DisposableStore());
	private items: IQueuedPrompt[] = [];
	private agents: IAgentComposerAgents = { views: [], conflicts: [] };
	private agentsSignature = '';
	/** The side toolbar beside the chat is open and lists the agents: the card leaves them out. */
	private agentsInDock = false;
	/** Cursor: "N subagents running" starts as its header alone; the chevron opens the rows. */
	private agentsCollapsed = true;
	private queueCollapsed = false;
	private readonly agentTooltip = this._register(new AgentTooltip());
	private readonly clockStore = this._register(new DisposableStore());
	private state: IAgentComposerQueueState = { running: false, steer: false };
	private mode = 'Agent';
	/** Start Multitasking is on: the rows are checkboxes; `unpicked` holds the ones unticked. */
	private picking = false;
	private readonly unpicked = new Set<string>();
	/** Configure is on while multitasking: each picked row shows its model trigger. */
	private configuring = false;
	/** True while a row is being dragged; re-renders are deferred until the drop lands. */
	private dragging = false;
	private renderPending = false;

	constructor(
		private readonly options: IAgentComposerQueueOptions,
	) {
		super();
		this.agentsElement = $('.volt-agent-agents-card.hidden');
		this.element = $('.volt-agent-composer-stack');
		this.queueEl = append(this.element, $('.volt-agent-queue-card.hidden'));
		this.tasksCard = this._register(new AgentTasksCard(() => this.syncStackClass()));
		append(this.element, this.tasksCard.element);
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
		// A different queue (another chat in this editor) never inherits the ticks.
		const fresh = this.items.length > 0 && !items.some(item => this.items.some(current => current.id === item.id));
		this.items = items.slice();
		if (this.picking && fresh) {
			this.picking = false;
			this.unpicked.clear();
			this.emitPick();
		} else if (this.picking) {
			const ids = new Set(this.items.map(item => item.id));
			for (const id of [...this.unpicked]) {
				if (!ids.has(id)) {
					this.unpicked.delete(id);
				}
			}
			// Nothing left to pick (the queue drained or was cleared): multitasking turns off.
			this.picking = this.items.length > 0;
			this.emitPick();
		}
		this.render();
	}

	/** Turns Start Multitasking off (the picked messages were sent, or the host dropped them). */
	stopPicking(): void {
		if (!this.picking) {
			return;
		}
		this.picking = false;
		this.configuring = false;
		this.unpicked.clear();
		this.emitPick();
		this.render();
	}

	private pickedIds(): string[] {
		return this.items.filter(item => !this.unpicked.has(item.id)).map(item => item.id);
	}

	private emitPick(): void {
		this.options.onMultitaskPick?.(this.picking ? this.pickedIds() : undefined);
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
			return current.id === item.id && current.text === item.text && current.preview === item.preview && current.modelRef === item.modelRef && current.modelLabel === item.modelLabel;
		});
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
		this.agentsElement.replaceChildren();
		const count = this.items.length;
		// The agents live in the composer's chip (its menu lists them and their file conflicts); the card
		// keeps them only while their reports wait for Resume.
		const agents = this.state.paused ? this.shownAgents().length : 0;
		this.queueEl.classList.toggle('hidden', count === 0);
		this.agentsElement.classList.toggle('hidden', agents === 0);
		this.agentsElement.classList.toggle('expanded', !this.agentsCollapsed);
		this.syncStackClass();
		this.queueEl.classList.toggle('paused', false);
		this.queueEl.classList.toggle('editing', false);
		if (agents) {
			this.renderAgents(append(this.agentsElement, $('.volt-agent-work-section.agents')));
		}
		if (count) {
			this.renderQueue(append(this.queueEl, $('.volt-agent-work-section.queue')));
		}
	}

	private syncStackClass(): void {
		this.element.classList.toggle('has-stack', this.items.length > 0 || this.tasksCard.visible);
		this.element.classList.toggle('has-tasks', this.tasksCard.visible);
	}

	/**
	 * With the side toolbar open beside the chat, its agents list (and the composer's agents chip)
	 * show this chat's agents: the card keeps them only while their reports wait for Resume.
	 */
	private shownAgents(): readonly ISubagentView[] {
		if (!this.agentsInDock) {
			return this.agents.views;
		}
		return this.state.paused ? this.agents.views.filter(view => isLiveSubagentState(view.state)) : [];
	}

	private renderAgents(section: HTMLElement): void {
		const views = this.shownAgents();
		const live = views.filter(view => isLiveSubagentState(view.state));
		const head = append(section, $('.volt-agent-work-head'));
		const toggle = append(head, $('button.volt-agent-work-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!this.agentsCollapsed));
		toggle.appendChild(renderIcon(this.agentsCollapsed ? Codicon.chevronRight : Codicon.chevronDown));
		let heading: string;
		if (!views.length) {
			// Only conflicts: the agents themselves are in the side toolbar.
			heading = localize('voltAgent.work.conflictsOnly', "Agents editing the same files");
		} else if (live.length) {
			heading = live.length === 1 ? localize('voltAgent.work.oneRunning', "1 subagent running") : localize('voltAgent.work.manyRunning', "{0} subagents running", live.length);
		} else {
			heading = views.length === 1 ? localize('voltAgent.work.one', "1 subagent") : localize('voltAgent.work.many', "{0} subagents", views.length);
		}
		append(toggle, $('span')).textContent = heading;
		const finished = views.length - live.length;
		if (finished && live.length) {
			const summary = append(head, $('span.volt-agent-work-summary'));
			summary.textContent = groupSummary(views.filter(view => !isLiveSubagentState(view.state)));
			setAgentTooltip(summary, summary.textContent);
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
		this.listeners.add(closeOnOutsideClick(this.agentsElement, () => {
			this.agentsCollapsed = true;
			this.render();
		}));
		const list = append(section, $('.volt-agent-work-agents'));
		const now = Date.now();
		for (const view of views) {
			renderCursorCardRow(list, view, {
				store: this.listeners,
				now,
				tooltip: this.agentTooltip,
				onOpen: this.options.onOpenAgent,
				onStop: this.options.onStopAgent,
				onResume: this.options.onResumeAgent,
			});
		}
		for (const conflict of this.agents.conflicts) {
			this.renderConflict(section, conflict);
		}
		tickSubagentClocks(list, this.clockStore);
	}

	/**
	 * Two live agents in one checkout both changed a file, so one can overwrite the other. The file
	 * name opens the file; each agent's name opens its chat.
	 */
	private renderConflict(section: HTMLElement, conflict: IAgentComposerAgents['conflicts'][number]): void {
		const line = append(section, $('.volt-agent-work-conflict'));
		line.appendChild(renderIcon(Codicon.warning));
		const name = conflict.path.split(/[\\/]/).pop() || conflict.path;
		const file = append(line, $('button.volt-agent-work-conflict-file')) as HTMLButtonElement;
		file.type = 'button';
		file.textContent = name;
		setAgentTooltip(file, localize('voltAgent.work.conflictOpen', "Open {0}", conflict.path));
		this.listeners.add(addDisposableListener(file, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onOpenFile?.(conflict.path);
		}));
		append(line, $('span.volt-agent-work-conflict-text')).textContent = localize('voltAgent.work.conflictBy', "edited by {0} agents at once:", conflict.titles.length);
		const agents = append(line, $('span.volt-agent-work-conflict-agents'));
		conflict.titles.forEach((title, index) => {
			const view = this.agents.views.find(candidate => candidate.key === conflict.taskIds?.[index]);
			// allow-any-unicode-next-line
			const short = title.split(/\s+[—–-]\s+|:\s/)[0].trim() || title;
			if (view?.openable && this.options.onOpenAgent) {
				const link = append(agents, $('button.volt-agent-work-conflict-agent')) as HTMLButtonElement;
				link.type = 'button';
				link.textContent = short;
				setAgentTooltip(link, localize('voltAgent.work.conflictOpenAgent', "Open {0}", title));
				this.listeners.add(addDisposableListener(link, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.options.onOpenAgent?.(view);
				}));
			} else {
				const plain = append(agents, $('span.volt-agent-work-conflict-agent'));
				plain.textContent = short;
				setAgentTooltip(plain, title);
			}
		});
		setAgentTooltip(line, localize('voltAgent.work.conflictHint', "{0}\nThese agents share one checkout and both changed this file, so one can overwrite the other's edits. Check it when they finish, or run them in worktrees.", conflict.path));
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
		const picking = this.picking && !editing;
		this.queueEl.classList.toggle('picking', picking);
		append(title, $('span')).textContent = editing
			? localize('voltAgent.queue.editingTitle', "Editing queued message")
			: picking
				? localize('voltAgent.queue.pickedOf', "{0} of {1} Selected", this.pickedIds().length, count)
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
		if (!editing) {
			if (picking && this.options.onPickModel) {
				const configure = append(actions, $('button.volt-agent-queue-text-btn')) as HTMLButtonElement;
				configure.type = 'button';
				configure.textContent = localize('voltAgent.queue.configure', "Configure");
				configure.classList.toggle('active', this.configuring);
				configure.setAttribute('aria-pressed', String(this.configuring));
				setAgentTooltip(configure, localize('voltAgent.queue.configureHint', "Choose the model each picked message runs with"));
				this.listeners.add(addDisposableListener(configure, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.configuring = !this.configuring;
					this.render();
				}));
			}
			const multi = append(actions, $('button.volt-agent-queue-multitask')) as HTMLButtonElement;
			multi.type = 'button';
			multi.textContent = localize('voltAgent.startMultitasking', "Start Multitasking");
			if (this.options.onMultitaskPick) {
				// A toggle: on, the rows become checkboxes and Send starts the ticked ones, each as its own agent.
				multi.classList.toggle('active', picking);
				multi.setAttribute('aria-pressed', String(picking));
				setAgentTooltip(multi, picking
					? localize('voltAgent.startMultitaskingOff', "Turn off to keep these messages queued")
					: localize('voltAgent.startMultitaskingPickHint', "Pick queued messages to run in parallel, each as its own agent, then press Send"));
				this.listeners.add(addDisposableListener(multi, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.picking = !this.picking;
					this.configuring = false;
					this.unpicked.clear();
					this.queueCollapsed = false;
					this.emitPick();
					this.render();
				}));
			} else {
				// Every queued message starts now, each as its own agent beside this chat.
				setAgentTooltip(multi, localize('voltAgent.startMultitaskingHint', "Send every queued message now, each to its own agent running in parallel"));
				this.listeners.add(addDisposableListener(multi, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.options.onMultitask();
				}));
			}
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
			let grip: HTMLElement | undefined;
			if (picking) {
				// Multitasking: a checkbox (ticked unless the user unticked it), and the row toggles it. No reordering.
				const picked = !this.unpicked.has(item.id);
				row.classList.add('pickable');
				row.classList.toggle('picked', picked);
				row.setAttribute('role', 'checkbox');
				row.setAttribute('aria-checked', String(picked));
				row.tabIndex = 0;
				const check = append(row, $('span.volt-agent-queue-check'));
				check.appendChild(renderIcon(Codicon.check));
				const toggle = () => {
					if (this.unpicked.has(item.id)) {
						this.unpicked.delete(item.id);
					} else {
						this.unpicked.add(item.id);
					}
					this.emitPick();
					this.render();
				};
				this.listeners.add(addDisposableListener(row, 'click', e => {
					e.preventDefault();
					toggle();
				}));
				this.listeners.add(addDisposableListener(row, 'keydown', e => {
					if (e.key === ' ' || e.key === 'Enter') {
						e.preventDefault();
						toggle();
					}
				}));
			} else {
				// Cursor marks a queued message with a circle; it turns into the drag grip on hover.
				append(row, $('span.volt-agent-queue-circle'));
				grip = append(row, createGripIcon());
				setAgentTooltip(grip, localize('voltAgent.reorderQueue', "Drag to reorder"));
			}
			const text = append(row, $('span.volt-agent-queue-text'));
			const preview = (item.preview ?? item.text).trim().replace(/\s+/g, ' ');
			text.textContent = preview;
			this.listeners.add(bindTruncatedHoverTooltip(text, preview));
			const pickModel = this.options.onPickModel;
			if (picking && this.configuring && pickModel && !this.unpicked.has(item.id)) {
				const model = append(row, $('button.volt-agent-queue-model')) as HTMLButtonElement;
				model.type = 'button';
				model.textContent = item.modelLabel ?? localize('voltAgent.queue.defaultModel', "Default model");
				setAgentTooltip(model, localize('voltAgent.queue.modelHint', "The model this message's agent runs with"));
				this.listeners.add(addDisposableListener(model, 'keydown', e => e.stopPropagation()));
				this.listeners.add(addDisposableListener(model, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					pickModel(item.id, model);
				}));
			}
			const onEdit = this.options.onEdit;
			const onSendNow = this.options.onSendNow;
			const onSendToNewChat = this.options.onSendToNewChat;
			if (!isEditing && onEdit) {
				this.appendRowAction(row, Codicon.edit, localize('voltAgent.queue.edit', "Edit queued message"), () => onEdit(item.id));
			}
			if (!isEditing && !picking && onSendToNewChat) {
				this.appendRowAction(row, createQueueSendIcon(), localize('voltAgent.queue.newChatHint', "Send in a new chat, with this conversation handed over condensed"), () => onSendToNewChat(item.id), 'new-chat', localize('voltAgent.queue.newChat', "Send in new chat"));
			}
			if (!isEditing && onSendNow) {
				this.appendRowAction(row, Codicon.arrowUp, sendNow.tooltip, () => onSendNow(item.id), 'send-now', sendNow.label);
			}
			this.appendRowAction(row, Codicon.trash, localize('voltAgent.removeQueued', "Remove from queue"), () => this.options.onRemove(item.id));
			if (!grip) {
				continue;
			}
			const dragGrip = grip;
			this.listeners.add(addDisposableListener(dragGrip, 'pointerdown', e => {
				if (e.button !== 0 || this.items.length < 2) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.beginDrag(e, list, row, dragGrip);
			}));
		}
	}

	private appendRowAction(row: HTMLElement, icon: ThemeIcon | HTMLElement, tooltip: string, run: () => void, extraClass?: string, ariaLabel?: string): void {
		const button = append(row, $(extraClass ? `button.volt-agent-queue-remove.${extraClass}` : 'button.volt-agent-queue-remove')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', ariaLabel ?? tooltip);
		setAgentTooltip(button, tooltip);
		// An element first: `ThemeIcon.isThemeIcon` takes any object with a string `id`, and every element has one.
		button.appendChild(isHTMLElement(icon) ? icon : renderIcon(icon));
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
}
