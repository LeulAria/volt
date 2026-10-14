/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltCaptureService, VOLT_CAPTURE_CHANNEL_NAME } from '../../../../platform/voltCapture/common/voltCapture.js';
import { IVoltDevicesService, VOLT_DEVICES_CHANNEL_NAME } from '../../../../platform/voltDevices/common/voltDevices.js';
import { IVoltSpeechService, VOLT_SPEECH_CHANNEL_NAME } from '../../../../platform/voltSpeech/common/voltSpeech.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { DEVICE_REMOTE_HOSTS_SETTING } from '../common/agentDevices.js';
import { AgentDevicesService, IAgentDevicesService } from '../browser/devices/agentDevicesService.js';
import { DEVICE_EDITOR_ID, DevicePreviewEditor, DevicePreviewEditorInput, DevicePreviewEditorInputSerializer } from '../browser/devices/deviceEditor.js';
import { startAgentChat } from '../browser/workspace/agentPanels.js';
import { agentToolsSessionOnScreen, openInAgentTools } from '../browser/workspace/agentSurfaceHost.js';
import { IAgentWorkspaceService } from '../browser/workspace/agentWorkspace.js';
import '../browser/preview/browserCookieImport.js';
import '../browser/workspace/agentWorkspaceContext.js';
import './voltWindowCapture.js';

registerMainProcessRemoteService(IVoltDevicesService, VOLT_DEVICES_CHANNEL_NAME);
registerMainProcessRemoteService(IVoltCaptureService, VOLT_CAPTURE_CHANNEL_NAME);
registerMainProcessRemoteService(IVoltSpeechService, VOLT_SPEECH_CHANNEL_NAME);
registerSingleton(IAgentDevicesService, AgentDevicesService, InstantiationType.Delayed);

export const OPEN_DEVICE_PREVIEW_COMMAND_ID = 'volt.devices.openPreview';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.devices',
	title: localize('voltDevices.configTitle', "Volt Devices"),
	type: 'object',
	properties: {
		[DEVICE_REMOTE_HOSTS_SETTING]: {
			type: 'array',
			default: [],
			markdownDescription: localize('voltDevices.remoteHosts', "Other machines whose iOS simulators and Android emulators Volt (and its agents) can use, reached with `ssh` using keys (no passwords). Each needs Xcode and/or the Android SDK. Example: `[{ \"name\": \"Mac mini\", \"host\": \"me@mac-mini.local\" }]`."),
			items: {
				type: 'object',
				properties: {
					name: { type: 'string', description: localize('voltDevices.host.name', "Name shown in Volt.") },
					host: { type: 'string', description: localize('voltDevices.host.host', "host, user@host or user@host:port") },
					user: { type: 'string' },
					port: { type: 'number' },
					identityFile: { type: 'string', description: localize('voltDevices.host.identity', "Private key file (ssh -i).") },
					androidSdk: { type: 'string', description: localize('voltDevices.host.sdk', "Android SDK folder on that machine, if not ~/Library/Android/sdk or on its PATH.") },
				},
				required: ['host'],
			},
		},
	},
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DevicePreviewEditor, DEVICE_EDITOR_ID, localize('voltDevices.editorLabel', "Devices")),
	[new SyncDescriptor(DevicePreviewEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DevicePreviewEditorInput.TypeID, DevicePreviewEditorInputSerializer);

/**
 * Opens the device preview as a tab in the right panel beside a chat. In the agent window it never
 * takes the middle, which always shows the agent: with no chat on screen it opens the unsent draft
 * chat (or a new one) first. In the IDE layout it is a normal editor tab.
 */
async function openDevicePreview(accessor: ServicesAccessor, input: DevicePreviewEditorInput): Promise<boolean> {
	const opened = openInAgentTools(input, agentToolsSessionOnScreen());
	if (opened) {
		await opened;
		return true;
	}
	if (getLayoutMode(accessor.get(IWorkbenchLayoutService)) !== 'agent') {
		return false;
	}
	await startAgentChat(
		accessor.get(IVoltSessionContextService),
		accessor.get(IAgentWorkspaceService),
		accessor.get(IAgentHistoryService),
		accessor.get(IEditorGroupsService),
		accessor.get(IInstantiationService),
		{ kind: 'active' },
	);
	// The chat's panel can take tabs once it is laid out on screen.
	for (let attempt = 0; attempt < 40; attempt++) {
		const later = openInAgentTools(input, agentToolsSessionOnScreen());
		if (later) {
			await later;
			return true;
		}
		await timeout(25);
	}
	return false;
}

/**
 * Creates the devices service at startup, so agents have the device_* tools from their first turn,
 * and moves a device preview that lands in the middle of the agent window (restored, or opened
 * from elsewhere) into the right panel.
 */
class VoltDevicesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltDevices';

	private moving = false;

	constructor(
		@IAgentDevicesService devices: IAgentDevicesService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		void devices;
		this._register(this.editorService.onDidEditorsChange(() => void this.moveOutOfMiddle()));
		this._register(onDidChangeLayoutMode(() => void this.moveOutOfMiddle()));
		void this.moveOutOfMiddle();
	}

	private async moveOutOfMiddle(): Promise<void> {
		if (this.moving || getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		for (const group of this.editorGroupsService.mainPart.groups) {
			const input = group.editors.find((editor): editor is DevicePreviewEditorInput => editor instanceof DevicePreviewEditorInput);
			if (!input) {
				continue;
			}
			this.moving = true;
			try {
				// Opened beside the chat first, so closing it here does not dispose it.
				if (await this.instantiationService.invokeFunction(openDevicePreview, input)) {
					await group.closeEditor(input, { preserveFocus: true });
				}
			} finally {
				this.moving = false;
			}
			return;
		}
	}
}

registerWorkbenchContribution2(VoltDevicesContribution.ID, VoltDevicesContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_DEVICE_PREVIEW_COMMAND_ID, title: localize2('voltDevices.open', "Open Device Preview (iOS Simulator / Android Emulator)"), category: localize2('volt', "Volt"), f1: true });
	}

	async run(accessor: ServicesAccessor, deviceKey?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const existing = editorService.editors.find((editor): editor is DevicePreviewEditorInput => editor instanceof DevicePreviewEditorInput);
		const input = existing ?? new DevicePreviewEditorInput(typeof deviceKey === 'string' ? deviceKey : undefined);
		// Beside the chat in the agent layout; a normal editor tab in the IDE layout.
		if (!await openDevicePreview(accessor, input)) {
			await editorService.openEditor(input, { pinned: true });
		}
	}
});
