/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ACCESS_MODES, type AccessMode, applyToolDensity, approvalsFor, buildRows, chatStatus, type ComposerMode, compactNumber, COMPOSER_MODES, duration, historyOf, type IPromptAttachment, isStreaming,
	modelLabel, projectOf, questionsFor, relativeTime, runtimeOf, sessionsOf, shortPath, tasksOf, threadsOf, uriPath
} from '@volt/client-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCheckpoints, useClient, useCollections, usePending, useTranscript } from '../app/client';
import { useConversationPrefs } from '../app/prefs';
import { changesPath, chatPath, filePath, navigate } from '../app/router';
import { revealInFile } from '../ide/workbench';
import { ConfirmDialog, type IMenuItem, MenuButton, PromptDialog } from '../ui/overlays';
import { Button, EmptyState, Icon, IconButton, LiveTimer, Spinner, StatusIcon } from '../ui/primitives';
import { Composer } from './Composer';
import { TranscriptRowView } from './Rows';
import { ChatRowContext, type IChatRowContext } from './rowContext';
import { ApprovalCard, LimitTray, PausedTray, QuestionCard, QueueTray } from './Trays';

const CHAT_COLLECTIONS = ['history', 'orch.threads', 'orch.tasks', 'sessions', 'access', 'questions', 'projects', 'runtime'];
const DETAILS_KEY = 'volt.web.details';

function Transcript({ chatId }: { readonly chatId: string }) {
	const transcript = useTranscript(chatId);
	const pending = usePending(chatId);
	const { toolDensity } = useConversationPrefs();
	const rows = useMemo(() => applyToolDensity(buildRows(transcript?.messages ?? [], pending), toolDensity), [transcript?.messages, pending, toolDensity]);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const stuck = useRef(true);
	const [atBottom, setAtBottom] = useState(true);

	useLayoutEffect(() => {
		stuck.current = true;
		setAtBottom(true);
		const el = scroller.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [chatId]);

	useEffect(() => {
		const el = scroller.current;
		const inner = content.current;
		if (!el || !inner) {
			return;
		}
		// Follow the live end while the reader is there; let go when they scroll up.
		const observer = new ResizeObserver(() => {
			if (stuck.current) {
				el.scrollTop = el.scrollHeight;
			}
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, [chatId]);

	const onScroll = () => {
		const el = scroller.current!;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
		stuck.current = near;
		if (near !== atBottom) {
			setAtBottom(near);
		}
	};

	const jump = () => {
		const el = scroller.current!;
		stuck.current = true;
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
	};

	const loading = transcript?.status === 'loading' && !rows.length;
	return (
		<div className="transcript" ref={scroller} onScroll={onScroll}>
			<div className="transcript-inner" ref={content}>
				{loading ? (
					<div className="transcript-loading">
						{[0.9, 0.6, 0.75].map((w, i) => <div key={i} className="skeleton" style={{ width: `${w * 100}%` }} />)}
					</div>
				) : null}
				{transcript?.status === 'error' && !rows.length ? <EmptyState icon="alertCircle" title="Couldn't open this chat" body={transcript.error} /> : null}
				{rows.map(row => (
					<div key={row.key} className={`trow trow-${row.kind}`}>
						<TranscriptRowView row={row} chatId={chatId} />
					</div>
				))}
			</div>
			{!atBottom ? <button type="button" className="jump" onClick={jump} aria-label="Jump to latest"><Icon name="arrowDown" size={15} /></button> : null}
		</div>
	);
}

function readDetailsOpen(): boolean {
	try {
		return window.localStorage.getItem(DETAILS_KEY) === '1';
	} catch {
		return false;
	}
}

export interface IChatViewProps {
	readonly chatId: string;
	/** `panel`: the agent panel beside the editor (its own header, no details pane). */
	readonly variant?: 'page' | 'tab' | 'panel';
	/** Opens a file a reply names (the web IDE's editor). */
	readonly openPath?: (path: string, line?: number) => void;
}

/** Opens files in the IDE's editor (a line puts the cursor there). */
export function openPathInEditor(path: string, line?: number): void {
	if (line) {
		revealInFile(path, line);
	} else {
		navigate(filePath(path));
	}
}

export function ChatView({ chatId, variant = 'page', openPath }: IChatViewProps) {
	const client = useClient();
	const cols = useCollections(CHAT_COLLECTIONS);
	const transcript = useTranscript(chatId);
	const meta = historyOf(cols)[chatId];
	const thread = threadsOf(cols)[chatId];
	const session = sessionsOf(cols)[chatId];
	const runtime = runtimeOf(cols);
	const project = projectOf(cols, chatId);
	const approvals = approvalsFor(cols, chatId);
	const questions = questionsFor(cols, chatId);
	const messages = transcript?.messages ?? [];
	const running = !!thread?.active || isStreaming(messages);
	const status = chatStatus(meta, thread, approvals.length, questions.length);

	const lastMode = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.kind === 'user' && m.mode) {
				return m.mode;
			}
		}
		return meta?.mode;
	}, [messages, meta?.mode]);
	const [mode, setMode] = useState<ComposerMode>('Agent');
	const [modelRef, setModelRef] = useState<string | undefined>(undefined);
	const [modelTouched, setModelTouched] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [editingTurnId, setEditingTurnId] = useState<string | undefined>();
	const [restoredTurnId, setRestoredTurnId] = useState<string | undefined>();
	const [seed, setSeed] = useState<{ key: number; text: string; attachments: readonly IPromptAttachment[] } | undefined>();
	const checkpoints = useCheckpoints(chatId);

	useEffect(() => {
		setModelTouched(false);
		setModelRef(undefined);
		setEditingTurnId(undefined);
		setRestoredTurnId(undefined);
	}, [chatId]);
	useEffect(() => {
		const known = COMPOSER_MODES.find(m => m.id.toLowerCase() === (lastMode ?? '').toLowerCase());
		setMode(known?.id ?? 'Agent');
	}, [chatId, lastMode]);
	const effectiveModel = modelTouched ? modelRef : session?.providerRef ?? thread?.modelRef ?? runtime.activeCatalogRef;

	useEffect(() => {
		client.markRead(chatId);
	}, [client, chatId, meta?.unread]);

	useEffect(() => {
		if (variant === 'panel') {
			return;
		}
		document.title = meta?.title ? `${meta.title} · Volt` : 'Volt';
		return () => {
			document.title = 'Volt';
		};
	}, [meta?.title, variant]);

	const folder = session?.worktreePath ?? session?.workingFolder ?? meta?.workspaceFolder ?? uriPath(project?.root);
	const lastTurnId = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.kind === 'user' && m.id) {
				return m.id;
			}
		}
		return undefined;
	}, [messages]);
	const startEdit = useCallback((turnId: string | undefined) => setEditingTurnId(turnId), []);
	const onRewound = useCallback((text: string, attachments: readonly IPromptAttachment[]) => setSeed(s => ({ key: (s?.key ?? 0) + 1, text, attachments })), []);
	const rowContext = useMemo((): IChatRowContext => ({
		chatId,
		running,
		...(folder ? { root: folder } : {}),
		mode,
		...(effectiveModel ? { modelRef: effectiveModel } : {}),
		...(session?.accessMode ?? runtime.accessMode ? { accessMode: session?.accessMode ?? runtime.accessMode } : {}),
		...(checkpoints ? { checkpoints } : {}),
		...(editingTurnId ? { editingTurnId } : {}),
		...(restoredTurnId ? { restoredTurnId } : {}),
		...(lastTurnId ? { lastTurnId } : {}),
		startEdit,
		onRewound,
		onRestored: setRestoredTurnId,
		...(openPath ? { openPath } : {}),
	}), [chatId, running, folder, mode, effectiveModel, session?.accessMode, runtime.accessMode, checkpoints, editingTurnId, restoredTurnId, lastTurnId, startEdit, onRewound, openPath]);

	const toggleDetails = () => {
		setDetailsOpen(open => {
			try {
				window.localStorage.setItem(DETAILS_KEY, open ? '0' : '1');
			} catch {
				// private mode
			}
			return !open;
		});
	};

	if (!meta && !transcript?.messages.length && transcript?.status !== 'loading' && !hasPending(client, chatId)) {
		return (
			<div className="chat-empty">
				<EmptyState icon="message" title="This chat isn't here" body="It may have been deleted on your computer." action={<Button onClick={() => navigate('/')}>Back to chats</Button>} />
			</div>
		);
	}

	const branch = session?.worktreeBranch ?? meta?.worktreeBranch;
	const menu: IMenuItem[] = [
		{ id: 'pin', label: meta?.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => void client.setPinned(chatId, !meta?.pinned) },
		{ id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(true) },
		{ id: 'unread', label: 'Mark as unread', icon: 'dot', onSelect: () => void client.markUnread(chatId) },
		{ id: 'changes', label: 'Review changes', icon: 'fileDiff', onSelect: () => navigate(changesPath(chatId)) },
		...(variant === 'panel' ? [{ id: 'open', label: 'Open as editor tab', icon: 'external' as const, onSelect: () => navigate(chatPath(chatId)) }] : []),
		{ id: 'sep1', label: '', separator: true },
		{ id: 'settle', label: meta?.settled ? 'Unsettle' : 'Settle', icon: 'inbox', onSelect: () => void client.setSettled(chatId, !meta?.settled) },
		meta?.snoozed
			? { id: 'wake', label: 'Wake', icon: 'sun', onSelect: () => void client.wake(chatId) }
			: { id: 'snooze', label: 'Snooze until tomorrow', icon: 'moon', onSelect: () => void client.snooze(chatId, tomorrowMorning()) },
		{ id: 'archive', label: meta?.archived ? 'Unarchive' : 'Archive', icon: 'archive', onSelect: () => void client.setArchived(chatId, !meta?.archived) },
		{ id: 'sep2', label: '', separator: true },
		{ id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(true) },
	];

	const showDetails = detailsOpen && variant !== 'panel';
	return (
		<ChatRowContext.Provider value={rowContext}>
			<div className={`chat chat-${variant}${showDetails ? ' with-details' : ''}`}>
				<div className="chat-main">
					{variant !== 'panel' ? (
						<header className="chat-header">
							<IconButton className="back-btn" icon="chevronLeft" label="Chats" onClick={() => navigate('/')} />
							<div className="chat-heading">
								<button type="button" className="chat-title" onClick={() => setRenaming(true)} title="Rename">{meta?.title || 'New chat'}</button>
								<div className="chat-sub">
									{project?.displayName || meta?.workspaceLabel ? <span className="sub-item"><Icon name="folder" size={12} />{project?.displayName ?? meta?.workspaceLabel}</span> : null}
									{branch ? <span className="sub-item mono"><Icon name="branch" size={12} />{branch}</span> : null}
									{status.status !== 'idle' ? <span className={`sub-item status-text status-${status.status}`}>{status.label}</span> : meta?.updatedAt ? <span className="sub-item">{relativeTime(meta.updatedAt)}</span> : null}
								</div>
							</div>
							{running && thread?.active ? <span className="header-timer"><Spinner size={11} /><LiveTimer since={thread.active.at} /></span> : null}
							<IconButton icon="fileDiff" label="Review changes" onClick={() => navigate(changesPath(chatId))} />
							<IconButton icon="sidebar" label="Details" active={detailsOpen} onClick={toggleDetails} />
							<MenuButton className="icon-btn" items={menu} placement="bottom-end" width={220} label="Chat actions"><Icon name="more" size={16} /></MenuButton>
						</header>
					) : null}
					<Transcript chatId={chatId} />
					<div className="chat-bottom">
						<div className="trays">
							{approvals.map(request => <ApprovalCard key={request.id} request={request} />)}
							{questions[0] ? <QuestionCard key={questions[0].id} request={questions[0]} /> : null}
							{thread?.limit ? <LimitTray chatId={chatId} thread={thread} /> : null}
							{thread && !thread.active && thread.pause && thread.pause !== 'limit' && thread.queue.length ? <PausedTray chatId={chatId} thread={thread} /> : null}
							{thread ? <QueueTray chatId={chatId} thread={thread} /> : null}
						</div>
						<Composer
							draftKey={chatId}
							running={running}
							mode={mode}
							onModeChange={setMode}
							modelRef={effectiveModel}
							onModelChange={ref => {
								setModelTouched(true);
								setModelRef(ref);
							}}
							accessMode={session?.accessMode ?? runtime.accessMode}
							onAccessChange={(m: AccessMode) => void client.setAccessMode(m, chatId)}
							onSend={(text, delivery, attachments) => {
								client.send({ threadId: chatId, text, mode, ...(effectiveModel ? { modelRef: effectiveModel } : {}), delivery, ...(attachments.length ? { attachments } : {}) });
							}}
							onStop={() => void client.stop(chatId)}
							contextUsed={transcript?.contextUsed}
							contextWindow={transcript?.contextWindow}
							mentionRoot={folder}
							acceptsInserts
							compact={variant === 'panel'}
							{...(seed ? { seed } : {})}
							autoFocus={variant !== 'panel'}
						/>
					</div>
				</div>
				{showDetails ? <ChatDetails chatId={chatId} folder={folder} branch={branch} onClose={toggleDetails} /> : null}
				<PromptDialog open={renaming} title="Rename chat" initial={meta?.title} onClose={() => setRenaming(false)} onSubmit={title => void client.rename(chatId, title)} />
				<ConfirmDialog open={deleting} title="Delete this chat?" body="Its transcript is removed from Volt on your computer. This can't be undone." confirm="Delete" danger onClose={() => setDeleting(false)}
					onConfirm={() => {
						void client.deleteChat(chatId);
						navigate('/');
					}} />
			</div>
		</ChatRowContext.Provider>
	);
}

function hasPending(client: ReturnType<typeof useClient>, chatId: string): boolean {
	return client.getPending(chatId).length > 0;
}

function tomorrowMorning(): number {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(8, 0, 0, 0);
	return d.getTime();
}

function ChatDetails({ chatId, folder, branch, onClose }: { readonly chatId: string; readonly folder?: string; readonly branch?: string; readonly onClose: () => void }) {
	const client = useClient();
	const cols = useCollections(CHAT_COLLECTIONS);
	const transcript = useTranscript(chatId);
	const session = sessionsOf(cols)[chatId];
	const thread = threadsOf(cols)[chatId];
	const runtime = runtimeOf(cols);
	const tasks = Object.values(tasksOf(cols)).filter(task => task?.parentId === chatId).sort((a, b) => (b.createdAt ?? b.startedAt ?? 0) - (a.createdAt ?? a.startedAt ?? 0));
	const access = ACCESS_MODES.find(a => a.id === (session?.accessMode ?? runtime.accessMode)) ?? ACCESS_MODES[3];
	const used = transcript?.contextUsed;
	const windowSize = transcript?.contextWindow;
	return (
		<aside className="details">
			<div className="details-head">
				<span>Details</span>
				<IconButton icon="close" label="Close" size={14} onClick={onClose} />
			</div>
			<div className="details-body">
				<section className="details-section">
					<div className="details-label">Model</div>
					<div className="details-value">{modelLabel(runtime, session?.providerRef ?? thread?.modelRef)}</div>
				</section>
				<section className="details-section">
					<div className="details-label">Access</div>
					<div className="access-options">
						{ACCESS_MODES.map(a => (
							<button key={a.id} type="button" className={`access-option${a.id === access.id ? ' on' : ''}`} onClick={() => void client.setAccessMode(a.id, chatId)}>
								<span className="access-name">{a.label}</span>
								<span className="access-desc">{a.description}</span>
							</button>
						))}
					</div>
				</section>
				{folder ? (
					<section className="details-section">
						<div className="details-label">Folder</div>
						<div className="details-value mono" title={folder}>{shortPath(folder, 60)}</div>
						{branch ? <div className="details-value mono dim"><Icon name="branch" size={12} /> {branch}</div> : null}
					</section>
				) : null}
				{used && windowSize ? (
					<section className="details-section">
						<div className="details-label">Context</div>
						<div className="meter"><span style={{ width: `${Math.min(100, (used / windowSize) * 100)}%` }} /></div>
						<div className="details-value dim">{compactNumber(used)} of {compactNumber(windowSize)} tokens</div>
					</section>
				) : null}
				{tasks.length ? (
					<section className="details-section">
						<div className="details-label">Subagents</div>
						{tasks.slice(0, 20).map(task => {
							const live = task.state === 'running' || task.state === 'queued' || task.state === 'waiting';
							return (
								<div key={task.id} className={`task task-${task.state}`}>
									<div className="task-top">
										<StatusIcon status={task.state === 'running' ? 'working' : task.state === 'waiting' ? 'question' : task.state === 'failed' ? 'failed' : task.state === 'queued' ? 'queued' : 'unread'} size={13} />
										<span className="task-title">{task.title}</span>
										{live ? <IconButton icon="stop" label="Stop subagent" size={12} onClick={() => void client.cancelTask(task.id)} /> : null}
									</div>
									<div className="task-sub">
										{task.activity && live ? task.activity : task.state}
										{task.startedAt && task.endedAt ? ` · ${duration(task.endedAt - task.startedAt)}` : ''}
										{task.modelLabel ? ` · ${task.modelLabel}` : ''}
									</div>
									{task.childId ? <button type="button" className="task-open" onClick={() => navigate(`/t/${encodeURIComponent(task.childId!)}`)}>Open chat</button> : null}
								</div>
							);
						})}
					</section>
				) : null}
			</div>
		</aside>
	);
}
