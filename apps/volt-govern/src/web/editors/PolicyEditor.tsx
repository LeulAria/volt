/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { IPolicyRecord } from '../../shared/api';
import { BUILTIN_SECRET_PATTERNS, scanText, validatePattern } from '../../shared/dlp';
import { ACCESS_PRESETS, type AccessPreset, DEFAULT_ORG_POLICY, type IDlpPattern, type IPolicyDocument, type IPolicyLayer, mergePolicy, type ScopeType } from '../../shared/policy';
import { AGENT_CLIS, type AgentCliId } from '../../shared/providers';
import { api, ApiError } from '../lib/api';
import { keys, useMcp, useMembers, useOrg, usePolicies, useSkills, useTeamMembers, useTeams } from '../lib/data';
import { timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { closeEditor } from '../lib/workbench';
import { Action, Button, Callout, Checkbox, FilterInput, Input, NumberField, Segmented, Select, Tag, TagInput, TextArea, Toggle } from '../ui/controls';
import { Group, Loading, SaveBar, Setting } from '../ui/layout';
import { attempt, confirm, notify } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { EffectivePolicyView, useBeforeUnload, useDirty } from './common';

type Section = 'models' | 'capabilities' | 'mcp' | 'skills' | 'data' | 'budget' | 'limits';
const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
	{ id: 'models', label: 'Models' },
	{ id: 'capabilities', label: 'Capabilities' },
	{ id: 'mcp', label: 'MCP' },
	{ id: 'skills', label: 'Skills & Context' },
	{ id: 'data', label: 'Data & DLP' },
	{ id: 'budget', label: 'Budget' },
	{ id: 'limits', label: 'Limits' },
];

/** A switch at a narrowing scope: inherit, or force on/off (only "off" narrows). */
function TriState({ value, onChange, org, inherited }: { readonly value: boolean | undefined; readonly onChange: (v: boolean | undefined) => void; readonly org: boolean; readonly inherited?: boolean }) {
	if (org) {
		return <Toggle checked={value !== false} title={value !== false ? 'Allowed' : 'Blocked'} onChange={v => onChange(v ? true : false)} />;
	}
	const current = value === undefined ? 'inherit' : value ? 'allow' : 'block';
	return (
		<Segmented value={current} onChange={v => onChange(v === 'inherit' ? undefined : v === 'allow')} options={[
			{ value: 'inherit', label: 'Inherit', title: `Organization: ${inherited === false ? 'blocked' : 'allowed'}` },
			{ value: 'block', label: 'Block', danger: true },
			{ value: 'allow', label: 'Allow', title: 'Cannot widen a block set above' },
		]} />
	);
}

function DlpEditor({ patterns, onChange, redactSecrets }: { readonly patterns: readonly IDlpPattern[]; readonly onChange: (p: IDlpPattern[]) => void; readonly redactSecrets: boolean }) {
	const [sample, setSample] = useState('');
	const all = [...(redactSecrets ? BUILTIN_SECRET_PATTERNS : []), ...patterns];
	const result = sample ? scanText(sample, all) : undefined;
	const set = (i: number, patch: Partial<IDlpPattern>) => onChange(patterns.map((p, j) => j === i ? { ...p, ...patch } : p));
	return (
		<div className="stack">
			{patterns.map((p, i) => {
				const error = validatePattern(p.regex);
				return (
					<div key={i} className="row" style={{ alignItems: 'flex-start' }}>
						<Input value={p.name} placeholder="name" style={{ width: 160 }} onChange={e => set(i, { name: e.target.value })} />
						<div className="grow">
							<Input mono value={p.regex} placeholder="regular expression" invalid={!!error} onChange={e => set(i, { regex: e.target.value })} />
							{error ? <div className="input-msg error">{error}</div> : null}
						</div>
						<Select compact value={p.action} onChange={action => set(i, { action })} options={[{ value: 'redact', label: 'Redact' }, { value: 'block', label: 'Block request' }]} />
						<Action icon="trash" label="Remove pattern" onClick={() => onChange(patterns.filter((_, j) => j !== i))} />
					</div>
				);
			})}
			<div><Button size="sm" icon="add" onClick={() => onChange([...patterns, { name: 'customer-id', regex: '\\bCUST-[0-9]{8}\\b', action: 'redact' }])}>Add Pattern</Button></div>
			<div className="field-label" style={{ marginTop: 6 }}>Try it</div>
			<TextArea mono rows={3} value={sample} placeholder="Paste text to see what the gateway would send" onChange={e => setSample(e.target.value)} />
			{result ? (
				<div className="secret-box" style={{ whiteSpace: 'pre-wrap', alignItems: 'flex-start' }}>
					<code>{result.text}</code>
				</div>
			) : null}
			{result?.findings.length ? <div className="tag-list">{result.findings.map(f => <Tag key={f.pattern} tone={f.action === 'block' ? 'err' : 'warn'}>{f.pattern} ×{f.count}{f.action === 'block' ? ' (blocks)' : ''}</Tag>)}</div> : null}
		</div>
	);
}

export default function PolicyEditor({ input }: IEditorProps) {
	const scopeType = input.params!.scopeType as ScopeType;
	const scopeId = input.params!.scopeId;
	const { orgId, orgName, can } = useOrg();
	const policies = usePolicies(orgId);
	const mcp = useMcp(orgId);
	const skills = useSkills(orgId);
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const teamMembers = useTeamMembers(orgId, teams.data);
	const record = policies.data?.find(p => p.scopeType === scopeType && p.scopeId === scopeId);
	const saved = useMemo<IPolicyDocument>(() => record?.document ?? (scopeType === 'org' ? DEFAULT_ORG_POLICY : {}), [record, scopeType]);
	const [draft, setDraft] = useState<IPolicyDocument>(saved);
	const [filter, setFilter] = useState('');
	const [section, setSection] = useState<Section>('models');
	const [previewUser, setPreviewUser] = useState<string>('');
	const [busy, setBusy] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const loadedVersion = useRef<number | undefined>(undefined);

	useEffect(() => {
		// Take the server's copy when it first arrives or after our own save, never over local edits.
		if (record?.version !== loadedVersion.current) {
			loadedVersion.current = record?.version;
			setDraft(saved);
		}
	}, [record?.version, saved]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	useDirty(input.id, dirty);
	useBeforeUnload(dirty);

	if (!policies.data) {
		return <Loading page />;
	}
	const editable = can({ policy: ['update'] });
	const org = scopeType === 'org';
	const orgDoc = policies.data.find(p => p.scopeType === 'org')?.document ?? DEFAULT_ORG_POLICY;
	const parent = org ? undefined : orgDoc;
	const scopeLabel = org ? orgName : scopeType === 'team' ? `Team ${teams.data?.find(t => t.id === scopeId)?.name ?? ''}` : members.data?.find(m => m.userId === scopeId)?.user.name ?? 'Member';

	const sub = <K extends keyof IPolicyDocument>(key: K, value: Partial<NonNullable<IPolicyDocument[K]>>) => setDraft(d => ({ ...d, [key]: { ...(d[key] as object | undefined), ...value } }));
	const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

	const save = async () => {
		setBusy(true);
		try {
			await api.put<IPolicyRecord>(`/policies/${scopeType}/${scopeId}`, { document: draft, version: record && record.version > 0 ? record.version : undefined });
			notify('success', `${org ? 'Organization policy' : 'Policy'} saved. Volt picks it up within a minute.`);
			invalidate(keys.policies(orgId), `${orgId}:effective`, keys.access(orgId));
		} catch (err) {
			if (err instanceof ApiError && err.code === 'version_conflict') {
				notify('warning', err.message, { actions: [{ label: 'Reload', run: () => { invalidate(keys.policies(orgId)); } }] });
			} else {
				notify('error', err instanceof Error ? err.message : String(err));
			}
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (await confirm({ title: `Remove the ${scopeType === 'team' ? 'team policy' : 'member override'}?`, message: 'The organization policy (and any team policy) applies instead.', primary: 'Remove', danger: true })) {
			const ok = await attempt(() => api.delete(`/policies/${scopeType}/${scopeId}`), 'Removed');
			if (ok) {
				invalidate(keys.policies(orgId));
				closeEditor(input.id);
			}
		}
	};

	// "Preview as": the selected member's layers, with this editor's draft in place of the saved one.
	const preview = (() => {
		if (!previewUser) {
			return undefined;
		}
		const docOf = (t: ScopeType, id: string) => t === scopeType && id === scopeId ? draft : policies.data!.find(p => p.scopeType === t && p.scopeId === id)?.document;
		const orgBase = docOf('org', orgId) ?? DEFAULT_ORG_POLICY;
		const approved = (mcp.data ?? []).filter(s => s.status === 'approved').map(s => s.name);
		const blocked = (mcp.data ?? []).filter(s => s.status === 'blocked').map(s => s.name);
		const layers: IPolicyLayer[] = [{ scopeType: 'org', scopeId: orgId, label: orgName, document: { ...orgBase, mcp: { ...orgBase.mcp, mode: orgBase.mcp?.mode ?? 'allowlist', allow: [...(orgBase.mcp?.allow ?? []), ...approved], deny: [...(orgBase.mcp?.deny ?? []), ...blocked] } } }];
		for (const t of teams.data ?? []) {
			const d = teamMembers.data?.get(t.id)?.includes(previewUser) ? docOf('team', t.id) : undefined;
			if (d) {
				layers.push({ scopeType: 'team', scopeId: t.id, label: `Team ${t.name}`, document: d });
			}
		}
		const u = docOf('user', previewUser);
		if (u) {
			layers.push({ scopeType: 'user', scopeId: previewUser, label: 'Member override', document: u });
		}
		return { policy: mergePolicy(layers), layers };
	})();

	const q = filter.trim().toLowerCase();
	const show = (...words: string[]) => !q || words.some(w => w.toLowerCase().includes(q));
	const group = (id: Section, children: ReactNode) => <Group id={id} title={SECTIONS.find(s => s.id === id)!.label}>{children}</Group>;
	const inherit = (text: ReactNode) => org ? undefined : text;
	const published = (skills.data ?? []).filter(s => s.status === 'published');
	const mcpNames = (mcp.data ?? []).map(s => s.name);

	return (
		<div className="split">
			<nav className="split-nav list" aria-label="Policy sections">
				{SECTIONS.map(s => (
					<div key={s.id} className={`list-row${section === s.id ? ' selected' : ''}`}
						onClick={() => { setSection(s.id); scroller.current?.querySelector(`[data-section="${s.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
						<span className="list-label">{s.label}</span>
					</div>
				))}
			</nav>
			<div className="split-main">
				<div className="split-toolbar">
					<div style={{ width: 300 }}><FilterInput value={filter} onChange={setFilter} placeholder="Search policy settings" /></div>
					<Tag icon={org ? 'organization' : scopeType === 'team' ? 'organization' : 'person'}>{scopeLabel}</Tag>
					{record && record.version > 0 ? <span className="faint" style={{ fontSize: 12 }}>v{record.version} · {timeAgo(record.updatedAt)}</span> : <span className="faint" style={{ fontSize: 12 }}>{org ? 'defaults' : 'not saved yet'}</span>}
					<span className="spacer" />
					{!org && record && record.version > 0 && editable ? <Button variant="ghost" icon="trash" onClick={() => void remove()}>Remove</Button> : null}
					{!editable ? <Tag icon="lock">read only</Tag> : null}
				</div>
				<div ref={scroller} className="split-scroll"
					onScroll={e => {
						const top = e.currentTarget.getBoundingClientRect().top;
						const groups = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-section]')];
						const current = groups.filter(g => g.getBoundingClientRect().top - top < 120).at(-1);
						if (current) {
							setSection(current.dataset.section as Section);
						}
					}}>
					<div className="page">
					<fieldset disabled={!editable}>
						{!org ? <div style={{ marginBottom: 8 }}><Callout tone="info" icon="type-hierarchy">This {scopeType === 'team' ? 'team policy' : 'override'} can only narrow the organization policy: allow lists intersect, block lists add up, switches can only turn off, limits take the smaller value. Budgets here count only {scopeType === 'team' ? "this team's" : "this member's"} spend.</Callout></div> : null}

						{show('models', 'allow', 'block', 'deny') ? group('models', <>
							<Setting category="Models" title="Allowed models" modified={changed(draft.models?.allow, saved.models?.allow)} wide
								description={<>Only models matching one of these <code>provider/model</code> globs are reachable (<code>anthropic/claude-sonnet-*</code>, <code>openai/*</code>). Off: every model on the organization's keys.</>}
								inherited={inherit(parent?.models?.allow ? `Organization allows: ${parent.models.allow.join(', ')}` : 'Organization allows every model')}>
								<Toggle label="Restrict to a list" checked={!!draft.models?.allow} onChange={on => sub('models', { allow: on ? [] : undefined })} />
								{draft.models?.allow ? <TagInput values={draft.models.allow} onChange={allow => sub('models', { allow })} placeholder="anthropic/claude-sonnet-*" /> : null}
							</Setting>
							<Setting category="Models" title="Blocked models" modified={changed(draft.models?.deny, saved.models?.deny)} wide description="Never reachable, whatever any allow list says."
								inherited={inherit(parent?.models?.deny?.length ? `Organization blocks: ${parent.models.deny.join(', ')}` : undefined)}>
								<TagInput values={draft.models?.deny ?? []} onChange={deny => sub('models', { deny })} placeholder="openai/o1-pro" />
							</Setting>
						</>) : null}

						{show('capabilities', 'access', 'preset', 'shell', 'web', 'browser', 'agents', 'personal', 'accounts') ? group('capabilities', <>
							<Setting category="Capabilities" title="Most permissive access" modified={changed(draft.capabilities?.maxAccessPreset, saved.capabilities?.maxAccessPreset)}
								description="The highest access preset a developer can choose in Volt. Supervised asks before every edit and command; Full access runs without asking (the hard-deny list still applies)."
								inherited={inherit(`Organization: ${ACCESS_PRESETS.find(p => p.id === parent?.capabilities?.maxAccessPreset)?.label ?? 'Full access'}`)}>
								<Select<string> value={draft.capabilities?.maxAccessPreset ?? (org ? 'full' : 'inherit')} width={240}
									onChange={v => sub('capabilities', { maxAccessPreset: v === 'inherit' ? undefined : v as AccessPreset })}
									options={[...(org ? [] : [{ value: 'inherit', label: 'Inherit' }]), ...ACCESS_PRESETS.map(p => ({ value: p.id, label: p.label }))]} />
							</Setting>
							<Setting category="Capabilities" title="Shell commands" modified={changed(draft.capabilities?.shell, saved.capabilities?.shell)}
								description="Whether agents may run terminal commands. Off removes shell tools from every model request at the gateway, so it holds for any client.">
								<TriState org={org} value={draft.capabilities?.shell} inherited={parent?.capabilities?.shell} onChange={shell => sub('capabilities', { shell })} />
							</Setting>
							<Setting category="Capabilities" title="Web access" modified={changed(draft.capabilities?.webAccess, saved.capabilities?.webAccess)}
								description="Web search and fetch, including provider-hosted web tools. Off strips them from requests at the gateway.">
								<TriState org={org} value={draft.capabilities?.webAccess} inherited={parent?.capabilities?.webAccess} onChange={webAccess => sub('capabilities', { webAccess })} />
							</Setting>
							<Setting category="Capabilities" title="In-app browser" modified={changed(draft.capabilities?.browser, saved.capabilities?.browser)} description="Whether agents may drive Volt's browser.">
								<TriState org={org} value={draft.capabilities?.browser} inherited={parent?.capabilities?.browser} onChange={browser => sub('capabilities', { browser })} />
							</Setting>
							<Setting category="Capabilities" title="Personal accounts" modified={changed(draft.capabilities?.personalAccounts, saved.capabilities?.personalAccounts)}
								description="Whether developers may also use their own agent sign-ins and API keys in Volt. Off: every model request goes through this gateway.">
								<TriState org={org} value={draft.capabilities?.personalAccounts} inherited={parent?.capabilities?.personalAccounts} onChange={personalAccounts => sub('capabilities', { personalAccounts })} />
							</Setting>
							<Setting category="Capabilities" title="Agents" wide modified={changed(draft.capabilities?.agents, saved.capabilities?.agents)} description="Which agents Volt may run for these developers.">
								<Toggle label="All agents" checked={!draft.capabilities?.agents} onChange={all => sub('capabilities', { agents: all ? undefined : AGENT_CLIS.map(a => a.id) })} />
								{draft.capabilities?.agents ? (
									<div className="row wrap" style={{ gap: '10px 22px' }}>
										{AGENT_CLIS.map(a => <Checkbox key={a.id} label={a.label} checked={draft.capabilities!.agents!.includes(a.id)}
											onChange={on => sub('capabilities', { agents: on ? [...draft.capabilities!.agents!, a.id] : draft.capabilities!.agents!.filter(x => x !== a.id) as AgentCliId[] })} />)}
									</div>
								) : null}
							</Setting>
						</>) : null}

						{show('mcp', 'server', 'tool', 'allowlist', 'enforcement') ? group('mcp', <>
							<Setting category="MCP" title="Mode" modified={changed(draft.mcp?.mode, saved.mcp?.mode)}
								description="Allowlist: only approved servers (the registry's Approved list plus the entries below). Blocklist: any server not blocked."
								inherited={inherit(`Organization: ${parent?.mcp?.mode ?? 'allowlist'}`)}>
								<Select<string> value={draft.mcp?.mode ?? (org ? 'allowlist' : 'inherit')} width={240} onChange={v => sub('mcp', { mode: v === 'inherit' ? undefined : v as 'allowlist' | 'blocklist' })}
									options={[...(org ? [] : [{ value: 'inherit', label: 'Inherit' }]), { value: 'allowlist', label: 'Allowlist (approved only)' }, { value: 'blocklist', label: 'Blocklist (all but blocked)' }]} />
							</Setting>
							<Setting category="MCP" title="Allowed servers and tools" modified={changed(draft.mcp?.allow, saved.mcp?.allow)} wide
								description={<><code>server</code> or <code>server:tool</code> globs, added to the approved registry entries{org ? '' : ' (at this scope, the list narrows what the organization allows)'}.</>}>
								<TagInput values={draft.mcp?.allow ?? []} onChange={allow => sub('mcp', { allow })} placeholder="github, linear:read_*" suggestions={mcpNames} />
							</Setting>
							<Setting category="MCP" title="Blocked servers and tools" modified={changed(draft.mcp?.deny, saved.mcp?.deny)} wide description={<>For example <code>github:delete_*</code> or <code>*:write_*</code>.</>}>
								<TagInput values={draft.mcp?.deny ?? []} onChange={deny => sub('mcp', { deny })} placeholder="github:delete_*" suggestions={mcpNames} />
							</Setting>
							<Setting category="MCP" title="Enforcement" modified={changed(draft.mcp?.enforcement, saved.mcp?.enforcement)}
								description="What the gateway does when a model request offers a blocked MCP tool: remove the tool and continue, or refuse the request.">
								<Select<string> value={draft.mcp?.enforcement ?? 'strip'} width={240} onChange={v => sub('mcp', { enforcement: v as 'strip' | 'block' })}
									options={[{ value: 'strip', label: 'Remove the tool' }, { value: 'block', label: 'Refuse the request' }]} />
							</Setting>
						</>) : null}

						{show('skills', 'rules', 'context', 'local', 'required') ? group('skills', <>
							<Setting category="Skills" title="Required skills and rules" modified={changed(draft.skills?.required, saved.skills?.required)} wide description="Published organization skills and rules every developer in this scope receives, whatever their teams.">
								{published.length ? (
									<div className="stack">
										{published.map(s => <Checkbox key={s.id} label={<>{s.name} <span className="faint">· {s.kind}</span></>} checked={!!draft.skills?.required?.includes(s.id)}
											onChange={on => sub('skills', { required: on ? [...(draft.skills?.required ?? []), s.id] : (draft.skills?.required ?? []).filter(x => x !== s.id) })} />)}
									</div>
								) : <span className="muted">No published skills yet.</span>}
							</Setting>
							<Setting category="Skills" title="Local skills and rules" modified={changed(draft.skills?.allowLocal, saved.skills?.allowLocal)}
								description="Whether Volt also loads skills, rules and instruction files from repositories and home folders (AGENTS.md, .cursor/rules, .claude/skills). Off: only what the organization publishes.">
								<TriState org={org} value={draft.skills?.allowLocal} inherited={parent?.skills?.allowLocal} onChange={allowLocal => sub('skills', { allowLocal })} />
							</Setting>
						</>) : null}

						{show('data', 'dlp', 'secret', 'redact', 'path', 'pattern') ? group('data', <>
							<Setting category="Data" title="Redact secrets" modified={changed(draft.data?.redactSecrets, saved.data?.redactSecrets)}
								description={<>Before a request leaves, the gateway replaces private keys, cloud and SaaS tokens, connection strings and JWTs with <code>[REDACTED:kind]</code> ({BUILTIN_SECRET_PATTERNS.length} built-in detectors).</>}>
								<Toggle title="Redact secrets in prompts and tool results" checked={!!draft.data?.redactSecrets} onChange={redactSecrets => sub('data', { redactSecrets })} />
							</Setting>
							<Setting category="Data" title="DLP patterns" modified={changed(draft.data?.dlpPatterns, saved.data?.dlpPatterns)} wide
								description="Your own patterns (customer ids, internal hostnames, project code names). Redact replaces matches; Block refuses the whole request.">
								<DlpEditor patterns={draft.data?.dlpPatterns ?? []} redactSecrets={!!draft.data?.redactSecrets || !!parent?.data?.redactSecrets} onChange={dlpPatterns => sub('data', { dlpPatterns })} />
							</Setting>
							<Setting category="Data" title="Blocked paths" modified={changed(draft.data?.blockedPaths, saved.data?.blockedPaths)} wide
								description="Files agents may not read or attach in Volt (globs). Enforced by Volt's access broker on the developer's machine.">
								<TagInput values={draft.data?.blockedPaths ?? []} onChange={blockedPaths => sub('data', { blockedPaths })} placeholder="**/.env*" />
							</Setting>
						</>) : null}

						{show('budget', 'spend', 'cost', 'tokens', 'month') ? group('budget', <>
							<Setting category="Budget" title="Monthly spend" modified={changed(draft.budget?.monthlyUsd, saved.budget?.monthlyUsd)}
								description={`Priced at the organization's price table. Alerts at 80% and 100%. Counts ${org ? "the whole organization's" : scopeType === 'team' ? "this team's members'" : "this member's"} spend.`}>
								<NumberField value={draft.budget?.monthlyUsd} onChange={monthlyUsd => sub('budget', { monthlyUsd })} unit="USD / month" />
							</Setting>
							<Setting category="Budget" title="Monthly tokens" modified={changed(draft.budget?.monthlyTokens, saved.budget?.monthlyTokens)} description="Input, output and cache tokens together.">
								<NumberField value={draft.budget?.monthlyTokens} onChange={monthlyTokens => sub('budget', { monthlyTokens })} unit="tokens / month" />
							</Setting>
							<Setting category="Budget" title="When exceeded" modified={changed(draft.budget?.onExceed, saved.budget?.onExceed)}>
								<Select<string> value={draft.budget?.onExceed ?? 'alert'} width={240} onChange={v => sub('budget', { onExceed: v as 'alert' | 'block' })}
									options={[{ value: 'alert', label: 'Alert only' }, { value: 'block', label: 'Block further requests' }]} />
							</Setting>
						</>) : null}

						{show('limits', 'rate', 'output', 'tokens') ? group('limits', <>
							<Setting category="Limits" title="Requests per minute" modified={changed(draft.limits?.requestsPerMinute, saved.limits?.requestsPerMinute)} description="Per developer, at the gateway.">
								<NumberField value={draft.limits?.requestsPerMinute} onChange={requestsPerMinute => sub('limits', { requestsPerMinute })} unit="per minute" />
							</Setting>
							<Setting category="Limits" title="Max output tokens" modified={changed(draft.limits?.maxOutputTokens, saved.limits?.maxOutputTokens)} description="Caps max_tokens on every request.">
								<NumberField value={draft.limits?.maxOutputTokens} onChange={maxOutputTokens => sub('limits', { maxOutputTokens })} unit="tokens" />
							</Setting>
						</>) : null}
					</fieldset>

					<Group title="Preview" hint="The merged policy a member would get, with this editor's unsaved changes.">
						<Setting title="Preview as member">
							<Select value={previewUser} placeholder="Choose a member…" width={260} onChange={setPreviewUser}
								options={(members.data ?? []).map(m => ({ value: m.userId, label: m.user.name || m.user.email, detail: m.user.email }))} />
						</Setting>
						{preview ? <div className="group-pad" style={{ borderTop: '1px solid var(--row-line)' }}><EffectivePolicyView policy={preview.policy} layers={preview.layers} /></div> : null}
					</Group>
					<SaveBar dirty={dirty && editable} busy={busy} onSave={() => void save()} onDiscard={() => setDraft(saved)}
						message={org ? 'Unsaved changes to the organization policy' : 'Unsaved policy changes'} />
					</div>
				</div>
			</div>
		</div>
	);
}

