/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Context, MiddlewareHandler } from 'hono';
import { can, type Permission } from '../../shared/rbac.js';
import { auth, type Session } from '../auth.js';
import { db } from '../db.js';
import type { IAuditInput } from './audit.js';

export interface IOrgContext {
	readonly id: string;
	readonly role: string;
	readonly memberId: string;
}

export type AppEnv = {
	Variables: {
		user: Session['user'];
		session: Session['session'];
		org: IOrgContext;
	};
};

export function clientIp(c: Context): string | null {
	return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
}

export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502, error: string, code?: string) {
	return c.json(code ? { error, code } : { error }, status);
}

/** A signed-in user (cookie session from the console, or a bearer session token from Volt). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) {
		return fail(c, 401, 'Sign in required', 'unauthenticated');
	}
	c.set('user', session.user);
	c.set('session', session.session);
	await next();
};

/**
 * The session's active organization, and the caller's membership in it. Every console route that
 * reads or writes organization data runs behind this; repositories take `c.var.org.id` first.
 */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
	const organizationId = (c.var.session as { activeOrganizationId?: string | null }).activeOrganizationId;
	if (!organizationId) {
		return fail(c, 409, 'Choose an organization first', 'no_active_organization');
	}
	const member = await db.selectFrom('member').select(['id', 'role']).where('organizationId', '=', organizationId).where('userId', '=', c.var.user.id).executeTakeFirst();
	if (!member) {
		return fail(c, 403, 'You are not a member of this organization', 'not_member');
	}
	c.set('org', { id: organizationId, role: member.role, memberId: member.id });
	await next();
};

export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!can(c.var.org.role, permission)) {
			return fail(c, 403, 'Your role does not allow this', 'forbidden');
		}
		await next();
	};
}

export function hasPermission(c: Context<AppEnv>, permission: Permission): boolean {
	return can(c.var.org.role, permission);
}

/** The audit fields every console action shares. */
export function actor(c: Context<AppEnv>): Pick<IAuditInput, 'organizationId' | 'actorId' | 'actorType' | 'ip' | 'userAgent'> {
	return { organizationId: c.var.org.id, actorId: c.var.user.id, actorType: 'user', ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null };
}

export async function readJson<T>(c: Context): Promise<T | undefined> {
	try {
		return await c.req.json<T>();
	} catch {
		return undefined;
	}
}
