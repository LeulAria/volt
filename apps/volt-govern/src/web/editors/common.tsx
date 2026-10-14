/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';
import { ACCESS_PRESETS, type IEffectivePolicy } from '../../shared/policy';
import { AGENT_CLIS } from '../../shared/providers';
import { setEditorDirty } from '../lib/workbench';
import { Tag } from '../ui/controls';

/** Marks the editor's tab dirty while it has unsaved changes. */
export function useDirty(editorId: string, dirty: boolean): void {
	useEffect(() => {
		setEditorDirty(editorId, dirty);
	}, [editorId, dirty]);
	useEffect(() => () => setEditorDirty(editorId, false), [editorId]);
}

/** Warns before leaving the page with unsaved changes. */
export function useBeforeUnload(dirty: boolean): void {
	useEffect(() => {
		if (!dirty) {
			return;
		}
		const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', onUnload);
		return () => window.removeEventListener('beforeunload', onUnload);
	}, [dirty]);
}

const yes = (on: boolean) => on ? <Tag tone="ok" icon="check">allowed</Tag> : <Tag tone="err" icon="circle-slash">blocked</Tag>;

/** A merged policy, readable: what this person can actually do in Volt. */
export function EffectivePolicyView({ policy, layers }: { readonly policy: IEffectivePolicy; readonly layers: readonly { readonly label: string; readonly scopeType: string }[] }) {
	const preset = ACCESS_PRESETS.find(p => p.id === policy.capabilities.maxAccessPreset)?.label ?? policy.capabilities.maxAccessPreset;
	return (
		<div className="stack">
			<div className="row wrap">
				<span className="muted">Merged from</span>
				{layers.map((l, i) => <Tag key={i} icon={l.scopeType === 'org' ? 'organization' : l.scopeType === 'team' ? 'organization' : 'person'}>{l.label}</Tag>)}
			</div>
			<dl className="kv">
				<dt>Models</dt>
				<dd>
					{policy.models.allow ? policy.models.allow.map((list, i) => <div key={i} className="tag-list" style={{ marginBottom: 4 }}>{list.length ? list.map(g => <Tag key={g} mono>{g}</Tag>) : <span className="faint">none</span>}</div>) : <span>Every model on the organization's keys</span>}
					{policy.models.deny.length ? <div className="tag-list" style={{ marginTop: 4 }}><span className="faint">except</span>{[...new Set(policy.models.deny)].map(g => <Tag key={g} mono tone="err">{g}</Tag>)}</div> : null}
				</dd>
				<dt>Most access</dt><dd>{preset}</dd>
				<dt>Shell</dt><dd>{yes(policy.capabilities.shell)}</dd>
				<dt>Web access</dt><dd>{yes(policy.capabilities.webAccess)}</dd>
				<dt>In-app browser</dt><dd>{yes(policy.capabilities.browser)}</dd>
				<dt>Personal accounts</dt><dd>{yes(policy.capabilities.personalAccounts)}</dd>
				<dt>Agents</dt><dd>{policy.capabilities.agents ? <div className="tag-list">{policy.capabilities.agents.map(a => <Tag key={a}>{AGENT_CLIS.find(x => x.id === a)?.label ?? a}</Tag>)}{!policy.capabilities.agents.length ? <span className="faint">none</span> : null}</div> : 'All agents'}</dd>
				<dt>MCP</dt>
				<dd>
					{policy.mcp.mode === 'allowlist' ? <>Approved servers only{policy.mcp.allow?.length ? <div className="tag-list" style={{ marginTop: 4 }}>{policy.mcp.allow.flat().filter((v, i, a) => a.indexOf(v) === i).map(g => <Tag key={g} mono>{g}</Tag>)}</div> : null}</> : 'Any server not blocked'}
					{policy.mcp.deny.length ? <div className="tag-list" style={{ marginTop: 4 }}><span className="faint">blocked</span>{[...new Set(policy.mcp.deny)].map(g => <Tag key={g} mono tone="err">{g}</Tag>)}</div> : null}
				</dd>
				<dt>Local skills</dt><dd>{yes(policy.skills.allowLocal)}</dd>
				<dt>Secrets</dt><dd>{policy.data.redactSecrets ? 'Redacted before leaving' : 'Sent as typed'}{policy.data.dlpPatterns.length ? ` · ${policy.data.dlpPatterns.length} DLP pattern${policy.data.dlpPatterns.length === 1 ? '' : 's'}` : ''}</dd>
				<dt>Blocked paths</dt><dd>{policy.data.blockedPaths.length ? <div className="tag-list">{policy.data.blockedPaths.map(p => <Tag key={p} mono>{p}</Tag>)}</div> : <span className="faint">none</span>}</dd>
				<dt>Limits</dt><dd>{policy.limits.requestsPerMinute ? `${policy.limits.requestsPerMinute} requests/min` : 'No rate limit'}{policy.limits.maxOutputTokens ? ` · ${policy.limits.maxOutputTokens.toLocaleString()} output tokens max` : ''}</dd>
				<dt>Budgets</dt>
				<dd>{policy.budgets.length ? policy.budgets.map(b => <div key={`${b.scopeType}:${b.scopeId}`}>{b.label}: {b.budget.monthlyUsd !== undefined ? `$${b.budget.monthlyUsd}/month` : ''}{b.budget.monthlyTokens !== undefined ? ` ${b.budget.monthlyTokens.toLocaleString()} tokens/month` : ''} <span className="faint">({b.budget.onExceed === 'block' ? 'blocks' : 'alerts'})</span></div>) : <span className="faint">none</span>}</dd>
			</dl>
		</div>
	);
}
