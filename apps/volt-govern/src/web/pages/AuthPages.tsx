/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { authClient } from '../lib/auth';
import { invalidate, resetQueries } from '../lib/query';
import { resetEditors } from '../lib/workbench';
import { Button, Callout, Field, Input } from '../ui/controls';
import { Bolt } from '../ui/icons';

export function navigate(path: string): void {
	window.history.pushState(null, '', path);
	window.dispatchEvent(new PopStateEvent('popstate'));
}

function nextPath(): string {
	const next = new URLSearchParams(window.location.search).get('next');
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function AuthCard({ title, sub, children, foot }: { readonly title: string; readonly sub?: ReactNode; readonly children: ReactNode; readonly foot?: ReactNode }) {
	return (
		<div className="auth-page">
			<div className="auth-wrap">
			<div className="auth-card">
				<div className="auth-brand">
					<span className="titlebar-mark"><Bolt size={16} /></span>
					<div><div className="auth-brand-name">Volt Govern</div><div className="auth-brand-sub">AI access for your organization</div></div>
				</div>
				<h1 className="auth-title">{title}</h1>
				{sub ? <p className="auth-sub">{sub}</p> : null}
				{children}
				{foot ? <div className="auth-foot">{foot}</div> : null}
			</div>
			<div className="auth-legal">Provider keys stay on this server. Every request is checked against your organization's policy.</div>
			</div>
		</div>
	);
}

function useSubmit(action: () => Promise<void>): [busy: boolean, error: string | undefined, submit: (e?: FormEvent) => void] {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return [busy, error, e => {
		e?.preventDefault();
		setBusy(true);
		setError(undefined);
		action().catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
	}];
}

export function SignInPage() {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [mode, setMode] = useState<'password' | 'sso'>('password');
	const [busy, error, submit] = useSubmit(async () => {
		if (mode === 'sso') {
			const { error: e } = await authClient.signIn.sso({ email, callbackURL: nextPath() });
			if (e) {
				throw new Error(e.message ?? 'No single sign-on is set up for this email domain');
			}
			return;
		}
		const { error: e } = await authClient.signIn.email({ email, password });
		if (e) {
			throw new Error(e.message ?? 'Sign-in failed');
		}
		resetQueries();
		navigate(nextPath());
	});
	return (
		<AuthCard title="Sign in" sub="Use your work email. Organizations with single sign-on send you to your identity provider."
			foot={<>New organization? <button type="button" className="link-btn" onClick={() => navigate(`/sign-up${window.location.search}`)}>Create an account</button></>}>
			<form onSubmit={submit}>
				<Field label="Work email"><Input type="email" autoFocus required value={email} placeholder="you@company.com" onChange={e => setEmail(e.target.value)} /></Field>
				{mode === 'password' ? <Field label="Password"><Input type="password" required value={password} onChange={e => setPassword(e.target.value)} /></Field> : null}
				{error ? <div style={{ marginBottom: 12 }}><Callout tone="err">{error}</Callout></div> : null}
				<Button type="submit" variant="primary" busy={busy}>{mode === 'sso' ? 'Continue with SSO' : 'Sign In'}</Button>
			</form>
			<div className="auth-divider">or</div>
			<Button icon={mode === 'sso' ? 'key' : 'shield'} onClick={() => setMode(mode === 'sso' ? 'password' : 'sso')}>{mode === 'sso' ? 'Sign in with a password' : 'Sign in with SSO'}</Button>
		</AuthCard>
	);
}

export function SignUpPage() {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, error, submit] = useSubmit(async () => {
		const { error: e } = await authClient.signUp.email({ name, email, password });
		if (e) {
			throw new Error(e.message ?? 'Sign-up failed');
		}
		resetQueries();
		navigate(new URLSearchParams(window.location.search).get('next') ?? '/onboarding');
	});
	return (
		<AuthCard title="Create your account" sub="Then create your organization, or accept an invitation."
			foot={<>Have an account? <button type="button" className="link-btn" onClick={() => navigate(`/sign-in${window.location.search}`)}>Sign in</button></>}>
			<form onSubmit={submit}>
				<Field label="Name"><Input autoFocus required value={name} onChange={e => setName(e.target.value)} /></Field>
				<Field label="Work email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
				<Field label="Password" hint="At least 10 characters."><Input type="password" required minLength={10} value={password} onChange={e => setPassword(e.target.value)} /></Field>
				{error ? <div style={{ marginBottom: 12 }}><Callout tone="err">{error}</Callout></div> : null}
				<Button type="submit" variant="primary" busy={busy}>Create Account</Button>
			</form>
		</AuthCard>
	);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function OnboardingPage() {
	const [name, setName] = useState('');
	const [slug, setSlug] = useState('');
	const [touched, setTouched] = useState(false);
	const [busy, error, submit] = useSubmit(async () => {
		const { data, error: e } = await authClient.organization.create({ name, slug: slug || slugify(name) });
		if (e || !data) {
			throw new Error(e?.message ?? 'Could not create the organization');
		}
		await authClient.organization.setActive({ organizationId: data.id });
		resetEditors();
		resetQueries();
		navigate('/');
	});
	return (
		<AuthCard title="Create your organization" sub="You become its owner. Add provider keys, connect SSO and invite your developers next."
			foot={<button type="button" className="link-btn" onClick={() => navigate('/')}>Back</button>}>
			<form onSubmit={submit}>
				<Field label="Organization name"><Input autoFocus required value={name} placeholder="Acme" onChange={e => { setName(e.target.value); if (!touched) { setSlug(slugify(e.target.value)); } }} /></Field>
				<Field label="URL name" hint="Lowercase letters, digits and dashes."><Input mono required value={slug} onChange={e => { setTouched(true); setSlug(slugify(e.target.value)); }} /></Field>
				{error ? <div style={{ marginBottom: 12 }}><Callout tone="err">{error}</Callout></div> : null}
				<Button type="submit" variant="primary" busy={busy}>Create Organization</Button>
			</form>
		</AuthCard>
	);
}

export function AcceptInvitePage({ invitationId }: { readonly invitationId: string }) {
	const [invitation, setInvitation] = useState<{ organizationName?: string; email?: string; role?: string; inviterEmail?: string } | null>();
	useEffect(() => {
		void authClient.organization.getInvitation({ query: { id: invitationId } }).then(({ data }) => setInvitation((data as never) ?? null));
	}, [invitationId]);
	const [busy, error, submit] = useSubmit(async () => {
		const { data, error: e } = await authClient.organization.acceptInvitation({ invitationId });
		if (e) {
			throw new Error(e.message ?? 'Could not accept the invitation');
		}
		const orgId = (data as { member?: { organizationId?: string } } | null)?.member?.organizationId;
		if (orgId) {
			await authClient.organization.setActive({ organizationId: orgId });
		}
		resetEditors();
		resetQueries();
		navigate('/');
	});
	if (invitation === undefined) {
		return <AuthCard title="Invitation"><div className="stack tight"><div className="skeleton" style={{ height: 14, width: '80%' }} /><div className="skeleton" style={{ height: 14, width: '60%' }} /><div className="skeleton" style={{ height: 34, marginTop: 10 }} /></div></AuthCard>;
	}
	if (invitation === null) {
		return <AuthCard title="Invitation not found" sub="It may have expired, been cancelled, or been sent to a different email than the one you are signed in with." foot={<button type="button" className="link-btn" onClick={() => navigate('/')}>Go to the console</button>}><span /></AuthCard>;
	}
	return (
		<AuthCard title={`Join ${invitation.organizationName ?? 'the organization'}`} sub={`${invitation.inviterEmail ?? 'An admin'} invited ${invitation.email ?? 'you'}${invitation.role ? ` as ${invitation.role}` : ''}.`}>
			{error ? <div style={{ marginBottom: 12 }}><Callout tone="err">{error}</Callout></div> : null}
			<Button variant="primary" busy={busy} onClick={() => submit()}>Accept Invitation</Button>
		</AuthCard>
	);
}

/** Where a developer approves the code Volt shows (OAuth device authorization). */
export function DevicePage() {
	const initial = new URLSearchParams(window.location.search).get('user_code') ?? '';
	const [code, setCode] = useState(initial.toUpperCase());
	const [state, setState] = useState<'enter' | 'confirm' | 'approved' | 'denied'>(initial ? 'confirm' : 'enter');
	const userCode = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
	const [busy, error, submit] = useSubmit(async () => {
		if (state === 'enter') {
			const { error: e } = await authClient.device({ query: { user_code: userCode } });
			if (e) {
				throw new Error(e.error_description || 'That code is not valid or has expired');
			}
			setState('confirm');
			return;
		}
		const { error: e } = await authClient.device.approve({ userCode });
		if (e) {
			throw new Error(e.error_description || 'Could not approve the sign-in');
		}
		setState('approved');
	});
	const deny = async () => {
		await authClient.device.deny({ userCode });
		setState('denied');
	};
	if (state === 'approved') {
		return <AuthCard title="Volt is signed in" sub="You can close this tab and return to Volt."><Callout tone="ok">Approved. Volt registers this computer and receives credentials bound to it.</Callout></AuthCard>;
	}
	if (state === 'denied') {
		return <AuthCard title="Sign-in denied" sub="Volt on that computer was not signed in. If you did not start this, tell your security team."><span /></AuthCard>;
	}
	return (
		<AuthCard title={state === 'enter' ? 'Connect Volt' : 'Approve this sign-in?'} sub={state === 'enter' ? 'Enter the code Volt shows.' : 'Only approve if Volt on your computer shows this exact code.'}>
			<form onSubmit={submit}>
				{state === 'enter'
					? <Field label="Code"><Input mono autoFocus value={code} placeholder="ABCD-EFGH" onChange={e => setCode(e.target.value.toUpperCase())} /></Field>
					: <div className="auth-code">{userCode.replace(/(.{4})(?=.)/g, '$1-')}</div>}
				{error ? <div style={{ marginBottom: 12 }}><Callout tone="err">{error}</Callout></div> : null}
				<Button type="submit" variant="primary" busy={busy} disabled={userCode.length < 4}>{state === 'enter' ? 'Continue' : 'Approve'}</Button>
			</form>
			{state === 'confirm' ? <><div className="auth-divider">or</div><Button variant="danger" onClick={() => void deny()}>Deny</Button></> : null}
		</AuthCard>
	);
}

export function refreshSession(): void {
	invalidate('me');
}
