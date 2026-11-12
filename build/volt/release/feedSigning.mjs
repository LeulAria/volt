/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Update feed signatures (INV-28). Each `<channel>/<platform>.json` entry gets `channel`, `platform`,
// `feedVersion` (publish time in ms, monotonic), `expires` and `signature`: base64 Ed25519 over
// FEED_SIGNATURE_CONTEXT + canonical JSON of the entry without `signature`. The app checks it in
// src/vs/platform/update/common/voltUpdateFeed.ts (checkVoltFeedTrust); keep the two in step.

import * as crypto from 'node:crypto';

export const FEED_SIGNATURE_CONTEXT = 'volt-update-feed-v1\n';

/** How long a signed entry stays valid. A channel with no release for longer stops offering updates until the next one. */
export const DEFAULT_FEED_EXPIRY_DAYS = 90;

/** JSON with object keys sorted (UTF-16 code unit order), no whitespace, undefined members dropped. */
export function canonicalJson(value) {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('Feed numbers must be finite');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	throw new Error(`Feed values can't be ${typeof value}`);
}

/** @param {object} entry */
export function signingMessage(entry) {
	const { signature: _signature, ...signed } = entry;
	return FEED_SIGNATURE_CONTEXT + canonicalJson(signed);
}

/**
 * Reads the channel's signing key from `VOLT_FEED_SIGNING_KEY_<CHANNEL>` or `VOLT_FEED_SIGNING_KEY`:
 * a PKCS #8 PEM, or its base64 DER body.
 * @param {string} channel
 * @returns {crypto.KeyObject | undefined}
 */
export function feedSigningKeyFromEnv(channel, env = process.env) {
	const raw = (env[`VOLT_FEED_SIGNING_KEY_${channel.toUpperCase()}`] || env.VOLT_FEED_SIGNING_KEY)?.trim();
	if (!raw) {
		return undefined;
	}
	const key = raw.startsWith('-----BEGIN')
		? crypto.createPrivateKey(raw)
		: crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
	if (key.asymmetricKeyType !== 'ed25519') {
		throw new Error(`VOLT_FEED_SIGNING_KEY is a ${key.asymmetricKeyType} key; the feed is signed with Ed25519`);
	}
	return key;
}

/** The public half as product.json pins it: base64 SPKI DER. */
export function publicKeyBase64(key) {
	return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Returns a signed copy of a feed entry.
 * @param {object} entry
 * @param {{ channel: string, platform: string, key: crypto.KeyObject, now?: number, expiryDays?: number }} o
 */
export function signFeedEntry(entry, o) {
	const now = o.now ?? Date.now();
	const signed = {
		...entry,
		channel: o.channel,
		platform: o.platform,
		feedVersion: now,
		expires: now + (o.expiryDays ?? DEFAULT_FEED_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
	};
	delete signed.signature;
	const signature = crypto.sign(null, Buffer.from(signingMessage(signed), 'utf8'), o.key).toString('base64');
	return { ...signed, signature };
}

/** @param {object} entry @param {string} publicKey base64 SPKI DER */
export function verifyFeedEntry(entry, publicKey) {
	if (typeof entry?.signature !== 'string') {
		return false;
	}
	const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
	return crypto.verify(null, Buffer.from(signingMessage(entry), 'utf8'), key, Buffer.from(entry.signature, 'base64'));
}
