/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Counters for the Tab and composer predictions since the window opened, so the cost and the hit
 * rate can be read rather than guessed. Pure; nothing leaves the window.
 */

export interface IPredictionStats {
	/** Model requests that went out. */
	requests: number;
	/** Characters of prompt sent, and of reply read (about four per token). */
	promptChars: number;
	replyChars: number;
	/** Answered from what was already known: typed through a suggestion, or the same spot again. */
	instant: number;
	/** Answered by the local predictor with no model call (repeated lines, clipboard, history). */
	local: number;
	/** Requests the gate skipped as not worth their tokens. */
	gated: number;
	/** Requests replaced by a newer keystroke before they were sent: cost nothing. */
	replaced: number;
	/** Requests stopped mid-reply because the typing went another way. */
	aborted: number;
	/** Requests not made while a failing provider backs off. */
	backoff: number;
	/** Model suggestions shown, and taken with Tab. */
	shown: number;
	accepted: number;
	/** Time to the first usable text, summed over answered requests. */
	firstMsTotal: number;
	answered: number;
}

export type PredictionStatCounter = Exclude<keyof IPredictionStats, 'firstMsTotal' | 'answered'>;

export class PredictionStats {

	private readonly counts: IPredictionStats = {
		requests: 0, promptChars: 0, replyChars: 0, instant: 0, local: 0, gated: 0, replaced: 0,
		aborted: 0, backoff: 0, shown: 0, accepted: 0, firstMsTotal: 0, answered: 0,
	};

	bump(counter: PredictionStatCounter, by = 1): void {
		this.counts[counter] += by;
	}

	answeredIn(ms: number): void {
		this.counts.firstMsTotal += ms;
		this.counts.answered++;
	}

	snapshot(): IPredictionStats {
		return { ...this.counts };
	}
}

/** One paragraph for a notification. */
export function describeStats(stats: IPredictionStats): string {
	const served = stats.instant + stats.local;
	const asked = served + stats.requests;
	const free = asked ? Math.round(served / asked * 100) : 0;
	const avoided = stats.gated + stats.replaced + stats.backoff;
	const tokens = Math.round(stats.promptChars / 4);
	const perRequest = stats.requests ? Math.round(tokens / stats.requests) : 0;
	const latency = stats.answered ? Math.round(stats.firstMsTotal / stats.answered) : 0;
	const taken = stats.shown ? Math.round(stats.accepted / stats.shown * 100) : 0;
	return [
		`${asked} suggestions asked for: ${served} answered with no model call (${free}%), ${stats.requests} model requests.`,
		`${avoided} requests avoided (${stats.gated} skipped by the smart trigger, ${stats.replaced} replaced before sending, ${stats.backoff} during provider backoff); ${stats.aborted} cut short when the typing went elsewhere.`,
		`About ${tokens.toLocaleString()} prompt tokens sent (${perRequest} per request), first text after ${latency} ms on average.`,
		`${stats.accepted} of ${stats.shown} model suggestions taken (${taken}%).`,
	].join(' ');
}
