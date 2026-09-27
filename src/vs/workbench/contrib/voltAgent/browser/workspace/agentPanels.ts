/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { latestSessionForFolder } from '../home/agentHomeModel.js';
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
		});
		this.onActiveEditor();
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
		const active = this.editorGroupsService.mainPart.activeGroup.activeEditor;
		if (!(active instanceof AgentEditorInput)) {
			return;
		}
		this.workspaceService.activate(active.sessionId);
		this.bindSession(active.sessionId);
		for (const group of this.editorGroupsService.mainPart.groups) {
			const release = agentPanelsToRelease(group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE));
			if (release.length) {
				void group.closeEditors(release, { preserveFocus: true });
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

/** Start a new chat bound to this project. The previous chat stays in the sidebar. */
export async function newAgentChat(
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
	const input = await openAgentPanel(editorGroups, instantiation, undefined);
	attachSessionToProject(sessionContext, workspace, history, input.sessionId, project);
}

/**
 * Open a new agent from a home control. Project selection and the no-project
 * (send disabled) path share this entry so New Chat, folder +, and bucket + agree.
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
			await newAgentChat(sessionContext, workspace, history, editorGroups, instantiation, start.root, start.name);
			return;
		case 'active': {
			const project = sessionContext.activeProject;
			const input = await openAgentPanel(editorGroups, instantiation, undefined);
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
