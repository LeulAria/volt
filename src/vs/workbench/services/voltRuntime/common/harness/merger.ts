/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Result merger and consensus. Parallel workers each produce a claim about the same
 * question ("does this gate pass?", "which file owns this symbol?"). A clever merge of
 * two disagreed answers is how you ship a file nobody wrote - so consensus here is a
 * vote, not a synthesis.
 *
 *   agree      every voter said the same thing
 *   majority   a strict majority said the same thing; minorities are recorded
 *   conflict   no majority; the caller must not pretend there is an answer
 */

export type ConsensusKind = 'agree' | 'majority' | 'conflict';

export interface IWorkerResult<T = string> {
	readonly workerId: string;
	readonly value: T;
	readonly ok: boolean;
	readonly note?: string;
}

export interface IConsensus<T = string> {
	readonly kind: ConsensusKind;
	readonly value?: T;
	readonly votes: readonly IWorkerResult<T>[];
	readonly reason: string;
}

export function mergeResults<T>(results: readonly IWorkerResult<T>[], serialize: (value: T) => string = defaultSerialize): IConsensus<T> {
	if (!results.length) {
		return { kind: 'conflict', votes: [], reason: 'No worker produced a result.' };
	}

	const usable = results.filter(result => result.ok);
	if (!usable.length) {
		return { kind: 'conflict', votes: results, reason: 'Every worker failed.' };
	}

	const buckets = new Map<string, IWorkerResult<T>[]>();
	for (const result of usable) {
		const key = serialize(result.value);
		const list = buckets.get(key) ?? [];
		list.push(result);
		buckets.set(key, list);
	}

	const ranked = [...buckets.values()].sort((a, b) => b.length - a.length);
	const top = ranked[0];
	if (ranked.length === 1) {
		return { kind: 'agree', value: top[0].value, votes: results, reason: `All ${usable.length} workers agreed.` };
	}
	if (top.length > usable.length / 2) {
		return {
			kind: 'majority',
			value: top[0].value,
			votes: results,
			reason: `${top.length}/${usable.length} workers agreed; ${usable.length - top.length} dissented.`,
		};
	}
	return { kind: 'conflict', votes: results, reason: `No majority among ${usable.length} workers.` };
}

function defaultSerialize(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
