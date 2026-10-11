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
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../webview/browser/webview.js';
import { IVoltCommentItem, VoltCommentsPane } from '../../chrome/voltCommentsPane.js';
import { dispatchPageChannel, IPageChannelPort, parsePageRequest } from '../agentVisualBridge.js';
import { buildVisualPage } from '../agentVisualPage.js';
import { themeKind, visualThemeCss } from '../agentVisuals.js';
import type { CanvasFrameKind, ICanvasAnchor, ICanvasDoc, ICanvasFrame } from './canvasModel.js';
import { buildCanvasPage } from './canvasPage.js';
import { attachCanvasAgent } from './canvasAgent.js';
import { canvasStrings, IVoltCanvasService } from './canvasService.js';

export interface ICanvasViewOptions {
	readonly canvasId: string;
	/** The frame to center on first. */
	readonly focusFrame?: string;
	readonly onTitle?: (title: string) => void;
}

let viewSeq = 0;

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
	private readonly commentsPane: HTMLElement;
	private readonly host: HTMLElement;
	private readonly frames: WorkbenchList<FrameRow>;
	private readonly comments: VoltCommentsPane;
	private readonly framesCount: HTMLElement;
	private readonly mounted = this._register(new MutableDisposable<DisposableStore>());
	private readonly strings = canvasStrings();
	private webview: IWebviewElement | undefined;
	private port: IPageChannelPort | undefined;
	private doc: ICanvasDoc | undefined;
	private selected: readonly string[] = [];
	private panesSized = false;

	constructor(
		container: HTMLElement,
		private readonly options: ICanvasViewOptions,
		@IVoltCanvasService private readonly canvas: IVoltCanvasService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IThemeService private readonly themeService: IThemeService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
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

		this.commentsPane = append(this.element, $('.volt-canvas-pane.comments'));
		// The comments fold away under their head, so the agent below can have the whole column.
		this.comments = this._register(instantiationService.createInstance(VoltCommentsPane, this.commentsPane, {
			listId: 'VoltCanvasComments',
			title: this.strings.comments,
			collapsible: true,
			onOpen: id => this.post({ op: 'comment', comment: id }),
			onSend: ids => this.sendComments(ids),
			onSetStatus: (id, status) => this.handle({ op: 'comment', comment: { id, status } }),
			onDelete: id => this.handle({ op: 'comment-delete', comment: id }),
			onArchiveResolved: () => this.handle({ op: 'comments-archive' }),
			onShowResolved: show => this.post({ op: 'resolved', show }),
		}));
		this._register(this.comments.onDidChangeHeight(() => this.layoutLists()));
		// The canvas's own agent: comments and every change asked for here go to it, and its changes
		// land on the canvas as it makes them.
		const agentHead = append(this.commentsPane, $('.volt-canvas-pane-head.agent'));
		append(agentHead, $('span.volt-canvas-pane-title')).textContent = localize('voltCanvas.agentPane', "Agent");
		append(agentHead, $('span.volt-canvas-pane-hint')).textContent = localize('voltCanvas.agentHint', "Changes this canvas");
		const agentSlot = append(this.commentsPane, $('.volt-canvas-agent-slot'));
		this._register(attachCanvasAgent(instantiationService, options.canvasId, agentSlot));

		const observer = new (getWindow(container).ResizeObserver)(() => this.layoutLists());
		observer.observe(this.element);
		observer.observe(framesBody);
		observer.observe(this.commentsPane);
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

	private setDoc(doc: ICanvasDoc): void {
		this.doc = doc;
		this.options.onTitle?.(doc.title);
		this.renderFrames();
		this.renderComments();
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
		webview.setHtml(buildVisualPage(buildCanvasPage(this.canvas.pageData(doc, 'panel', focus)), { themeCss: visualThemeCss(theme), kind: themeKind(theme) }));
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
				this.post({ op: 'resolved', show: this.comments.showResolved });
				return;
			case 'select':
				this.selected = Array.isArray(message.frames) ? message.frames.filter((frame): frame is string => typeof frame === 'string') : [];
				this.syncFrameSelection(true);
				return;
			case 'panes':
				this.framesPane.hidden = message.layers === false;
				this.commentsPane.hidden = message.comments === false;
				this.layoutLists();
				return;
			case 'thread':
				if (typeof message.comment === 'string') {
					this.comments.reveal(message.comment);
				}
				return;
		}
	}

	/** A narrow tab starts with fewer panes, so the board keeps room (the page's buttons bring them back). */
	private sizePanes(): void {
		if (this.panesSized) {
			return;
		}
		this.panesSized = true;
		const width = this.element.clientWidth;
		const layers = width >= 980;
		const comments = width >= 520;
		if (!layers || !comments) {
			this.post({ op: 'panes', layers, comments });
		}
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

	private commentItems(): IVoltCommentItem[] {
		const doc = this.doc;
		if (!doc) {
			return [];
		}
		return doc.comments
			.filter(comment => !comment.archived && doc.frames.some(frame => frame.id === comment.anchor.frame))
			.map(comment => ({
				id: comment.id,
				number: doc.comments.indexOf(comment) + 1,
				where: this.anchorLabel(doc, comment.anchor),
				text: comment.text || (comment.tweaks ?? []).map(tweak => `${tweak.property}: ${tweak.value}`).join(', '),
				reply: comment.reply,
				status: comment.status,
				author: comment.author,
			}));
	}

	private anchorLabel(doc: ICanvasDoc, anchor: ICanvasAnchor): string {
		const frame = doc.frames.find(other => other.id === anchor.frame)?.name ?? anchor.frame;
		const what = anchor.element ?? (anchor.w && anchor.h ? this.strings.region.replace('{0}', `${Math.round(anchor.w)}×${Math.round(anchor.h)}`) : undefined);
		return what ? `${frame} \u203A ${what}` : frame;
	}

	private renderComments(): void {
		this.comments.setItems(this.commentItems());
		this.layoutLists();
	}

	private handle(payload: Record<string, unknown>): void {
		const doc = this.doc;
		if (doc && this.port) {
			this.canvas.handle(this.port, { ...payload, id: doc.id });
		}
	}

	/** The ticked comments as one message to the canvas's agent; they turn "sent". */
	private sendComments(ids: readonly string[]): void {
		this.handle({ op: 'send', comments: ids });
	}

	private layoutLists(): void {
		const framesBody = this.frames.getHTMLElement().parentElement;
		if (!this.framesPane.hidden && framesBody) {
			this.frames.layout(framesBody.clientHeight, framesBody.clientWidth);
		}
		if (!this.commentsPane.hidden) {
			// The comments take what they need, up to a third of the column; the agent gets the rest.
			const height = this.comments.collapsed ? 0 : Math.min(this.comments.contentHeight, Math.round(this.commentsPane.clientHeight * 0.34));
			this.comments.layout(height, this.commentsPane.clientWidth);
		}
	}
}

/** Clears `container` and shows the canvas's "no longer stored" line in it. */
export function renderCanvasMissing(container: HTMLElement): void {
	clearNode(container);
	append(container, $('.volt-canvas-editor-empty')).textContent = localize('voltCanvas.missing', "This canvas is no longer stored.");
}
