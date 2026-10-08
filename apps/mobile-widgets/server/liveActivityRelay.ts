/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentChatView } from '../src/agentState.ts';
import { isTokenRegistration, liveActivityPush, type ApnsEnvironment, type IApnsRequest, type ILiveActivityTokenRegistration } from '../src/apns.ts';
import { DEFAULT_PLAN_OPTIONS, planActivities, type IPlanOptions, type ITrackedActivity } from '../src/planner.ts';
import { toSeconds } from '../src/model.ts';

// The agent server's half of Live Activities: keeps the tokens phones registered and, whenever the
// chats change, pushes the same start/update/end decisions the app makes locally. Devices whose
// app is open drive their activities themselves, so they are skipped until the app goes away.
//
// Wiring in the agent server (serverApi.ts):
//   const relay = new LiveActivityPushRelay({ send: (t, env, req) => apns.send(t, env, req) });
//   protocol.registerMethod('liveActivity.register', (ctx, reg) => relay.register(reg, ctx.client.connectionId));
//   protocol.registerMethod('liveActivity.unregister', (_ctx, arg) => relay.unregister(arg));
//   protocol.onDidChangeClients(() => relay.setForeground(new Set(<connection ids of mobile clients>)));
//   on orchestrator/history/edits/runtime changes (debounced): relay.update(<chat views>)

export interface IRelayTransport {
	send(token: string, environment: ApnsEnvironment, request: IApnsRequest): Promise<{ readonly status: number; readonly reason?: string }>;
}

export interface IRelayOptions extends IRelayTransport {
	readonly now?: () => number;
	readonly plan?: IPlanOptions;
	readonly server?: string;
	/** A push-to-start not followed by the activity's own token within this long may be retried. */
	readonly startRetryMs?: number;
}

interface IDevice {
	readonly deviceId: string;
	bundleId: string;
	environment: ApnsEnvironment;
	pushToStart?: string;
	/** Connection that registered last; while it is connected the app drives its activities. */
	connectionId?: string;
	readonly activities: Map<string, { token: string; tracked: ITrackedActivity }>;
	/** chatId → when a push-to-start went out. */
	readonly starting: Map<string, number>;
}

export interface IRelayDelivery {
	readonly deviceId: string;
	readonly kind: 'start' | 'update' | 'end';
	readonly chatId: string;
	readonly status: number;
	readonly reason?: string;
}

function dead(result: { readonly status: number; readonly reason?: string }): boolean {
	return result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered';
}

export class LiveActivityPushRelay {

	private readonly devices = new Map<string, IDevice>();
	private foreground = new Set<string>();
	private readonly now: () => number;
	private readonly plan: IPlanOptions;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly options: IRelayOptions;

	constructor(options: IRelayOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.plan = options.plan ?? DEFAULT_PLAN_OPTIONS;
	}

	register(value: unknown, connectionId?: string): boolean {
		if (!isTokenRegistration(value)) {
			throw new Error('Invalid Live Activity token registration.');
		}
		const registration: ILiveActivityTokenRegistration = value;
		let device = this.devices.get(registration.deviceId);
		if (!device) {
			device = { deviceId: registration.deviceId, bundleId: registration.bundleId, environment: registration.environment, activities: new Map(), starting: new Map() };
			this.devices.set(registration.deviceId, device);
		}
		device.bundleId = registration.bundleId;
		device.environment = registration.environment;
		if (connectionId) {
			device.connectionId = connectionId;
		}
		if (registration.kind === 'pushToStart') {
			device.pushToStart = registration.token;
			return true;
		}
		const activityId = registration.activityId!;
		const chatId = registration.chatId!;
		device.starting.delete(chatId);
		const existing = device.activities.get(activityId);
		device.activities.set(activityId, {
			token: registration.token,
			// Until the first push the relay doesn't know what the phone shows: an empty state forces an update.
			tracked: existing?.tracked ?? { activityId, chatId, state: { phase: 'working', title: '', step: '', startedAt: 0, filesChanged: 0, queued: 0, subagents: 0, others: 0, updatedAt: 0 }, sentAt: 0 },
		});
		return true;
	}

	unregister(value: unknown): void {
		const arg = value as { deviceId?: unknown; activityId?: unknown } | undefined;
		if (!arg || typeof arg.deviceId !== 'string') {
			return;
		}
		const device = this.devices.get(arg.deviceId);
		if (!device) {
			return;
		}
		if (typeof arg.activityId === 'string') {
			device.activities.delete(arg.activityId);
		} else {
			this.devices.delete(arg.deviceId);
		}
	}

	/** Connection ids of the mobile apps connected now: their devices drive activities locally. */
	setForeground(connectionIds: ReadonlySet<string>): void {
		this.foreground = new Set(connectionIds);
	}

	/** Pushes whatever the chats' new state calls for. Serialized; resolves with what was sent. */
	update(views: readonly IAgentChatView[]): Promise<IRelayDelivery[]> {
		const run = this.chain.then(() => this.push(views));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async push(views: readonly IAgentChatView[]): Promise<IRelayDelivery[]> {
		const deliveries: IRelayDelivery[] = [];
		const now = this.now();
		for (const device of [...this.devices.values()]) {
			if (device.connectionId && this.foreground.has(device.connectionId)) {
				continue;
			}
			const tracked = [...device.activities.values()].map(entry => entry.tracked);
			const { actions } = planActivities(tracked, views, now, this.plan, this.options.server);
			for (const action of actions) {
				if (action.kind === 'start') {
					const startedAt = device.starting.get(action.chatId);
					if (!device.pushToStart || (startedAt !== undefined && now - startedAt < (this.options.startRetryMs ?? 60_000))) {
						continue;
					}
					device.starting.set(action.chatId, now);
					const request = liveActivityPush(device.bundleId, { event: 'start', state: action.state, attributes: action.attributes, timestamp: toSeconds(now), staleAt: action.staleAt, relevance: action.relevance });
					const result = await this.options.send(device.pushToStart, device.environment, request);
					deliveries.push({ deviceId: device.deviceId, kind: 'start', chatId: action.chatId, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
					if (dead(result)) {
						device.pushToStart = undefined;
					}
					continue;
				}
				const entry = device.activities.get(action.activityId);
				if (!entry) {
					continue;
				}
				const request = action.kind === 'update'
					? liveActivityPush(device.bundleId, { event: 'update', state: action.state, timestamp: toSeconds(now), staleAt: action.staleAt, relevance: action.relevance, ...(action.alert ? { alert: action.alert } : {}) })
					: liveActivityPush(device.bundleId, { event: 'end', state: action.state ?? entry.tracked.state, timestamp: toSeconds(now), dismissAt: action.dismissAt, ...(action.alert ? { alert: action.alert } : {}) });
				const result = await this.options.send(entry.token, device.environment, request);
				deliveries.push({ deviceId: device.deviceId, kind: action.kind, chatId: action.chatId, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
				if (action.kind === 'end' || dead(result)) {
					device.activities.delete(action.activityId);
				} else if (result.status === 200) {
					entry.tracked = { ...entry.tracked, state: action.state, sentAt: now };
				}
			}
		}
		return deliveries;
	}

	/** For persistence and tests. */
	snapshot(): { readonly deviceId: string; readonly pushToStart: boolean; readonly activities: readonly { readonly activityId: string; readonly chatId: string }[] }[] {
		return [...this.devices.values()].map(device => ({
			deviceId: device.deviceId,
			pushToStart: !!device.pushToStart,
			activities: [...device.activities.values()].map(entry => ({ activityId: entry.tracked.activityId, chatId: entry.tracked.chatId })),
		}));
	}
}
