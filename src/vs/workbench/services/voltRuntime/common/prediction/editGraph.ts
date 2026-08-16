/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orders parsed edits into an acceptance chain:
 *   1. edits in the current file, top-to-bottom (Tab walks down, ranges stay valid because
 *      each accepted edit only shifts lines below it);
 *   2. other files grouped together, each file's edits top-to-bottom.
 * Pure logic - tested without an editor.
 */

import { IRange } from '../../../../../editor/common/core/range.js';
import { IParsedEdit } from './multiEditParser.js';

export interface IOrderedEdits {
	/** Edits in the current file. First one is the primary prediction. */
	local: IParsedEdit[];
	/** Cross-file edits, grouped by path in first-seen order. */
	remote: IParsedEdit[];
}

function byPosition(a: IParsedEdit, b: IParsedEdit): number {
	return a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn;
}

export function orderEdits(edits: readonly IParsedEdit[], currentPath: string): IOrderedEdits {
	const local: IParsedEdit[] = [];
	const byFile = new Map<string, IParsedEdit[]>();
	for (const edit of edits) {
		if (samePath(edit.path, currentPath)) {
			local.push(edit);
		} else {
			const group = byFile.get(edit.path) ?? [];
			group.push(edit);
			byFile.set(edit.path, group);
		}
	}
	local.sort(byPosition);
	const remote: IParsedEdit[] = [];
	for (const group of byFile.values()) {
		group.sort(byPosition);
		remote.push(...group);
	}
	return { local, remote };
}

/** The model may echo an absolute path or a workspace-relative one; match on suffix. */
export function samePath(a: string, b: string): boolean {
	const na = normalize(a);
	const nb = normalize(b);
	return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

function normalize(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

/** Drops predictions that are not worth interrupting the user for. */
export function meetsConfidence(confidence: number, threshold = 0.3): boolean {
	return confidence >= threshold;
}

export interface IRangedEdit {
	range: IRange;
	replacement: string;
}

/** Net line growth an applied edit causes below itself. */
export function lineDelta(edit: IRangedEdit): number {
	const insertedLines = edit.replacement.split('\n').length - 1;
	const removedLines = edit.range.endLineNumber - edit.range.startLineNumber;
	return insertedLines - removedLines;
}

/**
 * After `accepted` is applied, queued edits strictly below it in the same file shift by its
 * line delta; edits above are untouched. (Edits never overlap - the parser rejects those.)
 */
export function shiftRangeAfterAccept(range: IRange, accepted: IRangedEdit): IRange {
	if (range.startLineNumber <= accepted.range.endLineNumber) {
		return range;
	}
	const delta = lineDelta(accepted);
	if (delta === 0) {
		return range;
	}
	return {
		startLineNumber: range.startLineNumber + delta,
		startColumn: range.startColumn,
		endLineNumber: range.endLineNumber + delta,
		endColumn: range.endColumn,
	};
}
