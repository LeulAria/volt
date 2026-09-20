/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../../editor/common/model.js';

const LIST_LINE = /^(\s*)- (.*)$/;
const EMPTY_LIST_LINE = /^(\s*)- ?$/;

/**
 * Turns `- ` at the start of a composer line into a visual bullet, and
 * continues or ends the list on Enter.
 */
export class AgentComposerLists extends Disposable {

	private decorationIds: string[] = [];

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(this.editor.onDidChangeModelContent(() => this.refresh()));
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
	}
}
