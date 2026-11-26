/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';

/**
 * Room the main window's workbench leaves free along the page's edges: a phone's notch and home
 * indicator, and bars drawn outside the workbench (voltWebPhone.ts's bottom bar, voltPhoneKeys.ts's
 * key row above the keyboard). The layout sizes the workbench to the page less these and moves it
 * in by the top and left ones.
 */
export interface IWorkbenchLayoutInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

const NONE: IWorkbenchLayoutInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The safe areas and bottom bar (setWorkbenchLayoutInsets). */
let base: IWorkbenchLayoutInsets = NONE;
/** More room on top of the base, by who asked for it (setWorkbenchLayoutInset). */
const extra = new Map<string, IWorkbenchLayoutInsets>();
let current: IWorkbenchLayoutInsets = NONE;
const onDidChangeEmitter = new Emitter<void>();

/** Fired when the insets change; the layout lays the workbench out again. */
export const onDidChangeWorkbenchLayoutInsets: Event<void> = onDidChangeEmitter.event;

/** The base insets plus every reservation. */
export function getWorkbenchLayoutInsets(): IWorkbenchLayoutInsets {
	return current;
}

/** The page's own insets (safe areas, the bottom bar); reservations stay on top of them. */
export function setWorkbenchLayoutInsets(insets: IWorkbenchLayoutInsets | undefined): void {
	base = insets ? normalize(insets) : NONE;
	update();
}

/**
 * Keeps more room free for `source` on top of the base insets (a bar that shows for a while, like
 * the key row above a phone's keyboard); `undefined` gives it back.
 */
export function setWorkbenchLayoutInset(source: string, edges: Partial<IWorkbenchLayoutInsets> | undefined): void {
	const next = edges ? normalize({ top: edges.top ?? 0, right: edges.right ?? 0, bottom: edges.bottom ?? 0, left: edges.left ?? 0 }) : undefined;
	if (next && !same(next, NONE)) {
		extra.set(source, next);
	} else {
		extra.delete(source);
	}
	update();
}

function update(): void {
	let { top, right, bottom, left } = base;
	for (const edges of extra.values()) {
		top += edges.top;
		right += edges.right;
		bottom += edges.bottom;
		left += edges.left;
	}
	const next = { top, right, bottom, left };
	if (same(next, current)) {
		return;
	}
	current = next;
	onDidChangeEmitter.fire();
}

function normalize(insets: IWorkbenchLayoutInsets): IWorkbenchLayoutInsets {
	return {
		top: Math.max(0, Math.round(insets.top)),
		right: Math.max(0, Math.round(insets.right)),
		bottom: Math.max(0, Math.round(insets.bottom)),
		left: Math.max(0, Math.round(insets.left)),
	};
}

function same(a: IWorkbenchLayoutInsets, b: IWorkbenchLayoutInsets): boolean {
	return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}
