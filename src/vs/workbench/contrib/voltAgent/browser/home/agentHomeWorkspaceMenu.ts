/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltMenuItem, IVoltMenuSection, IVoltSubmenu, showVoltMenu } from '../ui/menu/voltMenu.js';
import { createHomeBitbucketIcon, createHomeFolderIcon, createHomeFoldersIcon, createHomeGitIcon, createHomeGitLabIcon, createHomeLaptopIcon, createHomeSearchIcon } from './agentHomeIcons.js';
import {
	AGENT_CLONE_PROVIDERS,
	AgentCloneProvider,
	cloneProviderLabel,
	cloneProviderPlaceholder,
	IAgentHomeWorkspaceEntry,
	newProjectNameProblem,
	resolveCloneUrl,
} from './agentHomeWorkspace.js';

export interface IAgentHomeWorkspaceMenuHost {
	/** Local folders, most recent first. */
	readonly entries: readonly IAgentHomeWorkspaceEntry[];
	/** The project the menu was opened from; its rows get a check. */
	readonly current?: URI;
	/** Where cloned and new projects are made, as a path label. */
	location(): string;
	/** Asks for another location and keeps it for next time. */
	changeLocation(): Promise<void>;
	/** One folder opens as its project; several open one new chat across all of them. */
	openFolders(folders: readonly URI[], current?: URI): Promise<void>;
	/** Volt's in-app folder picker (never the system dialog). */
	browse(): Promise<void>;
	/** The Add Project dialog on its GitHub tab: your repositories, searchable. */
	browseGitHub(): Promise<void>;
	/** A repository from just a name, open in a new chat. Resolves with a message when it could not be made. */
	createProject(name: string): Promise<string | undefined>;
	/** Resolves with a message when the clone failed. */
	clone(url: string): Promise<string | undefined>;
	/** A failure that lands after the menu closed. */
	reportError(message: string): void;
}

type WorkspacePick =
	| { readonly kind: 'open'; readonly folders: readonly URI[] }
	| { readonly kind: 'toggle'; readonly entry: IAgentHomeWorkspaceEntry }
	| { readonly kind: 'multiple' }
	| { readonly kind: 'browse' }
	| { readonly kind: 'github' }
	| { readonly kind: 'location' }
	/** Rows that open a flyout or a prompt; the menu handles them itself. */
	| { readonly kind: 'none' };

type WorkspaceItem = IVoltMenuItem<WorkspacePick>;

const NONE: WorkspacePick = { kind: 'none' };

/**
 * Open Workspace menu on the sidebar's project header, on the shared VoltMenu (a VS Code list):
 * recent projects scroll in the list, and under it the ways to start stay put - Local folders,
 * New project (a name in the search field), On This Mac (search, pick one or several) and Git
 * Repo, whose flyout holds the hosts to clone from.
 */
export function showAgentHomeWorkspaceMenu(
	contextViewService: IContextViewService,
	anchor: HTMLElement,
	host: IAgentHomeWorkspaceMenuHost,
): void {
	let multiple = false;
	const selected = new Map<string, IAgentHomeWorkspaceEntry>();
	let closed = false;

	const isCurrent = (uri: URI) => !!host.current && isEqual(uri, host.current);
	const run = (action: () => Promise<void>) => action().catch(err => host.reportError(toErrorMessage(err)));
	/** A form's action: its message keeps the prompt open, or is reported once the menu has closed. */
	const submit = async (action: () => Promise<string | undefined>) => {
		const error = await action().catch(err => toErrorMessage(err));
		if (!error) {
			return;
		}
		if (closed) {
			host.reportError(error);
			return;
		}
		throw new Error(error);
	};
	const folderItem = (entry: IAgentHomeWorkspaceEntry, toggle: boolean): WorkspaceItem => ({
		id: entry.uri.toString(),
		label: entry.name,
		description: entry.path,
		icon: createHomeFolderIcon,
		checked: toggle ? selected.has(entry.uri.toString()) : isCurrent(entry.uri),
		keepOpen: toggle,
		data: toggle ? { kind: 'toggle', entry } : { kind: 'open', folders: [entry.uri] },
	});

	const onThisMac: IVoltSubmenu<WorkspacePick> = {
		width: 300,
		search: { placeholder: localize('voltAgent.workspace.searchMac', "Search This Mac"), icon: createHomeSearchIcon },
		emptyMessage: localize('voltAgent.workspace.noMatches', "No folders match"),
		sections: () => {
			const sections: IVoltMenuSection<WorkspacePick>[] = [{
				id: 'mode',
				items: [{
					id: 'multiple',
					label: localize('voltAgent.workspace.selectMultiple', "Select Multiple"),
					icon: createHomeFoldersIcon,
					checked: multiple,
					keepOpen: true,
					alwaysShow: true,
					data: { kind: 'multiple' },
				}],
			}];
			if (multiple && selected.size) {
				sections.push({
					id: 'open',
					items: [{
						id: 'openSelected',
						label: selected.size === 1
							? localize('voltAgent.workspace.openOne', "Open Folder")
							: localize('voltAgent.workspace.openMany', "Open {0} Folders", selected.size),
						icon: Codicon.folderOpened,
						alwaysShow: true,
						data: { kind: 'open', folders: [...selected.values()].map(entry => entry.uri) },
					}],
				});
			}
			sections.push({
				id: 'folders',
				items: host.entries.map(entry => folderItem(entry, multiple)),
				emptyMessage: localize('voltAgent.workspace.noFolders', "No folders yet."),
			});
			return sections;
		},
	};

	const cloneItem = (provider: AgentCloneProvider): WorkspaceItem => provider === 'github'
		// GitHub lists your repositories; the other hosts take a URL.
		? { id: provider, label: cloneProviderLabel(provider), icon: Codicon.github, data: { kind: 'github' } }
		: {
			id: provider,
			label: cloneProviderLabel(provider),
			icon: provider === 'gitlab' ? createHomeGitLabIcon : provider === 'bitbucket' ? createHomeBitbucketIcon : Codicon.repoClone,
			prompt: {
				placeholder: cloneProviderPlaceholder(provider),
				hint: localize('voltAgent.workspace.clonesInto', "Clones into {0}", host.location()),
				validate: value => resolveCloneUrl(provider, value) ? undefined : localize('voltAgent.workspace.badUrl', "Paste a repository URL."),
				onSubmit: value => submit(() => host.clone(resolveCloneUrl(provider, value)!)),
			},
			data: NONE,
		};

	const gitRepo: IVoltSubmenu<WorkspacePick> = {
		width: 260,
		sections: () => [{
			id: 'hosts',
			items: AGENT_CLONE_PROVIDERS.map(cloneItem),
		}, {
			id: 'location',
			items: [{
				id: 'location',
				label: localize('voltAgent.workspace.location', "Location"),
				description: host.location(),
				icon: Codicon.folder,
				tooltip: localize('voltAgent.workspace.changeLocation', "Change where new projects and clones go"),
				data: { kind: 'location' },
			}],
		}],
	};

	const footer: WorkspaceItem[] = [{
		id: 'browse',
		label: localize('voltAgent.workspace.localFolders', "Local folders"),
		icon: Codicon.folderOpened,
		data: { kind: 'browse' },
	}, {
		id: 'newProject',
		label: localize('voltAgent.workspace.newProjectAction', "New project"),
		icon: Codicon.add,
		prompt: {
			placeholder: localize('voltAgent.workspace.projectName', "Project name"),
			hint: localize('voltAgent.workspace.createsIn', "Creates a Git repository in {0}", host.location()),
			validate: newProjectNameProblem,
			onSubmit: value => submit(() => host.createProject(value.trim())),
		},
		data: NONE,
	}, {
		id: 'mac',
		label: isMacintosh
			? localize('voltAgent.workspace.onThisMac', "On This Mac")
			: localize('voltAgent.workspace.onThisPC', "On This PC"),
		icon: createHomeLaptopIcon,
		submenu: onThisMac,
		data: NONE,
	}, {
		id: 'git',
		label: localize('voltAgent.workspace.gitRepo', "Git Repo"),
		icon: createHomeGitIcon,
		submenu: gitRepo,
		data: NONE,
	}];

	const handle = showVoltMenu<WorkspacePick>(contextViewService, {
		anchor,
		position: 'below',
		align: 'left',
		gap: 4,
		width: 336,
		// About six recent projects, then the list scrolls.
		maxListHeight: 180,
		className: 'volt-agent-home-workspace-volt-menu',
		ariaLabel: localize('voltAgent.workspace.openWorkspace', "Open Workspace"),
		search: { placeholder: localize('voltAgent.workspace.searchProjects', "Search projects and folders"), icon: createHomeSearchIcon },
		emptyMessage: localize('voltAgent.workspace.noMatches', "No folders match"),
		sections: () => [{
			id: 'recent',
			items: host.entries.map(entry => folderItem(entry, false)),
			emptyMessage: localize('voltAgent.workspace.noFolders', "No folders yet."),
		}],
		footer,
		onPick: item => {
			const pick = item.data;
			switch (pick.kind) {
				case 'open':
					if (pick.folders.length) {
						run(() => host.openFolders(pick.folders, host.current));
					}
					return;
				case 'toggle': {
					const key = pick.entry.uri.toString();
					if (!selected.delete(key)) {
						selected.set(key, pick.entry);
					}
					handle.refresh();
					return;
				}
				case 'multiple':
					multiple = !multiple;
					handle.refresh();
					return;
				case 'browse':
					run(() => host.browse());
					return;
				case 'github':
					run(() => host.browseGitHub());
					return;
				case 'location':
					run(() => host.changeLocation());
					return;
				case 'none':
					return;
				default: {
					const unexpected: never = pick;
					return unexpected;
				}
			}
		},
		onHide: () => closed = true,
	});
}
