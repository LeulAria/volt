/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the authorization types sign with. MD5 and SHA-512/256 (Digest auth) are written out here
 * because Web Crypto has neither; everything else goes through `crypto.subtle`.
 */

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';

export type HttpHashName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export function httpUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function httpHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) {
		out += (byte < 16 ? '0' : '') + byte.toString(16);
	}
	return out;
}

export function httpBase64(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes), true, false);
}

/** Base64 as a JWT writes it: `-` and `_`, no padding. */
export function httpBase64Url(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes), false, true);
}

export function httpFromBase64(text: string): Uint8Array {
	return decodeBase64(text.replace(/\s+/g, '')).buffer;
}

export function httpRandomHex(bytes: number): string {
	const out = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(out);
	return httpHex(out);
}

/** A copy in a buffer of its own: what `crypto.subtle` takes whatever the bytes were a view of. */
function own(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

export async function httpSha(name: HttpHashName, data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await globalThis.crypto.subtle.digest(name, own(data)));
}

export async function httpHmac(name: HttpHashName, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	// Web Crypto refuses an empty HMAC key; a zero byte pads to the same block as no key at all.
	const imported = await globalThis.crypto.subtle.importKey('raw', own(key.byteLength ? key : new Uint8Array(1)), { name: 'HMAC', hash: name }, false, ['sign']);
	return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', imported, own(data)));
}

// --- MD5 (RFC 1321) ---------------------------------------------------------------------------

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_SINES = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) >>> 0);

export function httpMd5(data: Uint8Array): Uint8Array {
	const length = data.byteLength;
	const padded = new Uint8Array((((length + 8) >>> 6) + 1) << 6);
	padded.set(data);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.byteLength - 8, (length << 3) >>> 0, true);
	view.setUint32(padded.byteLength - 4, Math.floor(length / 536870912), true);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	const words = new Uint32Array(16);
	for (let offset = 0; offset < padded.byteLength; offset += 64) {
		for (let index = 0; index < 16; index++) {
			words[index] = view.getUint32(offset + index * 4, true);
		}
		let a = a0, b = b0, c = c0, d = d0;
		for (let index = 0; index < 64; index++) {
			let f: number;
			let g: number;
			if (index < 16) {
				f = (b & c) | (~b & d);
				g = index;
			} else if (index < 32) {
				f = (d & b) | (~d & c);
				g = (5 * index + 1) % 16;
			} else if (index < 48) {
				f = b ^ c ^ d;
				g = (3 * index + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * index) % 16;
			}
			const sum = (a + f + MD5_SINES[index] + words[g]) >>> 0;
			const shift = MD5_SHIFTS[((index >>> 4) << 2) + (index % 4)];
			a = d;
			d = c;
			c = b;
			b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0, true);
	outView.setUint32(4, b0, true);
	outView.setUint32(8, c0, true);
	outView.setUint32(12, d0, true);
	return out;
}

// --- SHA-512/256 (FIPS 180-4) -----------------------------------------------------------------

const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);
let sha512Constants: bigint[] | undefined;

/** The 80 round constants: the first 64 bits of the fractional parts of the cube roots of the first 80 primes. */
function roundConstants(): bigint[] {
	if (sha512Constants) {
		return sha512Constants;
	}
	const primes: number[] = [];
	for (let candidate = 2; primes.length < 80; candidate++) {
		if (primes.every(prime => candidate % prime !== 0)) {
			primes.push(candidate);
		}
	}
	sha512Constants = primes.map(prime => {
		// floor(cbrt(prime) * 2^64): the integer cube root of prime * 2^192.
		const target = BigInt(prime) << BigInt(192);
		let low = BigInt(0);
		let high = BigInt(1) << BigInt(68);
		while (low < high) {
			const middle = (low + high + BigInt(1)) >> BigInt(1);
			if (middle * middle * middle <= target) {
				low = middle;
			} else {
				high = middle - BigInt(1);
			}
		}
		return low & MASK64;
	});
	return sha512Constants;
}

const SHA512_256_START = ['22312194fc2bf72c', '9f555fa3c84c64c2', '2393b86b6f53b151', '963877195940eabd', '96283ee2a88effe3', 'be5e1e2553863992', '2b0199fc2c85b8aa', '0eb72ddc81c52ca2'];

function rotate(value: bigint, by: number): bigint {
	return ((value >> BigInt(by)) | (value << BigInt(64 - by))) & MASK64;
}

export function httpSha512_256(data: Uint8Array): Uint8Array {
	const constants = roundConstants();
	const length = data.byteLength;
	const padded = new Uint8Array((((length + 16) >>> 7) + 1) << 7);
	padded.set(data);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setBigUint64(padded.byteLength - 8, BigInt(length) << BigInt(3), false);
	const state = SHA512_256_START.map(hex => BigInt(`0x${hex}`));
	const words: bigint[] = new Array<bigint>(80).fill(BigInt(0));
	for (let offset = 0; offset < padded.byteLength; offset += 128) {
		for (let index = 0; index < 16; index++) {
			words[index] = view.getBigUint64(offset + index * 8, false);
		}
		for (let index = 16; index < 80; index++) {
			const w15 = words[index - 15];
			const w2 = words[index - 2];
			const s0 = rotate(w15, 1) ^ rotate(w15, 8) ^ (w15 >> BigInt(7));
			const s1 = rotate(w2, 19) ^ rotate(w2, 61) ^ (w2 >> BigInt(6));
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) & MASK64;
		}
		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 80; index++) {
			const s1 = rotate(e, 14) ^ rotate(e, 18) ^ rotate(e, 41);
			const choose = (e & f) ^ (~e & MASK64 & g);
			const t1 = (h + s1 + choose + constants[index] + words[index]) & MASK64;
			const s0 = rotate(a, 28) ^ rotate(a, 34) ^ rotate(a, 39);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + majority) & MASK64;
			h = g;
			g = f;
			f = e;
			e = (d + t1) & MASK64;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) & MASK64;
		}
		const next = [a, b, c, d, e, f, g, h];
		for (let index = 0; index < 8; index++) {
			state[index] = (state[index] + next[index]) & MASK64;
		}
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let index = 0; index < 4; index++) {
		outView.setBigUint64(index * 8, state[index], false);
	}
	return out;
}

// --- Private keys -----------------------------------------------------------------------------

function derLength(length: number): number[] {
	if (length < 0x80) {
		return [length];
	}
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest & 0xff);
	}
	return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, ...parts: (readonly number[] | Uint8Array)[]): number[] {
	const content: number[] = [];
	for (const part of parts) {
		for (const byte of part) {
			content.push(byte);
		}
	}
	return [tag, ...derLength(content.length), ...content];
}

const OID_RSA = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_CURVES: Readonly<Record<string, readonly number[]>> = {
	'P-256': [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
	'P-384': [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22],
	'P-521': [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23],
};

/**
 * A PEM private key as PKCS#8 bytes. `BEGIN PRIVATE KEY` is that already; the older
 * `BEGIN RSA PRIVATE KEY` and `BEGIN EC PRIVATE KEY` are wrapped into it.
 */
export function httpPemToPkcs8(pem: string, curve?: string): Uint8Array {
	const match = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/.exec(pem);
	if (!match) {
		if (/-----BEGIN /.test(pem)) {
			throw new Error('The private key must be a PEM "PRIVATE KEY" block.');
		}
		// The key's base64 alone, without the BEGIN and END lines.
		return httpFromBase64(pem);
	}
	const kind = match[1].trim();
	const body = httpFromBase64(match[2]);
	if (kind === 'ENCRYPTED') {
		throw new Error('The private key is encrypted. Use an unencrypted PKCS#8 key.');
	}
	if (kind === 'RSA') {
		return new Uint8Array(der(0x30, [0x02, 0x01, 0x00], der(0x30, OID_RSA, [0x05, 0x00]), der(0x04, body)));
	}
	if (kind === 'EC') {
		return new Uint8Array(der(0x30, [0x02, 0x01, 0x00], der(0x30, OID_EC, OID_CURVES[curve ?? 'P-256'] ?? OID_CURVES['P-256']), der(0x04, body)));
	}
	return body;
}

export type HttpKeyScheme = 'RSASSA-PKCS1-v1_5' | 'RSA-PSS' | 'ECDSA';

/** Signs with a PEM private key. An ECDSA signature is `r || s`, as a JWT wants it. */
export async function httpSignWithKey(scheme: HttpKeyScheme, hash: HttpHashName, pem: string, data: Uint8Array, curve?: string): Promise<Uint8Array> {
	if (!pem.trim()) {
		throw new Error('The private key is empty.');
	}
	const subtle = globalThis.crypto.subtle;
	const pkcs8 = own(httpPemToPkcs8(pem, curve));
	let key: CryptoKey;
	try {
		key = scheme === 'ECDSA'
			? await subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: curve ?? 'P-256' }, false, ['sign'])
			: await subtle.importKey('pkcs8', pkcs8, { name: scheme, hash }, false, ['sign']);
	} catch {
		throw new Error(scheme === 'ECDSA' ? `The private key could not be read as a PEM EC key on curve ${curve ?? 'P-256'}.` : 'The private key could not be read as a PEM RSA key.');
	}
	const bits = hash === 'SHA-1' ? 160 : Number(hash.slice(4));
	const signature = scheme === 'ECDSA'
		? await subtle.sign({ name: 'ECDSA', hash }, key, own(data))
		: scheme === 'RSA-PSS'
			? await subtle.sign({ name: 'RSA-PSS', saltLength: bits / 8 }, key, own(data))
			: await subtle.sign(scheme, key, own(data));
	return new Uint8Array(signature);
}
