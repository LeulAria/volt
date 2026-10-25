/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../media/agentCanvas.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../webview/browser/webview.js';
import { BATCH_EDITS_STORAGE_KEY, IVoltAnnotationItem, showVoltAnnotationsMenu } from '../../chrome/voltAnnotations.js';
import { IVoltCommentAnchor, IVoltCommentInsets, VoltCommentComposer } from '../../chrome/voltCommentComposer.js';
import { dispatchPageChannel, IPageChannelPort, parsePageRequest } from '../agentVisualBridge.js';
import { buildVisualPage } from '../agentVisualPage.js';
import { themeKind, visualThemeCss } from '../visualTheme.js';
import type { CanvasFrameKind, ICanvasAnchor, ICanvasDoc, ICanvasFrame } from './canvasModel.js';
import { createCanvasChatIsland, ICanvasChatIsland } from './canvasAgent.js';
import { buildCanvasPage } from './canvasPage.js';
import { canvasStrings, IVoltCanvasService } from './canvasService.js';

export interface ICanvasViewOptions {
	readonly canvasId: string;
	/** The frame to center on first. */
	readonly focusFrame?: string;
	readonly onTitle?: (title: string) => void;
	/** The tab: the canvas's chat as an island at the bottom of the board (not in Expand, which sits in the chat). */
	readonly island?: boolean;
}

let viewSeq = 0;

/** The frame list (agentCanvas.css). */
const CANVAS_LAYERS_PANE_WIDTH = 220;

const KIND_ICONS: Record<CanvasFrameKind, ThemeIcon> = {
	iphone: Codicon.deviceMobile,
	android: Codicon.deviceMobile,
	tablet: Codicon.deviceMobile,
	browser: Codicon.browser,
	desktop: Codicon.deviceDesktop,
	watch: Codicon.watch,
	component: Codicon.symbolMisc,
	frame: Codicon.layout,
};

//#region Frames list

type FrameRow = { readonly kind: 'section'; readonly name: string } | { readonly kind: 'frame'; readonly frame: ICanvasFrame };

class FrameRowDelegate implements IListVirtualDelegate<FrameRow> {
	getHeight(row: FrameRow): number {
		return row.kind === 'section' ? 30 : 26;
	}
	getTemplateId(row: FrameRow): string {
		return row.kind;
	}
}

interface ISectionTemplate {
	readonly label: HTMLElement;
}

class SectionRenderer implements IListRenderer<FrameRow, ISectionTemplate> {
	readonly templateId = 'section';
	renderTemplate(container: HTMLElement): ISectionTemplate {
		return { label: append(container, $('.volt-canvas-pane-section')) };
	}
	renderElement(row: FrameRow, _index: number, template: ISectionTemplate): void {
		template.label.textContent = row.kind === 'section' ? row.name : '';
	}
	disposeTemplate(): void { }
}

interface IFrameTemplate {
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly size: HTMLElement;
}

class FrameRenderer implements IListRenderer<FrameRow, IFrameTemplate> {
	readonly templateId = 'frame';
	renderTemplate(container: HTMLElement): IFrameTemplate {
		const row = append(container, $('.volt-canvas-frame-row'));
		return {
			icon: append(row, $('span.volt-canvas-frame-icon')),
			name: append(row, $('span.volt-canvas-frame-name')),
			size: append(row, $('span.volt-canvas-frame-size')),
		};
	}
	renderElement(row: FrameRow, _index: number, template: IFrameTemplate): void {
		if (row.kind !== 'frame') {
			return;
		}
		template.icon.replaceChildren(renderIcon(KIND_ICONS[row.frame.kind] ?? Codicon.layout));
		template.name.textContent = row.frame.name;
		template.size.textContent = `${row.frame.width}×${row.frame.height || 'auto'}`;
	}
	disposeTemplate(): void { }
}

//#endregion

/**
 * A design canvas with room: the page (the board itself, in a webview) between two workbench
 * panes, the frame list and the comments. The tab beside the chat and Expand both show one.
 */
export class CanvasView extends Disposable {

	readonly element: HTMLElement;
	private readonly framesPane: HTMLElement;
	private readonly host: HTMLElement;
	private readonly frames: WorkbenchList<FrameRow>;
	private readonly framesCount: HTMLElement;
	private readonly mounted = this._register(new MutableDisposable<DisposableStore>());
	private readonly strings = canvasStrings();
	private webview: IWebviewElement | undefined;
	private port: IPageChannelPort | undefined;
	private doc: ICanvasDoc | undefined;
	private selected: readonly string[] = [];
	private panesSized = false;
	private readonly island: ICanvasChatIsland | undefined;
	private readonly commentComposer: VoltCommentComposer;
	/** Clear of the page's top bars, and of the chat island at the bottom of the tab. */
	private composeInsets: IVoltCommentInsets = { top: 48, bottom: 12 };

	constructor(
		container: HTMLElement,
		private readonly options: ICanvasViewOptions,
		@IVoltCanvasService private readonly canvas: IVoltCanvasService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IThemeService private readonly themeService: IThemeService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(container, $('.volt-canvas-view'));
		this._register(toDisposable(() => this.element.remove()));

		this.framesPane = append(this.element, $('.volt-canvas-pane.frames'));
		const framesHead = append(this.framesPane, $('.volt-canvas-pane-head'));
		append(framesHead, $('span.volt-canvas-pane-title')).textContent = this.strings.frames;
		this.framesCount = append(framesHead, $('span.volt-canvas-pane-count'));
		const framesBody = append(this.framesPane, $('.volt-canvas-pane-body'));
		this.frames = this._register(instantiationService.createInstance(
			WorkbenchList<FrameRow>,
			'VoltCanvasFrames',
			framesBody,
			new FrameRowDelegate(),
			[new SectionRenderer(), new FrameRenderer()],
			{
				identityProvider: { getId: row => row.kind === 'frame' ? `frame:${row.frame.id}` : `section:${row.name}` },
				accessibilityProvider: {
					getAriaLabel: row => row.kind === 'frame' ? `${row.frame.name}, ${row.frame.width} by ${row.frame.height || 'auto'}` : row.name,
					getWidgetAriaLabel: () => this.strings.frames,
				},
				keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: row => row.kind === 'frame' ? row.frame.name : row.name },
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
			},
		));
		this._register(this.frames.onDidOpen(event => {
			if (event.element?.kind === 'frame') {
				this.post({ op: 'focus', frame: event.element.frame.id });
			}
		}));
		this._register(this.frames.onMouseOver(event => this.post({ op: 'hover', frame: event.element?.kind === 'frame' ? event.element.frame.id : undefined })));
		this._register(this.frames.onMouseOut(() => this.post({ op: 'hover' })));

		this.host = append(this.element, $('.volt-canvas-view-host'));
		// Comments use the browser's comment box, over the page where the user picked (the page posts `compose`).
		this.commentComposer = this._register(instantiationService.createInstance(VoltCommentComposer, this.host, {
			onAdd: text => this.post({ op: 'compose-commit', text, send: false }),
			onSend: text => this.post({ op: 'compose-commit', text, send: true }),
			onClose: () => this.post({ op: 'compose-cancel' }),
			onDelete: () => this.post({ op: 'compose-delete' }),
			insets: () => this.composeInsets,
		}));
		if (options.island) {
			const island = createCanvasChatIsland(instantiationService, this.host, options.canvasId);
			if (island) {
				this.island = this._register(island);
			}
		}

		const observer = new (getWindow(container).ResizeObserver)(() => this.layoutLists());
		observer.observe(this.element);
		observer.observe(framesBody);
		this._register(toDisposable(() => observer.disconnect()));

		this._register(this.canvas.onDidChange(change => {
			if (change.id === this.options.canvasId) {
				this.setDoc(change.doc);
			}
		}));
	}

	/** Loads the canvas; false when it is no longer stored. */
	async load(): Promise<boolean> {
		const doc = await this.canvas.get(this.options.canvasId);
		if (!doc || this._store.isDisposed) {
			return false;
		}
		this.setDoc(doc);
		this.mount(this.options.focusFrame);
		return true;
	}

	focusFrame(frame: string): void {
		this.post({ op: 'focus', frame });
	}

	focus(): void {
		this.webview?.focus();
	}

	/** The tab is on screen (or not): its chat island holds the chat only while it is. */
	setVisible(visible: boolean): void {
		this.island?.setVisible(visible);
	}

	private setDoc(doc: ICanvasDoc): void {
		this.doc = doc;
		this.options.onTitle?.(doc.title);
		this.renderFrames();
	}

	private post(message: Record<string, unknown>): void {
		void this.webview?.postMessage({ type: 'volt-canvas', id: this.options.canvasId, ...message });
	}

	private mount(focus?: string): void {
		const doc = this.doc;
		if (!doc) {
			return;
		}
		const store = new DisposableStore();
		this.mounted.value = store;
		const webview = store.add(this.webviewService.createWebviewElement({
			title: doc.title,
			origin: `volt-canvas-${doc.id}-${++viewSeq}`,
			options: { enableFindWidget: false, purpose: WebviewContentPurpose.WebviewView, tryRestoreScrollPosition: false, disableServiceWorker: true },
			contentOptions: { allowScripts: true, localResourceRoots: [] },
			extension: undefined,
		}));
		this.webview = webview;
		store.add(toDisposable(() => {
			if (this.webview === webview) {
				this.webview = undefined;
				this.port = undefined;
			}
		}));
		const theme = this.themeService.getColorTheme();
		webview.setHtml(buildVisualPage(buildCanvasPage({ ...this.canvas.pageData(doc, 'panel', focus), hostComposer: true }), { themeCss: visualThemeCss(theme), kind: themeKind(theme) }));
		// A page that goes (reloads, remounts) takes its comment draft with it.
		store.add(toDisposable(() => this.commentComposer.hide()));
		store.add(this.themeService.onDidColorThemeChange(next => {
			void webview.postMessage({ type: 'volt-theme', css: visualThemeCss(next), kind: themeKind(next) });
		}));
		const port = this.port = this.createPort(webview, store, doc.title);
		store.add(webview.onMessage(event => {
			const request = parsePageRequest(event.message);
			if (request?.kind === 'channel') {
				if (request.channel === 'canvas') {
					this.onPageMessage(request.payload);
				}
				dispatchPageChannel(port, request.channel, request.payload);
			} else if (request?.kind === 'open') {
				port.open?.(request.href);
			}
		}));
		const win = getWindow(this.host);
		webview.mountTo(this.host, win);
		// A webview whose iframe left the document (the tab moved to another group) comes back empty:
		// load the canvas again, from the store, so nothing is lost.
		const iframe = this.host.querySelector('iframe');
		if (iframe) {
			let loaded = false;
			store.add(addDisposableListener(iframe, 'load', () => {
				if (!iframe.getAttribute('src')) {
					return;
				}
				if (loaded) {
					win.setTimeout(() => {
						if (this.mounted.value === store) {
							this.mount();
						}
					}, 0);
				}
				loaded = true;
			}));
		}
	}

	private createPort(webview: IWebviewElement, store: DisposableStore, title: string): IPageChannelPort {
		const listeners: (() => void)[] = [];
		store.add(toDisposable(() => {
			for (const listener of listeners.splice(0)) {
				listener();
			}
		}));
		const win = getWindow(this.element);
		return {
			id: `canvas-view-${++viewSeq}`,
			title,
			post: message => void webview.postMessage(message),
			focused: () => this.element.contains(win.document.activeElement),
			open: href => void this.openerService.open(URI.parse(href), { openExternal: /^https?:/i.test(href) }),
			copy: text => void this.clipboardService.writeText(text),
			onDispose: listener => {
				if (store.isDisposed) {
					listener();
				} else {
					listeners.push(listener);
				}
			},
		};
	}

	/** What the page tells its panes: the selected frames, the panes shown, the open thread. */
	private onPageMessage(payload: unknown): void {
		if (!payload || typeof payload !== 'object') {
			return;
		}
		const message = payload as { op?: unknown; frames?: unknown; layers?: unknown; comments?: unknown; comment?: unknown };
		switch (message.op) {
			case 'hello':
				this.sizePanes();
				this.post({ op: 'batch', on: this.storageService.getBoolean(BATCH_EDITS_STORAGE_KEY, StorageScope.PROFILE, false) });
				return;
			case 'batch':
				// The same "Batch edits" setting as the browser's design prompt.
				this.storageService.store(BATCH_EDITS_STORAGE_KEY, (message as { on?: unknown }).on === true, StorageScope.PROFILE, StorageTarget.USER);
				return;
			case 'batch-menu':
				this.showBatchMenu((message as { rect?: unknown }).rect);
				return;
			case 'select':
				this.selected = Array.isArray(message.frames) ? message.frames.filter((frame): frame is string => typeof frame === 'string') : [];
				this.syncFrameSelection(true);
				return;
			case 'panes':
				this.framesPane.hidden = message.layers === false;
				this.layoutLists();
				return;
			case 'compose':
				this.showComposer(payload as { rect?: unknown; chip?: unknown; text?: unknown; deletable?: unknown; keep?: unknown; top?: unknown });
				return;
			case 'compose-place': {
				const rect = this.composeRect((payload as { rect?: unknown }).rect);
				if (rect && this.commentComposer.visible) {
					this.commentComposer.place(rect);
				}
				return;
			}
			case 'compose-close':
				this.commentComposer.hide();
				return;
		}
	}

	/**
	 * The page picked something to comment on (or a pin): the comment box opens beside it. `rect` is in
	 * the page's pixels, which are the host's: the webview fills `.volt-canvas-view-host` from its corner.
	 * `keep`: the same draft moved to the element around it; what was typed stays.
	 */
	private showComposer(message: { rect?: unknown; chip?: unknown; text?: unknown; deletable?: unknown; keep?: unknown; top?: unknown }): void {
		const rect = this.composeRect(message.rect);
		if (!rect) {
			return;
		}
		this.composeInsets = {
			top: typeof message.top === 'number' ? message.top : 48,
			// The island's pill (34px and its 12px margin) stays uncovered in the tab.
			bottom: this.island ? 58 : 12,
		};
		const chip = typeof message.chip === 'string' ? message.chip : '';
		const typed = !this.commentComposer.element.classList.contains('composer-empty');
		if (message.keep === true && this.commentComposer.visible && typed) {
			this.commentComposer.place(rect);
			return;
		}
		this.commentComposer.show(rect, chip, {
			...(typeof message.text === 'string' && message.text ? { text: message.text } : {}),
			deletable: message.deletable === true,
		});
	}

	private composeRect(raw: unknown): IVoltCommentAnchor | undefined {
		const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
		if (!r || typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.width !== 'number' || typeof r.height !== 'number') {
			return undefined;
		}
		return { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) };
	}

	/**
	 * Panes open only where the board keeps room for the frames: beside an open chat the tab is
	 * narrow, so the board starts alone and the toolbar's buttons bring the panes back.
	 */
	private sizePanes(): void {
		if (this.panesSized) {
			return;
		}
		this.panesSized = true;
		const width = this.element.clientWidth;
		const layers = width - CANVAS_LAYERS_PANE_WIDTH >= 720;
		this.post({ op: 'panes', layers, comments: false });
	}

	private frameRows(): FrameRow[] {
		const groups = new Map<string, ICanvasFrame[]>();
		for (const frame of this.doc?.frames ?? []) {
			groups.set(frame.section ?? '', [...groups.get(frame.section ?? '') ?? [], frame]);
		}
		const rows: FrameRow[] = [];
		for (const [section, frames] of groups) {
			if (section) {
				rows.push({ kind: 'section', name: section });
			}
			rows.push(...frames.map(frame => ({ kind: 'frame' as const, frame })));
		}
		return rows;
	}

	private renderFrames(): void {
		const rows = this.frameRows();
		this.framesCount.textContent = String(this.doc?.frames.length ?? 0);
		this.frames.splice(0, this.frames.length, rows);
		this.syncFrameSelection(false);
	}

	private syncFrameSelection(reveal: boolean): void {
		const indices: number[] = [];
		for (let index = 0; index < this.frames.length; index++) {
			const row = this.frames.element(index);
			if (row.kind === 'frame' && this.selected.includes(row.frame.id)) {
				indices.push(index);
			}
		}
		this.frames.setSelection(indices);
		if (indices.length) {
			this.frames.setFocus([indices[0]]);
			if (reveal) {
				this.frames.reveal(indices[0]);
			}
		}
	}

	/** The batch: the user's comments waiting for the board's Send, numbered as their pins are. */
	private batchItems(): IVoltAnnotationItem[] {
		const doc = this.doc;
		if (!doc) {
			return [];
		}
		return doc.comments
			.filter(comment => !comment.archived && comment.status === 'open' && comment.author === 'user' && doc.frames.some(frame => frame.id === comment.anchor.frame))
			.map(comment => ({
				id: comment.id,
				number: doc.comments.indexOf(comment) + 1,
				text: comment.text || (comment.tweaks ?? []).map(tweak => `${tweak.property}: ${tweak.value}`).join(', ') || this.anchorLabel(doc, comment.anchor),
			}));
	}

	/** The arrow beside the board's Send: the batch in a Volt menu, under the button (`rect` is in the page). */
	private showBatchMenu(rect: unknown): void {
		const r = rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
		if (!r || typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.w !== 'number' || typeof r.h !== 'number' || !this.batchItems().length) {
			return;
		}
		const host = this.host.getBoundingClientRect();
		const view = this.element.getBoundingClientRect();
		const anchor = append(this.element, $('.volt-canvas-menu-anchor'));
		Object.assign(anchor.style, { left: `${host.left - view.left + r.x}px`, top: `${host.top - view.top + r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
		showVoltAnnotationsMenu(this.contextViewService, {
			anchor,
			items: () => this.batchItems(),
			onOpen: id => this.post({ op: 'comment', comment: id }),
			onRemove: id => this.handle({ op: 'comment-delete', comment: id }),
			onClear: () => {
				for (const item of this.batchItems()) {
					this.handle({ op: 'comment-delete', comment: item.id });
				}
			},
			onHide: () => anchor.remove(),
		});
	}

	private anchorLabel(doc: ICanvasDoc, anchor: ICanvasAnchor): string {
		const frame = doc.frames.find(other => other.id === anchor.frame)?.name ?? anchor.frame;
		const what = anchor.element ?? (anchor.w && anchor.h ? this.strings.region.replace('{0}', `${Math.round(anchor.w)}×${Math.round(anchor.h)}`) : undefined);
		return what ? `${frame} \u203A ${what}` : frame;
	}

	private handle(payload: Record<string, unknown>): void {
		const doc = this.doc;
		if (doc && this.port) {
			this.canvas.handle(this.port, { ...payload, id: doc.id });
		}
	}

	private layoutLists(): void {
		const framesBody = this.frames.getHTMLElement().parentElement;
		if (!this.framesPane.hidden && framesBody) {
			this.frames.layout(framesBody.clientHeight, framesBody.clientWidth);
		}
	}
}

/** Clears `container` and shows the canvas's "no longer stored" line in it. */
export function renderCanvasMissing(container: HTMLElement): void {
	clearNode(container);
	append(container, $('.volt-canvas-editor-empty')).textContent = localize('voltCanvas.missing', "This canvas is no longer stored.");
}
