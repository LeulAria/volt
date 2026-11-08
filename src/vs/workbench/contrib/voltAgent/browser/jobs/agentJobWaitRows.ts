/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentJobWaits.css';
import { $, addDisposableListener, append, getWindow, reset } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { formatJobClock, formatJobDuration } from '../../../../services/voltRuntime/common/jobs/jobWatch.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IAgentJobWait, IAgentJobWaitsService } from './agentJobWaits.js';

interface IRowParts {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly percent: HTMLElement;
	readonly clock: HTMLElement;
	readonly line: HTMLElement;
	readonly fill: HTMLElement;
	view: IAgentJobWait;
}

/**
 * The jobs a chat waits on, under the agent's last reply while it is idle: three breathing dots,
 * the job's name, the latest line it printed, a running clock, and a progress bar once it says how
 * far along it is. Kept as the thread's last child (the transcript is redrawn and parked around
 * it), and only there while it has rows. Updates land in place, so the dots never restart.
 */
export class AgentJobWaitRows extends Disposable {

	readonly element: HTMLElement;
	private chatId: string | undefined;
	private rows = new Map<string, IRowParts>();
	/** Ids and states of the drawn rows: a change in them redraws, anything else updates in place. */
	private shape = '';
	private readonly rowStore = this._register(new DisposableStore());
	private clock: number | undefined;

	constructor(
		private readonly threadInner: HTMLElement,
		/** The rows appeared, went or changed height: the thread re-measures (and keeps to its end). */
		private readonly onDidResize: () => void,
		@IAgentJobWaitsService private readonly service: IAgentJobWaitsService,
	) {
		super();
		this.element = $('section.volt-agent-job-waits');
		this.element.setAttribute('aria-label', localize('voltAgent.jobWaits', "Jobs the agent is waiting on"));
		const observer = new MutationObserver(() => this.keepLast());
		observer.observe(threadInner, { childList: true });
		this._register(toDisposable(() => {
			observer.disconnect();
			this.stopClock();
			this.element.remove();
		}));
		this._register(service.onDidChange(chatId => {
			if (chatId === this.chatId) {
				this.render();
			}
		}));
	}

	setChat(chatId: string | undefined): void {
		if (chatId === this.chatId) {
			return;
		}
		this.chatId = chatId;
		this.shape = '';
		this.render();
	}

	/** Redraws and parks of the transcript move or drop it: back to the end, if it has rows. */
	private keepLast(): void {
		if (!this.rows.size) {
			if (this.element.parentElement) {
				this.element.remove();
			}
			return;
		}
		if (this.threadInner.lastElementChild !== this.element) {
			this.threadInner.appendChild(this.element);
			this.onDidResize();
		}
	}

	private render(): void {
		const views = this.chatId ? this.service.visible(this.chatId) : [];
		const shape = views.map(view => `${view.id}:${view.state}:${view.progress !== undefined}`).join('|');
		if (shape === this.shape) {
			for (const view of views) {
				const parts = this.rows.get(view.id);
				if (parts) {
					parts.view = view;
					this.update(parts);
				}
			}
			return;
		}
		this.shape = shape;
		this.rowStore.clear();
		this.rows = new Map(views.map(view => [view.id, this.renderRow(view)]));
		reset(this.element, ...[...this.rows.values()].map(parts => parts.root));
		this.keepLast();
		if (views.some(view => view.state === 'running')) {
			this.startClock();
		} else {
			this.stopClock();
		}
		this.onDidResize();
	}

	private renderRow(view: IAgentJobWait): IRowParts {
		const running = view.state === 'running';
		const root = $(`.volt-agent-job-wait.${view.state}`);
		const main = append(root, $('.volt-agent-job-wait-main'));
		const mark = append(main, $('span.volt-agent-job-wait-mark'));
		if (running) {
			const dots = append(mark, $('span.volt-agent-job-dots'));
			dots.setAttribute('aria-hidden', 'true');
			for (let index = 0; index < 3; index++) {
				append(dots, $('i'));
			}
		} else {
			mark.appendChild(renderIcon(endIcon(view)));
		}
		const body = append(main, $('.volt-agent-job-wait-body'));
		const head = append(body, $('.volt-agent-job-wait-head'));
		const title = append(head, $('span.volt-agent-job-wait-title'));
		const percent = append(head, $('span.volt-agent-job-wait-percent'));
		const clock = append(head, $('span.volt-agent-job-wait-clock'));
		const line = append(body, $('.volt-agent-job-wait-line'));
		setAgentTooltip(main, rowTooltip(view));
		const actions = append(main, $('.volt-agent-job-wait-actions'));
		if (view.source === 'agent-task') {
			this.action(actions, Codicon.output, localize('voltAgent.jobWait.output', "Show output"), () => this.service.reveal(view.id));
		}
		this.action(actions, Codicon.close, running ? localize('voltAgent.jobWait.stop', "Stop waiting (the job keeps running, and the agent is not told when it ends)") : localize('voltAgent.jobWait.dismiss', "Dismiss"), () => this.service.stop(view.id));
		const bar = append(root, $('.volt-agent-job-wait-bar'));
		const fill = append(bar, $('.volt-agent-job-wait-fill'));
		const parts: IRowParts = { root, title, percent, clock, line, fill, view };
		this.update(parts);
		return parts;
	}

	private action(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = append(parent, $('button.volt-agent-job-wait-action')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
		button.appendChild(renderIcon(icon));
		this.rowStore.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
	}

	private update(parts: IRowParts): void {
		const view = parts.view;
		parts.title.textContent = rowTitle(view);
		parts.line.textContent = view.line ?? rowFallbackLine(view);
		parts.line.classList.toggle('placeholder', !view.line);
		const progress = view.progress;
		parts.root.classList.toggle('has-progress', progress !== undefined);
		parts.percent.textContent = progress !== undefined && view.state === 'running' ? `${Math.round(progress * 100)}%` : '';
		parts.fill.style.transform = `scaleX(${progress ?? 0})`;
		this.updateClock(parts, Date.now());
	}

	private updateClock(parts: IRowParts, now: number): void {
		const view = parts.view;
		parts.clock.textContent = view.state === 'running' ? formatJobClock(now - view.startedAt) : formatJobDuration((view.endedAt ?? now) - view.startedAt);
	}

	private startClock(): void {
		if (this.clock !== undefined) {
			return;
		}
		this.clock = getWindow(this.element).setInterval(() => {
			const now = Date.now();
			for (const parts of this.rows.values()) {
				if (parts.view.state === 'running') {
					this.updateClock(parts, now);
				}
			}
		}, 1000);
	}

	private stopClock(): void {
		if (this.clock !== undefined) {
			getWindow(this.element).clearInterval(this.clock);
			this.clock = undefined;
		}
	}
}

function endIcon(view: IAgentJobWait): ThemeIcon {
	switch (view.state) {
		case 'done': return Codicon.passFilled;
		case 'failed': return Codicon.error;
		case 'timedOut': return Codicon.watch;
		default: return Codicon.warning;
	}
}

function rowTitle(view: IAgentJobWait): string {
	switch (view.state) {
		case 'done': return localize('voltAgent.jobWait.done', "{0} finished", view.title);
		case 'failed': return localize('voltAgent.jobWait.failed', "{0} failed", view.title);
		case 'timedOut': return localize('voltAgent.jobWait.timedOut', "{0} is still running; stopped waiting", view.title);
		case 'broken': return localize('voltAgent.jobWait.broken', "Stopped watching {0}: its check did not work", view.title);
		default: return view.title;
	}
}

function rowFallbackLine(view: IAgentJobWait): string {
	if (view.state !== 'running') {
		return '';
	}
	if (view.source === 'agent-task') {
		return localize('voltAgent.jobWait.background', "Running in the background");
	}
	return localize('voltAgent.jobWait.checking', "Checking every {0}s", Math.round((view.everyMs ?? 5000) / 1000));
}

function rowTooltip(view: IAgentJobWait): string {
	if (view.source === 'agent-task') {
		return localize('voltAgent.jobWait.taskTip', "A command the agent left running. Volt tells the agent when it ends, so it can give you the result.");
	}
	return view.check
		? localize('voltAgent.jobWait.watchTip', "Volt runs `{0}` every {1}s and tells the agent when the job ends.", view.check, Math.round((view.everyMs ?? 5000) / 1000))
		: localize('voltAgent.jobWait.pidTip', "Volt checks the job's process every {0}s and tells the agent when it ends.", Math.round((view.everyMs ?? 5000) / 1000));
}
