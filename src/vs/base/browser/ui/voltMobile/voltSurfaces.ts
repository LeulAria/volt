/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The sheets and pages open on a phone, in the order they opened. The top one takes Escape and the
// system Back (Android's back button and gesture, the browser's Back): each open surface pushes a
// history entry, so Back closes it instead of leaving the workbench. Each one stacks above the last.

import { addDisposableListener } from '../../dom.js';
import { mainWindow } from '../../window.js';
import { DisposableStore, IDisposable } from '../../../common/lifecycle.js';

export interface IVoltSurface {
	/** Closes the surface because the user went back (system Back, Escape). */
	dismiss(): void;
	/** False when the surface refuses Back (a sheet that must be answered). */
	readonly dismissible: boolean;
}

export interface IVoltSurfaceEntry extends IDisposable {
	/** The stacking order for this surface's layer. */
	readonly zIndex: number;
	/** True while no surface opened after this one is still open. */
	isTop(): boolean;
}

/** Above the workbench's own overlays (context views 2500, dialogs 2600, quick input 2550). */
const BASE_Z_INDEX = 2700;
const HISTORY_KEY = 'voltSurface';

interface IStackEntry {
	readonly surface: IVoltSurface;
	readonly id: number;
	/** This entry pushed a history state that is still on the history stack. */
	pushed: boolean;
}

const stack: IStackEntry[] = [];
let nextId = 1;
/** History moves we started (to drop our entry after a close in the UI); their popstate is ours, not the user's. */
let ownPops = 0;
let listeners: DisposableStore | undefined;

function install(): void {
	if (listeners) {
		return;
	}
	listeners = new DisposableStore();
	listeners.add(addDisposableListener(mainWindow, 'popstate', () => {
		if (ownPops > 0) {
			ownPops--;
			return;
		}
		const top = stack[stack.length - 1];
		if (!top) {
			return;
		}
		// The browser already left the entry this surface pushed.
		top.pushed = false;
		if (top.surface.dismissible) {
			top.surface.dismiss();
		} else {
			pushHistory(top);
		}
	}));
	listeners.add(addDisposableListener(mainWindow, 'keydown', (e: KeyboardEvent) => {
		const top = stack[stack.length - 1];
		if (e.key === 'Escape' && top?.surface.dismissible) {
			e.preventDefault();
			e.stopPropagation();
			top.surface.dismiss();
		}
	}, true));
}

function pushHistory(entry: IStackEntry): void {
	try {
		mainWindow.history.pushState({ ...(mainWindow.history.state ?? {}), [HISTORY_KEY]: entry.id }, '');
		entry.pushed = true;
	} catch {
		// A sandboxed frame can refuse history; Escape and the UI still close the surface.
	}
}

/** Puts a surface on the stack; disposing the entry takes it off (and drops its history entry). */
export function openVoltSurface(surface: IVoltSurface): IVoltSurfaceEntry {
	install();
	const entry: IStackEntry = { surface, id: nextId++, pushed: false };
	stack.push(entry);
	pushHistory(entry);
	const zIndex = BASE_Z_INDEX + stack.length * 2;
	let disposed = false;
	return {
		zIndex,
		isTop: () => stack[stack.length - 1] === entry,
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			const index = stack.indexOf(entry);
			if (index >= 0) {
				stack.splice(index, 1);
			}
			// Closed in the UI: step back over our entry when it is the current one, so Back keeps working.
			if (entry.pushed && (mainWindow.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] === entry.id) {
				ownPops++;
				mainWindow.history.back();
			}
			entry.pushed = false;
		},
	};
}

/** How many surfaces are open (0 when none). */
export function openVoltSurfaceCount(): number {
	return stack.length;
}

/** Closes every open surface, newest first (a navigation that leaves them all behind). */
export function dismissAllVoltSurfaces(): void {
	for (let i = stack.length - 1; i >= 0; i--) {
		stack[i]?.surface.dismiss();
	}
}

/** For tests: forget the stack and the listeners. */
export function resetVoltSurfacesForTesting(): void {
	stack.length = 0;
	ownPops = 0;
	listeners?.dispose();
	listeners = undefined;
}
