/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAlert, IAuditEvent, ICredential, IDevice, IMcpServer, IMe, IOrgSettings, IOverview, IPolicyRecord, IRequestLog, ISkill } from '../../shared/api';
import type { IEffectivePolicy } from '../../shared/policy';
import { can, type Permission } from '../../shared/rbac';
import { api } from './api';
import { authClient, unwrap } from './auth';
import { useQuery } from './query';

/**
 * Query keys start with the organization, so a switch never shows the previous one's data. Pass
 * an empty organization to skip a query the role may not run.
 */
export const keys = {
	me: 'me',
	members: (org: string) => `${org}:members`,
	teams: (org: string) => `${org}:teams`,
	teamMembers: (org: string) => `${org}:team-members`,
	invitations: (org: string) => `${org}:invitations`,
	overview: (org: string) => `${org}:overview`,
	credentials: (org: string) => `${org}:credentials`,
	policies: (org: string) => `${org}:policies`,
	mcp: (org: string) => `${org}:mcp`,
	skills: (org: string) => `${org}:skills`,
	alerts: (org: string) => `${org}:alerts`,
	settings: (org: string) => `${org}:settings`,
	devices: (org: string) => `${org}:devices`,
	audit: (org: string) => `${org}:audit`,
	requests: (org: string) => `${org}:requests`,
	usage: (org: string) => `${org}:usage`,
	access: (org: string) => `${org}:my-access`,
	identity: (org: string) => `${org}:identity`,
};

export function useMe() {
	return useQuery<IMe>(keys.me, () => api.get<IMe>('/me'));
}

/** The active organization and what the signed-in member's role allows. */
export function useOrg(): { readonly orgId: string; readonly orgName: string; readonly role: string; readonly can: (p: Permission) => boolean; readonly me: IMe } {
	const { data } = useMe();
	const me = data!;
	const role = me.role ?? 'member';
	return { orgId: me.organization!.id, orgName: me.organization!.name, role, can: p => can(role, p), me };
}

export interface IMember {
	readonly id: string;
	readonly userId: string;
	readonly role: string;
	readonly createdAt: string;
	readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly image?: string | null };
}

export interface ITeam {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
}

export interface IInvitation {
	readonly id: string;
	readonly email: string;
	readonly role: string;
	readonly status: string;
	readonly expiresAt: string;
	readonly teamId?: string | null;
}

export function useMembers(org: string) {
	return useQuery(org ? keys.members(org) : undefined, async () => {
		const result = await unwrap(authClient.organization.listMembers({ query: { organizationId: org, limit: 1000 } })) as unknown as { members: IMember[] };
		return result.members;
	});
}

export function useTeams(org: string) {
	return useQuery(org ? keys.teams(org) : undefined, async () => await unwrap(authClient.organization.listTeams({ query: { organizationId: org } })) as unknown as ITeam[]);
}

/** Team id → user ids, for every team (Better Auth's own listing only answers a team's members). */
export function useTeamMembers(org: string, teams: readonly ITeam[] | undefined) {
	return useQuery(teams ? `${keys.teamMembers(org)}:${teams.map(t => t.id).join(',')}` : undefined, async () => {
		const byTeam = await api.get<Record<string, string[]>>('/team-members');
		return new Map((teams ?? []).map(t => [t.id, byTeam[t.id] ?? []] as const));
	});
}

export function useInvitations(org: string) {
	return useQuery(org ? keys.invitations(org) : undefined, async () => await unwrap(authClient.organization.listInvitations({ query: { organizationId: org } })) as unknown as IInvitation[]);
}

export const useOverview = (org: string) => useQuery(org ? keys.overview(org) : undefined, () => api.get<IOverview>('/overview'), { refreshMs: 60_000 });
export const useCredentials = (org: string) => useQuery(org ? keys.credentials(org) : undefined, () => api.get<ICredential[]>('/credentials'));
export const usePolicies = (org: string) => useQuery(org ? keys.policies(org) : undefined, () => api.get<IPolicyRecord[]>('/policies'));
export const useMcp = (org: string) => useQuery(org ? keys.mcp(org) : undefined, () => api.get<IMcpServer[]>('/mcp'));
export const useSkills = (org: string) => useQuery(org ? keys.skills(org) : undefined, () => api.get<ISkill[]>('/skills'));
export const useAlerts = (org: string) => useQuery(org ? keys.alerts(org) : undefined, () => api.get<IAlert[]>('/alerts'), { refreshMs: 60_000 });
export const useSettings = (org: string) => useQuery(org ? keys.settings(org) : undefined, () => api.get<IOrgSettings>('/settings'));
export const useDevices = (org: string) => useQuery(org ? keys.devices(org) : undefined, () => api.get<IDevice[]>('/devices'));
export const useAudit = (org: string, filter = '') => useQuery(org ? `${keys.audit(org)}:${filter}` : undefined, () => api.get<IAuditEvent[]>(`/audit?limit=300${filter ? `&action=${encodeURIComponent(filter)}` : ''}`), { refreshMs: 15_000 });
export const useRequests = (org: string, status = '') => useQuery(org ? `${keys.requests(org)}:${status}` : undefined, () => api.get<IRequestLog[]>(`/usage/requests?limit=300${status ? `&status=${status}` : ''}`), { refreshMs: 15_000 });
export const useMyAccess = (org: string) => useQuery(org ? keys.access(org) : undefined, () => api.get<{ layers: { scopeType: string; scopeId: string; label: string }[]; policy: IEffectivePolicy; usage: { requests: number; costMicros: number; tokens: number } }>('/me/access'));

/** Display name for a user id, from the member list. */
export function memberName(members: readonly IMember[] | undefined, userId: string | null | undefined): string {
	if (!userId) {
		return '—';
	}
	const m = members?.find(x => x.userId === userId);
	return m ? m.user.name || m.user.email : userId.slice(0, 8);
}
