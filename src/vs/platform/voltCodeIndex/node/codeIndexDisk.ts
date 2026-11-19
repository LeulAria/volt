/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, normalize, sep } from '../../../base/common/path.js';
import { IVoltCodeIndexStatus } from '../common/voltCodeIndex.js';

/**
 * The code index as it lies on disk, readable without the index process: a folder's status when no process
 * holds it is its manifest's summary, so the service answers it in place instead of forking a process for it.
 */

/** The part of a folder's manifest a status needs. */
export interface IManifestSummary {
	readonly root?: string;
	readonly optionsKey?: string;
	readonly updatedAt?: number;
	readonly lastUsedAt?: number;
	readonly stats?: { readonly files: number; readonly bytes: number; readonly symbols: number; readonly diskBytes: number };
}

export function normalizeIndexRoot(root: string): string {
	const path = normalize(root);
	return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** The folder under `dataDir` that holds the index keyed `key` (a normalized root, or a confined index's key). */
export function indexDirFor(dataDir: string, key: string): string {
	return join(dataDir, createHash('sha1').update(key).digest('hex').slice(0, 24));
}

export async function readIndexSummary(dir: string): Promise<IManifestSummary | undefined> {
	try {
		return JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as IManifestSummary;
	} catch {
		return undefined;
	}
}

/** A folder's status from its index on disk (`none` when it has none). */
export async function diskIndexStatus(root: string, dir: string): Promise<IVoltCodeIndexStatus> {
	const summary = await readIndexSummary(dir);
	return {
		root,
		state: summary ? 'ready' : 'none',
		files: summary?.stats?.files ?? 0,
		bytes: summary?.stats?.bytes ?? 0,
		diskBytes: summary?.stats?.diskBytes ?? 0,
		symbols: summary?.stats?.symbols ?? 0,
		pending: 0,
		...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
		...(summary?.lastUsedAt ? { lastUsedAt: summary.lastUsedAt } : {}),
	};
}
