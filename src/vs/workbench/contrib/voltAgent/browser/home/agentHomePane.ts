/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomePane.css';
import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement, isMouseEvent, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Action, IAction, Separator, SubmenuAction, toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { showAgentProjectMenu } from './agentHomeWorkspaceActions.js';
import { isScratchSession, scratchProjectLabel } from './agentHomeWorkspace.js';
import { IVoltProjectsService, VoltProjectCommands } from '../../../voltProjects/common/projects.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { AgentEditorInput, NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { OPEN_AGENT_SCHEDULES_COMMAND_ID } from '../schedules/agentScheduleCommands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { AgentUsageEditorInput, OPEN_AGENT_USAGE_COMMAND_ID } from '../usage/agentUsageEditor.js';
import { createUsageIcon } from '../usage/agentUsageIcons.js';
import { createHomeFilterIcon, createHomeFolderIcon, createHomeFoldersIcon, createHomeNewChatIcon, createHomeOpenWorkspaceIcon, createHomeSearchIcon, createHomeStatusBadgeIcon } from './agentHomeIcons.js';
import { showAgentSnoozeMenu } from './agentSnoozeMenu.js';
import { activateAgentProject, startAgentChat } from '../workspace/agentPanels.js';
import { AgentChatStart } from '../workspace/agentShell.js';
import { agentSideChatParents, onDidChangeAgentToolEditors } from '../workspace/agentSurfaceHost.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { AgentTooltip, IAgentTooltipRow, setAgentTooltip } from '../chrome/agentTooltip.js';
import {
	AGENT_HOME_VIEW_STORAGE_KEY,
	AgentHomePrFilter,
	anyHomeFilterActive,
	defaultAgentHomeViewState,
	IAgentHomeViewState,
	reviveAgentHomeViewState,
	serializeAgentHomeViewState,
	sessionFolders,
	sessionPrimaryStatus,
} from './agentHomeFilter.js';
import { showAgentHomeFilterMenu } from './agentHomeFilterMenu.js';
import { showAgentHomeNewChatMenu } from './agentHomeNewChatMenu.js';
import {
	AGENT_HOME_GROUP_EXPAND_ALL,
	AgentHomeActionId,
	agentHomeLiveWork,
	AgentHomeWorkState,
	AgentHomeElement,
	AgentHomeStatusBadgeKind,
	agentHomeAddStart,
	agentHomeGroupLabel,
	agentHomeSectionLabel,
	buildAgentHomeTree,
	folderPath,
	IAgentHomeFolder,
	IAgentHomeNode,
	IAgentHomeProject,
	IAgentHomeSessionContext,
	IAgentHomeStatusBadge,
	IAgentOpenDraft,
	isTwoLineView,
	sessionHomeShelf,
	sessionSecondLine,
	sessionMetaParts,
	sessionShowsStatusBadge,
	sessionStatusBadge,
	sessionsWithOpenDrafts,
} from './agentHomeModel.js';
import { AgentRepoResolver, dominantRepoOwner, IAgentRepoInfo, repoDisplayName, repoInitials } from './agentRepoInfo.js';
import { agentSessionHoverRows, agentSessionStatusNote } from './agentSessionHover.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { OPEN_PULL_REQUEST_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { IAgentPrBadge, prBadge, sessionPrFilterTag, visibleLinks } from '../../common/agentPullRequests.js';
import { AGENT_HOME_WORKING_SECTION_SETTING } from '../../common/agentHomeSettings.js';
import { lifecycleUndoLabel } from '../../common/agentLifecycleUndo.js';
import { AGENT_LIFECYCLE_UNDO_COMMAND_ID, IAgentThreadLifecycleService } from './agentThreadLifecycle.js';

const ROW_HEIGHT = 28;
/** An agent tab with a second line (branch, pull request, model). */
const TWO_LINE_ROW_HEIGHT = 46;
/** How often ages, "Working 2m" and snooze countdowns are redrawn. */
const CLOCK_TICK_MS = 30_000;
/** How long the pointer rests on an agent tab before its details card opens. */
const SESSION_HOVER_DELAY_MS = 500;

const identityProvider: IIdentityProvider<AgentHomeElement> = {
	getId(element) {
		switch (element.type) {
			case 'newChat': return 'newChat';
			case 'action': return `action:${element.id}`;
			case 'section': return `section:${element.key}`;
			case 'folder': return `folder:${element.project.key}`;
			case 'bucket': return `bucket:${element.id}`;
			case 'group': return `group:${element.id}`;
			case 'session': return `session:${element.folderKey}:${element.session.id}`;
			case 'more': return `more:${element.groupKey}`;
			case 'empty': return `empty:${element.key}`;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}
};

interface IHomeTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly twist: HTMLElement;
	readonly glyph: HTMLElement;
	readonly name: HTMLElement;
	readonly actions: HTMLElement;
	readonly snooze: HTMLButtonElement;
	readonly settle: HTMLButtonElement;
	readonly wake: HTMLButtonElement;
	readonly pin: HTMLButtonElement;
	readonly archive: HTMLButtonElement;
	readonly badge: HTMLElement;
	readonly meta: HTMLElement;
	/** The second line of an agent tab: branch, pull request badge, model. */
	readonly sub: HTMLElement;
	readonly subBranch: HTMLElement;
	readonly subPr: HTMLElement;
	readonly subModel: HTMLElement;
	readonly keybinding: HTMLElement;
	readonly filter: HTMLButtonElement;
	readonly openWorkspace: HTMLButtonElement;
	readonly add: HTMLButtonElement;
	readonly elementDisposables: DisposableStore;
}

const ROW_STATE_CLASSES = [
	'is-new', 'is-action', 'is-section', 'is-folder', 'is-bucket', 'is-group', 'is-session', 'is-more', 'is-empty',
	'is-nested', 'is-flat', 'is-collapsible', 'current', 'unread', 'archived', 'pinned',
	'status-needsAttention', 'status-working', 'status-draft', 'status-done',
	'actions-cover-name', 'active-chat', 'shelf-active', 'shelf-settled', 'shelf-snooze', 'group-working', 'group-settled', 'group-snooze', 'two-line',
];

class AgentHomeDelegate implements IListVirtualDelegate<AgentHomeElement> {
	constructor(private readonly host: { readonly twoLine: boolean }) { }

	getHeight(element: AgentHomeElement): number {
		return element.type === 'session' && this.host.twoLine ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT;
	}

	getTemplateId(): string {
		return AgentHomeRenderer.ID;
	}
}

class AgentHomeRenderer implements ITreeRenderer<AgentHomeElement, void, IHomeTemplate> {
	static readonly ID = 'agentHome';
	readonly templateId = AgentHomeRenderer.ID;

	constructor(
		private readonly host: AgentHomePane,
		private readonly keybindingService: IKeybindingService,
	) { }

	renderTemplate(container: HTMLElement): IHomeTemplate {
		container.classList.add('volt-agent-home-row');
		const icon = append(container, $('span.icon'));
		const twist = append(icon, $('span.twist'));
		twist.appendChild(renderIcon(Codicon.chevronDown));
		const glyph = append(icon, $('span.glyph'));
		const name = append(container, $('span.name'));
		const meta = append(container, $('span.meta'));
		const badge = append(container, $('span.status-badge'));
		const sub = append(container, $('span.sub'));
		const subBranch = append(sub, $('span.sub-branch'));
		const subPr = append(sub, $('span.sub-pr'));
		append(sub, $('span.sub-spacer'));
		const subModel = append(sub, $('span.sub-model'));
		const actions = append(container, $('span.actions'));
		const snooze = append(actions, $('button.row-action.snooze')) as HTMLButtonElement;
		snooze.tabIndex = -1;
		const settle = append(actions, $('button.row-action.settle')) as HTMLButtonElement;
		settle.tabIndex = -1;
		const wake = append(actions, $('button.row-action.wake')) as HTMLButtonElement;
		wake.tabIndex = -1;
		const pin = append(actions, $('button.row-action.pin')) as HTMLButtonElement;
		pin.tabIndex = -1;
		const archive = append(actions, $('button.row-action.archive')) as HTMLButtonElement;
		archive.tabIndex = -1;
		const keybinding = append(container, $('span.keybinding'));
		const filter = append(container, $('button.volt-agent-home-filter.hidden')) as HTMLButtonElement;
		filter.appendChild(createHomeFilterIcon());
		filter.tabIndex = -1;
		filter.setAttribute('aria-label', localize('voltAgent.home.filter', "Filter and sort"));
		setAgentTooltip(filter, localize('voltAgent.home.filter', "Filter and sort"));
		const openWorkspace = append(container, $('button.volt-agent-home-open-workspace.hidden')) as HTMLButtonElement;
		openWorkspace.appendChild(createHomeOpenWorkspaceIcon());
		openWorkspace.tabIndex = -1;
		openWorkspace.setAttribute('aria-label', localize('voltAgent.home.openWorkspace', "Open Workspace"));
		setAgentTooltip(openWorkspace, localize('voltAgent.home.openWorkspace', "Open Workspace"));
		const add = append(container, $('button.add')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		add.tabIndex = -1;
		return { container, icon, twist, glyph, name, actions, snooze, settle, wake, pin, archive, badge, meta, sub, subBranch, subPr, subModel, keybinding, filter, openWorkspace, add, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
		template.glyph.replaceChildren();
		template.name.textContent = '';
		template.meta.textContent = '';
		template.badge.replaceChildren();
		template.badge.className = 'status-badge';
		template.subBranch.replaceChildren();
		template.subPr.replaceChildren();
		template.subModel.textContent = '';
		template.keybinding.textContent = '';
		template.filter.classList.add('hidden');
		template.filter.classList.remove('active');
		template.openWorkspace.classList.add('hidden');
		template.add.classList.add('hidden');
		template.container.classList.remove(...ROW_STATE_CLASSES);
		template.container.style.setProperty('--volt-home-level', String(rowLevel(node.element)));
		template.container.classList.toggle('collapsed', !!node.collapsed);

		const element = node.element;
		// Group headers: collapsed left / expanded down. Folder rows keep collapsed right.
		// Settled / Snoozed put a trailing chevron after their rule: down to open, up to fold.
		const collapsedChevron = element.type === 'bucket' ? Codicon.chevronLeft : Codicon.chevronRight;
		const chevron = element.type === 'group'
			? (node.collapsed ? Codicon.chevronDown : Codicon.chevronUp)
			: (node.collapsed ? collapsedChevron : Codicon.chevronDown);
		template.twist.replaceChildren(renderIcon(chevron));
		switch (element.type) {
			case 'newChat':
				template.container.classList.add('is-new');
				template.glyph.appendChild(createHomeNewChatIcon());
				template.name.textContent = localize('voltAgent.home.newChat', "New Chat");
				template.keybinding.textContent = this.keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? '';
				break;
			case 'action':
				this.renderAction(element.id, template);
				break;
			case 'section':
				this.renderSection(element, template);
				break;
			case 'folder':
				this.renderFolder(element.project, node.collapsible, template);
				break;
			case 'bucket':
				this.renderBucket(element, template);
				break;
			case 'group':
				this.renderGroup(element, template);
				break;
			case 'session':
				this.renderSession(element, template);
				break;
			case 'more':
				template.container.classList.add('is-more');
				template.container.classList.toggle('is-nested', element.nested);
				template.name.textContent = localize('voltAgent.home.showMore', "Show more");
				break;
			case 'empty':
				template.container.classList.add('is-empty');
				template.name.textContent = element.filtered
					? localize('voltAgent.home.noMatches', "No agents match these filters")
					: localize('voltAgent.home.noAgents', "No agents yet");
				break;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	private renderAction(id: AgentHomeActionId, template: IHomeTemplate): void {
		template.container.classList.add('is-action');
		const spec = actionSpec(id);
		switch (id) {
			case 'search':
				template.glyph.appendChild(createHomeSearchIcon());
				break;
			case 'automations':
			case 'customize':
				template.glyph.appendChild(renderIcon(spec.icon));
				break;
			default: {
				const unexpected: never = id;
				return unexpected;
			}
		}
		template.name.textContent = spec.label;
	}

	/** The filter and Open Workspace controls on a header row. Only one header carries them. */
	private renderFilter(template: IHomeTemplate): void {
		template.filter.classList.remove('hidden');
		template.filter.classList.toggle('active', anyHomeFilterActive(this.host.view));
		template.elementDisposables.add(addDisposableListener(template.filter, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openFilterMenu(template.filter);
			template.filter.blur();
		}));
		template.openWorkspace.classList.remove('hidden');
		template.elementDisposables.add(addDisposableListener(template.openWorkspace, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openWorkspaceMenu(template.openWorkspace);
		}));
	}

	private renderSection(element: Extract<AgentHomeElement, { type: 'section' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-section');
		template.name.textContent = agentHomeSectionLabel(element.key);
		if (element.filter) {
			this.renderFilter(template);
		}
		if (element.add) {
			template.add.classList.remove('hidden');
			setAgentTooltip(template.add, localize('voltAgent.home.newProject', "New Project"));
			template.elementDisposables.add(addDisposableListener(template.add, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.host.addProject(template.add);
			}));
		}
	}

	private renderFolder(project: IAgentHomeProject, collapsible: boolean, template: IHomeTemplate): void {
		template.container.classList.add('is-folder');
		template.container.classList.toggle('current', project.current);
		template.container.classList.toggle('is-collapsible', collapsible);
		template.glyph.appendChild(project.multi ? createHomeFoldersIcon() : createHomeFolderIcon());
		const status = project.folder ? this.host.projectStatus(project.folder.uri) : undefined;
		template.name.textContent = status ? `${project.label} · ${status}` : project.label;
		this.renderAdd(template, { type: 'folder', project });
	}

	/** Pinned, Today, Needs Attention, This Mac, ...: a VS Code style group header over agent tabs. */
	private renderBucket(element: Extract<AgentHomeElement, { type: 'bucket' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-group', 'is-collapsible');
		template.name.textContent = element.label;
		if (element.count !== undefined) {
			template.meta.textContent = String(element.count);
		}
		if (element.filter) {
			this.renderFilter(template);
		}
		this.renderAdd(template, element);
	}

	/** + on project rows (hover-only via CSS) and group headers (always visible); start rules live in {@link agentHomeAddStart}. */
	private renderAdd(template: IHomeTemplate, element: AgentHomeElement): void {
		const start = agentHomeAddStart(element);
		if (!start) {
			return;
		}
		template.add.classList.remove('hidden');
		setAgentTooltip(template.add, start.kind === 'folder'
			? localize('voltAgent.home.newChatInProject', "New chat in {0}", start.name)
			: localize('voltAgent.home.newChat', "New Chat"));
		template.elementDisposables.add(addDisposableListener(template.add, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			// A project row knows its folder; a group header asks which project (or none).
			if (start.kind === 'folder') {
				void this.host.startChat(start);
			} else {
				this.host.openNewChatMenu(template.add);
			}
		}));
	}

	/** Working / Settled / Snoozed: the label (Working counts its folded chats), a rule across the row, and the fold chevron at the end. */
	private renderGroup(element: Extract<AgentHomeElement, { type: 'group' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-group', 'is-collapsible', `group-${element.id}`);
		template.name.textContent = agentHomeGroupLabel(element.id);
		if (element.count !== undefined) {
			template.meta.textContent = String(element.count);
		}
	}

	private renderSession(element: Extract<AgentHomeElement, { type: 'session' }>, template: IHomeTemplate): void {
		const session = element.session;
		const status = sessionPrimaryStatus(session);
		const context = this.host.sessionContext(session);
		const shelf = sessionHomeShelf(session);
		const now = Date.now();
		template.container.classList.add('is-session', `status-${status}`, element.nested ? 'is-nested' : 'is-flat', `shelf-${shelf}`);
		template.container.classList.toggle('unread', !!session.unread);
		template.container.classList.toggle('archived', !!session.archived);
		template.container.classList.toggle('pinned', !!session.pinned);
		template.container.classList.toggle('active-chat', this.host.isActiveChat(session.id));

		// Under a project a dot is enough; in a flat list the project's initials say where the tab lives.
		if (element.nested || !context.initials) {
			append(template.glyph, $('span.volt-agent-home-dot'));
		} else {
			append(template.glyph, $('span.volt-agent-home-initials')).textContent = context.initials;
		}
		template.name.textContent = session.title || localize('voltAgent.home.untitled', "New Agent");
		const twoLine = this.host.twoLine;
		template.container.classList.toggle('two-line', twoLine);
		// On two lines the branch moves to the second line, beside the pull request and the model.
		template.meta.textContent = sessionMetaParts(session, twoLine ? { workspace: context.workspace } : context, this.host.view, now).join(' · ');
		if (twoLine) {
			this.renderSecondLine(template, session, context);
		}

		const badge = sessionShowsStatusBadge(session, this.host.view) ? sessionStatusBadge(session, now, this.host.liveWork(session.id)) : undefined;
		if (badge) {
			this.renderStatusBadge(template.badge, badge);
		}

		// Hover: snooze and Settle on the inbox, snooze on Settled, wake on Snoozed.
		template.snooze.classList.toggle('hidden', shelf === 'snooze');
		template.settle.classList.toggle('hidden', shelf !== 'active');
		template.wake.classList.toggle('hidden', shelf !== 'snooze');
		if (shelf !== 'snooze') {
			this.renderRowAction(template, template.snooze, localize('voltAgent.home.snoozeThread', "Snooze thread"),
				button => this.host.openSnoozeMenu(button, session), renderIcon(Codicon.clock));
		}
		if (shelf === 'active') {
			const label = localize('voltAgent.home.settleThread', "Settle");
			this.renderRowAction(template, template.settle, localize('voltAgent.home.settleThreadTooltip', "Move to Settled"),
				() => this.host.settle(session), renderIcon(Codicon.check), $('span.label', undefined, label));
		}
		if (shelf === 'snooze') {
			this.renderRowAction(template, template.wake, localize('voltAgent.home.unsnoozeThread', "Unsnooze"),
				() => this.host.wake(session), renderIcon(Codicon.bellSlash));
		}
		this.renderRowAction(template, template.pin, session.pinned ? localize('voltAgent.home.unpin', "Unpin") : localize('voltAgent.home.pin', "Pin"),
			() => this.host.togglePin(session), renderIcon(session.pinned ? Codicon.pinned : Codicon.pin));
		this.renderRowAction(template, template.archive, session.archived ? localize('voltAgent.home.unarchive', "Unarchive") : localize('voltAgent.home.archive', "Archive"),
			() => this.host.toggleArchive(session), renderIcon(Codicon.archive));
		template.elementDisposables.add(this.host.bindSessionHover(template.container, session));
		template.elementDisposables.add(addDisposableListener(template.container, 'mouseenter', () => this.fadeNameUnderActions(template)));
	}

	/** Branch (or project), the pull request badge, and the model, under the title. */
	private renderSecondLine(template: IHomeTemplate, session: IAgentSessionMeta, context: IAgentHomeSessionContext): void {
		const line = sessionSecondLine(session, context, this.host.view, this.host.modelLabel(session));
		if (line.branch) {
			template.subBranch.appendChild(renderIcon(Codicon.gitBranch));
			append(template.subBranch, $('span.sub-text')).textContent = line.branch;
		} else if (line.place) {
			append(template.subBranch, $('span.sub-text')).textContent = line.place;
		}
		const badge = this.host.view.show.has('pr') ? this.host.prBadge(session.id) : undefined;
		if (badge) {
			this.renderPrBadge(template, session, badge);
		}
		template.subModel.textContent = line.model ?? '';
	}

	private renderPrBadge(template: IHomeTemplate, session: IAgentSessionMeta, badge: IAgentPrBadge): void {
		const pill = append(template.subPr, $(`span.volt-agent-home-pr.state-${badge.state}`));
		pill.appendChild(renderIcon(badge.kind === 'stack' ? Codicon.layers : prBadgeIcon(badge.state)));
		append(pill, $('span')).textContent = badge.kind === 'multi' ? `#${badge.number} +${badge.count - 1}` : badge.kind === 'stack' ? `${badge.count}` : `#${badge.number}`;
		if (badge.checks) {
			append(pill, $(`span.checks.check-${badge.checks}`));
		}
		if (badge.link.watch) {
			append(pill, renderIcon(Codicon.eye)).classList.add('watch');
		}
		const snapshot = badge.link.snapshot;
		setAgentTooltip(pill, snapshot
			? `#${snapshot.number} ${snapshot.title}\n${snapshot.headRefName} → ${snapshot.baseRefName}${badge.link.watch ? `\n${localize('voltAgent.home.prWatched', "Watched: the agent wakes on checks, reviews and conflicts")}` : ''}`
			: localize('voltAgent.home.prLinked', "Pull request #{0}", badge.number));
		template.elementDisposables.add(addDisposableListener(pill, 'mousedown', e => e.stopPropagation()));
		template.elementDisposables.add(addDisposableListener(pill, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openPullRequest(session.id, badge);
		}));
	}

	/** The hover actions float over the row's end; fade the title where they would cover it. */
	private fadeNameUnderActions(template: IHomeTemplate): void {
		const cover = template.name.getBoundingClientRect().right - template.actions.getBoundingClientRect().left + 4;
		template.container.classList.toggle('actions-cover-name', cover > 0);
		template.container.style.setProperty('--volt-home-name-cover', `${Math.max(0, Math.round(cover))}px`);
	}

	private renderStatusBadge(host: HTMLElement, badge: IAgentHomeStatusBadge): void {
		host.classList.add(`kind-${badge.kind}`);
		append(host, $('span.status-icon')).appendChild(statusBadgeIcon(badge.kind));
		append(host, $('span.status-label')).textContent = badge.label;
	}

	private renderRowAction(template: IHomeTemplate, button: HTMLButtonElement, label: string, run: (button: HTMLButtonElement) => void, ...content: HTMLElement[]): void {
		button.replaceChildren(...content);
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
		template.elementDisposables.add(addDisposableListener(button, 'mousedown', e => e.stopPropagation()));
		template.elementDisposables.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			run(button);
		}));
	}

	disposeElement(_node: ITreeNode<AgentHomeElement, void>, _index: number, template: IHomeTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IHomeTemplate): void {
		template.elementDisposables.dispose();
	}
}

function prBadgeIcon(state: IAgentPrBadge['state']): ThemeIcon {
	switch (state) {
		case 'open': return Codicon.gitPullRequest;
		case 'draft': return Codicon.gitPullRequestDraft;
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
	}
}

/** The glyph in a status badge: drawn rings for most states, a codicon for Interrupted. */
function statusBadgeIcon(kind: AgentHomeStatusBadgeKind): HTMLElement {
	switch (kind) {
		case 'input':
		case 'working':
		case 'woke':
		case 'done':
		case 'draft':
		case 'limited':
		case 'failed':
			return createHomeStatusBadgeIcon(kind);
		case 'interrupted': return renderIcon(Codicon.debugPause);
		default: {
			const unexpected: never = kind;
			return unexpected;
		}
	}
}

/** Headers sit flush; agent tabs under a project or time/status group step in once (~6px). */
function rowLevel(element: AgentHomeElement): number {
	switch (element.type) {
		case 'session':
			// A side chat steps in past its chat's dot, so it reads as part of that chat.
			return 1 + 3 * (element.sideDepth ?? 0);
		case 'more':
			return 1;
		case 'newChat':
		case 'action':
		case 'section':
		case 'folder':
		case 'bucket':
		case 'group':
		case 'empty':
			return 0;
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}

function elementLabel(element: AgentHomeElement): string {
	switch (element.type) {
		case 'newChat': return localize('voltAgent.home.newChat', "New Chat");
		case 'action': return actionSpec(element.id).label;
		case 'section': return agentHomeSectionLabel(element.key);
		case 'folder': return element.project.label;
		case 'bucket': return element.label;
		case 'group': return agentHomeGroupLabel(element.id);
		case 'session': {
			const title = element.session.title || localize('voltAgent.home.untitled', "New Agent");
			return element.session.turnCount === 0
				? localize('voltAgent.home.draftRow', "{0}, Draft", title)
				: title;
		}
		case 'more': return localize('voltAgent.home.showMore', "Show more");
		case 'empty': return element.filtered
			? localize('voltAgent.home.noMatches', "No agents match these filters")
			: localize('voltAgent.home.noAgents', "No agents yet");
		default: {
			const unexpected: never = element;
			return unexpected;
		}
	}
}

class AgentHomeAccessibilityProvider implements IListAccessibilityProvider<AgentHomeElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.home.list', "Agent Home");
	}

	getAriaLabel(element: AgentHomeElement): string {
		return elementLabel(element);
	}
}

function actionSpec(id: AgentHomeActionId): { readonly label: string; readonly icon: ThemeIcon } {
	switch (id) {
		case 'search':
			return { label: localize('voltAgent.home.search', "Search"), icon: Codicon.search };
		case 'automations':
			return { label: localize('voltAgent.home.automations', "Automations"), icon: Codicon.history };
		case 'customize':
			return { label: localize('voltAgent.home.customize', "Customize"), icon: Codicon.extensions };
		default: {
			const unexpected: never = id;
			return unexpected;
		}
	}
}

function sameLiveWork(a: ReadonlyMap<string, AgentHomeWorkState>, b: ReadonlyMap<string, AgentHomeWorkState>): boolean {
	return a.size === b.size && [...a].every(([id, state]) => b.get(id) === state);
}

function sameRepo(a: IAgentRepoInfo | undefined, b: IAgentRepoInfo | undefined): boolean {
	return a?.id === b?.id && a?.name === b?.name && a?.owner === b?.owner && a?.branch === b?.branch && a?.root.toString() === b?.root.toString();
}

export class AgentHomePane extends Disposable {

	readonly element: HTMLElement;
	private readonly nav: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<AgentHomeElement>;
	private readonly hover = this._register(new AgentTooltip());
	private readonly repoResolver: AgentRepoResolver;
	/** Repository facts by folder path; filled in the background and applied on the next refresh. */
	private readonly repos = new Map<string, IAgentRepoInfo>();
	/** Rows revealed by "More", per group. */
	private readonly limits = new Map<string, number>();
	private readonly repoRefresh = this._register(new RunOnceScheduler(() => void this.refresh(), 50));
	/** Events that land in the same frame (a chat switch fires several) share one rebuild. */
	private readonly refreshFrame = this._register(new MutableDisposable());
	/** Recently opened folders, read once and again only when that list changes. */
	private recents: Promise<readonly (IRecentFolder | IRecentWorkspace)[]> | undefined;
	private refreshSeq = 0;
	private viewState: IAgentHomeViewState;
	/** Chats with a parent whose orchestration was asked for, to learn if they are subagents. */
	private readonly checkedSubagents = new Set<string>();
	/** Desktop only: pull requests linked to chats. */
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** Whether the tree was last built with two-line agent tabs; their height changes with it. */
	private builtTwoLine: boolean | undefined;
	/** Chats the orchestrator sees busy: a turn starting or running, or subagents still at work. */
	private live = new Map<string, AgentHomeWorkState>();

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IFileService fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly voltSessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IVoltProjectsService private readonly voltProjects: IVoltProjectsService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentThreadLifecycleService private readonly lifecycle: IAgentThreadLifecycleService,
	) {
		super();
		this._register(this.voltProjects.onDidChange(() => this.scheduleRefresh()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_HOME_WORKING_SECTION_SETTING)) {
				this.scheduleRefresh();
			}
		}));
		// Subagent chats are reached from their parent, not listed. Chats from before the history kept
		// that flag learn it once their orchestration is loaded; the history change refreshes the list.
		this._register(this.orchestrator.onDidChange(change => {
			for (const id of change.threads) {
				const thread = this.orchestrator.getThread(id);
				if (thread?.taskId && thread.parentId && !this.history.get(id)?.subagent) {
					this.history.pinSessionParent(id, thread.parentId, { subagent: true });
				}
			}
			// A turn starting or subagents finishing moves a chat in or out of Working before history says so.
			if (!sameLiveWork(this.live, agentHomeLiveWork(this.orchestrator.getState()))) {
				this.scheduleRefresh();
			}
		}));
		this.pullRequests = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentPullRequestService));
		if (this.pullRequests) {
			this._register(this.pullRequests.onDidChange(() => this.scheduleRefresh()));
		}
		this.repoResolver = new AgentRepoResolver(fileService);
		this.viewState = this.readViewState();
		this.element = append(parent, $('.volt-agent-home'));
		this.keepSingleHome(parent);

		this.nav = append(this.element, $('.volt-agent-home-nav'));
		this.installNav(keybindingService);
		this.treeContainer = append(this.element, $('.volt-agent-home-tree'));
		this.installSettingsButton(keybindingService);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<AgentHomeElement>,
			'AgentHome',
			this.treeContainer,
			new AgentHomeDelegate(this),
			[new AgentHomeRenderer(this, keybindingService)],
			{
				accessibilityProvider: new AgentHomeAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: AgentHomeElement) => elementLabel(element),
				},
				identityProvider,
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: false,
				renderIndentGuides: RenderIndentGuides.None,
				expandOnlyOnTwistieClick: false,
				// Every node carries its own default collapse state; see toTreeElement.
				paddingBottom: ROW_HEIGHT,
				setRowLineHeight: false,
				horizontalScrolling: false,
				transformOptimization: false,
				// Sticky group headers cover the rows underneath with the sidebar plate.
				stickyScrollBackdrop: true,
			}
		));

		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (this.isExpandToggleClick(element, e.browserEvent)) {
				return;
			}
			void this.activate(element).finally(() => {
				if (element.type === 'newChat' || element.type === 'action' || element.type === 'more' || element.type === 'empty') {
					this.tree.setSelection([]);
					this.tree.setFocus([]);
				}
			});
		}));

		this._register(this.tree.onContextMenu(e => {
			if (e.element?.type !== 'session') {
				return;
			}
			e.browserEvent.preventDefault();
			e.browserEvent.stopPropagation();
			this.showSessionMenu(e.element.session, isHTMLElement(e.anchor) ? e.anchor : { x: e.anchor.posx, y: e.anchor.posy });
		}));

		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => {
			this.recents = undefined;
			this.scheduleRefresh();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => this.scheduleRefresh()));
		this._register(this.history.onDidChange(() => this.scheduleRefresh()));
		this._register(this.editorService.onDidEditorsChange(() => this.scheduleRefresh()));
		this._register(this.editorService.onDidActiveEditorChange(() => this.scheduleRefresh()));
		this._register(onDidChangeAgentToolEditors(() => this.scheduleRefresh()));
		this._register(this.voltSessionContext.onDidChangeProjects(() => this.scheduleRefresh()));
		this._register(this.voltSessionContext.onDidChangeActiveProject(() => this.scheduleRefresh()));

		// Ages, "Working 2m" and snooze countdowns move with the clock, not with history events.
		const clock = getWindow(this.element).setInterval(() => this.tree.rerender(), CLOCK_TICK_MS);
		this._register(toDisposable(() => getWindow(this.element).clearInterval(clock)));

		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		void this.refresh();
	}

	/**
	 * Footer of the agent list: Settings and Usage. While Usage is the active page the row
	 * turns into a Back button that closes it and returns to the chat underneath.
	 */
	private installSettingsButton(keybindingService: IKeybindingService): void {
		const footer = append(this.element, $('.volt-agent-home-footer'));

		const back = append(footer, $('button.volt-agent-home-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		append(back, $('span')).textContent = localize('voltAgent.home.back', "Back");
		back.setAttribute('aria-label', localize('voltAgent.home.backFromUsage', "Back to chat"));
		this._register(addDisposableListener(back, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.closeUsage();
		}));

		const button = append(footer, $('button.volt-agent-home-settings')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(Codicon.settingsGear));
		const label = localize('voltAgent.home.settings', "Settings");
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
			button.blur();
		}));

		const usage = append(footer, $('button.volt-agent-home-settings.volt-agent-home-usage')) as HTMLButtonElement;
		usage.type = 'button';
		usage.appendChild(createUsageIcon(16));
		const usageLabel = localize('voltAgent.home.usage', "Usage");
		usage.setAttribute('aria-label', usageLabel);
		setAgentTooltip(usage, usageLabel);
		this._register(addDisposableListener(usage, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand(OPEN_AGENT_USAGE_COMMAND_ID);
			usage.blur();
		}));

		let wasOpen = false;
		const sync = () => {
			const open = this.editorService.activeEditor instanceof AgentUsageEditorInput;
			// Usage is a page, not a tab: leaving it for a chat drops it so it never resurfaces as one.
			if (wasOpen && !open && this.editorService.activeEditor) {
				void this.closeUsage();
			}
			wasOpen = open;
			footer.classList.toggle('usage-open', open);
			back.tabIndex = open ? 0 : -1;
			back.setAttribute('aria-hidden', String(!open));
		};
		this._register(this.editorService.onDidActiveEditorChange(sync));
		sync();
		this.installUndoNotice(footer, keybindingService);
	}

	/**
	 * "Settled 'Fix login'  Undo Cmd+Z" in the footer for a few seconds after a settle, snooze,
	 * archive or pin. It sits in the footer's free space, so the list above never moves.
	 */
	private installUndoNotice(footer: HTMLElement, keybindingService: IKeybindingService): void {
		const notice = append(footer, $('.volt-agent-home-undo.hidden'));
		notice.setAttribute('role', 'status');
		notice.setAttribute('aria-live', 'polite');
		const label = append(notice, $('span.label'));
		const undo = append(notice, $('button.undo')) as HTMLButtonElement;
		undo.type = 'button';
		append(undo, $('span')).textContent = localize('voltAgent.home.undo', "Undo");
		const key = append(undo, $('span.keybinding'));
		this._register(addDisposableListener(undo, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.lifecycle.undo();
		}));
		const render = () => {
			const entry = this.lifecycle.notice;
			notice.classList.toggle('hidden', !entry);
			if (entry) {
				label.textContent = lifecycleUndoLabel(entry);
				setAgentTooltip(label, label.textContent);
				key.textContent = keybindingService.lookupKeybinding(AGENT_LIFECYCLE_UNDO_COMMAND_ID)?.getLabel() ?? '';
			}
		};
		this._register(this.lifecycle.onDidChangeNotice(render));
		render();
	}

	/** Closes every Usage tab; the group falls back to the chat that was open before it. */
	private async closeUsage(): Promise<void> {
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			const editors = group.editors.filter(editor => editor instanceof AgentUsageEditorInput);
			if (editors.length) {
				await group.closeEditors(editors);
			}
		}
	}

	/**
	 * Top actions stay outside the virtualized tree so they pin while chats scroll.
	 * Padding lives on `.volt-agent-home-nav`. The block has no fill and no fade.
	 */
	private installNav(keybindingService: IKeybindingService): void {
		const shortcut = keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? '';
		const rows: Array<{ readonly element: Extract<AgentHomeElement, { type: 'newChat' | 'action' }>; readonly label: string }> = [
			{ element: { type: 'newChat' }, label: localize('voltAgent.home.newChat', "New Chat") },
			{ element: { type: 'action', id: 'search' }, label: actionSpec('search').label },
			{ element: { type: 'action', id: 'automations' }, label: actionSpec('automations').label },
			{ element: { type: 'action', id: 'customize' }, label: actionSpec('customize').label },
		];
		for (const row of rows) {
			const button = append(this.nav, $('button.volt-agent-home-nav-row')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', row.label);
			const container = append(button, $('.volt-agent-home-row'));
			const icon = append(container, $('span.icon'));
			append(icon, $('span.twist'));
			const glyph = append(icon, $('span.glyph'));
			append(container, $('span.name')).textContent = row.label;
			const keybinding = append(container, $('span.keybinding'));
			if (row.element.type === 'newChat') {
				container.classList.add('is-new');
				glyph.appendChild(createHomeNewChatIcon());
				keybinding.textContent = shortcut;
			} else {
				container.classList.add('is-action');
				switch (row.element.id) {
					case 'search':
						glyph.appendChild(createHomeSearchIcon());
						break;
					case 'automations':
					case 'customize':
						glyph.appendChild(renderIcon(actionSpec(row.element.id).icon));
						break;
					default: {
						const unexpected: never = row.element.id;
						return unexpected;
					}
				}
			}
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.activate(row.element);
				button.blur();
			}));
		}
	}

	get view(): IAgentHomeViewState {
		return this.viewState;
	}

	get twoLine(): boolean {
		return isTwoLineView(this.viewState);
	}

	/** The model a chat last ran on: its history, else its loaded orchestration. */
	modelLabel(session: IAgentSessionMeta): string | undefined {
		return session.model || this.orchestrator.getThread(session.id)?.modelLabel;
	}

	liveWork(sessionId: string): AgentHomeWorkState | undefined {
		return this.live.get(sessionId);
	}

	get workingSection(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_HOME_WORKING_SECTION_SETTING) !== false;
	}

	prBadge(sessionId: string): IAgentPrBadge | undefined {
		return this.pullRequests ? prBadge(this.pullRequests.links(sessionId)) : undefined;
	}

	/** A single pull request opens; a stack or several open the chat's current one (the view links the rest). */
	openPullRequest(sessionId: string, badge: IAgentPrBadge): void {
		void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, { host: badge.link.repo.host, owner: badge.link.repo.owner, name: badge.link.repo.name, number: badge.link.number }, sessionId);
	}

	focus(): void {
		this.tree.domFocus();
	}

	/** Opens the Add Project menu (This PC, Git URL, GitHub) under `anchor`. Never a native dialog. */
	async addProject(anchor?: HTMLElement): Promise<void> {
		await this.commandService.executeCommand(VoltProjectCommands.addProject, { anchor });
	}

	/** "Cloning 42%" or "Clone failed" for a project row, while that applies. */
	projectStatus(uri: URI): string | undefined {
		const project = this.voltProjects.getByUri(uri);
		switch (project?.state.kind) {
			case 'cloning': return localize('voltAgent.home.cloning', "Cloning {0}%", project.state.percent);
			case 'error': return localize('voltAgent.home.cloneFailed', "Clone failed");
			default: return undefined;
		}
	}

	async startChat(start: AgentChatStart): Promise<void> {
		await startAgentChat(
			this.voltSessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			start,
		);
	}

	setView(next: IAgentHomeViewState): void {
		this.viewState = next;
		this.storageService.store(AGENT_HOME_VIEW_STORAGE_KEY, JSON.stringify(serializeAgentHomeViewState(next)), StorageScope.PROFILE, StorageTarget.USER);
		this.syncFilterButton();
		void this.refresh();
	}

	/** Folds every group; the Repositories / Workspaces header stays open so its rows remain. */
	collapseAll(): void {
		for (const node of this.tree.getNode(null).children) {
			if (node.element?.type === 'section') {
				for (const child of node.children) {
					this.collapseRecursive(child);
				}
				continue;
			}
			this.collapseRecursive(node);
		}
	}

	markAllAsRead(): void {
		void this.history.markAllRead();
	}

	togglePin(session: IAgentSessionMeta): void {
		void this.lifecycle.setPinned(session.id, !session.pinned);
	}

	toggleArchive(session: IAgentSessionMeta): void {
		this.hover.hide();
		void this.lifecycle.setArchived(session.id, !session.archived);
	}

	settle(session: IAgentSessionMeta): void {
		this.hover.hide();
		void this.lifecycle.setSettled(session.id, true);
	}

	/** The clock on an agent tab: quick picks, or Custom… for a date or a duration. */
	openSnoozeMenu(anchor: HTMLElement, session: IAgentSessionMeta): void {
		this.hover.hide();
		showAgentSnoozeMenu(this.contextViewService, anchor, this.layoutService.activeContainer, until => void this.lifecycle.setSnoozed(session.id, true, until));
	}

	/** The bell on a snoozed tab: back to the list now. */
	wake(session: IAgentSessionMeta): void {
		this.hover.hide();
		void this.lifecycle.setSnoozed(session.id, false);
	}

	openFilterMenu(anchor: HTMLElement): void {
		const pane = this;
		showAgentHomeFilterMenu(this.contextViewService, anchor, {
			get view() {
				return pane.view;
			},
			setView: next => pane.setView(next),
			get workingSection() {
				return pane.workingSection;
			},
			setWorkingSection: on => void pane.configurationService.updateValue(AGENT_HOME_WORKING_SECTION_SETTING, on),
			collapseAll: () => pane.collapseAll(),
			markAllAsRead: () => pane.markAllAsRead(),
		});
	}

	/** Active projects and No Project under a group header's +; the pick starts the new chat. */
	openNewChatMenu(anchor: HTMLElement): void {
		const active = this.voltSessionContext.activeProject?.root.toString();
		const seen = new Set<string>();
		const projects = this.voltSessionContext.projects
			.filter(project => {
				// Two records can share a folder (an older stored id); list the folder once.
				const key = project.root.toString();
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				const state = this.voltProjects.getByUri(project.root)?.state.kind;
				return state === undefined || state === 'ready';
			})
			.map(project => ({ root: project.root, name: project.displayName, current: project.root.toString() === active }));
		showAgentHomeNewChatMenu(this.contextViewService, anchor, projects, choice => void this.startChat(choice));
	}

	/** Right-click on an agent tab: pin, settle, snooze, Auto-settle, archive. */
	showSessionMenu(session: IAgentSessionMeta, anchor: HTMLElement | { x: number; y: number }): void {
		this.hover.hide();
		const actions: IAction[] = [
			new Action('volt.home.pin', session.pinned ? localize('voltAgent.home.unpin', "Unpin") : localize('voltAgent.home.pin', "Pin"), undefined, !session.archived, () => this.lifecycle.setPinned(session.id, !session.pinned)),
			new Separator(),
			new Action('volt.home.settle', session.settled ? localize('voltAgent.home.unsettle', "Move Out of Settled") : localize('voltAgent.home.settle', "Move to Settled"), undefined, true, () => this.lifecycle.setSettled(session.id, !session.settled)),
			new Action('volt.home.snooze', session.snoozed ? localize('voltAgent.home.unsnooze', "Unsnooze") : localize('voltAgent.home.snoozeAction', "Snooze…"), undefined, true, async () => {
				if (session.snoozed) {
					await this.lifecycle.setSnoozed(session.id, false);
				} else {
					// The picker hangs from an element; a right-click at a point falls back to the list.
					this.openSnoozeMenu(isHTMLElement(anchor) ? anchor : this.treeContainer, session);
				}
			}),
			// Off keeps the chat out of Settled however long it sits idle; settling by hand still works.
			new SubmenuAction('volt.home.autoSettle', localize('voltAgent.home.autoSettle', "Auto-settle"), [
				toAction({ id: 'volt.home.autoSettle.on', label: localize('voltAgent.home.autoSettleOn', "Enabled"), checked: session.autoSettle !== false, run: () => this.history.setAutoSettle(session.id, true) }),
				toAction({ id: 'volt.home.autoSettle.off', label: localize('voltAgent.home.autoSettleOff', "Disabled"), checked: session.autoSettle === false, run: () => this.history.setAutoSettle(session.id, false) }),
			]),
			new Separator(),
			new Action('volt.home.archive', session.archived ? localize('voltAgent.home.unarchive', "Unarchive") : localize('voltAgent.home.archive', "Archive"), undefined, true, () => this.lifecycle.setArchived(session.id, !session.archived)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	/** Open Workspace on the project header: recents, folders on this Mac, clone, new folder. A second click closes it. */
	openWorkspaceMenu(anchor: HTMLElement): void {
		void showAgentProjectMenu(this.instantiationService, anchor, this.voltSessionContext.activeProject?.root);
	}

	/** The open chat keeps its highlight from the active editor, not list selection (clicking elsewhere clears that). */
	isActiveChat(sessionId: string): boolean {
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		return active instanceof AgentEditorInput && active.sessionId === sessionId;
	}

	/** Where a session lives, as far as the row can tell: repository or folder name, branch, initials. */
	sessionContext(session: IAgentSessionMeta): IAgentHomeSessionContext & { readonly initials: string } {
		if (isScratchSession(session)) {
			const label = scratchProjectLabel();
			return { workspace: label, initials: repoInitials(label) };
		}
		const primary = sessionFolders(session)[0];
		const repo = primary ? this.repos.get(primary) : undefined;
		const folderName = primary ? basename(uriFromStoredRoot(primary)) : undefined;
		const name = repo?.name || folderName || session.workspaceLabel;
		return {
			workspace: repo ? repoDisplayName(repo, dominantRepoOwner(this.repos.values())) : (folderName || session.workspaceLabel || undefined),
			branch: repo?.branch,
			initials: name ? repoInitials(name) : '',
		};
	}

	/** Details card beside an agent tab: title, last-run note, branch, and the folder on disk. */
	bindSessionHover(anchor: HTMLElement, session: IAgentSessionMeta): IDisposable {
		return this.hover.bind(anchor, () => this.sessionHoverRows(session), { placement: 'end', variant: 'card', delay: SESSION_HOVER_DELAY_MS });
	}

	private sessionHoverRows(session: IAgentSessionMeta): IAgentTooltipRow[] {
		const folders = sessionFolders(session).map(path => ({
			pathLabel: this.labelService.getUriLabel(uriFromStoredRoot(path)),
			repo: this.repos.get(path),
		}));
		const rows = agentSessionHoverRows(
			session.title || localize('voltAgent.home.untitled', "New Agent"),
			agentSessionStatusNote(session),
			folders,
			session.workspaceLabel,
		);
		// The chat's pull requests, after the title and status; a click opens one.
		const links = this.pullRequests ? visibleLinks(this.pullRequests.links(session.id)) : [];
		const prRows: IAgentTooltipRow[] = links.slice(0, 5).map(link => ({
			label: `#${link.number} ${link.snapshot?.title ?? ''}`.trim(),
			detail: link.snapshot ? `${link.snapshot.state}${link.watch ? ` · ${localize('voltAgent.home.prWatching', "watching")}` : ''}` : undefined,
			icon: Codicon.gitPullRequest,
			onClick: () => void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, { host: link.repo.host, owner: link.repo.owner, name: link.repo.name, number: link.number }, session.id),
		}));
		const at = rows.findIndex(row => row.icon === Codicon.gitBranch);
		rows.splice(at >= 0 ? at : Math.min(rows.length, 2), 0, ...prRows);
		return rows;
	}

	showMore(groupKey: string): void {
		this.limits.set(groupKey, AGENT_HOME_GROUP_EXPAND_ALL);
		void this.refresh();
	}

	/**
	 * A single click anywhere on a collapsible folder/group/bucket toggles it.
	 * Switching into that folder stays on double-click and keyboard.
	 */
	private isExpandToggleClick(element: AgentHomeElement, browserEvent: UIEvent | undefined): boolean {
		if (!isMouseEvent(browserEvent) || browserEvent.detail === 2) {
			return false;
		}
		switch (element.type) {
			case 'folder':
			case 'bucket':
			case 'group':
			case 'section':
				return this.tree.getNode(element).collapsible;
			case 'newChat':
			case 'action':
			case 'session':
			case 'more':
			case 'empty':
				return false;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	private async activate(element: AgentHomeElement): Promise<void> {
		switch (element.type) {
			case 'newChat':
				await this.startChat({ kind: 'active' });
				return;
			case 'action':
				await this.runAction(element.id);
				return;
			case 'section':
			case 'bucket':
			case 'group':
			case 'empty':
				return;
			case 'folder':
				await this.openProject(element);
				return;
			case 'session':
				await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, element.session.id);
				return;
			case 'more':
				this.showMore(element.groupKey);
				return;
			default: {
				const unexpected: never = element;
				return unexpected;
			}
		}
	}

	/** A single-folder row opens its folder; a multi-folder row opens its most recent agent tab. */
	private async openProject(element: Extract<AgentHomeElement, { type: 'folder' }>): Promise<void> {
		const folder = element.project.folder;
		if (folder && !folder.workspace) {
			await this.openFolder(folder);
			return;
		}
		const first = this.tree.getNode(element).children[0]?.element;
		if (first?.type === 'session') {
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, first.session.id);
		}
	}

	private async runAction(id: AgentHomeActionId): Promise<void> {
		switch (id) {
			case 'search':
				await this.commandService.executeCommand('workbench.action.showCommands');
				return;
			case 'automations':
				await this.commandService.executeCommand(OPEN_AGENT_SCHEDULES_COMMAND_ID);
				return;
			case 'customize':
				await this.commandService.executeCommand(OPEN_AGENT_CUSTOMIZE_COMMAND_ID);
				return;
			default: {
				const unexpected: never = id;
				return unexpected;
			}
		}
	}

	private currentKeys(): Set<string> {
		const active = this.voltSessionContext.activeProject;
		if (active) {
			return new Set([active.root.toString()]);
		}
		const workspace = this.workspaceService.getWorkspace();
		const keys = new Set(workspace.folders.map(folder => folder.uri.toString()));
		if (workspace.configuration) {
			keys.add(workspace.configuration.toString());
		}
		return keys;
	}

	private async openFolder(folder: IAgentHomeFolder): Promise<void> {
		await activateAgentProject(
			this.voltSessionContext,
			this.agentWorkspace,
			this.history,
			this.editorGroupsService,
			this.instantiationService,
			folder.uri,
			folder.name,
		);
	}

	private scheduleRefresh(): void {
		if (this.refreshFrame.value || this._store.isDisposed) {
			return;
		}
		this.refreshFrame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
			this.refreshFrame.clear();
			void this.refresh();
		});
	}

	private recentlyOpened(): Promise<readonly (IRecentFolder | IRecentWorkspace)[]> {
		if (!this.recents) {
			const pending = this.workspacesService.getRecentlyOpened().then(recent => recent.workspaces, () => {
				if (this.recents === pending) {
					this.recents = undefined;
				}
				return [];
			});
			this.recents = pending;
		}
		return this.recents;
	}

	/**
	 * New chats history will not list yet: nothing sent, and no saved unsent text.
	 * Closing the editor drops the row. The first send lists the real session and this stops adding it.
	 */
	private openDrafts(): IAgentOpenDraft[] {
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		const drafts: IAgentOpenDraft[] = [];
		const seen = new Set<string>();
		let index = 0;
		const now = Date.now();
		const parts = this.editorGroupsService.parts.length
			? this.editorGroupsService.parts
			: [this.editorGroupsService.mainPart];
		for (const part of parts) {
			for (const group of part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
				for (const editor of group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
					if (!(editor instanceof AgentEditorInput) || editor.isDisposed() || seen.has(editor.sessionId)) {
						continue;
					}
					seen.add(editor.sessionId);
					const meta = this.history.get(editor.sessionId);
					// Saved unsent text, and every sent chat, already come from history.
					if (meta && (meta.turnCount > 0 || meta.hasDraft)) {
						continue;
					}
					drafts.push(this.describeOpenDraft(editor, now - index, editor === active));
					index++;
				}
			}
		}
		return drafts;
	}

	/** Group the open chat with the project it will run in, the same way a saved chat is grouped. */
	private describeOpenDraft(editor: AgentEditorInput, createdAt: number, isActive: boolean): IAgentOpenDraft {
		const pinned = this.history.pinnedWorkspace(editor.sessionId);
		const binding = this.voltSessionContext.bindingFor(editor.sessionId);
		const project = binding ? this.voltSessionContext.getProject(binding.projectId) : undefined;
		const bound = project ?? (isActive ? this.voltSessionContext.activeProject : undefined);
		const pinnedFolders = pinned?.folders?.filter(folder => folder.length > 0);
		const projectFolder = bound ? folderPath(bound.root) : undefined;
		return {
			id: editor.sessionId,
			createdAt,
			title: editor.storedTitle,
			workspaceId: pinned?.id || bound?.id || editor.sessionId,
			workspaceLabel: pinned?.label || bound?.displayName || '',
			workspaceFolder: pinnedFolders?.[0] || projectFolder,
			workspaceFolders: pinnedFolders && pinnedFolders.length > 1 ? pinnedFolders : undefined,
			parentId: this.history.sessionParent(editor.sessionId),
		};
	}

	private async refresh(): Promise<void> {
		this.refreshFrame.clear();
		const seq = ++this.refreshSeq;
		const recents = await this.recentlyOpened();
		// Wait out the index load so a restored chat is not briefly called a draft.
		await this.history.whenReady.catch(() => undefined);
		if (seq !== this.refreshSeq || this._store.isDisposed) {
			return;
		}
		const current = this.currentKeys();
		// A chat's worktree is listed under the chat's project. The IDE layout opens it as the
		// window's folder, which must not turn it into a workspace of its own.
		const worktrees = new Set(this.history.list({ includeArchived: true })
			.flatMap(session => session.worktreePath ? [URI.file(session.worktreePath).toString()] : []));
		const projects = this.voltSessionContext.projects
			.filter(project => !worktrees.has(project.root.toString()))
			.map(project => ({
				uri: project.root,
				name: project.displayName,
				current: current.has(project.root.toString()),
				workspace: false,
			}));
		const projectKeys = new Set(projects.map(project => project.uri.toString()));
		const extras: IAgentHomeFolder[] = [];
		for (const recent of recents) {
			const folder = this.toFolder(recent, current);
			if (!folder || projectKeys.has(folder.uri.toString()) || worktrees.has(folder.uri.toString())) {
				continue;
			}
			extras.push(folder);
		}
		const folders = [...projects, ...extras];
		// A side chat tab in a chat's tools belongs to that chat even before its log records it.
		// Side chats opened before chats recorded their parent learn it here.
		const toolsParents = agentSideChatParents();
		for (const [id, parentId] of toolsParents) {
			if (!this.history.sessionParent(id)) {
				this.history.pinSessionParent(id, parentId);
			}
		}
		const sessions = sessionsWithOpenDrafts(
			this.history.list({ includeArchived: this.viewState.archived === 'show' }),
			this.openDrafts(),
		).map(session => !session.parentId && toolsParents.has(session.id) ? { ...session, parentId: toolsParents.get(session.id) } : session)
			.filter(session => !this.isSubagentSession(session));
		this.resolveRepos(folders, sessions);
		const prTags = new Map<string, AgentHomePrFilter>();
		if (this.pullRequests) {
			for (const session of sessions) {
				const tag = sessionPrFilterTag(this.pullRequests.links(session.id));
				if (tag !== 'none') {
					prTags.set(session.id, tag);
				}
			}
		}
		this.live = agentHomeLiveWork(this.orchestrator.getState());
		const tree = buildAgentHomeTree(folders, sessions, this.viewState, { repos: this.repos, limits: this.limits, prTags, workingShelf: this.workingSection, live: this.live });
		// Row heights are measured when rows are inserted: switching one and two lines inserts them again.
		if (this.builtTwoLine !== undefined && this.builtTwoLine !== this.twoLine) {
			this.tree.setChildren(null, []);
		}
		this.builtTwoLine = this.twoLine;
		this.tree.setChildren(null, tree.map(toTreeElement));
		this.tree.rerender();
		this.expandHomeSections();
		this.revealActiveNewChat();
		this.syncFilterButton();
		this.layout();
	}

	/**
	 * Reads git facts for every folder the list can show. The resolver caches
	 * them, so a refresh only follows when a repository or branch changed.
	 */
	private isSubagentSession(session: IAgentSessionMeta): boolean {
		if (session.subagent || this.orchestrator.getThread(session.id)?.taskId) {
			return true;
		}
		if (session.parentId && !this.checkedSubagents.has(session.id)) {
			this.checkedSubagents.add(session.id);
			void this.orchestrator.ensureThreadLoaded(session.id);
		}
		return false;
	}

	private resolveRepos(folders: readonly IAgentHomeFolder[], sessions: readonly IAgentSessionMeta[]): void {
		const paths = new Set<string>();
		for (const folder of folders) {
			if (!folder.workspace) {
				paths.add(folderPath(folder.uri));
			}
		}
		for (const session of sessions) {
			for (const path of sessionFolders(session)) {
				paths.add(path);
			}
		}
		for (const path of paths) {
			let uri;
			try {
				uri = uriFromStoredRoot(path);
			} catch {
				continue;
			}
			void this.repoResolver.resolve(uri).then(repo => {
				if (this._store.isDisposed || sameRepo(this.repos.get(path), repo)) {
					return;
				}
				if (repo) {
					this.repos.set(path, repo);
				} else {
					this.repos.delete(path);
				}
				this.repoRefresh.schedule();
			});
		}
	}

	private expandHomeSections(): void {
		for (const node of this.tree.getNode(null).children) {
			// Keep the project section open; folder expand/collapse is left to the user and preserved across refresh.
			if (node.element?.type === 'section' && node.collapsible) {
				this.tree.expand(node.element);
			}
		}
	}

	/**
	 * A new chat is filed under its project. If that project is folded, the row
	 * the user just started is invisible, so open the folders above it.
	 */
	private revealActiveNewChat(): void {
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		if (!(active instanceof AgentEditorInput)) {
			return;
		}
		const meta = this.history.get(active.sessionId);
		if (meta && meta.turnCount > 0) {
			return;
		}
		const node = this.findSessionNode(active.sessionId);
		if (!node?.element) {
			return;
		}
		const folded: AgentHomeElement[] = [];
		let parent = this.tree.getParentElement(node.element);
		while (parent) {
			if (this.tree.isCollapsed(parent)) {
				folded.push(parent);
			}
			parent = this.tree.getParentElement(parent);
		}
		for (const element of folded.reverse()) {
			this.tree.expand(element);
		}
	}

	private findSessionNode(id: string): ITreeNode<AgentHomeElement | null, void> | undefined {
		const walk = (node: ITreeNode<AgentHomeElement | null, void>): ITreeNode<AgentHomeElement | null, void> | undefined => {
			for (const child of node.children) {
				if (child.element?.type === 'session' && child.element.session.id === id) {
					return child;
				}
				const nested = walk(child);
				if (nested) {
					return nested;
				}
			}
			return undefined;
		};
		return walk(this.tree.getNode(null));
	}

	private collapseRecursive(node: ITreeNode<AgentHomeElement | null, void>): void {
		if (node.element && node.collapsible) {
			this.tree.collapse(node.element);
		}
		for (const child of node.children) {
			this.collapseRecursive(child);
		}
	}

	private syncFilterButton(): void {
		const active = anyHomeFilterActive(this.viewState);
		for (const button of this.treeContainer.querySelectorAll('.volt-agent-home-filter')) {
			button.classList.toggle('active', active);
		}
	}

	private readViewState(): IAgentHomeViewState {
		try {
			const raw = this.storageService.get(AGENT_HOME_VIEW_STORAGE_KEY, StorageScope.PROFILE);
			return raw ? reviveAgentHomeViewState(JSON.parse(raw)) : defaultAgentHomeViewState();
		} catch {
			return defaultAgentHomeViewState();
		}
	}

	/** A second pane would paint over the first after a workspace switch. */
	private keepSingleHome(parent: HTMLElement): void {
		for (const el of parent.querySelectorAll(':scope > .volt-agent-home')) {
			if (el !== this.element) {
				el.remove();
			}
		}
	}

	private toFolder(recent: IRecentFolder | IRecentWorkspace, current: Set<string>): IAgentHomeFolder | undefined {
		if (isRecentFolder(recent)) {
			return {
				uri: recent.folderUri,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.folderUri),
				current: current.has(recent.folderUri.toString()),
				workspace: false,
			};
		}
		if (isRecentWorkspace(recent)) {
			return {
				uri: recent.workspace.configPath,
				name: recent.label || this.labelService.getUriBasenameLabel(recent.workspace.configPath).replace(/\.code-workspace$/, ''),
				current: current.has(recent.workspace.configPath.toString()),
				workspace: true,
				workspaceId: recent.workspace.id,
			};
		}
		return undefined;
	}

	layout(): void {
		const height = this.treeContainer.clientHeight;
		const width = this.treeContainer.clientWidth;
		if (height <= 0 || width <= 0) {
			return;
		}
		this.tree.layout(height, width);
	}
}

function toTreeElement(node: IAgentHomeNode): IObjectTreeElement<AgentHomeElement> {
	const children = node.children?.map(toTreeElement);
	const hasChildren = !!children?.length;
	let collapsible = false;
	switch (node.element.type) {
		case 'folder':
		case 'bucket':
		case 'group':
		case 'section':
			collapsible = hasChildren;
			break;
		case 'newChat':
		case 'action':
		case 'session':
		case 'more':
		case 'empty':
			collapsible = false;
			break;
		default: {
			const unexpected: never = node.element;
			return unexpected;
		}
	}
	// Preserve user expand/collapse across refresh; fall back to the model default on first insert.
	const collapsed = node.collapsed
		? ObjectTreeElementCollapseState.PreserveOrCollapsed
		: ObjectTreeElementCollapseState.PreserveOrExpanded;
	return {
		element: node.element,
		collapsible,
		collapsed,
		children,
	};
}
