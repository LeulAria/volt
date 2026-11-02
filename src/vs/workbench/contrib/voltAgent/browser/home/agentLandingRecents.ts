/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isKeyboardEvent } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { createHomeFolderIcon } from './agentHomeIcons.js';
import { AGENT_HOME_RECENT_LIMIT, IAgentHomeWorkspaceEntry } from './agentHomeWorkspace.js';
import { AgentHomeWorkspaceActions } from './agentHomeWorkspaceActions.js';

/** Projects shown before "Show N more"; each has a ⌘1 to ⌘3 shortcut. */
const VISIBLE = 3;
const ROW_HEIGHT = 30;
/** "Recent projects" above the rows (agentEditor.css). */
const HEAD_HEIGHT = 24;

/** The last list read, so the next new chat draws it at once instead of moving the composer when it lands. */
let lastEntries: readonly IAgentHomeWorkspaceEntry[] = [];

export interface IAgentLandingRecentsHost {
	/** Whether the new chat has a project; the list shows only without one. */
	hasProject(): boolean;
	/** Loads the folder into the new chat. */
	openProject(folder: URI): Promise<void>;
	/** Whether ⌘1 to ⌘3 pressed on this target belong to this chat. */
	ownsKey(e: KeyboardEvent): boolean;
	focusComposer(): void;
}

type RecentRow =
	| { readonly kind: 'project'; readonly entry: IAgentHomeWorkspaceEntry; readonly parent: string; readonly index: number }
	| { readonly kind: 'more'; readonly hidden: number; readonly open: boolean };

class RecentDelegate implements IListVirtualDelegate<RecentRow> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return RecentRenderer.TEMPLATE_ID;
	}
}

interface IRecentTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly path: HTMLElement;
	readonly key: HTMLElement;
}

class RecentRenderer implements IListRenderer<RecentRow, IRecentTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentLandingRecent';
	readonly templateId = RecentRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IRecentTemplate {
		container.classList.add('volt-agent-landing-recent');
		return {
			row: container,
			icon: append(container, $('span.icon')),
			name: append(container, $('span.name')),
			path: append(container, $('span.path')),
			key: append(container, $('span.key')),
		};
	}

	renderElement(element: RecentRow, _index: number, template: IRecentTemplate): void {
		template.row.classList.toggle('more', element.kind === 'more');
		if (element.kind === 'more') {
			template.icon.replaceChildren(renderIcon(element.open ? Codicon.chevronUp : Codicon.chevronDown));
			template.name.textContent = moreLabel(element);
			template.path.textContent = '';
			template.key.textContent = '';
			return;
		}
		template.icon.replaceChildren(createHomeFolderIcon());
		template.name.textContent = element.entry.name;
		template.path.textContent = element.parent;
		template.key.textContent = element.index < VISIBLE ? shortcutLabel(element.index) : '';
	}

	disposeTemplate(): void { }
}

function moreLabel(row: { readonly hidden: number; readonly open: boolean }): string {
	return row.open
		? localize('voltAgent.recentProjects.less', "Show less")
		: localize('voltAgent.recentProjects.more', "Show {0} more", row.hidden);
}

function shortcutLabel(index: number): string {
	return isMacintosh ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

/** The row ⌘1 to ⌘3 (Ctrl off a Mac) picks, if the key is one of them. */
function shortcutIndex(e: KeyboardEvent): number | undefined {
	const primary = isMacintosh ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
	const digit = /^Digit(\d)$/.exec(e.code);
	const index = digit ? Number(digit[1]) - 1 : -1;
	return primary && !e.altKey && !e.shiftKey && index >= 0 && index < VISIBLE ? index : undefined;
}

/**
 * "Recent projects" under a new chat's composer while it has no project, as Cezar offers them: the
 * project menu's folders (VS Code's recents, Volt's projects, Claude Code's history), three at
 * first, then "Show N more". A row, or ⌘1 to ⌘3, loads that folder into the new chat.
 */
export class AgentLandingRecents extends Disposable {

	readonly element: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly list: WorkbenchList<RecentRow>;
	private entries: readonly IAgentHomeWorkspaceEntry[] = [];
	/** Folders found gone on a click; Claude Code's history would list them again. */
	private readonly missing = new ResourceSet();
	private showAll = false;
	private request = 0;

	constructor(
		private readonly host: IAgentLandingRecentsHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IVoltSessionContextService sessionContext: IVoltSessionContextService,
	) {
		super();
		this.element = $('.volt-agent-landing-recents.hidden');
		append(this.element, $('.volt-agent-landing-recents-head')).textContent = localize('voltAgent.recentProjects', "Recent projects");
		this.listHost = append(this.element, $('.volt-agent-landing-recents-list'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<RecentRow>, 'VoltAgentLandingRecents', this.listHost, new RecentDelegate(), [new RecentRenderer()], {
			identityProvider: { getId: (row: RecentRow) => row.kind === 'more' ? 'more' : row.entry.uri.toString() },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAgent.recentProjects', "Recent projects"),
				getAriaLabel: (row: RecentRow) => row.kind === 'more' ? moreLabel(row) : `${row.entry.name}, ${row.entry.path}`,
			},
		}));
		this._register(this.list.onDidOpen(e => {
			if (e.element?.kind === 'more') {
				this.showAll = !this.showAll;
				this.render();
				// Rows are actions, not a selection: after a click only the hover shows and typing goes
				// to the composer again. The keyboard keeps its place.
				this.list.setSelection([]);
				if (isKeyboardEvent(e.browserEvent)) {
					this.list.setFocus([this.list.length - 1]);
				} else {
					this.list.setFocus([]);
					this.host.focusComposer();
				}
			} else if (e.element) {
				void this.open(e.element.entry);
			}
		}));
		this._register(sessionContext.onDidChangeActiveProject(() => this.refresh()));
		this._register(sessionContext.onDidChangeProjects(() => this.refresh()));
		this._register(workspacesService.onDidChangeRecentlyOpened(() => this.refresh()));
		// Claude Code may have worked in another folder meanwhile.
		this._register(addDisposableListener(getWindow(this.element), 'focus', () => this.refresh()));
		this._register(addDisposableListener(getWindow(this.element), 'keydown', e => {
			const index = shortcutIndex(e);
			const entry = index === undefined ? undefined : this.entries[index];
			if (!entry || !this.isShown() || !this.host.ownsKey(e)) {
				return;
			}
			// Before anything else hears the key (Cmd+1 focuses the first editor group).
			e.preventDefault();
			e.stopPropagation();
			void this.open(entry);
		}, true));
		this.refresh();
	}

	/** Reads the folders again; the list shows while the new chat has no project. */
	refresh(): void {
		const request = ++this.request;
		if (this.host.hasProject()) {
			this.show([]);
			return;
		}
		if (!this.entries.length) {
			this.show(lastEntries);
		}
		void this.instantiationService.createInstance(AgentHomeWorkspaceActions).entries().then(entries => {
			lastEntries = entries.slice(0, AGENT_HOME_RECENT_LIMIT);
			if (request === this.request && !this.host.hasProject()) {
				this.show(lastEntries);
			}
		}, () => undefined);
	}

	private isShown(): boolean {
		return !this.element.classList.contains('hidden') && this.element.offsetWidth > 0;
	}

	private show(entries: readonly IAgentHomeWorkspaceEntry[]): void {
		this.entries = entries.filter(entry => !this.missing.has(entry.uri));
		if (!this.entries.length) {
			this.showAll = false;
		}
		this.render();
	}

	private render(): void {
		const entries = this.entries;
		this.element.classList.toggle('hidden', !entries.length);
		const shown = this.showAll ? entries : entries.slice(0, VISIBLE);
		const rows: RecentRow[] = shown.map((entry, index) => ({ kind: 'project', entry, index, parent: this.labelService.getUriLabel(dirname(entry.uri)) }));
		const hidden = entries.length - Math.min(entries.length, VISIBLE);
		if (hidden > 0) {
			rows.push({ kind: 'more', hidden, open: this.showAll });
		}
		// The block keeps its folded height, so "Show more" grows the list downward and the
		// centered composer above it stays where it is.
		const folded = Math.min(entries.length, VISIBLE) + (hidden > 0 ? 1 : 0);
		this.element.style.height = `${HEAD_HEIGHT + folded * ROW_HEIGHT}px`;
		const height = rows.length * ROW_HEIGHT;
		this.listHost.style.height = `${height}px`;
		this.list.layout(height);
		this.list.splice(0, this.list.length, rows);
	}

	private async open(entry: IAgentHomeWorkspaceEntry): Promise<void> {
		// Claude Code's history can name a deleted folder: those under Desktop and the like are listed unchecked.
		if (!await this.fileService.stat(entry.uri).then(stat => stat.isDirectory, () => false)) {
			this.missing.add(entry.uri);
			this.show(this.entries);
			this.notificationService.warn(localize('voltAgent.recentProjects.missing', "{0} was moved or deleted.", entry.path));
			return;
		}
		void this.workspacesService.addRecentlyOpened([{ folderUri: entry.uri }]);
		await this.host.openProject(entry.uri);
	}
}
