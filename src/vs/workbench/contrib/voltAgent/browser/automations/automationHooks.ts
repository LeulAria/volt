/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { parseRelayLink } from '../../../../../platform/voltRelay/common/relayLink.js';
import { IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAutomation, IAutomationService, IAutomationTrigger } from '../../../../services/voltRuntime/common/automations/automations.js';
import { compactPayload, eventLabel, matchAutomationEvent, providerLabel, summarizeAutomationEvent } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { describeWebhookDelivery, evaluateWebhookFilters, hasWebhookPlaceholders, IAgentWebhookTrigger, renderWebhookTemplate, webhookContext } from '../../../../services/voltRuntime/common/automations/automationWebhooks.js';

export const VOLT_RELAY_CONNECT_COMMAND_ID = 'voltRelay.connect';
export const VOLT_RELAY_DISCONNECT_COMMAND_ID = 'voltRelay.disconnect';

const DRAIN_WAIT_MS = 25_000;
const RETRY_MS = 5_000;

interface IHooked {
	readonly automation: IAutomation;
	readonly trigger: IAutomationTrigger;
	readonly hook: IAgentWebhookTrigger;
}

export function hookedTriggers(automations: readonly IAutomation[]): IHooked[] {
	return automations.flatMap(automation => automation.triggers.flatMap(trigger => trigger.provider !== 'schedule' && trigger.hook ? [{ automation, trigger, hook: trigger.hook }] : []));
}

/** The URL a sender posts to: the relay's while it is connected, else the direct local one. */
export function hookUrl(automation: IAutomation, hook: IAgentWebhookTrigger, relay: IVoltRelayState): string | undefined {
	const issued = automation.relayUrls?.[hook.id];
	if (issued && issued.relayId === relay.relayId) {
		return issued.url;
	}
	if (hook.relayUrl && (!hook.relayId || hook.relayId === relay.relayId)) {
		return hook.relayUrl;
	}
	return relay.localWebhookBase ? `${relay.localWebhookBase}/h/${hook.localToken}` : undefined;
}

/**
 * Keeps the relay and the direct local URL in step with the automations' event triggers (one
 * secret URL per trigger), and runs what arrives: held by the relay while Volt was closed, or
 * received on the local URL. A delivery is matched to its trigger's event (a merged pull request,
 * not any `pull_request`), filtered, and turned into a run whose prompt carries the event's facts.
 * Each delivery runs at most once; one that does not run is recorded as skipped, with why.
 */
class AutomationHooksContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAutomationHooks';

	private relayState: IVoltRelayState = { status: 'off' };
	private ready = false;
	private stopped = false;
	/** Relay hook id → what was last sent for it. */
	private readonly synced = new Map<string, string>();
	private relayChain: Promise<void> = Promise.resolve();
	private lastLocal = '';

	constructor(
		@IAutomationService private readonly automations: IAutomationService,
		@IVoltRelayService private readonly relay: IVoltRelayService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.stopped = true));
		this._register(automations.onDidChange(() => this.sync()));
		this._register(relay.onDidChangeState(state => {
			this.relayState = state;
			this.sync();
		}));
		// A sender whose signature did not match: shown in Run History so a wrong secret is found fast.
		this._register(relay.onDidEvent(event => {
			if (event.type !== 'local.rejected' || !event.data || typeof event.data !== 'object') {
				return;
			}
			const data = event.data as { hookId?: unknown; reason?: unknown; receivedAt?: unknown };
			const found = hookedTriggers(this.automations.list()).find(entry => entry.hook.id === data.hookId);
			if (found) {
				void this.automations.recordSkippedDelivery(found.automation.id, found.trigger.id, {
					deliveryId: `rej_${event.at}`,
					receivedAt: typeof data.receivedAt === 'number' ? data.receivedAt : event.at,
					label: eventLabel(found.trigger.provider, found.trigger.event),
					note: localize('voltAutomations.rejectedDelivery', "Refused: {0}", typeof data.reason === 'string' ? data.reason : localize('voltAutomations.badSignature', "bad signature")),
				});
			}
		}));
		void this.start();
	}

	private async start(): Promise<void> {
		await this.automations.whenReady;
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
		const hooks: IVoltLocalHook[] = hookedTriggers(this.automations.list())
			.filter(({ automation }) => automation.enabled)
			.map(({ hook }) => ({ hookId: hook.id, token: hook.localToken, signature: hook.signature }));
		// Skip the IPC round trip when nothing about the hooks changed (most changes are run updates).
		const key = JSON.stringify(hooks);
		if (key === this.lastLocal) {
			return;
		}
		this.lastLocal = key;
		try {
			await this.relay.setLocalHooks(hooks);
		} catch (err) {
			this.lastLocal = '';
			this.logService.warn('[volt automations] local hooks not updated', err);
		}
	}

	private syncRelayHooks(): Promise<void> {
		this.relayChain = this.relayChain.then(() => this.pushRelayHooks()).catch(err => this.logService.warn('[volt automations] relay hooks not updated', err));
		return this.relayChain;
	}

	private async pushRelayHooks(): Promise<void> {
		const state = this.relayState;
		if (state.status !== 'online' || !state.relayId) {
			return;
		}
		const hooked = hookedTriggers(this.automations.list());
		const current = new Set(hooked.map(({ hook }) => hook.id));
		for (const id of [...this.synced.keys()]) {
			if (!current.has(id)) {
				await this.relay.request('DELETE', `/hooks/${encodeURIComponent(id)}`).catch(() => undefined);
				this.synced.delete(id);
			}
		}
		for (const { automation, trigger, hook } of hooked) {
			const hasUrl = automation.relayUrls?.[hook.id]?.relayId === state.relayId || (!!hook.relayUrl && hook.relayId === state.relayId);
			const name = `${automation.name} · ${providerLabel(trigger.provider)}`;
			const key = JSON.stringify({ enabled: automation.enabled, name, signature: hook.signature, holdOffline: hook.holdOffline !== false });
			if (hasUrl && this.synced.get(hook.id) === key) {
				continue;
			}
			const reply = await this.relay.request<{ url?: string }>('PUT', `/hooks/${encodeURIComponent(hook.id)}`, {
				name,
				enabled: automation.enabled,
				signature: hook.signature,
				holdOffline: hook.holdOffline !== false,
				...(hasUrl ? {} : { rotate: true }),
			});
			this.synced.set(hook.id, key);
			if (reply.url) {
				await this.automations.setRelayUrl(automation.id, hook.id, reply.url, state.relayId);
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
				this.logService.warn('[volt automations] delivery failed', err);
				await new Promise(resolve => setTimeout(resolve, RETRY_MS));
			}
		}
	}

	private async handle(delivery: IVoltHeldDelivery): Promise<void> {
		const found = hookedTriggers(this.automations.list()).find(entry => entry.hook.id === delivery.hookId);
		if (!found) {
			await this.relay.ackDelivery(delivery.id, delivery.source, { status: 'failed', error: 'No automation uses this hook.' });
			return;
		}
		const { automation, trigger, hook } = found;
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
		const what = describeWebhookDelivery(context);
		const label = [eventLabel(trigger.provider, trigger.event), what].filter(Boolean).join(' · ');
		const skip = async (note: string): Promise<IVoltDeliveryOutcome> => {
			await this.automations.recordSkippedDelivery(automation.id, trigger.id, { deliveryId: delivery.id, receivedAt: delivery.receivedAt, label, note });
			return { status: 'filtered', note };
		};
		let outcome: IVoltDeliveryOutcome;
		const match = matchAutomationEvent(trigger.provider, trigger.event, trigger.option, context);
		const filters = evaluateWebhookFilters(hook.filters, context);
		if (!automation.enabled) {
			outcome = await skip(localize('voltAutomations.inactive', "The automation is inactive."));
		} else if (!match.match) {
			outcome = await skip(match.reason ?? localize('voltAutomations.otherEvent', "Another event."));
		} else if (!filters.pass) {
			outcome = await skip(filters.reason ?? localize('voltAutomations.filtered', "A filter did not match."));
		} else {
			// The instructions' {{payload.…}} placeholders are filled in; otherwise the run gets the event's
			// facts (a few hundred bytes), and a generic webhook a pruned excerpt of its payload.
			const placeholders = hasWebhookPlaceholders(automation.instructions);
			const runs = await this.automations.runFromDelivery(automation.id, trigger.id, {
				deliveryId: delivery.id,
				receivedAt: delivery.receivedAt,
				label,
				instructions: placeholders ? renderWebhookTemplate(automation.instructions, context).text : automation.instructions,
				eventLines: summarizeAutomationEvent(trigger.provider, context),
				...(trigger.provider === 'webhook' && !placeholders ? { payload: compactPayload(context.payload) } : {}),
			});
			const failed = runs.find(run => run.status === 'failed');
			const threadId = runs.find(run => run.threadId)?.threadId;
			outcome = !runs.length
				? { status: 'failed', error: localize('voltAutomations.notRun', "The automation did not start a run.") }
				: failed && runs.every(run => run.status === 'failed')
					? { status: 'failed', ...(failed.error ? { error: failed.error } : {}) }
					: { status: 'ran', ...(threadId ? { threadId } : {}), ...(runs.some(run => run.status === 'queued') ? { note: localize('voltAutomations.queued', "Queued behind the chat's current turn.") } : {}) };
		}
		await this.relay.ackDelivery(delivery.id, delivery.source, outcome);
	}
}

registerWorkbenchContribution2(AutomationHooksContribution.ID, AutomationHooksContribution, WorkbenchPhase.AfterRestored);

let pendingRelayConnect: Promise<IVoltRelayState | undefined> | undefined;

/** Asks for a link from `volt-relay pair` (or a URL and a code) and connects this Volt to it. */
export function connectVoltRelay(relay: IVoltRelayService, quickInput: IQuickInputService, notifications: INotificationService): Promise<IVoltRelayState | undefined> {
	// One prompt at a time: a second click on Connect while the link is being pasted joins the first.
	pendingRelayConnect ??= askAndConnect(relay, quickInput, notifications).finally(() => pendingRelayConnect = undefined);
	return pendingRelayConnect;
}

async function askAndConnect(relay: IVoltRelayService, quickInput: IQuickInputService, notifications: INotificationService): Promise<IVoltRelayState | undefined> {
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
