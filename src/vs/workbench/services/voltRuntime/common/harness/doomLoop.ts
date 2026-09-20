/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IToolCall } from '../tools/tool.js';

const DEFAULT_THRESHOLD = 3;

export interface IDoomLoopState {
	lastKey?: string;
	repeats: number;
}

export function toolCallKey(call: IToolCall): string {
	return `${call.name}\0${stableJson(call.args)}`;
}

export function batchKey(calls: readonly IToolCall[]): string {
	return calls.map(toolCallKey).join('\n');
}

/**
 * Three identical consecutive tool batches (same names + arguments) is a doom loop. The loop
 * asks the user instead of spinning.
 */
export function recordToolBatch(state: IDoomLoopState, calls: readonly IToolCall[], threshold = DEFAULT_THRESHOLD): { state: IDoomLoopState; looping: boolean } {
	if (!calls.length) {
		return { state: { repeats: 0 }, looping: false };
	}
	const key = batchKey(calls);
	if (state.lastKey === key) {
		const repeats = state.repeats + 1;
		return { state: { lastKey: key, repeats }, looping: repeats >= threshold };
	}
	return { state: { lastKey: key, repeats: 1 }, looping: false };
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(sortValue(value));
	} catch {
		return String(value);
	}
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			out[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}
