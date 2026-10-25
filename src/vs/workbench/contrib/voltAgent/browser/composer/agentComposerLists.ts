/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { parseInlineMarkdown } from './agentInlineMarkdown.js';
import { linkBrandForHref, linkBrandIconClass, splitTextLinks } from '../blocks/agentLinkLogos.js';

const LIST_LINE = /^(\s*)- (.*)$/;
const EMPTY_LIST_LINE = /^(\s*)- ?$/;

/**
 * Turns `- ` at the start of a composer line into a visual bullet, and
 * continues or ends the list on Enter. Also styles inline markdown (bold,
 * italic, strikethrough, code, headings) with its markers hidden until the
 * cursor is in that run. A pasted link to a known site (YouTube, GitHub, X...)
 * leads with the site's logo.
 */
export class AgentComposerLists extends Disposable {

	private decorationIds: string[] = [];
	private markdownDecorationIds: string[] = [];
	private linkDecorationIds: string[] = [];
	private refreshingLinks = false;
	private linksStale = false;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(this.editor.onDidChangeModelContent(() => this.refresh()));
		this._register(this.editor.onDidChangeCursorSelection(() => this.refreshMarkdown()));
		this.refresh();
	}

	tryHandleEnter(): boolean {
		const model = this.editor.getModel();
		const position = this.editor.getPosition();
		if (!model || !position) {
			return false;
		}
		const line = model.getLineContent(position.lineNumber);
		const empty = line.match(EMPTY_LIST_LINE);
		if (empty) {
			const indent = empty[1];
			this.editor.executeEdits('volt-agent-list', [{
				range: new Range(position.lineNumber, 1, position.lineNumber, line.length + 1),
				text: indent,
			}], [new Selection(position.lineNumber, indent.length + 1, position.lineNumber, indent.length + 1)]);
			return true;
		}
		const item = line.match(LIST_LINE);
		if (!item) {
			return false;
		}
		const indent = item[1];
		const prefix = `${indent}- `;
		this.editor.executeEdits('volt-agent-list', [{
			range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
			text: `\n${prefix}`,
		}], [new Selection(position.lineNumber + 1, prefix.length + 1, position.lineNumber + 1, prefix.length + 1)]);
		return true;
	}

	private refresh(): void {
		const model = this.editor.getModel();
		if (!model) {
			this.decorationIds = [];
			return;
		}
		const next: IModelDeltaDecoration[] = [];
		for (let line = 1; line <= model.getLineCount(); line++) {
			const text = model.getLineContent(line);
			const match = text.match(LIST_LINE);
			if (!match) {
				continue;
			}
			const start = match[1].length + 1;
			next.push({
				range: new Range(line, start, line, start + 2),
				options: {
					description: 'volt-agent-list-bullet',
					inlineClassName: 'volt-agent-list-marker',
					inlineClassNameAffectsLetterSpacing: true,
					before: {
						content: ' ',
						inlineClassName: 'volt-agent-list-bullet',
						inlineClassNameAffectsLetterSpacing: true,
					},
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			});
		}
		this.decorationIds = model.deltaDecorations(this.decorationIds, next);
		this.refreshLinks();
		this.refreshMarkdown();
	}

	/**
	 * Setting injected text makes the editor deliver a queued content change at once, which calls
	 * back in here before the new ids are kept; that call only marks the links stale, and they are
	 * drawn again once this one is done, so no logo is ever left behind.
	 */
	private refreshLinks(): void {
		if (this.refreshingLinks) {
			this.linksStale = true;
			return;
		}
		this.refreshingLinks = true;
		try {
			do {
				this.linksStale = false;
				this.drawLinks();
			} while (this.linksStale);
		} finally {
			this.refreshingLinks = false;
		}
	}

	private drawLinks(): void {
		const model = this.editor.getModel();
		if (!model) {
			this.linkDecorationIds = [];
			return;
		}
		const next: IModelDeltaDecoration[] = [];
		for (let line = 1; line <= model.getLineCount(); line++) {
			const text = model.getLineContent(line);
			if (!text.includes('://')) {
				continue;
			}
			let column = 1;
			for (const part of splitTextLinks(text)) {
				if (typeof part === 'string') {
					column += part.length;
					continue;
				}
				const brand = linkBrandForHref(part.url);
				if (brand) {
					next.push({
						range: new Range(line, column, line, column + part.url.length),
						options: {
							description: 'volt-agent-link',
							inlineClassName: `volt-agent-composer-link ${brand.id}`,
							before: {
								content: '\u00a0',
								inlineClassName: `volt-agent-composer-link-icon ${linkBrandIconClass(brand)}`,
								inlineClassNameAffectsLetterSpacing: true,
							},
							stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
						},
					});
				}
				column += part.url.length;
			}
		}
		this.linkDecorationIds = model.deltaDecorations(this.linkDecorationIds, next);
	}

	private refreshMarkdown(): void {
		const model = this.editor.getModel();
		if (!model) {
			this.markdownDecorationIds = [];
			return;
		}
		const selections = this.editor.getSelections() ?? [];
		const next: IModelDeltaDecoration[] = [];
		for (let line = 1; line <= model.getLineCount(); line++) {
			const text = model.getLineContent(line);
			if (!/[*_~`#]/.test(text)) {
				continue;
			}
			for (const span of parseInlineMarkdown(text)) {
				const start = span.start + 1;
				const end = span.end + 1;
				// The cursor in (or at the edge of) a run shows its markers so they can be edited.
				const editing = selections.some(selection => selection.startLineNumber <= line && selection.endLineNumber >= line
					&& (selection.startLineNumber < line || selection.startColumn <= end)
					&& (selection.endLineNumber > line || selection.endColumn >= start));
				const markerClass = editing ? 'volt-agent-md-marker' : 'volt-agent-md-marker-hidden';
				next.push({
					range: new Range(line, start + span.open, line, end - span.close),
					options: {
						description: 'volt-agent-md',
						inlineClassName: span.styles.map(style => `volt-agent-md-${style}`).join(' '),
						inlineClassNameAffectsLetterSpacing: true,
						stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					},
				});
				for (const [from, to] of [[start, start + span.open], [end - span.close, end]]) {
					if (to > from) {
						next.push({
							range: new Range(line, from, line, to),
							options: {
								description: 'volt-agent-md-marker',
								inlineClassName: markerClass,
								inlineClassNameAffectsLetterSpacing: true,
								stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
							},
						});
					}
				}
			}
		}
		this.markdownDecorationIds = model.deltaDecorations(this.markdownDecorationIds, next);
	}
}
