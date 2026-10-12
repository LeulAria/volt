/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "Add to Chat" from the explorer, the editor and search: text goes into the composer the user
 * last typed in (the agent panel's, or the chat tab's), or the first one on screen.
 */

type Inserter = (text: string) => void;

const composers: { readonly id: number; readonly insert: Inserter }[] = [];
let lastFocused: number | undefined;
let nextId = 1;

export function registerComposer(insert: Inserter): { readonly id: number; readonly focused: () => void; readonly dispose: () => void } {
	const id = nextId++;
	composers.push({ id, insert });
	return {
		id,
		focused: () => {
			lastFocused = id;
		},
		dispose: () => {
			const index = composers.findIndex(c => c.id === id);
			if (index >= 0) {
				composers.splice(index, 1);
			}
			if (lastFocused === id) {
				lastFocused = undefined;
			}
		},
	};
}

export function insertIntoComposer(text: string): boolean {
	const target = composers.find(c => c.id === lastFocused) ?? composers[composers.length - 1];
	if (!target) {
		return false;
	}
	target.insert(text);
	return true;
}
