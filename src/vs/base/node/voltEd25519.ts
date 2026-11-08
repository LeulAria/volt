/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';

/**
 * Public keys Volt pins in product.json are Ed25519 keys as base64 SPKI DER: the body of a
 * `-----BEGIN PUBLIC KEY-----` PEM (`MCowBQYDK2VwAyEA...`, 44 bytes). A full PEM is accepted too.
 */
export function parseEd25519PublicKey(key: string): crypto.KeyObject | undefined {
	try {
		const trimmed = key.trim();
		const object = trimmed.startsWith('-----BEGIN')
			? crypto.createPublicKey(trimmed)
			: crypto.createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
		return object.asymmetricKeyType === 'ed25519' ? object : undefined;
	} catch {
		return undefined;
	}
}

/** True when `signature` is a valid Ed25519 signature of `data` by `publicKey` (see parseEd25519PublicKey). */
export function verifyEd25519(data: string | Uint8Array, signature: Uint8Array, publicKey: string): boolean {
	const key = parseEd25519PublicKey(publicKey);
	if (!key || signature.byteLength !== 64) {
		return false;
	}
	try {
		return crypto.verify(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, key, signature);
	} catch {
		return false;
	}
}
