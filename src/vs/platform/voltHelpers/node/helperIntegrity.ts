/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs, Stats } from 'fs';
import { basename, dirname, join } from '../../../base/common/path.js';

/**
 * Integrity of Volt's native helpers, checked immediately before every launch (INV-27).
 *
 * Minimal version: each helper folder carries `volt-helpers.json`, written by the build next to
 * the binaries it compiled (`{ "<helper id>": { "file": "<name>", "sha256": "<hex>" } }`), and a
 * helper runs only when its file's SHA-256 matches. The manifest ships inside the signed app
 * bundle with the helpers, so it pins them against a swap by another same-user process at run
 * time, not against an edit of the bundle itself (that is the code signature's job, B-14).
 *
 * The digest is recomputed whenever the file's identity changes: device, inode, size, modification
 * and status-change times. A replaced file has a new inode, and any write moves the status-change
 * time, which a process cannot set back; so a check costs two `lstat`s when nothing changed.
 */

export const HELPER_MANIFEST_NAME = 'volt-helpers.json';

interface IHelperManifestEntry {
	readonly file: string;
	readonly sha256: string;
}

const stamp = (st: Stats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const verified = new Map<string, string>();

export async function verifyHelperBinary(helperId: string, path: string): Promise<{ ok: boolean; reason?: string }> {
	const manifestPath = join(dirname(path), HELPER_MANIFEST_NAME);
	let binary: Stats;
	let manifestStat: Stats;
	try {
		[binary, manifestStat] = await Promise.all([fs.lstat(path), fs.lstat(manifestPath)]);
	} catch (err) {
		verified.delete(`${helperId}\0${path}`);
		return { ok: false, reason: `cannot read ${path} or its manifest: ${(err as Error).message}` };
	}
	if (!binary.isFile()) {
		return { ok: false, reason: `${path} is not a regular file` };
	}
	const key = `${helperId}\0${path}`;
	const identity = `${stamp(binary)}|${stamp(manifestStat)}`;
	if (verified.get(key) === identity) {
		return { ok: true };
	}
	verified.delete(key);
	let manifest: Record<string, IHelperManifestEntry | undefined>;
	try {
		manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
	} catch (err) {
		return { ok: false, reason: `no helper manifest next to ${path}: ${(err as Error).message}` };
	}
	const entry = manifest?.[helperId];
	if (!entry || typeof entry.sha256 !== 'string' || typeof entry.file !== 'string') {
		return { ok: false, reason: `${helperId} is not in the helper manifest` };
	}
	if (entry.file !== basename(path)) {
		return { ok: false, reason: `${helperId} is ${entry.file} in the manifest, not ${basename(path)}` };
	}
	let digest: string;
	try {
		digest = createHash('sha256').update(await fs.readFile(path)).digest('hex');
	} catch (err) {
		return { ok: false, reason: `cannot read ${path}: ${(err as Error).message}` };
	}
	if (digest !== entry.sha256.toLowerCase()) {
		return { ok: false, reason: `${helperId} does not match its pinned SHA-256` };
	}
	verified.set(key, identity);
	return { ok: true };
}
