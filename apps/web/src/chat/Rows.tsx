/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, compactNumber, dirname, duration, highlight, type IStepItem, money, pendingLabel, type TranscriptRow } from '@volt/client-core';
import { Fragment, memo, type ReactNode, useMemo, useState } from 'react';
import { useClient } from '../app/client';
import { Icon, LiveTimer, Shimmer, Spinner } from '../ui/primitives';
import { CodeBlock, Inline, Markdown } from './Markdown';

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

function UserRow({ row, chatId }: { readonly row: RowOf<'user'>; readonly chatId: string }) {
	const client = useClient();
	const [expanded, setExpanded] = useState(false);
	const long = row.text.length > 600 || row.text.split('\n').length > 12;
	return (
		<div className={`row-user${row.pending ? ` pending pending-${row.pending}` : ''}`}>
			{row.from ? <div className="user-from"><Icon name="message" size={12} />From {row.from}</div> : null}
			<div className={`user-bubble${long && !expanded ? ' clamped' : ''}`}>
				{row.mode ? <span className={`user-mode mode-${row.mode.toLowerCase()}`}>{row.mode}</span> : null}
				<div className="user-text">{row.text}</div>
				{row.chips.length ? <div className="user-chips">{row.chips.map(chip => <span key={chip} className="chip"><Icon name="file" size={11} />{chip}</span>)}</div> : null}
				{long ? <button type="button" className="user-more" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
			</div>
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
		return <div className="step-body"><DiffView diff={body.diff} /></div>;
	}
	return <pre className={`step-body${body.mono ? ' mono' : ''}`}>{body.text.length > 8000 ? `${body.text.slice(0, 8000)}\n…` : body.text}</pre>;
}

function StepLine({ step }: { readonly step: IStepItem }) {
	const [open, setOpen] = useState(false);
	const expandable = !!step.body;
	return (
		<div className={`step step-${step.status}`}>
			<button type="button" className="step-line" disabled={!expandable} onClick={() => setOpen(o => !o)} aria-expanded={expandable ? open : undefined}>
				<span className="step-icon">{step.status === 'running' ? <Spinner size={11} /> : <Icon name={step.status === 'error' ? 'xCircle' : step.icon} size={13} />}</span>
				<Shimmer active={step.status === 'running'}><span className="step-label">{step.label}</span></Shimmer>
				{step.detail ? <span className="step-detail">{step.detail}</span> : null}
				{expandable ? <Icon name="chevronRight" size={11} className={`step-chevron${open ? ' open' : ''}`} /> : null}
			</button>
			{open ? <StepBodyView step={step} /> : null}
		</div>
	);
}

function StepsRow({ row }: { readonly row: RowOf<'steps'> }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
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

export function DiffView({ diff }: { readonly diff: string }) {
	const lines = useMemo(() => highlight(diff, 'diff'), [diff]);
	return (
		<pre className="diff">
			{lines.map((tokens, i) => {
				const kind = tokens[0]?.k;
				return <div key={i} className={`diff-line${kind === 'inserted' ? ' add' : kind === 'deleted' ? ' del' : kind === 'meta' ? ' meta' : ''}`}>{tokens.map(t => t.v).join('') || '​'}</div>;
			})}
		</pre>
	);
}

function FileRow({ row }: { readonly row: RowOf<'file'> }) {
	const [open, setOpen] = useState(false);
	const dir = dirname(row.path);
	return (
		<div className={`row-file file-${row.status}`}>
			<button type="button" className="file-head" onClick={() => row.diff && setOpen(o => !o)} disabled={!row.diff}>
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
			{open && row.diff ? <DiffView diff={row.diff} /> : null}
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
	const [copied, setCopied] = useState(false);
	const parts = [row.outcome === 'stopped' ? 'Stopped' : row.outcome === 'failed' ? 'Failed' : undefined, duration(row.durationMs), row.model, row.tokens ? `${compactNumber(row.tokens)} tokens` : undefined, money(row.costUsd)].filter(Boolean);
	return (
		<div className="row-footer">
			{row.copyText ? (
				<button type="button" className="footer-btn" onClick={() => {
					copyText(row.copyText);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} aria-label="Copy reply"><Icon name={copied ? 'check' : 'copy'} size={13} /></button>
			) : null}
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
