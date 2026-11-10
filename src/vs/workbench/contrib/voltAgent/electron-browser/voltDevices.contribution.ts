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
import { parse as parseJson } from '../../../../base/common/json.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { DEVICE_REMOTE_HOSTS_SCHEMA, DEVICE_REMOTE_HOSTS_SETTING, parseRemoteHosts, workspaceRemoteHosts } from '../common/agentDevices.js';
import { AgentDevicesService, IAgentDevicesService } from '../browser/devices/agentDevicesService.js';
import { DEVICE_EDITOR_ID, DeviceFloat, DevicePreviewEditor, DevicePreviewEditorInput, DevicePreviewEditorInputSerializer } from '../browser/devices/deviceEditor.js';
import { agentIdeScope, onDidChangeAgentIdeScope } from '../browser/workspace/agentIdeWorkspace.js';
import { startAgentChat } from '../browser/workspace/agentPanels.js';
import { agentSessionToolTabs, agentToolsSessionOnScreen, isAgentChatOnScreen, liveAgentToolsPart, openInAgentTools, openInChatTools, revealAgentToolEditor } from '../browser/workspace/agentSurfaceHost.js';
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
		[DEVICE_REMOTE_HOSTS_SETTING]: DEVICE_REMOTE_HOSTS_SCHEMA,
	},
});

const REMOTE_HOSTS_NOTICE_KEY = 'volt.devices.remoteHostsWorkspaceNotice';

/**
 * `volt.devices.remoteHosts` is read from user settings only (B-36): a repository could otherwise
 * point Volt's ssh and scp at a machine of its choosing. A workspace that still sets it gets one
 * notice per workspace that shows where it pointed, and can copy the entries to user settings
 * after the user has seen them (B-AP-5). Nothing is copied without that click.
 */
class VoltRemoteHostsScopeNotice extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltRemoteHostsScopeNotice';

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		void this.check();
	}

	private async check(): Promise<void> {
		if (this.storageService.getBoolean(REMOTE_HOSTS_NOTICE_KEY, StorageScope.WORKSPACE, false)) {
			return;
		}
		const workspace = this.workspaceContextService.getWorkspace();
		const found: unknown[] = [];
		const read = async (resource: URI, pick: (parsed: unknown) => unknown) => {
			const content = await this.fileService.readFile(resource).catch(() => undefined);
			const entries = content ? workspaceRemoteHosts(pick(parseJson(content.value.toString()))) : undefined;
			found.push(...(entries ?? []));
		};
		for (const folder of workspace.folders) {
			await read(joinPath(folder.uri, '.vscode', 'settings.json'), parsed => parsed);
		}
		if (workspace.configuration) {
			await read(workspace.configuration, parsed => parsed && typeof parsed === 'object' ? (parsed as { settings?: unknown }).settings : undefined);
		}
		const valid = found.filter(entry => parseRemoteHosts([entry]).length === 1);
		if (!found.length || this._store.isDisposed) {
			return;
		}
		const destinations = parseRemoteHosts(valid).map(host => host.ssh ? `${host.ssh.user ? `${host.ssh.user}@` : ''}${host.ssh.host}${host.ssh.port ? `:${host.ssh.port}` : ''}` : host.label);
		const dismiss = () => this.storageService.store(REMOTE_HOSTS_NOTICE_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const actions = valid.length ? [{
			label: localize('voltDevices.remoteHosts.copy', "Copy to User Settings"),
			run: () => {
				const current = this.configurationService.inspect<unknown[]>(DEVICE_REMOTE_HOSTS_SETTING).userValue;
				const existing = Array.isArray(current) ? current : [];
				const known = new Set(parseRemoteHosts(existing).map(host => host.ssh?.host));
				const added = valid.filter(entry => !known.has(parseRemoteHosts([entry])[0]?.ssh?.host));
				void this.configurationService.updateValue(DEVICE_REMOTE_HOSTS_SETTING, [...existing, ...added], ConfigurationTarget.USER);
				dismiss();
			},
		}] : [];
		this.notificationService.prompt(
			Severity.Warning,
			destinations.length
				? localize('voltDevices.remoteHosts.workspace', "This workspace's settings list remote device hosts ({0}). Volt now reads volt.devices.remoteHosts from your user settings only, so it will not connect to them unless you copy them there.", destinations.join(', '))
				: localize('voltDevices.remoteHosts.workspaceInvalid', "This workspace's settings list remote device hosts that Volt ignores: volt.devices.remoteHosts is read from your user settings only, and these entries are not valid."),
			[...actions, { label: localize('voltDevices.remoteHosts.ignore', "Ignore"), run: dismiss }],
		);
	}
}

registerWorkbenchContribution2(VoltRemoteHostsScopeNotice.ID, VoltRemoteHostsScopeNotice, WorkbenchPhase.Eventually);

/**
 * A build from sources may compile Volt's native helpers at runtime and runs them unsigned (the
 * unsigned helpers developer mode, see helperIntegrity.ts). The status bar says so for as long as
 * the window runs; packaged builds run only the signed helpers in their bundle and show nothing.
 */
class VoltUnsignedHelpersBadge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltUnsignedHelpersBadge';

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IStatusbarService statusbarService: IStatusbarService,
	) {
		super();
		if (environmentService.isBuilt) {
			return;
		}
		const text = localize('voltHelpers.unsigned', "Unsigned helpers");
		this._register(statusbarService.addEntry({
			name: text,
			text: `$(unverified) ${text}`,
			ariaLabel: text,
			tooltip: localize('voltHelpers.unsignedTooltip', "Developer mode: Volt runs from sources, so its native helpers (speech, desktop control) may be compiled here and are not signed. Packaged builds run only signed helpers from the app bundle, checked before every launch."),
			kind: 'warning',
		}, VoltUnsignedHelpersBadge.ID, StatusbarAlignment.LEFT, -1000));
	}
}

registerWorkbenchContribution2(VoltUnsignedHelpersBadge.ID, VoltUnsignedHelpersBadge, WorkbenchPhase.AfterRestored);

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
		this._register(this.instantiationService.createInstance(DeviceFloat));
		this._register(this.editorService.onDidEditorsChange(() => void this.moveOutOfMiddle()));
		this._register(onDidChangeLayoutMode(() => void this.moveOutOfMiddle()));
		this._register(onDidChangeAgentIdeScope(() => void this.moveOutOfMiddle()));
		void this.moveOutOfMiddle();
	}

	private async moveOutOfMiddle(): Promise<void> {
		// Leaving the IDE layout puts each tab of the middle back in the chat it came from, which is
		// not always the chat on screen: only a tab still left over once that is done moves here.
		if (this.moving || getLayoutMode(this.layoutService) !== 'agent' || agentIdeScope()) {
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
		super({ id: OPEN_DEVICE_PREVIEW_COMMAND_ID, visibility: 'internal', title: localize2('voltDevices.open', "Open Device Preview (iOS Simulator / Android Emulator)"), category: localize2('volt', "Volt"), f1: true });
	}

	/**
	 * Opens a new device tab, or brings forward the tab that already shows `deviceKey`. With
	 * `sessionId` the tab goes to that chat's right panel only (a background tab when another chat
	 * is on screen), and the chat uses the device from then on.
	 */
	async run(accessor: ServicesAccessor, deviceKey?: string, sessionId?: string, options?: { onlyIfHere?: boolean }): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const key = typeof deviceKey === 'string' ? deviceKey : undefined;
		const chat = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
		// An agent's device: only the window that has its chat (on screen, its panel made here, or opened here) shows it.
		if (chat && options?.onlyIfHere && !isAgentChatOnScreen(chat) && !liveAgentToolsPart(chat) && !accessor.get(IAgentWorkspaceService).get(chat)) {
			return;
		}
		if (chat) {
			if (key) {
				accessor.get(IAgentDevicesService).attachToChat(chat, key);
			}
			const tab = key ? agentSessionToolTabs(chat)?.tabs.find(entry => entry.input instanceof DevicePreviewEditorInput && entry.input.deviceKey === key)?.input : undefined;
			if (tab) {
				if (isAgentChatOnScreen(chat)) {
					revealAgentToolEditor(tab);
				}
				return;
			}
			const opened = openInChatTools(new DevicePreviewEditorInput(key), chat);
			if (opened) {
				await opened;
				return;
			}
			// No chat view here (the IDE layout): a normal editor tab below.
		}
		const existing = key ? editorService.editors.find((editor): editor is DevicePreviewEditorInput => editor instanceof DevicePreviewEditorInput && editor.deviceKey === key) : undefined;
		if (existing && revealAgentToolEditor(existing)) {
			return;
		}
		const input = existing ?? new DevicePreviewEditorInput(key);
		// Beside the chat in the agent layout; a normal editor tab in the IDE layout.
		if (!await openDevicePreview(accessor, input)) {
			await editorService.openEditor(input, { pinned: true });
		}
	}
});
