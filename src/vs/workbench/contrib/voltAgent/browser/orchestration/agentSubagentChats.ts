/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { agentServerEnabled, IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { harnessSubagentChatId } from '../../../../services/voltRuntime/common/orchestration/harnessSubagents.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { openAgentPanel } from '../workspace/agentPanels.js';
import { revealAgentSideChat } from '../workspace/agentSurfaceHost.js';
import { HarnessSubagentChats } from './harnessSubagentChats.js';

export const IAgentSubagentChatService = createDecorator<IAgentSubagentChatService>('voltAgentSubagentChatService');

/**
 * Where a subagent's work can be watched. A Volt subagent runs in its own chat. A harness's own
 * subagent (Claude's or Codex's native subagent sessions, Cursor's Task) has none, so Volt keeps a
 * read-only one for it (`harnessSubagentChatId`), written by {@link HarnessSubagentChats} where the
 * transcripts live: the agent server, or this window when agents run in it.
 */
export interface IAgentSubagentChatService {
	readonly _serviceBrand: undefined;
	/** Opens a subagent's chat in its parent's right panel (or as a tab when that panel has no room). */
	open(parentSessionId: string, taskId: string): Promise<void>;
}

class AgentSubagentChatService extends Disposable implements IAgentSubagentChatService {

	declare readonly _serviceBrand: undefined;

	/** Writes the chats when agents run in this window; with the agent server, the server does. */
	private readonly writer: HarnessSubagentChats | undefined;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.writer = agentServerEnabled(configurationService) ? undefined : this._register(instantiationService.createInstance(HarnessSubagentChats));
	}

	async open(parentSessionId: string, taskId: string): Promise<void> {
		const task = this.orchestrator.getTask(taskId);
		if (!task) {
			return;
		}
		if (task.childId) {
			this.reveal(parentSessionId, task.childId);
			return;
		}
		if (task.source !== 'harness') {
			return;
		}
		const chatId = harnessSubagentChatId(task.id);
		if (!this.writer) {
			// The agent server writes the chat (it streams there while the subagent works); this
			// window shows it, and asks for one drawn from the task when nothing wrote it yet.
			await this.reveal(parentSessionId, chatId);
			const client = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentServerClientService));
			await client.call('subagents.draw', task.id).catch(err => this.logService.warn('[volt subagents] the agent server could not draw a subagent chat', err));
			return;
		}
		const writing = this.writer.whenWriting(task.id);
		if (writing) {
			// Opened while the chat is still being set up: the panel adopts it once it is loaded.
			await writing;
			this.reveal(parentSessionId, chatId);
			return;
		}
		this.writer.prepare(chatId, task.parentId, task.title);
		await this.reveal(parentSessionId, chatId);
		await this.writer.draw(task.id);
	}

	private reveal(parentSessionId: string, chatId: string): Promise<unknown> {
		const shown = revealAgentSideChat(parentSessionId, chatId);
		return shown ? Promise.resolve() : openAgentPanel(this.editorGroupsService, this.instantiationService, chatId);
	}
}

registerSingleton(IAgentSubagentChatService, AgentSubagentChatService, InstantiationType.Eager);
