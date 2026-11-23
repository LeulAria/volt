/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IExtensionGalleryService, InstallOperation } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IScannedExtension } from '../../../../platform/extensionManagement/common/extensionsScannerService.js';
import { IVoltExtensionIntegrityService, IVoltIntegrityFailure, VOLT_EXTENSION_INTEGRITY_CHANNEL } from '../../../../platform/extensionManagement/common/voltExtensionLock.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NotificationPriority } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchExtensionManagementService } from '../../extensionManagement/common/extensionManagement.js';
import { IHostService } from '../../host/browser/host.js';

registerSharedProcessRemoteService(IVoltExtensionIntegrityService, VOLT_EXTENSION_INTEGRITY_CHANNEL);

/**
 * Volt (H.10): before the window starts its extensions, each installed third-party extension's
 * files are checked against the integrity lock the shared process keeps (`~/.volt/trust`). One whose
 * files changed on disk after it was installed is left out (not started), and the user is told,
 * with "Reinstall" (from the gallery, when it came from there) and "Trust Current Files".
 */
export class VoltExtensionIntegrityGate {

	constructor(
		@IVoltExtensionIntegrityService private readonly integrity: IVoltExtensionIntegrityService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly galleryService: IExtensionGalleryService,
		@ILogService private readonly logService: ILogService,
	) { }

	/** The extensions that may start: all of `extensions` but the ones whose files changed. */
	async filter(extensions: IScannedExtension[]): Promise<IScannedExtension[]> {
		const checked = extensions.filter(extension => extension.type === ExtensionType.User && !extension.isBuiltin && extension.location.scheme === Schemas.file);
		if (!checked.length) {
			return extensions;
		}
		const started = Date.now();
		let failures: IVoltIntegrityFailure[];
		try {
			failures = await this.integrity.verify(checked.map(extension => extension.location.fsPath));
		} catch (error) {
			// The check could not run (the shared process is gone): extensions start as before, and the log says so.
			this.logService.error(`[volt integrity] the extension integrity check did not run: ${getErrorMessage(error)}`);
			return extensions;
		}
		this.logService.info(`[volt integrity] checked ${checked.length} extensions in ${Date.now() - started} ms${failures.length ? `: ${failures.length} not started` : ''}`);
		if (!failures.length) {
			return extensions;
		}
		const failed = new Map(failures.map(failure => [failure.location, failure]));
		for (const failure of failures) {
			const extension = checked.find(candidate => candidate.location.fsPath === failure.location);
			this.tell(failure, !!(extension?.identifier.uuid || extension?.metadata?.id));
		}
		return extensions.filter(extension => !(extension.location.scheme === Schemas.file && failed.has(extension.location.fsPath)));
	}

	private tell(failure: IVoltIntegrityFailure, fromGallery: boolean): void {
		const reload = () => this.notificationService.prompt(Severity.Info, localize('voltIntegrity.reload', "Reload the window to start {0}.", failure.id), [{
			label: localize('voltIntegrity.reloadNow', "Reload Window"),
			run: () => this.hostService.reload(),
		}]);
		this.notificationService.prompt(Severity.Error,
			localize('voltIntegrity.tampered', "{0} was not started: its files changed on disk after it was installed ({1}). Reinstall it, or trust its files as they are now?", failure.id, failure.why),
			[
				...(fromGallery ? [{
					label: localize('voltIntegrity.reinstall', "Reinstall"),
					run: () => void this.reinstall(failure).then(reload, error => this.notificationService.error(localize('voltIntegrity.reinstallFailed', "Could not reinstall {0}: {1}", failure.id, getErrorMessage(error)))),
				}] : []),
				{
					label: localize('voltIntegrity.trust', "Trust Current Files"),
					run: () => void this.integrity.trust(failure.location).then(reload, error => this.notificationService.error(getErrorMessage(error))),
				},
			],
			{ sticky: true, priority: NotificationPriority.URGENT });
	}

	/** The same version, downloaded again from the gallery and unpacked over the changed files (a `.vsix` install replaces the folder). */
	private async reinstall(failure: IVoltIntegrityFailure): Promise<void> {
		const [gallery] = await this.galleryService.getExtensions([{ id: failure.id, version: failure.version }], CancellationToken.None);
		if (!gallery) {
			throw new Error(localize('voltIntegrity.notInGallery', "{0} {1} is not in the gallery.", failure.id, failure.version));
		}
		const vsix = await this.extensionManagementService.download(gallery, InstallOperation.Install, false);
		const manifest = await this.extensionManagementService.getManifest(vsix);
		await this.extensionManagementService.installVSIX(vsix, manifest, { installGivenVersion: true });
	}
}
