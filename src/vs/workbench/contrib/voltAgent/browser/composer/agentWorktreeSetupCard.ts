/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWorktreeSetup.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IAgentWorktreeSetupService, IWorktreeSetupStatus, IWorktreeSetupStepStatus } from '../../../../services/voltRuntime/common/git/worktreeSetupPlan.js';
import { formatElapsed } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

/** A finished setup's card stays this long, then folds away on its own. */
const DONE_LINGER_MS = 5_000;

export interface IAgentWorktreeSetupCardDelegate {
	/** Retry from the step that failed, and continue the turn it held up. */
	onRetry(chatId: string): void;
	/** The card's height changed: the composer lays out again. */
	onDidChangeHeight(): void;
}

/**
 * "Setting up worktree · Step 2 of 4 · 0:38   Cancel": the steps a new worktree runs before the
 * agent works there, one row each with its state and, for the running or failed one, the last
 * lines of output. Failed or cancelled: Retry picks up at that step. T3's worktree setup card, in
 * the composer stack like Volt's Tasks card.
 */
export class AgentWorktreeSetupCard extends Disposable {

	readonly element: HTMLElement;
	private chatId: string | undefined;
	private expanded = true;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly ticker = this._register(new MutableDisposable());
	private readonly linger = this._register(new MutableDisposable());

	constructor(
		private readonly delegate: IAgentWorktreeSetupCardDelegate,
		@IAgentWorktreeSetupService private readonly setup: IAgentWorktreeSetupService,
	) {
		super();
		this.element = $('.volt-worktree-setup.hidden');
		this.element.setAttribute('role', 'status');
		this._register(this.setup.onDidChange(chatId => {
			if (chatId === this.chatId) {
				this.render();
			}
		}));
	}

	setChat(chatId: string | undefined): void {
		if (chatId !== this.chatId) {
			this.chatId = chatId;
			this.expanded = true;
			this.linger.clear();
			this.render();
		}
	}

	private render(): void {
		this.renderStore.clear();
		clearNode(this.element);
		const status = this.chatId ? this.setup.get(this.chatId) : undefined;
		const wasHidden = this.element.classList.contains('hidden');
		this.element.classList.toggle('hidden', !status);
		if (!status) {
			this.ticker.clear();
			if (!wasHidden) {
				this.delegate.onDidChangeHeight();
			}
			return;
		}
		this.element.classList.remove('phase-running', 'phase-done', 'phase-failed', 'phase-cancelled');
		this.element.classList.add(`phase-${status.phase}`);
		this.renderHeader(status);
		if (this.expanded) {
			const list = append(this.element, $('.volt-worktree-setup-steps'));
			for (const step of status.steps) {
				this.renderStep(list, step);
			}
		}
		this.syncTimers(status);
		this.delegate.onDidChangeHeight();
	}

	private renderHeader(status: IWorktreeSetupStatus): void {
		const head = append(this.element, $('.volt-worktree-setup-head'));
		const toggle = append(head, $('button.volt-worktree-setup-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(this.expanded));
		append(toggle, $('span.volt-worktree-setup-mark')).appendChild(renderIcon(phaseIcon(status.phase)));
		const done = status.steps.filter(step => step.state === 'done').length;
		const current = status.steps.findIndex(step => step.state === 'running');
		const title = append(toggle, $('span.volt-worktree-setup-title'));
		switch (status.phase) {
			case 'running':
				title.textContent = localize('voltWorktreeSetup.running', "Setting up worktree");
				break;
			case 'done':
				title.textContent = localize('voltWorktreeSetup.done', "Worktree ready");
				break;
			case 'failed':
				title.textContent = localize('voltWorktreeSetup.failed', "Worktree setup failed");
				break;
			case 'cancelled':
				title.textContent = localize('voltWorktreeSetup.cancelled', "Worktree setup cancelled");
				break;
		}
		const detail = append(toggle, $('span.volt-worktree-setup-detail'));
		detail.textContent = status.phase === 'running'
			? localize('voltWorktreeSetup.step', "Step {0} of {1}", Math.max(current, done) + 1, status.steps.length)
			: localize('voltWorktreeSetup.steps', "{0} of {1} steps", done, status.steps.length);
		append(toggle, $('span.volt-worktree-setup-clock')).textContent = formatElapsed((status.endedAt ?? Date.now()) - status.startedAt);
		append(toggle, $('span.volt-worktree-setup-chevron')).appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronRight));
		this.renderStore.add(addDisposableListener(toggle, 'click', () => {
			this.expanded = !this.expanded;
			this.render();
		}));
		setAgentTooltip(toggle, status.worktreePath);

		const actions = append(head, $('.volt-worktree-setup-actions'));
		if (status.phase === 'running') {
			this.button(actions, localize('voltWorktreeSetup.cancel', "Cancel"), () => void this.setup.cancel(status.chatId));
		} else if (status.phase === 'failed' || status.phase === 'cancelled') {
			this.button(actions, localize('voltWorktreeSetup.retry', "Retry"), () => this.delegate.onRetry(status.chatId), true);
		}
		if (status.phase !== 'running') {
			const close = append(actions, $('button.volt-worktree-setup-close')) as HTMLButtonElement;
			close.type = 'button';
			close.setAttribute('aria-label', localize('voltWorktreeSetup.dismiss', "Dismiss"));
			close.appendChild(renderIcon(Codicon.close));
			this.renderStore.add(addDisposableListener(close, 'click', () => this.setup.dismiss(status.chatId)));
		}
		if (status.error && status.phase !== 'done') {
			append(this.element, $('.volt-worktree-setup-error')).textContent = status.error;
		}
	}

	private renderStep(list: HTMLElement, step: IWorktreeSetupStepStatus): void {
		const row = append(list, $(`.volt-worktree-setup-step.state-${step.state}`));
		const line = append(row, $('.volt-worktree-setup-step-line'));
		append(line, $('span.volt-worktree-setup-step-mark')).appendChild(renderIcon(stepIcon(step.state)));
		append(line, $('span.volt-worktree-setup-step-label')).textContent = step.label;
		if (step.async) {
			append(line, $('span.volt-worktree-setup-step-badge')).textContent = localize('voltWorktreeSetup.background', "background");
		}
		if (step.startedAt !== undefined) {
			append(line, $('span.volt-worktree-setup-step-time')).textContent = formatElapsed((step.endedAt ?? Date.now()) - step.startedAt);
		}
		if (step.command !== step.label) {
			append(row, $('code.volt-worktree-setup-step-command')).textContent = step.command;
		}
		if (step.tail && (step.state === 'running' || step.state === 'failed')) {
			append(row, $('pre.volt-worktree-setup-step-output')).textContent = step.tail;
		}
	}

	private button(parent: HTMLElement, label: string, run: () => void, primary = false): void {
		const button = append(parent, $(`button.volt-worktree-setup-button${primary ? '.primary' : ''}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		this.renderStore.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
	}

	/** Running: the clocks tick. Done: the card folds away after a moment. */
	private syncTimers(status: IWorktreeSetupStatus): void {
		const win = getWindow(this.element);
		if (status.phase === 'running') {
			if (!this.ticker.value) {
				const timer = win.setInterval(() => this.render(), 1_000);
				this.ticker.value = { dispose: () => win.clearInterval(timer) };
			}
		} else {
			this.ticker.clear();
		}
		if (status.phase === 'done' && !this.linger.value) {
			const chatId = status.chatId;
			const timer = win.setTimeout(() => this.setup.dismiss(chatId), DONE_LINGER_MS);
			this.linger.value = { dispose: () => win.clearTimeout(timer) };
		}
	}
}

function phaseIcon(phase: IWorktreeSetupStatus['phase']): ThemeIcon {
	switch (phase) {
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'done': return Codicon.passFilled;
		case 'failed': return Codicon.error;
		case 'cancelled': return Codicon.circleSlash;
	}
}

function stepIcon(state: IWorktreeSetupStepStatus['state']): ThemeIcon {
	switch (state) {
		case 'pending': return Codicon.circleLargeOutline;
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'done': return Codicon.check;
		case 'failed': return Codicon.close;
		case 'cancelled': return Codicon.circleSlash;
	}
}
