/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/addProject.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltFsBrowseService } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IRecentFolder, IRecentlyOpened, IWorkspacesService, isRecentFolder } from '../../../../../platform/workspaces/common/workspaces.js';
import { untildify } from '../../common/browsePath.js';
import { IVoltProjectsService } from '../../common/projects.js';
import { IProjectCloneService } from '../projectCloneService.js';
import { FolderBrowser, IFolderBrowserOptions } from './folderBrowser.js';
import { GitHubPane } from './githubPane.js';
import { GitUrlPane } from './gitUrlPane.js';
import { showVoltModal } from './voltModal.js';

export type AddProjectTab = 'thisPC' | 'gitUrl' | 'github';

export interface IAddProjectShowOptions {
	/** This PC: start naming a new folder right away. */
	readonly newFolder?: boolean;
	/** Git URL: fill the form, e.g. from a GitHub repo picked in the project menu. */
	readonly prefill?: { readonly url: string; readonly name: string; readonly source: 'git' | 'github' };
}

const LAST_DIR_KEY = 'volt.projects.lastBrowseDir';
const LAST_CLONE_PARENT_KEY = 'volt.projects.lastCloneParent';

let openDialog: { readonly local: boolean; readonly select: (tab: AddProjectTab, options?: IAddProjectShowOptions) => void; readonly close: () => void } | undefined;

/**
 * Add Project. This PC is a compact folder palette; Git URL and GitHub open as a clone dialog.
 * Everything is in-app; no native file dialog is ever shown.
 */
export class AddProjectDialog {

	private home = '';
	private recentFolders: { name: string; path: string }[] = [];

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
		@IProjectCloneService private readonly cloneService: IProjectCloneService,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async show(tab: AddProjectTab = 'thisPC', options?: IAddProjectShowOptions): Promise<void> {
		const local = tab === 'thisPC';
		if (openDialog?.local === local) {
			openDialog.select(tab, options);
			return;
		}
		openDialog?.close();
		const [home, recents] = await Promise.all([
			this.fsBrowse.home(),
			this.workspacesService.getRecentlyOpened().catch((): IRecentlyOpened => ({ workspaces: [], files: [] })),
		]);
		this.home = home;
		this.recentFolders = recents.workspaces.filter((recent): recent is IRecentFolder => isRecentFolder(recent)).filter(recent => recent.folderUri.scheme === 'file')
			.map(recent => ({ name: recent.label || basename(recent.folderUri), path: recent.folderUri.fsPath })).slice(0, 12);
		let select: ((tab: AddProjectTab, options?: IAddProjectShowOptions) => void) | undefined;
		const modal = showVoltModal(this.layoutService, local ? {
			title: localize('voltProjects.addProject', "Add Project"),
			headless: true,
			width: 620,
			height: 460,
			className: 'volt-add-project volt-folder-palette',
			render: (body, close) => this.renderLocal(body, close, options, s => select = s),
			onDidClose: () => openDialog = undefined,
		} : {
			title: localize('voltProjects.cloneRepository', "Clone Repository"),
			subtitle: localize('voltProjects.cloneSubtitle', "From a Git URL or one of your GitHub repositories"),
			width: 760,
			height: 520,
			className: 'volt-add-project',
			render: (body, close) => this.renderClone(body, close, tab, options, s => select = s),
			onDidClose: () => openDialog = undefined,
		});
		openDialog = { local, select: (tab, options) => select?.(tab, options), close: () => modal.dispose() };
	}

	private folderOptions(): Omit<IFolderBrowserOptions, 'onAccept' | 'initialPath'> {
		return {
			addedPaths: () => new Set(this.projects.list().filter(project => project.uri.scheme === 'file').map(project => project.uri.fsPath)),
			knownFolders: () => {
				const seen = new Set<string>();
				return [...this.projects.list().filter(project => project.uri.scheme === 'file').map(project => ({ name: project.name, path: project.uri.fsPath })), ...this.recentFolders]
					.filter(folder => !seen.has(folder.path) && !!seen.add(folder.path));
			},
		};
	}

	private renderLocal(body: HTMLElement, close: () => void, initialOptions: IAddProjectShowOptions | undefined, setSelect: (select: (tab: AddProjectTab, options?: IAddProjectShowOptions) => void) => void): IDisposable {
		const store = new DisposableStore();
		const addLabel = localize('voltProjects.addShort', "Add");
		const openLabel = localize('voltProjects.openShort', "Open");
		const browser = store.add(this.instantiationService.createInstance(FolderBrowser, body, {
			...this.folderOptions(),
			initialPath: this.initialBrowseFolder(),
			acceptLabel: addLabel,
			onAccept: path => {
				const uri = URI.file(path);
				const project = this.projects.add(uri, { source: 'local' });
				this.storageService.store(LAST_DIR_KEY, dirname(uri).fsPath, StorageScope.APPLICATION, StorageTarget.USER);
				close();
				void this.projects.open(project.id);
			},
		}));
		store.add(browser.onDidChangeTarget(path => browser.setAcceptLabel(path && this.projects.getByUri(URI.file(path)) ? openLabel : addLabel)));
		const select = (_tab: AddProjectTab, options?: IAddProjectShowOptions) => {
			browser.focus();
			if (options?.newFolder) {
				browser.requestNewFolder();
			}
		};
		setSelect(select);
		select('thisPC', initialOptions);
		return store;
	}

	private renderClone(body: HTMLElement, close: () => void, initial: AddProjectTab, initialOptions: IAddProjectShowOptions | undefined, setSelect: (select: (tab: AddProjectTab, options?: IAddProjectShowOptions) => void) => void): IDisposable {
		const store = new DisposableStore();
		const panes = append(body, $('.volt-add-panes'));
		const paneElements = new Map<AddProjectTab, HTMLElement>();
		const focusers = new Map<AddProjectTab, () => void>();
		let gitUrlPane: GitUrlPane | undefined;

		const ensurePane = (tab: AddProjectTab): void => {
			if (paneElements.has(tab)) {
				return;
			}
			const pane = append(panes, $('.volt-add-pane-host'));
			paneElements.set(tab, pane);
			if (tab === 'github') {
				const githubPane = store.add(this.instantiationService.createInstance(GitHubPane, pane, repo => {
					select('gitUrl');
					gitUrlPane?.prefill(repo.cloneUrl, repo.name, 'github');
				}));
				focusers.set(tab, () => githubPane.focus());
				return;
			}
			gitUrlPane = store.add(this.instantiationService.createInstance(GitUrlPane, pane, {
				home: () => this.home,
				defaultParent: () => this.defaultCloneParent(),
				folderOptions: this.folderOptions(),
				clone: async request => {
					const project = await this.cloneService.clone(request);
					this.storageService.store(LAST_CLONE_PARENT_KEY, request.parent, StorageScope.APPLICATION, StorageTarget.USER);
					close();
					await this.projects.open(project.id);
				},
				addExisting: (path, url) => {
					const project = this.projects.add(URI.file(path), { source: 'git', remoteUrl: url });
					close();
					void this.projects.open(project.id);
				},
				cancel: close,
			}));
			focusers.set(tab, () => gitUrlPane!.focus());
		};

		const select = (tab: AddProjectTab, options?: IAddProjectShowOptions) => {
			ensurePane(tab);
			for (const [id, pane] of paneElements) {
				pane.classList.toggle('hidden', id !== tab);
			}
			focusers.get(tab)?.();
			if (options?.prefill && tab === 'gitUrl') {
				gitUrlPane?.prefill(options.prefill.url, options.prefill.name, options.prefill.source);
			}
		};

		setSelect(select);
		select(initial, initialOptions);
		return store;
	}

	/** The last folder browsed, else the folder that holds your most recent project. */
	private initialBrowseFolder(): string | undefined {
		const last = this.storageService.get(LAST_DIR_KEY, StorageScope.APPLICATION);
		if (last) {
			return last;
		}
		const recent = this.projects.list().find(project => project.uri.scheme === 'file');
		return recent ? dirname(recent.uri).fsPath : undefined;
	}

	/** Where clones go: the setting, the last folder used, a code folder, or ~/Volt. */
	private async defaultCloneParent(): Promise<string> {
		const configured = this.configurationService.getValue<string>('volt.projects.cloneDirectory')?.trim();
		if (configured) {
			return untildify(configured, this.home);
		}
		const last = this.storageService.get(LAST_CLONE_PARENT_KEY, StorageScope.APPLICATION);
		if (last) {
			return last;
		}
		const roots = await this.fsBrowse.quickAccess().catch(() => []);
		const code = roots.find(root => root.id === 'code');
		if (code) {
			return code.path;
		}
		return joinPath(URI.file(this.home), 'Volt').fsPath;
	}
}
