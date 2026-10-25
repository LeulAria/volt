/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { threadStatus } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltProjectRecord, IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AGENT_DEFAULT_MODEL_SETTING } from '../../common/agentComposerSettings.js';
import { attachmentPathLines, IAgentDisplayMention } from '../composer/agentMentions.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { AgentHistoryCodec } from '../history/agentHistoryCodec.js';
import { stashTurnDisplay } from '../orchestration/agentTurnDisplays.js';
import { AgentScratchFolders } from '../workspace/agentScratchProject.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

export const IScratchAgentBridge = createDecorator<IScratchAgentBridge>('voltScratchAgentBridge');

export type ScratchRunState = 'starting' | 'running' | 'waiting' | 'queued' | 'done' | 'failed' | 'stopped' | 'idle';

export interface IScratchRunStatus {
	readonly state: ScratchRunState;
	readonly title: string;
	readonly modelLabel: string | undefined;
}

export interface IScratchAttachment {
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

export interface IScratchSendRequest {
	/** What the user asked. */
	readonly instruction: string;
	/** What the board says about the selection (text, diagram as Mermaid...). */
	readonly context: string;
	readonly attachments: readonly IScratchAttachment[];
	readonly modelRef: string | undefined;
	/** A project to run in; undefined starts the chat in a scratch folder. */
	readonly projectId: string | undefined;
	/** The board's other chats: without a project, this one joins their scratch folder (one project, a thread each). */
	readonly siblings?: readonly string[];
	readonly title: string;
}

/** Scratch's way into Volt's chats: start one with the selection, follow its state, open it. */
export interface IScratchAgentBridge {
	readonly _serviceBrand: undefined;
	/** A chat the board knows about changed state or title. */
	readonly onDidChange: Event<void>;
	defaultModelRef(projectId: string | undefined): string | undefined;
	modelLabel(ref: string | undefined): string | undefined;
	/** Starts a chat and sends at once. Resolves with its id. */
	send(request: IScratchSendRequest): Promise<string>;
	status(sessionId: string): IScratchRunStatus;
	/** The chat is still there (not deleted). */
	exists(sessionId: string): boolean;
	openChat(sessionId: string): Promise<void>;
}

class ScratchAgentBridge extends Disposable implements IScratchAgentBridge {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly fire = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 120));

	constructor(
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(orchestrator.onDidChange(() => this.fire.schedule()));
		this._register(history.onDidChange(() => this.fire.schedule()));
	}

	defaultModelRef(projectId: string | undefined): string | undefined {
		void projectId;
		const catalog = this.runtime.listCatalog().filter(item => item.enabled);
		const configured = this.configurationService.getValue<string>(AGENT_DEFAULT_MODEL_SETTING);
		if (configured && catalog.some(item => item.ref === configured)) {
			return configured;
		}
		const last = this.runtime.getActiveCatalogRef();
		return last && catalog.some(item => item.ref === last) ? last : undefined;
	}

	modelLabel(ref: string | undefined): string | undefined {
		return ref ? this.runtime.listCatalog().find(item => item.ref === ref)?.label : undefined;
	}

	/** Image mentions with a saved copy on disk, so tools can open the files too. */
	private async mentions(attachments: readonly IScratchAttachment[]): Promise<IAgentDisplayMention[]> {
		const out: IAgentDisplayMention[] = [];
		for (const attachment of attachments) {
			let path: string | undefined;
			try {
				const ref = await this.history.putAttachment(attachment.bytes, attachment.mime);
				path = this.history.attachmentResource(ref)?.fsPath;
			} catch (err) {
				this.logService.warn('[volt scratch] could not keep a copy of an attachment', err);
			}
			out.push({
				kind: 'image',
				label: attachment.name,
				image: { id: `image-${generateUuid()}`, mime: attachment.mime, bytes: attachment.bytes, name: attachment.name, ...(path ? { path } : {}) },
			});
		}
		return out;
	}

	private composeText(request: IScratchSendRequest, mentions: readonly IAgentDisplayMention[]): string {
		const parts = [request.instruction.trim()];
		if (request.context.trim()) {
			parts.push(`<scratch_board>\n${request.context.trim()}\n\nTo answer on the board itself (a diagram, sticky notes, a markdown card beside what I sent), call scratch_draw; to redraw a frame I sent, pass its frameId as replace. scratch_read shows the whole board.\n</scratch_board>`);
		}
		const lines = attachmentPathLines(mentions);
		if (lines.length) {
			parts.push(lines.join('\n'));
		}
		return parts.filter(Boolean).join('\n\n');
	}

	private async bindProject(threadId: string, request: IScratchSendRequest): Promise<IVoltProjectRecord | undefined> {
		const project = request.projectId ? this.sessionContext.getProject(request.projectId) : undefined;
		if (project) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, threadId, project);
			return project;
		}
		const folders = this.instantiationService.createInstance(AgentScratchFolders);
		// No project: the board's earlier chats already have a scratch folder; this chat is another thread in it.
		for (const sibling of [...request.siblings ?? []].reverse()) {
			const binding = this.sessionContext.bindingFor(sibling);
			const shared = binding && this.sessionContext.getProject(binding.projectId);
			if (shared?.scratch) {
				return folders.share(threadId, shared);
			}
		}
		// The board's first: a scratch folder of its own, like New Chat Without Project.
		return folders.bind(threadId, request.title || request.instruction);
	}

	async send(request: IScratchSendRequest): Promise<string> {
		const threadId = `agent-${generateUuid()}`;
		try {
			await this.start(threadId, request);
		} catch (err) {
			// Nothing was started: no empty chat is left behind.
			await this.history.delete(threadId).catch(() => undefined);
			throw err;
		}
		this.fire.schedule();
		return threadId;
	}

	private async start(threadId: string, request: IScratchSendRequest): Promise<void> {
		const bound = await this.bindProject(threadId, request);
		if (!bound) {
			throw new Error('There is no folder to run the chat in.');
		}
		const modelRef = request.modelRef ?? this.defaultModelRef(request.projectId);
		const modelLabel = this.modelLabel(modelRef);
		this.history.open(threadId).setMeta({ ...(modelLabel ? { model: modelLabel } : {}), mode: 'Agent' });
		await this.orchestrator.dispatch({ type: 'thread.upsert', threadId, title: request.title, ...(modelRef ? { modelRef, modelLabel } : {}) });
		// The request names the chat (its first message carries the board's context, which some agents title it after).
		if (request.title) {
			await this.history.rename(threadId, request.title);
		}
		const mentions = await this.mentions(request.attachments);
		const text = this.composeText(request, mentions);
		const turnId = generateUuid();
		const display = { text: request.instruction.trim() || request.title, mentions };
		stashTurnDisplay(turnId, display);
		const frozen = { text: display.text, mentions: await new AgentHistoryCodec(this.history).freezeMentions(mentions) };
		const result = await this.orchestrator.submit(threadId, {
			text,
			display: frozen,
			mode: 'Agent',
			...(modelRef ? { modelRef, options: this.runtime.getModelOptions(modelRef) } : {}),
		}, 'auto', turnId);
		if (result.outcome === 'rejected') {
			throw new Error(result.reason ?? 'The chat did not take the message.');
		}
	}

	status(sessionId: string): IScratchRunStatus {
		const meta = this.history.get(sessionId);
		const thread = this.orchestrator.getThread(sessionId);
		const title = meta?.title || thread?.title || '';
		const modelLabel = meta?.model || thread?.modelLabel;
		if (!thread && !meta) {
			return { state: 'starting', title, modelLabel };
		}
		const kind = thread ? threadStatus(this.orchestrator.getState(), sessionId).kind : undefined;
		let state: ScratchRunState;
		switch (kind) {
			case 'starting': state = 'starting'; break;
			case 'working': case 'stopping': case 'delegating': state = 'running'; break;
			case 'needsInput': case 'paused': case 'limited': state = 'waiting'; break;
			case 'queued': case 'blocked': case 'moving': state = 'queued'; break;
			case 'failed': state = 'failed'; break;
			case 'interrupted': state = 'stopped'; break;
			default: {
				const outcome = thread?.last?.outcome;
				if (outcome === 'failed') {
					state = 'failed';
				} else if (outcome === 'cancelled' || outcome === 'interrupted') {
					state = 'stopped';
				} else if (outcome === 'done' || meta?.status === 'done') {
					state = 'done';
				} else if (meta?.status === 'error') {
					state = 'failed';
				} else if (meta?.status === 'running') {
					state = 'running';
				} else if (meta?.status === 'cancelled' || meta?.status === 'interrupted') {
					state = 'stopped';
				} else {
					state = meta && meta.turnCount > 0 ? 'done' : 'idle';
				}
			}
		}
		return { state, title, modelLabel };
	}

	exists(sessionId: string): boolean {
		return !!this.history.get(sessionId) || !!this.orchestrator.getThread(sessionId);
	}

	async openChat(sessionId: string): Promise<void> {
		try {
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId);
		} catch (err) {
			this.logService.warn('[volt scratch] could not open the chat', err);
		}
	}
}

registerSingleton(IScratchAgentBridge, ScratchAgentBridge, InstantiationType.Delayed);
