/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { normalizeVoltMode, VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { IAgentOrchestratorService, IOrchPrompt, IOrchStartTurnRequest } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import '../../../../services/voltRuntime/browser/orchestration/agentOrchestratorService.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSendRequest } from '../../../../services/voltRuntime/common/session.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AgentRunOn, AgentWorktreeTarget } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { imageAttachmentsFromMentions } from '../composer/agentMentions.js';
import type { IAgentPromptDisplay, IAgentUserMessage } from '../editor/agentEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentHistoryCodec } from '../history/agentHistoryCodec.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { takeTurnDisplay } from './agentTurnDisplays.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { scheduledRunOf } from '../schedules/agentScheduleCommands.js';
import { takePageContext } from '../visuals/agentVisualBridge.js';

const CHECKPOINT_BEGIN_TURN_COMMAND = 'voltAgent.checkpoint.beginTurn';

export { stashTurnDisplay } from './agentTurnDisplays.js';

/** Send options only the chat UI sets, carried by an orchestrator prompt as `host`. */
export interface IAgentPromptHostOptions {
	readonly runOn?: AgentRunOn;
	readonly worktreeTarget?: AgentWorktreeTarget;
}

/**
 * A prompt another chat's agent sent (thread_send), started (thread_launch) or forked into
 * (thread_fork), carried as `host`: the transcript shows it as that chat's message, not the user's.
 */
export interface IAgentThreadSourceHost {
	readonly fromThread: { readonly id: string; readonly title: string; readonly kind: 'message' | 'launch' | 'fork' };
}

export function threadSourceOf(host: unknown): IAgentThreadSourceHost['fromThread'] | undefined {
	const from = (host as Partial<IAgentThreadSourceHost> | undefined)?.fromThread;
	return from && typeof from.id === 'string' && typeof from.title === 'string' ? { id: from.id, title: from.title, kind: from.kind === 'launch' || from.kind === 'fork' ? from.kind : 'message' } : undefined;
}

/** The composer's mode labels; the runtime's modes are their lower-case forms. */
export function modeLabel(mode: string | undefined): string {
	const known: Record<VoltMode, string> = { agent: 'Agent', plan: 'Plan', ask: 'Ask', debug: 'Debug', multitask: 'Multitask' };
	return known[normalizeVoltMode(mode)];
}

/**
 * Starts the orchestrator's turns in the chats they belong to: builds the transcript messages
 * through the chat's session controller (a panel may or may not show it), takes the checkpoint,
 * and hands the prompt to the runtime.
 */
export class AgentTurnHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentTurnHost';

	private readonly codec: AgentHistoryCodec;

	constructor(
		@IAgentOrchestratorService orchestrator: IAgentOrchestratorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.codec = new AgentHistoryCodec(history);
		this._register(orchestrator.setTurnHost({
			startTurn: request => this.startTurn(request),
			steer: (threadId, prompt) => this.steer(threadId, prompt),
			prepareChild: (childId, parentId) => this.prepareChild(childId, parentId),
		}));
	}

	private async startTurn(request: IOrchStartTurnRequest): Promise<string | undefined> {
		const { threadId, turn, thread } = request;
		const input = AgentEditorInput.acquire(threadId, this.instantiationService);
		try {
			await input.ensureLoaded();
		} catch (err) {
			this.logService.warn('[volt orchestrator] could not load the chat before its turn', err);
		}
		if (!request.isCurrent()) {
			return undefined;
		}
		const display = takeTurnDisplay(turn.id) ?? await this.thawDisplay(turn.prompt.display);
		const mode = modeLabel(turn.prompt.mode ?? input.chosenMode ?? input.restoredMode);
		// A turn Volt continued after a restart reads as a system row, like a subagent report.
		const restarted = turn.kind === 'resume' && (turn.prompt.display as { notification?: unknown } | undefined)?.notification === true;
		// Another chat's agent wrote it: a message bubble marked with that chat, not a system row.
		const fromThread = threadSourceOf(turn.prompt.host);
		const origin: IAgentUserMessage['origin'] = fromThread ? undefined : turn.kind === 'notification' || restarted ? 'notification' : turn.kind === 'brief' ? 'brief' : undefined;
		const controller = input.controller;
		// The first turn after the chat changed models carries the handoff: the divider, and the brief the
		// previous model wrote for this one (the runtime recaps the conversation itself).
		const latest = thread.handoffs.at(-1);
		const handoff = latest && !input.messages.some(message => message.kind === 'user' && message.handoff?.at === latest.at) ? latest : undefined;
		const base = handoff?.brief
			? `[Volt] ${handoff.fromLabel ?? 'The previous model'} handed this conversation to you. Its brief:\n<handoff_brief>\n${handoff.brief}\n</handoff_brief>\n\n${turn.prompt.text}`
			: turn.prompt.text;
		// What the user set in the chat's interactive pages since the agent last read it.
		const pageState = takePageContext(threadId);
		const text = pageState ? `${base}\n\n${pageState}` : base;
		controller.beginTurn({
			turnId: turn.id,
			text,
			display: display ?? (text !== turn.prompt.text ? { text: turn.prompt.text } : undefined),
			mode,
			...(origin ? { origin } : {}),
			...(turn.taskIds ? { taskIds: turn.taskIds } : {}),
			...(handoff ? { handoff: { ...(handoff.fromLabel ? { fromLabel: handoff.fromLabel } : {}), toLabel: handoff.toLabel, at: handoff.at, by: handoff.by, ...(handoff.reason ? { reason: handoff.reason } : {}) } } : {}),
			...(scheduledRunOf(turn.prompt.host) ? { scheduled: { ...scheduledRunOf(turn.prompt.host)! } } : {}),
			...(fromThread ? { fromThread } : {}),
		});
		if (turn.kind === 'brief' && thread.title) {
			// A subagent's chat is named after its task, not after the framing its model reads.
			this.history.open(threadId).setMeta({ title: thread.title });
		}
		await this.beginCheckpoint(threadId, turn.id);
		if (!request.isCurrent()) {
			controller.endUnstartedTurn(turn.id, undefined);
			return undefined;
		}
		// An explicit model for prompts the user wrote; the chat's model for everything Volt sends.
		const ref = turn.prompt.modelRef ?? (turn.kind === 'prompt' && !handoff ? undefined : thread.modelRef);
		const host = (turn.prompt.host ?? {}) as IAgentPromptHostOptions;
		const images = imageAttachmentsFromMentions(display?.mentions);
		const send: IVoltSendRequest = {
			text,
			mode: normalizeVoltMode(mode),
			...(ref ? { providerRef: ref } : {}),
			...(turn.prompt.options ? { options: turn.prompt.options } : ref ? { options: this.runtime.getModelOptions(ref) } : {}),
			...(host.runOn ? { runOn: host.runOn } : {}),
			...(host.worktreeTarget ? { worktreeTarget: host.worktreeTarget } : {}),
			...(images.length ? { images } : {}),
		};
		try {
			const runId = await this.runtime.send(threadId, send);
			this.recordModel(threadId, ref);
			return runId;
		} catch (err) {
			controller.endUnstartedTurn(turn.id, err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/** The model a chat last ran on, for its sidebar row: written to its history when it changes. */
	private recordModel(threadId: string, ref: string | undefined): void {
		const effective = ref ?? this.runtime.getOrCreateSession(threadId).providerRef;
		const label = effective ? this.runtime.listCatalog().find(item => item.ref === effective)?.label : undefined;
		if (label && this.history.get(threadId)?.model !== label) {
			this.history.open(threadId).setMeta({ model: label });
		}
	}

	private async steer(threadId: string, prompt: IOrchPrompt): Promise<boolean> {
		if (!this.runtime.canSteer(threadId)) {
			return false;
		}
		const display = prompt.display as { text?: unknown } | undefined;
		const shown = typeof display?.text === 'string' && display.text.trim() ? display.text.trim() : prompt.text;
		if (!await this.runtime.steerAsync(threadId, prompt.text)) {
			return false;
		}
		AgentEditorInput.acquire(threadId, this.instantiationService).controller.recordSteer(shown);
		return true;
	}

	/** A subagent's chat lives in its parent's project and is listed under it. */
	private prepareChild(childId: string, parentId: string): void {
		this.history.pinSessionParent(childId, parentId, { subagent: true });
		if (this.sessionContext.bindingFor(childId)) {
			return;
		}
		const parent = this.workspace.get(parentId);
		const bound = this.sessionContext.bindingFor(parentId);
		let project = (bound ? this.sessionContext.getProject(bound.projectId) : undefined)
			?? (parent?.projectId ? this.sessionContext.getProject(parent.projectId) : undefined)
			?? this.sessionContext.activeProject;
		if (!project && parent?.root) {
			try {
				const root = URI.parse(parent.root);
				project = this.sessionContext.registerProject(root, basename(root));
			} catch {
				project = undefined;
			}
		}
		if (project) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, childId, project);
		}
	}

	private async thawDisplay(stored: unknown): Promise<IAgentPromptDisplay | undefined> {
		if (!stored || typeof stored !== 'object' || typeof (stored as { text?: unknown }).text !== 'string') {
			return undefined;
		}
		const raw = stored as { text: string; mentions?: unknown };
		const mentions = await this.codec.thawMentions(raw.mentions).catch(() => undefined);
		return { text: raw.text, ...(mentions?.length ? { mentions } : {}) };
	}

	/** Snapshots the files before a turn runs (bounded by the checkpoint service to about 2 s). */
	private async beginCheckpoint(sessionId: string, turnId: string): Promise<void> {
		if (!CommandsRegistry.getCommand(CHECKPOINT_BEGIN_TURN_COMMAND)) {
			return;
		}
		try {
			await this.commandService.executeCommand(CHECKPOINT_BEGIN_TURN_COMMAND, { sessionId, turnId });
		} catch (err) {
			// A missed snapshot only disables Restore for this turn; the run goes ahead.
			this.logService.warn('[volt orchestrator] checkpoint before turn failed', err);
		}
	}
}

registerWorkbenchContribution2(AgentTurnHostContribution.ID, AgentTurnHostContribution, WorkbenchPhase.AfterRestored);
