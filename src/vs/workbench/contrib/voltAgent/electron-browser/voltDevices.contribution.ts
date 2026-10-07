/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltCaptureService, VOLT_CAPTURE_CHANNEL_NAME } from '../../../../platform/voltCapture/common/voltCapture.js';
import { IVoltDevicesService, VOLT_DEVICES_CHANNEL_NAME } from '../../../../platform/voltDevices/common/voltDevices.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { DEVICE_REMOTE_HOSTS_SETTING } from '../common/agentDevices.js';
import { AgentDevicesService, IAgentDevicesService } from '../browser/devices/agentDevicesService.js';
import { DEVICE_EDITOR_ID, DevicePreviewEditor, DevicePreviewEditorInput, DevicePreviewEditorInputSerializer } from '../browser/devices/deviceEditor.js';
import { agentToolsSessionOnScreen, openInAgentTools } from '../browser/workspace/agentSurfaceHost.js';
import '../browser/preview/browserCookieImport.js';
import './voltWindowCapture.js';

registerMainProcessRemoteService(IVoltDevicesService, VOLT_DEVICES_CHANNEL_NAME);
registerMainProcessRemoteService(IVoltCaptureService, VOLT_CAPTURE_CHANNEL_NAME);
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

/** Creates the devices service at startup, so agents have the device_* tools from their first turn. */
class VoltDevicesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltDevices';

	constructor(@IAgentDevicesService devices: IAgentDevicesService) {
		super();
		void devices;
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
		const opened = openInAgentTools(input, agentToolsSessionOnScreen());
		if (!opened) {
			await editorService.openEditor(input, { pinned: true });
		} else {
			await opened;
		}
	}
});
