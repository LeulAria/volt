/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/addProject.css';
import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IVoltFsBrowseService } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IRecentFolder, IRecentlyOpened, IWorkspacesService, isRecentFolder } from '../../../../../platform/workspaces/common/workspaces.js';
import { tildify, untildify } from '../../common/browsePath.js';
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

const LAST_TAB_KEY = 'volt.projects.addTab';
const LAST_DIR_KEY = 'volt.projects.lastBrowseDir';
const LAST_CLONE_PARENT_KEY = 'volt.projects.lastCloneParent';

let openDialog: { readonly select: (tab: AddProjectTab, options?: IAddProjectShowOptions) => void } | undefined;

/**
 * Add Project: This PC, Git URL and GitHub in one dialog. Everything is in-app; no native file
 * dialog is ever shown.
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

	async show(tab?: AddProjectTab, options?: IAddProjectShowOptions): Promise<void> {
		if (openDialog) {
			openDialog.select(tab ?? 'thisPC', options);
			return;
		}
		const [home, recents] = await Promise.all([
			this.fsBrowse.home(),
			this.workspacesService.getRecentlyOpened().catch((): IRecentlyOpened => ({ workspaces: [], files: [] })),
		]);
		this.home = home;
		this.recentFolders = recents.workspaces.filter((recent): recent is IRecentFolder => isRecentFolder(recent)).filter(recent => recent.folderUri.scheme === 'file')
			.map(recent => ({ name: recent.label || basename(recent.folderUri), path: recent.folderUri.fsPath })).slice(0, 12);
		const initial = tab ?? (this.storageService.get(LAST_TAB_KEY, StorageScope.APPLICATION) as AddProjectTab | undefined) ?? 'thisPC';
		showVoltModal(this.layoutService, {
			title: localize('voltProjects.addProject', "Add Project"),
			subtitle: localize('voltProjects.addProjectSubtitle', "Open a folder on this computer, or clone a repository"),
			width: 820,
			height: 560,
			className: 'volt-add-project',
			render: (body, close) => this.render(body, close, initial, options),
			onDidClose: () => openDialog = undefined,
		});
	}

	private render(body: HTMLElement, close: () => void, initial: AddProjectTab, initialOptions: IAddProjectShowOptions | undefined): IDisposable {
		const store = new DisposableStore();
		const tabs = append(body, $('.volt-add-tabs'));
		tabs.setAttribute('role', 'tablist');
		const panes = append(body, $('.volt-add-panes'));
		const folderOptions: Omit<IFolderBrowserOptions, 'onAccept' | 'initialPath'> = {
			addedPaths: () => new Set(this.projects.list().filter(project => project.uri.scheme === 'file').map(project => project.uri.fsPath)),
			knownFolders: () => {
				const seen = new Set<string>();
				return [...this.projects.list().filter(project => project.uri.scheme === 'file').map(project => ({ name: project.name, path: project.uri.fsPath })), ...this.recentFolders]
					.filter(folder => !seen.has(folder.path) && !!seen.add(folder.path));
			},
		};

		const definitions: { readonly id: AddProjectTab; readonly label: string; readonly icon: ThemeIcon; readonly key: string }[] = [
			{ id: 'thisPC', label: localize('voltProjects.thisPC', "This PC"), icon: Codicon.deviceDesktop, key: '⌘1' },
			{ id: 'gitUrl', label: localize('voltProjects.gitUrl', "Git URL"), icon: Codicon.sourceControl, key: '⌘2' },
			{ id: 'github', label: localize('voltProjects.github', "GitHub"), icon: Codicon.github, key: '⌘3' },
		];
		const tabButtons = new Map<AddProjectTab, HTMLButtonElement>();
		const paneElements = new Map<AddProjectTab, HTMLElement>();
		const focusers = new Map<AddProjectTab, () => void>();
		let gitUrlPane: GitUrlPane | undefined;
		let folderBrowser: FolderBrowser | undefined;

		const addLocal = (path: string) => {
			const uri = URI.file(path);
			const project = this.projects.add(uri, { source: 'local' });
			this.storageService.store(LAST_DIR_KEY, dirname(uri).fsPath, StorageScope.APPLICATION, StorageTarget.USER);
			close();
			void this.projects.open(project.id);
		};

		const ensurePane = (tab: AddProjectTab): HTMLElement => {
			let pane = paneElements.get(tab);
			if (pane) {
				return pane;
			}
			pane = append(panes, $('.volt-add-pane-host'));
			pane.setAttribute('role', 'tabpanel');
			paneElements.set(tab, pane);
			switch (tab) {
				case 'thisPC': {
					const browserHost = append(pane, $('.volt-add-browser'));
					const browser = folderBrowser = store.add(this.instantiationService.createInstance(FolderBrowser, browserHost, {
						...folderOptions,
						initialPath: this.initialBrowseFolder(),
						onAccept: addLocal,
					}));
					const footer = append(pane, $('.volt-add-footer'));
					const hidden = store.add(new Checkbox(localize('voltProjects.showHidden', "Show hidden folders"), browser.hiddenShown, defaultCheckboxStyles));
					const hiddenLabel = append(footer, $('label.volt-add-check'));
					hiddenLabel.appendChild(hidden.domNode);
					append(hiddenLabel, $('span')).textContent = localize('voltProjects.showHidden', "Show hidden folders");
					store.add(hidden.onChange(() => browser.setShowHidden(hidden.checked)));
					const target = append(footer, $('span.volt-add-footer-target'));
					const cancel = store.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
					cancel.label = localize('voltProjects.cancel', "Cancel");
					store.add(cancel.onDidClick(close));
					const add = store.add(new Button(footer, defaultButtonStyles));
					add.label = localize('voltProjects.add', "Add Project");
					store.add(add.onDidClick(() => {
						const path = browser.target;
						if (path) {
							addLocal(path);
						}
					}));
					store.add(browser.onDidChangeTarget(path => {
						add.enabled = !!path;
						// Marked left-to-right: the field ellipsizes on the left but must keep the path's order.
						target.textContent = path ? `\u200e${tildify(path, this.home)}\u200e` : '';
						target.title = path ?? '';
						const existing = path ? this.projects.getByUri(URI.file(path)) : undefined;
						add.label = existing ? localize('voltProjects.openProject', "Open Project") : localize('voltProjects.add', "Add Project");
					}));
					focusers.set(tab, () => browser.focus());
					break;
				}
				case 'gitUrl': {
					gitUrlPane = store.add(this.instantiationService.createInstance(GitUrlPane, pane, {
						home: () => this.home,
						defaultParent: () => this.defaultCloneParent(),
						folderOptions,
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
					break;
				}
				case 'github': {
					const githubPane = store.add(this.instantiationService.createInstance(GitHubPane, pane, repo => {
						select('gitUrl');
						gitUrlPane?.prefill(repo.cloneUrl, repo.name, 'github');
					}));
					focusers.set(tab, () => githubPane.focus());
					break;
				}
			}
			return pane;
		};

		const select = (tab: AddProjectTab, options?: IAddProjectShowOptions) => {
			ensurePane(tab);
			for (const [id, button] of tabButtons) {
				button.classList.toggle('selected', id === tab);
				button.setAttribute('aria-selected', String(id === tab));
				button.tabIndex = id === tab ? 0 : -1;
			}
			for (const [id, pane] of paneElements) {
				pane.classList.toggle('hidden', id !== tab);
			}
			this.storageService.store(LAST_TAB_KEY, tab, StorageScope.APPLICATION, StorageTarget.USER);
			focusers.get(tab)?.();
			if (options?.newFolder && tab === 'thisPC') {
				folderBrowser?.requestNewFolder();
			}
			if (options?.prefill && tab === 'gitUrl') {
				gitUrlPane?.prefill(options.prefill.url, options.prefill.name, options.prefill.source);
			}
		};

		for (const definition of definitions) {
			const button = append(tabs, $('button.volt-add-tab')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.appendChild(renderIcon(definition.icon));
			append(button, $('span.label')).textContent = definition.label;
			button.title = `${definition.label} (${definition.key})`;
			store.add(addDisposableListener(button, 'click', e => {
				EventHelper.stop(e, true);
				select(definition.id);
			}));
			tabButtons.set(definition.id, button);
		}
		store.add(addDisposableListener(body, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			const index = [KeyCode.Digit1, KeyCode.Digit2, KeyCode.Digit3].findIndex(key => event.equals(KeyMod.CtrlCmd | key));
			if (index >= 0) {
				EventHelper.stop(e, true);
				select(definitions[index].id);
			}
		}));

		openDialog = { select };
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
