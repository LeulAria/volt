/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHistoryList.css';
import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../../base/browser/dom.js';
import { FindInput } from '../../../../../base/browser/ui/findinput/findInput.js';
import { ContextScopedFindInput } from '../../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultInputBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { SIDE_BAR_BACKGROUND } from '../../../../common/theme.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { groupSessionsByDate, isDetailedHistoryGroup } from './agentHistoryGroups.js';
import { createHistoryStatusIcon } from './agentHistoryIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

export interface IAgentHistoryAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly keybinding?: string;
	readonly run: () => void;
}

export interface IAgentHistoryListOptions {
	/** Title-only rows (the clock dropdown); full rows add a summary line. */
	readonly compact?: boolean;
	/** Rows shown per date group before a "More" row. */
	readonly pageSize?: number;
	/** Render the search box as the first row. */
	readonly search?: boolean;
	/** Group sessions by date (tree) instead of a flat list. */
	readonly treeView?: boolean;
	/** Only sessions of the current workspace (default) or every workspace. */
	readonly allWorkspaces?: boolean;
	/** Root-level rows above the date groups (New Agent, Customize). */
	readonly actions?: readonly IAgentHistoryAction[];
	readonly onOpen: (session: IAgentSessionMeta) => void;
}

type HistoryActionElement = { readonly type: 'action'; readonly action: IAgentHistoryAction };
type HistoryDividerElement = { readonly type: 'divider' };
type HistoryGroupElement = { readonly type: 'group'; readonly key: string; readonly label: string };
type HistorySessionElement = { readonly type: 'session'; readonly session: IAgentSessionMeta; readonly detailed: boolean };
type HistoryMoreElement = { readonly type: 'more'; readonly groupKey: string; readonly hidden: number };
type HistoryMessageElement = { readonly type: 'message'; readonly text: string };
type HistoryElement = HistoryActionElement | HistoryDividerElement | HistoryGroupElement | HistorySessionElement | HistoryMoreElement | HistoryMessageElement;

const identityProvider: IIdentityProvider<HistoryElement> = {
	getId(element) {
		switch (element.type) {
			case 'action': return `action:${element.action.id}`;
			case 'divider': return 'divider';
			case 'group': return `group:${element.key}`;
			case 'session': return `session:${element.session.id}`;
			case 'more': return `more:${element.groupKey}`;
			case 'message': return 'message';
		}
	}
};

function sessionSummary(session: IAgentSessionMeta): string {
	switch (session.status) {
		case 'running':
			return session.summary || localize('voltAgent.history.working', "Working…");
		case 'interrupted':
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

interface IHistoryTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly name: HTMLElement;
	readonly description: HTMLElement;
	readonly keybinding: HTMLElement;
	readonly draftDot: HTMLElement;
	readonly pin: HTMLButtonElement;
	readonly actions: HTMLElement;
	readonly more: HTMLButtonElement;
	readonly trash: HTMLButtonElement;
	readonly elementDisposables: DisposableStore;
}

interface IHistoryRendererHost {
	readonly compact: boolean;
	readonly allWorkspaces: boolean;
	readonly currentWorkspaceId: string;
	readonly activeSessionId: string | undefined;
	openSession(session: IAgentSessionMeta): void;
	togglePin(session: IAgentSessionMeta): void;
	showMenu(session: IAgentSessionMeta, anchor: HTMLElement): void;
	deleteSession(session: IAgentSessionMeta): void;
	showMore(groupKey: string): void;
	runAction(action: IAgentHistoryAction): void;
}

const ROW_HEIGHT = 22;
const DIVIDER_HEIGHT = 11;

class AgentHistoryDelegate implements IListVirtualDelegate<HistoryElement> {
	constructor(private readonly compact: boolean) { }

	getHeight(element: HistoryElement): number {
		if (element.type === 'divider') {
			return DIVIDER_HEIGHT;
		}
		return element.type === 'session' && element.detailed && !this.compact ? 36 : ROW_HEIGHT;
	}

	getTemplateId(): string {
		return AgentHistoryRenderer.ID;
	}
}

class AgentHistoryRenderer implements ITreeRenderer<HistoryElement, void, IHistoryTemplate> {
	static readonly ID = 'agentHistory';
	readonly templateId = AgentHistoryRenderer.ID;

	constructor(private readonly host: IHistoryRendererHost) { }

	renderTemplate(container: HTMLElement): IHistoryTemplate {
		container.classList.add('volt-agent-history-row');
		const icon = append(container, $('span.status'));
		const text = append(container, $('span.volt-agent-history-text'));
		const name = append(text, $('span.name'));
		const description = append(text, $('span.description'));
		const keybinding = append(container, $('span.keybinding'));
		const draftDot = append(container, $('span.draft-dot'));
		const pin = append(container, $('button.volt-agent-history-action.pin')) as HTMLButtonElement;
		const actions = append(container, $('span.actions'));
		const more = append(actions, $('button.volt-agent-history-action')) as HTMLButtonElement;
		more.appendChild(renderIcon(Codicon.ellipsis));
		setAgentTooltip(more, localize('voltAgent.history.actions', "More Actions"));
		const trash = append(actions, $('button.volt-agent-history-action')) as HTMLButtonElement;
		trash.appendChild(renderIcon(Codicon.trash));
		setAgentTooltip(trash, localize('voltAgent.history.delete', "Delete"));
		return { container, icon, text, name, description, keybinding, draftDot, pin, actions, more, trash, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<HistoryElement, void>, _index: number, template: IHistoryTemplate): void {
		template.elementDisposables.clear();
		template.icon.replaceChildren();
		template.name.textContent = '';
		template.description.textContent = '';
		template.description.style.display = 'none';
		template.text.removeAttribute('title');
		template.keybinding.textContent = '';
		template.container.classList.remove('is-group', 'is-action', 'is-divider', 'is-session', 'is-more', 'is-message', 'is-nested', 'is-pinned', 'has-draft', 'running', 'detailed');
		template.container.classList.toggle('is-nested', node.depth > 1);

		const element = node.element;
		switch (element.type) {
			case 'action':
				this.renderAction(element, template);
				break;
			case 'divider':
				this.renderDivider(template);
				break;
			case 'group':
				this.renderGroup(element, template);
				break;
			case 'session':
				this.renderSession(element, template);
				break;
			case 'more':
				this.renderMore(element, template);
				break;
			case 'message':
				this.renderMessage(element, template);
				break;
		}
	}

	private renderAction(element: HistoryActionElement, template: IHistoryTemplate): void {
		template.container.classList.add('is-action');
		template.icon.appendChild(renderIcon(element.action.icon));
		template.name.textContent = element.action.label;
		if (element.action.keybinding) {
			template.keybinding.textContent = element.action.keybinding;
		}
	}

	private renderDivider(template: IHistoryTemplate): void {
		template.container.classList.add('is-divider');
	}

	private renderGroup(element: HistoryGroupElement, template: IHistoryTemplate): void {
		template.container.classList.add('is-group');
		template.name.textContent = element.label;
	}

	private renderSession(element: HistorySessionElement, template: IHistoryTemplate): void {
		const { session, detailed } = element;
		const titleText = session.title || localize('voltAgent.history.untitled', "New Agent");
		const summaryText = sessionSummary(session);
		template.container.classList.add('is-session');
		template.container.classList.toggle('is-pinned', !!session.pinned);
		template.container.classList.toggle('running', session.status === 'running');
		template.container.classList.toggle('detailed', detailed && !this.host.compact);
		template.icon.appendChild(createHistoryStatusIcon(session.status, session.hasDraft, session.turnCount));
		template.name.textContent = titleText;
		template.text.title = titleText;

		if (detailed && !this.host.compact) {
			let description = summaryText;
			if (this.host.allWorkspaces && session.workspaceId !== this.host.currentWorkspaceId && session.workspaceLabel) {
				description = `${summaryText} · ${session.workspaceLabel}`;
			}
			template.description.textContent = description;
			template.description.style.display = '';
		}

		if (session.hasDraft && session.turnCount > 0) {
			template.container.classList.add('has-draft');
			setAgentTooltip(template.draftDot, localize('voltAgent.history.hasDraft', "Has an unsent draft"));
		}

		template.more.replaceChildren(renderIcon(Codicon.ellipsis));
		if (this.host.compact) {
			template.elementDisposables.add(addDisposableListener(template.trash, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.host.deleteSession(session);
			}));
		} else {
			template.pin.replaceChildren(renderIcon(session.pinned ? Codicon.pinned : Codicon.pin));
			setAgentTooltip(template.pin, session.pinned ? localize('voltAgent.history.unpin', "Unpin") : localize('voltAgent.history.pin', "Pin"));
			template.elementDisposables.add(addDisposableListener(template.pin, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.host.togglePin(session);
			}));
		}
		template.elementDisposables.add(addDisposableListener(template.more, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.showMenu(session, template.more);
		}));
	}

	private renderMore(element: HistoryMoreElement, template: IHistoryTemplate): void {
		template.container.classList.add('is-more');
		template.icon.appendChild(renderIcon(Codicon.ellipsis));
		template.name.textContent = localize('voltAgent.history.more', "More");
		setAgentTooltip(template.container, localize('voltAgent.history.moreCount', "Show {0} more", element.hidden));
	}

	private renderMessage(element: HistoryMessageElement, template: IHistoryTemplate): void {
		template.container.classList.add('is-message');
		template.name.textContent = element.text;
	}

	disposeElement(_node: ITreeNode<HistoryElement, void>, _index: number, template: IHistoryTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IHistoryTemplate): void {
		template.elementDisposables.dispose();
	}
}

class AgentHistoryAccessibilityProvider implements IListAccessibilityProvider<HistoryElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.history.list', "Agents");
	}

	getAriaLabel(element: HistoryElement): string {
		switch (element.type) {
			case 'action': return element.action.label;
			case 'divider': return '';
			case 'group': return element.label;
			case 'session': return element.session.title || localize('voltAgent.history.untitled', "New Agent");
			case 'more': return localize('voltAgent.history.more', "More");
			case 'message': return element.text;
		}
	}

	getRole(element: HistoryElement): 'separator' | undefined {
		return element.type === 'divider' ? 'separator' : undefined;
	}
}

/**
 * The agent history list: a searchable, date-grouped tree over the history
 * index, using the same WorkbenchObjectTree as the explorer file list.
 */
export class AgentHistoryList extends Disposable implements IHistoryRendererHost {

	readonly element: HTMLElement;
	readonly compact: boolean;

	private readonly treeContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<HistoryElement>;
	private findInput: FindInput | undefined;
	private query = '';
	private treeViewValue: boolean;
	private allWorkspacesValue: boolean;
	private readonly expanded = new Set<string>();
	private readonly collapsedGroups = new Set<string>();
	private readonly renderScheduler: RunOnceScheduler;
	private readonly sessionsById = new Map<string, HistorySessionElement>();
	private lastTreeWidth = 0;
	private lastTreeHeight = 0;
	activeSessionId: string | undefined;

	private readonly _onDidOpen = this._register(new Emitter<IAgentSessionMeta>());
	readonly onDidOpen: Event<IAgentSessionMeta> = this._onDidOpen.event;
	private readonly _onDidChangeView = this._register(new Emitter<void>());
	readonly onDidChangeView: Event<void> = this._onDidChangeView.event;

	constructor(
		container: HTMLElement,
		private readonly options: IAgentHistoryListOptions,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.compact = !!options.compact;
		this.treeViewValue = options.treeView !== false;
		this.allWorkspacesValue = !!options.allWorkspaces;
		this.element = append(container, $('.volt-agent-history'));
		this.element.classList.toggle('compact', this.compact);

		if (options.search) {
			this.renderSearch();
		}

		this.treeContainer = append(this.element, $('.volt-agent-history-tree'));

		const renderer = new AgentHistoryRenderer(this);
		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<HistoryElement>,
			'AgentHistory',
			this.treeContainer,
			new AgentHistoryDelegate(this.compact),
			[renderer],
			{
				accessibilityProvider: new AgentHistoryAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (e: HistoryElement) => {
						switch (e.type) {
							case 'action': return e.action.label;
							case 'divider': return '';
							case 'group': return e.label;
							case 'session': return e.session.title || '';
							case 'more': return localize('voltAgent.history.more', "More");
							case 'message': return e.text;
						}
					}
				},
				identityProvider,
				multipleSelectionSupport: false,
				paddingBottom: ROW_HEIGHT,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.Always,
				setRowLineHeight: false,
				overrideStyles: { listBackground: SIDE_BAR_BACKGROUND },
			}
		));

		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (element.type === 'session') {
				this.openSession(element.session);
			} else if (element.type === 'more') {
				this.showMore(element.groupKey);
			} else if (element.type === 'action') {
				this.runAction(element.action);
			}
		}));
		this._register(this.tree.onContextMenu(e => {
			const element = e.element;
			if (element?.type !== 'session') {
				return;
			}
			e.browserEvent.preventDefault();
			e.browserEvent.stopPropagation();
			const anchor = isHTMLElement(e.anchor) ? e.anchor : { x: e.anchor.posx, y: e.anchor.posy };
			this.showMenu(element.session, anchor);
		}));
		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element?.type === 'group') {
				if (e.node.collapsed) {
					this.collapsedGroups.add(element.key);
				} else {
					this.collapsedGroups.delete(element.key);
				}
				this._onDidChangeView.fire();
			}
		}));

		this.renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
		this._register(this.history.onDidChange(() => this.renderScheduler.schedule()));
		void this.history.whenReady.then(() => this.renderScheduler.schedule());
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		this.render();
	}

	get allWorkspaces(): boolean {
		return this.allWorkspacesValue;
	}

	get currentWorkspaceId(): string {
		return this.history.currentWorkspace.id;
	}

	private renderSearch(): void {
		const row = append(this.element, $('.volt-agent-history-search'));
		const idlePlaceholder = localize('voltAgent.history.searchPlaceholder', "Search");
		const focusedPlaceholder = localize({
			key: 'voltAgent.history.searchPlaceholderHistory',
			comment: ['{0} is the up/down arrow glyph'],
		}, "Search ({0} for history)", '\u21C5');
		const findInput = this._register(this.instantiationService.createInstance(ContextScopedFindInput, row, this.contextViewService, {
			label: localize('voltAgent.history.searchAria', "Search agents"),
			placeholder: idlePlaceholder,
			showCommonFindToggles: true,
			history: new Set<string>(),
			validation: (value) => {
				if (!value || !findInput.getRegex()) {
					return null;
				}
				try {
					new RegExp(value);
					return null;
				} catch (e) {
					return { content: (e as Error).message };
				}
			},
			inputBoxStyles: defaultInputBoxStyles,
			toggleStyles: defaultToggleStyles,
		}));
		this.findInput = findInput;
		this._register(findInput.inputBox.onDidFocus(() => findInput.inputBox.setPlaceHolder(focusedPlaceholder)));
		this._register(findInput.inputBox.onDidBlur(() => {
			findInput.inputBox.setPlaceHolder(idlePlaceholder);
			findInput.inputBox.addToHistory();
		}));
		const searchScheduler = this._register(new RunOnceScheduler(() => this.setQuery(findInput.getValue()), 80));
		this._register(findInput.onInput(() => searchScheduler.schedule()));
		this._register(findInput.onDidOptionChange(() => this.render()));
		this._register(findInput.onKeyDown(event => {
			if (event.keyCode === KeyCode.Enter) {
				const first = [...this.sessionsById.values()][0];
				if (first) {
					event.preventDefault();
					findInput.onSearchSubmit();
					this.openSession(first.session);
				}
			} else if (event.keyCode === KeyCode.Escape && findInput.getValue()) {
				event.preventDefault();
				event.stopPropagation();
				findInput.setValue('');
				this.setQuery('');
			}
		}));
	}

	focus(): void {
		if (this.findInput) {
			this.findInput.focus();
			this.findInput.select();
		} else {
			this.tree.domFocus();
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
		return this.allWorkspacesValue;
	}

	get treeView(): boolean {
		return this.treeViewValue;
	}

	setTreeView(value: boolean): void {
		if (this.treeViewValue !== value) {
			this.treeViewValue = value;
			this.render();
			this._onDidChangeView.fire();
		}
	}

	get canCollapse(): boolean {
		if (!this.treeViewValue) {
			return false;
		}
		for (const node of this.tree.getNode().children) {
			if (node.element?.type === 'group' && !node.collapsed) {
				return true;
			}
		}
		return false;
	}

	collapseAll(): void {
		this.tree.collapseAll();
	}

	expandAll(): void {
		this.tree.expandAll();
	}

	setAllWorkspaces(value: boolean): void {
		if (this.allWorkspacesValue !== value) {
			this.allWorkspacesValue = value;
			this.render();
		}
	}

	setActiveSession(id: string | undefined): void {
		this.activeSessionId = id;
		const selected = id ? this.sessionsById.get(id) : undefined;
		if (!selected || !this.tree.hasElement(selected)) {
			this.tree.setSelection([]);
			this.tree.setFocus([]);
			return;
		}
		this.tree.setSelection([selected]);
		this.tree.setFocus([selected]);
		this.tree.reveal(selected);
	}

	layout(): void {
		if (this.compact) {
			const max = Math.min(560, this.element.ownerDocument.defaultView?.innerHeight ? this.element.ownerDocument.defaultView.innerHeight * 0.7 : 560);
			const height = Math.min(max, Math.max(this.tree.contentHeight, 80));
			const width = this.treeContainer.clientWidth;
			this.treeContainer.style.height = `${height}px`;
			if (width > 0 && (width !== this.lastTreeWidth || height !== this.lastTreeHeight)) {
				this.lastTreeWidth = width;
				this.lastTreeHeight = height;
				this.tree.layout(height, width);
				this.findInput?.inputBox.layout();
			}
			return;
		}
		const height = this.treeContainer.clientHeight;
		const width = this.treeContainer.clientWidth;
		if (height <= 0 || width <= 0 || (width === this.lastTreeWidth && height === this.lastTreeHeight)) {
			return;
		}
		this.lastTreeWidth = width;
		this.lastTreeHeight = height;
		this.tree.layout(height, width);
		this.findInput?.inputBox.layout();
	}

	openSession(session: IAgentSessionMeta): void {
		this.options.onOpen(session);
		this._onDidOpen.fire(session);
	}

	togglePin(session: IAgentSessionMeta): void {
		void this.history.setPinned(session.id, !session.pinned);
	}

	showMore(groupKey: string): void {
		this.expanded.add(groupKey);
		this.render();
	}

	runAction(action: IAgentHistoryAction): void {
		action.run();
	}

	showMenu(session: IAgentSessionMeta, anchor: HTMLElement | { x: number; y: number }): void {
		const actions: IAction[] = [
			new Action('volt.history.open', localize('voltAgent.history.open', "Open"), undefined, true, () => this.openSession(session)),
			new Separator(),
			new Action('volt.history.pin', session.pinned ? localize('voltAgent.history.unpin', "Unpin") : localize('voltAgent.history.pin', "Pin"), undefined, true, () => this.history.setPinned(session.id, !session.pinned)),
			new Action('volt.history.rename', localize('voltAgent.history.rename', "Rename..."), undefined, true, () => this.rename(session)),
			new Action('volt.history.archive', session.archived ? localize('voltAgent.history.unarchive', "Unarchive") : localize('voltAgent.history.archive', "Archive"), undefined, true, () => this.history.setArchived(session.id, !session.archived)),
			new Separator(),
			new Action('volt.history.delete', localize('voltAgent.history.delete', "Delete"), undefined, true, () => this.deleteSession(session)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	async deleteSession(session: IAgentSessionMeta): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltAgent.history.deleteConfirm', "Delete \"{0}\"?", session.title || localize('voltAgent.history.untitled', "New Agent")),
			detail: localize('voltAgent.history.deleteDetail', "The conversation and its draft are removed from disk. This cannot be undone."),
			primaryButton: localize({ key: 'voltAgent.history.deleteButton', comment: ['&& denotes a mnemonic'] }, "&&Delete"),
		});
		if (!confirmed) {
			return;
		}
		for (const group of this.editorGroupsService.groups) {
			const open = group.editors.filter(editor => editor instanceof AgentEditorInput && editor.sessionId === session.id);
			if (open.length) {
				await group.closeEditors(open);
			}
		}
		await this.history.delete(session.id);
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

	private sessions(): IAgentSessionMeta[] {
		const options = {
			workspaceId: this.allWorkspacesValue ? undefined : this.history.currentWorkspace.id,
			matchCase: this.findInput?.getCaseSensitive(),
			wholeWord: this.findInput?.getWholeWords(),
			isRegex: this.findInput?.getRegex(),
		};
		return this.query ? this.history.search(this.query, options) : this.history.list(options);
	}

	private render(): void {
		this.sessionsById.clear();
		const sessions = this.sessions();
		const children: IObjectTreeElement<HistoryElement>[] = [];

		const actions = this.options.actions ?? [];
		for (const action of actions) {
			children.push({ element: { type: 'action', action }, collapsible: false });
		}
		if (actions.length) {
			children.push({ element: { type: 'divider' }, collapsible: false });
		}

		if (!sessions.length) {
			children.push({
				element: {
					type: 'message',
					text: this.query
						? localize('voltAgent.history.noMatches', "No agents match \"{0}\"", this.query)
						: localize('voltAgent.history.empty', "No agents yet"),
				},
				collapsible: false,
			});
			this.tree.setChildren(null, children);
			this.layout();
			return;
		}

		const groups = this.treeViewValue
			? groupSessionsByDate(sessions)
			: [{ key: 'results', label: '', sessions }];
		const pageSize = this.options.pageSize ?? Infinity;

		for (const group of groups) {
			const detailed = isDetailedHistoryGroup(group.key);
			const showAll = group.key === 'pinned' || this.expanded.has(group.key);
			const visible = showAll ? group.sessions : group.sessions.slice(0, pageSize);
			const sessionChildren: IObjectTreeElement<HistoryElement>[] = visible.map(session => {
				const element: HistorySessionElement = { type: 'session', session, detailed };
				this.sessionsById.set(session.id, element);
				return { element, collapsible: false };
			});
			const hidden = group.sessions.length - visible.length;
			if (hidden > 0) {
				sessionChildren.push({ element: { type: 'more', groupKey: group.key, hidden }, collapsible: false });
			}
			if (!group.label) {
				children.push(...sessionChildren);
				continue;
			}
			children.push({
				element: { type: 'group', key: group.key, label: group.label },
				collapsible: true,
				collapsed: this.collapsedGroups.has(group.key),
				children: sessionChildren,
			});
		}

		this.tree.setChildren(null, children);
		if (this.activeSessionId) {
			this.setActiveSession(this.activeSessionId);
		}
		this.layout();
		this._onDidChangeView.fire();
	}
}
