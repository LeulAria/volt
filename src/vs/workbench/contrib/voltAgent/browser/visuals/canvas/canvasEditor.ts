/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, getWindow } from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../webview/browser/webview.js';
import { dispatchPageChannel, IPageChannelPort, parsePageRequest } from '../agentVisualBridge.js';
import { buildVisualPage } from '../agentVisualPage.js';
import { themeKind, visualThemeCss } from '../agentVisuals.js';
import { buildCanvasPage } from './canvasPage.js';
import { IVoltCanvasService } from './canvasService.js';

export const CANVAS_EDITOR_ID = 'workbench.editor.voltCanvas';
export const CANVAS_SCHEME = 'volt-canvas';

/** A design canvas as a tab beside the chat: the full editor (frames list, comments, play). */
export class CanvasEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.voltCanvas';

	readonly resource: URI;
	private readonly _onDidRequestFocus = this._register(new Emitter<string>());
	/** A frame to show, asked while the tab is already open. */
	readonly onDidRequestFocus = this._onDidRequestFocus.event;

	constructor(readonly canvasId: string, private title: string | undefined, public focusFrame?: string) {
		super();
		this.resource = URI.from({ scheme: CANVAS_SCHEME, path: `/${canvasId}` });
	}

	override get typeId(): string {
		return CanvasEditorInput.TypeID;
	}

	override get editorId(): string {
		return CANVAS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return this.title ?? localize('voltCanvas.tab', "Canvas");
	}

	override getTitle(): string {
		return localize('voltCanvas.tabTitle', "{0} (Design Canvas)", this.getName());
	}

	override getIcon(): ThemeIcon {
		return Codicon.symbolColor;
	}

	setTitle(title: string): void {
		if (title !== this.title) {
			this.title = title;
			this._onDidChangeLabel.fire();
		}
	}

	requestFocus(frame: string): void {
		this.focusFrame = frame;
		this._onDidRequestFocus.fire(frame);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof CanvasEditorInput && other.canvasId === this.canvasId);
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: CANVAS_EDITOR_ID } };
	}
}

export class CanvasEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}

	serialize(input: CanvasEditorInput): string {
		return JSON.stringify({ canvasId: input.canvasId, title: input.getName() });
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): CanvasEditorInput | undefined {
		try {
			const parsed = JSON.parse(raw) as { canvasId?: unknown; title?: unknown };
			return typeof parsed.canvasId === 'string' ? new CanvasEditorInput(parsed.canvasId, typeof parsed.title === 'string' ? parsed.title : undefined) : undefined;
		} catch {
			return undefined;
		}
	}
}

let panelSeq = 0;

export class CanvasEditor extends EditorPane {

	private container: HTMLElement | undefined;
	private readonly view = this._register(new MutableDisposable<DisposableStore>());
	private webview: IWebviewElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IVoltCanvasService private readonly canvas: IVoltCanvasService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(CANVAS_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = parent;
		parent.classList.add('volt-canvas-editor');
	}

	override async setInput(input: CanvasEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const container = this.container;
		if (!container || token.isCancellationRequested) {
			return;
		}
		const store = new DisposableStore();
		this.view.value = store;
		container.replaceChildren();
		const doc = await this.canvas.get(input.canvasId);
		if (token.isCancellationRequested || this.view.value !== store) {
			return;
		}
		if (!doc) {
			append(container, $('.volt-canvas-editor-empty')).textContent = localize('voltCanvas.missing', "This canvas is no longer stored.");
			return;
		}
		input.setTitle(doc.title);
		store.add(this.canvas.onDidChange(change => {
			if (change.id === input.canvasId) {
				input.setTitle(change.doc.title);
			}
		}));
		const host = append(container, $('.volt-canvas-editor-host'));
		store.add(toDisposable(() => host.remove()));
		const current = store.add(new MutableDisposable<DisposableStore>());
		const mount = async () => {
			const latest = await this.canvas.get(input.canvasId) ?? doc;
			if (store.isDisposed) {
				return;
			}
			const webviewStore = new DisposableStore();
			current.value = webviewStore;
			const webview = webviewStore.add(this.webviewService.createWebviewElement({
				title: latest.title,
				origin: `volt-canvas-${input.canvasId}`,
				options: { enableFindWidget: false, purpose: WebviewContentPurpose.WebviewView, tryRestoreScrollPosition: false, disableServiceWorker: true },
				contentOptions: { allowScripts: true, localResourceRoots: [] },
				extension: undefined,
			}));
			this.webview = webview;
			webviewStore.add(toDisposable(() => {
				if (this.webview === webview) {
					this.webview = undefined;
				}
			}));
			const theme = this.themeService.getColorTheme();
			const page = buildCanvasPage(this.canvas.pageData(latest, 'panel', input.focusFrame));
			input.focusFrame = undefined;
			webview.setHtml(buildVisualPage(page, { themeCss: visualThemeCss(theme), kind: themeKind(theme) }));
			webviewStore.add(this.themeService.onDidColorThemeChange(next => {
				void webview.postMessage({ type: 'volt-theme', css: visualThemeCss(next), kind: themeKind(next) });
			}));
			const port = this.createPort(webview, webviewStore, host, latest.title);
			webviewStore.add(webview.onMessage(event => {
				const request = parsePageRequest(event.message);
				if (request?.kind === 'channel') {
					dispatchPageChannel(port, request.channel, request.payload);
				} else if (request?.kind === 'open') {
					port.open?.(request.href);
				}
			}));
			webviewStore.add(input.onDidRequestFocus(frame => void webview.postMessage({ type: 'volt-canvas', op: 'focus', id: input.canvasId, frame })));
			webview.mountTo(host, getWindow(host));
			// A webview whose iframe left the document (the tab moved to another group) comes back
			// empty: load the canvas again, from the store, so nothing is lost.
			const iframe = host.querySelector('iframe');
			if (iframe) {
				let loaded = false;
				webviewStore.add(addDisposableListener(iframe, 'load', () => {
					if (!iframe.getAttribute('src')) {
						return;
					}
					if (loaded) {
						getWindow(host).setTimeout(() => {
							if (current.value === webviewStore && !store.isDisposed) {
								void mount();
							}
						}, 0);
					}
					loaded = true;
				}));
			}
		};
		await mount();
	}

	/** The tab's port: it has no composer of its own, so the service routes prompts to the chat. */
	private createPort(webview: IWebviewElement, store: DisposableStore, host: HTMLElement, title: string): IPageChannelPort {
		const listeners: (() => void)[] = [];
		store.add(toDisposable(() => {
			for (const listener of listeners.splice(0)) {
				listener();
			}
		}));
		const win = getWindow(host);
		return {
			id: `canvas-tab-${++panelSeq}`,
			title,
			post: message => void webview.postMessage(message),
			focused: () => host.contains(win.document.activeElement),
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

	override clearInput(): void {
		this.view.clear();
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.webview?.focus();
	}

	override layout(_dimension: Dimension): void {
		// The page fills the tab and lays itself out.
	}
}
