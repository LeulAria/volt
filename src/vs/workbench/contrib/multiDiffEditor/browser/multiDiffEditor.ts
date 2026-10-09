/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MultiDiffEditorWidget } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { IResourceLabel, IWorkbenchUIElementFactory } from '../../../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ResourceLabel } from '../../../browser/labels.js';
import { AbstractEditorWithViewState } from '../../../browser/parts/editor/editorWithViewState.js';
import { ICompositeControl } from '../../../common/composite.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IDocumentDiffItemWithMultiDiffEditorItem, MultiDiffEditorInput } from './multiDiffEditorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { MultiDiffEditorViewModel } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { IMultiDiffEditorOptions, IMultiDiffEditorViewState } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IDiffEditor } from '../../../../editor/common/editorCommon.js';
import { Range } from '../../../../editor/common/core/range.js';
import { MultiDiffEditorItem } from './multiDiffSourceResolverService.js';
import { IEditorProgressService } from '../../../../platform/progress/common/progress.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { IDiffEditorOptions } from '../../../../editor/common/config/editorOptions.js';

/**
 * Volt: a host's own look for the multi-diff editors shown inside it. The agent window's tools
 * draw git's multi-file diffs ("Open Changes") like its Changes review.
 */
export interface IMultiDiffEditorLook extends IDisposable {
	/** Options over every file's own. */
	readonly diffEditorOptions: IObservable<IDiffEditorOptions>;
	/** A bar above the files for `input`, or none. */
	createHeader?(input: MultiDiffEditorInput, group: IEditorGroup): IMultiDiffEditorHeader | undefined;
}

/** Volt: a look's bar above the files. Disposing it removes its element. */
export interface IMultiDiffEditorHeader extends IDisposable {
	readonly element: HTMLElement;
	readonly height: number;
}

/** Gives the look for an editor's container, or the current one back if it still applies. */
export type MultiDiffEditorLookProvider = (container: HTMLElement, current: IMultiDiffEditorLook | undefined) => IMultiDiffEditorLook | undefined;

let lookProvider: MultiDiffEditorLookProvider | undefined;

export function setMultiDiffEditorLookProvider(provider: MultiDiffEditorLookProvider): IDisposable {
	lookProvider = provider;
	return toDisposable(() => {
		if (lookProvider === provider) {
			lookProvider = undefined;
		}
	});
}

export class MultiDiffEditor extends AbstractEditorWithViewState<IMultiDiffEditorViewState> {
	static readonly ID = 'multiDiffEditor';

	private _multiDiffEditorWidget: MultiDiffEditorWidget | undefined = undefined;
	private _viewModel: MultiDiffEditorViewModel | undefined;
	private _uiElementFactory: WorkbenchUIElementFactory | undefined;
	private readonly _look = this._register(new MutableDisposable<IMultiDiffEditorLook>());
	private readonly _header = this._register(new MutableDisposable<IMultiDiffEditorHeader>());
	private _headerFor: { input: MultiDiffEditorInput; look: IMultiDiffEditorLook } | undefined;
	/** Volt: holds the widget, below the look's header. */
	private _body: HTMLElement | undefined;
	private _dimension: DOM.Dimension | undefined;

	public get viewModel(): MultiDiffEditorViewModel | undefined {
		return this._viewModel;
	}

	constructor(
		group: IEditorGroup,
		@IInstantiationService instantiationService: InstantiationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorProgressService private editorProgressService: IEditorProgressService,
	) {
		super(
			MultiDiffEditor.ID,
			group,
			'multiDiffEditor',
			telemetryService,
			instantiationService,
			storageService,
			textResourceConfigurationService,
			themeService,
			editorService,
			editorGroupService
		);
	}

	protected createEditor(parent: HTMLElement): void {
		this._uiElementFactory = this.instantiationService.createInstance(WorkbenchUIElementFactory, this);
		this._body = DOM.append(parent, DOM.$('.multiDiffEditorBody'));
		this._multiDiffEditorWidget = this._register(this.instantiationService.createInstance(
			MultiDiffEditorWidget,
			this._body,
			this._uiElementFactory,
		));

		this._register(this._multiDiffEditorWidget.onDidChangeActiveControl(() => {
			this._onDidChangeControl.fire();
		}));
	}

	override async setInput(input: MultiDiffEditorInput, options: IMultiDiffEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._updateLook();
		this._viewModel = await input.getViewModel();
		this._multiDiffEditorWidget!.setViewModel(this._viewModel);

		const viewState = this.loadEditorViewState(input, context);
		if (viewState) {
			this._multiDiffEditorWidget!.setViewState(viewState);
		}
		this._applyOptions(options);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this._updateLook();
		}
	}

	/** Volt: takes on the look of the host the editor shows in, or drops it. */
	private _updateLook(): void {
		const container = this.getContainer();
		const look = container && lookProvider ? lookProvider(container, this._look.value) : undefined;
		if (look !== this._look.value) {
			this._look.value = look;
			this._uiElementFactory?.hostOptions.set(look?.diffEditorOptions, undefined);
		}
		this._updateHeader();
	}

	/** Volt: the look's header for the current input, above the files. */
	private _updateHeader(): void {
		const input = this.input instanceof MultiDiffEditorInput ? this.input : undefined;
		const look = this._look.value;
		if (this._headerFor?.input === input && this._headerFor?.look === look) {
			return;
		}
		this._headerFor = input && look ? { input, look } : undefined;
		const header = input && look?.createHeader?.(input, this.group);
		this._header.value = header;
		if (header && this._body) {
			this._body.before(header.element);
		}
		if (this._dimension) {
			this.layout(this._dimension);
		}
	}

	override setOptions(options: IMultiDiffEditorOptions | undefined): void {
		this._applyOptions(options);
	}

	private _applyOptions(options: IMultiDiffEditorOptions | undefined): void {
		const viewState = options?.viewState;
		if (!viewState || !viewState.revealData) {
			return;
		}
		this._multiDiffEditorWidget?.reveal(viewState.revealData.resource, {
			range: viewState.revealData.range ? Range.lift(viewState.revealData.range) : undefined,
			highlight: true
		});
	}

	override async clearInput(): Promise<void> {
		await super.clearInput();
		this._headerFor = undefined;
		this._header.clear();
		this._multiDiffEditorWidget!.setViewModel(undefined);
	}

	layout(dimension: DOM.Dimension): void {
		this._dimension = dimension;
		const height = Math.max(0, dimension.height - (this._header.value?.height ?? 0));
		this._body!.style.height = `${height}px`;
		this._multiDiffEditorWidget!.layout(new DOM.Dimension(dimension.width, height));
	}

	override getControl(): ICompositeControl | undefined {
		return this._multiDiffEditorWidget!.getActiveControl();
	}

	override focus(): void {
		super.focus();

		this._multiDiffEditorWidget?.getActiveControl()?.focus();
	}

	override hasFocus(): boolean {
		return this._multiDiffEditorWidget?.getActiveControl()?.hasTextFocus() || super.hasFocus();
	}

	protected override computeEditorViewState(resource: URI): IMultiDiffEditorViewState | undefined {
		return this._multiDiffEditorWidget!.getViewState();
	}

	protected override tracksEditorViewState(input: EditorInput): boolean {
		return input instanceof MultiDiffEditorInput;
	}

	protected override toEditorViewStateResource(input: EditorInput): URI | undefined {
		return (input as MultiDiffEditorInput).resource;
	}

	public tryGetCodeEditor(resource: URI): { diffEditor: IDiffEditor; editor: ICodeEditor } | undefined {
		return this._multiDiffEditorWidget!.tryGetCodeEditor(resource);
	}

	public findDocumentDiffItem(resource: URI): MultiDiffEditorItem | undefined {
		const i = this._multiDiffEditorWidget!.findDocumentDiffItem(resource);
		if (!i) { return undefined; }
		const i2 = i as IDocumentDiffItemWithMultiDiffEditorItem;
		return i2.multiDiffEditorItem;
	}

	public async showWhile(promise: Promise<unknown>): Promise<void> {
		return this.editorProgressService.showWhile(promise);
	}
}


class WorkbenchUIElementFactory implements IWorkbenchUIElementFactory {
	/** Volt: the host look's options, while the editor has one. */
	readonly hostOptions = observableValue<IObservable<IDiffEditorOptions> | undefined>(this, undefined);
	readonly diffEditorOptions = derived(this, reader => this.hostOptions.read(reader)?.read(reader));

	constructor(
		/** Volt: the editor the labels sit in, so Open File lands in its group (an agent's tools). */
		private readonly _editor: MultiDiffEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
	) { }

	createResourceLabel(element: HTMLElement): IResourceLabel {
		const label = this._instantiationService.createInstance(ResourceLabel, element, {});
		let currentUri: URI | undefined;
		element.style.cursor = 'pointer';
		element.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (currentUri) {
				void this._commandService.executeCommand('multiDiffEditor.goToFile', currentUri, this._editor);
			}
		});
		return {
			setUri(uri, options = {}) {
				currentUri = uri;
				if (!uri) {
					label.element.clear();
				} else {
					label.element.setFile(uri, { strikethrough: options.strikethrough });
				}
			},
			dispose() {
				label.dispose();
			}
		};
	}
}
