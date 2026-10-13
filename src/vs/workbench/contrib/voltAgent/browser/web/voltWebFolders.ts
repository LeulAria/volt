/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { WorkspaceService } from '../../../../services/configuration/browser/configurationService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { getSingleFolderWorkspaceIdentifier } from '../../../../services/workspaces/browser/workspaces.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';

/**
 * The desktop changes the window's folder in place as you move between chats (Search, the
 * Explorer and Source Control follow the chat in front), without a reload, so running agents and
 * open tools carry on. A browser tab has no main process to do that, so this does the same steps
 * here: stop the extension host, take the new folder, carry the window's state over, start the
 * extension host again. Folders are the server's (`file:` paths become remote ones), and the
 * address keeps the folder, so a reload opens it again.
 */
class WebFolderSwitchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWebFolderSwitch';

	private switching: Promise<boolean> = Promise.resolve(true);

	constructor(
		@IWorkspaceEditingService workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceContextService private readonly contextService: WorkspaceService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		if (!workspaceEditingService.enterFolder && environmentService.remoteAuthority) {
			// One at a time: two chats shown in a row must not interleave their switches.
			workspaceEditingService.enterFolder = folder => this.switching = this.switching.then(() => this.enterFolder(folder), () => this.enterFolder(folder));
		}
	}

	private async enterFolder(folderUri: URI): Promise<boolean> {
		const remoteAuthority = this.environmentService.remoteAuthority;
		if (!remoteAuthority) {
			return false;
		}
		const folder = folderUri.scheme === Schemas.file ? folderUri.with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority }) : folderUri;
		const workspace = this.contextService.getWorkspace();
		if (this.contextService.getWorkbenchState() === WorkbenchState.FOLDER && workspace.folders.length === 1 && this.uriIdentityService.extUri.isEqual(workspace.folders[0].uri, folder)) {
			return true;
		}
		const stopped = await this.extensionService.stopExtensionHosts(localize('voltWeb.openingFolder', "Opening a folder"));
		if (!stopped) {
			return false;
		}
		try {
			const identifier = getSingleFolderWorkspaceIdentifier(folder);
			await this.contextService.initialize(identifier);
			// Carry the window's state over: chats, their tools and terminals live on in this tab.
			await this.storageService.switch(identifier, true /* preserve data */);
			this.rememberInAddress(folder);
			return true;
		} catch (error) {
			this.logService.error('[volt] could not open the folder in this tab', error);
			return false;
		} finally {
			await this.extensionService.startExtensionHosts();
		}
	}

	/** `?folder=/path`, as the page reads it when it loads. */
	private rememberInAddress(folder: URI): void {
		try {
			const url = new URL(mainWindow.location.href);
			url.searchParams.delete('ew');
			url.searchParams.delete('workspace');
			url.searchParams.set('folder', folder.path);
			mainWindow.history.replaceState(mainWindow.history.state, '', url.toString());
		} catch {
			// the address is a convenience
		}
	}
}

registerWorkbenchContribution2(WebFolderSwitchContribution.ID, WebFolderSwitchContribution, WorkbenchPhase.BlockStartup);
