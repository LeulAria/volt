/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { highlight, type MdBlock, type MdCallout, type MdInline, languageLabel, markdownFor, parseInline, parseMarkdown, stripHtml } from '@volt/client-core';
import { Fragment, memo, type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../ui/primitives';

function renderInlines(nodes: readonly MdInline[], key = ''): ReactNode[] {
	return nodes.map((node, i) => {
		const k = `${key}${i}`;
		switch (node.t) {
			case 'text': return <Fragment key={k}>{node.v}</Fragment>;
			case 'code': return <code key={k} className="md-code">{node.v}</code>;
			case 'strong': return <strong key={k}>{renderInlines(node.c, `${k}.`)}</strong>;
			case 'em': return <em key={k}>{renderInlines(node.c, `${k}.`)}</em>;
			case 'del': return <del key={k}>{renderInlines(node.c, `${k}.`)}</del>;
			case 'br': return <br key={k} />;
			case 'image': return <a key={k} className="md-link" href={node.src} target="_blank" rel="noreferrer noopener"><Icon name="image" size={13} /> {node.alt || 'image'}</a>;
			case 'link': {
				const safe = /^(https?:|mailto:)/i.test(node.href) ? node.href : undefined;
				return safe
					? <a key={k} className="md-link" href={safe} target="_blank" rel="noreferrer noopener">{renderInlines(node.c, `${k}.`)}</a>
					: <span key={k} className="md-link md-link-local">{renderInlines(node.c, `${k}.`)}</span>;
			}
		}
	});
}

export function Inline({ text, open }: { readonly text: string; readonly open?: boolean }) {
	return <>{renderInlines(parseInline(text, open))}</>;
}

const CALLOUT_ICON: Record<MdCallout, Parameters<typeof Icon>[0]['name']> = { note: 'info', tip: 'sparkles', important: 'alertCircle', warning: 'alert', caution: 'xCircle' };

const BlockView = memo(function BlockView({ block, open }: { readonly block: MdBlock; readonly open: boolean }): ReactNode {
	switch (block.type) {
		case 'paragraph':
			return <p><Inline text={block.text} open={open} /></p>;
		case 'heading': {
			const Tag = `h${Math.min(6, block.level)}` as 'h1';
			return <Tag><Inline text={block.text} open={open} /></Tag>;
		}
		case 'code':
			return <CodeBlock code={block.code} lang={block.lang} streaming={open && !block.closed} />;
		case 'math':
			return <pre className="md-math">{block.text}</pre>;
		case 'hr':
			return <hr />;
		case 'html':
			return <p className="md-html">{stripHtml(block.text)}</p>;
		case 'quote':
			return (
				<blockquote className={block.callout ? `md-callout md-callout-${block.callout}` : undefined}>
					{block.callout ? <div className="md-callout-title"><Icon name={CALLOUT_ICON[block.callout]} size={14} />{block.callout}</div> : null}
					<Blocks blocks={block.blocks} open={open} />
				</blockquote>
			);
		case 'list': {
			const items = block.items.map((item, i) => (
				<li key={item.key} className={item.checked !== undefined ? 'md-task' : undefined}>
					{item.checked !== undefined ? <span className={`md-check${item.checked ? ' on' : ''}`}>{item.checked ? <Icon name="check" size={11} strokeWidth={2.4} /> : null}</span> : null}
					<div className="md-li-body"><Blocks blocks={item.blocks} open={open && i === block.items.length - 1} tight={block.tight} /></div>
				</li>
			));
			return block.ordered
				? <ol start={block.start} className={block.tight ? 'tight' : undefined}>{items}</ol>
				: <ul className={block.tight ? 'tight' : undefined}>{items}</ul>;
		}
		case 'table':
			return (
				<div className="md-table-wrap">
					<table className="md-table">
						<thead><tr>{block.header.map((cell, i) => <th key={i} style={{ textAlign: block.align[i] ?? undefined }}><Inline text={cell} /></th>)}</tr></thead>
						<tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} style={{ textAlign: block.align[i] ?? undefined }}><Inline text={cell} /></td>)}</tr>)}</tbody>
					</table>
				</div>
			);
	}
}, (a, b) => a.block === b.block && a.open === b.open);

function Blocks({ blocks, open, tight }: { readonly blocks: readonly MdBlock[]; readonly open: boolean; readonly tight?: boolean }) {
	return (
		<>
			{blocks.map((block, i) => tight && block.type === 'paragraph'
				? <span key={block.key} className="md-tight"><Inline text={block.text} open={open && i === blocks.length - 1} /></span>
				: <BlockView key={block.key} block={block} open={open && i === blocks.length - 1} />)}
		</>
	);
}

/**
 * A reply's markdown. `docKey` names where the text lives (message and segment): while it streams
 * the parse reuses every finished block and only the tail block re-renders.
 */
export const Markdown = memo(function Markdown({ text, docKey, streaming = false, className }: { readonly text: string; readonly docKey?: string; readonly streaming?: boolean; readonly className?: string }) {
	const doc = useMemo(() => docKey ? markdownFor(docKey, text) : parseMarkdown(text), [docKey, text]);
	return (
		<div className={`md${className ? ` ${className}` : ''}`}>
			<Blocks blocks={doc.blocks} open={streaming} />
			{streaming ? <span className="md-caret" aria-hidden="true" /> : null}
		</div>
	);
});

export const CodeBlock = memo(function CodeBlock({ code, lang, path, streaming }: { readonly code: string; readonly lang?: string; readonly path?: string; readonly streaming?: boolean }) {
	const lines = useMemo(() => highlight(code, lang), [code, lang]);
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard?.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		});
	};
	return (
		<div className="code-card">
			<div className="code-head">
				<span className="code-lang">{path ? <><Icon name="file" size={12} />{path.split('/').pop()}</> : languageLabel(lang)}</span>
				{streaming ? <span className="code-live">writing</span> : null}
				<button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
					<Icon name={copied ? 'check' : 'copy'} size={13} />
					<span>{copied ? 'Copied' : 'Copy'}</span>
				</button>
			</div>
			<pre className="code-body"><code>
				{lines.map((tokens, i) => (
					<span key={i} className="code-line">
						{tokens.length ? tokens.map((token, j) => token.k === 'plain' ? <Fragment key={j}>{token.v}</Fragment> : <span key={j} className={`tok-${token.k}`}>{token.v}</span>) : '​'}
						{'\n'}
					</span>
				))}
			</code></pre>
		</div>
	);
});
