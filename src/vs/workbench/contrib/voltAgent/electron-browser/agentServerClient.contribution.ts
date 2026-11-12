/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IVoltAgentServerMainService, VOLT_AGENT_SERVER_CHANNEL_NAME, VOLT_ALLOW_NETWORK_COMMAND_ID } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { VOLT_USAGE_SHARE_MACHINE_COMMAND_ID } from '../../../../platform/voltUsage/common/voltUsage.js';
import { IWebSocketLike } from '../../../../platform/voltAgentServer/common/connection.js';
import { WORKBENCH_TOPICS } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVoltBrowserAccessService } from '../../../services/voltRuntime/common/browserAccess.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { AGENT_SERVER_ENABLED_SETTING, AgentServerClient, agentServerEnabled, IAgentServerClientService } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { RemoteAgentHistoryService } from '../../../services/voltAgentServer/common/remoteAgentHistoryService.js';
import { RemoteAgentOrchestratorService } from '../../../services/voltAgentServer/common/remoteAgentOrchestratorService.js';
import { RemoteAgentRuntimeService } from '../../../services/voltAgentServer/common/remoteAgentRuntimeService.js';
import { RemoteVoltHostToolService } from '../../../services/voltAgentServer/common/remoteVoltHostToolService.js';
import { RemoteVoltSessionContextService } from '../../../services/voltAgentServer/common/remoteVoltSessionContextService.js';
import { RemoteVoltTrajectoryService } from '../../../services/voltAgentServer/common/remoteVoltTrajectoryService.js';
import { VoltTrajectoryService } from '../../../services/voltRuntime/browser/trajectoryService.js';
import { IVoltTrajectoryService } from '../../../services/voltRuntime/common/trajectory.js';
import { AgentHistoryService } from '../../../services/voltRuntime/browser/history/agentHistoryService.js';
import { VoltHostToolService } from '../../../services/voltRuntime/browser/host/hostToolService.js';
import { AgentOrchestratorService } from '../../../services/voltRuntime/browser/orchestration/agentOrchestratorService.js';
import { VoltSessionContextService } from '../../../services/voltRuntime/browser/sessionContextService.js';
import { AgentRuntimeService } from '../../../services/voltRuntime/browser/voltRuntimeService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { AGENT_SERVER_WINDOW_COMMANDS, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IProviderProfile, secretKeyForProfile } from '../../../services/voltRuntime/common/profiles.js';
import { IAgentRuntimeService, OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { setAgentSessionControlFactory } from '../browser/editor/agentEditorInput.js';
import { RemoteAgentSessionControl } from '../browser/editor/remoteAgentSessionControl.js';
import { AgentCheckpointService, IAgentCheckpointService } from '../browser/review/agentCheckpointService.js';
import { RemoteAgentCheckpointService } from '../browser/review/remoteAgentCheckpointService.js';
import { AgentTerminalsService, IAgentTerminalsService } from '../browser/terminals/agentTerminals.js';
import { RemoteAgentTerminalsService } from '../browser/terminals/remoteAgentTerminals.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IVoltRelayService, VOLT_RELAY_CHANNEL_NAME } from '../../../../platform/voltRelay/common/voltRelay.js';
import { RemoteVoltRelayService } from '../../../services/voltAgentServer/common/remoteVoltRelayService.js';
import { WindowAgentRunGroupService } from '../browser/runGroups/agentRunGroupWindowService.js';
import { RemoteAgentRunGroupService } from '../browser/runGroups/remoteAgentRunGroupService.js';
import { IAgentRunGroupService } from '../../../services/voltRuntime/common/runGroups/runGroups.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AgentServerWindow, DESKTOP_FILE_NAMES } from '../browser/remote/agentServerWindow.js';
import { showRemoteControlIntro } from '../browser/remote/voltRemoteIntro.js';

registerMainProcessRemoteService(IVoltAgentServerMainService, VOLT_AGENT_SERVER_CHANNEL_NAME);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agentServer',
	title: localize('voltAgentServer', "Volt Agent Server"),
	type: 'object',
	properties: {
		[AGENT_SERVER_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAgentServer.enabled', "Run agents in the Volt agent server, a background process: they keep working while a window reloads or closes, after Volt quits and across sleep, and reopening Volt shows their progress. The server stops on its own after 15 minutes with no window open and nothing left to do. Turn off to run agents inside each window instead. Takes effect after a restart."),
		},
	},
});

/** This window's connection to the profile's agent server, started by the main process. */
class DesktopAgentServerClient extends AgentServerClient {
	constructor(
		@IVoltAgentServerMainService mainService: IVoltAgentServerMainService,
		@ILogService logService: ILogService,
	) {
		super({
			// Asked before every attempt: a server that died is started again.
			endpoint: async () => {
				try {
					const endpoint = await mainService.ensureRunning();
					return { url: endpoint.url, token: endpoint.token };
				} catch (err) {
					logService.error('[volt agent server] could not start the agent server', err);
					return undefined;
				}
			},
			createSocket: url => new WebSocket(url) as unknown as IWebSocketLike,
			client: { kind: 'desktop', id: generateUuid(), capabilities: ['browser', 'surface', 'codeIntel'], topics: WORKBENCH_TOPICS },
			onError: (method, err) => logService.warn(`[volt agent server] ${method} failed`, err),
		});
		this.connect();
	}
}

registerSingleton(IAgentServerClientService, DesktopAgentServerClient, InstantiationType.Delayed);

/**
 * A service that is this window's own implementation, or a client of the agent server's, as the
 * setting says when the window starts.
 */
type ServiceCtor = new (...args: any[]) => unknown;

function eitherLocalOrRemote(local: ServiceCtor, remote: ServiceCtor): ServiceCtor {
	class LocalOrRemote {
		constructor(
			@IInstantiationService instantiationService: IInstantiationService,
			@IConfigurationService configurationService: IConfigurationService,
		) {
			return instantiationService.createInstance(agentServerEnabled(configurationService) ? remote : local) as LocalOrRemote;
		}
	}
	return LocalOrRemote;
}

// Registered after the in-process services (this file is imported after them), so these win.
registerSingleton(IAgentRuntimeService, <never>eitherLocalOrRemote(AgentRuntimeService, RemoteAgentRuntimeService), InstantiationType.Delayed);
registerSingleton(IAgentOrchestratorService, <never>eitherLocalOrRemote(AgentOrchestratorService, RemoteAgentOrchestratorService), InstantiationType.Delayed);
registerSingleton(IAgentHistoryService, <never>eitherLocalOrRemote(AgentHistoryService, RemoteAgentHistoryService), InstantiationType.Delayed);
registerSingleton(IVoltSessionContextService, <never>eitherLocalOrRemote(VoltSessionContextService, RemoteVoltSessionContextService), InstantiationType.Delayed);
registerSingleton(IVoltHostToolService, <never>eitherLocalOrRemote(VoltHostToolService, RemoteVoltHostToolService), InstantiationType.Delayed);
registerSingleton(IAgentCheckpointService, <never>eitherLocalOrRemote(AgentCheckpointService, RemoteAgentCheckpointService), InstantiationType.Delayed);
// Agents' terminals run where the agents do: in the server they outlive this window, which shows them attached.
registerSingleton(IAgentTerminalsService, <never>eitherLocalOrRemote(AgentTerminalsService, RemoteAgentTerminalsService), InstantiationType.Delayed);
// Runs record their model requests where they run: the Trajectory panel reads the server's.
registerSingleton(IVoltTrajectoryService, <never>eitherLocalOrRemote(VoltTrajectoryService, RemoteVoltTrajectoryService), InstantiationType.Delayed);

/** The main process's relay, for windows that run their agents themselves. */
class MainProcessRelayService {
	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		return ProxyChannel.toService<IVoltRelayService>(mainProcessService.getChannel(VOLT_RELAY_CHANNEL_NAME));
	}
}

// The relay lives with the agents: in the server, webhook automations run with no window open.
registerSingleton(IVoltRelayService, <never>eitherLocalOrRemote(MainProcessRelayService, RemoteVoltRelayService), InstantiationType.Delayed);
// Run groups live in the server with the chats they start, so every client sees the same ones.
registerSingleton(IAgentRunGroupService, <never>eitherLocalOrRemote(WindowAgentRunGroupService, RemoteAgentRunGroupService), InstantiationType.Delayed);

// Chats' transcripts come from the server's session controllers.
setAgentSessionControlFactory((input, instantiationService) => instantiationService.invokeFunction(accessor =>
	agentServerEnabled(accessor.get(IConfigurationService)) ? instantiationService.createInstance(RemoteAgentSessionControl, input) : undefined));

/** Commands the server may ask this window to run: the in-app browser's, and what the user has open. */
const WINDOW_COMMANDS = AGENT_SERVER_WINDOW_COMMANDS;

/**
 * What a desktop window does for the agent server on top of every window's part (AgentServerWindow):
 * the things only the desktop can (the in-app browser), handing over provider keys once, and
 * reconnecting at once when the Mac wakes.
 */
class AgentServerClientContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentServerClient';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (agentServerEnabled(configurationService)) {
			this._register(instantiationService.createInstance(AgentServerWindow, { files: DESKTOP_FILE_NAMES, projectSettingsFromServer: false }));
			instantiationService.invokeFunction(accessor => this.start(accessor));
		}
	}

	private start(accessor: ServicesAccessor): void {
		const client = accessor.get(IAgentServerClientService);
		const commands = accessor.get(ICommandService);
		const secrets = accessor.get(ISecretStorageService);
		const nativeHost = accessor.get(INativeHostService);
		const logService = accessor.get(ILogService);

		this._register(client.registerHandler('command.execute', (id, ...args) => {
			if (typeof id !== 'string' || !WINDOW_COMMANDS.has(id)) {
				throw new Error(`This window does not run ${String(id)} for the agent server.`);
			}
			// Cancellation stays on the server; a token does not cross the socket.
			return commands.executeCommand(id, ...args.map(arg => withoutToken(arg)));
		}));
		const browserAccess = accessor.get(IVoltBrowserAccessService);
		const sendBrowserChoices = () => client.call('browserAccess.setChoices', browserAccess.chatChoices()).catch(err => logService.warn('[volt agent server] could not send the browser access choices', err));
		this._register(browserAccess.onDidChange(() => void sendBrowserChoices()));
		if (client.isReady) {
			void sendBrowserChoices();
		}
		this._register(client.onDidResync(() => {
			void sendBrowserChoices();
			void this.handOverKeys(client, secrets, logService);
		}));
		// After sleep the socket may look open but be dead (or the server may have gone): reconnect
		// now instead of after a backoff, then resume or resync. The server is started again if needed.
		this._register(nativeHost.onDidResumeOS(() => {
			logService.info('[volt agent server] the system woke up; reconnecting');
			client.connection.reconnect();
		}));
	}

	/** The desktop keeps provider keys encrypted for this app; the server gets the ones it lacks. */
	private async handOverKeys(client: IAgentServerClientService, secrets: ISecretStorageService, logService: ILogService): Promise<void> {
		const profiles = client.mirror.get<IProviderProfile[]>('runtime', 'profiles') ?? [];
		const keys: Record<string, string> = {};
		for (const profile of profiles) {
			if (profile.hasSecret) {
				const value = await secrets.get(secretKeyForProfile(profile.id)).catch(() => undefined);
				if (value) {
					keys[secretKeyForProfile(profile.id)] = value;
				}
			}
		}
		if (Object.keys(keys).length) {
			await client.call('secrets.importMissing', keys).catch(err => logService.warn('[volt agent server] could not hand over provider keys', err));
		}
	}
}

/** Browser automation options carry a cancellation token; the window runs the call with none. */
function withoutToken(arg: unknown): unknown {
	if (arg && typeof arg === 'object' && !Array.isArray(arg) && 'token' in arg) {
		return { ...arg as Record<string, unknown>, token: CancellationToken.None };
	}
	return arg;
}

registerWorkbenchContribution2(AgentServerClientContribution.ID, AgentServerClientContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.restart', title: localize2('voltAgentServer.restart', "Restart Agent Server"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const notifications = accessor.get(INotificationService);
		const dialogs = accessor.get(IDialogService);
		const { confirmed } = await dialogs.confirm({
			message: localize('voltAgentServer.restartConfirm', "Restart the Volt agent server?"),
			detail: localize('voltAgentServer.restartDetail', "Running turns stop and show as interrupted; you can resume them."),
			primaryButton: localize({ key: 'voltAgentServer.restartButton', comment: ['&& denotes a mnemonic'] }, "&&Restart"),
		});
		if (!confirmed) {
			return;
		}
		try {
			await mainService.restart();
		} catch (err) {
			notifications.error(localize('voltAgentServer.restartFailed', "Could not restart the Volt agent server: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.showLog', title: localize2('voltAgentServer.showLog', "Show Agent Server Log"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const environment = accessor.get(INativeEnvironmentService);
		const editors = accessor.get(IEditorService);
		await editors.openEditor({ resource: URI.joinPath(URI.file(environment.userDataPath), 'logs', 'agent-server.log'), options: { pinned: true } });
	}
});

/** Volt in the browser on this machine. It signs itself in over loopback, so no token goes in the URL. */
function localWebUrl(port: number, path = '/'): string {
	return `http://127.0.0.1:${port}${path}`;
}

/** The browser workbench opened on Volt Settings > Devices (for when this window is not the agent server's client). */
const DEVICES_PAGE_PATH = `/?next=${encodeURIComponent('/code/?voltSettings=devices')}`;

/** Turns the agent server on (it needs a restart) when it is off. Resolves whether it is on. */
async function ensureServerMode(configurationService: IConfigurationService, dialogs: IDialogService, host: IHostService): Promise<boolean> {
	if (agentServerEnabled(configurationService)) {
		return true;
	}
	const { confirmed } = await dialogs.confirm({
		message: localize('voltAgentServer.needed', "Phones and browsers reach Volt through its agent server"),
		detail: localize('voltAgentServer.neededDetail', "Turn on the agent server so chats keep running in the background and your other devices can follow and steer them. Volt restarts to apply it."),
		primaryButton: localize({ key: 'voltAgentServer.turnOn', comment: ['&& denotes a mnemonic'] }, "&&Turn On and Restart"),
	});
	if (confirmed) {
		await configurationService.updateValue(AGENT_SERVER_ENABLED_SETTING, true);
		await host.restart();
	}
	return false;
}

/** Set once the user turns Remote Control on from its introduction; until then pairing shows it. */
const REMOTE_INTRO_SEEN_KEY = 'volt.remoteControl.introSeen';

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.pairDevice', title: localize2('voltAgentServer.pairDevice', "Pair a Phone or Browser..."), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const configurationService = accessor.get(IConfigurationService);
		const dialogs = accessor.get(IDialogService);
		const commands = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const host = accessor.get(IHostService);
		const storage = accessor.get(IStorageService);
		const layout = accessor.get(ILayoutService);
		// The first time, a full introduction instead of going straight to the confirmations.
		if (!storage.getBoolean(REMOTE_INTRO_SEEN_KEY, StorageScope.APPLICATION, false)) {
			if (!await showRemoteControlIntro(layout.activeContainer)) {
				return;
			}
			storage.store(REMOTE_INTRO_SEEN_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		}
		if (!await ensureServerMode(configurationService, dialogs, host)) {
			return;
		}
		try {
			await mainService.ensureRunning();
			// Add Device picks the connection (Wi-Fi, Tailscale, Cloudflare, SSH) and asks for network access when one needs it.
			await commands.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID, 'devices:add');
		} catch (err) {
			notifications.error(localize('voltAgentServer.pairFailed', "Could not open pairing: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.openWebApp', title: localize2('voltAgentServer.openWebApp', "Open Volt in the Browser"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const configurationService = accessor.get(IConfigurationService);
		const dialogs = accessor.get(IDialogService);
		const nativeHost = accessor.get(INativeHostService);
		const notifications = accessor.get(INotificationService);
		const host = accessor.get(IHostService);
		if (!await ensureServerMode(configurationService, dialogs, host)) {
			return;
		}
		try {
			const endpoint = await mainService.ensureRunning();
			await nativeHost.openExternal(localWebUrl(endpoint.port));
		} catch (err) {
			notifications.error(localize('voltAgentServer.openWebFailed', "Could not open Volt in the browser: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});

/** Add Device's "Allow Wi-Fi Connections": the user already chose it there, so no second prompt. */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_ALLOW_NETWORK_COMMAND_ID, title: localize2('voltAgentServer.allowNetworkCommand', "Let Devices on This Network Connect"), category: localize2('volt', "Volt"), f1: false });
	}
	override async run(accessor: ServicesAccessor): Promise<boolean> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const configurationService = accessor.get(IConfigurationService);
		if (!agentServerEnabled(configurationService)) {
			return false;
		}
		return (await mainService.setNetworkAccess(true)).network;
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.stopNetwork', title: localize2('voltAgentServer.stopNetwork', "Stop Sharing Volt on This Network"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const configurationService = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		if (!agentServerEnabled(configurationService)) {
			return;
		}
		try {
			await mainService.setNetworkAccess(false);
			notifications.info(localize('voltAgentServer.networkOff', "Volt is reachable only from this computer now. Paired devices reconnect when you share it again."));
		} catch (err) {
			notifications.error(localize('voltAgentServer.networkOffFailed', "Could not stop sharing: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});

/**
 * Lets Volt on the user's other computers read this one's usage and limits (Settings > Usage >
 * Machines). They pair like a phone: the agent server listens on the local network, and the
 * Devices page makes a one-time code whose link the other computer adds. The agent server runs
 * for this whether or not chats run in it.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_USAGE_SHARE_MACHINE_COMMAND_ID, title: localize2('voltUsage.shareMachineCommand', "Share This Machine's Usage"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const dialogs = accessor.get(IDialogService);
		const nativeHost = accessor.get(INativeHostService);
		const notifications = accessor.get(INotificationService);
		try {
			let endpoint = await mainService.ensureRunning();
			if (!endpoint.network) {
				const { confirmed } = await dialogs.confirm({
					message: localize('voltUsage.shareConfirm', "Let your other computers read this machine's usage?"),
					detail: localize('voltUsage.shareDetail', "The Volt agent server will listen on your local network and restart; running turns stop and show as interrupted. Each computer you add pairs with a one-time code and gets its own key, which you can remove on the Devices page."),
					primaryButton: localize({ key: 'voltUsage.shareButton', comment: ['&& denotes a mnemonic'] }, "&&Share"),
				});
				if (!confirmed) {
					return;
				}
				endpoint = await mainService.setNetworkAccess(true);
			}
			await nativeHost.openExternal(localWebUrl(endpoint.port, DEVICES_PAGE_PATH));
			notifications.notify({
				severity: Severity.Info,
				message: localize('voltUsage.shareNext', "Choose Add Device on the Devices page and copy its link. On your other computer, open Settings > Usage, choose Add Machine and paste it."),
			});
		} catch (err) {
			notifications.error(localize('voltUsage.shareFailed', "Could not share this machine: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});
