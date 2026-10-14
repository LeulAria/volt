/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { scim } from '@better-auth/scim';
import { sso } from '@better-auth/sso';
import { APIError, type BetterAuthOptions } from 'better-auth';
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins';
import { ac, ROLE_NAMES, roles } from '../shared/rbac.js';
import { db, dbType } from './db.js';
import { env } from './env.js';
import { audit } from './lib/audit.js';
import { revokeUserDevices } from './lib/devices.js';
import { getSettings } from './lib/settings.js';

/** The client id Volt desktop uses for the device authorization grant. */
export const VOLT_DESKTOP_CLIENT_ID = 'volt-desktop';

function emailDomain(email: string): string {
	return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * SCIM groups grant roles by name: a group called `volt-admin` (or `Volt Admins`, `volt_security`)
 * maps to the matching organization role. Anything else grants nothing beyond `member`.
 */
function roleFromGroup(name: string | undefined): string | undefined {
	const slug = (name ?? '').toLowerCase().replace(/[^a-z]+/g, '-');
	return ROLE_NAMES.find(role => role !== 'owner' && (slug === `volt-${role}` || slug === `volt-${role}s`));
}

export const authOptions = {
	appName: 'Volt Govern',
	baseURL: env.baseUrl,
	basePath: '/api/auth',
	secret: env.authSecret,
	// Native transactions: SCIM reconciles users and memberships atomically.
	database: { db, type: dbType, transaction: true },
	trustedOrigins: [env.baseUrl, ...env.trustedOrigins],
	emailAndPassword: { enabled: true, minPasswordLength: 10 },
	session: {
		expiresIn: 60 * 60 * 24 * 7,
		updateAge: 60 * 60 * 24,
	},
	advanced: {
		useSecureCookies: env.production,
		cookiePrefix: 'volt-govern',
	},
	plugins: [
		organization({
			ac,
			roles,
			creatorRole: 'owner',
			teams: { enabled: true, allowRemovingAllTeams: true, defaultTeam: { enabled: false } },
			invitationExpiresIn: 60 * 60 * 24 * 7,
			cancelPendingInvitationsOnReInvite: true,
			async sendInvitationEmail({ id, email, organization: org, inviter }) {
				// No mail transport is configured by default: the console shows the link to copy, and
				// the server logs it. Wire SMTP / an email API here.
				console.info(`[volt-govern] invitation for ${email} to ${org.name} from ${inviter.user.email}: ${env.baseUrl}/accept-invite/${id}`);
			},
			organizationHooks: {
				async beforeAddMember({ member, user, organization: org }) {
					const { allowedEmailDomains } = await getSettings(org.id);
					if (allowedEmailDomains.length && !allowedEmailDomains.includes(emailDomain(user.email))) {
						throw new APIError('FORBIDDEN', { message: `${org.name} only admits people with an email at ${allowedEmailDomains.join(', ')}` });
					}
					return { data: member };
				},
				async afterAddMember({ member, user, organization: org }) {
					await audit({ organizationId: org.id, actorType: 'system', action: 'member.add', targetType: 'user', targetId: user.id, detail: { email: user.email, role: member.role } });
				},
				async afterRemoveMember({ user, organization: org }) {
					await revokeUserDevices(org.id, user.id, 'system');
					await audit({ organizationId: org.id, actorType: 'system', action: 'member.remove', targetType: 'user', targetId: user.id, detail: { email: user.email } });
				},
				async afterUpdateMemberRole({ member, previousRole, user, organization: org }) {
					await audit({ organizationId: org.id, actorType: 'system', action: 'member.role', targetType: 'user', targetId: user.id, detail: { email: user.email, from: previousRole, to: member.role } });
				},
				async afterCreateInvitation({ invitation, inviter, organization: org }) {
					await audit({ organizationId: org.id, actorId: inviter.id, action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, detail: { email: invitation.email, role: invitation.role } });
				},
				async afterCreateTeam({ team, user, organization: org }) {
					await audit({ organizationId: org.id, actorId: user?.id ?? null, action: 'team.create', targetType: 'team', targetId: team.id, detail: { name: team.name } });
				},
				async afterDeleteTeam({ team, user, organization: org }) {
					await audit({ organizationId: org.id, actorId: user?.id ?? null, action: 'team.delete', targetType: 'team', targetId: team.id, detail: { name: team.name } });
				},
			},
		}),
		sso({
			organizationProvisioning: { defaultRole: 'member' },
			domainVerification: { enabled: true, tokenPrefix: 'volt-govern-verification' },
			async provisionUser({ user, provider }) {
				if (provider.organizationId) {
					await audit({ organizationId: provider.organizationId, actorType: 'system', action: 'sso.provision', targetType: 'user', targetId: user.id, detail: { email: user.email, provider: provider.providerId } });
				}
			},
		}),
		scim({
			connections: [],
			managedConnections: { credentialHashSecret: env.scimSecret },
			projection: {
				roles: {
					map: ({ source }) => {
						const role = roleFromGroup('displayName' in source ? String((source as { displayName?: string }).displayName ?? '') : undefined);
						return role ? [role] : undefined;
					},
					exists: ({ role }) => role in roles,
				},
				/**
				 * The managed connection's provisioning domain is the organization id: an active SCIM
				 * user becomes (or stays) a member with the highest role its groups grant; a deactivated
				 * or deleted one leaves the organization and loses its Volt devices.
				 */
				async reconcileUser({ provisioningDomainId: organizationId, userId, active, grants }, { database }) {
					const existing = await database.findOne<{ id: string; role: string }>({
						model: 'member',
						where: [{ field: 'organizationId', value: organizationId }, { field: 'userId', value: userId }],
					});
					if (!active) {
						if (existing) {
							await database.delete({ model: 'member', where: [{ field: 'id', value: existing.id }] });
							await revokeUserDevices(organizationId, userId, 'scim');
							await audit({ organizationId, actorType: 'scim', action: 'member.deprovision', targetType: 'user', targetId: userId });
						}
						return;
					}
					const order = ['admin', 'security', 'billing', 'curator', 'member'];
					const granted = grants.map(g => g.role).filter(r => order.includes(r)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
					const role = granted[0] ?? 'member';
					if (!existing) {
						await database.create({ model: 'member', data: { organizationId, userId, role, createdAt: new Date() } });
						await audit({ organizationId, actorType: 'scim', action: 'member.provision', targetType: 'user', targetId: userId, detail: { role } });
					} else if (existing.role !== role && existing.role !== 'owner') {
						await database.update({ model: 'member', where: [{ field: 'id', value: existing.id }], update: { role } });
						await audit({ organizationId, actorType: 'scim', action: 'member.role', targetType: 'user', targetId: userId, detail: { from: existing.role, to: role } });
					}
				},
			},
		}),
		deviceAuthorization({
			verificationUri: '/device',
			expiresIn: '10m',
			interval: '5s',
			validateClient: clientId => clientId === VOLT_DESKTOP_CLIENT_ID,
		}),
		bearer(),
	],
} satisfies BetterAuthOptions;
