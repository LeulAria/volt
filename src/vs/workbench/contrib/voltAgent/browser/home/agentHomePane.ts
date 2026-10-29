/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomePane.css';
import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement, isKeyboardEvent, isMouseEvent, runWhenWindowIdle, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IDragAndDropData } from '../../../../../base/browser/dnd.js';
import { IIdentityProvider, IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { Pane, PaneView } from '../../../../../base/browser/ui/splitview/paneview.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { disposableTimeout, RunOnceScheduler } from '../../../../../base/common/async.js';
import { Action, IAction, Separator, SubmenuAction, toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, dispose, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { showAgentProjectMenu } from './agentHomeWorkspaceActions.js';
import { isScratchSession, scratchProjectLabel } from './agentHomeWorkspace.js';
import { IVoltProjectsService, VoltProjectCommands } from '../../../voltProjects/common/projects.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
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
import { IAgentCloudTasksService } from '../../../../services/voltRuntime/browser/cloud/agentCloudTasksService.js';
import { cloudTaskStatusText, cloudTaskTone, ICloudTask } from '../../../../services/voltRuntime/common/cloud/cloudTasks.js';
import { AgentCloudTaskMenu } from '../cloud/agentCloudTaskMenu.js';
import { isLiveTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { limitBadgeLabel, limitParkedClock } from '../../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import { IAgentRuntimeService, VOLT_PROJECT_SETTINGS_COMMAND_ID } from '../../../../services/voltRuntime/common/runtime.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { canonicalProjectRoot, IVoltProjectRecord, IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { AgentEditorInput, NEW_AGENT_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_CUSTOMIZE_COMMAND_ID, OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID } from '../editor/agentEditorInput.js';
import { OPEN_AUTOMATIONS_COMMAND_ID } from '../automations/automationCommands.js';
import { AgentUsageEditorInput } from '../usage/agentUsageEditor.js';
import { appendAgentFooterActions } from './agentHomeFooterActions.js';
import { SEARCH_AGENT_CHATS_COMMAND_ID } from '../search/agentChatSearchService.js';
import { createHomeAutomationsIcon, createHomeFilterIcon, createHomeFolderIcon, createHomeFoldersIcon, createHomeNewChatIcon, createHomeOpenWorkspaceIcon, createHomeSearchIcon, createHomeStatusBadgeIcon } from './agentHomeIcons.js';
import { OPEN_SCRATCH_BOARD_COMMAND_ID, ScratchBoardEditorInput } from '../scratchBoard/scratchBoardInput.js';
import { IScratchSessionLinks } from '../scratchBoard/scratchSessionLinks.js';
import { showAgentSnoozeMenu } from './agentSnoozeMenu.js';
import { activateAgentProject, findAgentPanelGroup, startAgentChat } from '../workspace/agentPanels.js';
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
	buildCloudHomeNodes,
	fairPaneShares,
	folderPath,
	IAgentHomeFolder,
	IAgentHomeNode,
	IAgentHomeRunGroup,
	IAgentHomeRunMember,
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
	shortProjectName,
} from './agentHomeModel.js';
import { AgentRepoResolver, dominantRepoOwner, IAgentRepoInfo, repoDisplayName } from './agentRepoInfo.js';
import { agentSessionHoverRows, agentSessionStatusNote } from './agentSessionHover.js';
import { IAgentPullRequestService } from '../pullRequests/agentPullRequestService.js';
import { IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';
import { OPEN_PULL_REQUEST_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { IAgentPrBadge, prBadge, sessionPrFilterTag, visibleLinks } from '../../common/agentPullRequests.js';
import { IAgentRunGroupService } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { runBadgeKind, runGroupBadge, runGroupSummary, runStatusLabel } from '../runGroups/agentRunGroupLabels.js';
import { ARCHIVE_RUN_GROUP_COMMAND_ID, OPEN_RUN_GROUP_COMMAND_ID } from '../runGroups/agentRunGroupCommands.js';
import { AGENT_HOME_WORKING_SECTION_SETTING } from '../../common/agentHomeSettings.js';
import { lifecycleUndoLabel } from '../../common/agentLifecycleUndo.js';
import { AGENT_LIFECYCLE_UNDO_COMMAND_ID, IAgentThreadLifecycleService } from './agentThreadLifecycle.js';

const ROW_HEIGHT = 28;
/** An agent tab with a second line (branch, pull request, model). */
const TWO_LINE_ROW_HEIGHT = 46;
/** How often ages, "Working 2m" and snooze countdowns are redrawn. */
const CLOCK_TICK_MS = 30_000;
/** Longest a list rebuild waits for an idle moment. */
const REFRESH_IDLE_TIMEOUT_MS = 120;
/** How long after a press-open the completing click is still the same open. */
const PRESS_OPEN_WINDOW_MS = 1_500;
/** How long the pointer rests on an agent tab before its details card opens. */
const SESSION_HOVER_DELAY_MS = 500;
/** How long a dragged chat rests on a folded group's header before the group opens (the Explorer's delay). */
const DROP_EXPAND_DELAY_MS = 500;

/** What dropping a chat on a group does: back to the inbox (`inbox` keeps a pin), pin, settle, snooze. */
type AgentHomeDropAction = 'inbox' | 'active' | 'pin' | 'settled' | 'snooze';

/** The drop action of a top-level group; none for groups that do not hold chats (Cloud). */
function groupDropAction(group: AgentHomeElement): AgentHomeDropAction | undefined {
	switch (group.type) {
		case 'group':
			return group.id === 'working' ? 'inbox' : group.id;
		case 'bucket':
			switch (group.id) {
				case 'pinned': return 'pin';
				case 'settled': return 'settled';
				case 'snooze': return 'snooze';
				case 'working': return 'inbox';
				default: return 'active';
			}
		case 'section':
			return 'active';
		default:
			return undefined;
	}
}

/** Whether the drop would change the chat; a drop back into its own group does nothing. */
function dropChangesSession(session: IAgentSessionMeta, action: AgentHomeDropAction): boolean {
	const shelf = sessionHomeShelf(session);
	switch (action) {
		case 'settled': return shelf !== 'settled';
		case 'snooze': return shelf !== 'snooze';
		case 'pin': return !session.archived && (!session.pinned || shelf !== 'active');
		case 'inbox': return shelf !== 'active';
		case 'active': return shelf !== 'active' || !!session.pinned;
	}
}

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
			case 'runGroup': return `runGroup:${element.folderKey}:${element.group.id}`;
			case 'more': return `more:${element.groupKey}`;
			case 'empty': return `empty:${element.key}`;
			case 'cloudHeader': return 'cloudHeader';
			case 'cloud': return `cloud:${element.task.id}`;
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
	/** The pull request at the end of a one-line row. */
	readonly linePr: HTMLElement;
	readonly glyph: HTMLElement;
	readonly name: HTMLElement;
	readonly actions: HTMLElement;
	readonly snooze: HTMLButtonElement;
	readonly settle: HTMLButtonElement;
	readonly wake: HTMLButtonElement;
	/** Open in New Window (desktop only). */
	readonly newWindow: HTMLButtonElement;
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
	/** Project Settings, beside the + on a project row. */
	readonly settings: HTMLButtonElement;
	readonly add: HTMLButtonElement;
	readonly elementDisposables: DisposableStore;
}

const ROW_STATE_CLASSES = [
	'is-new', 'is-action', 'is-section', 'is-folder', 'is-bucket', 'is-group', 'is-session', 'is-more', 'is-empty',
	'is-nested', 'is-flat', 'is-collapsible', 'current', 'unread', 'archived', 'pinned',
	'status-needsAttention', 'status-working', 'status-draft', 'status-done',
	'actions-cover-name', 'active-chat', 'shelf-active', 'shelf-settled', 'shelf-snooze', 'group-working', 'group-settled', 'group-snooze', 'two-line',
	'is-run-group', 'is-run-member', 'run-winner', 'run-discarded', 'no-glyph',
];

/** Settled chats are done with: one line each, their pull request at its end. */
function isOneLineSession(session: IAgentSessionMeta): boolean {
	return sessionHomeShelf(session) === 'settled';
}

class AgentHomeDelegate implements IListVirtualDelegate<AgentHomeElement> {
	constructor(private readonly host: { readonly twoLine: boolean }) { }

	getHeight(element: AgentHomeElement): number {
		return (element.type === 'session' && !isOneLineSession(element.session)) || element.type === 'runGroup'
			? (this.host.twoLine ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT)
			: ROW_HEIGHT;
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
		// Unread mark for rows without a glyph slot (CSS shows it only there).
		append(container, $('span.unread-dot'));
		const linePr = append(container, $('span.line-pr'));
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
		const newWindow = append(actions, $('button.row-action.new-window')) as HTMLButtonElement;
		newWindow.tabIndex = -1;
		const pin = append(actions, $('button.row-action.pin')) as HTMLButtonElement;
		pin.tabIndex = -1;
		const archive = append(actions, $('button.row-action.archive')) as HTMLButtonElement;
		archive.tabIndex = -1;
		const keybinding = append(container, $('span.keybinding'));
		const settings = append(container, $('button.settings')) as HTMLButtonElement;
		settings.appendChild(renderIcon(Codicon.settingsGear));
		settings.tabIndex = -1;
		const add = append(container, $('button.add')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		add.tabIndex = -1;
		return { container, icon, twist, glyph, name, linePr, actions, snooze, settle, wake, newWindow, pin, archive, badge, meta, sub, subBranch, subPr, subModel, keybinding, settings, add, elementDisposables: new DisposableStore() };
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
		template.linePr.replaceChildren();
		template.subModel.textContent = '';
		template.keybinding.textContent = '';
		template.settings.classList.add('hidden');
		template.add.classList.add('hidden');
		template.container.classList.remove(...ROW_STATE_CLASSES);
		template.container.style.setProperty('--volt-home-level', String(rowLevel(node.element)));
		template.container.classList.toggle('collapsed', !!node.collapsed);

		const element = node.element;
		// Headers and folders lead with the VS Code pane-header chevron: right when folded, down when open.
		const chevron = node.collapsed ? Codicon.chevronRight : Codicon.chevronDown;
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
				if (element.runMember) {
					this.renderRunMember(element, element.runMember, template);
				} else {
					this.renderSession(element, template);
				}
				break;
			case 'runGroup':
				this.renderRunGroup(element, template);
				break;
			case 'more':
				template.container.classList.add('is-more');
				template.container.classList.toggle('is-nested', element.nested);
				template.name.textContent = localize('voltAgent.home.showMore', "Show more");
				break;
			case 'cloudHeader':
				this.renderCloudHeader(element.count, template);
				break;
			case 'cloud':
				this.renderCloudRow(element.task, template);
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
				template.glyph.appendChild(createHomeAutomationsIcon());
				break;
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

	private renderCloudHeader(count: number, template: IHomeTemplate): void {
		template.container.classList.add('is-section');
		template.name.textContent = `${localize('voltAgent.home.cloud', "Cloud")} · ${count}`;
	}

	private renderCloudRow(task: ICloudTask, template: IHomeTemplate): void {
		const tone = cloudTaskTone(task);
		// Rows are reused: the tone from an earlier render goes before the current one is set.
		template.container.classList.remove('cloud-active', 'cloud-succeeded', 'cloud-failed', 'cloud-muted');
		template.container.classList.add('is-cloud', `cloud-${tone}`);
		template.name.textContent = task.title;
		template.meta.textContent = cloudTaskStatusText(task);
		setAgentTooltip(template.container, `${task.title}\n${cloudTaskStatusText(task)}`);
	}

	private renderSection(element: Extract<AgentHomeElement, { type: 'section' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-section');
		template.name.textContent = agentHomeSectionLabel(element.key);
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
		this.renderProjectSettings(template, project.folder ? this.host.projectFor(project.folder.uri) : undefined);
		this.renderAdd(template, { type: 'folder', project });
	}

	/** Gear on project rows (hover-only via CSS): the same Project Settings as the row's context menu. */
	private renderProjectSettings(template: IHomeTemplate, project: IVoltProjectRecord | undefined): void {
		if (!project) {
			return;
		}
		template.settings.classList.remove('hidden');
		const label = localize('voltAgent.home.projectSettings', "Project Settings");
		template.settings.setAttribute('aria-label', label);
		setAgentTooltip(template.settings, label);
		template.elementDisposables.add(addDisposableListener(template.settings, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.openProjectSettings(project);
		}));
	}

	/** Pinned, Today, Needs Attention, This Mac, ...: a VS Code style group header over agent tabs. */
	private renderBucket(element: Extract<AgentHomeElement, { type: 'bucket' }>, template: IHomeTemplate): void {
		template.container.classList.add('is-group', 'is-collapsible');
		template.name.textContent = element.label;
		if (element.count !== undefined) {
			template.meta.textContent = String(element.count);
		}
	}

	/** + on project rows (hover-only via CSS); start rules live in {@link agentHomeAddStart}. */
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

	/** Working / Settled / Snoozed: a pane section header (leading chevron, uppercase label). */
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

		// Flat rows start at the title: no glyph slot. The project is named on the second line instead.
		template.container.classList.toggle('no-glyph', !element.nested);
		template.name.textContent = session.title || localize('voltAgent.home.untitled', "New Agent");
		const oneLine = isOneLineSession(session);
		const twoLine = this.host.twoLine && !oneLine;
		template.container.classList.toggle('two-line', twoLine);
		// On two lines the branch moves to the second line, beside the pull request and the model.
		template.meta.textContent = sessionMetaParts(session, twoLine || oneLine ? { workspace: context.workspace } : context, this.host.view, now).join(' · ');
		if (twoLine) {
			this.renderSecondLine(template, session, context, element.nested ? undefined : context.project);
		} else if (oneLine) {
			const pr = this.host.view.show.has('pr') ? this.host.prBadge(session.id) : undefined;
			if (pr) {
				this.renderPrBadge(template, session, pr, template.linePr);
			}
		}

		const badge = sessionShowsStatusBadge(session, this.host.view) ? this.host.limitBadge(session.id) ?? sessionStatusBadge(session, now, this.host.liveWork(session.id), this.host.replySeen(session)) : undefined;
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
		// Run rows hide these; a recycled template must show them again.
		template.newWindow.classList.toggle('hidden', !this.host.canOpenInNewWindow);
		template.pin.classList.remove('hidden');
		template.archive.classList.remove('hidden');
		if (this.host.canOpenInNewWindow) {
			this.renderRowAction(template, template.newWindow, localize('voltAgent.home.openInNewWindow', "Open in New Window"),
				() => this.host.openInNewWindow(session), renderIcon(Codicon.linkExternal));
		}
		this.renderRowAction(template, template.pin, session.pinned ? localize('voltAgent.home.unpin', "Unpin") : localize('voltAgent.home.pin', "Pin"),
			() => this.host.togglePin(session), renderIcon(session.pinned ? Codicon.pinned : Codicon.pin));
		this.renderRowAction(template, template.archive, session.archived ? localize('voltAgent.home.unarchive', "Unarchive") : localize('voltAgent.home.archive', "Archive"),
			() => this.host.toggleArchive(session), renderIcon(Codicon.archive));
		template.elementDisposables.add(this.host.bindSessionHover(template.container, session));
		template.elementDisposables.add(addDisposableListener(template.container, 'mouseenter', () => this.fadeNameUnderActions(template)));
	}

	/** One prompt, several models: their icons stacked, the prompt, and how far the runs are. */
	private renderRunGroup(element: Extract<AgentHomeElement, { type: 'runGroup' }>, template: IHomeTemplate): void {
		const group = element.group;
		const status = sessionPrimaryStatus(group.session);
		template.container.classList.add('is-session', 'is-run-group', 'is-collapsible', `status-${status}`, element.nested ? 'is-nested' : 'is-flat', 'shelf-active');
		template.container.classList.toggle('archived', !!group.session.archived);
		template.container.classList.toggle('active-chat', this.host.isActiveRunGroup(group.id));
		template.glyph.appendChild(renderIcon(Codicon.layers));
		template.name.textContent = group.session.title;
		// The models, as overlapping brand icons where other rows show their age.
		const stack = append(template.meta, $('span.volt-run-group-stack'));
		for (const family of group.families.slice(0, 4)) {
			stack.appendChild(createBrandIcon(family, 12));
		}
		const twoLine = this.host.twoLine;
		template.container.classList.toggle('two-line', twoLine);
		if (twoLine) {
			append(template.subBranch, $('span.sub-text')).textContent = group.summary;
		}
		if (group.badge) {
			this.renderStatusBadge(template.badge, group.badge);
		}
		// The chevron folds the runs out; the rest of the row opens the compare view.
		template.elementDisposables.add(addDisposableListener(template.twist, 'mousedown', e => e.stopPropagation()));
		template.elementDisposables.add(addDisposableListener(template.twist, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.toggleRunGroup(element);
		}));
		// Rows are recycled: a session row may have left its snooze, settle and pin buttons showing.
		for (const button of [template.snooze, template.settle, template.wake, template.newWindow, template.pin]) {
			button.classList.add('hidden');
		}
		template.archive.classList.remove('hidden');
		this.renderRowAction(template, template.archive, localize('voltAgent.home.archiveRunGroup', "Archive"),
			() => this.host.archiveRunGroup(group.id), renderIcon(Codicon.archive));
		setAgentTooltip(template.container, `${group.session.title}\n${group.summary}`);
	}

	/** A run in a group: its model, live status, and what it changed so far. */
	private renderRunMember(element: Extract<AgentHomeElement, { type: 'session' }>, member: IAgentHomeRunMember, template: IHomeTemplate): void {
		const live = this.host.runMemberView(member);
		template.container.classList.add('is-session', 'is-run-member', element.nested ? 'is-nested' : 'is-flat', 'shelf-active');
		template.container.classList.toggle('run-winner', !!member.winner);
		template.container.classList.toggle('run-discarded', !!member.discarded);
		template.container.classList.toggle('active-chat', this.host.isActiveChat(member.sessionId));
		template.glyph.appendChild(createBrandIcon(member.family, 13));
		template.name.textContent = member.winner ? localize('voltAgent.home.runWinner', "{0} · Winner", member.label) : member.label;
		const twoLine = this.host.twoLine;
		template.container.classList.toggle('two-line', twoLine);
		if (twoLine) {
			template.subBranch.appendChild(renderIcon(Codicon.gitBranch));
			append(template.subBranch, $('span.sub-text')).textContent = member.branch;
		}
		template.meta.textContent = live.stat ?? '';
		const badge = live.badge ?? member.badge;
		if (badge) {
			this.renderStatusBadge(template.badge, badge);
		}
		for (const button of [template.snooze, template.settle, template.wake, template.newWindow, template.pin, template.archive]) {
			button.classList.add('hidden');
		}
		setAgentTooltip(template.container, `${member.label} · ${member.branch}\n${live.label}`);
	}

	/**
	 * Branch (or project), the pull request badge, and the model, under the title. `project` is
	 * named before the branch on flat rows; under a project row it would repeat it.
	 */
	private renderSecondLine(template: IHomeTemplate, session: IAgentSessionMeta, context: IAgentHomeSessionContext, project?: string): void {
		const line = sessionSecondLine(session, context, this.host.view, this.host.modelLabel(session));
		if (line.branch) {
			if (project) {
				template.subBranch.appendChild(renderIcon(Codicon.folder));
				const label = append(template.subBranch, $('span.sub-project'));
				label.textContent = shortProjectName(project);
				if (label.textContent !== project) {
					setAgentTooltip(label, project);
				}
			}
			template.subBranch.appendChild(renderIcon(Codicon.gitBranch));
			append(template.subBranch, $('span.sub-text')).textContent = line.branch;
		} else if (line.place) {
			append(template.subBranch, $('span.sub-text')).textContent = line.place;
		}
		const badge = this.host.view.show.has('pr') ? this.host.prBadge(session.id) : undefined;
		if (badge) {
			this.renderPrBadge(template, session, badge, template.subPr);
		}
		// The model's brand icon, its name on hover; the name itself when the provider is unknown.
		const model = line.model;
		const provider = model ? this.host.modelProvider(session, model) : undefined;
		if (model && provider) {
			template.subModel.appendChild(createBrandIcon(provider, 12));
			template.subModel.title = model;
		} else {
			template.subModel.textContent = line.model ?? '';
			template.subModel.removeAttribute('title');
		}
	}

	private renderPrBadge(template: IHomeTemplate, session: IAgentSessionMeta, badge: IAgentPrBadge, parent: HTMLElement): void {
		const pill = append(parent, $(`span.volt-agent-home-pr.state-${badge.state}`));
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
			? `#${snapshot.number} ${snapshot.title}\n${snapshot.baseRefName} ← ${snapshot.headRefName}${badge.link.watch ? `\n${localize('voltAgent.home.prWatched', "Watched: the agent wakes on checks, reviews and conflicts")}` : ''}`
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

/** The glyph in a status badge: drawn rings for most states, codicons for Interrupted and Stopped. */
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
		// The same square as the transcript's "Stopped" marker.
		case 'stopped': return renderIcon(Codicon.debugStop);
		default: {
			const unexpected: never = kind;
			return unexpected;
		}
	}
}

/** Headers sit flush; agent tabs under a project or time/status group step in once (~6px). */
function rowLevel(element: AgentHomeElement): number {
	switch (element.type) {
		case 'runGroup':
			return 1;
		case 'session':
			// A run steps in past its group's icon, so it reads as part of that group.
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
		case 'cloudHeader':
		case 'cloud':
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
		case 'runGroup': return localize('voltAgent.home.runGroupRow', "{0}, {1}", element.group.session.title, element.group.summary);
		case 'session': {
			if (element.runMember) {
				return localize('voltAgent.home.runMemberRow', "{0}, {1}", element.runMember.label, element.runMember.statusLabel);
			}
			const title = element.session.title || localize('voltAgent.home.untitled', "New Agent");
			return element.session.turnCount === 0
				? localize('voltAgent.home.draftRow', "{0}, Draft", title)
				: title;
		}
		case 'more': return localize('voltAgent.home.showMore', "Show more");
		case 'cloudHeader': return localize('voltAgent.home.cloud', "Cloud");
		case 'cloud': return element.task.title;
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
			return { label: localize('voltAgent.home.automations', "Automations"), icon: Codicon.zap };
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

/** The VS Code pane header's height (paneview.ts). */
const PANE_HEADER_HEIGHT = 22;
/** Smallest an open group can be dragged to, while it has that many rows. */
const PANE_MIN_BODY = 2 * ROW_HEIGHT;
/** Which groups are open, by pane id; a group without an entry starts as the list model says. */
const AGENT_HOME_PANES_STORAGE_KEY = 'volt.agent.home.panes';

/** Every group folded: this headerless pane takes the space above them, so their headers sit at the bottom. */
class AgentHomeSpacerPane extends Pane {
	constructor() {
		super({ title: '', expanded: true, minimumBodySize: 0, maximumBodySize: 0 });
		this.element.classList.add('volt-agent-home-pane-spacer');
		this.render();
		this.headerVisible = false;
		this.collapsible = false;
	}

	/** Takes the free space (no group open), or none. */
	fill(on: boolean): void {
		const max = on ? Number.POSITIVE_INFINITY : 0;
		if (this.maximumBodySize !== max) {
			this.maximumBodySize = max;
		}
	}

	protected renderHeader(): void { }
	protected renderBody(): void { }
	protected layoutBody(): void { }
}

/**
 * One top-level group of the list (Pinned, Today, Working, Done, Settled, a project section, Cloud):
 * a VS Code pane like Source Control's, with its own list. The header folds it; open groups share
 * the height, and folded ones keep only their header.
 */
class AgentHomeSectionPane extends Pane {
	tree: WorkbenchObjectTree<AgentHomeElement> | undefined;
	private readonly treeStore = this._register(new DisposableStore());
	private readonly headerStore = this._register(new DisposableStore());
	private headerRow: HTMLElement | undefined;
	private twist: HTMLElement | undefined;
	private label: HTMLElement | undefined;
	private count: HTMLElement | undefined;
	private add: HTMLButtonElement | undefined;

	constructor(
		readonly id: string,
		private groupElement: AgentHomeElement,
		private nodes: readonly IAgentHomeNode[],
		expanded: boolean,
		private readonly host: AgentHomePane,
	) {
		super({ title: elementLabel(groupElement), expanded, minimumBodySize: 0 });
		this.element.classList.add('volt-agent-home-pane');
		this.render();
		this._register(this.onDidChangeExpansionState(open => host.onPaneExpansion(this, open)));
	}

	/** The group's own element: the header row of the single list this replaced. */
	get group(): AgentHomeElement {
		return this.groupElement;
	}

	/** Rows in the open list; a folded group has none drawn. */
	get contentHeight(): number {
		return this.tree?.contentHeight ?? 0;
	}

	update(group: AgentHomeElement, nodes: readonly IAgentHomeNode[], reinsert: boolean): void {
		this.groupElement = group;
		this.nodes = nodes;
		this.renderHeaderContent();
		if (!this.tree) {
			return;
		}
		// Row heights are measured when rows are inserted: switching one and two lines inserts them again.
		if (reinsert) {
			this.tree.setChildren(null, []);
		}
		this.tree.setChildren(null, nodes.map(toTreeElement));
		this.tree.rerender();
	}

	/** Sets the body's height range, widening before narrowing so the range is never empty. */
	bound(min: number, max: number): void {
		if (min > this.maximumBodySize) {
			this.maximumBodySize = max;
			this.minimumBodySize = min;
			return;
		}
		if (this.minimumBodySize !== min) {
			this.minimumBodySize = min;
		}
		if (this.maximumBodySize !== max) {
			this.maximumBodySize = max;
		}
	}

	/** The chat's row in this group, drawn or not. */
	findSession(id: string): AgentHomeElement | undefined {
		const walk = (nodes: readonly IAgentHomeNode[]): AgentHomeElement | undefined => {
			for (const node of nodes) {
				if (node.element.type === 'session' && node.element.session.id === id) {
					return node.element;
				}
				const nested = node.children && walk(node.children);
				if (nested) {
					return nested;
				}
			}
			return undefined;
		};
		return walk(this.nodes);
	}

	/** The header row: where a drop that needs a pick (Snoozed) opens its menu. */
	get headerElement(): HTMLElement {
		return this.headerRow ?? this.element;
	}

	protected renderHeader(container: HTMLElement): void {
		container.classList.add('volt-agent-home-pane-header');
		// A chat dragged onto the header moves to this group; a folded group opens after a short hover.
		this._register(addDisposableListener(container, 'dragover', e => this.host.onHeaderDragOver(this, e)));
		this._register(addDisposableListener(container, 'dragleave', e => {
			if (!(e.relatedTarget instanceof Node && container.contains(e.relatedTarget))) {
				this.host.onDropTargetLeave();
			}
		}));
		this._register(addDisposableListener(container, 'drop', e => this.host.onHeaderDrop(this, e)));
		const row = append(container, $('.volt-agent-home-row.is-group.is-collapsible'));
		this.twist = append(append(row, $('span.icon')), $('span.twist'));
		this.label = append(row, $('span.name'));
		this.count = append(row, $('span.meta'));
		const add = append(row, $('button.add.hidden')) as HTMLButtonElement;
		add.type = 'button';
		add.tabIndex = -1;
		add.appendChild(renderIcon(Codicon.add));
		this.add = add;
		this.headerRow = row;
		this.renderHeaderContent();
	}

	protected override updateHeader(): void {
		super.updateHeader();
		this.twist?.replaceChildren(renderIcon(this.isExpanded() ? Codicon.chevronDown : Codicon.chevronRight));
	}

	private renderHeaderContent(): void {
		const row = this.headerRow;
		const add = this.add;
		if (!row || !add || !this.label || !this.count) {
			return;
		}
		this.headerStore.clear();
		const group = this.groupElement;
		row.classList.remove('group-working', 'group-settled', 'group-snooze');
		if (group.type === 'group') {
			row.classList.add(`group-${group.id}`);
		}
		this.label.textContent = elementLabel(group);
		const count = group.type === 'bucket' || group.type === 'group' || group.type === 'cloudHeader' ? group.count : undefined;
		this.count.textContent = count === undefined ? '' : String(count);
		// The header's +: only the projects section has one (it adds a project); chat groups (Pinned, Done, Settled) have none.
		const addsProject = group.type === 'section' && !!group.add;
		add.classList.toggle('hidden', !addsProject);
		if (!addsProject) {
			return;
		}
		setAgentTooltip(add, localize('voltAgent.home.newProject', "New Project"));
		// Handled here, not as a click on the header: the default is prevented so the group does not fold.
		this.headerStore.add(addDisposableListener(add, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.host.addProject(add);
		}));
	}

	protected renderBody(container: HTMLElement): void {
		const list = append(container, $('.volt-agent-home-pane-list'));
		this.tree = this.host.createPaneTree(list, this.treeStore, this);
		this.tree.setChildren(null, this.nodes.map(toTreeElement));
		this.treeStore.add(this.tree.onDidChangeContentHeight(() => this.host.scheduleBalance()));
	}

	protected layoutBody(height: number, width: number): void {
		this.tree?.layout(height, width);
	}
}

export class AgentHomePane extends Disposable {

	readonly element: HTMLElement;
	private readonly nav: HTMLElement;
	private navFilter: HTMLButtonElement | undefined;
	private readonly treeContainer: HTMLElement;
	/** The groups, as Source Control's views: folded headers stack, open groups share the height. */
	private readonly paneView: PaneView;
	private readonly spacer: AgentHomeSpacerPane;
	private panes: AgentHomeSectionPane[] = [];
	/** Groups the user opened or folded, by pane id. */
	private readonly paneExpanded: Map<string, boolean>;
	/** What the open groups were last sized for; sizes are set again only when it changes. */
	private balanceKey = '';
	private balanceQueued = false;
	private readonly hover = this._register(new AgentTooltip());
	private readonly repoResolver: AgentRepoResolver;
	/** Repository facts by folder path; filled in the background and applied on the next refresh. */
	private readonly repos = new Map<string, IAgentRepoInfo>();
	/** Rows revealed by "More", per group. */
	private readonly limits = new Map<string, number>();
	private readonly repoRefresh = this._register(new RunOnceScheduler(() => void this.refresh(), 50));
	/** Events that land in the same frame (a chat switch fires several) share one rebuild. */
	private readonly refreshFrame = this._register(new MutableDisposable());
	/** Redraws the rows on screen (the open chat's highlight) on the next frame, ahead of a full refresh. */
	private readonly rowsFrame = this._register(new MutableDisposable());
	/** A chat opened on the press; the click that completes the press does not open it again. */
	private pressed: { readonly element: AgentHomeElement; readonly at: number } | undefined;
	/** The chat dragged from a row, while the drag lasts. */
	private dragged: IAgentSessionMeta | undefined;
	private readonly dragCleanup = this._register(new MutableDisposable());
	/** The group under a dragged chat that would take it; highlighted with `drop-target`. */
	private dropPane: AgentHomeSectionPane | undefined;
	private readonly dropPaneLeave = this._register(new MutableDisposable());
	/** A folded group the drag rests on opens after {@link DROP_EXPAND_DELAY_MS}. */
	private readonly dropExpand = this._register(new MutableDisposable());
	/**
	 * The arrows' chat: one opens at a time, and a held arrow opens only where it stops. `target` is
	 * the last chat reached, until the opens catch up with it; `focusChat` puts the keyboard in it.
	 */
	private browsing: { pending: string | undefined; opening: boolean; target: string | undefined; focusChat: boolean } = { pending: undefined, opening: false, target: undefined, focusChat: false };
	/** Recently opened folders, read once and again only when that list changes. */
	private recents: Promise<readonly (IRecentFolder | IRecentWorkspace)[]> | undefined;
	private refreshSeq = 0;
	/** The Cloud rows' menu opens beside the list. */
	private readonly cloudMenu: AgentCloudTaskMenu;
	private readonly cloudAnchor: HTMLElement;
	private viewState: IAgentHomeViewState;
	/** Chats with a parent whose orchestration was asked for, to learn if they are subagents. */
	private readonly checkedSubagents = new Set<string>();
	/** Desktop only: pull requests linked to chats. */
	private readonly pullRequests: IAgentPullRequestService | undefined;
	/** Desktop only: prompts sent to several models at once. */
	private readonly runGroups: IAgentRunGroupService | undefined;
	private readonly scratchLinks: IScratchSessionLinks | undefined;
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
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentCloudTasksService private readonly cloud: IAgentCloudTasksService,
		@IVoltSessionContextService private readonly voltSessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IVoltProjectsService private readonly voltProjects: IVoltProjectsService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentThreadLifecycleService private readonly lifecycle: IAgentThreadLifecycleService,
		@IAgentThreadAttentionService private readonly attention: IAgentThreadAttentionService,
	) {
		super();
		this._register(this.attention.onDidChange(() => this.scheduleRefresh()));
		this._register(this.voltProjects.onDidChange(() => this.scheduleRefresh()));
		this._register(this.runtime.onDidChangeCatalog(() => this.scheduleRefresh()));
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
		this.scratchLinks = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IScratchSessionLinks));
		this.runGroups = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentRunGroupService));
		if (this.runGroups) {
			this._register(this.runGroups.onDidChange(() => this.scheduleRefresh()));
		}
		this.repoResolver = new AgentRepoResolver(fileService);
		this.viewState = this.readViewState();
		this.element = append(parent, $('.volt-agent-home'));
		this.keepSingleHome(parent);

		this.nav = append(this.element, $('.volt-agent-home-nav'));
		this.installNav(keybindingService);
		this.treeContainer = append(this.element, $('.volt-agent-home-tree'));
		this.installSettingsButton(keybindingService);

		this.paneExpanded = this.readPaneState();
		this.paneView = this._register(new PaneView(this.treeContainer));
		this.spacer = this._register(new AgentHomeSpacerPane());
		this.paneView.addPane(this.spacer, 0);
		this._register(toDisposable(() => dispose(this.panes)));
		// Typing after a click goes to the chat's composer, as it did when the click moved the keyboard there.
		this._register(addDisposableListener(this.treeContainer, 'keydown', e => this.typeIntoComposer(e), true));

		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => {
			this.recents = undefined;
			this.scheduleRefresh();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => this.scheduleRefresh()));
		this._register(this.history.onDidChange(() => this.scheduleRefresh()));
		this._register(this.cloud.onDidChange(() => this.scheduleRefresh()));
		this.cloudAnchor = parent;
		this.cloudMenu = instantiationService.createInstance(AgentCloudTaskMenu);
		this._register(this.editorService.onDidEditorsChange(() => this.scheduleRefresh()));
		// A switch moves the highlight on the next frame; the rebuild waits for the chat to draw.
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.scheduleRowsRerender();
			this.scheduleRefresh();
		}));
		this._register(onDidChangeAgentToolEditors(() => this.scheduleRefresh()));
		this._register(this.voltSessionContext.onDidChangeProjects(() => this.scheduleRefresh()));
		this._register(this.voltSessionContext.onDidChangeActiveProject(() => {
			this.scheduleRowsRerender();
			this.scheduleRefresh();
		}));

		// Ages, "Working 2m" and snooze countdowns move with the clock, not with history events.
		const clock = getWindow(this.element).setInterval(() => this.rerenderRows(), CLOCK_TICK_MS);
		this._register(toDisposable(() => getWindow(this.element).clearInterval(clock)));

		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		void this.refresh();
	}

	/** A group's list: the same rows, clicks, keys and menus in every group. */
	createPaneTree(container: HTMLElement, store: DisposableStore, pane: AgentHomeSectionPane): WorkbenchObjectTree<AgentHomeElement> {
		const tree = store.add(this.instantiationService.createInstance(
			WorkbenchObjectTree<AgentHomeElement>,
			'AgentHome',
			container,
			new AgentHomeDelegate(this),
			[new AgentHomeRenderer(this, this.keybindingService)],
			{
				accessibilityProvider: new AgentHomeAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: AgentHomeElement) => elementLabel(element),
				},
				identityProvider,
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: false,
				renderIndentGuides: RenderIndentGuides.None,
				// A run group's row opens its compare view; its chevron folds the runs out.
				expandOnlyOnTwistieClick: (element: AgentHomeElement) => element.type === 'runGroup',
				setRowLineHeight: false,
				horizontalScrolling: false,
				transformOptimization: false,
				// Sticky group headers cover the rows underneath with the sidebar plate.
				stickyScrollBackdrop: true,
				// Chats drag between groups: onto Settled settles, onto Pinned pins.
				dnd: this.createDragAndDrop(pane),
			}
		));

		// Rows still below the fold dissolve into the footer; the fade lifts at the end of the list.
		store.add(tree.onDidScroll(e => {
			container.classList.toggle('more-below', e.scrollTop + e.height < e.scrollHeight - ROW_HEIGHT);
		}));

		// A chat is read ahead of its open: the row under the pointer, and the one keyboard focus lands on.
		store.add(tree.onMouseOver(e => this.prefetch(e.element)));
		store.add(tree.onDidChangeFocus(e => this.prefetch(e.elements[0])));
		// The arrows walk the chats: each one they land on shows, and the keyboard stays in the list.
		store.add(tree.onDidChangeFocus(e => {
			const element = e.elements[0];
			if (element?.type === 'session' && isKeyboardEvent(e.browserEvent) && !this.isActiveChat(element.session.id)) {
				this.showWhileBrowsing(element.session.id);
			}
		}));
		// A chat opens on the press, not the release: the switch starts a whole click sooner.
		store.add(tree.onMouseDown(e => this.openOnPress(e.element, e.browserEvent)));

		store.add(tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (this.isExpandToggleClick(tree, element, e.browserEvent)) {
				return;
			}
			const pressed = this.pressed;
			this.pressed = undefined;
			if (pressed?.element === element && isMouseEvent(e.browserEvent) && Date.now() - pressed.at < PRESS_OPEN_WINDOW_MS) {
				return; // opened on the press already
			}
			if (element.type === 'session' && isKeyboardEvent(e.browserEvent)) {
				this.openFromKeyboard(element.session.id);
				return;
			}
			void this.activate(element).finally(() => {
				if (element.type === 'newChat' || element.type === 'action' || element.type === 'more' || element.type === 'empty') {
					tree.setSelection([]);
					tree.setFocus([]);
				}
			});
		}));

		// Header chevrons and the row's `collapsed` class are drawn in renderElement; a fold alone does not re-render the row.
		store.add(tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element && tree.hasElement(element)) {
				tree.rerender(element);
			}
		}));

		store.add(tree.onContextMenu(e => {
			if (e.element?.type !== 'session') {
				return;
			}
			e.browserEvent.preventDefault();
			e.browserEvent.stopPropagation();
			this.showSessionMenu(e.element.session, isHTMLElement(e.anchor) ? e.anchor : { x: e.anchor.posx, y: e.anchor.posy });
		}));
		return tree;
	}

	/**
	 * Chat rows drag onto another group: anywhere in its list, or its header. Only chats drag (not
	 * runs of a run group); the list draws no row feedback, the whole target group lights up instead.
	 */
	private createDragAndDrop(pane: AgentHomeSectionPane): ITreeDragAndDrop<AgentHomeElement> {
		const dragged = (element: AgentHomeElement | undefined) => element?.type === 'session' && !element.runMember ? element.session : undefined;
		return {
			getDragURI: element => {
				const session = dragged(element);
				return session ? `volt-agent-chat:${session.id}` : null;
			},
			getDragLabel: elements => elements[0] ? elementLabel(elements[0]) : undefined,
			onDragStart: (data: IDragAndDropData) => {
				const elements = data.getData();
				this.startDrag(Array.isArray(elements) ? dragged(elements[0]) : undefined);
			},
			onDragOver: (): ITreeDragOverReaction | boolean => {
				if (!this.acceptsDrop(pane)) {
					this.onDropTargetLeave();
					return false;
				}
				this.setDropPane(pane);
				return { accept: true, feedback: [], effect: { type: ListDragOverEffectType.Move, position: ListDragOverEffectPosition.Over } };
			},
			onDragLeave: () => this.onDropTargetLeave(),
			drop: () => this.dropOn(pane),
			onDragEnd: () => this.endDrag(),
			dispose: () => { },
		};
	}

	private startDrag(session: IAgentSessionMeta | undefined): void {
		this.dragged = session;
		if (!session) {
			return;
		}
		this.hover.hide();
		// The source row can be redrawn away mid-drag, and then its list never hears `dragend`;
		// the next press ends a drag that was missed.
		const store = new DisposableStore();
		const targetWindow = getWindow(this.element);
		store.add(addDisposableListener(targetWindow, 'dragend', () => this.endDrag(), true));
		store.add(addDisposableListener(targetWindow, 'mousedown', () => this.endDrag(), true));
		this.dragCleanup.value = store;
	}

	private endDrag(): void {
		this.dragged = undefined;
		this.dragCleanup.clear();
		this.setDropPane(undefined);
	}

	private acceptsDrop(pane: AgentHomeSectionPane): boolean {
		const action = groupDropAction(pane.group);
		return !!this.dragged && !!action && dropChangesSession(this.dragged, action);
	}

	/** Lights `pane` up as the drop target; a folded one opens if the drag stays on it. */
	private setDropPane(pane: AgentHomeSectionPane | undefined): void {
		this.dropPaneLeave.clear();
		if (this.dropPane === pane) {
			return;
		}
		this.dropPane?.element.classList.remove('drop-target');
		this.dropPane = pane;
		this.dropExpand.clear();
		if (!pane) {
			return;
		}
		pane.element.classList.add('drop-target');
		if (!pane.isExpanded()) {
			this.dropExpand.value = disposableTimeout(() => {
				if (this.dropPane === pane && this.dragged) {
					pane.setExpanded(true);
				}
			}, DROP_EXPAND_DELAY_MS);
		}
	}

	/** `dragleave` fires between a group's own rows too: the highlight goes only if no `dragover` follows. */
	onDropTargetLeave(): void {
		if (this.dropPane && !this.dropPaneLeave.value) {
			this.dropPaneLeave.value = disposableTimeout(() => this.setDropPane(undefined), 100);
		}
	}

	onHeaderDragOver(pane: AgentHomeSectionPane, e: DragEvent): void {
		if (!this.acceptsDrop(pane)) {
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		this.setDropPane(pane);
	}

	onHeaderDrop(pane: AgentHomeSectionPane, e: DragEvent): void {
		if (!this.acceptsDrop(pane)) {
			return;
		}
		e.preventDefault();
		this.dropOn(pane);
	}

	/** Moves the dragged chat into `pane`'s group with the same lifecycle actions as the row buttons (each one undoable). */
	private dropOn(pane: AgentHomeSectionPane): void {
		const session = this.dragged;
		const action = groupDropAction(pane.group);
		this.endDrag();
		if (!session || !action || !dropChangesSession(session, action)) {
			return;
		}
		const id = session.id;
		const toInbox = async () => {
			if (session.snoozed) {
				await this.lifecycle.setSnoozed(id, false);
			}
			if (session.settled) {
				await this.lifecycle.setSettled(id, false);
			}
		};
		switch (action) {
			case 'settled':
				void (async () => {
					if (session.snoozed) {
						await this.lifecycle.setSnoozed(id, false);
					}
					await this.lifecycle.setSettled(id, true);
				})();
				return;
			case 'snooze':
				// No default time: the snooze menu opens on the group's header for the pick.
				this.openSnoozeMenu(pane.headerElement, session);
				return;
			case 'pin':
				void toInbox().then(() => this.lifecycle.setPinned(id, true));
				return;
			case 'inbox':
				void toInbox();
				return;
			case 'active':
				void toInbox().then(() => session.pinned ? this.lifecycle.setPinned(id, false) : undefined);
				return;
		}
	}

	/**
	 * Footer of the agent list: Settings, Usage, Automations and Customize. While Usage is the active page the row
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

		const store = this._register(new DisposableStore());
		appendAgentFooterActions(footer, this.commandService, store, this.instantiationService);

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
	 * "Settled 'Fix login'  Undo Cmd+Z" for a few seconds after a settle, snooze, archive or pin:
	 * a toast just above the footer's buttons, over the list, so neither moves.
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
	 * Header bar outside the virtualized tree so it pins while chats scroll: Search on the left,
	 * then Filter, Open Workspace and New Chat. Padding lives on `.volt-agent-home-nav`.
	 */
	private installNav(keybindingService: IKeybindingService): void {
		const bar = append(this.nav, $('.volt-agent-home-nav-bar'));

		const searchLabel = actionSpec('search').label;
		const search = append(bar, $('button.volt-agent-home-nav-row')) as HTMLButtonElement;
		search.type = 'button';
		search.setAttribute('aria-label', searchLabel);
		const row = append(search, $('.volt-agent-home-row.is-action'));
		const icon = append(row, $('span.icon'));
		append(icon, $('span.twist'));
		append(icon, $('span.glyph')).appendChild(createHomeSearchIcon());
		append(row, $('span.name')).textContent = searchLabel;
		this._register(addDisposableListener(search, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.runAction('search');
			search.blur();
		}));

		const button = (className: string, label: string, glyph: HTMLElement, run: (button: HTMLButtonElement) => void) => {
			const button = append(bar, $(`button.volt-agent-home-nav-action.${className}`)) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(glyph);
			button.setAttribute('aria-label', label);
			setAgentTooltip(button, label);
			this._register(addDisposableListener(button, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				run(button);
			}));
			return button;
		};
		this.navFilter = button('volt-agent-home-filter', localize('voltAgent.home.filter', "Filter and sort"), createHomeFilterIcon(), button => {
			this.openFilterMenu(button);
			button.blur();
		});
		this.navFilter.classList.toggle('active', anyHomeFilterActive(this.viewState));
		button('volt-agent-home-open-workspace', localize('voltAgent.home.openWorkspace', "Open Workspace"), createHomeOpenWorkspaceIcon(), button => this.openWorkspaceMenu(button));
		const shortcut = keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel();
		const newChatLabel = localize('voltAgent.home.newChat', "New Chat");
		button('volt-agent-home-new-chat', shortcut ? `${newChatLabel} (${shortcut})` : newChatLabel, createHomeNewChatIcon(), button => {
			void this.activate({ type: 'newChat' });
			button.blur();
		});
	}

	get view(): IAgentHomeViewState {
		return this.viewState;
	}

	get twoLine(): boolean {
		return isTwoLineView(this.viewState);
	}

	/** The provider behind a chat's model: its orchestration's model ref, else the catalog entry with that label. */
	modelProvider(session: IAgentSessionMeta, label: string): string | undefined {
		const catalog = this.runtime.listCatalog();
		const ref = this.orchestrator.getThread(session.id)?.modelRef;
		return (ref ? catalog.find(item => item.ref === ref) : undefined)?.providerId
			?? catalog.find(item => item.label === label)?.providerId;
	}

	/** The model a chat last ran on: its history, else its loaded orchestration. */
	modelLabel(session: IAgentSessionMeta): string | undefined {
		return session.model || this.orchestrator.getThread(session.id)?.modelLabel;
	}

	liveWork(sessionId: string): AgentHomeWorkState | undefined {
		return this.live.get(sessionId);
	}

	/** The last reply was looked at: not marked unread and not finished out of sight since. */
	replySeen(session: IAgentSessionMeta): boolean {
		return !session.unread && !this.attention.isUnread(session.id);
	}

	/** A chat parked at a usage limit says when it resumes, and the countdown moves with the clock tick. */
	limitBadge(sessionId: string): IAgentHomeStatusBadge | undefined {
		const thread = this.orchestrator.getThread(sessionId);
		if (!thread?.limit || thread.active) {
			return undefined;
		}
		const now = Date.now();
		const clock = limitParkedClock(thread.limit, this.orchestrator.autoResumeDefault(), now);
		return { kind: 'limited', label: limitBadgeLabel(thread.limit, now, clock.auto) };
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

	/** Keyboard into the list, on the open chat's row when no row has focus yet, so the arrows start from it. */
	focus(): void {
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		const found = active instanceof AgentEditorInput ? this.findSession(active.sessionId) : undefined;
		// The open chat's group when it is open, else the first open group.
		const tree = (found?.pane.isExpanded() ? found.pane.tree : undefined) ?? this.panes.find(pane => pane.isExpanded() && pane.tree)?.tree;
		if (!tree) {
			return;
		}
		tree.domFocus();
		if (tree.getFocus().length) {
			return;
		}
		if (found && tree.hasElement(found.element)) {
			tree.setFocus([found.element]);
			tree.reveal(found.element);
		}
	}

	/** Opens the Add Project menu (This PC, Git URL, GitHub) under `anchor`. Never a native dialog. */
	async addProject(anchor?: HTMLElement): Promise<void> {
		await this.commandService.executeCommand(VoltProjectCommands.addProject, { anchor });
	}

	/** The project a folder row stands for. A folder that is not a project has no settings. */
	projectFor(uri: URI): IVoltProjectRecord | undefined {
		const root = canonicalProjectRoot(uri).toString();
		return this.voltSessionContext.projects.find(project => !project.scratch && canonicalProjectRoot(project.root).toString() === root);
	}

	openProjectSettings(project: IVoltProjectRecord): void {
		void this.commandService.executeCommand(VOLT_PROJECT_SETTINGS_COMMAND_ID, project.id);
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
		for (const pane of this.panes) {
			if (pane.group.type !== 'section') {
				pane.setExpanded(false);
				continue;
			}
			const tree = pane.tree;
			if (tree) {
				for (const node of tree.getNode(null).children) {
					this.collapseRecursive(tree, node);
				}
			}
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

	/** Desktop registers Open in New Window; web and agent-server clients have no second window. */
	get canOpenInNewWindow(): boolean {
		return !!CommandsRegistry.getCommand(OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID);
	}

	/** A new window listing the chat's project, open on the chat. */
	openInNewWindow(session: IAgentSessionMeta): void {
		this.hover.hide();
		void this.commandService.executeCommand(OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID, session.id);
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
		const thread = this.orchestrator.getThread(session.id);
		// Work in the background (the chat need not be open): its turn, subagents, a restart or resume Volt has lined up.
		const working = session.status === 'running' || !!thread?.active || !!thread?.rescue || (!!thread?.limit && thread.limit.auto !== false)
			|| this.orchestrator.tasksOf(session.id).some(task => task.source === 'volt' && isLiveTaskState(task.state));
		const actions: IAction[] = [
			...(working ? [
				new Action('volt.home.stop', localize('voltAgent.home.stop', "Stop"), undefined, true, () => this.orchestrator.cancel(session.id, { cascade: 'all' })),
				new Separator(),
			] : []),
			...(this.canOpenInNewWindow ? [
				new Action('volt.home.openInNewWindow', localize('voltAgent.home.openInNewWindow', "Open in New Window"), undefined, true, () => this.openInNewWindow(session)),
			] : []),
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

	/** Where a session lives, as far as the row can tell: repository or folder name, branch, short project name. */
	sessionContext(session: IAgentSessionMeta): IAgentHomeSessionContext & { readonly project?: string } {
		if (isScratchSession(session)) {
			const label = scratchProjectLabel();
			return { workspace: label, project: label };
		}
		const primary = sessionFolders(session)[0];
		const repo = primary ? this.repos.get(primary) : undefined;
		const folderName = primary ? basename(uriFromStoredRoot(primary)) : undefined;
		const name = repo?.name || folderName || session.workspaceLabel;
		return {
			workspace: repo ? repoDisplayName(repo, dominantRepoOwner(this.repos.values())) : (folderName || session.workspaceLabel || undefined),
			branch: repo?.branch,
			project: name || undefined,
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
	private prefetch(element: AgentHomeElement | null | undefined): void {
		if (element?.type === 'session' && !this.isActiveChat(element.session.id)) {
			this.history.prefetch(element.session.id);
		}
	}

	/** A plain left press on a chat row (not one of its buttons) opens it at once. */
	private openOnPress(element: AgentHomeElement | null, event: MouseEvent): void {
		if (element?.type !== 'session' || event.button !== 0 || event.detail > 1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		const target = event.target as Element | null;
		if (typeof target?.closest !== 'function' || target.closest('button, a, input, .actions, .line-pr, .sub-pr')) {
			return;
		}
		if (this.isActiveChat(element.session.id)) {
			return;
		}
		// Not prevented: Chromium starts no drag from a press whose default was prevented, and rows
		// drag between groups. The list is user-select: none and focuses itself on the press, so the
		// arrows still go on from here.
		this.pressed = { element, at: Date.now() };
		void this.openChat(element.session.id);
	}

	/** The Scratch board on screen, when chat `sessionId` belongs to it. */
	private scratchBoardShowing(sessionId: string): string | undefined {
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		if (!(active instanceof ScratchBoardEditorInput) || !active.boardId) {
			return undefined;
		}
		return this.scratchLinks?.boardFor(sessionId) === active.boardId ? active.boardId : undefined;
	}

	/**
	 * Shows a picked chat. One of the board's own chats, picked while that board shows, opens in the
	 * board's dock beside its drawing (Open in Agents there takes it to the full chat).
	 */
	private openChat(sessionId: string): Promise<unknown> {
		const boardId = this.scratchBoardShowing(sessionId);
		return boardId
			? this.commandService.executeCommand(OPEN_SCRATCH_BOARD_COMMAND_ID, boardId, sessionId, true)
			: this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId, { preserveFocus: true });
	}

	/** Shows the chat the arrows reached; while one opens, the latest reached waits its turn. */
	private showWhileBrowsing(sessionId: string, focusChat = false): void {
		this.browsing.pending = sessionId;
		this.browsing.target = sessionId;
		this.browsing.focusChat = focusChat;
		if (this.browsing.opening) {
			return;
		}
		const next = () => {
			const id = this.browsing.pending;
			this.browsing.pending = undefined;
			if (!id || this.isActiveChat(id)) {
				this.browsing.opening = false;
				this.browsing.target = undefined;
				if (this.browsing.focusChat) {
					findAgentPanelGroup(this.editorGroupsService.mainPart).focus();
				}
				return;
			}
			this.browsing.opening = true;
			void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, id, { preserveFocus: true }).finally(next);
		};
		next();
	}

	/**
	 * ⌘⇧↓ / ⌘⇧↑ (Ctrl+Shift elsewhere): the next or previous agent tab, in the list's order and
	 * wrapping at its ends. Only rows on screen count, not those in folded groups. From the list the
	 * keyboard stays there; from anywhere else it lands in the chat shown.
	 */
	stepChat(direction: -1 | 1): void {
		const rows: { readonly id: string; readonly element: AgentHomeElement; readonly tree: WorkbenchObjectTree<AgentHomeElement> }[] = [];
		const seen = new Set<string>();
		const walk = (tree: WorkbenchObjectTree<AgentHomeElement>, node: ITreeNode<AgentHomeElement | null, void>) => {
			for (const child of node.children) {
				const element = child.element;
				if (!element || !child.visible) {
					continue;
				}
				// A chat filed under two groups is one tab, where it first shows.
				if (element.type === 'session' && !seen.has(element.session.id)) {
					seen.add(element.session.id);
					rows.push({ id: element.session.id, element, tree });
				}
				if (!child.collapsed) {
					walk(tree, child);
				}
			}
		};
		for (const pane of this.panes) {
			if (pane.isExpanded() && pane.tree) {
				walk(pane.tree, pane.tree.getNode());
			}
		}
		if (!rows.length) {
			return;
		}
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		const current = this.browsing.target ?? (active instanceof AgentEditorInput ? active.sessionId : undefined);
		const at = rows.findIndex(row => row.id === current);
		const index = at === -1
			? (direction > 0 ? 0 : rows.length - 1)
			: (at + direction + rows.length) % rows.length;
		const row = rows[index];
		row.tree.setFocus([row.element]);
		row.tree.reveal(row.element);
		const fromList = this.element.contains(getWindow(this.element).document.activeElement);
		if (fromList) {
			row.tree.domFocus();
		}
		this.showWhileBrowsing(row.id, !fromList);
	}

	/** A character typed in the list moves the keyboard into the shown chat's composer, which takes it. */
	private typeIntoComposer(e: KeyboardEvent): void {
		if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
			return;
		}
		// The list's own fields (find, a rename) keep their typing.
		if (isHTMLElement(e.target) && e.target.closest('input, textarea, [contenteditable="true"]')) {
			return;
		}
		const group = findAgentPanelGroup(this.editorGroupsService.mainPart);
		if (!(group.activeEditor instanceof AgentEditorInput)) {
			return;
		}
		// Not the list's type-to-find: the character lands in the composer focused here.
		e.stopPropagation();
		group.focus();
	}

	/**
	 * Enter on a chat shows it and leaves the keyboard in the list, so the arrows go on to the next
	 * one. Enter on the chat already shown moves the keyboard into its composer.
	 */
	private openFromKeyboard(sessionId: string): void {
		if (this.isActiveChat(sessionId)) {
			findAgentPanelGroup(this.editorGroupsService.mainPart).focus();
			return;
		}
		void this.openChat(sessionId);
	}

	private isExpandToggleClick(tree: WorkbenchObjectTree<AgentHomeElement>, element: AgentHomeElement, browserEvent: UIEvent | undefined): boolean {
		if (!isMouseEvent(browserEvent) || browserEvent.detail === 2) {
			return false;
		}
		switch (element.type) {
			case 'folder':
			case 'bucket':
			case 'group':
			case 'section':
			case 'cloudHeader':
				return tree.getNode(element).collapsible;
			case 'newChat':
			case 'action':
			case 'session':
			case 'runGroup':
			case 'more':
			case 'empty':
			case 'cloud':
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
			case 'cloudHeader':
				return;
			case 'cloud':
				this.cloudMenu.show(element.task, this.cloudAnchor);
				return;
			case 'folder':
				await this.openProject(element);
				return;
			case 'session':
				// A click keeps the keyboard in the list too; typing moves it to the composer (typeIntoComposer).
				await this.openChat(element.session.id);
				return;
			case 'runGroup':
				await this.commandService.executeCommand(OPEN_RUN_GROUP_COMMAND_ID, element.group.id);
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
		const first = this.treeOf(element)?.getNode(element).children[0]?.element;
		if (first?.type === 'session') {
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, first.session.id);
		}
	}

	private async runAction(id: AgentHomeActionId): Promise<void> {
		switch (id) {
			case 'search':
				await this.commandService.executeCommand(SEARCH_AGENT_CHATS_COMMAND_ID);
				return;
			case 'automations':
				await this.commandService.executeCommand(OPEN_AUTOMATIONS_COMMAND_ID);
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

	/**
	 * Rebuilds the list once the window is idle (at most {@link REFRESH_IDLE_TIMEOUT_MS} later). A
	 * switch fires several changes at once; the rebuild runs once, after the chat has drawn, not in
	 * the frame that draws it.
	 */
	private scheduleRefresh(): void {
		if (this.refreshFrame.value || this._store.isDisposed) {
			return;
		}
		this.refreshFrame.value = runWhenWindowIdle(getWindow(this.element), () => {
			this.refreshFrame.clear();
			void this.refresh();
		}, REFRESH_IDLE_TIMEOUT_MS);
	}

	private scheduleRowsRerender(): void {
		if (this.rowsFrame.value || this._store.isDisposed) {
			return;
		}
		this.rowsFrame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
			this.rowsFrame.clear();
			this.rerenderRows();
		});
	}

	private rerenderRows(): void {
		for (const pane of this.panes) {
			pane.tree?.rerender();
		}
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
			this.history.list({ includeArchived: this.viewState.archived === 'show', inWindow: true }),
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
		const runGroups = this.homeRunGroups(sessions);
		this.live = agentHomeLiveWork(this.orchestrator.getState());
		const tree = [...buildCloudHomeNodes(this.cloud.tasks), ...buildAgentHomeTree(folders, sessions, this.viewState, { repos: this.repos, limits: this.limits, prTags, runGroups, workingShelf: this.workingSection, live: this.live })];
		const reinsert = this.builtTwoLine !== undefined && this.builtTwoLine !== this.twoLine;
		this.builtTwoLine = this.twoLine;
		this.setPanes(tree, reinsert);
		this.revealActiveNewChat();
		this.syncFilterButton();
		this.layout();
	}

	/**
	 * Reads git facts for every folder the list can show. The resolver caches
	 * them, so a refresh only follows when a repository or branch changed.
	 */
	/** Each run group as one row: it stands in for its runs wherever the list sorts or groups chats. */
	private homeRunGroups(sessions: readonly IAgentSessionMeta[]): IAgentHomeRunGroup[] {
		const service = this.runGroups;
		if (!service) {
			return [];
		}
		const byId = new Map(sessions.map(session => [session.id, session]));
		const now = Date.now();
		const showArchived = this.viewState.archived === 'show';
		return service.list().filter(group => showArchived || !group.archived).map(group => {
			const rollup = service.rollup(group.id);
			const summary = runGroupSummary(group, rollup);
			const metas = new Map<string, IAgentSessionMeta>();
			for (const run of group.runs) {
				const meta = byId.get(run.id);
				if (meta) {
					metas.set(run.id, meta);
				}
			}
			const first = metas.values().next().value as IAgentSessionMeta | undefined;
			const updatedAt = Math.max(group.createdAt, ...[...metas.values()].map(meta => meta.updatedAt));
			const badge = runGroupBadge(rollup);
			const session: IAgentSessionMeta = {
				id: group.id,
				title: group.title,
				createdAt: group.createdAt,
				updatedAt,
				workspaceId: first?.workspaceId ?? group.repoRoot,
				workspaceLabel: first?.workspaceLabel ?? basename(URI.file(group.repoRoot)),
				workspaceFolder: first?.workspaceFolder ?? group.repoRoot,
				turnCount: 1,
				preview: group.prompt.text.slice(0, 200),
				summary,
				status: rollup.live ? 'running' : rollup.status === 'failed' ? 'error' : 'done',
				lastPromptAt: group.createdAt,
				...(rollup.status === 'needsInput' ? { attention: 'question' as const } : {}),
				...(group.archived ? { archived: true } : {}),
			};
			return {
				id: group.id,
				session,
				families: group.runs.map(run => run.model.family),
				summary,
				...(badge ? { badge } : {}),
				metas,
				members: group.runs.map(run => {
					const status = service.runStatus(group.id, run.id);
					const kind = runBadgeKind(status);
					const statusLabel = runStatusLabel(status, run, now);
					return {
						sessionId: run.id,
						label: run.model.label,
						family: run.model.family,
						branch: run.branch,
						statusLabel,
						...(kind ? { badge: { kind, label: statusLabel } } : {}),
						...(group.winner?.runId === run.id ? { winner: true } : {}),
						...(run.discarded ? { discarded: true } : {}),
					};
				}),
			};
		});
	}

	/** A run row's live status (its clock moves between refreshes) and its diff stat. */
	runMemberView(member: IAgentHomeRunMember): { readonly label: string; readonly badge?: IAgentHomeStatusBadge; readonly stat?: string } {
		const group = this.runGroups?.groupOf(member.sessionId);
		const run = group?.runs.find(candidate => candidate.id === member.sessionId);
		if (!group || !run || !this.runGroups) {
			return { label: member.statusLabel };
		}
		const status = this.runGroups.runStatus(group.id, run.id);
		const label = runStatusLabel(status, run, Date.now());
		const kind = runBadgeKind(status);
		// allow-any-unicode-next-line
		const stat = run.stats && (run.stats.additions || run.stats.deletions) ? `+${run.stats.additions} −${run.stats.deletions}` : undefined;
		return { label, ...(kind ? { badge: { kind, label } } : {}), ...(stat ? { stat } : {}) };
	}

	isActiveRunGroup(groupId: string): boolean {
		const active = this.editorService.activeEditor as { readonly runGroupId?: string } | undefined;
		return active?.runGroupId === groupId;
	}

	toggleRunGroup(element: AgentHomeElement): void {
		const tree = this.treeOf(element);
		if (!tree) {
			return;
		}
		if (tree.isCollapsed(element)) {
			tree.expand(element);
		} else {
			tree.collapse(element);
		}
	}

	archiveRunGroup(groupId: string): void {
		void this.commandService.executeCommand(ARCHIVE_RUN_GROUP_COMMAND_ID, groupId);
	}

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

	/**
	 * A new chat is filed under its group and project. If either is folded, the row the user just
	 * started is invisible, so open them.
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
		const found = this.findSession(active.sessionId);
		if (!found) {
			return;
		}
		found.pane.setExpanded(true);
		const tree = found.pane.tree;
		if (!tree?.hasElement(found.element)) {
			return;
		}
		const folded: AgentHomeElement[] = [];
		let parent = tree.getParentElement(found.element);
		while (parent) {
			if (tree.isCollapsed(parent)) {
				folded.push(parent);
			}
			parent = tree.getParentElement(parent);
		}
		for (const element of folded.reverse()) {
			tree.expand(element);
		}
	}

	private findSession(id: string): { readonly pane: AgentHomeSectionPane; readonly element: AgentHomeElement } | undefined {
		for (const pane of this.panes) {
			const element = pane.findSession(id);
			if (element) {
				return { pane, element };
			}
		}
		return undefined;
	}

	/** The open group whose list holds `element`. */
	private treeOf(element: AgentHomeElement): WorkbenchObjectTree<AgentHomeElement> | undefined {
		return this.panes.find(pane => pane.tree?.hasElement(element))?.tree;
	}

	private collapseRecursive(tree: WorkbenchObjectTree<AgentHomeElement>, node: ITreeNode<AgentHomeElement | null, void>): void {
		if (node.element && node.collapsible) {
			tree.collapse(node.element);
		}
		for (const child of node.children) {
			this.collapseRecursive(tree, child);
		}
	}

	/**
	 * One pane per top-level group, in the list's order. A group keeps its pane (and its list's
	 * scroll and folds) across rebuilds; groups that empty out lose theirs.
	 */
	private setPanes(nodes: readonly IAgentHomeNode[], reinsert: boolean): void {
		const existing = new Map(this.panes.map(pane => [pane.id, pane]));
		const next = nodes.map(node => {
			const id = String(identityProvider.getId(node.element));
			const pane = existing.get(id);
			if (pane) {
				existing.delete(id);
				pane.update(node.element, node.children ?? [], reinsert);
				return pane;
			}
			const expanded = this.paneExpanded.get(id) ?? !node.collapsed;
			return new AgentHomeSectionPane(id, node.element, node.children ?? [], expanded, this);
		});
		for (const stale of existing.values()) {
			this.paneView.removePane(stale);
			stale.dispose();
		}
		// The spacer stays first, so pane i sits at index i + 1.
		const order = this.panes.filter(pane => !existing.has(pane.id));
		next.forEach((pane, index) => {
			const at = order.indexOf(pane);
			if (at === -1) {
				this.paneView.addPane(pane, pane.minimumSize, index + 1);
				order.splice(index, 0, pane);
			} else if (at !== index) {
				this.paneView.movePane(pane, order[index]);
				order.splice(at, 1);
				order.splice(index, 0, pane);
			}
		});
		this.panes = next;
	}

	onPaneExpansion(pane: AgentHomeSectionPane, open: boolean): void {
		this.paneExpanded.set(pane.id, open);
		this.storageService.store(AGENT_HOME_PANES_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.paneExpanded)), StorageScope.PROFILE, StorageTarget.USER);
		// After the pane has given the split view its own size for the fold.
		this.scheduleBalance();
	}

	scheduleBalance(): void {
		if (this.balanceQueued) {
			return;
		}
		this.balanceQueued = true;
		queueMicrotask(() => {
			this.balanceQueued = false;
			if (!this._store.isDisposed) {
				this.balancePanes();
			}
		});
	}

	/**
	 * Sizes the open groups to their rows, each up to a fair share of the height; the last open
	 * group takes what is left. With every group folded, the spacer takes it and the headers sit at
	 * the bottom. Runs when the groups, their rows or the height change, so a dragged sash holds
	 * until then.
	 */
	private balancePanes(): void {
		const height = this.treeContainer.clientHeight;
		if (height <= 0) {
			return;
		}
		const open = this.panes.filter(pane => pane.isExpanded());
		const content = open.map(pane => pane.contentHeight);
		const key = `${height}|${this.panes.map(pane => `${pane.id}:${pane.isExpanded() ? 1 : 0}`).join(',')}|${content.join(',')}`;
		if (key === this.balanceKey) {
			return;
		}
		this.balanceKey = key;
		this.spacer.fill(!open.length);
		if (!open.length) {
			return;
		}
		const { sizes, left } = fairPaneShares(content, height - this.panes.length * PANE_HEADER_HEIGHT);
		const last = open.length - 1;
		sizes[last] += left;
		// Pinned at their sizes first, then loosened to their real range: the split view keeps the sizes.
		open.forEach((pane, index) => pane.bound(sizes[index], sizes[index]));
		open.forEach((pane, index) => pane.bound(
			Math.min(content[index], sizes[index], PANE_MIN_BODY),
			index === last ? Number.POSITIVE_INFINITY : Math.max(content[index], sizes[index]),
		));
	}

	private readPaneState(): Map<string, boolean> {
		try {
			const raw = this.storageService.get(AGENT_HOME_PANES_STORAGE_KEY, StorageScope.PROFILE);
			const parsed: unknown = raw ? JSON.parse(raw) : undefined;
			if (parsed && typeof parsed === 'object') {
				return new Map(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
			}
		} catch {
			// A damaged entry starts every group as the list model says.
		}
		return new Map();
	}

	private syncFilterButton(): void {
		this.navFilter?.classList.toggle('active', anyHomeFilterActive(this.viewState));
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
		this.paneView.layout(height, width);
		this.balancePanes();
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
		case 'runGroup':
		case 'cloudHeader':
			collapsible = hasChildren;
			break;
		case 'newChat':
		case 'action':
		case 'session':
		case 'more':
		case 'empty':
		case 'cloud':
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
