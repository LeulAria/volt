/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltEvent } from '../../../../services/voltRuntime/common/events.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { isTerminalTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { harnessSubagentChatId } from '../../../../services/voltRuntime/common/orchestration/harnessSubagents.js';
import { IAgentOrchestratorService, IOrchTask } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { harnessTaskId } from '../../../../services/voltRuntime/common/orchestration/orchestratorDecider.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { agentMessagePlainText } from '../context/agentContextUsage.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { IAgentSessionControl } from '../editor/agentSessionController.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { prepareSubagentChat } from './agentTurnHost.js';

type MirrorEnd = 'done' | 'fail' | 'abort';

interface IMirror {
	readonly taskId: string;
	readonly chatId: string;
	readonly parentId: string;
	readonly runId: string;
	/** Fed by the parent's stream (`subagent.event`); otherwise by the task record's changes. */
	readonly native: boolean;
	/** Resolves once the chat is loaded and its turn began; events that arrive before wait in `pending`. */
	ready: Promise<void>;
	controller?: IAgentSessionControl;
	readonly pending: IVoltEvent[];
	seq: number;
	sawText: boolean;
	ended: boolean;
	/** Task-fed: the step last drawn, so the same activity is not drawn twice. */
	activity?: string;
	steps: number;
}

/**
 * Writes the read-only chats of a harness's own subagents (`harnessSubagentChatId`): Claude's or
 * Codex's native subagent sessions stream their steps into theirs as they work; any other is drawn
 * from what its task record knows (its brief, its steps, its report).
 *
 * It runs where the chats' transcripts live, next to the runtime whose stream it reads: the agent
 * server (the default), or the window when agents run in the window. A chat is only held while its
 * subagent works (the input lets go once its turn ends), so a finished subagent costs no memory.
 */
export class HarnessSubagentChats extends Disposable {

	/** Chats being written now, by task id. */
	private readonly mirrors = new Map<string, IMirror>();

	constructor(
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(runtime.onDidEmit(envelope => {
			const event = envelope.event;
			switch (event.type) {
				case 'subagent.spawned': {
					const taskId = harnessTaskId(event.childId);
					if (!this.mirrors.has(taskId)) {
						this.startNative(taskId, envelope.sessionId, event.title, event.prompt);
					}
					return;
				}
				case 'subagent.event': {
					const mirror = this.mirrors.get(harnessTaskId(event.childId));
					const inner = event.event;
					if (mirror?.native && inner.type !== 'run.start' && inner.type !== 'run.end') {
						if (inner.type === 'text.delta' && inner.delta) {
							mirror.sawText = true;
						}
						this.feed(mirror, inner);
					}
					return;
				}
				case 'subagent.completed': {
					const mirror = this.mirrors.get(harnessTaskId(event.childId));
					if (mirror) {
						const end: MirrorEnd = event.status === 'completed' ? 'done' : event.status === 'failed' ? 'fail' : 'abort';
						this.finish(mirror, end, end === 'fail' ? event.error ?? event.result : event.result);
					}
					return;
				}
				case 'run.end':
					// A harness subagent ends with the turn that runs it.
					for (const mirror of [...this.mirrors.values()]) {
						if (mirror.native && mirror.parentId === envelope.sessionId) {
							if (event.reason === 'fail') {
								this.finish(mirror, 'fail', localize('voltAgent.subagentChat.parentFailed', "The agent turn that ran this subagent ended with an error."));
							} else {
								this.finish(mirror, event.reason === 'abort' ? 'abort' : 'done');
							}
						}
					}
					return;
			}
		}));
		this._register(orchestrator.onDidChange(change => {
			for (const taskId of change.tasks) {
				const mirror = this.mirrors.get(taskId);
				if (mirror && !mirror.native) {
					this.followTask(mirror);
				}
			}
		}));
	}

	/** The chat of a harness task is being written now (a native subagent at work); resolves once it is set up. */
	whenWriting(taskId: string): Promise<void> | undefined {
		return this.mirrors.get(taskId)?.ready.catch(() => undefined);
	}

	/** The chat belongs to the parent's project, is named after the task, and is never listed in the sidebar. */
	prepare(chatId: string, parentId: string, title: string): void {
		prepareSubagentChat(this.history, this.sessionContext, this.workspace, chatId, parentId);
		if (this.history.get(chatId)?.title !== title) {
			this.history.open(chatId).setMeta({ title });
		}
	}

	/**
	 * A harness task's chat, opened for the first time (or recorded before Volt kept these chats):
	 * drawn from the task when it has no messages and nothing streams into it.
	 */
	async draw(taskId: string): Promise<void> {
		const task = this.orchestrator.getTask(taskId);
		if (!task || task.source !== 'harness' || task.childId) {
			return;
		}
		const writing = this.whenWriting(taskId);
		if (writing) {
			await writing;
			return;
		}
		const chatId = harnessSubagentChatId(task.id);
		this.prepare(chatId, task.parentId, task.title);
		const input = AgentEditorInput.acquire(chatId, this.instantiationService);
		await input.ensureLoaded();
		if (!input.messages.length && !this.mirrors.has(task.id)) {
			this.buildFromTask(input, task);
		}
	}

	private newMirror(taskId: string, parentId: string, native: boolean): IMirror {
		const mirror: IMirror = {
			taskId,
			chatId: harnessSubagentChatId(taskId),
			parentId,
			runId: `mirror-${taskId}`,
			native,
			ready: Promise.resolve(),
			pending: [],
			seq: 0,
			sawText: false,
			ended: false,
			steps: 0,
		};
		this.mirrors.set(taskId, mirror);
		return mirror;
	}

	/** A native subagent began: its chat starts now and streams its steps from the parent's run. */
	private startNative(taskId: string, parentId: string, title: string, prompt: string | undefined): void {
		const mirror = this.newMirror(taskId, parentId, true);
		mirror.ready = (async () => {
			this.prepare(mirror.chatId, parentId, title);
			const input = AgentEditorInput.acquire(mirror.chatId, this.instantiationService);
			await input.ensureLoaded();
			const controller = input.controller;
			if (!controller.applyMirroredEvent || input.messages.length) {
				// Another process owns the transcript, or this chat was written before: nothing to stream into.
				this.mirrors.delete(taskId);
				return;
			}
			controller.beginTurn({ turnId: mirror.runId, text: prompt?.trim() || title, mode: 'Agent', origin: 'brief' });
			controller.applyMirroredEvent(this.envelope(mirror, { type: 'run.start', runId: mirror.runId, mode: 'agent', ...this.modelOf(parentId) }));
			mirror.controller = controller;
			for (const event of mirror.pending.splice(0)) {
				this.feed(mirror, event);
			}
			if (mirror.ended) {
				this.mirrors.delete(taskId);
			}
		})().catch(err => {
			this.mirrors.delete(taskId);
			this.logService.warn('[volt subagents] could not start the chat of a harness subagent', err);
		});
	}

	/**
	 * A harness subagent with no stream of its own (Cursor's Task, or one that ran before Volt kept
	 * these chats): its brief, its steps as the task reports them, and its report or error.
	 */
	private buildFromTask(input: AgentEditorInput, task: IOrchTask): void {
		const controller = input.controller;
		if (!controller.applyMirroredEvent) {
			return;
		}
		const mirror = this.newMirror(task.id, task.parentId, false);
		const reply = controller.beginTurn({ turnId: mirror.runId, text: task.brief.trim() || task.title, mode: 'Agent', origin: 'brief' });
		if (task.startedAt !== undefined) {
			reply.startedAt = task.startedAt;
		}
		controller.applyMirroredEvent(this.envelope(mirror, { type: 'run.start', runId: mirror.runId, mode: 'agent', ...this.modelOf(task.parentId) }));
		mirror.controller = controller;
		this.followTask(mirror);
		if (mirror.ended && task.endedAt !== undefined && reply.startedAt !== undefined) {
			// Drawn after the fact: the reply keeps the task's own times, not the moment it was drawn.
			reply.endedAt = task.endedAt;
			reply.durationMs = Math.max(0, task.endedAt - reply.startedAt);
			input.recordAssistant(reply, true, task.state === 'completed' ? 'done' : task.state === 'failed' ? 'error' : 'cancelled', agentMessagePlainText(reply));
		}
	}

	/** A task-fed chat follows its task: a new step for each activity it reports, then its report. */
	private followTask(mirror: IMirror): void {
		const task = this.orchestrator.getTask(mirror.taskId);
		if (!task || mirror.ended) {
			return;
		}
		const activity = task.activity?.trim();
		if (activity && activity !== mirror.activity && !isTerminalTaskState(task.state)) {
			mirror.activity = activity;
			const callId = `${mirror.runId}-step-${++mirror.steps}`;
			this.feed(mirror, { type: 'tool.start', callId, name: 'Step', title: activity });
			this.feed(mirror, { type: 'tool.end', callId });
		}
		if (isTerminalTaskState(task.state)) {
			const end: MirrorEnd = task.state === 'completed' ? 'done' : task.state === 'failed' ? 'fail' : 'abort';
			this.finish(mirror, end, end === 'fail' ? task.error : task.result);
		}
	}

	private feed(mirror: IMirror, event: IVoltEvent): void {
		if (!mirror.controller) {
			mirror.pending.push(event);
			return;
		}
		mirror.controller.applyMirroredEvent?.(this.envelope(mirror, event));
	}

	/** Ends the chat's turn: the report (when its steps carried no text), or the error, then the end. */
	private finish(mirror: IMirror, end: MirrorEnd, text?: string): void {
		if (mirror.ended) {
			return;
		}
		mirror.ended = true;
		const body = text?.trim();
		if (end === 'fail' && body) {
			this.feed(mirror, { type: 'error', message: body });
		} else if (end === 'done' && body && !mirror.sawText) {
			this.feed(mirror, { type: 'text.delta', id: `${mirror.runId}-report`, delta: body });
		}
		this.feed(mirror, { type: 'run.end', runId: mirror.runId, reason: end });
		if (mirror.controller) {
			this.mirrors.delete(mirror.taskId);
		}
	}

	private envelope(mirror: IMirror, event: IVoltEvent) {
		return { seq: ++mirror.seq, runId: mirror.runId, sessionId: mirror.chatId, timestamp: Date.now(), event };
	}

	private modelOf(parentId: string): { providerRef?: string } {
		const ref = this.orchestrator.getThread(parentId)?.modelRef;
		return ref ? { providerRef: ref } : {};
	}
}
