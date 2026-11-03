/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';

/**
 * Workspace extensions (`.vscode/extensions/<folder>`) Volt installs without asking: only these,
 * by folder and extension id, and only in a trusted workspace. Today that is the import aid the
 * VS Code / Volt source tree ships for `src/vs` imports.
 */
const DEFAULT_WORKSPACE_EXTENSIONS: readonly { readonly folder: string; readonly id: string }[] = [
	{ folder: 'vscode-selfhost-import-aid', id: 'ms-vscode.vscode-selfhost-import-aid' },
];

/** Ids already installed once in this workspace; an uninstall afterwards is respected. */
const INSTALLED_ONCE_KEY = 'volt.defaultWorkspaceExtensions.installed';

export class VoltDefaultWorkspaceExtensions extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltDefaultWorkspaceExtensions';

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.run();
		this._register(this.trustService.onDidChangeTrust(trusted => {
			if (trusted) {
				void this.run();
			}
		}));
	}

	private async run(): Promise<void> {
		await this.trustService.workspaceTrustInitialized;
		this.logService.trace(`[volt] default workspace extensions: trusted=${this.trustService.isWorkspaceTrusted()}`);
		if (!this.trustService.isWorkspaceTrusted()) {
			return;
		}
		const done = new Set<string>(JSON.parse(this.storageService.get(INSTALLED_ONCE_KEY, StorageScope.WORKSPACE, '[]')));
		const pending = DEFAULT_WORKSPACE_EXTENSIONS.filter(entry => !done.has(entry.id));
		if (!pending.length) {
			return;
		}
		const installed = new Set((await this.extensionManagementService.getInstalledWorkspaceExtensions(true)).map(extension => extension.identifier.id.toLowerCase()));
		for (const folder of this.contextService.getWorkspace().folders) {
			for (const entry of pending) {
				const location = joinPath(folder.uri, '.vscode', 'extensions', entry.folder);
				this.logService.trace(`[volt] default workspace extension ${entry.id}: installed=${installed.has(entry.id)} at ${location.toString()}`);
				if (installed.has(entry.id) || !await this.fileService.exists(joinPath(location, 'package.json'))) {
					continue;
				}
				try {
					const [extension] = await this.extensionManagementService.getExtensions([location]);
					this.logService.trace(`[volt] default workspace extension resolved: ${extension?.identifier.id} main=${extension?.manifest.main}`);
					if (extension?.identifier.id.toLowerCase() !== entry.id) {
						continue;
					}
					// Its out/ is built with the repo; until then installing would add a broken extension. Try again next start.
					const main = extension.manifest.main;
					if (main && !await this.fileService.exists(joinPath(location, main.endsWith('.js') ? main : `${main}.js`))) {
						continue;
					}
					await this.extensionManagementService.installResourceExtension(extension, { isWorkspaceScoped: true });
					installed.add(entry.id);
					done.add(entry.id);
					this.logService.info(`[volt] installed workspace extension ${entry.id} from ${location.toString()}`);
				} catch (error) {
					this.logService.warn(`[volt] could not install workspace extension ${entry.id}`, error);
				}
			}
		}
		for (const entry of pending) {
			if (installed.has(entry.id)) {
				done.add(entry.id);
			}
		}
		this.storageService.store(INSTALLED_ONCE_KEY, JSON.stringify([...done]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
