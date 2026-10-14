/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { toAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IVoltAgentServerMainService, VOLT_AGENT_SERVER_CHANNEL_NAME } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { IWebSocketLike } from '../../../../platform/voltAgentServer/common/connection.js';
import { DEFAULT_TOPICS } from '../../../../platform/voltAgentServer/common/protocol.js';
import { VOLT_USAGE_SHARE_MACHINE_COMMAND_ID } from '../../../../platform/voltUsage/common/voltUsage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AGENT_SERVER_ENABLED_SETTING, AgentServerClient, IAgentServerClientService } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { RemoteAgentHistoryService } from '../../../services/voltAgentServer/common/remoteAgentHistoryService.js';
import { RemoteAgentOrchestratorService } from '../../../services/voltAgentServer/common/remoteAgentOrchestratorService.js';
import { RemoteAgentRuntimeService } from '../../../services/voltAgentServer/common/remoteAgentRuntimeService.js';
import { RemoteVoltHostToolService } from '../../../services/voltAgentServer/common/remoteVoltHostToolService.js';
import { RemoteVoltSessionContextService } from '../../../services/voltAgentServer/common/remoteVoltSessionContextService.js';
import { AgentHistoryService } from '../../../services/voltRuntime/browser/history/agentHistoryService.js';
import { VoltHostToolService } from '../../../services/voltRuntime/browser/host/hostToolService.js';
import { AgentOrchestratorService } from '../../../services/voltRuntime/browser/orchestration/agentOrchestratorService.js';
import { VoltSessionContextService } from '../../../services/voltRuntime/browser/sessionContextService.js';
import { AgentRuntimeService } from '../../../services/voltRuntime/browser/voltRuntimeService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IProviderProfile, secretKeyForProfile } from '../../../services/voltRuntime/common/profiles.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { setAgentSessionControlFactory } from '../browser/editor/agentEditorInput.js';
import { RemoteAgentSessionControl } from '../browser/editor/remoteAgentSessionControl.js';
import { AgentCheckpointService, IAgentCheckpointService } from '../browser/review/agentCheckpointService.js';
import { IAgentEditsService } from '../browser/review/agentEditsService.js';
import { RemoteAgentCheckpointService } from '../browser/review/remoteAgentCheckpointService.js';
import { AgentPullRequestService, IAgentPullRequestService } from '../browser/pullRequests/agentPullRequestService.js';
import { RemotePullRequestService } from '../browser/pullRequests/remotePullRequestService.js';
import { IAgentSurfaceDraft, IAgentWorkspaceService } from '../browser/workspace/agentWorkspace.js';
import { AgentEditsJournalEntry } from '../common/agentEditsJournal.js';

registerMainProcessRemoteService(IVoltAgentServerMainService, VOLT_AGENT_SERVER_CHANNEL_NAME);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agentServer',
	title: localize('voltAgentServer', "Volt Agent Server"),
	type: 'object',
	properties: {
		[AGENT_SERVER_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltAgentServer.enabled', "Run agents in the Volt agent server, a background process that keeps them working after Volt quits and serves the web app. Takes effect after a restart."),
		},
	},
});

function agentServerEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(AGENT_SERVER_ENABLED_SETTING) === true;
}

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
			client: { kind: 'desktop', id: generateUuid(), capabilities: ['browser', 'surface'], topics: [...DEFAULT_TOPICS, 'runtime.event'] },
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

registerSingleton(IAgentRuntimeService, <never>eitherLocalOrRemote(AgentRuntimeService, RemoteAgentRuntimeService), InstantiationType.Delayed);
registerSingleton(IAgentOrchestratorService, <never>eitherLocalOrRemote(AgentOrchestratorService, RemoteAgentOrchestratorService), InstantiationType.Delayed);
registerSingleton(IAgentHistoryService, <never>eitherLocalOrRemote(AgentHistoryService, RemoteAgentHistoryService), InstantiationType.Delayed);
registerSingleton(IVoltSessionContextService, <never>eitherLocalOrRemote(VoltSessionContextService, RemoteVoltSessionContextService), InstantiationType.Delayed);
registerSingleton(IVoltHostToolService, <never>eitherLocalOrRemote(VoltHostToolService, RemoteVoltHostToolService), InstantiationType.Delayed);
registerSingleton(IAgentCheckpointService, <never>eitherLocalOrRemote(AgentCheckpointService, RemoteAgentCheckpointService), InstantiationType.Delayed);
registerSingleton(IAgentPullRequestService, <never>eitherLocalOrRemote(AgentPullRequestService, RemotePullRequestService), InstantiationType.Delayed);

// Chats' transcripts come from the server's session controllers.
setAgentSessionControlFactory((input, instantiationService) => instantiationService.invokeFunction(accessor =>
	agentServerEnabled(accessor.get(IConfigurationService)) ? instantiationService.createInstance(RemoteAgentSessionControl, input) : undefined));

/** Commands the server may ask this window to run: the in-app browser's. */
const WINDOW_COMMANDS = new Set([AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID]);

/**
 * What a window does for the agent server: the things only a window can (the in-app browser,
 * opening a preview), handing over provider keys once, and applying the edits journal to the
 * Keep/Undo review.
 */
class AgentServerClientContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentServerClient';

	private readonly appliedEdits = new Set<string>();
	private applyingEdits = false;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (agentServerEnabled(configurationService)) {
			instantiationService.invokeFunction(accessor => this.start(accessor.get(IAgentServerClientService), accessor.get(ICommandService), accessor.get(IAgentWorkspaceService), accessor.get(ISecretStorageService), accessor.get(IAgentEditsService), accessor.get(INotificationService), accessor.get(ILogService)));
		}
	}

	private start(client: IAgentServerClientService, commands: ICommandService, workspace: IAgentWorkspaceService, secrets: ISecretStorageService, edits: IAgentEditsService, notifications: INotificationService, logService: ILogService): void {
		this._register(client.registerHandler('surface.open', (sessionId, draft, reuse) => {
			workspace.openSurface(String(sessionId), draft as IAgentSurfaceDraft, !!reuse);
			return true;
		}));
		this._register(client.registerHandler('command.execute', (id, ...args) => {
			if (typeof id !== 'string' || !WINDOW_COMMANDS.has(id)) {
				throw new Error(`This window does not run ${String(id)} for the agent server.`);
			}
			return commands.executeCommand(id, ...args);
		}));
		this._register(client.onDidResync(() => {
			void this.handOverKeys(client, secrets, logService);
			this.applyEdits(client, edits, logService);
		}));
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
		this._register(client.connection.onDidFail(failure => logService.error(`[volt agent server] connection refused (${failure.code}): ${failure.reason}`)));
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

registerWorkbenchContribution2(AgentServerClientContribution.ID, AgentServerClientContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.agentServer.openWebApp', title: localize2('voltAgentServer.openWebApp', "Open Agent Web App"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const nativeHost = accessor.get(INativeHostService);
		const notifications = accessor.get(INotificationService);
		try {
			// The token rides in the hash: the page keeps it for the tab and never sends it in a request.
			const endpoint = await mainService.ensureRunning();
			await nativeHost.openExternal(endpoint.webUrl);
		} catch (err) {
			notifications.error(localize('voltAgentServer.openFailed', "Could not start the Volt agent server: {0}", err instanceof Error ? err.message : String(err)));
		}
	}
});

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

/**
 * Lets Volt on the user's other computers read this one's usage and limits (Usage → Machines):
 * the agent server listens on the local network and the address with its token goes on the
 * clipboard, to paste there.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOLT_USAGE_SHARE_MACHINE_COMMAND_ID, title: localize2('voltUsage.shareMachineCommand', "Share This Machine's Usage"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<string | undefined> {
		const mainService = accessor.get(IVoltAgentServerMainService);
		const notifications = accessor.get(INotificationService);
		const dialogs = accessor.get(IDialogService);
		const clipboard = accessor.get(IClipboardService);
		try {
			let endpoint = await mainService.ensureRunning();
			if (!endpoint.network) {
				const { confirmed } = await dialogs.confirm({
					message: localize('voltUsage.shareConfirm', "Let your other computers read this machine's usage?"),
					detail: localize('voltUsage.shareDetail', "The Volt agent server will listen on your local network and restart; running turns stop and show as interrupted. The address includes a token that gives full access to this machine's agent server, so paste it only into your own computers."),
					primaryButton: localize({ key: 'voltUsage.shareButton', comment: ['&& denotes a mnemonic'] }, "&&Share"),
				});
				if (!confirmed) {
					return undefined;
				}
				endpoint = await mainService.setNetworkAccess(true);
			}
			if (!endpoint.pairingUrl) {
				notifications.error(localize('voltUsage.shareNoNetwork', "This machine has no local network address. Connect it to the same network as your other computers and try again."));
				return undefined;
			}
			await clipboard.writeText(endpoint.pairingUrl);
			notifications.notify({
				severity: Severity.Info,
				message: localize('voltUsage.shareCopied', "Copied this machine's address. On your other computer, open Usage → Limits → Add Machine and paste it."),
				actions: {
					secondary: [toAction({
						id: 'volt.usage.stopSharing',
						label: localize('voltUsage.stopSharing', "Stop Sharing"),
						run: () => mainService.setNetworkAccess(false),
					})],
				},
			});
			return endpoint.pairingUrl;
		} catch (err) {
			notifications.error(localize('voltUsage.shareFailed', "Could not share this machine: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}
});
