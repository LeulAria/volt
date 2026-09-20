/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parses the structured next-edit / multi-edit JSON a model returns for
 * {@link buildNextEditPrompt}. Strict: anything malformed is rejected rather than guessed,
 * because the output becomes real text edits.
 */

import { stripFences } from './postProcess.js';

export interface IParsedEdit {
	/** Path exactly as the model returned it; the browser layer resolves it to a URI. */
	path: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	replacement: string;
	reason?: string;
}

export interface IParsedPrediction {
	confidence: number;
	edits: IParsedEdit[];
}

function asPositiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parseEdit(raw: unknown): IParsedEdit | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const path = typeof o.path === 'string' ? o.path.trim() : '';
	const startLineNumber = asPositiveInt(o.startLine);
	const startColumn = asPositiveInt(o.startColumn);
	const endLineNumber = asPositiveInt(o.endLine);
	const endColumn = asPositiveInt(o.endColumn);
	if (!path || path.includes('..') || startLineNumber === undefined || startColumn === undefined || endLineNumber === undefined || endColumn === undefined) {
		return undefined;
	}
	if (endLineNumber < startLineNumber || (endLineNumber === startLineNumber && endColumn < startColumn)) {
		return undefined;
	}
	if (typeof o.replacement !== 'string') {
		return undefined;
	}
	return {
		path,
		startLineNumber,
		startColumn,
		endLineNumber,
		endColumn,
		replacement: o.replacement,
		reason: typeof o.reason === 'string' ? o.reason : undefined,
	};
}

function overlapsSameFile(a: IParsedEdit, b: IParsedEdit): boolean {
	if (a.path !== b.path) {
		return false;
	}
	const aEndsBeforeB = a.endLineNumber < b.startLineNumber || (a.endLineNumber === b.startLineNumber && a.endColumn <= b.startColumn);
	const bEndsBeforeA = b.endLineNumber < a.startLineNumber || (b.endLineNumber === a.startLineNumber && b.endColumn <= a.startColumn);
	return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * Returns undefined for non-JSON garbage (caller escalates or drops). A valid envelope
 * with malformed/overlapping entries keeps only the well-formed, non-overlapping ones.
 */
export function parseMultiEdit(raw: string): IParsedPrediction | undefined {
	const text = stripFences(raw.trim());
	// Some models wrap JSON in prose; take the outermost object.
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).edits)) {
		return undefined;
	}
	const envelope = parsed as { confidence?: unknown; edits: unknown[] };
	const confidence = typeof envelope.confidence === 'number' ? Math.max(0, Math.min(1, envelope.confidence)) : 0.5;

	const edits: IParsedEdit[] = [];
	for (const raw of envelope.edits) {
		const edit = parseEdit(raw);
		if (!edit) {
			continue;
		}
		if (edits.some(existing => overlapsSameFile(existing, edit))) {
			continue;
		}
		edits.push(edit);
	}
	return { confidence, edits };
}
