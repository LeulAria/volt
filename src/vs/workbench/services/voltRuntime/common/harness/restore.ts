/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSnapshot } from './stateManager.js';

/**
 * Applies a rollback ledger to a real filesystem. The state manager is the source of
 * truth for *what* to restore; this is the only place those snapshots become writes.
 */

export interface IRestoreIO {
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface IRestoreReport {
	readonly applied: number;
	readonly failed: readonly { readonly path: string; readonly error: string }[];
}

export async function applyRestored(restored: readonly IFileSnapshot[], io: IRestoreIO): Promise<IRestoreReport> {
	const failed: { path: string; error: string }[] = [];
	let applied = 0;
	for (const snap of restored) {
		try {
			if (!snap.existed) {
				await io.remove(snap.path);
			} else {
				await io.write(snap.path, snap.content);
			}
			applied++;
		} catch (err) {
			failed.push({ path: snap.path, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { applied, failed };
}
