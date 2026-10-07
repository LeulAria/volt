/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { hash } from '../../../../../base/common/hash.js';
import { untildify } from '../../../../../base/common/labels.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { isEqual, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
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
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltProjectsService } from '../../../voltProjects/common/projects.js';
import { IVoltFolderPickerService } from '../../../voltProjects/browser/folderPickerService.js';
import { IProjectCloneService } from '../../../voltProjects/browser/projectCloneService.js';
import { AddProjectDialog } from '../../../voltProjects/browser/ui/addProjectView.js';
import { agentHomeWorkspaceEntries, cloneFolderName, freeFolderName, IAgentHomeWorkspaceEntry } from './agentHomeWorkspace.js';
import { IAgentHomeWorkspaceMenuHost, showAgentHomeWorkspaceMenu } from './agentHomeWorkspaceMenu.js';

/** Parent folder for clones and Start from scratch, once the user picks one. */
const LOCATION_STORAGE_KEY = 'volt.agent.home.projectsLocation';
export const INIT_TIMEOUT_MS = 30_000;
/** Folder name for Start from scratch; a number follows when it is taken. */
const SCRATCH_FOLDER_NAME = 'new-project';

/** What the Open Workspace menu does: open and clone local folders, then show them as projects. */
export class AgentHomeWorkspaceActions {

	/** Where one folder goes instead of its latest chat, e.g. into the new chat whose picker opened the menu. */
	private openOne: ((folder: URI) => Promise<void>) | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
		@IVoltFolderPickerService private readonly folderPicker: IVoltFolderPickerService,
		@IProjectCloneService private readonly cloneService: IProjectCloneService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
	) { }

	/**
	 * The menu's host, with the folder list read now. `current` is the project the caller shows,
	 * checked in the menu. `openOne` takes a single picked, created or scratch folder.
	 */
	async menuHost(current?: URI, openOne?: (folder: URI) => Promise<void>): Promise<IAgentHomeWorkspaceMenuHost> {
		this.openOne = openOne;
		const entries = await this.entries();
		return {
			entries,
			current,
			location: () => this.labelService.getUriLabel(this.locationUri()),
			changeLocation: () => this.changeLocation(),
			openFolders: folders => this.openFolders(folders),
			browse: () => this.browse(),
			browseGitHub: () => this.instantiationService.createInstance(AddProjectDialog).show('github'),
			startFromScratch: () => this.startFromScratch(),
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
		const picked = await this.folderPicker.pickFolder({
			title: localize('voltAgent.workspace.chooseLocation', "Choose where new projects go"),
			subtitle: localize('voltAgent.workspace.chooseLocationSubtitle', "Clones, new folders and scratch projects are created here"),
			acceptLabel: localize('voltAgent.workspace.choose', "Choose"),
			initialPath: this.locationUri().fsPath,
		});
		if (picked) {
			this.storageService.store(LOCATION_STORAGE_KEY, URI.file(picked).toString(), StorageScope.APPLICATION, StorageTarget.USER);
		}
	}

	/**
	 * One folder shows its latest chat, or a new one. Several start one new
	 * chat that records all of them, listed as a single multi-folder row; it
	 * runs in the first folder, like a chat from a multi-root workspace.
	 */
	async openFolders(folders: readonly URI[], current?: URI): Promise<void> {
		const [first] = folders;
		if (!first || (folders.length === 1 && current && isEqual(first, current))) {
			return;
		}
		void this.workspacesService.addRecentlyOpened(folders.map(folderUri => ({ folderUri })));
		if (folders.length === 1 && this.openOne) {
			await this.openOne(first);
			return;
		}
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

	/** Volt's in-app folder picker (This PC); it adds the folder and opens a chat in it. */
	private async browse(): Promise<void> {
		await this.instantiationService.createInstance(AddProjectDialog).show('thisPC');
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

	/**
	 * Clones into a free folder under the projects location. The project opens at once while git
	 * runs in the background, with progress on the project and prompts held until the files land.
	 */
	private async clone(url: string): Promise<string | undefined> {
		const name = cloneFolderName(url);
		if (!name) {
			return localize('voltAgent.workspace.noRepoName', "Could not tell the repository name from this URL.");
		}
		const parent = this.locationUri();
		try {
			const free = await freeFolderName(name, candidate => this.fileService.exists(joinPath(parent, candidate)));
			const project = await this.cloneService.clone({ url, parent: parent.fsPath, name: free, source: /github\.com[/:]/i.test(url) ? 'github' : 'git' });
			await this.projects.open(project.id);
			return undefined;
		} catch (err) {
			return toErrorMessage(err);
		}
	}

	private git(cwd: string, args: readonly string[], timeoutMs: number): Promise<IGitRun> {
		return runGit(this.stdio, cwd, args, timeoutMs);
	}
}

export interface IGitRun {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/** Runs git in the user's shell, with their environment, so it is the git they use in a terminal. */
export async function runGit(stdio: IVoltStdioService, cwd: string, args: readonly string[], timeoutMs: number): Promise<IGitRun> {
	try {
		const result = await stdio.exec({
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

function shellQuote(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The project menu (Recents, Start from scratch, Local folder, On This Mac, clone hosts) under
 * `anchor`, shared by the sidebar header, the new agent's project picker and Add Project.
 * Without `openOne`, a folder shows its latest chat (or a new one). A second click on the
 * same anchor closes it.
 */
export async function showAgentProjectMenu(instantiationService: IInstantiationService, anchor: HTMLElement, current?: URI, openOne?: (folder: URI) => Promise<void>): Promise<void> {
	const contextViewService = instantiationService.invokeFunction(accessor => accessor.get(IContextViewService));
	if (anchor.classList.contains('open')) {
		contextViewService.hideContextView();
		return;
	}
	const actions = instantiationService.createInstance(AgentHomeWorkspaceActions);
	const host = await actions.menuHost(current, openOne);
	if (anchor.isConnected) {
		showAgentHomeWorkspaceMenu(contextViewService, anchor, host);
	}
}
