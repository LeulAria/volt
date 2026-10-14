/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { screen, type BrowserWindow, type Rectangle } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface IWindowState {
	readonly bounds: Partial<Rectangle> & { width: number; height: number };
	readonly maximized: boolean;
}

const DEFAULT_STATE: IWindowState = { bounds: { width: 1280, height: 820 }, maximized: false };

function stateFile(userDataDir: string): string {
	return path.join(userDataDir, 'window-state.json');
}

/** The last window bounds, if they still fit on a connected display. */
export function loadWindowState(userDataDir: string): IWindowState {
	try {
		const state = JSON.parse(fs.readFileSync(stateFile(userDataDir), 'utf8')) as IWindowState;
		const { x, y, width, height } = state.bounds;
		if (typeof x !== 'number' || typeof y !== 'number' || !(width > 0) || !(height > 0)) {
			return DEFAULT_STATE;
		}
		const visible = screen.getAllDisplays().some(({ workArea }) =>
			x < workArea.x + workArea.width && x + width > workArea.x && y < workArea.y + workArea.height && y + height > workArea.y);
		return visible ? state : DEFAULT_STATE;
	} catch {
		return DEFAULT_STATE;
	}
}

export function trackWindowState(win: BrowserWindow, userDataDir: string): void {
	let timer: NodeJS.Timeout | undefined;
	const save = () => {
		if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) {
			return;
		}
		const state: IWindowState = { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() };
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.writeFileSync(stateFile(userDataDir), JSON.stringify(state));
	};
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(save, 300);
	};
	win.on('resize', schedule);
	win.on('move', schedule);
	win.on('maximize', save);
	win.on('unmaximize', save);
	win.on('close', () => {
		clearTimeout(timer);
		save();
	});
}
