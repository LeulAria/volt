/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

/**
 * What an organization role may do. Better Auth's organization statements (organization, member,
 * invitation, team, ac) plus Volt Govern's own resources. The same object drives the server's
 * checks and the console's (which hides what a role cannot do; the server still decides).
 */
export const statements = {
	...defaultStatements,
	credential: ['read', 'create', 'update', 'delete'],
	policy: ['read', 'update'],
	mcp: ['read', 'create', 'update', 'delete', 'approve'],
	skill: ['read', 'create', 'update', 'delete', 'publish'],
	usage: ['read'],
	audit: ['read'],
	device: ['read', 'revoke'],
	identity: ['read', 'update'],
	settings: ['read', 'update'],
} as const;

export const ac = createAccessControl(statements);

const everything = {
	credential: ['read', 'create', 'update', 'delete'],
	policy: ['read', 'update'],
	mcp: ['read', 'create', 'update', 'delete', 'approve'],
	skill: ['read', 'create', 'update', 'delete', 'publish'],
	usage: ['read'],
	audit: ['read'],
	device: ['read', 'revoke'],
	identity: ['read', 'update'],
	settings: ['read', 'update'],
} as const;

export const roles = {
	owner: ac.newRole({
		organization: ['update', 'delete'],
		member: ['create', 'update', 'delete'],
		invitation: ['create', 'cancel'],
		team: ['create', 'update', 'delete'],
		ac: ['create', 'read', 'update', 'delete'],
		...everything,
	}),
	admin: ac.newRole({
		organization: ['update'],
		member: ['create', 'update', 'delete'],
		invitation: ['create', 'cancel'],
		team: ['create', 'update', 'delete'],
		ac: ['read'],
		...everything,
	}),
	/** Guards the perimeter: policies, MCP, devices, audit. Cannot touch keys or people. */
	security: ac.newRole({
		ac: ['read'],
		credential: ['read'],
		policy: ['read', 'update'],
		mcp: ['read', 'create', 'update', 'delete', 'approve'],
		skill: ['read'],
		usage: ['read'],
		audit: ['read'],
		device: ['read', 'revoke'],
		identity: ['read'],
		settings: ['read'],
	}),
	/** Watches spend. */
	billing: ac.newRole({
		credential: ['read'],
		policy: ['read'],
		usage: ['read'],
		audit: ['read'],
		settings: ['read'],
	}),
	/** Curates the shared skills, rules and agents. */
	curator: ac.newRole({
		mcp: ['read'],
		skill: ['read', 'create', 'update', 'delete', 'publish'],
		policy: ['read'],
	}),
	/** Every developer: uses Volt through the gateway, sees the shared catalog. */
	member: ac.newRole({
		mcp: ['read'],
		skill: ['read'],
	}),
};

export type RoleName = keyof typeof roles;
export const ROLE_NAMES = Object.keys(roles) as RoleName[];

export const ROLE_LABELS: Record<RoleName, { readonly label: string; readonly detail: string }> = {
	owner: { label: 'Owner', detail: 'Everything, including deleting the organization' },
	admin: { label: 'Admin', detail: 'People, teams, keys, policies, identity' },
	security: { label: 'Security', detail: 'Policies, MCP, devices and the audit log' },
	billing: { label: 'Billing', detail: 'Usage, spend and budgets (read only)' },
	curator: { label: 'Curator', detail: 'Shared skills, rules and agents' },
	member: { label: 'Developer', detail: 'Uses Volt through the gateway' },
};

export type Resource = Exclude<keyof typeof statements, 'organization' | 'invitation' | 'ac'> | 'organization' | 'invitation' | 'ac';
export type Permission<R extends keyof typeof statements = keyof typeof statements> = { [K in R]?: readonly (typeof statements)[K][number][] };

/**
 * Whether a member's role string (Better Auth stores several as `a,b`) grants every action asked.
 * Unknown roles grant nothing.
 */
export function can(roleField: string | undefined, permission: Permission): boolean {
	if (!roleField) {
		return false;
	}
	const held = roleField.split(',').map(r => r.trim()).filter((r): r is RoleName => r in roles);
	return Object.entries(permission).every(([resource, actions]) =>
		(actions ?? []).every(action => held.some(role => {
			const granted = (roles[role].statements as Record<string, readonly string[] | undefined>)[resource];
			return !!granted?.includes(action);
		})));
}
