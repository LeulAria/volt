/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, diffText, dirname, errorMessage, historyOf, type IAgentChange, type IFileDiff, uriPath } from '@volt/client-core';
import { memo, useEffect, useState } from 'react';
import { useClient, useCollections, useStatus } from '../app/client';
import { chatPath, navigate } from '../app/router';
import { DiffLines } from '../chat/DiffLines';
import { Segmented, Spinner } from '../ui/primitives';
import { Codicon, FileIcon } from './icons';
import { joinPath } from './roots';
import { openTab, useWorkbench } from './workbench';

type Scope = 'session' | 'lastTurn';

/** Every file a chat's agent changed, as one scrollable review (the desktop's changes editor). */
export function ChangesView({ chatId }: { readonly chatId: string }) {
	const client = useClient();
	const live = useStatus().live;
	const refresh = useWorkbench(s => s.refresh);
	const meta = historyOf(useCollections(['history']))[chatId];
	const [scope, setScope] = useState<Scope>('session');
	const [changes, setChanges] = useState<readonly IAgentChange[] | undefined>();
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!live) {
			return;
		}
		let cancelled = false;
		client.getChanges(chatId, scope).then(list => {
			if (!cancelled) {
				setChanges(list);
				setError(undefined);
			}
		}, err => !cancelled && setError(errorMessage(err)));
		return () => {
			cancelled = true;
		};
	}, [client, chatId, scope, refresh, live]);

	const additions = changes?.reduce((sum, c) => sum + c.additions, 0) ?? 0;
	const deletions = changes?.reduce((sum, c) => sum + c.deletions, 0) ?? 0;
	return (
		<div className="changes-view">
			<div className="changes-head">
				<div className="changes-title">
					<Codicon name="git-compare" size={16} />
					<div>
						<div className="changes-name">Changes in “{meta?.title ?? 'this chat'}”</div>
						<div className="changes-sub">
							{changes ? `${changes.length} ${changes.length === 1 ? 'file' : 'files'}` : 'Loading…'}
							{changes?.length ? <> · <span className="add">+{additions}</span> <span className="del">−{deletions}</span></> : null}
						</div>
					</div>
				</div>
				<span className="changes-spacer" />
				<Segmented value={scope} onChange={setScope} options={[{ id: 'session', label: 'Whole chat' }, { id: 'lastTurn', label: 'Last turn' }]} />
				<button type="button" className="btn btn-sm" onClick={() => navigate(chatPath(chatId))}>Open chat</button>
			</div>
			<div className="changes-list">
				{error ? <div className="view-empty"><Codicon name="error" size={20} />{error}</div> : null}
				{changes && !changes.length ? <div className="view-empty"><Codicon name="pass" size={22} /><div>The agent hasn't changed any files {scope === 'lastTurn' ? 'in its last turn' : 'in this chat'}.</div></div> : null}
				{changes?.map(change => <ChangeCard key={`${change.turnId}:${change.path}`} chatId={chatId} change={change} />)}
			</div>
		</div>
	);
}

const ChangeCard = memo(function ChangeCard({ chatId, change }: { readonly chatId: string; readonly change: IAgentChange }) {
	const client = useClient();
	const [open, setOpen] = useState(true);
	const [diff, setDiff] = useState<IFileDiff | { error: string } | undefined>();
	const path = uriPath(change.uri) ?? joinPath(change.repoRoot, change.path);

	useEffect(() => {
		if (!open || diff || change.binary) {
			return;
		}
		let cancelled = false;
		(async () => {
			const before = change.oldBlob ? (await client.gitBlob(change.repoRoot, change.oldBlob)).text : '';
			const after = change.newBlob ? (await client.gitBlob(change.repoRoot, change.newBlob)).text : change.kind === 'deleted' ? '' : await client.readFile(path).then(c => c.kind === 'text' ? c.text : '', () => '');
			if (!cancelled) {
				setDiff(diffText(before, after, 3));
			}
		})().catch(err => !cancelled && setDiff({ error: errorMessage(err) }));
		return () => {
			cancelled = true;
		};
	}, [client, open, diff, change, path]);

	const base = { kind: 'agent' as const, chatId, repo: change.repoRoot, ...(change.oldBlob ? { old: change.oldBlob } : {}), ...(change.newBlob ? { new: change.newBlob } : {}) };
	return (
		<div className={`change-card kind-${change.kind}`}>
			<div className="change-card-head">
				<button type="button" className="change-toggle" onClick={() => setOpen(o => !o)}>
					<Codicon name="chevron-right" className={`twistie${open ? ' open' : ''}`} />
					<FileIcon path={path} />
					<span className="change-file">{basename(change.path)}</span>
					<span className="change-dir">{dirname(change.path)}</span>
					<span className={`change-kind ${change.kind}`}>{change.kind}</span>
					<span className="change-stats"><span className="add">+{change.additions}</span><span className="del">−{change.deletions}</span></span>
				</button>
				<button type="button" className="ide-icon-btn" title="Open Changes in the diff editor" onClick={() => openTab({ name: 'diff', path, base })}><Codicon name="diff" /></button>
				{change.kind !== 'deleted' ? <button type="button" className="ide-icon-btn" title="Open File" onClick={() => openTab({ name: 'file', path })}><Codicon name="go-to-file" /></button> : null}
			</div>
			{open ? (
				<div className="change-card-body">
					{change.binary ? <div className="tree-status">Binary file</div>
						: !diff ? <div className="tree-status"><Spinner size={12} /> Loading…</div>
							: 'error' in diff ? <div className="tree-status error">{diff.error}</div>
								: diff.hunks.length ? <DiffLines hunks={diff.hunks} path={change.path} /> : <div className="tree-status">No text changes.</div>}
				</div>
			) : null}
		</div>
	);
});
