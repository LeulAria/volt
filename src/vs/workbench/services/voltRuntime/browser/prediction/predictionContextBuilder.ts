/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IPredictionContext, IRecentEdit, ISiblingExcerpt } from '../../common/prediction.js';
import { DEFAULT_EXCERPT_BUDGET, extractExcerpt, extractImports, truncateSnippet } from '../../common/prediction/contextWindow.js';

const DIAGNOSTIC_LINE_RADIUS = 20;
const SIBLING_EXCERPT_CHARS = 1200;
const MAX_SIBLINGS = 3;

/**
 * Assembles the D24 minimal prediction context from the live editor state:
 * excerpt + imports + nearby diagnostics + recent edits + open same-language siblings.
 */
export function buildPredictionContext(
	model: ITextModel,
	position: Position,
	markerService: IMarkerService,
	modelService: IModelService,
	recentEdits: IRecentEdit[],
	clipboard?: string,
): IPredictionContext {
	const text = model.getValue();
	const offset = model.getOffsetAt(position);
	const { prefix, suffix } = extractExcerpt(text, offset, DEFAULT_EXCERPT_BUDGET);

	const lineContent = model.getLineContent(position.lineNumber);
	const linePrefix = lineContent.slice(0, position.column - 1);
	const lineSuffix = lineContent.slice(position.column - 1);

	const diagnostics = markerService.read({ resource: model.uri })
		.filter(m => m.severity >= MarkerSeverity.Warning
			&& Math.abs(m.startLineNumber - position.lineNumber) <= DIAGNOSTIC_LINE_RADIUS)
		.slice(0, 6)
		.map(m => `${m.startLineNumber}:${m.startColumn} ${MarkerSeverity.toString(m.severity)} ${m.message}`);

	const languageId = model.getLanguageId();
	const siblings: ISiblingExcerpt[] = modelService.getModels()
		.filter(candidate => candidate !== model
			&& candidate.getLanguageId() === languageId
			&& candidate.uri.scheme === model.uri.scheme
			&& candidate.isAttachedToEditor())
		.slice(0, MAX_SIBLINGS)
		.map(candidate => ({
			path: candidate.uri.path,
			excerpt: truncateSnippet(candidate.getValue(), SIBLING_EXCERPT_CHARS),
		}));

	return {
		uri: model.uri,
		languageId,
		prefix,
		suffix,
		linePrefix,
		lineSuffix,
		imports: extractImports(text),
		diagnostics,
		recentEdits,
		siblings,
		clipboard,
		modelVersionId: model.getVersionId(),
	};
}
