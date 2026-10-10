/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/browserEditor.css';
import { $, addDisposableListener, append, Dimension, disposableWindowInterval, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { disposableTimeout, timeout } from '../../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltBrowserService, VOLT_BROWSER_PARTITION } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentMention, browserMentionColor, cloneDisplayMentions } from '../composer/agentMentions.js';
import { BrowserCommentCard } from './browserCommentCard.js';
import { BrowserAgentComposer } from './browserComposer.js';
import { commentPreviewText } from './browserComments.js';
import { OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from '../editor/agentEditorInput.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { BrowserDeviceMode } from './browserDevices.js';
import { BrowserAgentDock } from './browserDock.js';
import { BROWSER_PRESENT_EVENT, BROWSER_PRESENTATION_EVENT, BrowserPresentation, DEFAULT_BROWSER_URL, VoltBrowserEditorInput } from './browserEditorInput.js';
import { BrowserAppearance, IBrowserHistoryEntry, isRememberedUrl, IVoltBrowserHistory, shortBrowserUrl } from './browserHistory.js';
import { BrowserMenuEntry, showBrowserMenu } from './browserMenu.js';
import { browserMenuExtras } from './browserMenuExtras.js';
import { RecordingBadge } from '../capture/recordingBadge.js';
import { sanitizeBrowserUrl } from './localPreview.js';

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface IPinnedBrowserComment {
	card: BrowserCommentCard;
	selection: IBrowserSelection;
	markId: string;
}
const PROBE_SCRIPT = `(() => {
	const x = __X__;
	const y = __Y__;
	const el = document.elementFromPoint(x, y);
	if (!el || el === document.documentElement || el === document.body) {
		return undefined;
	}
	const token = (node) => {
		const tag = node.tagName.toLowerCase();
		if (node.id) {
			return tag + '#' + node.id;
		}
		const raw = typeof node.className === 'string' ? node.className.trim() : '';
		const classes = raw.split(/\\s+/).filter(Boolean).slice(0, 2);
		if (classes.length) {
			return tag + '.' + classes.join('.');
		}
		const parent = node.parentElement;
		if (parent) {
			const same = Array.from(parent.children).filter(n => n.tagName === node.tagName);
			if (same.length > 1) {
				return tag + '[' + same.indexOf(node) + ']';
			}
		}
		return tag;
	};
	const parts = [];
	for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && n !== document.body; n = n.parentElement) {
		parts.unshift(token(n));
	}
	const r = el.getBoundingClientRect();
	const attributes = {};
	for (const attr of Array.from(el.attributes || [])) {
		attributes[attr.name] = attr.value;
	}
	return {
		tag: el.tagName.toLowerCase(),
		selector: token(el),
		domPath: parts.join(' > '),
		className: typeof el.className === 'string' ? el.className.trim() : '',
		attributes,
		html: (el.outerHTML || '').slice(0, 6000),
		text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
		x: r.x,
		y: r.y,
		w: r.width,
		h: r.height
	};
})()`;

interface IVoltNativeImage {
	isEmpty?(): boolean;
	toDataURL?(): string;
	toPNG?(): Uint8Array;
}

interface IVoltWebview extends HTMLElement {
	src: string;
	getURL?(): string;
	getTitle?(): string;
	canGoBack?(): boolean;
	canGoForward?(): boolean;
	goBack(): void;
	goForward(): void;
	reload(): void;
	reloadIgnoringCache?(): void;
	loadURL?(url: string): void;
	capturePage?(): Promise<IVoltNativeImage>;
	executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
	setUserAgent?(userAgent: string): void;
	sendInputEvent?(event: IVoltInputEvent): void;
	insertText?(text: string): Promise<void>;
	isLoading?(): boolean;
	stop?(): void;
	openDevTools?(): void;
	closeDevTools?(): void;
	isDevToolsOpened?(): boolean;
	inspectElement?(x: number, y: number): void;
	setZoomFactor?(factor: number): void;
	getWebContentsId?(): number;
	cut?(): void;
	copy?(): void;
	paste?(): void;
	selectAll?(): void;
}

/** What Electron's `context-menu` event reports about the spot the user right-clicked in the page. */
interface IPageContextParams {
	readonly x: number;
	readonly y: number;
	readonly linkURL?: string;
	readonly srcURL?: string;
	readonly mediaType?: string;
	readonly selectionText?: string;
	readonly isEditable?: boolean;
	readonly editFlags?: { readonly canCut?: boolean; readonly canCopy?: boolean; readonly canPaste?: boolean; readonly canSelectAll?: boolean };
}

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The page's colors at its top (`theme-color`, else its background) and at its bottom (its background). */
const SCREEN_COLOR_SCRIPT = `(() => {
	const visible = color => color && color !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(color);
	const body = document.body ? getComputedStyle(document.body).backgroundColor : '';
	const root = getComputedStyle(document.documentElement).backgroundColor;
	const background = visible(body) ? body : visible(root) ? root : '#ffffff';
	const meta = document.querySelector('meta[name="theme-color"]');
	return { top: (meta && meta.getAttribute('content')) || background, bottom: background };
})()`;

/**
 * Whether the page is light or dark at a point: the first opaque background under it, read through a
 * 1px canvas so any color syntax (oklch, color-mix) resolves. null over images and gradients.
 */
const dockToneScript = (x: number, y: number) => `(() => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		return null;
	}
	const rgba = color => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = '#0000';
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		return ctx.getImageData(0, 0, 1, 1).data;
	};
	const stack = [...document.elementsFromPoint(${x}, ${y}), document.body, document.documentElement];
	for (const el of stack) {
		if (!el) {
			continue;
		}
		if (/^(img|video|canvas|svg|iframe|picture|object|embed)$/i.test(el.tagName)) {
			return null;
		}
		const style = getComputedStyle(el);
		const c = rgba(style.backgroundColor);
		if (c[3] >= 128) {
			return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 140 ? 'light' : 'dark';
		}
		if (style.backgroundImage !== 'none') {
			return null;
		}
	}
	return matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? 'dark' : 'light';
})()`;

/** Electron's `InputEvent` for `<webview>.sendInputEvent`: trusted input, like a real user. */
export interface IVoltInputEvent {
	type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'char';
	x?: number;
	y?: number;
	button?: 'left' | 'right' | 'middle';
	clickCount?: number;
	keyCode?: string;
	modifiers?: string[];
	deltaX?: number;
	deltaY?: number;
}

export interface IVoltConsoleMessage {
	readonly level: 'verbose' | 'info' | 'warning' | 'error';
	readonly message: string;
	readonly source?: string;
	readonly line?: number;
}

interface IBrowserHit {
	tag: string;
	selector: string;
	domPath: string;
	className: string;
	attributes: Record<string, string>;
	html: string;
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A row under the address bar: a page from history, or a web search for what was typed. */
interface IBrowserSuggestion {
	readonly url: string;
	readonly title: string;
	readonly detail: string;
	readonly favicon?: string;
	readonly search?: boolean;
}

interface IBrowserSelection {
	kind: 'element' | 'region';
	bounds: { x: number; y: number; w: number; h: number };
	tag?: string;
	domPath?: string;
	className?: string;
	attributes?: Record<string, string>;
	selector?: string;
	html?: string;
	text?: string;
}

/** The URL as shown in the address bar: a bare root path drops its trailing slash (`https://google.com`). */
export function displayBrowserUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === '/' && !parsed.search && !parsed.hash && url.endsWith('/')) {
			return url.slice(0, -1);
		}
	} catch {
		// Not a parseable URL; show it as is.
	}
	return url;
}

export function normalizeBrowserUrl(value: string): string {
	const sanitized = sanitizeBrowserUrl(value);
	if (sanitized) {
		return sanitized;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return DEFAULT_BROWSER_URL;
	}
	// Before the scheme check: `localhost:3000` would read as a `localhost:` scheme.
	if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
		return `http://${trimmed.split(/[\s\]>]/)[0]}`;
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
		return sanitizeBrowserUrl(trimmed) ?? trimmed.split(/[\s\]>]/)[0] ?? trimmed;
	}
	// Words, or a single word with no dot, are a search, as in any browser's address bar.
	if (/\s/.test(trimmed) || !/[.:/]/.test(trimmed)) {
		return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
	}
	return `https://${trimmed.split(/[\s\]>]/)[0]}`;
}

function browserUrlNeedsRewrite(raw: string, clean: string): boolean {
	if (/\]\(|%5[dD]\(|\((https?:\/\/)|\*+/i.test(raw)) {
		return true;
	}
	try {
		const current = new URL(raw);
		const next = new URL(clean);
		return current.origin !== next.origin
			|| current.pathname !== next.pathname
			|| current.search !== next.search
			|| current.hash !== next.hash;
	} catch {
		return raw !== clean;
	}
}

/**
 * One browser tab's page and chrome. It lives as long as the tab, not as long as the pane
 * showing it: moving a tab to another group gives it a new pane, and a `<webview>` taken
 * out of the DOM restarts its page. So the view sits in one layer per editor part
 * (`browserViewLayer`) and is laid over whichever pane shows the tab.
 */
const CONNECTION_REFUSED = -102;
/** About 30 seconds: long enough for a dev server to come up, short enough to give up on a wrong port. */
const LOCAL_SERVER_RETRIES = 40;
const LOCAL_SERVER_RETRY_MS = 750;

/** `host:port` when the URL points at this machine. */
export function localServerHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^\[|\]$/g, '');
		const local = host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
		return local && /^https?:$/.test(parsed.protocol) ? parsed.host : undefined;
	} catch {
		return undefined;
	}
}

export class VoltBrowserView extends Disposable {

	readonly element: HTMLElement;
	private layer: HTMLElement | undefined;
	/** The pane slot this view is laid over; only that slot may hide it. */
	private owner: HTMLElement | undefined;
	private relayoutHandle: number | undefined;
	private readonly dragListeners = this._register(new DisposableStore());
	private readonly _onDidFocus = this._register(new Emitter<void>());
	/** Pointer or focus went into the view, which is outside the group's DOM. */
	readonly onDidFocus: BaseEvent<void> = this._onDidFocus.event;

	private container!: HTMLElement;
	private backButton!: HTMLButtonElement;
	private forwardButton!: HTMLButtonElement;
	private reloadButton!: HTMLButtonElement;
	private starButton!: HTMLButtonElement;
	private urlWrap!: HTMLElement;
	private urlInput!: HTMLInputElement;
	private urlDisplay!: HTMLElement;
	/** The address the bar shows when the user is not editing it. */
	private address = '';
	private suggestEl!: HTMLElement;
	private suggestions: readonly IBrowserSuggestion[] = [];
	private suggestIndex = -1;
	private designButton!: HTMLButtonElement;
	private responsiveButton!: HTMLButtonElement;
	private devtoolsButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
	private bookmarkBar!: HTMLElement;
	private startPage!: HTMLElement;
	private startInput!: HTMLInputElement;
	private startRecents!: HTMLElement;
	private toastEl!: HTMLElement;
	private toastHandle: number | undefined;
	private deviceMode!: BrowserDeviceMode;
	private loading = false;
	private zoomFactor = 1;
	private userAgent = BROWSER_USER_AGENT;
	private devtoolsOpen = false;
	private presentation: BrowserPresentation | undefined;
	private stage!: HTMLElement;
	private overlay!: HTMLElement;
	private hoverBox!: HTMLElement;
	private selectBox!: HTMLElement;
	private drawBox!: HTMLElement;
	private hintEl!: HTMLElement;
	private hintPathEl!: HTMLElement;
	private hintTextEl!: HTMLElement;
	private promptEl!: HTMLElement;
	private readonly comments: IPinnedBrowserComment[] = [];
	private composer: BrowserAgentComposer | undefined;
	private dock: BrowserAgentDock | undefined;
	private errorEl!: HTMLElement;
	private webview: IVoltWebview | undefined;
	private readonly webviewListeners = this._register(new DisposableStore());
	private guestReady = false;
	private dockToneBusy = false;
	private guestIdle = false;
	private pendingUrl: string | undefined;
	/** The main frame failed: the load that finishes next is Chromium's error page. */
	private loadFailed = false;
	/** A local server the agent is still starting: its address is tried again until it answers. */
	private readonly loadRetry = this._register(new MutableDisposable());
	private loadRetries = 0;
	private designMode = false;
	private hoverHit: IBrowserHit | undefined;
	private selection: IBrowserSelection | undefined;
	private readonly marks = new Map<string, { box: HTMLElement; accent: number; bounds: { x: number; y: number; w: number; h: number } }>();
	private drawing: { startX: number; startY: number; currentX: number; currentY: number } | undefined;
	private probeHandle: number | undefined;
	private lastProbe = '';
	private agentLock: HTMLElement | undefined;
	private readonly consoleMessages: IVoltConsoleMessage[] = [];
	private consoleSeen = 0;
	private readonly _onDidTakeControl = this._register(new Emitter<void>());
	/** The user clicked "Take control" on the page the agent was driving. */
	readonly onDidTakeControl: BaseEvent<void> = this._onDidTakeControl.event;

	constructor(
		private readonly input: VoltBrowserEditorInput,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IVoltBrowserHistory private readonly history: IVoltBrowserHistory,
	) {
		super();
		this.element = $('.volt-browser-view.parked');
		this._register(addDisposableListener(this.element, 'pointerdown', () => this._onDidFocus.fire(), true));
		this._register(addDisposableListener(this.element, 'focusin', () => this._onDidFocus.fire()));
		this._register(addDisposableListener(this.element, BROWSER_PRESENTATION_EVENT, e => {
			const detail = (e as CustomEvent<{ mode: BrowserPresentation }>).detail;
			this.setPresentation(detail?.mode);
		}));
		try {
			this.createBrowserChrome(this.element);
		} catch (err) {
			this.container ??= append(this.element, $('.volt-browser-editor'));
			this.errorEl ??= append(this.container, $('.volt-browser-error'));
			this.errorEl.classList.remove('hidden');
			this.errorEl.textContent = err instanceof Error ? err.message : String(err);
			return;
		}
		this._register(this.history.onDidChange(() => {
			this.syncStar();
			this.renderBookmarkBar();
			if (!this.startPage.classList.contains('hidden')) {
				this.renderStartRecents();
			}
		}));
		try {
			// A new tab opens on the start page; the webview starts loading once `show` puts the view in the DOM.
			if (input.url) {
				this.navigate(input.url);
			} else {
				this.showStartPage();
			}
		} catch (err) {
			this.showError(err instanceof Error ? err.message : localize('voltBrowser.loadFailed', "This page could not be loaded."));
		}
	}

	/** Lay the view over `slot`, the area of the pane now showing this tab. */
	show(slot: HTMLElement): void {
		const layer = browserViewLayer(slot);
		if (this.element.parentElement !== layer) {
			// First show, or the tab moved to another part or window: the page restarts once here.
			layer.appendChild(this.element);
			this.dragListeners.clear();
			this.passDragsThroughPage(layer.ownerDocument);
		}
		this.layer = layer;
		this.owner = slot;
		this.element.classList.remove('parked');
		// A tab opened while its tools area floats or spans the window takes that presentation at once.
		const area = slot.closest('.volt-agent-tools-area');
		this.setPresentation(area?.classList.contains('fullscreen') ? 'fullscreen' : area?.classList.contains('floating') ? 'floating' : area ? 'split' : undefined);
		this.layoutOver(slot);
	}

	/** Hide the view if `slot` still shows it. A pane that lost the tab to another group leaves it alone. */
	hide(slot: HTMLElement): void {
		if (this.owner !== slot) {
			return;
		}
		this.owner = undefined;
		this.element.classList.add('parked');
	}

	layoutOver(slot: HTMLElement): void {
		if (this.owner !== slot) {
			return;
		}
		this.place(slot);
		// Group moves set positions top-down before layout, but a resize mid-frame can still settle later.
		if (this.relayoutHandle === undefined) {
			this.relayoutHandle = getWindow(slot).requestAnimationFrame(() => {
				this.relayoutHandle = undefined;
				if (this.owner) {
					this.place(this.owner);
				}
			});
		}
	}

	private place(slot: HTMLElement): void {
		if (!this.layer) {
			return;
		}
		const box = slot.getBoundingClientRect();
		const origin = this.layer.getBoundingClientRect();
		const style = this.element.style;
		const left = `${box.left - origin.left}px`;
		const top = `${box.top - origin.top}px`;
		const width = `${box.width}px`;
		const height = `${box.height}px`;
		if (style.left === left && style.top === top && style.width === width && style.height === height) {
			return;
		}
		style.left = left;
		style.top = top;
		style.width = width;
		style.height = height;
		this.layout();
	}

	/**
	 * A guest page swallows drag events, so a tab dragged over it never reaches the editor
	 * drop zones (split left, right, up, down). While anything is dragged in the window the
	 * page lets the pointer through, like VS Code's own webviews.
	 */
	private passDragsThroughPage(doc: Document): void {
		const set = (dragging: boolean) => this.container.classList.toggle('drag-passthrough', dragging);
		this.dragListeners.add(addDisposableListener(doc, 'dragstart', () => set(true), true));
		this.dragListeners.add(addDisposableListener(doc, 'dragenter', () => set(true), true));
		this.dragListeners.add(addDisposableListener(doc, 'dragend', () => set(false), true));
		this.dragListeners.add(addDisposableListener(doc, 'drop', () => set(false), true));
		// No related target: the drag left the window.
		this.dragListeners.add(addDisposableListener(doc, 'dragleave', e => {
			if (!e.relatedTarget) {
				set(false);
			}
		}, true));
	}

	private createBrowserChrome(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-browser-editor'));
		this.container.tabIndex = -1;
		const toolbar = append(this.container, $('.volt-browser-toolbar'));

		this.backButton = this.navButton(toolbar, Codicon.arrowLeft, localize('voltBrowser.back', "Back"), () => this.callGuest(() => this.webview?.goBack()));
		this.forwardButton = this.navButton(toolbar, Codicon.arrowRight, localize('voltBrowser.forward', "Forward"), () => this.callGuest(() => this.webview?.goForward()));
		this.reloadButton = this.navButton(toolbar, Codicon.refresh, localize('voltBrowser.reload', "Reload"), () => {
			if (this.loading) {
				this.callGuest(() => this.webview?.stop?.());
			} else {
				this.callGuest(() => this.webview?.reload());
			}
		});
		this.reloadButton.classList.add('reload');
		append(this.reloadButton, $('span.volt-browser-spinner'));
		this.starButton = this.navButton(toolbar, createAriaIcon(ARIA_ICONS.star), localize('voltBrowser.bookmark', "Bookmark This Page"), () => this.toggleBookmark());
		this.starButton.classList.add('star');

		this.urlWrap = append(toolbar, $('.volt-browser-url-wrap'));
		this.urlInput = append(this.urlWrap, $('input.volt-browser-url')) as HTMLInputElement;
		this.urlInput.type = 'text';
		this.urlInput.spellcheck = false;
		this.urlInput.placeholder = localize('voltBrowser.urlPlaceholder', "Search or enter URL");
		this.urlInput.setAttribute('aria-autocomplete', 'list');
		this.urlDisplay = append(this.urlWrap, $('.volt-browser-url-display'));
		this.urlDisplay.setAttribute('aria-hidden', 'true');

		const actions = append(toolbar, $('.volt-browser-actions'));
		this.designButton = this.actionButton(actions, 'design', localize('voltBrowser.design', "Design"), () => this.setDesignMode(!this.designMode));
		setAgentTooltip(this.designButton, localize('voltBrowser.designMode', "Design Mode"), formatAgentTooltipShortcut({ meta: true, shift: true, key: 'D' }));
		this.responsiveButton = this.actionButton(actions, 'responsive', localize('voltBrowser.responsive', "Responsive Design Mode"), () => this.toggleResponsive());
		this.responsiveButton.appendChild(createAriaIcon(ARIA_ICONS.smartphone));
		this.devtoolsButton = this.actionButton(actions, 'devtools', localize('voltBrowser.devtools', "Toggle Developer Tools"), () => this.toggleDevTools());
		this.devtoolsButton.appendChild(createAriaIcon(ARIA_ICONS.terminal));
		this.moreButton = this.actionButton(actions, 'more', localize('voltBrowser.more', "More"), () => this.showMoreMenu());
		this.moreButton.appendChild(createDotsIcon());
		const floatButton = this.actionButton(actions, 'float', localize('voltBrowser.float', "Float Preview over Chat"), () => this.requestPresentation('floating'));
		floatButton.appendChild(createAriaIcon(ARIA_ICONS.pictureInPicture));

		this.bookmarkBar = append(this.container, $('.volt-browser-bookmarks.hidden'));
		this.suggestEl = append(this.container, $('.volt-browser-suggest.hidden'));
		this.suggestEl.setAttribute('role', 'listbox');

		this.stage = append(this.container, $('.volt-browser-stage'));
		this._register(this.instantiationService.createInstance(RecordingBadge, this.stage));
		this.errorEl = append(this.stage, $('.volt-browser-error.hidden'));
		this.overlay = append(this.stage, $('.volt-browser-overlay'));
		this.hoverBox = append(this.overlay, $('.volt-browser-box.hover.hidden'));
		this.selectBox = append(this.overlay, $('.volt-browser-box.select.hidden'));
		this.drawBox = append(this.overlay, $('.volt-browser-box.draw.hidden'));
		this.hintEl = append(this.overlay, $('.volt-browser-hint.hidden'));
		this.hintPathEl = append(this.hintEl, $('span.volt-browser-hint-path.hidden'));
		this.hintTextEl = append(this.hintEl, $('span.volt-browser-hint-text'));
		this.hintTextEl.textContent = localize('voltBrowser.designHint', "Click to select, drag to draw");
		this.promptEl = append(this.overlay, $('.volt-browser-prompt.hidden'));
		this.buildPrompt();
		this.buildStartPage();
		this.toastEl = append(this.stage, $('.volt-browser-toast.hidden'));
		this.toastEl.setAttribute('role', 'status');
		this.deviceMode = this._register(this.instantiationService.createInstance(BrowserDeviceMode, this.stage, {
			page: () => this.webview,
			onDidLayout: () => this.onViewportLayout(),
			setUserAgent: userAgent => this.applyUserAgent(userAgent),
			onDidDisable: () => this.syncResponsiveButton(),
		}));
		this.dock = this._register(this.instantiationService.createInstance(BrowserAgentDock));
		this.dock.setChatResolver(() => this.ownerSession());
		append(this.container, this.dock.element);
		this._register(disposableWindowInterval(getWindow(this.container), () => { void this.sampleDockTone(); }, 1000));
		// The stage changes size without the view moving (bookmark bar, floating chrome): lay the page out again.
		const stageObserver = new (getWindow(this.container).ResizeObserver)(() => this.layout());
		stageObserver.observe(this.stage);
		this._register({ dispose: () => stageObserver.disconnect() });

		this.wireAddressBar();
		this._register(addDisposableListener(this.overlay, 'pointerdown', e => this.onDesignPointerDown(e)));
		this._register(addDisposableListener(this.overlay, 'pointermove', e => this.onDesignPointerMove(e)));
		this._register(addDisposableListener(this.overlay, 'pointerup', e => this.onDesignPointerUp(e)));
		this._register(addDisposableListener(this.overlay, 'pointerleave', () => this.clearHover()));
		this._register(addDisposableListener(this.container, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				const openPin = this.comments.find(pin => pin.card.expanded);
				if (openPin) {
					this.collapseComment(openPin);
					e.preventDefault();
					return;
				}
				if (this.selection || !this.promptEl.classList.contains('hidden')) {
					this.closeDraft();
					e.preventDefault();
					return;
				}
				if (this.designMode) {
					this.setDesignMode(false);
					e.preventDefault();
				}
				return;
			}
			if (event.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD)) {
				const target = e.target as HTMLElement;
				if (target === this.urlInput || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
					return;
				}
				e.preventDefault();
				this.setDesignMode(!this.designMode);
			}
		}));

		this.syncNavButtons();
		this.syncDesignChrome();
		this.syncStar();
		this.renderBookmarkBar();
	}

	private navButton(parent: HTMLElement, icon: ThemeIcon | HTMLElement, title: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-browser-nav')) as HTMLButtonElement;
		button.type = 'button';
		setAgentTooltip(button, title);
		// Elements have a string `id` too, so `ThemeIcon.isThemeIcon` cannot tell them apart.
		button.appendChild(isHTMLElement(icon) ? icon : renderIcon(icon));
		this._register(addDisposableListener(button, 'click', onClick));
		return button;
	}

	private actionButton(parent: HTMLElement, extra: string, title: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $(`button.volt-browser-action.${extra}`)) as HTMLButtonElement;
		setAgentTooltip(button, title);
		button.type = 'button';
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		}));
		return button;
	}

	//#region Address bar

	private wireAddressBar(): void {
		// Suggestions open on a click or on typing; the tab taking focus (switching to it) only selects the address.
		this._register(addDisposableListener(this.urlInput, 'focus', () => {
			this.urlWrap.classList.add('editing');
			this.syncAddressDisplay();
			this.urlInput.select();
		}));
		this._register(addDisposableListener(this.urlInput, 'blur', () => {
			this.urlWrap.classList.remove('editing');
			this.hideSuggestions();
			// Leaving the bar without going anywhere puts the page's address back.
			this.urlInput.value = this.address;
			this.urlInput.scrollLeft = 0;
			this.syncAddressDisplay();
		}));
		// The first click selects the whole address, as browsers do; later clicks place the caret.
		this._register(addDisposableListener(this.urlInput, 'mousedown', e => {
			if (!this.editingAddress() && e.button === 0) {
				e.preventDefault();
				this.urlInput.focus();
				this.showSuggestions(false);
			}
		}));
		this._register(addDisposableListener(this.urlInput, 'input', () => this.showSuggestions(true)));
		// Mouse-down on a suggestion would blur the bar before the click lands.
		this._register(addDisposableListener(this.suggestEl, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(this.urlInput, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const picked = this.suggestions[this.suggestIndex];
				const target = picked ? picked.url : this.urlInput.value;
				this.hideSuggestions();
				this.urlInput.blur();
				this.navigate(target);
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				if (!this.suggestions.length) {
					return;
				}
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				const count = this.suggestions.length;
				this.suggestIndex = this.suggestIndex < 0 && step < 0 ? count - 1 : (this.suggestIndex + step + count) % count;
				this.renderSuggestions();
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (!this.suggestEl.classList.contains('hidden')) {
					this.hideSuggestions();
					return;
				}
				this.urlInput.value = this.address;
				this.urlInput.blur();
				return;
			}
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyL)) {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand(OPEN_AGENT_SIDE_PANEL_COMMAND_ID);
			}
		}));
	}

	/** Shows `url` in the bar: the scheme dimmed, the rest bright, as Cursor draws it. */
	private setAddress(url: string): void {
		this.address = url ? displayBrowserUrl(url) : '';
		if (!this.editingAddress()) {
			this.urlInput.value = this.address;
		}
		this.syncAddressDisplay();
	}

	/**
	 * The user is in the address field. Not `document.activeElement`: that stays on the field
	 * while the whole window is in the background, and the field must show the page then.
	 */
	private editingAddress(): boolean {
		return this.urlWrap.classList.contains('editing');
	}

	private syncAddressDisplay(): void {
		const value = this.editingAddress() ? '' : this.address;
		this.urlWrap.classList.toggle('formatted', !!value);
		this.urlDisplay.replaceChildren();
		if (!value) {
			return;
		}
		const match = value.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
		append(this.urlDisplay, $('span.volt-browser-url-scheme')).textContent = match ? match[1] : '';
		append(this.urlDisplay, $('span.volt-browser-url-rest')).textContent = match ? match[2] : value;
	}

	private showSuggestions(typed: boolean): void {
		const query = this.urlInput.value.trim();
		const searching = typed && !!query;
		const pages: readonly IBrowserHistoryEntry[] = searching
			? this.history.search(query, 6)
			: this.history.search(this.address ? shortBrowserUrl(this.address) : '', this.address ? 1 : 6);
		const rows: IBrowserSuggestion[] = pages.map(page => ({ url: page.url, title: page.title, detail: page.url, favicon: page.favicon }));
		if (searching && normalizeBrowserUrl(query).startsWith('https://www.google.com/search?')) {
			rows.unshift({
				url: normalizeBrowserUrl(query),
				title: query,
				detail: localize('voltBrowser.searchGoogle', "Search Google"),
				search: true,
			});
		}
		this.suggestions = rows;
		this.suggestIndex = searching && rows[0]?.search ? 0 : -1;
		this.renderSuggestions();
	}

	private renderSuggestions(): void {
		this.suggestEl.replaceChildren();
		const open = this.suggestions.length > 0 && this.editingAddress();
		this.suggestEl.classList.toggle('hidden', !open);
		if (!open) {
			return;
		}
		// Under the address field, as wide as it.
		const bar = this.urlWrap.getBoundingClientRect();
		const box = this.container.getBoundingClientRect();
		this.suggestEl.style.left = `${Math.round(bar.left - box.left)}px`;
		this.suggestEl.style.top = `${Math.round(bar.bottom - box.top + 6)}px`;
		this.suggestEl.style.width = `${Math.round(Math.max(260, bar.width))}px`;
		this.suggestions.forEach((suggestion, index) => {
			const row = append(this.suggestEl, $('.volt-browser-suggest-row'));
			row.setAttribute('role', 'option');
			row.classList.toggle('active', index === this.suggestIndex);
			row.setAttribute('aria-selected', String(index === this.suggestIndex));
			row.appendChild(suggestion.search ? createAriaIcon(ARIA_ICONS.search, 'suggest-icon') : faviconElement(suggestion.favicon));
			const text = append(row, $('.volt-browser-suggest-text'));
			append(text, $('span.volt-browser-suggest-title')).textContent = suggestion.title;
			append(text, $(`span.volt-browser-suggest-detail${suggestion.search ? '.search' : ''}`)).textContent = suggestion.detail;
			this._register(addDisposableListener(row, 'click', () => {
				this.hideSuggestions();
				this.urlInput.blur();
				this.navigate(suggestion.url);
			}));
		});
	}

	private hideSuggestions(): void {
		this.suggestions = [];
		this.suggestIndex = -1;
		this.suggestEl.classList.add('hidden');
		this.suggestEl.replaceChildren();
	}

	private syncLoading(loading: boolean): void {
		this.loading = loading;
		this.container.classList.toggle('loading', loading);
		setAgentTooltip(this.reloadButton, loading ? localize('voltBrowser.stop', "Stop") : localize('voltBrowser.reload', "Reload"));
	}

	private syncStar(): void {
		const url = this.input.url;
		const remembered = isRememberedUrl(url);
		const marked = remembered && this.history.isBookmarked(url);
		this.starButton.disabled = !remembered;
		this.starButton.classList.toggle('active', marked);
		setAgentTooltip(this.starButton, marked ? localize('voltBrowser.unbookmark', "Remove Bookmark") : localize('voltBrowser.bookmark', "Bookmark This Page"));
	}

	private toggleBookmark(): void {
		const url = this.input.url;
		if (!isRememberedUrl(url)) {
			return;
		}
		const added = this.history.toggleBookmark(url, this.input.getName(), this.input.favicon);
		this.showToast(added ? localize('voltBrowser.bookmarked', "Bookmarked") : localize('voltBrowser.bookmarkRemoved', "Bookmark removed"));
	}

	private renderBookmarkBar(): void {
		const show = this.history.showBookmarkBar;
		this.bookmarkBar.classList.toggle('hidden', !show);
		this.bookmarkBar.replaceChildren();
		if (!show) {
			return;
		}
		const bookmarks = this.history.bookmarks;
		if (!bookmarks.length) {
			append(this.bookmarkBar, $('span.volt-browser-bookmarks-empty')).textContent = localize('voltBrowser.bookmarksEmpty', "Bookmark pages with the star to keep them here");
			return;
		}
		for (const bookmark of bookmarks) {
			const chip = append(this.bookmarkBar, $('button.volt-browser-bookmark')) as HTMLButtonElement;
			chip.type = 'button';
			chip.appendChild(faviconElement(bookmark.favicon));
			append(chip, $('span.volt-browser-bookmark-title')).textContent = bookmark.title;
			setAgentTooltip(chip, bookmark.url);
			this._register(addDisposableListener(chip, 'click', () => this.navigate(bookmark.url)));
			this._register(addDisposableListener(chip, 'contextmenu', e => {
				e.preventDefault();
				this.contextMenuService.showContextMenu({
					getAnchor: () => ({ x: e.clientX, y: e.clientY }),
					getActions: () => [
						toAction({ id: 'volt.browser.bookmark.open', label: localize('voltBrowser.open', "Open"), run: () => this.navigate(bookmark.url) }),
						toAction({ id: 'volt.browser.bookmark.newTab', label: localize('voltBrowser.openNewTab', "Open in New Tab"), run: () => this.openInNewTab(bookmark.url) }),
						new Separator(),
						toAction({ id: 'volt.browser.bookmark.remove', label: localize('voltBrowser.removeBookmark', "Remove Bookmark"), run: () => this.history.removeBookmark(bookmark.url) }),
					],
				});
			}));
		}
	}

	//#endregion

	//#region Start page

	/** What a new tab shows instead of loading a site: a search field and the pages visited last. */
	private buildStartPage(): void {
		this.startPage = append(this.stage, $('.volt-browser-start.hidden'));
		const column = append(this.startPage, $('.volt-browser-start-column'));
		const field = append(column, $('.volt-browser-start-field'));
		field.appendChild(createAriaIcon(ARIA_ICONS.search, 'start-search'));
		this.startInput = append(field, $('input.volt-browser-start-input')) as HTMLInputElement;
		this.startInput.type = 'text';
		this.startInput.spellcheck = false;
		this.startInput.placeholder = localize('voltBrowser.startPlaceholder', "Search or enter URL...");
		this._register(addDisposableListener(this.startInput, 'keydown', e => {
			if (e.key === 'Enter' && this.startInput.value.trim()) {
				e.preventDefault();
				const value = this.startInput.value;
				this.startInput.value = '';
				this.navigate(value);
			}
		}));
		this.startRecents = append(column, $('.volt-browser-start-recents'));
	}

	private showStartPage(): void {
		this.startPage.classList.remove('hidden');
		this.container.classList.add('start-page');
		this.renderStartRecents();
		this.setAddress('');
		this.syncStar();
		this.syncNavButtons();
	}

	private hideStartPage(): void {
		this.startPage.classList.add('hidden');
		this.container.classList.remove('start-page');
	}

	private renderStartRecents(): void {
		this.startRecents.replaceChildren();
		const recents = this.history.recents(8);
		if (!recents.length) {
			return;
		}
		append(this.startRecents, $('.volt-browser-start-heading')).textContent = localize('voltBrowser.recents', "Recents");
		for (const page of recents) {
			const row = append(this.startRecents, $('button.volt-browser-start-row')) as HTMLButtonElement;
			row.type = 'button';
			row.appendChild(faviconElement(page.favicon));
			append(row, $('span.volt-browser-start-url')).textContent = shortBrowserUrl(page.url);
			setAgentTooltip(row, page.title);
			this._register(addDisposableListener(row, 'click', () => this.navigate(page.url)));
		}
	}

	//#endregion

	private buildPrompt(): void {
		this.composer = this._register(this.instantiationService.createInstance(BrowserAgentComposer, {
			onSubmit: text => void this.sendSelectionToAgent(true, text),
			onPrefill: text => void this.sendSelectionToAgent(false, text),
			onComment: () => this.pinPromptAsComment(),
			onHoverMention: mention => this.glowMark(mention),
			onRemoveMention: mention => this.removeMark(mention.id),
			onLayout: () => this.positionPrompt(),
		}));
		append(this.promptEl, this.composer.element);
	}

	private ensureWebview(initialUrl?: string): IVoltWebview {
		if (this.webview) {
			return this.webview;
		}
		const webview = this.container.ownerDocument.createElement('webview') as IVoltWebview;
		webview.className = 'volt-browser-frame';
		webview.setAttribute('allowpopups', 'true');
		webview.setAttribute('partition', VOLT_BROWSER_PARTITION);
		webview.setAttribute('webpreferences', 'allowRunningInsecureContent, javascript=yes');
		webview.setAttribute('useragent', this.userAgent);
		webview.setAttribute('src', 'about:blank');

		const on = (type: string, listener: (e: Event) => void) => {
			this.webviewListeners.add(addDisposableListener(webview, type, listener));
		};
		on('dom-ready', () => {
			const firstReady = !this.guestReady;
			this.guestReady = true;
			this.syncNavButtons();
			this.applyPageSettings();
			if (!firstReady) {
				// Moving the editor (split, drag to another group) detaches the webview, and Electron
				// restarts the guest from its `src` (about:blank). Load the tab's page again.
				const url = this.browserInput()?.url;
				if (url && this.guestUrl() === 'about:blank') {
					this.loadGuest(url);
				}
				return;
			}
			const url = this.pendingUrl || initialUrl;
			this.pendingUrl = undefined;
			if (url) {
				this.loadGuest(url);
			}
		});
		on('did-start-loading', () => {
			this.guestIdle = false;
			this.syncLoading(true);
		});
		on('did-navigate', e => {
			this.consoleMessages.length = 0;
			this.consoleSeen = 0;
			const url = (e as Event & { url?: string }).url;
			// A new document: its icon arrives with `page-favicon-updated`.
			this.browserInput().setFavicon(undefined);
			this.syncFromGuest(url);
			if (url) {
				this.history.visit(url);
			}
		});
		on('console-message', e => {
			const msg = e as Event & { level?: number; message?: string; sourceId?: string; line?: number };
			const level = msg.level === 3 ? 'error' : msg.level === 2 ? 'warning' : msg.level === 0 ? 'verbose' : 'info';
			this.consoleMessages.push({ level, message: String(msg.message ?? '').slice(0, 2000), source: msg.sourceId, line: msg.line });
			if (this.consoleMessages.length > 300) {
				this.consoleMessages.splice(0, this.consoleMessages.length - 300);
				this.consoleSeen = Math.min(this.consoleSeen, this.consoleMessages.length);
			}
		});
		on('did-navigate-in-page', e => {
			const page = e as Event & { url?: string; isMainFrame?: boolean };
			this.syncFromGuest(page.url);
			if (page.url && page.isMainFrame !== false) {
				this.history.visit(page.url, this.browserInput().getName());
			}
		});
		on('page-title-updated', e => {
			const title = (e as Event & { title?: string }).title;
			if (title) {
				this.browserInput()?.setTitle(title);
				this.history.describe(this.browserInput().url, { title });
			}
		});
		on('page-favicon-updated', e => {
			const favicons = (e as Event & { favicons?: string[] }).favicons ?? [];
			const favicon = favicons.find(icon => /^(https?:|data:image\/)/i.test(icon));
			if (!favicon) {
				return;
			}
			// Chromium also reports a guessed `/favicon.ico` that may not exist; only a loaded icon replaces the globe.
			const page = this.browserInput().url;
			const probe = new (getWindow(this.container).Image)();
			probe.referrerPolicy = 'no-referrer';
			probe.onload = () => {
				if (this.browserInput().url === page && probe.naturalWidth > 0) {
					this.browserInput().setFavicon(favicon);
					this.history.describe(page, { favicon });
				}
			};
			probe.src = favicon;
		});
		on('did-change-theme-color', () => void this.syncScreenColor());
		on('context-menu', e => this.showPageContextMenu((e as Event & { params?: IPageContextParams }).params));
		on('devtools-opened', () => this.syncDevTools(true));
		on('devtools-closed', () => this.syncDevTools(false));
		on('did-stop-loading', () => {
			this.guestIdle = true;
			this.syncLoading(false);
			this.syncFromGuest();
			void this.syncScreenColor();
		});
		on('did-fail-load', e => {
			const fail = e as Event & { isMainFrame?: boolean; errorCode?: number; errorDescription?: string; validatedURL?: string };
			if (fail.isMainFrame === false || fail.errorCode === -3) {
				return;
			}
			this.loadFailed = true;
			// The agent opens its preview as it starts the server, often before it listens
			// (ERR_CONNECTION_REFUSED): keep trying the local address for a while.
			const host = fail.validatedURL ? localServerHost(fail.validatedURL) : undefined;
			if (fail.errorCode === CONNECTION_REFUSED && host && this.loadRetries < LOCAL_SERVER_RETRIES) {
				this.loadRetries++;
				const url = fail.validatedURL!;
				this.showError(localize('voltBrowser.waitingForServer', "Waiting for {0} to start...", host));
				this.loadRetry.value = disposableTimeout(() => this.loadGuest(url), LOCAL_SERVER_RETRY_MS);
				return;
			}
			this.loadRetries = 0;
			this.showError(fail.errorDescription || localize('voltBrowser.loadFailed', "This page could not be loaded."));
			this.syncLoading(false);
			this.syncNavButtons();
		});
		on('did-finish-load', () => {
			this.guestIdle = true;
			// Chromium finishes loading its own (blank) error page after a failure: keep the reason up.
			if (this.loadFailed) {
				this.loadFailed = false;
				return;
			}
			this.loadRetries = 0;
			this.hideError();
		});
		on('new-window', e => {
			const url = (e as Event & { url?: string }).url;
			if (url) {
				e.preventDefault();
				this.navigate(url);
			}
		});

		on('focus', () => this.dock?.dismissIfEmpty());
		this.stage.insertBefore(webview, this.overlay);
		this.webview = webview;
		return webview;
	}

	private loadGuest(url: string): void {
		const webview = this.webview;
		if (!webview) {
			return;
		}
		const href = sanitizeBrowserUrl(url) ?? url;
		this.guestIdle = false;
		this.callGuest(() => {
			if (typeof webview.loadURL === 'function') {
				void Promise.resolve(webview.loadURL(href)).catch(() => {
					// ERR_ABORTED is normal when a load is replaced or the editor reloads.
				});
				return;
			}
			webview.setAttribute('src', href);
		});
	}

	private guestUrl(): string | undefined {
		try {
			return this.webview?.getURL?.();
		} catch {
			return undefined;
		}
	}

	private callGuest(fn: () => void): void {
		if (!this.guestReady || !this.webview) {
			return;
		}
		try {
			fn();
		} catch {
			// Guest methods throw until the webview has attached and emitted dom-ready.
		}
	}

	private browserInput(): VoltBrowserEditorInput {
		return this.input;
	}

	openUrl(value: string): void {
		this.navigate(value);
	}

	async captureSnapshot(): Promise<string | undefined> {
		await this.waitForGuestIdle();
		for (let attempt = 0; attempt < 4; attempt++) {
			const image = await this.tryCaptureSnapshot();
			if (image) {
				return image;
			}
			await timeout(300);
		}
		return undefined;
	}

	private async waitForGuestIdle(timeoutMs = 8000): Promise<void> {
		const started = Date.now();
		while (!this.guestIdle || !this.guestReady) {
			if (Date.now() - started >= timeoutMs) {
				break;
			}
			await timeout(80);
		}
		await timeout(350);
	}

	private async tryCaptureSnapshot(): Promise<string | undefined> {
		if (this.errorEl && !this.errorEl.classList.contains('hidden')) {
			return undefined;
		}
		const webview = this.webview;
		if (webview?.capturePage) {
			try {
				const image = await webview.capturePage();
				if (image && !image.isEmpty?.()) {
					const dataUrl = image.toDataURL?.();
					if (dataUrl?.startsWith('data:image/')) {
						return dataUrl;
					}
					const png = image.toPNG?.();
					if (png?.byteLength) {
						return `data:image/png;base64,${encodeBase64(VSBuffer.wrap(png))}`;
					}
				}
			} catch {
				// Guest capture throws until the page has painted.
			}
		}
		const frame = (webview ?? this.stage)?.getBoundingClientRect();
		if (!frame || frame.width < 8 || frame.height < 8) {
			return undefined;
		}
		try {
			const shot = await this.hostService.getScreenshot({
				x: Math.round(frame.x),
				y: Math.round(frame.y),
				width: Math.round(frame.width),
				height: Math.round(frame.height),
			});
			if (!shot?.byteLength) {
				return undefined;
			}
			return `data:image/png;base64,${encodeBase64(shot)}`;
		} catch {
			return undefined;
		}
	}

	private navigate(value: string): void {
		const url = normalizeBrowserUrl(value);
		const input = this.browserInput();
		if (input) {
			input.url = url;
		}
		this.loadRetry.clear();
		this.loadRetries = 0;
		this.hideError();
		this.closeDraft();
		this.clearComments();
		if (!url) {
			// An empty address is the start page. A page already loaded makes way for it.
			if (this.webview && this.guestReady) {
				this.loadGuest('about:blank');
			}
			input.setFavicon(undefined);
			input.setTitle('');
			this.showStartPage();
			return;
		}
		this.hideStartPage();
		this.setAddress(url);
		this.syncStar();
		this.pendingUrl = url;
		this.ensureWebview(url);
		if (this.guestReady) {
			this.loadGuest(url);
			this.pendingUrl = undefined;
		}
		this.syncNavButtons();
	}

	private syncFromGuest(url?: string): void {
		const webview = this.webview;
		let guestUrl = url;
		if (!guestUrl && this.guestReady) {
			try {
				guestUrl = webview?.getURL?.();
			} catch {
				guestUrl = undefined;
			}
		}
		const href = guestUrl || webview?.getAttribute('src') || this.browserInput()?.url;
		if (href && href !== 'about:blank') {
			const clean = sanitizeBrowserUrl(href) ?? href;
			if (clean !== href && browserUrlNeedsRewrite(href, clean)) {
				this.navigate(clean);
				return;
			}
			this.setAddress(clean);
			this.hideStartPage();
			const input = this.browserInput();
			if (input) {
				input.url = clean;
				let title: string | undefined;
				if (this.guestReady) {
					try {
						title = webview?.getTitle?.();
					} catch {
						title = undefined;
					}
				}
				try {
					input.setTitle(title || new URL(clean).hostname);
				} catch {
					input.setTitle(title || localize('voltBrowser.tab', "Browser"));
				}
			}
			this.syncStar();
		}
		this.syncNavButtons();
	}

	private syncNavButtons(): void {
		if (!this.backButton || !this.forwardButton) {
			return;
		}
		if (!this.guestReady || !this.webview) {
			this.backButton.disabled = true;
			this.forwardButton.disabled = true;
			return;
		}
		try {
			this.backButton.disabled = !(this.webview.canGoBack?.() ?? false);
			this.forwardButton.disabled = !(this.webview.canGoForward?.() ?? false);
		} catch {
			this.backButton.disabled = true;
			this.forwardButton.disabled = true;
		}
	}

	private showError(message: string): void {
		if (!this.errorEl) {
			return;
		}
		this.errorEl.textContent = message;
		this.errorEl.classList.remove('hidden');
	}

	private hideError(): void {
		if (!this.errorEl) {
			return;
		}
		this.errorEl.classList.add('hidden');
		this.errorEl.textContent = '';
	}

	private setDesignMode(on: boolean): void {
		this.designMode = on;
		if (!on) {
			this.clearSelection(true);
			this.clearHover();
			this.drawing = undefined;
		} else {
			this.container.focus();
		}
		this.syncDesignChrome();
	}

	private syncDesignChrome(): void {
		this.container?.classList.toggle('design-mode', this.designMode);
		if (this.designButton) {
			this.designButton.classList.toggle('active', this.designMode);
			this.designButton.replaceChildren();
			this.designButton.appendChild(createDesignSelectorIcon());
			if (this.designMode) {
				append(this.designButton, $('span.volt-browser-design-label')).textContent = localize('voltBrowser.designChip', "Design");
				append(this.designButton, $('span.volt-browser-design-close')).appendChild(createCloseIcon());
			}
		}
		this.overlay?.classList.toggle('active', this.designMode);
		this.syncHint();
	}

	private showMoreMenu(): void {
		const url = this.input.url;
		const hasPage = isRememberedUrl(url) && !!this.webview;
		const appearance = this.history.appearance;
		const choice = (id: BrowserAppearance, label: string) => ({
			id,
			label,
			checked: appearance === id,
			run: () => {
				this.history.appearance = id;
				void this.applyAppearance();
			},
		});
		const extras = this.instantiationService.invokeFunction(accessor => browserMenuExtras(accessor, { sessionId: this.ownerSession(), anchor: this.moreButton, toast: message => this.showToast(message) }));
		const entries: BrowserMenuEntry[] = [
			{ kind: 'item', label: localize('voltBrowser.menu.screenshot', "Take Screenshot"), disabled: !hasPage, run: () => void this.takeScreenshot() },
			...extras.capture,
			{ kind: 'separator' },
			{ kind: 'item', label: localize('voltBrowser.menu.hardReload', "Hard Reload"), disabled: !hasPage, run: () => this.callGuest(() => this.webview?.reloadIgnoringCache?.()) },
			{ kind: 'item', label: localize('voltBrowser.menu.copyUrl', "Copy Current URL"), disabled: !url, run: () => void this.clipboardService.writeText(url) },
			{ kind: 'item', label: localize('voltBrowser.menu.openExternal', "Open in System Browser"), disabled: !url, run: () => void this.openerService.open(URI.parse(url), { openExternal: true }) },
			{ kind: 'item', label: localize('voltBrowser.menu.devtools', "Open DevTools"), disabled: !hasPage, run: () => this.openDevTools() },
			{ kind: 'item', label: localize('voltBrowser.menu.window', "Open Separate Preview Window"), run: () => void this.openInWindow() },
			{ kind: 'toggle', label: localize('voltBrowser.menu.deviceToolbar', "Show Device Toolbar"), checked: this.deviceMode.active, run: () => this.toggleResponsive() },
			...extras.devices,
			{
				kind: 'submenu',
				label: localize('voltBrowser.menu.appearance', "Appearance"),
				choices: [
					choice('system', localize('voltBrowser.menu.system', "System")),
					choice('light', localize('voltBrowser.menu.light', "Light")),
					choice('dark', localize('voltBrowser.menu.dark', "Dark")),
				],
			},
			{
				kind: 'zoom',
				level: () => this.zoomFactor,
				zoomIn: () => this.stepZoom(1),
				zoomOut: () => this.stepZoom(-1),
				reset: () => this.setZoom(1),
			},
			{ kind: 'separator' },
			...extras.agents,
			{ kind: 'toggle', label: localize('voltBrowser.menu.bookmarkBar', "Show Bookmark Bar"), checked: this.history.showBookmarkBar, run: show => { this.history.showBookmarkBar = show; } },
			{ kind: 'separator' },
			{ kind: 'header', label: localize('voltBrowser.menu.profile', "Profile: Default") },
			{ kind: 'item', label: localize('voltBrowser.menu.clearHistory', "Clear Browsing History"), run: () => this.clearHistory() },
			{ kind: 'item', label: localize('voltBrowser.menu.clearCookies', "Clear Cookies"), run: () => void this.clearData('cookies') },
			{ kind: 'item', label: localize('voltBrowser.menu.clearCache', "Clear Cache"), run: () => void this.clearData('cache') },
			...extras.profile,
		];
		showBrowserMenu(this.contextViewService, this.moreButton, entries);
	}

	//#region Page tools: DevTools, zoom, appearance, device mode, screenshots

	private toggleResponsive(): void {
		this.deviceMode.toggle();
		this.syncResponsiveButton();
	}

	private syncResponsiveButton(): void {
		const on = this.deviceMode.active;
		this.responsiveButton.classList.toggle('active', on);
		setAgentTooltip(this.responsiveButton, on ? localize('voltBrowser.responsiveExit', "Exit Responsive Design Mode") : localize('voltBrowser.responsive', "Responsive Design Mode"));
	}

	private onViewportLayout(): void {
		this.syncResponsiveButton();
		if (this.selection) {
			this.positionPrompt();
		}
		for (const pin of this.comments) {
			this.placeComment(pin);
		}
	}

	/** Device presets send their own user agent; the page reloads so the site serves that version. */
	private applyUserAgent(userAgent: string | undefined): void {
		const next = userAgent ?? BROWSER_USER_AGENT;
		if (next === this.userAgent) {
			return;
		}
		this.userAgent = next;
		const webview = this.webview;
		if (!webview) {
			return;
		}
		if (!this.guestReady) {
			webview.setAttribute('useragent', next);
			return;
		}
		this.callGuest(() => {
			webview.setUserAgent?.(next);
			if (isRememberedUrl(this.input.url)) {
				webview.reload();
			}
		});
	}

	private toggleDevTools(): void {
		if (this.devtoolsOpen) {
			this.callGuest(() => this.webview?.closeDevTools?.());
		} else {
			this.openDevTools();
		}
	}

	private openDevTools(): void {
		if (!this.webview || !this.guestReady) {
			this.showToast(localize('voltBrowser.devtoolsNoPage', "Open a page to inspect it"));
			return;
		}
		this.callGuest(() => this.webview?.openDevTools?.());
	}

	private syncDevTools(open: boolean): void {
		this.devtoolsOpen = open;
		this.devtoolsButton.classList.toggle('active', open);
		setAgentTooltip(this.devtoolsButton, open ? localize('voltBrowser.devtoolsClose', "Close Developer Tools") : localize('voltBrowser.devtools', "Toggle Developer Tools"));
	}

	/** Right-click in the page: link, image and text actions, and Inspect Element. */
	private showPageContextMenu(params: IPageContextParams | undefined): void {
		const webview = this.webview;
		if (!webview || !params) {
			return;
		}
		// Electron reports the spot in the window's coordinates; Inspect Element wants the page's.
		const frame = webview.getBoundingClientRect();
		const scale = this.deviceMode.scale || 1;
		const anchor = { x: params.x, y: params.y };
		const pageX = Math.round((params.x - frame.left) / scale);
		const pageY = Math.round((params.y - frame.top) / scale);
		const actions: IAction[] = [];
		const group = (items: IAction[]) => {
			if (!items.length) {
				return;
			}
			if (actions.length) {
				actions.push(new Separator());
			}
			actions.push(...items);
		};
		const link = params.linkURL;
		if (link) {
			group([
				toAction({ id: 'volt.browser.link.open', label: localize('voltBrowser.ctx.openLink', "Open Link"), run: () => this.navigate(link) }),
				toAction({ id: 'volt.browser.link.newTab', label: localize('voltBrowser.ctx.openLinkTab', "Open Link in New Tab"), run: () => this.openInNewTab(link) }),
				toAction({ id: 'volt.browser.link.external', label: localize('voltBrowser.ctx.openLinkExternal', "Open Link in System Browser"), run: () => this.openerService.open(URI.parse(link), { openExternal: true }) }),
				toAction({ id: 'volt.browser.link.copy', label: localize('voltBrowser.ctx.copyLink', "Copy Link Address"), run: () => this.clipboardService.writeText(link) }),
			]);
		}
		const image = params.mediaType === 'image' ? params.srcURL : undefined;
		if (image) {
			group([
				toAction({ id: 'volt.browser.image.newTab', label: localize('voltBrowser.ctx.openImage', "Open Image in New Tab"), run: () => this.openInNewTab(image) }),
				toAction({ id: 'volt.browser.image.copy', label: localize('voltBrowser.ctx.copyImage', "Copy Image Address"), run: () => this.clipboardService.writeText(image) }),
			]);
		}
		const flags = params.editFlags ?? {};
		const selection = params.selectionText?.trim();
		if (params.isEditable) {
			group([
				toAction({ id: 'volt.browser.cut', label: localize('voltBrowser.ctx.cut', "Cut"), enabled: flags.canCut !== false, run: () => this.callGuest(() => this.webview?.cut?.()) }),
				toAction({ id: 'volt.browser.copy', label: localize('voltBrowser.ctx.copy', "Copy"), enabled: flags.canCopy !== false, run: () => this.callGuest(() => this.webview?.copy?.()) }),
				toAction({ id: 'volt.browser.paste', label: localize('voltBrowser.ctx.paste', "Paste"), enabled: flags.canPaste !== false, run: () => this.callGuest(() => this.webview?.paste?.()) }),
				toAction({ id: 'volt.browser.selectAll', label: localize('voltBrowser.ctx.selectAll', "Select All"), run: () => this.callGuest(() => this.webview?.selectAll?.()) }),
			]);
		} else if (selection) {
			const short = selection.length > 32 ? `${selection.slice(0, 31)}…` : selection;
			group([
				toAction({ id: 'volt.browser.copy', label: localize('voltBrowser.ctx.copy', "Copy"), run: () => this.callGuest(() => this.webview?.copy?.()) }),
				toAction({ id: 'volt.browser.search', label: localize('voltBrowser.ctx.search', "Search Google for \u201c{0}\u201d", short), run: () => this.openInNewTab(normalizeBrowserUrl(`${selection} `)) }),
			]);
		}
		if (!link && !image && !selection && !params.isEditable) {
			let canBack = false;
			let canForward = false;
			try {
				canBack = !!webview.canGoBack?.();
				canForward = !!webview.canGoForward?.();
			} catch {
				// The page is still attaching.
			}
			group([
				toAction({ id: 'volt.browser.back', label: localize('voltBrowser.back', "Back"), enabled: canBack, run: () => this.callGuest(() => this.webview?.goBack()) }),
				toAction({ id: 'volt.browser.forward', label: localize('voltBrowser.forward', "Forward"), enabled: canForward, run: () => this.callGuest(() => this.webview?.goForward()) }),
				toAction({ id: 'volt.browser.reload', label: localize('voltBrowser.reload', "Reload"), run: () => this.callGuest(() => this.webview?.reload()) }),
			]);
		}
		group([
			toAction({ id: 'volt.browser.inspect', label: localize('voltBrowser.ctx.inspect', "Inspect Element"), run: () => this.callGuest(() => this.webview?.inspectElement?.(pageX, pageY)) }),
		]);
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	/** A new browser tab beside this one, in the same group. */
	private openInNewTab(url: string): void {
		const group = this.editorGroupsService.groups.find(candidate => candidate.contains(this.input)) ?? this.editorGroupsService.activeGroup;
		const next = this.instantiationService.createInstance(VoltBrowserEditorInput, VoltBrowserEditorInput.getNewEditorUri());
		next.url = normalizeBrowserUrl(url);
		try {
			next.setTitle(new URL(next.url).hostname);
		} catch {
			// keeps "Browser"
		}
		void group.openEditor(next, { pinned: true });
	}

	/** Moves this tab into its own window. The page reloads once there. */
	private async openInWindow(): Promise<void> {
		const source = this.editorGroupsService.groups.find(candidate => candidate.contains(this.input));
		const part = await this.editorGroupsService.createAuxiliaryEditorPart();
		if (source) {
			source.moveEditor(this.input, part.activeGroup);
		} else {
			await part.activeGroup.openEditor(this.input, { pinned: true });
		}
	}

	private stepZoom(direction: 1 | -1): void {
		const current = this.zoomFactor;
		const next = direction > 0
			? ZOOM_LEVELS.find(level => level > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
			: [...ZOOM_LEVELS].reverse().find(level => level < current - 0.001) ?? ZOOM_LEVELS[0];
		this.setZoom(next);
	}

	private setZoom(factor: number): void {
		this.zoomFactor = factor;
		this.callGuest(() => this.webview?.setZoomFactor?.(factor));
	}

	/** Zoom and appearance are the page's own; a new document starts without them. */
	private applyPageSettings(): void {
		if (this.zoomFactor !== 1) {
			this.callGuest(() => this.webview?.setZoomFactor?.(this.zoomFactor));
		}
		void this.applyAppearance();
	}

	private async applyAppearance(): Promise<void> {
		const webview = this.webview;
		if (!webview || !this.guestReady) {
			return;
		}
		const scheme = this.history.appearance;
		let id: number | undefined;
		try {
			id = webview.getWebContentsId?.();
		} catch {
			id = undefined;
		}
		const service = this.browserService();
		if (id !== undefined && service) {
			try {
				if (await service.setColorScheme(id, scheme)) {
					return;
				}
			} catch {
				// An app started before this feature has no handler; the page hint below still applies.
			}
		}
		// Without the DevTools protocol only the page's own controls and scrollbars follow.
		await this.runGuest(`document.documentElement.style.colorScheme = ${JSON.stringify(scheme === 'system' ? '' : scheme)}`);
	}

	private browserService(): IVoltBrowserService | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(IVoltBrowserService));
		} catch {
			return undefined;
		}
	}

	private clearHistory(): void {
		this.history.clear();
		this.showToast(localize('voltBrowser.historyCleared', "Browsing history cleared"));
	}

	private async clearData(kind: 'cookies' | 'cache'): Promise<void> {
		const service = this.browserService();
		try {
			if (!service) {
				throw new Error('unavailable');
			}
			await service.clearData(kind);
			if (kind === 'cache') {
				this.callGuest(() => this.webview?.reloadIgnoringCache?.());
			}
			this.showToast(kind === 'cookies' ? localize('voltBrowser.cookiesCleared', "Cookies cleared") : localize('voltBrowser.cacheCleared', "Cache cleared"));
		} catch {
			this.showToast(localize('voltBrowser.clearNeedsRestart', "Restart Volt to clear browser data"));
		}
	}

	private async takeScreenshot(): Promise<void> {
		const image = await this.captureSnapshot();
		if (!image) {
			this.showToast(localize('voltBrowser.screenshotFailed', "Could not capture the page"));
			return;
		}
		try {
			const blob = await (await fetch(image)).blob();
			const win = getWindow(this.container) as Window & typeof globalThis;
			await win.navigator.clipboard.write([new win.ClipboardItem({ [blob.type || 'image/png']: blob })]);
			this.showToast(localize('voltBrowser.screenshotCopied', "Screenshot copied to clipboard"));
		} catch {
			this.showToast(localize('voltBrowser.screenshotCopyFailed', "Could not copy the screenshot"));
		}
	}

	/** The page's top color, for a device frame's status bar. */
	private async syncScreenColor(): Promise<void> {
		if (!this.deviceMode.device) {
			return;
		}
		const colors = await this.runGuest<{ top?: string; bottom?: string }>(SCREEN_COLOR_SCRIPT);
		if (colors?.top) {
			this.deviceMode.setScreenColor(colors.top, colors.bottom);
		}
	}

	private showToast(message: string): void {
		const win = getWindow(this.container);
		this.toastEl.textContent = message;
		this.toastEl.classList.remove('hidden');
		if (this.toastHandle !== undefined) {
			win.clearTimeout(this.toastHandle);
		}
		this.toastHandle = win.setTimeout(() => {
			this.toastHandle = undefined;
			this.toastEl.classList.add('hidden');
		}, 1800);
	}

	//#endregion

	//#region Presentation in the agent window

	/** Asks the tools area holding this tab to float it over the chat, span the window, or dock it again. */
	private requestPresentation(mode: BrowserPresentation): void {
		this.element.dispatchEvent(new CustomEvent(BROWSER_PRESENT_EVENT, { bubbles: true, detail: { mode } }));
	}

	private setPresentation(mode: BrowserPresentation | undefined): void {
		if (this.presentation === mode) {
			return;
		}
		this.presentation = mode;
		this.container.classList.toggle('presentation-floating', mode === 'floating');
		this.container.classList.toggle('presentation-fullscreen', mode === 'fullscreen');
		// The dock is the chat's composer only across the window; elsewhere the chat is right there.
		this.dock?.setChatMode(mode === 'fullscreen');
		this.hideSuggestions();
		this.layout();
	}

	/** The chat whose tools area holds this tab, if any. */
	private ownerSession(): string | undefined {
		return this.element.closest<HTMLElement>('.volt-agent-tools-part')?.dataset.sessionId;
	}

	//#endregion

	private onDesignPointerDown(e: PointerEvent): void {
		if (!this.designMode || this.eventOnPrompt(e)) {
			return;
		}
		this.overlay.setPointerCapture?.(e.pointerId);
		const point = this.stagePoint(e);
		this.drawing = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
		this.drawBox.classList.add('hidden');
	}

	private onDesignPointerMove(e: PointerEvent): void {
		if (!this.designMode || this.eventOnPrompt(e)) {
			return;
		}
		const point = this.stagePoint(e);
		if (this.drawing) {
			this.drawing.currentX = point.x;
			this.drawing.currentY = point.y;
			const rect = normalizeRect(this.drawing.startX, this.drawing.startY, point.x, point.y);
			if (Math.max(rect.w, rect.h) > 4) {
				this.clearHover();
				this.placeBox(this.drawBox, rect);
			}
			return;
		}
		this.scheduleProbe(point.x, point.y);
	}

	private async onDesignPointerUp(e: PointerEvent): Promise<void> {
		if (!this.designMode || this.eventOnPrompt(e) || !this.drawing) {
			this.drawing = undefined;
			return;
		}
		const draw = this.drawing;
		this.drawing = undefined;
		this.drawBox.classList.add('hidden');
		const rect = normalizeRect(draw.startX, draw.startY, draw.currentX, draw.currentY);
		if (rect.w > 4 || rect.h > 4) {
			await this.selectRegion(rect);
			return;
		}
		const hit = this.hoverHit ?? await this.probe(draw.startX, draw.startY);
		if (hit) {
			await this.selectHit(hit);
		}
	}

	private scheduleProbe(x: number, y: number): void {
		const key = `${Math.round(x)}:${Math.round(y)}`;
		if (key === this.lastProbe) {
			return;
		}
		this.lastProbe = key;
		if (this.probeHandle !== undefined) {
			return;
		}
		this.probeHandle = getWindow(this.overlay).requestAnimationFrame(() => {
			this.probeHandle = undefined;
			void this.probe(x, y).then(hit => {
				this.hoverHit = hit;
				if (hit && !this.drawing) {
					this.placeBox(this.hoverBox, hitToRect(hit));
					this.syncHint(hit);
				} else {
					this.hoverBox.classList.add('hidden');
					this.syncHint();
				}
			});
		});
	}

	private async probe(x: number, y: number): Promise<IBrowserHit | undefined> {
		const frame = this.webview?.getBoundingClientRect();
		if (!frame) {
			return undefined;
		}
		const result = await this.runGuest<IBrowserHit>(PROBE_SCRIPT.replace('__X__', String(x)).replace('__Y__', String(y)));
		if (!result || !result.w || !result.h) {
			return undefined;
		}
		return result;
	}

	private async selectHit(hit: IBrowserHit): Promise<void> {
		this.selection = {
			kind: 'element',
			bounds: hitToRect(hit),
			tag: hit.tag,
			domPath: hit.domPath,
			className: hit.className,
			attributes: hit.attributes,
			selector: hit.selector,
			html: hit.html,
			text: hit.text,
		};
		this.finishSelection();
	}

	private async selectRegion(bounds: { x: number; y: number; w: number; h: number }): Promise<void> {
		this.selection = { kind: 'region', tag: 'region', bounds };
		this.finishSelection();
	}

	private finishSelection(): void {
		if (!this.selection) {
			return;
		}
		for (const pin of this.comments) {
			if (pin.card.expanded) {
				pin.card.collapse();
				this.placeComment(pin);
			}
		}
		this.hoverBox.classList.add('hidden');
		this.hintEl.classList.add('hidden');
		this.promptEl.classList.remove('hidden');
		this.composer?.clear();
		const mention = this.composer?.setSelectionChip(this.selectionChipLabel(), this.formatBrowserElement());
		if (mention && this.selection) {
			this.addMark(mention, this.selection.bounds);
		}
		this.composer?.layout();
		this.positionPrompt();
		this.syncDockBlocked();
		getWindow(this.promptEl).requestAnimationFrame(() => this.positionPrompt());
	}

	private selectionChipLabel(): string {
		return this.selection?.tag || (this.selection?.kind === 'region' ? 'region' : 'node');
	}

	private clearSelection(exitPrompt = false): void {
		if (exitPrompt) {
			this.closeDraft();
			return;
		}
		this.selection = undefined;
		this.selectBox.classList.add('hidden');
		this.drawBox.classList.add('hidden');
		this.syncHint(this.hoverHit);
	}

	private closeDraft(): void {
		this.selection = undefined;
		this.selectBox.classList.add('hidden');
		this.drawBox.classList.add('hidden');
		this.promptEl?.classList.add('hidden');
		this.composer?.clear();
		this.syncDockBlocked();
		this.syncHint();
	}

	private syncDockBlocked(): void {
		const draftOpen = !!this.selection && !this.promptEl.classList.contains('hidden');
		const commentOpen = this.comments.some(pin => pin.card.expanded);
		this.dock?.setBlocked(draftOpen || commentOpen);
	}

	private addMark(mention: IAgentMention, bounds: { x: number; y: number; w: number; h: number }): void {
		this.addBoundsMark(mention.id, bounds, mention.accent ?? 0);
	}

	private addBoundsMark(id: string, bounds: { x: number; y: number; w: number; h: number }, accent: number): void {
		if (this.marks.has(id)) {
			return;
		}
		const box = append(this.overlay, $('div.volt-browser-box.mark'));
		box.style.setProperty('--volt-mark-color', browserMentionColor(accent));
		this.placeBox(box, bounds);
		this.marks.set(id, { box, accent, bounds });
	}

	private removeMark(id: string): void {
		const mark = this.marks.get(id);
		if (!mark) {
			return;
		}
		mark.box.remove();
		this.marks.delete(id);
	}

	private glowMark(mention: IAgentMention | undefined): void {
		for (const [id, mark] of this.marks) {
			mark.box.classList.toggle('glow', mention?.id === id);
		}
	}

	private clearHover(): void {
		this.hoverHit = undefined;
		this.lastProbe = '';
		this.hoverBox.classList.add('hidden');
		this.syncHint();
	}

	private hintPath(hit: IBrowserHit): string {
		const id = hit.attributes?.id;
		if (id) {
			return `${id}#`;
		}
		const cls = hit.className.trim().split(/\s+/).filter(Boolean)[0];
		if (cls) {
			return cls;
		}
		return hit.tag;
	}

	private syncHint(hit?: IBrowserHit): void {
		if (!this.hintEl) {
			return;
		}
		if (!this.designMode || this.selection) {
			this.hintEl.classList.add('hidden');
			return;
		}
		const path = hit ? this.hintPath(hit) : '';
		this.hintPathEl.textContent = path;
		this.hintPathEl.classList.toggle('hidden', !path);
		this.hintEl.classList.remove('hidden');
		if (hit) {
			const rect = hitToRect(hit);
			const width = Math.max(this.hintEl.offsetWidth, 220);
			const left = rect.x + rect.w / 2 - width / 2;
			this.hintEl.style.left = `${Math.max(8, left)}px`;
			this.hintEl.style.top = `${rect.y + rect.h + 10}px`;
			this.hintEl.style.right = 'auto';
			return;
		}
		this.hintEl.style.top = '18px';
		this.hintEl.style.right = '18px';
		this.hintEl.style.left = 'auto';
	}

	private positionPrompt(): void {
		if (!this.selection || this.promptEl.classList.contains('hidden')) {
			return;
		}
		const stage = this.stage.getBoundingClientRect();
		const pad = 8;
		const width = Math.min(350, Math.max(160, stage.width - pad * 2));
		const nextWidth = `${width}px`;
		if (this.promptEl.style.width !== nextWidth) {
			this.promptEl.style.width = nextWidth;
		}
		const height = Math.max(this.composer?.element.offsetHeight || 72, 72);
		const placed = this.placeAroundSelection(width, height);
		this.applyPromptBox({ left: placed.left, top: placed.top, width, height }, false);
	}

	private pinPromptAsComment(): void {
		const composer = this.composer;
		const selection = this.selection;
		if (!composer || !selection || this.promptEl.classList.contains('hidden') || !composer.hasDraft()) {
			return;
		}
		const label = this.selectionChipLabel();
		const preview = commentPreviewText(composer.getDisplayText(), label);
		const payload = this.formatBrowserElement();
		const body = preview === label ? '' : preview;
		const markId = `comment:${generateUuid()}`;
		const pinnedSelection = cloneBrowserSelection(selection);
		this.addBoundsMark(markId, pinnedSelection.bounds, this.comments.length);
		// eslint-disable-next-line prefer-const -- card callbacks close over the pin, filled in once the card exists
		let pin!: IPinnedBrowserComment;
		const card = this._register(new BrowserCommentCard({
			index: this.comments.length + 1,
			preview,
			selectionLabel: label,
			onOpen: () => this.openComment(pin),
			createComposer: () => this.instantiationService.createInstance(BrowserAgentComposer, {
				onSubmit: text => { void this.sendPinned(pin, text); },
				onPrefill: text => { this.dock?.prefillFromBrowser(text); },
				onComment: () => this.collapseComment(pin),
				onLayout: () => this.placeComment(pin),
				onHoverMention: mention => this.glowMark(mention),
			}),
			seed: next => {
				next.setDraft('');
				next.setSelectionChip(label, payload);
				next.appendPlainText(body);
			},
		}));
		pin = { card, selection: pinnedSelection, markId };
		this.comments.push(pin);
		this.overlay.appendChild(card.element);
		this.closeDraft();
		this.placeComment(pin);
		getWindow(card.element).requestAnimationFrame(() => this.placeComment(pin));
	}

	private openComment(pin: IPinnedBrowserComment): void {
		this.closeDraft();
		for (const other of this.comments) {
			if (other !== pin && other.card.expanded) {
				other.card.collapse();
				this.placeComment(other);
			}
		}
		pin.card.expand();
		this.placeComment(pin);
		this.syncDockBlocked();
	}

	private collapseComment(pin: IPinnedBrowserComment): void {
		pin.card.collapse();
		this.placeComment(pin);
		this.syncDockBlocked();
	}

	private removeComment(pin: IPinnedBrowserComment): void {
		const index = this.comments.indexOf(pin);
		if (index >= 0) {
			this.comments.splice(index, 1);
		}
		this.removeMark(pin.markId);
		pin.card.dispose();
		this.comments.forEach((item, itemIndex) => item.card.setIndex(itemIndex + 1));
		this.syncDockBlocked();
	}

	private clearComments(): void {
		for (const pin of this.comments) {
			this.removeMark(pin.markId);
			pin.card.dispose();
		}
		this.comments.length = 0;
	}

	private async sendPinned(pin: IPinnedBrowserComment, prompt: string): Promise<void> {
		const text = prompt.trim();
		if (!text) {
			return;
		}
		const composer = pin.card.input;
		const displayText = composer?.getDisplayText() ?? text;
		const mentions = cloneDisplayMentions(composer?.getDisplayMentions() ?? []);
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		await Promise.resolve();
		this.removeComment(pin);
		this.clearHover();
		await this.dock?.submitFromBrowser(text, display);
	}

	private placeComment(pin: IPinnedBrowserComment): void {
		const el = pin.card.element;
		if (!el.isConnected) {
			return;
		}
		const stage = this.stage.getBoundingClientRect();
		const pad = 8;
		const sel = pin.selection.bounds;
		if (pin.card.expanded) {
			const width = Math.min(350, Math.max(160, stage.width - pad * 2));
			const nextWidth = `${width}px`;
			if (el.style.width !== nextWidth) {
				el.style.width = nextWidth;
			}
			const height = Math.max(el.offsetHeight, 72);
			const placed = this.placeAroundSelection(width, height, sel);
			el.style.left = `${placed.left}px`;
			el.style.top = `${placed.top}px`;
			el.style.height = 'auto';
			return;
		}
		const width = 30;
		const height = 32;
		el.style.width = `${width}px`;
		el.style.height = `${height}px`;
		const left = Math.min(Math.max(pad, sel.x - 6), Math.max(pad, stage.width - width - pad));
		const top = Math.min(Math.max(pad, sel.y - 10), Math.max(pad, stage.height - height - pad));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	private placeAroundSelection(width: number, height: number, bounds?: { x: number; y: number; w: number; h: number }): { left: number; top: number } {
		const stage = this.stage.getBoundingClientRect();
		const pad = 8;
		const sel = bounds ?? this.selection?.bounds ?? { x: pad, y: pad, w: 0, h: 0 };
		const clamp = (left: number, top: number) => ({
			left: Math.min(Math.max(pad, left), Math.max(pad, stage.width - width - pad)),
			top: Math.min(Math.max(pad, top), Math.max(pad, stage.height - height - pad)),
		});
		const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
			const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
			const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
			return x * y;
		};
		const gap = 12;
		const obstacles = [
			sel,
			...[...this.marks.values()].map(mark => mark.bounds),
			...this.comments.map(pin => pin.selection.bounds),
		];
		const candidates = [
			clamp(sel.x + sel.w / 2 - width / 2, sel.y + sel.h + gap),
			clamp(sel.x + sel.w / 2 - width / 2, sel.y - height - gap),
			clamp(sel.x + sel.w + gap, sel.y),
			clamp(sel.x - width - gap, sel.y),
			clamp(sel.x + sel.w + gap, sel.y + sel.h - height),
			clamp(sel.x - width - gap, sel.y + sel.h - height),
			clamp(sel.x + sel.w / 2 - width / 2, sel.y + sel.h + gap + 24),
		];
		let best = candidates[0];
		let bestScore = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			const rect = { x: candidate.left, y: candidate.top, w: width, h: height };
			const covered = obstacles.reduce((sum, item) => sum + overlap(rect, item), 0);
			const score = covered + Math.abs(candidate.left - (sel.x + sel.w / 2 - width / 2)) * 0.05;
			if (score < bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		return best;
	}

	private applyPromptBox(box: { left: number; top: number; width: number; height: number }, lockHeight: boolean): void {
		this.promptEl.style.width = `${box.width}px`;
		this.promptEl.style.left = `${box.left}px`;
		this.promptEl.style.top = `${box.top}px`;
		this.promptEl.style.height = lockHeight ? `${box.height}px` : 'auto';
	}

	private async sendSelectionToAgent(submit: boolean, prompt: string): Promise<void> {
		if (!prompt && submit) {
			return;
		}
		const text = prompt.trim() || localize('voltBrowser.defaultPrompt', "Update this selection.");
		const displayText = this.composer?.getDisplayText() ?? text;
		const mentions = cloneDisplayMentions(this.composer?.getDisplayMentions() ?? []);
		const display = mentions.length ? { text: displayText, mentions } : undefined;
		this.closeDraft();
		this.clearHover();
		if (submit) {
			await this.dock?.submitFromBrowser(text, display);
			return;
		}
		this.dock?.prefillFromBrowser(text);
	}

	private formatBrowserElement(): string {
		const selection = this.selection;
		const bounds = selection?.bounds;
		const top = Math.round(bounds?.y ?? 0);
		const left = Math.round(bounds?.x ?? 0);
		const width = Math.round(bounds?.w ?? 0);
		const height = Math.round(bounds?.h ?? 0);
		const tag = selection?.tag || (selection?.kind === 'region' ? 'region' : 'node');
		const id = selection?.attributes?.id;
		const lines = [
			'```browser_element',
			selection?.kind === 'region'
				? 'The user selected this region in the browser preview (blue outline in the screenshot).'
				: 'The user selected this node in the browser preview (blue outline in the screenshot).',
			'',
			`tag: ${tag}`,
		];
		if (selection?.domPath) {
			lines.push(`dom_path: ${selection.domPath}`);
		}
		if (id) {
			lines.push(`id: ${id}`);
		}
		if (selection?.className) {
			lines.push(`class: ${selection.className}`);
		}
		lines.push(`bounds_css_px: top=${top} left=${left} width=${width} height=${height}`);
		const attributes = Object.entries(selection?.attributes ?? {});
		const visible = attributes.slice(0, 18);
		const hidden = attributes.length - visible.length;
		if (visible.length) {
			lines.push('attributes:', ...visible.map(([name, value]) => `  ${name}=${value}`));
			if (hidden > 0) {
				lines.push(`  ... and ${hidden} more`);
			}
		}
		lines.push('```');
		return lines.join('\n');
	}

	/** Reads the page colour under the collapsed dock, so the bar keeps its contrast over light and dark pages. */
	private async sampleDockTone(): Promise<void> {
		const dock = this.dock;
		const webview = this.webview;
		const point = dock?.backdropPoint();
		if (!dock || !webview || !point || !this.guestReady || this.dockToneBusy || webview.ownerDocument.visibilityState === 'hidden') {
			return;
		}
		const frame = webview.getBoundingClientRect();
		if (!frame.width || point.x < frame.left || point.x > frame.right || point.y < frame.top || point.y > frame.bottom) {
			dock.setBackdropTone(undefined);
			return;
		}
		// Device mode scales the page and zoom changes its CSS pixels.
		const scale = (webview.offsetWidth / frame.width || 1) / this.zoomFactor;
		this.dockToneBusy = true;
		try {
			const tone = await this.runGuest<'light' | 'dark' | null>(dockToneScript(Math.round((point.x - frame.left) * scale), Math.round((point.y - frame.top) * scale)));
			if (tone && this.webview === webview) {
				dock.setBackdropTone(tone);
			}
		} finally {
			this.dockToneBusy = false;
		}
	}

	private async runGuest<T>(code: string): Promise<T | undefined> {
		const webview = this.webview;
		if (!webview?.executeJavaScript) {
			return undefined;
		}
		try {
			return await webview.executeJavaScript(code, false) as T;
		} catch {
			return undefined;
		}
	}

	private stagePoint(e: PointerEvent): { x: number; y: number } {
		const frame = (this.webview ?? this.stage).getBoundingClientRect();
		return { x: e.clientX - frame.left, y: e.clientY - frame.top };
	}

	private eventOnPrompt(e: Event): boolean {
		const target = e.target as Node | null;
		if (!target) {
			return false;
		}
		return this.promptEl.contains(target)
			|| this.comments.some(pin => pin.card.element.contains(target))
			|| !!this.dock?.element.contains(target);
	}

	private placeBox(box: HTMLElement, rect: { x: number; y: number; w: number; h: number }): void {
		box.style.left = `${rect.x}px`;
		box.style.top = `${rect.y}px`;
		box.style.width = `${Math.max(1, rect.w)}px`;
		box.style.height = `${Math.max(1, rect.h)}px`;
		box.classList.remove('hidden');
	}

	//#region Agent automation (the `browser_*` host tools)

	/** Waits for the page to attach and finish loading. False when it never became ready (or the wait was cancelled). */
	async automationReady(timeoutMs = 15000, token: CancellationToken = CancellationToken.None): Promise<boolean> {
		const started = Date.now();
		while (!this.guestReady || !this.webview || !this.guestIdle) {
			if (token.isCancellationRequested) {
				return false;
			}
			if (Date.now() - started >= timeoutMs) {
				return !!this.webview && this.guestReady;
			}
			await timeout(50);
		}
		return true;
	}

	/** A navigation or load is in flight: scripts run now may land in the document that is going away. */
	isLoadingForAgent(): boolean {
		try {
			return !!this.webview?.isLoading?.() || !this.guestIdle;
		} catch {
			return !this.guestIdle;
		}
	}

	/** After an input: give the page a beat to react, and if that started a navigation, wait it out. */
	async settle(timeoutMs = 10000, token: CancellationToken = CancellationToken.None): Promise<void> {
		await timeout(60);
		let loading = false;
		try {
			loading = !!this.webview?.isLoading?.();
		} catch {
			loading = false;
		}
		if (loading || !this.guestIdle) {
			await this.automationReady(timeoutMs, token);
		}
		// One frame for the page's own rAF-driven updates (animations, React commits).
		await timeout(40);
	}

	async navigateForAgent(url: string, timeoutMs = 20000, token: CancellationToken = CancellationToken.None): Promise<boolean> {
		this.navigate(url);
		this.guestIdle = false;
		await timeout(30);
		return this.automationReady(timeoutMs, token);
	}

	/** `reload-fresh` skips the HTTP cache, so a page re-renders from files the agent just edited. */
	async historyForAgent(action: 'back' | 'reload' | 'reload-fresh', token: CancellationToken = CancellationToken.None): Promise<void> {
		this.guestIdle = false;
		this.callGuest(() => {
			const webview = this.webview;
			if (action === 'back') {
				webview?.goBack();
			} else if (action === 'reload-fresh' && typeof webview?.reloadIgnoringCache === 'function') {
				webview.reloadIgnoringCache();
			} else {
				webview?.reload();
			}
		});
		await timeout(30);
		await this.automationReady(15000, token);
	}

	/** The page the tab shows (what the address bar says). */
	get pageUrl(): string {
		return this.input.url;
	}

	async runScript<T>(code: string): Promise<T | undefined> {
		const webview = this.webview;
		if (!webview?.executeJavaScript || !this.guestReady) {
			return undefined;
		}
		return await webview.executeJavaScript(code) as T;
	}

	canSendInput(): boolean {
		return typeof this.webview?.sendInputEvent === 'function';
	}

	sendInput(event: IVoltInputEvent): void {
		this.callGuest(() => this.webview?.sendInputEvent?.(event));
	}

	async insertText(text: string): Promise<boolean> {
		const webview = this.webview;
		if (!webview?.insertText || !this.guestReady) {
			return false;
		}
		await webview.insertText(text);
		return true;
	}

	/** Keyboard input goes to the focused web contents, so the page takes focus while the agent types. */
	focusPage(): void {
		this.callGuest(() => this.webview?.focus());
	}

	/** A width x height viewport centered in the stage (responsive design mode), to test layouts; undefined fills the pane. */
	setViewport(size: { width: number; height: number } | undefined): void {
		if (size) {
			this.deviceMode.enable(size);
		} else {
			this.deviceMode.disable();
		}
		this.syncResponsiveButton();
	}

	getViewport(): { width: number; height: number } | undefined {
		return this.deviceMode.size;
	}

	/** Every console line since the page loaded, without marking any as seen. */
	peekConsole(): readonly IVoltConsoleMessage[] {
		return this.consoleMessages.slice();
	}

	/** Console lines since the last call (`sinceLast`) or since the page loaded. */
	takeConsole(sinceLast: boolean): IVoltConsoleMessage[] {
		const from = sinceLast ? this.consoleSeen : 0;
		this.consoleSeen = this.consoleMessages.length;
		return this.consoleMessages.slice(from);
	}

	/** Where a page point sits in the stage, for the click ripple. */
	private pagePointInStage(x: number, y: number): { x: number; y: number } {
		const frame = this.webview?.getBoundingClientRect();
		const stage = this.stage.getBoundingClientRect();
		const scale = this.deviceMode.scale;
		return { x: (frame ? frame.left - stage.left : 0) + x * scale, y: (frame ? frame.top - stage.top : 0) + y * scale };
	}

	/** A short ring where the agent clicked, so the user can follow the test. */
	showAgentClick(x: number, y: number): void {
		if (!this.stage) {
			return;
		}
		const point = this.pagePointInStage(x, y);
		const ring = append(this.stage, $('.volt-browser-agent-click'));
		ring.style.left = `${point.x}px`;
		ring.style.top = `${point.y}px`;
		const win = getWindow(this.stage);
		win.setTimeout(() => ring.remove(), 600);
	}

	get agentLocked(): boolean {
		return !!this.agentLock;
	}

	/**
	 * While the agent drives the page the view is locked: a clear layer over the page takes the
	 * pointer, and a "Take control" pill follows it. Clicking the pill hands the page back.
	 */
	setAgentLock(locked: boolean): void {
		if (locked === !!this.agentLock || !this.stage) {
			return;
		}
		this.container.classList.toggle('agent-locked', locked);
		if (!locked) {
			this.agentLock?.remove();
			this.agentLock = undefined;
			return;
		}
		const lock = append(this.stage, $('.volt-browser-agent-lock'));
		lock.setAttribute('aria-label', localize('voltBrowser.agentLocked', "The agent is using this browser"));
		const pill = append(lock, $('button.volt-browser-take-control')) as HTMLButtonElement;
		pill.type = 'button';
		pill.appendChild(createPointerIcon());
		append(pill, $('span')).textContent = localize('voltBrowser.takeControl', "Take control");
		const store = new DisposableStore();
		store.add(addDisposableListener(lock, 'pointerdown', e => {
			e.preventDefault();
			e.stopPropagation();
		}));
		store.add(addDisposableListener(pill, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.setAgentLock(false);
			this._onDidTakeControl.fire();
		}));
		const remove = lock.remove.bind(lock);
		lock.remove = () => {
			store.dispose();
			remove();
		};
		this.agentLock = lock;
	}

	//#endregion

	private layout(): void {
		this.deviceMode?.layout();
		if (this.selection) {
			this.positionPrompt();
		}
		for (const pin of this.comments) {
			this.placeComment(pin);
		}
		this.dock?.layout();
	}

	async revealAgentInSidebar(): Promise<void> {
		const overlayDraft = this.composer && !this.promptEl.classList.contains('hidden')
			? this.composer.getDisplayText()
			: undefined;
		await this.dock?.revealInAgentsSidebar(overlayDraft);
	}

	focus(): void {
		if (this.selection && !this.promptEl.classList.contains('hidden')) {
			this.composer?.focus();
			return;
		}
		const open = this.comments.find(pin => pin.card.expanded);
		if (open) {
			open.card.focus();
			return;
		}
		this.urlInput.focus();
		this.urlInput.select();
	}

	override dispose(): void {
		if (this.probeHandle !== undefined && this.container) {
			getWindow(this.container).cancelAnimationFrame(this.probeHandle);
		}
		if (this.relayoutHandle !== undefined) {
			getWindow(this.element).cancelAnimationFrame(this.relayoutHandle);
		}
		this.webviewListeners.clear();
		this.webview?.remove();
		this.webview = undefined;
		this.guestReady = false;
		this.pendingUrl = undefined;
		this.element.remove();
		super.dispose();
	}
}

/** One layer per editor part holds its browser views; views are never moved between groups' DOM. */
function browserViewLayer(slot: HTMLElement): HTMLElement {
	const host = slot.closest<HTMLElement>('.part.editor') ?? slot.ownerDocument.body;
	let layer = host.querySelector<HTMLElement>(':scope > .volt-browser-view-layer');
	if (!layer) {
		host.classList.add('volt-browser-view-host');
		layer = append(host, $('.volt-browser-view-layer'));
	}
	return layer;
}

export const IVoltBrowserViews = createDecorator<IVoltBrowserViews>('voltBrowserViews');

/** Keeps each browser tab's view alive from first show until the tab closes. */
export interface IVoltBrowserViews {
	readonly _serviceBrand: undefined;
	viewFor(input: VoltBrowserEditorInput): VoltBrowserView;
}

class VoltBrowserViews extends Disposable implements IVoltBrowserViews {

	declare readonly _serviceBrand: undefined;

	private readonly views = this._register(new DisposableMap<VoltBrowserEditorInput, VoltBrowserView>());

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}

	viewFor(input: VoltBrowserEditorInput): VoltBrowserView {
		let view = this.views.get(input);
		if (!view) {
			// Root services: the view outlives the group (and its scoped services) it opened in.
			view = this.instantiationService.createInstance(VoltBrowserView, input);
			this.views.set(input, view);
			BaseEvent.once(input.onWillDispose)(() => this.views.deleteAndDispose(input));
		}
		return view;
	}
}

registerSingleton(IVoltBrowserViews, VoltBrowserViews, InstantiationType.Delayed);

/** The editor pane for a browser tab: a slot the tab's `VoltBrowserView` is laid over. */
export class VoltBrowserEditor extends EditorPane {

	static readonly ID = VoltBrowserEditorInput.EditorID;

	private slot!: HTMLElement;
	private view: VoltBrowserView | undefined;
	private readonly viewListeners = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IVoltBrowserViews private readonly browserViews: IVoltBrowserViews,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(VoltBrowserEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.slot = append(parent, $('.volt-browser-slot'));
	}

	override async setInput(input: VoltBrowserEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		const view = this.browserViews.viewFor(input);
		if (view !== this.view) {
			this.releaseView();
			this.view = view;
			this.viewListeners.add(view.onDidFocus(() => this.editorGroupsService.activateGroup(this.group)));
		}
		if (this.isVisible()) {
			view.show(this.slot);
		}
	}

	override clearInput(): void {
		this.releaseView();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!this.view) {
			return;
		}
		if (visible) {
			this.view.show(this.slot);
		} else {
			this.view.hide(this.slot);
		}
	}

	override layout(_dimension: Dimension): void {
		this.view?.layoutOver(this.slot);
	}

	override focus(): void {
		super.focus();
		this.view?.focus();
	}

	openUrl(value: string): void {
		this.view?.openUrl(value);
	}

	captureSnapshot(): Promise<string | undefined> {
		return this.view?.captureSnapshot() ?? Promise.resolve(undefined);
	}

	private releaseView(): void {
		this.viewListeners.clear();
		this.view?.hide(this.slot);
		this.view = undefined;
	}

	override dispose(): void {
		this.releaseView();
		super.dispose();
	}
}

function cloneBrowserSelection(selection: IBrowserSelection): IBrowserSelection {
	return {
		...selection,
		bounds: { ...selection.bounds },
		attributes: selection.attributes ? { ...selection.attributes } : undefined,
	};
}

function hitToRect(hit: IBrowserHit): { x: number; y: number; w: number; h: number } {
	return { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
}

function normalizeRect(x1: number, y1: number, x2: number, y2: number): { x: number; y: number; w: number; h: number } {
	const x = Math.min(x1, x2);
	const y = Math.min(y1, y2);
	return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

interface IAriaIconSpec {
	size?: number;
	paths?: readonly string[];
	rects?: readonly { x: string; y: string; width: string; height: string; rx?: string }[];
	circles?: readonly { cx: string; cy: string; r: string }[];
	lines?: readonly { x1: string; y1: string; x2: string; y2: string }[];
}

const DESIGN_SELECTOR_PATHS = [
	'm4 9l8-2l5 5l-2 8l-13 2z',
	'M14.5 2L12 7l5 5l5-2.5zM8 13l3 3m-9 6l7.5-7.5',
] as const;

/** Official Aria / Lucide path data. */
const ARIA_ICONS = {
	star: {
		paths: ['M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z'],
	},
	smartphone: {
		rects: [{ x: '6', y: '2', width: '12', height: '20', rx: '2.5' }],
		paths: ['M11 18.5h2'],
	},
	terminal: {
		paths: ['m4 17 6-6-6-6', 'M12 19h8'],
	},
	pictureInPicture: {
		paths: ['M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4'],
		rects: [{ x: '12', y: '13', width: '10', height: '7', rx: '1.5' }],
	},
	search: {
		circles: [{ cx: '11', cy: '11', r: '7.5' }],
		paths: ['m20.5 20.5-4.2-4.2'],
	},
	globe: {
		circles: [{ cx: '12', cy: '12', r: '9.5' }],
		paths: ['M12 2.5a14 14 0 0 0 0 19 14 14 0 0 0 0-19', 'M2.5 12h19'],
	},
	ellipsis: {
		circles: [
			{ cx: '12', cy: '12', r: '1' },
			{ cx: '19', cy: '12', r: '1' },
			{ cx: '5', cy: '12', r: '1' },
		],
	},
	x: {
		size: 10,
		paths: ['M18 6 6 18', 'm6 6 12 12'],
	},
} as const satisfies Record<string, IAriaIconSpec>;

function createAriaIcon(spec: IAriaIconSpec, extraClass?: string): HTMLElement {
	const el = extraClass ? $(`span.volt-browser-icon.${extraClass}`) : $('span.volt-browser-icon');
	const size = String(spec.size ?? 16);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', size);
	svg.setAttribute('height', size);
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of spec.paths ?? []) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	for (const item of spec.rects ?? []) {
		const rect = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', item.x);
		rect.setAttribute('y', item.y);
		rect.setAttribute('width', item.width);
		rect.setAttribute('height', item.height);
		if (item.rx) {
			rect.setAttribute('rx', item.rx);
		}
		svg.appendChild(rect);
	}
	for (const item of spec.circles ?? []) {
		const circle = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('cx', item.cx);
		circle.setAttribute('cy', item.cy);
		circle.setAttribute('r', item.r);
		svg.appendChild(circle);
	}
	for (const item of spec.lines ?? []) {
		const line = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', item.x1);
		line.setAttribute('y1', item.y1);
		line.setAttribute('x2', item.x2);
		line.setAttribute('y2', item.y2);
		svg.appendChild(line);
	}
	el.appendChild(svg);
	return el;
}

function createDesignSelectorIcon(): HTMLElement {
	const el = $('span.volt-browser-icon.design-selector');
	const doc = el.ownerDocument;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('aria-hidden', 'true');
	const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
	group.setAttribute('fill', 'none');
	group.setAttribute('stroke', 'currentColor');
	group.setAttribute('stroke-linecap', 'round');
	group.setAttribute('stroke-linejoin', 'round');
	group.setAttribute('stroke-width', '1');
	for (const d of DESIGN_SELECTOR_PATHS) {
		const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		group.appendChild(path);
	}
	svg.appendChild(group);
	el.appendChild(svg);
	return el;
}

function createPointerIcon(): HTMLElement {
	const el = $('span.volt-browser-take-control-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M3.5 2.5l9 4.2-3.9 1.2-1.3 3.9z');
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.3');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createDotsIcon(): HTMLElement { return createAriaIcon(ARIA_ICONS.ellipsis); }
function createCloseIcon(): HTMLElement { return createAriaIcon(ARIA_ICONS.x, 'close'); }

/** A page's icon, or a globe while it has none (or it fails to load). */
function faviconElement(favicon: string | undefined): HTMLElement {
	if (!favicon) {
		return createAriaIcon(ARIA_ICONS.globe, 'favicon');
	}
	const holder = $('span.volt-browser-icon.favicon');
	const image = append(holder, $('img')) as HTMLImageElement;
	image.alt = '';
	image.referrerPolicy = 'no-referrer';
	image.src = favicon;
	image.addEventListener('error', () => holder.replaceWith(createAriaIcon(ARIA_ICONS.globe, 'favicon')), { once: true });
	return holder;
}
