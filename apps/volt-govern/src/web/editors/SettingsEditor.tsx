/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { IOrgSettings, PromptLogging } from '../../shared/api';
import { DEFAULT_PRICES, type IPrice } from '../../shared/pricing';
import { api } from '../lib/api';
import { authClient, unwrap } from '../lib/auth';
import { keys, useOrg, useSettings } from '../lib/data';
import { invalidate } from '../lib/query';
import { Action, Button, ChoiceGroup, Input, NumberField, Select, TagInput, Toggle } from '../ui/controls';
import { ErrorView, Group, Loading, Page, SaveBar, Setting } from '../ui/layout';
import { attempt, confirm, promptText } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { useBeforeUnload, useDirty } from './common';

const LOGGING: { id: PromptLogging; label: string; detail: string }[] = [
	{ id: 'off', label: 'Off', detail: 'Counts only: no model names per member beyond aggregates' },
	{ id: 'metadata', label: 'Metadata', detail: 'Model, tokens, cost, latency, outcome per request (default)' },
	{ id: 'redacted', label: 'Prompts, redacted', detail: 'Also the request and answer as sent, after secret redaction' },
	{ id: 'full', label: 'Prompts, full', detail: 'As above; use only where policy and law allow' },
];

function PriceTable({ prices, onChange, readOnly }: { readonly prices: readonly IPrice[]; readonly onChange: (p: IPrice[]) => void; readonly readOnly: boolean }) {
	const set = (i: number, patch: Partial<IPrice>) => onChange(prices.map((p, j) => j === i ? { ...p, ...patch } : p));
	const num = (v: string) => v === '' ? 0 : Math.max(0, Number(v));
	return (
		<div className="stack">
			{prices.length ? (
				<div className="table-wrap">
					<table className="table">
						<colgroup><col /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 130 }} />{!readOnly ? <col style={{ width: 48 }} /> : null}</colgroup>
						<thead><tr><th>Model glob</th><th className="num">Input $/M</th><th className="num">Output $/M</th><th className="num">Cache read $/M</th>{!readOnly ? <th /> : null}</tr></thead>
						<tbody>
							{prices.map((p, i) => (
								<tr key={i}>
									<td><Input mono value={p.match} disabled={readOnly} onChange={e => set(i, { match: e.target.value })} /></td>
									<td className="num"><Input type="number" value={p.input} disabled={readOnly} onChange={e => set(i, { input: num(e.target.value) })} /></td>
									<td className="num"><Input type="number" value={p.output} disabled={readOnly} onChange={e => set(i, { output: num(e.target.value) })} /></td>
									<td className="num"><Input type="number" value={p.cacheRead ?? ''} placeholder="—" disabled={readOnly} onChange={e => set(i, { cacheRead: e.target.value === '' ? undefined : num(e.target.value) })} /></td>
									{!readOnly ? <td className="actions-cell"><Action icon="trash" label="Remove price" onClick={() => onChange(prices.filter((_, j) => j !== i))} /></td> : null}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : <div className="muted" style={{ fontSize: 12.5 }}>No overrides: the built-in list prices apply.</div>}
			{!readOnly ? (
				<div className="btn-group">
					<Button size="sm" icon="add" onClick={() => onChange([...prices, { match: 'anthropic/', input: 0, output: 0 }])}>Add Price</Button>
					{!prices.length ? <Button size="sm" variant="ghost" onClick={() => onChange([...DEFAULT_PRICES])}>Start from Defaults</Button> : null}
				</div>
			) : null}
		</div>
	);
}

export default function SettingsEditor({ input }: IEditorProps) {
	const { orgId, orgName, can, role } = useOrg();
	const { data, error, refetch } = useSettings(orgId);
	const [draft, setDraft] = useState<IOrgSettings>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (data) {
			setDraft(data);
		}
	}, [data]);
	const dirty = !!draft && !!data && JSON.stringify(draft) !== JSON.stringify(data);
	useDirty(input.id, dirty);
	useBeforeUnload(dirty);
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!draft || !data) {
		return <Loading page />;
	}
	const editable = can({ settings: ['update'] });
	const set = (patch: Partial<IOrgSettings>) => setDraft({ ...draft, ...patch });
	const changed = (k: keyof IOrgSettings) => JSON.stringify(draft[k]) !== JSON.stringify(data[k]);
	const save = async () => {
		setBusy(true);
		const ok = await attempt(() => api.put<IOrgSettings>('/settings', draft), 'Settings saved');
		setBusy(false);
		if (ok) {
			invalidate(keys.settings(orgId));
		}
	};
	const rename = async () => {
		const name = await promptText({ title: 'Rename Organization', primary: 'Rename', value: orgName });
		if (name) {
			await attempt(() => unwrap(authClient.organization.update({ data: { name }, organizationId: orgId })), 'Renamed');
			invalidate('me');
		}
	};
	const destroy = async () => {
		const typed = await promptText({ title: `Delete ${orgName}?`, message: 'Everything goes: members, keys, policies, skills, usage and the audit log. Type the organization name to confirm.', primary: 'Delete Organization', validate: v => v === orgName ? undefined : 'The name does not match' });
		if (typed === orgName && await confirm({ title: 'This cannot be undone.', primary: 'Delete Forever', danger: true })) {
			const ok = await attempt(() => unwrap(authClient.organization.delete({ organizationId: orgId })));
			if (ok !== undefined) {
				window.location.assign('/');
			}
		}
	};
	return (
		<Page title="Settings" subtitle={`${orgName}: logging and retention, gateway credentials, who may join, and how spend is priced.`}
>
			<fieldset disabled={!editable}>
				<Group title="Data" hint="What the gateway keeps about each request, and for how long.">
					<Setting title="Prompt logging" modified={changed('promptLogging')} wide description="Reading a kept prompt is audited.">
						<ChoiceGroup value={draft.promptLogging} onChange={promptLogging => set({ promptLogging })} disabled={!editable} options={LOGGING.map(l => ({ id: l.id, label: l.label, detail: l.detail }))} />
					</Setting>
					{(['usage', 'prompts', 'audit'] as const).map(k => (
						<Setting key={k} title={`Keep ${k === 'usage' ? 'usage records' : k === 'prompts' ? 'prompts' : 'the audit log'}`} modified={draft.retentionDays[k] !== data.retentionDays[k]}
							description={k === 'usage' ? 'Per-request metadata behind Usage & Cost and Gateway Requests.' : k === 'prompts' ? 'Only when prompt logging keeps prompts.' : 'Every administrative action and gateway enforcement.'}>
							<NumberField value={draft.retentionDays[k]} min={1} width={110} placeholder="days" unit="days" onChange={v => set({ retentionDays: { ...draft.retentionDays, [k]: v ?? 1 } })} />
						</Setting>
					))}
				</Group>
				<Group title="Gateway" hint="How Volt authenticates to this server's model gateway.">
					<Setting title="Device-bound credentials" modified={changed('requireDeviceBinding')}
						description="Gateway credentials work only with a proof signed by the key of the Volt device they were issued to (DPoP). Off lets a copied credential work anywhere until it expires.">
						<Toggle checked={draft.requireDeviceBinding} disabled={!editable} title="Require a device proof on every request" onChange={requireDeviceBinding => set({ requireDeviceBinding })} />
					</Setting>
					<Setting title="Credential lifetime" modified={changed('tokenTtlMinutes')} description="How long a gateway credential lives before Volt renews it. Shorter means revocations and policy changes take effect sooner.">
						<Select value={String(draft.tokenTtlMinutes)} width={160} disabled={!editable} onChange={v => set({ tokenTtlMinutes: Number(v) })} options={[5, 10, 15, 30, 60].map(m => ({ value: String(m), label: `${m} minutes` }))} />
					</Setting>
				</Group>
				<Group title="Membership">
					<Setting title="Allowed email domains" modified={changed('allowedEmailDomains')} wide description="Only people with an email at these domains can join, through SSO or an invitation. Empty: anyone you invite.">
						<TagInput values={draft.allowedEmailDomains} onChange={allowedEmailDomains => set({ allowedEmailDomains })} placeholder="company.com" />
					</Setting>
				</Group>
				<Group title="Prices" hint="USD per million tokens. The first matching row wins, ahead of the built-in list prices (which may be out of date: check your invoices). Unpriced models count tokens but no cost.">
					<Setting title="Price table" modified={changed('prices')} wide>
						<PriceTable prices={draft.prices} onChange={prices => set({ prices })} readOnly={!editable} />
					</Setting>
				</Group>
			</fieldset>
			<Group title="Organization">
				<Setting title="Name" description={orgName}>
					{can({ organization: ['update'] }) ? <Button size="sm" onClick={() => void rename()}>Rename</Button> : null}
				</Setting>
				{role === 'owner' ? (
					<Setting title="Delete organization" description="Removes the organization and everything in it: members, keys, policies, skills, usage and the audit log.">
						<Button variant="danger" icon="trash" onClick={() => void destroy()}>Delete</Button>
					</Setting>
				) : null}
			</Group>
			<SaveBar dirty={dirty && editable} busy={busy} onSave={() => void save()} onDiscard={() => setDraft(data)} />
		</Page>
	);
}
