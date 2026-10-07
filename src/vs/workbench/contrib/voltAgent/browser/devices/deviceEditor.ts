/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { DevicePreview } from './devicePreview.js';

export const DEVICE_EDITOR_ID = 'workbench.editor.voltDevicePreview';
export const DEVICE_PREVIEW_SCHEME = 'volt-device-preview';

/** The device preview tab. One per window: it switches devices in place. */
export class DevicePreviewEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.voltDevicePreview';

	readonly resource = URI.from({ scheme: DEVICE_PREVIEW_SCHEME, path: '/devices' });
	private title: string | undefined;

	constructor(public deviceKey: string | undefined) {
		super();
	}

	override get typeId(): string {
		return DevicePreviewEditorInput.TypeID;
	}

	override get editorId(): string {
		return DEVICE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return this.title ?? localize('voltDevices.tab', "Devices");
	}

	setTitle(title: string): void {
		if (title !== this.title) {
			this.title = title;
			this._onDidChangeLabel.fire();
		}
	}

	override getIcon(): ThemeIcon {
		return Codicon.deviceMobile;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DevicePreviewEditorInput;
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: DEVICE_EDITOR_ID } };
	}
}

export class DevicePreviewEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}

	serialize(input: DevicePreviewEditorInput): string {
		return JSON.stringify({ deviceKey: input.deviceKey });
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): DevicePreviewEditorInput {
		try {
			const parsed = JSON.parse(raw) as { deviceKey?: unknown };
			return new DevicePreviewEditorInput(typeof parsed.deviceKey === 'string' ? parsed.deviceKey : undefined);
		} catch {
			return new DevicePreviewEditorInput(undefined);
		}
	}
}

export class DevicePreviewEditor extends EditorPane {

	private container: HTMLElement | undefined;
	private readonly preview = this._register(new MutableDisposable<DevicePreview>());
	private readonly _onDidChangeSize = this._register(new Emitter<void>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(DEVICE_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = parent;
		parent.classList.add('volt-device-editor');
		parent.style.position = 'relative';
	}

	override async setInput(input: DevicePreviewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.container || token.isCancellationRequested) {
			return;
		}
		const preview = this.instantiationService.createInstance(DevicePreview, this.container, input.deviceKey);
		this.preview.value = preview;
		preview.onDidChangeTitle(title => {
			input.setTitle(title);
			input.deviceKey = preview.deviceKey;
		});
		preview.setVisible(this.isVisible());
	}

	override clearInput(): void {
		this.preview.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.preview.value?.setVisible(visible);
	}

	override focus(): void {
		super.focus();
		this.preview.value?.focus();
	}

	override layout(_dimension: Dimension): void {
		this.preview.value?.layout();
		this._onDidChangeSize.fire();
	}
}
