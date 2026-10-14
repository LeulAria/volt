/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type { IScimConnection, IScimIssued } from '../../shared/api.js';
import { auth } from '../auth.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { actor, type AppEnv, fail, readJson, requireOrg, requirePermission, requireSession } from '../lib/context.js';

/**
 * Identity: SSO connections (OIDC or SAML, one per email domain set, verified by a DNS TXT record)
 * and SCIM provisioning (a managed connection per organization; the identity provider pushes
 * users and groups, which become members and roles). Both are Better Auth plugins; this API adds
 * organization scoping, permissions and audit.
 */
export const identityApi = new Hono<AppEnv>();
identityApi.use('*', requireSession, requireOrg);

type Api = Record<string, (input: Record<string, unknown>) => Promise<any>>;
const api = auth.api as unknown as Api;

function errorText(err: unknown): string {
	if (err && typeof err === 'object' && 'body' in err) {
		const body = (err as { body?: { message?: string } }).body;
		if (body?.message) {
			return body.message;
		}
	}
	return err instanceof Error ? err.message : String(err);
}

//#region SSO

identityApi.get('/sso', requirePermission({ identity: ['read'] }), async c => {
	try {
		const result = await api.listSSOProviders({ headers: c.req.raw.headers }) as { providers: { providerId: string; organizationId: string | null }[] };
		const providers = result.providers.filter(p => p.organizationId === c.var.org.id);
		return c.json({
			providers,
			spEntityBase: env.baseUrl,
			oidcRedirectBase: `${env.baseUrl}/api/auth/sso/callback`,
			samlAcsBase: `${env.baseUrl}/api/auth/sso/saml2/sp/acs`,
		});
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

interface ISsoInput {
	readonly providerId?: string;
	readonly protocol?: 'oidc' | 'saml';
	readonly domain?: string;
	readonly issuer?: string;
	readonly oidc?: { readonly clientId?: string; readonly clientSecret?: string; readonly discoveryEndpoint?: string; readonly scopes?: string[] };
	readonly saml?: { readonly entryPoint?: string; readonly cert?: string; readonly idpMetadataXml?: string; readonly audience?: string };
}

identityApi.post('/sso', requirePermission({ identity: ['update'] }), async c => {
	const input = await readJson<ISsoInput>(c);
	const providerId = input?.providerId?.trim().toLowerCase();
	const domain = input?.domain?.trim().toLowerCase().replace(/^@/, '');
	if (!input || !providerId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(providerId) || !domain || !input.issuer) {
		return fail(c, 400, 'A connection id (letters, digits, -), an email domain and the issuer URL are required');
	}
	const body: Record<string, unknown> = { providerId, domain, issuer: input.issuer.trim(), organizationId: c.var.org.id };
	if (input.protocol === 'saml') {
		if (!input.saml?.entryPoint || (!input.saml.cert && !input.saml.idpMetadataXml)) {
			return fail(c, 400, 'SAML needs the IdP SSO URL and its signing certificate (or metadata XML)');
		}
		body.samlConfig = {
			entryPoint: input.saml.entryPoint.trim(),
			cert: input.saml.cert?.trim() ?? '',
			callbackUrl: `${env.baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`,
			audience: input.saml.audience?.trim() || env.baseUrl,
			...(input.saml.idpMetadataXml ? { idpMetadata: { metadata: input.saml.idpMetadataXml } } : {}),
			spMetadata: {},
			wantAssertionsSigned: true,
		};
	} else {
		if (!input.oidc?.clientId || !input.oidc.clientSecret) {
			return fail(c, 400, 'OIDC needs a client id and client secret');
		}
		body.oidcConfig = {
			clientId: input.oidc.clientId.trim(),
			clientSecret: input.oidc.clientSecret.trim(),
			discoveryEndpoint: input.oidc.discoveryEndpoint?.trim() || `${input.issuer.trim().replace(/\/+$/, '')}/.well-known/openid-configuration`,
			scopes: input.oidc.scopes?.length ? input.oidc.scopes : ['openid', 'email', 'profile'],
			pkce: true,
		};
	}
	try {
		const result = await api.registerSSOProvider({ body, headers: c.req.raw.headers }) as Record<string, unknown>;
		await audit({ ...actor(c), action: 'sso.create', targetType: 'sso', targetId: providerId, detail: { protocol: input.protocol ?? 'oidc', domain } });
		return c.json({ providerId, domainVerificationToken: result.domainVerificationToken ?? null, redirectURI: result.redirectURI ?? null }, 201);
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/sso/:providerId/request-verification', requirePermission({ identity: ['update'] }), async c => {
	try {
		const result = await api.requestDomainVerification({ body: { providerId: c.req.param('providerId') }, headers: c.req.raw.headers }) as { domainVerificationToken: string };
		return c.json({ token: result.domainVerificationToken, record: `_volt-govern-verification-${c.req.param('providerId')}` });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/sso/:providerId/verify', requirePermission({ identity: ['update'] }), async c => {
	try {
		await api.verifyDomain({ body: { providerId: c.req.param('providerId') }, headers: c.req.raw.headers });
		await audit({ ...actor(c), action: 'sso.verify-domain', targetType: 'sso', targetId: c.req.param('providerId') });
		return c.json({ verified: true });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.delete('/sso/:providerId', requirePermission({ identity: ['update'] }), async c => {
	try {
		await api.deleteSSOProvider({ body: { providerId: c.req.param('providerId') }, headers: c.req.raw.headers });
		await audit({ ...actor(c), action: 'sso.delete', targetType: 'sso', targetId: c.req.param('providerId') });
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

//#endregion

//#region SCIM

const SCOPES = ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'];
const SCIM_ENDPOINT = `${env.baseUrl}/api/auth/scim/v2`;

interface IManagedConnection { connectionId: string; status: string; createdAt: Date | string }
interface IManagedCredential { credentialId: string; status: string; expiresAt: Date | string; lastUsedAt: Date | string | null }

const asIso = (d: Date | string | null): string | null => d === null ? null : new Date(d).toISOString();

function toConnection(connection: IManagedConnection, credentials: readonly IManagedCredential[]): IScimConnection {
	return {
		connectionId: connection.connectionId,
		status: connection.status,
		createdAt: asIso(connection.createdAt)!,
		endpoint: SCIM_ENDPOINT,
		credentials: credentials.map(cr => ({ credentialId: cr.credentialId, status: cr.status, expiresAt: asIso(cr.expiresAt)!, lastUsedAt: asIso(cr.lastUsedAt) })),
	};
}

function expiry(days: unknown): Date {
	const d = typeof days === 'number' && days >= 1 && days <= 730 ? days : 365;
	return new Date(Date.now() + d * 86_400_000);
}

identityApi.get('/scim', requirePermission({ identity: ['read'] }), async c => {
	try {
		const { connections } = await api.listSCIMManagedConnections({ body: { provisioningDomainId: c.var.org.id } }) as { connections: IManagedConnection[] };
		const detailed = await Promise.all(connections.map(async conn => {
			const { credentials } = await api.getSCIMManagedConnection({ body: { connectionId: conn.connectionId, provisioningDomainId: c.var.org.id } }) as { credentials: IManagedCredential[] };
			return toConnection(conn, credentials);
		}));
		return c.json({ endpoint: SCIM_ENDPOINT, connections: detailed });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/scim', requirePermission({ identity: ['update'] }), async c => {
	const input = await readJson<{ expiresInDays?: number }>(c);
	try {
		const result = await api.createSCIMManagedConnection({
			body: { provisioningDomainId: c.var.org.id, creationRequestId: crypto.randomUUID(), actorId: c.var.user.id, scopes: SCOPES, expiresAt: expiry(input?.expiresInDays), noStore: true },
		}) as { connection: IManagedConnection; credential: IManagedCredential; token: string };
		await audit({ ...actor(c), action: 'scim.create', targetType: 'scim', targetId: result.connection.connectionId });
		const issued: IScimIssued = { connection: toConnection(result.connection, [result.credential]), token: result.token };
		return c.json(issued, 201);
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/scim/:connectionId/rotate', requirePermission({ identity: ['update'] }), async c => {
	const input = await readJson<{ expiresInDays?: number }>(c);
	try {
		const result = await api.rotateSCIMManagedCredential({
			body: { connectionId: c.req.param('connectionId'), provisioningDomainId: c.var.org.id, actorId: c.var.user.id, scopes: SCOPES, expiresAt: expiry(input?.expiresInDays), noStore: true },
		}) as { connection: IManagedConnection; credential: IManagedCredential; token: string };
		await audit({ ...actor(c), action: 'scim.rotate', targetType: 'scim', targetId: c.req.param('connectionId') });
		return c.json({ connection: toConnection(result.connection, [result.credential]), token: result.token } satisfies IScimIssued);
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/scim/:connectionId/credentials/:credentialId/revoke', requirePermission({ identity: ['update'] }), async c => {
	try {
		await api.revokeSCIMManagedCredential({ body: { connectionId: c.req.param('connectionId'), provisioningDomainId: c.var.org.id, credentialId: c.req.param('credentialId'), actorId: c.var.user.id } });
		await audit({ ...actor(c), action: 'scim.revoke', targetType: 'scim', targetId: c.req.param('connectionId'), detail: { credential: c.req.param('credentialId') } });
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

identityApi.post('/scim/:connectionId/decommission', requirePermission({ identity: ['update'] }), async c => {
	try {
		await api.decommissionSCIMManagedConnection({ body: { connectionId: c.req.param('connectionId'), provisioningDomainId: c.var.org.id, actorId: c.var.user.id } });
		await audit({ ...actor(c), action: 'scim.decommission', targetType: 'scim', targetId: c.req.param('connectionId') });
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, 400, errorText(err));
	}
});

//#endregion
