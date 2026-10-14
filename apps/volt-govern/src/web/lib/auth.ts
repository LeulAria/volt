/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ssoClient } from '@better-auth/sso/client';
import { deviceAuthorizationClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { ac, roles } from '../../shared/rbac';

/** Better Auth from the console: sessions, organizations, members, teams, invitations, SSO, device approval. */
export const authClient = createAuthClient({
	baseURL: window.location.origin,
	basePath: '/api/auth',
	plugins: [
		organizationClient({ ac, roles, teams: { enabled: true } }),
		ssoClient(),
		deviceAuthorizationClient(),
	],
});

/** Better Auth answers `{ data, error }`; the console wants a value or a thrown message. */
export async function unwrap<T>(promise: Promise<{ data: T | null; error: { message?: string; statusText?: string } | null }>): Promise<T> {
	const { data, error } = await promise;
	if (error) {
		throw new Error(error.message || error.statusText || 'Request failed');
	}
	return data as T;
}
