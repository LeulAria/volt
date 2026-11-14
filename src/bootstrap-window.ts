/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt: the launch window (see vs/platform/windows/common/earlyWindow.ts). This file runs in the main entry, before
// the main bundle loads, so it imports only Electron, Node and that file's pure rules.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, ipcMain, session, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type ProtocolRequest, type ProtocolResponse, type WebPreferences } from 'electron';
import { EARLY_IPC_KEY, EARLY_PAGE_FRAGMENT, EARLY_SNAPSHOT_CHANNEL, EARLY_WINDOW_HINT_FILE, EARLY_WINDOW_KEY, IEarlyWindowBounds, IEarlyWindowHint, isPlainLaunch, lastWindowBounds, parseEarlyWindowHint } from './vs/platform/windows/common/earlyWindow.js';

/** The IPC channels the page calls before the window code exists: its configuration and the shell environment. */
const SHELL_ENV_CHANNEL = 'vscode:fetchShellEnv';

// Same values as `DocumentPolicyheaders` and `CacheControlheaders` in vs/base/common/network.ts (not imported here:
// it would pull URI and path code into the main entry).
const DOCUMENT_POLICY_HEADERS = { 'Document-Policy': 'include-js-call-stacks-in-crash-reports' };
const CACHE_CONTROL_HEADERS = { 'Cache-Control': 'no-cache, no-store' };

export interface IEarlyWindowPlan {
	readonly hint: IEarlyWindowHint;
	readonly bounds: IEarlyWindowBounds;
	readonly appRoot: string;
	readonly userDataPath: string;
}

/** Same limit as the snapshot store's (MAX_WINDOW_SNAPSHOT_BYTES): a larger file is never painted. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

interface IPendingInvoke {
	readonly event: IpcMainInvokeEvent;
	readonly args: unknown[];
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

interface IPendingRequest {
	readonly request: ProtocolRequest;
	readonly callback: (response: string | ProtocolResponse) => void;
}

/** Shape published on `globalThis[EARLY_WINDOW_KEY]` (read by vs/platform/windows/electron-main/earlyWindow.ts). */
export interface IEarlyWindowState {
	readonly win: BrowserWindow;
	view: WebContentsView | undefined;
	readonly channel: string;
	readonly url: string;
	readonly options: Record<string, unknown>;
	readonly webPreferences: Record<string, unknown>;
	/** The page failed to load or its process went away before the window code took it. */
	failed: boolean;
	taken: boolean;
	/** Hands the `vscode-file:` and `file:` protocols over: the early handlers go, queued requests are returned. */
	releaseProtocols(): { resources: IPendingRequest[]; files: IPendingRequest[] };
	/** Stops tracking the window's layout (the window code does it from now on). */
	detach(): void;
	/** Closes the window and its page (nothing took it). */
	dispose(): void;
}

/**
 * Decides, before Electron is ready, whether this launch opens the launch window: a plain launch on macOS, no other
 * instance running for this profile, a hint written by this same build, and a last window left in the normal mode.
 */
export function planEarlyWindow(input: { userDataPath: string; appRoot: string; commit: string | null; args: Record<string, unknown>; positional: readonly string[] }): IEarlyWindowPlan | undefined {
	try {
		if (process.platform !== 'darwin' || !isPlainLaunch(input.args, input.positional)) {
			return undefined;
		}
		if (isOtherInstanceRunning(input.userDataPath)) {
			return undefined; // this launch hands its arguments to the running instance and quits
		}
		const hint = parseEarlyWindowHint(fs.readFileSync(path.join(input.userDataPath, EARLY_WINDOW_HINT_FILE), 'utf8'), { commit: input.commit, appRoot: input.appRoot });
		if (!hint) {
			return undefined;
		}
		const bounds = lastWindowBounds(fs.readFileSync(path.join(input.userDataPath, 'User', 'globalStorage', 'storage.json'), 'utf8'));
		if (!bounds) {
			return undefined;
		}
		return { hint, bounds, appRoot: input.appRoot, userDataPath: input.userDataPath };
	} catch {
		return undefined; // no hint yet, or unreadable: the normal path
	}
}

function isOtherInstanceRunning(userDataPath: string): boolean {
	let pid: number;
	try {
		pid = Number(fs.readFileSync(path.join(userDataPath, 'code.lock'), 'utf8').trim());
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Opens the launch window at `ready`: the window, its view, and the workbench page loading in it. The page paints the
 * picture of the window's last screen at once and waits for its configuration, which the window code serves when it
 * adopts the window. Resolves when the page has its files (it asked for the picture) or can no longer ask.
 */
export function openEarlyWindow(plan: IEarlyWindowPlan): Promise<void> {
	const { hint, bounds, appRoot } = plan;
	const channel = `vscode:${randomUUID()}`;

	const options: Record<string, unknown> = { ...hint.options, ...bounds };
	const windowOptions: BrowserWindowConstructorOptions = { ...options, show: true, webPreferences: { sandbox: true } };
	const win = new BrowserWindow(windowOptions);

	const webPreferences: WebPreferences = { ...hint.webPreferences, additionalArguments: [`--vscode-window-config=${channel}`] };
	const view = new WebContentsView({ webPreferences });
	if (typeof hint.options.backgroundColor === 'string') {
		view.setBackgroundColor(hint.options.backgroundColor);
	}
	win.contentView.addChildView(view);
	const layout = () => {
		if (!win.isDestroyed()) {
			const { width, height } = win.getContentBounds();
			view.setBounds({ x: 0, y: 0, width, height });
		}
	};
	layout();
	win.on('resize', layout);

	// Requests for the page's own files are served at once; anything else waits for the protocol service.
	const resources: IPendingRequest[] = [];
	const files: IPendingRequest[] = [];
	const protocol = session.defaultSession.protocol;
	protocol.registerFileProtocol('vscode-file', (request, callback) => {
		const filePath = appFilePath(request.url, appRoot);
		if (filePath) {
			const isPage = /[\\/]workbench(-dev)?\.html$/.test(filePath);
			callback({ path: filePath, headers: { ...(isPage ? DOCUMENT_POLICY_HEADERS : undefined), ...(process.env['VSCODE_DEV'] ? CACHE_CONTROL_HEADERS : undefined) } });
		} else {
			resources.push({ request, callback });
		}
	});
	protocol.interceptFileProtocol('file', (request, callback) => files.push({ request, callback }));
	let protocolsReleased = false;
	const releaseProtocols = () => {
		if (!protocolsReleased) {
			protocolsReleased = true;
			protocol.unregisterProtocol('vscode-file');
			protocol.uninterceptProtocol('file');
		}
		return { resources: resources.splice(0), files: files.splice(0) };
	};

	// The page asks for its configuration and the shell environment as soon as its preload runs.
	const early = holdIpcChannels([channel, SHELL_ENV_CHANNEL]);

	// The page's startup script asks for the picture of the window's last screen (once): by then it has its files.
	let pageStarted!: () => void;
	const whenPageStarted = new Promise<void>(resolve => pageStarted = resolve);
	let snapshotHandled = false;
	const stopServingSnapshot = () => {
		if (!snapshotHandled) {
			snapshotHandled = true;
			ipcMain.removeHandler(EARLY_SNAPSHOT_CHANNEL);
		}
		pageStarted();
	};
	ipcMain.handle(EARLY_SNAPSHOT_CHANNEL, event => {
		if (event.sender !== view.webContents) {
			return undefined;
		}
		stopServingSnapshot();
		return readSnapshot(plan);
	});

	const state: IEarlyWindowState = {
		win,
		view,
		channel,
		url: hint.url,
		options,
		webPreferences: hint.webPreferences,
		failed: false,
		taken: false,
		releaseProtocols,
		detach: () => win.removeListener('resize', layout),
		dispose: () => {
			state.taken = true;
			win.removeListener('resize', layout);
			early.dispose();
			stopServingSnapshot();
			if (!view.webContents.isDestroyed()) {
				view.webContents.close();
			}
			if (!win.isDestroyed()) {
				win.destroy();
			}
		}
	};
	const fail = () => {
		state.failed = true;
		pageStarted();
	};
	view.webContents.once('did-fail-load', fail);
	view.webContents.once('render-process-gone', fail);
	(globalThis as Record<string, unknown>)[EARLY_WINDOW_KEY] = state;

	// The fragment tells the page it is the launch window's (the window code compares and reloads the URL without it).
	view.webContents.loadURL(`${hint.url}#${EARLY_PAGE_FRAGMENT}`);
	return whenPageStarted;
}

/** The stored picture of the window's last screen (JSON), when the hint names one. */
function readSnapshot(plan: IEarlyWindowPlan): string | undefined {
	if (!plan.hint.snapshotFile) {
		return undefined;
	}
	try {
		const data = fs.readFileSync(path.join(plan.userDataPath, 'VoltWindowSnapshots', plan.hint.snapshotFile), 'utf8');
		return data.length <= MAX_SNAPSHOT_BYTES ? data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Holds `ipcMain.handle` channels until their real handlers are registered (vs/base/parts/ipc/electron-main/ipcMain.ts
 * hands the waiting calls to them).
 */
function holdIpcChannels(channels: string[]): { dispose(): void } {
	const held = new Map<string, IPendingInvoke[]>();
	for (const channel of channels) {
		const pending: IPendingInvoke[] = [];
		held.set(channel, pending);
		ipcMain.handle(channel, (event, ...args) => new Promise((resolve, reject) => pending.push({ event, args, resolve, reject })));
	}
	(globalThis as Record<string, unknown>)[EARLY_IPC_KEY] = held;
	return {
		dispose: () => {
			for (const [channel, pending] of held) {
				ipcMain.removeHandler(channel);
				for (const call of pending.splice(0)) {
					call.reject(new Error('The launch window was closed.'));
				}
			}
			held.clear();
		}
	};
}

/** The file a `vscode-file://vscode-app/<path>` URL names, when it lies inside the app. */
function appFilePath(url: string, appRoot: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.host !== 'vscode-app') {
		return undefined;
	}
	const filePath = path.normalize(decodeURIComponent(parsed.pathname));
	const root = appRoot.endsWith(path.sep) ? appRoot : appRoot + path.sep;
	return filePath.startsWith(root) ? filePath : undefined;
}
