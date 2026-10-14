/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { CredentialAuthKind, ICredential, ICredentialInput } from '../../shared/api';
import { type AuthHeader, PROVIDER_PRESETS, presetFor } from '../../shared/providers';
import { api } from '../lib/api';
import { keys, useCredentials, useOrg } from '../lib/data';
import { timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { Button, Callout, Field, Input, Segmented, Select, Tag, TagInput } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt, Modal, showContextMenu } from '../ui/overlays';
import { open } from '../workbench/commands';

const AUTH_HEADERS: { value: AuthHeader; label: string; detail: string }[] = [
	{ value: 'x-api-key', label: 'x-api-key', detail: 'Anthropic' },
	{ value: 'bearer', label: 'Authorization: Bearer', detail: 'OpenAI and most' },
	{ value: 'api-key', label: 'api-key', detail: 'Azure OpenAI' },
];

export function AddCredentialModal({ onClose }: { readonly onClose: () => void }) {
	const { orgId } = useOrg();
	const [provider, setProvider] = useState('anthropic');
	const preset = presetFor(provider)!;
	const [label, setLabel] = useState('');
	const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
	const [authKind, setAuthKind] = useState<CredentialAuthKind>('api_key');
	const [authHeader, setAuthHeader] = useState<AuthHeader>(preset.authHeader);
	const [secret, setSecret] = useState('');
	const [tokenUrl, setTokenUrl] = useState('');
	const [clientId, setClientId] = useState('');
	const [scope, setScope] = useState('');
	const [models, setModels] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setBaseUrl(preset.baseUrl);
		setAuthHeader(preset.authHeader);
		setLabel(l => l || '');
	}, [preset]);

	const save = async () => {
		setBusy(true);
		const input: ICredentialInput = {
			provider, label: label.trim() || preset.label, baseUrl, authKind, authHeader, secret, models,
			...(authKind === 'oauth_client' ? { oauth: { tokenUrl, clientId, scope: scope || undefined } } : {}),
		};
		const created = await attempt(() => api.post<ICredential>('/credentials', input), `${input.label} added`);
		setBusy(false);
		if (created) {
			invalidate(keys.credentials(orgId), keys.overview(orgId));
			onClose();
			open.credential(created.id, created.label, true);
		}
	};
	const needsUrl = preset.kind === 'openai-compatible';
	return (
		<Modal title="Add Provider Key" onClose={onClose} wide footer={<>
			<Button onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!secret.trim() || (authKind === 'oauth_client' && (!tokenUrl || !clientId)) || (needsUrl && baseUrl.includes('<'))} onClick={() => void save()}>Add Key</Button>
		</>}>
			<div className="field-row">
				<Field label="Provider"><Select value={provider} options={PROVIDER_PRESETS.map(p => ({ value: p.id, label: p.label, detail: p.format === 'anthropic' ? 'Messages API' : 'OpenAI API' }))} onChange={setProvider} /></Field>
				<Field label="Name" hint="How admins and logs refer to this key."><Input value={label} placeholder={`${preset.label} production`} onChange={e => setLabel(e.target.value)} /></Field>
			</div>
			<Field label="Base URL" hint="The API root including its version. The gateway appends /messages, /chat/completions, /responses, /models.">
				<Input mono value={baseUrl} onChange={e => setBaseUrl(e.target.value)} invalid={needsUrl && baseUrl.includes('<')} />
			</Field>
			<Field label="Authentication" hint={authKind === 'api_key' ? 'A provider key, sealed on this server.' : 'For example Microsoft Entra ID for Azure OpenAI: the gateway fetches and refreshes tokens.'}>
				<div><Segmented value={authKind} onChange={setAuthKind} options={[{ value: 'api_key', label: 'API key' }, { value: 'oauth_client', label: 'OAuth client credentials' }]} /></div>
			</Field>
			{authKind === 'oauth_client' ? (
				<>
					<div className="field-row">
						<Field label="Token URL"><Input mono value={tokenUrl} placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" onChange={e => setTokenUrl(e.target.value)} /></Field>
						<Field label="Client ID"><Input mono value={clientId} onChange={e => setClientId(e.target.value)} /></Field>
					</div>
					<div className="field-row">
						<Field label="Client secret"><Input type="password" mono value={secret} onChange={e => setSecret(e.target.value)} /></Field>
						<Field label="Scope"><Input mono value={scope} placeholder="https://cognitiveservices.azure.com/.default" onChange={e => setScope(e.target.value)} /></Field>
					</div>
				</>
			) : (
				<Field label="API key" hint="Write-only: it is encrypted with a key unique to this organization and never shown again.">
					<Input type="password" mono value={secret} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} onChange={e => setSecret(e.target.value)} />
				</Field>
			)}
			<Field label="Header"><Select value={authHeader} options={AUTH_HEADERS} onChange={setAuthHeader} /></Field>
			<Field label="Models" hint={`Leave empty to route any model of this format here${preset.models.length ? ` (suggested: ${preset.models.join(', ')})` : ''}. Policies decide who may use which.`}>
				<TagInput values={models} onChange={setModels} placeholder="claude-sonnet-5-5" suggestions={preset.models} />
			</Field>
			<Callout tone="info">Volt never receives this key. Developers get device-bound gateway credentials; the gateway adds the key to each forwarded request.</Callout>
		</Modal>
	);
}

export default function CredentialsEditor() {
	const { orgId, can } = useOrg();
	const { data, error, refetch } = useCredentials(orgId);
	const [adding, setAdding] = useState(false);
	useEffect(() => {
		const onAdd = () => setAdding(true);
		window.addEventListener('govern:add-credential', onAdd);
		return () => window.removeEventListener('govern:add-credential', onAdd);
	}, []);
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const columns: IColumn<ICredential>[] = [
		{ id: 'label', title: 'Name', sort: c => c.label, render: c => <span className="row"><span className={`dot ${c.status === 'active' ? 'ok' : ''}`} /><span className="cell-primary">{c.label}</span></span> },
		{ id: 'provider', title: 'Provider', width: 150, sort: c => c.provider, render: c => presetFor(c.provider)?.label ?? c.provider },
		{ id: 'auth', title: 'Auth', width: 130, render: c => c.authKind === 'oauth_client' ? <Tag icon="lock">OAuth client</Tag> : <Tag mono>{c.hint}</Tag> },
		{ id: 'models', title: 'Models', render: c => c.models.length ? <span className="tag-list">{c.models.slice(0, 4).map(m => <Tag key={m} mono>{m}</Tag>)}{c.models.length > 4 ? <span className="faint">+{c.models.length - 4}</span> : null}</span> : <span className="faint">any</span> },
		{ id: 'used', title: 'Last used', width: 120, sort: c => c.lastUsedAt ?? '', render: c => timeAgo(c.lastUsedAt) },
		{ id: 'rotated', title: 'Rotated', width: 120, sort: c => c.rotatedAt ?? c.createdAt, render: c => timeAgo(c.rotatedAt ?? c.createdAt) },
	];
	return (
		<Page title="Provider Keys" wide subtitle="The organization's credentials for AI providers. They stay on this server; the gateway adds them to requests it has checked against policy."
			actions={can({ credential: ['create'] }) ? <Button variant="primary" icon="add" onClick={() => setAdding(true)}>Add Provider Key</Button> : undefined}>
			<Table columns={columns} rows={data} rowKey={c => c.id} initialSort={{ column: 'label' }}
				onRowClick={c => open.credential(c.id, c.label)}
				onRowContextMenu={(c, e) => showContextMenu(e, [{ id: 'open', label: 'Open', run: () => open.credential(c.id, c.label, true) }])}
				emptyIcon="key" empty="No keys yet. Without one, developers cannot reach any model." />
			{adding ? <AddCredentialModal onClose={() => setAdding(false)} /> : null}
		</Page>
	);
}
