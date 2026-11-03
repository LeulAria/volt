/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type InlineMarkdownStyle = 'bold' | 'italic' | 'strike' | 'code' | 'heading';

/** One styled run of a prompt: `start`/`end` include the markers, `open`/`close` are their lengths. */
export interface IInlineMarkdownSpan {
	readonly styles: readonly InlineMarkdownStyle[];
	readonly start: number;
	readonly end: number;
	readonly open: number;
	readonly close: number;
}

// Leftmost match wins; at one position the earlier alternative does (code, then *** before ** before *).
// `_` only counts at word edges so snake_case names stay as typed. Nothing spans a line break.
const INLINE = /(`+)([^`\n]+?)\1|(\*\*\*|___)(?=[^\s*_])([^\n]+?)(?<=[^\s*_])\3|(\*\*|__)(?=[^\s*_])([^\n]+?)(?<=[^\s*_])\5|~~(?=\S)([^\n]+?)(?<=\S)~~|\*(?=[^\s*])([^\n]+?)(?<=[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu;
const HEADING = /^(#{1,6} +)(?=\S)/gm;
const MAX_DEPTH = 3;

/**
 * The bold, italic, strikethrough, inline code and heading runs of plain prompt text, the way
 * markdown would read them, so the composer and the sent message can show them styled.
 */
export function parseInlineMarkdown(text: string): IInlineMarkdownSpan[] {
	const spans: IInlineMarkdownSpan[] = [];
	for (const match of text.matchAll(HEADING)) {
		const lineEnd = text.indexOf('\n', match.index);
		spans.push({ styles: ['heading'], start: match.index, end: lineEnd < 0 ? text.length : lineEnd, open: match[1].length, close: 0 });
	}
	parseRange(text, 0, text.length, 0, spans);
	return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

function parseRange(text: string, from: number, to: number, depth: number, spans: IInlineMarkdownSpan[]): void {
	const slice = text.slice(from, to);
	for (const match of slice.matchAll(INLINE)) {
		const start = from + match.index;
		const end = start + match[0].length;
		let styles: InlineMarkdownStyle[];
		let marker: number;
		let inner: string | undefined;
		if (match[1] !== undefined) {
			styles = ['code'];
			marker = match[1].length;
		} else if (match[3] !== undefined) {
			styles = ['bold', 'italic'];
			marker = 3;
			inner = match[4];
		} else if (match[5] !== undefined) {
			styles = ['bold'];
			marker = 2;
			inner = match[6];
		} else if (match[7] !== undefined) {
			styles = ['strike'];
			marker = 2;
			inner = match[7];
		} else {
			styles = ['italic'];
			marker = 1;
			inner = match[8] ?? match[9];
		}
		spans.push({ styles, start, end, open: marker, close: marker });
		if (inner !== undefined && depth < MAX_DEPTH) {
			parseRange(text, start + marker, end - marker, depth + 1, spans);
		}
	}
}

/**
 * Plain text with its markdown runs as nested elements: markers dropped, styled text in
 * `strong`/`em`/`del`/`code`, and `appendText` for every plain piece.
 */
export function renderInlineMarkdown(parent: HTMLElement, text: string, appendText: (parent: HTMLElement, text: string) => void): void {
	const spans = parseInlineMarkdown(text);
	const doc = parent.ownerDocument;
	const renderRange = (into: HTMLElement, from: number, to: number, list: readonly IInlineMarkdownSpan[]): void => {
		let cursor = from;
		let i = 0;
		while (i < list.length) {
			const span = list[i];
			if (span.start < cursor || span.end > to) {
				i++;
				continue;
			}
			if (span.start > cursor) {
				appendText(into, text.slice(cursor, span.start));
			}
			const element = doc.createElement(tagFor(span.styles));
			element.classList.add('volt-agent-inline-md', ...span.styles.map(style => `md-${style}`));
			into.appendChild(element);
			// Bold italic is one run: the italic sits inside the strong.
			let body = element;
			if (span.styles.length > 1) {
				body = doc.createElement('em');
				element.appendChild(body);
			}
			const children: IInlineMarkdownSpan[] = [];
			let j = i + 1;
			for (; j < list.length && list[j].start < span.end; j++) {
				children.push(list[j]);
			}
			renderRange(body, span.start + span.open, span.end - span.close, children);
			cursor = span.end;
			i = j;
		}
		if (cursor < to) {
			appendText(into, text.slice(cursor, to));
		}
	};
	renderRange(parent, 0, text.length, spans);
}

function tagFor(styles: readonly InlineMarkdownStyle[]): string {
	switch (styles[0]) {
		case 'bold': return 'strong';
		case 'italic': return 'em';
		case 'strike': return 'del';
		case 'code': return 'code';
		case 'heading': return 'span';
	}
}
