/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IPredictionContext, IRecentEdit, ISiblingExcerpt } from '../../common/prediction.js';
import { cursorIdentifiers, DEFAULT_EXCERPT_BUDGET, extractExcerpt, extractImports, IExcerptBudget, relevantSnippet } from '../../common/prediction/contextWindow.js';

const DIAGNOSTIC_LINE_RADIUS = 20;
const SIBLING_SNIPPET_CHARS = 600;
const MAX_SIBLINGS = 3;
/** Larger files are skipped as siblings: scanning them would sit on the keystroke path. */
const MAX_SIBLING_SCAN_CHARS = 400_000;

/**
 * Assembles the D24 minimal prediction context from the live editor state:
 * excerpt + imports + nearby diagnostics + recent edits + the lines of open same-language files
 * that mention the names around the cursor.
 */
export function buildPredictionContext(
	model: ITextModel,
	position: Position,
	markerService: IMarkerService,
	modelService: IModelService,
	recentEdits: IRecentEdit[],
	clipboard?: string,
	budget: IExcerptBudget = DEFAULT_EXCERPT_BUDGET,
): IPredictionContext {
	const offset = model.getOffsetAt(position);
	// Read only the window around the cursor; getValue() would copy the whole file per keystroke.
	const startOffset = Math.max(0, offset - budget.before - 200);
	const endOffset = Math.min(model.getValueLength(), offset + budget.after + 200);
	const window = model.getValueInRange(rangeFromOffsets(model, startOffset, endOffset));
	// The window is wider than the budget, so the excerpt's cuts still snap to whole lines.
	const { prefix, suffix } = extractExcerpt(window, offset - startOffset, budget);

	const lineContent = model.getLineContent(position.lineNumber);
	const linePrefix = lineContent.slice(0, position.column - 1);
	const lineSuffix = lineContent.slice(position.column - 1);

	const diagnostics = markerService.read({ resource: model.uri })
		.filter(m => m.severity >= MarkerSeverity.Warning
			&& Math.abs(m.startLineNumber - position.lineNumber) <= DIAGNOSTIC_LINE_RADIUS)
		.slice(0, 6)
		.map(m => `${m.startLineNumber}:${m.startColumn} ${MarkerSeverity.toString(m.severity)} ${m.message}`);

	const languageId = model.getLanguageId();
	const identifiers = cursorIdentifiers(prefix, linePrefix);
	const siblings: ISiblingExcerpt[] = [];
	for (const candidate of modelService.getModels()) {
		if (siblings.length >= MAX_SIBLINGS) {
			break;
		}
		if (candidate === model
			|| candidate.getLanguageId() !== languageId
			|| candidate.uri.scheme !== model.uri.scheme
			|| !candidate.isAttachedToEditor()
			|| candidate.getValueLength() > MAX_SIBLING_SCAN_CHARS) {
			continue;
		}
		const excerpt = relevantSnippet(candidate.getValue(), identifiers, SIBLING_SNIPPET_CHARS);
		if (excerpt) {
			siblings.push({ path: candidate.uri.path, excerpt });
		}
	}

	const head = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: Math.min(60, model.getLineCount()), endColumn: model.getLineMaxColumn(Math.min(60, model.getLineCount())) });

	return {
		uri: model.uri,
		languageId,
		prefix,
		suffix,
		linePrefix,
		lineSuffix,
		imports: extractImports(head),
		diagnostics,
		recentEdits,
		siblings,
		clipboard,
		modelVersionId: model.getVersionId(),
	};
}

function rangeFromOffsets(model: ITextModel, start: number, end: number) {
	const from = model.getPositionAt(start);
	const to = model.getPositionAt(end);
	return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
}
