/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Retry policies for Volt's durable work (resuming chats after a usage limit, scheduled
 * automations), shaped like Temporal's: an initial interval that grows by a coefficient up to a
 * ceiling, an attempt budget (0: retry until it works), and errors that are never worth retrying.
 * Pure: callers pass the attempt and any server hint; jitter comes from a key, not randomness, so
 * the decider and the tests see the same delays and workbenches that share a key agree.
 */

export interface IRetryPolicy {
	readonly initialIntervalMs: number;
	readonly backoffCoefficient: number;
	readonly maximumIntervalMs: number;
	/** Attempts in all, the first included. 0: unlimited. */
	readonly maximumAttempts: number;
	/** Share of the delay that may be added as jitter (0.1: up to 10% later). */
	readonly jitter?: number;
}

/** Five seconds, doubling, at most five minutes apart, five attempts: a run that failed to start. */
export const RUN_START_RETRY: IRetryPolicy = { initialIntervalMs: 5_000, backoffCoefficient: 2, maximumIntervalMs: 5 * 60_000, maximumAttempts: 5, jitter: 0.1 };

/** One minute, then growing to half an hour, with no attempt budget: waiting for a provider to come back. */
export const PROVIDER_BACK_RETRY: IRetryPolicy = { initialIntervalMs: 60_000, backoffCoefficient: 2, maximumIntervalMs: 30 * 60_000, maximumAttempts: 0, jitter: 0.1 };

/**
 * The delay before attempt `attempt + 1` after `attempt` attempts failed (attempt >= 1). A
 * server's `retry-after` hint wins when it is longer than the policy's delay; it is never cut short.
 */
export function retryDelay(policy: IRetryPolicy, attempt: number, options?: { readonly hintMs?: number; readonly key?: string }): number {
	const exponent = Math.max(0, attempt - 1);
	const base = Math.min(policy.maximumIntervalMs, policy.initialIntervalMs * (policy.backoffCoefficient ** exponent));
	const jittered = base + Math.floor(base * (policy.jitter ?? 0) * unitHash(`${options?.key ?? ''}#${attempt}`));
	const hint = options?.hintMs;
	return hint !== undefined && hint > jittered ? hint : jittered;
}

/** Another attempt is allowed after `attempt` attempts. */
export function retryAllowed(policy: IRetryPolicy, attempt: number): boolean {
	return policy.maximumAttempts <= 0 || attempt < policy.maximumAttempts;
}

/**
 * Failures no retry fixes: the account is signed out, the key is wrong, the model or the chat is
 * gone, the request itself is malformed. Everything else (network, overload, a crashed agent
 * process, timeouts) is worth another attempt.
 */
const NON_RETRYABLE = /\b(?:not (?:signed|logged) in|sign in|log ?in (?:again|required|to)|unauthori[sz]ed|authentication (?:failed|required|error)|invalid[_ ](?:api[_ ])?key|invalid x-api-key|permission[_ ]denied|forbidden|401\b|403\b|model[_ ]not[_ ]found|unknown model|no such model|invalid[_ ]request|not found: (?:thread|chat|session)|(?:chat|automation) (?:is gone|was deleted))/i;

export function isRetryableFailure(message: string | undefined): boolean {
	return !message || !NON_RETRYABLE.test(message);
}

/** A stable number in [0, 1) from a string (FNV-1a). */
export function unitHash(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) / 0x1_0000_0000;
}
