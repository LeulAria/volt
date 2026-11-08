/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import product from '../../product/common/product.js';

/**
 * Native helpers Volt launches (`volt-fsd`, ...) are checked immediately before every launch
 * (B-14, INV-27): the file's SHA-256 must be the one recorded when the app was built.
 *
 * Minimal version: the recorded hashes come from `product.json` (`voltHelpers.<id>.sha256`,
 * written by the build) or from {@link recordHelperHash}. A developer build (no commit in
 * `product.json`) without a recorded hash runs the helper as an explicitly unsigned helper.
 * A release build without one refuses it.
 */

const recorded = new Map<string, string>();

/** Records the SHA-256 (hex) a helper must have. The build writes these into `product.json`; tests record their own. */
export function recordHelperHash(helperId: string, sha256: string): void {
	recorded.set(helperId, sha256.toLowerCase());
}

function expectedHash(helperId: string): string | undefined {
	const own = recorded.get(helperId);
	if (own) {
		return own;
	}
	const helpers = (product as unknown as { readonly voltHelpers?: Readonly<Record<string, { readonly sha256?: unknown } | undefined>> }).voltHelpers;
	const value = helpers?.[helperId]?.sha256;
	return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

export async function verifyHelperBinary(helperId: string, path: string): Promise<{ ok: boolean; reason?: string }> {
	let bytes: Buffer;
	try {
		const stat = await fs.lstat(path);
		if (!stat.isFile()) {
			return { ok: false, reason: `${helperId} at ${path} is not a regular file` };
		}
		bytes = await fs.readFile(path);
	} catch (err) {
		return { ok: false, reason: `${helperId} is missing (${path}): ${err instanceof Error ? err.message : String(err)}` };
	}
	const expected = expectedHash(helperId);
	if (!expected) {
		return product.commit
			? { ok: false, reason: `no recorded hash for ${helperId} in this build` }
			: { ok: true, reason: `unsigned helper ${helperId} (developer build)` };
	}
	const actual = createHash('sha256').update(bytes).digest('hex');
	return actual === expected ? { ok: true } : { ok: false, reason: `${helperId} at ${path} does not match the hash recorded at build` };
}
