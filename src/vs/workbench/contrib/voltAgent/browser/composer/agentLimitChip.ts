/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentTerminals.css';
import '../media/agentLimitChip.css';
import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ILimitChipView, limitChipView, limitParkedClock, nextBannerTick } from '../../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import { IAgentOrchestratorService, IOrchThread } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { rescueChipView, rescueWaits } from '../../../../services/voltRuntime/common/orchestration/rescue.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentLimitChipHost {
	/** The chat on screen. */
	chatId(): string | undefined;
	/** Opens the model picker under the chip (move the chat to a model that is not limited). */
	switchModel(anchor: HTMLElement): void;
}

type LimitAction = 'arm' | 'disarm' | 'resume' | 'stop' | 'switch';

/**
 * The chat's usage-limit state as a chip at the top of the chat, beside its terminals:
 *
 * - "Claude limit · resets 3:40 PM" with "Resume when Claude is back": nothing is sent on the
 *   account until the user asks (Claude stops at its limit by default). One click arms it.
 * - "Claude limit · resumes 3:40 PM · 1h 12m": armed. Volt continues the chat on its own once
 *   the provider answers again, checking with a growing back-off when no reset is known, and
 *   never gives up while armed.
 * - "Checking if Claude is back…": a resume is out; the park holds until the provider answers.
 * - "Couldn't reach Claude · retrying 3:12 PM": the resume failed for another reason (network,
 *   the agent process); it is retried, the park is kept.
 *
 * The menu has Resume now, Stop waiting, and Switch model.
 */
export class AgentLimitChip extends Disposable {

	readonly element: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private timer: ReturnType<typeof setTimeout> | undefined;
	private error: string | undefined;
	private shownFor: string | undefined;

	constructor(
		private readonly host: IAgentLimitChipHost,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.element = $('.volt-agent-terminal-bar.volt-agent-limit-bar.hidden');
		this.element.setAttribute('role', 'status');
		this.element.setAttribute('aria-live', 'polite');
		this._register(this.orchestrator.onDidChange(change => {
			const chatId = this.host.chatId();
			if (chatId && change.threads.includes(chatId)) {
				this.render();
			}
		}));
		this._register({ dispose: () => this.clearTimer() });
		this.render();
	}

	render(): void {
		this.clearTimer();
		this.renderStore.clear();
		this.element.replaceChildren();
		const chatId = this.host.chatId();
		if (chatId !== this.shownFor) {
			this.shownFor = chatId;
			this.error = undefined;
		}
		const thread = chatId ? this.orchestrator.getThread(chatId) : undefined;
		const limit = thread?.limit;
		const checking = !!limit && thread?.active?.limitProbe !== undefined;
		const visible = !!chatId && !!limit && (!thread?.active || checking);
		// Without a usage limit, the chip says when Volt restarts work that stopped part way.
		const restarting = !visible && !!chatId && !!thread && this.orchestrator.keepsWorking() && rescueWaits(thread);
		this.element.classList.toggle('hidden', !visible && !restarting);
		if (restarting) {
			this.renderRescue(chatId, thread);
			return;
		}
		if (!chatId || !limit || !visible) {
			return;
		}

		const now = Date.now();
		const clock = limitParkedClock(limit, this.orchestrator.autoResumeDefault(), now);
		const view = limitChipView(limit, { now, auto: clock.auto, checking });

		const chip = append(this.element, $(`.volt-agent-terminal-chip.volt-agent-limit-chip.${view.tone}`));
		const main = append(chip, $('button.volt-agent-terminal-chip-main')) as HTMLButtonElement;
		main.type = 'button';
		main.appendChild(chipIcon(view));
		append(main, $('span.label')).textContent = this.error ?? view.label;
		if (view.detail && !this.error) {
			append(main, $('span.detail')).textContent = view.detail;
		}
		if (view.primary === 'arm' && !this.error) {
			append(main, $('span.volt-agent-limit-chip-arm')).textContent = view.armLabel;
		}
		setAgentTooltip(main, view.tooltip);
		main.setAttribute('aria-label', [view.label, view.detail, view.primary === 'arm' ? view.armLabel : undefined].filter(Boolean).join(', '));
		this.renderStore.add(addDisposableListener(main, 'click', e => {
			EventHelper.stop(e, true);
			if (view.primary === 'arm') {
				void this.act(chatId, 'arm', main);
			} else {
				this.openMenu(chatId, chip, view);
			}
		}));

		const more = append(chip, $('button.volt-agent-terminal-chip-more')) as HTMLButtonElement;
		more.type = 'button';
		more.setAttribute('aria-haspopup', 'menu');
		more.appendChild(renderIcon(Codicon.chevronDown));
		setAgentTooltip(more, localize('voltAgent.limitChip.more', "Usage limit options"));
		this.renderStore.add(addDisposableListener(more, 'click', e => {
			EventHelper.stop(e, true);
			this.openMenu(chatId, more, view);
		}));

		// The countdown moves by the minute; the chip re-reads the state when it is due.
		const next = view.dueAt !== undefined ? nextBannerTick(view.dueAt, now) : undefined;
		if (next !== undefined) {
			this.timer = setTimeout(() => this.render(), next - now);
		}
	}

	/** "Stopped by an error · restarting 3:12 PM · 4m", with Retry now and Stop retrying. */
	private renderRescue(chatId: string, thread: IOrchThread): void {
		const now = Date.now();
		const view = rescueChipView(thread.rescue!, thread.id, now);
		const chip = append(this.element, $('.volt-agent-terminal-chip.volt-agent-limit-chip.armed'));
		const main = append(chip, $('button.volt-agent-terminal-chip-main')) as HTMLButtonElement;
		main.type = 'button';
		const icon = append(main, $('span.volt-agent-terminal-status.volt-agent-limit-chip-icon'));
		icon.appendChild(renderIcon(view.dueAt > now ? Codicon.history : ThemeIcon.modify(Codicon.loading, 'spin')));
		append(main, $('span.label')).textContent = this.error ?? view.label;
		if (view.detail && !this.error) {
			append(main, $('span.detail')).textContent = view.detail;
		}
		setAgentTooltip(main, view.tooltip);
		main.setAttribute('aria-label', [view.label, view.detail].filter(Boolean).join(', '));
		const open = (anchor: HTMLElement) => showVoltMenu<'now' | 'stop'>(this.contextViewService, {
			anchor,
			position: 'below',
			align: 'left',
			width: 320,
			ariaLabel: localize('voltAgent.rescueChip.menu', "Restart"),
			className: 'volt-agent-terminal-menu',
			sections: [{
				id: 'rescue',
				title: thread.rescue!.error,
				items: [
					{ id: 'now', label: localize('voltAgent.rescueChip.now', "Retry now"), subtitle: localize('voltAgent.rescueChip.nowDetail', "Restart the chat now instead of waiting"), icon: Codicon.debugContinue, data: 'now' },
					{ id: 'stop', label: localize('voltAgent.rescueChip.stop', "Stop retrying"), subtitle: localize('voltAgent.rescueChip.stopDetail', "The chat waits for you instead"), icon: Codicon.circleSlash, data: 'stop' },
				],
			}],
			onPick: async item => {
				this.error = undefined;
				const events = await this.orchestrator.dispatch(item.data === 'now' ? { type: 'rescue.now', threadId: chatId } : { type: 'rescue.stop', threadId: chatId });
				if (item.data === 'now' && !events.length) {
					this.error = localize('voltAgent.rescueChip.cannot', "This chat cannot restart right now");
				}
				this.render();
			},
		});
		this.renderStore.add(addDisposableListener(main, 'click', e => {
			EventHelper.stop(e, true);
			open(chip);
		}));
		const more = append(chip, $('button.volt-agent-terminal-chip-more')) as HTMLButtonElement;
		more.type = 'button';
		more.setAttribute('aria-haspopup', 'menu');
		more.appendChild(renderIcon(Codicon.chevronDown));
		setAgentTooltip(more, localize('voltAgent.rescueChip.more', "Restart options"));
		this.renderStore.add(addDisposableListener(more, 'click', e => {
			EventHelper.stop(e, true);
			open(more);
		}));
		const next = nextBannerTick(view.dueAt, now);
		if (next !== undefined) {
			this.timer = setTimeout(() => this.render(), next - now);
		}
	}

	private openMenu(chatId: string, anchor: HTMLElement, view: ILimitChipView): void {
		const items: IVoltMenuItem<LimitAction>[] = [];
		if (view.tone === 'checking') {
			items.push({ id: 'stop', label: localize('voltAgent.limitChip.stopChecking', "Stop checking"), subtitle: localize('voltAgent.limitChip.stopCheckingDetail', "Stops the resume that is waiting for an answer"), icon: Codicon.debugStop, data: 'stop' });
		} else {
			if (view.auto) {
				items.push({ id: 'disarm', label: localize('voltAgent.limitChip.disarm', "Stop waiting"), subtitle: localize('voltAgent.limitChip.disarmDetail', "Nothing is sent until you resume the chat yourself"), icon: Codicon.circleSlash, data: 'disarm' });
			} else {
				items.push({ id: 'arm', label: view.armLabel, subtitle: localize('voltAgent.limitChip.armDetail', "Volt keeps checking and continues this chat once it answers"), icon: Codicon.history, data: 'arm' });
			}
			items.push({ id: 'resume', label: localize('voltAgent.limitChip.resumeNow', "Resume now"), subtitle: localize('voltAgent.limitChip.resumeNowDetail', "Try once more now; if the limit holds the chat waits again"), icon: Codicon.debugContinue, data: 'resume' });
		}
		items.push({ id: 'switch', label: localize('voltAgent.limitChip.switch', "Switch model…"), subtitle: localize('voltAgent.limitChip.switchDetail', "Continue on a model that is not limited"), icon: Codicon.arrowSwap, data: 'switch' });
		showVoltMenu<LimitAction>(this.contextViewService, {
			anchor,
			position: 'below',
			align: 'left',
			width: 320,
			ariaLabel: localize('voltAgent.limitChip.menu', "Usage limit"),
			className: 'volt-agent-terminal-menu',
			sections: [{ id: 'limit', title: view.message, items }],
			onPick: item => this.act(chatId, item.data, anchor),
		});
	}

	private async act(chatId: string, action: LimitAction, anchor: HTMLElement): Promise<void> {
		this.error = undefined;
		switch (action) {
			case 'arm':
				await this.orchestrator.configureLimit(chatId, true);
				break;
			case 'disarm':
				await this.orchestrator.configureLimit(chatId, false);
				break;
			case 'resume': {
				const result = await this.orchestrator.resumeLimit(chatId);
				if (result.outcome === 'rejected') {
					this.error = result.reason ?? localize('voltAgent.limitChip.cannotResume', "This chat cannot resume right now");
				}
				break;
			}
			case 'stop':
				await this.orchestrator.cancel(chatId);
				break;
			case 'switch':
				this.host.switchModel(anchor);
				return;
		}
		this.render();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

function chipIcon(view: ILimitChipView): HTMLElement {
	const el = $('span.volt-agent-terminal-status.volt-agent-limit-chip-icon');
	switch (view.tone) {
		case 'checking':
			el.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			break;
		case 'error':
			el.appendChild(renderIcon(Codicon.warning));
			break;
		case 'armed':
			el.appendChild(renderIcon(Codicon.history));
			break;
		default:
			el.appendChild(renderIcon(Codicon.dashboard));
	}
	return el;
}
