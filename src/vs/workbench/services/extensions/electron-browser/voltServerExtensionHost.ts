/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WebSocketRemoteConnection } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IVoltAgentServerMainService } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { IVoltExtensionHostTicket, VOLT_EXTHOST_TICKET_QUERY } from '../../../../platform/voltAgentServer/common/protocol.js';
import { extensionSandboxPlan } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { agentServerEnabled } from '../../voltAgentServer/common/agentServerClient.js';
import { IExtensionManifestPropertiesService } from '../common/extensionManifestPropertiesService.js';
import { ExtensionRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionRunningLocationTracker } from '../common/extensionRunningLocationTracker.js';
import { ExtensionHostExtensions, IExtensionHost } from '../common/extensions.js';
import { IRemoteExtensionHostDataProvider, RemoteExtensionHost } from '../common/remoteExtensionHost.js';
import { IVoltExtensionSandboxService, voltExtensionFacts } from '../common/voltExtensionSandbox.js';
import { voltSandboxedExtension, voltSandboxParams } from '../common/voltSandboxedExtensionHosts.js';

/** Where the agent server's workbench is served (`serverWorkbench.ts`, WORKBENCH_BASE_PATH). */
const WORKBENCH_BASE_PATH = '/code';

/**
 * P6: on the desktop, an opted-in Node extension runs in the local agent server's sandboxed host,
 * never in the desktop's own extension host process (Electron's `utilityProcess` can't be
 * sandboxed, D-09). The host is reached with a one-time ticket the main process gets with the
 * server's own token, and it is a local host to the extension: the same machine's `file:` URIs,
 * the window's workspace. With the agent server off, or an extension the platform can't sandbox,
 * nothing starts: it stays off and the reason is shown (P8, never silently unsandboxed).
 */
export function createVoltServerExtensionHost(
	instantiationService: IInstantiationService,
	runningLocations: ExtensionRunningLocationTracker,
	runningLocation: ExtensionRunningLocation,
	snapshot: () => Promise<{ readonly versionId: number; readonly extensions: readonly IExtensionDescription[] }>,
): IExtensionHost {
	return instantiationService.invokeFunction(accessor => {
		const configurationService = accessor.get(IConfigurationService);
		const sandbox = accessor.get(IVoltExtensionSandboxService);
		const manifestProperties = accessor.get(IExtensionManifestPropertiesService);
		const mainService = accessor.get(IVoltAgentServerMainService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
		const context = accessor.get(IWorkspaceContextService);
		const trust = accessor.get(IWorkspaceTrustManagementService);
		const mine = async () => voltSandboxedExtension(runningLocations, runningLocation, (await snapshot()).extensions);

		// Decided before any launch, from static facts (F.13).
		const refusal = async () => {
			const extension = await mine();
			if (!extension) {
				return undefined;
			}
			const extensionId = extension.identifier.value;
			const plan = extensionSandboxPlan(voltExtensionFacts(extension, manifestProperties.getExtensionKind(extension)), isMacintosh ? 'darwin' : isLinux ? 'linux' : isWindows ? 'win32' : 'other');
			if (plan.kind === 'refuse') {
				return { extensionId, code: plan.code, reason: plan.reason };
			}
			if (!agentServerEnabled(configurationService)) {
				return { extensionId, code: 'server-off', reason: localize('voltSandbox.serverOff', "Volt runs sandboxed extensions in its agent server, which is turned off (Volt Settings, Agent Server).") };
			}
			return undefined;
		};

		let ticket: (IVoltExtensionHostTicket & { readonly port: number }) | undefined;
		let refused = false;
		let extensionIdOf = '';
		const provider: IRemoteExtensionHostDataProvider = {
			remoteAuthority: 'volt-agent-server',
			voltLocal: {
				address: async () => {
					ticket = await mainService.createExtensionHostTicket();
					return {
						connectTo: new WebSocketRemoteConnection('127.0.0.1', ticket.port, { pathPrefix: WORKBENCH_BASE_PATH, query: `${VOLT_EXTHOST_TICKET_QUERY}=${encodeURIComponent(ticket.ticket)}` }),
						connectionToken: ticket.connectionToken,
					};
				},
			},
			getInitData: async () => {
				const current = await snapshot();
				const extension = voltSandboxedExtension(runningLocations, runningLocation, current.extensions);
				if (!extension || !ticket) {
					throw new Error('A sandboxed extension host holds exactly one extension.');
				}
				// Everything it writes lives in the folder the server lets it write: its storage on the server.
				const storageHome = URI.file(ticket.globalStorageHome);
				const own = joinPath(storageHome, extension.identifier.value.toLowerCase());
				return {
					connectionData: null,
					pid: 0,
					appRoot: URI.file(environmentService.appRoot),
					extensionHostLogsPath: joinPath(own, 'logs'),
					globalStorageHome: storageHome,
					workspaceStorageHome: joinPath(own, 'workspaceStorage'),
					extensions: new ExtensionHostExtensions(current.versionId, current.extensions, [extension.identifier]),
				};
			},
			voltSandbox: {
				extensionId: '',
				params: async () => {
					const why = await refusal();
					if (why) {
						refused = true;
						throw new Error(`volt-sandbox:${why.code}: ${why.reason}`);
					}
					const extension = await mine();
					if (!extension) {
						throw new Error('A sandboxed extension host holds exactly one extension.');
					}
					extensionIdOf = extension.identifier.value;
					// The server finds it in this app's own extension folder (named by the main process with the ticket), at this version.
					return voltSandboxParams(extensionIdOf, false, context, trust, extension.version);
				},
				report: state => {
					if (extensionIdOf || refused) {
						void mine().then(extension => extension && sandbox.report(extension.identifier.value, state));
					}
				},
			},
		};
		// A refusal known before any launch throws from `params`, before a ticket or a connection.
		return instantiationService.createInstance(RemoteExtensionHost, runningLocation, provider);
	});
}
