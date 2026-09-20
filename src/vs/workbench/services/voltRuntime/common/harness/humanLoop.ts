/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExecutionPlan, IReplanRequest, replan } from './plan.js';
import { TaskLifecycle, TaskPhase } from './lifecycle.js';

/**
 * Human-in-the-loop actions. The UI emits one of these; this module is the only place that
 * knows what each one does to the lifecycle and the plan. The runtime still performs the
 * side effects (cancel the token, inject the redirect text) - this returns the *intent*.
 */

export type HumanActionKind =
	| 'pause'
	| 'resume'
	| 'stop'
	| 'redirect'
	| 'approve'
	| 'deny'
	| 'edit-plan'
	| 'takeover';

export interface IHumanAction {
	readonly kind: HumanActionKind;
	readonly text?: string;
	readonly replan?: IReplanRequest;
	readonly requestId?: string;
}

export interface IHumanEffect {
	readonly kind: HumanActionKind;
	readonly phase?: TaskPhase;
	readonly plan?: IExecutionPlan;
	readonly inject?: string;
	readonly stop?: boolean;
	readonly takeover?: boolean;
	readonly approval?: { readonly requestId: string; readonly effect: 'allow' | 'deny' };
	readonly reason: string;
}

export function applyHumanAction(
	action: IHumanAction,
	life: TaskLifecycle,
	plan?: IExecutionPlan,
	now = Date.now(),
): IHumanEffect {
	switch (action.kind) {
		case 'pause': {
			const snap = life.tryTransition('paused', now);
			return { kind: action.kind, phase: life.current, reason: snap ? 'Paused.' : `Cannot pause from ${life.current}.` };
		}
		case 'resume': {
			try {
				const snap = life.resume(now);
				return { kind: action.kind, phase: snap.phase, reason: 'Resumed.' };
			} catch (error) {
				return { kind: action.kind, phase: life.current, reason: error instanceof Error ? error.message : String(error) };
			}
		}
		case 'stop': {
			const snap = life.tryTransition('cancelled', now);
			return { kind: action.kind, phase: life.current, stop: !!snap, reason: snap ? 'Stopped.' : `Cannot stop from ${life.current}.` };
		}
		case 'redirect':
			return {
				kind: action.kind,
				phase: life.current,
				inject: action.text?.trim() || undefined,
				reason: action.text?.trim() ? 'Redirected; the next turn will follow the new instruction.' : 'Redirect needs a new instruction.',
			};
		case 'approve':
			return {
				kind: action.kind,
				approval: { requestId: action.requestId ?? '', effect: 'allow' },
				reason: 'Approved.',
			};
		case 'deny':
			return {
				kind: action.kind,
				approval: { requestId: action.requestId ?? '', effect: 'deny' },
				reason: 'Denied.',
			};
		case 'edit-plan': {
			if (!plan || !action.replan) {
				return { kind: action.kind, reason: 'No plan to edit.' };
			}
			return { kind: action.kind, plan: replan(plan, action.replan), reason: 'Plan updated.' };
		}
		case 'takeover':
			life.tryTransition('paused', now);
			return { kind: action.kind, phase: life.current, takeover: true, stop: true, reason: 'You have the session.' };
	}
}
