/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's workbench in a browser, served by the agent server (`/code/`). The page is the desktop's
// workbench with the agent server on: the agents, chats and history live in the agent server and
// this page is one more window on them. What the desktop's main process does for a window
// (processes, git, the folder picker, pull requests, usage) the agent server does here, over the
// workbench's remote connection.

import './media/voltWorkbenchWeb.css';
import './voltWebFolders.js';
import './voltWebTouch.js';
import { WebSpeechService } from './voltWebSpeech.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { BrandedService, IInstantiationService, ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { editorBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltAccountsService } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import { IWebSocketLike } from '../../../../../platform/voltAgentServer/common/connection.js';
import { DEFAULT_TOPICS } from '../../../../../platform/voltAgentServer/common/protocol.js';
import { IVoltAwakeService } from '../../../../../platform/voltAwake/common/voltAwake.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltExternalMcpService } from '../../../../../platform/voltExternalMcp/common/voltExternalMcp.js';
import { IVoltFsBrowseService, VOLT_FS_BROWSE_CHANNEL_NAME } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IVoltGitService, VOLT_GIT_CHANNEL_NAME } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltCodeIndexService, VOLT_CODE_INDEX_CHANNEL_NAME } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IVoltSkillsDirectoryService } from '../../../../../platform/voltMarketplace/common/voltMarketplace.js';
import { IVoltPullRequestService, VOLT_PULL_REQUEST_CHANNEL_NAME } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IVoltSpeechService } from '../../../../../platform/voltSpeech/common/voltSpeech.js';
import { IVoltStdioService, VOLT_STDIO_CHANNEL_NAME } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltUsageService, VOLT_USAGE_CHANNEL_NAME } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { SIDE_BAR_BACKGROUND, TITLE_BAR_ACTIVE_BACKGROUND } from '../../../../common/theme.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { AgentServerClient, IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { RemoteAgentHistoryService } from '../../../../services/voltAgentServer/common/remoteAgentHistoryService.js';
import { RemoteAgentOrchestratorService } from '../../../../services/voltAgentServer/common/remoteAgentOrchestratorService.js';
import { RemoteAgentRuntimeService } from '../../../../services/voltAgentServer/common/remoteAgentRuntimeService.js';
import { RemoteVoltHostToolService } from '../../../../services/voltAgentServer/common/remoteVoltHostToolService.js';
import { RemoteVoltSessionContextService } from '../../../../services/voltAgentServer/common/remoteVoltSessionContextService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { ProjectEnvVoltStdioService } from '../../../../services/voltRuntime/common/projectEnvStdio.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { setAgentSessionControlFactory } from '../editor/agentEditorInput.js';
import { RemoteAgentSessionControl } from '../editor/remoteAgentSessionControl.js';
import { IAgentCheckpointService } from '../review/agentCheckpointService.js';
import { IAgentEditsService } from '../review/agentEditsService.js';
import { RemoteAgentCheckpointService } from '../review/remoteAgentCheckpointService.js';
import { IVoltCanvasService, VoltCanvasService } from '../visuals/canvas/canvasService.js';
import { IAgentSurfaceDraft, IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { AgentEditsJournalEntry } from '../../common/agentEditsJournal.js';

// What the desktop also loads (its main file imports these after the agent services).
import '../pullRequests/agentPullRequests.contribution.js';
import '../trajectory/agentTrajectory.contribution.js';
import '../runGroups/agentRunGroups.contribution.js';
import '../orchestration/agentThreadToolService.js';
import '../orchestration/agentWorkspaceMover.js';
import '../orchestration/agentMoveChat.contribution.js';

/** What the agent server put in the page's configuration. */
interface IVoltPageConfiguration {
	readonly environmentId?: string;
	readonly wsPath?: string;
}

/** The web app's saved environments (it paired this browser; the page shares its origin). */
const CATALOG_KEY = 'volt.web.catalog';

function pageConfiguration(environmentService: IBrowserWorkbenchEnvironmentService): IVoltPageConfiguration {
	return (environmentService.options as { voltAgentServer?: IVoltPageConfiguration } | undefined)?.voltAgentServer ?? {};
}

/** This browser's device token for the agent server that served the page. */
function savedDeviceToken(environmentId: string | undefined): string | undefined {
	try {
		const catalog = JSON.parse(mainWindow.localStorage.getItem(CATALOG_KEY) ?? 'null') as { environments?: { environmentId?: string; token?: string; routes?: { baseUrl?: string }[] }[] } | null;
		const environments = Array.isArray(catalog?.environments) ? catalog.environments : [];
		const origin = mainWindow.location.origin;
		const match = environments.find(env => environmentId && env.environmentId === environmentId)
			?? environments.find(env => env.routes?.some(route => route.baseUrl === origin));
		return typeof match?.token === 'string' ? match.token : undefined;
	} catch {
		return undefined;
	}
}

/** The web app signs this browser in, then sends it back here. */
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
				const token = savedDeviceToken(config.environmentId);
				if (!token) {
					return undefined;
				}
				const scheme = mainWindow.location.protocol === 'https:' ? 'wss' : 'ws';
				return { url: `${scheme}://${mainWindow.location.host}${config.wsPath ?? '/ws'}`, token };
			},
			createSocket: url => new WebSocket(url) as unknown as IWebSocketLike,
			client: { kind: 'web', id: `workbench-${generateUuid()}`, capabilities: ['surface'], topics: [...DEFAULT_TOPICS, 'runtime.event'] },
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

registerSingleton(IVoltCanvasService, VoltCanvasService, InstantiationType.Delayed);

/**
 * What only the desktop app can do (keeping the Mac awake, dictation, the in-app browser, signing
 * in to Claude, the relay, the MCP bridge): its events never fire and its calls say why they fail,
 * except the members `answers` gives.
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
registerDesktopOnly(IVoltAccountsService, localize('volt.web.accounts', "Signing in to Claude accounts"));
registerDesktopOnly(IVoltExternalMcpService, localize('volt.web.externalMcp', "Connecting other agents"));
registerDesktopOnly(IVoltSkillsDirectoryService, localize('volt.web.skills', "The skills directory"));
// The relay reads as off, and asking for webhook deliveries waits, then finds none.
registerDesktopOnly(IVoltRelayService, localize('volt.web.relay', "The relay"), {
	getState: (): Promise<IVoltRelayState> => Promise.resolve({ status: 'off' }),
	nextDelivery: (waitMs: number) => new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), Math.max(1_000, waitMs))),
});

//#endregion

//#region What this page does for the agent server

/**
 * As a desktop window: opens the previews an agent asks for, applies the edits journal to the
 * Keep/Undo review, reconnects when the tab comes back or the network returns, and sends the
 * browser to sign in when it has no device token for this server.
 */
class WebAgentServerClientContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebAgentServerClient';

	private readonly appliedEdits = new Set<string>();
	private applyingEdits = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		instantiationService.invokeFunction(accessor => this.start(accessor));
	}

	private start(accessor: ServicesAccessor): void {
		const client = accessor.get(IAgentServerClientService);
		const workspace = accessor.get(IAgentWorkspaceService);
		const edits = accessor.get(IAgentEditsService);
		const notifications = accessor.get(INotificationService);
		const environmentService = accessor.get(IBrowserWorkbenchEnvironmentService);
		const logService = accessor.get(ILogService);
		// Made now so they listen from the first snapshot.
		accessor.get(IAgentRuntimeService);
		accessor.get(IVoltHostToolService);

		if (!savedDeviceToken(pageConfiguration(environmentService).environmentId)) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('volt.web.signIn', "This browser isn't signed in to Volt yet, so chats can't load."),
				actions: { primary: [{ id: 'volt.web.signIn', label: localize('volt.web.signInAction', "Sign In"), tooltip: '', class: undefined, enabled: true, run: () => mainWindow.location.assign(signInUrl()) }] },
				sticky: true,
			});
		}

		this._register(client.registerHandler('surface.open', (sessionId, draft, reuse) => {
			workspace.openSurface(String(sessionId), draft as IAgentSurfaceDraft, !!reuse);
			return true;
		}));
		this._register(client.onDidResync(() => this.applyEdits(client, edits, logService)));
		const editsScheduler = this._register(new RunOnceScheduler(() => this.applyEdits(client, edits, logService), 0));
		this._register(client.onDidChangeCollection(e => {
			if (e.col === 'edits') {
				editsScheduler.schedule();
			}
		}));
		const pendingScheduler = this._register(new RunOnceScheduler(() => client.send('edits.setPending', edits.getPendingFiles().map(file => ({ uri: file.uri, sessionId: file.sessionId }))), 200));
		this._register(edits.onDidChange(() => pendingScheduler.schedule()));
		this._register(edits.onDidResolve(resolution => client.send('edits.resolved', resolution)));
		this._register(client.onServerEvent(event => {
			const notice = event as { kind?: string; severity?: Severity; message?: string };
			if (notice.kind === 'notification' && notice.message) {
				notifications.notify({ severity: notice.severity ?? Severity.Info, message: notice.message });
			}
		}));
		this._register(client.connection.onDidFail(failure => {
			logService.error(`[volt agent server] connection refused (${failure.code}): ${failure.reason}`);
		}));

		// A tab in the background or a laptop that slept may hold a dead socket: reconnect when it is back.
		const reconnect = () => client.connection.reconnect();
		const onVisible = () => {
			if (mainWindow.document.visibilityState === 'visible') {
				reconnect();
			}
		};
		mainWindow.addEventListener('online', reconnect);
		mainWindow.document.addEventListener('visibilitychange', onVisible);
		this._register({
			dispose: () => {
				mainWindow.removeEventListener('online', reconnect);
				mainWindow.document.removeEventListener('visibilitychange', onVisible);
			}
		});
	}

	/** Applies new journal entries in order, then tells the server they are done. */
	private applyEdits(client: IAgentServerClientService, edits: IAgentEditsService, logService: ILogService): void {
		if (this.applyingEdits) {
			return;
		}
		const entries = client.mirror.entries<AgentEditsJournalEntry>('edits')
			.filter(([id]) => !this.appliedEdits.has(id))
			.sort(([a], [b]) => a.localeCompare(b));
		if (!entries.length) {
			return;
		}
		this.applyingEdits = true;
		void (async () => {
			const done: string[] = [];
			for (const [id, entry] of entries) {
				try {
					await edits.applyJournalEntry(entry);
				} catch (err) {
					logService.warn('[volt agent server] could not apply an edits journal entry', err);
				}
				this.appliedEdits.add(id);
				done.push(id);
			}
			client.send('edits.ack', done);
		})().finally(() => {
			this.applyingEdits = false;
			if (client.mirror.entries('edits').some(([id]) => !this.appliedEdits.has(id))) {
				this.applyEdits(client, edits, logService);
			}
		});
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

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.web.openLiteApp', title: localize2('volt.web.openLiteApp', "Open the Lightweight Web App"), category: localize2('volt', "Volt"), f1: true });
	}
	override run(): void {
		mainWindow.location.assign('/?lite=1');
	}
});

// The desktop's command, for the same entry points: pairing happens on the web app's Devices page.
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.pairDevice', title: localize2('voltAgentServer.pairDevice', "Pair a Phone or Browser..."), category: localize2('volt', "Volt"), f1: true });
	}
	override run(): void {
		mainWindow.open(new URL('/devices', mainWindow.location.origin).toString(), '_blank', 'noopener');
	}
});

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
