/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, historyOf, type IAgentChange, type IGitChange, uriPath } from '@volt/client-core';
import { useEffect, useState } from 'react';
import { useClient, useCollections, useStatus } from '../app/client';
import { changesPath, navigate } from '../app/router';
import { ContextMenu, type IMenuItem } from '../ui/overlays';
import { insertIntoComposer } from './composerBridge';
import { GIT_LABEL, GIT_LETTER, refreshGit, useGitStatus } from './git';
import { Codicon, FileIcon } from './icons';
import { joinPath, relativeTo, useActiveRoot } from './roots';
import { bumpRefresh, getWorkbench, openTab, useWorkbench } from './workbench';

/** Source control: the project's working tree changes, a commit box, and what the agent changed. */
export function ScmView() {
	const client = useClient();
	const { root } = useActiveRoot();
	const git = useGitStatus(root?.path);
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState({ changes: true, agent: true });
	const [menu, setMenu] = useState<{ x: number; y: number; path: string } | undefined>();

	const commit = async () => {
		if (!root || !message.trim() || busy) {
			return;
		}
		setBusy(true);
		try {
			const result = await client.gitCommit(root.path, message);
			client.toast('success', `Committed ${result.commit}`);
			setMessage('');
			await refreshGit(client, root.path, getWorkbench().refresh, true);
			bumpRefresh();
		} catch (err) {
			client.toast('error', errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	if (!root) {
		return <div className="view-empty"><Codicon name="source-control" size={22} /><div>No project is open.</div></div>;
	}
	if (git && !git.repoRoot) {
		return (
			<div className="view-empty">
				<Codicon name="source-control" size={22} />
				<div>{root.name} is not a git repository.</div>
				<AgentChanges />
			</div>
		);
	}
	const changes = git?.changes ?? [];
	const menuItems = (path: string): IMenuItem[] => [
		{ id: 'diff', label: 'Open Changes', icon: 'layers', onSelect: () => openTab({ name: 'diff', path, base: { kind: 'head' } }) },
		{ id: 'file', label: 'Open File', icon: 'file', onSelect: () => openTab({ name: 'file', path }) },
		{ id: 'ask', label: 'Add to Chat', icon: 'message', onSelect: () => insertIntoComposer(`@${relativeTo(root.path, path)} `) },
		{ id: 'copy', label: 'Copy Path', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(path) },
	];

	return (
		<div className="scm-view">
			<div className="scm-commit">
				<textarea
					value={message}
					placeholder={`Message (⌘↵ to commit on "${git?.branch ?? 'HEAD'}")`}
					rows={2}
					onChange={e => setMessage(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void commit();
						}
					}}
				/>
				<button type="button" className="scm-commit-btn" disabled={!message.trim() || !changes.length || busy} onClick={() => void commit()}>
					{busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Codicon name="check" />}Commit
				</button>
			</div>
			<button type="button" className="view-group-head" onClick={() => setOpen(o => ({ ...o, changes: !o.changes }))}>
				<Codicon name="chevron-right" className={`twistie${open.changes ? ' open' : ''}`} />
				<span>Changes</span>
				<span className="badge">{changes.length}</span>
				<span className="view-actions" onClick={e => e.stopPropagation()}>
					<button type="button" className="ide-icon-btn" title="Refresh" onClick={() => {
						void refreshGit(client, root.path, getWorkbench().refresh, true);
					}}><Codicon name="refresh" /></button>
				</span>
			</button>
			{open.changes ? (
				<div className="scm-list">
					{!git ? <div className="tree-status">Loading…</div> : !changes.length ? <div className="tree-status">No changes in the working tree.</div> : null}
					{changes.map(change => (
						<ChangeRow key={change.path} change={change} root={root.path} onMenu={(x, y) => setMenu({ x, y, path: change.path })} />
					))}
				</div>
			) : null}
			<button type="button" className="view-group-head" onClick={() => setOpen(o => ({ ...o, agent: !o.agent }))}>
				<Codicon name="chevron-right" className={`twistie${open.agent ? ' open' : ''}`} />
				<span>Agent changes</span>
			</button>
			{open.agent ? <AgentChanges /> : null}
			<ContextMenu at={menu} items={menu ? menuItems(menu.path) : []} onClose={() => setMenu(undefined)} />
		</div>
	);
}

function ChangeRow({ change, root, onMenu }: { readonly change: IGitChange; readonly root: string; readonly onMenu: (x: number, y: number) => void }) {
	const activeId = useWorkbench(s => s.activeId);
	const active = activeId?.startsWith('diff:head:') && activeId.endsWith(change.path);
	return (
		<button
			type="button"
			className={`scm-row git-${change.status === '?' ? 'untracked' : change.status}${active ? ' active' : ''}`}
			title={`${change.rel} · ${GIT_LABEL[change.status]}`}
			onClick={e => openTab(change.status === 'D' ? { name: 'diff', path: change.path, base: { kind: 'head' } } : { name: 'diff', path: change.path, base: { kind: 'head' } }, { preview: e.detail < 2 })}
			onContextMenu={e => {
				e.preventDefault();
				onMenu(e.clientX, e.clientY);
			}}
		>
			<FileIcon path={change.path} />
			<span className={`scm-name${change.status === 'D' ? ' deleted' : ''}`}>{basename(change.path)}</span>
			<span className="scm-dir">{dirname(relativeTo(root, change.path))}</span>
			{change.additions || change.deletions ? <span className="scm-stats"><span className="add">+{change.additions ?? 0}</span><span className="del">−{change.deletions ?? 0}</span></span> : null}
			<span className="scm-letter">{GIT_LETTER[change.status]}</span>
		</button>
	);
}

/** What the agent of the chat in front changed, from its checkpoints (survives commits). */
function AgentChanges() {
	const client = useClient();
	const live = useStatus().live;
	const chatId = useWorkbench(s => s.agentChatId);
	const refresh = useWorkbench(s => s.refresh);
	const history = historyOf(useCollections(['history']));
	const [changes, setChanges] = useState<readonly IAgentChange[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	useEffect(() => {
		if (!chatId || !live) {
			return;
		}
		let cancelled = false;
		client.getChanges(chatId, 'session').then(list => {
			if (!cancelled) {
				setChanges(list);
				setError(undefined);
			}
		}, err => !cancelled && setError(errorMessage(err)));
		return () => {
			cancelled = true;
		};
	}, [client, chatId, refresh, live]);
	if (!chatId) {
		return <div className="tree-status">Open a chat to see what its agent changed.</div>;
	}
	const title = history[chatId]?.title ?? 'This chat';
	return (
		<div className="scm-list">
			<button type="button" className="scm-chat" onClick={() => navigate(changesPath(chatId))} title="Review every change in this chat">
				<Codicon name="comment-discussion" />
				<span className="scm-name">{title}</span>
				<Codicon name="go-to-file" />
			</button>
			{error ? <div className="tree-status error">{error}</div> : !changes ? <div className="tree-status">Loading…</div> : !changes.length ? <div className="tree-status">The agent hasn't changed any files in this chat.</div> : null}
			{changes?.map(change => {
				const path = uriPath(change.uri) ?? joinPath(change.repoRoot, change.path);
				const status = change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : change.kind === 'renamed' ? 'R' : 'M';
				return (
					<button key={`${change.turnId}:${path}`} type="button" className={`scm-row git-${status}`} title={change.path}
						onClick={e => openTab({ name: 'diff', path, base: { kind: 'agent', chatId, repo: change.repoRoot, ...(change.oldBlob ? { old: change.oldBlob } : {}), ...(change.newBlob ? { new: change.newBlob } : {}) } }, { preview: e.detail < 2 })}>
						<FileIcon path={path} />
						<span className={`scm-name${status === 'D' ? ' deleted' : ''}`}>{basename(path)}</span>
						<span className="scm-dir">{dirname(change.path)}</span>
						<span className="scm-stats"><span className="add">+{change.additions}</span><span className="del">−{change.deletions}</span></span>
						<span className="scm-letter">{status}</span>
					</button>
				);
			})}
		</div>
	);
}
