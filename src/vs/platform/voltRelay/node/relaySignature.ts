/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, timingSafeEqual } from 'crypto';
import { IVoltRelaySignature } from '../common/voltRelay.js';

/**
 * Webhook signature checks for the direct local URL: the same rules as the relay's
 * (apps/relay/src/signature.mjs), so a sender set up once works on either URL.
 * GitHub: `X-Hub-Signature-256: sha256=<hex>`; generic: any header, hex or base64, optional
 * `<timestamp>.<body>` signing with a replay window.
 */
const PRESETS = {
	github: { header: 'x-hub-signature-256', prefix: 'sha256=', encoding: 'hex' as const },
	generic: { header: 'x-volt-signature', prefix: 'sha256=', encoding: 'hex' as const },
};

interface ISettings {
	readonly secret: string;
	readonly header: string;
	readonly prefix: string;
	readonly encoding: 'hex' | 'base64';
	readonly timestampHeader?: string;
	readonly toleranceSec: number;
}

function settingsOf(config: IVoltRelaySignature | undefined): ISettings | undefined {
	if (!config || config.kind === 'none') {
		return undefined;
	}
	const preset = PRESETS[config.kind] ?? PRESETS.generic;
	return {
		secret: config.secret ?? '',
		header: (config.header || preset.header).toLowerCase(),
		prefix: config.prefix ?? preset.prefix,
		encoding: config.encoding === 'base64' ? 'base64' : preset.encoding,
		timestampHeader: config.timestampHeader ? config.timestampHeader.toLowerCase() : undefined,
		toleranceSec: config.toleranceSec && config.toleranceSec > 0 ? config.toleranceSec : 300,
	};
}

/** The header value a sender computes. */
export function signWebhookBody(config: IVoltRelaySignature, body: Uint8Array | string, timestamp?: string): string | undefined {
	const settings = settingsOf(config);
	if (!settings) {
		return undefined;
	}
	const hmac = createHmac('sha256', settings.secret);
	if (settings.timestampHeader) {
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
	// With or without the prefix, as the relay accepts.
	const candidate = Buffer.from(settings.prefix && !given.startsWith(settings.prefix) ? settings.prefix + given : given);
	return candidate.length === expected.length && timingSafeEqual(candidate, expected)
		? { ok: true, verified: true }
		: { ok: false, reason: 'The signature did not match.' };
}
