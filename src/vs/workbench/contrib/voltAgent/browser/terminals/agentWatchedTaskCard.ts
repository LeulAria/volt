/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWatchedTaskCard.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { formatDuration, isWatchLive, IWatchedAttempt, WatchedTaskState } from '../../../../services/voltRuntime/common/terminals/watchedTasks.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { closeOnOutsideClick } from '../composer/agentTasksCard.js';
import { IAgentWatchedTasksService, IWatchedTaskView } from './agentWatchedTasks.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The countdown ring's circumference (r = 5.5). */
const RING = 2 * Math.PI * 5.5;

function stateLabel(view: IWatchedTaskView): string {
	const attempt = view.attempts.at(-1)?.number ?? 1;
	switch (view.state) {
		case 'running': return attempt > 1
			? localize('voltWatch.state.rerunning', "Run {0} of {1}", attempt, view.maxAttempts)
			: localize('voltWatch.state.running', "Running");
		case 'fixing': return localize('voltWatch.state.fixing', "Agent is fixing it");
		case 'passed': return localize('voltWatch.state.passed', "Passed");
		case 'failed': return localize('voltWatch.state.failed', "Failed");
		case 'stuck': return localize('voltWatch.state.stuck', "Stuck on the same error");
		case 'exhausted': return localize('voltWatch.state.exhausted', "Gave up");
		case 'stopped': return localize('voltWatch.state.stopped', "Stopped");
	}
}

function stateIcon(state: WatchedTaskState): ThemeIcon | undefined {
	switch (state) {
		case 'running': return undefined;
		case 'fixing': return Codicon.tools;
		case 'passed': return Codicon.passFilled;
		case 'stuck': return Codicon.issueReopened;
		case 'stopped': return Codicon.circleSlash;
		default: return Codicon.error;
	}
}

function attemptTone(attempt: IWatchedAttempt): string {
	return attempt.result === 'passed' ? 'passed' : attempt.result ? 'failed' : 'live';
}

/** A spinning arc: the run is going. */
function spinner(doc: Document): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 14 14');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-watch-spinner');
	const track = doc.createElementNS(SVG_NS, 'circle');
	track.setAttribute('cx', '7');
	track.setAttribute('cy', '7');
	track.setAttribute('r', '5.5');
	track.classList.add('track');
	const arc = doc.createElementNS(SVG_NS, 'circle');
	arc.setAttribute('cx', '7');
	arc.setAttribute('cy', '7');
	arc.setAttribute('r', '5.5');
	arc.classList.add('arc');
	svg.append(track, arc);
	return svg;
}

/**
 * The chat's watched tasks above the composer, a card like Tasks: one line (state, title, attempt
 * dots, time, a ring counting down to the next check) that opens into the run's latest output, its
 * attempts as a timeline and what to do next.
 */
export class AgentWatchedTaskCard extends Disposable {

	readonly element: HTMLElement;

	private chatId: string | undefined;
	private views: readonly IWatchedTaskView[] = [];
	/** The watch on show; the newest live one unless the user paged to another. */
	private selected: string | undefined;
	private expanded = false;
	private structure = '';
	private readonly renderStore = this._register(new DisposableStore());
	private readonly clock = this._register(new MutableDisposable());

	// Parts updated in place between rebuilds, so hover and focus survive a tick.
	private timeEl: HTMLElement | undefined;
	private ringEl: SVGCircleElement | undefined;
	private ringAt: number | undefined;
	private outputEl: HTMLElement | undefined;
	private noteEl: HTMLElement | undefined;
	private dotsEl: HTMLElement | undefined;
	private timelineEl: HTMLElement | undefined;
	private visible = false;

	constructor(
		private readonly onDidChangeVisibility: () => void,
		@IAgentWatchedTasksService private readonly service: IAgentWatchedTasksService,
	) {
		super();
		this.element = $('.volt-agent-tasks-card.volt-watch-card.hidden');
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

	private current(): IWatchedTaskView | undefined {
		return this.views.find(view => view.id === this.selected)
			?? [...this.views].reverse().find(view => isWatchLive(view.state))
			?? this.views.at(-1);
	}

	private refresh(): void {
		this.views = this.chatId ? this.service.list(this.chatId) : [];
		const view = this.current();
		const visible = !!view;
		this.element.classList.toggle('hidden', !visible);
		if (!view) {
			this.renderStore.clear();
			this.element.replaceChildren();
			this.structure = '';
			this.clock.clear();
		} else {
			const structure = JSON.stringify([view.id, view.state, this.expanded, this.views.length, view.attempts.length, !!view.terminalId]);
			if (structure !== this.structure) {
				this.structure = structure;
				this.build(view);
			}
			this.update(view);
			this.clock.value = isWatchLive(view.state) ? this.startClock() : undefined;
		}
		if (visible !== this.visible) {
			this.visible = visible;
			this.onDidChangeVisibility();
		}
	}

	private startClock() {
		const window = getWindow(this.element);
		const handle = window.setInterval(() => {
			const view = this.current();
			if (view) {
				this.updateTime(view);
			}
		}, 1000);
		return toDisposable(() => window.clearInterval(handle));
	}

	private build(view: IWatchedTaskView): void {
		this.renderStore.clear();
		this.element.replaceChildren();
		this.ringEl = undefined;
		this.ringAt = undefined;
		const doc = this.element.ownerDocument;
		this.element.classList.toggle('expanded', this.expanded);
		for (const state of ['running', 'fixing', 'passed', 'failed', 'stuck', 'exhausted', 'stopped']) {
			this.element.classList.toggle(`state-${state}`, view.state === state);
		}

		const panel = append(this.element, $('.volt-agent-tasks-panel.volt-watch-panel'));
		if (this.expanded) {
			this.buildDetail(panel, view);
		}

		const head = append(panel, $('button.volt-agent-tasks-head.volt-watch-head')) as HTMLButtonElement;
		head.type = 'button';
		head.setAttribute('aria-expanded', String(this.expanded));
		head.setAttribute('aria-label', localize('voltWatch.aria', "Watched task {0}: {1}", view.title, stateLabel(view)));
		const mark = append(head, $('span.volt-watch-mark'));
		const icon = stateIcon(view.state);
		mark.appendChild(icon ? renderIcon(icon) : spinner(doc));
		append(head, $('span.volt-watch-title')).textContent = view.title;
		const state = append(head, $('span.volt-watch-state'));
		state.textContent = stateLabel(view);
		state.classList.toggle('shimmer', isWatchLive(view.state));
		this.dotsEl = append(head, $('span.volt-watch-dots'));
		this.dotsEl.setAttribute('aria-hidden', 'true');
		this.timeEl = append(head, $('span.volt-watch-time'));
		if (view.state === 'running') {
			const ring = doc.createElementNS(SVG_NS, 'svg');
			ring.setAttribute('viewBox', '0 0 14 14');
			ring.setAttribute('width', '14');
			ring.setAttribute('height', '14');
			ring.classList.add('volt-watch-ring');
			const track = doc.createElementNS(SVG_NS, 'circle');
			track.setAttribute('cx', '7');
			track.setAttribute('cy', '7');
			track.setAttribute('r', '5.5');
			track.classList.add('track');
			ring.appendChild(track);
			this.ringEl = doc.createElementNS(SVG_NS, 'circle');
			this.ringEl.setAttribute('cx', '7');
			this.ringEl.setAttribute('cy', '7');
			this.ringEl.setAttribute('r', '5.5');
			this.ringEl.setAttribute('stroke-dasharray', String(RING));
			this.ringEl.classList.add('left');
			ring.appendChild(this.ringEl);
			const holder = append(head, $('span.volt-watch-ring-holder'));
			holder.appendChild(ring);
			setAgentTooltip(holder, localize('voltWatch.ringTip', "Volt checks it every {0}", formatDuration(view.checkEveryMs)));
		}
		if (this.views.length > 1) {
			append(head, $('span.volt-watch-more')).textContent = `${this.views.indexOf(view) + 1}/${this.views.length}`;
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

	/** The open card: command, output, attempts and actions, above the header line. */
	private buildDetail(panel: HTMLElement, view: IWatchedTaskView): void {
		const detail = append(panel, $('.volt-watch-detail'));
		const top = append(detail, $('.volt-watch-top'));
		const command = append(top, $('code.volt-watch-command'));
		command.textContent = view.command;
		setAgentTooltip(command, view.command);
		if (this.views.length > 1) {
			const pager = append(top, $('.volt-watch-pager'));
			const index = this.views.indexOf(view);
			for (const [label, icon, delta] of [[localize('voltWatch.prev', "Previous Task"), Codicon.chevronLeft, -1], [localize('voltWatch.next', "Next Task"), Codicon.chevronRight, 1]] as const) {
				const button = append(pager, $('button.volt-watch-page')) as HTMLButtonElement;
				button.type = 'button';
				button.appendChild(renderIcon(icon));
				button.setAttribute('aria-label', label);
				setAgentTooltip(button, label);
				const target = this.views[(index + delta + this.views.length) % this.views.length];
				this.renderStore.add(addDisposableListener(button, 'click', e => {
					e.stopPropagation();
					this.selected = target.id;
					this.structure = '';
					this.refresh();
				}));
			}
		}

		const screen = append(detail, $('.volt-watch-screen'));
		this.outputEl = append(screen, $('pre.volt-watch-output'));
		this.outputEl.setAttribute('aria-live', 'off');
		if (view.state === 'running') {
			append(screen, $('span.volt-watch-caret'));
		}

		this.timelineEl = append(detail, $('.volt-watch-timeline'));
		this.noteEl = append(detail, $('.volt-watch-note'));

		const actions = append(detail, $('.volt-watch-actions'));
		if (view.terminalId) {
			const open = this.renderStore.add(createVoltButton(actions, 'ghost', { supportIcons: true }));
			open.label = `$(terminal) ${localize('voltWatch.openTerminal', "Open Terminal")}`;
			this.renderStore.add(open.onDidClick(() => this.service.reveal(view.id)));
		}
		append(actions, $('span.volt-watch-spacer'));
		if (isWatchLive(view.state)) {
			const stop = this.renderStore.add(createVoltButton(actions, 'danger'));
			stop.label = localize('voltWatch.stop', "Stop Watching");
			this.renderStore.add(stop.onDidClick(() => void this.service.stop(view.id)));
		} else {
			const dismiss = this.renderStore.add(createVoltButton(actions, 'ghost'));
			dismiss.label = localize('voltWatch.dismiss', "Dismiss");
			this.renderStore.add(dismiss.onDidClick(() => {
				this.selected = undefined;
				this.expanded = false;
				this.service.dismiss(view.id);
			}));
		}
		const rerun = this.renderStore.add(createVoltButton(actions, view.state === 'passed' || view.state === 'running' ? 'secondary' : 'primary', { supportIcons: true }));
		rerun.label = `$(debug-rerun) ${localize('voltWatch.rerun', "Run Again")}`;
		this.renderStore.add(rerun.onDidClick(() => void this.service.rerun(view.id)));
	}

	private update(view: IWatchedTaskView): void {
		this.updateTime(view);
		if (this.dotsEl) {
			// One dot per attempt it may take: done ones coloured by result, the running one pulsing.
			const dots: HTMLElement[] = [];
			for (let i = 0; i < view.maxAttempts; i++) {
				const attempt = view.attempts[i];
				dots.push($(`span.volt-watch-dot.${attempt ? attemptTone(attempt) : 'pending'}`));
			}
			this.dotsEl.replaceChildren(...dots);
		}
		if (this.ringEl && view.nextCheckAt !== this.ringAt) {
			this.ringAt = view.nextCheckAt;
			this.restartRing(view);
		}
		if (this.outputEl) {
			const text = view.snapshot.length ? view.snapshot.join('\n') : localize('voltWatch.noOutput', "No output yet.");
			if (this.outputEl.textContent !== text) {
				this.outputEl.textContent = text;
				this.outputEl.classList.toggle('empty', !view.snapshot.length);
			}
		}
		if (this.noteEl) {
			this.noteEl.textContent = view.note ?? (view.state === 'running'
				? localize('voltWatch.runningNote', "Volt checks it every {0} and asks the agent to fix it if it fails.", formatDuration(view.checkEveryMs))
				: '');
		}
		if (this.timelineEl) {
			this.renderTimeline(view);
		}
	}

	/** The attempts as one track: each a segment as wide as it ran, coloured by how it ended. */
	private renderTimeline(view: IWatchedTaskView): void {
		const el = this.timelineEl!;
		const now = Date.now();
		const spans = view.attempts.map(attempt => Math.max(1, (attempt.endedAt ?? now) - attempt.startedAt));
		const total = spans.reduce((sum, span) => sum + span, 0);
		el.replaceChildren();
		view.attempts.forEach((attempt, index) => {
			const segment = append(el, $(`span.volt-watch-segment.${attemptTone(attempt)}`));
			segment.style.flexGrow = String(Math.max(0.08, spans[index] / total));
			append(segment, $('span.volt-watch-segment-label')).textContent = `#${attempt.number}`;
			const when = formatDuration(spans[index]);
			const tip = attempt.result === 'passed'
				? localize('voltWatch.tip.passed', "Attempt {0} passed in {1}", attempt.number, when)
				: attempt.result
					? localize('voltWatch.tip.failed', "Attempt {0} failed after {1}: {2}", attempt.number, when, attempt.reason ?? '')
					: localize('voltWatch.tip.running', "Attempt {0}, running for {1}", attempt.number, when);
			setAgentTooltip(segment, tip);
		});
		for (let i = view.attempts.length; i < view.maxAttempts && isWatchLive(view.state); i++) {
			append(el, $('span.volt-watch-segment.pending'));
		}
	}

	private updateTime(view: IWatchedTaskView): void {
		if (!this.timeEl) {
			return;
		}
		const attempt = view.attempts.at(-1);
		const from = view.state === 'running' && attempt ? attempt.startedAt : view.startedAt;
		this.timeEl.textContent = formatDuration((view.endedAt ?? Date.now()) - from);
	}

	/** The ring empties until the next check; a CSS animation, so no timer redraws it. */
	private restartRing(view: IWatchedTaskView): void {
		const ring = this.ringEl!;
		const left = Math.max(0, (view.nextCheckAt ?? Date.now()) - Date.now());
		ring.style.animation = 'none';
		// A reflow between, or the browser keeps the old run.
		void ring.getBoundingClientRect();
		ring.style.setProperty('--volt-watch-ring', String(RING));
		ring.style.animation = `volt-watch-countdown ${view.checkEveryMs}ms linear ${left - view.checkEveryMs}ms forwards`;
	}
}
