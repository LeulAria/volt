/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt Agents: a standalone window onto the Volt agent server. It finds the profile's server (or
// starts it with the same launcher Volt uses) and shows the Volt web app in a native window. Tasks
// started here run on the shared server, so Volt, the web app and the phone see them too.

import { app, BrowserWindow, dialog, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import { homedir } from 'os';
import * as path from 'path';
import { AgentServerLauncher } from '../../../src/vs/platform/voltAgentServer/node/agentServerLauncher.js';
import { IVoltAgentServerEndpoint } from '../../../src/vs/platform/voltAgentServer/common/agentServerService.js';
import { isSameOriginNavigation, parseSafeExternalUrl, retryDelay } from './navigation.js';
import { loadWindowState, trackWindowState } from './windowState.js';

const APP_NAME = 'Volt Agents';

/** Command-line flag or environment variable, flag first. */
function setting(flag: string, env: string): string | undefined {
	const prefix = `--${flag}=`;
	const arg = process.argv.find(value => value.startsWith(prefix));
	return arg ? arg.slice(prefix.length) : process.env[env] || undefined;
}

/** The Volt build whose server this app talks to. In a checkout that is the checkout itself. */
const appRoot = path.resolve(setting('volt-app-root', 'VOLT_APP_ROOT') ?? path.join(__dirname, '..', '..', '..'));
/** Unpackaged, Volt runs "out of sources": profile `code-oss-dev`, like `./scripts/code.sh`. */
const fromSources = !app.isPackaged && !setting('volt-app-root', 'VOLT_APP_ROOT');
if (fromSources) {
	process.env['VSCODE_DEV'] = '1';
}

/** The same folder Volt resolves (userDataPath.ts), so both connect to one server. */
function voltUserDataDir(): string {
	const explicit = setting('volt-user-data-dir', 'VOLT_USER_DATA_DIR');
	if (explicit) {
		return path.resolve(explicit);
	}
	const productName = fromSources ? 'code-oss-dev' : 'VOLT';
	switch (process.platform) {
		case 'darwin': return path.join(homedir(), 'Library', 'Application Support', productName);
		case 'win32': return path.join(process.env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming'), productName);
		default: return path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config'), productName);
	}
}

const serverUserDataDir = voltUserDataDir();
// This app's own Chromium profile, next to (never inside) Volt's, one per server profile.
app.setName(APP_NAME);
app.setPath('userData', `${serverUserDataDir}-agents`);

const launcher = new AgentServerLauncher({
	userDataDir: serverUserDataDir,
	appRoot,
	// Electron as Node runs the server; the checkout's Electron is the version Volt is built for.
	electronPath: setting('volt-electron', 'VOLT_ELECTRON') ?? process.execPath,
	log: message => console.log(message),
});

const iconPath = path.join(__dirname, 'resources', 'icon.png');
let mainWindow: BrowserWindow | undefined;
let endpoint: IVoltAgentServerEndpoint | undefined;

function openExternal(url: string): void {
	const safe = parseSafeExternalUrl(url);
	if (safe) {
		void shell.openExternal(safe);
	}
}

/** Consecutive failed loads; reset once the page loads. */
let failedLoads = 0;

const WATCHDOG_MS = 5_000;

/**
 * The page reconnects to the server on its own, but nothing restarts a server that died (crashed,
 * killed, or stopped by another client). While a window is open, bring it back as Volt does.
 */
function watchServer(win: BrowserWindow): void {
	let busy = false;
	const timer = setInterval(async () => {
		if (busy || !endpoint || win.isDestroyed()) {
			return;
		}
		busy = true;
		try {
			if (!await launcher.current()) {
				console.log('[volt agents] the agent server is gone; starting it again');
				const next = await launcher.ensureRunning();
				// Same profile, same port: the page's own reconnect picks it up. A new port needs a reload.
				if (next.port !== endpoint.port) {
					endpoint = next;
					await win.loadURL(next.webUrl);
				}
				endpoint = next;
			}
		} catch (error) {
			console.error('[volt agents] could not restart the agent server', error);
		} finally {
			busy = false;
		}
	}, WATCHDOG_MS);
	win.on('closed', () => clearInterval(timer));
}

async function loadServer(win: BrowserWindow, restart = false): Promise<void> {
	try {
		endpoint = restart ? await launcher.restart() : await launcher.ensureRunning();
		await win.loadURL(endpoint.webUrl);
		failedLoads = 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const { response } = await dialog.showMessageBox(win, {
			type: 'error',
			message: 'Volt Agents could not reach the Volt agent server.',
			detail: `${message}\n\nVolt build: ${appRoot}\nProfile: ${serverUserDataDir}`,
			buttons: ['Try Again', 'Quit'],
			defaultId: 0,
		});
		if (response === 0) {
			return loadServer(win);
		}
		app.quit();
	}
}

function createWindow(): BrowserWindow {
	const state = loadWindowState(app.getPath('userData'));
	const win = new BrowserWindow({
		title: APP_NAME,
		icon: iconPath,
		...state.bounds,
		minWidth: 720,
		minHeight: 480,
		show: false,
		// The agent window's look: translucent sidebar over vibrancy, traffic lights inset into the page.
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 16, y: 12 },
		vibrancy: 'under-window',
		visualEffectState: 'followWindow',
		transparent: process.platform === 'darwin',
		backgroundColor: process.platform === 'darwin' ? '#00000000' : '#181818',
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});
	if (state.maximized) {
		win.maximize();
	}
	trackWindowState(win, app.getPath('userData'));
	win.once('ready-to-show', () => win.show());

	// Links in transcripts open in the browser; only the server's own page stays in the window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (!isSameOriginNavigation(endpoint?.webUrl, url)) {
			event.preventDefault();
			openExternal(url);
		}
	});
	// The server went away (or came back on another port): find or start it again, backing off.
	const reconnect = () => setTimeout(() => !win.isDestroyed() && void loadServer(win), retryDelay(failedLoads++));
	win.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
		if (isMainFrame && code !== -3 /* aborted by a newer load */ && isSameOriginNavigation(endpoint?.webUrl, url)) {
			reconnect();
		}
	});
	win.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason !== 'clean-exit') {
			reconnect();
		}
	});
	win.on('closed', () => {
		if (mainWindow === win) {
			mainWindow = undefined;
		}
	});
	void loadServer(win);
	watchServer(win);
	return win;
}

function buildMenu(): void {
	const template: MenuItemConstructorOptions[] = [
		{ role: 'appMenu' },
		{
			label: 'File',
			submenu: [
				{
					label: 'New Chat',
					accelerator: 'CmdOrCtrl+N',
					click: () => mainWindow?.webContents.send('volt-shell:command', 'newChat'),
				},
				{ type: 'separator' },
				{ role: 'close' },
			],
		},
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				{ role: 'forceReload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
			],
		},
		{
			label: 'Server',
			submenu: [
				{
					label: 'Open in Browser',
					click: () => endpoint && void shell.openExternal(endpoint.webUrl),
				},
				{
					label: 'Restart Agent Server',
					click: () => mainWindow && void loadServer(mainWindow, true),
				},
				{
					label: 'Show Server Log',
					click: () => void shell.openPath(launcher.paths.logFile),
				},
			],
		},
		{ role: 'windowMenu' },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.focus();
		}
	});
	app.whenReady().then(() => {
		if (process.platform === 'darwin') {
			app.dock?.setIcon(nativeImage.createFromPath(iconPath));
		}
		buildMenu();
		mainWindow = createWindow();
		app.on('activate', () => {
			mainWindow ??= createWindow();
		});
	});
	// Closing the window leaves runs going on the server; on macOS the app stays in the dock.
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});
}
