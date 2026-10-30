/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clockTime, firstLine, type IAccessRequest, type IOrchQueueItem, type IOrchThread, type IQuestionRequest, questionApproval, queuedText } from '@volt/client-core';
import { useEffect, useRef, useState } from 'react';
import { useClient } from '../app/client';
import { Button, Icon, IconButton } from '../ui/primitives';
import { Markdown } from './Markdown';

const ACTION_TITLES: Record<string, string> = {
	shell: 'Run a command',
	edit: 'Edit a file',
	read: 'Read a file',
	search: 'Search the project',
	web: 'Open a web page',
	network: 'Use the network',
	mcp: 'Use a tool',
	browser: 'Control the browser',
	subagent: 'Start a subagent',
	git: 'Run git',
	question: 'Ask you',
};

export function approvalTitle(request: IAccessRequest): string {
	return request.preview?.title ?? ACTION_TITLES[request.action] ?? `Use ${request.action}`;
}

export function ApprovalCard({ request, onBuildPlan }: { readonly request: IAccessRequest; readonly onBuildPlan?: () => void }) {
	const question = questionApproval(request);
	return question ? <PlanCard request={request} question={question} onBuildPlan={onBuildPlan} /> : <PermissionCard request={request} />;
}

/** A plan waiting for Build (the chat goes on in Agent mode) or Keep planning; or a yes/no question (agentBlockRenderers.ts). */
function PlanCard({ request, question, onBuildPlan }: { readonly request: IAccessRequest; readonly question: NonNullable<ReturnType<typeof questionApproval>>; readonly onBuildPlan?: () => void }) {
	const client = useClient();
	const [busy, setBusy] = useState(false);
	const decide = async (effect: 'allow' | 'deny') => {
		setBusy(true);
		await client.respondToApproval(request.id, effect, 'once');
		if (effect === 'allow' && question.plan) {
			onBuildPlan?.();
		}
		setBusy(false);
	};
	return (
		<div className="tray tray-approval tray-plan">
			<div className="approval-line"><Icon name={question.plan ? 'book' : 'help'} size={14} /><span className="approval-action">{question.title}</span></div>
			{question.markdown ? <div className="tray-plan-body"><Markdown text={question.markdown} /></div> : null}
			<div className="tray-actions approval-footer">
				<button type="button" className="approval-btn secondary" disabled={busy} onClick={() => void decide('deny')}>{question.plan ? 'Keep planning' : 'Decline'}</button>
				<button type="button" className="approval-btn primary" disabled={busy} onClick={() => void decide('allow')}>{question.plan ? 'Build' : 'Approve'}</button>
			</div>
		</div>
	);
}

function PermissionCard({ request }: { readonly request: IAccessRequest }) {
	const client = useClient();
	const [busy, setBusy] = useState<string | undefined>();
	const answer = async (id: string, effect: 'allow' | 'deny', scope: 'once' | 'always') => {
		setBusy(id);
		await client.respondToApproval(request.id, effect, scope);
		setBusy(undefined);
	};
	const detail = request.preview?.detail ?? request.resource?.value;
	const risky = request.risk === 'high' || request.risk === 'critical';
	return (
		<div className={`tray tray-approval${risky ? ' risky' : ''}`}>
			<div className="approval-line"><Icon name="shieldAlert" size={14} /><span className="approval-action">{approvalTitle(request)}</span>{request.risk && request.risk !== 'safe' ? <span className={`approval-detail risk-${request.risk}`}>{request.risk} risk</span> : null}</div>
			{detail ? <pre className="tray-detail">{detail}</pre> : null}
			{request.reason ? <div className="tray-reason">{request.reason}</div> : null}
			<div className="tray-actions approval-footer">
				<button type="button" className="approval-btn text" disabled={!!busy} onClick={() => void answer('deny', 'deny', 'once')}>Deny</button>
				<button type="button" className="approval-btn secondary" disabled={!!busy} onClick={() => void answer('always', 'allow', 'always')}>Always allow</button>
				<button type="button" className="approval-btn primary" disabled={!!busy} onClick={() => void answer('once', 'allow', 'once')}>Allow</button>
			</div>
		</div>
	);
}

export function QuestionCard({ request }: { readonly request: IQuestionRequest }) {
	const client = useClient();
	const [index, setIndex] = useState(0);
	const [picked, setPicked] = useState<Record<string, readonly string[]>>({});
	const [other, setOther] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const question = request.questions[index];
	if (!question) {
		return null;
	}
	const chosen = picked[question.id] ?? [];
	const last = index === request.questions.length - 1;
	const answered = chosen.length > 0 || !!other[question.id]?.trim();
	const toggle = (optionId: string) => {
		setPicked(p => {
			const current = p[question.id] ?? [];
			const next = question.multiple ? (current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId]) : [optionId];
			return { ...p, [question.id]: next };
		});
	};
	const submit = async () => {
		setBusy(true);
		await client.answerQuestions(request.id, {
			outcome: 'answered',
			answers: request.questions.map(q => ({ questionId: q.id, optionIds: picked[q.id] ?? [], ...(other[q.id]?.trim() ? { other: other[q.id].trim() } : {}) })),
		});
		setBusy(false);
	};
	return (
		<div className="tray tray-question">
			<div className="tray-eyebrow">
				<Icon name="help" size={13} />{request.title ?? 'Question'}
				{request.questions.length > 1 ? <span className="tray-count">{index + 1} of {request.questions.length}</span> : null}
				<span className="tray-spacer" />
				<IconButton icon="close" label="Dismiss" size={14} onClick={() => void client.dismissQuestions(request.id)} />
			</div>
			<div className="tray-title">{question.prompt}</div>
			<div className="options">
				{question.options.map(option => {
					const on = chosen.includes(option.id);
					return (
						<button key={option.id} type="button" className={`option${on ? ' on' : ''}`} onClick={() => toggle(option.id)} aria-pressed={on}>
							<span className={`option-mark${question.multiple ? ' square' : ''}`}>{on ? <Icon name="check" size={11} strokeWidth={2.4} /> : null}</span>
							<span className="option-text">
								<span className="option-label">{option.label}</span>
								{option.description ? <span className="option-desc">{option.description}</span> : null}
							</span>
						</button>
					);
				})}
				{question.allowOther ? (
					<input className="input option-other" placeholder="Something else…" value={other[question.id] ?? ''} onChange={e => setOther(o => ({ ...o, [question.id]: e.target.value }))}
						onKeyDown={e => e.key === 'Enter' && answered && (last ? void submit() : setIndex(i => i + 1))} />
				) : null}
			</div>
			<div className="tray-actions">
				{index > 0 ? <Button variant="ghost" size="sm" onClick={() => setIndex(i => i - 1)}>Back</Button> : null}
				<Button variant="ghost" size="sm" onClick={() => void client.answerQuestions(request.id, { outcome: 'skipped', answers: [] })}>Skip</Button>
				<span className="tray-spacer" />
				{last
					? <Button variant="primary" size="sm" busy={busy} disabled={!answered} onClick={() => void submit()}>Submit</Button>
					: <Button variant="primary" size="sm" disabled={!answered} onClick={() => setIndex(i => i + 1)} trailingIcon="arrowRight">Next</Button>}
			</div>
		</div>
	);
}

export function LimitTray({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const client = useClient();
	const limit = thread.limit!;
	return (
		<div className="tray tray-banner tray-limit">
			<Icon name="clock" size={15} />
			<div className="banner-text">
				<div className="banner-title">Paused at a usage limit</div>
				<div className="banner-sub">{limit.message ?? 'The provider stopped this turn.'}{limit.resetAt ? ` Resumes around ${clockTime(limit.resetAt)}.` : ''}</div>
			</div>
			<Button size="sm" onClick={() => void client.resumeLimit(chatId)}>Resume now</Button>
		</div>
	);
}

export function PausedTray({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const client = useClient();
	const reason = thread.pause === 'failed' ? 'The last turn failed' : thread.pause === 'stopped' ? 'You stopped the last turn' : thread.pause === 'interrupted' ? 'Volt restarted during the last turn' : 'Waiting for you';
	return (
		<div className="tray tray-banner">
			<Icon name="pause" size={15} />
			<div className="banner-text">
				<div className="banner-title">{thread.queue.length} queued {thread.queue.length === 1 ? 'prompt is' : 'prompts are'} waiting</div>
				<div className="banner-sub">{reason}.</div>
			</div>
			<Button size="sm" icon="play" onClick={() => void client.resumeQueue(chatId)}>Resume</Button>
		</div>
	);
}

export function QueueTray({ chatId, thread }: { readonly chatId: string; readonly thread: IOrchThread }) {
	const client = useClient();
	const [open, setOpen] = useState(false);
	// The item being edited, as it was when editing began; the queue holds it meanwhile.
	const [editing, setEditing] = useState<IOrchQueueItem | undefined>();
	const [editText, setEditText] = useState('');
	const editingRef = useRef(editing);
	editingRef.current = editing;
	// Leaving the chat mid-edit lets the queue go on.
	useEffect(() => () => {
		const item = editingRef.current;
		if (item) {
			void client.holdQueued(chatId, item.id, false);
		}
	}, [chatId, client]);
	if (!thread.queue.length && !editing) {
		return null;
	}
	const startEdit = (item: IOrchQueueItem) => {
		if (editing && editing.id !== item.id) {
			void client.holdQueued(chatId, editing.id, false);
		}
		setEditing(item);
		setEditText(queuedText(item));
		setOpen(true);
		void client.holdQueued(chatId, item.id, true);
	};
	const cancelEdit = () => {
		if (editing) {
			void client.holdQueued(chatId, editing.id, false);
		}
		setEditing(undefined);
	};
	const saveEdit = () => {
		const text = editText.trim();
		if (!editing) {
			return;
		}
		if (!text) {
			cancelEdit();
			return;
		}
		void client.saveQueuedEdit(chatId, editing, text);
		setEditing(undefined);
	};
	const count = thread.queue.length;
	// Sent or removed elsewhere mid-edit: still editable here; saving queues it again.
	const rows = editing && !thread.queue.some(item => item.id === editing.id) ? [...thread.queue, editing] : thread.queue;
	return (
		<div className={`queue${open ? ' open' : ''}`}>
			<button type="button" className="queue-head" onClick={() => setOpen(o => !o)}>
				<Icon name="queue" size={13} />
				<span>{count} queued</span>
				<span className="queue-preview">{count ? firstLine(queuedText(thread.queue[0]), 80) : ''}</span>
				<Icon name="chevronUp" size={12} className="queue-chevron" />
			</button>
			{open ? (
				<div className="queue-list">
					{rows.map((item, i) => editing?.id === item.id ? (
						<div key={item.id} className="queue-edit">
							<div className="queue-edit-label"><Icon name="pencil" size={11} />Editing queued message {i + 1} · held until you save</div>
							<textarea
								className="queue-edit-input"
								value={editText}
								autoFocus
								rows={Math.min(6, Math.max(2, editText.split('\n').length))}
								onChange={e => setEditText(e.target.value)}
								onKeyDown={e => {
									if (e.key === 'Escape') {
										e.preventDefault();
										cancelEdit();
									} else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
										e.preventDefault();
										saveEdit();
									}
								}}
							/>
							<div className="queue-edit-actions">
								<span className="queue-edit-hint">Enter to save · Esc to cancel</span>
								<Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
								<Button variant="primary" size="sm" disabled={!editText.trim()} onClick={saveEdit}>Save</Button>
							</div>
						</div>
					) : (
						<div key={item.id} className={`queue-item${item.held ? ' held' : ''}`}>
							<span className="queue-index">{i + 1}</span>
							<button type="button" className="queue-text" title="Edit" onClick={() => startEdit(item)}>
								{firstLine(queuedText(item), 200)}
								{item.held ? <span className="queue-held">Being edited</span> : null}
							</button>
							<IconButton icon="pencil" label="Edit" size={13} onClick={() => startEdit(item)} />
							<IconButton icon="chevronUp" label="Move up" size={14} disabled={i === 0} onClick={() => void client.moveQueued(chatId, thread.queue, item.id, -1)} />
							<IconButton icon="chevronDown" label="Move down" size={14} disabled={i >= count - 1} onClick={() => void client.moveQueued(chatId, thread.queue, item.id, 1)} />
							<IconButton icon="arrowUp" label="Send now" size={14} onClick={() => void client.sendQueuedNow(chatId, item.id)} />
							<IconButton icon="close" label="Remove" size={14} onClick={() => void client.removeQueued(chatId, item.id)} />
						</div>
					))}
					{count > 1 && !editing ? <button type="button" className="queue-clear" onClick={() => void client.clearQueue(chatId)}>Clear queue</button> : null}
				</div>
			) : null}
		</div>
	);
}
