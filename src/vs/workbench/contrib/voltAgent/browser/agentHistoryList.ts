/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentHistoryList.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AgentSessionStatus, IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/agentHistory.js';
import { AgentEditorInput } from './agentEditorInput.js';
import { groupSessionsByDate } from './agentHistoryGroups.js';
import { createAgentScrollable } from './agentScrollable.js';
import { setAgentTooltip } from './agentTooltip.js';

export interface IAgentHistoryListOptions {
	/** Title-only rows (the clock dropdown); full rows add a summary line. */
	readonly compact?: boolean;
	/** Rows shown per date group before a "More" row. */
	readonly pageSize?: number;
	/** Render the search box as the first row. */
	readonly search?: boolean;
	/** Only sessions of the current workspace (default) or every workspace. */
	readonly allWorkspaces?: boolean;
	/** Renders fixed content between the search row and the scrolling list. */
	readonly renderHeader?: (parent: HTMLElement) => void;
	readonly onOpen: (session: IAgentSessionMeta) => void;
}

export function statusIcon(status: AgentSessionStatus, hasDraft?: boolean): ThemeIcon {
	switch (status) {
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'error': return Codicon.error;
		case 'cancelled': return Codicon.circleSlash;
		case 'interrupted': return Codicon.warning;
		case 'idle': return hasDraft ? Codicon.edit : Codicon.circleLargeOutline;
		default: return Codicon.pass;
	}
}

function sessionSummary(session: IAgentSessionMeta): string {
	switch (session.status) {
		case 'running':
			return session.summary || localize('voltAgent.history.working', "Working…");
		case 'interrupted':
			// The stored summary is the last streaming status ("Thinking"), which
			// is misleading once the run was cut short by an app shutdown.
			return localize('voltAgent.history.interrupted', "Interrupted");
		case 'cancelled':
			return localize('voltAgent.history.cancelled', "Stopped");
		case 'error':
			return session.summary || localize('voltAgent.history.failed', "Failed");
	}
	if (session.summary) {
		return session.summary;
	}
	if (session.turnCount === 0) {
		return localize('voltAgent.history.draft', "Draft");
	}
	return session.turnCount === 1
		? localize('voltAgent.history.oneTurn', "1 message")
		: localize('voltAgent.history.turns', "{0} messages", session.turnCount);
}

/**
 * The agent history list: a searchable, date-grouped view over the history
 * index. Rendering is index-only (never touches session logs) and re-renders
 * at most once per frame when the index changes.
 */
export class AgentHistoryList extends Disposable {

	readonly element: HTMLElement;

	private readonly listEl: HTMLElement;
	private readonly scroll: DomScrollableElement;
	private searchInput: HTMLInputElement | undefined;
	private query = '';
	private allWorkspaces: boolean;
	private readonly expanded = new Set<string>();
	private readonly rowStore = this._register(new DisposableStore());
	private readonly renderScheduler: RunOnceScheduler;
	private activeSessionId: string | undefined;

	private readonly _onDidOpen = this._register(new Emitter<IAgentSessionMeta>());
	readonly onDidOpen: Event<IAgentSessionMeta> = this._onDidOpen.event;

	constructor(
		container: HTMLElement,
		private readonly options: IAgentHistoryListOptions,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this.allWorkspaces = !!options.allWorkspaces;
		this.element = append(container, $('.volt-agent-history'));
		this.element.classList.toggle('compact', !!options.compact);

		if (options.search) {
			this.renderSearch();
		}
		options.renderHeader?.(this.element);

		this.listEl = $('.volt-agent-history-list');
		this.listEl.setAttribute('role', 'listbox');
		this.scroll = this._register(createAgentScrollable(this.listEl, { verticalScrollbarSize: 6 }));
		this.scroll.getDomNode().classList.add('volt-agent-history-scroll');
		this.element.appendChild(this.scroll.getDomNode());

		this.renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
		this._register(this.history.onDidChange(() => this.renderScheduler.schedule()));
		this._register(addDisposableListener(this.listEl, EventType.KEY_DOWN, e => this.onListKeyDown(new StandardKeyboardEvent(e))));

		void this.history.whenReady.then(() => this.renderScheduler.schedule());
		this.render();
	}

	private renderSearch(): void {
		const row = append(this.element, $('.volt-agent-history-search'));
		row.appendChild(renderIcon(Codicon.search));
		const input = append(row, $('input.volt-agent-history-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.placeholder = localize('voltAgent.history.searchPlaceholder', "Search Agents...");
		input.setAttribute('aria-label', input.placeholder);
		this.searchInput = input;
		const searchScheduler = this._register(new RunOnceScheduler(() => this.setQuery(input.value), 80));
		this._register(addDisposableListener(input, EventType.INPUT, () => searchScheduler.schedule()));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.DownArrow) {
				event.preventDefault();
				this.focusRow(0);
			} else if (event.keyCode === KeyCode.Enter) {
				const first = this.listEl.querySelector<HTMLElement>('.volt-agent-history-item');
				if (first) {
					event.preventDefault();
					first.click();
				}
			} else if (event.keyCode === KeyCode.Escape && input.value) {
				event.preventDefault();
				event.stopPropagation();
				input.value = '';
				this.setQuery('');
			}
		}));
	}

	focus(): void {
		if (this.searchInput) {
			this.searchInput.focus();
			this.searchInput.select();
		} else {
			this.focusRow(0);
		}
	}

	setQuery(query: string): void {
		const next = query.trim();
		if (next === this.query) {
			return;
		}
		this.query = next;
		this.render();
	}

	get showsAllWorkspaces(): boolean {
		return this.allWorkspaces;
	}

	setAllWorkspaces(value: boolean): void {
		if (this.allWorkspaces !== value) {
			this.allWorkspaces = value;
			this.render();
		}
	}

	/** Highlights the session currently shown in the editor. */
	setActiveSession(id: string | undefined): void {
		if (this.activeSessionId === id) {
			return;
		}
		this.activeSessionId = id;
		for (const row of this.listEl.querySelectorAll<HTMLElement>('.volt-agent-history-item')) {
			row.classList.toggle('active', row.dataset.sessionId === id);
		}
	}

	layout(): void {
		this.scroll.scanDomNode();
	}

	private sessions(): IAgentSessionMeta[] {
		const options = this.allWorkspaces ? undefined : { workspaceId: this.history.currentWorkspace.id };
		return this.query ? this.history.search(this.query, options) : this.history.list(options);
	}

	private render(): void {
		this.rowStore.clear();
		clearNode(this.listEl);
		const sessions = this.sessions();
		if (!sessions.length) {
			const empty = append(this.listEl, $('.volt-agent-history-empty'));
			empty.textContent = this.query
				? localize('voltAgent.history.noMatches', "No agents match \"{0}\"", this.query)
				: localize('voltAgent.history.empty', "No agents yet");
			this.scheduleScan();
			return;
		}

		// A search is already ranked; grouping by date would scramble it.
		const groups = this.query
			? [{ key: 'results', label: '', sessions }]
			: groupSessionsByDate(sessions);
		const pageSize = this.options.pageSize ?? Infinity;

		for (const group of groups) {
			const section = append(this.listEl, $('.volt-agent-history-group'));
			section.dataset.group = group.key;
			if (group.label) {
				const heading = append(section, $('.volt-agent-history-heading'));
				heading.textContent = group.label;
				if (group.key === 'pinned') {
					section.classList.add('pinned');
				}
			}
			const showAll = group.key === 'pinned' || this.expanded.has(group.key);
			const visible = showAll ? group.sessions : group.sessions.slice(0, pageSize);
			for (const session of visible) {
				this.renderRow(section, session);
			}
			const hidden = group.sessions.length - visible.length;
			if (hidden > 0) {
				const more = append(section, $('button.volt-agent-history-more')) as HTMLButtonElement;
				more.appendChild(renderIcon(Codicon.ellipsis));
				append(more, $('span')).textContent = localize('voltAgent.history.more', "More");
				setAgentTooltip(more, localize('voltAgent.history.moreCount', "Show {0} more", hidden));
				this.rowStore.add(addDisposableListener(more, EventType.CLICK, e => {
					e.preventDefault();
					this.expanded.add(group.key);
					this.render();
				}));
			}
		}
		this.scheduleScan();
	}

	private renderRow(parent: HTMLElement, session: IAgentSessionMeta): void {
		const row = append(parent, $('.volt-agent-history-item'));
		row.setAttribute('role', 'option');
		row.tabIndex = -1;
		row.dataset.sessionId = session.id;
		row.classList.toggle('active', session.id === this.activeSessionId);
		row.classList.toggle('running', session.status === 'running');

		const icon = append(row, $('span.status'));
		icon.appendChild(renderIcon(session.pinned && this.options.compact ? Codicon.pinned : statusIcon(session.status, session.hasDraft)));

		const copy = append(row, $('span.copy'));
		const title = append(copy, $('span.title'));
		title.textContent = session.title || localize('voltAgent.history.untitled', "New Agent");
		if (!this.options.compact) {
			const summary = append(copy, $('span.summary'));
			summary.textContent = sessionSummary(session);
			if (this.allWorkspaces && session.workspaceId !== this.history.currentWorkspace.id && session.workspaceLabel) {
				const scope = append(copy, $('span.workspace'));
				scope.textContent = session.workspaceLabel;
			}
		}
		setAgentTooltip(row, session.preview && session.preview !== session.title ? session.preview : undefined);

		if (session.hasDraft && session.turnCount > 0) {
			const dot = append(row, $('span.draft-dot'));
			setAgentTooltip(dot, localize('voltAgent.history.hasDraft', "Has an unsent draft"));
		}

		const actions = append(row, $('span.actions'));
		const more = append(actions, $('button.volt-agent-history-action')) as HTMLButtonElement;
		more.appendChild(renderIcon(Codicon.ellipsis));
		setAgentTooltip(more, localize('voltAgent.history.actions', "More Actions"));
		if (this.options.compact) {
			const trash = append(actions, $('button.volt-agent-history-action')) as HTMLButtonElement;
			trash.appendChild(renderIcon(Codicon.trash));
			setAgentTooltip(trash, localize('voltAgent.history.delete', "Delete"));
			this.rowStore.add(addDisposableListener(trash, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.delete(session);
			}));
		} else {
			const pin = append(actions, $('button.volt-agent-history-action')) as HTMLButtonElement;
			pin.appendChild(renderIcon(session.pinned ? Codicon.pinned : Codicon.pin));
			setAgentTooltip(pin, session.pinned ? localize('voltAgent.history.unpin', "Unpin") : localize('voltAgent.history.pin', "Pin"));
			this.rowStore.add(addDisposableListener(pin, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.history.setPinned(session.id, !session.pinned);
			}));
		}

		this.rowStore.add(addDisposableListener(row, EventType.CLICK, e => {
			if (actions.contains(e.target as Node)) {
				return;
			}
			e.preventDefault();
			this.open(session);
		}));
		this.rowStore.add(addDisposableListener(row, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(session, { x: e.clientX, y: e.clientY });
		}));
		this.rowStore.add(addDisposableListener(more, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(session, more);
		}));
	}

	private open(session: IAgentSessionMeta): void {
		this.options.onOpen(session);
		this._onDidOpen.fire(session);
	}

	private showContextMenu(session: IAgentSessionMeta, anchor: HTMLElement | { x: number; y: number }): void {
		const actions: IAction[] = [
			new Action('volt.history.open', localize('voltAgent.history.open', "Open"), undefined, true, () => this.open(session)),
			new Separator(),
			new Action('volt.history.pin', session.pinned ? localize('voltAgent.history.unpin', "Unpin") : localize('voltAgent.history.pin', "Pin"), undefined, true, () => this.history.setPinned(session.id, !session.pinned)),
			new Action('volt.history.rename', localize('voltAgent.history.rename', "Rename..."), undefined, true, () => this.rename(session)),
			new Action('volt.history.archive', session.archived ? localize('voltAgent.history.unarchive', "Unarchive") : localize('voltAgent.history.archive', "Archive"), undefined, true, () => this.history.setArchived(session.id, !session.archived)),
			new Separator(),
			new Action('volt.history.delete', localize('voltAgent.history.delete', "Delete"), undefined, true, () => this.delete(session)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	private async rename(session: IAgentSessionMeta): Promise<void> {
		const value = await this.quickInputService.input({
			prompt: localize('voltAgent.history.renamePrompt', "Agent name"),
			value: session.title,
			valueSelection: [0, session.title.length],
		});
		if (value === undefined) {
			return;
		}
		await this.history.rename(session.id, value.trim() || undefined);
	}

	private async delete(session: IAgentSessionMeta): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltAgent.history.deleteConfirm', "Delete \"{0}\"?", session.title || localize('voltAgent.history.untitled', "New Agent")),
			detail: localize('voltAgent.history.deleteDetail', "The conversation and its draft are removed from disk. This cannot be undone."),
			primaryButton: localize({ key: 'voltAgent.history.deleteButton', comment: ['&& denotes a mnemonic'] }, "&&Delete"),
		});
		if (!confirmed) {
			return;
		}
		// Close open tabs first so nothing keeps writing to the removed log.
		for (const group of this.editorGroupsService.groups) {
			const open = group.editors.filter(editor => editor instanceof AgentEditorInput && editor.sessionId === session.id);
			if (open.length) {
				await group.closeEditors(open);
			}
		}
		await this.history.delete(session.id);
	}

	private rows(): HTMLElement[] {
		return [...this.listEl.querySelectorAll<HTMLElement>('.volt-agent-history-item, .volt-agent-history-more')];
	}

	private focusRow(index: number): void {
		const rows = this.rows();
		const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
		row?.focus();
	}

	private onListKeyDown(event: StandardKeyboardEvent): void {
		const rows = this.rows();
		const current = rows.indexOf(this.listEl.ownerDocument.activeElement as HTMLElement);
		if (event.keyCode === KeyCode.DownArrow) {
			event.preventDefault();
			this.focusRow(current + 1);
		} else if (event.keyCode === KeyCode.UpArrow) {
			event.preventDefault();
			if (current <= 0 && this.searchInput) {
				this.searchInput.focus();
			} else {
				this.focusRow(current - 1);
			}
		} else if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
			if (current >= 0) {
				event.preventDefault();
				rows[current].click();
			}
		}
	}

	private scheduleScan(): void {
		scheduleAtNextAnimationFrame(getWindow(this.listEl), () => this.scroll.scanDomNode());
	}
}
