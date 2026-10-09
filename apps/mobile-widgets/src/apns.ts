/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IActivityAlert } from './planner.ts';
import type { IAgentActivityAttributes, IAgentActivityContentState } from './model.ts';

// The contract between the app and whatever pushes Live Activity updates while the app is in the
// background (the agent server itself, or a relay it forwards to).
//
// 1. The app registers tokens with the agent server over the existing socket:
//      call `liveActivity.register` [ILiveActivityTokenRegistration]
//      call `liveActivity.unregister` [{ deviceId, activityId? }]   (activityId absent: every token of the device)
//    `kind: 'activity'` is one running activity's update token (ActivityKit `pushTokenUpdates`).
//    `kind: 'pushToStart'` (iOS 17.2+) lets the server start an activity when a turn begins while
//    the app is closed (`Activity.pushToStartTokenUpdates`). Tokens rotate; the app re-registers.
// 2. The server sends APNs requests built by `liveActivityPush` below:
//      POST https://api(.sandbox).push.apple.com/3/device/<token>
//      apns-push-type: liveactivity
//      apns-topic: <bundleId>.push-type.liveactivity
//      apns-priority: 5 (routine step updates) | 10 (phase changes, alerts, end)
//    with the same content state the app sends locally (src/model.ts), so one Swift decoder reads
//    both. Server-side logic that decides when to push is `planActivities` (src/planner.ts).

export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'VoltActivityAttributes';

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ILiveActivityTokenRegistration {
	/** Stable per install (the app keeps it in secure storage). */
	readonly deviceId: string;
	readonly bundleId: string;
	readonly environment: ApnsEnvironment;
	readonly kind: 'activity' | 'pushToStart';
	/** Hex APNs token. */
	readonly token: string;
	/** `activity`: which activity and chat the token updates. */
	readonly activityId?: string;
	readonly chatId?: string;
	/** Unix seconds. */
	readonly registeredAt: number;
}

export const REGISTER_METHOD = 'liveActivity.register';
export const UNREGISTER_METHOD = 'liveActivity.unregister';

export type LiveActivityPushEvent = 'start' | 'update' | 'end';

export interface ILiveActivityPushInput {
	readonly event: LiveActivityPushEvent;
	readonly state: IAgentActivityContentState;
	/** Unix seconds; APNs drops a push older than the last one applied. */
	readonly timestamp: number;
	/** Unix seconds after which the activity is drawn stale. */
	readonly staleAt?: number;
	/** `end`: when the ended activity leaves the Lock Screen (Unix seconds; 0 = now). */
	readonly dismissAt?: number;
	readonly relevance?: number;
	/** Lights the screen and expands the Dynamic Island. */
	readonly alert?: IActivityAlert;
	/** `start`: the activity's attributes (push-to-start). */
	readonly attributes?: IAgentActivityAttributes;
}

export interface IApnsRequest {
	readonly headers: Record<string, string>;
	readonly payload: { readonly aps: Record<string, unknown> };
}

/** The APNs request for one Live Activity push. */
export function liveActivityPush(bundleId: string, input: ILiveActivityPushInput): IApnsRequest {
	const urgent = input.event !== 'update' || !!input.alert || input.state.phase === 'input';
	const aps: Record<string, unknown> = {
		timestamp: Math.floor(input.timestamp),
		event: input.event,
		'content-state': input.state,
	};
	if (input.staleAt !== undefined && input.event !== 'end') {
		aps['stale-date'] = Math.floor(input.staleAt);
	}
	if (input.event === 'end') {
		aps['dismissal-date'] = Math.floor(input.dismissAt ?? input.timestamp);
	}
	if (input.relevance !== undefined) {
		aps['relevance-score'] = input.relevance;
	}
	if (input.event === 'start') {
		if (!input.attributes) {
			throw new Error('A push-to-start needs the activity attributes.');
		}
		aps['attributes-type'] = LIVE_ACTIVITY_ATTRIBUTES_TYPE;
		aps.attributes = input.attributes;
		// iOS 18: the started activity reports its own update token to the app.
		aps['input-push-token'] = 1;
	}
	const alert = input.alert ?? (input.event === 'start' ? { title: input.state.title, body: input.state.step } : undefined);
	if (alert) {
		aps.alert = { title: alert.title, body: alert.body, sound: 'default' };
	}
	return {
		headers: {
			'apns-push-type': 'liveactivity',
			'apns-topic': `${bundleId}.push-type.liveactivity`,
			'apns-priority': urgent ? '10' : '5',
			'apns-expiration': String(Math.floor(input.timestamp) + 60 * 60),
		},
		payload: { aps },
	};
}

export function isTokenRegistration(value: unknown): value is ILiveActivityTokenRegistration {
	const v = value as Partial<ILiveActivityTokenRegistration> | undefined;
	return !!v && typeof v === 'object'
		&& typeof v.deviceId === 'string' && v.deviceId.length > 0
		&& typeof v.bundleId === 'string' && v.bundleId.length > 0
		&& (v.environment === 'sandbox' || v.environment === 'production')
		&& (v.kind === 'activity' || v.kind === 'pushToStart')
		&& typeof v.token === 'string' && /^[0-9a-f]{32,256}$/i.test(v.token)
		&& (v.kind === 'pushToStart' || (typeof v.activityId === 'string' && typeof v.chatId === 'string'));
}
