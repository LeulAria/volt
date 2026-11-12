/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's workbench in a browser, served by the agent server (`/code/`). The page is the desktop's
// workbench with the agent server on: the agents, chats and history live in the agent server and
// this page is one more window on them. What the desktop's main process does for a window
// (processes, git, the folder picker, pull requests, usage, Claude accounts, the skills directory,
// storage cleanup, importing from other editors) the agent server does here, over the workbench's
// remote connection; what a desktop window does for the agent server (language servers, unsaved
// changes, Project Settings, the Keep/Undo review) this page does the same way (AgentServerWindow).

import './media/voltWorkbenchWeb.css';
import './voltWebFolders.js';
import './voltWebTouch.js';
import { WebSpeechService } from './voltWebSpeech.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { BrandedService, IInstantiationService, ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { editorBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltAccountsService, VOLT_ACCOUNTS_CHANNEL_NAME } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import { IWebSocketLike } from '../../../../../platform/voltAgentServer/common/connection.js';
import { WORKBENCH_TOPICS } from '../../../../../platform/voltAgentServer/common/protocol.js';
import { IVoltAwakeService } from '../../../../../platform/voltAwake/common/voltAwake.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltExternalMcpService } from '../../../../../platform/voltExternalMcp/common/voltExternalMcp.js';
import { IVoltFsBrowseService, VOLT_FS_BROWSE_CHANNEL_NAME } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltCodeIndexService, VOLT_CODE_INDEX_CHANNEL_NAME } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IVoltEditorImportService, VOLT_EDITOR_IMPORT_CHANNEL_NAME } from '../../../../../platform/voltEditorImport/common/voltEditorImport.js';
import { IVoltSkillsDirectoryService, VOLT_SKILLS_DIRECTORY_CHANNEL_NAME } from '../../../../../platform/voltMarketplace/common/voltMarketplace.js';
import { IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IVoltRelayService } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IVoltSpeechService } from '../../../../../platform/voltSpeech/common/voltSpeech.js';
import { IVoltStdioService, VOLT_STDIO_CHANNEL_NAME } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltStorageService, VOLT_STORAGE_CHANNEL_NAME } from '../../../../../platform/voltStorage/common/voltStorage.js';
import { IVoltUsageService, VOLT_USAGE_CHANNEL_NAME } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { SIDE_BAR_BACKGROUND, TITLE_BAR_ACTIVE_BACKGROUND } from '../../../../common/theme.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { AgentServerClient, IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { RemoteAgentHistoryService } from '../../../../services/voltAgentServer/common/remoteAgentHistoryService.js';
import { RemoteAgentOrchestratorService } from '../../../../services/voltAgentServer/common/remoteAgentOrchestratorService.js';
import { RemoteAgentRuntimeService } from '../../../../services/voltAgentServer/common/remoteAgentRuntimeService.js';
import { RemoteVoltHostToolService } from '../../../../services/voltAgentServer/common/remoteVoltHostToolService.js';
import { RemoteVoltRelayService } from '../../../../services/voltAgentServer/common/remoteVoltRelayService.js';
import { RemoteVoltSessionContextService } from '../../../../services/voltAgentServer/common/remoteVoltSessionContextService.js';
import { RemoteVoltTrajectoryService } from '../../../../services/voltAgentServer/common/remoteVoltTrajectoryService.js';
import { IVoltTrajectoryService } from '../../../../services/voltRuntime/common/trajectory.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { WORKSPACE_SNAPSHOT_COMMAND_ID } from '../../../../services/voltRuntime/common/harness/workspaceContext.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { ProjectEnvVoltStdioService } from '../../../../services/voltRuntime/common/projectEnvStdio.js';
import { IAgentRuntimeService, OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { setAgentSessionControlFactory } from '../editor/agentEditorInput.js';
import { RemoteAgentSessionControl } from '../editor/remoteAgentSessionControl.js';
import { IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';
import { registerMachineCapacity } from '../orchestration/agentMachineCapacity.js';
import { AgentServerWindow, DESKTOP_FILE_NAMES, remoteFileNames } from '../remote/agentServerWindow.js';
import { IAgentCheckpointService } from '../review/agentCheckpointService.js';
import { RemoteAgentCheckpointService } from '../review/remoteAgentCheckpointService.js';
import { IAgentTerminalsService } from '../terminals/agentTerminals.js';
import { RemoteAgentTerminalsService } from '../terminals/remoteAgentTerminals.js';
import { RemoteAgentRunGroupService } from '../runGroups/remoteAgentRunGroupService.js';
import { IAgentRunGroupService } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { setComputerName } from '../usage/agentComputerName.js';
import { IVoltCanvasService, VoltCanvasService } from '../visuals/canvas/canvasService.js';
import { AGENT_BADGE_SETTING } from '../../common/agentThreadAttention.js';

// What the desktop also loads (its main file imports these after the agent services).
import '../pullRequests/agentPullRequests.contribution.js';
import '../trajectory/agentTrajectory.contribution.js';
import '../runGroups/agentRunGroups.contribution.js';
import '../orchestration/agentThreadToolService.js';
import '../../../../services/voltRuntime/browser/orchestration/agentOrchestraService.js';
import '../orchestration/agentWorkspaceMover.js';
import '../orchestration/agentMoveChat.contribution.js';

/** What the agent server put in the page's configuration. */
interface IVoltPageConfiguration {
	readonly environmentId?: string;
	readonly wsPath?: string;
	/** The device token this page signed in with (the server reads it from the session cookie). */
	readonly deviceToken?: string;
	/** The computer's home folder: the path service's home in the browser (see BrowserPathService). */
	readonly userHome?: string;
	/** The desktop's user data dir (the agent server's log is under it). */
	readonly userDataDir?: string;
	/** The computer: its name, and the memory and cores agent runs are sized by. */
	readonly machine?: {
		readonly name?: string;
		readonly totalMemMb: number;
		readonly cpus: number;
		readonly cpuModel?: string;
		readonly platform?: string;
		readonly arch?: string;
	};
}

function pageConfiguration(environmentService: IBrowserWorkbenchEnvironmentService): IVoltPageConfiguration {
	return (environmentService.options as { voltAgentServer?: IVoltPageConfiguration } | undefined)?.voltAgentServer ?? {};
}

function signInUrl(): string {
	const here = mainWindow.location.pathname + mainWindow.location.search;
	return `/?next=${encodeURIComponent(here)}`;
}

//#region Agent server

class WebAgentServerClient extends AgentServerClient {
	constructor(
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@ILogService logService: ILogService,
	) {
		const config = pageConfiguration(environmentService);
		super({
			endpoint: async () => {
				const token = config.deviceToken;
				if (!token) {
					return undefined;
				}
				const scheme = mainWindow.location.protocol === 'https:' ? 'wss' : 'ws';
				return { url: `${scheme}://${mainWindow.location.host}${config.wsPath ?? '/ws'}`, token };
			},
			createSocket: url => new WebSocket(url) as unknown as IWebSocketLike,
			// As a desktop window, less the in-app browser: this page's language servers answer the agents too.
			client: { kind: 'web', id: `workbench-${generateUuid()}`, capabilities: ['surface', 'codeIntel'], topics: WORKBENCH_TOPICS },
			onError: (method, err) => logService.warn(`[volt agent server] ${method} failed`, err),
		});
		this.connect();
	}
}

registerSingleton(IAgentServerClientService, WebAgentServerClient, InstantiationType.Delayed);

// The agents run in the agent server; this page reads and steers them (registered after the
// in-process services, so these win).
registerSingleton(IAgentRuntimeService, RemoteAgentRuntimeService, InstantiationType.Delayed);
registerSingleton(IAgentOrchestratorService, RemoteAgentOrchestratorService, InstantiationType.Delayed);
registerSingleton(IAgentHistoryService, RemoteAgentHistoryService, InstantiationType.Delayed);
registerSingleton(IVoltSessionContextService, RemoteVoltSessionContextService, InstantiationType.Delayed);
registerSingleton(IVoltHostToolService, RemoteVoltHostToolService, InstantiationType.Delayed);
registerSingleton(IAgentCheckpointService, RemoteAgentCheckpointService, InstantiationType.Delayed);
// The agents' terminals run in the agent server too; this page shows them attached to it.
registerSingleton(IAgentTerminalsService, RemoteAgentTerminalsService, InstantiationType.Delayed);
registerSingleton(IAgentRunGroupService, RemoteAgentRunGroupService, InstantiationType.Delayed);
registerSingleton(IVoltTrajectoryService, RemoteVoltTrajectoryService, InstantiationType.Delayed);
// The relay lives with the agents (webhook automations run with no window open), as on the desktop with the agent server on.
registerSingleton(IVoltRelayService, RemoteVoltRelayService, InstantiationType.Delayed);
setAgentSessionControlFactory((input, instantiationService) => instantiationService.createInstance(RemoteAgentSessionControl, input));

//#endregion

//#region The machine's services, over the remote connection

function registerServerService<T>(id: ServiceIdentifier<T>, channelName: string, wrap?: (channel: IChannel) => T): void {
	class ServerService {
		constructor(@IRemoteAgentService remoteAgentService: IRemoteAgentService) {
			const connection = remoteAgentService.getConnection();
			if (!connection) {
				throw new Error(`Volt's ${channelName} service needs the server connection.`);
			}
			const channel = connection.getChannel(channelName);
			return (wrap ? wrap(channel) : ProxyChannel.toService<T & object>(channel)) as ServerService;
		}
	}
	registerSingleton(id, ServerService as unknown as new (...services: BrandedService[]) => T, InstantiationType.Delayed);
}

registerServerService(IVoltStdioService, VOLT_STDIO_CHANNEL_NAME, channel => new ProjectEnvVoltStdioService(channel));
registerServerService(IVoltGitService, VOLT_GIT_CHANNEL_NAME);
registerServerService(IVoltCodeIndexService, VOLT_CODE_INDEX_CHANNEL_NAME);
registerServerService(IVoltFsBrowseService, VOLT_FS_BROWSE_CHANNEL_NAME);
registerServerService(IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME);
registerServerService(IVoltUsageService, VOLT_USAGE_CHANNEL_NAME);
registerServerService(IVoltAccountsService, VOLT_ACCOUNTS_CHANNEL_NAME);
registerServerService(IVoltSkillsDirectoryService, VOLT_SKILLS_DIRECTORY_CHANNEL_NAME);
registerServerService(IVoltStorageService, VOLT_STORAGE_CHANNEL_NAME);
registerServerService(IVoltEditorImportService, VOLT_EDITOR_IMPORT_CHANNEL_NAME);

registerSingleton(IVoltCanvasService, VoltCanvasService, InstantiationType.Delayed);

/**
 * What only the desktop app can do (keeping the Mac awake, the in-app browser, the MCP bridge for
 * other agents): its events never fire and its calls say why they fail, except the members
 * `answers` gives.
 */
function registerDesktopOnly<T>(id: ServiceIdentifier<T>, what: string, answers: Record<string, unknown> = {}): void {
	class DesktopOnly {
		constructor() {
			return new Proxy(Object.create(null), {
				get: (_target, property) => {
					if (typeof property !== 'string' || property === 'then' || property === '_serviceBrand') {
						return undefined;
					}
					if (Object.prototype.hasOwnProperty.call(answers, property)) {
						return answers[property];
					}
					if (/^on[A-Z]/.test(property)) {
						return Event.None;
					}
					return () => Promise.reject(new Error(localize('volt.web.desktopOnly', "{0} needs the Volt desktop app.", what)));
				},
			}) as DesktopOnly;
		}
	}
	registerSingleton(id, DesktopOnly as unknown as new (...services: BrandedService[]) => T, InstantiationType.Delayed);
}

registerDesktopOnly(IVoltAwakeService, localize('volt.web.awake', "Lid-Closed Mode"));
// Dictation listens through the browser's own speech recognition.
registerSingleton(IVoltSpeechService, WebSpeechService, InstantiationType.Delayed);
registerDesktopOnly(IVoltBrowserService, localize('volt.web.browser', "The in-app browser"));
registerDesktopOnly(IVoltExternalMcpService, localize('volt.web.externalMcp', "Connecting other agents"));

// The machine's memory and cores, from the agent server (Settings > Orchestration sizes agent runs by them).
registerMachineCapacity(async accessor => {
	const machine = pageConfiguration(accessor.get(IBrowserWorkbenchEnvironmentService)).machine;
	if (!machine) {
		throw new Error(localize('volt.web.noMachine', "The agent server did not say what this computer has. Update Volt on it."));
	}
	return { totalMemMb: machine.totalMemMb, cpus: machine.cpus, cpuModel: machine.cpuModel, platform: machine.platform, arch: machine.arch };
});

//#endregion

//#region What this page does for the agent server

/**
 * As a desktop window (AgentServerWindow does the same here), plus what a browser tab needs:
 * answers what the user has open, reconnects when the tab comes back, and sends the browser to
 * sign in when it has no device token for this server.
 */
class WebAgentServerClientContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebAgentServerClient';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
	) {
		super();
		const remoteAuthority = environmentService.remoteAuthority;
		this._register(instantiationService.createInstance(AgentServerWindow, { files: remoteAuthority ? remoteFileNames(remoteAuthority) : DESKTOP_FILE_NAMES, projectSettingsFromServer: true }));
		instantiationService.invokeFunction(accessor => this.start(accessor));
	}

	private start(accessor: ServicesAccessor): void {
		const client = accessor.get(IAgentServerClientService);
		const commands = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const environmentService = accessor.get(IBrowserWorkbenchEnvironmentService);
		const config = pageConfiguration(environmentService);

		if (!config.deviceToken) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('volt.web.signIn', "This browser isn't signed in to Volt yet, so chats can't load."),
				actions: { primary: [{ id: 'volt.web.signIn', label: localize('volt.web.signInAction', "Sign In"), tooltip: '', class: undefined, enabled: true, run: () => mainWindow.location.assign(signInUrl()) }] },
				sticky: true,
			});
		}
		// The title bar's machine name, as the desktop reads it from its main process.
		if (config.machine?.name) {
			setComputerName(config.machine.name);
		}

		// What the user has open (the agents' workspace snapshot); the in-app browser's commands stay with the desktop.
		this._register(client.registerHandler('command.execute', (id, ...args) => {
			if (id !== WORKSPACE_SNAPSHOT_COMMAND_ID) {
				throw new Error(`This window does not run ${String(id)} for the agent server.`);
			}
			return commands.executeCommand(id, ...args.map(arg => arg && typeof arg === 'object' && !Array.isArray(arg) && 'token' in arg ? { ...arg as Record<string, unknown>, token: CancellationToken.None } : arg));
		}));

		// A tab in the background or a laptop that slept may hold a dead socket: reconnect when it is back.
		const onVisible = () => {
			if (mainWindow.document.visibilityState === 'visible') {
				client.connection.reconnect();
			}
		};
		mainWindow.document.addEventListener('visibilitychange', onVisible);
		this._register({ dispose: () => mainWindow.document.removeEventListener('visibilitychange', onVisible) });
	}
}

registerWorkbenchContribution2(WebAgentServerClientContribution.ID, WebAgentServerClientContribution, WorkbenchPhase.BlockRestore);

/**
 * The page around the workbench in the theme's colours: what shows when a phone over-scrolls,
 * and the browser's own bar (Safari's tab bar, an installed app's title bar).
 */
class WebPageChromeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebPageChrome';

	constructor(@IThemeService private readonly themeService: IThemeService) {
		super();
		this.apply();
		this._register(themeService.onDidColorThemeChange(() => this.apply()));
	}

	private apply(): void {
		const theme = this.themeService.getColorTheme();
		const background = theme.getColor(SIDE_BAR_BACKGROUND) ?? theme.getColor(editorBackground);
		const bar = theme.getColor(TITLE_BAR_ACTIVE_BACKGROUND) ?? background;
		const page = mainWindow.document;
		if (background) {
			for (const element of [page.documentElement, page.body]) {
				element.style.setProperty('background-color', background.toString(), 'important');
			}
		}
		if (bar) {
			let meta = page.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
			if (!meta) {
				meta = page.createElement('meta');
				meta.name = 'theme-color';
				page.head.appendChild(meta);
			}
			meta.content = bar.toString();
		}
		page.documentElement.style.colorScheme = isDark(theme.type) ? 'dark' : 'light';
	}
}

registerWorkbenchContribution2(WebPageChromeContribution.ID, WebPageChromeContribution, WorkbenchPhase.BlockStartup);

/**
 * The desktop's app icon badge, for an installed Volt (a home screen or desktop web app): chats
 * that finished out of sight.
 */
class WebBadgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebBadge';

	private sent: number | undefined;

	constructor(
		@IAgentThreadAttentionService private readonly attention: IAgentThreadAttentionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const badge = mainWindow.navigator as unknown as { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> };
		if (typeof badge.setAppBadge !== 'function') {
			return;
		}
		const sync = () => {
			const count = this.configurationService.getValue<boolean>(AGENT_BADGE_SETTING) !== false ? this.attention.unreadCount : 0;
			if (count === this.sent) {
				return;
			}
			this.sent = count;
			void (count ? badge.setAppBadge!(count) : badge.clearAppBadge?.() ?? badge.setAppBadge!(0))?.catch(() => undefined);
		};
		sync();
		this._register(this.attention.onDidChange(sync));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_BADGE_SETTING)) {
				sync();
			}
		}));
	}
}

registerWorkbenchContribution2(WebBadgeContribution.ID, WebBadgeContribution, WorkbenchPhase.AfterRestored);

// The desktop's command: the agent server's log is a file on the computer, which this page reads.
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.showLog', title: localize2('voltAgentServer.showLog', "Show Agent Server Log"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const userDataDir = pageConfiguration(accessor.get(IBrowserWorkbenchEnvironmentService)).userDataDir;
		if (!userDataDir) {
			accessor.get(INotificationService).warn(localize('volt.web.noLog', "The agent server did not say where its log is. Update Volt on this computer."));
			return;
		}
		await accessor.get(IEditorService).openEditor({ resource: URI.joinPath(URI.file(userDataDir), 'logs', 'agent-server.log'), options: { pinned: true } });
	}
});

// The desktop's command, for the same entry points: Volt Settings > Devices.
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.pairDevice', title: localize2('voltAgentServer.pairDevice', "Pair a Phone or Browser..."), category: localize2('volt', "Volt"), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID, 'devices');
	}
});

/**
 * `?voltSettings=<page>` opens Volt Settings on that page once the workbench is up (the desktop
 * sends its Devices links here when it is not the agent server's client), then leaves the address.
 */
class WebSettingsLinkContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebSettingsLink';

	constructor(@ICommandService commandService: ICommandService) {
		const url = new URL(mainWindow.location.href);
		const page = url.searchParams.get('voltSettings');
		if (!page) {
			return;
		}
		url.searchParams.delete('voltSettings');
		mainWindow.history.replaceState(mainWindow.history.state, '', url.pathname + url.search + url.hash);
		void commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID, page);
	}
}

registerWorkbenchContribution2(WebSettingsLinkContribution.ID, WebSettingsLinkContribution, WorkbenchPhase.Eventually);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.web.signOut', title: localize2('volt.web.signOut', "Sign Out of This Browser"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(): Promise<void> {
		await fetch('/api/workbench/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
		mainWindow.location.assign('/');
	}
});

//#endregion
