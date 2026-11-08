/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { MXC_HELPER_DIGESTS, MXC_HELPER_ID, WXC_EXEC_DIGESTS, WXC_EXEC_HELPER_ID } from '../../voltSandbox/common/mxc.js';

/**
 * Helper binaries Volt runs outside or around a sandbox are checked against pinned SHA-256
 * digests immediately before every launch (INV-27). A binary with no pinned digest is refused.
 *
 * Minimal version for the Windows sandbox backend (C7): pins `wxc-exec.exe` (Microsoft-signed,
 * from the pinned `@microsoft/mxc-sdk` tarball) and Volt's reproducibly built `volt-mxc-helper`.
 * The Phase 0 helper-integrity work (P0-4) owns the general registry, signatures and developer mode.
 */

const PINNED: Readonly<Record<string, readonly string[]>> = {
	[WXC_EXEC_HELPER_ID]: Object.values(WXC_EXEC_DIGESTS),
	[MXC_HELPER_ID]: Object.values(MXC_HELPER_DIGESTS),
};

/** Largest helper Volt hashes (wxc-exec x64 is 12 MB). */
const MAX_HELPER_BYTES = 64 * 1024 * 1024;

export async function verifyHelperBinary(helperId: string, path: string): Promise<{ ok: boolean; reason?: string }> {
	const pinned = PINNED[helperId];
	if (!pinned?.length) {
		return { ok: false, reason: `No pinned digest for helper ${helperId}.` };
	}
	try {
		const stat = await fs.lstat(path);
		if (!stat.isFile()) {
			return { ok: false, reason: `${helperId} is not a regular file: ${path}` };
		}
		if (stat.size > MAX_HELPER_BYTES) {
			return { ok: false, reason: `${helperId} is unexpectedly large: ${path}` };
		}
		const digest = createHash('sha256').update(await fs.readFile(path)).digest('hex');
		return pinned.includes(digest) ? { ok: true } : { ok: false, reason: `${helperId} does not match its pinned digest (${digest.slice(0, 16)}): ${path}` };
	} catch (err) {
		return { ok: false, reason: `${helperId} could not be read: ${(err as Error).message}` };
	}
}
