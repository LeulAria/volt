/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { TrackedRangeStickiness } from '../../../../../editor/common/model.js';

/**
 * Where dictation writes in a composer: the partial transcript replaces what the last partial wrote,
 * at the spot dictation started, as one undo step. Shared by every composer with a mic.
 */
export class AgentDictationText {

	private written: IEditorDecorationsCollection | undefined;
	private shown = '';
	private separator = '';

	constructor(private readonly editor: () => ICodeEditor | undefined) { }

	/** A partial is on screen. */
	get writing(): boolean {
		return !!this.written;
	}

	/** Writes `text` where dictation started, over what the last partial wrote. Empty removes it. */
	write(text: string): void {
		if (text === this.shown) {
			return;
		}
		const editor = this.editor();
		const model = editor?.getModel();
		if (!editor || !model || model.isDisposed()) {
			return;
		}
		let range: IRange | undefined = this.written?.getRange(0) ?? undefined;
		if (!range) {
			const pos = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
			range = { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column };
			const before = model.getValueInRange({ ...range, startColumn: Math.max(1, pos.column - 1) });
			this.separator = before && !/\s/.test(before) ? ' ' : '';
			// One undo step for the whole dictation.
			editor.pushUndoStop();
			this.written = editor.createDecorationsCollection();
		}
		const insert = text ? this.separator + text : '';
		editor.executeEdits('volt-dictation', [{ range, text: insert }]);
		const start = { lineNumber: range.startLineNumber, column: range.startColumn };
		const end = model.getPositionAt(model.getOffsetAt(start) + insert.length);
		this.written!.set([{
			range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
			options: { description: 'volt-dictation', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
		}]);
		editor.setPosition(end);
		this.shown = text;
	}

	/** Settles dictation with its final text, or removes the partial when `text` is empty. */
	end(text: string): void {
		this.write(text);
		this.written?.clear();
		this.written = undefined;
		this.shown = '';
		const editor = this.editor();
		editor?.pushUndoStop();
		if (text) {
			editor?.focus();
		}
	}

	/** The draft before where dictation writes: the sentence it continues and the names around it. */
	textBefore(): string {
		const editor = this.editor();
		const model = editor?.getModel();
		const start = this.written?.getRange(0)?.getStartPosition() ?? editor?.getPosition();
		return model && !model.isDisposed() && start ? model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: start.lineNumber, endColumn: start.column }) : '';
	}
}
