/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-session credentials for the host MCP server (spec I.15, B-07).
 *
 * A server has one random secret that only Volt holds (the window or the agent server that
 * registered it). An agent never gets it: it gets a token for its own chat,
 * `<epoch>.<expiry>.HMAC-SHA256(secret, "<sessionId>\n<groups>\n<epoch>\n<expiry>")`, and the
 * server accepts a request on `/mcp/<sessionId>?groups=…` only with a token for exactly that
 * session and those groups, before its expiry, and with a key epoch above the last one the chat
 * was revoked at. So an agent cannot act as another chat (its id is in `thread_list`) or widen its
 * tool groups, a token stops working a day after it was issued, and a closed chat's token dies at
 * once. A request without a session needs the secret itself.
 *
 * The key epoch is a number the issuer takes from a monotonic clock: a revocation records one,
 * and every token issued after it carries a larger one.
 *
 * Pure and synchronous: the renderer builds an agent's MCP config synchronously (it is compared
 * on every turn to tell a stale session), and the main process checks the same value with Node's
 * crypto.
 */

/** How long a session token is valid. */
export const HOST_MCP_TOKEN_TTL_MS = 24 * 60 * 60_000;

/**
 * A new token is issued once the current one has less than this left. A new token restarts the
 * chat's agent (its MCP config changed), so it happens at a turn boundary well before expiry.
 */
export const HOST_MCP_TOKEN_RENEW_MS = 6 * 60 * 60_000;

/** When and until when a session's token was issued. */
export interface IHostMcpLease {
	/** The key epoch: above the chat's last revocation. */
	readonly epoch: number;
	/** Milliseconds since 1970; the token is refused from then on. */
	readonly expiry: number;
}

/** A lease starting now, at `epoch` (a monotonic clock reading). */
export function newHostMcpLease(epoch = Date.now()): IHostMcpLease {
	return { epoch, expiry: epoch + HOST_MCP_TOKEN_TTL_MS };
}

/** The lease a token carries, and its MAC; undefined for anything that is not a session token. */
export function parseHostMcpSessionToken(token: string): (IHostMcpLease & { readonly mac: string }) | undefined {
	const match = /^(\d{1,16})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(token);
	if (!match) {
		return undefined;
	}
	const epoch = Number(match[1]);
	const expiry = Number(match[2]);
	return Number.isSafeInteger(epoch) && Number.isSafeInteger(expiry) ? { epoch, expiry, mac: match[3] } : undefined;
}

/** `<epoch>.<expiry>.<mac>`: the token string for a lease and the hex MAC over its message. */
export function formatHostMcpSessionToken(lease: IHostMcpLease, mac: string): string {
	return `${lease.epoch}.${lease.expiry}.${mac}`;
}

/** The groups part of the signed message: `all` when the URL names none. */
export function hostMcpGroupsKey(groups: Iterable<string> | undefined): string {
	if (groups === undefined) {
		return 'all';
	}
	return `only:${normalizeHostMcpGroups(groups).join(',')}`;
}

/** Trimmed, without empties and duplicates, sorted: `?groups=image, core` and `core,image` sign the same. */
export function normalizeHostMcpGroups(groups: Iterable<string>): string[] {
	return [...new Set([...groups].map(group => group.trim()).filter(Boolean))].sort();
}

/** What a session's token signs. Versioned, so a change of format never accepts an old token. */
export function hostMcpSessionMessage(sessionId: string, groups: Iterable<string> | undefined, lease: IHostMcpLease): string {
	return `volt-host-mcp/2\n${sessionId}\n${hostMcpGroupsKey(groups)}\n${lease.epoch}\n${lease.expiry}`;
}

/**
 * The bearer token for one chat's agent: the lease and the hex HMAC-SHA256 of the session message
 * under the server secret. Without a lease, one that starts now.
 */
export function hostMcpSessionToken(secret: string, sessionId: string, groups?: Iterable<string>, lease: IHostMcpLease = newHostMcpLease()): string {
	return formatHostMcpSessionToken(lease, toHex(hmacSha256(utf8(secret), utf8(hostMcpSessionMessage(sessionId, groups, lease)))));
}

// --- SHA-256 / HMAC (FIPS 180-4, RFC 2104) ------------------------------------------------------

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK = 64;

function rotr(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

export function sha256(data: Uint8Array): Uint8Array {
	const length = data.length;
	// The message, a 1 bit, zeros, and the bit length as a 64-bit big-endian number, in whole blocks.
	const padded = new Uint8Array(Math.ceil((length + 9) / BLOCK) * BLOCK);
	padded.set(data);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = length * 8;
	view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
	view.setUint32(padded.length - 4, bits >>> 0);

	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	for (let offset = 0; offset < padded.length; offset += BLOCK) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(offset + i * 4);
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
		for (let i = 0; i < 64; i++) {
			const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			k = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0] + a) >>> 0;
		h[1] = (h[1] + b) >>> 0;
		h[2] = (h[2] + c) >>> 0;
		h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0;
		h[5] = (h[5] + f) >>> 0;
		h[6] = (h[6] + g) >>> 0;
		h[7] = (h[7] + k) >>> 0;
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) {
		outView.setUint32(i * 4, h[i]);
	}
	return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
	const block = new Uint8Array(BLOCK);
	block.set(key.length > BLOCK ? sha256(key) : key);
	const inner = new Uint8Array(BLOCK + message.length);
	const outer = new Uint8Array(BLOCK + 32);
	for (let i = 0; i < BLOCK; i++) {
		inner[i] = block[i] ^ 0x36;
		outer[i] = block[i] ^ 0x5c;
	}
	inner.set(message, BLOCK);
	outer.set(sha256(inner), BLOCK);
	return sha256(outer);
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
}
