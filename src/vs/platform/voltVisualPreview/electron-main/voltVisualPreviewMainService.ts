/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Debugger } from 'electron';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltPageCapture, IVoltPageCaptureRequest, IVoltPageEvaluation, IVoltPageOpened, IVoltPageOpenRequest, IVoltPageState, IVoltVisualConsoleMessage, IVoltVisualPreview, IVoltVisualPreviewRequest, IVoltVisualPreviewService, VOLT_VISUAL_MAX_CAPTURE, VOLT_VISUAL_MAX_WIDTH, VOLT_VISUAL_MIN_WIDTH, VoltPageInput, VoltPageScheme } from '../common/voltVisualPreview.js';
import { consoleMessageOf } from './cdpConsole.js';
import { VoltHeadlessPages } from './voltHeadlessPages.js';

const LOAD_TIMEOUT_MS = 15_000;
/** A page that never settles (an endless loop, a hung script) fails the call instead of holding the agent. */
const RUN_TIMEOUT_MS = 45_000;
const STEP_TIMEOUT_MS = 3_000;
/** Pages animate in; give them a moment before measuring and capturing. */
const SETTLE_MS = 350;
const MAX_MESSAGES = 60;

function clampWidth(width: number): number {
	return Math.round(Math.min(VOLT_VISUAL_MAX_WIDTH, Math.max(VOLT_VISUAL_MIN_WIDTH, Number.isFinite(width) ? width : 728)));
}

/**
 * One offscreen window per request, driven over the DevTools protocol: exact viewport sizes,
 * a full-page PNG, and the page's console with stack traces. Requests run one at a time.
 */
export class VoltVisualPreviewMainService implements IVoltVisualPreviewService {

	declare readonly _serviceBrand: undefined;

	private queue: Promise<unknown> = Promise.resolve();
	private readonly pages: VoltHeadlessPages;

	constructor(@ILogService private readonly logService: ILogService) {
		this.pages = new VoltHeadlessPages(logService);
	}

	capture(request: IVoltVisualPreviewRequest): Promise<IVoltVisualPreview> {
		const once = () => this.run(request);
		const run = this.queue.then(once, once);
		this.queue = run.catch(() => undefined);
		return run;
	}

	//#region Headless pages (see VoltHeadlessPages)

	openPage(request: IVoltPageOpenRequest): Promise<IVoltPageOpened> {
		return this.pages.open(request);
	}

	evaluatePage<T>(id: string, expression: string, timeoutMs?: number): Promise<IVoltPageEvaluation<T>> {
		return this.pages.evaluate<T>(id, expression, timeoutMs);
	}

	inputPage(id: string, input: readonly VoltPageInput[]): Promise<void> {
		return this.pages.input(id, input);
	}

	insertPageText(id: string, text: string): Promise<boolean> {
		return this.pages.insertText(id, text);
	}

	navigatePage(id: string, target: string, timeoutMs?: number): Promise<IVoltPageState> {
		return this.pages.navigate(id, target, timeoutMs);
	}

	waitForPage(id: string, timeoutMs: number): Promise<IVoltPageState> {
		return this.pages.waitFor(id, timeoutMs);
	}

	setPageScheme(id: string, scheme: VoltPageScheme | undefined): Promise<void> {
		return this.pages.setScheme(id, scheme);
	}

	capturePage(id: string, request?: IVoltPageCaptureRequest): Promise<IVoltPageCapture> {
		return this.pages.capture(id, request);
	}

	takePageConsole(id: string): Promise<IVoltVisualConsoleMessage[]> {
		return this.pages.takeConsole(id);
	}

	async closePage(id: string): Promise<void> {
		this.pages.close(id);
	}

	//#endregion

	private async run(request: IVoltVisualPreviewRequest): Promise<IVoltVisualPreview> {
		const width = clampWidth(request.width);
		const dir = join(tmpdir(), `volt-visual-${generateUuid()}`);
		const file = join(dir, 'page.html');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(file, request.html, 'utf8');
		const win = new BrowserWindow({
			width,
			height: 800,
			show: false,
			webPreferences: {
				javascript: true,
				offscreen: true,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
				spellcheck: false,
				partition: 'volt-visual-preview',
			},
		});
		const messages: IVoltVisualConsoleMessage[] = [];
		const push = (level: IVoltVisualConsoleMessage['level'], text: string) => {
			if (messages.length < MAX_MESSAGES) {
				messages.push({ level, text: text.slice(0, 2000) });
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const contents = win.webContents;
			contents.setWindowOpenHandler(() => ({ action: 'deny' }));
			// The protocol only answers once the window has a renderer: start one on a blank page first.
			await win.loadURL('about:blank');
			contents.on('will-navigate', event => event.preventDefault());
			const cdp = contents.debugger;
			cdp.attach('1.3');
			cdp.on('message', (_event, method, params) => {
				const message = consoleMessageOf(method, params);
				if (message) {
					push(message.level, message.text);
				}
			});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`The page did not finish rendering in ${RUN_TIMEOUT_MS / 1000}s. Check for endless loops or scripts that never finish.`)), RUN_TIMEOUT_MS);
			});
			const started = Date.now();
			const laps: string[] = [];
			const step = async <T,>(label: string, work: Promise<T>): Promise<T> => {
				const at = Date.now();
				const result = await Promise.race([work, timeout]);
				laps.push(`${label} ${Date.now() - at}ms`);
				return result;
			};
			const report = () => this.logService.info(`[volt] visual preview ${width}px in ${Date.now() - started}ms: ${laps.join(', ')}`);
			await step('enable', cdp.sendCommand('Runtime.enable'));
			await step('log', cdp.sendCommand('Log.enable'));
			await step('viewport', cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }));
			if (request.background) {
				// Without it a transparent page is captured on white: a dark-theme page then looks washed out.
				await step('background', cdp.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { ...request.background, a: 1 } }));
			}
			await step('load', Promise.race([
				win.loadFile(file),
				new Promise((_, reject) => setTimeout(() => reject(new Error('The page took more than 15s to load.')), LOAD_TIMEOUT_MS)),
			]));
			await step('settle', this.settle(cdp, SETTLE_MS));
			const contentHeight = await step('measure', this.measure(cdp));
			const heights: [number, number][] = [];
			for (const measureWidth of request.measureWidths ?? []) {
				const at = clampWidth(measureWidth);
				await step(`viewport ${at}`, cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: at, height: 800, deviceScaleFactor: 1, mobile: false }));
				await step(`settle ${at}`, this.settle(cdp, 60));
				heights.push([at, await step(`measure ${at}`, this.measure(cdp))]);
			}
			if (request.measureOnly) {
				report();
				return { width, contentHeight, capturedHeight: 0, heights, console: messages };
			}
			const capturedHeight = Math.max(1, Math.min(contentHeight, VOLT_VISUAL_MAX_CAPTURE));
			await step('resize', cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: capturedHeight, deviceScaleFactor: 1, mobile: false }));
			await step('settle', this.settle(cdp, 80));
			const shot = await step('capture', cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: capturedHeight, scale: 1 } })) as { data: string };
			report();
			return { png: shot.data, width, contentHeight, capturedHeight, heights, console: messages };
		} catch (err) {
			this.logService.warn('[volt] visual preview failed', err);
			throw err;
		} finally {
			clearTimeout(timer);
			win.destroy();
			fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async settle(cdp: Debugger, ms: number): Promise<void> {
		await cdp.sendCommand('Runtime.evaluate', {
			// Fonts, then time for the page's own entry animations. Timers only: an offscreen window
			// whose app window is hidden can stop producing frames, and a requestAnimationFrame wait
			// then stalls until the cap (measuring and capturing force their own layout and frame).
			expression: `Promise.race([(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise(resolve => setTimeout(resolve, ${ms}))), new Promise(resolve => setTimeout(resolve, ${STEP_TIMEOUT_MS}))])`,
			awaitPromise: true,
		}).catch(() => undefined);
	}

	/** The height the page needs: its scroll height when taller than the viewport, else its own box. */
	private async measure(cdp: Debugger): Promise<number> {
		const result = await cdp.sendCommand('Runtime.evaluate', {
			expression: '(() => { const r = document.documentElement; const b = document.body; const box = Math.max(r.getBoundingClientRect().height, b ? b.getBoundingClientRect().bottom + parseFloat(getComputedStyle(b).marginBottom || "0") : 0); return Math.ceil(r.scrollHeight > r.clientHeight ? r.scrollHeight : box); })()',
			returnByValue: true,
		}) as { result?: { value?: number } };
		const value = result.result?.value;
		return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, value) : 1;
	}
}
