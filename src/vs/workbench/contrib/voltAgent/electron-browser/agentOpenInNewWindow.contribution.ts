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
import { IVoltWindowScopesService, KEEP_NEXT_WINDOW_READY_SETTING } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { getLayoutMode, SET_AGENT_LAYOUT_MODE_COMMAND_ID } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, sessionBelongsToProject } from '../../../services/voltRuntime/common/sessionContext.js';
import { IVoltWindowScopeService } from '../../../services/voltWindowScope/common/voltWindowScope.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID } from '../browser/editor/agentEditorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** The project a chat runs in: its binding, else the project of its saved folder. Scratch chats have none. */
function chatProject(context: IVoltSessionContextService, session: IAgentSessionMeta): IVoltProjectRecord | undefined {
	const bound = context.bindingFor(session.id)?.projectId;
	const project = bound ? context.getProject(bound) : context.projects.find(candidate => sessionBelongsToProject(session, candidate));
	return project && !project.scratch ? project : undefined;
}

/**
 * Open in New Window on an agent tab. The main process holds the new window's scope ready: the
 * chat's project and every chat of it this window lists move there (this window hides them until
 * it closes), and the new window opens on the chat.
 */
registerAction2(class OpenAgentInNewWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID,
			title: localize2('voltAgent.openInNewWindow', "Open Chat in New Window"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		if (typeof sessionId !== 'string' || !sessionId) {
			return;
		}
		const history = accessor.get(IAgentHistoryService);
		const context = accessor.get(IVoltSessionContextService);
		const scopes = accessor.get(IVoltWindowScopesService);
		const nativeHostService = accessor.get(INativeHostService);
		const session = history.get(sessionId);
		if (!session) {
			return;
		}
		const project = chatProject(context, session);
		const sessions = project
			? history.list({ inWindow: true, includeArchived: true })
				.filter(meta => {
					const bound = context.bindingFor(meta.id)?.projectId;
					return bound ? bound === project.id : sessionBelongsToProject(meta, project);
				})
				.map(meta => meta.id)
			: [];
		await scopes.prepareWindow({
			openSession: sessionId,
			sessions: [sessionId, ...sessions.filter(id => id !== sessionId)],
			projects: project ? [project.id] : [],
			layoutMode: 'agent',
		});
		await nativeHostService.openWindow({ forceReuseWindow: false });
	}
});

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
