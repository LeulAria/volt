/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentLimitBanner.css';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { limitRecoveryView, nextLimitViewChange } from '../../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import type { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';

export interface IAgentLimitBannerServices {
	readonly orchestrator: Pick<IAgentOrchestratorService, 'getThread' | 'onDidChange' | 'setLimitRecovery'>;
	readonly history: { get(id: string): IAgentSessionMeta | undefined; readonly onDidChange: Event<void> };
}

/**
 * "Usage limit reached · Resets 4:10 AM · Snooze until reset · [Resume at reset]" above the
 * composer while the chat's last turn is stopped at the provider's limit, drawn as the queue card.
 * The agent window and the web app both use it; the orchestrator (on the agent server) does the resuming.
 */
export class AgentLimitBanner extends Disposable {

	readonly element: HTMLElement;
	private sessionId: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending = false;
	private error: string | undefined;

	constructor(private readonly services: IAgentLimitBannerServices) {
		super();
		this.element = $('.volt-agent-queue-card.volt-agent-limit-banner.hidden');
		this.element.setAttribute('role', 'status');
		this._register(services.orchestrator.onDidChange(change => {
			if (this.sessionId && change.threads.includes(this.sessionId)) {
				this.error = undefined;
				this.render();
			}
		}));
		this._register(services.history.onDidChange(() => this.render()));
		this._register({ dispose: () => this.clearTimer() });
	}

	setSession(sessionId: string | undefined): void {
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.error = undefined;
			this.render();
		}
	}

	render(): void {
		this.clearTimer();
		const thread = this.sessionId ? this.services.orchestrator.getThread(this.sessionId) : undefined;
		const limit = thread?.limit;
		this.element.classList.toggle('hidden', !limit || !!thread?.active);
		clearNode(this.element);
		if (!limit || thread?.active || !this.sessionId) {
			return;
		}
		const sessionId = this.sessionId;
		const now = Date.now();
		const view = limitRecoveryView(limit, now, this.services.history.get(sessionId));

		const head = append(this.element, $('.volt-agent-queue-head'));
		const title = append(head, $('span.volt-agent-queue-title.volt-agent-limit-banner-title'));
		title.appendChild(renderIcon(Codicon.dashboard));
		append(title, $('span')).textContent = view.title;
		const detail = append(head, $('span.volt-agent-queue-paused.volt-agent-limit-banner-detail'));
		detail.textContent = this.error ?? view.description;
		detail.classList.toggle('error', !!this.error);
		if (limit.message) {
			this.element.title = limit.message;
		}

		if (view.canSchedule) {
			const actions = append(head, $('.volt-agent-queue-head-actions'));
			// Snooze is a text button like the queue's; resuming is the card's one primary action.
			const button = (label: string, run: () => Promise<string | undefined>, active: boolean, primary: boolean) => {
				const el = append(actions, $(primary ? 'button.volt-agent-limit-banner-primary' : 'button.volt-agent-queue-text-btn')) as HTMLButtonElement;
				el.type = 'button';
				el.textContent = this.pending ? localize('voltAgent.limit.saving', "Saving…") : label;
				el.disabled = this.pending;
				el.setAttribute('aria-pressed', String(active));
				el.addEventListener('click', async e => {
					e.preventDefault();
					this.pending = true;
					this.render();
					try {
						this.error = await run();
					} catch (err) {
						this.error = err instanceof Error ? err.message : localize('voltAgent.limit.failed', "Could not change limit recovery.");
					}
					this.pending = false;
					this.render();
				});
			};
			if (!view.resetPassed) {
				button(view.snoozeLabel, () => this.services.orchestrator.setLimitRecovery(sessionId, limit.turnId, { snooze: !view.snoozed }), view.snoozed, false);
			}
			button(view.resumeLabel, () => this.services.orchestrator.setLimitRecovery(sessionId, limit.turnId, { autoResume: !view.autoResume }), view.autoResume, true);
		}

		// The countdown ticks by the minute and the buttons change at the reset.
		const next = nextLimitViewChange(limit, now);
		if (next !== undefined) {
			this.timer = setTimeout(() => this.render(), next - now);
		}
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
