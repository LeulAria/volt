/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, posix, win32 } from '../../../../../base/common/path.js';
import { pickString } from '../tools/args.js';
import { IToolCall, IVoltTool } from '../tools/tool.js';

/**
 * What a call reads and writes. Two calls in one batch run in the model's order only when their
 * resources conflict (write/write, write/read, read/write); everything else runs concurrently.
 * `*` is the whole workspace: a shell command or a git mutation can touch anything.
 */

export const ANY_RESOURCE = '*';

export interface IResourceKeys {
	readonly reads: readonly string[];
	readonly writes: readonly string[];
}

export function resourceKeys(tool: IVoltTool, args: unknown, cwd: string | undefined): IResourceKeys {
	const raw = pickString(args, 'path', 'file', 'file_path', 'directory');
	const target = raw ? pathKey(raw, cwd) : cwd ? pathKey(cwd, undefined) : ANY_RESOURCE;
	switch (tool.group) {
		case 'edit':
			return { reads: [], writes: [raw ? target : ANY_RESOURCE] };
		case 'shell':
			// Reading a job's output touches nothing; running a command can touch anything.
			return tool.parallelSafe ? { reads: [], writes: [] } : { reads: [], writes: [ANY_RESOURCE] };
		case 'git':
			return tool.parallelSafe ? { reads: [ANY_RESOURCE], writes: [] } : { reads: [], writes: [ANY_RESOURCE] };
		case 'read':
		case 'search':
			return { reads: [target], writes: [] };
		default:
			return tool.parallelSafe ? { reads: [], writes: [] } : { reads: [], writes: [ANY_RESOURCE] };
	}
}

/**
 * Absolute, `/`-separated, `.`/`..` resolved, lower-cased. Lower-casing can only make two paths
 * look like one on a case-sensitive disk, which serializes them: safe, never racy.
 */
export function pathKey(path: string, cwd: string | undefined): string {
	const unified = path.replace(/\\/g, '/');
	const absolute = isAbsolute(path) || /^[a-zA-Z]:\//.test(unified) || !cwd
		? unified
		: `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${unified}`;
	const drive = /^[a-zA-Z]:/.test(absolute);
	const normalized = drive ? win32.normalize(absolute).replace(/\\/g, '/') : posix.normalize(absolute);
	return normalized.replace(/\/$/, '').toLowerCase() || '/';
}

export function resourcesConflict(a: IResourceKeys, b: IResourceKeys): boolean {
	return overlaps(a.writes, b.writes) || overlaps(a.writes, b.reads) || overlaps(a.reads, b.writes);
}

function overlaps(x: readonly string[], y: readonly string[]): boolean {
	return x.some(p => y.some(q => p === ANY_RESOURCE || q === ANY_RESOURCE || p === q || q.startsWith(`${p}/`) || p.startsWith(`${q}/`)));
}

/** For each call, the earlier calls it must wait for. */
export function batchDependencies(calls: readonly IToolCall[], tools: ReadonlyMap<string, IVoltTool>, cwd: string | undefined): number[][] {
	const keys = calls.map(call => {
		const tool = tools.get(call.name);
		return tool ? resourceKeys(tool, call.args, cwd) : { reads: [], writes: [] };
	});
	return keys.map((key, j) => {
		const deps: number[] = [];
		for (let i = 0; i < j; i++) {
			if (resourcesConflict(keys[i], key)) {
				deps.push(i);
			}
		}
		return deps;
	});
}
