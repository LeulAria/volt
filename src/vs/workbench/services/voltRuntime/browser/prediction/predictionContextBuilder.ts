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
import { queryTerms } from '../../common/prediction/retrieval.js';
import { WorkspaceContextIndex } from './workspaceContextIndex.js';

const DIAGNOSTIC_LINE_RADIUS = 20;
const SIBLING_SNIPPET_CHARS = 600;
const MAX_SIBLINGS = 3;
/** Larger files are skipped as siblings: scanning them would sit on the keystroke path. */
const MAX_SIBLING_SCAN_CHARS = 400_000;
/** Ghost text: what the workspace index may add to a prompt. NES and AI Edit get more. */
const INLINE_RELATED_CHARS = 1_000;
const INLINE_DEFINITION_CHARS = 700;
const FULL_RELATED_CHARS = 1_800;
const FULL_DEFINITION_CHARS = 1_000;

/** Where the richer context comes from, when the caller has it. */
export interface IPredictionEnrichment {
	readonly index?: WorkspaceContextIndex;
	/** Recent terminal failures that name one of `terms` (the names around the cursor). */
	readonly running?: (terms: ReadonlyMap<string, number>) => string[];
	/** Files never shown to the model (secrets, lockfiles). */
	readonly excludedGlobs?: readonly string[];
	/** Ghost text: smaller related-code budgets. */
	readonly inline?: boolean;
}

/**
 * The part of the context every keystroke needs: the excerpt around the cursor and the cursor's
 * line. Enough to answer from caches and the local predictor; no diagnostics, files or index.
 */
export function buildExcerptContext(
	model: ITextModel,
	position: Position,
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
	return {
		uri: model.uri,
		languageId: model.getLanguageId(),
		prefix,
		suffix,
		linePrefix: lineContent.slice(0, position.column - 1),
		lineSuffix: lineContent.slice(position.column - 1),
		imports: '',
		diagnostics: [],
		recentEdits,
		siblings: [],
		clipboard,
		modelVersionId: model.getVersionId(),
		excerptLines: {
			start: position.lineNumber - countNewlines(prefix),
			end: position.lineNumber + countNewlines(suffix),
		},
	};
}

/**
 * Adds what a model request needs to an excerpt context: nearby diagnostics, the imports (when
 * the excerpt does not show them), and from the workspace index the code most like the cursor's
 * and the declarations of the names it uses; without an index, the lines of open same-language
 * files that mention those names.
 */
export function enrichPredictionContext(
	ctx: IPredictionContext,
	model: ITextModel,
	position: Position,
	markerService: IMarkerService,
	modelService: IModelService,
	enrichment: IPredictionEnrichment = {},
): IPredictionContext {
	const diagnostics = markerService.read({ resource: model.uri })
		.filter(m => m.severity >= MarkerSeverity.Warning
			&& Math.abs(m.startLineNumber - position.lineNumber) <= DIAGNOSTIC_LINE_RADIUS)
		.slice(0, 6)
		.map(m => `${m.startLineNumber}:${m.startColumn} ${MarkerSeverity.toString(m.severity)} ${m.message}`);

	const excerpt = ctx.excerptLines ?? { start: position.lineNumber, end: position.lineNumber };
	let imports = '';
	if (excerpt.start > 1) {
		const headEnd = Math.min(60, model.getLineCount());
		imports = extractImports(model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: headEnd, endColumn: model.getLineMaxColumn(headEnd) }));
	}

	let siblings: ISiblingExcerpt[];
	let definitions: string[] | undefined;
	let running: string[] | undefined;
	if (enrichment.index) {
		const terms = queryTerms(ctx.prefix, ctx.linePrefix, ctx.suffix);
		const found = enrichment.index.query(model, terms, excerpt, {
			related: enrichment.inline ? INLINE_RELATED_CHARS : FULL_RELATED_CHARS,
			definitions: enrichment.inline ? INLINE_DEFINITION_CHARS : FULL_DEFINITION_CHARS,
		}, enrichment.excludedGlobs ?? []);
		siblings = found.related;
		definitions = found.definitions.length ? found.definitions : undefined;
		const failures = enrichment.running?.(terms);
		running = failures?.length ? failures : undefined;
	} else {
		siblings = openSiblings(model, modelService, cursorIdentifiers(ctx.prefix, ctx.linePrefix));
	}

	return { ...ctx, imports, diagnostics, siblings, definitions, running };
}

/**
 * The full context in one step: excerpt, diagnostics, imports, related code. Used where a model
 * request is certain (next-edit, AI Edit).
 */
export function buildPredictionContext(
	model: ITextModel,
	position: Position,
	markerService: IMarkerService,
	modelService: IModelService,
	recentEdits: IRecentEdit[],
	clipboard?: string,
	budget: IExcerptBudget = DEFAULT_EXCERPT_BUDGET,
	enrichment?: IPredictionEnrichment,
): IPredictionContext {
	const ctx = buildExcerptContext(model, position, recentEdits, clipboard, budget);
	return enrichPredictionContext(ctx, model, position, markerService, modelService, enrichment);
}

/** The lines of open same-language files that mention `identifiers` (no index at hand). */
function openSiblings(model: ITextModel, modelService: IModelService, identifiers: string[]): ISiblingExcerpt[] {
	const languageId = model.getLanguageId();
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
	return siblings;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
		count++;
	}
	return count;
}

function rangeFromOffsets(model: ITextModel, start: number, end: number) {
	const from = model.getPositionAt(start);
	const to = model.getPositionAt(end);
	return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
}
