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
 * - `slack`: `X-Slack-Signature: v0=<hex>` over `v0:<timestamp>:<body>` (5 minute window).
 * - `sentry`: `Sentry-Hook-Signature: <hex>`. `linear`: `Linear-Signature: <hex>`.
 * - `pagerduty`: `X-PagerDuty-Signature: v1=<hex>[,v1=<hex>]` (several during key rotation).
 * - `teams`: outgoing webhooks, `Authorization: HMAC <base64>` keyed by the base64-decoded token.
 * - `generic`: any header, hex or base64, optional prefix. With `timestampHeader`, the signed
 *   text is `<timestamp>.<body>` and requests older than `toleranceSec` are refused (replay guard,
 *   as Stripe and Slack do).
 * - `none`: the secret URL is the only guard.
 */
export const SIGNATURE_PRESETS = {
	github: { header: 'x-hub-signature-256', prefix: 'sha256=', encoding: 'hex' },
	slack: { header: 'x-slack-signature', prefix: 'v0=', encoding: 'hex', timestampHeader: 'x-slack-request-timestamp', format: 'slack' },
	sentry: { header: 'sentry-hook-signature', prefix: '', encoding: 'hex' },
	linear: { header: 'linear-signature', prefix: '', encoding: 'hex' },
	pagerduty: { header: 'x-pagerduty-signature', prefix: 'v1=', encoding: 'hex' },
	teams: { header: 'authorization', prefix: 'HMAC ', encoding: 'base64', keyBase64: true },
	generic: { header: 'x-volt-signature', prefix: 'sha256=', encoding: 'hex' },
};

export const SIGNATURE_KINDS = ['none', ...Object.keys(SIGNATURE_PRESETS)];

/** The effective settings for a stored signature config. */
export function signatureSettings(config) {
	if (!config || config.kind === 'none' || !config.kind) {
		return undefined;
	}
	const preset = SIGNATURE_PRESETS[config.kind] ?? SIGNATURE_PRESETS.generic;
	const custom = config.kind === 'generic';
	return {
		secret: String(config.secret ?? ''),
		header: String((custom && config.header) || preset.header).toLowerCase(),
		prefix: custom && config.prefix !== undefined && config.prefix !== null ? config.prefix : preset.prefix,
		encoding: custom && config.encoding === 'base64' ? 'base64' : preset.encoding,
		timestampHeader: custom ? (config.timestampHeader ? String(config.timestampHeader).toLowerCase() : undefined) : preset.timestampHeader,
		toleranceSec: Number.isFinite(config.toleranceSec) && config.toleranceSec > 0 ? config.toleranceSec : 300,
		format: preset.format,
		keyBase64: !!preset.keyBase64,
	};
}

/** The header value a sender would compute: used by tests and by `volt-relay sign`. */
export function signBody(config, body, timestamp) {
	const settings = signatureSettings(config);
	if (!settings) {
		return undefined;
	}
	const head = settings.format === 'slack' ? `v0:${timestamp}:` : settings.timestampHeader ? `${timestamp}.` : '';
	const text = Buffer.concat([Buffer.from(head), Buffer.from(body)]);
	const key = settings.keyBase64 ? Buffer.from(settings.secret, 'base64') : settings.secret;
	return settings.prefix + crypto.createHmac('sha256', key).update(text).digest(settings.encoding);
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
	const candidates = (settings.prefix === 'v1=' ? given.split(',') : [given]).map(value => value.trim()).filter(Boolean)
		.map(value => settings.prefix && !value.startsWith(settings.prefix) ? settings.prefix + value : value);
	const ok = candidates.some(candidate => {
		const left = Buffer.from(candidate);
		const right = Buffer.from(expected);
		return left.length === right.length && crypto.timingSafeEqual(left, right);
	});
	return ok ? { ok: true, verified: true } : { ok: false, reason: 'The signature did not match.' };
}
