/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { hash } from '../../../../../base/common/hash.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { providerFamily } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { AgentWorktreeTarget, IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IAgentWorktreeSetupService } from '../../../../services/voltRuntime/common/git/worktreeSetupPlan.js';
import { AgentSessionStatus, IAgentHistoryService, IAgentSessionMeta, IAgentSessionTurn } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltExternalCaller, IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { normalizeVoltMode, VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { DEFAULT_ORCH_LIMITS, IAgentOrchestratorService, IOrchPrompt, IOrchThread } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { isTerminalTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import {
	agentMessagePrompt, branchSlug, clip, describeModelCatalog, describeThreadLine, forkPrompt, formatTurns, IThreadLineInfo, IThreadTurnText, isSettledStatus, MAX_LAUNCH_MODELS,
	matchCatalogModel, numberArg, parseBranchStatus, parseHandoffArgs, parseWorkspace, parseWorktreeList, sendModeArg, stringArg, stringList, THREAD_MESSAGE_CHARS, THREAD_READ_CHARS,
	THREAD_READ_MAX_CHARS, THREAD_REPLY_CHARS, THREAD_TOOLS, THREAD_WAIT_MS, threadIdArg, threadLink, ThreadWorkspace,
} from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { workspaceTargetLabel } from '../../../../services/voltRuntime/common/git/workspaceMove.js';
import { mergeBackNotice, MergeBackOutcome, turnsThroughId } from '../../../../services/voltRuntime/common/orchestration/chatForks.js';
import { threadStatus } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { IAgentRunGroupService } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { canonicalProjectRoot, IVoltProjectRecord, IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { AGENT_DEFAULT_MODEL_SETTING } from '../../common/agentComposerSettings.js';
import { externalCallerId, externalSpendWindow } from './agentExternalCaller.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { IAgentChatForkService, IAgentForkChatOptions, IAgentForkChatResult, IAgentMergeBackResult } from './agentChatFork.js';
import { IAgentThreadSourceHost, modeLabel, threadSourceOf } from './agentTurnHost.js';

/** Chats an agent may start (launch or fork) in one of its turns: a runaway loop stops here. */
const MAX_STARTS_PER_TURN = 8;
/** Messages an agent may send to other chats in one of its turns. */
const MAX_SENDS_PER_TURN = 24;
const CHILD_ID_PREFIX = 'agent-';
const SETUP_BLOCK = 'Setting up its worktree';

interface ICaller {
	readonly id: string;
	readonly title: string;
	readonly model?: string;
	readonly mode: VoltMode;
	readonly thread: IOrchThread | undefined;
	readonly subagent: boolean;
	/** An agent outside Volt (OAuth MCP): no chat of its own, so nothing defaults to "this chat". */
	readonly external?: IVoltExternalCaller;
}

/**
 * Serves the orchestration tools (`thread_*`, `queue_*`, `worktree_*`, `orchestrator_capabilities`)
 * on Volt's MCP server. Every action goes through the same seams the UI uses: the orchestrator for
 * turns and queues, the history for transcripts and the sidebar, the worktree service for checkouts.
 */
export class AgentThreadToolService extends Disposable implements IAgentChatForkService {

	declare readonly _serviceBrand: undefined;

	/** Starts and sends per caller turn (`<chat>:<turn>`), for the per-turn limits. */
	private readonly perTurn = new Map<string, { starts: number; sends: number }>();

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IAgentWorktreeSetupService private readonly worktreeSetup: IAgentWorktreeSetupService,
		@IAgentRunGroupService private readonly runGroups: IAgentRunGroupService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: THREAD_TOOLS,
			invoke: (name, args, call) => this.invoke(name, args, call),
		}));
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const external = call?.external;
		const callerId = !external && call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!callerId && !external) {
			return { error: `${name} only works from a Volt chat.` };
		}
		await Promise.all([this.orchestrator.whenReady, this.history.whenReady]);
		if (callerId) {
			await this.orchestrator.ensureThreadLoaded(callerId);
		}
		const caller = external ? this.externalCaller(external) : this.caller(callerId!);
		const token = call?.token ?? CancellationToken.None;
		try {
			switch (name) {
				case 'orchestrator_capabilities': return this.capabilities(caller);
				case 'thread_list': return this.list(caller, args);
				case 'thread_search': return this.search(caller, args);
				case 'thread_read': return await this.read(caller, args);
				case 'thread_send': return await this.send(caller, args, token);
				case 'thread_wait': return await this.waitTool(caller, args, token);
				case 'thread_interrupt': return await this.interrupt(caller, args);
				case 'thread_fork': return await this.fork(caller, args);
				case 'thread_merge_back': return await this.mergeBackTool(caller, args);
				case 'thread_launch': return await this.launch(caller, args);
				case 'thread_update': return await this.update(caller, args);
				case 'thread_configure': return await this.configure(caller, args);
				case 'queue_list': return await this.queueList(caller, args);
				case 'queue_edit': return await this.queueEdit(caller, args);
				case 'queue_cancel': return await this.queueCancel(caller, args);
				case 'queue_reorder': return await this.queueReorder(caller, args);
				case 'queue_send_now': return await this.queueSendNow(caller, args);
				case 'queue_resume': return await this.queueResume(caller, args);
				case 'worktree_status': return await this.worktreeStatus(caller, args);
				case 'worktree_list': return await this.worktreeList(caller, args);
				case 'worktree_handoff': return await this.worktreeHandoff(caller, args);
			}
		} catch (err) {
			this.logService.warn(`[volt threads] ${name} failed`, err);
			return { error: err instanceof Error ? err.message : String(err) };
		}
		return { error: `Unknown tool ${name}` };
	}

	//#region Lookups

	private caller(id: string): ICaller {
		const thread = this.orchestrator.getThread(id);
		const meta = this.history.get(id);
		const mode = normalizeVoltMode(thread?.active?.prompt.mode ?? meta?.mode);
		return {
			id,
			title: this.titleOf(id),
			model: thread?.modelLabel ?? meta?.model,
			mode,
			thread,
			subagent: !!thread?.taskId || !!meta?.subagent,
		};
	}

	private externalCaller(external: IVoltExternalCaller): ICaller {
		return { id: externalCallerId(external.clientId), title: external.name, mode: 'agent', thread: undefined, subagent: false, external };
	}

	/** Where a prompt came from, for the pill above it ("Started by Claude Code · external"). */
	private sourceOf(caller: ICaller, kind: IAgentThreadSourceHost['fromThread']['kind']): IAgentThreadSourceHost {
		return { fromThread: { id: caller.id, title: caller.title, kind, ...(caller.external ? { external: true } : {}) } };
	}

	/** The model a chat an outside agent starts gets when it names none: the user's default for new chats. */
	private defaultModel(caller: ICaller): { readonly ref: string; readonly label: string } | undefined {
		if (!caller.external) {
			return this.modelOf(caller.id);
		}
		const ref = this.configurationService.getValue<string>(AGENT_DEFAULT_MODEL_SETTING);
		const item = ref ? this.runtime.listCatalog().find(candidate => candidate.ref === ref && candidate.enabled) : undefined;
		return item ? { ref: item.ref, label: item.label } : undefined;
	}

	private titleOf(id: string): string {
		return this.history.get(id)?.title || this.orchestrator.getThread(id)?.title || 'Untitled chat';
	}

	/** `thread_id`, or the caller when omitted (and `allowSelf`). Throws for an unknown chat. */
	private async target(caller: ICaller, value: unknown, options: { readonly allowSelf: boolean; readonly required?: boolean }): Promise<string> {
		const id = threadIdArg(value);
		if (!id) {
			if (options.required || !options.allowSelf || caller.external) {
				throw new Error('Pass thread_id: a chat id from thread_list.');
			}
			return caller.id;
		}
		if (id === caller.id && !options.allowSelf) {
			throw new Error('That is this chat. These tools act on other chats.');
		}
		if (id !== caller.id && !this.history.get(id) && !this.history.has(id) && !this.orchestrator.getThread(id)) {
			throw new Error(`No chat ${id}. thread_list and thread_search show chat ids.`);
		}
		await this.orchestrator.ensureThreadLoaded(id);
		return id;
	}

	private lineInfo(id: string, caller: ICaller, meta = this.history.get(id)): IThreadLineInfo {
		const thread = this.orchestrator.getThread(id);
		const status = threadStatus(this.orchestrator.getState(), id);
		// A chat this window's orchestrator has not loaded is not running here.
		const kind = thread ? status.kind : meta?.attention ? 'needsInput' : meta?.status === 'error' ? 'failed' : meta?.status === 'interrupted' ? 'interrupted' : 'idle';
		return {
			id,
			title: meta?.title || thread?.title || 'Untitled chat',
			status: kind,
			model: thread?.modelLabel ?? meta?.model,
			mode: meta?.mode,
			branch: meta?.worktreeBranch,
			updatedAt: Math.max(meta?.updatedAt ?? 0, meta?.lastPromptAt ?? 0) || thread?.createdAt,
			queued: status.queued,
			subagents: status.running,
			subagent: !!meta?.subagent || !!thread?.taskId,
			archived: meta?.archived,
			self: id === caller.id,
			error: kind === 'failed' ? thread?.last?.error : undefined,
		};
	}

	private projectOf(threadId: string): IVoltProjectRecord | undefined {
		const bound = this.sessionContext.bindingFor(threadId);
		const project = bound ? this.sessionContext.getProject(bound.projectId) : undefined;
		if (project) {
			return project;
		}
		const workspaceId = this.history.get(threadId)?.workspaceId;
		return (workspaceId ? this.sessionContext.getProject(workspaceId) : undefined) ?? this.sessionContext.activeProject;
	}

	/** `"this"`, `"all"` or a folder path. `undefined` means every project. */
	private projectArg(caller: ICaller, value: unknown): IVoltProjectRecord | undefined | 'all' {
		const raw = stringArg(value, 1000);
		if (raw === 'all') {
			return 'all';
		}
		if (!raw || raw === 'this') {
			return this.projectOf(caller.id);
		}
		const root = canonicalProjectRoot(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? URI.parse(raw) : URI.file(raw));
		const known = [...this.sessionContext.projects].find(project => canonicalProjectRoot(project.root).toString() === root.toString());
		if (known) {
			return known;
		}
		throw new Error(`No Volt project at ${raw}. Pass "this", "all", or the folder of a project the user opened.`);
	}

	private resolveModel(value: unknown): { readonly ref: string; readonly label: string; readonly providerId: string } | undefined {
		const raw = stringArg(value, 200);
		if (!raw) {
			return undefined;
		}
		const match = matchCatalogModel(this.runtime.listCatalog(), raw);
		if (!match) {
			throw new Error(`No connected model matches "${raw}". orchestrator_capabilities lists the exact values.`);
		}
		return { ref: match.ref, label: match.label, providerId: match.providerId };
	}

	private modelOf(threadId: string): { readonly ref: string; readonly label: string } | undefined {
		const thread = this.orchestrator.getThread(threadId);
		const ref = thread?.modelRef ?? this.runtime.getOrCreateSession(threadId).providerRef;
		if (!ref) {
			return undefined;
		}
		return { ref, label: thread?.modelLabel ?? this.runtime.listCatalog().find(item => item.ref === ref)?.label ?? ref };
	}

	/** Counts a start or a send against the caller's current turn; throws past the limit. */
	private spend(caller: ICaller, kind: 'starts' | 'sends', count = 1): void {
		// An outside agent has no turns: its limits count per ten minutes.
		const key = `${caller.id}:${caller.external ? externalSpendWindow(Date.now()) : caller.thread?.active?.id ?? 'idle'}`;
		const used = this.perTurn.get(key) ?? { starts: 0, sends: 0 };
		const limit = kind === 'starts' ? MAX_STARTS_PER_TURN : MAX_SENDS_PER_TURN;
		if (used[kind] + count > limit) {
			if (caller.external) {
				throw new Error(`You already ${kind === 'starts' ? `started ${used.starts} chats` : `sent ${used.sends} messages`} in the last few minutes; the limit is ${limit} per 10 minutes. Wait, or ask the user.`);
			}
			throw new Error(kind === 'starts'
				? `This turn already started ${used.starts} chats; the limit is ${MAX_STARTS_PER_TURN} per turn. Ask the user before starting more.`
				: `This turn already sent ${used.sends} messages to other chats; the limit is ${MAX_SENDS_PER_TURN} per turn.`);
		}
		this.perTurn.set(key, { ...used, [kind]: used[kind] + count });
		if (this.perTurn.size > 200) {
			this.perTurn.delete(this.perTurn.keys().next().value!);
		}
	}

	private refuseSubagent(caller: ICaller, what: string): void {
		if (caller.subagent) {
			throw new Error(`A subagent cannot ${what}. Put what you found in your report; the chat that delegated to you decides.`);
		}
	}

	/** Read-only chats start read-only chats. */
	private launchMode(caller: ICaller, requested: unknown): VoltMode {
		const wanted = typeof requested === 'string' && requested.trim() ? normalizeVoltMode(requested) : 'agent';
		const readOnly = caller.mode === 'ask' || caller.mode === 'plan';
		return readOnly && wanted !== 'ask' && wanted !== 'plan' ? caller.mode : wanted;
	}

	private open(threadId: string): void {
		void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId).then(undefined, err => this.logService.warn('[volt threads] could not open a chat', err));
	}

	//#endregion

	//#region Capabilities, list, search, read

	private capabilities(caller: ICaller): IVoltHostToolResult {
		const project = this.projectOf(caller.id);
		const meta = caller.external ? undefined : this.history.get(caller.id);
		const current = this.defaultModel(caller);
		const models = this.runtime.listCatalog().filter(item => item.enabled);
		const head = caller.external ? [
			'## You',
			`An outside agent ("${caller.title}") connected over OAuth with scopes: ${caller.external.scopes.join(' ')}. You are not a Volt chat: pass thread_id to every tool. Chats you start or message show "${caller.title} · external" to the user.`,
			`Project new chats start in: ${project ? `${project.displayName} (${project.root.fsPath})` : 'none open'}; default model: ${current?.label ?? 'the one the user picked last'}.`,
		] : [
			'## This chat',
			`${threadLink(caller.id, caller.title)} · id ${caller.id} · ${current?.label ?? 'default model'} · ${caller.mode} mode${caller.subagent ? ' · a subagent (it reports to the chat that delegated to it; it cannot start top-level chats)' : ''}`,
			`Project: ${project ? `${project.displayName} (${project.root.fsPath})` : 'none'} · checkout: ${meta?.worktreePath ? `worktree ${meta.worktreeBranch ?? ''} at ${meta.worktreePath}` : 'the project\'s main checkout'}`,
		];
		const lines = [
			...head,
			'',
			'## Models',
			'Pass `model` as provider:id (e.g. claude-code:claude-opus-5-5), a full ref, or a label. Agent harnesses run their own tools; model APIs run in Volt\'s loop.',
			...(models.length ? describeModelCatalog(models, current?.ref) : ['- none connected']),
			'',
			'## Limits',
			`- Subagents: ${DEFAULT_ORCH_LIMITS.runningPerParent} at once per chat (${DEFAULT_ORCH_LIMITS.runningTotal} across Volt), nested ${DEFAULT_ORCH_LIMITS.maxDepth} deep; more wait their turn.`,
			`- A chat answers at most ${DEFAULT_ORCH_LIMITS.maxWakeups} automatic turns in a row (agent messages, subagent reports, pull request updates), then waits for the user.`,
			`- Per turn of yours: ${MAX_STARTS_PER_TURN} new chats (launch, fork) and ${MAX_SENDS_PER_TURN} messages to other chats. Waits return after ${THREAD_WAIT_MS / 1000} s; call again to keep waiting.`,
			'',
			'## Which tool',
			'- A piece of work whose result you need back: delegate_task (any model; `models` runs the same brief on several, e.g. independent reviews). Its report arrives as a message; end your turn instead of polling.',
			'- Independent top-level work the user follows on its own (a separate PR, a stack layer): thread_launch, with workspace {type:"worktree", base_ref, branch} so it gets its own checkout. `models` compares models on the same task.',
			'- Another direction, or another model, from this conversation: thread_fork (at_turn, model, workspace "worktree", message).',
			'- Talk to a chat that already exists: thread_send (wait=true returns its reply); thread_read to read it; thread_wait to wait for several.',
			'- Steer what a chat does next: queue_list / queue_edit / queue_reorder / queue_cancel / queue_send_now; thread_interrupt to stop it; thread_configure to move it to another model.',
			'- Pull requests: link_pull_request / watch_pull_request take thread_id to act for a chat you launched; a watch wakes that chat when checks fail or pass, a review comes in, or the branch conflicts.',
			'- Recurring work: schedule_task. Visual answers: render_chart (data) and html_render (pages).',
			'Mention chats as their markdown link so the user can open them.',
		];
		return { text: lines.join('\n') };
	}

	private list(caller: ICaller, args: Record<string, unknown>): IVoltHostToolResult {
		const project = this.projectArg(caller, args.project);
		const includeSubagents = args.include_subagents === true;
		const statuses = new Set(stringList(args.status, 12));
		const query = stringArg(args.query, 200)?.toLowerCase();
		const limit = numberArg(args.limit, 1, 100) ?? 30;
		const cursor = numberArg(args.cursor, 0, 100_000) ?? 0;
		const metas = this.history.list({
			includeArchived: args.include_archived === true,
			...(project && project !== 'all' ? { workspaceId: project.id } : {}),
		});
		const now = Date.now();
		const lines: IThreadLineInfo[] = [];
		for (const meta of metas) {
			if ((meta.subagent && !includeSubagents) || (query && !meta.title.toLowerCase().includes(query))) {
				continue;
			}
			const info = this.lineInfo(meta.id, caller, meta);
			if (statuses.size && !statuses.has(info.status)) {
				continue;
			}
			lines.push(project === 'all' ? { ...info, project: meta.workspaceLabel } : info);
		}
		const page = lines.slice(cursor, cursor + limit);
		const next = cursor + limit < lines.length ? cursor + limit : undefined;
		const scope = project === 'all' ? 'every project' : project ? `project ${project.displayName}` : 'every project';
		return {
			text: [
				`${lines.length} chat${lines.length === 1 ? '' : 's'} in ${scope}${lines.length > page.length ? ` (showing ${cursor + 1}-${cursor + page.length})` : ''}:`,
				...page.map(info => describeThreadLine(info, now)),
				...(next !== undefined ? [`nextCursor: ${next}`] : []),
			].join('\n'),
		};
	}

	private search(caller: ICaller, args: Record<string, unknown>): IVoltHostToolResult {
		const query = stringArg(args.query, 200);
		if (!query) {
			return { error: 'Pass a `query`.' };
		}
		const project = this.projectArg(caller, args.project);
		const limit = numberArg(args.limit, 1, 50) ?? 20;
		const matches = this.history.search(query, { ...(project && project !== 'all' ? { workspaceId: project.id } : {}), limit: limit * 2 })
			.filter(meta => !meta.subagent)
			.slice(0, limit);
		const now = Date.now();
		if (!matches.length) {
			return { text: `No chats match "${query}".` };
		}
		return {
			text: [
				`${matches.length} match${matches.length === 1 ? '' : 'es'}:`,
				...matches.map(meta => `${describeThreadLine(this.lineInfo(meta.id, caller, meta), now)}${meta.summary ? `\n  ${clip(meta.summary, 200)}` : meta.preview ? `\n  first prompt: ${clip(meta.preview, 200)}` : ''}`),
			].join('\n'),
		};
	}

	private async read(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: true });
		const turns = await this.turnsOf(id);
		const maxChars = numberArg(args.max_chars, 200, THREAD_READ_MAX_CHARS) ?? THREAD_READ_CHARS;
		const page = formatTurns(turns, {
			...(numberArg(args.after, 0, 100_000) !== undefined ? { after: numberArg(args.after, 0, 100_000) } : {}),
			...(numberArg(args.turn, 1, 100_000) !== undefined ? { turn: numberArg(args.turn, 1, 100_000) } : {}),
			limit: numberArg(args.limit, 1, 50) ?? 10,
			maxChars,
		});
		return { text: [...this.stateLines(id, caller), '', page.text].join('\n') };
	}

	/** A chat's state as the head of a read: status, model, checkout, queue, subagents. */
	private stateLines(id: string, caller: ICaller): string[] {
		const meta = this.history.get(id);
		const thread = this.orchestrator.getThread(id);
		const info = this.lineInfo(id, caller, meta);
		const lines = [describeThreadLine(info, Date.now()).slice(2)];
		const project = this.projectOf(id);
		lines.push(`Checkout: ${meta?.worktreePath ? `worktree ${meta.worktreeBranch ?? ''} at ${meta.worktreePath}` : project ? `${project.root.fsPath} (main checkout)` : 'none'}`);
		if (thread?.queue.length) {
			lines.push(`Queue (${thread.queue.length}${thread.pause ? `, paused: ${thread.pause}` : ''}): ${thread.queue.map(item => `${item.id} "${clip(promptPreview(item.prompt), 60)}"`).join('; ')}`);
		}
		const tasks = this.orchestrator.tasksOf(id).filter(task => !isTerminalTaskState(task.state));
		if (tasks.length) {
			lines.push(`Subagents running: ${tasks.map(task => `${task.id} "${task.title}" (${task.state}${task.activity ? `: ${task.activity}` : ''})`).join('; ')}`);
		}
		if (thread?.inputs.length) {
			lines.push(`Waiting for the user: ${thread.inputs.map(input => input.kind).join(', ')} (only the user can answer, in that chat).`);
		}
		return lines;
	}

	private async turnsOf(id: string): Promise<IThreadTurnText[]> {
		let turns: readonly IAgentSessionTurn[] = [];
		try {
			turns = (await this.history.open(id).load()).turns;
		} catch (err) {
			this.logService.warn('[volt threads] could not read a chat', err);
		}
		return turns.map(turn => {
			const message = turn.user.message as { text?: unknown; origin?: unknown; fromThread?: { title?: unknown; kind?: unknown } } | undefined;
			const shown = typeof message?.text === 'string' && message.text.trim() ? message.text : turn.user.text;
			const source = message?.fromThread && typeof message.fromThread.title === 'string' ? message.fromThread : undefined;
			const from = source ? `${source.kind === 'launch' ? 'task from' : source.kind === 'fork' ? 'fork message from' : 'message from'} chat "${source.title}"` : undefined;
			const origin = from ?? (message?.origin === 'notification' ? 'Volt notification' : message?.origin === 'brief' ? 'task brief' : undefined);
			return {
				user: shown,
				at: turn.user.at,
				...(turn.assistant ? { reply: turn.assistant.text, status: statusWord(turn.assistant.status, turn.assistant.final) } : {}),
				...(origin ? { origin } : {}),
			};
		});
	}

	/** The newest reply of a chat, from the live session (what the model said last). */
	private lastReply(id: string): string | undefined {
		const last = this.runtime.getOrCreateSession(id).messages.at(-1);
		return last?.role === 'assistant' && last.content.trim() ? last.content : undefined;
	}

	//#endregion

	//#region Send, wait, interrupt

	private async send(caller: ICaller, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: false, required: true });
		const message = typeof args.message === 'string' ? args.message.trim() : '';
		if (!message) {
			return { error: 'Pass a `message`.' };
		}
		if (message.length > THREAD_MESSAGE_CHARS) {
			return { error: `The message is ${message.length.toLocaleString('en-US')} characters; the limit is ${THREAD_MESSAGE_CHARS.toLocaleString('en-US')}. Point to files instead of pasting them.` };
		}
		const thread = this.orchestrator.getThread(id);
		const task = thread?.taskId ? this.orchestrator.getTask(thread.taskId) : undefined;
		if (task) {
			return { error: `That chat runs delegated task ${task.id}. Use message_task with task_id ${task.id} for a follow-up, or delegate_task with previous_task_id for a new round.` };
		}
		this.spend(caller, 'sends');
		const mode = sendModeArg(args.mode);
		const key = stringArg(args.client_request_id, 200);
		const turnId = key ? `msg-${hash(`${caller.id}\0${id}\0${key}`).toString(36)}` : `msg-${generateUuid()}`;
		const host = this.sourceOf(caller, 'message');
		const prompt: IOrchPrompt = {
			text: agentMessagePrompt({ id: caller.id, title: caller.title, model: caller.model, ...(caller.external ? { external: true } : {}) }, message),
			display: { text: message },
			host,
		};
		const active = thread?.active;
		const steerable = !!active && active.phase === 'running' && (!!active.steerable || this.runtime.canSteer(id));
		let delivery: string;
		if (mode === 'steer' || (mode === 'auto' && steerable)) {
			if (!steerable) {
				const status = threadStatus(this.orchestrator.getState(), id).kind;
				return { error: `"${this.titleOf(id)}" is not running a turn that takes messages now (it is ${status}). Use mode "queue" to send it after its turn, or "interrupt" to stop the turn and send it now.` };
			}
			const result = await this.orchestrator.submit(id, prompt, 'now', turnId);
			if (result.outcome === 'rejected') {
				return { error: result.reason ?? 'The chat refused the message.' };
			}
			delivery = result.outcome === 'steered' ? 'steered into its running turn' : result.outcome === 'duplicate' ? 'already sent (same client_request_id)' : 'queued to run next';
		} else {
			const result = await this.orchestrator.notify(id, prompt, turnId, mode === 'interrupt' ? { interrupt: true } : undefined);
			if (result.outcome === 'rejected') {
				return { error: `Not sent: ${result.reason ?? 'the chat refused it.'}` };
			}
			delivery = result.outcome === 'started' ? 'started a turn'
				: result.outcome === 'duplicate' ? 'already sent (same client_request_id)'
					: mode === 'interrupt' ? 'its running turn is being stopped; this message runs next'
						: 'queued behind its current turn';
		}
		const lines = [`Sent to ${threadLink(id, this.titleOf(id))}: ${delivery}.`];
		if (args.wait === true) {
			await this.waitFor([id], false, THREAD_WAIT_MS, token, turnId);
			lines.push(...this.waitReport([id], caller));
		} else {
			lines.push('Its reply does not come back on its own: call thread_wait or thread_read later (or pass wait=true next time).');
		}
		return { text: lines.join('\n') };
	}

	private async waitTool(caller: ICaller, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
		const raw = [...stringList(args.thread_ids, 20), ...(threadIdArg(args.thread_id) ? [threadIdArg(args.thread_id)!] : [])];
		if (!raw.length) {
			return { error: 'Pass thread_ids (or thread_id).' };
		}
		const ids: string[] = [];
		for (const value of new Set(raw)) {
			ids.push(await this.target(caller, value, { allowSelf: false, required: true }));
		}
		const ms = (numberArg(args.timeout_s, 1, THREAD_WAIT_MS / 1000) ?? THREAD_WAIT_MS / 1000) * 1000;
		await this.waitFor(ids, args.any === true, ms, token);
		return { text: this.waitReport(ids, caller).join('\n') };
	}

	/**
	 * Resolves when every chat (or one, with `any`) settled, or after `ms`. With `turnId`, a chat
	 * settles only once that turn ran (a message queued behind other work).
	 */
	private async waitFor(ids: readonly string[], any: boolean, ms: number, token: CancellationToken, turnId?: string): Promise<void> {
		const settled = (id: string) => {
			const thread = this.orchestrator.getThread(id);
			if (turnId && thread && (thread.active?.id === turnId || thread.queue.some(item => item.id === turnId)) && !thread.inputs.length) {
				return false;
			}
			return isSettledStatus(threadStatus(this.orchestrator.getState(), id).kind);
		};
		const done = () => any ? ids.some(settled) : ids.every(settled);
		if (done()) {
			return;
		}
		await new Promise<void>(resolve => {
			const finish = () => {
				listener.dispose();
				cancel.dispose();
				clearTimeout(timer);
				resolve();
			};
			const listener = this.orchestrator.onDidChange(change => {
				if (change.threads.some(id => ids.includes(id)) && done()) {
					finish();
				}
			});
			const cancel = token.onCancellationRequested(finish);
			const timer = setTimeout(finish, ms);
		});
	}

	private waitReport(ids: readonly string[], caller: ICaller): string[] {
		const now = Date.now();
		const lines: string[] = [];
		const still: string[] = [];
		for (const id of ids) {
			const info = this.lineInfo(id, caller);
			lines.push(describeThreadLine(info, now));
			if (!isSettledStatus(info.status)) {
				still.push(id);
				continue;
			}
			if (info.status === 'needsInput') {
				lines.push('  It waits for the user (an approval or a question in that chat); only the user can answer it.');
				continue;
			}
			const reply = this.lastReply(id);
			lines.push(reply ? `  Reply:\n${indent(clip(reply, ids.length > 1 ? Math.floor(THREAD_REPLY_CHARS / ids.length) : THREAD_REPLY_CHARS))}` : '  (no reply text)');
		}
		if (still.length) {
			lines.push(`Still working: ${still.join(', ')}. The wait only bounds this call; they keep going. Call thread_wait again, or do other work and check back.`);
		}
		return lines;
	}

	private async interrupt(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: false, required: true });
		const thread = this.orchestrator.getThread(id);
		if (!thread?.active) {
			return { text: `${threadLink(id, this.titleOf(id))} is not running a turn (${threadStatus(this.orchestrator.getState(), id).kind}); nothing to stop.` };
		}
		// Not orchestrator.cancel: that is the user's Stop, which also ends the chat's pull request watches.
		await this.orchestrator.dispatch({ type: 'turn.cancel', threadId: id, ...(args.subagents === true ? { cascade: 'turn' as const } : {}), ...(stringArg(args.reason, 500) ? { reason: stringArg(args.reason, 500) } : {}) });
		return { text: `Stopping the running turn of ${threadLink(id, this.titleOf(id))}.${thread.queue.length ? ` Its ${thread.queue.length} queued message(s) run next unless you cancel them (queue_cancel).` : ''}` };
	}

	//#endregion

	//#region Fork and launch

	private async fork(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		this.refuseSubagent(caller, 'fork chats');
		const sourceId = await this.target(caller, args.thread_id, { allowSelf: true });
		const { finished } = await this.finishedTurns(sourceId);
		const at = numberArg(args.at_turn, 1, Math.max(1, finished.length)) ?? finished.length;
		if (!finished.slice(0, at).length) {
			return { error: 'That chat has no finished turn to fork from yet.' };
		}
		const workspace = stringArg(args.workspace, 20) ?? 'same';
		if (workspace !== 'same' && workspace !== 'worktree') {
			return { error: 'workspace is "same" or "worktree".' };
		}
		this.spend(caller, 'starts');
		const title = stringArg(args.title, 120);
		const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : undefined;
		const fork = await this.forkChat(sourceId, {
			atTurns: at,
			...(title ? { title } : {}),
			model: this.resolveModel(args.model),
			workspace,
			message,
			open: args.open === true,
			from: { id: caller.id, title: caller.title, kind: 'fork', ...(caller.external ? { external: true } : {}) },
		});
		if (fork.refused) {
			return { error: `Forked, but the message was refused: ${fork.refused}` };
		}
		return {
			text: [
				`Forked ${threadLink(fork.sourceId, fork.sourceTitle)} at turn ${fork.forkedAtTurns} of ${fork.totalTurns} into ${threadLink(fork.forkId, fork.title)} (id ${fork.forkId})${fork.model ? ` on ${fork.model}` : ''}.`,
				workspace === 'worktree' ? `It works in its own worktree on branch ${fork.branch}; its setup runs before its first turn.` : fork.branch ? `It shares the source's worktree (branch ${fork.branch}): both chats edit the same files.` : 'It works in the project\'s main checkout.',
				message ? 'Your message was sent; follow it with thread_wait or thread_read.' : 'It is idle until someone sends it a message (thread_send).',
			].join('\n'),
		};
	}

	private async mergeBackTool(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		this.refuseSubagent(caller, 'merge chats back');
		const forkId = await this.target(caller, args.thread_id, { allowSelf: true });
		this.spend(caller, 'sends');
		const result = await this.mergeBack(forkId, { apply: args.apply === true });
		const { outcome } = result;
		const state = outcome.kind === 'merged' ? `merged as commit ${outcome.commit}`
			: outcome.kind === 'failed' ? `not merged: ${outcome.reason}`
				: outcome.kind;
		return { text: `Told ${threadLink(result.parentId, result.parentTitle)} about this fork (${state}).` };
	}

	async forkChat(sourceId: string, options: IAgentForkChatOptions): Promise<IAgentForkChatResult> {
		const { all, finished } = await this.finishedTurns(sourceId);
		const at = options.throughTurnId !== undefined
			? turnsThroughId(finished.map(turn => turn.id), options.throughTurnId)
			: Math.min(options.atTurns ?? finished.length, finished.length);
		const turns = finished.slice(0, at);
		if (!turns.length) {
			throw new Error('That chat has no finished turn to fork from yet.');
		}
		const sourceTitle = this.titleOf(sourceId);
		const model = options.model ?? this.modelOf(sourceId);
		const title = options.title ?? `${sourceTitle} · fork`;
		const forkId = `${CHILD_ID_PREFIX}${generateUuid()}`;
		const project = this.projectOf(sourceId);
		if (project) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, forkId, project);
		}
		const handle = this.history.open(forkId);
		for (const turn of turns) {
			handle.appendUser(turn.id, turn.user.text, turn.user.message);
			if (turn.assistant) {
				handle.appendAssistant({
					turn: turn.id,
					final: true,
					status: turn.assistant.status === 'running' ? 'interrupted' : turn.assistant.status,
					text: turn.assistant.text,
					...(turn.assistant.summary ? { summary: turn.assistant.summary } : {}),
					message: turn.assistant.message,
				});
			}
		}
		const sourceMeta = this.history.get(sourceId);
		const mode = options.mode ?? sourceMeta?.mode;
		// The checkout as it is now: its commits, not uncommitted edits. Merging back diffs from here.
		const base = await this.headOf(sourceMeta?.worktreePath ?? project?.root.fsPath);
		handle.setMeta({
			title,
			...(model ? { model: model.label } : {}),
			...(mode ? { mode } : {}),
			forkOf: { id: sourceId, title: sourceTitle, turns: turns.length, ...(base ? { base } : {}) },
		});
		await handle.flush();
		await this.history.rename(forkId, title);
		// The fork's first prompt carries the copied conversation to its agent as a recap.
		this.runtime.seedSession(forkId, turns.flatMap(turn => [
			{ role: 'user' as const, content: turn.user.text },
			...(turn.assistant?.text ? [{ role: 'assistant' as const, content: turn.assistant.text }] : []),
		]));
		await this.orchestrator.dispatch({ type: 'thread.upsert', threadId: forkId, title, ...(model ? { modelRef: model.ref, modelLabel: model.label } : {}) });
		let branch: string | undefined;
		if (options.workspace === 'worktree') {
			const root = project?.root.fsPath;
			if (!root) {
				throw new Error('The chat has no project folder to make a worktree from.');
			}
			const created = await this.createWorktree(forkId, root, { kind: 'new', name: `volt/${branchSlug(title)}-${forkId.slice(-4)}`, ...(base ? { from: base } : {}) });
			branch = created.branch;
			void this.runSetup(forkId, root, created.path, created.branch);
		} else if (sourceMeta?.worktreePath && sourceMeta.worktreeBranch) {
			// Same checkout as the source: both chats edit the same files.
			this.runtime.rememberWorktree(forkId, sourceMeta.worktreePath, sourceMeta.worktreeBranch);
			this.history.open(forkId).setMeta({ worktreePath: sourceMeta.worktreePath, worktreeBranch: sourceMeta.worktreeBranch });
			branch = sourceMeta.worktreeBranch;
		}
		let refused: string | undefined;
		if (options.message) {
			const result = await this.orchestrator.submit(forkId, {
				text: forkPrompt({ id: sourceId, title: sourceTitle }, turns.length, options.message, options.workspace === 'worktree' ? branch : undefined),
				display: { text: options.message },
				mode: modeLabel(mode),
				...(model ? { modelRef: model.ref } : {}),
				...(options.from ? { host: { fromThread: options.from } } : {}),
			}, 'auto');
			if (result.outcome === 'rejected') {
				refused = result.reason ?? '';
			}
		}
		if (options.open) {
			this.open(forkId);
		}
		return {
			forkId,
			title,
			sourceId,
			sourceTitle,
			branch,
			forkedAtTurns: turns.length,
			totalTurns: all.length,
			model: model?.label,
			refused,
		};
	}

	async mergeBack(forkId: string, options: { readonly apply: boolean }): Promise<IAgentMergeBackResult> {
		const fork = this.history.get(forkId);
		const origin = fork?.forkOf;
		if (!origin) {
			throw new Error('This chat was not forked from another chat, so it has nothing to merge back.');
		}
		const parentId = origin.id;
		if (!this.history.get(parentId) && !this.orchestrator.getThread(parentId)) {
			throw new Error('The chat this was forked from no longer exists.');
		}
		const parentTitle = this.titleOf(parentId);
		const parentPath = this.history.get(parentId)?.worktreePath ?? this.projectOf(parentId)?.root.fsPath;
		const forkTitle = this.titleOf(forkId);
		const forkPath = fork?.worktreePath ?? this.projectOf(forkId)?.root.fsPath;
		let diffStat = '';
		let outcome: MergeBackOutcome = { kind: 'shared' };
		if (forkPath && parentPath && forkPath !== parentPath) {
			diffStat = (await this.worktrees.git(forkPath, ['diff', '--stat', origin.base ?? 'HEAD'])).stdout;
			outcome = options.apply && fork?.worktreeBranch
				? await this.mergeFork({ parentPath, forkPath, forkBranch: fork.worktreeBranch, forkTitle })
				: { kind: 'summary' };
		}
		const reply = (await this.history.open(forkId).load()).turns.at(-1)?.assistant?.text;
		const text = mergeBackNotice({ forkId, forkTitle, forkedAtTurns: origin.turns, diffStat, reply, outcome });
		const result = await this.orchestrator.notify(parentId, {
			text,
			display: { text },
			host: { fromThread: { id: forkId, title: forkTitle, kind: 'merge' } },
		}, `merge-${forkId}-${generateUuid()}`);
		if (result.outcome === 'rejected') {
			throw new Error(`The merge is done, but ${parentTitle} refused the notice: ${result.reason ?? ''}`);
		}
		return { parentId, parentTitle, outcome };
	}

	/** Commits what the fork has not committed, then merges its branch into the parent's checkout. */
	private mergeFork(input: { readonly parentPath: string; readonly forkPath: string; readonly forkBranch: string; readonly forkTitle: string }): Promise<MergeBackOutcome> {
		return this.worktrees.serialize(input.parentPath, async (): Promise<MergeBackOutcome> => {
			if ((await this.worktrees.git(input.forkPath, ['status', '--porcelain'])).stdout.trim()) {
				await this.worktrees.git(input.forkPath, ['add', '-A']);
				const commit = await this.worktrees.git(input.forkPath, ['commit', '-m', `Changes from "${input.forkTitle}"`]);
				if (commit.exitCode !== 0) {
					return { kind: 'failed', reason: firstLine(commit.stderr || commit.stdout) };
				}
			}
			const before = (await this.worktrees.git(input.parentPath, ['rev-parse', 'HEAD'])).stdout.trim();
			const merge = await this.worktrees.git(input.parentPath, ['merge', '--no-ff', '-m', `Merge "${input.forkTitle}" (${input.forkBranch})`, input.forkBranch]);
			if (merge.exitCode !== 0) {
				const conflicts = (await this.worktrees.git(input.parentPath, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
				await this.worktrees.git(input.parentPath, ['merge', '--abort']);
				return conflicts ? { kind: 'conflict' } : { kind: 'failed', reason: firstLine(merge.stderr || merge.stdout) };
			}
			const after = (await this.worktrees.git(input.parentPath, ['rev-parse', 'HEAD'])).stdout.trim();
			return after === before ? { kind: 'nothing' } : { kind: 'merged', commit: after.slice(0, 7) };
		});
	}

	private async finishedTurns(sourceId: string): Promise<{ readonly all: readonly IAgentSessionTurn[]; readonly finished: readonly IAgentSessionTurn[] }> {
		const all = (await this.history.open(sourceId).load()).turns;
		// The running turn is not finished: a fork stops before it.
		const source = this.orchestrator.getThread(sourceId);
		const finished = source?.active && all.at(-1)?.id === source.active.id ? all.slice(0, -1) : all;
		return { all, finished };
	}

	private async headOf(cwd: string | undefined): Promise<string | undefined> {
		return cwd ? (await this.worktrees.git(cwd, ['rev-parse', 'HEAD'])).stdout.trim() || undefined : undefined;
	}

	private async launch(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		this.refuseSubagent(caller, 'start top-level chats');
		const title = stringArg(args.title, 120);
		if (!title) {
			return { error: 'Pass a short `title`.' };
		}
		const message = typeof args.message === 'string' ? args.message.trim() : '';
		if (!message) {
			return { error: 'Pass `message`: the task for the new chat, complete and self-contained (it does not see this conversation).' };
		}
		if (message.length > THREAD_MESSAGE_CHARS) {
			return { error: `The message is ${message.length.toLocaleString('en-US')} characters; the limit is ${THREAD_MESSAGE_CHARS.toLocaleString('en-US')}.` };
		}
		const projectArg = this.projectArg(caller, args.project);
		const project = projectArg === 'all' ? this.projectOf(caller.id) : projectArg;
		if (!project) {
			return { error: 'There is no project to start the chat in. Pass `project`: a folder the user opened in Volt.' };
		}
		const workspace = parseWorkspace(args.workspace ?? args.workspaceStrategy);
		if ('error' in workspace) {
			return { error: workspace.error };
		}
		const mode = this.launchMode(caller, args.mode);
		const models = stringList(args.models, MAX_LAUNCH_MODELS + 1);
		if (models.length > 1) {
			return this.launchCompare(caller, title, message, models, mode, project, workspace);
		}
		this.spend(caller, 'starts');
		const model = this.resolveModel(models[0] ?? args.model) ?? this.defaultModel(caller);
		const threadId = `${CHILD_ID_PREFIX}${generateUuid()}`;
		attachSessionToProject(this.sessionContext, this.workspace, this.history, threadId, project);
		this.history.open(threadId).setMeta({ title, ...(model ? { model: model.label } : {}), mode: modeLabel(mode) });
		await this.orchestrator.dispatch({ type: 'thread.upsert', threadId, title, ...(model ? { modelRef: model.ref, modelLabel: model.label } : {}) });
		let where = `the project's main checkout (${project.root.fsPath})`;
		if (workspace.type === 'existing_worktree') {
			const entry = await this.findWorktree(project.root.fsPath, workspace.path);
			const branch = workspace.branch ?? entry.branch;
			if (!branch) {
				return { error: `${workspace.path} has no branch checked out (detached HEAD); pass a worktree on a branch.` };
			}
			this.runtime.rememberWorktree(threadId, entry.path, branch);
			this.history.open(threadId).setMeta({ worktreePath: entry.path, worktreeBranch: branch });
			where = `the existing worktree ${entry.path} (branch ${branch})`;
		} else if (workspace.type === 'worktree') {
			await this.orchestrator.dispatch({ type: 'thread.block', threadId, reason: SETUP_BLOCK });
			try {
				const target = await this.worktreeTarget(project.root.fsPath, title, threadId, workspace);
				const created = await this.createWorktree(threadId, project.root.fsPath, target);
				where = `a new worktree on branch ${created.branch} (${created.path})${workspace.baseRef ? ` from ${workspace.baseRef}` : ''}`;
				void this.runSetup(threadId, project.root.fsPath, created.path, created.branch);
			} catch (err) {
				await this.orchestrator.dispatch({ type: 'thread.block', threadId, reason: undefined });
				throw err;
			}
		}
		const host = this.sourceOf(caller, 'launch');
		const result = await this.orchestrator.submit(threadId, {
			text: message,
			display: { text: message },
			mode: modeLabel(mode),
			...(model ? { modelRef: model.ref } : {}),
			host,
		}, 'auto');
		if (result.outcome === 'rejected') {
			return { error: `The chat was created but refused the message: ${result.reason ?? ''}` };
		}
		if (args.open === true) {
			this.open(threadId);
		}
		return {
			text: [
				`Launched ${threadLink(threadId, title)} (id ${threadId})${model ? ` on ${model.label}` : ''}, ${mode} mode, in ${where}.`,
				workspace.type === 'worktree' ? 'Its worktree setup runs first; the message is sent when it is done.' : `Its first turn ${result.outcome === 'started' ? 'started' : 'is queued'}.`,
				'Follow it with thread_wait / thread_read. Mention it to the user as its link.',
			].join('\n'),
		};
	}

	/** Several models on one task: a run group (one chat and worktree each, and the compare view). */
	private async launchCompare(caller: ICaller, title: string, message: string, names: readonly string[], mode: VoltMode, project: IVoltProjectRecord, workspace: ThreadWorkspace): Promise<IVoltHostToolResult> {
		if (names.length > MAX_LAUNCH_MODELS) {
			return { error: `At most ${MAX_LAUNCH_MODELS} models at once.` };
		}
		if (workspace.type === 'existing_worktree') {
			return { error: 'Comparing models gives each its own new worktree; existing_worktree does not apply. Use workspace {"type":"worktree","base_ref":...} or leave it out.' };
		}
		const models = names.map(name => this.resolveModel(name)!);
		this.spend(caller, 'starts', models.length);
		const group = await this.runGroups.start({
			prompt: { text: message, display: { text: message }, mode: modeLabel(mode) },
			models: models.map(model => ({ ref: model.ref, label: model.label, family: providerFamily(model.providerId) })),
			repoRoot: project.root.fsPath,
			projectId: project.id,
			...(workspace.type === 'worktree' && workspace.baseRef ? { baseRef: workspace.baseRef } : {}),
		});
		return {
			text: [
				`Started ${models.length} chats on "${title}", one per model, each in its own worktree (Volt's compare view shows them side by side):`,
				...group.runs.map(run => `- ${threadLink(run.id, `${title} · ${run.model.label}`)} · id ${run.id} · ${run.model.label}${run.branch ? ` · branch ${run.branch}` : ''}`),
				'Wait for them with thread_wait (thread_ids), then compare with thread_read or worktree_status.',
			].join('\n'),
		};
	}

	private async worktreeTarget(root: string, title: string, threadId: string, workspace: Extract<ThreadWorkspace, { type: 'worktree' }>): Promise<AgentWorktreeTarget | undefined> {
		if (workspace.branch) {
			const exists = (await this.worktrees.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${workspace.branch}`])).exitCode === 0;
			if (exists) {
				if (workspace.baseRef) {
					throw new Error(`Branch ${workspace.branch} already exists; leave base_ref out to check it out, or pick a new branch name.`);
				}
				return { kind: 'branch', name: workspace.branch };
			}
			return { kind: 'new', name: workspace.branch, ...(workspace.baseRef ? { from: await this.resolveRef(root, workspace.baseRef) } : {}) };
		}
		if (workspace.baseRef) {
			return { kind: 'new', name: `volt/${branchSlug(title)}-${threadId.slice(-4)}`, from: await this.resolveRef(root, workspace.baseRef) };
		}
		return undefined;
	}

	/** A branch, tag, remote branch or commit as the full ref the worktree service expects. */
	private async resolveRef(root: string, ref: string): Promise<string> {
		for (const candidate of [`refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`]) {
			if ((await this.worktrees.git(root, ['rev-parse', '--verify', '--quiet', candidate])).exitCode === 0) {
				return candidate;
			}
		}
		const commit = await this.worktrees.git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
		if (commit.exitCode === 0 && commit.stdout.trim()) {
			return commit.stdout.trim();
		}
		throw new Error(`No branch, tag or commit "${ref}" in ${root}.`);
	}

	private async createWorktree(threadId: string, root: string, target: AgentWorktreeTarget | undefined): Promise<{ path: string; branch: string }> {
		const created = await this.worktrees.create(root, target);
		this.runtime.rememberWorktree(threadId, created.path, created.branch);
		this.history.open(threadId).setMeta({ worktreePath: created.path, worktreeBranch: created.branch });
		return created;
	}

	/** Runs the worktree's setup while the chat is blocked; its queued first message goes after. */
	private async runSetup(threadId: string, root: string, path: string, branch: string): Promise<void> {
		await this.orchestrator.dispatch({ type: 'thread.block', threadId, reason: SETUP_BLOCK });
		try {
			await this.worktreeSetup.run(threadId, { repoRoot: root, worktreePath: path, branch, isCancelled: () => false });
		} catch (err) {
			// The setup card shows what failed; the chat's next turn retries it first.
			this.logService.warn('[volt threads] worktree setup failed', err);
		} finally {
			await this.orchestrator.dispatch({ type: 'thread.block', threadId, reason: undefined });
		}
	}

	private async findWorktree(root: string, path: string) {
		const listing = await this.worktrees.git(root, ['worktree', 'list', '--porcelain']);
		const wanted = path.replace(/\/+$/, '');
		const entry = parseWorktreeList(listing.stdout).find(candidate => candidate.path.replace(/\/+$/, '') === wanted);
		if (!entry) {
			throw new Error(`${path} is not a worktree of ${root}. worktree_list shows them.`);
		}
		return entry;
	}

	//#endregion

	//#region Update and configure

	private async update(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: true });
		const action = stringArg(args.action, 40);
		const link = () => threadLink(id, this.titleOf(id));
		switch (action) {
			case 'rename': {
				const title = stringArg(args.title, 120);
				if (!title) {
					return { error: 'rename needs `title`.' };
				}
				await this.history.rename(id, title);
				await this.orchestrator.dispatch({ type: 'thread.upsert', threadId: id, title });
				return { text: `Renamed to ${link()}.` };
			}
			case 'pin':
			case 'unpin':
				await this.history.setPinned(id, action === 'pin');
				return { text: `${action === 'pin' ? 'Pinned' : 'Unpinned'} ${link()}.` };
			case 'archive':
			case 'unarchive':
				if (action === 'archive' && threadStatus(this.orchestrator.getState(), id).busy) {
					return { error: 'That chat is working; stop it (thread_interrupt) before archiving it.' };
				}
				await this.history.setArchived(id, action === 'archive');
				return { text: `${action === 'archive' ? 'Archived' : 'Unarchived'} ${link()}.` };
			case 'settle':
			case 'unsettle':
				await this.history.setSettled(id, action === 'settle');
				return { text: `${action === 'settle' ? 'Settled' : 'Unsettled'} ${link()}.` };
			case 'snooze': {
				const until = stringArg(args.snoozed_until, 60);
				const at = until ? Date.parse(until) : undefined;
				if (until && (!at || at <= Date.now())) {
					return { error: 'snoozed_until must be a future ISO date-time, e.g. 2026-10-08T09:00:00Z.' };
				}
				await this.history.setSnoozed(id, true, at);
				return { text: `Snoozed ${link()}${at ? ` until ${new Date(at).toISOString()}` : ' until it is woken'}.` };
			}
			case 'unsnooze':
				await this.history.setSnoozed(id, false);
				return { text: `Woke ${link()}.` };
			case 'mark_unread':
			case 'mark_read':
				await this.history.setUnread(id, action === 'mark_unread');
				return { text: `Marked ${link()} ${action === 'mark_unread' ? 'unread' : 'read'}.` };
		}
		return { error: 'action is one of rename, pin, unpin, archive, unarchive, settle, unsettle, snooze, unsnooze, mark_unread, mark_read.' };
	}

	private async configure(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: false, required: true });
		const model = this.resolveModel(args.model);
		if (!model) {
			return { error: 'Pass `model` (orchestrator_capabilities lists them).' };
		}
		if (this.orchestrator.getThread(id)?.taskId) {
			return { error: 'That chat runs a delegated task; its model is set by delegate_task.' };
		}
		const reason = stringArg(args.reason, 300);
		const events = await this.orchestrator.dispatch({ type: 'thread.handoff', threadId: id, to: model.ref, toLabel: model.label, by: 'agent', ...(reason ? { reason } : {}) });
		const busy = threadStatus(this.orchestrator.getState(), id).busy;
		return { text: events.length ? `${threadLink(id, this.titleOf(id))} moves to ${model.label} ${busy ? 'when its current turn ends' : 'now'}; its conversation goes with it.` : `${threadLink(id, this.titleOf(id))} is already on ${model.label}.` };
	}

	//#endregion

	//#region Queue

	private async queueThread(caller: ICaller, value: unknown): Promise<{ id: string; thread: IOrchThread }> {
		const id = await this.target(caller, value, { allowSelf: true });
		const thread = this.orchestrator.getThread(id);
		if (!thread) {
			throw new Error(`${this.titleOf(id)} has nothing queued.`);
		}
		return { id, thread };
	}

	private queueItem(thread: IOrchThread, value: unknown) {
		const itemId = stringArg(value, 200);
		const item = itemId ? thread.queue.find(candidate => candidate.id === itemId) : undefined;
		if (!item) {
			throw new Error(itemId ? `No queued message ${itemId} (it may have been sent already). queue_list shows the queue.` : 'Pass item_id from queue_list.');
		}
		return item;
	}

	private async queueList(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: true });
		const thread = this.orchestrator.getThread(id);
		const queue = thread?.queue ?? [];
		if (!queue.length) {
			return { text: `${threadLink(id, this.titleOf(id))} has nothing queued (${threadStatus(this.orchestrator.getState(), id).kind}).` };
		}
		const full = args.full === true;
		return {
			text: [
				`${queue.length} queued in ${threadLink(id, this.titleOf(id))}${thread?.pause ? ` (paused: ${thread.pause}; queue_resume lets it run)` : thread?.active ? ', after the running turn' : ''}:`,
				...queue.map((item, index) => {
					const text = promptPreview(item.prompt);
					const from = threadSourceOf(item.prompt.host);
					const kind = from ? ` · from chat "${from.title}"${from.id === caller.id ? ' (you)' : ''}` : item.kind && item.kind !== 'prompt' ? ` · ${item.kind === 'notification' ? 'automatic (subagent report or update)' : item.kind}` : '';
					return `${index + 1}. ${item.id}${kind}${item.held ? ' · the user is editing it' : ''}\n${indent(full ? clip(text, THREAD_READ_MAX_CHARS) : clip(text, 300))}`;
				}),
			].join('\n'),
		};
	}

	private async queueEdit(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const { id, thread } = await this.queueThread(caller, args.thread_id);
		const item = this.queueItem(thread, args.item_id);
		const text = typeof args.text === 'string' ? args.text.trim() : '';
		if (!text) {
			return { error: 'Pass the new `text` (to drop the message, use queue_cancel).' };
		}
		if (item.held) {
			return { error: 'The user is editing that message right now; leave it to them.' };
		}
		const from = threadSourceOf(item.prompt.host);
		if (item.kind && item.kind !== 'prompt' && !from) {
			return { error: 'That is an automatic message from Volt (a subagent report or a pull request update); it cannot be edited, only cancelled.' };
		}
		// An agent's message keeps its framing (who sent it) around the new text.
		const prompt = from ? { ...item.prompt, text: agentMessagePrompt({ id: from.id, title: from.title }, text), display: { text } } : { ...item.prompt, text, display: { text } };
		await this.orchestrator.dispatch({ type: 'queue.update', threadId: id, itemId: item.id, prompt });
		return { text: `Edited queued message ${item.id} in ${threadLink(id, this.titleOf(id))}.` };
	}

	private async queueCancel(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const { id, thread } = await this.queueThread(caller, args.thread_id);
		if (args.all === true) {
			const count = thread.queue.length;
			await this.orchestrator.dispatch({ type: 'queue.clear', threadId: id });
			return { text: `Removed ${count} queued message(s) from ${threadLink(id, this.titleOf(id))}.` };
		}
		const item = this.queueItem(thread, args.item_id);
		await this.orchestrator.dispatch({ type: 'queue.remove', threadId: id, itemId: item.id });
		return { text: `Removed queued message ${item.id} from ${threadLink(id, this.titleOf(id))}.` };
	}

	private async queueReorder(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const { id, thread } = await this.queueThread(caller, args.thread_id);
		const current = thread.queue.map(item => item.id);
		let order: string[];
		const explicit = stringList(args.order, 200);
		if (explicit.length) {
			const unknown = explicit.filter(itemId => !current.includes(itemId));
			if (unknown.length) {
				return { error: `Not in the queue: ${unknown.join(', ')}.` };
			}
			order = [...explicit, ...current.filter(itemId => !explicit.includes(itemId))];
		} else {
			const item = this.queueItem(thread, args.item_id);
			const before = args.before_item_id === null ? undefined : stringArg(args.before_item_id, 200);
			if (before && !current.includes(before)) {
				return { error: `No queued message ${before}.` };
			}
			order = current.filter(itemId => itemId !== item.id);
			order.splice(before ? order.indexOf(before) : order.length, 0, item.id);
		}
		await this.orchestrator.dispatch({ type: 'queue.reorder', threadId: id, ids: order });
		return { text: `Queue of ${threadLink(id, this.titleOf(id))} is now: ${order.join(', ')}.` };
	}

	private async queueSendNow(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const { id, thread } = await this.queueThread(caller, args.thread_id);
		const item = this.queueItem(thread, args.item_id);
		if (id === caller.id) {
			return { error: 'Your own queued message goes after this turn anyway: finish your turn.' };
		}
		const canSteer = !!thread.active?.steerable || this.runtime.canSteer(id);
		await this.orchestrator.dispatch({ type: 'queue.sendNow', threadId: id, itemId: item.id, canSteer });
		const how = !thread.active ? 'started it' : canSteer && thread.active.phase === 'running' ? 'steered it into the running turn' : 'is stopping the running turn and runs it next';
		return { text: `Sent ${item.id} now in ${threadLink(id, this.titleOf(id))}: Volt ${how}.` };
	}

	private async queueResume(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const { id, thread } = await this.queueThread(caller, args.thread_id);
		if (!thread.pause) {
			return { text: `The queue of ${threadLink(id, this.titleOf(id))} is not paused.` };
		}
		await this.orchestrator.dispatch({ type: 'queue.resume', threadId: id });
		return { text: `Resumed the queue of ${threadLink(id, this.titleOf(id))} (it was paused: ${thread.pause}).` };
	}

	//#endregion

	//#region Worktrees

	private async worktreeStatus(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const id = await this.target(caller, args.thread_id, { allowSelf: true });
		const meta = this.history.get(id);
		const project = this.projectOf(id);
		const folder = meta?.worktreePath ?? project?.root.fsPath;
		if (!folder) {
			return { text: `${threadLink(id, this.titleOf(id))} has no project folder.` };
		}
		const status = await this.worktrees.git(folder, ['status', '--porcelain=v1', '-b']);
		if (status.exitCode !== 0) {
			return { text: `${threadLink(id, this.titleOf(id))} works in ${folder}, which is not a git checkout (${clip(status.stderr, 200)}).` };
		}
		const parsed = parseBranchStatus(status.stdout);
		return {
			text: [
				`${threadLink(id, this.titleOf(id))} works in ${meta?.worktreePath ? `its own worktree ${folder}` : `the project's main checkout ${folder}`}.`,
				`Branch: ${parsed.detached ? 'detached HEAD' : parsed.branch ?? 'unknown'}${parsed.upstream ? ` · upstream ${parsed.upstream} (${parsed.ahead} ahead, ${parsed.behind} behind)` : ' · no upstream'}`,
				parsed.changes.length ? `${parsed.changes.length} uncommitted change(s):\n${parsed.changes.slice(0, 40).map(line => `  ${line}`).join('\n')}${parsed.changes.length > 40 ? `\n  …${parsed.changes.length - 40} more` : ''}` : 'No uncommitted changes.',
				...(project && meta?.worktreePath ? [`Project root: ${project.root.fsPath}`] : []),
			].join('\n'),
		};
	}

	private async worktreeHandoff(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const parsed = parseHandoffArgs(args);
		if ('error' in parsed) {
			return { error: parsed.error };
		}
		const id = await this.target(caller, args.thread_id, { allowSelf: true });
		const result = await this.orchestrator.move(id, parsed.spec, { by: 'agent', stop: parsed.stop });
		if (result.outcome === 'rejected') {
			return { error: result.reason ?? 'The chat cannot move now.' };
		}
		const chat = threadLink(id, this.titleOf(id));
		const where = workspaceTargetLabel(parsed.spec.target);
		return {
			text: result.outcome === 'queued'
				? `${chat} moves to ${where} when its current turn ends. Its next turn runs there.`
				: `${chat} is moving to ${where}. Its next turn runs there.`,
		};
	}

	private async worktreeList(caller: ICaller, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const projectArg = this.projectArg(caller, args.project);
		const project = projectArg === 'all' ? this.projectOf(caller.id) : projectArg;
		if (!project) {
			return { error: 'No project.' };
		}
		const listing = await this.worktrees.git(project.root.fsPath, ['worktree', 'list', '--porcelain']);
		if (listing.exitCode !== 0) {
			return { error: `Could not list worktrees of ${project.root.fsPath}: ${clip(listing.stderr, 300)}` };
		}
		const users = new Map<string, IAgentSessionMeta[]>();
		for (const meta of this.history.list({ workspaceId: project.id, includeArchived: true })) {
			if (meta.worktreePath) {
				const key = meta.worktreePath.replace(/\/+$/, '');
				users.set(key, [...(users.get(key) ?? []), meta]);
			}
		}
		const entries = parseWorktreeList(listing.stdout);
		return {
			text: [
				`${entries.length} worktree(s) of ${project.displayName}:`,
				...entries.map((entry, index) => {
					const chats = users.get(entry.path.replace(/\/+$/, '')) ?? [];
					return `- ${entry.path} · ${entry.branch ? `branch ${entry.branch}` : entry.detached ? 'detached' : entry.bare ? 'bare' : '?'}${entry.head ? ` · ${entry.head.slice(0, 8)}` : ''}${index === 0 ? ' · main checkout' : ''}${entry.locked ? ' · locked' : ''}${entry.prunable ? ' · missing (prunable)' : ''}${chats.length ? ` · used by ${chats.slice(0, 3).map(meta => threadLink(meta.id, meta.title)).join(', ')}${chats.length > 3 ? ` +${chats.length - 3}` : ''}` : ''}`;
				}),
			].join('\n'),
		};
	}

	//#endregion
}

function promptPreview(prompt: IOrchPrompt): string {
	const display = prompt.display as { text?: unknown } | undefined;
	return typeof display?.text === 'string' && display.text.trim() ? display.text : prompt.text;
}

function statusWord(status: AgentSessionStatus, final: boolean): string {
	if (!final && status === 'running') {
		return 'in progress';
	}
	return status === 'error' ? 'failed' : status;
}

function indent(text: string): string {
	return text.split('\n').map(line => `    ${line}`).join('\n');
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}

registerSingleton(IAgentChatForkService, AgentThreadToolService, InstantiationType.Eager);
