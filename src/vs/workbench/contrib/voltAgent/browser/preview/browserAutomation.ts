/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveDocument } from '../../../../../base/browser/dom.js';
import { raceCancellation, raceTimeout, SequencerByKey, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { localize } from '../../../../../nls.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { describeMockRoute, IVoltEmulation, IVoltMockRoute, parseEmulation, parseMockRoutes } from '../../../../../platform/voltBrowser/common/browserAgent.js';
import { decodeDataUrl, encodeImage, IImageLabel, ImageFormat, scaleScreenshot } from '../../../../services/voltRuntime/browser/host/imageCodec.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_ACT_TOOL_NAME, BROWSER_AUDIT_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_DEVTOOLS_TOOL_NAME, BROWSER_EMULATE_TOOL_NAME, BROWSER_MOCK_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, BROWSER_PAGE_URL_COMMAND_ID, BROWSER_RUN_TOOL_NAME, BROWSER_STATUS_TOOL_NAME, IVoltBrowserAutomationOptions, IVoltBrowserPreflightRequest, IVoltBrowserPreflightResult, PREFLIGHT_BROWSER_COMMAND_ID, IVoltHostToolResult, IVoltHostToolService, VoltBrowserAutomationToolName } from '../../../../services/voltRuntime/common/hostTools.js';
import { BrowserAuditCheck, describeLocator, describeStep, formatRunLog, HOST_EXPECTATIONS, IBrowserAssertion, IBrowserLocator, IBrowserRunStep, IBrowserStepOutcome, parseLocator, parseRunSteps } from '../../../../services/voltRuntime/common/tools/browserRun.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { diffAx, formatAxLine, IAxItem, placeOnImage, readingOrder, strokeBoxes } from '../../../../services/voltRuntime/common/tools/axAnnotations.js';
import { clampRect, compareImages, compareLayout, cropImage, describeComparison, describeLayout, diffHeatmap, IRgbaImage, parseRect, sideBySide } from '../../../../services/voltRuntime/common/tools/imageAnalysis.js';
import { actionEffect, describeEffect, IActionEffect, IPageView } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { agentSessionBrowser } from '../workspace/agentSurfaceHost.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { keepUserFocus } from './agentFocusGuard.js';
import { formatActRun, formatFlowRuns, IActDriver, IFlowRun, IPageSnapshotBase, pageStateLines, probe, runActSteps, settle, unsafeToSave } from './browserAct.js';
import { fileFlowStore, resolveActInput } from '../actFlows.js';
import { runDevtools } from './browserDevtools.js';
import { IVoltBrowserViews, IVoltConsoleMessage, normalizeBrowserUrl, VoltBrowserView } from './browserEditor.js';
import { VoltBrowserEditorInput } from './browserEditorInput.js';
import { assertScript, auditScript, IAuditFinding, IAuditPage, IPageStatus, locateScript as agentLocateScript, NET_MARK_SCRIPT, netSinceScript, STATUS_SCRIPT } from './browserAgentScripts.js';
import { clickFallbackScript, evaluateScript, focusScript, INetworkEntry, NETWORK_SCRIPT, readStateScript, rectScript, scrollScript, selectOptionScript, setValueScript, SNAPSHOT_SCRIPT, snapshotScript, targetScript, textPresentScript } from './browserAutomationScripts.js';
import { RunModeTracker } from '../../../../services/voltRuntime/common/hostSessionResolver.js';

interface IPageSnapshot extends IPageSnapshotBase {
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
	readonly files: IFileService;
	readonly groups: IEditorGroupsService;
	/** Main-process side of the browser (desktop only). */
	readonly browser?: IVoltBrowserService;
}

interface ICallContext {
	readonly sessionId: string;
	readonly token: CancellationToken;
	readonly options: IVoltBrowserAutomationOptions;
	readonly files: IFileService;
	readonly services: IAutomationServices;
}

/** How much of the page a result shows: changes since the agent last read it, all of it, or none. */
type PageObserve = 'auto' | 'full' | 'none';

/** Mocks and emulation an agent set, per chat; cleared when its turn ends. */
const agentOverrides = new Map<string, { view: VoltBrowserView; routes: readonly IVoltMockRoute[]; emulation?: IVoltEmulation }>();

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
	const driver = driverFor(view);
	const before = await probe(driver);
	if (hit.covered || !view.canSendInput()) {
		// Something sits on top of the element's center (a toast, an overlay): click the element itself.
		await run(view, clickFallbackScript(ref), token);
		if (hit.covered) {
			notes.push(`Note: the element was covered by \`${hit.covered}\`, so it was clicked directly instead of with the mouse.`);
		}
	} else {
		mouseClick(view, hit.x, hit.y, button, !!options.double);
	}
	notes.unshift(effectLine(actionEffect(before, await settle(driver, token))));
	return notes;
}

/** The chat's browser tab as the page `browser_act` steps run in. */
function driverFor(view: VoltBrowserView): IActDriver {
	return {
		run: <T>(code: string, ms: number) => raceTimeout(view.runScript<T>(code), ms).catch(() => undefined),
		canSendInput: () => view.canSendInput(),
		click: (x, y, button, double) => mouseClick(view, x, y, button, double),
		move: (x, y) => view.sendInput({ type: 'mouseMove', x, y }),
		press: combo => pressKey(view, combo),
		insertText: text => view.insertText(text),
		isLoading: () => view.isLoadingForAgent(),
		waitForLoad: (ms, token) => view.automationReady(ms, token),
		navigate: (url, token) => view.navigateForAgent(normalizeBrowserUrl(url), 20000, token),
		history: (action, token) => view.historyForAgent(action, token),
	};
}

function effectLine(effect: IActionEffect | undefined): string {
	return `- Effect: ${describeEffect(effect)}`;
}

/** Runs one input and reports what it did once the page has gone quiet. */
async function withEffect(view: VoltBrowserView, token: CancellationToken, input: () => void | Promise<void>): Promise<string> {
	const driver = driverFor(view);
	const before = await probe(driver);
	await input();
	return effectLine(actionEffect(before, await settle(driver, token)));
}

function formatConsole(messages: readonly IVoltConsoleMessage[], limit = 40): string[] {
	return messages.slice(-limit).map(msg => {
		const where = msg.source ? ` (${msg.source.replace(/^.*\//, '')}${msg.line ? `:${msg.line}` : ''})` : '';
		return `- [${msg.level}] ${msg.message.replace(/\s+/g, ' ').slice(0, 400)}${where}`;
	});
}

/**
 * The `snapshot` argument of the browser tools: `diff` (only what changed since the agent last read
 * the page, the whole page on a new document) is `auto`; `full` and `none` as they say.
 */
function observeOf(value: unknown, fallback: PageObserve): PageObserve {
	return value === 'diff' || value === 'auto' ? 'auto' : value === 'full' || value === 'none' ? value : fallback;
}

/** The page as the agent last read it, per view: the next result reports only what changed since. */
const seen = new WeakMap<VoltBrowserView, IPageView>();

/**
 * `auto`: the whole page the first time the agent sees a document, only the changes after that.
 * `full`: the whole page. `none`: URL, title and errors only. A partial `script` (selector or
 * interactive only) is shown whole and leaves what the agent knows of the page as it was.
 */
async function pageState(view: VoltBrowserView, observe: 'auto' | 'full' | 'none' = 'auto', script = SNAPSHOT_SCRIPT, unfold?: boolean): Promise<string[]> {
	const lines = ['### Page state'];
	const snap = await raceTimeout(view.runScript<IPageSnapshot>(script), SCRIPT_TIMEOUT_MS).catch(() => undefined);
	if (!snap) {
		lines.push('- The page did not answer (still loading or busy).');
		return lines;
	}
	const errors = view.takeConsole(true).filter(msg => msg.level === 'error' || msg.level === 'warning');
	const state = pageStateLines(snap, {
		previous: seen.get(view),
		observe,
		partial: script !== SNAPSHOT_SCRIPT,
		fixedViewport: !!view.getViewport(),
		console: errors.length ? formatConsole(errors, 10) : undefined,
		unfold,
	});
	if (state.page) {
		seen.set(view, state.page);
	}
	lines.push(...state.lines);
	return lines;
}

/** The ref of the element a call names: `ref`, or a `target` locator resolved in the page. */
async function resolveRef(view: VoltBrowserView, args: Record<string, unknown>, token: CancellationToken): Promise<{ ref: string; label?: string } | undefined> {
	const ref = str(args.ref);
	if (ref) {
		return { ref: ref.replace(/^@|^ref=/, '') };
	}
	const locator = parseLocator(args.target ?? args.locator);
	if (!locator) {
		return undefined;
	}
	return locate(view, locator, token);
}

async function locate(view: VoltBrowserView, locator: IBrowserLocator, token: CancellationToken): Promise<{ ref: string; label?: string }> {
	if (locator.ref) {
		return { ref: locator.ref.replace(/^@|^ref=/, '') };
	}
	const found = await run<{ ref?: string; label?: string; error?: string }>(view, agentLocateScript(locator), token);
	if (!found.ref) {
		throw new AutomationError(`${describeLocator(locator)}: ${found.error ?? 'not found'}`);
	}
	return { ref: found.ref, label: found.label };
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

interface IOwnTab {
	readonly input: VoltBrowserEditorInput;
	group: IEditorGroup;
	/** The user's tab it was opened beside. */
	readonly beside: VoltBrowserEditorInput;
}

/** A tab an agent opened for itself because the user was using theirs, per chat; it keeps using it. */
const ownTabs = new Map<string, IOwnTab>();
/** The user's tab each chat's agent stepped around: it gets the notice, and the refresh offer at the end. */
const steppedAround = new Map<string, VoltBrowserView>();
/** Why a chat's agent moved to its own tab, told with its next result. */
const ownTabNotes = new Map<string, string>();
/** Chats whose current run changed files, so a user's tab it stepped around may show old code. */
const changedFiles = new Set<string>();

/** The chat's browser tab: the agent's own tab while it has one, else the one beside the chat. */
function sessionBrowser(sessionId: string): { input: VoltBrowserEditorInput; group: IEditorGroup } | undefined {
	const own = ownTabs.get(sessionId);
	if (own && !own.input.isDisposed()) {
		return own;
	}
	ownTabs.delete(sessionId);
	return agentSessionBrowser(sessionId);
}

/** Another chat's agent holds `view`. */
function heldByOther(view: VoltBrowserView, sessionId: string): boolean {
	for (const [holder, held] of locked) {
		if (holder !== sessionId && held === view) {
			return true;
		}
	}
	return false;
}

/** Why the agent must leave `view` alone: the user is using it, or another agent is driving it. */
async function busyReason(view: VoltBrowserView, sessionId: string): Promise<string | undefined> {
	if (locked.get(sessionId) === view) {
		return undefined;
	}
	return heldByOther(view, sessionId) ? 'another agent is driving it' : view.userBusyReason();
}

/**
 * Keeps the agent's own tab live without bringing it forward: shown if the user is looking at it,
 * else laid under the browser tab in front. With no page in front to hide under, it comes forward.
 */
async function keepOwnTabLive(services: IAutomationServices, own: IOwnTab): Promise<VoltBrowserView> {
	if (!own.group.contains(own.input)) {
		own.group = services.groups.groups.find(group => group.contains(own.input)) ?? own.group;
	}
	const view = services.views.viewFor(own.input);
	const front = own.group.activeEditor;
	if (front !== own.input && front instanceof VoltBrowserEditorInput && view.runUnder(services.views.viewFor(front))) {
		return view;
	}
	await own.group.openEditor(own.input, { preserveFocus: true });
	return view;
}

/**
 * A tab of the agent's own beside the user's, on the same page, so the agent never types over what
 * the user is doing. It runs under the user's tab; a notice on their page says so.
 */
async function openOwnTab(services: IAutomationServices, sessionId: string, user: { input: VoltBrowserEditorInput; group: IEditorGroup }, url: string, reason: string): Promise<VoltBrowserView> {
	const input = new VoltBrowserEditorInput(VoltBrowserEditorInput.getNewEditorUri());
	input.url = url;
	input.agentOwner = sessionId;
	try {
		input.setTitle(new URL(url).host || 'Browser');
	} catch {
		// keeps "Browser"
	}
	await user.group.openEditor(input, { pinned: true, inactive: true, preserveFocus: true });
	const own: IOwnTab = { input, group: user.group, beside: user.input };
	ownTabs.set(sessionId, own);
	ownTabNotes.set(sessionId, reason);
	stepAround(services, sessionId, own);
	return keepOwnTabLive(services, own);
}

/** Tells the user, on their own tab, that the agent is working in its tab this run. */
function stepAround(services: IAutomationServices, sessionId: string, own: IOwnTab): void {
	if (own.beside.isDisposed() || steppedAround.has(sessionId)) {
		return;
	}
	const userView = services.views.viewFor(own.beside);
	steppedAround.set(sessionId, userView);
	userView.setAgentNotice({
		text: localize('voltBrowser.agentOwnTab', "The agent is working in its own tab, so it won't interrupt you"),
		onView: () => void own.group.openEditor(own.input),
	});
}

/**
 * Finds the chat's browser tab, opening one for `browser_navigate`. A tab the user is using (or
 * another agent holds) is left alone: the agent gets a tab of its own on the same page instead.
 */
async function browserFor(services: IAutomationServices, sessionId: string, openUrl: string | undefined, token: CancellationToken): Promise<{ view: VoltBrowserView; opened: boolean }> {
	const own = ownTabs.get(sessionId);
	let ownBusy: string | undefined;
	if (own && !own.input.isDisposed()) {
		const view = await keepOwnTabLive(services, own);
		cancelled(token);
		ownBusy = await busyReason(view, sessionId);
		if (!ownBusy) {
			stepAround(services, sessionId, own);
			return { view, opened: false };
		}
		// The user took the agent's tab over too: it gets another.
		ownTabs.delete(sessionId);
	}
	let found = agentSessionBrowser(sessionId);
	if (found) {
		const view = services.views.viewFor(found.input);
		const reason = found.input === own?.input ? ownBusy : await busyReason(view, sessionId);
		cancelled(token);
		if (reason) {
			return { view: await openOwnTab(services, sessionId, found, openUrl ?? view.pageUrl, reason), opened: true };
		}
	}
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

//#region browser_run

interface IRunState {
	readonly consoleMark: number;
	readonly netMark: number;
	shot?: IShot;
	snapshotLines?: string[];
	/** Audit findings from `audit` steps, printed after the step log. */
	auditLines?: string[];
}

function plainError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Console errors (not warnings) since the run started, as one line each. */
function runConsoleErrors(view: VoltBrowserView, state: IRunState): IVoltConsoleMessage[] {
	return view.peekConsole().slice(state.consoleMark).filter(msg => msg.level === 'error');
}

async function runFailedRequests(view: VoltBrowserView, state: IRunState): Promise<INetworkEntry[]> {
	const net = await raceTimeout(view.runScript<{ kind: string; method: string; url: string; status?: number; error?: string; ms: number }[]>(netSinceScript(state.netMark)), 3000).catch(() => undefined) ?? [];
	const fromConsole = consoleFailures(view.peekConsole().slice(state.consoleMark));
	const seen = new Set<string>();
	return [...net.map(item => ({ url: item.url, type: item.kind, status: item.status, error: item.error, method: item.method, ms: item.ms })), ...fromConsole].filter(entry => {
		const key = `${entry.url}|${entry.status ?? entry.error}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** Polls one assertion until it holds or its time runs out. */
async function checkAssertion(view: VoltBrowserView, assertion: IBrowserAssertion, timeoutMs: number, state: IRunState, token: CancellationToken): Promise<{ ok: boolean; actual: string }> {
	const started = Date.now();
	let last = { ok: false, actual: 'not checked' };
	do {
		cancelled(token);
		if (HOST_EXPECTATIONS.has(assertion.expect)) {
			if (assertion.expect === 'no_console_errors') {
				const errors = runConsoleErrors(view, state);
				last = { ok: !errors.length, actual: errors.length ? `${errors.length} error(s): ${errors.slice(0, 3).map(msg => msg.message.replace(/\s+/g, ' ').slice(0, 160)).join(' | ')}` : 'no errors' };
			} else {
				const failed = await runFailedRequests(view, state);
				last = { ok: !failed.length, actual: failed.length ? failed.slice(0, 4).map(entry => `${entry.status ?? entry.error} ${entry.url.slice(0, 120)}`).join(' | ') : 'no failed requests' };
			}
			// Errors only accumulate, so waiting longer cannot make these pass.
			return last;
		}
		const result = await raceTimeout(view.runScript<{ ok: boolean; actual?: string }>(assertScript(assertion)), 3000).catch(err => ({ ok: false, actual: plainError(err) }));
		last = { ok: !!result?.ok, actual: result?.actual ?? 'the page did not answer' };
		if (last.ok) {
			return last;
		}
		await timeout(100);
	} while (Date.now() - started < timeoutMs);
	return last;
}

async function setChecked(view: VoltBrowserView, ref: string, want: boolean, token: CancellationToken): Promise<string> {
	const result = await run<{ value?: string; error?: string }>(view, evaluateScript('(el) => el.getAttribute("aria-checked") === "true" || !!el.checked', ref), token);
	if (result.error) {
		throw new AutomationError(`could not read its state: ${result.error.split('\n')[0]}`);
	}
	const checked = result.value === 'true';
	if (checked === want) {
		return `already ${want ? 'checked' : 'unchecked'}`;
	}
	await click(view, ref, {}, token);
	return want ? 'checked' : 'unchecked';
}

/** Runs one step. Throws on an action failure; returns ok:false for a failed assertion. */
async function runStep(view: VoltBrowserView, step: IBrowserRunStep, state: IRunState, ctx: ICallContext): Promise<{ ok: boolean; detail?: string }> {
	const { token } = ctx;
	const target = async () => {
		if (!step.target) {
			throw new AutomationError('needs a target');
		}
		return locate(view, step.target, token);
	};
	switch (step.action) {
		case 'navigate': {
			const url = agentUrl(step.url)!;
			const loaded = await view.navigateForAgent(url, 20000, token);
			cancelled(token);
			return { ok: true, detail: loaded ? undefined : 'still loading after 20s' };
		}
		case 'click':
		case 'dblclick': {
			const hit = await target();
			const notes = await click(view, hit.ref, { double: step.action === 'dblclick' }, token);
			return { ok: true, detail: [hit.label, ...notes.map(note => note.replace(/^Note: /, ''))].filter(Boolean).join('; ') || undefined };
		}
		case 'type':
		case 'fill': {
			const hit = await target();
			const focus = await run<{ error?: string }>(view, focusScript(hit.ref, step.clear !== false), token);
			if (focus.error) {
				throw staleRef(hit.ref);
			}
			if (!await view.insertText(step.text!).catch(() => false)) {
				await run(view, setValueScript(hit.ref, step.text!, step.clear !== false), token);
			}
			if (step.submit) {
				pressKey(view, 'Enter');
			}
			await view.settle(10000, token);
			return { ok: true, detail: hit.label };
		}
		case 'press':
			pressKey(view, step.key!);
			await view.settle(10000, token);
			return { ok: true };
		case 'hover': {
			const hit = await target();
			const point = await targetOf(view, hit.ref, token);
			view.sendInput({ type: 'mouseMove', x: point.x, y: point.y });
			await view.settle(10000, token);
			return { ok: true, detail: hit.label };
		}
		case 'select': {
			const hit = await target();
			const picked = await run<{ error?: string; picked?: string[] }>(view, selectOptionScript(hit.ref, step.values!), token);
			if (picked.error) {
				throw new AutomationError(picked.error === 'stale' ? 'the element went away' : 'not a <select>; click it and choose the option instead');
			}
			await view.settle(10000, token);
			if (!picked.picked?.length) {
				throw new AutomationError(`no option matches ${step.values!.join(', ')}`);
			}
			return { ok: true, detail: `selected ${picked.picked.join(', ')}` };
		}
		case 'check':
		case 'uncheck': {
			const hit = await target();
			return { ok: true, detail: await setChecked(view, hit.ref, step.action === 'check', token) };
		}
		case 'scroll': {
			const hit = step.target ? await target() : undefined;
			await run(view, scrollScript(hit?.ref, step.deltaX ?? 0, step.deltaY ?? 0), token);
			await view.settle(10000, token);
			return { ok: true };
		}
		case 'wait':
			await raceCancellation(timeout(step.ms ?? 500), token);
			return { ok: true };
		case 'resize':
			view.setViewport(step.reset ? undefined : { width: step.width!, height: step.height! });
			await timeout(180);
			await view.settle(10000, token);
			return { ok: true };
		case 'reload':
			await view.historyForAgent('reload-fresh', token);
			return { ok: true };
		case 'back':
			await view.historyForAgent('back', token);
			return { ok: true };
		case 'evaluate': {
			const ref = step.target ? (await target()).ref : undefined;
			const result = await run<{ value?: string; error?: string }>(view, evaluateScript(step.expression!, ref), token);
			if (result.error) {
				throw new AutomationError(`threw ${result.error.split('\n')[0].slice(0, 300)}`);
			}
			const value = (result.value ?? 'undefined').replace(/\s+/g, ' ');
			return { ok: true, detail: `→ ${value.length > 400 ? `${value.slice(0, 397)}…` : value}` };
		}
		case 'snapshot': {
			state.snapshotLines = (await pageState(view, 'full')).slice(1);
			return { ok: true, detail: 'see snapshot below' };
		}
		case 'screenshot': {
			const ref = step.target ? (await target()).ref : undefined;
			state.shot = await screenshot(view, { ref }, token);
			return { ok: !!state.shot, detail: state.shot ? `${state.shot.width}×${state.shot.height}, attached` : 'could not capture' };
		}
		case 'assert': {
			const result = await checkAssertion(view, step.assertion!, step.timeoutMs, state, token);
			return { ok: result.ok, detail: result.ok ? undefined : `actual: ${result.actual}` };
		}
		case 'mock': {
			if (!await setMocks(view, step.routes!, ctx)) {
				throw new AutomationError('could not intercept this page\'s requests (the page may be closing)');
			}
			if (step.reloadAfter) {
				await view.historyForAgent('reload-fresh', token);
				await view.settle(10000, token);
			}
			return { ok: true, detail: step.routes!.length ? `${step.routes!.length} route(s) active` : undefined };
		}
		case 'emulate': {
			const applied = await setEmulation(view, step.emulation!, !!step.reset, ctx);
			if (!applied) {
				throw new AutomationError('could not emulate on this page (it may be closing)');
			}
			if (step.reloadAfter) {
				await view.historyForAgent('reload-fresh', token);
				await view.settle(10000, token);
			}
			return { ok: true };
		}
		case 'audit': {
			const report = await auditReport(view, { checks: step.checks!, scope: step.scope, widths: step.widths?.length ? step.widths : undefined }, token);
			(state.auditLines ??= []).push(...report.lines);
			const problems = [report.errors ? `${report.errors} accessibility error(s)` : '', report.overflowAt.length ? `overflow at ${report.overflowAt.join(', ')}px` : ''].filter(Boolean);
			return { ok: !problems.length, detail: problems.length ? `${problems.join('; ')} (findings below)` : `clean${report.warnings ? `, ${report.warnings} warning(s) below` : ''}` };
		}
	}
}

async function targetOf(view: VoltBrowserView, ref: string, token: CancellationToken): Promise<ITarget> {
	return target(view, ref, token);
}

async function runSteps(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext, openedAt?: string): Promise<IVoltHostToolResult> {
	const { token } = ctx;
	const parsed = parseRunSteps(args.steps);
	const steps = [...parsed.steps];
	const url = str(args.url);
	if (url && !(steps[0]?.action === 'navigate' && agentUrl(steps[0].url) === agentUrl(url))) {
		steps.unshift({ action: 'navigate', url, timeoutMs: 5000 });
	}
	// Files just changed (browser_run `edits`): load the page again so the steps see the new code.
	if (args.reload_first === true && !openedAt && steps[0]?.action !== 'navigate' && steps[0]?.action !== 'reload') {
		steps.unshift({ action: 'reload', timeoutMs: 5000, note: 'after the edits' });
	}
	// The tab was just opened on the run's first URL: loading it again would only cost time.
	const skipFirst = !!openedAt && steps[0]?.action === 'navigate' && agentUrl(steps[0].url) === openedAt;
	if (parsed.errors.length) {
		return { error: `browser_run did not start: ${parsed.errors.join('; ')}` };
	}
	const started = Date.now();
	const state: IRunState = {
		consoleMark: view.peekConsole().length,
		netMark: await raceTimeout(view.runScript<number>(NET_MARK_SCRIPT), 2000).catch(() => undefined) ?? 0,
	};
	const outcomes: IBrowserStepOutcome[] = [];
	for (const [index, step] of steps.entries()) {
		const t0 = Date.now();
		try {
			const result = index === 0 && skipFirst ? { ok: true, detail: 'opened the tab' } : await runStep(view, step, state, ctx);
			outcomes.push({ ok: result.ok, line: `${describeStep(step)}${result.detail ? ` - ${result.detail}` : ''}${step.note ? ` [${step.note}]` : ''}`, ms: Date.now() - t0 });
		} catch (err) {
			if (token.isCancellationRequested) {
				outcomes.push({ ok: false, line: `${describeStep(step)} - cancelled`, ms: Date.now() - t0 });
				break;
			}
			outcomes.push({ ok: false, line: `${describeStep(step)} - ${plainError(err)}`, ms: Date.now() - t0 });
			if (!step.optional) {
				break;
			}
		}
	}
	const lines = formatRunLog(outcomes, steps.length, Date.now() - started);
	const errors = runConsoleErrors(view, state);
	if (errors.length) {
		lines.push(`- Console errors during the run (${errors.length}):`, ...formatConsole(errors, 8).map(line => `  ${line}`));
	}
	const failed = await runFailedRequests(view, state);
	if (failed.length) {
		lines.push(`- Failed requests during the run (${failed.length}):`, ...failed.slice(0, 8).map(entry => `  ${requestLine(entry)}`));
	}
	const overrides = agentOverrides.get(ctx.sessionId);
	if (overrides?.routes.length) {
		lines.push(`- Network mocks active: ${overrides.routes.length} route(s)`);
	}
	if (state.auditLines?.length) {
		lines.push('', ...state.auditLines);
	}
	if (state.snapshotLines) {
		lines.push('', ...state.snapshotLines);
	}
	lines.push('', ...(await pageState(view, observeOf(args.snapshot, 'auto'))).filter(line => !line.startsWith('- New console errors') && !/^ {2}- \[(error|warning)\]/.test(line)));
	if (!state.shot && args.screenshot === true) {
		state.shot = await screenshot(view, {}, token);
	}
	return state.shot ? { text: `${lines.join('\n')}\n- Screenshot attached (${state.shot.width}×${state.shot.height})`, image: state.shot.image } : { text: lines.join('\n') };
}

//#endregion

//#region Mocks, emulation, audit, status

function protocolOf(view: VoltBrowserView, ctx: ICallContext): { browser: IVoltBrowserService; id: number } {
	const browser = ctx.services.browser ?? view.agentBrowserService();
	const id = view.agentWebContentsId();
	if (!browser || id === undefined) {
		throw new AutomationError('This needs the desktop app\'s in-app browser (its DevTools protocol), which is not available here.');
	}
	return { browser, id };
}

async function mock(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const { browser, id } = protocolOf(view, ctx);
	const { routes, errors } = parseMockRoutes(args.routes ?? []);
	if (errors.length) {
		return { error: `browser_mock: ${errors.join('; ')}` };
	}
	if (!routes.length && args.clear !== true) {
		return { error: 'browser_mock needs `routes` (or clear: true to remove them).' };
	}
	if (!await setMocks(view, routes, ctx)) {
		return { error: 'Could not intercept this page\'s requests (the page may be closing). Try again after browser_navigate.' };
	}
	const lines = [routes.length ? `### Network mocks: ${routes.length} route(s), first match wins (until cleared or this turn ends)` : '### Network mocks cleared', ...routes.map((route, i) => `${i + 1}. ${describeMockRoute(route)}`)];
	if (args.reload === true) {
		await view.historyForAgent('reload-fresh', ctx.token);
		await view.settle(10000, ctx.token);
		await timeout(250);
		const hits = await browser.getMockHits(id);
		const answered = hits.filter(hit => hit.route >= 0);
		lines.push('', `- Reloaded: ${answered.length} request(s) answered by mocks${answered.length ? `: ${answered.slice(-8).map(hit => `${hit.method} ${hit.url.slice(0, 100)} → route ${hit.route + 1}`).join('; ')}` : ''}`);
		lines.push('', ...await pageState(view, 'auto'));
	} else if (routes.length) {
		lines.push('- Requests already made are not repeated: reload (reload: true, browser_reload or a reload step) to mock the ones made at page load.');
	}
	return { text: lines.join('\n') };
}

/** Replaces the page's mocked routes (empty clears them) and remembers them for the end of the turn. */
async function setMocks(view: VoltBrowserView, routes: readonly IVoltMockRoute[], ctx: ICallContext): Promise<boolean> {
	const { browser, id } = protocolOf(view, ctx);
	if (!await browser.setNetworkMocks(id, routes)) {
		return false;
	}
	const previous = agentOverrides.get(ctx.sessionId);
	agentOverrides.set(ctx.sessionId, { view, routes, emulation: previous?.view === view ? previous.emulation : undefined });
	return true;
}

async function setEmulation(view: VoltBrowserView, emulation: IVoltEmulation, reset: boolean, ctx: ICallContext): Promise<IVoltEmulation | undefined> {
	const { browser, id } = protocolOf(view, ctx);
	const applied = await browser.emulate(id, emulation, reset);
	if (!applied) {
		return undefined;
	}
	const previous = agentOverrides.get(ctx.sessionId);
	agentOverrides.set(ctx.sessionId, { view, routes: previous?.view === view ? previous.routes : [], emulation: reset && !Object.keys(emulation).length ? undefined : applied });
	return applied;
}

async function emulate(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const { emulation, errors } = parseEmulation(args);
	if (errors.length) {
		return { error: `browser_emulate: ${errors.join('; ')}` };
	}
	const reset = args.reset === true;
	const applied = await setEmulation(view, emulation, reset, ctx);
	if (!applied) {
		return { error: 'Could not emulate on this page (the page may be closing).' };
	}
	const parts = Object.entries(applied).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}: ${value}`);
	const lines = [`### Emulation ${parts.length ? `active (until this turn ends): ${parts.join(', ')}` : 'cleared'}`];
	if (args.reload === true) {
		await view.historyForAgent('reload-fresh', ctx.token);
		lines.push('', ...await pageState(view, 'auto'));
	}
	return { text: lines.join('\n') };
}

function findingLine(finding: IAuditFinding): string {
	return `- [${finding.severity}] ${finding.rule}: ${finding.message}${finding.ref ? ` → ${finding.ref}${finding.selector ? ` \`${finding.selector}\`` : ''}` : ''}`;
}

async function audit(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const requested = Array.isArray(args.checks) ? args.checks.filter((check): check is BrowserAuditCheck => check === 'a11y' || check === 'layout' || check === 'perf') : [];
	const url = str(args.url);
	if (url && view.pageUrl !== agentUrl(url)) {
		await view.navigateForAgent(agentUrl(url)!, 20000, ctx.token);
	}
	const widths = Array.isArray(args.widths) ? args.widths.map(Number) : undefined;
	const report = await auditReport(view, { checks: requested.length ? requested : ['a11y', 'layout', 'perf'], scope: str(args.scope), widths }, ctx.token);
	return report.error ? { error: report.error } : { text: report.lines.join('\n') };
}

interface IAuditReport {
	readonly lines: string[];
	readonly errors: number;
	readonly warnings: number;
	readonly overflowAt: number[];
	readonly error?: string;
}

/** The audit as lines (a header, then findings), with the counts a pass/fail needs. */
async function auditReport(view: VoltBrowserView, options: { checks: readonly BrowserAuditCheck[]; scope?: string; widths?: readonly number[] }, token: CancellationToken): Promise<IAuditReport> {
	const { checks, scope } = options;
	const lines = [`### Audit of ${view.pageUrl}${scope ? ` (scope \`${scope}\`)` : ''}`];
	let errorCount = 0;
	let warningCount = 0;
	const overflowAt: number[] = [];
	const here = checks.filter(check => check !== 'layout');
	if (here.length) {
		const page = await run<IAuditPage & { error?: string }>(view, auditScript({ checks: here, scope }), token);
		if (page.error) {
			return { lines: [`- audit failed: ${page.error}`], errors: 0, warnings: 0, overflowAt, error: page.error };
		}
		if (here.includes('a11y')) {
			const found = page.findings.filter(f => !['lcp', 'cls', 'dom-size'].includes(f.rule));
			const errors = found.filter(f => f.severity === 'error').length;
			const warnings = found.filter(f => f.severity === 'warning').length;
			errorCount += errors;
			warningCount += warnings;
			lines.push(`Accessibility: ${errors} error(s), ${warnings} warning(s), ${found.length - errors - warnings} note(s)${found.length ? '' : ' - nothing found'}`);
			const order = { error: 0, warning: 1, info: 2 } as const;
			lines.push(...[...found].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 30).map(findingLine));
			if (found.length > 30) {
				lines.push(`- (${found.length - 30} more)`);
			}
		}
		if (page.perf) {
			const p = page.perf;
			const fmt = (label: string, value: number | string | undefined, unit = '') => value === undefined ? undefined : `${label} ${value}${unit}`;
			lines.push(`Performance: ${[fmt('TTFB', p.ttfbMs, ' ms'), fmt('DOMContentLoaded', p.domContentLoadedMs, ' ms'), fmt('load', p.loadMs, ' ms'), fmt('LCP', p.lcpMs, ' ms'), fmt('CLS', p.cls), fmt('long tasks', p.longTasks), fmt('DOM elements', p.domNodes), fmt('requests', p.requests), fmt('transferred', p.transferKB, ' KB'), fmt('JS heap', p.jsHeapMB, ' MB')].filter(Boolean).join(' · ')}`);
			lines.push(...page.findings.filter(f => ['lcp', 'cls', 'dom-size'].includes(f.rule)).map(findingLine));
		}
	}
	if (checks.includes('layout')) {
		const widths = (options.widths ?? [375, 768, 1280]).map(Number).filter(w => Number.isFinite(w) && w >= 200 && w <= 3840).slice(0, 6);
		const before = view.getViewport();
		lines.push('Layout:');
		try {
			for (const width of widths) {
				cancelled(token);
				view.setViewport({ width, height: before?.height ?? (width <= 480 ? 844 : 900) });
				await timeout(220);
				await view.settle(5000, token);
				const page = await run<IAuditPage & { error?: string }>(view, auditScript({ checks: ['layout'], scope }), token);
				if (page.error) {
					lines.push(`- ${width}px: ${page.error}`);
					continue;
				}
				const clipped = page.findings.filter(f => f.rule === 'clipped-text');
				if (page.overflow) {
					overflowAt.push(width);
					lines.push(`- ${width}px: \u2717 horizontal overflow - content is ${page.overflow.scrollWidth}px wide. Caused by:`, ...page.overflow.culprits.map(c => `  - ${c.ref} \`${c.selector}\` reaches ${c.right}px (${c.width}px wide): ${c.why}`));
				} else {
					lines.push(`- ${width}px: ✓ no horizontal overflow`);
				}
				lines.push(...clipped.slice(0, 5).map(f => `  ${findingLine(f)}`));
			}
		} finally {
			view.setViewport(before);
			await timeout(150);
		}
	}
	return { lines, errors: errorCount, warnings: warningCount, overflowAt };
}

/** One image of the page at several viewport widths (same height), labelled with each width. */
async function responsiveSheet(view: VoltBrowserView, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
	const widths = (args.widths as unknown[]).map(Number).filter(w => Number.isFinite(w) && w >= 200 && w <= 3840).slice(0, 5);
	const before = view.getViewport();
	const height = Math.max(400, Math.min(2000, num(args.height) ?? before?.height ?? 900));
	const images: IRgbaImage[] = [];
	const notes: string[] = [];
	try {
		for (const width of widths) {
			cancelled(token);
			view.setViewport({ width, height });
			await timeout(220);
			await view.settle(5000, token);
			await raceTimeout(view.runScript(PAINTED_SCRIPT), 2000);
			const shot = await view.captureSnapshot();
			if (!shot) {
				notes.push(`${width}px: not captured`);
				continue;
			}
			const overflow = await raceTimeout(view.runScript<number>('(document.scrollingElement || document.documentElement).scrollWidth'), 1500).catch(() => undefined);
			if (typeof overflow === 'number' && overflow > width + 1) {
				notes.push(`${width}px: horizontal overflow (content ${overflow}px wide)`);
			}
			images.push(await decodeDataUrl(shot, { width, height }));
		}
	} finally {
		view.setViewport(before);
	}
	if (!images.length) {
		return { error: 'The page could not be captured.' };
	}
	const sheet = sideBySide(images, num(args.max_side) ?? 1600, 12);
	const scale = sheet.height / height;
	const labels: IImageLabel[] = [];
	let x = 0;
	images.forEach((image, i) => {
		labels.push({ x: Math.round(x) + 4, y: Math.max(0, sheet.height - 19), text: `${widths[i]}px` });
		x += image.width * scale + 12;
	});
	const image = await encodeImage(sheet, 'jpeg', 0.8, labels);
	return { text: [...action('responsive screenshot', { Widths: widths.map(w => `${w}px`).join(', '), Height: `${height}px` }), ...notes.map(note => `- ${note}`), '- Viewport restored afterwards'].join('\n'), image };
}

async function fullPage(view: VoltBrowserView, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	const { browser, id } = protocolOf(view, ctx);
	const capture = await browser.captureFullPage(id);
	if (!capture) {
		return { error: 'The full page could not be captured.' };
	}
	const format: ImageFormat = args.format === 'png' || args.format === 'webp' ? args.format : 'jpeg';
	const shot = await scaleScreenshot(capture.dataUrl, { maxSide: Math.max(256, Math.min(2560, num(args.max_side) ?? 1600)), targetWidth: capture.width, format });
	return { text: [...action('full-page screenshot', { Page: `${capture.width}×${capture.height} CSS px${capture.clipped ? ' (cut at 8000px)' : ''}`, Image: `${shot.width}×${shot.height}` })].join('\n'), image: shot.dataUrl };
}

async function status(ctx: ICallContext): Promise<IVoltHostToolResult> {
	const lines = ['### Browser status'];
	const found = sessionBrowser(ctx.sessionId);
	const view = found ? ctx.services.views.viewFor(found.input) : undefined;
	if (!view) {
		lines.push('- No browser tab is open for this chat yet: browser_navigate, browser_run with url, or playground_create opens one.');
	} else {
		const page = await raceTimeout(view.runScript<IPageStatus>(STATUS_SCRIPT), 4000).catch(() => undefined);
		if (page) {
			const fixed = view.getViewport();
			lines.push(`- Tab: ${page.url} - "${page.title || '(untitled)'}" (${page.readyState})`);
			lines.push(`- Viewport: ${page.viewport.width}×${page.viewport.height}${fixed ? ' (fixed by resize)' : ' (fills the pane)'}, scrolled ${page.viewport.scrollY}/${Math.max(0, page.viewport.scrollHeight - page.viewport.height)}${page.viewport.scrollWidth > page.viewport.width + 1 ? `, content ${page.viewport.scrollWidth}px wide (horizontal overflow)` : ''}`);
			lines.push(`- ${page.interactive} interactive elements, ${page.forms} form(s)${page.focused ? `, focus on ${page.focused}` : ''}${page.dialogs.length ? `, open dialog: ${page.dialogs.join('; ')}` : ''}`);
		} else {
			lines.push(`- Tab: ${view.pageUrl} (the page is not answering: loading or busy)`);
		}
		const consoleAll = view.peekConsole();
		const errors = consoleAll.filter(msg => msg.level === 'error');
		const warnings = consoleAll.filter(msg => msg.level === 'warning');
		lines.push(`- Console since load: ${errors.length} error(s), ${warnings.length} warning(s)`, ...formatConsole(errors, 3).map(line => `  ${line}`));
		const failures = consoleFailures(consoleAll);
		if (failures.length || page?.failedRequests) {
			lines.push(`- Failed requests: ${failures.length + (page?.failedRequests ?? 0)} (browser_network lists them)`);
		}
		lines.push(`- Control: ${view.agentLocked ? 'the agent (locked; the user can click Take control)' : 'the user'}`);
	}
	const overrides = agentOverrides.get(ctx.sessionId);
	if (overrides) {
		if (overrides.routes.length) {
			lines.push(`- Network mocks (${overrides.routes.length}): ${overrides.routes.map(describeMockRoute).join('; ')}`);
		}
		if (overrides.emulation && Object.keys(overrides.emulation).length) {
			lines.push(`- Emulation: ${Object.entries(overrides.emulation).map(([key, value]) => `${key}=${value}`).join(', ')}`);
		}
	}
	const browser = ctx.services.browser;
	if (browser) {
		const [playgrounds, servers, started] = await Promise.all([
			browser.listPlaygrounds(ctx.sessionId).catch(() => []),
			raceTimeout(browser.listLocalServers(), 5000).catch(() => undefined),
			browser.listDevServers().catch(() => []),
		]);
		for (const server of started) {
			const state = server.exitCode !== undefined ? `exited with code ${server.exitCode}` : server.port ? `serving http://localhost:${server.port}` : 'starting';
			const tail = server.log.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-8).map(line => `    ${line.slice(0, 200)}`);
			lines.push(`- Dev server Volt started: \`${server.command}\` in ${server.cwd} (pid ${server.pid}), ${state}. Last output:`, ...(tail.length ? tail : ['    (none)']));
		}
		if (playgrounds.length) {
			lines.push(`- Playgrounds (${playgrounds.length}):`, ...playgrounds.map(pg => `  - ${pg.id} "${pg.title}" ${pg.url} (${pg.files.length} file(s)${pg.mocks ? `, ${pg.mocks} mock(s)` : ''})`));
		}
		if (servers) {
			const cwd = ctx.options.cwd ? canonicalPath(ctx.options.cwd) : undefined;
			const mine = (path: string | undefined) => !!cwd && !!path && (canonicalPath(path) === cwd || canonicalPath(path).startsWith(`${cwd}/`));
			const dev = servers.filter(server => mine(server.cwd) || looksLikeDevServer(server.command, server.cwd));
			const sorted = [...dev].sort((a, b) => Number(mine(b.cwd)) - Number(mine(a.cwd)) || a.port - b.port).slice(0, 10);
			lines.push(sorted.length ? '- Dev servers listening on this machine:' : '- No dev servers are listening on this machine (start the app first).');
			lines.push(...sorted.map(server => `  - http://localhost:${server.port} - ${server.command.slice(0, 90)}${server.cwd ? ` (in ${mine(server.cwd) ? 'this workspace' : server.cwd})` : ''}`));
			if (servers.length > dev.length) {
				lines.push(`  - and ${servers.length - dev.length} other listener(s) from desktop apps (not shown)`);
			}
		}
	}
	return { text: lines.join('\n') };
}

/** macOS names /tmp and /var by their /private targets in process info. */
function canonicalPath(path: string): string {
	return path.replace(/^\/private\/(tmp|var)\//, '/$1/').replace(/\/+$/, '');
}

/** A server someone started for development, not a desktop app's own port (Docker, AirPlay, editors). */
function looksLikeDevServer(command: string, cwd: string | undefined): boolean {
	if (/^\/(Applications|System)\/|\.app\/Contents\//.test(command)) {
		return false;
	}
	return /\b(node|bun|deno|python[\d.]*|ruby|rails|php|java|go|cargo|uvicorn|gunicorn|flask|django|vite|next|nuxt|astro|webpack|esbuild|parcel|http-server|serve|live-server|hugo|jekyll)\b/i.test(command) || (!!cwd && !/\/Library\//.test(cwd) && cwd !== '/');
}

/** Takes back what an agent's turn changed in the page: network mocks and emulation. */
export async function clearAgentOverrides(sessionId: string, browser: IVoltBrowserService | undefined): Promise<void> {
	const overrides = agentOverrides.get(sessionId);
	agentOverrides.delete(sessionId);
	const service = browser ?? overrides?.view.agentBrowserService();
	const id = overrides?.view.agentWebContentsId();
	if (!overrides || !service || id === undefined) {
		return;
	}
	if (overrides.routes.length) {
		await service.setNetworkMocks(id, []).catch(() => undefined);
	}
	if (overrides.emulation) {
		await service.emulate(id, {}, true).catch(() => undefined);
	}
}

//#endregion

/** A bare port ("4400", ":4400") means the dev server on this machine. */
function agentUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const port = /^:?(\d{2,5})(\/.*)?$/.exec(value.trim());
	return normalizeBrowserUrl(port ? `http://localhost:${port[1]}${port[2] ?? '/'}` : value);
}

/** The URL a call opens first, if any: navigate's url, or run/audit/compare's optional `url` (or a first navigate step). */
function firstUrl(tool: VoltBrowserAutomationToolName, args: Record<string, unknown>): string | undefined {
	if (tool === 'browser_navigate' || tool === BROWSER_COMPARE_IMAGE_TOOL_NAME || tool === BROWSER_AUDIT_TOOL_NAME) {
		return str(args.url);
	}
	if (tool === BROWSER_RUN_TOOL_NAME) {
		if (str(args.url)) {
			return str(args.url);
		}
		const first = Array.isArray(args.steps) ? args.steps[0] as Record<string, unknown> | undefined : undefined;
		const action = typeof first?.action === 'string' ? first.action.toLowerCase() : undefined;
		return first && (action === 'navigate' || action === 'goto' || action === 'open') ? str(first.url) : first && typeof first.navigate === 'string' ? str(first.navigate) : undefined;
	}
	return undefined;
}

async function automate(services: IAutomationServices, sessionId: string, tool: VoltBrowserAutomationToolName, args: Record<string, unknown>, ctx: ICallContext): Promise<IVoltHostToolResult> {
	if (tool === BROWSER_STATUS_TOOL_NAME) {
		return status(ctx).catch(err => ({ error: err instanceof Error ? err.message : String(err) }));
	}
	const url = firstUrl(tool, args);
	if (tool === 'browser_navigate' && !url) {
		return { error: 'browser_navigate needs a `url`.' };
	}
	const normalized = agentUrl(url);
	try {
		cancelled(ctx.token);
		const { view, opened } = await browserFor(services, sessionId, normalized, ctx.token);
		lock(sessionId, view);
		const ownTabNote = ownTabNotes.get(sessionId);
		ownTabNotes.delete(sessionId);
		if (!opened || tool !== 'browser_navigate') {
			if (!await view.automationReady(tool === 'browser_navigate' ? 2000 : 15000, ctx.token) && tool !== 'browser_navigate') {
				cancelled(ctx.token);
				throw new AutomationError('The in-app browser page is not ready yet.');
			}
		}
		// The user keeps typing in the composer while the agent clicks and types in the page.
		let result = await keepUserFocus(getActiveDocument(), () => act(view, tool, args, normalized, opened, ctx));
		if (ownTabNote) {
			const note = `[Volt] The user is using their browser tab (${ownTabNote}), so this ran in a separate tab of yours on the same page ("Agent · …"). Their tab stays as it is; keep working here, and don't ask them to stop.`;
			result = { ...result, text: result.text ? `${note}\n${result.text}` : note };
		}
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
	const needsRef = tool === 'browser_click' || tool === 'browser_type' || tool === 'browser_hover' || tool === 'browser_select_option' || tool === 'browser_scroll' || tool === 'browser_evaluate' || tool === 'browser_screenshot';
	const resolved = needsRef ? await resolveRef(view, args, token) : undefined;
	const ref = resolved?.ref;
	const element = str(args.element) ?? resolved?.label;
	const after = observeOf(args.snapshot, 'auto');
	switch (tool) {
		case 'browser_navigate': {
			const loaded = opened ? await view.automationReady(20000, token) : await view.navigateForAgent(normalized!, 20000, token);
			cancelled(token);
			const head = action('navigate', { URL: normalized });
			if (!loaded) {
				head.push('- Note: the page is still loading after 20s.');
			}
			return { text: [...head, '', ...await pageState(view, observeOf(args.snapshot, 'auto'))].join('\n') };
		}
		case BROWSER_RUN_TOOL_NAME:
			return runSteps(view, args, ctx, opened ? normalized : undefined);
		case BROWSER_MOCK_TOOL_NAME:
			return mock(view, args, ctx);
		case BROWSER_EMULATE_TOOL_NAME:
			return emulate(view, args, ctx);
		case BROWSER_AUDIT_TOOL_NAME:
			return audit(view, args, ctx);
		case 'browser_snapshot': {
			const selector = str(args.selector);
			const interactive = args.interactive === true;
			const script = selector || interactive ? snapshotScript({ selector, interactive }) : SNAPSHOT_SCRIPT;
			return { text: (await pageState(view, 'full', script, args.unfold === true)).join('\n') };
		}
		case BROWSER_ACT_TOOL_NAME: {
			const store = ctx.options.cwd ? fileFlowStore(ctx.files, URI.file(ctx.options.cwd)) : undefined;
			const input = await resolveActInput(args, store, BROWSER_ACT_TOOL_NAME);
			if ('error' in input) {
				return { error: input.error };
			}
			const driver = driverFor(view);
			const [first] = input.plans;
			if (input.plans.length === 1 && !first.label) {
				const run = await runActSteps(driver, first.steps, token);
				cancelled(token);
				// on_failure: the steps' own expectations are the report; the page only matters when one failed.
				const brief = args.observe === 'on_failure' && run.ok;
				const lines = formatActRun(run, BROWSER_ACT_TOOL_NAME, { brief });
				if (input.save && store) {
					const refused = run.ok ? unsafeToSave(run, args.vars as Record<string, string> | undefined) : 'the run did not pass';
					lines.push(refused ? `- Not saved as flow ${input.save.name}: ${refused}.` : `- Saved as flow ${input.save.name} (${(await store.write(input.save.name, input.save.script)).fsPath}): re-run it with {"run": "${input.save.name}"}.`);
				}
				const observe = args.observe === 'full' || args.observe === 'none' ? args.observe : brief ? 'none' : 'auto';
				return { text: [...lines, '', ...await pageState(view, observe)].join('\n') };
			}
			// Several saved flows: each runs on its own; the page is shown after the first one that fails.
			const runs: IFlowRun[] = [];
			let failure: string[] | undefined;
			for (const plan of input.plans) {
				const run = await runActSteps(driver, plan.steps, token);
				cancelled(token);
				runs.push({ label: plan.label ?? 'flow', run });
				if (!run.ok && !failure) {
					failure = await pageState(view, 'auto');
				}
			}
			return { text: [...formatFlowRuns(runs, BROWSER_ACT_TOOL_NAME), ...(failure ? ['', ...failure] : [])].join('\n') };
		}
		case 'browser_click': {
			const double = args.doubleClick === true;
			const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
			const x = num(args.x);
			const y = num(args.y);
			if (!ref) {
				if (x === undefined || y === undefined) {
					return { error: 'browser_click needs a `target` (e.g. {"role":"button","name":"Save"}), a `ref` from browser_snapshot, or `x` and `y` viewport coordinates.' };
				}
				if (!view.canSendInput()) {
					return { error: 'Coordinate clicks are not available in this browser; use a ref.' };
				}
				const effect = await withEffect(view, token, () => mouseClick(view, Math.round(x), Math.round(y), button, double));
				return { text: [...action('click', { 'Element': element, 'At': `${Math.round(x)}, ${Math.round(y)}`, 'Click type': double ? 'double-click' : 'single-click', 'Button': button }), effect, '', ...await pageState(view, after)].join('\n') };
			}
			const notes = await click(view, ref, { double, button }, token);
			return { text: [...action('click', { 'Element': element, 'Ref': ref, 'Click type': double ? 'double-click' : 'single-click', 'Button': button }), ...notes, '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_type': {
			const text = typeof args.text === 'string' ? args.text : undefined;
			if (!ref || text === undefined) {
				return { error: 'browser_type needs `text` and the field: a `target` (e.g. {"label":"Email"}) or a `ref`.' };
			}
			const clear = args.clear !== false;
			const focus = await run<{ error?: string; focused?: boolean }>(view, focusScript(ref, clear), token);
			if (focus.error) {
				throw staleRef(ref);
			}
			let secret = false;
			const effect = await withEffect(view, token, async () => {
				if (!await view.insertText(text).catch(() => false)) {
					await run(view, setValueScript(ref, text, clear), token);
				}
				secret = !!(await raceTimeout(view.runScript<{ secret?: boolean }>(readStateScript(ref)), 2000).catch(() => undefined))?.secret;
				if (args.submit === true) {
					pressKey(view, 'Enter');
				}
			});
			const typed = secret ? `${'•'.repeat(Math.min(8, Math.max(1, text.length)))} (hidden)` : JSON.stringify(text);
			return { text: [...action('type', { 'Element': element, 'Ref': ref, 'Text': typed, 'Submitted': args.submit === true ? 'yes' : undefined }), effect, '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_press_key': {
			const key = str(args.key);
			if (!key) {
				return { error: 'browser_press_key needs a `key`.' };
			}
			const effect = await withEffect(view, token, () => pressKey(view, key));
			return { text: [...action('press key', { Key: key }), effect, '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_hover': {
			if (!ref) {
				return { error: 'browser_hover needs a `target` or a `ref`.' };
			}
			const hit = await target(view, ref, token);
			const effect = await withEffect(view, token, () => view.sendInput({ type: 'mouseMove', x: hit.x, y: hit.y }));
			return { text: [...action('hover', { Element: element, Ref: ref }), effect, '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_select_option': {
			const values = Array.isArray(args.values) ? args.values.map(value => String(value)) : [];
			if (!ref || !values.length) {
				return { error: 'browser_select_option needs `values` and the <select>: a `target` or a `ref`.' };
			}
			let picked: { error?: string; picked?: string[] } = {};
			const effect = await withEffect(view, token, async () => {
				picked = await run<{ error?: string; picked?: string[] }>(view, selectOptionScript(ref, values), token);
			});
			if (picked.error === 'stale') {
				throw staleRef(ref);
			}
			if (picked.error) {
				return { error: `${element ?? ref} is not a <select>. Use browser_act with {"action":"select"}, which also opens custom dropdowns and clicks the option.` };
			}
			return { text: [...action('select option', { Element: element, Ref: ref, Selected: picked.picked?.join(', ') || '(no matching option)' }), effect, '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_scroll': {
			const dy = num(args.deltaY) ?? (ref ? 0 : 600);
			const dx = num(args.deltaX) ?? 0;
			const scrolled = await run<{ error?: string }>(view, scrollScript(ref, dx, dy), token);
			if (scrolled.error && ref) {
				throw staleRef(ref);
			}
			await settle(driverFor(view), token, 1000);
			return { text: [...action('scroll', { Element: element, 'Delta Y': String(dy), 'Delta X': dx ? String(dx) : undefined }), '', ...await pageState(view, after)].join('\n') };
		}
		case 'browser_resize': {
			const width = num(args.width);
			const height = num(args.height);
			const reset = args.reset === true || width === undefined || height === undefined;
			view.setViewport(reset ? undefined : { width: width!, height: height! });
			await timeout(180);
			await settle(driverFor(view), token, 1500);
			return { text: [...action('resize', reset ? { Viewport: 'fills the pane' } : { Viewport: `${Math.round(width!)}×${Math.round(height!)}` }), '', ...await pageState(view, after)].join('\n') };
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
			return { text: [...head, '', ...await pageState(view, after)].join('\n') };
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
		case BROWSER_DEVTOOLS_TOOL_NAME:
			return runDevtools(view, args, { run: (code, runToken) => run(view, code, runToken), pageState: () => pageState(view) }, token);
		case 'browser_navigate_back':
			await view.historyForAgent('back', token);
			cancelled(token);
			return { text: [...action('navigate back', {}), '', ...await pageState(view, observeOf(args.snapshot, 'auto'))].join('\n') };
		case 'browser_reload':
			await view.historyForAgent('reload', token);
			cancelled(token);
			return { text: [...action('reload', {}), '', ...await pageState(view, observeOf(args.snapshot, 'auto'))].join('\n') };
		case 'browser_screenshot': {
			if (Array.isArray(args.widths) && args.widths.length) {
				return responsiveSheet(view, args, token);
			}
			if (args.full_page === true && !ref) {
				return fullPage(view, args, ctx);
			}
			const shot = await screenshot(view, { ...args, ref }, token, args.ax !== 'off');
			if (!shot) {
				return { error: 'The page could not be captured yet.' };
			}
			const details = { Element: ref ? (element ?? ref) : undefined, Size: shot.width ? `${shot.width}×${shot.height}` : undefined };
			const listing = elementListing(view, shot, args);
			const format: ImageFormat = args.format === 'png' || args.format === 'webp' ? args.format : 'jpeg';
			const image = args.marks === true && listing.listed.length ? await markedImage(shot, listing.listed, format) : shot.image;
			return { text: [...action('screenshot', details), '', ...await pageState(view, 'none'), '', ...listing.lines].join('\n'), image };
		}
		case BROWSER_COMPARE_IMAGE_TOOL_NAME:
			return compare(view, args, ctx);
		case BROWSER_STATUS_TOOL_NAME:
			return status(ctx);
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

/** The in-app browser's main-process side; undefined on the web, which has no main process. */
function mainBrowserService(accessor: ServicesAccessor): IVoltBrowserService | undefined {
	try {
		return accessor.get(IVoltBrowserService);
	} catch {
		return undefined;
	}
}

CommandsRegistry.registerCommand(AUTOMATE_BROWSER_COMMAND_ID, (accessor: ServicesAccessor, callerId: string, tool: VoltBrowserAutomationToolName, args?: Record<string, unknown>, options?: IVoltBrowserAutomationOptions) => {
	// The accessor is only valid now, not once the call's turn in the queue comes.
	const services: IAutomationServices = { workspace: accessor.get(IAgentWorkspaceService), views: accessor.get(IVoltBrowserViews), files: accessor.get(IFileService), groups: accessor.get(IEditorGroupsService), browser: mainBrowserService(accessor) };
	// A warm-pool agent calls with its pool id; its browser tab lives under the chat it was given.
	const sessionId = accessor.get(IAgentRuntimeService).chatFor(callerId);
	const source = new CancellationTokenSource(options?.token);
	let calls = inflight.get(sessionId);
	if (!calls) {
		calls = new Set();
		inflight.set(sessionId, calls);
	}
	calls.add(source);
	const ctx: ICallContext = { sessionId, token: source.token, options: options ?? {}, files: services.files, services };
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

CommandsRegistry.registerCommand(BROWSER_PAGE_URL_COMMAND_ID, (accessor: ServicesAccessor, sessionId: string): string | undefined => {
	return sessionBrowser(accessor.get(IAgentRuntimeService).chatFor(sessionId))?.input.url;
});

CommandsRegistry.registerCommand(PREFLIGHT_BROWSER_COMMAND_ID, (accessor: ServicesAccessor, callerId: string, request: IVoltBrowserPreflightRequest, token?: CancellationToken): Promise<IVoltBrowserPreflightResult> => {
	// A warm-pool agent's id names the chat it was given, like the browser tool calls.
	const sessionId = accessor.get(IAgentRuntimeService).chatFor(callerId);
	const browser = mainBrowserService(accessor);
	if (!browser) {
		return Promise.resolve({ lines: [] }); // web: no main process, no dev servers to find
	}
	const services: IAutomationServices = { workspace: accessor.get(IAgentWorkspaceService), views: accessor.get(IVoltBrowserViews), files: accessor.get(IFileService), groups: accessor.get(IEditorGroupsService), browser };
	// A primer that failed says nothing rather than something the agent would have to work around.
	return queue.queue(sessionId, () => preflight(services, browser, sessionId, request, token ?? CancellationToken.None).catch((): IVoltBrowserPreflightResult => ({ lines: [] })));
});

function logTail(log: string, max: number): string {
	const text = log.replace(/\x1b\[[0-9;]*m/g, '').trim();
	return text.length > max ? `…${text.slice(-max)}` : text || '(no output)';
}

/**
 * The browser half of the turn primer: the app serving (found, or started with the project's own
 * command), open in the chat's browser, with what the agent would otherwise spend its first calls
 * finding out: the page outline, console errors, failed requests, and the audits the request names.
 */
async function preflight(services: IAutomationServices, browser: IVoltBrowserService, sessionId: string, request: IVoltBrowserPreflightRequest, token: CancellationToken): Promise<IVoltBrowserPreflightResult> {
	const cwd = canonicalPath(request.cwd);
	const mine = (path: string | undefined) => !!path && (canonicalPath(path) === cwd || canonicalPath(path).startsWith(`${cwd}/`));
	const servers = await raceTimeout(browser.listLocalServers(), 5000).catch(() => undefined) ?? [];
	const running = servers.filter(server => mine(server.cwd)).sort((a, b) => a.port - b.port)[0];
	let port = running?.port;
	let origin = running ? `already running: ${running.command.slice(0, 80)}` : '';
	if (!port) {
		if (!request.start) {
			return { lines: [] };
		}
		if (!request.allowStart) {
			return { lines: [`[Volt] The app is not running. Its start command: \`${request.start}\`.`] };
		}
		const started = await browser.startDevServer(request.cwd, request.start, 15_000);
		cancelled(token);
		if (!started.port) {
			return {
				lines: [started.exitCode !== undefined
					? `[Volt] Volt ran the app's start command \`${request.start}\`; it exited with code ${started.exitCode}. Its output:\n${logTail(started.log, 1500)}`
					: `[Volt] Volt started \`${request.start}\` (pid ${started.pid}), but it was not listening after 15s. Its output so far:\n${logTail(started.log, 1000)}`],
			};
		}
		port = started.port;
		origin = `started by Volt just now with \`${request.start}\` (pid ${started.pid}; it keeps running; browser_status shows its output)`;
	}
	const url = `http://localhost:${port}/`;
	let found: { view: VoltBrowserView; opened: boolean };
	try {
		found = await browserFor(services, sessionId, url, token);
	} catch {
		// The chat is not on screen, so its browser tab cannot open yet; the agent opens it later.
		return { lines: [`[Volt] The app is serving at ${url} (${origin}). Do not start another server.`], url };
	}
	const { view, opened } = found;
	if (opened) {
		await view.automationReady(15_000, token);
	} else if (view.pageUrl !== url) {
		await view.navigateForAgent(url, 15_000, token);
	}
	await view.settle(5000, token);
	await timeout(150);
	const lines = [`[Volt] The app is serving at ${url} (${origin}). It is open in this chat's in-app browser, so browser_run can start right away (no navigate needed). Do not start another server.`];
	const failed = await runFailedRequests(view, { consoleMark: 0, netMark: 0 });
	const state = await pageState(view, 'full');
	const snapshotAt = state.indexOf('- Page Snapshot:');
	const yaml = snapshotAt >= 0 ? state.slice(snapshotAt).join('\n') : '';
	const head = (snapshotAt >= 0 ? state.slice(1, snapshotAt) : state.slice(1)).filter(line => !line.startsWith('- Viewport'));
	const unseen = failed.filter(entry => !head.some(line => line.includes(entry.url)));
	if (unseen.length) {
		head.push(`- Failed requests since load: ${unseen.slice(0, 6).map(requestLine).join('; ')}`);
	}
	lines.push('Page now:', ...head);
	if (yaml && yaml.length <= 3500) {
		lines.push(yaml);
	} else {
		// The agent never saw this snapshot, so its first diff must not be against it.
		seen.delete(view);
	}
	const checks: BrowserAuditCheck[] = [...(request.a11y ? ['a11y' as const] : []), ...(request.widths.length ? ['layout' as const] : []), ...(request.perf ? ['perf' as const] : [])];
	if (checks.length) {
		const report = await auditReport(view, { checks, widths: request.widths.length ? request.widths : undefined }, token);
		lines.push(`[Volt] Audit Volt ran because the request asks about it (${checks.join(', ')}). Fix from it; re-check with an audit step in browser_run:`, ...report.lines.slice(1));
	}
	return { lines, url };
}

/**
 * Hands the page back when the agent's turn ends, stops for a question, or the user takes control;
 * cancels browser calls of a run that ended; and tells the host tools each chat's mode and folder.
 */
class AgentBrowserLockContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentBrowserLock';

	private readonly takeControl = this._register(new DisposableMap<VoltBrowserView>());

	constructor(
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
	) {
		super();
		hostTools.setSessionResolver(this._register(new RunModeTracker(runtime)));
		this._register(toDisposable(() => hostTools.setSessionResolver(undefined)));
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			const view = locked.get(sessionId);
			if (view && !this.takeControl.has(view)) {
				this.takeControl.set(view, view.onDidTakeControl(() => {
					if (locked.get(sessionId) === view) {
						locked.delete(sessionId);
					}
				}));
			}
			if (event.type === 'file.change') {
				changedFiles.add(sessionId);
			}
			if (event.type === 'run.end') {
				const userView = steppedAround.get(sessionId);
				steppedAround.delete(sessionId);
				const own = ownTabs.get(sessionId);
				if (userView && changedFiles.has(sessionId) && own && !own.input.isDisposed()) {
					userView.setAgentNotice({
						text: localize('voltBrowser.agentChanged', "The agent changed the app. Refresh to see it"),
						refresh: true,
						onView: () => void own.group.openEditor(own.input),
					});
				} else {
					userView?.setAgentNotice(undefined);
				}
				changedFiles.delete(sessionId);
				cancelAgentBrowserCalls(sessionId);
				// Mocks and emulation were for the agent's test, not for the user's browsing afterwards.
				void clearAgentOverrides(sessionId, undefined);
			}
			if (event.type === 'run.end' || event.type === 'question.ask' || (event.type === 'finish' && event.reason !== 'tool_calls')) {
				releaseAgentBrowser(sessionId);
			}
		}));
	}
}

registerWorkbenchContribution2(AgentBrowserLockContribution.ID, AgentBrowserLockContribution, WorkbenchPhase.AfterRestored);
