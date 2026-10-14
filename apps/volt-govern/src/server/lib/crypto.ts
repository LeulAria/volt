/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, type JsonWebKey, type KeyObject, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
import { db, now } from '../db.js';
import { env } from '../env.js';

//#region Credential encryption

/**
 * Provider secrets are sealed with AES-256-GCM under a key derived (HKDF-SHA256) from the master
 * key and the organization id, so one organization's ciphertext is useless under another's key and
 * a database dump without the master key reveals nothing. The organization id is also bound as
 * associated data. Format: `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
function derivedKey(purpose: string, salt: string): Buffer {
	return Buffer.from(hkdfSync('sha256', env.masterKey, Buffer.from(salt), Buffer.from(`volt-govern/${purpose}/v1`), 32));
}

export function seal(plaintext: string, organizationId: string, purpose = 'credential'): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', derivedKey(purpose, organizationId), iv);
	cipher.setAAD(Buffer.from(organizationId));
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function unseal(sealed: string, organizationId: string, purpose = 'credential'): string {
	const [version, iv, tag, ciphertext] = sealed.split('.');
	if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
		throw new Error('Unrecognized sealed value');
	}
	const decipher = createDecipheriv('aes-256-gcm', derivedKey(purpose, organizationId), Buffer.from(iv, 'base64url'));
	decipher.setAAD(Buffer.from(organizationId));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

//#endregion

//#region Base64url and hashing

export const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');
export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7638 JWK thumbprint (EC, OKP and RSA public keys). */
export function jwkThumbprint(jwk: JsonWebKey): string {
	let members: Record<string, unknown>;
	switch (jwk.kty) {
		case 'EC': members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }; break;
		case 'OKP': members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x }; break;
		case 'RSA': members = { e: jwk.e, kty: jwk.kty, n: jwk.n }; break;
		default: throw new Error(`Unsupported key type ${String(jwk.kty)}`);
	}
	return b64url(sha256(JSON.stringify(members)));
}

//#endregion

//#region Server signing key (Ed25519)

interface ISigningKey {
	readonly kid: string;
	readonly privateKey: KeyObject;
	readonly publicJwk: JsonWebKey;
}

let signingKey: Promise<ISigningKey> | undefined;
const verifyKeys = new Map<string, KeyObject>();

/**
 * The server's Ed25519 key signs gateway tokens and Volt policy bundles. Created on first use,
 * stored sealed under the master key; Volt verifies with the published JWKS.
 */
export function serverKey(): Promise<ISigningKey> {
	signingKey ??= (async () => {
		const row = await db.selectFrom('gov_server_key').selectAll().where('retired_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
		if (row) {
			const privateKey = createPrivateKey(unseal(row.private_enc, 'server', 'signing-key'));
			return { kid: row.kid, privateKey, publicJwk: JSON.parse(row.public_jwk) as JsonWebKey };
		}
		const pair = generateKeyPairSync('ed25519');
		const publicJwk = pair.publicKey.export({ format: 'jwk' });
		const kid = jwkThumbprint(publicJwk);
		await db.insertInto('gov_server_key').values({
			kid,
			public_jwk: JSON.stringify(publicJwk),
			private_enc: seal(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'server', 'signing-key'),
			created_at: now(),
			retired_at: null,
		}).execute();
		return { kid, privateKey: pair.privateKey, publicJwk };
	})();
	return signingKey;
}

export async function jwks(): Promise<{ keys: JsonWebKey[] }> {
	await serverKey();
	const rows = await db.selectFrom('gov_server_key').select(['kid', 'public_jwk']).execute();
	return { keys: rows.map(r => ({ ...(JSON.parse(r.public_jwk) as JsonWebKey), kid: r.kid, use: 'sig', alg: 'EdDSA' })) };
}

async function verifyKey(kid: string): Promise<KeyObject | undefined> {
	let key = verifyKeys.get(kid);
	if (!key) {
		const row = await db.selectFrom('gov_server_key').select('public_jwk').where('kid', '=', kid).executeTakeFirst();
		if (!row) {
			return undefined;
		}
		key = createPublicKey({ key: JSON.parse(row.public_jwk) as JsonWebKey, format: 'jwk' });
		verifyKeys.set(kid, key);
	}
	return key;
}

//#endregion

//#region JWT (compact JWS)

export async function signJwt(payload: Record<string, unknown>, typ: string): Promise<string> {
	const key = await serverKey();
	const head = b64url(JSON.stringify({ alg: 'EdDSA', typ, kid: key.kid }));
	const body = b64url(JSON.stringify(payload));
	const signature = sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
	return `${head}.${body}.${b64url(signature)}`;
}

/** Verifies an EdDSA token this server issued. Returns the payload, or undefined when invalid or expired. */
export async function verifyJwt<T extends { exp?: number }>(token: string, typ: string): Promise<T | undefined> {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; typ?: string; kid?: string };
		if (header.alg !== 'EdDSA' || header.typ !== typ || !header.kid) {
			return undefined;
		}
		const key = await verifyKey(header.kid);
		if (!key || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) {
			return undefined;
		}
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as T;
		if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
			return undefined;
		}
		return payload;
	} catch {
		return undefined;
	}
}

//#endregion

//#region DPoP (RFC 9449)

const seenProofs = new Map<string, number>();
const PROOF_WINDOW_S = 120;

function rememberProof(jti: string): boolean {
	const t = Date.now();
	if (seenProofs.size > 50_000) {
		for (const [key, at] of seenProofs) {
			if (t - at > PROOF_WINDOW_S * 2000) {
				seenProofs.delete(key);
			}
		}
	}
	if (seenProofs.has(jti)) {
		return false;
	}
	seenProofs.set(jti, t);
	return true;
}

export interface IDpopCheck {
	readonly method: string;
	/** Path of the request (proxies may rewrite scheme and host; the path is what is bound). */
	readonly path: string;
	/** The access token the proof must be bound to (`ath`); absent when minting a token. */
	readonly accessToken?: string;
	/** The JWK thumbprint the proof's key must have. */
	readonly expectedJkt?: string;
}

/**
 * Verifies a DPoP proof: an ES256/EdDSA JWT signed by the device key whose public JWK is in its
 * header, naming this method and path, fresh, never replayed, and bound to the access token.
 * Returns the proof key's thumbprint and JWK.
 */
export function verifyDpop(proof: string | undefined, check: IDpopCheck): { readonly jkt: string; readonly jwk: JsonWebKey } | { readonly error: string } {
	if (!proof) {
		return { error: 'DPoP proof required' };
	}
	const parts = proof.split('.');
	if (parts.length !== 3) {
		return { error: 'Malformed DPoP proof' };
	}
	try {
		const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { typ?: string; alg?: string; jwk?: JsonWebKey };
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { htm?: string; htu?: string; iat?: number; jti?: string; ath?: string };
		if (header.typ !== 'dpop+jwt' || !header.jwk || (header.alg !== 'ES256' && header.alg !== 'EdDSA')) {
			return { error: 'DPoP proof header invalid' };
		}
		const key = createPublicKey({ key: header.jwk, format: 'jwk' });
		const data = Buffer.from(`${parts[0]}.${parts[1]}`);
		const signature = Buffer.from(parts[2], 'base64url');
		const valid = header.alg === 'ES256'
			? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
			: verify(null, data, key, signature);
		if (!valid) {
			return { error: 'DPoP signature invalid' };
		}
		if (payload.htm?.toUpperCase() !== check.method.toUpperCase()) {
			return { error: 'DPoP method mismatch' };
		}
		let proofPath: string;
		try {
			proofPath = new URL(payload.htu ?? '').pathname;
		} catch {
			return { error: 'DPoP htu invalid' };
		}
		if (proofPath !== check.path) {
			return { error: 'DPoP URL mismatch' };
		}
		if (typeof payload.iat !== 'number' || Math.abs(Date.now() / 1000 - payload.iat) > PROOF_WINDOW_S) {
			return { error: 'DPoP proof expired' };
		}
		if (!payload.jti || !rememberProof(payload.jti)) {
			return { error: 'DPoP proof replayed' };
		}
		if (check.accessToken && payload.ath !== b64url(sha256(check.accessToken))) {
			return { error: 'DPoP proof not bound to this token' };
		}
		const jkt = jwkThumbprint(header.jwk);
		if (check.expectedJkt && !safeEqual(jkt, check.expectedJkt)) {
			return { error: 'DPoP key does not match the token' };
		}
		return { jkt, jwk: header.jwk };
	} catch {
		return { error: 'DPoP proof invalid' };
	}
}

//#endregion
