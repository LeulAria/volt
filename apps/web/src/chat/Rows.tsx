/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	attachmentsOf, basename, compactNumber, dirname, duration, errorMessage, formatWorkedTime, type IPromptAttachment, type IRestorePreview, type IRowImage, type IStepItem,
	type ISubagentItem, liveVerb, money, pendingLabel, receiptHeadline, receiptStatus, relativeTime, tokenizeShell, type TranscriptRow, uuid
} from '@volt/client-core';
import { Fragment, memo, type ReactNode, useContext, useMemo, useState } from 'react';
import { useAttachment, useClient } from '../app/client';
import { useConversationPrefs } from '../app/prefs';
import { Dialog } from '../ui/overlays';
import { Button, Icon, LiveTimer, Spinner } from '../ui/primitives';
import { openTab } from '../ide/workbench';
import { Composer } from './Composer';
import { DiffLines } from './DiffLines';
import { openLightbox } from './Lightbox';
import { CodeBlock, Inline, Markdown } from './Markdown';
import { changesPath, navigate } from '../app/router';
import { FileIcon } from '../ide/icons';
import { VisualCard } from './Visuals';
import { useChatRow, WorkedToggleContext } from './rowContext';

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
	// A long prompt shows its first two lines and Read more, as on the desktop.
	const long = row.text.length > 180 || row.text.split('\n').length > 2;
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
				{long ? <button type="button" className="user-more" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : 'Read more'}</button> : null}
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

/** The chevron after a header: right closed, down open (agentTranscript.css `.volt-tr-chevron`). */
function Chevron() {
	return <span className="tr-chevron"><Icon name="chevronDown" size={12} strokeWidth={2} /></span>;
}

function Stats({ additions, deletions }: { readonly additions?: number; readonly deletions?: number }) {
	return additions || deletions ? (
		<span className="tr-stats">
			{additions ? <span className="add">+{additions}</span> : null}
			{deletions ? <span className="del">-{deletions}</span> : null}
		</span>
	) : null;
}

/** A work log header: the verb (tertiary), the details (quaternary), stats, exit code, chevron. */
function TrHeader({ action, detail, command, live, expandable, open, onToggle, additions, deletions, exit, tertiary }: {
	readonly action: string;
	readonly detail?: string;
	readonly command?: string;
	readonly live?: boolean;
	readonly expandable: boolean;
	readonly open?: boolean;
	readonly onToggle?: () => void;
	readonly additions?: number;
	readonly deletions?: number;
	readonly exit?: number;
	readonly tertiary?: boolean;
}) {
	const body = <>
		<span className={`tr-action${live ? ' shimmer' : ''}`}>{action}</span>
		{detail ? <span className={`tr-details${tertiary ? ' tertiary' : ''}`}>{detail}{command ? <span className="tr-command"> {command}</span> : null}</span> : null}
		<Stats additions={additions} deletions={deletions} />
		{exit !== undefined ? <span className="tr-exit">exit {exit}</span> : null}
		{expandable ? <Chevron /> : null}
	</>;
	return expandable
		? <button type="button" className="tr-header" aria-expanded={open} onClick={onToggle}>{body}</button>
		: <div className="tr-header">{body}</div>;
}

/** Cursor's command card: `$ cmd args` then the output, 13/18 mono, 200px before it scrolls. */
function TerminalCard({ command, output }: { readonly command: string; readonly output: string }) {
	const tokens = useMemo(() => tokenizeShell(command), [command]);
	const text = output.replace(/[\r\n]+$/, '');
	return (
		<div className="tr-terminal">
			<button type="button" className="tr-terminal-menu" title="Copy command" onClick={() => copyText(command)}><Icon name="copy" size={12} /></button>
			<div className="tr-terminal-scroll">
				<code className="tr-terminal-command"><span className="prompt">$ </span>{tokens.map((t, i) => t.kind === 'text' ? <Fragment key={i}>{t.value}</Fragment> : <span key={i} className={t.kind}>{t.value}</span>)}</code>
				{text ? <pre className="tr-terminal-output">{text.length > 12000 ? `…${text.slice(-12000)}` : text}</pre> : null}
			</div>
		</div>
	);
}

function ToolOutput({ text }: { readonly text: string }) {
	return (
		<div className="tr-terminal tool">
			<div className="tr-terminal-scroll"><pre className="tr-terminal-output">{text.length > 12000 ? `${text.slice(0, 12000)}\n…` : text.replace(/[\r\n]+$/, '')}</pre></div>
		</div>
	);
}

function ThoughtLine({ text, detail, live }: { readonly text: string; readonly detail?: string; readonly live: boolean }) {
	const [open, setOpen] = useState(false);
	if (live) {
		return <div className="tr-group thought live"><TrHeader action="Thinking" live expandable={false} /></div>;
	}
	const has = !!text.trim();
	return (
		<div className={`tr-group thought${open ? ' open' : ''}`}>
			<TrHeader action="Thought" detail={detail} expandable={has} open={open} onToggle={() => setOpen(o => !o)} />
			{open ? <div className="tr-body"><div className="tr-thinking"><Markdown text={text} /></div></div> : null}
		</div>
	);
}

function StepBody({ step }: { readonly step: IStepItem }) {
	const body = step.body;
	if (!body) {
		return null;
	}
	switch (body.kind) {
		case 'command': return <TerminalCard command={body.command} output={body.output} />;
		case 'diff': return <DiffLines diff={body.diff} {...(body.path ? { path: body.path } : {})} />;
		case 'thought': return <div className="tr-thinking"><Markdown text={body.text} /></div>;
		default: return <ToolOutput text={body.text} />;
	}
}

const StepLine = memo(function StepLine({ step, live, card }: { readonly step: IStepItem; readonly live: boolean; readonly card?: boolean }) {
	const [open, setOpen] = useState(!!card && !!step.body);
	if (step.kind === 'thought') {
		return <ThoughtLine text={step.body?.kind === 'thought' ? step.body.text : ''} detail={step.detail} live={live && step.status === 'running'} />;
	}
	const running = live && step.status === 'running';
	return (
		<div className={`tr-group step ${step.kind}${open ? ' open' : ''}${card && step.body ? ' card' : ''}`}>
			<TrHeader action={running ? liveVerb(step) : step.label} detail={step.detail} command={step.command} live={running} expandable={!!step.body} open={open} onToggle={() => setOpen(o => !o)} additions={step.additions} deletions={step.deletions} exit={step.exitCode} />
			{open && step.body ? <div className="tr-body"><StepBody step={step} /></div> : null}
		</div>
	);
});

function StepsRow({ row }: { readonly row: RowOf<'steps'> }) {
	const [open, setOpen] = useState(false);
	if (row.display === 'lines' || row.display === 'cards') {
		return (
			<div className={`tr-step-list ${row.display}`}>
				{row.items.map((step, i) => <StepLine key={step.key} step={step} live={row.live && i === row.items.length - 1} card={row.display === 'cards'} />)}
			</div>
		);
	}
	return (
		<div className={`tr-group${open ? ' open' : ''}${row.live ? ' live' : ''}`}>
			<TrHeader action={row.action} detail={row.detail} live={row.live} expandable open={open} onToggle={() => setOpen(o => !o)} additions={row.additions} deletions={row.deletions} />
			{open ? <div className="tr-body">{row.items.map((step, i) => <StepLine key={step.key} step={step} live={row.live && i === row.items.length - 1} />)}</div> : null}
		</div>
	);
}

export function DiffView({ diff, path }: { readonly diff: string; readonly path?: string }) {
	return <DiffLines diff={diff} {...(path ? { path } : {})} />;
}

/** One edit between the other steps: its own card over a fading peek of its diff (`.volt-tr-edit-card`). */
function EditCard({ row }: { readonly row: RowOf<'file'> }) {
	const ctx = useChatRow();
	const client = useClient();
	const { toolDensity } = useConversationPrefs();
	const [open, setOpen] = useState(toolDensity === 'detailed');
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
		<div className={`tr-edit-card${open ? ' open' : ''}`}>
			<div className="tr-edit-head">
				<button type="button" className="tr-header" aria-expanded={open} onClick={() => setOpen(o => !o)} title={row.path}>
					<FileIcon path={row.path} />
					<span className={`tr-edit-name${row.status === 'running' ? ' shimmer' : ''}`}>{basename(row.path)}</span>
					{row.verb !== 'Edited' ? <span className="tr-details">{row.verb === 'Created' ? 'new' : 'deleted'}</span> : null}
					<Stats additions={row.additions} deletions={row.deletions} />
					<Chevron />
				</button>
				{absolute && ctx?.openPath && row.verb !== 'Deleted' ? (
					<span className="tr-edit-actions">
						<button type="button" title="Open the diff in the editor" onClick={() => void openDiff()}><Icon name="fileDiff" size={13} /></button>
						<button type="button" title="Open the file" onClick={() => ctx.openPath?.(absolute)}><Icon name="external" size={13} /></button>
					</span>
				) : null}
			</div>
			{row.diff || row.status === 'running' ? (
				<div className="tr-edit-body" onClick={open ? undefined : () => setOpen(true)}>
					{row.diff ? <DiffLines diff={row.diff} path={row.path} /> : <div className="tr-diff-empty">Writing…</div>}
				</div>
			) : null}
		</div>
	);
}

function SubagentLine({ item }: { readonly item: ISubagentItem }) {
	const [open, setOpen] = useState(false);
	const live = item.state === 'running';
	const expandable = !!item.output;
	return (
		<div className={`tr-subagent${live ? ' live' : ''}${open ? ' open' : ''}`}>
			<span className="tr-subagent-icon">{live ? <Spinner size={12} /> : <Icon name={item.state === 'stopped' ? 'stop' : item.state === 'failed' ? 'xCircle' : 'check'} size={13} strokeWidth={2} />}</span>
			<div className="tr-subagent-text">
				<button type="button" className="tr-subagent-head" disabled={!expandable} onClick={() => setOpen(o => !o)}>
					<span className="tr-subagent-title">{item.title}</span>
					{item.type ? <span className="tr-subagent-type">{item.type}</span> : null}
					{expandable ? <Chevron /> : null}
				</button>
				<div className={`tr-subagent-status${live ? ' shimmer' : ''}`}>{item.status}{live && item.steps > 1 ? <span className="tr-subagent-steps">{item.steps} steps</span> : null}</div>
				{open && item.output ? <pre className="tr-subagent-output">{item.output}</pre> : null}
			</div>
		</div>
	);
}

function SubagentsRow({ row }: { readonly row: RowOf<'subagents'> }) {
	const [open, setOpen] = useState(false);
	if (row.items.length < 3) {
		return <div className="tr-subagents">{row.items.map(item => <SubagentLine key={item.key} item={item} />)}</div>;
	}
	const working = row.items.filter(item => item.state === 'running').length;
	return (
		<div className={`tr-group${open ? ' open' : ''}`}>
			<TrHeader action={`${row.items.length} subagents`} detail={working ? `${working} working` : undefined} live={row.live} expandable open={open} onToggle={() => setOpen(o => !o)} />
			{open ? <div className="tr-body tr-subagents">{row.items.map(item => <SubagentLine key={item.key} item={item} />)}</div> : null}
		</div>
	);
}

function CompactionRow({ row }: { readonly row: RowOf<'compaction'> }) {
	const [open, setOpen] = useState(false);
	const running = row.status === 'running';
	const label = running ? 'Compacting context' : row.status === 'failed' ? 'Compaction failed' : row.status === 'cancelled' ? 'Compaction stopped' : 'Context compacted';
	return (
		<div className={`tr-compaction${open ? ' open' : ''}${row.status === 'failed' ? ' failed' : ''}`}>
			<div className="tr-compaction-line">
				<button type="button" className="tr-compaction-pill" disabled={!row.summary} onClick={() => setOpen(o => !o)}>
					<span className="tr-compaction-icon"><Icon name="minimize" size={13} /></span>
					<span className={`tr-compaction-label${running ? ' shimmer' : ''}`}>{label}</span>
					{row.detail ? <span className="tr-compaction-detail">{row.detail}</span> : null}
					{row.summary ? <Chevron /> : null}
				</button>
			</div>
			{open && row.summary ? <div className="tr-compaction-summary tr-thinking"><Markdown text={row.summary} /></div> : null}
		</div>
	);
}

function WorkedRow({ row }: { readonly row: RowOf<'worked'> }) {
	const toggle = useContext(WorkedToggleContext);
	return (
		<div className={`tr-group worked${row.open ? ' open' : ''}`}>
			<TrHeader action="Worked" detail={`for ${formatWorkedTime(row.durationMs)}`} tertiary expandable open={row.open} onToggle={() => toggle?.(row.turnKey, !row.open)} />
		</div>
	);
}

function TurnFilesCard({ row }: { readonly row: RowOf<'turnFiles'> }) {
	const ctx = useChatRow();
	const [all, setAll] = useState(false);
	const shown = all ? row.files : row.files.slice(0, 8);
	const open = (path: string) => {
		const absolute = path.startsWith('/') ? path : ctx?.root ? `${ctx.root}/${path}` : undefined;
		if (absolute) {
			ctx?.openPath?.(absolute);
		}
	};
	return (
		<div className="turn-files">
			<div className="turn-files-header">
				<span className="turn-files-title">{row.files.length === 1 ? '1 file changed' : `${row.files.length} files changed`}</span>
				{ctx ? <button type="button" className="turn-files-review" onClick={() => navigate(changesPath(ctx.chatId))}>Review<Icon name="arrowRight" size={12} /></button> : null}
			</div>
			<div className="turn-files-rows">
				{shown.map(file => (
					<button key={file.path} type="button" className={`turn-files-row${file.verb === 'Deleted' ? ' deleted' : ''}`} disabled={file.verb === 'Deleted'} onClick={() => open(file.path)} title={file.path}>
						<FileIcon path={file.path} />
						<span className="turn-files-name">{basename(file.path)}</span>
						<span className="turn-files-dir">{dirname(file.path)}</span>
						<Stats additions={file.additions} deletions={file.deletions} />
					</button>
				))}
				{row.files.length > shown.length ? <button type="button" className="turn-files-more" onClick={() => setAll(true)}>{row.files.length - shown.length} more</button> : null}
			</div>
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
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? row.live;
	return (
		<div className={`tr-group tr-todos${expanded ? ' open' : ''}${row.live ? ' live' : ''}`}>
			<button type="button" className="tr-header" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
				<span className="tr-todos-icon"><Icon name="listChecks" size={13} /></span>
				<span className="tr-action">To-dos</span>
				<span className="tr-details">{done} of {row.steps.length} done</span>
				<Chevron />
			</button>
			{expanded ? (
				<ul className="tr-todo-list">
					{row.steps.map((step, i) => (
						<li key={`${i}:${step.label}`} className={`tr-todo ${step.state}`}>
							<span className="tr-todo-mark">{step.state === 'current' && row.live ? <Spinner size={11} /> : <Icon name={step.state === 'done' ? 'checkCircle' : step.state === 'current' ? 'circleDashed' : 'circle'} size={13} />}</span>
							<span className={`tr-todo-label${step.state === 'current' && row.live ? ' shimmer' : ''}`}>{step.label}</span>
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

/** Proof of done under the answer: the verdict, each item with its proof, what is left, and the files changed. */
function ReceiptRow({ row }: { readonly row: RowOf<'receipt'> }) {
	const ctx = useChatRow();
	const receipt = row.receipt;
	const head = receiptHeadline(receipt);
	const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : ctx?.root ? `${ctx.root}/${path}` : undefined;
	const more = receipt.changedCount - receipt.changed.length;
	return (
		<div className={`card row-receipt receipt-${receipt.verdict}`} role="group" aria-label={head.title}>
			<div className="card-head receipt-head">
				<Icon name={head.icon} size={14} className={`tone-${head.tone}`} />
				<span>{head.title}</span>
				<span className="receipt-meta" title={receipt.gated ? 'This run could only finish once its checks passed after its last edit.' : undefined}>{head.meta}</span>
			</div>
			<ul className="receipt-lines">
				{receipt.lines.map((line, i) => {
					const status = receiptStatus(line.status);
					return (
						<li key={i} className={`receipt-line status-${line.status}`}>
							<span className={`receipt-mark tone-${status.tone}`} title={status.label} aria-label={status.label}><Icon name={status.icon} size={13} /></span>
							<div className="receipt-body">
								<div className="receipt-text">{line.source === 'agent' ? `Agent: \u201c${line.text}\u201d` : line.text}</div>
								{line.command || line.detail ? (
									<div className="receipt-proof">
										{line.command ? <button type="button" className="receipt-command" title="Copy command" onClick={() => copyText(line.command!)}>{line.command}</button> : null}
										{line.detail ? <span className="receipt-detail" title={line.detail}>{line.detail}</span> : null}
									</div>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
			{receipt.review && (receipt.review.summary || receipt.review.gaps.length) ? (
				<div className="receipt-section">
					<div className="receipt-label">Second opinion</div>
					{receipt.review.summary ? <div className="receipt-note">{receipt.review.summary}</div> : null}
					{receipt.review.gaps.map((gap, i) => <div key={i} className="receipt-note receipt-gap">{gap}</div>)}
				</div>
			) : null}
			{receipt.open.length ? (
				<div className="receipt-section">
					<div className="receipt-label">Left open</div>
					{receipt.open.map((entry, i) => <div key={i} className="receipt-note">{entry}</div>)}
				</div>
			) : null}
			{receipt.changedCount ? (
				<div className="receipt-files">
					<span className="receipt-label">{receipt.changedCount === 1 ? '1 file changed' : `${receipt.changedCount} files changed`}</span>
					{receipt.changed.map(path => {
						const target = absolute(path);
						return target
							? <button key={path} type="button" className="receipt-file" title={path} onClick={() => openTab({ name: 'file', path: target })}>{basename(path)}</button>
							: <span key={path} className="receipt-file" title={path}>{basename(path)}</span>;
					})}
					{more > 0 ? <span className="receipt-more">+{more} more</span> : null}
				</div>
			) : null}
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
	const context = !row.tokens && row.tokensUsed ? `${compactNumber(row.tokensUsed)}${row.tokensWindow ? ` / ${compactNumber(row.tokensWindow)}` : ''} context` : undefined;
	const parts = [row.outcome === 'stopped' ? 'Stopped' : row.outcome === 'failed' ? 'Failed' : undefined, row.endedAt ? relativeTime(row.endedAt) : duration(row.durationMs), row.model, row.tokens ? `${compactNumber(row.tokens)} tokens` : context, money(row.costUsd)].filter(Boolean);
	return (
		<div className="row-footer">
			{row.copyText ? (
				<button type="button" className="footer-btn" onClick={() => {
					copyText(row.copyText);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} aria-label="Copy reply" title="Copy"><Icon name={copied ? 'check' : 'copy'} size={12} /></button>
			) : null}
			{ctx && row.turnId && !ctx.running ? <button type="button" className="footer-btn" onClick={retry} aria-label="Retry" title="Retry: send the prompt again"><Icon name="refresh" size={12} /></button> : null}
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
			return <ThoughtLine text={row.text} detail={row.durationMs && row.durationMs >= 1000 ? `${Math.round(row.durationMs / 1000)}s` : 'briefly'} live={row.streaming} />;
		case 'steps':
			return <StepsRow row={row} />;
		case 'file':
			return <EditCard row={row} />;
		case 'subagents':
			return <SubagentsRow row={row} />;
		case 'compaction':
			return <CompactionRow row={row} />;
		case 'worked':
			return <WorkedRow row={row} />;
		case 'turnFiles':
			return <TurnFilesCard row={row} />;
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
				<div className="tr-header row-decision">
					<Icon name="shieldAlert" size={13} />
					<span className="tr-action">Waiting for approval</span>
					<span className="tr-details mono">{row.resource}</span>
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
		case 'receipt':
			return <ReceiptRow row={row} />;
		case 'notice':
			return (
				<div className={`row-notice notice-${row.severity}`}>
					{row.severity === 'error' ? null : <Icon name={row.severity === 'warning' ? 'alert' : 'info'} size={13} />}
					<div><div className="notice-title">{row.title}</div>{row.description ? <div className="notice-desc">{row.description}</div> : null}</div>
				</div>
			);
		case 'error':
			return <div className="row-error"><div className="error-text">{row.message}</div></div>;
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
			return <VisualCard visualRef={row.ref} kind={row.visual} title={row.title} {...(row.height ? { height: row.height } : {})} {...(row.detail ? { detail: row.detail } : {})} {...(row.pending ? { pending: true } : {})} />;
		case 'working':
			return (
				<div className="tr-tail">
					<span className="tr-action shimmer">{row.status}</span>
					{row.since ? <LiveTimer since={row.since} className="tr-elapsed" /> : null}
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
