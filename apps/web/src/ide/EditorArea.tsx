/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, chatStatus, historyOf, runGroupById, threadsOf } from '@volt/client-core';
import { lazy, memo, type ReactNode, Suspense, useMemo, useState } from 'react';
import { useChatItems, useClient, useCollections } from '../app/client';
import { chatPath, navigate, routePath } from '../app/router';
import { ChatView, openPathInEditor } from '../chat/ChatView';
import { CompareView } from '../chat/CompareView';
import { NewChat } from '../home/NewChat';
import { Settings } from '../settings/Settings';
import { ContextMenu, type IMenuItem } from '../ui/overlays';
import { Kbd, StatusIcon } from '../ui/primitives';
import { ChangesView } from './ChangesView';
import { insertIntoComposer } from './composerBridge';
import { gitDecorations, useGitStatus } from './git';
import { Codicon, FileIcon } from './icons';
import { relativeTo, useActiveRoot } from './roots';
import {
	closeOthers, closeTabs, dirtyKey, type EditorTab, moveTab, openQuick, openTab, pinTab, routeForTab, setAgentChat, showActivity, toggleAgentPanel, toggleDiffInline, toggleWordWrap,
	useWorkbench
} from './workbench';

const CodeEditorPane = lazy(() => import('./monaco/Editors').then(m => ({ default: m.CodeEditorPane })));
const DiffEditorPane = lazy(() => import('./monaco/Editors').then(m => ({ default: m.DiffEditorPane })));

export function EditorArea({ onSignedOut }: { readonly onSignedOut: () => void }) {
	const tabs = useWorkbench(s => s.tabs);
	const activeId = useWorkbench(s => s.activeId);
	const active = tabs.find(t => t.id === activeId);
	return (
		<div className="editor-area">
			{tabs.length ? <TabsBar tabs={tabs} active={active} /> : null}
			{active && (active.kind === 'file' || active.kind === 'diff') ? <Breadcrumbs tab={active} /> : null}
			<div className="editor-content">
				{active ? <EditorContent key={active.kind === 'file' ? 'file' : active.id} tab={active} onSignedOut={onSignedOut} /> : <Watermark />}
			</div>
		</div>
	);
}

function EditorContent({ tab, onSignedOut }: { readonly tab: EditorTab; readonly onSignedOut: () => void }) {
	const client = useClient();
	switch (tab.kind) {
		case 'chat':
			return <ChatView key={tab.chatId} chatId={tab.chatId} variant="tab" openPath={openPathInEditor} />;
		case 'file':
			return <Suspense fallback={<EditorLoading />}><CodeEditorPane client={client} path={tab.path} /></Suspense>;
		case 'diff':
			return <Suspense fallback={<EditorLoading />}><DiffEditorPane client={client} tab={tab} /></Suspense>;
		case 'new':
			return <NewChat initialProjectId={tab.projectId} />;
		case 'settings':
			return <Settings section={tab.section} onSignedOut={onSignedOut} />;
		case 'changes':
			return <ChangesView chatId={tab.chatId} />;
		case 'compare':
			return <CompareView groupId={tab.groupId} />;
	}
}

function EditorLoading() {
	return <div className="editor-loading"><span className="spinner" style={{ width: 14, height: 14 }} /></div>;
}

/** What a tab shows: its icon, its name and (when two tabs share a name) its folder. */
function useTabLabels(tabs: readonly EditorTab[]): Map<string, { readonly label: string; readonly description?: string; readonly icon: ReactNode; readonly title: string }> {
	const cols = useCollections(['history', 'orch.threads', 'access', 'questions', 'runGroups']);
	const { root } = useActiveRoot();
	return useMemo(() => {
		const history = historyOf(cols);
		const threads = threadsOf(cols);
		const names = new Map<string, number>();
		for (const tab of tabs) {
			if (tab.kind === 'file') {
				names.set(basename(tab.path), (names.get(basename(tab.path)) ?? 0) + 1);
			}
		}
		const out = new Map<string, { label: string; description?: string; icon: ReactNode; title: string }>();
		for (const tab of tabs) {
			switch (tab.kind) {
				case 'chat': {
					const meta = history[tab.chatId];
					const status = chatStatus(meta, threads[tab.chatId], 0, 0).status;
					out.set(tab.id, { label: meta?.title || 'New chat', icon: status === 'idle' ? <Codicon name="comment-discussion" /> : <StatusIcon status={status} size={13} />, title: meta?.title ?? 'Chat' });
					break;
				}
				case 'file': {
					const name = basename(tab.path);
					const rel = relativeTo(root?.path, tab.path);
					out.set(tab.id, { label: name, ...((names.get(name) ?? 0) > 1 ? { description: rel.split('/').slice(-2, -1)[0] ?? '' } : {}), icon: <FileIcon path={tab.path} />, title: tab.path });
					break;
				}
				case 'diff':
					out.set(tab.id, { label: `${basename(tab.path)}`, description: tab.base.kind === 'head' ? '(Working Tree)' : '(Agent changes)', icon: <Codicon name="diff" className="tab-diff-icon" />, title: `${tab.path} — ${tab.base.kind === 'head' ? 'HEAD ↔ Working Tree' : 'before the agent ↔ now'}` });
					break;
				case 'new':
					out.set(tab.id, { label: 'New Chat', icon: <Codicon name="add" />, title: 'New Chat' });
					break;
				case 'settings':
					out.set(tab.id, { label: 'Settings', icon: <Codicon name="settings-gear" />, title: 'Settings' });
					break;
				case 'changes':
					out.set(tab.id, { label: `Changes: ${history[tab.chatId]?.title ?? 'chat'}`, icon: <Codicon name="git-compare" />, title: 'Review changes' });
					break;
				case 'compare': {
					const group = runGroupById(cols, tab.groupId);
					out.set(tab.id, { label: `Compare · ${group?.title ?? 'models'}`, icon: <Codicon name="layers" />, title: group ? `Compare models: ${group.title}` : 'Compare models' });
					break;
				}
			}
		}
		return out;
	}, [tabs, cols, root?.path]);
}

const TabsBar = memo(function TabsBar({ tabs, active }: { readonly tabs: readonly EditorTab[]; readonly active: EditorTab | undefined }) {
	const labels = useTabLabels(tabs);
	const dirty = useWorkbench(s => s.dirty);
	const previewId = useWorkbench(s => s.previewId);
	const wordWrap = useWorkbench(s => s.wordWrap);
	const diffInline = useWorkbench(s => s.diffInline);
	const [menu, setMenu] = useState<{ x: number; y: number; tab: EditorTab } | undefined>();
	const [dragId, setDragId] = useState<string | undefined>();
	const { root } = useActiveRoot();

	const menuItems = (tab: EditorTab): IMenuItem[] => [
		{ id: 'close', label: 'Close', icon: 'close', onSelect: () => closeTabs([tab.id]) },
		{ id: 'others', label: 'Close Others', onSelect: () => closeOthers(tab.id) },
		{ id: 'right', label: 'Close to the Right', onSelect: () => closeTabs(tabs.slice(tabs.findIndex(t => t.id === tab.id) + 1).map(t => t.id)) },
		{ id: 'saved', label: 'Close Saved', onSelect: () => closeTabs(tabs.filter(t => !dirty.has(dirtyKey(t) ?? '')).map(t => t.id)) },
		{ id: 'all', label: 'Close All', onSelect: () => closeTabs(tabs.map(t => t.id)) },
		...(tab.kind === 'file' || tab.kind === 'diff' ? [
			{ id: 's', label: '', separator: true },
			{ id: 'copy', label: 'Copy Path', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(tab.path) },
			{ id: 'copy-rel', label: 'Copy Relative Path', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(relativeTo(root?.path, tab.path)) },
			{ id: 'reveal', label: 'Reveal in Explorer', icon: 'folder' as const, onSelect: () => showActivity('explorer') },
			{ id: 'ask', label: 'Add to Chat', icon: 'message' as const, onSelect: () => insertIntoComposer(`@${relativeTo(root?.path, tab.path)} `) },
		] : []),
		...(tab.kind === 'chat' ? [
			{ id: 's', label: '', separator: true },
			{ id: 'panel', label: 'Show in Agent Panel', icon: 'sidebar' as const, onSelect: () => setAgentChat(tab.chatId) },
		] : []),
	];

	return (
		<div className="tabs-bar">
			<div className="tabs" role="tablist" onWheel={e => {
				if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
					e.currentTarget.scrollLeft += e.deltaY;
				}
			}}>
				{tabs.map((tab, index) => {
					const label = labels.get(tab.id);
					const isActive = tab.id === active?.id;
					const isDirty = dirty.has(dirtyKey(tab) ?? '');
					return (
						<div
							key={tab.id}
							role="tab"
							aria-selected={isActive}
							className={`tab${isActive ? ' active' : ''}${tab.id === previewId ? ' preview' : ''}${isDirty ? ' dirty' : ''}${dragId === tab.id ? ' dragging' : ''}`}
							title={label?.title}
							draggable
							onDragStart={e => {
								setDragId(tab.id);
								e.dataTransfer.effectAllowed = 'move';
								if (tab.kind === 'file') {
									e.dataTransfer.setData('text/plain', `@${relativeTo(root?.path, tab.path)} `);
								}
							}}
							onDragEnd={() => setDragId(undefined)}
							onDragOver={e => dragId && e.preventDefault()}
							onDrop={e => {
								if (dragId) {
									e.preventDefault();
									moveTab(dragId, index);
									setDragId(undefined);
								}
							}}
							onMouseDown={e => {
								if (e.button === 1) {
									e.preventDefault();
									closeTabs([tab.id]);
								}
							}}
							onClick={() => !isActive && navigate(routePath(routeForTab(tab)))}
							onDoubleClick={() => pinTab(tab.id)}
							onContextMenu={e => {
								e.preventDefault();
								setMenu({ x: e.clientX, y: e.clientY, tab });
							}}
						>
							<span className="tab-icon">{label?.icon}</span>
							<span className="tab-label">{label?.label}</span>
							{label?.description ? <span className="tab-desc">{label.description}</span> : null}
							<button type="button" className="tab-close" aria-label="Close" title="Close (⌥⌘W)" onClick={e => {
								e.stopPropagation();
								closeTabs([tab.id]);
							}}>
								<span className="tab-dirty-dot" />
								<Codicon name="close" />
							</button>
						</div>
					);
				})}
				<div className="tabs-filler" onDoubleClick={() => openTab({ name: 'new' })} />
			</div>
			<div className="editor-actions">
				{active?.kind === 'file' ? <>
					<FileChangesAction path={active.path} />
					<button type="button" className={`ide-icon-btn${wordWrap ? ' on' : ''}`} title="Toggle Word Wrap (⌥Z)" onClick={toggleWordWrap}><Codicon name="word-wrap" /></button>
					<button type="button" className="ide-icon-btn" title="Add File to Chat" onClick={() => insertIntoComposer(`@${relativeTo(root?.path, active.path)} `)}><Codicon name="mention" /></button>
				</> : null}
				{active?.kind === 'diff' ? <>
					<button type="button" className={`ide-icon-btn${diffInline ? ' on' : ''}`} title={diffInline ? 'Side by Side' : 'Inline View'} onClick={toggleDiffInline}><Codicon name={diffInline ? 'split-horizontal' : 'list-flat'} /></button>
					<button type="button" className="ide-icon-btn" title="Open File" onClick={() => openTab({ name: 'file', path: active.path })}><Codicon name="go-to-file" /></button>
				</> : null}
				{active?.kind === 'chat' ? <button type="button" className="ide-icon-btn" title="Show in Agent Panel" onClick={() => setAgentChat(active.chatId)}><Codicon name="layout-sidebar-right" /></button> : null}
				{active ? <button type="button" className="ide-icon-btn" title="More Actions" onClick={e => setMenu({ x: e.clientX - 200, y: e.clientY + 12, tab: active })}><Codicon name="ellipsis" /></button> : null}
			</div>
			<ContextMenu at={menu} items={menu ? menuItems(menu.tab) : []} onClose={() => setMenu(undefined)} />
		</div>
	);
});

function FileChangesAction({ path }: { readonly path: string }) {
	const { root } = useActiveRoot();
	const git = useGitStatus(root?.path);
	const changed = useMemo(() => gitDecorations(git).has(path), [git, path]);
	if (!changed) {
		return null;
	}
	return <button type="button" className="ide-icon-btn" title="Open Changes" onClick={() => openTab({ name: 'diff', path, base: { kind: 'head' } })}><Codicon name="git-compare" /></button>;
}

function Breadcrumbs({ tab }: { readonly tab: Extract<EditorTab, { kind: 'file' | 'diff' }> }) {
	const { root } = useActiveRoot();
	const rel = relativeTo(root?.path, tab.path);
	const parts = rel.split('/').filter(Boolean);
	return (
		<div className="breadcrumbs">
			{root && rel !== tab.path ? <><span className="crumb root">{root.name}</span><Codicon name="chevron-right" className="crumb-sep" /></> : null}
			{parts.map((part, i) => (
				<span key={i} className="crumb-wrap">
					{i === parts.length - 1 ? <FileIcon path={part} size={14} /> : null}
					<span className={`crumb${i === parts.length - 1 ? ' last' : ''}`}>{part}</span>
					{i < parts.length - 1 ? <Codicon name="chevron-right" className="crumb-sep" /> : null}
				</span>
			))}
		</div>
	);
}

const SHORTCUTS: readonly { readonly label: string; readonly keys: string; readonly run: () => void }[] = [
	{ label: 'New Chat', keys: '⇧⌘O', run: () => openTab({ name: 'new' }) },
	{ label: 'Go to File', keys: '⌘P', run: () => openQuick('files') },
	{ label: 'Show All Commands', keys: '⇧⌘P', run: () => openQuick('commands') },
	{ label: 'Find in Files', keys: '⇧⌘F', run: () => showActivity('search') },
	{ label: 'Toggle Agent Panel', keys: '⌘L', run: () => toggleAgentPanel() },
];

/** The empty editor area: the Volt mark, the shortcuts to start, and the latest chats. */
function Watermark() {
	const client = useClient();
	const chats = useChatItems().filter(c => !c.archived).slice(0, 6);
	return (
		<div className="watermark">
			<div className="watermark-mark"><svg viewBox="0 0 24 24" width="64" height="64" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /></svg></div>
			<div className="watermark-title">Volt on {client.environment.label}</div>
			<div className="watermark-keys">
				{SHORTCUTS.map(s => (
					<button key={s.label} type="button" className="watermark-row" onClick={s.run}>
						<span>{s.label}</span>
						<span className="watermark-kbd">{[...s.keys].map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
					</button>
				))}
			</div>
			{chats.length ? (
				<div className="watermark-recent">
					<div className="watermark-recent-title">Recent chats</div>
					{chats.map(chat => (
						<button key={chat.id} type="button" className="watermark-chat" onClick={() => navigate(chatPath(chat.id))}>
							<StatusIcon status={chat.status} size={13} />
							<span className="watermark-chat-title">{chat.title}</span>
							<span className="watermark-chat-project">{chat.projectName}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
