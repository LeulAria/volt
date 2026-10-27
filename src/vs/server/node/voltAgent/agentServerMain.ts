/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo, Socket } from 'net';
import minimist from 'minimist';
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../base/common/network.js';
import { extname, join, normalize, sep } from '../../../base/common/path.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../editor/common/services/languageFeaturesService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ConfigurationService } from '../../../platform/configuration/common/configurationService.js';
import { NativeParsedArgs } from '../../../platform/environment/common/argv.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import { NativeEnvironmentService } from '../../../platform/environment/node/environmentService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, LogLevel, parseLogLevel } from '../../../platform/log/common/log.js';
import { LogService } from '../../../platform/log/common/logService.js';
import { IMarkerService } from '../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../platform/markers/common/markerService.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NullPolicyService } from '../../../platform/policy/common/policy.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import product from '../../../platform/product/common/product.js';
import { VOLT_USAGE_PROVIDERS, VoltUsageProvider } from '../../../platform/voltUsage/common/voltUsage.js';
import { ResetCreditError } from '../../../platform/voltUsage/node/usageAccounts.js';
import { MACHINE_REDEEM_PATH, MACHINE_USAGE_PATH } from '../../../platform/voltUsage/node/usageMachines.js';
import { VoltUsageService } from '../../../platform/voltUsage/node/voltUsageService.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { RequestService } from '../../../platform/request/node/requestService.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { getResolvedShellEnv } from '../../../platform/shell/node/shellEnv.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { AgentServerCloseCode, ICollectionDelta, IAgentServerRuntimeInfo } from '../../../platform/voltAgentServer/common/protocol.js';
import { AgentServerProtocol, IClientCallOptions, tokensEqual } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { agentServerPaths, clearAgentServerRuntime, ensureAgentServerToken, isProcessAlive, preferredAgentServerPort, writeAgentServerRuntime } from '../../../platform/voltAgentServer/node/agentServerFiles.js';
import { acceptWebSocket } from '../../../platform/voltAgentServer/node/webSocket.js';
import { IVoltGitService } from '../../../platform/voltGit/common/voltGit.js';
import { VoltGitService } from '../../../platform/voltGit/node/voltGitService.js';
import { IVoltCodeIndexService } from '../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { VoltCodeIndexService } from '../../../platform/voltCodeIndex/node/voltCodeIndexService.js';
import { IVoltHostMcpService } from '../../../platform/voltHostMcp/common/voltHostMcp.js';
import { VoltHostMcpService } from '../../../platform/voltHostMcp/node/voltHostMcpService.js';
import { IVoltStdioService } from '../../../platform/voltStdio/common/voltStdio.js';
import { VoltStdioService } from '../../../platform/voltStdio/node/voltStdioService.js';
import { AgentTurnHostContribution } from '../../../workbench/contrib/voltAgent/browser/orchestration/agentTurnHost.js';
import { AgentThreadToolService } from '../../../workbench/contrib/voltAgent/browser/orchestration/agentThreadToolService.js';
import { IAgentChatForkService } from '../../../workbench/contrib/voltAgent/browser/orchestration/agentChatFork.js';
import { AgentChatSearchService, IAgentChatSearchService } from '../../../workbench/contrib/voltAgent/browser/search/agentChatSearchService.js';
import { AgentRunGroupService } from '../../../workbench/contrib/voltAgent/browser/runGroups/agentRunGroupService.js';
import { IAgentRunGroupService } from '../../../workbench/services/voltRuntime/common/runGroups/runGroups.js';
import { AgentWorkspaceMover } from '../../../workbench/contrib/voltAgent/browser/orchestration/agentWorkspaceMover.js';
import { CHECKPOINT_BEGIN_TURN_COMMAND_ID, IAgentCheckpointService } from '../../../workbench/contrib/voltAgent/browser/review/agentCheckpointService.js';
import { IAgentEditsService } from '../../../workbench/contrib/voltAgent/browser/review/agentEditsService.js';
import { IAgentWorkspaceService } from '../../../workbench/contrib/voltAgent/browser/workspace/agentWorkspace.js';
import { VoltHostMcpBridge } from '../../../workbench/contrib/voltAgent/common/voltHostMcpBridge.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { ISearchService } from '../../../workbench/services/search/common/search.js';
import { ITextFileService } from '../../../workbench/services/textfile/common/textfiles.js';
import { AgentWorktreeService } from '../../../workbench/services/voltRuntime/browser/git/agentWorktreeService.js';
import { AgentWorktreeSetupService } from '../../../workbench/services/voltRuntime/browser/git/agentWorktreeSetupService.js';
import { VoltBrowserAccessService } from '../../../workbench/services/voltRuntime/browser/browserAccessService.js';
import { VoltMemoryService } from '../../../workbench/services/voltRuntime/browser/memory/voltMemoryService.js';
import { IVoltBrowserAccessService } from '../../../workbench/services/voltRuntime/common/browserAccess.js';
import { IVoltMemoryService } from '../../../workbench/services/voltRuntime/common/memory/voltMemory.js';
import { VoltHooksService } from '../../../workbench/services/voltRuntime/browser/hooks/voltHooksService.js';
import { IVoltHooksService } from '../../../workbench/services/voltRuntime/common/hooks/voltHooks.js';
import { IWorkspaceTrustManagementService } from '../../../platform/workspace/common/workspaceTrust.js';
import { IAgentWorktreeSetupService } from '../../../workbench/services/voltRuntime/common/git/worktreeSetupPlan.js';
import { AgentHistoryService, setAgentHistoryAppender } from '../../../workbench/services/voltRuntime/browser/history/agentHistoryService.js';
import { VoltHostToolService } from '../../../workbench/services/voltRuntime/browser/host/hostToolService.js';
import { AgentOrchestratorService } from '../../../workbench/services/voltRuntime/browser/orchestration/agentOrchestratorService.js';
import { VoltSessionContextService } from '../../../workbench/services/voltRuntime/browser/sessionContextService.js';
import { VoltWindowScopeService } from '../../../workbench/services/voltWindowScope/common/voltWindowScopeService.js';
import { IVoltWindowScopeService } from '../../../workbench/services/voltWindowScope/common/voltWindowScope.js';
import { AgentRuntimeService } from '../../../workbench/services/voltRuntime/browser/voltRuntimeService.js';
import { IAgentWorktreeService } from '../../../workbench/services/voltRuntime/common/git/agentWorktree.js';
import { IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../workbench/services/voltRuntime/common/sessionContext.js';
import { RunModeTracker } from '../../../workbench/services/voltRuntime/common/hostSessionResolver.js';
import { AgentServerApi, createCollections } from './serverApi.js';
import { ServerAgentWorkspaceService } from './serverAgentWorkspace.js';
import { IAgentServerClients } from './serverClients.js';
import { ChildLedger } from '../../../platform/voltStdio/node/childLedger.js';
import { ServerCodeIntel, WindowFolders } from './serverCodeIntel.js';
import { restartWhenStale } from './serverDevRestart.js';
import { stopWhenIdle } from './serverIdleExit.js';
import { setBeaconProcessProbe } from '../../../workbench/services/voltRuntime/browser/jobs/workbenchBeacons.js';
import { setRuntimeCodeIntelFactory } from '../../../workbench/services/voltRuntime/browser/host/codeIntelHost.js';
import { ServerEditsJournal } from './serverEditsJournal.js';
import { importDesktopStorage, ServerCommandService, ServerConsoleLogger, ServerLifecycleService, ServerNotificationService, ServerPathService, ServerSearchService, ServerSecretStorageService, ServerStorageService, ServerTextModelService, serverTextFileService, ServerWorkspaceContextService, ServerWorkspaceTrustService } from './serverPlatformServices.js';
import { ServerSessionHost } from './serverSessionHost.js';
import { ServerTerminals } from './serverTerminals.js';
import { ServerRelay } from './serverRelay.js';
import { IVoltRelayService } from '../../../platform/voltRelay/common/voltRelay.js';
import { VoltRelayService } from '../../../platform/voltRelay/node/voltRelayService.js';
import { AutomationHookSync, hookedTriggers } from '../../../workbench/contrib/voltAgent/browser/automations/automationHookSync.js';
import { ServerProjectEnv } from './serverProjectEnv.js';
import { ServerDocuments } from './serverDocuments.js';
import { ServerAgentCheckpointService } from './serverCheckpoints.js';
import { ProjectEnvVoltStdioService } from '../../../workbench/services/voltRuntime/common/projectEnvStdio.js';
import { AutomationService } from '../../../workbench/contrib/voltAgent/browser/automations/automationService.js';
import { IAutomationService } from '../../../workbench/services/voltRuntime/common/automations/automations.js';
import { IPairingHttpContext, machineLabel, ServerPairing } from './serverPairing.js';
import { ServerWorkbench } from './serverWorkbench.js';
import { VOLT_SOURCE_CONTROL_HOSTS_SETTING } from '../../../platform/voltPullRequests/common/voltPrHosts.js';
import { IVoltPullRequestService } from '../../../platform/voltPullRequests/common/voltPullRequests.js';
import { VoltPullRequestService } from '../../../platform/voltPullRequests/node/voltPullRequestService.js';

/** Settings keys the server takes over from the desktop's storage the first time it starts. */
const IMPORTED_STORAGE_PREFIXES = ['volt.runtime.', 'volt.agent.', 'volt.pullRequests.', 'volt.access.'];
const IMPORT_DONE_KEY = 'volt.agentServer.importedDesktopStorage';
const SERVER_VERSION = '1';

interface IServerArgs {
	readonly userDataDir: string;
	readonly host: string;
	readonly port: number | undefined;
	readonly logLevel: LogLevel;
	readonly webRoot: string | undefined;
}

function parseArgs(argv: string[]): IServerArgs {
	const args = minimist(argv, { string: ['user-data-dir', 'host', 'port', 'log', 'web-root'] });
	const userDataDir = args['user-data-dir'] || process.env['VOLT_AGENT_SERVER_USER_DATA_DIR'];
	if (!userDataDir) {
		throw new Error('--user-data-dir is required');
	}
	return {
		userDataDir,
		host: args.host || process.env['VOLT_AGENT_SERVER_HOST'] || '127.0.0.1',
		port: args.port ? Number(args.port) : undefined,
		logLevel: parseLogLevel(args.log || process.env['VOLT_AGENT_SERVER_LOG'] || 'info') ?? LogLevel.Info,
		webRoot: args['web-root'] || undefined,
	};
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const paths = agentServerPaths(args.userDataDir);
	const disposables = new DisposableStore();
	const logService = disposables.add(new LogService(new ServerConsoleLogger(args.logLevel)));
	logService.info(`[volt agent server] starting (pid ${process.pid}) for ${args.userDataDir}`);

	const token = await ensureAgentServerToken(paths);
	const epoch = randomBytes(8).toString('hex');
	const pairing = disposables.add(await ServerPairing.load(paths.dir, logService));
	// The port is known once the server listens; pairing links are made after that.
	let httpContext: IPairingHttpContext = { port: 0, network: args.host !== '127.0.0.1' && args.host !== 'localhost', serverVersion: SERVER_VERSION };

	//#region Platform services

	const services = new ServiceCollection();
	const productService: IProductService = { _serviceBrand: undefined, ...product };
	const parsedArgs: NativeParsedArgs = { _: [], 'user-data-dir': args.userDataDir };
	const environmentService = new NativeEnvironmentService(parsedArgs, productService);
	const fileService = disposables.add(new FileService(logService));
	const diskProvider = disposables.add(new DiskFileSystemProvider(logService));
	disposables.add(fileService.registerProvider(Schemas.file, diskProvider));
	// The desktop addresses its user data dir with this scheme; on disk it is the same folder.
	disposables.add(fileService.registerProvider(Schemas.vscodeUserData, diskProvider));
	const configurationService = disposables.add(new ConfigurationService(joinPath(environmentService.userRoamingDataHome, 'settings.json'), fileService, new NullPolicyService(), logService));
	await configurationService.initialize();
	const storageService = disposables.add(new ServerStorageService(paths.storageDir));
	await storageService.initialize();
	if (!storageService.getBoolean(IMPORT_DONE_KEY, StorageScope.APPLICATION, false)) {
		const imported = await importDesktopStorage(storageService, args.userDataDir, IMPORTED_STORAGE_PREFIXES).catch(err => {
			logService.warn('[volt agent server] could not import the desktop settings', err);
			return 0;
		});
		storageService.store(IMPORT_DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		logService.info(`[volt agent server] imported ${imported} settings from the desktop`);
	}
	const secretStorage = disposables.add(new ServerSecretStorageService(`Volt Agent Server (${paths.label})`, join(paths.dir, 'secrets.json')));
	const lifecycleService = disposables.add(new ServerLifecycleService());
	const resolveEnv = () => getResolvedShellEnv(configurationService, logService, { _: [] }, process.env)
		.then(resolved => ({ ...process.env, ...resolved }))
		.catch(err => {
			logService.warn('[volt agent server] could not resolve the shell environment', err);
			return process.env;
		});
	const notificationService = new ServerNotificationService(logService);

	services.set(ILogService, logService);
	services.set(IProductService, productService);
	services.set(IEnvironmentService, environmentService);
	services.set(INativeEnvironmentService, environmentService);
	services.set(IFileService, fileService);
	services.set(IConfigurationService, configurationService);
	services.set(IStorageService, storageService);
	services.set(ISecretStorageService, secretStorage);
	services.set(ILifecycleService, lifecycleService);
	services.set(IRequestService, new SyncDescriptor(RequestService, ['local']));
	services.set(IWorkspaceContextService, new ServerWorkspaceContextService());
	services.set(IPathService, new ServerPathService());
	services.set(ISearchService, new ServerSearchService() as unknown as ISearchService);
	services.set(ITextFileService, serverTextFileService as unknown as ITextFileService);
	services.set(IMarkerService, new MarkerService());
	services.set(ITextModelService, new ServerTextModelService() as unknown as ITextModelService);
	services.set(ILanguageFeaturesService, new LanguageFeaturesService());
	services.set(INotificationService, notificationService as unknown as INotificationService);
	services.set(ICommandService, new SyncDescriptor(ServerCommandService));
	// Agent CLIs and commands a killed server left running would otherwise run forever, unowned.
	const childrenFile = join(paths.dir, 'children.json');
	const reaped = await ChildLedger.reapOrphans(childrenFile);
	if (reaped) {
		logService.info(`[volt agent server] stopped ${reaped} agent process group(s) the previous server left running`);
	}
	const childLedger = disposables.add(new ChildLedger(childrenFile));
	const stdioService = disposables.add(new VoltStdioService(logService, configurationService, args.userDataDir, childLedger));
	// Project Settings > Environment reaches what runs here too (windows send the settings; ServerProjectEnv).
	services.set(IVoltStdioService, new ProjectEnvVoltStdioService(stdioService));
	services.set(IVoltGitService, disposables.add(new VoltGitService(resolveEnv, logService, { shadowRoot: join(args.userDataDir, 'volt-checkpoints') })));
	services.set(IVoltHostMcpService, disposables.add(new VoltHostMcpService(logService)));
	// The phone's git and pull request screens (ServerGit), and the browser workbench's own channel, share one.
	const pullRequests = disposables.add(new VoltPullRequestService(resolveEnv, logService, 'gh', {
		hostSettings: () => configurationService.getValue(VOLT_SOURCE_CONTROL_HOSTS_SETTING),
	}));
	services.set(IVoltPullRequestService, pullRequests);
	// Its own index folder: the desktop's index process may be writing to the desktop one.
	const codeIndex = disposables.add(new VoltCodeIndexService(join(args.userDataDir, 'volt-index-server'), logService));
	services.set(IVoltCodeIndexService, codeIndex);
	// The relay connection and the local webhook URL live here (the main process leaves them alone in this mode).
	const relay = disposables.add(new VoltRelayService(args.userDataDir, logService));
	services.set(IVoltRelayService, relay);

	//#endregion

	//#region Protocol and the hosted agent services

	const sendDelta = new Emitter<ICollectionDelta>();
	disposables.add(sendDelta);
	const collections = createCollections(delta => sendDelta.fire(delta));
	const protocol = disposables.add(new AgentServerProtocol({
		token,
		authorize: deviceToken => pairing.authorize(deviceToken),
		epoch,
		serverVersion: SERVER_VERSION,
		pid: process.pid,
		snapshot: () => ({ collections: Object.fromEntries([...collections].map(([name, col]) => [name, col.snapshot()])) }),
	}));
	disposables.add(sendDelta.event(delta => protocol.publish('col', delta)));
	const clientsChanged = disposables.add(new Emitter<void>());
	disposables.add(protocol.onDidChangeClients(() => {
		clientsChanged.fire();
		for (const client of protocol.listClients()) {
			if (client.deviceId) {
				pairing.touch(client.deviceId);
			}
		}
	}));
	// Set once the session host exists: which connections have a chat open.
	let holdersOf: (sessionId: string) => ReadonlySet<number> = () => new Set();
	const clients: IAgentServerClients = {
		_serviceBrand: undefined,
		onDidChange: clientsChanged.event,
		list: () => protocol.listClients(),
		has: capability => !!protocol.clientWith(capability),
		call: <T>(capability: Parameters<AgentServerProtocol['callClient']>[0], method: string, ...params: unknown[]) => protocol.callClient<T>(capability, method, params),
		callWith: <T>(capability: Parameters<AgentServerProtocol['callClient']>[0], options: IClientCallOptions, method: string, ...params: unknown[]) => protocol.callClient<T>(capability, method, params, options),
		callForChat: <T>(capability: Parameters<AgentServerProtocol['callClient']>[0], sessionId: string | undefined, method: string, ...params: unknown[]) => {
			const holders = sessionId ? holdersOf(sessionId) : undefined;
			return protocol.callClient<T>(capability, method, params, holders?.size ? { prefer: connectionId => holders.has(connectionId) } : undefined);
		},
		holders: sessionId => holdersOf(sessionId),
	};
	services.set(IAgentServerClients, clients);
	// Its chat-ownership beacons name this process, so the next server takes over at once after a crash.
	setBeaconProcessProbe({ pid: process.pid, alive: isProcessAlive });
	// Language servers live in a window: the runtime's code tools ask the one that has the file's folder open.
	const windowFolders = new WindowFolders();
	disposables.add(protocol.registerMethod('codeIntel.setFolders', (ctx, folders) => {
		if (ctx.client.role === 'owner') {
			windowFolders.set(ctx.client.connectionId, folders);
		}
		return true;
	}));
	disposables.add(protocol.onDidChangeClients(() => windowFolders.retain(new Set(protocol.listClients().map(client => client.connectionId)))));
	setRuntimeCodeIntelFactory(() => new ServerCodeIntel(clients, configurationService, fileService, windowFolders));
	disposables.add(notificationService.onDidNotify(notification => protocol.publish('server', {
		kind: 'notification',
		severity: notification.severity,
		message: typeof notification.message === 'string' ? notification.message : String(notification.message),
	})));

	services.set(IWorkspaceTrustManagementService, new ServerWorkspaceTrustService() as unknown as IWorkspaceTrustManagementService);
	services.set(IVoltHooksService, new SyncDescriptor(VoltHooksService));
	services.set(IVoltHostToolService, new SyncDescriptor(VoltHostToolService));
	// The server has no windows: it keeps and lists every chat and project.
	services.set(IVoltWindowScopeService, new SyncDescriptor(VoltWindowScopeService, [undefined, undefined, undefined]));
	services.set(IVoltSessionContextService, new SyncDescriptor(VoltSessionContextService));
	// Chat logs are on this machine's disk: a turn appends its records (synced) instead of rewriting the log.
	setAgentHistoryAppender(appendDurably);
	services.set(IAgentHistoryService, new SyncDescriptor(AgentHistoryService));
	services.set(IAgentWorktreeService, new SyncDescriptor(AgentWorktreeService));
	services.set(IAgentRuntimeService, new SyncDescriptor(AgentRuntimeService));
	services.set(IAgentOrchestratorService, new SyncDescriptor(AgentOrchestratorService));
	services.set(IAgentWorkspaceService, new SyncDescriptor(ServerAgentWorkspaceService));
	// The thread tools (send to, wait for, fork and search other chats) and what they use: served
	// here so agents coordinating chats work with no window open.
	services.set(IAgentChatSearchService, new SyncDescriptor(AgentChatSearchService));
	services.set(IAgentRunGroupService, new SyncDescriptor(AgentRunGroupService));
	services.set(IAgentChatForkService, new SyncDescriptor(AgentThreadToolService));
	// It watches each chat's work tree itself (the server has no workspace folders), so unchanged projects reuse the last snapshot.
	services.set(IAgentCheckpointService, new SyncDescriptor(ServerAgentCheckpointService));
	services.set(IAgentWorktreeSetupService, new SyncDescriptor(AgentWorktreeSetupService));
	services.set(IVoltBrowserAccessService, new SyncDescriptor(VoltBrowserAccessService));
	services.set(IVoltMemoryService, new SyncDescriptor(VoltMemoryService));
	// Scheduled automations fire here, so they run with no window open (windows claim the same slots, so each runs once).
	services.set(IAutomationService, new SyncDescriptor(AutomationService));

	const instantiationService = disposables.add(new InstantiationService(services, true));
	services.set(IInstantiationService, instantiationService);
	// Before any run resumes: the commands it starts get their project's environment.
	disposables.add(instantiationService.createInstance(ServerProjectEnv, protocol));
	// And the agents read the windows' unsaved changes (their edits go into those buffers).
	disposables.add(instantiationService.createInstance(ServerDocuments, protocol));

	const editsJournal = disposables.add(instantiationService.createInstance(ServerEditsJournal, join(paths.dir, 'edits-journal.json'), collections.get('edits')!));
	await editsJournal.load();
	services.set(IAgentEditsService, editsJournal as unknown as IAgentEditsService);

	// The turn host asks for a checkpoint before every turn.
	disposables.add(CommandsRegistry.registerCommand(CHECKPOINT_BEGIN_TURN_COMMAND_ID, async (accessor, request: { sessionId?: string; turnId?: string } | undefined) => {
		if (request?.sessionId && request.turnId) {
			await accessor.get(IAgentCheckpointService).beginTurn(request.sessionId, request.turnId);
		}
	}));

	const sessionHost = disposables.add(instantiationService.createInstance(ServerSessionHost, data => protocol.publish('session', data)));
	holdersOf = sessionId => sessionHost.holders(sessionId);
	const [history, orchestrator] = instantiationService.invokeFunction(accessor => [accessor.get(IAgentHistoryService), accessor.get(IAgentOrchestratorService)] as const);
	await history.whenReady;
	await orchestrator.whenReady;
	disposables.add(instantiationService.createInstance(AgentTurnHostContribution));
	// Moves to another checkout run here: a window's mover does not reach the server's orchestrator.
	disposables.add(instantiationService.createInstance(AgentWorkspaceMover));
	instantiationService.invokeFunction(accessor => accessor.get(IAgentChatForkService));
	// The browser menu's per-chat "Let Agents Use the Browser" lives in a window's storage: it sends its copy.
	instantiationService.invokeFunction(accessor => {
		const browserAccess = accessor.get(IVoltBrowserAccessService);
		disposables.add(protocol.registerMethod('browserAccess.setChoices', (ctx, choices) => {
			// A paired phone must not lift a block the user set on this computer.
			if (ctx.client.role !== 'owner') {
				throw Object.assign(new Error('Only Volt on this computer can change browser access.'), { code: 'Forbidden' });
			}
			const next: Record<string, boolean> = {};
			for (const [sessionId, allowed] of Object.entries(choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {})) {
				if (typeof allowed === 'boolean') {
					next[sessionId] = allowed;
				}
			}
			browserAccess.setChatChoices(next);
			return true;
		}));
	});
	disposables.add(instantiationService.createInstance(VoltHostMcpBridge));
	// Mode and folder per chat for the host tools (a window's browser automation did this).
	instantiationService.invokeFunction(accessor => accessor.get(IVoltHostToolService).setSessionResolver(disposables.add(new RunModeTracker(accessor.get(IAgentRuntimeService)))));
	disposables.add(instantiationService.createInstance(AgentServerApi, protocol, collections, sessionHost, editsJournal, async (secrets: Record<string, string>) => {
		const imported: string[] = [];
		for (const [key, value] of Object.entries(secrets)) {
			if (typeof value === 'string' && value && !await secretStorage.get(key)) {
				await secretStorage.set(key, value);
				imported.push(key);
			}
		}
		if (imported.length) {
			logService.info(`[volt agent server] imported ${imported.length} provider key(s) from the desktop`);
		}
		return imported;
	}));
	// The agents' terminals run here, in the server's own pty: dev servers outlive every window.
	const terminals = disposables.add(instantiationService.createInstance(ServerTerminals, protocol, collections.get('terminals')!, join(paths.dir, 'terminals.json'), resolveEnv, childLedger));
	const automations = instantiationService.invokeFunction(accessor => accessor.get(IAutomationService));
	void automations.whenReady.catch(err => logService.warn('[volt agent server] automations did not load', err));
	// Webhook triggers run here: deliveries the relay held while nothing was connected, and ones posted to the local URL.
	disposables.add(new ServerRelay(protocol, relay));
	disposables.add(instantiationService.createInstance(AutomationHookSync));
	const ownerOnly = (role: string) => {
		if (role !== 'owner') {
			throw Object.assign(new Error('Only Volt on this computer can pair or remove devices.'), { code: 'Forbidden' });
		}
	};
	disposables.add(protocol.registerMethods('pairing', {
		createCode: ctx => {
			ownerOnly(ctx.client.role);
			return pairing.createCode(httpContext);
		},
		environment: () => pairing.descriptor(httpContext),
		devices: ctx => pairing.list(new Set(protocol.listClients().map(client => client.deviceId).filter((id): id is string => !!id)), ctx.client.deviceId),
		rename: (ctx, id, label) => {
			if (ctx.client.deviceId !== id) {
				ownerOnly(ctx.client.role);
			}
			return pairing.rename(String(id), String(label ?? ''));
		},
		revoke: async (ctx, id) => {
			// A device may always remove itself (sign out); only the owner removes others.
			if (ctx.client.deviceId !== id) {
				ownerOnly(ctx.client.role);
			}
			const revoked = await pairing.revoke(String(id));
			if (revoked) {
				setTimeout(() => protocol.closeWhere(client => client.deviceId === id, AgentServerCloseCode.Unauthorized, 'device removed'), 50);
			}
			return revoked;
		},
	}));
	disposables.add(protocol.registerMethods('server', {
		info: () => ({ pid: process.pid, epoch, version: SERVER_VERSION, environmentId: pairing.environmentId, userDataDir: args.userDataDir, clients: protocol.listClients() }),
		shutdown: ctx => {
			ownerOnly(ctx.client.role);
			setTimeout(() => void stop(0), 10);
			return true;
		},
	}));

	//#endregion

	//#region HTTP

	// The checkout in dev, the app's Resources/app when packaged (where this module is bundled into out/).
	const appRoot = FileAccess.asFileUri('').fsPath.replace(/[\\/]out[\\/]?$/, '');
	const webRoot = args.webRoot ?? join(appRoot, 'out-volt-web');
	// Usage and limits: the browser workbench's Usage page, and other machines reading this one's (`/api/usage`).
	const usage = new VoltUsageService(resolveEnv, logService, join(args.userDataDir, 'volt-usage'));
	// Volt's workbench for browsers (VS Code's server, started with the first page load).
	const workbench = disposables.add(instantiationService.createInstance(ServerWorkbench, {
		userDataDir: args.userDataDir,
		serverDir: paths.dir,
		label: machineLabel(),
		environmentId: () => pairing.environmentId,
		authorize: deviceToken => pairing.authorize(deviceToken),
		resolveEnv,
		git: instantiationService.invokeFunction(accessor => accessor.get(IVoltGitService)),
		codeIndex,
		sendFile,
		usage,
		pullRequests,
	}));
	httpContext = { ...httpContext, workbench: workbench.available };
	const server = http.createServer((req, res) => void serveHttp(req, res, webRoot, token, epoch, pairing, workbench, httpContext, usage, logService));
	server.on('upgrade', (req, socket: Socket) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname !== '/ws' && workbench.handleUpgrade(req, socket)) {
			return;
		}
		if (url.pathname !== '/ws' || !originAllowed(req.headers.origin, req.headers.host)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			return;
		}
		const ws = acceptWebSocket(req, socket);
		if (ws) {
			protocol.accept(ws);
		}
	});
	const port = await listen(server, args.host, args.port ?? preferredAgentServerPort(args.userDataDir), args.port === undefined);
	httpContext = { ...httpContext, port };
	const info: IAgentServerRuntimeInfo = {
		version: 1,
		pid: process.pid,
		host: args.host,
		port,
		epoch,
		serverVersion: SERVER_VERSION,
		startedAt: Date.now(),
		appRoot,
		...(product.commit ? { commit: product.commit } : {}),
	};
	await writeAgentServerRuntime(paths, info);
	logService.info(`[volt agent server] listening on http://${args.host}:${port} (epoch ${epoch})`);

	//#endregion

	let stopping = false;
	async function stop(code: number): Promise<void> {
		if (stopping) {
			return;
		}
		stopping = true;
		logService.info('[volt agent server] stopping');
		protocol.closeAll();
		server.close();
		try {
			await lifecycleService.shutdown();
			// Its terminals stop with the server: the next one lists them as stopped, restartable.
			await terminals.saveRecords();
			await editsJournal.flush();
			await history.flushAll();
			await storageService.close();
		} catch (err) {
			logService.error('[volt agent server] error while stopping', err);
		}
		await clearAgentServerRuntime(paths, process.pid).catch(() => undefined);
		disposables.dispose();
		process.exit(code);
	}
	disposables.add(toDisposable(() => server.close()));
	process.on('SIGTERM', () => void stop(0));
	process.on('SIGINT', () => void stop(0));
	const sessions = collections.get('sessions')!;
	const runsIdle = () => sessions.keys().every(key => (sessions.get(key) as { activeRun?: { status?: string } } | undefined)?.activeRun?.status !== 'running');
	if (process.env['VSCODE_DEV'] && !product.commit) {
		disposables.add(restartWhenStale(join(appRoot, 'out'), runsIdle, () => void stop(0), logService));
	}
	const busy = () => terminals.hasLive()
		? 'an agent terminal is running'
		: automations.list().some(automation => automation.enabled && automation.triggers.some(trigger => trigger.provider === 'schedule'))
			? 'an automation is scheduled'
			: hookedTriggers(automations.list()).some(({ automation }) => automation.enabled)
				? 'an automation waits for webhooks'
				: undefined;
	disposables.add(stopWhenIdle({ clients: () => protocol.listClients().length, runsIdle, orchestrator, network: args.host !== '127.0.0.1' && args.host !== 'localhost', busy, stop: () => void stop(0), logService }));
	process.on('uncaughtException', err => logService.error('[volt agent server] uncaught exception', err));
	process.on('unhandledRejection', err => logService.error('[volt agent server] unhandled rejection', err));
}

/** Listens on `preferred`, or on any free port when it is taken and `fallback` allows. */
function listen(server: http.Server, host: string, preferred: number, fallback: boolean): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			if (fallback && err.code === 'EADDRINUSE') {
				server.removeListener('error', onError);
				server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
				server.once('error', reject);
				return;
			}
			reject(err);
		};
		server.on('error', onError);
		server.listen(preferred, host, () => {
			server.removeListener('error', onError);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

/**
 * The socket accepts the desktop renderer, the web app served here, and Node clients (no Origin).
 * Every connection still has to present the token; this only stops other web pages from trying.
 */
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
	if (!origin) {
		return true;
	}
	if (origin === 'vscode-file://vscode-app') {
		return true;
	}
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ttf': 'font/ttf',
	'.woff2': 'font/woff2',
	'.map': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.mp3': 'audio/mpeg',
	'.otf': 'font/otf',
	'.scm': 'text/plain; charset=utf-8',
};

/** Text assets worth compressing; the web IDE's editor bundle shrinks to about a quarter. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.webmanifest', '.ttf', '.otf', '.txt', '.wasm', '.scm']);
/** Compressed copies of the served files, by path and modification time (the app is a few MB). */
const compressed = new Map<string, { readonly mtime: number; readonly encoding: 'br' | 'gzip'; readonly data: Promise<Buffer> }>();

function preferredEncoding(header: string | string[] | undefined): 'br' | 'gzip' | undefined {
	const value = Array.isArray(header) ? header.join(',') : header ?? '';
	return /\bbr\b/.test(value) ? 'br' : /\bgzip\b/.test(value) ? 'gzip' : undefined;
}

function compressedCopy(file: string, mtime: number, data: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
	const key = `${encoding}:${file}`;
	const hit = compressed.get(key);
	if (hit && hit.mtime === mtime) {
		return hit.data;
	}
	const result = new Promise<Buffer>((resolve, reject) => encoding === 'br'
		? zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }, (err, out) => err ? reject(err) : resolve(out))
		: zlib.gzip(data, { level: 7 }, (err, out) => err ? reject(err) : resolve(out)));
	compressed.set(key, { mtime, encoding, data: result });
	result.catch(() => compressed.delete(key));
	return result;
}

async function serveHttp(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string, token: string, epoch: string, pairing: ServerPairing, workbench: ServerWorkbench, ctx: IPairingHttpContext, usage: VoltUsageService, logService: ILogService): Promise<void> {
	if (await pairing.handleHttp(req, res, ctx)) {
		return;
	}
	if (req.url?.startsWith(MACHINE_USAGE_PATH)) {
		await serveUsage(req, res, bearer => tokensEqual(bearer, token) || !!pairing.authorize(bearer), usage, logService);
		return;
	}
	if (await workbench.handleHttp(req, res)) {
		return;
	}
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname === '/health') {
		// Answers only with the token, so a stray process on the port can't pass for the server.
		const ok = req.headers.authorization === `Bearer ${token}`;
		res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(ok ? { ok: true, pid: process.pid, epoch } : { ok: false }));
		return;
	}
	const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
	const file = normalize(join(webRoot, relative));
	if (!file.startsWith(webRoot + sep)) {
		res.writeHead(403).end();
		return;
	}
	// The web app routes on the client (/pair, /t/<chat>): a path without an extension is the app.
	// Hashed bundles never change under their name: cached for good. Everything else (the page,
	// the manifest) revalidates, so a rebuilt app never mixes with an older bundle.
	if (!await sendFile(req, res, extname(file) ? file : join(webRoot, 'index.html'), relative.startsWith('assets/'))) {
		res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found. The web app is built into ${webRoot}.`);
	}
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(body));
}

/**
 * Another machine's Volt reading this one's usage: `GET /api/usage` answers this machine's own
 * usage and limits, `POST /api/usage/redeem` spends a reset credit for a login held here. Both
 * need the server's token or a paired device's, like the socket.
 */
async function serveUsage(req: http.IncomingMessage, res: http.ServerResponse, authorized: (bearer: string) => boolean, usage: VoltUsageService, logService: ILogService): Promise<void> {
	const header = req.headers.authorization ?? '';
	if (!header.startsWith('Bearer ') || !authorized(header.slice('Bearer '.length))) {
		sendJson(res, 401, { error: 'unauthorized' });
		return;
	}
	try {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === MACHINE_USAGE_PATH && req.method === 'GET') {
			sendJson(res, 200, await usage.getMachineReport(url.searchParams.get('force') === '1'));
			return;
		}
		if (url.pathname === MACHINE_REDEEM_PATH && req.method === 'POST') {
			const body = JSON.parse(await readBody(req, 4096)) as { provider?: unknown; accountId?: unknown };
			if (!VOLT_USAGE_PROVIDERS.includes(body.provider as VoltUsageProvider) || typeof body.accountId !== 'string') {
				sendJson(res, 400, { error: 'Bad request.', settled: true });
				return;
			}
			sendJson(res, 200, { outcome: await usage.redeemLocal(body.provider as VoltUsageProvider, body.accountId) });
			return;
		}
		sendJson(res, 404, { error: 'Not found.' });
	} catch (err) {
		logService.warn('[volt agent server] usage request failed', err);
		sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), settled: err instanceof ResetCreditError ? err.settled : false });
	}
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk: string) => {
			body += chunk;
			if (body.length > limit) {
				reject(new Error('Request too large.'));
				req.destroy();
			}
		});
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

/**
 * Sends a file with an ETag, compressed when the browser takes it, and cached for good when
 * `immutable` (its name changes with its content). Resolves false when there is no such file.
 */
async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, served: string, immutable: boolean): Promise<boolean> {
	try {
		const stat = await fs.stat(served);
		if (!stat.isFile()) {
			return false;
		}
		const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
		const headers: Record<string, string> = {
			'Content-Type': MIME[extname(served)] ?? 'application/octet-stream',
			'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
			'X-Content-Type-Options': 'nosniff',
			'ETag': etag,
			'Vary': 'Accept-Encoding',
		};
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, headers).end();
			return true;
		}
		let data = await fs.readFile(served);
		const encoding = COMPRESSIBLE.has(extname(served)) && data.length > 1024 ? preferredEncoding(req.headers['accept-encoding']) : undefined;
		if (encoding) {
			data = await compressedCopy(served, stat.mtimeMs, data, encoding);
			headers['Content-Encoding'] = encoding;
		}
		headers['Content-Length'] = String(data.length);
		res.writeHead(200, headers);
		res.end(req.method === 'HEAD' ? undefined : data);
		return true;
	} catch {
		return false;
	}
}

/** Appends to a file and waits until the bytes are on disk. */
async function appendDurably(file: URI, text: string): Promise<void> {
	const handle = await fs.open(file.fsPath, 'a');
	try {
		await handle.appendFile(text, 'utf8');
		await handle.datasync();
	} finally {
		await handle.close();
	}
}
