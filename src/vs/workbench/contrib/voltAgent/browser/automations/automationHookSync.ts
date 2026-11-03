/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IAutomation, IAutomationService, IAutomationTrigger } from '../../../../services/voltRuntime/common/automations/automations.js';
import { compactPayload, eventLabel, matchAutomationEvent, providerLabel, summarizeAutomationEvent } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { describeWebhookDelivery, evaluateWebhookFilters, hasWebhookPlaceholders, IAgentWebhookTrigger, renderWebhookTemplate, webhookContext } from '../../../../services/voltRuntime/common/automations/automationWebhooks.js';

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
 *
 * DOM-free: the agent server runs it when it holds the relay (webhooks then run with no window
 * open); otherwise a window does.
 */
export class AutomationHookSync extends Disposable {

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
