/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Debugger, WebContents } from 'electron';
import { isMacintosh } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { VOLT_BROWSER_PARTITION } from '../../voltBrowser/common/voltBrowser.js';
import { IVoltPageCapture, IVoltPageCaptureRequest, IVoltPageEvaluation, IVoltPageOpened, IVoltPageOpenRequest, IVoltPageState, IVoltVisualConsoleMessage, VoltPageInput, VoltPageScheme } from '../common/voltVisualPreview.js';
import { ALT, CTRL, MAC_COMMANDS, META, parseKeyCombo, SHIFT } from '../common/pageKeys.js';
import { consoleMessageOf, ICdpConsoleParams } from './cdpConsole.js';

const DEFAULT_LOAD_MS = 20_000;
const MAX_WAIT_MS = 45_000;
/** No request in flight and no DOM change for this long: the page is done drawing. */
const QUIET_MS = 350;
/** A request open longer than this is a stream or a long poll, not the page still loading. */
const LONG_REQUEST_MS = 8_000;
/** A page nobody used for this long is closed, so a capture that died half way leaks nothing. */
const IDLE_MS = 90_000;
const MAX_PAGES = 8;
const MAX_MESSAGES = 50;
/** What Safari on an iPhone sends, so servers that sniff the user agent serve their phone layout. */
const PHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

interface IHeadlessPage {
	readonly id: string;
	readonly win: BrowserWindow;
	readonly contents: WebContents;
	readonly cdp: Debugger;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	status?: number;
	/** Requests in flight, by id, with when they started. */
	readonly requests: Map<string, number>;
	/** When a request last started or ended. */
	lastNetwork: number;
	readonly console: IVoltVisualConsoleMessage[];
	/** Calls on a page run one at a time, in order: input lands before the script that checks it. */
	queue: Promise<unknown>;
	idle?: ReturnType<typeof setTimeout>;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), ms))]).finally(() => clearTimeout(timer));
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A load failure in words a developer acts on. */
function loadFailure(url: string, error: string): string {
	if (/ERR_CONNECTION_REFUSED/.test(error)) {
		return `${url} refused the connection: is the dev server running?`;
	}
	if (/ERR_NAME_NOT_RESOLVED/.test(error)) {
		return `${url}: the host name does not resolve.`;
	}
	if (/ERR_FILE_NOT_FOUND/.test(error)) {
		return `${url}: no such file.`;
	}
	if (/ERR_CERT_/.test(error)) {
		return `${url}: the certificate is not trusted (${/ERR_CERT_\w+/.exec(error)?.[0]}).`;
	}
	return `Could not open ${url}: ${error.replace(/\s*loading '.*'$/, '')}`;
}

/**
 * Resolves true once the DOM has not changed for `quiet` ms, web fonts are in and the images on
 * screen have loaded; false at `cap`. Timers only: an offscreen window whose app window is hidden
 * can stop producing frames, so animation frames may never come.
 */
function domQuietScript(quiet: number, cap: number): string {
	return `new Promise(resolve => {
	const start = Date.now();
	let last = start, fonts = !document.fonts;
	if (document.fonts) { document.fonts.ready.then(() => fonts = true, () => fonts = true); }
	const root = document.documentElement || document;
	const observer = new MutationObserver(() => last = Date.now());
	observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
	const onScreen = img => { const r = img.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; };
	const tick = () => {
		const now = Date.now();
		const images = Array.prototype.every.call(document.images, img => img.complete || !onScreen(img));
		if (fonts && images && now - last >= ${quiet}) { observer.disconnect(); resolve(true); return; }
		if (now - start >= ${cap}) { observer.disconnect(); resolve(false); return; }
		setTimeout(tick, 40);
	};
	setTimeout(tick, 40);
})`;
}

/**
 * Pages of the user's app, offscreen: loaded at an exact viewport and color scheme in the in-app
 * browser's session (signed in where the user is), driven over the DevTools protocol so input
 * works without focus, and captured as JPEG. JavaScript dialogs never reach the screen: alerts are
 * accepted, confirms and prompts declined.
 */
export class VoltHeadlessPages {

	private readonly pages = new Map<string, IHeadlessPage>();

	constructor(private readonly logService: ILogService) { }

	async open(request: IVoltPageOpenRequest): Promise<IVoltPageOpened> {
		const url = (request.url ?? '').trim();
		if (!/^(https?|file):/i.test(url)) {
			throw new Error(`Headless pages open http(s) and file URLs, not "${url}".`);
		}
		while (this.pages.size >= MAX_PAGES) {
			this.close(this.pages.keys().next().value!);
		}
		const width = Math.round(clamp(request.width, 200, 3840, 1280));
		const height = Math.round(clamp(request.height, 200, 4320, 800));
		const scale = clamp(request.scale, 1, 3, 1);
		const win = new BrowserWindow({
			width,
			height,
			show: false,
			webPreferences: {
				javascript: true,
				offscreen: true,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
				spellcheck: false,
				partition: VOLT_BROWSER_PARTITION,
			},
		});
		const contents = win.webContents;
		const page: IHeadlessPage = { id: generateUuid(), win, contents, cdp: contents.debugger, width, height, scale, requests: new Map(), lastNetwork: 0, console: [], queue: Promise.resolve() };
		this.pages.set(page.id, page);
		this.touch(page);
		try {
			contents.setWindowOpenHandler(() => ({ action: 'deny' }));
			contents.setAudioMuted(true);
			contents.on('did-navigate', (_event, _url, code) => {
				page.status = code > 0 ? code : undefined;
			});
			// The protocol only answers once the window has a renderer: start one on a blank page first.
			await win.loadURL('about:blank');
			page.cdp.attach('1.3');
			page.cdp.on('message', (_event, method, params) => this.onProtocolEvent(page, method, params));
			await Promise.all([
				page.cdp.sendCommand('Runtime.enable'),
				page.cdp.sendCommand('Log.enable'),
				page.cdp.sendCommand('Page.enable'),
				page.cdp.sendCommand('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 200_000 }),
			]);
			await page.cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: !!request.mobile, screenWidth: width, screenHeight: height });
			if (request.mobile) {
				await page.cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
				if (width < 600) {
					await page.cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: PHONE_USER_AGENT, platform: 'iPhone' });
				}
			}
			// The page acts focused (focus rings, :focus-within, keyboard input) while Volt keeps the real focus.
			await page.cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
			await this.applyScheme(page, request.scheme);
			const result = await this.load(page, () => contents.loadURL(url), clamp(request.timeoutMs, 1000, MAX_WAIT_MS, DEFAULT_LOAD_MS));
			if (result.error) {
				throw new Error(loadFailure(url, result.error));
			}
			return { id: page.id, ...this.state(page, result.loaded) };
		} catch (err) {
			this.close(page.id);
			throw err;
		}
	}

	evaluate<T>(id: string, expression: string, timeoutMs = 10_000): Promise<IVoltPageEvaluation<T>> {
		return this.run(id, page => this.evaluateIn<T>(page, expression, clamp(timeoutMs, 100, MAX_WAIT_MS, 10_000)));
	}

	input(id: string, input: readonly VoltPageInput[]): Promise<void> {
		return this.run(id, async page => {
			for (const event of input.slice(0, 50)) {
				await this.dispatch(page, event);
			}
		});
	}

	insertText(id: string, text: string): Promise<boolean> {
		return this.run(id, async page => {
			await page.cdp.sendCommand('Input.insertText', { text });
			return true;
		});
	}

	navigate(id: string, target: string, timeoutMs = DEFAULT_LOAD_MS): Promise<IVoltPageState> {
		return this.run(id, async page => {
			const { contents } = page;
			const wait = clamp(timeoutMs, 1000, MAX_WAIT_MS, DEFAULT_LOAD_MS);
			if (target === 'back' || target === 'reload') {
				const started = new Promise<void>(resolve => contents.once('did-start-loading', () => resolve()));
				if (target === 'reload') {
					contents.reload();
				} else if (contents.navigationHistory.canGoBack()) {
					contents.navigationHistory.goBack();
				} else {
					return this.state(page, true);
				}
				// A same-document history step never starts a load; give it a moment either way.
				await withTimeout(started, 800);
				return this.state(page, await this.quiet(page, Date.now() + wait));
			}
			if (!/^(https?|file):/i.test(target)) {
				throw new Error(`Headless pages open http(s) and file URLs, not "${target}".`);
			}
			const result = await this.load(page, () => contents.loadURL(target), wait);
			return this.state(page, !result.error && result.loaded);
		});
	}

	waitFor(id: string, timeoutMs: number): Promise<IVoltPageState> {
		return this.run(id, async page => this.state(page, await this.quiet(page, Date.now() + clamp(timeoutMs, 0, MAX_WAIT_MS, 5000))));
	}

	setScheme(id: string, scheme: VoltPageScheme | undefined): Promise<void> {
		return this.run(id, async page => {
			await this.applyScheme(page, scheme);
		});
	}

	capture(id: string, request: IVoltPageCaptureRequest = {}): Promise<IVoltPageCapture> {
		return this.run(id, async page => {
			const quality = Math.round(clamp(request.quality, 30, 100, 85));
			let cssHeight = page.height;
			let params: Record<string, unknown> = { format: 'jpeg', quality, fromSurface: true };
			if (request.fullPage) {
				const metrics = await page.cdp.sendCommand('Page.getLayoutMetrics') as { cssContentSize?: { height?: number }; contentSize?: { height?: number } };
				const content = Math.ceil(metrics.cssContentSize?.height ?? metrics.contentSize?.height ?? page.height);
				cssHeight = Math.max(page.height, Math.min(content, clamp(request.maxHeight, page.height, 16_000, page.height * 4)));
				if (cssHeight > page.height) {
					params = { ...params, captureBeyondViewport: true, clip: { x: 0, y: 0, width: page.width, height: cssHeight, scale: 1 } };
				}
			}
			const shot = await page.cdp.sendCommand('Page.captureScreenshot', params) as { data: string };
			return { jpeg: shot.data, width: Math.round(page.width * page.scale), height: Math.round(cssHeight * page.scale) };
		});
	}

	takeConsole(id: string): Promise<IVoltVisualConsoleMessage[]> {
		return this.run(id, async page => page.console.splice(0));
	}

	close(id: string): void {
		const page = this.pages.get(id);
		if (!page) {
			return;
		}
		this.pages.delete(id);
		clearTimeout(page.idle);
		try {
			if (page.cdp.isAttached()) {
				page.cdp.detach();
			}
		} catch {
			// the renderer is already gone
		}
		if (!page.win.isDestroyed()) {
			page.win.destroy();
		}
	}

	dispose(): void {
		for (const id of [...this.pages.keys()]) {
			this.close(id);
		}
	}

	private run<T>(id: string, work: (page: IHeadlessPage) => Promise<T>): Promise<T> {
		const page = this.pages.get(id);
		if (!page || page.contents.isDestroyed()) {
			return Promise.reject(new Error(`The headless page ${id} is closed (pages close after ${IDLE_MS / 1000}s unused).`));
		}
		this.touch(page);
		const next = page.queue.then(() => work(page), () => work(page));
		page.queue = next.catch(() => undefined);
		return next;
	}

	private touch(page: IHeadlessPage): void {
		clearTimeout(page.idle);
		page.idle = setTimeout(() => {
			this.logService.info(`[volt] closing a headless page left unused for ${IDLE_MS / 1000}s`);
			this.close(page.id);
		}, IDLE_MS);
	}

	private onProtocolEvent(page: IHeadlessPage, method: string, params: ICdpConsoleParams & { readonly [key: string]: unknown }): void {
		switch (method) {
			case 'Network.requestWillBeSent': {
				const type = params.type;
				const url = (params.request as { url?: string } | undefined)?.url ?? '';
				if (type !== 'WebSocket' && type !== 'EventSource' && !url.startsWith('data:')) {
					page.requests.set(String(params.requestId), Date.now());
					page.lastNetwork = Date.now();
				}
				return;
			}
			case 'Network.loadingFinished':
			case 'Network.loadingFailed':
				if (page.requests.delete(String(params.requestId))) {
					page.lastNetwork = Date.now();
				}
				return;
			case 'Page.javascriptDialogOpening': {
				// A hidden window must never show a dialog. An alert has only OK; a confirm may guard
				// something destructive, so it is declined; leaving the page is allowed.
				const type = String(params.type ?? 'alert');
				void page.cdp.sendCommand('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }).catch(() => undefined);
				this.record(page, { level: 'warning', text: `Volt ${type === 'alert' || type === 'beforeunload' ? 'accepted' : 'dismissed'} a ${type} dialog: ${String(params.message ?? '').slice(0, 300)}` });
				return;
			}
		}
		const message = consoleMessageOf(method, params);
		if (message && (message.level === 'error' || message.level === 'warning')) {
			this.record(page, message);
		}
	}

	private record(page: IHeadlessPage, message: IVoltVisualConsoleMessage): void {
		// Electron's own advice to developers (unpackaged builds only), not the page's.
		if (page.console.length < MAX_MESSAGES && !/Electron Security Warning/.test(message.text)) {
			page.console.push(message);
		}
	}

	private applyScheme(page: IHeadlessPage, scheme: VoltPageScheme | undefined): Promise<unknown> {
		// An empty value drops the override: the page follows the OS again.
		return page.cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme ?? '' }] });
	}

	private state(page: IHeadlessPage, loaded: boolean): IVoltPageState {
		const alive = !page.contents.isDestroyed();
		return {
			url: alive ? page.contents.getURL() : '',
			title: alive ? page.contents.getTitle() : '',
			loading: alive && page.contents.isLoading(),
			loaded,
			...(page.status ? { status: page.status } : {}),
		};
	}

	/**
	 * Starts a load and waits for the page to go quiet, until `timeoutMs`. A page that redirects
	 * itself while loading aborts the first load (ERR_ABORTED): the new one is what counts.
	 */
	private async load(page: IHeadlessPage, start: () => Promise<unknown>, timeoutMs: number): Promise<{ readonly loaded: boolean; readonly error?: string }> {
		const deadline = Date.now() + timeoutMs;
		let error: string | undefined;
		const started = start().then(() => undefined, err => { error = errorText(err); });
		await Promise.race([started, sleep(timeoutMs)]);
		if (error && /ERR_ABORTED|\(-3\)/.test(error)) {
			error = undefined;
		}
		if (error) {
			return { loaded: false, error };
		}
		return { loaded: await this.quiet(page, deadline) };
	}

	private inflight(page: IHeadlessPage): number {
		const now = Date.now();
		let count = 0;
		for (const started of page.requests.values()) {
			if (now - started < LONG_REQUEST_MS) {
				count++;
			}
		}
		return count;
	}

	/** Waits until nothing loads, no request is open and the DOM stops changing; false at `deadline`. */
	private async quiet(page: IHeadlessPage, deadline: number): Promise<boolean> {
		while (Date.now() < deadline && !page.contents.isDestroyed()) {
			if (!page.contents.isLoading() && this.inflight(page) === 0 && Date.now() - page.lastNetwork >= QUIET_MS) {
				const left = deadline - Date.now();
				const dom = await this.evaluateIn<boolean>(page, domQuietScript(QUIET_MS, Math.max(100, Math.min(4000, left))), Math.min(5000, left + 500));
				if (dom.value === true && this.inflight(page) === 0 && !page.contents.isLoading()) {
					return true;
				}
			}
			await sleep(60);
		}
		return false;
	}

	private async evaluateIn<T>(page: IHeadlessPage, expression: string, timeoutMs: number): Promise<IVoltPageEvaluation<T>> {
		const loading = () => !page.contents.isDestroyed() && page.contents.isLoading();
		if (page.contents.isDestroyed()) {
			return { error: 'The page was closed.', loading: false };
		}
		try {
			const result = await withTimeout(page.cdp.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }), timeoutMs) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
			if (!result) {
				return { error: `The page did not answer within ${timeoutMs}ms.`, loading: loading() };
			}
			if (result.exceptionDetails) {
				return { error: (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The script threw.').slice(0, 2000), loading: loading() };
			}
			return { value: result.result?.value, loading: loading() };
		} catch (err) {
			// "Execution context was destroyed": the page navigated while the script ran.
			return { error: errorText(err), loading: loading() };
		}
	}

	private async dispatch(page: IHeadlessPage, event: VoltPageInput): Promise<void> {
		const mouse = (params: Record<string, unknown>) => page.cdp.sendCommand('Input.dispatchMouseEvent', params);
		switch (event.kind) {
			case 'move':
				await mouse({ type: 'mouseMoved', x: event.x, y: event.y, button: 'none', buttons: 0 });
				return;
			case 'wheel':
				await mouse({ type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY });
				return;
			case 'click': {
				const button = event.button ?? 'left';
				const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
				await mouse({ type: 'mouseMoved', x: event.x, y: event.y, button: 'none', buttons: 0 });
				for (let count = 1; count <= Math.max(1, Math.min(3, event.clickCount ?? 1)); count++) {
					await mouse({ type: 'mousePressed', x: event.x, y: event.y, button, buttons, clickCount: count });
					await mouse({ type: 'mouseReleased', x: event.x, y: event.y, button, buttons: 0, clickCount: count });
				}
				return;
			}
			case 'key': {
				const parsed = parseKeyCombo(event.combo);
				if (!parsed) {
					throw new Error(`Unknown key "${event.combo}".`);
				}
				const { modifiers, key } = parsed;
				const typed = key.text && !(modifiers & (ALT | CTRL | META)) ? (modifiers & SHIFT && key.text.length === 1 ? key.text.toUpperCase() : key.text) : undefined;
				const command = isMacintosh && modifiers & META && !(modifiers & (ALT | CTRL)) ? (key.text?.toLowerCase() === 'z' && modifiers & SHIFT ? 'redo' : MAC_COMMANDS[key.text?.toLowerCase() ?? '']) : undefined;
				const base = { modifiers, key: typed ?? key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
				await page.cdp.sendCommand('Input.dispatchKeyEvent', { ...base, type: typed ? 'keyDown' : 'rawKeyDown', ...(typed ? { text: typed, unmodifiedText: typed } : {}), ...(command ? { commands: [command] } : {}) });
				await page.cdp.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
				return;
			}
		}
	}
}
