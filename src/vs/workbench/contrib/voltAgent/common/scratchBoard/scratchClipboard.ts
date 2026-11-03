/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseElement } from './scratchDocument.js';
import { ScratchElement } from './scratchTypes.js';

/** The `type` of the JSON a board puts on the clipboard (Excalidraw's is `excalidraw/clipboard`). */
export const SCRATCH_CLIPBOARD_TYPE = 'volt-scratch/clipboard';

/** The page-private clipboard format a copy event carries that JSON in; other apps get words. */
export const SCRATCH_CLIPBOARD_MIME = 'application/x-volt-scratch';

/** Copied elements as clipboard JSON. Pasting gives them fresh ids (see `duplicateElements`). */
export function serializeScratchClipboard(elements: readonly ScratchElement[]): string {
	return JSON.stringify({ type: SCRATCH_CLIPBOARD_TYPE, version: 1, elements });
}

/**
 * Elements from a board's clipboard JSON, validated like a saved board; undefined when the text
 * is not ours (any other text pastes as text).
 */
export function parseScratchClipboard(text: string | undefined): ScratchElement[] | undefined {
	if (!text || !text.trimStart().startsWith('{')) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const { type, elements } = parsed as { type?: unknown; elements?: unknown };
	if (type !== SCRATCH_CLIPBOARD_TYPE || !Array.isArray(elements)) {
		return undefined;
	}
	const out = elements.map(item => parseElement(item)).filter((el): el is ScratchElement => !!el);
	return out.length ? out : undefined;
}
