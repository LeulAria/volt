/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AGENT_SCRATCH_WORKSPACE_ID, freeFolderName, scratchFolderName, scratchProjectLabel } from '../home/agentHomeWorkspace.js';
import { runGit } from '../home/agentHomeWorkspaceActions.js';
import { bindingFromProject } from './agentShell.js';
import { IAgentWorkspaceService } from './agentWorkspace.js';

const GIT_CHECK_TIMEOUT_MS = 10_000;

/** Asked once per window and folder: whether the scratch root sits inside a checkout (a dotfiles home). */
const scratchInsideCheckout = new Map<string, Promise<boolean>>();

/**
 * Folders for chats started without a project. Each chat gets its own plain folder (no git)
 * under `~/.volt/scratch`, beside Volt's worktrees in `~/.volt/worktrees`, named from the day,
 * the first message and a short id. The folder is made on the first send and kept when the
 * chat is deleted. It is bound like a project but never listed as one.
 */
export class AgentScratchFolders {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
	) { }

	/** `~/.volt/scratch` on this machine. */
	root(): URI {
		return joinPath(this.pathService.userHome({ preferLocal: true }), '.volt', 'scratch');
	}

	/**
	 * Makes the chat's scratch folder and binds the chat to it. Undefined, with the reason shown,
	 * when the folder could not be made; the prompt then stays in the composer.
	 */
	async bind(sessionId: string, firstMessage: string): Promise<IVoltProjectRecord | undefined> {
		const existing = this.sessionContext.bindingFor(sessionId);
		if (existing) {
			return this.sessionContext.getProject(existing.projectId);
		}
		const root = this.root();
		try {
			await this.fileService.createFolder(root);
			// Inside a checkout the folder would show the repository's changes and branches as its own.
			let inside = scratchInsideCheckout.get(root.fsPath);
			if (!inside) {
				inside = runGit(this.stdio, root.fsPath, ['rev-parse', '--is-inside-work-tree'], GIT_CHECK_TIMEOUT_MS)
					.then(result => result.exitCode === 0 && !result.timedOut);
				scratchInsideCheckout.set(root.fsPath, inside);
			}
			if (await inside) {
				this.notificationService.error(localize('voltAgent.scratch.insideRepo', "Chats without a project need a folder outside git, but {0} is inside a git repository. Pick a project to send this prompt.", root.fsPath));
				return undefined;
			}
			const name = await freeFolderName(scratchFolderName(new Date(), firstMessage, generateUuid()), candidate => this.fileService.exists(joinPath(root, candidate)));
			const folder = joinPath(root, name);
			await this.fileService.createFolder(folder);
			const project = this.sessionContext.registerScratchProject(folder, scratchProjectLabel());
			if (!this.sessionContext.bindSession(sessionId, project.id)) {
				return undefined;
			}
			this.history.pinSessionWorkspace(sessionId, { id: AGENT_SCRATCH_WORKSPACE_ID, label: project.displayName, folders: [project.root.fsPath] });
			this.workspace.bindProject(sessionId, bindingFromProject(project));
			return project;
		} catch (err) {
			this.notificationService.error(localize('voltAgent.scratch.failed', "Could not make a folder for this chat: {0}", toErrorMessage(err)));
			return undefined;
		}
	}
}
