/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import crypto from 'node:crypto';

/**
 * Webhook signature checks (HMAC-SHA256 over the raw body). Kept byte-for-byte in step with
 * Volt's own copy for its direct local URL (`platform/voltRelay/node/relaySignature.ts`).
 *
 * - `github`: `X-Hub-Signature-256: sha256=<hex>`.
 * - `generic`: any header, hex or base64, optional prefix. With `timestampHeader`, the signed
 *   text is `<timestamp>.<body>` and requests older than `toleranceSec` are refused (replay guard,
 *   as Stripe and Slack do).
 * - `none`: the secret URL is the only guard.
 */
export const SIGNATURE_PRESETS = {
	github: { header: 'x-hub-signature-256', prefix: 'sha256=', encoding: 'hex' },
	generic: { header: 'x-volt-signature', prefix: 'sha256=', encoding: 'hex' },
};

/** The effective settings for a stored signature config. */
export function signatureSettings(config) {
	if (!config || config.kind === 'none' || !config.kind) {
		return undefined;
	}
	const preset = SIGNATURE_PRESETS[config.kind] ?? SIGNATURE_PRESETS.generic;
	return {
		secret: String(config.secret ?? ''),
		header: String(config.header || preset.header).toLowerCase(),
		prefix: config.prefix ?? preset.prefix,
		encoding: config.encoding === 'base64' ? 'base64' : preset.encoding,
		timestampHeader: config.timestampHeader ? String(config.timestampHeader).toLowerCase() : undefined,
		toleranceSec: Number.isFinite(config.toleranceSec) && config.toleranceSec > 0 ? config.toleranceSec : 300,
	};
}

/** The header value a sender would compute: used by tests and by `volt-relay sign`. */
export function signBody(config, body, timestamp) {
	const settings = signatureSettings(config);
	if (!settings) {
		return undefined;
	}
	const text = settings.timestampHeader ? Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]) : Buffer.from(body);
	return settings.prefix + crypto.createHmac('sha256', settings.secret).update(text).digest(settings.encoding);
}

/**
 * `{ ok: true, verified }` or `{ ok: false, reason }`. `headers` are lower-cased (Node's are).
 * `now` in ms.
 */
export function verifySignature(config, headers, body, now = Date.now()) {
	const settings = signatureSettings(config);
	if (!settings) {
		return { ok: true, verified: false };
	}
	if (!settings.secret) {
		return { ok: false, reason: 'No signing secret is set for this hook.' };
	}
	const raw = headers[settings.header];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (!value) {
		return { ok: false, reason: `Missing ${settings.header} header.` };
	}
	let timestamp;
	if (settings.timestampHeader) {
		const stamp = headers[settings.timestampHeader];
		timestamp = Array.isArray(stamp) ? stamp[0] : stamp;
		const seconds = Number(timestamp);
		if (!timestamp || !Number.isFinite(seconds)) {
			return { ok: false, reason: `Missing ${settings.timestampHeader} header.` };
		}
		if (Math.abs(now / 1000 - seconds) > settings.toleranceSec) {
			return { ok: false, reason: 'The signature timestamp is too old (replay guard).' };
		}
	}
	const expected = signBody(config, body, timestamp);
	const given = String(value).trim();
	// Accept the digest with or without the prefix, so `sha256=` vs bare hex is not a footgun.
	const candidates = settings.prefix && !given.startsWith(settings.prefix) ? [settings.prefix + given] : [given];
	const ok = candidates.some(candidate => {
		const left = Buffer.from(candidate);
		const right = Buffer.from(expected);
		return left.length === right.length && crypto.timingSafeEqual(left, right);
	});
	return ok ? { ok: true, verified: true } : { ok: false, reason: 'The signature did not match.' };
}
