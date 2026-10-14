/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode, useState } from 'react';
import { useOrg, useOverview } from '../lib/data';
import { Button, SecretBox, Tag } from '../ui/controls';
import { Codicon, type CodiconName } from '../ui/icons';
import { Page } from '../ui/layout';
import { open } from '../workbench/commands';

interface IStep {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly done: boolean;
	readonly icon: CodiconName;
	readonly detail: () => ReactNode;
}

/** VS Code's Get Started walkthrough, for an organization's first hour. */
export default function WelcomeEditor() {
	const { orgId, orgName, can } = useOrg();
	const overview = useOverview(can({ usage: ['read'] }) ? orgId : '');
	const setup = overview.data?.setup;
	const origin = window.location.origin;
	const steps: IStep[] = [
		{
			id: 'key', icon: 'key', title: 'Add a provider key', done: !!setup?.credential,
			body: 'Anthropic, OpenAI, Gemini, OpenRouter, Azure OpenAI or any OpenAI-compatible endpoint. The key stays on this server.',
			detail: () => (
				<div className="stack">
					<p>Developers never see provider keys. Volt sends every model request to this server's gateway, which checks the policy, then forwards it with the organization's key and records usage and cost.</p>
					<div><Button variant="primary" icon="add" disabled={!can({ credential: ['create'] })} onClick={() => { open.credentials(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:add-credential')), 0); }}>Add Provider Key</Button></div>
				</div>
			),
		},
		{
			id: 'policy', icon: 'law', title: 'Review the organization policy', done: !!setup?.policy,
			body: 'Which models, how much autonomy, which MCP servers, what data may leave, monthly budgets.',
			detail: () => (
				<div className="stack">
					<p>The organization policy is the ceiling. Team policies and member overrides can only narrow it. The defaults are conservative: auto-accept edits at most, MCP by approval only, secrets redacted, no personal accounts.</p>
					<div><Button variant="primary" icon="law" onClick={() => open.policy('org', orgId, 'Organization Policy', true)}>Open Organization Policy</Button></div>
				</div>
			),
		},
		{
			id: 'sso', icon: 'shield', title: 'Connect single sign-on', done: !!setup?.sso,
			body: 'Okta, Microsoft Entra ID, Google Workspace, or any OIDC or SAML 2.0 identity provider.',
			detail: () => (
				<div className="stack">
					<p>People with an email at your verified domain sign in through your identity provider and join {orgName} automatically as developers.</p>
					<div><Button variant="primary" icon="shield" disabled={!can({ identity: ['read'] })} onClick={() => open.identity()}>Configure SSO</Button></div>
				</div>
			),
		},
		{
			id: 'scim', icon: 'sync', title: 'Turn on SCIM provisioning', done: !!setup?.scim,
			body: 'Your identity provider adds and removes people. Leavers lose Volt access the moment they are deprovisioned.',
			detail: () => (
				<div className="stack">
					<p>Groups named <code>volt-admin</code>, <code>volt-security</code>, <code>volt-billing</code> or <code>volt-curator</code> grant those roles; everyone else is a developer.</p>
					<div><Button variant="primary" icon="sync" disabled={!can({ identity: ['update'] })} onClick={() => open.identity()}>Set Up SCIM</Button></div>
				</div>
			),
		},
		{
			id: 'people', icon: 'person-add', title: 'Invite your developers', done: !!setup?.invited,
			body: 'Invite by email now, or let SSO and SCIM bring everyone in.',
			detail: () => (
				<div className="stack">
					<p>Put people in teams to give a group its own models, budget and shared skills.</p>
					<div className="btn-group">
						<Button variant="primary" icon="person-add" disabled={!can({ invitation: ['create'] })} onClick={() => { open.members(); setTimeout(() => window.dispatchEvent(new CustomEvent('govern:invite')), 0); }}>Invite Members</Button>
						<Button icon="organization" onClick={() => open.members()}>Open Members</Button>
					</div>
				</div>
			),
		},
		{
			id: 'volt', icon: 'debug-disconnect', title: 'Connect Volt', done: false,
			body: 'Developers point Volt at this server once. From then on, models, MCP servers and skills come from here.',
			detail: () => (
				<div className="stack">
					<p>Volt signs in with a one-time code (approved in the browser, through SSO when configured), registers a device key, and receives short-lived gateway credentials bound to that device. A credential copied out of Volt does not work anywhere else.</p>
					<div className="field-label">Organization address</div>
					<SecretBox value={origin} label="Copy address" />
					<div className="btn-group"><Button icon="workspace-trusted" onClick={() => open.myAccess()}>See what developers get</Button></div>
				</div>
			),
		},
	];
	const [active, setActive] = useState(steps.find(s => !s.done)?.id ?? steps[0].id);
	const current = steps.find(s => s.id === active)!;
	const done = steps.filter(s => s.done).length;
	return (
		<Page title={`Set up ${orgName}`} subtitle="Volt Govern sits between your developers and AI providers: identity, models, tools, data and spend in one place." wide
			actions={<div className="walk-progress"><span>{done} of {steps.length} complete</span><div className="progress-line"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div></div>}>
			<div className="walkthrough">
				<div className="steps" role="tablist">
					{steps.map((s, i) => (
						<button key={s.id} type="button" role="tab" aria-selected={s.id === active} className={`step${s.id === active ? ' active' : ''}${s.done ? ' done' : ''}`} onClick={() => setActive(s.id)}>
							<span className="step-mark">{s.done ? <Codicon name="check" /> : i + 1}</span>
							<span className="step-text">
								<span className="step-title">{s.title}</span>
								{s.id === active ? <span className="step-body">{s.body}</span> : null}
							</span>
						</button>
					))}
				</div>
				<div className="step-detail">
					<span className="step-hero"><Codicon name={current.icon} /></span>
					<div className="step-detail-title">{current.title}{current.done ? <Tag tone="ok">done</Tag> : null}</div>
					<div className="step-detail-body">{current.detail()}</div>
				</div>
			</div>
		</Page>
	);
}
