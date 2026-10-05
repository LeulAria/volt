/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
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
import { openAgentPanel } from '../workspace/agentPanels.js';
import { revealAgentSideChat } from '../workspace/agentSurfaceHost.js';
import { ISubagentView, subagentHoverRows, subagentStateMark, subagentView, tickSubagentClocks } from './agentSubagents.js';
import { AgentTooltip } from './agentTooltip.js';

const ROW_HEIGHT = 26;
/** Room under the group's last row, inside the row so its hover reaches the card edge. */
const LAST_ROW_PADDING = 5;
/** Running agents shown before "Show N more". */
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
	readonly row: HTMLElement;
	readonly store: DisposableStore;
}

class LineageRenderer implements IListRenderer<ILineageRow, ILineageTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentLineage';
	readonly templateId = LineageRenderer.TEMPLATE_ID;

	constructor(private readonly tooltip: AgentTooltip) { }

	renderTemplate(container: HTMLElement): ILineageTemplate {
		container.classList.add('volt-agent-lineage-row');
		const avatar = append(container, $('span.volt-agent-lineage-avatar'));
		const title = append(container, $('span.volt-agent-lineage-title'));
		const clock = append(container, $('span.volt-subagent-clock'));
		const state = append(container, $('span.volt-agent-lineage-state'));
		return { avatar, title, clock, state, row: container, store: new DisposableStore() };
	}

	renderElement(element: ILineageRow, _index: number, template: ILineageTemplate): void {
		template.store.clear();
		const view = element.view;
		template.avatar.replaceChildren();
		if (element.parent) {
			template.avatar.classList.add('parent');
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
		template.title.textContent = view.title;
		template.state.textContent = view.stateLabel;
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
		template.store.add(this.tooltip.bind(template.row, () => subagentHoverRows(view, Date.now()), { placement: 'start', variant: 'card', delay: 400 }));
	}

	disposeTemplate(template: ILineageTemplate): void {
		template.store.dispose();
	}
}

/**
 * The agents of the chat on screen, in the dock beside it: "Agents · N running" (subagents and
 * multitask agents under its root, except its own working ones: those are in the card above the
 * composer), then "Needs attention (N)" (agents waiting for an
 * approval or an answer; open, and gone when there are none), then "Previous agents (N)",
 * collapsed. In a subagent's chat the parent comes first. A row opens that agent in this chat's
 * right panel.
 */
export class AgentLineageDock extends Disposable {

	readonly element: HTMLElement;
	private readonly runningHead: HTMLElement;
	private readonly runningHost: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly attentionHead: HTMLButtonElement;
	private readonly attentionHost: HTMLElement;
	private readonly attention: WorkbenchList<ILineageRow>;
	private readonly previousHead: HTMLButtonElement;
	private readonly previousHost: HTMLElement;
	private readonly running: WorkbenchList<ILineageRow>;
	private readonly previous: WorkbenchList<ILineageRow>;
	private readonly tooltip = this._register(new AgentTooltip());
	private readonly clocks = this._register(new MutableDisposable<DisposableStore>());
	private sessionId: string | undefined;
	private showAll = false;
	private previousOpen = false;
	private attentionOpen = true;
	private signature = '';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this.element = $('.volt-agent-dock-section.volt-agent-lineage.hidden');
		this.runningHead = append(this.element, $('.volt-agent-dock-heading.volt-agent-lineage-head'));
		this.runningHost = append(this.element, $('.volt-agent-lineage-list'));
		this.moreButton = append(this.element, $('button.volt-agent-dock-row.volt-agent-lineage-more')) as HTMLButtonElement;
		this.moreButton.type = 'button';
		this.attentionHead = append(this.element, $('button.volt-agent-lineage-divider.attention')) as HTMLButtonElement;
		this.attentionHead.type = 'button';
		this.attentionHost = append(this.element, $('.volt-agent-lineage-list.attention'));
		this.previousHead = append(this.element, $('button.volt-agent-lineage-divider')) as HTMLButtonElement;
		this.previousHead.type = 'button';
		this.previousHost = append(this.element, $('.volt-agent-lineage-list.previous'));
		const renderer = new LineageRenderer(this.tooltip);
		const options = (label: string) => ({
			identityProvider: { getId: (row: ILineageRow) => `${row.parent ? 'p:' : ''}${row.view.key}` },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => label,
				getAriaLabel: (row: ILineageRow) => `${row.view.title}, ${row.view.stateLabel}`,
			},
		});
		this.running = this._register(instantiationService.createInstance(WorkbenchList<ILineageRow>, 'VoltAgentLineageRunning', this.runningHost, new LineageDelegate(), [renderer], options(localize('voltAgent.lineage.running', "Running agents"))));
		this.attention = this._register(instantiationService.createInstance(WorkbenchList<ILineageRow>, 'VoltAgentLineageAttention', this.attentionHost, new LineageDelegate(), [renderer], options(localize('voltAgent.lineage.attention', "Agents that need attention"))));
		this.previous = this._register(instantiationService.createInstance(WorkbenchList<ILineageRow>, 'VoltAgentLineagePrevious', this.previousHost, new LineageDelegate(), [renderer], options(localize('voltAgent.lineage.previous', "Previous agents"))));
		for (const list of [this.running, this.attention, this.previous]) {
			this._register(list.onDidOpen(e => e.element && this.open(e.element)));
		}
		this._register(addDisposableListener(this.moreButton, 'click', () => {
			this.showAll = !this.showAll;
			this.render(true);
		}));
		this._register(addDisposableListener(this.attentionHead, 'click', () => {
			this.attentionOpen = !this.attentionOpen;
			this.render(true);
		}));
		this._register(addDisposableListener(this.previousHead, 'click', () => {
			this.previousOpen = !this.previousOpen;
			this.render(true);
		}));
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

	setSession(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) {
			return;
		}
		this.sessionId = sessionId;
		this.showAll = false;
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
		// This chat's own working agents show in the card above its composer; the dock keeps the
		// ones elsewhere under the root (a sibling's, or the parent's from a subagent's chat).
		const live = view?.running
			.filter(row => this.orchestrator.getTask(row.taskId)?.parentId !== sessionId)
			.map(row => subagentView(row, ref => this.providerOf(ref))) ?? [];
		// Agents blocked on an approval or a question get their own group: they wait on the user.
		const running = live.filter(row => row.state !== 'waiting');
		const attention = live.filter(row => row.state === 'waiting');
		const previous = view?.previous.map(row => subagentView(row, ref => this.providerOf(ref))) ?? [];
		const parent = view?.parent;
		const signature = JSON.stringify([sessionId, this.showAll, this.previousOpen, this.attentionOpen, parent?.status.kind, parent?.title, live.map(row => [row.key, row.state, row.stateLabel, row.title, row.startedAt]), previous.map(row => [row.key, row.state, row.endedAt])]);
		if (!force && signature === this.signature) {
			return;
		}
		this.signature = signature;
		const empty = !parent && !live.length && !previous.length;
		this.element.classList.toggle('hidden', empty);
		if (empty) {
			return;
		}

		// Only running agents get a heading; "Previous agents" heads its own group.
		this.runningHead.replaceChildren();
		this.runningHead.style.display = running.length ? '' : 'none';
		append(this.runningHead, $('span')).textContent = localize('voltAgent.lineage.title', "Agents · {0} running", running.length);
		const rows: ILineageRow[] = [];
		if (parent && sessionId) {
			rows.push({ parent: true, view: { key: parent.threadId, title: parent.title ?? this.history.get(parent.threadId)?.title ?? localize('voltAgent.lineage.parent', "Parent chat"), state: statusState(parent.status.kind), stateLabel: statusLabel(parent.status.kind), openable: true, cancellable: false, source: 'volt' } });
		}
		const visible = this.showAll ? running : running.slice(0, RUNNING_VISIBLE);
		rows.push(...visible.map(row => ({ view: row })));
		this.runningHost.style.height = `${rows.length * ROW_HEIGHT}px`;
		this.running.layout(rows.length * ROW_HEIGHT);
		this.running.splice(0, this.running.length, rows);
		const hidden = running.length - visible.length;
		this.moreButton.style.display = hidden > 0 || (this.showAll && running.length > RUNNING_VISIBLE) ? '' : 'none';
		this.moreButton.replaceChildren(renderIcon(this.showAll ? Codicon.remove : Codicon.add));
		append(this.moreButton, $('span')).textContent = this.showAll
			? localize('voltAgent.lineage.less', "Show less")
			: localize('voltAgent.lineage.more', "Show {0} more", hidden);

		this.attentionHead.style.display = attention.length ? '' : 'none';
		this.attentionHead.replaceChildren();
		this.attentionHead.setAttribute('aria-expanded', String(this.attentionOpen));
		this.attentionHead.appendChild(renderIcon(this.attentionOpen ? Codicon.chevronDown : Codicon.chevronRight));
		append(this.attentionHead, $('span.label')).textContent = localize('voltAgent.lineage.attentionTitle', "Needs attention ({0})", attention.length);
		const shownAttention = this.attentionOpen ? attention : [];
		const attentionHeight = shownAttention.length * ROW_HEIGHT;
		this.attentionHost.style.height = `${attentionHeight}px`;
		this.attention.layout(attentionHeight);
		this.attention.splice(0, this.attention.length, shownAttention.map(row => ({ view: row })));

		this.previousHead.style.display = previous.length ? '' : 'none';
		this.previousHead.replaceChildren();
		this.previousHead.setAttribute('aria-expanded', String(this.previousOpen));
		// A VS Code pane header: chevron, then the title.
		this.previousHead.appendChild(renderIcon(this.previousOpen ? Codicon.chevronDown : Codicon.chevronRight));
		append(this.previousHead, $('span.label')).textContent = localize('voltAgent.lineage.previousTitle', "Previous agents ({0})", previous.length);
		const shownPrevious = this.previousOpen ? previous.slice(0, PREVIOUS_VISIBLE) : [];
		const previousHeight = shownPrevious.length ? shownPrevious.length * ROW_HEIGHT + LAST_ROW_PADDING : 0;
		this.previousHost.style.height = `${previousHeight}px`;
		this.previous.layout(previousHeight);
		this.previous.splice(0, this.previous.length, shownPrevious.map((row, index) => ({ view: row, last: index === shownPrevious.length - 1 })));
		this.element.classList.toggle('ends-in-previous', shownPrevious.length > 0);

		const clocks = new DisposableStore();
		this.clocks.value = clocks;
		tickSubagentClocks(this.runningHost, clocks);
		tickSubagentClocks(this.attentionHost, clocks);
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
		const task = this.orchestrator.getTask(row.view.key);
		if (!task?.childId) {
			return;
		}
		// The agent opens as a tab in this chat's right panel; it streams there as it works.
		if (!revealAgentSideChat(sessionId, task.childId)) {
			void openAgentPanel(this.editorGroupsService, this.instantiationService, task.childId);
		}
	}
}

function statusState(kind: OrchThreadStatusKind): ISubagentView['state'] {
	switch (kind) {
		case 'working':
		case 'starting':
		case 'stopping':
		case 'delegating':
		case 'queued':
			return 'running';
		case 'needsInput':
			return 'waiting';
		case 'failed':
			return 'failed';
		case 'interrupted':
		case 'paused':
		case 'blocked':
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
		case 'idle': return localize('voltAgent.status.idle', "Done");
	}
}
