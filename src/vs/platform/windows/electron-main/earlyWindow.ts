/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as electron from 'electron';
import { EARLY_WINDOW_KEY, matchEarlyWebPreferences, matchEarlyWindowOptions } from '../common/earlyWindow.js';

/**
 * The launch window as the main entry (src/bootstrap-window.ts) published it. That file runs from another bundle, so
 * the two share this shape by convention, not by import.
 */
interface IEarlyWindowState {
	readonly win: electron.BrowserWindow;
	view: electron.WebContentsView | undefined;
	readonly channel: string;
	readonly url: string;
	readonly options: Record<string, unknown>;
	readonly webPreferences: Record<string, unknown>;
	failed: boolean;
	taken: boolean;
	releaseProtocols(): { resources: IEarlyProtocolRequest[]; files: IEarlyProtocolRequest[] };
	detach(): void;
	dispose(): void;
}

export interface IEarlyProtocolRequest {
	readonly request: electron.ProtocolRequest;
	readonly callback: (response: string | electron.ProtocolResponse) => void;
}

function earlyWindow(): IEarlyWindowState | undefined {
	return (globalThis as Record<string, unknown>)[EARLY_WINDOW_KEY] as IEarlyWindowState | undefined;
}

/** The configuration channel of the launch window's page, while it can still be adopted with its page. */
export function earlyWindowChannel(): string | undefined {
	const state = earlyWindow();
	if (!state || state.taken || state.failed || !state.view || state.win.isDestroyed() || state.view.webContents.isDestroyed()) {
		return undefined;
	}
	return state.channel;
}

export interface IAdoptedEarlyWindow {
	readonly win: electron.BrowserWindow;
	/** The view with the workbench page loading, when its preferences match. */
	readonly view: electron.WebContentsView | undefined;
	/** The page the view is loading (the window code skips loading it again). */
	readonly loadedUrl: string | undefined;
}

/**
 * Hands the launch window to the first code window when it was opened with the options that window would use. Options
 * a window can still take (colors, title, sizes, position) are applied; any other difference closes the launch window
 * and the caller creates its own. The page is kept only when the view's preferences match and it loads `url`.
 */
export function adoptEarlyWindow(options: electron.BrowserWindowConstructorOptions, url: string, trace: (message: string) => void): IAdoptedEarlyWindow | undefined {
	const state = earlyWindow();
	if (!state || state.taken) {
		return undefined;
	}
	state.taken = true;
	const { win } = state;
	if (win.isDestroyed()) {
		state.dispose();
		return undefined;
	}

	const actual = options as Record<string, unknown>;
	const match = matchEarlyWindowOptions(state.options, actual);
	if (!match.compatible) {
		trace(`window#ctor: launch window not used (options differ: ${match.conflicts.join(', ')})`);
		state.dispose();
		return undefined;
	}

	for (const key of match.changed) {
		const value = actual[key];
		switch (key) {
			case 'backgroundColor': if (typeof value === 'string') { win.setBackgroundColor(value); } break;
			case 'title': if (typeof value === 'string') { win.setTitle(value); } break;
			case 'minWidth':
			case 'minHeight': win.setMinimumSize(Number(actual.minWidth ?? 0), Number(actual.minHeight ?? 0)); break;
			case 'fullscreenable': win.setFullScreenable(value !== false); break;
		}
	}
	if (match.changed.some(key => key === 'x' || key === 'y' || key === 'width' || key === 'height')) {
		const { x, y, width, height } = options;
		const current = win.getBounds();
		win.setBounds({ x: x ?? current.x, y: y ?? current.y, width: width ?? current.width, height: height ?? current.height });
	}
	state.detach();

	let view = state.view;
	const pageUsable = !!view && !state.failed && !view.webContents.isDestroyed() && state.url === url
		&& matchEarlyWebPreferences(state.webPreferences, (options.webPreferences ?? {}) as Record<string, unknown>);
	if (view && !pageUsable) {
		trace('window#ctor: launch window page not used (preferences or page differ)');
		win.contentView.removeChildView(view);
		if (!view.webContents.isDestroyed()) {
			view.webContents.close();
		}
		view = undefined;
	} else if (view) {
		const zoomFactor = options.webPreferences?.zoomFactor;
		if (typeof zoomFactor === 'number' && view.webContents.getZoomFactor() !== zoomFactor) {
			view.webContents.setZoomFactor(zoomFactor);
		}
	}
	state.view = undefined;

	trace(`window#ctor: using the launch window${view ? ' and its page' : ''}`);
	return { win, view, loadedUrl: view ? state.url : undefined };
}

/** The protocol service calls this before registering its handlers: the launch window's handlers go away. */
export function releaseEarlyProtocols(): { resources: IEarlyProtocolRequest[]; files: IEarlyProtocolRequest[] } | undefined {
	return earlyWindow()?.releaseProtocols();
}

/** Closes the launch window when the first windows opened without it (a hidden window, or other options). */
export function disposeUnusedEarlyWindow(): void {
	const state = earlyWindow();
	if (state && !state.taken) {
		state.dispose();
	}
}
