/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useCredentials, useMcp, useMembers, useOrg, useSkills, useTeams } from '../lib/data';
import { closeQuick, openQuick, useWorkbench } from '../lib/workbench';
import { Kbd } from '../ui/controls';
import { Codicon, type CodiconName } from '../ui/icons';
import { COMMANDS, open } from './commands';

interface IPick {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly group: string;
	readonly icon?: CodiconName;
	readonly keys?: string;
	readonly run: () => void;
}

/** Fuzzy match: every query character in order; earlier and contiguous hits score higher. */
function match(label: string, query: string): { readonly score: number; readonly hits: readonly number[] } | undefined {
	if (!query) {
		return { score: 0, hits: [] };
	}
	const l = label.toLowerCase();
	const q = query.toLowerCase();
	const hits: number[] = [];
	let from = 0;
	let score = 0;
	for (const ch of q) {
		const at = l.indexOf(ch, from);
		if (at < 0) {
			return undefined;
		}
		score += at === from ? 3 : at === 0 || /[\s:/._-]/.test(l[at - 1]) ? 2 : 1;
		hits.push(at);
		from = at + 1;
	}
	return { score: score - hits[0] * 0.1, hits };
}

function highlight(label: string, hits: readonly number[]): ReactNode {
	if (!hits.length) {
		return label;
	}
	const set = new Set(hits);
	return [...label].map((ch, i) => set.has(i) ? <mark key={i}>{ch}</mark> : ch);
}

/** VS Code's Quick Open (`⌘P`) and Command Palette (`⇧⌘P`, or `>` in Quick Open). */
export function QuickInput() {
	const mode = useWorkbench(s => s.quick);
	const { orgId, can } = useOrg();
	const members = useMembers(orgId);
	const teams = useTeams(orgId);
	const skills = useSkills(orgId);
	const mcp = useMcp(orgId);
	const credentials = useCredentials(can({ credential: ['read'] }) ? orgId : '');
	const [value, setValue] = useState('');
	const [focus, setFocus] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setValue(mode === 'commands' ? '>' : '');
		setFocus(0);
	}, [mode]);

	const commandMode = value.startsWith('>');
	const query = commandMode ? value.slice(1).trim() : value.trim();

	const picks = useMemo<IPick[]>(() => {
		if (commandMode) {
			return COMMANDS.filter(c => !c.needs || can(c.needs)).map(c => ({ id: c.id, label: `${c.category}: ${c.title}`, group: 'commands', icon: c.icon, keys: c.keys, run: c.run }));
		}
		const out: IPick[] = [];
		for (const m of members.data ?? []) {
			out.push({ id: `m:${m.userId}`, label: m.user.name || m.user.email, description: m.user.email, group: 'members', icon: 'person', run: () => open.member(m.userId, m.user.name || m.user.email, true) });
		}
		for (const t of teams.data ?? []) {
			out.push({ id: `t:${t.id}`, label: t.name, description: 'team', group: 'teams', icon: 'organization', run: () => open.team(t.id, t.name, true) });
		}
		for (const s of skills.data ?? []) {
			out.push({ id: `s:${s.id}`, label: s.name, description: `${s.kind} · ${s.status}`, group: 'skills', icon: 'book', run: () => open.skill(s.id, s.name, true) });
		}
		for (const s of mcp.data ?? []) {
			out.push({ id: `p:${s.id}`, label: s.name, description: `MCP · ${s.status}`, group: 'MCP servers', icon: 'plug', run: () => open.mcpServer(s.id, s.name, true) });
		}
		for (const c of credentials.data ?? []) {
			out.push({ id: `c:${c.id}`, label: c.label, description: `${c.provider} key`, group: 'provider keys', icon: 'key', run: () => open.credential(c.id, c.label, true) });
		}
		return out;
	}, [commandMode, members.data, teams.data, skills.data, mcp.data, credentials.data, can]);

	const results = useMemo(() => picks
		.map(p => ({ p, m: match(p.label, query) ?? (p.description ? match(p.description, query) && { score: -1, hits: [] } : undefined) }))
		.filter((x): x is { p: IPick; m: { score: number; hits: readonly number[] } } => !!x.m)
		.sort((a, b) => b.m.score - a.m.score)
		.slice(0, 80), [picks, query]);

	useEffect(() => {
		listRef.current?.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
	}, [focus]);

	if (!mode) {
		return null;
	}
	const run = (pick: IPick | undefined) => {
		if (pick) {
			closeQuick();
			pick.run();
		}
	};
	let lastGroup = '';
	return (
		<div className="quick-backdrop" onMouseDown={e => e.target === e.currentTarget && closeQuick()}>
			<div className="quick" role="dialog" aria-label={commandMode ? 'Command Palette' : 'Quick Open'}>
				<div className="quick-input">
					<input autoFocus value={value} placeholder={commandMode ? 'Type the name of a command to run.' : 'Search members, teams, skills, MCP servers and keys (type > for commands)'}
						onChange={e => { setValue(e.target.value); setFocus(0); }}
						onKeyDown={e => {
							if (e.key === 'Escape') { e.preventDefault(); closeQuick(); }
							else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(f => Math.min(results.length - 1, f + 1)); }
							else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(f => Math.max(0, f - 1)); }
							else if (e.key === 'Enter') { e.preventDefault(); run(results[focus]?.p); }
						}} />
				</div>
				<div className="quick-list" role="listbox" ref={listRef}>
					{results.length ? results.map(({ p, m }, i) => {
						const head = !commandMode && p.group !== lastGroup ? p.group : undefined;
						lastGroup = p.group;
						return (
							<div key={p.id}>
								{head ? <div className="quick-group">{head}</div> : null}
								<button type="button" role="option" aria-selected={i === focus} className={`quick-item${i === focus ? ' focused' : ''}`} onMouseMove={() => setFocus(i)} onClick={() => run(p)}>
									{p.icon ? <Codicon name={p.icon} /> : <span className="quick-icon-space" />}
									<span className="quick-label">{highlight(p.label, m.hits)}</span>
									{p.description ? <span className="quick-desc">{p.description}</span> : null}
									{p.keys ? <span className="quick-keys"><Kbd>{p.keys}</Kbd></span> : null}
								</button>
							</div>
						);
					}) : <div className="quick-empty">{commandMode ? 'No matching commands' : <>No matching results. <button type="button" className="link-btn" onClick={() => openQuick('commands')}>Show commands</button></>}</div>}
				</div>
			</div>
		</div>
	);
}
