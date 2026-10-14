/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Context } from 'hono';
import { db, newId } from '../db.js';
import { env } from '../env.js';
import { signJwt, verifyDpop, verifyJwt } from '../lib/crypto.js';
import { deviceState, touchDevice } from '../lib/devices.js';
import { getSettings } from '../lib/settings.js';

/**
 * Volt credentials. A gateway token is an Ed25519-signed JWT the server issues to one registered
 * device of one member, for a few minutes, bound (`cnf.jkt`) to the device's key. Every use
 * carries a DPoP proof signed by that key, so a token copied out of Volt — into curl, another
 * tool, or another machine — is refused. Provider keys never leave the server.
 */
export const GATEWAY_TOKEN_PREFIX = 'vgt_';
const TOKEN_TYP = 'vgt+jwt';

interface IGatewayClaims {
	readonly iss: string;
	readonly sub: string;
	readonly org: string;
	readonly dev: string;
	readonly cnf: { readonly jkt: string };
	readonly iat: number;
	readonly exp: number;
	readonly jti: string;
}

export interface IPrincipal {
	readonly organizationId: string;
	readonly userId: string;
	/** The Volt device the token is bound to; null for the console's gateway playground. */
	readonly deviceId: string | null;
	readonly client: string | null;
}

export async function issueGatewayToken(organizationId: string, userId: string, deviceId: string, jkt: string): Promise<{ readonly token: string; readonly expiresIn: number }> {
	const { tokenTtlMinutes } = await getSettings(organizationId);
	const iat = Math.floor(Date.now() / 1000);
	const expiresIn = tokenTtlMinutes * 60;
	const claims: IGatewayClaims = { iss: env.baseUrl, sub: userId, org: organizationId, dev: deviceId, cnf: { jkt }, iat, exp: iat + expiresIn, jti: newId() };
	return { token: `${GATEWAY_TOKEN_PREFIX}${await signJwt({ ...claims }, TOKEN_TYP)}`, expiresIn };
}

/** The token from whichever header the client's SDK uses. */
function presentedToken(c: Context): string | undefined {
	const authorization = c.req.header('authorization');
	const candidates = [
		authorization?.replace(/^(?:Bearer|DPoP)\s+/i, ''),
		c.req.header('x-api-key'),
		c.req.header('api-key'),
	];
	return candidates.find(v => v?.startsWith(GATEWAY_TOKEN_PREFIX));
}

const memberships = new Map<string, { readonly at: number; readonly ok: boolean }>();

async function isMember(organizationId: string, userId: string): Promise<boolean> {
	const key = `${organizationId}:${userId}`;
	const hit = memberships.get(key);
	if (hit && Date.now() - hit.at < 30_000) {
		return hit.ok;
	}
	const row = await db.selectFrom('member').select('id').where('organizationId', '=', organizationId).where('userId', '=', userId).executeTakeFirst();
	memberships.set(key, { at: Date.now(), ok: !!row });
	return !!row;
}

export type AuthResult = { readonly principal: IPrincipal } | { readonly status: 401 | 403; readonly error: string; readonly code: string };

export async function authenticate(c: Context): Promise<AuthResult> {
	const raw = presentedToken(c);
	if (!raw) {
		return { status: 401, error: 'A Volt gateway token is required. Sign in to your organization in Volt.', code: 'missing_token' };
	}
	const token = raw.slice(GATEWAY_TOKEN_PREFIX.length);
	const claims = await verifyJwt<IGatewayClaims>(token, TOKEN_TYP);
	if (!claims || claims.iss !== env.baseUrl) {
		return { status: 401, error: 'The gateway token is invalid or expired.', code: 'invalid_token' };
	}
	const device = await deviceState(claims.dev);
	if (!device || device.revoked || device.organizationId !== claims.org || device.userId !== claims.sub) {
		return { status: 401, error: 'This device has been revoked.', code: 'device_revoked' };
	}
	if (!await isMember(claims.org, claims.sub)) {
		return { status: 403, error: 'You are no longer a member of this organization.', code: 'not_member' };
	}
	const settings = await getSettings(claims.org);
	if (settings.requireDeviceBinding) {
		const proof = verifyDpop(c.req.header('dpop'), { method: c.req.method, path: new URL(c.req.url).pathname, accessToken: raw, expectedJkt: claims.cnf.jkt });
		if ('error' in proof) {
			return { status: 401, error: `${proof.error}. Gateway tokens only work from the Volt device they were issued to.`, code: 'dpop_required' };
		}
	}
	touchDevice(device.id);
	return { principal: { organizationId: claims.org, userId: claims.sub, deviceId: claims.dev, client: c.req.header('x-volt-client')?.slice(0, 80) ?? c.req.header('user-agent')?.slice(0, 80) ?? null } };
}
