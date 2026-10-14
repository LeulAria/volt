/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import type { IScimConnection, IScimIssued } from '../../shared/api';
import { api } from '../lib/api';
import { keys, useOrg } from '../lib/data';
import { formatDateTime, timeAgo } from '../lib/format';
import { invalidate, useQuery } from '../lib/query';
import { Button, Callout, CopyAction, EmptyState, Field, Input, SecretBox, Segmented, Select, Tag, TextArea } from '../ui/controls';
import { ErrorView, Group, Loading, Page, Setting } from '../ui/layout';
import { attempt, confirm, Modal } from '../ui/overlays';

interface ISsoProvider {
	readonly providerId: string;
	readonly type: string;
	readonly domain: string;
	readonly domainVerified: boolean;
	readonly issuer?: string;
	readonly spMetadataUrl?: string;
}

interface ISsoList {
	readonly providers: readonly ISsoProvider[];
	readonly oidcRedirectBase: string;
	readonly samlAcsBase: string;
}

const IDP_PRESETS = [
	{ id: 'okta', label: 'Okta', issuer: 'https://<your-org>.okta.com' },
	{ id: 'entra', label: 'Microsoft Entra ID', issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0' },
	{ id: 'google', label: 'Google Workspace', issuer: 'https://accounts.google.com' },
	{ id: 'other', label: 'Other', issuer: '' },
];

function AddSsoModal({ onClose, redirectBase, acsBase }: { readonly onClose: () => void; readonly redirectBase: string; readonly acsBase: string }) {
	const { orgId } = useOrg();
	const [protocol, setProtocol] = useState<'oidc' | 'saml'>('oidc');
	const [idp, setIdp] = useState('okta');
	const [providerId, setProviderId] = useState('okta');
	const [domain, setDomain] = useState('');
	const [issuer, setIssuer] = useState(IDP_PRESETS[0].issuer);
	const [clientId, setClientId] = useState('');
	const [clientSecret, setClientSecret] = useState('');
	const [entryPoint, setEntryPoint] = useState('');
	const [cert, setCert] = useState('');
	const [busy, setBusy] = useState(false);
	const [created, setCreated] = useState<{ providerId: string; domainVerificationToken: string | null }>();
	const save = async () => {
		setBusy(true);
		const result = await attempt(() => api.post<{ providerId: string; domainVerificationToken: string | null }>('/identity/sso', {
			providerId, protocol, domain, issuer,
			...(protocol === 'oidc' ? { oidc: { clientId, clientSecret } } : { saml: { entryPoint, cert } }),
		}));
		setBusy(false);
		if (result) {
			invalidate(keys.identity(orgId), keys.overview(orgId));
			setCreated(result);
		}
	};
	if (created) {
		return (
			<Modal title="Verify your domain" onClose={onClose} wide footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
				<p>Sign-ins through <b>{created.providerId}</b> start once you prove you own <b>{domain}</b>. Add this DNS TXT record, then choose <i>Verify</i> on the connection.</p>
				{created.domainVerificationToken ? (
					<dl className="kv">
						<dt>Type</dt><dd>TXT</dd>
						<dt>Name</dt><dd className="row"><code>_volt-govern-verification-{created.providerId}.{domain}</code><CopyAction value={`_volt-govern-verification-${created.providerId}.${domain}`} /></dd>
						<dt>Value</dt><dd className="row"><code>{created.domainVerificationToken}</code><CopyAction value={created.domainVerificationToken} /></dd>
					</dl>
				) : <Callout tone="info">Request a verification token from the connection's menu.</Callout>}
			</Modal>
		);
	}
	const redirect = protocol === 'oidc' ? `${redirectBase}/${providerId}` : `${acsBase}/${providerId}`;
	return (
		<Modal title="Add SSO Connection" onClose={onClose} wide footer={<>
			<Button onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!providerId || !domain || !issuer || (protocol === 'oidc' ? !clientId || !clientSecret : !entryPoint || !cert)} onClick={() => void save()}>Add Connection</Button>
		</>}>
			<Field label="Protocol" hint={protocol === 'oidc' ? 'Recommended for Okta, Entra ID and Google Workspace.' : 'For identity providers without OpenID Connect.'}>
				<div><Segmented value={protocol} onChange={setProtocol} options={[{ value: 'oidc', label: 'OpenID Connect' }, { value: 'saml', label: 'SAML 2.0' }]} /></div>
			</Field>
			<div className="field-row">
				<Field label="Identity provider">
					<Select value={idp} options={IDP_PRESETS.map(p => ({ value: p.id, label: p.label }))} onChange={id => { const p = IDP_PRESETS.find(x => x.id === id)!; setIdp(p.id); setIssuer(p.issuer); if (p.id !== 'other') { setProviderId(p.id); } }} />
				</Field>
				<Field label="Connection id" hint="Part of the callback URL."><Input mono value={providerId} onChange={e => setProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></Field>
			</div>
			<div className="field-row">
				<Field label="Email domain" hint="Comma-separate several."><Input mono value={domain} placeholder="company.com" onChange={e => setDomain(e.target.value)} /></Field>
				<Field label="Issuer URL"><Input mono value={issuer} onChange={e => setIssuer(e.target.value)} /></Field>
			</div>
			<Field label={protocol === 'oidc' ? 'Redirect URI to register with your provider' : 'ACS URL to register with your provider'}>
				<SecretBox value={redirect} label="Copy" />
			</Field>
			{protocol === 'oidc' ? (
				<div className="field-row">
					<Field label="Client ID"><Input mono value={clientId} onChange={e => setClientId(e.target.value)} /></Field>
					<Field label="Client secret"><Input mono type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} /></Field>
				</div>
			) : (
				<>
					<Field label="IdP SSO URL"><Input mono value={entryPoint} placeholder="https://idp.example.com/sso/saml" onChange={e => setEntryPoint(e.target.value)} /></Field>
					<Field label="IdP signing certificate (PEM)"><TextArea mono rows={5} value={cert} placeholder="-----BEGIN CERTIFICATE-----" onChange={e => setCert(e.target.value)} /></Field>
				</>
			)}
		</Modal>
	);
}

export default function IdentityEditor() {
	const { orgId, can } = useOrg();
	const sso = useQuery(`${keys.identity(orgId)}:sso`, () => api.get<ISsoList>('/identity/sso'));
	const scim = useQuery(`${keys.identity(orgId)}:scim`, () => api.get<{ endpoint: string; connections: IScimConnection[] }>('/identity/scim'));
	const [adding, setAdding] = useState(false);
	const [issued, setIssued] = useState<IScimIssued>();
	const [verification, setVerification] = useState<{ providerId: string; token: string; record: string }>();
	const editable = can({ identity: ['update'] });
	const refresh = () => invalidate(keys.identity(orgId), keys.overview(orgId));

	const verify = async (p: ISsoProvider) => {
		const ok = await attempt(() => api.post(`/identity/sso/${p.providerId}/verify`), `${p.domain} verified`);
		if (ok) {
			refresh();
		}
	};
	const requestToken = async (p: ISsoProvider) => {
		const result = await attempt(() => api.post<{ token: string; record: string }>(`/identity/sso/${p.providerId}/request-verification`));
		if (result) {
			setVerification({ providerId: p.providerId, ...result });
		}
	};
	const removeSso = async (p: ISsoProvider) => {
		if (await confirm({ title: `Delete ${p.providerId}?`, message: `People at ${p.domain} can no longer sign in through it.`, primary: 'Delete', danger: true })) {
			await attempt(() => api.delete(`/identity/sso/${p.providerId}`), 'Connection deleted');
			refresh();
		}
	};
	const createScim = async () => {
		const result = await attempt(() => api.post<IScimIssued>('/identity/scim', { expiresInDays: 365 }));
		if (result) {
			setIssued(result);
			refresh();
		}
	};
	const rotate = async (c: IScimConnection) => {
		const result = await attempt(() => api.post<IScimIssued>(`/identity/scim/${c.connectionId}/rotate`, { expiresInDays: 365 }));
		if (result) {
			setIssued(result);
			refresh();
		}
	};
	const revokeCredential = async (c: IScimConnection, credentialId: string) => {
		if (await confirm({ title: 'Revoke this SCIM token?', message: 'Your identity provider can no longer provision with it.', primary: 'Revoke', danger: true })) {
			await attempt(() => api.post(`/identity/scim/${c.connectionId}/credentials/${credentialId}/revoke`), 'Token revoked');
			refresh();
		}
	};
	const decommission = async (c: IScimConnection) => {
		if (await confirm({ title: 'Turn off SCIM provisioning?', message: 'Provisioned users stay members, but changes in your identity provider stop reaching Volt Govern.', primary: 'Turn Off', danger: true })) {
			await attempt(() => api.post(`/identity/scim/${c.connectionId}/decommission`), 'SCIM turned off');
			refresh();
		}
	};

	if (sso.error) {
		return <ErrorView error={sso.error} retry={sso.refetch} />;
	}
	const activeScim = (scim.data?.connections ?? []).filter(c => c.status === 'active');
	return (
		<Page title="Identity" subtitle="Single sign-on decides who can sign in; SCIM keeps membership in step with your directory. Both are per organization.">
			<Group title="Single sign-on" hint="People with an email at a verified domain sign in through your identity provider and join as developers."
				actions={editable && sso.data?.providers.length ? <Button size="sm" icon="add" onClick={() => setAdding(true)}>Add Connection</Button> : undefined}>
				{!sso.data ? <Loading /> : sso.data.providers.length ? sso.data.providers.map(p => (
					<Setting key={p.providerId} title={<span className="mono">{p.providerId}</span>}
						tags={<><Tag>{p.type?.toUpperCase?.() ?? 'OIDC'}</Tag>{p.domainVerified ? <Tag tone="ok" icon="verified">{p.domain}</Tag> : <Tag tone="warn" icon="warning">{p.domain} not verified</Tag>}</>}
						description={<>{p.issuer ? <span className="mono">{p.issuer}</span> : null}{p.spMetadataUrl ? <span className="row" style={{ marginTop: 4 }}><span>SP metadata</span><code className="ellipsis">{p.spMetadataUrl}</code><CopyAction value={p.spMetadataUrl} /></span> : null}</>}>
						{editable ? <>
							{!p.domainVerified ? <><Button size="sm" onClick={() => void requestToken(p)}>DNS Record</Button><Button size="sm" variant="primary" onClick={() => void verify(p)}>Verify</Button></> : null}
							<Button size="sm" variant="ghost" icon="trash" onClick={() => void removeSso(p)}>Delete</Button>
						</> : null}
					</Setting>
				)) : (
					<div className="group-pad">
						<EmptyState icon="shield" title="No SSO connection" actions={editable ? <Button variant="primary" icon="add" onClick={() => setAdding(true)}>Add Connection</Button> : undefined}>
							People sign in with email and password and join by invitation. Connect Okta, Microsoft Entra ID, Google Workspace or any OIDC or SAML provider.
						</EmptyState>
					</div>
				)}
			</Group>

			<Group title="SCIM provisioning" hint="Your identity provider creates, updates and deactivates members. Deactivated people leave the organization and their Volt devices are revoked. Groups named volt-admin, volt-security, volt-billing or volt-curator grant those roles.">
				{!scim.data ? <Loading /> : <>
					<Setting title="SCIM base URL" description="Paste it with a bearer token into your identity provider's provisioning settings." wide>
						<SecretBox value={scim.data.endpoint} label="Copy URL" />
					</Setting>
					{activeScim.map(c => (
						<Setting key={c.connectionId} title="Connection" tags={<Tag tone="ok">active</Tag>}
							description={<><span className="mono">{c.connectionId}</span> · since {formatDateTime(c.createdAt)}
								{c.credentials.map(cr => (
									<span key={cr.credentialId} className="row" style={{ marginTop: 6 }}>
										<Tag tone={cr.status === 'active' ? 'ok' : undefined}>{cr.status}</Tag>
										<span className="mono">{cr.credentialId.slice(0, 12)}…</span>
										<span>expires {timeAgo(cr.expiresAt)} · last used {timeAgo(cr.lastUsedAt)}</span>
										{editable && cr.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => void revokeCredential(c, cr.credentialId)}>Revoke</Button> : null}
									</span>
								))}</>}>
							{editable ? <><Button size="sm" icon="sync" onClick={() => void rotate(c)}>New Token</Button><Button size="sm" variant="danger" onClick={() => void decommission(c)}>Turn Off</Button></> : null}
						</Setting>
					))}
					{!activeScim.length ? (
						<Setting title="Provisioning is off" description="Removing people who leave is manual until it is on.">
							{editable ? <Button variant="primary" icon="sync" onClick={() => void createScim()}>Turn On SCIM</Button> : null}
						</Setting>
					) : null}
				</>}
			</Group>

			{adding && sso.data ? <AddSsoModal onClose={() => setAdding(false)} redirectBase={sso.data.oidcRedirectBase} acsBase={sso.data.samlAcsBase} /> : null}
			{issued ? (
				<Modal title="SCIM bearer token" onClose={() => setIssued(undefined)} wide footer={<Button variant="primary" onClick={() => setIssued(undefined)}>I Copied It</Button>}>
					<Callout tone="warn">This token is shown once. Paste it with the base URL into your identity provider's SCIM settings.</Callout>
					<div className="stack" style={{ marginTop: 12 }}>
						<Field label="SCIM base URL"><SecretBox value={issued.connection.endpoint} /></Field>
						<Field label="Bearer token"><SecretBox value={issued.token} label="Copy token" /></Field>
					</div>
				</Modal>
			) : null}
			{verification ? (
				<Modal title="DNS verification record" onClose={() => setVerification(undefined)} footer={<Button variant="primary" onClick={() => setVerification(undefined)}>Done</Button>}>
					<dl className="kv">
						<dt>Type</dt><dd>TXT</dd>
						<dt>Name</dt><dd className="row"><code>{verification.record}.&lt;your domain&gt;</code><CopyAction value={verification.record} /></dd>
						<dt>Value</dt><dd className="row"><code>{verification.token}</code><CopyAction value={verification.token} /></dd>
					</dl>
				</Modal>
			) : null}
		</Page>
	);
}
