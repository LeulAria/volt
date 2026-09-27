/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/browserEditor.css';
import { $, addDisposableListener, append, Dimension, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../../base/common/actions.js';
import { timeout } from '../../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentMention, browserMentionColor, cloneDisplayMentions } from '../composer/agentMentions.js';
import { BrowserCommentCard } from './browserCommentCard.js';
import { BrowserAgentComposer } from './browserComposer.js';
import { commentPreviewText } from './browserComments.js';
import { OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from '../editor/agentEditorInput.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from '../chrome/agentTooltip.js';
import { BrowserAgentDock } from './browserDock.js';
import { DEFAULT_BROWSER_URL, VoltBrowserEditorInput } from './browserEditorInput.js';
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
	loadURL?(url: string): void;
	capturePage?(): Promise<IVoltNativeImage>;
	executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
	setUserAgent?(userAgent: string): void;
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
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
		return sanitizeBrowserUrl(trimmed) ?? trimmed.split(/[\s\]>]/)[0] ?? trimmed;
	}
	if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
		return `http://${trimmed.split(/[\s\]>]/)[0]}`;
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
	private urlInput!: HTMLInputElement;
	private designButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
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
	private guestIdle = false;
	private pendingUrl: string | undefined;
	private designMode = false;
	private hoverHit: IBrowserHit | undefined;
	private selection: IBrowserSelection | undefined;
	private readonly marks = new Map<string, { box: HTMLElement; accent: number; bounds: { x: number; y: number; w: number; h: number } }>();
	private drawing: { startX: number; startY: number; currentX: number; currentY: number } | undefined;
	private probeHandle: number | undefined;
	private lastProbe = '';

	constructor(
		private readonly input: VoltBrowserEditorInput,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this.element = $('.volt-browser-view.parked');
		this._register(addDisposableListener(this.element, 'pointerdown', () => this._onDidFocus.fire(), true));
		this._register(addDisposableListener(this.element, 'focusin', () => this._onDidFocus.fire()));
		try {
			this.createBrowserChrome(this.element);
		} catch (err) {
			this.container ??= append(this.element, $('.volt-browser-editor'));
			this.errorEl ??= append(this.container, $('.volt-browser-error'));
			this.errorEl.classList.remove('hidden');
			this.errorEl.textContent = err instanceof Error ? err.message : String(err);
			return;
		}
		try {
			// The webview starts loading once `show` puts the view in the DOM.
			this.navigate(input.url || DEFAULT_BROWSER_URL);
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
		this.navButton(toolbar, Codicon.refresh, localize('voltBrowser.reload', "Reload"), () => this.callGuest(() => this.webview?.reload()));

		this.urlInput = append(toolbar, $('input.volt-browser-url')) as HTMLInputElement;
		this.urlInput.type = 'text';
		this.urlInput.spellcheck = false;
		this.urlInput.placeholder = DEFAULT_BROWSER_URL;

		const actions = append(toolbar, $('.volt-browser-actions'));
		this.designButton = this.actionButton(actions, 'design', localize('voltBrowser.design', "Design"), () => this.setDesignMode(!this.designMode));
		setAgentTooltip(this.designButton, localize('voltBrowser.designMode', "Design Mode"), formatAgentTooltipShortcut({ meta: true, shift: true, key: 'D' }));
		this.actionButton(actions, 'clear', localize('voltBrowser.clearSelection', "Clear selection"), () => this.clearSelection(true))
			.appendChild(createMinusIcon());
		this.moreButton = this.actionButton(actions, 'more', localize('voltBrowser.more', "More"), () => this.showMoreMenu());
		this.moreButton.appendChild(createDotsIcon());

		this.stage = append(this.container, $('.volt-browser-stage'));
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
		this.dock = this._register(this.instantiationService.createInstance(BrowserAgentDock));
		append(this.container, this.dock.element);

		this._register(addDisposableListener(this.urlInput, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.navigate(this.urlInput.value);
				return;
			}
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyL)) {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand(OPEN_AGENT_SIDE_PANEL_COMMAND_ID);
			}
		}));
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
	}

	private navButton(parent: HTMLElement, icon: typeof Codicon.arrowLeft, title: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-browser-nav')) as HTMLButtonElement;
		setAgentTooltip(button, title);
		button.appendChild(renderIcon(icon));
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
		webview.setAttribute('partition', 'persist:volt-browser');
		webview.setAttribute('webpreferences', 'allowRunningInsecureContent, javascript=yes');
		webview.setAttribute('useragent', BROWSER_USER_AGENT);
		webview.setAttribute('src', 'about:blank');

		const on = (type: string, listener: (e: Event) => void) => {
			this.webviewListeners.add(addDisposableListener(webview, type, listener));
		};
		on('dom-ready', () => {
			const firstReady = !this.guestReady;
			this.guestReady = true;
			this.syncNavButtons();
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
		});
		on('did-navigate', e => this.syncFromGuest((e as Event & { url?: string }).url));
		on('did-navigate-in-page', e => this.syncFromGuest((e as Event & { url?: string }).url));
		on('page-title-updated', e => {
			const title = (e as Event & { title?: string }).title;
			if (title) {
				this.browserInput()?.setTitle(title);
			}
		});
		on('did-stop-loading', () => {
			this.guestIdle = true;
			this.syncFromGuest();
		});
		on('did-fail-load', e => {
			const fail = e as Event & { isMainFrame?: boolean; errorCode?: number; errorDescription?: string };
			if (fail.isMainFrame === false || fail.errorCode === -3) {
				return;
			}
			this.showError(fail.errorDescription || localize('voltBrowser.loadFailed', "This page could not be loaded."));
			this.syncNavButtons();
		});
		on('did-finish-load', () => {
			this.guestIdle = true;
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
		this.urlInput.value = displayBrowserUrl(url);
		this.hideError();
		this.closeDraft();
		this.clearComments();
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
			this.urlInput.value = displayBrowserUrl(clean);
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
		const url = this.urlInput.value || DEFAULT_BROWSER_URL;
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.moreButton,
			getActions: () => [
				toAction({ id: 'volt.browser.reload', label: localize('voltBrowser.reload', "Reload"), run: () => this.callGuest(() => this.webview?.reload()) }),
				toAction({
					id: 'volt.browser.copyUrl',
					label: localize('voltBrowser.copyUrl', "Copy URL"),
					run: () => this.clipboardService.writeText(url),
				}),
				toAction({
					id: 'volt.browser.openExternal',
					label: localize('voltBrowser.openExternal', "Open in System Browser"),
					run: () => this.openerService.open(URI.parse(url), { openExternal: true }),
				}),
				toAction({
					id: 'volt.browser.new',
					label: localize('voltBrowser.new', "New Browser"),
					run: async () => {
						const next = this.instantiationService.createInstance(VoltBrowserEditorInput, VoltBrowserEditorInput.getNewEditorUri());
						await this.editorService.openEditor(next, { pinned: true }, this.editorGroupsService.mainPart.activeGroup);
					},
				}),
			],
		});
	}

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

	private layout(): void {
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
	squareMinus: {
		rects: [{ x: '3', y: '3', width: '18', height: '18', rx: '2' }],
		paths: ['M8 12h8'],
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

function createMinusIcon(): HTMLElement { return createAriaIcon(ARIA_ICONS.squareMinus); }
function createDotsIcon(): HTMLElement { return createAriaIcon(ARIA_ICONS.ellipsis); }
function createCloseIcon(): HTMLElement { return createAriaIcon(ARIA_ICONS.x, 'close'); }
