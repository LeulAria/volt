/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWatchedTaskCard.css';
import '../media/agentIdeCard.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { formatDuration } from '../../../../services/voltRuntime/common/terminals/watchedTasks.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { closeOnOutsideClick } from '../composer/agentTasksCard.js';
import { AgentIdeActivityState, IAgentIdeActivity, IAgentIdeService } from './agentIdeService.js';

/** The watched-task card's tones, so both cards read the same: blue live, yellow paused, green, red. */
const TONE: Readonly<Record<AgentIdeActivityState, string>> = {
	running: 'state-running',
	paused: 'state-fixing',
	passed: 'state-passed',
	failed: 'state-failed',
	ended: 'state-stopped',
	stopped: 'state-stopped',
};

function kindIcon(activity: IAgentIdeActivity): ThemeIcon {
	switch (activity.kind) {
		case 'tests': return Codicon.beaker;
		case 'debug': return Codicon.debugAlt;
		case 'task': return Codicon.tools;
	}
}

function stateIcon(activity: IAgentIdeActivity): ThemeIcon {
	switch (activity.state) {
		case 'running': return Codicon.loading;
		case 'paused': return Codicon.debugPause;
		case 'passed': return Codicon.passFilled;
		case 'failed': return Codicon.error;
		default: return Codicon.circleSlash;
	}
}

function stateLabel(activity: IAgentIdeActivity): string {
	switch (activity.state) {
		case 'running': return activity.kind === 'tests' ? localize('voltIde.testing', "Testing") : activity.kind === 'debug' ? localize('voltIde.debugging', "Debugging") : localize('voltIde.running', "Running");
		case 'paused': return localize('voltIde.paused', "Paused");
		case 'passed': return activity.kind === 'tests' ? localize('voltIde.passed', "Passed") : localize('voltIde.done', "Done");
		case 'failed': return localize('voltIde.failed', "Failed");
		case 'ended': return localize('voltIde.ended', "Ended");
		case 'stopped': return localize('voltIde.stopped', "Stopped");
	}
}

function isLive(activity: IAgentIdeActivity): boolean {
	return activity.state === 'running' || activity.state === 'paused';
}

/**
 * What the agent is running in the IDE for this chat, above the composer: its test runs, debug
 * sessions and tasks, one line (kind, title, state, detail, time) that opens into the details and
 * the actions that matter (open in Test Results / Run and Debug / the terminal, rerun failures,
 * continue, stop). The same runs show in VS Code's own views; this is the chat's window onto them.
 */
export class AgentIdeCard extends Disposable {

	readonly element: HTMLElement;

	private chatId: string | undefined;
	private activities: readonly IAgentIdeActivity[] = [];
	private selected: string | undefined;
	private expanded = false;
	private structure = '';
	private visible = false;
	private timeEl: HTMLElement | undefined;
	private detailEl: HTMLElement | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly clock = this._register(new MutableDisposable());

	constructor(
		private readonly onDidChangeVisibility: () => void,
		@IAgentIdeService private readonly service: IAgentIdeService,
	) {
		super();
		this.element = $('.volt-agent-tasks-card.volt-watch-card.volt-ide-card.hidden');
		this._register(service.onDidChange(chatId => {
			if (chatId === this.chatId) {
				this.refresh();
			}
		}));
	}

	setChat(chatId: string | undefined): void {
		if (chatId === this.chatId) {
			return;
		}
		this.chatId = chatId;
		this.selected = undefined;
		this.expanded = false;
		this.refresh();
	}

	private current(): IAgentIdeActivity | undefined {
		return this.activities.find(activity => activity.id === this.selected)
			?? [...this.activities].reverse().find(isLive)
			?? this.activities.at(-1);
	}

	private refresh(): void {
		this.activities = this.chatId ? this.service.list(this.chatId) : [];
		const activity = this.current();
		this.element.classList.toggle('hidden', !activity);
		if (!activity) {
			this.renderStore.clear();
			this.element.replaceChildren();
			this.structure = '';
			this.clock.clear();
		} else {
			const structure = JSON.stringify([activity.id, activity.state, this.expanded, this.activities.length]);
			if (structure !== this.structure) {
				this.structure = structure;
				this.build(activity);
			}
			this.update(activity);
			this.clock.value = isLive(activity) ? this.startClock() : undefined;
		}
		if (!!activity !== this.visible) {
			this.visible = !!activity;
			this.onDidChangeVisibility();
		}
	}

	private startClock() {
		const window = getWindow(this.element);
		const handle = window.setInterval(() => {
			const activity = this.current();
			if (activity) {
				this.updateTime(activity);
			}
		}, 1000);
		return toDisposable(() => window.clearInterval(handle));
	}

	private build(activity: IAgentIdeActivity): void {
		this.renderStore.clear();
		this.element.replaceChildren();
		this.element.classList.toggle('expanded', this.expanded);
		for (const tone of new Set(Object.values(TONE))) {
			this.element.classList.toggle(tone, TONE[activity.state] === tone);
		}
		const panel = append(this.element, $('.volt-agent-tasks-panel.volt-watch-panel'));
		if (this.expanded) {
			this.buildDetail(panel, activity);
		}
		const head = append(panel, $('button.volt-agent-tasks-head.volt-watch-head')) as HTMLButtonElement;
		head.type = 'button';
		head.setAttribute('aria-expanded', String(this.expanded));
		head.setAttribute('aria-label', localize('voltIde.aria', "{0}: {1}", activity.title, stateLabel(activity)));
		const mark = append(head, $('span.volt-watch-mark'));
		const icon = activity.state === 'running' ? ThemeIcon.modify(stateIcon(activity), 'spin') : stateIcon(activity);
		mark.appendChild(renderIcon(icon));
		const title = append(head, $('span.volt-watch-title'));
		title.appendChild(renderIcon(kindIcon(activity)));
		title.append(` ${activity.title}`);
		const state = append(head, $('span.volt-watch-state'));
		state.textContent = stateLabel(activity);
		state.classList.toggle('shimmer', activity.state === 'running');
		this.detailEl = append(head, $('span.volt-ide-detail'));
		this.timeEl = append(head, $('span.volt-watch-time'));
		if (this.activities.length > 1) {
			append(head, $('span.volt-watch-more')).textContent = `${this.activities.indexOf(activity) + 1}/${this.activities.length}`;
		}
		append(head, $('span.volt-agent-tasks-chevron')).appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronUp));
		this.renderStore.add(addDisposableListener(head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.expanded = !this.expanded;
			this.structure = '';
			this.refresh();
		}));
		if (this.expanded) {
			this.renderStore.add(closeOnOutsideClick(this.element, () => {
				this.expanded = false;
				this.structure = '';
				this.refresh();
			}));
		}
	}

	private buildDetail(panel: HTMLElement, activity: IAgentIdeActivity): void {
		const detail = append(panel, $('.volt-watch-detail'));
		const top = append(detail, $('.volt-watch-top'));
		const what = append(top, $('code.volt-watch-command'));
		what.textContent = activity.title;
		setAgentTooltip(what, activity.title);
		if (this.activities.length > 1) {
			const pager = append(top, $('.volt-watch-pager'));
			const index = this.activities.indexOf(activity);
			for (const [label, icon, delta] of [[localize('voltIde.prev', "Previous"), Codicon.chevronLeft, -1], [localize('voltIde.next', "Next"), Codicon.chevronRight, 1]] as const) {
				const button = append(pager, $('button.volt-watch-page')) as HTMLButtonElement;
				button.type = 'button';
				button.appendChild(renderIcon(icon));
				button.setAttribute('aria-label', label);
				setAgentTooltip(button, label);
				const target = this.activities[(index + delta + this.activities.length) % this.activities.length];
				this.renderStore.add(addDisposableListener(button, 'click', e => {
					e.stopPropagation();
					this.selected = target.id;
					this.structure = '';
					this.refresh();
				}));
			}
		}
		append(detail, $('.volt-watch-note')).textContent = activity.detail ?? '';

		const actions = append(detail, $('.volt-watch-actions'));
		const open = this.renderStore.add(createVoltButton(actions, 'ghost', { supportIcons: true }));
		open.label = activity.kind === 'tests'
			? `$(beaker) ${localize('voltIde.openResults', "Test Results")}`
			: activity.kind === 'debug' ? `$(debug-alt) ${localize('voltIde.openDebug', "Run and Debug")}` : `$(terminal) ${localize('voltIde.openTerminal', "Open Terminal")}`;
		this.renderStore.add(open.onDidClick(() => this.service.reveal(activity.id)));
		append(actions, $('span.volt-watch-spacer'));
		if (isLive(activity)) {
			const stop = this.renderStore.add(createVoltButton(actions, 'danger'));
			stop.label = activity.kind === 'debug' ? localize('voltIde.stopDebug', "Stop Debugging") : localize('voltIde.stop', "Stop");
			this.renderStore.add(stop.onDidClick(() => this.service.stop(activity.id)));
		} else {
			const dismiss = this.renderStore.add(createVoltButton(actions, 'ghost'));
			dismiss.label = localize('voltIde.dismiss', "Dismiss");
			this.renderStore.add(dismiss.onDidClick(() => {
				this.selected = undefined;
				this.expanded = false;
				this.service.dismiss(activity.id);
			}));
		}
		if (activity.kind === 'debug' && activity.state === 'paused') {
			const resume = this.renderStore.add(createVoltButton(actions, 'primary', { supportIcons: true }));
			resume.label = `$(debug-continue) ${localize('voltIde.continue', "Continue")}`;
			this.renderStore.add(resume.onDidClick(() => this.service.primary(activity.id)));
		} else if (activity.kind === 'tests' && activity.state === 'failed') {
			const rerun = this.renderStore.add(createVoltButton(actions, 'primary', { supportIcons: true }));
			rerun.label = `$(debug-rerun) ${localize('voltIde.rerunFailed', "Rerun Failed")}`;
			this.renderStore.add(rerun.onDidClick(() => this.service.primary(activity.id)));
		}
	}

	private update(activity: IAgentIdeActivity): void {
		this.updateTime(activity);
		if (this.detailEl) {
			this.detailEl.textContent = activity.detail ?? '';
		}
	}

	private updateTime(activity: IAgentIdeActivity): void {
		if (this.timeEl) {
			this.timeEl.textContent = formatDuration((activity.endedAt ?? Date.now()) - activity.startedAt);
		}
	}
}
