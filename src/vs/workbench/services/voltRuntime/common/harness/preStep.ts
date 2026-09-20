/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeLoopMessage } from './nativeLoop.js';
import { repairTranscript } from './transcriptRepair.js';

/**
 * Pre-step waterfall (DeepSeek `agent/pre-step`). Listeners run before the model
 * is called. They may rewrite the transcript, start a new request series, or
 * reject the step so the turn closes without spending a provider call.
 *
 * Empty enter on step 0 is a reject: there is nothing to send.
 */

export type InboxTarget = 'step' | 'turn';

export type PreStepDecision =
	| { readonly kind: 'enter'; readonly messages: INativeLoopMessage[]; readonly startsSeries?: boolean }
	| { readonly kind: 'reject'; readonly reason: string };

export interface IPreStepContext {
	readonly messages: readonly INativeLoopMessage[];
	readonly claimed: readonly string[];
	readonly step: number;
	readonly target: InboxTarget;
}

export interface IPreStepListener {
	readonly name?: string;
	decide(ctx: IPreStepContext, next: () => PreStepDecision): PreStepDecision;
}

export function runPreStep(ctx: IPreStepContext, listeners: readonly IPreStepListener[] = defaultPreStepListeners()): PreStepDecision {
	const chain = listeners.reduceRight<() => PreStepDecision>(
		(next, listener) => () => listener.decide(ctx, next),
		() => enterDefault(ctx),
	);
	return chain();
}

export function defaultPreStepListeners(): IPreStepListener[] {
	return [rejectEmpty, repairPairs];
}

function enterDefault(ctx: IPreStepContext): PreStepDecision {
	return { kind: 'enter', messages: ctx.messages.slice(), startsSeries: ctx.target === 'turn' && ctx.claimed.length > 0 };
}

const rejectEmpty: IPreStepListener = {
	name: 'reject-empty',
	decide(ctx, next) {
		const hasUser = ctx.messages.some(message => message.role === 'user' && message.content.trim());
		if (!hasUser && ctx.step === 0 && !ctx.claimed.length) {
			return { kind: 'reject', reason: 'Nothing to send: the transcript has no user turn.' };
		}
		return next();
	},
};

const repairPairs: IPreStepListener = {
	name: 'repair-pairs',
	decide(ctx, next) {
		const decision = next();
		if (decision.kind !== 'enter') {
			return decision;
		}
		const repaired = repairTranscript(decision.messages);
		return repaired.changed ? { ...decision, messages: repaired.messages } : decision;
	},
};
