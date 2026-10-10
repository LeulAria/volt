/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentVisuals.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Color, RGBA } from '../../../../../base/common/color.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService, registerThemingParticipant } from '../../../../../platform/theme/common/themeService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { WebviewThemeDataProvider } from '../../../webview/browser/themeing.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';
import type { IVisualBlock } from '../blocks/agentBlocks.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { DotLoaderShape, renderDotLoader } from './agentDotLoader.js';
import { pageHeightFor, PAGE_SEND_INTERVAL_MS, PageRequest, parsePageRequest, setPageContext } from './agentVisualBridge.js';
import { buildVisualPage, VISUAL_COLUMN_WIDTH, VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT } from './agentVisualPage.js';
import { IVoltChartsHandle, IVoltChartsRuntime, IVoltChartsStrings, voltChartsRuntime } from './voltChartsRuntime.js';

/** Opens a chat by id (`OPEN_AGENT_COMMAND_ID`, kept as a string to stay clear of the editor's imports). */
const OPEN_AGENT_COMMAND = 'workbench.action.voltAgent.openSession';

//#region Engine and theme

const runtimes = new WeakMap<Window, IVoltChartsRuntime>();

/** The chart engine for a window (each window gets its own, bound to its document). */
export function voltCharts(win: Window): IVoltChartsRuntime {
	let runtime = runtimes.get(win);
	if (!runtime) {
		runtime = voltChartsRuntime(win as Window & typeof globalThis);
		runtimes.set(win, runtime);
	}
	return runtime;
}

export function voltChartStrings(): Partial<IVoltChartsStrings> {
	return {
		emptyTitle: localize('voltCharts.emptyTitle', "No data yet"),
		emptyMessage: localize('voltCharts.emptyMessage', "Values will appear here once there is something to show."),
		loading: localize('voltCharts.loading', "Loading"),
		all: localize('voltCharts.all', "All"),
		fewer: localize('voltCharts.fewer', "fewer"),
		more: localize('voltCharts.more', "more"),
		showAll: localize('voltCharts.showAll', "Show all"),
		showLess: localize('voltCharts.showLess', "Show less"),
		zoomHint: localize('voltCharts.zoomHint', "Click to zoom in. Right click or Esc to zoom out."),
		open: localize('voltCharts.open', "Click to open"),
		total: localize('voltCharts.total', "Total"),
		other: localize('voltCharts.other', "Other"),
		vsPrevious: localize('voltCharts.vsPrevious', "vs previous"),
		chart: localize('voltCharts.chart', "Chart"),
		zoomIn: localize('voltCharts.zoomIn', "Click to zoom in"),
		ofParent: localize('voltCharts.ofParent', "of {0}"),
		ofPrevious: localize('voltCharts.ofPrevious', "of the previous stage"),
		ofFirst: localize('voltCharts.ofFirst', "Share of the first stage"),
		logScale: localize('voltCharts.logScale', "Widths are log-scaled; the numbers are exact."),
		candleOpen: localize('voltCharts.candleOpen', "Open"),
		candleHigh: localize('voltCharts.candleHigh', "High"),
		candleLow: localize('voltCharts.candleLow', "Low"),
		candleClose: localize('voltCharts.candleClose', "Close"),
		rising: localize('voltCharts.rising', "Up"),
		falling: localize('voltCharts.falling', "Down"),
	};
}

/** Where each chart hue comes from, best first: the theme's chart color, then its terminal palette. */
const PALETTE_SOURCES: readonly (readonly [slot: string, ids: readonly string[]])[] = [
	['blue', ['charts.blue', 'terminal.ansiBrightBlue', 'terminal.ansiBlue']],
	['green', ['charts.green', 'terminal.ansiGreen', 'terminal.ansiBrightGreen']],
	['purple', ['charts.purple', 'terminal.ansiMagenta', 'terminal.ansiBrightMagenta']],
	['yellow', ['charts.yellow', 'terminal.ansiYellow', 'terminal.ansiBrightYellow']],
	['red', ['charts.red', 'terminal.ansiRed', 'terminal.ansiBrightRed']],
	['teal', ['terminal.ansiCyan', 'terminal.ansiBrightCyan']],
	['pink', ['terminal.ansiBrightMagenta', 'terminal.ansiMagenta']],
	['orange', ['charts.orange']],
];

function mix(a: Color, b: Color, weight = 0.5): Color {
	return new Color(new RGBA(
		Math.round(a.rgba.r * weight + b.rgba.r * (1 - weight)),
		Math.round(a.rgba.g * weight + b.rgba.g * (1 - weight)),
		Math.round(a.rgba.b * weight + b.rgba.b * (1 - weight)),
	));
}

/**
 * The chart palette for a theme, as CSS custom properties. A hue the theme sets itself (its chart
 * or terminal colors) beats VS Code's defaults, so Nord, Dracula or Solarized charts look like
 * Nord, Dracula or Solarized. Orange, which terminals lack, is the theme's red and yellow mixed.
 */
export function chartPaletteVariables(theme: IColorTheme): Record<string, string> {
	const background = theme.getColor('sideBar.background') ?? theme.getColor('editor.background') ?? Color.black;
	const opaque = (color: Color) => color.isOpaque() ? color : color.makeOpaque(background);
	const colors = new Map<string, Color>();
	const declared = new Set<string>();
	for (const [slot, ids] of PALETTE_SOURCES) {
		const id = ids.find(candidate => theme.defines(candidate));
		const color = theme.getColor(id ?? ids[0]);
		if (id) {
			declared.add(slot);
		}
		if (color) {
			colors.set(slot, opaque(color));
		}
	}
	const red = colors.get('red');
	const yellow = colors.get('yellow');
	if (!declared.has('orange') && red && yellow) {
		colors.set('orange', mix(red, yellow));
	}
	const purple = colors.get('purple');
	const pink = colors.get('pink');
	if (red && purple && (!pink || pink.equals(purple))) {
		colors.set('pink', mix(red, purple));
	}
	const accent = theme.getColor('textLink.foreground') ?? colors.get('blue');
	const variables: Record<string, string> = {};
	if (accent) {
		variables['--volt-chart-accent'] = opaque(accent).toString();
	}
	for (const [slot, color] of colors) {
		variables[`--volt-chart-${slot}`] = color.toString();
	}
	return variables;
}

function cssBlock(selector: string, variables: Record<string, string>): string {
	return `${selector}{${Object.entries(variables).map(([name, value]) => `${name}:${value};`).join('')}}`;
}

registerThemingParticipant((theme, collector) => {
	collector.addRule(cssBlock('.monaco-workbench', chartPaletteVariables(theme)));
});

export function themeKind(theme: IColorTheme): 'light' | 'dark' {
	return theme.type === ColorScheme.LIGHT || theme.type === ColorScheme.HIGH_CONTRAST_LIGHT ? 'light' : 'dark';
}

/** What a page needs on top of the webview's own `--vscode-*` colors: the chart palette and the chat's surface. */
export function visualThemeCss(theme: IColorTheme, extra: Record<string, string> = {}): string {
	const surface = theme.getColor('sideBar.background') ?? theme.getColor('editor.background');
	return cssBlock(':root', { ...extra, ...chartPaletteVariables(theme), ...(surface ? { '--volt-surface': surface.toString() } : {}) });
}

//#endregion

//#region Links out of a visual

export interface IVisualHostContext {
	readonly instantiationService: IInstantiationService;
	readonly onOpenPath?: (path: string, startLine?: number, endLine?: number) => void;
	readonly onOpenUrl?: (url: string) => void;
	readonly onCopyText?: (text: string) => void;
	/** A page under the pointer took a wheel event: scroll the transcript instead. */
	readonly onWheel?: (event: IMouseWheelEvent) => void;
	/** Shows the visual full size; `store` is disposed when it closes. */
	readonly onExpandVisual?: (title: string, content: HTMLElement, store: IDisposable) => void;
	/** The chat the visual is shown in (page state for its next turn). */
	readonly sessionId?: string;
	/** A page asked to send a message as the user (`send`), or to put one in the composer. */
	readonly onPagePrompt?: (text: string, page: string, send: boolean) => void;
}

/** `volt://session/<id>`, `volt://file/<path>#L12-20`, a local path, or a web link. */
export function openVisualHref(href: string, ctx: IVisualHostContext): void {
	const session = /^volt:\/\/session\/([^/?#]+)/i.exec(href);
	if (session) {
		const id = decodeURIComponent(session[1]);
		ctx.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(OPEN_AGENT_COMMAND, id));
		return;
	}
	const file = /^volt:\/\/file\/([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?/i.exec(href) ?? /^(?:file:\/\/)?(\/[^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/i.exec(href);
	if (file) {
		let path = file[1];
		try {
			path = decodeURI(path);
		} catch {
			// keep it as written
		}
		ctx.onOpenPath?.(path, file[2] ? Number(file[2]) : undefined, file[3] ? Number(file[3]) : undefined);
		return;
	}
	if (/^https?:\/\//i.test(href)) {
		if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(href) && ctx.onOpenUrl) {
			ctx.onOpenUrl(href);
			return;
		}
		ctx.instantiationService.invokeFunction(accessor => accessor.get(IOpenerService).open(URI.parse(href), { openExternal: true }));
	}
}

//#endregion

//#region Live visuals (kept across transcript redraws)

/**
 * The transcript rebuilds its last exchange on every streamed frame. A chart is plain DOM, so its
 * node simply moves into the new row and keeps its hover state. A page lives in an iframe, which
 * reloads when it leaves the document, so its frame is moved with `moveBefore` (an atomic move
 * that keeps the frame alive) once the new row is in the document; see `adoptVisualFrames`.
 */
interface ILiveChart {
	readonly element: HTMLElement;
	handle: IVoltChartsHandle | undefined;
	ctx: IVisualHostContext;
}

interface ILiveFrame {
	readonly element: HTMLElement;
	webview: IWebviewElement | undefined;
	readonly store: DisposableStore;
	ctx: IVisualHostContext;
	height: number;
	readonly key: string;
	readonly title: string;
	/** Shown over the chat (top layer), in place: the page keeps its state. */
	fullscreen?: DisposableStore;
	lastSend?: number;
}

/** How a page frame opens: heights measured at several widths, and the agent's cap. */
interface IFrameSizing {
	readonly heights?: readonly (readonly [number, number])[];
	readonly cap?: number;
}

/** The reply column's width last seen by a frame, for sizing frames before they are in the document. */
let replyWidth = VISUAL_COLUMN_WIDTH;

const MAX_LIVE_CHARTS = 48;
const MAX_LIVE_FRAMES = 10;
const liveCharts = new Map<string, ILiveChart>();
const liveFrames = new Map<string, ILiveFrame>();
const specs = new Map<string, Promise<unknown>>();
const pages = new Map<string, Promise<string | undefined>>();

function touch<T>(map: Map<string, T>, key: string, value: T, max: number, evict: (value: T) => void): void {
	map.delete(key);
	map.set(key, value);
	for (const [oldKey, oldValue] of map) {
		if (map.size <= max) {
			break;
		}
		if (oldKey !== key) {
			map.delete(oldKey);
			evict(oldValue);
		}
	}
}

function loadAttachment(ctx: IVisualHostContext, ref: string): Promise<Uint8Array | undefined> {
	return ctx.instantiationService.invokeFunction(accessor => accessor.get(IAgentHistoryService).getAttachment(ref)).then(file => file?.bytes);
}

function loadSpec(ctx: IVisualHostContext, ref: string): Promise<unknown> {
	let pending = specs.get(ref);
	if (!pending) {
		pending = loadAttachment(ctx, ref).then(bytes => bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined).catch(() => undefined);
		specs.set(ref, pending);
		if (specs.size > 64) {
			specs.delete(specs.keys().next().value!);
		}
	}
	return pending;
}

function loadPage(ctx: IVisualHostContext, ref: string): Promise<string | undefined> {
	let pending = pages.get(ref);
	if (!pending) {
		pending = loadAttachment(ctx, ref).then(bytes => bytes ? new TextDecoder().decode(bytes) : undefined).catch(() => undefined);
		pages.set(ref, pending);
		if (pages.size > 16) {
			pages.delete(pages.keys().next().value!);
		}
	}
	return pending;
}

/** A chart for `key` in `host`: the live one moved here, or a new one. */
export function mountChart(host: HTMLElement, key: string, spec: unknown, ctx: IVisualHostContext, animate = true): IVoltChartsHandle {
	const live = liveCharts.get(key);
	if (live) {
		live.ctx = ctx;
		host.appendChild(live.element);
		touch(liveCharts, key, live, MAX_LIVE_CHARTS, value => value.handle?.dispose());
		return live.handle!;
	}
	const element = $('.volt-agent-visual-chart');
	host.appendChild(element);
	const entry: ILiveChart = { element, ctx, handle: undefined };
	const handle = voltCharts(getWindow(host)).render(element, spec, {
		strings: voltChartStrings(),
		animate,
		onOpen: href => openVisualHref(href, entry.ctx),
	});
	entry.handle = handle;
	touch(liveCharts, key, entry, MAX_LIVE_CHARTS, value => value.handle?.dispose());
	return handle;
}

function frameHeight(height: number | undefined): number {
	return Math.round(Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, height ?? 360)));
}

function createFrame(key: string, title: string, html: string, height: number | undefined, ctx: IVisualHostContext, win: CodeWindow, sizing: IFrameSizing = {}): ILiveFrame {
	const store = new DisposableStore();
	const element = $('.volt-agent-visual-frame');
	const opening = frameHeight(pageHeightFor(replyWidth, sizing.heights, sizing.cap) ?? height);
	element.style.height = `${opening}px`;
	const frame: ILiveFrame = {
		element,
		store,
		ctx,
		height: opening,
		webview: undefined,
		key,
		title,
	};
	store.add(toDisposable(() => frame.fullscreen?.dispose()));
	// A skeleton until the page reports its size (it has loaded and laid out), or 4s at most.
	const skeleton = renderVisualSkeleton(element, 'page');
	const settle = () => skeleton.remove();
	const timer = win.setTimeout(settle, 4000);
	store.add(toDisposable(() => win.clearTimeout(timer)));
	const current = store.add(new MutableDisposable<DisposableStore>());
	const mount = () => {
		const webviewStore = current.value = new DisposableStore();
		ctx.instantiationService.invokeFunction(accessor => {
			const webviewService = accessor.get(IWebviewService);
			const themeService = accessor.get(IThemeService);
			const webview = webviewStore.add(webviewService.createWebviewElement({
				title,
				origin: key,
				options: { enableFindWidget: false, purpose: WebviewContentPurpose.ChatOutputItem, tryRestoreScrollPosition: false, disableServiceWorker: true },
				contentOptions: { allowScripts: true, localResourceRoots: [] },
				extension: undefined,
			}));
			frame.webview = webview;
			const theme = themeService.getColorTheme();
			webview.setHtml(buildVisualPage(html, { themeCss: visualThemeCss(theme), kind: themeKind(theme) }));
			webviewStore.add(themeService.onDidColorThemeChange(next => {
				void webview.postMessage({ type: 'volt-theme', css: visualThemeCss(next), kind: themeKind(next) });
			}));
			webviewStore.add(autorun(reader => {
				const size = reader.readObservable(webview.intrinsicContentSize);
				if (size?.height) {
					frame.height = frameHeight(sizing.cap ? Math.min(sizing.cap, size.height) : size.height);
					element.style.height = `${frame.height}px`;
					if (element.clientWidth) {
						replyWidth = element.clientWidth;
					}
					settle();
				}
			}));
			// The page posts its wheel events as plain data; the transcript's scrollable calls
			// preventDefault/stopPropagation on what it handles, so give it no-op ones (as chat does).
			webviewStore.add(webview.onDidWheel(event => frame.ctx.onWheel?.({ ...event, preventDefault: () => { }, stopPropagation: () => { } })));
			webviewStore.add(webview.onDidClickLink(link => openVisualHref(link, frame.ctx)));
			webviewStore.add(webview.onMessage(event => {
				const request = parsePageRequest(event.message);
				if (request) {
					handlePageRequest(frame, request, win);
				}
			}));
			webview.mountTo(element, win);
			webviewStore.add(onHostReloaded(element, () => {
				// Out of the event: the old webview goes and a new one loads the page.
				win.setTimeout(() => {
					if (current.value === webviewStore && !store.isDisposed) {
						mount();
					}
				}, 0);
			}));
		});
	};
	mount();
	return frame;
}

/**
 * An iframe that leaves the document loses its page; when it comes back it loads the empty webview
 * host again, which shows nothing and swallows every wheel event over it (the transcript stops
 * scrolling there). That happens behind our back whenever the editor is hidden (another editor,
 * the Usage page) and shown again. A host can not be reliably re-primed in place, so `onReload`
 * fires on any load after the first, and the caller swaps in a fresh webview.
 */
function onHostReloaded(element: HTMLElement, onReload: () => void): IDisposable {
	const iframe = element.querySelector('iframe');
	if (!iframe) {
		return toDisposable(() => { });
	}
	let loaded = false;
	return addDisposableListener(iframe, 'load', () => {
		if (!iframe.getAttribute('src')) {
			return;
		}
		if (loaded) {
			onReload();
		}
		loaded = true;
	});
}

/** Puts the live frame for each slot under `root` into its slot, keeping the page alive where it can. */
export function adoptVisualFrames(root: ParentNode): void {
	for (const slot of Array.from(root.querySelectorAll<HTMLElement>('.volt-agent-visual-slot[data-visual]'))) {
		const live = liveFrames.get(slot.dataset.visual!);
		const parent = slot.parentElement;
		if (!live || !parent) {
			continue;
		}
		const moveBefore = (parent as HTMLElement & { moveBefore?(node: Node, child: Node | null): void }).moveBefore;
		if (live.element.isConnected && slot.isConnected && moveBefore) {
			try {
				moveBefore.call(parent, live.element, slot);
				slot.remove();
				continue;
			} catch {
				// Not movable atomically (another document): fall back to a reload.
			}
		}
		// A frame that was out of the document reloads its host as it comes back; its load
		// listener (watchFrameReloads) puts the page back.
		slot.replaceWith(live.element);
	}
}

/**
 * Before a full redraw: moves every live page under `root` into `parking` (connected, so it stays
 * loaded) and leaves a slot in its place, for `adoptVisualFrames` to fill again.
 */
export function parkVisualFrames(root: ParentNode, parking: HTMLElement): void {
	const moveBefore = (parking as HTMLElement & { moveBefore?(node: Node, child: Node | null): void }).moveBefore;
	for (const [key, live] of liveFrames) {
		if (!root.contains(live.element) || !live.element.isConnected || !parking.isConnected || !moveBefore) {
			continue;
		}
		const slot = $('.volt-agent-visual-slot');
		slot.dataset.visual = key;
		slot.style.height = `${live.height}px`;
		live.element.before(slot);
		try {
			moveBefore.call(parking, live.element, null);
		} catch {
			slot.remove();
		}
	}
}

/** A page for `key` in `host`. A live one is adopted (now, or after the caller connects the new row). */
function mountFrame(host: HTMLElement, key: string, title: string, html: string, height: number | undefined, ctx: IVisualHostContext, sizing: IFrameSizing = {}): void {
	const live = liveFrames.get(key);
	if (live) {
		live.ctx = ctx;
		touch(liveFrames, key, live, MAX_LIVE_FRAMES, value => value.store.dispose());
		const slot = append(host, $('.volt-agent-visual-slot'));
		slot.dataset.visual = key;
		slot.style.height = `${live.height}px`;
		// The editor adopts slots right after it connects a redrawn row; anything else is caught here.
		queueMicrotask(() => {
			if (slot.isConnected) {
				adoptVisualFrames(slot.parentElement ?? slot);
			}
		});
		return;
	}
	if (host.clientWidth) {
		replyWidth = host.clientWidth;
	}
	const frame = createFrame(key, title, html, height, ctx, getWindow(host), sizing);
	host.appendChild(frame.element);
	touch(liveFrames, key, frame, MAX_LIVE_FRAMES, value => value.store.dispose());
}

/**
 * Acts on what a page asked (see agentVisualBridge.ts). Sending as the user needs the page to have
 * the user's focus (they clicked in it), and at most one message per {@link PAGE_SEND_INTERVAL_MS}.
 */
function handlePageRequest(frame: ILiveFrame, request: PageRequest, win: CodeWindow): void {
	switch (request.kind) {
		case 'open':
			openVisualHref(request.href, frame.ctx);
			return;
		case 'display':
			setFrameFullscreen(frame, request.mode === 'fullscreen', win);
			return;
		case 'context':
			if (frame.ctx.sessionId) {
				setPageContext(frame.ctx.sessionId, frame.key, frame.title, request.value);
			}
			return;
		case 'prompt':
			frame.ctx.onPagePrompt?.(request.text, frame.title, false);
			return;
		case 'send': {
			const focused = frame.element.contains(win.document.activeElement);
			const now = Date.now();
			if (!focused || (frame.lastSend && now - frame.lastSend < PAGE_SEND_INTERVAL_MS)) {
				// Not from the user's click (or too fast): it goes to the composer for the user to send.
				frame.ctx.onPagePrompt?.(request.text, frame.title, false);
				return;
			}
			frame.lastSend = now;
			setFrameFullscreen(frame, false, win);
			frame.ctx.onPagePrompt?.(request.text, frame.title, true);
			return;
		}
	}
}

/**
 * Shows the page over the chat in the top layer (a popover), where it is: the iframe never moves,
 * so the page keeps its state. The row keeps its height so the transcript does not jump. Opaque and
 * contained like the inline frame (volt-transparent-window). Esc or the close button ends it.
 */
function setFrameFullscreen(frame: ILiveFrame, on: boolean, win: CodeWindow): boolean {
	const element = frame.element as HTMLElement & { showPopover?(): void; hidePopover?(): void };
	if (!element.showPopover || on === !!frame.fullscreen) {
		return !!element.showPopover;
	}
	if (!on) {
		frame.fullscreen?.dispose();
		return true;
	}
	const store = frame.fullscreen = new DisposableStore();
	const holder = element.parentElement;
	if (holder) {
		holder.style.minHeight = `${frame.height}px`;
	}
	element.setAttribute('popover', 'manual');
	element.classList.add('fullscreen');
	try {
		element.showPopover();
	} catch {
		// Not connected: stay inline.
	}
	// A bar above the page (its title and the exit button), so nothing covers the page's own controls.
	const bar = append(element, $('.volt-agent-visual-fullscreen-bar'));
	append(bar, $('span.volt-agent-visual-fullscreen-title')).textContent = frame.title;
	const close = append(bar, $('button.volt-agent-visual-fullscreen-close')) as HTMLButtonElement;
	close.type = 'button';
	close.setAttribute('aria-label', localize('voltVisual.exitFullscreen', "Exit Full Screen"));
	close.appendChild(renderIcon(Codicon.screenNormal));
	setAgentTooltip(close, localize('voltVisual.exitFullscreenEsc', "Exit Full Screen (Esc)"));
	store.add(addDisposableListener(close, 'click', event => {
		event.preventDefault();
		setFrameFullscreen(frame, false, win);
	}));
	store.add(addDisposableListener(win, 'keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			setFrameFullscreen(frame, false, win);
		}
	}, true));
	store.add(toDisposable(() => {
		bar.remove();
		try {
			element.hidePopover?.();
		} catch {
			// already hidden
		}
		element.removeAttribute('popover');
		element.classList.remove('fullscreen');
		element.style.height = `${frame.height}px`;
		if (holder) {
			holder.style.minHeight = '';
		}
		if (frame.fullscreen === store) {
			frame.fullscreen = undefined;
		}
	}));
	return true;
}

/** Saves the page as a standalone file with the current theme baked in, to open in a browser or share. */
async function savePage(ctx: IVisualHostContext, title: string, html: string): Promise<void> {
	await ctx.instantiationService.invokeFunction(async accessor => {
		const dialogs = accessor.get(IFileDialogService);
		const files = accessor.get(IFileService);
		const theme = accessor.get(IThemeService).getColorTheme();
		const provider = ctx.instantiationService.createInstance(WebviewThemeDataProvider);
		try {
			const vscode: Record<string, string> = {};
			for (const [name, value] of Object.entries(provider.getWebviewThemeData().styles)) {
				vscode[`--${name}`] = String(value);
			}
			const name = `${title.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'page'}.html`;
			const target = await dialogs.showSaveDialog({ title: localize('voltVisual.saveTitle', "Save Page"), defaultUri: joinPath(await dialogs.defaultFilePath(), name), filters: [{ name: 'HTML', extensions: ['html'] }] });
			if (target) {
				await files.writeFile(target, VSBuffer.fromString(buildVisualPage(html, { themeCss: visualThemeCss(theme, vscode), kind: themeKind(theme), preview: true })));
			}
		} finally {
			provider.dispose();
		}
	});
}

//#endregion

//#region The transcript block

/**
 * The placeholder for a visual on its way (the tool call still streaming in, its stored spec being
 * read, or the page loading): the dot loader, in the shape and height of what is coming. Only one
 * the agent is still making says so ("Creating chart"); a stored one loading is just the dots.
 */
export function renderVisualSkeleton(parent: HTMLElement, kind: 'chart' | 'html' | 'page', height?: number, hint?: { readonly shape?: DotLoaderShape; readonly creating?: boolean }): HTMLElement {
	const chart = kind === 'chart';
	const skeleton = renderDotLoader(parent, {
		shape: hint?.shape ?? 'wide',
		height,
		caption: hint?.creating ? (chart ? localize('voltVisual.creatingChart', "Creating chart") : localize('voltVisual.creatingPage', "Building page")) : undefined,
		ariaLabel: chart ? localize('voltVisual.loadingChart', "Loading chart") : localize('voltVisual.loadingPage', "Loading page"),
	});
	skeleton.classList.add('volt-agent-visual-skeleton', chart ? 'chart' : 'page');
	return skeleton;
}

function toolbarButton(parent: HTMLElement, icon: ThemeIconLike, label: string, run: () => void, store: DisposableStore): HTMLButtonElement {
	const button = append(parent, $('button.volt-agent-visual-action')) as HTMLButtonElement;
	button.type = 'button';
	button.setAttribute('aria-label', label);
	button.appendChild(renderIcon(icon));
	setAgentTooltip(button, label);
	store.add(addDisposableListener(button, 'click', event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
	return button;
}

type ThemeIconLike = Parameters<typeof renderIcon>[0];

/**
 * Mounts the loaded visual next to its skeleton, then drops the skeleton. Emptying the body first
 * shrinks the transcript for a moment: the layout read while mounting then clamps its scrollTop
 * (to 0 in a short chat), and the scroll event that follows stops the chat following the reply.
 */
function replaceBody(body: HTMLElement, mount: () => void): void {
	const old = Array.from(body.childNodes);
	mount();
	for (const node of old) {
		node.remove();
	}
}

/** Without a title row on top, the hover chip would sit on the chart's own switchers: lift it above. */
function placeActions(wrap: HTMLElement, body: HTMLElement): void {
	const titled = !!body.querySelector('.vc-visual-title') || !!body.querySelector('.vc-blocks > .vc-block:first-child > .vc-head:first-child, .vc-blocks > .vc-block:first-child > .vc-variant-head:first-child > .vc-head');
	wrap.classList.toggle('actions-above', !titled);
}

/**
 * A visual above the reply: a native Volt chart, or the agent's page in a sandboxed frame, with
 * Expand and Copy on hover. Loading holds the visual's own height, so nothing below it jumps.
 */
export function renderVisualBlock(parent: HTMLElement, block: IVisualBlock, ctx: IVisualHostContext & { readonly store: DisposableStore }): void {
	const wrap = append(parent, $('.volt-agent-block.volt-agent-visual'));
	wrap.classList.add(block.kind === 'html' ? 'page' : 'chart');
	const key = `${block.id}:${block.ref}`;
	const title = block.title || (block.kind === 'html' ? localize('voltVisual.page', "Page") : localize('voltVisual.chart', "Chart"));
	// A page gets a caption (its name, and its tools on the right) so nothing sits over the page's own controls.
	const caption = block.kind === 'html' ? renderPageCaption(wrap, title, !block.ref) : undefined;
	const body = append(wrap, $('.volt-agent-visual-body'));
	const actions = append(caption ?? wrap, $('.volt-agent-visual-actions'));
	if (!block.ref) {
		// The render_chart / render_html call is still streaming in: hold its place.
		wrap.classList.add('pending');
		renderVisualSkeleton(body, block.kind, block.kind === 'html' ? frameHeight(block.height) : undefined, { shape: block.shape, creating: true });
		return;
	}
	if (block.kind === 'chart') {
		const live = liveCharts.has(key);
		const draw = (spec: unknown) => {
			if (spec === undefined) {
				body.replaceChildren();
				append(body, $('.volt-agent-visual-missing')).textContent = localize('voltVisual.missing', "This chart is no longer stored.");
				return;
			}
			replaceBody(body, () => mountChart(body, key, spec, ctx));
			placeActions(wrap, body);
		};
		if (live) {
			mountChart(body, key, undefined, ctx);
			placeActions(wrap, body);
		} else {
			renderVisualSkeleton(body, 'chart');
			void loadSpec(ctx, block.ref).then(spec => draw(spec));
		}
		toolbarButton(actions, Codicon.screenFull, localize('voltVisual.expand', "Expand"), () => {
			void loadSpec(ctx, block.ref).then(spec => {
				if (spec === undefined || !ctx.onExpandVisual) {
					return;
				}
				const content = $('.volt-agent-visual-expanded');
				const handle = voltCharts(getWindow(parent)).render(content, spec, { strings: voltChartStrings(), onOpen: href => openVisualHref(href, ctx) });
				ctx.onExpandVisual(title, content, handle);
			});
		}, ctx.store);
		toolbarButton(actions, Codicon.copy, localize('voltVisual.copyData', "Copy Data as CSV"), () => {
			void loadSpec(ctx, block.ref).then(spec => spec !== undefined && ctx.onCopyText?.(voltCharts(getWindow(parent)).toCsv(spec)));
		}, ctx.store);
		return;
	}
	// A page: its frame survives redraws (see mountFrame); first time, load it from storage once it
	// is near the screen, so a long chat with many pages does not start a frame for each.
	const sizing: IFrameSizing = { heights: block.heights, cap: block.cap };
	if (liveFrames.has(key)) {
		mountFrame(body, key, title, '', block.height, ctx, sizing);
	} else {
		renderVisualSkeleton(body, 'page', frameHeight(pageHeightFor(replyWidth, block.heights, block.cap) ?? block.height));
		const load = () => void loadPage(ctx, block.ref).then(html => {
			if (!wrap.isConnected && !liveFrames.has(key)) {
				// Redrawn away while loading; the new row loads it.
				return;
			}
			if (html === undefined) {
				body.replaceChildren();
				append(body, $('.volt-agent-visual-missing')).textContent = localize('voltVisual.pageMissing', "This page is no longer stored.");
				return;
			}
			replaceBody(body, () => mountFrame(body, key, title, html, block.height, ctx, sizing));
		});
		whenNearScreen(wrap, load, ctx.store);
	}
	toolbarButton(actions, Codicon.screenFull, localize('voltVisual.fullscreen', "Full Screen"), () => {
		const live = liveFrames.get(key);
		if (live && setFrameFullscreen(live, true, getWindow(parent))) {
			return;
		}
		void loadPage(ctx, block.ref).then(html => {
			if (html === undefined || !ctx.onExpandVisual) {
				return;
			}
			const content = $('.volt-agent-visual-expanded.page');
			const frame = createFrame(`${key}:expanded`, title, html, Math.max(block.height ?? 0, 480), ctx, getWindow(parent));
			frame.element.style.height = '';
			frame.element.classList.add('fill');
			content.appendChild(frame.element);
			ctx.onExpandVisual(title, content, frame.store);
		});
	}, ctx.store);
	toolbarButton(actions, Codicon.copy, localize('voltVisual.copySource', "Copy HTML"), () => {
		void loadPage(ctx, block.ref).then(html => html !== undefined && ctx.onCopyText?.(html));
	}, ctx.store);
	toolbarButton(actions, Codicon.desktopDownload, localize('voltVisual.save', "Save as HTML File"), () => {
		void loadPage(ctx, block.ref).then(html => html !== undefined ? savePage(ctx, title, html) : undefined);
	}, ctx.store);
}

/** The line above a page: a window glyph, its title, and "Building…" while the call streams in. */
function renderPageCaption(wrap: HTMLElement, title: string, pending: boolean): HTMLElement {
	const caption = append(wrap, $('.volt-agent-visual-caption'));
	const label = append(caption, $('.volt-agent-visual-caption-label'));
	label.appendChild(renderIcon(Codicon.window));
	append(label, $('span.volt-agent-visual-caption-title')).textContent = title;
	if (pending) {
		append(label, $('span.volt-agent-visual-caption-status')).textContent = localize('voltVisual.building', "Building page");
	}
	return caption;
}

/** Runs `load` once `element` comes within a screen or so of the viewport (at once without IntersectionObserver). */
function whenNearScreen(element: HTMLElement, load: () => void, store: DisposableStore): void {
	const win = getWindow(element) as Window & typeof globalThis;
	if (typeof win.IntersectionObserver !== 'function') {
		load();
		return;
	}
	const observer = new win.IntersectionObserver(entries => {
		if (entries.some(entry => entry.isIntersecting)) {
			observer.disconnect();
			load();
		}
	}, { rootMargin: '1200px 0px' });
	observer.observe(element);
	store.add(toDisposable(() => observer.disconnect()));
}

/** The width a visual is laid out at in the reply column, for tools that measure pages. */
export const VISUAL_REPLY_WIDTH = VISUAL_COLUMN_WIDTH;

/** Disposes every live visual (window closing). */
export function disposeLiveVisuals(): IDisposable {
	return toDisposable(() => {
		for (const live of liveCharts.values()) {
			live.handle?.dispose();
		}
		liveCharts.clear();
		for (const live of liveFrames.values()) {
			live.store.dispose();
		}
		liveFrames.clear();
	});
}

//#endregion
