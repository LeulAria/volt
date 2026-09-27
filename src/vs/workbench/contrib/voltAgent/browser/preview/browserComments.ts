/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Label painted on a pinned comment. The element chip is already on the page,
 * so the card shows the words the user typed.
 */
export function commentPreviewText(displayText: string, selectionLabel: string): string {
	const trimmed = displayText.replace(/\s+/g, ' ').trim();
	const label = selectionLabel.trim();
	if (!trimmed) {
		return label;
	}
	if (!label || trimmed === label) {
		return trimmed;
	}
	if (trimmed.startsWith(`${label} `)) {
		const rest = trimmed.slice(label.length).trim();
		return rest || trimmed;
	}
	return trimmed;
}
