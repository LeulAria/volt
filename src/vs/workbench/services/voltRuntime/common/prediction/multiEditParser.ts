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
import { CURSOR_MARKER } from './predictionPrompt.js';

export interface IParsedEdit {
	/** Path exactly as the model returned it; the browser layer resolves it to a URI. */
	path: string;
	/**
	 * Text the edit replaces, copied from the file. When present it decides where the edit goes
	 * and the positions below are 0 until the edit is located in the file.
	 */
	find?: string;
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
	if (typeof o.find === 'string') {
		const replacement = typeof o.replace === 'string' ? o.replace : o.replacement;
		if (!path || path.includes('..') || !o.find.trim() || typeof replacement !== 'string' || replacement === o.find) {
			return undefined;
		}
		return {
			path,
			find: stripMarker(o.find),
			startLineNumber: 0,
			startColumn: 0,
			endLineNumber: 0,
			endColumn: 0,
			replacement: stripMarker(replacement),
			reason: typeof o.reason === 'string' ? o.reason : undefined,
		};
	}
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

/** Models copy the cursor marker out of the excerpt into anchors now and then. */
function stripMarker(text: string): string {
	return text.split(CURSOR_MARKER).join('');
}

function overlapsSameFile(a: IParsedEdit, b: IParsedEdit): boolean {
	if (a.path !== b.path) {
		return false;
	}
	if (a.find !== undefined || b.find !== undefined) {
		// Located later; two edits of the same text are one edit.
		return a.find === b.find;
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
