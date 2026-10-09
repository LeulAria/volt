/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import crypto from 'node:crypto';

/** A random URL-safe secret, `bytes` of entropy. */
export function randomToken(bytes = 32) {
	return crypto.randomBytes(bytes).toString('base64url');
}

/** A short id for records (not a secret). */
export function newId(prefix) {
	return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function sha256(value) {
	return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string compare; false when lengths differ. */
export function safeEqual(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** `ABCD-EFGH`: easy to read aloud and type, no 0/O/1/I. */
export function pairingCode() {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = crypto.randomBytes(8);
	let code = '';
	for (let i = 0; i < 8; i++) {
		code += alphabet[bytes[i] % alphabet.length];
		if (i === 3) {
			code += '-';
		}
	}
	return code;
}

export function normalizePairingCode(code) {
	return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}

const SECRET_HEADER = /(authorization|cookie|token|secret|signature|password|api[-_]?key|x-hub-signature)/i;

/** Headers worth keeping for a delivery: secrets are masked, hop-by-hop and proxy noise dropped. */
export function redactHeaders(headers) {
	const out = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const key = name.toLowerCase();
		if (key === 'connection' || key === 'keep-alive' || key === 'transfer-encoding' || key === 'upgrade' || key.startsWith('cf-') || key === 'host') {
			continue;
		}
		const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
		out[key] = SECRET_HEADER.test(key) ? `[redacted ${text.length} chars]` : text.slice(0, 2000);
	}
	return out;
}

export class HttpError extends Error {
	constructor(status, message, extra) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

/** Reads a request body up to `limit` bytes; throws 413 past it. */
export function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let failed = false;
		req.on('data', chunk => {
			if (failed) {
				return;
			}
			size += chunk.length;
			if (size > limit) {
				failed = true;
				reject(new HttpError(413, `Body is larger than ${limit} bytes.`));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
		req.on('error', err => !failed && reject(err));
	});
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
	const raw = await readBody(req, limit);
	if (!raw.length) {
		return {};
	}
	try {
		return JSON.parse(raw.toString('utf8'));
	} catch {
		throw new HttpError(400, 'Body is not valid JSON.');
	}
}

export function sendJson(res, status, value, headers = {}) {
	const body = JSON.stringify(value);
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...headers });
	res.end(body);
}

/** The public origin clients should use: the configured one, else what the request came in on. */
export function publicBase(req, configured) {
	if (configured) {
		return configured.replace(/\/+$/, '');
	}
	const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
	const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
	return `${proto}://${host}`;
}

export function clampInt(value, min, max, fallback) {
	const number = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
