/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import type { ISkill, ISkillVersion, SkillKind } from '../../shared/api';
import { api } from '../lib/api';
import { keys, memberName, useMembers, useOrg, useSkills, useTeams } from '../lib/data';
import { formatDateTime, keys as kb, timeAgo } from '../lib/format';
import { invalidate, useQuery } from '../lib/query';
import { closeEditor } from '../lib/workbench';
import { Button, Checkbox, Select, Tag, TextArea } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { Loading, Section } from '../ui/layout';
import { attempt, confirm } from '../ui/overlays';
import type { IEditorProps } from '../workbench/EditorPart';
import { useBeforeUnload, useDirty } from './common';
import { KIND_LABELS } from './SkillsEditor';

/** A plain code editor: line numbers, tab inserts a tab, ⌘S saves. */
function CodeEditor({ value, onChange, onSave, readOnly }: { readonly value: string; readonly onChange: (v: string) => void; readonly onSave: () => void; readonly readOnly?: boolean }) {
	const gutter = useRef<HTMLDivElement>(null);
	const lines = value.split('\n').length;
	return (
		<div className="code-editor">
			<div className="code-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
			<textarea className="code-input" value={value} readOnly={readOnly} spellCheck={false} wrap="off" aria-label="Content"
				onScroll={e => { if (gutter.current) { gutter.current.scrollTop = e.currentTarget.scrollTop; } }}
				onChange={e => onChange(e.target.value)}
				onKeyDown={e => {
					if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
						e.preventDefault();
						onSave();
					} else if (e.key === 'Tab' && !readOnly) {
						e.preventDefault();
						const t = e.currentTarget;
						const { selectionStart: s, selectionEnd: end } = t;
						onChange(`${value.slice(0, s)}\t${value.slice(end)}`);
						requestAnimationFrame(() => t.setSelectionRange(s + 1, s + 1));
					}
				}} />
		</div>
	);
}

export default function SkillEditor({ input }: IEditorProps) {
	const id = input.params!.id;
	const { orgId, can } = useOrg();
	const skills = useSkills(orgId);
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const skill = skills.data?.find(s => s.id === id);
	const versions = useQuery(`${orgId}:skill-versions:${id}`, () => api.get<ISkillVersion[]>(`/skills/${id}/versions`));
	const [content, setContent] = useState('');
	const [description, setDescription] = useState('');
	const [kind, setKind] = useState<SkillKind>('skill');
	const [shared, setShared] = useState<string[]>([]);
	const [viewing, setViewing] = useState<ISkillVersion>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (skill) {
			setContent(skill.content);
			setDescription(skill.description);
			setKind(skill.kind);
			setShared([...skill.teams]);
		}
	}, [skill]);

	const dirty = !!skill && (content !== skill.content || description !== skill.description || kind !== skill.kind || JSON.stringify(shared) !== JSON.stringify(skill.teams));
	useDirty(input.id, dirty);
	useBeforeUnload(dirty);

	if (!skills.data) {
		return <Loading page />;
	}
	if (!skill) {
		return <div className="page"><div className="muted">This item was deleted.</div></div>;
	}
	const editable = can({ skill: ['update'] });
	const refresh = () => invalidate(keys.skills(orgId), `${orgId}:skill-versions:${id}`);
	const save = async (status?: ISkill['status']) => {
		if (!editable) {
			return;
		}
		setBusy(true);
		const ok = await attempt(() => api.put<ISkill>(`/skills/${id}`, { content, description, kind, teams: shared, ...(status ? { status } : {}) }), status === 'published' ? `${skill.name} published` : 'Saved');
		setBusy(false);
		if (ok) {
			refresh();
		}
	};
	const remove = async () => {
		if (await confirm({ title: `Delete ${skill.name}?`, message: 'It disappears from every developer\'s Volt with the next policy refresh, along with its history.', primary: 'Delete', danger: true })) {
			const ok = await attempt(() => api.delete(`/skills/${id}`), 'Deleted');
			if (ok) {
				invalidate(keys.skills(orgId));
				closeEditor(input.id);
			}
		}
	};
	return (
		<div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
			<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '12px 16px 16px' }}>
				<div className="row" style={{ marginBottom: 10 }}>
					<Codicon name="book" />
					<span className="mono" style={{ fontWeight: 600 }}>{skill.name}</span>
					<Tag tone={skill.status === 'published' ? 'ok' : skill.status === 'draft' ? 'info' : undefined}>{skill.status}</Tag>
					<span className="faint" style={{ fontSize: 12 }}>v{skill.version} · {timeAgo(skill.updatedAt)} by {memberName(members.data, skill.updatedBy)}</span>
					<span className="spacer" />
					{viewing ? <><Tag icon="history">viewing v{viewing.version}</Tag><Button size="sm" onClick={() => setViewing(undefined)}>Back to Current</Button>{editable ? <Button size="sm" onClick={() => { setContent(viewing.content); setViewing(undefined); }}>Restore</Button> : null}</> : null}
					{dirty && !viewing ? <Button icon="save" busy={busy} title={`Save (${kb('⌘S')})`} onClick={() => void save()}>Save</Button> : null}
					{can({ skill: ['publish'] }) && !viewing ? (
						skill.status === 'published' && !dirty
							? <Button icon="archive" onClick={() => void save('archived')}>Archive</Button>
							: <Button variant="primary" icon="cloud-upload" busy={busy} onClick={() => void save('published')}>{dirty && skill.status === 'published' ? 'Save & Publish' : 'Publish'}</Button>
					) : null}
				</div>
				<CodeEditor value={viewing ? viewing.content : content} readOnly={!editable || !!viewing} onChange={setContent} onSave={() => void save()} />
			</div>
			<aside style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--stroke-faint)', overflowY: 'auto', padding: '14px 16px' }}>
				<Section title="Details">
					<div className="field"><span className="field-label">Kind</span><Select value={kind} disabled={!editable} onChange={setKind} options={(Object.keys(KIND_LABELS) as SkillKind[]).map(k => ({ value: k, label: KIND_LABELS[k].label }))} /></div>
					<div className="field"><span className="field-label">Description</span><TextArea rows={3} value={description} disabled={!editable} onChange={e => setDescription(e.target.value)} /></div>
				</Section>
				<Section title="Shared with" hint="No team selected: everyone. Policies can also make it required.">
					<div className="stack">
						<Checkbox label="Everyone" checked={!shared.length} disabled={!editable} onChange={on => on && setShared([])} />
						{(teams.data ?? []).map(t => <Checkbox key={t.id} label={t.name} disabled={!editable} checked={shared.includes(t.id)} onChange={on => setShared(on ? [...shared, t.id] : shared.filter(x => x !== t.id))} />)}
					</div>
				</Section>
				<Section title="History">
					{(versions.data ?? []).map(v => (
						<div key={v.version} className={`list-row${viewing?.version === v.version ? ' selected' : ''}`} style={{ ['--indent' as string]: '4px' }} onClick={() => setViewing(v.version === skill.version ? undefined : v)}>
							<Codicon name="history" />
							<span className="list-label">v{v.version}</span>
							<span className="list-desc" title={formatDateTime(v.createdAt)}>{timeAgo(v.createdAt)} · {memberName(members.data, v.createdBy)}</span>
						</div>
					))}
				</Section>
				{can({ skill: ['delete'] }) ? <Section title="Danger zone"><div className="group danger group-pad"><div className="field-hint" style={{ marginBottom: 10 }}>Removes it from every developer's Volt, with its history.</div><Button variant="danger" icon="trash" onClick={() => void remove()}>Delete</Button></div></Section> : null}
			</aside>
		</div>
	);
}
