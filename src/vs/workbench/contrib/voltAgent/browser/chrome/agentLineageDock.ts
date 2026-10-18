/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { formatElapsed, lineage, OrchThreadStatusKind } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { IAgentSubagentChatService } from '../orchestration/agentSubagentChats.js';
import { openAgentPanel } from '../workspace/agentPanels.js';
import { isLiveSubagentState, isResumableSubagent, ISubagentCounts, resumeSubagentTask, ISubagentView, subagentCounts, subagentHoverRows, subagentStateMark, subagentView, tickSubagentClocks } from './agentSubagents.js';
import { AgentTooltip } from './agentTooltip.js';

const ROW_HEIGHT = 26;
/** Room under the dock's last row, inside the row so its hover reaches the card edge. */
const LAST_ROW_PADDING = 5;
/** Live agents shown per group before "Show N more". */
const RUNNING_VISIBLE = 6;
const PREVIOUS_VISIBLE = 8;

interface ILineageRow {
	readonly view: ISubagentView;
	/** The parent of a subagent's chat: drawn with an up arrow, opens in the main panel. */
	readonly parent?: boolean;
	readonly last?: boolean;
}

class LineageDelegate implements IListVirtualDelegate<ILineageRow> {
	getHeight(row: ILineageRow): number {
		return row.last ? ROW_HEIGHT + LAST_ROW_PADDING : ROW_HEIGHT;
	}
	getTemplateId(): string {
		return LineageRenderer.TEMPLATE_ID;
	}
}

interface ILineageTemplate {
	readonly avatar: HTMLElement;
	readonly title: HTMLElement;
	readonly clock: HTMLElement;
	readonly state: HTMLElement;
	readonly stop: HTMLElement;
	readonly resume: HTMLElement;
	readonly row: HTMLElement;
	readonly store: DisposableStore;
}

class LineageRenderer implements IListRenderer<ILineageRow, ILineageTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentLineage';
	readonly templateId = LineageRenderer.TEMPLATE_ID;

	constructor(
		private readonly tooltip: AgentTooltip,
		private readonly onStop: (view: ISubagentView) => void,
		private readonly onOpen: (row: ILineageRow) => void,
		private readonly onResume: (view: ISubagentView) => void,
	) { }

	renderTemplate(container: HTMLElement): ILineageTemplate {
		container.classList.add('volt-agent-lineage-row');
		const avatar = append(container, $('span.volt-agent-lineage-avatar'));
		const title = append(container, $('span.volt-agent-lineage-title'));
		const clock = append(container, $('span.volt-subagent-clock'));
		const state = append(container, $('span.volt-agent-lineage-state'));
		// A span, not a button: the row is the list's. Shown on hover (agentSubagents.css).
		const stop = append(container, $('span.volt-agent-lineage-stop'));
		stop.setAttribute('role', 'button');
		stop.appendChild(renderIcon(Codicon.debugStop));
		// Resume on a failed or stopped agent, in the same place on hover.
		const resume = append(container, $('span.volt-agent-lineage-stop.volt-agent-lineage-resume'));
		resume.setAttribute('role', 'button');
		resume.appendChild(renderIcon(Codicon.play));
		return { avatar, title, clock, state, stop, resume, row: container, store: new DisposableStore() };
	}

	renderElement(element: ILineageRow, _index: number, template: ILineageTemplate): void {
		template.store.clear();
		const view = element.view;
		template.avatar.replaceChildren();
		if (element.parent) {
			template.avatar.appendChild(renderIcon(Codicon.arrowUp));
			append(template.avatar, $(`span.volt-agent-lineage-dot.state-${view.state}`));
		} else if (view.providerId) {
			// The agent's harness mark with a small state dot (pulsing while it works).
			template.avatar.appendChild(createBrandIcon(view.providerId, 14));
			append(template.avatar, $(`span.volt-agent-lineage-dot.state-${view.state}`));
		} else {
			// No known harness: Cursor's mark, dots that pulse while it works.
			template.avatar.appendChild(subagentStateMark(template.avatar, view));
		}
		template.avatar.className = `volt-agent-lineage-avatar state-${view.state}${element.parent ? ' parent' : ''}`;
		template.row.classList.toggle('multitask', !!view.multitask);
		template.row.classList.toggle('read-only', !!view.readOnly);
		template.title.textContent = view.title;
		// A running agent's clock says enough; anything else names its state.
		template.state.textContent = view.state === 'running' && !element.parent ? '' : view.stateLabel;
		template.state.className = `volt-agent-lineage-state state-${view.state}`;
		delete template.clock.dataset.startedAt;
		delete template.clock.dataset.endedAt;
		if (view.startedAt !== undefined && !element.parent) {
			template.clock.dataset.startedAt = String(view.startedAt);
			if (view.endedAt !== undefined) {
				template.clock.dataset.endedAt = String(view.endedAt);
			}
			template.clock.textContent = formatElapsed((view.endedAt ?? Date.now()) - view.startedAt);
		} else {
			template.clock.textContent = '';
		}
		const stoppable = !element.parent && isLiveSubagentState(view.state) && (view.cancellable || !!view.stopsTurn);
		template.row.classList.toggle('stoppable', stoppable);
		if (stoppable) {
			const label = view.stopsTurn
				? localize('voltAgent.lineage.stopTurn', "Stop (stops the agent turn that runs it)")
				: localize('voltAgent.lineage.stop', "Stop {0}", view.title);
			template.stop.setAttribute('aria-label', label);
			// The list opens a row on pointer events: the stop keeps them to itself.
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
				template.store.add(addDisposableListener(template.stop, type, e => EventHelper.stop(e, true)));
			}
			template.store.add(addDisposableListener(template.stop, 'click', e => {
				EventHelper.stop(e, true);
				this.onStop(view);
			}));
		}
		const resumable = !element.parent && isResumableSubagent(view);
		template.row.classList.toggle('resumable', resumable);
		if (resumable) {
			template.resume.setAttribute('aria-label', localize('voltAgent.lineage.resume', "Resume {0}", view.title));
			template.resume.title = localize('voltAgent.lineage.resumeHint', "Resume: it continues where it stopped");
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
				template.store.add(addDisposableListener(template.resume, type, e => EventHelper.stop(e, true)));
			}
			template.store.add(addDisposableListener(template.resume, 'click', e => {
				EventHelper.stop(e, true);
				this.onResume(view);
			}));
		}
		// A click on the card opens the agent, like the row. Shown at once, and it follows the pointer from row to row.
		template.store.add(this.tooltip.bind(template.row, () => subagentHoverRows(view, Date.now()), { placement: 'start', variant: 'card', onClick: () => this.onOpen(element) }));
	}

	disposeTemplate(template: ILineageTemplate): void {
		template.store.dispose();
	}
}

/**
 * One group of the dock: an optional heading (a label, or a pane header that folds), a list, and "Show N more".
 */
class LineageGroup extends Disposable {

	readonly head: HTMLElement | undefined;
	private readonly host: HTMLElement;
	private readonly more: HTMLButtonElement;
	private readonly list: WorkbenchList<ILineageRow>;
	private showAll = false;
	private open: boolean;

	constructor(
		parent: HTMLElement,
		private readonly options: {
			readonly id: string;
			readonly ariaLabel: string;
			readonly head: 'heading' | 'divider' | 'none';
			readonly open: boolean;
			readonly visible: number;
			readonly className?: string;
			readonly onOpen: (row: ILineageRow) => void;
			readonly onChange: () => void;
		},
		renderer: LineageRenderer,
		instantiationService: IInstantiationService,
	) {
		super();
		this.open = options.open;
		if (options.head === 'heading') {
			this.head = append(parent, $('.volt-agent-dock-heading.volt-agent-lineage-head'));
		} else if (options.head === 'divider') {
			const divider = append(parent, $('button.volt-agent-lineage-divider')) as HTMLButtonElement;
			divider.type = 'button';
			this._register(addDisposableListener(divider, 'click', () => {
				this.open = !this.open;
				this.options.onChange();
			}));
			this.head = divider;
		}
		if (this.head && options.className) {
			this.head.classList.add(options.className);
		}
		this.host = append(parent, $('.volt-agent-lineage-list'));
		if (options.className) {
			this.host.classList.add(options.className);
		}
		this.more = append(parent, $('button.volt-agent-dock-row.volt-agent-lineage-more')) as HTMLButtonElement;
		this.more.type = 'button';
		this.more.style.display = 'none';
		this._register(addDisposableListener(this.more, 'click', () => {
			this.showAll = !this.showAll;
			this.options.onChange();
		}));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<ILineageRow>, options.id, this.host, new LineageDelegate(), [renderer], {
			identityProvider: { getId: (row: ILineageRow) => `${row.parent ? 'p:' : ''}${row.view.key}` },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => options.ariaLabel,
				getAriaLabel: (row: ILineageRow) => `${row.view.title}, ${row.view.stateLabel}${row.view.multitask ? `, ${localize('voltAgent.lineage.multitaskAria', "multitask agent")}` : ''}`,
			},
		}));
		this._register(this.list.onDidOpen(e => e.element && this.options.onOpen(e.element)));
	}

	get listHost(): HTMLElement {
		return this.host;
	}

	/** The rows the group shows once folding and "Show N more" are applied. */
	shown(rows: readonly ILineageRow[]): ILineageRow[] {
		if (!this.isOpen()) {
			return [];
		}
		return this.showAll ? [...rows] : rows.slice(0, this.options.visible);
	}

	isOpen(): boolean {
		return this.options.head === 'heading' || this.options.head === 'none' || this.open;
	}

	/** What the user toggled (folded, "Show N more"): part of the dock's redraw signature. */
	viewState(): string {
		return `${this.isOpen()}:${this.showAll}`;
	}

	resetShowAll(): void {
		this.showAll = false;
	}

	/** `title` undefined hides the heading; no rows hides the group. */
	render(title: string | undefined, rows: readonly ILineageRow[], shown: readonly ILineageRow[]): void {
		const visible = rows.length > 0;
		if (this.head) {
			this.head.style.display = visible && title !== undefined ? '' : 'none';
			this.head.replaceChildren();
			if (this.options.head === 'divider') {
				this.head.setAttribute('aria-expanded', String(this.open));
				// A VS Code pane header: chevron, then the title.
				this.head.appendChild(renderIcon(this.open ? Codicon.chevronDown : Codicon.chevronRight));
				append(this.head, $('span.label')).textContent = title ?? '';
			} else {
				append(this.head, $('span')).textContent = title ?? '';
			}
		}
		const height = shown.reduce((sum, row) => sum + (row.last ? ROW_HEIGHT + LAST_ROW_PADDING : ROW_HEIGHT), 0);
		this.host.style.height = `${height}px`;
		this.host.style.display = height ? '' : 'none';
		this.list.layout(height);
		this.list.splice(0, this.list.length, [...shown]);
		const hidden = this.isOpen() ? rows.length - Math.min(rows.length, this.options.visible) : 0;
		const showMore = hidden > 0;
		this.more.style.display = showMore ? '' : 'none';
		if (showMore) {
			this.more.replaceChildren(renderIcon(this.showAll ? Codicon.remove : Codicon.add));
			append(this.more, $('span')).textContent = this.showAll
				? localize('voltAgent.lineage.less', "Show less")
				: localize('voltAgent.lineage.more', "Show {0} more", hidden);
		}
	}
}

/**
 * Every agent under the chat on screen, at the top of the chat's side toolbar: its parent (in a
 * subagent's chat), "Multitasks · N running" (work the user asked to run in parallel; their chats
 * take follow-ups), "Subagents · N running" (agents' own helpers, Volt's or the harness's; watched,
 * not driven) and "Needs attention (N)" (waiting for an approval or an answer). "Previous agents
 * (N)", folded, is its own section at the bottom of the toolbar (`previousElement`): finished work
 * stays out of the way of the tools. A row opens that agent in this chat's right panel; hovering a
 * live one offers Stop.
 */
export class AgentLineageDock extends Disposable {

	readonly element: HTMLElement;
	/** "Previous agents (N)": mounted at the bottom of the toolbar, below the tools and git. */
	readonly previousElement: HTMLElement;
	private readonly parentGroup: LineageGroup;
	private readonly multitaskGroup: LineageGroup;
	private readonly subagentGroup: LineageGroup;
	private readonly attentionGroup: LineageGroup;
	private readonly previousGroup: LineageGroup;
	private readonly tooltip = this._register(new AgentTooltip());
	private readonly clocks = this._register(new MutableDisposable<DisposableStore>());
	private sessionId: string | undefined;
	private signature = '';
	private summary: ISubagentCounts = { multitask: 0, subagents: 0, waiting: 0, queued: 0 };

	private readonly _onDidChangeSummary = this._register(new Emitter<ISubagentCounts>());
	/** Live agents under the chat's tree changed: the collapsed toolbar's badge follows. */
	readonly onDidChangeSummary: Event<ISubagentCounts> = this._onDidChangeSummary.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IAgentSubagentChatService private readonly subagentChats: IAgentSubagentChatService,
	) {
		super();
		this.element = $('.volt-agent-dock-section.volt-agent-lineage.hidden');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('voltAgent.lineage.region', "Agents"));
		this.previousElement = $('.volt-agent-dock-section.volt-agent-lineage-previous.hidden');
		this.previousElement.setAttribute('role', 'region');
		this.previousElement.setAttribute('aria-label', localize('voltAgent.lineage.previousRegion', "Previous agents"));
		const renderer = new LineageRenderer(this.tooltip, view => this.stop(view), row => this.open(row), view => void resumeSubagentTask(this.orchestrator, view.key).catch(() => false));
		const group = (id: string, ariaLabel: string, head: 'heading' | 'divider' | 'none', open: boolean, visible: number, className?: string, parent = this.element) => this._register(new LineageGroup(parent, {
			id,
			ariaLabel,
			head,
			open,
			visible,
			...(className ? { className } : {}),
			onOpen: row => this.open(row),
			onChange: () => this.render(true),
		}, renderer, instantiationService));
		this.parentGroup = group('VoltAgentLineageParent', localize('voltAgent.lineage.parentList', "Parent chat"), 'none', true, 1, 'parent');
		this.multitaskGroup = group('VoltAgentLineageMultitasks', localize('voltAgent.lineage.multitasks', "Multitask agents"), 'divider', true, RUNNING_VISIBLE, 'multitasks');
		this.subagentGroup = group('VoltAgentLineageRunning', localize('voltAgent.lineage.running', "Running subagents"), 'divider', true, RUNNING_VISIBLE, 'subagents');
		this.attentionGroup = group('VoltAgentLineageAttention', localize('voltAgent.lineage.attention', "Agents that need attention"), 'divider', true, RUNNING_VISIBLE, 'attention');
		this.previousGroup = group('VoltAgentLineagePrevious', localize('voltAgent.lineage.previous', "Previous agents"), 'divider', false, PREVIOUS_VISIBLE, 'previous', this.previousElement);
		this._register(orchestrator.onDidChange(change => {
			if (!this.sessionId) {
				return;
			}
			const rootId = orchestrator.getThread(this.sessionId)?.rootId;
			if (change.threads.some(id => id === this.sessionId || orchestrator.getThread(id)?.rootId === rootId)) {
				this.render(false);
			}
		}));
	}

	/** Live agents under the chat on screen. */
	getSummary(): ISubagentCounts {
		return this.summary;
	}

	setSession(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) {
			return;
		}
		this.sessionId = sessionId;
		for (const group of [this.multitaskGroup, this.subagentGroup, this.attentionGroup, this.previousGroup]) {
			group.resetShowAll();
		}
		if (sessionId) {
			void this.orchestrator.ensureThreadLoaded(sessionId).then(() => this.render(true));
		}
		this.render(true);
	}

	private providerOf(modelRef: string | undefined): string | undefined {
		return modelRef ? this.runtime.listCatalog().find(item => item.ref === modelRef)?.providerId : undefined;
	}

	private render(force: boolean): void {
		const sessionId = this.sessionId;
		const view = sessionId ? lineage(this.orchestrator.getState(), sessionId) : undefined;
		const live = view?.running.map(row => subagentView(row, ref => this.providerOf(ref))) ?? [];
		// Agents blocked on an approval or a question get their own group: they wait on the user.
		const attention = live.filter(row => row.state === 'waiting').sort((a, b) => Number(!!b.multitask) - Number(!!a.multitask));
		const working = live.filter(row => row.state !== 'waiting');
		const multitasks = working.filter(row => row.multitask);
		const subagents = working.filter(row => !row.multitask);
		const previous = view?.previous.map(row => subagentView(row, ref => this.providerOf(ref))) ?? [];
		const parent = view?.parent;
		const signature = JSON.stringify([
			sessionId,
			[this.multitaskGroup, this.subagentGroup, this.attentionGroup, this.previousGroup].map(group => group.viewState()),
			parent?.status.kind, parent?.title,
			live.map(row => [row.key, row.state, row.stateLabel, row.title, row.startedAt, row.multitask, row.cancellable, row.stopsTurn, row.providerId]),
			previous.map(row => [row.key, row.state, row.endedAt, row.title]),
		]);
		if (!force && signature === this.signature) {
			return;
		}
		this.signature = signature;
		this.publishSummary(subagentCounts(live));
		const emptyTop = !parent && !live.length;
		this.element.classList.toggle('hidden', emptyTop);
		this.previousElement.classList.toggle('hidden', !previous.length);
		if (emptyTop && !previous.length) {
			return;
		}

		const parentRows: ILineageRow[] = parent && sessionId ? [{
			parent: true,
			view: {
				key: parent.threadId,
				title: parent.title ?? this.history.get(parent.threadId)?.title ?? localize('voltAgent.lineage.parent', "Parent chat"),
				state: statusState(parent.status.kind),
				stateLabel: statusLabel(parent.status.kind),
				openable: true,
				cancellable: false,
				source: 'volt',
			},
		}] : [];
		const groups: { readonly group: LineageGroup; readonly title: string | undefined; readonly rows: ILineageRow[] }[] = [
			{ group: this.parentGroup, title: undefined, rows: parentRows },
			{ group: this.multitaskGroup, title: groupTitle('multitask', multitasks), rows: multitasks.map(row => ({ view: row })) },
			{ group: this.subagentGroup, title: groupTitle('subagent', subagents), rows: subagents.map(row => ({ view: row })) },
			{ group: this.attentionGroup, title: localize('voltAgent.lineage.attentionTitle', "Needs attention ({0})", attention.length), rows: attention.map(row => ({ view: row })) },
			{ group: this.previousGroup, title: localize('voltAgent.lineage.previousTitle', "Previous agents ({0})", previous.length), rows: previous.map(row => ({ view: row })) },
		];
		const shown = groups.map(entry => entry.group.shown(entry.rows));
		// Previous agents end the card: its last row pads its own bottom, so its hover reaches the card
		// edge. A folded divider or "Show N more" under it ends the card instead.
		const previousIndex = groups.length - 1;
		const endsInRow = shown[previousIndex].length > 0 && shown[previousIndex].length === groups[previousIndex].rows.length;
		if (endsInRow) {
			const rows = shown[previousIndex];
			rows[rows.length - 1] = { ...rows[rows.length - 1], last: true };
		}
		groups.forEach((entry, index) => entry.group.render(entry.title, entry.rows, shown[index]));

		const clocks = new DisposableStore();
		this.clocks.value = clocks;
		for (const entry of groups) {
			tickSubagentClocks(entry.group.listHost, clocks);
		}
	}

	private publishSummary(summary: ISubagentCounts): void {
		const current = this.summary;
		if (current.multitask === summary.multitask && current.subagents === summary.subagents && current.waiting === summary.waiting && current.queued === summary.queued) {
			return;
		}
		this.summary = summary;
		this._onDidChangeSummary.fire(summary);
	}

	private open(row: ILineageRow): void {
		const sessionId = this.sessionId;
		if (!sessionId) {
			return;
		}
		if (row.parent) {
			void openAgentPanel(this.editorGroupsService, this.instantiationService, row.view.key);
			return;
		}
		// The agent opens as a tab in this chat's right panel and streams there as it works; a
		// harness's own subagent opens the read-only chat Volt keeps for it.
		void this.subagentChats.open(sessionId, row.view.key);
	}

	/** Stops at once: a Volt agent ends now (its run is cancelled); a harness's own ends with the turn that runs it. */
	private stop(view: ISubagentView): void {
		const task = this.orchestrator.getTask(view.key);
		if (!task) {
			return;
		}
		if (task.source === 'harness') {
			void this.orchestrator.cancel(task.parentId, { cascade: 'turn' });
			return;
		}
		void this.orchestrator.dispatch({ type: 'task.cancel', taskId: task.id, reason: 'The user stopped it.' });
	}
}

/** "Multitasks · 3 running", "Subagents · 1 running · 2 queued", "Multitasks · 2 queued". */
function groupTitle(kind: 'multitask' | 'subagent', views: readonly ISubagentView[]): string {
	const queued = views.filter(view => view.state === 'queued').length;
	const running = views.length - queued;
	const name = kind === 'multitask'
		? localize('voltAgent.lineage.multitaskHead', "Multitasks")
		: localize('voltAgent.lineage.subagentHead', "Subagents");
	const parts = [name];
	if (running || !queued) {
		parts.push(localize('voltAgent.lineage.runningCount', "{0} running", running));
	}
	if (queued) {
		parts.push(localize('voltAgent.lineage.queuedCount', "{0} queued", queued));
	}
	return parts.join(' · ');
}

function statusState(kind: OrchThreadStatusKind): ISubagentView['state'] {
	switch (kind) {
		case 'working':
		case 'starting':
		case 'stopping':
		case 'delegating':
		case 'queued':
		case 'moving':
			return 'running';
		case 'needsInput':
			return 'waiting';
		case 'failed':
			return 'failed';
		case 'interrupted':
		case 'paused':
		case 'blocked':
		case 'limited':
			return 'interrupted';
		case 'idle':
			return 'completed';
	}
}

function statusLabel(kind: OrchThreadStatusKind): string {
	switch (kind) {
		case 'working': return localize('voltAgent.status.working', "Running");
		case 'starting': return localize('voltAgent.status.starting', "Starting");
		case 'stopping': return localize('voltAgent.status.stopping', "Stopping");
		case 'delegating': return localize('voltAgent.status.delegating', "Waiting");
		case 'queued': return localize('voltAgent.status.queued', "Queued");
		case 'needsInput': return localize('voltAgent.status.needsInput', "Needs input");
		case 'failed': return localize('voltAgent.status.failed', "Failed");
		case 'interrupted': return localize('voltAgent.status.interrupted', "Interrupted");
		case 'paused': return localize('voltAgent.status.paused', "Paused");
		case 'blocked': return localize('voltAgent.status.blocked', "Waiting to start");
		case 'moving': return localize('voltAgent.status.moving', "Moving");
		case 'limited': return localize('voltAgent.status.limited', "Usage limit");
		case 'idle': return localize('voltAgent.status.idle', "Done");
	}
}
