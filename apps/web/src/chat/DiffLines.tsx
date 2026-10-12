/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { highlight, type IDiffHunk, type IDiffLine, languageForPath, parseUnifiedDiff, wordChanges } from '@volt/client-core';
import { Fragment, memo, type ReactNode, useMemo, useState } from 'react';

const COLLAPSED_LINES = 80;

/** Syntax colours for one line, with the changed words marked. */
function LineText({ text, lang, marks }: { readonly text: string; readonly lang: string; readonly marks?: readonly (readonly [number, number])[] }) {
	const tokens = useMemo(() => highlight(text, lang)[0] ?? [], [text, lang]);
	if (!text) {
		return <>{'​'}</>;
	}
	const out: ReactNode[] = [];
	let at = 0;
	tokens.forEach((token, i) => {
		const start = at;
		const end = at + token.v.length;
		at = end;
		const cls = token.k === 'plain' ? undefined : `tok-${token.k}`;
		const hits = marks?.filter(([s, e]) => e > start && s < end);
		if (!hits?.length) {
			out.push(cls ? <span key={i} className={cls}>{token.v}</span> : <Fragment key={i}>{token.v}</Fragment>);
			return;
		}
		// Split the token where a changed range starts or ends.
		let pos = start;
		const pieces: ReactNode[] = [];
		for (const [s, e] of hits) {
			const from = Math.max(s, start);
			const to = Math.min(e, end);
			if (from > pos) {
				pieces.push(text.slice(pos, from));
			}
			pieces.push(<mark key={`${i}:${from}`} className="diff-word">{text.slice(from, to)}</mark>);
			pos = to;
		}
		if (pos < end) {
			pieces.push(text.slice(pos, end));
		}
		out.push(<span key={i} className={cls}>{pieces}</span>);
	});
	return <>{out}</>;
}

/** Word marks for runs of deletions followed by as many additions (an edited line). */
function pairMarks(lines: readonly IDiffLine[]): Map<number, readonly (readonly [number, number])[]> {
	const marks = new Map<number, readonly (readonly [number, number])[]>();
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].kind !== 'del') {
			continue;
		}
		let dels = i;
		while (dels < lines.length && lines[dels].kind === 'del') {
			dels++;
		}
		let adds = dels;
		while (adds < lines.length && lines[adds].kind === 'add') {
			adds++;
		}
		const count = Math.min(dels - i, adds - dels);
		for (let k = 0; k < count; k++) {
			const changes = wordChanges(lines[i + k].text, lines[dels + k].text);
			marks.set(i + k, changes.del);
			marks.set(dels + k, changes.add);
		}
		i = adds - 1;
	}
	return marks;
}

const Hunk = memo(function Hunk({ hunk, lang, limit }: { readonly hunk: IDiffHunk; readonly lang: string; readonly limit: number }) {
	const marks = useMemo(() => pairMarks(hunk.lines), [hunk]);
	const lines = hunk.lines.slice(0, limit);
	return (
		<>
			<div className="dl-hunk"><span className="dl-gutter" /><span className="dl-gutter" /><span className="dl-text">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header ? ` ${hunk.header}` : ''}</span></div>
			{lines.map((line, i) => (
				<div key={i} className={`dl-line ${line.kind}`}>
					<span className="dl-gutter">{line.oldLine ?? ''}</span>
					<span className="dl-gutter">{line.newLine ?? ''}</span>
					<span className="dl-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
					<span className="dl-text"><LineText text={line.text} lang={lang} marks={marks.get(i)} /></span>
				</div>
			))}
		</>
	);
});

/** A unified diff as the desktop's inline diff shows it: both line numbers, colour, changed words. */
export const DiffLines = memo(function DiffLines({ diff, path, hunks: given }: { readonly diff?: string; readonly path?: string; readonly hunks?: readonly IDiffHunk[] }) {
	const [expanded, setExpanded] = useState(false);
	const hunks = useMemo(() => given ?? parseUnifiedDiff(diff ?? '').flatMap(file => file.hunks), [diff, given]);
	const lang = path ? languageForPath(path).fence : 'plain';
	const total = hunks.reduce((sum, h) => sum + h.lines.length + 1, 0);
	if (!hunks.length) {
		return diff ? <pre className="diff">{diff}</pre> : null;
	}
	let budget = expanded ? Infinity : COLLAPSED_LINES;
	return (
		<div className="dl">
			<div className="dl-scroll">
				{hunks.map((hunk, i) => {
					if (budget <= 0) {
						return null;
					}
					const limit = budget;
					budget -= hunk.lines.length + 1;
					return <Hunk key={i} hunk={hunk} lang={lang} limit={limit} />;
				})}
			</div>
			{total > COLLAPSED_LINES ? (
				<button type="button" className="dl-more" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : `Show all ${total} lines`}</button>
			) : null}
		</div>
	);
});
