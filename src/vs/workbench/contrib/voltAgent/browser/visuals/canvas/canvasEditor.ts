/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { CanvasView, renderCanvasMissing } from './canvasView.js';

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

export class CanvasEditor extends EditorPane {

	private container: HTMLElement | undefined;
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private view: CanvasView | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
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
		container.replaceChildren();
		const focus = input.focusFrame;
		input.focusFrame = undefined;
		const store = new DisposableStore();
		this.session.value = store;
		const view = store.add(this.instantiationService.createInstance(CanvasView, container, { canvasId: input.canvasId, focusFrame: focus, onTitle: title => input.setTitle(title), island: true }));
		this.view = view;
		view.element.classList.add('volt-canvas-editor-host');
		view.setVisible(this.isVisible());
		store.add(toDisposable(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		}));
		store.add(input.onDidRequestFocus(frame => view.focusFrame(frame)));
		if (!await view.load() && this.session.value === store) {
			this.session.clear();
			renderCanvasMissing(container);
		}
	}

	override clearInput(): void {
		this.session.clear();
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.view?.focus();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.view?.setVisible(visible);
	}

	override layout(_dimension: Dimension): void {
		// The view fills the tab and lays itself out.
	}
}
