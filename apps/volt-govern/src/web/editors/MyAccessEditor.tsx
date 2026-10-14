/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ROLE_LABELS, type RoleName } from '../../shared/rbac';
import { useMyAccess, useOrg, useSkills } from '../lib/data';
import { formatCount, formatUsd } from '../lib/format';
import { Button, SecretBox, Tag } from '../ui/controls';
import { ErrorView, Group, Loading, Page, Setting, Tile } from '../ui/layout';
import { open } from '../workbench/commands';
import { EffectivePolicyView } from './common';

/** A developer's view: what they can use, what it cost this month, how Volt connects. */
export default function MyAccessEditor() {
	const { orgId, orgName, role, me } = useOrg();
	const access = useMyAccess(orgId);
	const skills = useSkills(orgId);
	if (access.error) {
		return <ErrorView error={access.error} retry={access.refetch} />;
	}
	if (!access.data) {
		return <Loading page />;
	}
	const { policy, layers, usage } = access.data;
	const published = (skills.data ?? []).filter(s => s.status === 'published');
	return (
		<Page title="My Access" subtitle={`${me.user.name || me.user.email} in ${orgName} · ${ROLE_LABELS[role as RoleName]?.label ?? role}`}>
			<div className="tiles four" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
				<Tile icon="pulse" label="Requests this month" value={formatCount(usage.requests)} />
				<Tile icon="symbol-key" label="Tokens this month" value={formatCount(usage.tokens)} />
				<Tile icon="credit-card" label="Spend this month" value={formatUsd(usage.costMicros)} />
			</div>
			<Group title="Connect Volt" hint="Volt routes your models, MCP servers and shared skills through this organization. Your organization's keys never reach your computer.">
				<Setting title="Organization address" description={<>In Volt, sign in to an organization with this address. Volt shows a one-time code; approve it at <code>{window.location.origin}/device</code>, and Volt gets short-lived credentials that work only on that computer.</>} wide>
					<SecretBox value={window.location.origin} label="Copy address" />
				</Setting>
			</Group>
			<Group title="What you can use" hint="Your organization's policy, narrowed by your teams' policies and any override for you.">
				<div className="group-pad"><EffectivePolicyView policy={policy} layers={layers} /></div>
			</Group>
			<Group title="Shared skills and rules" hint="Published by your organization. Volt loads them for you.">
				{published.length ? published.map(s => (
					<Setting key={s.id} title={<span className="mono">{s.name}</span>} tags={<Tag>{s.kind}</Tag>} description={s.description || undefined}>
						{policy.skills.required.includes(s.id) ? <Tag icon="pin" tone="info">required</Tag> : null}
						<Button size="sm" variant="ghost" onClick={() => open.skill(s.id, s.name, true)}>Open</Button>
					</Setting>
				)) : <Setting title="None yet" description="Curators publish skills, rules, prompts and agents for everyone in the organization." />}
			</Group>
		</Page>
	);
}
