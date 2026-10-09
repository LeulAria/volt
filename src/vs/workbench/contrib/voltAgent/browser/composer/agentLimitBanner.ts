/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentLimitBanner.css';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { limitBannerView, limitParkedClock, nextBannerTick } from '../../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import type { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';

export interface IAgentLimitBannerServices {
	readonly orchestrator: Pick<IAgentOrchestratorService, 'getThread' | 'onDidChange' | 'resumeLimit' | 'configureLimit' | 'autoResumeDefault'>;
	readonly switchModel: (anchor: HTMLElement) => void;
}

/**
 * "Usage limit reached · resumes at 3:40 PM (in 1h 12m)" above the composer while a chat is parked
 * at the provider's usage limit: Resume now, Cancel (or Resume at reset), Switch model.
 */
export class AgentLimitBanner extends Disposable {

	readonly element: HTMLElement;
	private sessionId: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private error: string | undefined;

	constructor(private readonly services: IAgentLimitBannerServices) {
		super();
		this.element = $('.volt-agent-queue-card.volt-agent-limit-banner.hidden');
		this.element.setAttribute('role', 'status');
		this._register(services.orchestrator.onDidChange(change => {
			if (this.sessionId && change.threads.includes(this.sessionId)) {
				this.render();
			}
		}));
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
		const sessionId = this.sessionId;
		const thread = sessionId ? this.services.orchestrator.getThread(sessionId) : undefined;
		const limit = thread?.limit;
		const visible = !!sessionId && !!limit && !thread?.active;
		this.element.classList.toggle('hidden', !visible);
		clearNode(this.element);
		if (!sessionId || !limit || !visible) {
			return;
		}

		const now = Date.now();
		const clock = limitParkedClock(limit, this.services.orchestrator.autoResumeDefault(), now);
		const auto = clock.auto;
		const view = limitBannerView(limit, now, auto);

		const head = append(this.element, $('.volt-agent-queue-head'));
		const title = append(head, $('span.volt-agent-queue-title.volt-agent-limit-banner-title'));
		title.appendChild(renderIcon(Codicon.dashboard));
		append(title, $('span')).textContent = view.title;
		const detail = append(head, $('span.volt-agent-queue-paused.volt-agent-limit-banner-detail'));
		detail.textContent = this.error ?? view.detail;
		detail.classList.toggle('error', !!this.error);
		this.element.title = limit.message ?? '';

		const actions = append(head, $('.volt-agent-queue-head-actions'));
		this.button(actions, localize('voltAgent.limit.resumeNow', "Resume now"), true, () => void this.resume(sessionId));
		this.button(actions, view.toggleLabel, false, () => void this.services.orchestrator.configureLimit(sessionId, !auto));
		this.button(actions, localize('voltAgent.limit.switchModel', "Switch model"), false, button => this.services.switchModel(button));

		// The countdown ticks by the minute, and the banner gives way once the reset passes.
		const next = nextBannerTick(clock.dueAt, now);
		if (next !== undefined) {
			this.timer = setTimeout(() => this.render(), next - now);
		}
	}

	private async resume(sessionId: string): Promise<void> {
		const result = await this.services.orchestrator.resumeLimit(sessionId);
		this.error = result.outcome === 'rejected' ? result.reason ?? localize('voltAgent.limit.cannotResume', "This chat cannot resume right now.") : undefined;
		this.render();
	}

	private button(parent: HTMLElement, label: string, primary: boolean, run: (button: HTMLElement) => void): void {
		const el = append(parent, $(primary ? 'button.volt-agent-limit-banner-primary' : 'button.volt-agent-queue-text-btn')) as HTMLButtonElement;
		el.type = 'button';
		el.textContent = label;
		el.addEventListener('click', e => {
			e.preventDefault();
			run(el);
		});
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
