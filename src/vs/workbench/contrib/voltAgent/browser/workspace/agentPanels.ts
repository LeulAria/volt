/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runWhenWindowIdle } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentUsageEditorInput } from '../usage/agentUsageEditor.js';
import { AGENT_NEW_CHAT_DRAFT_SETTING } from '../../common/agentComposerSettings.js';
import { agentPanelTabsMode, isBlankNewChat, latestSessionForFolder, unsentDraftForFolder } from '../home/agentHomeModel.js';
import { AgentChatStart, attachSessionToProject, resolveSessionProject } from './agentShell.js';
import { IAgentWorkspaceService } from './agentWorkspace.js';

/**
 * Agent layout shows one agent per main panel. Picking an agent in the left
 * menu swaps the whole panel to it; agents you left stay alive behind it (no
 * tab strip) so coming back is instant, up to this many.
 */
export const MAX_BACKGROUND_AGENT_PANELS = 8;

/** The group that hosts agent panels: the one showing an agent, else any holding one, else the active group. */
export function findAgentPanelGroup(part: IEditorPart): IEditorGroup {
	const groups = part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
	return groups.find(group => group.activeEditor instanceof AgentEditorInput)
		?? groups.find(group => group.editors.some(editor => editor instanceof AgentEditorInput))
		?? part.activeGroup;
}

/**
 * Shows an agent as the main panel. With a session id, reuses that agent's
 * panel when it is already alive; without one, opens a clean new agent.
 */
export async function openAgentPanel(
	editorGroupsService: IEditorGroupsService,
	instantiationService: IInstantiationService,
	sessionId: string | undefined,
	options?: { preserveFocus?: boolean },
): Promise<AgentEditorInput> {
	const part = editorGroupsService.mainPart;
	const preserveFocus = options?.preserveFocus === true;
	if (sessionId) {
		for (const group of part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			const existing = group.editors.find((editor): editor is AgentEditorInput => editor instanceof AgentEditorInput && editor.sessionId === sessionId);
			if (existing) {
				await group.openEditor(existing, { pinned: true, preserveFocus });
				if (!preserveFocus) {
					group.focus();
				}
				return existing;
			}
		}
	}
	const group = findAgentPanelGroup(part);
	const resource = sessionId ? AgentEditorInput.uriForSession(sessionId) : AgentEditorInput.getNewEditorUri();
	const input = instantiationService.createInstance(AgentEditorInput, resource);
	await group.openEditor(input, { pinned: true, preserveFocus });
	if (!preserveFocus) {
		group.focus();
	}
	return input;
}

function isAgentBusy(input: AgentEditorInput): boolean {
	const last = input.messages.at(-1);
	return last?.kind === 'agent' && !!last.activity?.streaming;
}

/** Background agents past the cap, least recently shown first; busy ones are never picked. */
export function agentPanelsToRelease(editors: readonly EditorInput[], max = MAX_BACKGROUND_AGENT_PANELS): AgentEditorInput[] {
	const agents = editors.filter((editor): editor is AgentEditorInput => editor instanceof AgentEditorInput);
	// editors[0] is the visible panel; everything after it is in the background.
	return agents.slice(1 + max).filter(input => !isAgentBusy(input));
}

/**
 * Keeps the agent workspace in step with whichever agent the main panel shows,
 * no matter how it got there (left menu, command, restore, drag).
 */
class AgentPanelsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentPanels';

	private historyReady = false;
	private bindGeneration = 0;
	/** The chat the main panel was showing, so a blank one can be dropped on the way out. */
	private lastMainAgent: AgentEditorInput | undefined;
	private readonly preloadIdle = this._register(new MutableDisposable());

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentWorkspaceService private readonly workspaceService: IAgentWorkspaceService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.onActiveEditor()));
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.markVisibleRead()));
		this._register(this.history.onDidChange(() => this.markVisibleRead()));
		void this.history.whenReady.then(() => {
			this.historyReady = true;
			this.markVisibleRead();
			void this.preloadOpenChats();
		});
		this.onActiveEditor();
	}

	/**
	 * Reads the open chat tabs' history while the window is idle, most recent first,
	 * so the first switch to one draws at once instead of waiting on disk.
	 */
	private async preloadOpenChats(): Promise<void> {
		const inputs = this.editorGroupsService.mainPart.groups
			.flatMap(group => group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE))
			.filter((editor): editor is AgentEditorInput => editor instanceof AgentEditorInput)
			.slice(0, 1 + MAX_BACKGROUND_AGENT_PANELS);
		for (const input of inputs) {
			await new Promise<void>(resolve => this.preloadIdle.value = runWhenWindowIdle(mainWindow, () => resolve(), 1000));
			if (this._store.isDisposed) {
				return;
			}
			if (!input.isDisposed()) {
				await input.ensureLoaded().catch(() => undefined);
			}
		}
	}

	/** A reply that lands on screen is already read; only chats you have not seen stay unread. */
	private markVisibleRead(): void {
		for (const editor of this.editorService.visibleEditors) {
			if (editor instanceof AgentEditorInput && this.history.get(editor.sessionId)?.unread) {
				void this.history.setUnread(editor.sessionId, false);
			}
		}
	}

	private onActiveEditor(): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		// Only the main panel picks the chat; a side chat focused in the tools does not.
		const active = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		const previous = this.lastMainAgent;
		if (active instanceof AgentEditorInput) {
			this.lastMainAgent = active;
		}
		// Nothing typed and nothing sent: leaving the new chat removes it.
		if (previous && previous !== active && !previous.isDisposed() && this.isAbandonedBlank(previous)) {
			this.closeEditor(previous);
		}
		if (!(active instanceof AgentEditorInput)) {
			return;
		}
		this.workspaceService.activate(active.sessionId);
		this.bindSession(active.sessionId);
		// Opening a chat that woke from its snooze is seeing it; the sidebar drops "Woke".
		if (this.history.get(active.sessionId)?.wokeAt !== undefined) {
			void this.history.clearWoke(active.sessionId);
		}
		for (const group of this.editorGroupsService.mainPart.groups) {
			const release = agentPanelsToRelease(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE));
			if (release.length) {
				void group.closeEditors(release, { preserveFocus: true });
			}
		}
	}

	/** A new chat still waiting for its first word. Typed text keeps the sidebar row. */
	private isAbandonedBlank(editor: AgentEditorInput): boolean {
		return isBlankNewChat({
			messages: editor.messages.length,
			draft: editor.draft,
			mentions: editor.draftMentions.length,
			queued: editor.promptQueue.length,
		}, this.history.get(editor.sessionId));
	}

	private closeEditor(editor: AgentEditorInput): void {
		for (const part of this.editorGroupsService.parts) {
			for (const group of part.groups) {
				if (group.editors.includes(editor)) {
					void group.closeEditor(editor, { preserveFocus: true });
					return;
				}
			}
		}
	}

	/**
	 * Bind the chat to its own project. A late result may still record that
	 * binding, but only the latest selection changes the visible project.
	 */
	private bindSession(sessionId: string): void {
		const generation = ++this.bindGeneration;
		const apply = () => {
			const foreground = generation === this.bindGeneration;
			const project = resolveSessionProject(this.sessionContext, this.history.get(sessionId), foreground);
			if (!project) {
				return;
			}
			attachSessionToProject(this.sessionContext, this.workspaceService, this.history, sessionId, project);
			if (foreground) {
				this.sessionContext.selectProject(project.id);
			}
		};
		if (this.historyReady) {
			apply();
			return;
		}
		void this.history.whenReady.then(() => {
			this.historyReady = true;
			apply();
		});
	}
}

/** Register the folder and show its latest chat, or a new one, without opening a workbench. */
export async function activateAgentProject(
	sessionContext: IVoltSessionContextService,
	workspace: IAgentWorkspaceService,
	history: IAgentHistoryService,
	editorGroups: IEditorGroupsService,
	instantiation: IInstantiationService,
	root: URI,
	name: string,
): Promise<void> {
	const project = sessionContext.registerProject(root, name);
	sessionContext.selectProject(project.id);
	const latest = latestSessionForFolder(
		{ uri: project.root, name: project.displayName, current: true, workspace: false },
		history.list({ includeArchived: false }),
	);
	const input = await openAgentPanel(editorGroups, instantiation, latest?.id);
	attachSessionToProject(sessionContext, workspace, history, input.sessionId, project);
}

/**
 * Start a new chat bound to this project. The previous chat stays in the sidebar. With
 * `reopenDraft`, a chat in the project left with only unsent text opens instead (when the setting allows).
 */
export async function newAgentChat(
	sessionContext: IVoltSessionContextService,
	workspace: IAgentWorkspaceService,
	history: IAgentHistoryService,
	editorGroups: IEditorGroupsService,
	instantiation: IInstantiationService,
	root: URI,
	name: string,
	reopenDraft = false,
): Promise<AgentEditorInput> {
	const project = sessionContext.registerProject(root, name);
	sessionContext.selectProject(project.id);
	const draft = reopenDraft ? unsentDraftChat(history, editorGroups, instantiation, project) : undefined;
	const input = await openAgentPanel(editorGroups, instantiation, draft);
	attachSessionToProject(sessionContext, workspace, history, input.sessionId, project);
	return input;
}

/** The project's chat holding only unsent text, other than the one on screen, if the setting is on. */
function unsentDraftChat(
	history: IAgentHistoryService,
	editorGroups: IEditorGroupsService,
	instantiation: IInstantiationService,
	project: IVoltProjectRecord,
): string | undefined {
	const enabled = instantiation.invokeFunction(accessor => accessor.get(IConfigurationService).getValue<boolean>(AGENT_NEW_CHAT_DRAFT_SETTING)) !== false;
	if (!enabled) {
		return undefined;
	}
	const showing = findAgentPanelGroup(editorGroups.mainPart).activeEditor;
	return unsentDraftForFolder(
		{ uri: project.root, name: project.displayName, current: true, workspace: false },
		history.list({ includeArchived: false }),
		showing instanceof AgentEditorInput ? showing.sessionId : undefined,
	)?.id;
}

/**
 * Open a new agent from a home control. Project selection and the no-project
 * (scratch folder on first send) path share this entry so New Chat, folder +, and bucket + agree.
 */
export async function startAgentChat(
	sessionContext: IVoltSessionContextService,
	workspace: IAgentWorkspaceService,
	history: IAgentHistoryService,
	editorGroups: IEditorGroupsService,
	instantiation: IInstantiationService,
	start: AgentChatStart,
): Promise<void> {
	switch (start.kind) {
		case 'folder':
			await newAgentChat(sessionContext, workspace, history, editorGroups, instantiation, start.root, start.name, true);
			return;
		case 'active': {
			const project = sessionContext.activeProject;
			const draft = project ? unsentDraftChat(history, editorGroups, instantiation, project) : undefined;
			const input = await openAgentPanel(editorGroups, instantiation, draft);
			if (project) {
				attachSessionToProject(sessionContext, workspace, history, input.sessionId, project);
			}
			return;
		}
		case 'none':
			sessionContext.selectProject(undefined);
			await openAgentPanel(editorGroups, instantiation, undefined);
			return;
		default: {
			const unexpected: never = start;
			return unexpected;
		}
	}
}

registerWorkbenchContribution2(AgentPanelsContribution.ID, AgentPanelsContribution, WorkbenchPhase.AfterRestored);

/**
 * The main panel is one agent, never a tab strip, whether or not the agent list is open. A file,
 * browser or changes editor opened there gets a single title so it can still be told apart and closed.
 * Tabs belong to the tools beside the chat.
 */
class AgentPanelTabsContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentPanelTabs';

	private readonly override = this._register(new MutableDisposable<IDisposable>());
	private mode: 'none' | 'single' | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._register(this.editorService.onDidEditorsChange(() => this.sync()));
		this._register(onDidChangeLayoutMode(() => this.sync()));
		this.sync();
	}

	private sync(): void {
		const root = this.layoutService.mainContainer;
		if (getLayoutMode(this.layoutService) !== 'agent') {
			this.mode = undefined;
			this.override.clear();
			root.classList.remove('volt-single-agent');
			return;
		}
		// Only an editor on screen needs a title. A file left behind in a background group would
		// otherwise bring the chat's own tab row back under the titlebar, which already names it.
		// Usage needs none either: the titlebar names it and holds its controls.
		let nonAgentEditors = 0;
		for (const group of this.editorGroupsService.mainPart.groups) {
			if (group.activeEditor && !(group.activeEditor instanceof AgentEditorInput) && !(group.activeEditor instanceof AgentUsageEditorInput)) {
				nonAgentEditors++;
			}
		}
		const mode = agentPanelTabsMode(nonAgentEditors);
		root.classList.toggle('volt-single-agent', mode === 'none');
		// Re-applying the same option would relayout every editor group for nothing.
		if (mode !== this.mode) {
			this.mode = mode;
			this.override.value = this.editorGroupsService.mainPart.enforcePartOptions({ showTabs: mode });
		}
	}
}

// Before the editors restore, so the first frame never shows the saved chats as tabs.
registerWorkbenchContribution2(AgentPanelTabsContribution.ID, AgentPanelTabsContribution, WorkbenchPhase.BlockRestore);
