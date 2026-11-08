/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { ExtensionSandboxRefusalCode, IVoltSandboxedHostStartParams, t3LogsHome, t3WorkspaceStorageHome } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ExtensionRunningLocation } from './extensionRunningLocation.js';
import { ExtensionRunningLocationTracker } from './extensionRunningLocationTracker.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost } from './extensions.js';
import { IRemoteExtensionHostDataProvider, IRemoteExtensionHostInitData } from './remoteExtensionHost.js';
import { IVoltExtensionSandboxService } from './voltExtensionSandbox.js';

/**
 * The window's part of one opted-in extension's sandboxed host (P2, P6): which extension it is,
 * what the server is asked for, and the init data that keeps the host to its own storage and logs.
 */

/** The one extension a sandboxed location holds (H.6). */
export function voltSandboxedExtension(runningLocations: ExtensionRunningLocationTracker, location: ExtensionRunningLocation, extensions: readonly IExtensionDescription[]): IExtensionDescription | undefined {
	const mine = runningLocations.filterByRunningLocation(extensions, location);
	return mine.length === 1 ? mine[0] : undefined;
}

/** What the server is asked for: the extension, URI mapping, and the workspace and its trust as this window knows them. */
export function voltSandboxParams(extensionId: string, transformURIs: boolean, contextService: IWorkspaceContextService, trustService: IWorkspaceTrustManagementService): IVoltSandboxedHostStartParams {
	return {
		extensionId,
		transformURIs,
		workspaceTrusted: trustService.isWorkspaceTrusted(),
		workspaceRoots: contextService.getWorkspace().folders.map(folder => folder.uri.path),
	};
}

/**
 * A remote host's init data, made one sandboxed extension's: only it in the host, no parent-pid
 * polling (a sandbox can't signal outside; the supervisor kills the host with the server), and
 * its own workspace storage and log folders (the only ones the server lets it write).
 */
export function voltSandboxedRemoteInitData(data: IRemoteExtensionHostInitData, extension: IExtensionDescription, allExtensions: readonly IExtensionDescription[], versionId: number): IRemoteExtensionHostInitData {
	const id = extension.identifier.value;
	return {
		...data,
		pid: 0,
		extensionHostLogsPath: data.extensionHostLogsPath.with({ path: t3LogsHome(dirname(data.extensionHostLogsPath.path), id) }),
		workspaceStorageHome: data.workspaceStorageHome.with({ path: t3WorkspaceStorageHome(data.workspaceStorageHome.path, id) }),
		extensions: new ExtensionHostExtensions(versionId, allExtensions, [extension.identifier]),
	};
}

/** Wraps a remote host's data provider for one sandboxed location. */
export function voltSandboxedRemoteDataProvider(
	base: IRemoteExtensionHostDataProvider,
	runningLocations: ExtensionRunningLocationTracker,
	location: ExtensionRunningLocation,
	snapshot: () => Promise<{ readonly versionId: number; readonly extensions: readonly IExtensionDescription[] }>,
	services: { readonly sandbox: IVoltExtensionSandboxService; readonly context: IWorkspaceContextService; readonly trust: IWorkspaceTrustManagementService },
	transformURIs: boolean,
): IRemoteExtensionHostDataProvider {
	let extensionId = '';
	return {
		remoteAuthority: base.remoteAuthority,
		getInitData: async () => {
			const data = await base.getInitData();
			const current = await snapshot();
			const extension = voltSandboxedExtension(runningLocations, location, current.extensions);
			if (!extension) {
				throw new Error('A sandboxed extension host holds exactly one extension.');
			}
			return voltSandboxedRemoteInitData(data, extension, current.extensions, current.versionId);
		},
		voltSandbox: {
			get extensionId() { return extensionId; },
			params: async () => {
				const current = await snapshot();
				const extension = voltSandboxedExtension(runningLocations, location, current.extensions);
				if (!extension) {
					throw new Error('A sandboxed extension host holds exactly one extension.');
				}
				extensionId = extension.identifier.value;
				return voltSandboxParams(extensionId, transformURIs, services.context, services.trust);
			},
			report: state => extensionId && services.sandbox.report(extensionId, state),
		},
	};
}

/**
 * A sandboxed location that can't run here (F.13, P8): nothing starts, the extension stays off,
 * and the reason is reported so the user can choose "Run Without Sandbox".
 */
export class VoltRefusedExtensionHost extends Disposable implements IExtensionHost {

	readonly pid = null;
	readonly remoteAuthority = null;
	readonly startup = ExtensionHostStartup.EagerAutoStart;
	readonly extensions: ExtensionHostExtensions | null = null;
	private readonly _onExit = this._register(new Emitter<[number, string | null]>());
	readonly onExit: Event<[number, string | null]> = this._onExit.event;

	constructor(
		readonly runningLocation: ExtensionRunningLocation,
		private readonly refusal: () => Promise<{ readonly extensionId: string; readonly code: ExtensionSandboxRefusalCode | string; readonly reason: string } | undefined>,
		private readonly sandbox: IVoltExtensionSandboxService,
	) {
		super();
	}

	async start(): Promise<IMessagePassingProtocol> {
		const refusal = await this.refusal();
		if (refusal) {
			this.sandbox.report(refusal.extensionId, { kind: 'refused', code: refusal.code, reason: refusal.reason });
		}
		throw new Error(`Volt did not start a sandboxed extension host: ${refusal?.reason ?? 'it cannot run here'}`);
	}

	getInspectPort(): undefined {
		return undefined;
	}

	enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}
}
