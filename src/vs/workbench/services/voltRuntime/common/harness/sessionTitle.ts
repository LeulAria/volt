/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session title as a log-only projection (DeepSeek). Never model-visible.
 * Deterministic: first user prompt, slash stripped, word-bounded, 60 chars.
 */

const MAX = 60;

export function titleFrom(text: string): string {
	const stripped = text.replace(/^\s*\/[a-z][\w-]*\s*/i, '').replace(/\s+/g, ' ').trim();
	if (!stripped) {
		return 'New chat';
	}
	if (stripped.length <= MAX) {
		return stripped;
	}
	const slice = stripped.slice(0, MAX);
	const cut = slice.lastIndexOf(' ');
	return `${(cut > 24 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}
