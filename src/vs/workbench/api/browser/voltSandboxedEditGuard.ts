/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../base/common/network.js';
import Severity from '../../../base/common/severity.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { protectedEditTarget } from '../../../platform/voltSandbox/common/sandboxProfiles.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { voltIsSandboxed } from '../../services/extensions/common/voltExtensionSandbox.js';

/**
 * A sandboxed extension host can't write the project itself (H.7: its OS policy has no workspace
 * write); its edits reach disk through Volt's window, which applies WorkspaceEdits, editor edits
 * and saves with the user's rights. Without a check here the sandbox's read-only files (git hooks
 * and config, `.vscode/tasks.json`, hook managers, agent configs) were one `applyEdit` away: the
 * Agent Lab sample created `.git/hooks/post-merge` and a `runOn: folderOpen` task that way. This
 * refuses those paths for a sandboxed host's edits, as the OS refuses them for its own writes, and
 * tells the user. Other hosts are unaffected.
 */
export class VoltSandboxedEditGuard {

	private readonly told = new Set<string>();

	constructor(
		private readonly extHostContext: IExtHostContext,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) { }

	/** The sandboxed extension this host runs (a sandboxed host holds exactly one). */
	private sandboxed(): IExtensionDescription | undefined {
		return this.extensionService.extensions.find(extension => this.extHostContext.hostsExtension(extension.identifier.value) && voltIsSandboxed(this.configurationService, extension));
	}

	/** False, and the user is told, when a sandboxed host's edit touches a protected file. */
	allows(resources: readonly (URI | undefined)[]): boolean {
		const local = resources.filter((resource): resource is URI => !!resource && (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote));
		const hits = local.map(resource => ({ path: resource.path, name: protectedEditTarget(resource.path) })).filter(hit => !!hit.name);
		if (!hits.length) {
			return true;
		}
		const extension = this.sandboxed();
		if (!extension) {
			return true;
		}
		const name = extension.displayName ?? extension.name;
		this.logService.warn(`[volt-sandbox] refused an edit from sandboxed ${extension.identifier.value}: ${hits.map(hit => hit.path).join(', ')}`);
		const key = `${extension.identifier.value}\u0000${hits.map(hit => hit.path).join('\u0000')}`;
		if (!this.told.has(key)) {
			this.told.add(key);
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('voltEditGuard.blocked', "Volt's sandbox blocked {0}: it tried to change {1}, which runs later outside the sandbox.", name, hits.map(hit => hit.path).join(', ')),
				sticky: true,
			});
		}
		return false;
	}
}
