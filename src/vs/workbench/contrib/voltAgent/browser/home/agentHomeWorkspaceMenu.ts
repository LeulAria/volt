/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomeWorkspaceMenu.css';
import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { createHomeBitbucketIcon, createHomeFolderIcon, createHomeFoldersIcon, createHomeGitLabIcon, createHomeLaptopIcon, createHomeOpenWorkspaceIcon } from './agentHomeIcons.js';
import {
	AGENT_CLONE_PROVIDERS,
	AGENT_HOME_RECENT_LIMIT,
	AgentCloneProvider,
	cloneProviderLabel,
	cloneProviderPlaceholder,
	filterAgentHomeWorkspaceEntries,
	IAgentHomeWorkspaceEntry,
	newFolderNameProblem,
	newProjectNameProblem,
	resolveCloneUrl,
} from './agentHomeWorkspace.js';

export interface IAgentHomeWorkspaceMenuHost {
	/** Local folders, most recent first. */
	readonly entries: readonly IAgentHomeWorkspaceEntry[];
	/** The project the menu was opened from; its rows get a check. */
	readonly current?: URI;
	/** Where new, cloned and scratch folders are made, as a path label. */
	location(): string;
	/** Asks for another location and keeps it for next time. */
	changeLocation(): Promise<void>;
	/** One folder opens as its project; several open one new chat across all of them. */
	openFolders(folders: readonly URI[], current?: URI): Promise<void>;
	/** Volt's in-app folder picker (never the system dialog). */
	browse(): Promise<void>;
	/** The Add Project dialog on its GitHub tab: your repositories, searchable. */
	browseGitHub(): Promise<void>;
	startFromScratch(): Promise<void>;
	/** Resolves with a message when the folder could not be made. */
	createFolder(name: string): Promise<string | undefined>;
	/** A repository from just a name, open in a new chat. Resolves with a message when it could not be made. */
	createProject(name: string): Promise<string | undefined>;
	/** Resolves with a message when the clone failed. */
	clone(url: string): Promise<string | undefined>;
	/** A failure that lands after the menu closed. */
	reportError(message: string): void;
}

type FlyoutKind = 'mac' | 'existing' | 'clone' | 'newFolder' | 'newProject';

/** Flyouts that hold a form rather than a list. */
function isFormFlyout(kind: FlyoutKind): boolean {
	return kind === 'clone' || kind === 'newFolder' || kind === 'newProject';
}

/**
 * Open Workspace popover on the sidebar's project header: Recents, On This
 * Mac (search, pick one or several), Start from scratch, New Project (from a name), Use
 * Existing (open a folder or clone from a host), New Folder. Same panel look as the filter menu.
 */
export function showAgentHomeWorkspaceMenu(
	contextViewService: IContextViewService,
	anchor: HTMLElement,
	host: IAgentHomeWorkspaceMenuHost,
): void {
	contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.LEFT,
		render: container => {
			const close = () => contextViewService.hideContextView();
			const store = new DisposableStore();
			store.add(new AgentHomeWorkspaceMenu(container, host, close));
			anchor.classList.add('open');
			store.add(toDisposable(() => anchor.classList.remove('open')));
			store.add(addDisposableListener(getWindow(anchor).document, 'mousedown', e => {
				if (!(e.target instanceof Node)) {
					return;
				}
				if (contextViewService.getContextViewElement().contains(e.target) || anchor.contains(e.target)) {
					return;
				}
				close();
			}, true));
			store.add(addDisposableListener(getWindow(anchor), 'keydown', e => {
				if (e.key === 'Escape') {
					e.preventDefault();
					close();
				}
			}));
			return store;
		},
	});
}

interface IRowOptions {
	readonly label: string;
	readonly icon?: ThemeIcon | HTMLElement;
	readonly description?: string;
	/** Present on multi-select rows: whether the box is ticked. */
	readonly checked?: boolean;
	readonly submenu?: FlyoutKind;
	/** The project the menu was opened from: a trailing check. */
	readonly current?: boolean;
	readonly onClick?: () => void;
	readonly onHover?: () => void;
}

class AgentHomeWorkspaceMenu extends Disposable {

	private readonly menu: HTMLElement;
	private readonly flyout: HTMLElement;
	private readonly search: HTMLInputElement;
	private readonly body: HTMLElement;
	private readonly bodyStore = this._register(new DisposableStore());
	private readonly flyoutStore = this._register(new DisposableStore());

	private query = '';
	private flyoutKind: FlyoutKind | undefined;
	private macQuery = '';
	private multiple = false;
	private readonly selected = new Map<string, IAgentHomeWorkspaceEntry>();
	private cloneProvider: AgentCloneProvider = 'github';
	private cloneUrl = '';
	private folderName = '';
	private projectName = '';
	private busy = false;
	private error: string | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly host: IAgentHomeWorkspaceMenuHost,
		private readonly close: () => void,
	) {
		super();
		container.classList.add('volt-agent-home-filter-menu-host', 'volt-agent-home-workspace-menu-host');
		this.menu = append(container, $('.volt-agent-home-filter-menu.volt-agent-home-workspace-menu'));
		this.flyout = append(container, $('.volt-agent-home-filter-flyout.volt-agent-home-workspace-flyout.hidden'));

		this.search = this.input(this.menu, localize('voltAgent.workspace.search', "Search repos and folders..."));
		this.search.classList.add('volt-agent-home-workspace-search');
		this._register(addDisposableListener(this.search, 'input', () => {
			this.query = this.search.value;
			if (this.query.trim()) {
				this.hideFlyout();
			}
			this.paintBody();
		}));
		this._register(addDisposableListener(this.search, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const first = this.query.trim() ? filterAgentHomeWorkspaceEntries(this.host.entries, this.query)[0] : undefined;
				if (first) {
					this.open([first.uri]);
				}
			}
		}));
		this.body = append(this.menu, $('.volt-agent-home-workspace-body'));
		this.paintBody();

		this._register(addDisposableListener(container, 'keydown', e => this.onKeyDown(e)));
		this.search.focus();
	}

	//#region Main list

	private paintBody(): void {
		this.bodyStore.clear();
		clearNode(this.body);
		const store = this.bodyStore;
		const closeHover = () => this.openFlyout(undefined);

		if (this.query.trim()) {
			const matches = filterAgentHomeWorkspaceEntries(this.host.entries, this.query);
			const list = append(this.body, $('.volt-agent-home-workspace-list'));
			if (!matches.length) {
				this.note(list, localize('voltAgent.workspace.noMatches', "No folders match"));
			}
			for (const entry of matches) {
				this.row(list, store, {
					label: entry.name,
					description: entry.path,
					icon: createHomeFolderIcon(),
					current: this.isCurrent(entry.uri),
					onClick: () => this.open([entry.uri]),
					onHover: closeHover,
				});
			}
			return;
		}

		const recents = this.host.entries.slice(0, AGENT_HOME_RECENT_LIMIT);
		if (recents.length) {
			this.heading(this.body, localize('voltAgent.workspace.recents', "Recents"));
			for (const entry of recents) {
				this.row(this.body, store, {
					label: entry.name,
					icon: createHomeFolderIcon(),
					current: this.isCurrent(entry.uri),
					onClick: () => this.open([entry.uri]),
					onHover: closeHover,
				});
			}
			this.separator(this.body);
		}

		this.heading(this.body, localize('voltAgent.workspace.repos', "Repos"));
		this.row(this.body, store, {
			label: localize('voltAgent.workspace.onThisMac', "On This Mac"),
			icon: createHomeLaptopIcon(),
			submenu: 'mac',
			onHover: () => this.openFlyout('mac'),
		});
		this.row(this.body, store, {
			label: localize('voltAgent.workspace.fromScratch', "Start from scratch"),
			icon: Codicon.add,
			onClick: () => this.run(() => this.host.startFromScratch()),
			onHover: closeHover,
		});
		this.row(this.body, store, {
			label: localize('voltAgent.workspace.newProject', "New Project..."),
			icon: Codicon.repo,
			submenu: 'newProject',
			onClick: () => this.openFlyout('newProject', true),
			onHover: closeHover,
		});
		this.separator(this.body);
		this.row(this.body, store, {
			label: localize('voltAgent.workspace.useExisting', "Use Existing..."),
			icon: Codicon.folderOpened,
			submenu: 'existing',
			onHover: () => this.openFlyout('existing'),
		});
		this.row(this.body, store, {
			label: localize('voltAgent.workspace.newFolder', "New Folder"),
			icon: createHomeOpenWorkspaceIcon(),
			submenu: 'newFolder',
			onClick: () => this.openFlyout('newFolder', true),
			onHover: closeHover,
		});
		this.syncExpanded();
	}

	//#endregion

	//#region Flyouts

	/**
	 * Hover opens a submenu, like a native menu. Hovering a plain row closes a
	 * hover submenu, but a form being filled in stays until another one opens.
	 */
	private openFlyout(kind: FlyoutKind | undefined, focus = false): void {
		if (this.busy) {
			return;
		}
		if (!kind) {
			if (this.flyoutKind === 'mac' || this.flyoutKind === 'existing') {
				this.hideFlyout();
			}
			return;
		}
		if (this.flyoutKind === kind && !this.flyout.classList.contains('hidden')) {
			if (focus) {
				this.focusFlyout();
			}
			return;
		}
		this.flyoutKind = kind;
		this.error = undefined;
		this.paintFlyout();
		if (focus) {
			this.focusFlyout();
		}
	}

	private hideFlyout(): void {
		this.flyoutKind = undefined;
		this.flyoutStore.clear();
		clearNode(this.flyout);
		this.flyout.classList.add('hidden');
		this.syncExpanded();
	}

	private paintFlyout(): void {
		const kind = this.flyoutKind;
		if (!kind) {
			this.hideFlyout();
			return;
		}
		this.flyoutStore.clear();
		clearNode(this.flyout);
		this.flyout.classList.remove('hidden');
		this.flyout.classList.toggle('form', isFormFlyout(kind));
		switch (kind) {
			case 'mac':
				this.paintMac();
				break;
			case 'existing':
				this.paintExisting();
				break;
			case 'clone':
				this.paintClone();
				break;
			case 'newFolder':
				this.paintNewFolder();
				break;
			case 'newProject':
				this.paintNewProject();
				break;
			default: {
				const unexpected: never = kind;
				return unexpected;
			}
		}
		this.syncExpanded();
		this.placeFlyout();
	}

	private focusFlyout(): void {
		const target = this.flyout.querySelector<HTMLElement>('input:not(:disabled), button.volt-agent-home-workspace-row');
		target?.focus();
	}

	/** On This Mac: every known local folder, searchable, one or several at a time. */
	private paintMac(): void {
		const store = this.flyoutStore;
		const search = this.input(this.flyout, localize('voltAgent.workspace.searchMac', "Search This Mac..."));
		search.classList.add('volt-agent-home-workspace-search');
		search.value = this.macQuery;

		const toggle = this.row(this.flyout, store, {
			label: localize('voltAgent.workspace.selectMultiple', "Select Multiple"),
			icon: createHomeFoldersIcon(),
			onClick: () => {
				this.multiple = !this.multiple;
				this.paintFlyout();
				this.flyout.querySelector<HTMLElement>('.volt-agent-home-workspace-row.toggle')?.focus();
			},
		});
		toggle.classList.add('toggle');
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(this.multiple));
		const knob = append(toggle.querySelector('.trailing')!, $('span.volt-agent-home-workspace-switch'));
		knob.classList.toggle('on', this.multiple);
		this.separator(this.flyout);

		const selectedStore = store.add(new DisposableStore());
		const selectedBlock = this.multiple ? append(this.flyout, $('.volt-agent-home-workspace-selected')) : undefined;
		const paintSelected = () => {
			if (!selectedBlock) {
				return;
			}
			selectedStore.clear();
			clearNode(selectedBlock);
			this.heading(selectedBlock, localize('voltAgent.workspace.selected', "Selected"));
			if (!this.selected.size) {
				this.note(selectedBlock, localize('voltAgent.workspace.noneSelected', "No folders selected"));
			}
			for (const entry of this.selected.values()) {
				const row = this.row(selectedBlock, selectedStore, {
					label: entry.name,
					description: entry.path,
					icon: createHomeFolderIcon(),
					onClick: () => toggleEntry(entry),
				});
				row.querySelector('.trailing')!.appendChild(renderIcon(Codicon.close));
				row.setAttribute('aria-label', localize('voltAgent.workspace.unselect', "Remove {0}", entry.path));
			}
			if (this.selected.size) {
				const submit = this.submit(selectedBlock, selectedStore, this.selected.size === 1
					? localize('voltAgent.workspace.openOne', "Open Folder")
					: localize('voltAgent.workspace.openMany', "Open {0} Folders", this.selected.size), () => this.open([...this.selected.values()].map(entry => entry.uri)));
				submit.classList.add('inline');
			}
			this.separator(selectedBlock);
		};

		const list = append(this.flyout, $('.volt-agent-home-workspace-list.scroll'));
		const listStore = store.add(new DisposableStore());
		const toggleEntry = (entry: IAgentHomeWorkspaceEntry) => {
			const key = entry.uri.toString();
			if (this.selected.has(key)) {
				this.selected.delete(key);
			} else {
				this.selected.set(key, entry);
			}
			for (const row of list.querySelectorAll<HTMLElement>('.volt-agent-home-workspace-row')) {
				if (row.dataset.key === key) {
					row.classList.toggle('checked', this.selected.has(key));
					row.setAttribute('aria-checked', String(this.selected.has(key)));
				}
			}
			paintSelected();
			this.placeFlyout();
		};
		const paintList = () => {
			listStore.clear();
			clearNode(list);
			const matches = filterAgentHomeWorkspaceEntries(this.host.entries, this.macQuery);
			if (!matches.length) {
				this.note(list, this.macQuery.trim()
					? localize('voltAgent.workspace.noMatches', "No folders match")
					: localize('voltAgent.workspace.noFolders', "No folders yet. Open one below."));
			}
			for (const entry of matches) {
				const key = entry.uri.toString();
				const row = this.row(list, listStore, {
					label: entry.path,
					icon: createHomeFolderIcon(),
					checked: this.multiple ? this.selected.has(key) : undefined,
					current: !this.multiple && this.isCurrent(entry.uri),
					onClick: () => this.multiple ? toggleEntry(entry) : this.open([entry.uri]),
				});
				row.dataset.key = key;
			}
		};
		store.add(addDisposableListener(search, 'input', () => {
			this.macQuery = search.value;
			paintList();
			this.placeFlyout();
		}));
		store.add(addDisposableListener(search, 'keydown', e => {
			if (e.key !== 'Enter') {
				return;
			}
			e.preventDefault();
			const first = filterAgentHomeWorkspaceEntries(this.host.entries, this.macQuery)[0];
			if (first) {
				if (this.multiple) {
					toggleEntry(first);
				} else {
					this.open([first.uri]);
				}
			}
		}));
		paintSelected();
		paintList();

		this.separator(this.flyout);
		this.row(this.flyout, store, {
			label: localize('voltAgent.workspace.openFolder', "Open Folder"),
			icon: Codicon.folderOpened,
			onClick: () => {
				this.run(() => this.host.browse());
			},
		});
	}

	/** Use Existing: a folder already on disk, or a clone from a Git host. */
	private paintExisting(): void {
		const store = this.flyoutStore;
		this.row(this.flyout, store, {
			label: localize('voltAgent.workspace.openFolderEllipsis', "Open Folder..."),
			icon: Codicon.folderOpened,
			onClick: () => this.run(() => this.host.browse()),
		});
		this.separator(this.flyout);
		this.heading(this.flyout, localize('voltAgent.workspace.cloneFrom', "Clone Repository"));
		this.row(this.flyout, store, {
			label: localize('voltAgent.workspace.browseGitHub', "Your GitHub repositories..."),
			icon: Codicon.github,
			onClick: () => this.run(() => this.host.browseGitHub()),
		});
		for (const provider of AGENT_CLONE_PROVIDERS) {
			this.row(this.flyout, store, {
				label: cloneProviderLabel(provider),
				icon: providerIcon(provider),
				onClick: () => {
					this.cloneProvider = provider;
					this.openFlyout('clone', true);
				},
			});
		}
	}

	/** Paste a repository URL (or owner/repo on a host) and clone it into the location. */
	private paintClone(): void {
		const store = this.flyoutStore;
		const header = append(this.flyout, $('.volt-agent-home-workspace-form-header'));
		const back = append(header, $('button.volt-agent-home-workspace-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.chevronLeft));
		back.setAttribute('aria-label', localize('voltAgent.workspace.back', "Back"));
		back.disabled = this.busy;
		store.add(addDisposableListener(back, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.openFlyout('existing', true);
		}));
		const title = append(header, $('span.title'));
		const icon = providerIcon(this.cloneProvider);
		title.appendChild(isHTMLElement(icon) ? icon : renderIcon(icon));
		append(title, $('span')).textContent = localize('voltAgent.workspace.cloneFromHost', "Clone from {0}", cloneProviderLabel(this.cloneProvider));

		const form = append(this.flyout, $('.volt-agent-home-workspace-form'));
		const url = this.input(form, cloneProviderPlaceholder(this.cloneProvider));
		url.classList.add('field');
		url.value = this.cloneUrl;
		url.disabled = this.busy;
		url.setAttribute('aria-label', localize('voltAgent.workspace.repoUrl', "Repository URL"));
		this.location(form, store, localize('voltAgent.workspace.cloneInto', "Clone into"));
		const message = append(form, $('.volt-agent-home-workspace-error'));
		message.textContent = this.error ?? '';
		const submit = this.submit(form, store, this.busy
			? localize('voltAgent.workspace.cloning', "Cloning...")
			: localize('voltAgent.workspace.clone', "Clone"), () => void this.submitClone());
		const sync = () => {
			submit.disabled = this.busy || !resolveCloneUrl(this.cloneProvider, this.cloneUrl);
		};
		sync();
		store.add(addDisposableListener(url, 'input', () => {
			this.cloneUrl = url.value;
			this.error = undefined;
			message.textContent = '';
			sync();
		}));
		store.add(addDisposableListener(url, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submitClone();
			}
		}));
		submit.classList.toggle('busy', this.busy);
	}

	private async submitClone(): Promise<void> {
		if (this.busy) {
			return;
		}
		const url = resolveCloneUrl(this.cloneProvider, this.cloneUrl);
		if (!url) {
			this.error = localize('voltAgent.workspace.badUrl', "Paste a repository URL.");
			this.paintFlyout();
			this.focusFlyout();
			return;
		}
		await this.whileBusy(() => this.host.clone(url));
	}

	/** New Folder: a name, created inside the location. */
	private paintNewFolder(): void {
		const store = this.flyoutStore;
		this.heading(this.flyout, localize('voltAgent.workspace.newFolder', "New Folder"));
		const form = append(this.flyout, $('.volt-agent-home-workspace-form'));
		const name = this.input(form, localize('voltAgent.workspace.folderName', "Folder name"));
		name.classList.add('field');
		name.value = this.folderName;
		name.disabled = this.busy;
		name.setAttribute('aria-label', localize('voltAgent.workspace.folderName', "Folder name"));
		this.location(form, store, localize('voltAgent.workspace.createIn', "Create in"));
		const message = append(form, $('.volt-agent-home-workspace-error'));
		message.textContent = this.error ?? '';
		const submit = this.submit(form, store, localize('voltAgent.workspace.create', "Create"), () => void this.submitNewFolder());
		const sync = () => {
			submit.disabled = this.busy || !name.value.trim();
		};
		sync();
		store.add(addDisposableListener(name, 'input', () => {
			this.folderName = name.value;
			this.error = undefined;
			message.textContent = '';
			sync();
		}));
		store.add(addDisposableListener(name, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submitNewFolder();
			}
		}));
	}

	private async submitNewFolder(): Promise<void> {
		if (this.busy) {
			return;
		}
		const problem = newFolderNameProblem(this.folderName);
		if (problem) {
			this.error = problem;
			this.paintFlyout();
			this.focusFlyout();
			return;
		}
		const name = this.folderName.trim();
		await this.whileBusy(() => this.host.createFolder(name));
	}

	/** New Project: a name; the project becomes a repository with a README and a first commit. */
	private paintNewProject(): void {
		const store = this.flyoutStore;
		this.heading(this.flyout, localize('voltAgent.workspace.newProjectHeading', "New Project"));
		const form = append(this.flyout, $('.volt-agent-home-workspace-form'));
		const name = this.input(form, localize('voltAgent.workspace.projectName', "Project name"));
		name.classList.add('field');
		name.value = this.projectName;
		name.disabled = this.busy;
		this.location(form, store, localize('voltAgent.workspace.createIn', "Create in"));
		const message = append(form, $('.volt-agent-home-workspace-error'));
		message.textContent = this.error ?? '';
		const submit = this.submit(form, store, this.busy
			? localize('voltAgent.workspace.creating', "Creating...")
			: localize('voltAgent.workspace.create', "Create"), () => void this.submitNewProject());
		const sync = () => {
			submit.disabled = this.busy || !name.value.trim();
		};
		sync();
		store.add(addDisposableListener(name, 'input', () => {
			this.projectName = name.value;
			this.error = undefined;
			message.textContent = '';
			sync();
		}));
		store.add(addDisposableListener(name, 'keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.submitNewProject();
			}
		}));
		submit.classList.toggle('busy', this.busy);
	}

	private async submitNewProject(): Promise<void> {
		if (this.busy) {
			return;
		}
		const problem = newProjectNameProblem(this.projectName);
		if (problem) {
			this.error = problem;
			this.paintFlyout();
			this.focusFlyout();
			return;
		}
		const name = this.projectName.trim();
		await this.whileBusy(() => this.host.createProject(name));
	}

	/** Runs a form action with its inputs locked. Closes on success, shows the message on failure. */
	private async whileBusy(action: () => Promise<string | undefined>): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.paintFlyout();
		let error: string | undefined;
		try {
			error = await action();
		} catch (err) {
			error = toErrorMessage(err);
		}
		if (this._store.isDisposed) {
			if (error) {
				this.host.reportError(error);
			}
			return;
		}
		this.busy = false;
		if (!error) {
			this.close();
			return;
		}
		this.error = error;
		this.paintFlyout();
		this.focusFlyout();
	}

	/** Where the folder goes, with Change next to it. */
	private location(parent: HTMLElement, store: DisposableStore, label: string): void {
		const line = append(parent, $('.volt-agent-home-workspace-location'));
		append(line, $('span.caption')).textContent = label;
		append(line, $('span.path')).textContent = this.host.location();
		const change = append(line, $('button.link')) as HTMLButtonElement;
		change.type = 'button';
		change.textContent = localize('voltAgent.workspace.change', "Change");
		change.disabled = this.busy;
		store.add(addDisposableListener(change, 'click', async e => {
			e.preventDefault();
			e.stopPropagation();
			await this.host.changeLocation();
			if (this._store.isDisposed) {
				return;
			}
			this.paintFlyout();
			this.focusFlyout();
		}));
	}

	private syncExpanded(): void {
		const owner = this.flyoutKind === 'clone' ? 'existing' : this.flyoutKind;
		for (const row of this.menu.querySelectorAll<HTMLElement>('[data-flyout]')) {
			const open = row.dataset.flyout === owner;
			row.classList.toggle('expanded', open);
			row.setAttribute('aria-expanded', String(open));
		}
	}

	/** Beside the main list, level with its row, kept inside the window. */
	private placeFlyout(): void {
		if (this.flyout.classList.contains('hidden')) {
			return;
		}
		const owner = this.flyoutKind === 'clone' ? 'existing' : this.flyoutKind;
		const row = owner ? this.menu.querySelector<HTMLElement>(`[data-flyout="${owner}"]`) : null;
		const win = getWindow(this.container);
		const box = this.container.getBoundingClientRect();
		const width = this.flyout.offsetWidth;
		const height = this.flyout.offsetHeight;
		const margin = 8;
		// Right of the list, else left of it; with no room on either side, inside the window over the list.
		const right = this.menu.offsetWidth + 4;
		let left = right;
		if (box.left + right + width > win.innerWidth - margin) {
			left = box.left - width - 4 >= margin
				? -(width + 4)
				: Math.max(margin, win.innerWidth - margin - width) - box.left;
		}
		// Less the flyout's border, so its first row lines up with this one.
		let top = row ? row.offsetTop - 1 : 0;
		top = Math.min(top, win.innerHeight - margin - box.top - height);
		top = Math.max(top, margin - box.top);
		this.flyout.style.position = 'absolute';
		this.flyout.style.left = `${left}px`;
		this.flyout.style.top = `${top}px`;
	}

	//#endregion

	//#region Pieces

	private isCurrent(uri: URI): boolean {
		return !!this.host.current && isEqual(uri, this.host.current);
	}

	private open(folders: readonly URI[]): void {
		if (folders.length) {
			this.run(() => this.host.openFolders(folders, this.host.current));
		}
	}

	/** Closes first so a dialog or the new chat is not covered by the menu. */
	private run(action: () => Promise<void>): void {
		const host = this.host;
		this.close();
		action().catch(err => host.reportError(toErrorMessage(err)));
	}

	private row(parent: HTMLElement, store: DisposableStore, options: IRowOptions): HTMLButtonElement {
		const row = append(parent, $('button.volt-agent-home-filter-row.volt-agent-home-workspace-row')) as HTMLButtonElement;
		row.type = 'button';
		if (options.submenu) {
			row.dataset.flyout = options.submenu;
			row.setAttribute('aria-haspopup', 'true');
		}
		if (options.checked !== undefined) {
			row.classList.add('selectable');
			row.classList.toggle('checked', options.checked);
			row.setAttribute('role', 'menuitemcheckbox');
			row.setAttribute('aria-checked', String(options.checked));
			append(row, $('span.checkbox')).appendChild(renderIcon(Codicon.check));
		}
		const leading = append(row, $('span.leading'));
		if (options.icon) {
			// An element has a string `id` too, so test for the element rather than the theme icon.
			leading.appendChild(isHTMLElement(options.icon) ? options.icon : renderIcon(options.icon));
		}
		append(row, $('span.label')).textContent = options.label;
		if (options.description) {
			row.classList.add('has-description');
			append(row, $('span.description')).textContent = options.description;
		}
		const trailing = append(row, $('span.trailing'));
		if (options.current) {
			row.classList.add('current');
			row.setAttribute('aria-current', 'true');
			trailing.appendChild(renderIcon(Codicon.check));
		}
		if (options.submenu && options.submenu !== 'newFolder' && options.submenu !== 'newProject') {
			trailing.appendChild(renderIcon(Codicon.chevronRight));
		}
		if (options.onHover) {
			store.add(addDisposableListener(row, 'mouseenter', () => options.onHover?.()));
		}
		store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (options.onClick) {
				options.onClick();
			} else if (options.submenu) {
				this.openFlyout(options.submenu, true);
			}
		}));
		return row;
	}

	private submit(parent: HTMLElement, store: DisposableStore, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.volt-agent-home-workspace-submit')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		store.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!button.disabled) {
				run();
			}
		}));
		return button;
	}

	private input(parent: HTMLElement, placeholder: string): HTMLInputElement {
		const input = append(parent, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = placeholder;
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.setAttribute('aria-label', placeholder);
		return input;
	}

	private heading(parent: HTMLElement, label: string): void {
		append(parent, $('.volt-agent-home-filter-heading')).textContent = label;
	}

	private note(parent: HTMLElement, label: string): void {
		append(parent, $('.volt-agent-home-workspace-note')).textContent = label;
	}

	private separator(parent: HTMLElement): void {
		append(parent, $('.volt-agent-home-filter-sep'));
	}

	/** Arrows move between rows of the panel in focus; Right opens a submenu, Left goes back. */
	private onKeyDown(e: KeyboardEvent): void {
		const target = e.target;
		if (!isHTMLElement(target)) {
			return;
		}
		const inFlyout = this.flyout.contains(target);
		const panel = inFlyout ? this.flyout : this.menu;
		const isInput = target.tagName === 'INPUT';
		switch (e.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				const items = [...panel.querySelectorAll<HTMLElement>('input:not(:disabled), button.volt-agent-home-workspace-row')];
				if (!items.length) {
					return;
				}
				const index = items.indexOf(target);
				const step = e.key === 'ArrowDown' ? 1 : -1;
				const next = items[index < 0 ? 0 : (index + step + items.length) % items.length];
				e.preventDefault();
				next.focus();
				next.scrollIntoView({ block: 'nearest' });
				return;
			}
			case 'ArrowRight': {
				const kind = target.dataset.flyout as FlyoutKind | undefined;
				if (!isInput && kind) {
					e.preventDefault();
					this.openFlyout(kind, true);
				}
				return;
			}
			case 'ArrowLeft': {
				if (inFlyout && !isInput) {
					e.preventDefault();
					const owner = this.flyoutKind === 'clone' ? 'existing' : this.flyoutKind;
					this.menu.querySelector<HTMLElement>(`[data-flyout="${owner}"]`)?.focus();
				}
				return;
			}
		}
	}

	//#endregion
}

function providerIcon(provider: AgentCloneProvider): ThemeIcon | HTMLElement {
	switch (provider) {
		case 'github': return Codicon.github;
		case 'gitlab': return createHomeGitLabIcon();
		case 'bitbucket': return createHomeBitbucketIcon();
		case 'url': return Codicon.repoClone;
		default: {
			const unexpected: never = provider;
			return unexpected;
		}
	}
}
