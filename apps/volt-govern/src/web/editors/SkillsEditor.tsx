/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { ISkill, SkillKind } from '../../shared/api';
import { api } from '../lib/api';
import { keys, memberName, useMembers, useOrg, useSkills, useTeams } from '../lib/data';
import { timeAgo } from '../lib/format';
import { invalidate } from '../lib/query';
import { Button, Field, Input, Select, Tag, TextArea } from '../ui/controls';
import { ErrorView, type IColumn, Loading, Page, Table } from '../ui/layout';
import { attempt, Modal } from '../ui/overlays';
import { open } from '../workbench/commands';

export const KIND_LABELS: Record<SkillKind, { readonly label: string; readonly detail: string }> = {
	skill: { label: 'Skill', detail: 'Instructions and know-how an agent loads when relevant (SKILL.md)' },
	rule: { label: 'Rule', detail: 'Always-on project or company rules (AGENTS.md, .cursor/rules)' },
	prompt: { label: 'Prompt', detail: 'A reusable prompt developers run as a command' },
	agent: { label: 'Agent', detail: 'A sub-agent definition: role, tools, model' },
};

const TEMPLATES: Record<SkillKind, string> = {
	skill: '---\nname: {name}\ndescription: When to use this skill, in one sentence the agent can match on.\n---\n\n# {name}\n\nSteps, conventions and examples the agent should follow.\n',
	rule: '# {name}\n\n- Prefer the internal HTTP client (`@acme/http`) over fetch.\n- Never log customer identifiers.\n',
	prompt: 'Review the current diff for security issues. List each finding with file, line, risk and fix.\n',
	agent: '---\nname: {name}\ndescription: What this agent is for.\ntools: [read_file, grep, glob]\n---\n\nYou are a focused reviewer. ...\n',
};

function NewSkillModal({ kind: initialKind, onClose }: { readonly kind: SkillKind; readonly onClose: () => void }) {
	const { orgId } = useOrg();
	const [name, setName] = useState('');
	const [kind, setKind] = useState<SkillKind>(initialKind);
	const [description, setDescription] = useState('');
	const [busy, setBusy] = useState(false);
	const valid = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name);
	const create = async () => {
		setBusy(true);
		const skill = await attempt(() => api.post<ISkill>('/skills', { name, kind, description, content: TEMPLATES[kind].replaceAll('{name}', name), teams: [] }));
		setBusy(false);
		if (skill) {
			invalidate(keys.skills(orgId));
			onClose();
			open.skill(skill.id, skill.name, true);
		}
	};
	return (
		<Modal title="New Skill or Rule" onClose={onClose} footer={<>
			<Button onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} disabled={!valid} onClick={() => void create()}>Create Draft</Button>
		</>}>
			<Field label="Kind"><Select value={kind} onChange={setKind} options={(Object.keys(KIND_LABELS) as SkillKind[]).map(k => ({ value: k, label: KIND_LABELS[k].label, detail: KIND_LABELS[k].detail }))} /></Field>
			<Field label="Name" error={name && !valid ? 'Lowercase letters, digits, ., - and _' : undefined}><Input mono autoFocus value={name} placeholder="security-review" onChange={e => setName(e.target.value.toLowerCase())} /></Field>
			<Field label="Description" hint="Shown to developers, and to agents deciding when a skill applies."><TextArea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></Field>
		</Modal>
	);
}

export default function SkillsEditor() {
	const { orgId, can } = useOrg();
	const { data, error, refetch } = useSkills(orgId);
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const [creating, setCreating] = useState<SkillKind>();
	useEffect(() => {
		const onNew = (e: Event) => setCreating(((e as CustomEvent).detail as SkillKind | undefined) ?? 'skill');
		window.addEventListener('govern:new-skill', onNew);
		return () => window.removeEventListener('govern:new-skill', onNew);
	}, []);
	if (error) {
		return <ErrorView error={error} retry={refetch} />;
	}
	if (!data) {
		return <Loading page />;
	}
	const columns: IColumn<ISkill>[] = [
		{ id: 'name', title: 'Name', sort: s => s.name, render: s => <span className="cell-primary mono">{s.name}</span> },
		{ id: 'kind', title: 'Kind', width: 100, sort: s => s.kind, render: s => KIND_LABELS[s.kind].label },
		{ id: 'description', title: 'Description', render: s => <span title={s.description}>{s.description || <span className="faint">—</span>}</span> },
		{ id: 'status', title: 'Status', width: 110, sort: s => s.status, render: s => <Tag tone={s.status === 'published' ? 'ok' : s.status === 'draft' ? 'info' : undefined}>{s.status}</Tag> },
		{ id: 'teams', title: 'Shared with', width: 180, render: s => s.teams.length ? s.teams.map(t => teams.data?.find(x => x.id === t)?.name ?? t).join(', ') : 'Everyone' },
		{ id: 'version', title: 'Version', width: 80, align: 'right', sort: s => s.version, render: s => `v${s.version}` },
		{ id: 'updated', title: 'Updated', width: 150, sort: s => s.updatedAt, render: s => `${timeAgo(s.updatedAt)} · ${memberName(members.data, s.updatedBy)}` },
	];
	return (
		<Page title="Skills & Rules" wide subtitle="Shared know-how for every agent in the organization: skills, always-on rules, prompts and sub-agents. Published items reach developers' Volt with their next policy refresh."
			actions={can({ skill: ['create'] }) ? <Button variant="primary" icon="new-file" onClick={() => setCreating('skill')}>New</Button> : undefined}>
			<Table columns={columns} rows={data} rowKey={s => s.id} initialSort={{ column: 'name' }} onRowClick={s => open.skill(s.id, s.name)} empty="Nothing shared yet." />
			{creating ? <NewSkillModal kind={creating} onClose={() => setCreating(undefined)} /> : null}
		</Page>
	);
}
