/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pickString } from '../tools/args.js';
import { IToolHook } from './waterfall.js';

/**
 * File staleness (Roo FileContextTracker). An edit against a path the agent has
 * not read since an external write is how you get a silent three-way merge.
 * The tracker does not watch the disk; the runtime tells it when the agent
 * read, wrote, or learned the file changed outside the run.
 */

export type FileTouch = 'read' | 'write' | 'external';

export interface IFileTouch {
	readonly path: string;
	readonly kind: FileTouch;
	readonly at: number;
}

export class FileTracker {

	private readonly last = new Map<string, IFileTouch>();

	touch(path: string, kind: FileTouch, now = Date.now()): IFileTouch {
		const key = normalize(path);
		const item: IFileTouch = { path: key, kind, at: now };
		this.last.set(key, item);
		return item;
	}

	isStale(path: string): boolean {
		const item = this.last.get(normalize(path));
		return item?.kind === 'external';
	}

	lastTouch(path: string): IFileTouch | undefined {
		return this.last.get(normalize(path));
	}

	known(): readonly IFileTouch[] {
		return [...this.last.values()];
	}
}

export function staleEditReason(path: string): string {
	return `File ${path} changed on disk since you last read it. Read it again before editing.`;
}

export function staleEditHook(tracker: FileTracker): IToolHook {
	return {
		name: 'stale-edit',
		pre: (call, tool) => {
			if (tool.group !== 'edit') {
				return { kind: 'allow' };
			}
			const path = pickString(call.args, 'path', 'file', 'file_path');
			if (path && tracker.isStale(path)) {
				return { kind: 'deny', reason: staleEditReason(path) };
			}
			return { kind: 'allow' };
		},
	};
}

function normalize(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
