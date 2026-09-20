/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pickString } from '../tools/args.js';
import { IToolCall, IVoltTool } from '../tools/tool.js';

/**
 * Per-file mutation lanes (Prime). Two edits to different files may run together;
 * two edits to the same real path must not. Shell and git stay exclusive because
 * they can touch any path.
 */

export type MutationLane = { readonly kind: 'path'; readonly path: string } | { readonly kind: 'exclusive' } | { readonly kind: 'parallel' };

export function mutationLane(call: IToolCall, tool: IVoltTool | undefined): MutationLane {
	if (!tool || tool.parallelSafe) {
		return { kind: 'parallel' };
	}
	if (tool.group === 'edit') {
		const path = pickString(call.args, 'path', 'file', 'file_path');
		if (path) {
			return { kind: 'path', path: path.replace(/\\/g, '/') };
		}
	}
	return { kind: 'exclusive' };
}

export interface IMutationPlan {
	readonly parallel: readonly number[];
	readonly fileLanes: readonly (readonly number[])[];
	readonly exclusive: readonly number[];
}

/**
 * Splits a batch of *already classified* mutating vs parallel-safe indices.
 * `mutating` is the serial list from the executor; this further splits it.
 */
export function planMutationLanes(
	calls: readonly IToolCall[],
	tools: ReadonlyMap<string, IVoltTool>,
	mutating: readonly number[],
): { readonly fileLanes: readonly (readonly number[])[]; readonly exclusive: readonly number[] } {
	const byPath = new Map<string, number[]>();
	const exclusive: number[] = [];
	for (const index of mutating) {
		const lane = mutationLane(calls[index], tools.get(calls[index].name));
		if (lane.kind === 'path') {
			const list = byPath.get(lane.path) ?? [];
			list.push(index);
			byPath.set(lane.path, list);
		} else {
			exclusive.push(index);
		}
	}
	return { fileLanes: [...byPath.values()], exclusive };
}
