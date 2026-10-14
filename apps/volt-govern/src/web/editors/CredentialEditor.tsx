/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { ICredential } from '../../shared/api';
import { presetFor } from '../../shared/providers';
import { api } from '../lib/api';
import { keys, memberName, useCredentials, useMembers, useOrg } from '../lib/data';
import { formatDateTime, formatMs, timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { closeEditor } from '../lib/workbench';
import { Button, Callout, Checkbox, Input, Tag, TagInput } from '../ui/controls';
import { Group, Loading, Page, SaveBar, Setting } from '../ui/layout';
import { attempt, confirm, promptText } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { useDirty } from './common';

interface ITestResult { readonly ok: boolean; readonly status: number; readonly latencyMs: number; readonly models: readonly string[]; readonly error?: string }

export default function CredentialEditor({ input }: IEditorProps) {
	const id = input.params!.id;
	const { orgId, can } = useOrg();
	const credentials = useCredentials(orgId);
	const members = useMembers(orgId);
	const credential = credentials.data?.find(c => c.id === id);
	const [label, setLabel] = useState('');
	const [baseUrl, setBaseUrl] = useState('');
	const [models, setModels] = useState<string[]>([]);
	const [test, setTest] = useState<ITestResult>();
	const [testing, setTesting] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (credential) {
			setLabel(credential.label);
			setBaseUrl(credential.baseUrl);
			setModels([...credential.models]);
		}
	}, [credential]);

	const dirty = !!credential && (label !== credential.label || baseUrl !== credential.baseUrl || JSON.stringify(models) !== JSON.stringify(credential.models));
	useDirty(input.id, dirty);

	if (!credentials.data) {
		return <Loading page />;
	}
	if (!credential) {
		return <div className="page"><div className="muted">This key was removed.</div></div>;
	}
	const editable = can({ credential: ['update'] });
	const refresh = () => invalidate(keys.credentials(orgId), keys.overview(orgId));
	const save = async () => {
		setSaving(true);
		const ok = await attempt(() => api.patch<ICredential>(`/credentials/${id}`, { label, baseUrl, models }), 'Saved');
		setSaving(false);
		if (ok) {
			refresh();
		}
	};
	const discard = () => {
		setLabel(credential.label);
		setBaseUrl(credential.baseUrl);
		setModels([...credential.models]);
	};
	const rotate = async () => {
		const secret = await promptText({ title: credential.authKind === 'oauth_client' ? 'Rotate Client Secret' : 'Rotate API Key', message: 'The new secret replaces the old one immediately for every request.', primary: 'Rotate', placeholder: 'New secret' });
		if (secret) {
			await attempt(() => api.patch(`/credentials/${id}`, { secret }), 'Rotated');
			refresh();
		}
	};
	const setStatus = async (status: 'active' | 'disabled') => {
		await attempt(() => api.patch(`/credentials/${id}`, { status }), status === 'active' ? 'Enabled' : 'Disabled');
		refresh();
	};
	const remove = async () => {
		if (await confirm({ title: `Delete ${credential.label}?`, message: 'Requests routed to this key start failing at once. This cannot be undone.', primary: 'Delete', danger: true })) {
			const ok = await attempt(() => api.delete(`/credentials/${id}`), 'Key deleted');
			if (ok) {
				refresh();
				closeEditor(input.id);
			}
		}
	};
	const runTest = async () => {
		setTesting(true);
		const result = await attempt(() => api.post<ITestResult>(`/credentials/${id}/test`));
		setTesting(false);
		setTest(result);
	};
	return (
		<Page title={credential.label} badge={<Tag tone={credential.status === 'active' ? 'ok' : undefined}>{credential.status}</Tag>}
			subtitle={`${presetFor(credential.provider)?.label ?? credential.provider} · added ${timeAgo(credential.createdAt)} by ${memberName(members.data, credential.createdBy)}${credential.lastUsedAt ? ` · last used ${timeAgo(credential.lastUsedAt)}` : ''}`}
			actions={<>
				<Button icon="play" busy={testing} disabled={!editable} onClick={() => void runTest()}>Test</Button>
				{editable ? <Button icon="sync" onClick={() => void rotate()}>Rotate</Button> : null}
			</>}>
			{test ? (
				<div style={{ marginBottom: 18 }}>
					{test.ok
						? <Callout tone="ok">The provider accepted the key ({formatMs(test.latencyMs)}). It offers {test.models.length} models.</Callout>
						: <Callout tone="err">The provider refused the request{test.status ? ` (HTTP ${test.status})` : ''}{test.error ? `: ${test.error}` : ''}.</Callout>}
				</div>
			) : null}
			<Group title="Key">
				<Setting title="Name" modified={label !== credential.label} description="Shown to admins in this console and in usage reports.">
					<Input value={label} disabled={!editable} onChange={e => setLabel(e.target.value)} />
				</Setting>
				<Setting title="Base URL" description="The API root including its version; the gateway appends /messages, /chat/completions or /responses." modified={baseUrl !== credential.baseUrl}>
					<Input mono value={baseUrl} disabled={!editable} onChange={e => setBaseUrl(e.target.value)} style={{ width: 320 }} />
				</Setting>
				<Setting title="Models" wide modified={JSON.stringify(models) !== JSON.stringify(credential.models)}
					description="Model ids this key serves. Empty means any model of this provider's format. A request for a listed model goes to the key that lists it.">
					<TagInput values={models} onChange={setModels} placeholder="Type a model id and press Enter" suggestions={test?.models ?? presetFor(credential.provider)?.models} />
					{test?.models.length ? (
						<div className="stack tight">
							<div className="field-hint">Offered by the provider:</div>
							<div className="row wrap" style={{ gap: '8px 18px', maxHeight: 160, overflow: 'auto' }}>
								{test.models.map(m => <Checkbox key={m} label={<span className="mono" style={{ fontSize: 12 }}>{m}</span>} checked={models.includes(m)} onChange={on => setModels(on ? [...models, m] : models.filter(x => x !== m))} />)}
							</div>
						</div>
					) : null}
				</Setting>
			</Group>
			<Group title="Authentication" hint="The secret is sealed on this server and never shown again. Rotate it to replace it.">
				<div className="group-pad">
					<dl className="kv">
						<dt>Kind</dt><dd>{credential.authKind === 'oauth_client' ? 'OAuth client credentials' : 'API key'}</dd>
						<dt>{credential.authKind === 'oauth_client' ? 'Client' : 'Key'}</dt><dd className="mono">{credential.hint}</dd>
						<dt>Header</dt><dd className="mono">{credential.authHeader}</dd>
						<dt>Rotated</dt><dd>{credential.rotatedAt ? formatDateTime(credential.rotatedAt) : 'Never'}</dd>
					</dl>
				</div>
			</Group>
			{editable ? (
				<Group title="Danger zone" danger>
					{credential.status === 'active'
						? <Setting title="Disable key" description="Stop routing requests to this key without deleting it."><Button onClick={() => void setStatus('disabled')}>Disable</Button></Setting>
						: <Setting title="Enable key" description="Route requests to this key again."><Button onClick={() => void setStatus('active')}>Enable</Button></Setting>}
					{can({ credential: ['delete'] }) ? <Setting title="Delete key" description="Removes the sealed secret from this server. Requests routed to it fail at once."><Button variant="danger" icon="trash" onClick={() => void remove()}>Delete</Button></Setting> : null}
				</Group>
			) : null}
			<SaveBar dirty={dirty} busy={saving} onSave={() => void save()} onDiscard={discard} />
		</Page>
	);
}
