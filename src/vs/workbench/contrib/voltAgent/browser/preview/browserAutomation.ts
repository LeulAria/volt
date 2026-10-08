/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveDocument } from '../../../../../base/browser/dom.js';
import { raceCancellation, raceTimeout, SequencerByKey, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { decodeDataUrl, encodeImage, ImageFormat, scaleScreenshot } from '../../../../services/voltRuntime/browser/host/imageCodec.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, BROWSER_PAGE_URL_COMMAND_ID, IVoltBrowserAutomationOptions, IVoltHostToolResult, IVoltHostToolService, VoltBrowserAutomationToolName } from '../../../../services/voltRuntime/common/hostTools.js';
import { VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { diffAx, formatAxLine, IAxItem, placeOnImage, readingOrder, strokeBoxes } from '../../../../services/voltRuntime/common/tools/axAnnotations.js';
import { clampRect, compareImages, compareLayout, cropImage, describeComparison, describeLayout, diffHeatmap, parseRect, sideBySide } from '../../../../services/voltRuntime/common/tools/imageAnalysis.js';
import { agentSessionBrowser } from '../workspace/agentSurfaceHost.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { keepUserFocus } from './agentFocusGuard.js';
import { IVoltBrowserViews, IVoltConsoleMessage, normalizeBrowserUrl, VoltBrowserView } from './browserEditor.js';
import { clickFallbackScript, evaluateScript, focusScript, INetworkEntry, NETWORK_SCRIPT, rectScript, scrollScript, selectOptionScript, setValueScript, SNAPSHOT_SCRIPT, snapshotScript, targetScript, textPresentScript } from './browserAutomationScripts.js';

interface IPageSnapshot {
	url: string;
	title: string;
	yaml: string;
	error?: string;
	viewport?: { width: number; height: number; scrollY: number; scrollHeight: number; scrollWidth: number };
	items?: IAxItem[];
}

interface ITarget {
	x: number;
	y: number;
	covered?: string;
	disabled?: boolean;
	error?: string;
}

interface IAutomationServices {
	readonly workspace: IAgentWorkspaceService;
	readonly views: IVoltBrowserViews;
}

interface ICallContext {
	readonly token: CancellationToken;
	readonly options: IVoltBrowserAutomationOptions;
}

class AutomationError extends Error { }

const SCRIPT_TIMEOUT_MS = 10000;
const PAINTED_SCRIPT = `(async () => { try { await document.fonts.ready; } catch {} await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`;

/** A capture of one solid color: the page has not painted yet. */
async function isFlatImage(dataUrl: string): Promise<boolean> {
	try {
		const image = await decodeDataUrl(dataUrl, { width: 24, height: 24 });
		const data = image.data;
		for (let i = 4; i < data.length; i += 4) {
			if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 6) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}
/** Views the agent holds right now, per chat; the lock lifts when the chat's run ends. */
const locked = new Map<string, VoltBrowserView>();
/** One browser call per chat at a time, in arrival order, so parallel calls never interleave input. */
const queue = new SequencerByKey<string>();
/** Calls running or queued per chat; a run that ends cancels them. */
const inflight = new Map<string, Set<CancellationTokenSource>>();

function cancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new AutomationError('Cancelled.');
	}
}

async function run<T>(view: VoltBrowserView, code: string, token: CancellationToken = CancellationToken.None): Promise<T> {
	const result = await raceCancellation(raceTimeout(view.runScript<T>(code), SCRIPT_TIMEOUT_MS), token);
	cancelled(token);
	if (result === undefined) {
		throw new AutomationError('The page did not respond (it may be busy or still loading). Try browser_wait_for, then retry.');
	}
	return result;
}

function staleRef(ref: string): AutomationError {
	return new AutomationError(`Ref ${ref} is not on the page anymore. Call browser_snapshot and use a current ref.`);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Electron key codes for `sendInputEvent`, from Playwright-style names. */
function electronKey(key: string): string {
	const map: Record<string, string> = {
		ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
		Esc: 'Escape', Return: 'Enter', ' ': 'Space', Spacebar: 'Space', Del: 'Delete',
	};
	return map[key] ?? key;
}

const MODIFIERS: Record<string, string> = { shift: 'shift', control: 'control', ctrl: 'control', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta', controlormeta: 'meta' };

function pressKey(view: VoltBrowserView, combo: string): void {
	const parts = combo.split('+').map(part => part.trim()).filter(Boolean);
	const key = parts.pop() ?? combo;
	const modifiers = parts.map(part => MODIFIERS[part.toLowerCase()]).filter((mod): mod is string => !!mod);
	const keyCode = electronKey(key);
	view.sendInput({ type: 'keyDown', keyCode, modifiers });
	if ((key.length === 1 || keyCode === 'Enter' || keyCode === 'Space') && !modifiers.some(mod => mod !== 'shift')) {
		view.sendInput({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : key, modifiers });
	}
	view.sendInput({ type: 'keyUp', keyCode, modifiers });
}

async function target(view: VoltBrowserView, ref: string, token: CancellationToken): Promise<ITarget> {
	const hit = await run<ITarget>(view, targetScript(ref), token);
	if (hit.error) {
		throw staleRef(ref);
	}
	return hit;
}

function mouseClick(view: VoltBrowserView, x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): void {
	view.showAgentClick(x, y);
	view.sendInput({ type: 'mouseMove', x, y });
	view.sendInput({ type: 'mouseDown', x, y, button, clickCount: 1 });
	view.sendInput({ type: 'mouseUp', x, y, button, clickCount: 1 });
	if (double) {
		view.sendInput({ type: 'mouseDown', x, y, button, clickCount: 2 });
		view.sendInput({ type: 'mouseUp', x, y, button, clickCount: 2 });
	}
}

async function click(view: VoltBrowserView, ref: string, options: { double?: boolean; button?: 'left' | 'right' | 'middle' }, token: CancellationToken): Promise<string[]> {
	const hit = await target(view, ref, token);
	const notes: string[] = [];
	if (hit.disabled) {
		notes.push('Note: the element is disabled, so the click may have done nothing.');
	}
	const button = options.button ?? 'left';
	if (hit.covered || !view.canSendInput()) {
		// Something sits on top of the element's center (a toast, an overlay): click the element itself.
		await run(view, clickFallbackScript(ref), token);
		if (hit.covered) {
			notes.push(`Note: the element was covered by \`${hit.covered}\`, so it was clicked directly instead of with the mouse.`);
		}
	} else {
		mouseClick(view, hit.x, hit.y, button, !!options.double);
	}
	await view.settle(10000, token);
	return notes;
}

function formatConsole(messages: readonly IVoltConsoleMessage[], limit = 40): string[] {
	return messages.slice(-limit).map(msg => {
		const where = msg.source ? ` (${msg.source.replace(/^.*\//, '')}${msg.line ? `:${msg.line}` : ''})` : '';
		return `- [${msg.level}] ${msg.message.replace(/\s+/g, ' ').slice(0, 400)}${where}`;
	});
}

async function pageState(view: VoltBrowserView, withSnapshot = true, script = SNAPSHOT_SCRIPT): Promise<string[]> {
	const lines = ['### Page state'];
	const snap = await raceTimeout(view.runScript<IPageSnapshot>(script), SCRIPT_TIMEOUT_MS).catch(() => undefined);
	if (!snap) {
		lines.push('- The page did not answer (still loading or busy).');
		return lines;
	}
	lines.push(`- Page URL: ${snap.url}`, `- Page Title: ${snap.title || '(untitled)'}`);
	const viewport = view.getViewport();
	if (snap.viewport) {
		const overflow = snap.viewport.scrollWidth > snap.viewport.width + 1 ? ` (content is ${snap.viewport.scrollWidth}px wide: horizontal overflow)` : '';
		lines.push(`- Viewport: ${snap.viewport.width}×${snap.viewport.height}${viewport ? ' (fixed)' : ''}, scrolled ${snap.viewport.scrollY}/${Math.max(0, snap.viewport.scrollHeight - snap.viewport.height)}${overflow}`);
	}
	const errors = view.takeConsole(true).filter(msg => msg.level === 'error' || msg.level === 'warning');
	if (errors.length) {
		lines.push('- New console errors/warnings:', ...formatConsole(errors, 10).map(line => `  ${line}`));
	}
	if (withSnapshot) {
		lines.push('- Page Snapshot:', '```yaml', snap.yaml, '```');
	}
	return lines;
}

function action(name: string, details: Record<string, string | undefined>): string[] {
	const lines = [`### Action: ${name}`];
	for (const [key, value] of Object.entries(details)) {
		if (value !== undefined) {
			lines.push(`- ${key}: ${value}`);
		}
	}
	return lines;
}

/** Finds the chat's browser tab, opening one for `browser_navigate`, and brings it to the front. */
async function browserFor(services: IAutomationServices, sessionId: string, openUrl: string | undefined, token: CancellationToken): Promise<{ view: VoltBrowserView; opened: boolean }> {
	let found = agentSessionBrowser(sessionId);
	let opened = false;
	if (!found) {
		if (!openUrl) {
			throw new AutomationError('No page is open in the in-app browser yet. Call browser_navigate with a URL first.');
		}
		let title = 'Browser';
		try {
			title = new URL(openUrl).host || title;
		} catch {
			// keep the fallback title
		}
		services.workspace.openSurface(sessionId, { kind: 'browser', url: openUrl, title, floating: true }, true);
		const started = Date.now();
		while (!found && Date.now() - started < 6000) {
			cancelled(token);
			await timeout(60);
			found = agentSessionBrowser(sessionId);
		}
		if (!found) {
			throw new AutomationError('The in-app browser could not open: its tab lives beside this chat, so the chat has to be open in a Volt window.');
		}
		opened = true;
	}
	if (found.group.activeEditor !== found.input) {
		await found.group.openEditor(found.input, { preserveFocus: true });
	}
	return { view: services.views.viewFor(found.input), opened };
}

interface IShot {
	readonly image: string;
	readonly width: number;
	readonly height: number;
	/** Interactive elements inside the image, boxes in image pixels. */
	readonly items?: IAxItem[];
}

/**
 * A screenshot sized for the model: CSS pixels (not Retina device pixels), at most `max_side`
 * (default 1280) on the longest side, JPEG unless asked otherwise. With `ref`, only that element.
 * With `withItems`, also the interactive elements that land in the image, with their refs.
 */
async function screenshot(view: VoltBrowserView, args: Record<string, unknown>, token: CancellationToken, withItems = false): Promise<IShot | undefined> {
	// Web fonts and the first paint land after `load`; a capture before them comes back flat.
	await raceTimeout(view.runScript(PAINTED_SCRIPT), 3000);
	const ref = str(args.ref);
	const rect = ref ? await run<{ x: number; y: number; w: number; h: number; viewportWidth: number; error?: string }>(view, rectScript(ref), token) : undefined;
	if (rect?.error) {
		throw staleRef(ref!);
	}
	if (rect) {
		await timeout(60);
	}
	const page = withItems ? await raceTimeout(view.runScript<IPageSnapshot>(snapshotScript({ interactive: true, items: true })), SCRIPT_TIMEOUT_MS).catch(() => undefined) : undefined;
	let image = await view.captureSnapshot();
	if (image && await isFlatImage(image)) {
		await timeout(400);
		image = await view.captureSnapshot() ?? image;
	}
	cancelled(token);
	if (!image) {
		return undefined;
	}
	const cssWidth = rect?.viewportWidth ?? await raceTimeout(view.runScript<number>('innerWidth'), 2000).catch(() => undefined);
	const format: ImageFormat = args.format === 'png' || args.format === 'webp' ? args.format : 'jpeg';
	const maxSide = Math.max(256, Math.min(2560, num(args.max_side) ?? 1280));
	const crop = rect && rect.w > 0 && rect.h > 0 ? rect : undefined;
	try {
		const shot = await scaleScreenshot(image, { maxSide, targetWidth: typeof cssWidth === 'number' ? cssWidth : undefined, format, crop });
		const items = page?.items && page.viewport && shot.width ? placeOnImage(page.items, {
			origin: crop ? { x: crop.x, y: crop.y } : { x: 0, y: 0 },
			scale: shot.width / (crop ? crop.w : page.viewport.width),
			width: shot.width,
			height: shot.height,
		}) : undefined;
		return { image: shot.dataUrl, width: shot.width, height: shot.height, items };
	} catch {
		return { image, width: 0, height: 0 };
	}
}

/** Parses Chromium's own console lines about failed loads: 404s, net::ERR_*, CORS blocks. */
function consoleFailures(messages: readonly IVoltConsoleMessage[]): INetworkEntry[] {
	const out: INetworkEntry[] = [];
	for (const msg of messages) {
		const failed = /^Failed to load resource: (.+)$/.exec(msg.message.trim());
		if (failed && msg.source) {
			const status = /status of (\d{3})/.exec(failed[1]);
			const error = /net::(ERR_[A-Z_]+)/.exec(failed[1]);
			out.push({ url: msg.source, type: 'resource', status: status ? Number(status[1]) : undefined, error: error?.[1], ms: 0 });
			continue;
		}
		const cors = /Access to (\w+)(?: request)? at '([^']+)' from origin '[^']*' has been blocked by CORS policy/.exec(msg.message);
		if (cors) {
			out.push({ url: cors[2], type: cors[1], error: 'blocked by CORS policy', ms: 0 });
		}
	}
	return out;
}

function sizeText(bytes: number | undefined): string {
	if (!bytes) {
		return '';
	}
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function requestLine(entry: INetworkEntry): string {
	const what = entry.status ? String(entry.status) : entry.error ?? 'ok';
	const extra = [entry.type, entry.ms ? `${entry.ms} ms` : '', sizeText(entry.bytes)].filter(Boolean).join(', ');
	return `- ${what} ${entry.method ? `${entry.method} ` : ''}${entry.url.slice(0, 300)}${extra ? ` (${extra})` : ''}`;
}

async function network(view: VoltBrowserView, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
	const data = await run<{ entries: INetworkEntry[]; failures: INetworkEntry[] }>(view, NETWORK_SCRIPT, token);
	const filter = str(args.filter);
	const keep = (entry: INetworkEntry) => !filter || entry.url.includes(filter);
	const entries = data.entries.filter(keep);
	const failed: INetworkEntry[] = [];
	const seen = new Set<string>();
	for (const entry of [...data.failures, ...consoleFailures(view.peekConsole()), ...entries.filter(item => (item.status ?? 0) >= 400)].filter(keep)) {
		const key = `${entry.url}|${entry.status ?? entry.error}`;
		if (!seen.has(key)) {
			seen.add(key);
			failed.push(entry);
		}
	}
	const lines = [`### Network (since the page loaded${filter ? `, URLs containing "${filter}"` : ''}): ${entries.length} requests, ${failed.length} failed`];
	lines.push(failed.length ? '- Failed:' : '- No failed requests.', ...failed.slice(0, 30).map(entry => `  ${requestLine(entry)}`));
	if (args.all === true) {
		lines.push('- All requests:', ...entries.slice(0, 100).map(entry => `  ${requestLine(entry)}`));
		if (entries.length > 100) {
			lines.push(`  (${entries.length - 100} more)`);
		}
	} else if (entries.length) {
		const slowest = [...entries].sort((a, b) => b.ms - a.ms).slice(0, 5);
		lines.push('- Slowest:', ...slowest.map(entry => `  ${requestLine(entry)}`));
		const largest = entries.filter(entry => entry.bytes).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 5);
		if (largest.length) {
			lines.push('- Largest:', ...largest.map(entry => `  ${requestLine(entry)}`));
		}
	}
	lines.push('- Note: fetch/XHR failures are recorded from the first browser tool call on this page; failures before that show only when the browser logged them.');
	return { text: lines.join('\n') };
}

/** Renders the page at the reference image's size, diffs the two, and explains the largest differences. */
async function compare(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const { token } = ctx;
	const reference = ctx.options.reference;
	if (!reference) {
		return { error: 'browser_compare_image needs a readable `reference_path` image.' };
	}
	const scale = Math.max(0.25, Math.min(4, num(args.scale) ?? 1));
	const width = Math.max(200, Math.min(4096, Math.round(num(args.width) ?? reference.width / scale)));
	const height = Math.max(200, Math.min(4096, Math.round(num(args.height) ?? reference.height / scale)));
	const notes: string[] = [];
	const current = view.getViewport();
	if (!current || current.width !== width || current.height !== height) {
		view.setViewport({ width, height });
		await timeout(180);
	}
	const url = str(args.url);
	if (url) {
		if (!await view.navigateForAgent(normalizeBrowserUrl(url), 20000, token)) {
			notes.push('- Note: the page was still loading after 20s.');
		}
	} else if (args.reload !== false) {
		await view.historyForAgent('reload-fresh', token);
	}
	await view.settle(10000, token);
	await raceTimeout(view.runScript(PAINTED_SCRIPT), 3000);
	cancelled(token);
	const shot = await view.captureSnapshot();
	cancelled(token);
	if (!shot) {
		return { error: 'The page could not be captured yet.' };
	}
	let page = await decodeDataUrl(shot, { width: reference.width, height: reference.height });
	let ref = reference;
	const requested = parseRect(args.region);
	const region = requested ? clampRect(requested, reference.width, reference.height) : undefined;
	if (requested && !region) {
		return { error: `region is outside the ${reference.width}×${reference.height} reference.` };
	}
	if (region) {
		ref = cropImage(reference, region);
		page = cropImage(page, region);
	}
	const diff = compareImages(ref, page, { threshold: num(args.threshold) });
	const label = ctx.options.referenceLabel ?? 'reference';
	if (Math.abs(width / height - reference.width / reference.height) > 0.01) {
		notes.push(`- Note: the viewport's aspect ratio differs from the image; the page capture was stretched to ${reference.width}×${reference.height} to compare.`);
	}
	const errors = view.takeConsole(true).filter(msg => msg.level === 'error');
	const lines = [
		`### Compared with ${label}`,
		`- Reference: ${reference.width}×${reference.height} px${scale !== 1 ? ` (scale ${scale})` : ''}${region ? `, region x ${region.x}, y ${region.y}, ${region.w}×${region.h}` : ''}`,
		`- Page: ${view.pageUrl} rendered at ${width}×${height} CSS px (viewport left at this size; browser_resize reset: true restores it)`,
		...notes,
		...describeComparison(diff, region ? { x: region.x, y: region.y } : undefined),
	];
	if (diff.mismatchRatio >= 0.001) {
		lines.push(...describeLayout(compareLayout(ref, page, 6), region ? { x: region.x, y: region.y } : undefined));
	}
	if (errors.length) {
		lines.push('- Console errors on the page:', ...formatConsole(errors, 5).map(line => `  ${line}`));
	}
	const mode = args.image === 'none' || args.image === 'side_by_side' ? args.image : 'heatmap';
	if (mode === 'none' || (mode === 'heatmap' && diff.mismatchRatio < 0.001)) {
		return { text: lines.join('\n') };
	}
	if (mode === 'side_by_side') {
		const heat = diffHeatmap(page, diff, 1280);
		lines.push('- Image: reference | page | differences (red), numbered boxes match the regions above');
		return { text: lines.join('\n'), image: await encodeImage(sideBySide([ref, page, heat.image], 1280), 'jpeg', 0.82) };
	}
	const heat = diffHeatmap(page, diff, 800);
	lines.push('- Image: the page in grey with differing pixels in red; numbered boxes match the regions above');
	return { text: lines.join('\n'), image: await encodeImage(heat.image, 'jpeg', 0.8, heat.labels) };
}

async function automate(services: IAutomationServices, sessionId: string, tool: VoltBrowserAutomationToolName, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const url = tool === 'browser_navigate' ? str(args.url) : tool === BROWSER_COMPARE_IMAGE_TOOL_NAME ? str(args.url) : undefined;
	if (tool === 'browser_navigate' && !url) {
		return { error: 'browser_navigate needs a `url`.' };
	}
	const normalized = url ? normalizeBrowserUrl(url) : undefined;
	try {
		cancelled(ctx.token);
		const { view, opened } = await browserFor(services, sessionId, normalized, ctx.token);
		lock(sessionId, view);
		if (!opened || tool !== 'browser_navigate') {
			if (!await view.automationReady(tool === 'browser_navigate' ? 2000 : 15000, ctx.token) && tool !== 'browser_navigate') {
				cancelled(ctx.token);
				throw new AutomationError('The in-app browser page is not ready yet.');
			}
		}
		// The user keeps typing in the composer while the agent clicks and types in the page.
		const result = await keepUserFocus(getActiveDocument(), () => act(view, tool, args, normalized, opened, ctx));
		if (args.screenshot === true && !result.error && !result.image && tool !== 'browser_screenshot') {
			const shot = await screenshot(view, {}, ctx.token);
			if (shot) {
				return { text: `${result.text ?? ''}\n- Screenshot attached${shot.width ? ` (${shot.width}×${shot.height})` : ''}`, image: shot.image };
			}
		}
		return result;
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const DEFAULT_LISTED_ELEMENTS = 60;

/** The elements listed with the last screenshot of each view; refs are stable per element, so a follow-up can diff by ref. */
const lastListing = new WeakMap<VoltBrowserView, { url: string; items: IAxItem[] }>();

/**
 * Lists the interactive elements a screenshot shows. The first capture of a page lists them all up
 * to `max_elements`; a later capture of the same page lists only what was added, changed or removed.
 * `ax: "full"` forces the full list.
 */
function elementListing(view: VoltBrowserView, shot: IShot, args: Record<string, unknown>): { lines: string[]; listed: IAxItem[] } {
	if (!shot.items) {
		return { lines: [], listed: [] };
	}
	const budget = Math.max(5, Math.min(200, num(args.max_elements) ?? DEFAULT_LISTED_ELEMENTS));
	const ordered = readingOrder(shot.items);
	const listed = ordered.slice(0, budget);
	const previous = lastListing.get(view);
	lastListing.set(view, { url: view.pageUrl, items: shot.items });
	const more = ordered.length > listed.length ? [`- …${ordered.length - listed.length} more in view (raise max_elements)`] : [];
	if (!previous || previous.url !== view.pageUrl || args.ax === 'full') {
		const header = '### Elements in the screenshot (box = x, y, w, h in image pixels; pass a ref to browser_click, browser_type, …)';
		return { lines: [header, ...(listed.length ? listed.map(formatAxLine) : ['- (no interactive elements in view)']), ...more], listed };
	}
	const diff = diffAx(previous.items, shot.items);
	const lines = [`### Changes since the last screenshot (${diff.unchanged} unchanged)`];
	if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
		lines.push('- No element was added, changed or removed. Positions are in the image.');
	}
	if (diff.added.length) {
		lines.push('- Added:', ...readingOrder(diff.added).slice(0, budget).map(item => `  ${formatAxLine(item)}`));
	}
	if (diff.changed.length) {
		lines.push('- Changed:', ...readingOrder(diff.changed).slice(0, budget).map(item => `  ${formatAxLine(item)}`));
	}
	if (diff.removed.length) {
		lines.push(`- Removed: ${diff.removed.map(item => item.ref).join(', ')}`);
	}
	return { lines, listed };
}

/** The screenshot with a numbered outline (its ref) around each listed element. */
async function markedImage(shot: IShot, listed: readonly IAxItem[], format: ImageFormat): Promise<string> {
	const image = await decodeDataUrl(shot.image, { width: shot.width, height: shot.height });
	const stroked = strokeBoxes(image, listed.map(item => item.box));
	return encodeImage(stroked, format, 0.8, listed.map(item => ({ x: item.box[0], y: item.box[1], text: item.ref })));
}

async function act(view: VoltBrowserView, tool: VoltBrowserAutomationToolName, args: Record<string, unknown>, normalized: string | undefined, opened: boolean, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const { token } = ctx;
	const ref = str(args.ref);
	const element = str(args.element);
	switch (tool) {
		case 'browser_navigate': {
			const loaded = opened ? await view.automationReady(20000, token) : await view.navigateForAgent(normalized!, 20000, token);
			cancelled(token);
			const head = action('navigate', { URL: normalized });
			if (!loaded) {
				head.push('- Note: the page is still loading after 20s.');
			}
			return { text: [...head, '', ...await pageState(view)].join('\n') };
		}
		case 'browser_snapshot': {
			const selector = str(args.selector);
			const interactive = args.interactive === true;
			const script = selector || interactive ? snapshotScript({ selector, interactive }) : SNAPSHOT_SCRIPT;
			return { text: (await pageState(view, true, script)).join('\n') };
		}
		case 'browser_click': {
			const double = args.doubleClick === true;
			const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
			const x = num(args.x);
			const y = num(args.y);
			if (!ref) {
				if (x === undefined || y === undefined) {
					return { error: 'browser_click needs a `ref` from browser_snapshot, or `x` and `y` viewport coordinates.' };
				}
				if (!view.canSendInput()) {
					return { error: 'Coordinate clicks are not available in this browser; use a ref.' };
				}
				mouseClick(view, Math.round(x), Math.round(y), button, double);
				await view.settle(10000, token);
				return { text: [...action('click', { 'Element': element, 'At': `${Math.round(x)}, ${Math.round(y)}`, 'Click type': double ? 'double-click' : 'single-click', 'Button': button }), '', ...await pageState(view)].join('\n') };
			}
			const notes = await click(view, ref, { double, button }, token);
			return { text: [...action('click', { 'Element': element, 'Ref': ref, 'Click type': double ? 'double-click' : 'single-click', 'Button': button }), ...notes, '', ...await pageState(view)].join('\n') };
		}
		case 'browser_type': {
			const text = typeof args.text === 'string' ? args.text : undefined;
			if (!ref || text === undefined) {
				return { error: 'browser_type needs `ref` and `text`.' };
			}
			const clear = args.clear !== false;
			const focus = await run<{ error?: string; focused?: boolean }>(view, focusScript(ref, clear), token);
			if (focus.error) {
				throw staleRef(ref);
			}
			if (!await view.insertText(text).catch(() => false)) {
				await run(view, setValueScript(ref, text, clear), token);
			}
			if (args.submit === true) {
				pressKey(view, 'Enter');
			}
			await view.settle(10000, token);
			return { text: [...action('type', { 'Element': element, 'Ref': ref, 'Text': JSON.stringify(text), 'Submitted': args.submit === true ? 'yes' : undefined }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_press_key': {
			const key = str(args.key);
			if (!key) {
				return { error: 'browser_press_key needs a `key`.' };
			}
			pressKey(view, key);
			await view.settle(10000, token);
			return { text: [...action('press key', { Key: key }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_hover': {
			if (!ref) {
				return { error: 'browser_hover needs a `ref`.' };
			}
			const hit = await target(view, ref, token);
			view.sendInput({ type: 'mouseMove', x: hit.x, y: hit.y });
			await view.settle(10000, token);
			return { text: [...action('hover', { Element: element, Ref: ref }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_select_option': {
			const values = Array.isArray(args.values) ? args.values.map(value => String(value)) : [];
			if (!ref || !values.length) {
				return { error: 'browser_select_option needs `ref` and `values`.' };
			}
			const picked = await run<{ error?: string; picked?: string[] }>(view, selectOptionScript(ref, values), token);
			if (picked.error === 'stale') {
				throw staleRef(ref);
			}
			if (picked.error) {
				return { error: `${element ?? ref} is not a <select>. Click it and choose the option instead.` };
			}
			await view.settle(10000, token);
			return { text: [...action('select option', { Element: element, Ref: ref, Selected: picked.picked?.join(', ') || '(no matching option)' }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_scroll': {
			const dy = num(args.deltaY) ?? (ref ? 0 : 600);
			const dx = num(args.deltaX) ?? 0;
			const scrolled = await run<{ error?: string }>(view, scrollScript(ref, dx, dy), token);
			if (scrolled.error && ref) {
				throw staleRef(ref);
			}
			await view.settle(10000, token);
			return { text: [...action('scroll', { Element: element, 'Delta Y': String(dy), 'Delta X': dx ? String(dx) : undefined }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_resize': {
			const width = num(args.width);
			const height = num(args.height);
			const reset = args.reset === true || width === undefined || height === undefined;
			view.setViewport(reset ? undefined : { width: width!, height: height! });
			await timeout(180);
			await view.settle(10000, token);
			return { text: [...action('resize', reset ? { Viewport: 'fills the pane' } : { Viewport: `${Math.round(width!)}×${Math.round(height!)}` }), '', ...await pageState(view)].join('\n') };
		}
		case 'browser_wait_for': {
			const text = str(args.text);
			const gone = str(args.textGone);
			const seconds = Math.min(30, Math.max(0, num(args.time) ?? 0));
			const started = Date.now();
			let met = true;
			if (text || gone) {
				const limit = (seconds || 10) * 1000;
				met = false;
				while (Date.now() - started < limit) {
					cancelled(token);
					const present = await raceTimeout(view.runScript<boolean>(textPresentScript((text ?? gone)!)), 2000);
					if (text ? present === true : present === false) {
						met = true;
						break;
					}
					await timeout(120);
				}
			} else {
				await raceCancellation(timeout(seconds * 1000), token);
			}
			cancelled(token);
			const head = action('wait for', { 'Text': text && JSON.stringify(text), 'Text gone': gone && JSON.stringify(gone), 'Waited': `${((Date.now() - started) / 1000).toFixed(1)}s` });
			if (!met) {
				head.push('- Result: timed out');
			}
			return { text: [...head, '', ...await pageState(view)].join('\n') };
		}
		case 'browser_evaluate': {
			const expression = str(args.expression);
			if (!expression) {
				return { error: 'browser_evaluate needs an `expression`.' };
			}
			const result = await run<{ value?: string; error?: string }>(view, evaluateScript(expression, ref), token);
			if (result.error) {
				return { error: `The expression threw: ${result.error.slice(0, 2000)}` };
			}
			const value = (result.value ?? 'undefined').slice(0, 20000);
			return { text: [...action('evaluate', { Element: element, Ref: ref }), '', '### Result', '```json', value, '```'].join('\n') };
		}
		case 'browser_console_messages': {
			const all = view.takeConsole(false);
			const messages = args.errorsOnly === true ? all.filter(msg => msg.level === 'error' || msg.level === 'warning') : all;
			return { text: ['### Console', ...(messages.length ? formatConsole(messages, 120) : ['- (no messages)'])].join('\n') };
		}
		case BROWSER_NETWORK_TOOL_NAME:
			return network(view, args, token);
		case 'browser_navigate_back':
			await view.historyForAgent('back', token);
			cancelled(token);
			return { text: [...action('navigate back', {}), '', ...await pageState(view)].join('\n') };
		case 'browser_reload':
			await view.historyForAgent('reload', token);
			cancelled(token);
			return { text: [...action('reload', {}), '', ...await pageState(view)].join('\n') };
		case 'browser_screenshot': {
			const shot = await screenshot(view, args, token, args.ax !== 'off');
			if (!shot) {
				return { error: 'The page could not be captured yet.' };
			}
			const details = { Element: ref ? (element ?? ref) : undefined, Size: shot.width ? `${shot.width}×${shot.height}` : undefined };
			const listing = elementListing(view, shot, args);
			const format: ImageFormat = args.format === 'png' || args.format === 'webp' ? args.format : 'jpeg';
			const image = args.marks === true && listing.listed.length ? await markedImage(shot, listing.listed, format) : shot.image;
			return { text: [...action('screenshot', details), '', ...await pageState(view, false), '', ...listing.lines].join('\n'), image };
		}
		case BROWSER_COMPARE_IMAGE_TOOL_NAME:
			return compare(view, args, ctx);
	}
}

function lock(sessionId: string, view: VoltBrowserView): void {
	const held = locked.get(sessionId);
	if (held && held !== view) {
		held.setAgentLock(false);
	}
	locked.set(sessionId, view);
	view.setAgentLock(true);
}

export function releaseAgentBrowser(sessionId: string): void {
	locked.get(sessionId)?.setAgentLock(false);
	locked.delete(sessionId);
}

/** Stops every browser call a chat has running or queued (its run ended or was cancelled). */
export function cancelAgentBrowserCalls(sessionId: string): void {
	for (const source of inflight.get(sessionId) ?? []) {
		source.cancel();
	}
}

CommandsRegistry.registerCommand(AUTOMATE_BROWSER_COMMAND_ID, (accessor: ServicesAccessor, sessionId: string, tool: VoltBrowserAutomationToolName, args?: Record<string, unknown>, options?: IVoltBrowserAutomationOptions) => {
	// The accessor is only valid now, not once the call's turn in the queue comes.
	const services: IAutomationServices = { workspace: accessor.get(IAgentWorkspaceService), views: accessor.get(IVoltBrowserViews) };
	const source = new CancellationTokenSource(options?.token);
	let calls = inflight.get(sessionId);
	if (!calls) {
		calls = new Set();
		inflight.set(sessionId, calls);
	}
	calls.add(source);
	const ctx: ICallContext = { token: source.token, options: options ?? {} };
	return queue.queue(sessionId, () => source.token.isCancellationRequested
		? Promise.resolve<IVoltHostToolResult>({ error: 'Cancelled.' })
		: automate(services, sessionId, tool, args ?? {}, ctx)
	).finally(() => {
		calls.delete(source);
		if (!calls.size && inflight.get(sessionId) === calls) {
			inflight.delete(sessionId);
		}
		source.dispose();
	});
});

CommandsRegistry.registerCommand(BROWSER_PAGE_URL_COMMAND_ID, (_accessor: ServicesAccessor, sessionId: string): string | undefined => {
	return agentSessionBrowser(sessionId)?.input.url;
});

/**
 * Hands the page back when the agent's turn ends, stops for a question, or the user takes control;
 * cancels browser calls of a run that ended; and tells the host tools each chat's mode and folder.
 */
class AgentBrowserLockContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentBrowserLock';

	private readonly takeControl = this._register(new DisposableMap<VoltBrowserView>());
	private readonly modes = new Map<string, VoltMode>();

	constructor(
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
	) {
		super();
		hostTools.setSessionResolver({
			mode: sessionId => this.modes.get(sessionId),
			cwd: sessionId => this.modes.has(sessionId) ? runtime.getOrCreateSession(sessionId).worktreePath : undefined,
		});
		this._register(toDisposable(() => hostTools.setSessionResolver(undefined)));
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			if (event.type === 'run.start') {
				this.modes.set(sessionId, event.mode);
			}
			const view = locked.get(sessionId);
			if (view && !this.takeControl.has(view)) {
				this.takeControl.set(view, view.onDidTakeControl(() => {
					if (locked.get(sessionId) === view) {
						locked.delete(sessionId);
					}
				}));
			}
			if (event.type === 'run.end') {
				cancelAgentBrowserCalls(sessionId);
			}
			if (event.type === 'run.end' || event.type === 'question.ask' || (event.type === 'finish' && event.reason !== 'tool_calls')) {
				releaseAgentBrowser(sessionId);
			}
		}));
	}
}

registerWorkbenchContribution2(AgentBrowserLockContribution.ID, AgentBrowserLockContribution, WorkbenchPhase.AfterRestored);
