/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { parseRelayLink } from '../../../../../platform/voltRelay/common/relayLink.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentSchedule, IAgentScheduleService, usesWebhook } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { IAgentWebhookTrigger, planWebhookDelivery, webhookContext } from '../../../../services/voltRuntime/common/schedules/agentWebhooks.js';

export const VOLT_RELAY_CONNECT_COMMAND_ID = 'voltRelay.connect';
export const VOLT_RELAY_DISCONNECT_COMMAND_ID = 'voltRelay.disconnect';

const DRAIN_WAIT_MS = 25_000;
const RETRY_MS = 5_000;

/**
 * Keeps the relay and the direct local URL in step with the scheduled tasks that have a webhook,
 * and runs the deliveries that arrive: held by the relay while Volt was closed, or received on the
 * local URL. Each delivery runs at most once (a redelivery of a handled one answers with its thread).
 */
class AgentWebhookRelayContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWebhookRelay';

	private relayState: IVoltRelayState = { status: 'off' };
	private ready = false;
	private stopped = false;
	/** Relay hook id → what was last sent for it. */
	private readonly synced = new Map<string, string>();
	private relayChain: Promise<void> = Promise.resolve();

	constructor(
		@IAgentScheduleService private readonly schedules: IAgentScheduleService,
		@IVoltRelayService private readonly relay: IVoltRelayService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.stopped = true));
		this._register(schedules.onDidChange(() => this.sync()));
		this._register(relay.onDidChangeState(state => {
			this.relayState = state;
			this.sync();
		}));
		void this.start();
	}

	private hooked(): { readonly task: IAgentSchedule; readonly webhook: IAgentWebhookTrigger }[] {
		return this.schedules.list().flatMap(task => task.webhook && usesWebhook(task) ? [{ task, webhook: task.webhook }] : []);
	}

	private async start(): Promise<void> {
		await this.schedules.whenReady;
		this.relayState = await this.relay.getState();
		this.ready = true;
		this.sync();
		void this.drain();
	}

	private sync(): void {
		if (!this.ready) {
			return;
		}
		void this.syncLocalHooks();
		void this.syncRelayHooks();
	}

	private async syncLocalHooks(): Promise<void> {
		const hooks: IVoltLocalHook[] = this.hooked().filter(({ task }) => task.enabled).map(({ webhook }) => ({ hookId: webhook.id, token: webhook.localToken, signature: webhook.signature }));
		try {
			await this.relay.setLocalHooks(hooks);
		} catch (err) {
			this.logService.warn('[volt webhooks] local hooks not updated', err);
		}
	}

	private syncRelayHooks(): Promise<void> {
		this.relayChain = this.relayChain.then(() => this.pushRelayHooks()).catch(err => this.logService.warn('[volt webhooks] relay hooks not updated', err));
		return this.relayChain;
	}

	private async pushRelayHooks(): Promise<void> {
		const state = this.relayState;
		if (state.status !== 'online' || !state.relayId) {
			return;
		}
		const hooked = this.hooked();
		const current = new Set(hooked.map(({ webhook }) => webhook.id));
		for (const id of [...this.synced.keys()]) {
			if (!current.has(id)) {
				await this.relay.request('DELETE', `/hooks/${encodeURIComponent(id)}`);
				this.synced.delete(id);
			}
		}
		for (const { task, webhook } of hooked) {
			const hasUrl = !!webhook.relayUrl && webhook.relayId === state.relayId;
			const key = JSON.stringify({ enabled: task.enabled, name: task.title, signature: webhook.signature });
			if (hasUrl && this.synced.get(webhook.id) === key) {
				continue;
			}
			const reply = await this.relay.request<{ url?: string }>('PUT', `/hooks/${encodeURIComponent(webhook.id)}`, {
				name: task.title,
				enabled: task.enabled,
				signature: webhook.signature,
				...(hasUrl ? {} : { rotate: true }),
			});
			this.synced.set(webhook.id, key);
			const latest = this.schedules.get(task.id)?.webhook;
			if (reply.url && latest) {
				await this.schedules.update(task.id, { webhook: { ...latest, relayUrl: reply.url, relayId: state.relayId } });
			}
		}
	}

	private async drain(): Promise<void> {
		while (!this.stopped) {
			try {
				const delivery = await this.relay.nextDelivery(DRAIN_WAIT_MS);
				if (delivery) {
					await this.handle(delivery);
				}
			} catch (err) {
				this.logService.warn('[volt webhooks] delivery failed', err);
				await new Promise(resolve => setTimeout(resolve, RETRY_MS));
			}
		}
	}

	private async handle(delivery: IVoltHeldDelivery): Promise<void> {
		const task = this.hooked().find(({ webhook }) => webhook.id === delivery.hookId)?.task;
		if (!task) {
			await this.relay.ackDelivery(delivery.id, delivery.source, { status: 'failed', error: 'No scheduled task uses this hook.' });
			return;
		}
		const context = webhookContext({
			body: delivery.body,
			headers: delivery.headers,
			query: delivery.query,
			...(delivery.event ? { event: delivery.event } : {}),
			id: delivery.id,
			receivedAt: delivery.receivedAt,
			source: delivery.source,
			...(delivery.redeliveryOf ? { redeliveryOf: delivery.redeliveryOf } : {}),
		});
		const plan = planWebhookDelivery(task, context);
		let outcome: IVoltDeliveryOutcome;
		switch (plan.kind) {
			case 'off':
				outcome = { status: 'filtered', note: localize('voltWebhooks.off', "The task is turned off.") };
				break;
			case 'duplicate':
				outcome = { status: 'ran', ...(plan.threadId ? { threadId: plan.threadId } : {}) };
				break;
			case 'filtered':
				outcome = { status: 'filtered', note: plan.note };
				break;
			case 'unknown':
				outcome = { status: 'failed', error: localize('voltWebhooks.unknown', "No scheduled task uses this hook.") };
				break;
			case 'run': {
				const run = await this.schedules.runFromWebhook(task.id, {
					text: plan.text,
					display: plan.display,
					key: delivery.id,
					deliveryId: delivery.id,
					...(context.event ? { event: context.event } : {}),
					at: Date.now(),
				});
				outcome = run.status === 'failed' || run.status === 'skipped'
					? { status: 'failed', error: run.error }
					: { status: 'ran', ...(run.threadId ? { threadId: run.threadId } : {}), ...(run.status === 'queued' ? { note: localize('voltWebhooks.queued', "Queued behind the chat's current turn.") } : {}) };
				break;
			}
		}
		await this.relay.ackDelivery(delivery.id, delivery.source, outcome);
	}
}

registerWorkbenchContribution2(AgentWebhookRelayContribution.ID, AgentWebhookRelayContribution, WorkbenchPhase.AfterRestored);

/** Asks for a link from `volt-relay pair` (or a URL and a code) and connects this Volt to it. */
export async function connectVoltRelay(relay: IVoltRelayService, quickInput: IQuickInputService, notifications: INotificationService): Promise<IVoltRelayState | undefined> {
	const link = await quickInput.input({
		prompt: localize('voltRelay.linkPrompt', "Paste the link from volt-relay pair"),
		placeHolder: 'https://relay.example.com/#pair=ABCD-EFGH',
		ignoreFocusLost: true,
		validateInput: async value => parseRelayLink(value) ? undefined : localize('voltRelay.badLink', "That is not a relay link."),
	});
	if (!link) {
		return undefined;
	}
	try {
		const state = await relay.connect(link);
		notifications.info(localize('voltRelay.connected', "Connected to {0}.", state.relayName ?? state.url ?? 'Volt Relay'));
		return state;
	} catch (err) {
		notifications.error(localize('voltRelay.connectFailed', "Could not connect to the relay: {0}", err instanceof Error ? err.message : String(err)));
		return undefined;
	}
}

registerAction2(class ConnectVoltRelayAction extends Action2 {
	constructor() {
		super({
			id: VOLT_RELAY_CONNECT_COMMAND_ID,
			title: localize2('voltRelay.connectCommand', "Connect to Volt Relay…"),
			category: localize2('voltAgent.category', "Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await connectVoltRelay(accessor.get(IVoltRelayService), accessor.get(IQuickInputService), accessor.get(INotificationService));
	}
});

registerAction2(class DisconnectVoltRelayAction extends Action2 {
	constructor() {
		super({
			id: VOLT_RELAY_DISCONNECT_COMMAND_ID,
			title: localize2('voltRelay.disconnectCommand', "Disconnect from Volt Relay"),
			category: localize2('voltAgent.category', "Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltRelayService).disconnect();
	}
});
