/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, timingSafeEqual } from 'crypto';
import { IVoltRelaySignature, VoltRelaySignatureKind } from '../common/voltRelay.js';

/**
 * Webhook signature checks for the direct local URL: the same rules as the relay's
 * (apps/relay/src/signature.mjs), so a sender set up once works on either URL.
 * GitHub: `X-Hub-Signature-256: sha256=<hex>`; Slack: `X-Slack-Signature: v0=<hex>` over
 * `v0:<timestamp>:<body>`; Sentry, Linear: bare hex; PagerDuty: `v1=<hex>`, several comma-separated
 * during key rotation; Teams outgoing webhooks: `Authorization: HMAC <base64>` keyed by the
 * base64-decoded token; generic: any header, hex or base64, optional `<timestamp>.<body>` signing.
 */
interface IPreset {
	readonly header: string;
	readonly prefix: string;
	readonly encoding: 'hex' | 'base64';
	readonly timestampHeader?: string;
	/** How the timestamp joins the body: `<ts>.<body>` (default) or Slack's `v0:<ts>:<body>`. */
	readonly format?: 'slack';
	/** The secret is base64 (Teams). */
	readonly keyBase64?: boolean;
}

const PRESETS: Readonly<Record<Exclude<VoltRelaySignatureKind, 'none'>, IPreset>> = {
	github: { header: 'x-hub-signature-256', prefix: 'sha256=', encoding: 'hex' },
	slack: { header: 'x-slack-signature', prefix: 'v0=', encoding: 'hex', timestampHeader: 'x-slack-request-timestamp', format: 'slack' },
	sentry: { header: 'sentry-hook-signature', prefix: '', encoding: 'hex' },
	linear: { header: 'linear-signature', prefix: '', encoding: 'hex' },
	pagerduty: { header: 'x-pagerduty-signature', prefix: 'v1=', encoding: 'hex' },
	teams: { header: 'authorization', prefix: 'HMAC ', encoding: 'base64', keyBase64: true },
	generic: { header: 'x-volt-signature', prefix: 'sha256=', encoding: 'hex' },
};

interface ISettings {
	readonly secret: string;
	readonly header: string;
	readonly prefix: string;
	readonly encoding: 'hex' | 'base64';
	readonly timestampHeader?: string;
	readonly toleranceSec: number;
	readonly format?: 'slack';
	readonly keyBase64?: boolean;
}

function settingsOf(config: IVoltRelaySignature | undefined): ISettings | undefined {
	if (!config || config.kind === 'none') {
		return undefined;
	}
	const preset = PRESETS[config.kind] ?? PRESETS.generic;
	const custom = config.kind === 'generic';
	return {
		secret: config.secret ?? '',
		header: ((custom && config.header) || preset.header).toLowerCase(),
		prefix: custom && config.prefix !== undefined ? config.prefix : preset.prefix,
		encoding: custom && config.encoding === 'base64' ? 'base64' : preset.encoding,
		timestampHeader: custom ? (config.timestampHeader ? config.timestampHeader.toLowerCase() : undefined) : preset.timestampHeader,
		toleranceSec: config.toleranceSec && config.toleranceSec > 0 ? config.toleranceSec : 300,
		format: preset.format,
		keyBase64: preset.keyBase64,
	};
}

/** The header value a sender computes. */
export function signWebhookBody(config: IVoltRelaySignature, body: Uint8Array | string, timestamp?: string): string | undefined {
	const settings = settingsOf(config);
	if (!settings) {
		return undefined;
	}
	const hmac = createHmac('sha256', settings.keyBase64 ? Buffer.from(settings.secret, 'base64') : settings.secret);
	if (settings.format === 'slack') {
		hmac.update(`v0:${timestamp}:`);
	} else if (settings.timestampHeader) {
		hmac.update(`${timestamp}.`);
	}
	hmac.update(body);
	return settings.prefix + hmac.digest(settings.encoding);
}

export type SignatureCheck = { readonly ok: true; readonly verified: boolean } | { readonly ok: false; readonly reason: string };

/** `headers` lower-cased, as Node gives them. */
export function verifyWebhookSignature(config: IVoltRelaySignature | undefined, headers: Readonly<Record<string, string | string[] | undefined>>, body: Uint8Array | string, now = Date.now()): SignatureCheck {
	const settings = settingsOf(config);
	if (!settings) {
		return { ok: true, verified: false };
	}
	if (!settings.secret) {
		return { ok: false, reason: 'No signing secret is set for this hook.' };
	}
	const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
	const given = first(headers[settings.header])?.trim();
	if (!given) {
		return { ok: false, reason: `Missing ${settings.header} header.` };
	}
	let timestamp: string | undefined;
	if (settings.timestampHeader) {
		timestamp = first(headers[settings.timestampHeader]);
		const seconds = Number(timestamp);
		if (!timestamp || !Number.isFinite(seconds)) {
			return { ok: false, reason: `Missing ${settings.timestampHeader} header.` };
		}
		if (Math.abs(now / 1000 - seconds) > settings.toleranceSec) {
			return { ok: false, reason: 'The signature timestamp is too old (replay guard).' };
		}
	}
	const expected = Buffer.from(signWebhookBody(config!, body, timestamp)!);
	// With or without the prefix, as the relay accepts; PagerDuty sends several during key rotation.
	const candidates = (settings.prefix === 'v1=' ? given.split(',') : [given]).map(value => value.trim()).filter(Boolean)
		.map(value => Buffer.from(settings.prefix && !value.startsWith(settings.prefix) ? settings.prefix + value : value));
	return candidates.some(candidate => candidate.length === expected.length && timingSafeEqual(candidate, expected))
		? { ok: true, verified: true }
		: { ok: false, reason: 'The signature did not match.' };
}
