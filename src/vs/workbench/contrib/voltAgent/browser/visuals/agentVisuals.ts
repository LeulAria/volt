/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentVisuals.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { IMouseWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Color, RGBA } from '../../../../../base/common/color.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService, registerThemingParticipant } from '../../../../../platform/theme/common/themeService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';
import type { IVisualBlock } from '../blocks/agentBlocks.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
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
}

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

function createFrame(key: string, title: string, html: string, height: number | undefined, ctx: IVisualHostContext, win: CodeWindow): ILiveFrame {
	const store = new DisposableStore();
	const element = $('.volt-agent-visual-frame');
	element.style.height = `${frameHeight(height)}px`;
	const frame: ILiveFrame = {
		element,
		store,
		ctx,
		height: frameHeight(height),
		webview: undefined,
	};
	ctx.instantiationService.invokeFunction(accessor => {
		const webviewService = accessor.get(IWebviewService);
		const themeService = accessor.get(IThemeService);
		const webview = store.add(webviewService.createWebviewElement({
			title,
			origin: key,
			options: { enableFindWidget: false, purpose: WebviewContentPurpose.ChatOutputItem, tryRestoreScrollPosition: false, disableServiceWorker: true },
			contentOptions: { allowScripts: true, localResourceRoots: [] },
			extension: undefined,
		}));
		frame.webview = webview;
		const theme = themeService.getColorTheme();
		webview.setHtml(buildVisualPage(html, { themeCss: visualThemeCss(theme), kind: themeKind(theme) }));
		store.add(themeService.onDidColorThemeChange(next => {
			void webview.postMessage({ type: 'volt-theme', css: visualThemeCss(next), kind: themeKind(next) });
		}));
		store.add(autorun(reader => {
			const size = reader.readObservable(webview.intrinsicContentSize);
			if (size?.height) {
				frame.height = frameHeight(size.height);
				element.style.height = `${frame.height}px`;
			}
		}));
		store.add(webview.onDidWheel(event => frame.ctx.onWheel?.(event)));
		store.add(webview.onDidClickLink(link => openVisualHref(link, frame.ctx)));
		store.add(webview.onMessage(event => {
			const message = event.message as { type?: unknown; href?: unknown } | undefined;
			if (message?.type === 'volt-open' && typeof message.href === 'string') {
				openVisualHref(message.href, frame.ctx);
			}
		}));
		webview.mountTo(element, win);
	});
	return frame;
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
		const wasDetached = !live.element.isConnected;
		slot.replaceWith(live.element);
		if (wasDetached || !live.element.isConnected) {
			live.webview?.reinitializeAfterDismount();
		}
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
function mountFrame(host: HTMLElement, key: string, title: string, html: string, height: number | undefined, ctx: IVisualHostContext): void {
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
	const frame = createFrame(key, title, html, height, ctx, getWindow(host));
	host.appendChild(frame.element);
	touch(liveFrames, key, frame, MAX_LIVE_FRAMES, value => value.store.dispose());
}

//#endregion

//#region The transcript block

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
	const body = append(wrap, $('.volt-agent-visual-body'));
	const actions = append(wrap, $('.volt-agent-visual-actions'));
	const key = `${block.id}:${block.ref}`;
	const title = block.title || (block.kind === 'html' ? localize('voltVisual.page', "Page") : localize('voltVisual.chart', "Chart"));
	if (block.kind === 'chart') {
		const live = liveCharts.has(key);
		const draw = (spec: unknown) => {
			if (spec === undefined) {
				body.replaceChildren();
				append(body, $('.volt-agent-visual-missing')).textContent = localize('voltVisual.missing', "This chart is no longer stored.");
				return;
			}
			body.replaceChildren();
			mountChart(body, key, spec, ctx);
			placeActions(wrap, body);
		};
		if (live) {
			mountChart(body, key, undefined, ctx);
			placeActions(wrap, body);
		} else {
			body.style.minHeight = '240px';
			void loadSpec(ctx, block.ref).then(spec => {
				body.style.minHeight = '';
				draw(spec);
			});
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
	// A page: its frame survives redraws (see mountFrame); first time, load it from storage.
	if (liveFrames.has(key)) {
		mountFrame(body, key, title, '', block.height, ctx);
	} else {
		body.style.height = `${frameHeight(block.height)}px`;
		void loadPage(ctx, block.ref).then(html => {
			body.style.height = '';
			if (html === undefined) {
				append(body, $('.volt-agent-visual-missing')).textContent = localize('voltVisual.pageMissing', "This page is no longer stored.");
				return;
			}
			if (!wrap.isConnected && !liveFrames.has(key)) {
				// Redrawn away while loading; the new row loads it.
				return;
			}
			mountFrame(body, key, title, html, block.height, ctx);
		});
	}
	toolbarButton(actions, Codicon.screenFull, localize('voltVisual.expand', "Expand"), () => {
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
