/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { $, addDisposableListener, append, Dimension, getWindow } from '../../../../base/browser/dom.js';
import { CancellationTokenSource, CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IOverlayWebview, IWebviewElement, IWebviewService, WebviewContentOptions, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { IWebviewViewService, WebviewView } from '../../webviewView/browser/webviewViewService.js';
import { IViewBadge } from '../../../common/views.js';
import { VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import { injectVoltWebviewKit, resolveVoltViewSize } from '../common/voltPluginDesign.js';

/**
 * A plugin view's webview in any element: Volt makes the webview, the extension's
 * `WebviewViewProvider` fills it (VS Code's own path, `MainThreadWebviewsViews`). The webview is
 * owned by the contributing extension (its origin, its local resources), so another extension
 * can't provide for it.
 *
 * An iframe that leaves the document loses its page; when its host loads again the view is
 * resolved afresh, as VS Code does for a view without `retainContextWhenHidden`.
 *
 * Every page it shows gets the Volt kit (Volt's type, spacing, buttons and lists) and its placement
 * (`<html data-volt-placement>`): see `injectVoltWebviewKit`.
 */
export class VoltPluginViewHost extends Disposable {

	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private readonly _onDidChangeTitle = this._register(new Emitter<string | undefined>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;

	constructor(
		private readonly viewId: string,
		private readonly extension: { readonly id: string; readonly location?: URI } | undefined,
		private readonly element: HTMLElement,
		private readonly title: string,
		private readonly placement: VoltViewLocation | undefined,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();
		element.classList.add('volt-plugin-view-host');
		if (placement) {
			element.dataset.voltPlacement = placement;
		}
		this.mount();
	}

	private mount(): void {
		const store = this.current.value = new DisposableStore();
		const cts = store.add(new CancellationTokenSource());
		const webview: IWebviewElement = store.add(this.webviewService.createWebviewElement({
			providedViewType: this.viewId,
			title: this.title,
			origin: undefined,
			options: { purpose: WebviewContentPurpose.WebviewView, tryRestoreScrollPosition: false },
			contentOptions: { allowScripts: true, localResourceRoots: this.extension?.location ? [this.extension.location] : [] },
			extension: this.extension ? { id: new ExtensionIdentifier(this.extension.id), location: this.extension.location } : undefined,
		}));
		const win = getWindow(this.element);
		webview.mountTo(this.element, win);

		const onDidChangeVisibility = store.add(new Emitter<boolean>());
		const onDispose = store.add(new Emitter<void>());
		let title: string | undefined = this.title;
		const view: WebviewView = {
			get title() { return title; },
			set title(value: string | undefined) { title = value; },
			description: undefined,
			badge: undefined as IViewBadge | undefined,
			// The main thread uses it as a plain webview (html, options, messages, state); it also reads
			// `contentOptions`, which only the overlay webview exposes, so this keeps them readable,
			// and every page it sets gets the Volt kit.
			webview: voltPluginWebview(webview, { allowScripts: true, localResourceRoots: this.extension?.location ? [this.extension.location] : [] }, this.placement) as unknown as IOverlayWebview,
			onDidChangeVisibility: onDidChangeVisibility.event,
			onDispose: onDispose.event,
			dispose: () => this.dispose(),
			show: () => this.element.scrollIntoView({ block: 'nearest' }),
		};
		store.add(toDisposable(() => {
			cts.cancel();
			onDispose.fire();
		}));
		void this.resolve(view, cts.token).then(() => {
			if (!cts.token.isCancellationRequested) {
				onDidChangeVisibility.fire(true);
				this._onDidChangeTitle.fire(title);
			}
		});

		// A page lost on a move comes back as a fresh resolve.
		const iframe = this.element.querySelector('iframe');
		if (iframe) {
			let loads = 0;
			store.add(addDisposableListener(iframe, 'load', () => {
				if (++loads > 1) {
					win.setTimeout(() => {
						if (!this._store.isDisposed && this.current.value === store) {
							this.mount();
						}
					}, 0);
				}
			}));
		}
	}

	private async resolve(view: WebviewView, token: CancellationToken): Promise<void> {
		await this.extensionService.activateByEvent(`onView:${this.viewId}`);
		if (!token.isCancellationRequested) {
			await this.webviewViewService.resolve(this.viewId, view, token);
		}
	}
}

/**
 * The webview element with a `contentOptions` getter (it has only the setter), and `setHtml` putting
 * the Volt kit into each page; everything else passes through.
 */
function voltPluginWebview(webview: IWebviewElement, initial: WebviewContentOptions, placement: VoltViewLocation | undefined): IWebviewElement {
	let contentOptions = initial;
	const setHtml = (html: string) => webview.setHtml(injectVoltWebviewKit(html, placement));
	return new Proxy(webview, {
		get(target, property) {
			if (property === 'contentOptions') {
				return contentOptions;
			}
			if (property === 'setHtml') {
				return setHtml;
			}
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set(target, property, value) {
			if (property === 'contentOptions') {
				contentOptions = value;
			}
			return Reflect.set(target, property, value, target);
		},
	});
}

// --- A view as a right panel tab or a page -------------------------------------------------

export const VOLT_PLUGIN_VIEW_EDITOR_ID = 'workbench.editor.voltPluginView';
const VOLT_PLUGIN_VIEW_INPUT_ID = 'workbench.input.voltPluginView';

export interface IVoltPluginViewInfo {
	readonly title: string;
	readonly extensionId: string;
	readonly extensionLocation?: URI;
	/** The size the view asked for (`voltViews[].size`). */
	readonly size?: { readonly width?: number; readonly height?: number };
}

/** A plugin view as an editor: a tab in a chat's right panel, or a page over the chat. */
export class VoltPluginViewInput extends EditorInput {

	static readonly TypeID = VOLT_PLUGIN_VIEW_INPUT_ID;
	static readonly EditorID = VOLT_PLUGIN_VIEW_EDITOR_ID;

	readonly resource: URI;

	constructor(readonly viewId: string, private info: IVoltPluginViewInfo | undefined, readonly asPage: boolean) {
		super();
		this.resource = URI.from({ scheme: 'volt-plugin-view', path: `/${viewId}`, query: asPage ? 'page' : '' });
	}

	get viewInfo(): IVoltPluginViewInfo | undefined {
		return this.info;
	}

	setInfo(info: IVoltPluginViewInfo | undefined): void {
		this.info = info;
		this._onDidChangeLabel.fire();
	}

	override get typeId(): string {
		return VoltPluginViewInput.TypeID;
	}

	override get editorId(): string | undefined {
		return VoltPluginViewInput.EditorID;
	}

	override getName(): string {
		return this.info?.title ?? this.viewId;
	}

	override getIcon(): ThemeIcon {
		return Codicon.extensions;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof VoltPluginViewInput && other.viewId === this.viewId && other.asPage === this.asPage);
	}
}

export class VoltPluginViewInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof VoltPluginViewInput;
	}
	serialize(input: EditorInput): string {
		return input instanceof VoltPluginViewInput ? JSON.stringify({ viewId: input.viewId, asPage: input.asPage }) : '';
	}
	deserialize(_instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const value = JSON.parse(raw) as { viewId?: unknown; asPage?: unknown };
			return typeof value.viewId === 'string' ? new VoltPluginViewInput(value.viewId, undefined, value.asPage === true) : undefined;
		} catch {
			return undefined;
		}
	}
}

/** Resolves a view's title and extension for an input restored before plugins were read. */
export interface IVoltPluginViewLookup {
	(viewId: string): IVoltPluginViewInfo | undefined;
}

let viewLookup: IVoltPluginViewLookup = () => undefined;
export function setVoltPluginViewLookup(lookup: IVoltPluginViewLookup): void {
	viewLookup = lookup;
}

export class VoltPluginViewEditor extends EditorPane {

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private readonly host = this._register(new MutableDisposable<VoltPluginViewHost>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(VOLT_PLUGIN_VIEW_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-plugin-view-editor'));
	}

	override async setInput(input: VoltPluginViewInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.root) {
			return;
		}
		const info = input.viewInfo ?? viewLookup(input.viewId);
		if (info && !input.viewInfo) {
			input.setInfo(info);
		}
		this.root.classList.toggle('is-page', input.asPage);
		this.body?.remove();
		this.body = append(this.root, $('.volt-plugin-view-editor-body'));
		this.host.value = this.instantiationService.createInstance(VoltPluginViewHost, input.viewId, info ? { id: info.extensionId, location: info.extensionLocation } : undefined, this.body, info?.title ?? input.viewId, input.asPage ? 'page' : 'rightPanel');
	}

	override clearInput(): void {
		this.host.clear();
		this.body?.remove();
		this.body = undefined;
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		if (this.root) {
			this.root.style.width = `${dimension.width}px`;
			this.root.style.height = `${dimension.height}px`;
		}
	}
}

// --- A view in a popover under its button --------------------------------------------------

/** A popover with one plugin view, under (or beside) the button that opened it. */
export class VoltPluginPopover extends Disposable {

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;
	readonly element: HTMLElement;
	private readonly size: { readonly width: number; readonly height: number };

	constructor(
		readonly viewId: string,
		info: IVoltPluginViewInfo,
		readonly anchor: HTMLElement | undefined,
		parent: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const win = getWindow(parent);
		const size = resolveVoltViewSize('popover', info.size);
		this.size = { width: size.width ?? 360, height: size.height ?? 420 };
		const element = this.element = append(parent, $('.volt-plugin-popover'));
		const head = append(element, $('.volt-plugin-popover-head'));
		const title = append(head, $('span.volt-plugin-popover-title'));
		title.textContent = info.title;
		const body = append(element, $('.volt-plugin-popover-body'));
		const host = this._register(instantiationService.createInstance(VoltPluginViewHost, viewId, { id: info.extensionId, location: info.extensionLocation }, body, info.title, 'popover'));
		this._register(host.onDidChangeTitle(next => { title.textContent = next || info.title; }));
		this.position(win);
		this._register(addDisposableListener(win, 'resize', () => this.position(win)));
		// Outside clicks and Escape close it; the webview's own clicks stay inside its iframe.
		this._register(addDisposableListener(win.document, 'mousedown', e => {
			const target = e.target as Node | null;
			if (target && !element.contains(target) && !anchor?.contains(target)) {
				this.close();
			}
		}, true));
		this._register(addDisposableListener(win.document, 'keydown', e => {
			if (e.key === 'Escape') {
				this.close();
			}
		}, true));
		this._register(toDisposable(() => element.remove()));
	}

	private position(win: Window): void {
		const width = Math.min(this.size.width, win.innerWidth - 16);
		const height = Math.min(this.size.height, win.innerHeight - 40);
		const rect = this.anchor?.getBoundingClientRect();
		let left = rect ? rect.left + rect.width / 2 - width / 2 : (win.innerWidth - width) / 2;
		left = Math.max(8, Math.min(left, win.innerWidth - width - 8));
		let top = rect ? rect.bottom + 6 : 60;
		if (rect && top + height > win.innerHeight - 8) {
			// No room below (the composer's chips, the footer): above it.
			top = Math.max(8, rect.top - height - 6);
		}
		Object.assign(this.element.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
	}

	close(): void {
		this._onDidClose.fire();
		this.dispose();
	}
}

/**
 * A view's webview in `element`, drawn for `location`. Where the placement sizes it (above the
 * composer, the left sidebar), the element gets the height the view asked for, inside the bounds.
 */
export function voltPluginViewHostFactory(instantiationService: IInstantiationService, viewId: string, info: IVoltPluginViewInfo | undefined, element: HTMLElement, location: VoltViewLocation): IDisposable {
	const { height } = resolveVoltViewSize(location, info?.size);
	if (height !== undefined) {
		element.style.height = `${height}px`;
	}
	return instantiationService.createInstance(VoltPluginViewHost, viewId, info ? { id: info.extensionId, location: info.extensionLocation } : undefined, element, info?.title ?? viewId, location);
}
