/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyPlan, type ActivityAction, type ITrackedActivity } from './planner.ts';

// Carries a plan out against the platform (ActivityKit through the native module, or a fake in tests).
// Returns the tracked list the next plan starts from: ids of activities iOS just started are added.

export type StartAction = Extract<ActivityAction, { readonly kind: 'start' }>;
export type UpdateAction = Extract<ActivityAction, { readonly kind: 'update' }>;
export type EndAction = Extract<ActivityAction, { readonly kind: 'end' }>;

export interface IActivityHost {
	/** The new activity's id, or undefined when the system refused it. */
	start(action: StartAction): Promise<string | undefined>;
	update(action: UpdateAction): Promise<void>;
	end(action: EndAction): Promise<void>;
}

export async function runPlan(tracked: readonly ITrackedActivity[], actions: readonly ActivityAction[], host: IActivityHost, now: number): Promise<ITrackedActivity[]> {
	const started: ITrackedActivity[] = [];
	for (const action of actions) {
		if (action.kind === 'start') {
			const activityId = await host.start(action);
			if (activityId) {
				started.push({ activityId, chatId: action.chatId, state: action.state, sentAt: now });
			}
		} else if (action.kind === 'update') {
			await host.update(action);
		} else {
			await host.end(action);
		}
	}
	return [...applyPlan(tracked, actions, now), ...started];
}
