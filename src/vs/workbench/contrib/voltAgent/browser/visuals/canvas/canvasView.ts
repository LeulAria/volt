/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../media/agentCanvas.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { Checkbox } from '../../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { defaultCheckboxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../webview/browser/webview.js';
import { createVoltButton } from '../../chrome/voltButton.js';
import { dispatchPageChannel, IPageChannelPort, parsePageRequest } from '../agentVisualBridge.js';
import { buildVisualPage } from '../agentVisualPage.js';
import { themeKind, visualThemeCss } from '../agentVisuals.js';
import type { CanvasFrameKind, ICanvasAnchor, ICanvasComment, ICanvasDoc, ICanvasFrame } from './canvasModel.js';
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

//#region Comments list

interface ICommentRow {
	readonly comment: ICanvasComment;
	readonly number: number;
	readonly where: string;
}

class CommentRowDelegate implements IListVirtualDelegate<ICommentRow> {
	getHeight(row: ICommentRow): number {
		return 52 + (row.comment.reply ? 18 : 0);
	}
	getTemplateId(): string {
		return 'comment';
	}
	hasDynamicHeight(): boolean {
		return true;
	}
}

interface ICommentTemplate {
	readonly pin: HTMLElement;
	readonly where: HTMLElement;
	readonly text: HTMLElement;
	readonly reply: HTMLElement;
}

class CommentRenderer implements IListRenderer<ICommentRow, ICommentTemplate> {
	readonly templateId = 'comment';
	renderTemplate(container: HTMLElement): ICommentTemplate {
		const row = append(container, $('.volt-canvas-comment-row'));
		const pin = append(row, $('span.volt-canvas-comment-pin'));
		const body = append(row, $('.volt-canvas-comment-body'));
		return {
			pin,
			where: append(body, $('.volt-canvas-comment-where')),
			text: append(body, $('.volt-canvas-comment-text')),
			reply: append(body, $('.volt-canvas-comment-reply')),
		};
	}
	renderElement(row: ICommentRow, _index: number, template: ICommentTemplate): void {
		const { comment } = row;
		template.pin.className = `volt-canvas-comment-pin ${comment.author === 'agent' ? 'agent' : comment.status}`;
		if (comment.author === 'agent') {
			template.pin.replaceChildren(renderIcon(Codicon.sparkle));
		} else if (comment.status === 'resolved') {
			template.pin.replaceChildren(renderIcon(Codicon.check));
		} else {
			template.pin.textContent = String(row.number);
		}
		template.where.textContent = row.where;
		template.text.textContent = comment.text || (comment.tweaks ?? []).map(tweak => `${tweak.property}: ${tweak.value}`).join(', ');
		template.reply.textContent = comment.reply ?? '';
		template.reply.hidden = !comment.reply;
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
	private readonly comments: WorkbenchList<ICommentRow>;
	private readonly framesCount: HTMLElement;
	private readonly commentsCount: HTMLElement;
	private readonly commentsEmpty: HTMLElement;
	private readonly showResolved: Checkbox;
	private readonly commentsFoot: HTMLElement;
	private readonly sendButton: ReturnType<typeof createVoltButton>;
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
		const commentsHead = append(this.commentsPane, $('.volt-canvas-pane-head'));
		append(commentsHead, $('span.volt-canvas-pane-title')).textContent = this.strings.comments;
		this.commentsCount = append(commentsHead, $('span.volt-canvas-pane-count'));
		append(commentsHead, $('span.volt-canvas-pane-grow'));
		const resolvedToggle = append(commentsHead, $('.volt-canvas-pane-check'));
		this.showResolved = this._register(new Checkbox(this.strings.showResolved, false, defaultCheckboxStyles));
		resolvedToggle.appendChild(this.showResolved.domNode);
		const resolvedLabel = append(resolvedToggle, $('span.volt-canvas-pane-check-label'));
		resolvedLabel.textContent = this.strings.showResolved;
		this._register(addDisposableListener(resolvedLabel, 'click', () => {
			this.showResolved.checked = !this.showResolved.checked;
			this.renderComments();
		}));
		this._register(this.showResolved.onChange(() => this.renderComments()));
		const commentsBody = append(this.commentsPane, $('.volt-canvas-pane-body'));
		this.commentsEmpty = append(commentsBody, $('.volt-canvas-pane-empty'));
		this.commentsEmpty.textContent = this.strings.noComments;
		this.comments = this._register(instantiationService.createInstance(
			WorkbenchList<ICommentRow>,
			'VoltCanvasComments',
			commentsBody,
			new CommentRowDelegate(),
			[new CommentRenderer()],
			{
				identityProvider: { getId: row => row.comment.id },
				accessibilityProvider: {
					getAriaLabel: row => `${row.where}: ${row.comment.text}${row.comment.reply ? `. ${row.comment.reply}` : ''}`,
					getWidgetAriaLabel: () => this.strings.comments,
				},
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
				supportDynamicHeights: true,
			},
		));
		this._register(this.comments.onDidChangeContentHeight(() => this.layoutLists()));
		this._register(this.comments.onDidOpen(event => {
			if (event.element) {
				this.post({ op: 'comment', comment: event.element.comment.id });
			}
		}));
		this.commentsFoot = append(this.commentsPane, $('.volt-canvas-pane-foot'));
		this.sendButton = this._register(createVoltButton(this.commentsFoot, 'primary'));
		this._register(this.sendButton.onDidClick(() => this.sendAll()));
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
		observer.observe(commentsBody);
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
			case 'thread': {
				const index = this.commentRows().findIndex(row => row.comment.id === message.comment);
				if (index >= 0) {
					this.comments.setFocus([index]);
					this.comments.setSelection([index]);
					this.comments.reveal(index);
				}
				return;
			}
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

	private commentRows(): ICommentRow[] {
		const doc = this.doc;
		if (!doc) {
			return [];
		}
		const show = this.showResolved.checked;
		return doc.comments
			.filter(comment => doc.frames.some(frame => frame.id === comment.anchor.frame) && (show || comment.status !== 'resolved'))
			.map(comment => ({ comment, number: doc.comments.indexOf(comment) + 1, where: this.anchorLabel(doc, comment.anchor) }));
	}

	private anchorLabel(doc: ICanvasDoc, anchor: ICanvasAnchor): string {
		const frame = doc.frames.find(other => other.id === anchor.frame)?.name ?? anchor.frame;
		const what = anchor.element ?? (anchor.w && anchor.h ? this.strings.region.replace('{0}', `${Math.round(anchor.w)}×${Math.round(anchor.h)}`) : undefined);
		return what ? `${frame} \u203A ${what}` : frame;
	}

	private renderComments(): void {
		const rows = this.commentRows();
		const doc = this.doc;
		this.commentsCount.textContent = String(doc?.comments.filter(comment => comment.status !== 'resolved').length ?? 0);
		this.comments.splice(0, this.comments.length, rows);
		this.commentsEmpty.hidden = rows.length > 0;
		const ready = this.readyComments().length;
		this.sendButton.label = this.strings.sendAll.replace('{0}', String(ready));
		this.sendButton.enabled = ready > 0;
		this.commentsFoot.hidden = !ready;
		this.post({ op: 'resolved', show: this.showResolved.checked });
		this.layoutLists();
	}

	private readyComments(): ICanvasComment[] {
		return this.doc?.comments.filter(comment => comment.status === 'open' && comment.author === 'user') ?? [];
	}

	private sendAll(): void {
		const ready = this.readyComments();
		const doc = this.doc;
		if (!ready.length || !doc || !this.port) {
			return;
		}
		this.canvas.handle(this.port, { op: 'send', id: doc.id, comments: ready.map(comment => comment.id) });
	}

	private layoutLists(): void {
		const framesBody = this.frames.getHTMLElement().parentElement;
		if (!this.framesPane.hidden && framesBody) {
			this.frames.layout(framesBody.clientHeight, framesBody.clientWidth);
		}
		const commentsBody = this.comments.getHTMLElement().parentElement;
		if (!this.commentsPane.hidden && commentsBody) {
			// The comments take what they need, up to a third of the pane; the agent gets the rest.
			const height = this.comments.length ? Math.min(this.comments.contentHeight, Math.round(this.commentsPane.clientHeight * 0.34)) : 64;
			if (commentsBody.style.height !== `${height}px`) {
				commentsBody.style.height = `${height}px`;
			}
			this.comments.layout(height, commentsBody.clientWidth);
		}
	}
}

/** Clears `container` and shows the canvas's "no longer stored" line in it. */
export function renderCanvasMissing(container: HTMLElement): void {
	clearNode(container);
	append(container, $('.volt-canvas-editor-empty')).textContent = localize('voltCanvas.missing', "This canvas is no longer stored.");
}
