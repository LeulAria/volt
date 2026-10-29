/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IVoltWindowScopesService } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, sessionBelongsToProject } from '../../../services/voltRuntime/common/sessionContext.js';
import { IVoltWindowScopeService } from '../../../services/voltWindowScope/common/voltWindowScope.js';
import { OPEN_AGENT_COMMAND_ID, OPEN_AGENT_IN_NEW_WINDOW_COMMAND_ID } from '../browser/editor/agentEditorInput.js';

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

/** In a window opened for one chat: select its project and show it, once (not again on reload). */
class AgentWindowStartContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWindowStart';

	constructor(
		@IVoltWindowScopeService windowScope: IVoltWindowScopeService,
		@IVoltWindowScopesService scopes: IVoltWindowScopesService,
		@IVoltSessionContextService context: IVoltSessionContextService,
		@ICommandService commandService: ICommandService,
		@ILogService logService: ILogService,
	) {
		super();
		const scope = windowScope.scope;
		if (!scope) {
			return;
		}
		void scopes.takeWindowStart(scope).then(async sessionId => {
			if (!sessionId) {
				return;
			}
			const projectId = context.bindingFor(sessionId)?.projectId;
			if (projectId) {
				context.selectProject(projectId);
			}
			await commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId);
		}).catch(err => logService.warn('[volt] could not open the chat this window was opened for', err));
	}
}

registerWorkbenchContribution2(AgentWindowStartContribution.ID, AgentWindowStartContribution, WorkbenchPhase.AfterRestored);
