/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	attachmentsOf, basename, compactNumber, dirname, duration, errorMessage, type IPromptAttachment, type IRestorePreview, type IRowImage, type IStepItem, money, pendingLabel,
	type TranscriptRow, uuid
} from '@volt/client-core';
import { Fragment, memo, type ReactNode, useState } from 'react';
import { useAttachment, useClient } from '../app/client';
import { useConversationPrefs } from '../app/prefs';
import { Dialog } from '../ui/overlays';
import { Button, Icon, LiveTimer, Shimmer, Spinner } from '../ui/primitives';
import { openTab } from '../ide/workbench';
import { Composer } from './Composer';
import { DiffLines } from './DiffLines';
import { openLightbox } from './Lightbox';
import { CodeBlock, Inline, Markdown } from './Markdown';
import { useChatRow } from './rowContext';

type RowOf<K extends TranscriptRow['kind']> = Extract<TranscriptRow, { kind: K }>;

function Disclosure({ open, onToggle, children, className }: { readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode; readonly className?: string }) {
	return (
		<button type="button" className={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-expanded={open} onClick={onToggle}>
			{children}
			<Icon name="chevronRight" size={12} className="disclosure-chevron" />
		</button>
	);
}

function copyText(text: string) {
	void navigator.clipboard?.writeText(text);
}

function RowImage({ image, onlyOne }: { readonly image: IRowImage; readonly onlyOne: boolean }) {
	const url = useAttachment(image.ref);
	return (
		<button type="button" className={`user-image${onlyOne ? ' single' : ''}`} title={image.name} onClick={() => url && openLightbox(url, image.name)}>
			{url ? <img src={url} alt={image.name} loading="lazy" /> : <span className="user-image-loading"><Spinner size={13} /></span>}
		</button>
	);
}

function UserImages({ images }: { readonly images: readonly IRowImage[] }) {
	return (
		<div className={`user-images count-${Math.min(images.length, 4)}`}>
			{images.map(image => <RowImage key={image.ref} image={image} onlyOne={images.length === 1} />)}
		</div>
	);
}

type UserDialog = { readonly kind: 'rewind' } | { readonly kind: 'restore'; readonly preview?: IRestorePreview; readonly loading: boolean } | undefined;

function UserRow({ row, chatId }: { readonly row: RowOf<'user'>; readonly chatId: string }) {
	const client = useClient();
	const ctx = useChatRow();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const [dialog, setDialog] = useState<UserDialog>();
	const [busy, setBusy] = useState(false);
	const [revert, setRevert] = useState(false);
	const [editMode, setEditMode] = useState(ctx?.mode ?? 'Agent');
	const long = row.text.length > 600 || row.text.split('\n').length > 12;
	const turnId = row.turnId;
	const actionable = !!ctx && !!turnId && !row.pending && !row.from && !row.steer;
	const checkpoint = actionable && !!ctx?.checkpoints?.checkpoints.some(c => c.turnId === turnId);
	const editing = actionable && ctx?.editingTurnId === turnId;

	const attachments = (): IPromptAttachment[] => (row.images ?? []).map(image => ({ id: uuid(), name: image.name, mime: image.mime, ref: image.ref }));

	const rewind = async (revertFiles: boolean) => {
		if (!turnId || !ctx) {
			return;
		}
		setBusy(true);
		const message = await client.rewindTo(chatId, turnId, revertFiles);
		setBusy(false);
		setDialog(undefined);
		if (message) {
			ctx.onRewound(message.text, attachmentsOf(message));
		}
	};

	const openRestore = async () => {
		if (!turnId) {
			return;
		}
		setDialog({ kind: 'restore', loading: true });
		const preview = await client.previewRestore(chatId, turnId);
		setDialog(current => current?.kind === 'restore' ? { kind: 'restore', loading: false, ...(preview ? { preview } : {}) } : current);
	};

	const restore = async () => {
		if (!turnId || !ctx || dialog?.kind !== 'restore') {
			return;
		}
		setBusy(true);
		const result = await client.restoreCheckpoint(chatId, turnId, !!dialog.preview?.conflicts.length);
		setBusy(false);
		setDialog(undefined);
		if (result?.applied) {
			ctx.onRestored(turnId);
			ctx.startEdit(turnId);
		}
	};

	if (editing && ctx && turnId) {
		return (
			<div className="row-user editing">
				<Composer
					edit={{ text: row.text, attachments: attachments(), onCancel: () => ctx.startEdit(undefined), label: revert ? 'Revert files and send' : 'Send' }}
					mode={editMode}
					onModeChange={setEditMode}
					modelRef={ctx.modelRef}
					onModelChange={() => undefined}
					accessMode={ctx.accessMode}
					onAccessChange={mode => void client.setAccessMode(mode, chatId)}
					mentionRoot={ctx.root}
					leading={checkpoint ? (
						<button type="button" className={`pill pill-quiet revert-toggle${revert ? ' on' : ''}`} aria-pressed={revert} title="Also put the files back as they were before this message" onClick={() => setRevert(r => !r)}>
							<Icon name="undo" size={13} /><span className="pill-text">Revert files</span>
						</button>
					) : undefined}
					onSend={async (text, _delivery, images) => {
						const ok = await client.editMessage(chatId, turnId, { text, attachments: images, mode: editMode, ...(ctx.modelRef ? { modelRef: ctx.modelRef } : {}), revertFiles: revert });
						if (ok) {
							ctx.startEdit(undefined);
						}
						return ok;
					}}
				/>
				<div className="edit-hint">Sending replaces this message and everything after it.{ctx.running ? ' The running reply stops.' : ''}</div>
			</div>
		);
	}

	return (
		<div className={`row-user${row.pending ? ` pending pending-${row.pending}` : ''}${actionable ? ' actionable' : ''}`}>
			{row.from ? <div className="user-from"><Icon name="message" size={12} />From {row.from}</div> : null}
			<div className={`user-bubble${long && !expanded ? ' clamped' : ''}`} onDoubleClick={() => actionable && !window.getSelection()?.toString() && ctx?.startEdit(turnId)}>
				{row.mode ? <span className={`user-mode mode-${row.mode.toLowerCase()}`}>{row.mode}</span> : null}
				{row.images?.length ? <UserImages images={row.images} /> : null}
				<div className="user-text">{row.text}</div>
				{row.chips.length ? <div className="user-chips">{row.chips.map(chip => <span key={chip} className="chip"><Icon name="file" size={11} />{chip}</span>)}</div> : null}
				{long ? <button type="button" className="user-more" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
				{actionable ? (
					<div className="user-actions" role="toolbar" aria-label="Message actions">
						<button type="button" className="user-action" title="Edit and resend" onClick={() => ctx?.startEdit(turnId)}><Icon name="pencil" size={13} /></button>
						<button type="button" className="user-action" title={copied ? 'Copied' : 'Copy'} onClick={() => {
							copyText(row.text);
							setCopied(true);
							setTimeout(() => setCopied(false), 1400);
						}}><Icon name={copied ? 'check' : 'copy'} size={13} /></button>
						<button type="button" className="user-action" title="Rewind the chat to before this message" onClick={() => setDialog({ kind: 'rewind' })}><Icon name="history" size={13} /></button>
						{checkpoint ? <button type="button" className="user-action" title="Restore checkpoint: put the files back as they were before this message" onClick={() => void openRestore()}><Icon name="undo" size={13} /></button> : null}
					</div>
				) : null}
			</div>
			{actionable && ctx?.restoredTurnId === turnId && ctx.checkpoints?.canRedo ? (
				<button type="button" className="redo-checkpoint" onClick={() => void client.redoCheckpoint(chatId).then(result => result?.applied && ctx.onRestored(undefined))}>
					<Icon name="refresh" size={12} />Redo checkpoint
				</button>
			) : null}
			{row.pending ? (
				<div className="user-pending">
					{row.pending === 'sending' ? <Spinner size={11} /> : <Icon name={row.pending === 'failed' ? 'alertCircle' : 'clock'} size={12} />}
					<span>{pendingLabel(row.pending)}</span>
					{row.pending === 'failed' && row.turnId ? <>
						<button type="button" onClick={() => client.retrySend(chatId, row.turnId!)}>Retry</button>
						<button type="button" onClick={() => client.dismissPending(chatId, row.turnId!)}>Dismiss</button>
					</> : null}
				</div>
			) : null}
			<Dialog open={dialog?.kind === 'rewind'} onClose={() => setDialog(undefined)} title="Rewind the chat to before this message?" width={460} footer={<>
				<Button variant="ghost" onClick={() => setDialog(undefined)}>Cancel</Button>
				{checkpoint ? <Button busy={busy} onClick={() => void rewind(true)}>Rewind and revert files</Button> : null}
				<Button variant="primary" busy={busy} onClick={() => void rewind(false)}>Rewind</Button>
			</>}>
				<div className="dialog-text">This message and everything after it leave the chat and the agent's context, and the message goes back to the composer. Files stay as they are{checkpoint ? ' unless you revert them too' : ''}.</div>
			</Dialog>
			<Dialog open={dialog?.kind === 'restore'} onClose={() => setDialog(undefined)} title="Discard all changes up to this checkpoint?" width={480} footer={<>
				<Button variant="ghost" onClick={() => setDialog(undefined)}>Cancel</Button>
				<Button variant="primary" busy={busy} disabled={dialog?.kind === 'restore' && dialog.loading} onClick={() => void restore()}>{dialog?.kind === 'restore' && dialog.preview?.conflicts.length ? 'Restore anyway' : 'Restore'}</Button>
			</>}>
				{dialog?.kind === 'restore' ? <RestoreBody dialog={dialog} /> : null}
			</Dialog>
		</div>
	);
}

function RestoreBody({ dialog }: { readonly dialog: Extract<UserDialog, { kind: 'restore' }> }) {
	if (dialog.loading) {
		return <div className="dialog-text"><Spinner size={12} /> Checking the files…</div>;
	}
	const preview = dialog.preview;
	const changed = preview?.files.filter(f => f.action !== 'none') ?? [];
	return (
		<div className="dialog-text">
			<p>Files go back to how they were before this message ran, and the message opens for editing. You can redo this until you send again.</p>
			{changed.length ? (
				<ul className="restore-files">
					{changed.slice(0, 8).map(file => <li key={file.path} className={file.editedSince ? 'conflict' : undefined}><Icon name={file.editedSince ? 'alert' : 'file'} size={12} />{file.path}</li>)}
					{changed.length > 8 ? <li className="dim">and {changed.length - 8} more</li> : null}
				</ul>
			) : <p className="dim">No files need to change.</p>}
			{preview?.conflicts.length ? <p className="restore-warning"><Icon name="alert" size={13} />{preview.conflicts.length} {preview.conflicts.length === 1 ? 'file was' : 'files were'} edited after the agent changed {preview.conflicts.length === 1 ? 'it' : 'them'}; restoring discards those edits.</p> : null}
		</div>
	);
}

function ThoughtRow({ row }: { readonly row: RowOf<'thought'> }) {
	const [open, setOpen] = useState(false);
	const label = row.streaming ? 'Thinking' : row.durationMs && row.durationMs > 1000 ? `Thought for ${duration(row.durationMs)}` : 'Thought';
	return (
		<div className="row-thought">
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name="thought" size={14} />
				<Shimmer active={row.streaming}>{label}</Shimmer>
			</Disclosure>
			{open ? <div className="thought-body"><Markdown text={row.text} /></div> : null}
		</div>
	);
}

function StepBodyView({ step }: { readonly step: IStepItem }) {
	const body = step.body;
	if (!body) {
		return null;
	}
	if (body.kind === 'command') {
		return (
			<div className="step-body term">
				<div className="term-cmd"><span className="term-prompt">$</span>{body.command}</div>
				{body.output ? <pre className="term-out">{body.output.length > 12000 ? `${body.output.slice(0, 12000)}\n…` : body.output}</pre> : null}
				{body.exitCode !== undefined && body.exitCode !== 0 ? <div className="term-exit">exit {body.exitCode}</div> : null}
			</div>
		);
	}
	if (body.kind === 'diff') {
		return <div className="step-body flush"><DiffLines diff={body.diff} {...(body.path ? { path: body.path } : {})} /></div>;
	}
	return <pre className={`step-body${body.mono ? ' mono' : ''}`}>{body.text.length > 8000 ? `${body.text.slice(0, 8000)}\n…` : body.text}</pre>;
}

function StepStats({ step }: { readonly step: IStepItem }) {
	if (!step.additions && !step.deletions) {
		return null;
	}
	return (
		<span className="file-stats">
			{step.additions ? <span className="add">+{step.additions}</span> : null}
			{step.deletions ? <span className="del">{'−'}{step.deletions}</span> : null}
		</span>
	);
}

function StepLine({ step, card }: { readonly step: IStepItem; readonly card?: boolean }) {
	const [open, setOpen] = useState(!!card);
	const expandable = !!step.body;
	return (
		<div className={`step step-${step.status}${card && expandable ? ' step-card' : ''}`}>
			<button type="button" className="step-line" disabled={!expandable} onClick={() => setOpen(o => !o)} aria-expanded={expandable ? open : undefined}>
				<span className="step-icon">{step.status === 'running' ? <Spinner size={11} /> : <Icon name={step.status === 'error' ? 'xCircle' : step.icon} size={13} />}</span>
				<Shimmer active={step.status === 'running'}><span className="step-label">{step.label}</span></Shimmer>
				{step.detail ? <span className="step-detail">{step.detail}</span> : null}
				<StepStats step={step} />
				{expandable ? <Icon name="chevronRight" size={11} className={`step-chevron${open ? ' open' : ''}`} /> : null}
			</button>
			{open ? <StepBodyView step={step} /> : null}
		</div>
	);
}

function StepsRow({ row }: { readonly row: RowOf<'steps'> }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	if (row.display === 'lines' || row.display === 'cards') {
		// Standard: a line per call. Detailed: calls with output or a diff open as cards.
		return (
			<div className={`row-steps steps-${row.display}`}>
				<div className="steps-list">
					{row.items.map(step => <StepLine key={step.key} step={step} card={row.display === 'cards'} />)}
				</div>
			</div>
		);
	}
	// A live group shows its latest steps; a finished one folds behind its summary.
	const expanded = open ?? row.live;
	const shown = expanded ? (row.live && open === undefined ? row.items.slice(-4) : row.items) : [];
	return (
		<div className="row-steps">
			<Disclosure open={expanded} onToggle={() => setOpen(!expanded)}>
				<Shimmer active={row.live}>{row.live ? (row.items[row.items.length - 1]?.label ?? 'Working') : row.summary}</Shimmer>
				{row.live && row.items.length > 1 ? <span className="steps-count">{row.summary}</span> : null}
			</Disclosure>
			{expanded ? (
				<div className="steps-list">
					{row.live && open === undefined && row.items.length > 4 ? <div className="steps-more">{row.items.length - 4} earlier</div> : null}
					{shown.map(step => <StepLine key={step.key} step={step} />)}
				</div>
			) : null}
		</div>
	);
}

export function DiffView({ diff, path }: { readonly diff: string; readonly path?: string }) {
	return <DiffLines diff={diff} {...(path ? { path } : {})} />;
}

function FileRow({ row }: { readonly row: RowOf<'file'> }) {
	const ctx = useChatRow();
	const client = useClient();
	const { toolDensity } = useConversationPrefs();
	// Detailed density opens each edit on its diff.
	const [open, setOpen] = useState(toolDensity === 'detailed');
	const dir = dirname(row.path);
	const absolute = row.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(row.path) ? row.path : ctx?.root ? `${ctx.root}/${row.path}` : undefined;
	const openDiff = async () => {
		if (!ctx || !absolute) {
			return;
		}
		try {
			const changes = await client.getChanges(ctx.chatId, 'session');
			const hit = changes.find(c => c.path === row.path || absolute.endsWith(`/${c.path}`));
			openTab(hit
				? { name: 'diff', path: absolute, base: { kind: 'agent', chatId: ctx.chatId, repo: hit.repoRoot, ...(hit.oldBlob ? { old: hit.oldBlob } : {}), ...(hit.newBlob ? { new: hit.newBlob } : {}) } }
				: { name: 'diff', path: absolute, base: { kind: 'head' } });
		} catch (err) {
			client.toast('error', errorMessage(err));
		}
	};
	return (
		<div className={`row-file file-${row.status}${open ? ' open' : ''}`}>
			<div className="file-head">
				<button type="button" className="file-toggle" onClick={() => row.diff && setOpen(o => !o)} disabled={!row.diff}>
					<span className="file-icon">{row.status === 'running' ? <Spinner size={11} /> : <Icon name={row.verb === 'Created' ? 'plus' : row.verb === 'Deleted' ? 'trash' : 'pencil'} size={13} />}</span>
					<span className="file-verb">{row.verb}</span>
					<span className="file-name">{basename(row.path)}</span>
					{dir ? <span className="file-dir">{dir}</span> : null}
					<span className="file-stats">
						{row.additions ? <span className="add">+{row.additions}</span> : null}
						{row.deletions ? <span className="del">{'−'}{row.deletions}</span> : null}
					</span>
					{row.diff ? <Icon name="chevronDown" size={12} className={`file-chevron${open ? ' open' : ''}`} /> : null}
				</button>
				{absolute && ctx?.openPath && row.verb !== 'Deleted' ? (
					<span className="file-actions">
						<button type="button" className="file-action" title="Open the diff in the editor" onClick={() => void openDiff()}><Icon name="fileDiff" size={13} /></button>
						<button type="button" className="file-action" title="Open the file" onClick={() => ctx.openPath?.(absolute)}><Icon name="external" size={13} /></button>
					</span>
				) : null}
			</div>
			{open && row.diff ? <DiffLines diff={row.diff} path={row.path} /> : null}
		</div>
	);
}

function PlanRow({ row }: { readonly row: RowOf<'plan'> }) {
	return (
		<div className="card row-plan">
			<div className="card-head"><Icon name="book" size={14} /><span>{row.title}</span>{row.streaming ? <Spinner size={11} /> : null}</div>
			<Markdown text={row.markdown} docKey={row.docKey} streaming={row.streaming} />
			{row.openQuestions?.length ? (
				<div className="plan-questions">
					<div className="plan-questions-title">Open questions</div>
					<ul>{row.openQuestions.map(q => <li key={q}><Inline text={q} /></li>)}</ul>
				</div>
			) : null}
		</div>
	);
}

function TodosRow({ row }: { readonly row: RowOf<'todos'> }) {
	const done = row.steps.filter(s => s.state === 'done').length;
	const [open, setOpen] = useState(row.live);
	return (
		<div className="row-todos">
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name="listChecks" size={14} />
				<span>To-dos</span>
				<span className="todos-progress"><span style={{ width: `${(done / Math.max(1, row.steps.length)) * 100}%` }} /></span>
				<span className="steps-count">{done}/{row.steps.length}</span>
			</Disclosure>
			{open ? (
				<ul className="todos">
					{row.steps.map((step, i) => (
						<li key={`${i}:${step.label}`} className={`todo todo-${step.state}`}>
							<span className="todo-mark">{step.state === 'done' ? <Icon name="check" size={11} strokeWidth={2.4} /> : step.state === 'current' ? <span className="todo-pulse" /> : null}</span>
							<span>{step.label}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function ChartRow({ row }: { readonly row: RowOf<'chart'> }) {
	const max = Math.max(1, ...row.values.map(v => Math.abs(v)));
	return (
		<div className="card row-chart">
			{row.title ? <div className="card-head"><Icon name="layers" size={14} /><span>{row.title}</span></div> : null}
			{row.labels.map((label, i) => (
				<div key={i} className="bar">
					<span className="bar-label">{label}</span>
					<span className="bar-track"><span className="bar-fill" style={{ width: `${(Math.abs(row.values[i] ?? 0) / max) * 100}%` }} /></span>
					<span className="bar-value">{compactNumber(row.values[i])}{row.unit ?? ''}</span>
				</div>
			))}
		</div>
	);
}

function FooterRow({ row }: { readonly row: RowOf<'footer'> }) {
	const client = useClient();
	const ctx = useChatRow();
	const [copied, setCopied] = useState(false);
	const retry = () => {
		if (!ctx || !row.turnId) {
			return;
		}
		if (row.turnId !== ctx.lastTurnId && !window.confirm('Retrying this reply removes everything after it. Retry?')) {
			return;
		}
		void client.retryTurn(ctx.chatId, row.turnId);
	};
	const parts = [row.outcome === 'stopped' ? 'Stopped' : row.outcome === 'failed' ? 'Failed' : undefined, duration(row.durationMs), row.model, row.tokens ? `${compactNumber(row.tokens)} tokens` : undefined, money(row.costUsd)].filter(Boolean);
	return (
		<div className="row-footer">
			{row.copyText ? (
				<button type="button" className="footer-btn" onClick={() => {
					copyText(row.copyText);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} aria-label="Copy reply" title="Copy"><Icon name={copied ? 'check' : 'copy'} size={13} /></button>
			) : null}
			{ctx && row.turnId && !ctx.running ? <button type="button" className="footer-btn" onClick={retry} aria-label="Retry" title="Retry: send the prompt again"><Icon name="refresh" size={13} /></button> : null}
			<span className="footer-meta">{parts.join(' · ')}</span>
		</div>
	);
}

function SystemRow({ row }: { readonly row: RowOf<'system'> }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="row-system">
			<Disclosure open={open} onToggle={() => setOpen(o => !o)}>
				<Icon name={row.icon} size={14} />
				<span>{row.title}</span>
			</Disclosure>
			{open ? <div className="system-body"><Markdown text={row.body} /></div> : null}
		</div>
	);
}

export const TranscriptRowView = memo(function TranscriptRowView({ row, chatId }: { readonly row: TranscriptRow; readonly chatId: string }): ReactNode {
	switch (row.kind) {
		case 'user':
			return <UserRow row={row} chatId={chatId} />;
		case 'markdown':
			return <div className="row-md"><Markdown text={row.text} docKey={row.docKey} streaming={row.streaming} /></div>;
		case 'thought':
			return <ThoughtRow row={row} />;
		case 'steps':
			return <StepsRow row={row} />;
		case 'file':
			return <FileRow row={row} />;
		case 'code':
			return <div className="row-code"><CodeBlock code={row.code} lang={row.lang} path={row.path} streaming={row.streaming} /></div>;
		case 'table':
			return (
				<div className="row-table md-table-wrap">
					<table className="md-table">
						<thead><tr>{row.headers.map((h, i) => <th key={i}><Inline text={h} /></th>)}</tr></thead>
						<tbody>{row.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody>
					</table>
					{row.caption ? <div className="table-caption">{row.caption}</div> : null}
				</div>
			);
		case 'plan':
			return <PlanRow row={row} />;
		case 'decision':
			return (
				<div className={`row-decision decision-${row.decision ?? 'pending'}`}>
					<Icon name={row.decision === 'deny' || row.blocked ? 'xCircle' : row.decision === 'allow' ? 'shieldCheck' : 'shieldAlert'} size={14} />
					<span>{row.blocked ? 'Blocked' : row.decision === 'allow' ? row.scope === 'always' ? 'Always allowed' : 'Allowed' : row.decision === 'deny' ? 'Denied' : 'Asked'} {row.action}</span>
					<code>{row.resource}</code>
				</div>
			);
		case 'answers':
			return (
				<div className="card row-answers">
					<div className="card-head"><Icon name="help" size={14} /><span>{row.outcome === 'answered' ? 'Answers' : row.outcome === 'skipped' ? 'Skipped' : 'Dismissed'}</span></div>
					{row.items.map((item, i) => (
						<div key={i} className="answer"><div className="answer-q">{item.question}</div><div className="answer-a">{item.answer}</div></div>
					))}
					{row.note ? <div className="answer-note">{row.note}</div> : null}
				</div>
			);
		case 'notice':
			return (
				<div className={`row-notice notice-${row.severity}`}>
					<Icon name={row.severity === 'error' ? 'alertCircle' : row.severity === 'warning' ? 'alert' : 'info'} size={14} />
					<div><div className="notice-title">{row.title}</div>{row.description ? <div className="notice-desc">{row.description}</div> : null}</div>
				</div>
			);
		case 'error':
			return (
				<div className="row-error">
					<Icon name="alertCircle" size={15} />
					<div className="error-text">{row.message}</div>
				</div>
			);
		case 'todos':
			return <TodosRow row={row} />;
		case 'chart':
			return <ChartRow row={row} />;
		case 'cards':
			return (
				<div className="row-cards">
					{row.items.map((item, i) => (
						<div key={i} className="card mini-card">
							<div className="mini-title">{item.title}</div>
							<div className="mini-body"><Inline text={item.body} /></div>
							{item.meta ? <div className="mini-meta">{item.meta}</div> : null}
						</div>
					))}
				</div>
			);
		case 'visual':
			return (
				<div className="card row-visual">
					<Icon name={row.visual === 'chart' ? 'layers' : 'globe'} size={15} />
					<div><div className="visual-title">{row.title}</div><div className="visual-sub">{row.visual === 'chart' ? 'Chart' : 'Page'} shown in Volt on your computer</div></div>
				</div>
			);
		case 'working':
			return (
				<div className="row-working">
					<span className="working-orb" />
					<Shimmer>{row.status}</Shimmer>
					{row.since ? <LiveTimer since={row.since} className="working-timer" /> : null}
				</div>
			);
		case 'footer':
			return <FooterRow row={row} />;
		case 'divider':
			return (
				<div className="row-divider">
					<span className="divider-line" />
					<span className="divider-label">{row.live ? <Spinner size={11} /> : <Icon name={row.icon} size={12} />}{row.label}{row.detail ? <span className="divider-detail">{row.detail}</span> : null}</span>
					<span className="divider-line" />
				</div>
			);
		case 'system':
			return <SystemRow row={row} />;
	}
	return <Fragment />;
});
