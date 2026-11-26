/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IVoltWindowScopesService, IVoltWindowStart, KEEP_NEXT_WINDOW_READY_SETTING } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { getLayoutMode, SET_AGENT_LAYOUT_MODE_COMMAND_ID } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, sessionBelongsToProject } from '../../../services/voltRuntime/common/sessionContext.js';
import { IVoltWindowScopeService } from '../../../services/voltWindowScope/common/voltWindowScope.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID, OPEN_PROJECT_IN_NEW_WINDOW_COMMAND_ID } from '../browser/editor/agentEditorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/** The project a chat runs in: its binding, else the project of its saved folder. Scratch chats have none. */
function chatProject(context: IVoltSessionContextService, session: IAgentSessionMeta): IVoltProjectRecord | undefined {
	const bound = context.bindingFor(session.id)?.projectId;
	const project = bound ? context.getProject(bound) : context.projects.find(candidate => sessionBelongsToProject(session, candidate));
	return project && !project.scratch ? project : undefined;
}

/** The chats and their side chats and subagents, in order: a side chat goes where its chat goes. */
function withSideChats(history: IAgentHistoryService, ids: readonly string[]): string[] {
	const moved = new Set(ids);
	const listed = history.list({ inWindow: true, includeArchived: true });
	let grew = true;
	while (grew) {
		grew = false;
		for (const meta of listed) {
			const parent = history.sessionParent(meta.id);
			if (!moved.has(meta.id) && parent && moved.has(parent)) {
				moved.add(meta.id);
				grew = true;
			}
		}
	}
	return [...moved];
}

/**
 * Open in New Window on one chat or several. The main process holds the new window's scope ready:
 * only those chats (and their side chats) move there, listed under their projects, and the new
 * window opens on the first. The rest of each project stays here. This window closes the chats
 * and leaves them out until the new window closes; then they show here again.
 */
registerAction2(class OpenAgentInNewWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID,
			title: localize2('voltAgent.openInNewWindow', "Open Chat in New Window"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, target?: string | readonly string[]): Promise<void> {
		const requested = (typeof target === 'string' ? [target] : Array.isArray(target) ? target : []).filter((id): id is string => typeof id === 'string' && !!id);
		const history = accessor.get(IAgentHistoryService);
		const context = accessor.get(IVoltSessionContextService);
		const windowScope = accessor.get(IVoltWindowScopeService);
		const ids = requested.filter(id => !!history.get(id) && windowScope.showsSession(id));
		if (!ids.length) {
			return;
		}
		const projects = new Set<string>();
		for (const id of ids) {
			const session = history.get(id);
			const project = session && chatProject(context, session);
			if (project) {
				projects.add(project.id);
			}
		}
		await openNewWindowWith(accessor, {
			openSession: ids[0],
			sessions: withSideChats(history, ids),
			projects: [...projects],
			layoutMode: 'agent',
		});
	}
});

/**
 * Open in New Window on a project: the project and every chat of it this window lists move to a
 * new window, which opens on the latest chat. This window leaves the project out until it closes.
 */
registerAction2(class OpenProjectInNewWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_PROJECT_IN_NEW_WINDOW_COMMAND_ID,
			title: localize2('voltAgent.openProjectInNewWindow', "Open Project in New Window"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, projectId?: string): Promise<void> {
		const context = accessor.get(IVoltSessionContextService);
		const history = accessor.get(IAgentHistoryService);
		const project = typeof projectId === 'string' ? context.getProject(projectId) : undefined;
		if (!project || project.scratch) {
			return;
		}
		// Newest first: the window opens on the chat used last.
		const sessions = history.list({ inWindow: true, includeArchived: true })
			.filter(meta => {
				const bound = context.bindingFor(meta.id)?.projectId;
				return bound ? bound === project.id : sessionBelongsToProject(meta, project);
			})
			.map(meta => meta.id);
		const open = history.list({ inWindow: true }).find(meta => sessions.includes(meta.id) && !meta.subagent)?.id;
		await openNewWindowWith(accessor, {
			openSession: open,
			sessions: withSideChats(history, sessions),
			createdProjects: [project.id],
			layoutMode: 'agent',
		});
	}
});

async function openNewWindowWith(accessor: ServicesAccessor, start: IVoltWindowStart): Promise<void> {
	const scopes = accessor.get(IVoltWindowScopesService);
	const nativeHostService = accessor.get(INativeHostService);
	await scopes.prepareWindow(start);
	await nativeHostService.openWindow({ forceReuseWindow: false });
}

/**
 * A chat is open in one window only. Chats another window took (Open in New Window, or opened
 * there) close here; a chat another window owns that is opened here goes to that window instead.
 */
class AgentWindowOwnershipContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWindowOwnership';

	constructor(
		@IVoltWindowScopeService private readonly windowScope: IVoltWindowScopeService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@ICommandService commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(windowScope.onDidChange(() => this.closeHeldElsewhere()));
		this._register(editorService.onDidActiveEditorChange(() => {
			const active = editorService.activeEditor;
			if (active instanceof AgentEditorInput) {
				void this.sendAway(active);
			}
		}));
		// Another window asked for a chat this one owns: show it here (the window is in front already).
		this._register(windowScope.onDidRevealSession(sessionId => {
			void commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId).catch(err => this.logService.warn('[volt] could not show the chat another window asked for', err));
		}));
		this.closeHeldElsewhere();
	}

	private closeHeldElsewhere(): void {
		for (const group of this.editorGroupsService.groups) {
			const held = group.editors.filter(editor => editor instanceof AgentEditorInput && this.windowScope.heldElsewhere(editor.sessionId));
			if (held.length) {
				void group.closeEditors(held, { preserveFocus: true });
			}
		}
	}

	/** An existing chat this window does not list was opened here: it goes to the window that owns it. */
	private async sendAway(editor: AgentEditorInput): Promise<void> {
		const sessionId = editor.sessionId;
		if (this.windowScope.showsSession(sessionId) || !this.history.get(sessionId)) {
			return; // ours, or a new chat not saved yet (claimed when it is)
		}
		if (!await this.windowScope.revealElsewhere(sessionId)) {
			return;
		}
		for (const group of this.editorGroupsService.groups) {
			const open = group.editors.filter(candidate => candidate instanceof AgentEditorInput && candidate.sessionId === sessionId);
			if (open.length) {
				void group.closeEditors(open, { preserveFocus: true });
			}
		}
	}
}

registerWorkbenchContribution2(AgentWindowOwnershipContribution.ID, AgentWindowOwnershipContribution, WorkbenchPhase.AfterRestored);

/**
 * In a window opened for one chat: select its project and show it, once (not again on reload).
 * The window kept loaded for the next New Window gets its chat when it is shown instead.
 */
class AgentWindowStartContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWindowStart';

	constructor(
		@IVoltWindowScopeService private readonly windowScope: IVoltWindowScopeService,
		@IVoltWindowScopesService scopes: IVoltWindowScopesService,
		@IVoltSessionContextService private readonly context: IVoltSessionContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IEditorService private readonly editorService: IEditorService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const scope = windowScope.scope;
		if (!scope) {
			return;
		}
		this._register(scopes.onDidStartWindow(start => {
			if (start.scope === scope) {
				// The window comes up see-through and turns solid once the chat is drawn, which is
				// before opening it has finished.
				const drawn = this.whenDrawn(start.session);
				void Promise.race([drawn, this.open(start.session)]).finally(() => scopes.didShowWindowStart(scope).catch(() => undefined));
			}
		}));
		void scopes.takeWindowStart(scope).then(sessionId => sessionId ? this.open(sessionId) : undefined);
	}

	/** The chat is the active editor (its transcript renders as it is set) and a frame went by. */
	private async whenDrawn(sessionId: string): Promise<void> {
		const shows = () => {
			const active = this.editorService.activeEditor;
			return active instanceof AgentEditorInput && active.sessionId === sessionId;
		};
		if (!shows()) {
			await Event.toPromise(Event.filter(this.editorService.onDidActiveEditorChange, shows), this._store);
		}
		await new Promise<void>(resolve => scheduleAtNextAnimationFrame(mainWindow, resolve));
	}

	private async open(sessionId: string): Promise<void> {
		try {
			await this.lifecycleService.when(LifecyclePhase.Restored);
			// A window loaded ahead of time started in the mode other windows use.
			if (this.windowScope.layoutMode === 'agent' && getLayoutMode(this.layoutService) !== 'agent') {
				await this.commandService.executeCommand(SET_AGENT_LAYOUT_MODE_COMMAND_ID);
			}
			const projectId = this.context.bindingFor(sessionId)?.projectId;
			if (projectId) {
				this.context.selectProject(projectId);
			}
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId);
		} catch (err) {
			this.logService.warn('[volt] could not open the chat this window was opened for', err);
		}
	}
}

// Before the window reports itself restored: from then on it can be shown for a chat.
registerWorkbenchContribution2(AgentWindowStartContribution.ID, AgentWindowStartContribution, WorkbenchPhase.BlockRestore);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.window',
	title: localize('voltWindow.configTitle', "Windows"),
	type: 'object',
	properties: {
		[KEEP_NEXT_WINDOW_READY_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltWindow.keepNextWindowReady', "Keeps the next window loaded out of sight, so New Window and Open in New Window show at once. Uses the memory of one more window."),
		},
	},
});
