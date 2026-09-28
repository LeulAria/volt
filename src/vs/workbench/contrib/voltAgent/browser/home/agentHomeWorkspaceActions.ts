/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { hash } from '../../../../../base/common/hash.js';
import { untildify } from '../../../../../base/common/labels.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { isRecentFolder, IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { activateAgentProject, newAgentChat } from '../workspace/agentPanels.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { agentHomeWorkspaceEntries, cloneFolderName, freeFolderName, gitErrorSummary, IAgentHomeWorkspaceEntry } from './agentHomeWorkspace.js';
import { IAgentHomeWorkspaceMenuHost } from './agentHomeWorkspaceMenu.js';

/** Parent folder for clones, New Folder and Start from scratch, once the user picks one. */
const LOCATION_STORAGE_KEY = 'volt.agent.home.projectsLocation';
const CLONE_TIMEOUT_MS = 10 * 60_000;
const INIT_TIMEOUT_MS = 30_000;
/** Folder name for Start from scratch; a number follows when it is taken. */
const SCRATCH_FOLDER_NAME = 'new-project';

/** What the Open Workspace menu does: open, clone and create local folders, then show them as projects. */
export class AgentHomeWorkspaceActions {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IPathService private readonly pathService: IPathService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
	) { }

	/** The menu's host, with the folder list read now. */
	async menuHost(): Promise<IAgentHomeWorkspaceMenuHost> {
		const entries = await this.entries();
		return {
			entries,
			location: () => this.labelService.getUriLabel(this.locationUri()),
			changeLocation: () => this.changeLocation(),
			openFolders: folders => this.openFolders(folders),
			browse: multiple => this.browse(multiple),
			startFromScratch: () => this.startFromScratch(),
			createFolder: name => this.createFolder(name),
			clone: url => this.clone(url),
			reportError: message => this.notificationService.error(message),
		};
	}

	/** Local folders only (no remotes, no workspace files): recently opened first, then registered projects. */
	private async entries(): Promise<IAgentHomeWorkspaceEntry[]> {
		const recents = await this.workspacesService.getRecentlyOpened();
		const recent = recents.workspaces
			.filter(isRecentFolder)
			.filter(folder => folder.folderUri.scheme === 'file')
			.map(folder => ({ uri: folder.folderUri, name: folder.label || this.labelService.getUriBasenameLabel(folder.folderUri) }));
		const projects = this.sessionContext.projects
			.filter(project => project.root.scheme === 'file')
			.map(project => ({ uri: project.root, name: project.displayName }));
		return agentHomeWorkspaceEntries(recent, projects, uri => this.labelService.getUriLabel(uri));
	}

	private locationUri(): URI {
		const stored = this.storageService.get(LOCATION_STORAGE_KEY, StorageScope.APPLICATION);
		if (stored) {
			try {
				return URI.parse(stored);
			} catch {
				// Fall through to the defaults.
			}
		}
		const home = this.pathService.userHome({ preferLocal: true });
		const configured = this.configurationService.getValue<unknown>('git.defaultCloneDirectory');
		if (typeof configured === 'string' && configured.trim()) {
			const path = untildify(configured.trim(), home.fsPath);
			if (isAbsolute(path)) {
				return URI.file(path);
			}
		}
		return home;
	}

	private async changeLocation(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: this.locationUri(),
			title: localize('voltAgent.workspace.chooseLocation', "Choose where new projects go"),
			openLabel: localize('voltAgent.workspace.choose', "Choose"),
		});
		const folder = picked?.[0];
		if (folder) {
			this.storageService.store(LOCATION_STORAGE_KEY, folder.toString(), StorageScope.APPLICATION, StorageTarget.USER);
		}
	}

	/**
	 * One folder shows its latest chat, or a new one. Several start one new
	 * chat that records all of them, listed as a single multi-folder row; it
	 * runs in the first folder, like a chat from a multi-root workspace.
	 */
	async openFolders(folders: readonly URI[]): Promise<void> {
		const [first] = folders;
		if (!first) {
			return;
		}
		void this.workspacesService.addRecentlyOpened(folders.map(folderUri => ({ folderUri })));
		if (folders.length === 1) {
			await activateAgentProject(
				this.sessionContext,
				this.agentWorkspace,
				this.history,
				this.editorGroupsService,
				this.instantiationService,
				first,
				this.labelService.getUriBasenameLabel(first),
			);
			return;
		}
		const projects = folders.map(folder => this.sessionContext.registerProject(folder, this.labelService.getUriBasenameLabel(folder)));
		const input = await newAgentChat(
			this.sessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			projects[0].root,
			projects[0].displayName,
		);
		this.history.pinSessionWorkspace(input.sessionId, {
			id: `folders-${hash(projects.map(project => project.id).join('|')).toString(36)}`,
			label: projects.map(project => project.displayName).join(', '),
			folders: projects.map(project => project.root.fsPath),
		});
	}

	private async browse(multiple: boolean): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: multiple,
			title: multiple
				? localize('voltAgent.workspace.openFoldersTitle', "Open Folders")
				: localize('voltAgent.workspace.openFolderTitle', "Open Folder"),
			openLabel: localize('voltAgent.workspace.open', "Open"),
		});
		if (picked?.length) {
			await this.openFolders(picked);
		}
	}

	/** An empty git repository in the projects location, open in a new chat. */
	private async startFromScratch(): Promise<void> {
		const parent = this.locationUri();
		try {
			const name = await freeFolderName(SCRATCH_FOLDER_NAME, candidate => this.fileService.exists(joinPath(parent, candidate)));
			const target = joinPath(parent, name);
			await this.fileService.createFolder(target);
			// Git lets the chat show its changes and use worktrees; a folder without it still works.
			await this.git(target.fsPath, ['init'], INIT_TIMEOUT_MS);
			await this.openFolders([target]);
		} catch (err) {
			this.notificationService.error(localize('voltAgent.workspace.scratchFailed', "Could not create a project: {0}", toErrorMessage(err)));
		}
	}

	private async createFolder(name: string): Promise<string | undefined> {
		const target = joinPath(this.locationUri(), name);
		try {
			if (await this.fileService.exists(target)) {
				return localize('voltAgent.workspace.folderExists', "A folder named {0} is already there.", name);
			}
			await this.fileService.createFolder(target);
		} catch (err) {
			return toErrorMessage(err);
		}
		await this.openFolders([target]);
		return undefined;
	}

	/** Clones into a free folder under the projects location, then opens it. */
	private async clone(url: string): Promise<string | undefined> {
		const name = cloneFolderName(url);
		if (!name) {
			return localize('voltAgent.workspace.noRepoName', "Could not tell the repository name from this URL.");
		}
		const parent = this.locationUri();
		let target: URI;
		try {
			if (!await this.fileService.exists(parent)) {
				await this.fileService.createFolder(parent);
			}
			target = joinPath(parent, await freeFolderName(name, candidate => this.fileService.exists(joinPath(parent, candidate))));
		} catch (err) {
			return toErrorMessage(err);
		}
		const result = await this.git(parent.fsPath, ['clone', '--', url, target.fsPath], CLONE_TIMEOUT_MS);
		if (result.exitCode !== 0) {
			// The folder name was free, so anything left there is this clone's partial checkout.
			await this.fileService.del(target, { recursive: true }).catch(() => undefined);
			return result.timedOut
				? localize('voltAgent.workspace.cloneTimeout', "Cloning took too long and was stopped.")
				: gitErrorSummary(result.stderr) ?? localize('voltAgent.workspace.cloneFailed', "git clone failed.");
		}
		await this.openFolders([target]);
		return undefined;
	}

	private async git(cwd: string, args: readonly string[], timeoutMs: number): Promise<{ readonly exitCode: number | null; readonly stderr: string; readonly timedOut: boolean }> {
		try {
			const result = await this.stdio.exec({
				id: `git-${generateUuid().slice(0, 8)}`,
				command: ['git', ...args].map(shellQuote).join(' '),
				cwd,
				// No terminal to answer a credential prompt; fail instead of waiting for the timeout.
				env: { GIT_TERMINAL_PROMPT: '0' },
				timeoutMs,
				inlineChars: 20_000,
			});
			return { exitCode: result.exitCode, stderr: result.stderr, timedOut: result.timedOut };
		} catch (err) {
			return { exitCode: 1, stderr: toErrorMessage(err), timedOut: false };
		}
	}
}

function shellQuote(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}
