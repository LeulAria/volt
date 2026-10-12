/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, type IChatListItem } from '@volt/client-core';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatItems, useClient } from '../app/client';
import { StatusIcon } from '../ui/primitives';
import { fuzzyPath, fuzzyText, rank } from './fuzzy';
import { Codicon, type CodiconName, FileIcon } from './icons';
import { relativeTo, useActiveRoot } from './roots';
import { closeQuick, getWorkbench, openTab, type QuickMode, revealInFile, useWorkbench } from './workbench';

export interface ICommand {
	readonly id: string;
	readonly label: string;
	readonly category?: string;
	readonly keybinding?: string;
	readonly icon?: CodiconName;
	readonly run: () => void;
}

interface IItem {
	readonly key: string;
	readonly icon: ReactNode;
	readonly label: string;
	readonly positions?: readonly number[];
	readonly description?: string;
	readonly detail?: string;
	readonly run: () => void;
}

const PREFIX: Record<QuickMode, string> = { files: '', commands: '>', chats: '#', line: ':' };
const RECENT_KEY = 'volt.web.recentFiles';
const indexes = new Map<string, { readonly at: number; readonly files: Promise<readonly string[]> }>();

export function rememberRecentFile(path: string): void {
	try {
		const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
		window.localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...list.filter(p => p !== path)].slice(0, 40)));
	} catch {
		// private mode
	}
}

function recentFiles(): string[] {
	try {
		const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

function Highlight({ text, positions, offset = 0 }: { readonly text: string; readonly positions?: readonly number[]; readonly offset?: number }) {
	if (!positions?.length) {
		return <>{text}</>;
	}
	const marks = new Set(positions.map(p => p - offset));
	const out: ReactNode[] = [];
	let run = '';
	let hit = false;
	for (let i = 0; i < text.length; i++) {
		const on = marks.has(i);
		if (on !== hit && run) {
			out.push(hit ? <mark key={i}>{run}</mark> : <Fragment key={i}>{run}</Fragment>);
			run = '';
		}
		hit = on;
		run += text[i];
	}
	if (run) {
		out.push(hit ? <mark key="end">{run}</mark> : <Fragment key="end">{run}</Fragment>);
	}
	return <>{out}</>;
}

/** The desktop's quick input: ⌘P files, ⇧⌘P commands (`>`), `#` chats, `:` go to line. */
export function QuickInput({ commands }: { readonly commands: readonly ICommand[] }) {
	const quick = useWorkbench(s => s.quick);
	if (!quick) {
		return null;
	}
	return createPortal(<QuickPanel key={quick.seed} initial={PREFIX[quick.mode]} commands={commands} />, document.body);
}

function QuickPanel({ initial, commands }: { readonly initial: string; readonly commands: readonly ICommand[] }) {
	const client = useClient();
	const chats = useChatItems();
	const { root } = useActiveRoot();
	const [value, setValue] = useState(initial);
	const [index, setIndex] = useState(0);
	const [files, setFiles] = useState<readonly string[] | undefined>();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const mode: QuickMode = value.startsWith('>') ? 'commands' : value.startsWith('#') ? 'chats' : value.startsWith(':') ? 'line' : 'files';
	const query = mode === 'files' ? value : value.slice(1);

	useEffect(() => {
		input.current?.focus();
	}, []);

	useEffect(() => {
		if (mode !== 'files' || !root) {
			return;
		}
		let entry = indexes.get(root.path);
		if (!entry || Date.now() - entry.at > 20_000) {
			entry = { at: Date.now(), files: client.fileIndex(root.path).then(r => r.files) };
			indexes.set(root.path, entry);
			entry.files.catch(() => indexes.delete(root.path));
		}
		let cancelled = false;
		entry.files.then(f => !cancelled && setFiles(f), () => !cancelled && setFiles([]));
		return () => {
			cancelled = true;
		};
	}, [client, root, mode]);

	const items = useMemo((): IItem[] => {
		switch (mode) {
			case 'commands': {
				const ranked = query.trim()
					? rank(commands, query, c => `${c.category ? `${c.category}: ` : ''}${c.label}`, fuzzyText, 80)
					: commands.map(item => ({ item, match: { score: 0, positions: [] as number[] } }));
				return ranked.map(({ item, match }) => ({
					key: item.id,
					icon: <Codicon name={item.icon ?? 'symbol-method'} />,
					label: `${item.category ? `${item.category}: ` : ''}${item.label}`,
					positions: match.positions,
					...(item.keybinding ? { detail: item.keybinding } : {}),
					run: item.run,
				}));
			}
			case 'chats': {
				const pool = chats.filter(c => !c.archived);
				const ranked = query.trim() ? rank(pool, query, c => c.title, fuzzyText, 60) : pool.slice(0, 60).map(item => ({ item, match: { score: 0, positions: [] as number[] } }));
				return ranked.map(({ item, match }: { item: IChatListItem; match: { positions: readonly number[] } }) => ({
					key: item.id,
					icon: <StatusIcon status={item.status} size={13} />,
					label: item.title,
					positions: match.positions,
					...(item.projectName ? { description: item.projectName } : {}),
					...(item.status !== 'idle' ? { detail: item.statusLabel } : {}),
					run: () => openTab({ name: 'chat', id: item.id }),
				}));
			}
			case 'line': {
				const line = parseInt(query, 10);
				const active = getWorkbench().tabs.find(t => t.id === getWorkbench().activeId);
				if (active?.kind !== 'file') {
					return [{ key: 'none', icon: <Codicon name="info" />, label: 'Open a file to go to a line.', run: () => undefined }];
				}
				return [{
					key: 'line',
					icon: <Codicon name="arrow-right" />,
					label: Number.isFinite(line) && line > 0 ? `Go to line ${line}` : 'Type a line number to go to.',
					description: basename(active.path),
					run: () => Number.isFinite(line) && line > 0 && revealInFile(active.path, line),
				}];
			}
			default: {
				const base = root?.path;
				if (!query.trim()) {
					const open = getWorkbench().tabs.filter(t => t.kind === 'file').map(t => (t as { path: string }).path);
					const recent = [...new Set([...recentFiles(), ...open])].slice(0, 30);
					return recent.map(path => fileItem(path, base, [], true));
				}
				const pool = files ?? [];
				return rank(pool, query, p => p, fuzzyPath, 60).map(({ item, match }) => fileItem(base ? `${base}/${item}` : item, base, match.positions, false));
			}
		}
	}, [mode, query, commands, chats, files, root]);

	useEffect(() => setIndex(0), [value]);
	useEffect(() => {
		list.current?.querySelector('.quick-item.focused')?.scrollIntoView({ block: 'nearest' });
	}, [index]);

	const accept = (item: IItem | undefined) => {
		if (!item) {
			return;
		}
		closeQuick();
		item.run();
	};

	return (
		<div className="quick-backdrop" onPointerDown={e => e.target === e.currentTarget && closeQuick()}>
			<div className="quick" role="dialog" aria-label="Quick open">
				<div className="quick-input">
					<input
						ref={input}
						value={value}
						spellCheck={false}
						placeholder={mode === 'commands' ? 'Type a command' : mode === 'chats' ? 'Go to a chat' : mode === 'line' ? 'Go to line' : `Search files by name${root ? ` in ${root.name}` : ''} (> commands, # chats, : line)`}
						onChange={e => setValue(e.target.value)}
						onKeyDown={e => {
							if (e.key === 'ArrowDown') {
								e.preventDefault();
								setIndex(i => Math.min(items.length - 1, i + 1));
							} else if (e.key === 'ArrowUp') {
								e.preventDefault();
								setIndex(i => Math.max(0, i - 1));
							} else if (e.key === 'Enter') {
								e.preventDefault();
								accept(items[index]);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								closeQuick();
							}
						}}
					/>
				</div>
				<div className="quick-list" ref={list} role="listbox">
					{mode === 'files' && query.trim() && !files ? <div className="quick-empty"><span className="spinner" style={{ width: 12, height: 12 }} />Indexing {root?.name}…</div> : null}
					{items.length === 0 && (mode !== 'files' || files || !query.trim()) ? <div className="quick-empty">{mode === 'files' && !query.trim() ? 'Type to search files.' : 'No matching results'}</div> : null}
					{items.map((item, i) => (
						<button key={item.key} type="button" role="option" aria-selected={i === index} className={`quick-item${i === index ? ' focused' : ''}`} onMouseMove={() => i !== index && setIndex(i)} onClick={() => accept(item)}>
							<span className="quick-icon">{item.icon}</span>
							<span className="quick-label"><Highlight text={item.label} positions={item.positions?.filter(p => p >= 0)} /></span>
							{item.description ? <span className="quick-desc">{item.description}</span> : null}
							{item.detail ? <span className="quick-detail">{item.detail}</span> : null}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function fileItem(path: string, root: string | undefined, positions: readonly number[], recent: boolean): IItem {
	const rel = relativeTo(root, path);
	const name = basename(path);
	const nameStart = rel.length - name.length;
	return {
		key: path,
		icon: <FileIcon path={path} />,
		label: name,
		// Positions are in the relative path: the label shows the name's share.
		positions: positions.map(p => p - nameStart).filter(p => p >= 0),
		description: dirname(rel) || (recent ? 'recently opened' : ''),
		run: () => openTab({ name: 'file', path }),
	};
}
