/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
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
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { AGENT_TOOLS_VISIBILITY_EVENT } from '../../../../browser/parts/titlebar/layoutModeStartup.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { agentSessionToolTabs, agentToolsSessionOnScreen, closeAgentToolEditor, onDidChangeAgentToolEditors, revealAgentToolEditor, toggleAgentToolsPanel } from '../workspace/agentSurfaceHost.js';
import { IAgentDevicesService } from './agentDevicesService.js';
import { deviceIcon, DevicePreview, devicePreviews, registerDevicePreview } from './devicePreview.js';

export const DEVICE_EDITOR_ID = 'workbench.editor.voltDevicePreview';
export const DEVICE_PREVIEW_SCHEME = 'volt-device-preview';

/** A device preview tab. There can be several, one per device; each switches devices in place. */
export class DevicePreviewEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.input.voltDevicePreview';

	readonly resource: URI;
	private title: string | undefined;

	constructor(public deviceKey: string | undefined, readonly id = generateUuid()) {
		super();
		this.resource = URI.from({ scheme: DEVICE_PREVIEW_SCHEME, path: `/devices/${id}` });
	}

	override get typeId(): string {
		return DevicePreviewEditorInput.TypeID;
	}

	override get editorId(): string {
		return DEVICE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return this.title ?? localize('voltDevices.tab', "Devices");
	}

	get savedTitle(): string | undefined {
		return this.title;
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
		return super.matches(other) || (other instanceof DevicePreviewEditorInput && other.id === this.id);
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
		return JSON.stringify({ deviceKey: input.deviceKey, id: input.id, title: input.savedTitle });
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): DevicePreviewEditorInput {
		try {
			const parsed = JSON.parse(raw) as { deviceKey?: unknown; id?: unknown; title?: unknown };
			const input = new DevicePreviewEditorInput(typeof parsed.deviceKey === 'string' ? parsed.deviceKey : undefined, typeof parsed.id === 'string' ? parsed.id : undefined);
			// A tab behind another shows its device's name before its preview is created.
			if (typeof parsed.title === 'string') {
				input.setTitle(parsed.title);
			}
			return input;
		} catch {
			return new DevicePreviewEditorInput(undefined);
		}
	}
}

/**
 * Shows the device tabs of one group. Each tab keeps its own preview (device, view, screen) while it
 * is open, so switching tabs does not drop the device; only the tab in front streams.
 */
export class DevicePreviewEditor extends EditorPane {

	private container: HTMLElement | undefined;
	private readonly previews = new Map<DevicePreviewEditorInput, { readonly host: HTMLElement; readonly preview: DevicePreview; readonly store: DisposableStore }>();
	private current: DevicePreviewEditorInput | undefined;
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
		this.dropMoved();
		this.show(input);
	}

	private show(input: DevicePreviewEditorInput): void {
		if (this.current && this.current !== input) {
			const previous = this.previews.get(this.current);
			if (previous) {
				previous.preview.setVisible(false);
				previous.host.classList.add('hidden');
			}
		}
		this.current = input;
		const existing = this.previews.get(input);
		if (existing) {
			existing.host.classList.remove('hidden');
			existing.preview.setVisible(this.isVisible());
			existing.preview.layout();
			return;
		}
		const host = append(this.container!, $('.volt-device-editor-tab'));
		const preview = this.instantiationService.createInstance(DevicePreview, host, input.deviceKey);
		const store = new DisposableStore();
		store.add(preview);
		store.add({ dispose: () => host.remove() });
		this.previews.set(input, { host, preview, store });
		// The tab closed for good: its device preview goes with it.
		store.add(input.onWillDispose(() => this.drop(input)));
		store.add(registerDevicePreview(input, preview));
		store.add(preview.onDidChangeTitle(title => {
			input.setTitle(title);
			input.deviceKey = preview.deviceKey;
		}));
		store.add(preview.onDidRequestReveal(() => revealAgentToolEditor(input) || void this.group.openEditor(input)));
		store.add(preview.onDidRequestClose(() => closeAgentToolEditor(input) || void this.group.closeEditor(input)));
		store.add(preview.onDidRequestFloat(float => {
			if (float) {
				// Closing the right panel floats the device over the chat (DeviceFloat).
				toggleAgentToolsPanel();
			} else {
				revealAgentToolEditor(input);
			}
		}));
		preview.setVisible(this.isVisible());
	}

	private drop(input: DevicePreviewEditorInput): void {
		const entry = this.previews.get(input);
		if (!entry) {
			return;
		}
		this.previews.delete(input);
		if (this.current === input) {
			this.current = undefined;
		}
		entry.store.dispose();
	}

	private shownPreview(): DevicePreview | undefined {
		return this.current ? this.previews.get(this.current)?.preview : undefined;
	}

	/** A tab that left this group (moved to another) lets go of its preview here. */
	private dropMoved(): void {
		for (const input of [...this.previews.keys()]) {
			if (!this.group.contains(input)) {
				this.drop(input);
			}
		}
	}

	override clearInput(): void {
		// Another kind of tab came to the front: the device tabs stay open, only hidden.
		this.shownPreview()?.setVisible(false);
		this.dropMoved();
		super.clearInput();
	}

	override dispose(): void {
		for (const input of [...this.previews.keys()]) {
			this.drop(input);
		}
		super.dispose();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.shownPreview()?.setVisible(visible);
	}

	override focus(): void {
		super.focus();
		this.shownPreview()?.focus();
	}

	override layout(_dimension: Dimension): void {
		this.shownPreview()?.layout();
		this._onDidChangeSize.fire();
	}
}

/**
 * The mini device over the chat: while the chat's right panel is closed and it has a device tab
 * with a running device, that device's screen floats in the corner (as T3 Code floats it). Touches
 * and keys go to the device; Expand opens the panel on its tab again.
 */
export class DeviceFloat extends Disposable {

	private element: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private shown: DevicePreview | undefined;
	private shownInput: DevicePreviewEditorInput | undefined;
	/** Closed with its X: it stays away until the panel opens again. */
	private dismissed = false;
	private scheduled = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentDevicesService devices: IAgentDevicesService,
	) {
		super();
		const update = () => this.schedule();
		this._register(onDidChangeAgentToolEditors(update));
		this._register(devices.onDidChangeDevices(update));
		this._register(addDisposableListener(layoutService.mainContainer, AGENT_TOOLS_VISIBILITY_EVENT, update));
		this._register({ dispose: () => this.hide() });
		this.schedule();
	}

	private schedule(): void {
		if (this.scheduled) {
			return;
		}
		this.scheduled = true;
		// After the panel finished opening or closing, and the editors settled.
		setTimeout(() => {
			this.scheduled = false;
			this.update();
		}, 0);
	}

	private update(): void {
		const session = agentToolsSessionOnScreen();
		const tabs = session ? agentSessionToolTabs(session) : undefined;
		if (!tabs || tabs.open) {
			this.dismissed = false;
		}
		let input: DevicePreviewEditorInput | undefined;
		let preview: DevicePreview | undefined;
		if (tabs && !tabs.open && !this.dismissed) {
			// With several device tabs, the one that was in front floats.
			for (const tab of [...tabs.tabs].sort((a, b) => Number(b.focused) - Number(a.focused))) {
				const candidate = tab.input instanceof DevicePreviewEditorInput ? devicePreviews.get(tab.input) : undefined;
				if (candidate?.floatable) {
					input = tab.input as DevicePreviewEditorInput;
					preview = candidate;
					break;
				}
			}
		}
		if (this.shown && this.shown !== preview) {
			this.shown.setFloat(undefined);
			this.shown = undefined;
		}
		if (!preview || !input) {
			this.hide();
			return;
		}
		const body = this.ensure();
		this.shownInput = input;
		if (this.shown !== preview) {
			this.shown = preview;
			preview.setFloat(body);
		}
		this.element!.setAttribute('aria-label', input.getName());
	}

	private ensure(): HTMLElement {
		if (this.element && this.body) {
			return this.body;
		}
		const doc = this.layoutService.mainContainer.ownerDocument;
		const element = append(this.layoutService.mainContainer, $('.volt-device-float'));
		element.tabIndex = 0;
		element.setAttribute('role', 'application');
		const body = append(element, $('.volt-device-float-body'));
		const actions = append(element, $('.volt-device-float-actions'));
		const action = (icon: 'expand' | 'close', label: string, run: () => void) => {
			const button = append(actions, $('button.volt-device-float-action')) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(deviceIcon(doc, icon));
			button.setAttribute('aria-label', label);
			setAgentTooltip(button, label, undefined, undefined, 'above');
			button.addEventListener('click', event => {
				event.stopPropagation();
				run();
			});
		};
		action('expand', localize('voltDevices.floatExpand', "Show in Right Panel"), () => {
			const input = this.shownInput;
			if (input) {
				revealAgentToolEditor(input);
			}
		});
		action('close', localize('voltDevices.floatClose', "Hide Mini Device"), () => {
			this.dismissed = true;
			this.update();
		});
		element.addEventListener('keydown', event => this.shown?.handleKeyDown(event));
		element.addEventListener('pointerdown', () => element.focus({ preventScroll: true }));
		this.element = element;
		this.body = body;
		return body;
	}

	private hide(): void {
		this.shown?.setFloat(undefined);
		this.shown = undefined;
		this.shownInput = undefined;
		this.element?.remove();
		this.element = undefined;
		this.body = undefined;
	}
}
