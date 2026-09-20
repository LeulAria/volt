/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';

export type InlineCommentMode = 'edit' | 'ask' | 'chat';

export interface ILineRange {
	startLineNumber: number;
	endLineNumber: number;
}

export function selectionLineRange(selection: IRange): ILineRange {
	const startLineNumber = selection.startLineNumber;
	let endLineNumber = selection.endLineNumber;
	if (selection.endColumn === 1 && endLineNumber > startLineNumber) {
		endLineNumber -= 1;
	}
	if (endLineNumber < startLineNumber) {
		endLineNumber = startLineNumber;
	}
	return { startLineNumber, endLineNumber };
}

export function fullLineRange(model: ITextModel, lines: ILineRange): Range {
	const start = Math.max(1, lines.startLineNumber);
	const end = Math.min(model.getLineCount(), Math.max(start, lines.endLineNumber));
	return new Range(start, 1, end, model.getLineMaxColumn(end));
}

export function selectedSource(model: ITextModel, lines: ILineRange): string {
	return model.getValueInRange(fullLineRange(model, lines));
}

export function formatLineLabel(lines: ILineRange): string {
	return lines.startLineNumber === lines.endLineNumber
		? `${lines.startLineNumber}`
		: `${lines.startLineNumber}-${lines.endLineNumber}`;
}

export function extractReplacementCode(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return '';
	}
	const fenced = trimmed.match(/^```(?:[\w.+\-]*)?\r?\n([\s\S]*?)\r?\n?```$/);
	if (fenced) {
		return fenced[1].replace(/\s+$/, '');
	}
	const inner = trimmed.match(/```(?:[\w.+\-]*)?\r?\n([\s\S]*?)\r?\n?```/);
	if (inner?.[1] && inner[1].trim().length >= Math.min(12, trimmed.length * 0.35)) {
		return inner[1].replace(/\s+$/, '');
	}
	return trimmed;
}

export function buildInlineAskPrompt(fileLabel: string, lines: ILineRange, code: string, question: string): string {
	return [
		`The user selected ${fileLabel} lines ${formatLineLabel(lines)} and asked a question.`,
		'Answer clearly and concisely. Use markdown when it helps.',
		'',
		'```',
		code,
		'```',
		'',
		`Question: ${question.trim()}`,
	].join('\n');
}

export function buildInlineEditPrompt(fileLabel: string, lines: ILineRange, code: string, request: string): string {
	return [
		`Replace the selected code in ${fileLabel} lines ${formatLineLabel(lines)} according to the user's request.`,
		'Reply with ONLY the replacement code for those lines. No markdown fences, no explanation, no surrounding commentary.',
		'Preserve the file\'s indentation and style. Return the complete replacement, not a patch.',
		'',
		'Selected code:',
		'```',
		code,
		'```',
		'',
		`Request: ${request.trim()}`,
	].join('\n');
}

export function collectRuntimeText(
	runtime: IAgentRuntimeService,
	sessionId: string,
	runId: string,
	onDelta: (text: string) => void,
	token: CancellationToken,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let text = '';
		let settled = false;
		const finish = (value: string, error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			listener.dispose();
			cancel.dispose();
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		};
		const listener = runtime.onEvent(sessionId, envelope => {
			if (envelope.runId !== runId) {
				return;
			}
			const event = envelope.event;
			if (event.type === 'text.delta' && event.delta) {
				text += event.delta;
				onDelta(text);
			}
			if (event.type === 'error') {
				finish(text, new Error(event.message));
				return;
			}
			if (event.type === 'run.end') {
				if (event.reason === 'abort') {
					finish(text, new Error('cancelled'));
					return;
				}
				if (event.reason === 'fail' && !text.trim()) {
					finish(text, new Error('The model did not return a response.'));
					return;
				}
				finish(text);
			}
		});
		const cancel = token.onCancellationRequested(() => {
			void runtime.cancel(sessionId);
			finish(text, new Error('cancelled'));
		});
	});
}
