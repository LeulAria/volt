/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, type GitChangeStatus, type IFileEntry, type IFileRoot } from '@volt/client-core';
import { type KeyboardEvent as ReactKeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClient, useStatus } from '../app/client';
import { ConfirmDialog, ContextMenu, type IMenuItem, MenuButton } from '../ui/overlays';
import { insertIntoComposer } from './composerBridge';
import { gitDecorations, GIT_LABEL, GIT_LETTER, useGitStatus } from './git';
import { Codicon, FileIcon } from './icons';
import { joinPath, relativeTo, useActiveRoot } from './roots';
import { closeTabs, getWorkbench, openTab, setRoot, useWorkbench } from './workbench';

const ROW = 22;

interface IDirState {
	readonly entries?: readonly IFileEntry[];
	readonly loading: boolean;
	readonly error?: string;
}

type InlineEdit =
	| { readonly kind: 'new-file' | 'new-folder'; readonly parent: string }
	| { readonly kind: 'rename'; readonly path: string };

type Row =
	| { readonly kind: 'entry'; readonly entry: IFileEntry; readonly depth: number; readonly expanded: boolean }
	| { readonly kind: 'input'; readonly depth: number; readonly edit: InlineEdit; readonly folder: boolean }
	| { readonly kind: 'status'; readonly depth: number; readonly text: string; readonly error?: boolean };

function expandedKey(root: string): string {
	return `volt.web.expanded.${root}`;
}

function loadExpanded(root: string): Set<string> {
	try {
		const list = JSON.parse(window.localStorage.getItem(expandedKey(root)) ?? '[]') as string[];
		return new Set(Array.isArray(list) ? list : []);
	} catch {
		return new Set();
	}
}

/** The explorer: the active project's files as a tree, drawn the way the desktop draws it. */
export function Explorer() {
	const { root, roots } = useActiveRoot();
	if (!root) {
		return (
			<div className="view-empty">
				<Codicon name="folder" size={22} />
				<div>No project is open in Volt yet.</div>
				<div className="view-empty-sub">Start a chat in a project folder and it shows up here.</div>
			</div>
		);
	}
	return <ExplorerTree key={root.path} root={root} roots={roots} />;
}

const ExplorerTree = memo(function ExplorerTree({ root, roots }: { readonly root: IFileRoot; readonly roots: readonly IFileRoot[] }) {
	const client = useClient();
	const live = useStatus().live;
	const refresh = useWorkbench(s => s.refresh);
	const activeId = useWorkbench(s => s.activeId);
	const tabs = useWorkbench(s => s.tabs);
	const git = useGitStatus(root.path);
	const decorations = useMemo(() => gitDecorations(git), [git]);
	const [dirs, setDirs] = useState<ReadonlyMap<string, IDirState>>(new Map());
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => loadExpanded(root.path));
	const [selected, setSelected] = useState<string | undefined>();
	const [edit, setEdit] = useState<InlineEdit | undefined>();
	const [menu, setMenu] = useState<{ x: number; y: number; entry?: IFileEntry } | undefined>();
	const [deleting, setDeleting] = useState<IFileEntry | undefined>();
	const scroller = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ top: 0, height: 600 });
	const dirsRef = useRef(dirs);
	dirsRef.current = dirs;

	const load = useCallback(async (dir: string, quiet = false) => {
		if (!quiet) {
			setDirs(prev => new Map(prev).set(dir, { ...prev.get(dir), loading: true }));
		}
		try {
			const entries = await client.listDir(dir);
			setDirs(prev => new Map(prev).set(dir, { entries, loading: false }));
		} catch (err) {
			setDirs(prev => new Map(prev).set(dir, { ...(quiet ? prev.get(dir) : {}), loading: false, error: errorMessage(err) }));
		}
	}, [client]);

	useEffect(() => {
		try {
			window.localStorage.setItem(expandedKey(root.path), JSON.stringify([...expanded].slice(0, 400)));
		} catch {
			// private mode
		}
	}, [expanded, root.path]);

	// The root and every open folder load at once and reload when files may have changed.
	useEffect(() => {
		if (!live) {
			return;
		}
		const known = dirsRef.current;
		void load(root.path, known.has(root.path));
		for (const dir of expanded) {
			if (dir.startsWith(root.path)) {
				void load(dir, known.has(dir));
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [root.path, refresh, live]);

	const toggle = useCallback((dir: string, open?: boolean) => {
		setExpanded(prev => {
			const next = new Set(prev);
			const opening = open ?? !next.has(dir);
			if (opening) {
				next.add(dir);
				if (!dirsRef.current.get(dir)?.entries) {
					void load(dir);
				}
			} else {
				next.delete(dir);
			}
			return next;
		});
	}, [load]);

	// The file in front is revealed: its folders open and its row scrolls into view.
	const activePath = useMemo(() => {
		const tab = tabs.find(t => t.id === activeId);
		return tab?.kind === 'file' || tab?.kind === 'diff' ? tab.path : undefined;
	}, [tabs, activeId]);
	useEffect(() => {
		if (!activePath || !activePath.startsWith(`${root.path}/`)) {
			return;
		}
		setSelected(activePath);
		const parents: string[] = [];
		for (let dir = dirname(activePath); dir.length > root.path.length; dir = dirname(dir)) {
			parents.unshift(dir);
		}
		const missing = parents.filter(dir => !expanded.has(dir));
		if (missing.length) {
			setExpanded(prev => new Set([...prev, ...missing]));
			missing.forEach(dir => !dirsRef.current.get(dir)?.entries && void load(dir));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activePath, root.path]);

	const rows = useMemo(() => {
		const out: Row[] = [];
		const walk = (dir: string, depth: number) => {
			const state = dirs.get(dir);
			if (edit && edit.kind !== 'rename' && edit.parent === dir) {
				out.push({ kind: 'input', depth, edit, folder: edit.kind === 'new-folder' });
			}
			if (!state?.entries) {
				if (state?.loading || !state) {
					out.push({ kind: 'status', depth, text: 'Loading…' });
				} else if (state.error) {
					out.push({ kind: 'status', depth, text: state.error, error: true });
				}
				return;
			}
			for (const entry of state.entries) {
				if (edit?.kind === 'rename' && edit.path === entry.path) {
					out.push({ kind: 'input', depth, edit, folder: entry.kind === 'dir' });
				} else {
					const open = entry.kind === 'dir' && expanded.has(entry.path);
					out.push({ kind: 'entry', entry, depth, expanded: open });
				}
				if (entry.kind === 'dir' && expanded.has(entry.path)) {
					walk(entry.path, depth + 1);
				}
			}
		};
		walk(root.path, 0);
		return out;
	}, [dirs, expanded, edit, root.path]);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) {
			return;
		}
		const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!selected || !scroller.current) {
			return;
		}
		const index = rows.findIndex(r => r.kind === 'entry' && r.entry.path === selected);
		const el = scroller.current;
		if (index >= 0 && (index * ROW < el.scrollTop || (index + 1) * ROW > el.scrollTop + el.clientHeight)) {
			el.scrollTop = Math.max(0, index * ROW - el.clientHeight / 2);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, rows.length]);

	const open = (entry: IFileEntry, pinned: boolean) => {
		if (entry.kind === 'dir') {
			toggle(entry.path);
			return;
		}
		openTab({ name: 'file', path: entry.path }, { preview: !pinned });
	};

	const commitEdit = async (value: string) => {
		const current = edit;
		setEdit(undefined);
		const name = value.trim();
		if (!current || !name) {
			return;
		}
		try {
			if (current.kind === 'rename') {
				if (name === basename(current.path)) {
					return;
				}
				const target = joinPath(dirname(current.path), name);
				await client.renamePath(current.path, target);
				const wasOpen = getWorkbench().tabs.some(t => t.kind === 'file' && t.path === current.path);
				closeTabs(getWorkbench().tabs.filter(t => (t.kind === 'file' || t.kind === 'diff') && t.path === current.path).map(t => t.id), { force: true });
				await load(dirname(current.path), true);
				setSelected(target);
				if (wasOpen) {
					openTab({ name: 'file', path: target });
				}
			} else {
				const target = joinPath(current.parent, name);
				await client.createFile(target, current.kind === 'new-folder' ? 'dir' : 'file');
				await load(dirname(target), true);
				setSelected(target);
				if (current.kind === 'new-file') {
					openTab({ name: 'file', path: target });
				} else {
					toggle(target, true);
				}
			}
		} catch (err) {
			client.toast('error', errorMessage(err));
		}
	};

	const startCreate = (kind: 'new-file' | 'new-folder', near?: IFileEntry) => {
		const parent = near ? (near.kind === 'dir' ? near.path : dirname(near.path)) : selectedDir();
		if (parent !== root.path) {
			toggle(parent, true);
		}
		setEdit({ kind, parent });
	};

	const selectedDir = () => {
		const row = rows.find(r => r.kind === 'entry' && r.entry.path === selected);
		if (row?.kind === 'entry') {
			return row.entry.kind === 'dir' ? row.entry.path : dirname(row.entry.path);
		}
		return root.path;
	};

	const remove = async (entry: IFileEntry) => {
		try {
			await client.deletePath(entry.path);
			closeTabs(getWorkbench().tabs.filter(t => (t.kind === 'file' || t.kind === 'diff') && (t.path === entry.path || t.path.startsWith(`${entry.path}/`))).map(t => t.id), { force: true });
			await load(dirname(entry.path), true);
		} catch (err) {
			client.toast('error', `Couldn't delete: ${errorMessage(err)}`);
		}
	};

	const onKeyDown = (e: ReactKeyboardEvent) => {
		if (edit || (e.target as HTMLElement).tagName === 'INPUT') {
			return;
		}
		const entries = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry');
		const index = entries.findIndex(r => r.entry.path === selected);
		const current = entries[index];
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const next = entries[Math.max(0, Math.min(entries.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (next) {
				setSelected(next.entry.path);
				if (next.entry.kind === 'file') {
					openTab({ name: 'file', path: next.entry.path }, { preview: true });
				}
			}
		} else if (e.key === 'ArrowRight' && current?.entry.kind === 'dir') {
			e.preventDefault();
			toggle(current.entry.path, true);
		} else if (e.key === 'ArrowLeft' && current) {
			e.preventDefault();
			if (current.entry.kind === 'dir' && current.expanded) {
				toggle(current.entry.path, false);
			} else if (dirname(current.entry.path) !== root.path) {
				setSelected(dirname(current.entry.path));
			}
		} else if (e.key === 'Enter' && current) {
			e.preventDefault();
			open(current.entry, true);
		} else if (e.key === 'F2' && current) {
			e.preventDefault();
			setEdit({ kind: 'rename', path: current.entry.path });
		} else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && current) {
			e.preventDefault();
			setDeleting(current.entry);
		}
	};

	const menuItems = (entry: IFileEntry | undefined): IMenuItem[] => {
		const rel = entry ? relativeTo(root.path, entry.path) : '';
		const items: IMenuItem[] = [
			...(entry?.kind === 'file' ? [
				{ id: 'open', label: 'Open', icon: 'file' as const, onSelect: () => open(entry, true) },
				...(decorations.has(entry.path) ? [{ id: 'changes', label: 'Open Changes', icon: 'layers' as const, onSelect: () => openTab({ name: 'diff', path: entry.path, base: { kind: 'head' } }) }] : []),
				{ id: 'ask', label: 'Add to Chat', icon: 'message' as const, onSelect: () => void insertIntoComposer(`@${rel} `) },
				{ id: 's0', label: '', separator: true },
			] : []),
			{ id: 'new-file', label: 'New File…', icon: 'plus' as const, onSelect: () => startCreate('new-file', entry) },
			{ id: 'new-folder', label: 'New Folder…', icon: 'folderPlus' as const, onSelect: () => startCreate('new-folder', entry) },
			...(entry ? [
				{ id: 's1', label: '', separator: true },
				{ id: 'copy', label: 'Copy Path', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(entry.path) },
				{ id: 'copy-rel', label: 'Copy Relative Path', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(rel) },
				{ id: 's2', label: '', separator: true },
				{ id: 'rename', label: 'Rename…', icon: 'pencil' as const, detail: 'F2', onSelect: () => setEdit({ kind: 'rename', path: entry.path }) },
				{ id: 'delete', label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => setDeleting(entry) },
			] : [
				{ id: 's1', label: '', separator: true },
				{ id: 'refresh', label: 'Refresh', icon: 'refresh' as const, onSelect: () => void load(root.path) },
			]),
		];
		return items;
	};

	const picked = getWorkbench().root;
	const rootItems: IMenuItem[] = [
		{ id: 'follow', label: 'Follow the Open Chat', icon: 'message', checked: !picked, detail: 'Show the project of the chat in front', onSelect: () => setRoot(undefined) },
		{ id: 's', label: '', separator: true },
		{ id: 'h', label: 'Projects and worktrees', header: true },
		...roots.map(r => ({ id: r.path, label: r.name, detail: r.kind === 'worktree' ? `Worktree · ${r.path}` : r.path, icon: (r.kind === 'worktree' ? 'branch' : 'folder') as 'branch' | 'folder', checked: !!picked && r.path === root.path, onSelect: () => setRoot(r.path) })),
	];

	const start = Math.max(0, Math.floor(viewport.top / ROW) - 8);
	const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW) + 8);

	return (
		<div className="explorer">
			<div className="view-section-head">
				<MenuButton className="root-picker" items={rootItems} placement="bottom-start" width={320} label="Switch project">
					<Codicon name="chevron-down" size={14} />
					<span className="root-name">{root.name}</span>
					{root.kind === 'worktree' ? <span className="root-tag">worktree</span> : null}
				</MenuButton>
				<span className="view-actions">
					<button type="button" className="ide-icon-btn" title="New File…" onClick={() => startCreate('new-file')}><Codicon name="new-file" /></button>
					<button type="button" className="ide-icon-btn" title="New Folder…" onClick={() => startCreate('new-folder')}><Codicon name="new-folder" /></button>
					<button type="button" className="ide-icon-btn" title="Refresh Explorer" onClick={() => {
						void load(root.path);
						expanded.forEach(dir => void load(dir, true));
					}}><Codicon name="refresh" /></button>
					<button type="button" className="ide-icon-btn" title="Collapse Folders" onClick={() => setExpanded(new Set())}><Codicon name="collapse-all" /></button>
				</span>
			</div>
			<div
				className="tree"
				ref={scroller}
				tabIndex={0}
				role="tree"
				onKeyDown={onKeyDown}
				onScroll={e => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
				onContextMenu={e => {
					if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('tree-spacer')) {
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY });
					}
				}}
			>
				<div className="tree-spacer" style={{ height: rows.length * ROW }}>
					{rows.slice(start, end).map((row, i) => {
						const index = start + i;
						const style = { top: index * ROW, paddingLeft: 8 + row.depth * 12 };
						if (row.kind === 'status') {
							return <div key={`s:${index}`} className={`tree-row tree-status${row.error ? ' error' : ''}`} style={style}>{row.text}</div>;
						}
						if (row.kind === 'input') {
							const initial = row.edit.kind === 'rename' ? basename(row.edit.path) : '';
							return (
								<div key="input" className="tree-row tree-input-row" style={style}>
									{row.folder ? <Codicon name="chevron-right" className="twistie" /> : <span className="twistie" />}
									{row.folder ? <Codicon name="folder" className="folder-icon" /> : <FileIcon path={initial || 'file'} />}
									<InlineInput initial={initial} onCommit={value => void commitEdit(value)} onCancel={() => setEdit(undefined)} />
								</div>
							);
						}
						const { entry } = row;
						const deco = decorations.get(entry.path);
						const isActive = entry.path === activePath;
						return (
							<TreeRow
								key={entry.path}
								entry={entry}
								expanded={row.expanded}
								style={style}
								selected={entry.path === selected}
								active={isActive}
								deco={deco}
								root={root.path}
								onClick={pinned => {
									setSelected(entry.path);
									open(entry, pinned);
								}}
								onMenu={(x, y) => {
									setSelected(entry.path);
									setMenu({ x, y, entry });
								}}
							/>
						);
					})}
				</div>
			</div>
			<ContextMenu at={menu} items={menu ? menuItems(menu.entry) : []} onClose={() => setMenu(undefined)} />
			<ConfirmDialog
				open={!!deleting}
				title={`Delete ${deleting ? basename(deleting.path) : ''}?`}
				body={deleting?.kind === 'dir' ? 'The folder and everything in it are deleted on your computer. This can\'t be undone here.' : 'The file is deleted on your computer. This can\'t be undone here.'}
				confirm="Delete"
				danger
				onClose={() => setDeleting(undefined)}
				onConfirm={() => deleting && void remove(deleting)}
			/>
		</div>
	);
});

const TreeRow = memo(function TreeRow({ entry, expanded, style, selected, active, deco, root, onClick, onMenu }: {
	readonly entry: IFileEntry;
	readonly expanded: boolean;
	readonly style: { readonly top: number; readonly paddingLeft: number };
	readonly selected: boolean;
	readonly active: boolean;
	readonly deco?: GitChangeStatus;
	readonly root: string;
	readonly onClick: (pinned: boolean) => void;
	readonly onMenu: (x: number, y: number) => void;
}) {
	return (
		<div
			className={`tree-row${selected ? ' selected' : ''}${active ? ' active' : ''}${deco ? ` git-${deco === '?' ? 'untracked' : deco}` : ''}`}
			style={style}
			role="treeitem"
			aria-expanded={entry.kind === 'dir' ? expanded : undefined}
			title={entry.path}
			draggable
			onDragStart={e => {
				e.dataTransfer.setData('text/plain', `@${relativeTo(root, entry.path)} `);
				e.dataTransfer.setData('application/x-volt-path', entry.path);
			}}
			onClick={e => onClick(e.detail > 1)}
			onContextMenu={e => {
				e.preventDefault();
				onMenu(e.clientX, e.clientY);
			}}
		>
			{entry.kind === 'dir' ? <Codicon name="chevron-right" className={`twistie${expanded ? ' open' : ''}`} /> : <span className="twistie" />}
			{entry.kind === 'dir' ? <Codicon name={expanded ? 'folder-opened' : 'folder'} className="folder-icon" /> : <FileIcon path={entry.name} />}
			<span className="tree-label">{entry.name}</span>
			{entry.link ? <Codicon name="link-external" className="tree-link" size={11} /> : null}
			{deco ? <span className="tree-deco" title={GIT_LABEL[deco]}>{entry.kind === 'dir' ? '•' : GIT_LETTER[deco]}</span> : null}
		</div>
	);
});

function InlineInput({ initial, onCommit, onCancel }: { readonly initial: string; readonly onCommit: (value: string) => void; readonly onCancel: () => void }) {
	const ref = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		el.focus();
		const dot = initial.lastIndexOf('.');
		el.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial]);
	const finish = (commit: boolean) => {
		if (done.current) {
			return;
		}
		done.current = true;
		if (commit) {
			onCommit(ref.current?.value ?? '');
		} else {
			onCancel();
		}
	};
	return (
		<input
			ref={ref}
			className="tree-input"
			defaultValue={initial}
			spellCheck={false}
			onKeyDown={e => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					finish(true);
				} else if (e.key === 'Escape') {
					finish(false);
				}
			}}
			onBlur={() => finish(true)}
		/>
	);
}
