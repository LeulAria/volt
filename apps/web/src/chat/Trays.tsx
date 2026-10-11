/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clockTime, firstLine, type IAccessRequest, type IOrchThread, type IQuestionRequest } from '@volt/client-core';
import { useState } from 'react';
import { useClient } from '../app/client';
import { Button, Icon, IconButton } from '../ui/primitives';

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

export function ApprovalCard({ request }: { readonly request: IAccessRequest }) {
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
			<div className="tray-eyebrow"><Icon name="shieldAlert" size={13} />Approval needed{request.risk && request.risk !== 'safe' ? <span className={`risk risk-${request.risk}`}>{request.risk} risk</span> : null}</div>
			<div className="tray-title">{approvalTitle(request)}</div>
			{detail ? <pre className="tray-detail">{detail}</pre> : null}
			{request.reason ? <div className="tray-reason">{request.reason}</div> : null}
			<div className="tray-actions">
				<Button variant="primary" size="sm" busy={busy === 'once'} onClick={() => void answer('once', 'allow', 'once')}>Allow once</Button>
				<Button size="sm" busy={busy === 'always'} onClick={() => void answer('always', 'allow', 'always')}>Always allow</Button>
				<span className="tray-spacer" />
				<Button variant="danger" size="sm" busy={busy === 'deny'} onClick={() => void answer('deny', 'deny', 'once')}>Deny</Button>
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
	if (!thread.queue.length) {
		return null;
	}
	return (
		<div className={`queue${open ? ' open' : ''}`}>
			<button type="button" className="queue-head" onClick={() => setOpen(o => !o)}>
				<Icon name="queue" size={13} />
				<span>{thread.queue.length} queued</span>
				<span className="queue-preview">{firstLine(thread.queue[0].prompt.text, 80)}</span>
				<Icon name="chevronUp" size={12} className="queue-chevron" />
			</button>
			{open ? (
				<div className="queue-list">
					{thread.queue.map((item, i) => (
						<div key={item.id} className="queue-item">
							<span className="queue-index">{i + 1}</span>
							<span className="queue-text">{firstLine(item.prompt.text, 200)}</span>
							<IconButton icon="arrowUp" label="Send now" size={14} onClick={() => void client.sendQueuedNow(chatId, item.id)} />
							<IconButton icon="close" label="Remove" size={14} onClick={() => void client.removeQueued(chatId, item.id)} />
						</div>
					))}
					{thread.queue.length > 1 ? <button type="button" className="queue-clear" onClick={() => void client.clearQueue(chatId)}>Clear queue</button> : null}
				</div>
			) : null}
		</div>
	);
}
