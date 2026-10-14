/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError } from './lib/api';
import { authClient } from './lib/auth';
import { useMe } from './lib/data';
import { resetQueries } from './lib/query';
import { useAppliedTheme } from './lib/theme';
import { AcceptInvitePage, DevicePage, navigate, OnboardingPage, SignInPage, SignUpPage } from './pages/AuthPages';
import { Bolt } from './ui/icons';
import { Workbench } from './workbench/Workbench';

function usePath(): string {
	return useSyncExternalStore(l => {
		window.addEventListener('popstate', l);
		return () => window.removeEventListener('popstate', l);
	}, () => window.location.pathname);
}

function Splash() {
	return <div className="auth-page"><span className="titlebar-mark" style={{ width: 36, height: 36, borderRadius: 9, opacity: 0.8 }}><Bolt size={20} /></span></div>;
}

/** Signed in with no active organization: pick the first one, or create one. */
function ActivateOrganization({ organizations }: { readonly organizations: readonly { readonly id: string }[] }) {
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!organizations.length) {
			navigate('/onboarding');
			return;
		}
		void authClient.organization.setActive({ organizationId: organizations[0].id }).then(({ error }) => {
			if (error) {
				setFailed(true);
			} else {
				resetQueries();
			}
		});
	}, [organizations]);
	return failed ? <div className="auth-page">Could not open your organization. Reload to try again.</div> : <Splash />;
}

export function App() {
	useAppliedTheme();
	const path = usePath();
	const me = useMe();
	const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
	const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);

	useEffect(() => {
		const needsSession = path === '/device' || path.startsWith('/accept-invite/') || path === '/onboarding' || !['/sign-in', '/sign-up'].includes(path);
		if (unauthenticated && needsSession) {
			navigate(`/sign-in?next=${next}`);
		}
	}, [unauthenticated, path, next]);

	if (path === '/sign-in') {
		return <SignInPage />;
	}
	if (path === '/sign-up') {
		return <SignUpPage />;
	}
	if (me.loading && !me.data) {
		return <Splash />;
	}
	if (!me.data) {
		return unauthenticated ? <Splash /> : <div className="auth-page">{me.error?.message ?? 'Could not reach the server.'}</div>;
	}
	if (path === '/device') {
		return <DevicePage />;
	}
	if (path.startsWith('/accept-invite/')) {
		return <AcceptInvitePage invitationId={decodeURIComponent(path.slice('/accept-invite/'.length))} />;
	}
	if (path === '/onboarding') {
		return <OnboardingPage />;
	}
	if (!me.data.organization) {
		return <ActivateOrganization organizations={me.data.organizations} />;
	}
	return <Workbench key={me.data.organization.id} />;
}
