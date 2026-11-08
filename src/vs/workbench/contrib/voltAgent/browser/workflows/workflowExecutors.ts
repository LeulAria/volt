/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { isEqualOrParent, joinPath, relativePath } from '../../../../../base/common/resources.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { asText, IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltExecFileResult, IVoltStdioService, runGitThrough } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltPrRepo, IVoltPullRequestService, voltPrErrorCode, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { isTurnOfRun } from '../../../../services/voltRuntime/common/automations/automations.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { isTransientFailure } from '../../../../services/voltRuntime/common/jobs/retryPolicy.js';
import { IAgentOrchestratorService, OrchOutcome } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { foldSpend, seedSpendTracker, spendUsage } from '../../../../services/voltRuntime/common/orchestration/taskSpend.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { canonicalProjectRoot, IVoltProjectRecord, IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { keyValueRecord, parseWorkflowDuration } from '../../../../services/voltRuntime/common/workflows/workflowNodeCatalog.js';
import { nodeDisplayName } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import {
	IWorkflowDefinition, IWorkflowExecutor, IWorkflowNodeContext, IWorkflowNodeResult, IWorkflowRunTrigger, IWorkflowTokenUsage, WorkflowNodeError, WorkflowRecord, WorkflowValue,
} from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import type { IAutomationRunHost } from '../automations/automationCommands.js';
import { IAgentCustomizeService } from '../customize/agentCustomizeService.js';
import { expandSlashPrompt } from '../customize/agentSlashExpansion.js';
import type { IAgentPromptHostOptions } from '../orchestration/agentTurnHost.js';
import { AgentScratchFolders } from '../workspace/agentScratchProject.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

/**
 * The real executors of workflow task nodes, one set per run. Agent-like nodes (agent, skill,
 * MCP tool, subtask, classify, summarize) are turns in Volt chats sent through the orchestrator
 * and followed until they settle; shell and package scripts run through Volt's stdio service; HTTP,
 * webhooks, Slack and Teams through the request service; git without a shell; GitHub through the
 * pull request service, else the `gh` CLI. Pure nodes (transform, template, log) never get here.
 *
 * Every node works in one folder: the run's repository (an automation's), else the workflow's
 * `settings.repository`, else the project open in the window.
 */

/** Characters of a stream or body kept in a step's output. */
const OUTPUT_CHARS = 16_000;
/** Characters of upstream input handed to a classify or summarize turn. */
const INPUT_CHARS = 24_000;
const SHELL_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 60_000;
const CI_TIMEOUT_MS = 60 * 60_000;
const NO_PROMPT = localize('voltWorkflows.noPrompt', "The node has no prompt.");

/** What the executors need to know about the run beyond each node's context. */
export interface IWorkflowRunEnvironment {
	readonly runId: string;
	readonly workflow: IWorkflowDefinition;
	readonly trigger?: IWorkflowRunTrigger;
}

interface ITurnRequest {
	/** What the model receives. */
	readonly text: string;
	/** What the transcript shows as the user's message. */
	readonly display: string;
	readonly modelRef?: string;
	readonly mode: string;
	/** Continue this chat instead of starting one. */
	readonly threadId?: string;
	/** A new chat on its own worktree. */
	readonly worktree?: boolean;
}

interface ITurnResult {
	readonly threadId: string;
	readonly outcome: OrchOutcome;
	readonly reply: string;
	readonly error?: string;
	readonly tokens?: IWorkflowTokenUsage;
}

type Run = (context: IWorkflowNodeContext) => Promise<IWorkflowNodeResult>;

export class WorkflowExecutors extends Disposable {

	private readonly scratch: AgentScratchFolders;
	/** The chat of the run's latest agent node, for `session: continue`. */
	private lastThread: string | undefined;
	private readonly table: Readonly<Record<string, Run>>;

	constructor(
		private readonly env: IWorkflowRunEnvironment,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IRequestService private readonly requestService: IRequestService,
		@IVoltPullRequestService private readonly pullRequests: IVoltPullRequestService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileService private readonly fileService: IFileService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.scratch = instantiationService.createInstance(AgentScratchFolders);
		this.table = {
			agent: ctx => this.agent(ctx),
			skill: ctx => this.skill(ctx),
			mcp_tool: ctx => this.mcpTool(ctx),
			subtask: ctx => this.subtask(ctx),
			classify: ctx => this.classify(ctx),
			summarize: ctx => this.summarize(ctx),
			ask_user: ctx => this.askUser(ctx),
			shell: ctx => this.shell(ctx),
			package_script: ctx => this.packageScript(ctx),
			http: ctx => this.http(ctx),
			webhook: ctx => this.webhook(ctx),
			slack_message: ctx => this.slack(ctx),
			teams_message: ctx => this.teams(ctx),
			notify: ctx => this.notify(ctx),
			write_file: ctx => this.writeFile(ctx),
			git_commit: ctx => this.gitCommit(ctx),
			git_push: ctx => this.gitPush(ctx),
			git_sync: ctx => this.gitSync(ctx),
			git_branch: ctx => this.gitBranch(ctx),
			github_pr: ctx => this.githubPr(ctx),
			github_wait_ci: ctx => this.githubWaitCi(ctx),
			github_pr_comment: ctx => this.githubPrComment(ctx),
			github_update_pr: ctx => this.githubUpdatePr(ctx),
			github_issue_comment: ctx => this.githubIssueComment(ctx),
		};
	}

	executor(type: string): IWorkflowExecutor | undefined {
		const run = this.table[type];
		return run ? { execute: ctx => run(ctx) } : undefined;
	}

	//#region Folder

	/** The folder this run works in, when it has one. */
	private folder(): URI | undefined {
		const stored = this.env.trigger?.repository ?? this.env.workflow.settings?.repository;
		if (stored?.trim()) {
			return canonicalProjectRoot(uriFromStoredRoot(stored.trim()));
		}
		const active = this.sessionContext.activeProject;
		return active && !active.scratch ? active.root : undefined;
	}

	private requireFolder(): URI {
		const folder = this.folder();
		if (!folder) {
			throw new WorkflowNodeError(localize('voltWorkflows.noFolder', "No folder to work in: set the workflow's repository (Settings) or open a project."));
		}
		return folder;
	}

	private projectFor(root: URI): IVoltProjectRecord {
		const key = canonicalProjectRoot(root).toString();
		return this.sessionContext.projects.find(project => canonicalProjectRoot(project.root).toString() === key)
			?? this.sessionContext.registerProject(root);
	}

	//#endregion

	//#region Agent turns

	private async newChat(title: string): Promise<string> {
		const threadId = `agent-${generateUuid()}`;
		const folder = this.folder();
		if (folder) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, threadId, this.projectFor(folder));
		} else if (!await this.scratch.bind(threadId, title)) {
			throw new WorkflowNodeError(localize('voltWorkflows.noScratch', "Could not make a folder for the agent; set the workflow's repository."), true);
		}
		this.history.open(threadId).setMeta({ title });
		return threadId;
	}

	/**
	 * Sends one turn and follows it until it settles, from the orchestrator's change events (no
	 * polling): running, parked at a usage limit (the step shows it is waiting), then its outcome.
	 * Stopping the step stops the chat's turn. Usage reports of the chat are folded on the way.
	 */
	private async runTurn(ctx: IWorkflowNodeContext, request: ITurnRequest): Promise<ITurnResult> {
		const threadId = request.threadId && this.orchestrator.getThread(request.threadId) ? request.threadId : await this.newChat(this.title(ctx));
		ctx.reportThread(threadId);
		const turnId = `wf-${generateUuid().replace(/-/g, '').slice(0, 12)}`;
		const store = new DisposableStore();
		let tracker = seedSpendTracker(undefined);
		store.add(this.runtime.onDidEmit(envelope => {
			if (envelope.event.type === 'usage' && this.runtime.chatFor(envelope.sessionId) === threadId) {
				tracker = foldSpend(tracker, envelope.runId, envelope.event);
			}
		}));
		try {
			const settled = this.whenSettled(ctx, threadId, turnId, store);
			const automation = this.env.trigger?.kind === 'automation' && this.env.trigger.automationId ? this.env.trigger : undefined;
			const host: Partial<IAutomationRunHost> & IAgentPromptHostOptions = {
				...(automation ? { scheduled: { id: automation.automationId!, title: this.env.workflow.name, ...(automation.automationRunId ? { runId: automation.automationRunId } : {}) } } : {}),
				...(request.worktree ? { runOn: 'worktree' as const } : {}),
			};
			const result = await this.orchestrator.submit(threadId, {
				text: request.text,
				display: { text: request.display },
				mode: request.mode,
				...(request.modelRef ? { modelRef: request.modelRef } : {}),
				...(Object.keys(host).length ? { host } : {}),
			}, 'auto', turnId);
			if (result.outcome === 'rejected') {
				throw new WorkflowNodeError(result.reason ?? localize('voltWorkflows.rejected', "The chat refused the prompt."), true, { threadId });
			}
			settled.check();
			const end = await settled.done;
			const reply = end.outcome === 'done' ? await this.finalReply(threadId) : '';
			const usage = spendUsage(tracker, undefined);
			const tokens: IWorkflowTokenUsage | undefined = usage.input + usage.output + usage.cacheWrite > 0 || usage.costUsd !== undefined
				? { input: usage.input + usage.cacheWrite, output: usage.output, ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) }
				: undefined;
			if (tokens) {
				ctx.reportTokens(tokens);
			}
			return { threadId, outcome: end.outcome, reply, ...(end.error ? { error: end.error } : {}), ...(tokens ? { tokens } : {}) };
		} finally {
			store.dispose();
		}
	}

	private whenSettled(ctx: IWorkflowNodeContext, threadId: string, turnId: string, store: DisposableStore): { readonly done: Promise<{ readonly outcome: OrchOutcome; readonly error?: string }>; check(): void } {
		let check = () => { };
		const done = new Promise<{ readonly outcome: OrchOutcome; readonly error?: string }>((resolve, reject) => {
			let seen = false;
			let finished = false;
			const parked = store.add(new DisposableStore());
			let parkedFor: string | undefined;
			check = () => {
				if (finished) {
					return;
				}
				const thread = this.orchestrator.getThread(threadId);
				if (!thread) {
					return;
				}
				if (isTurnOfRun(thread.active?.id, turnId)) {
					seen = true;
					parked.clear();
					parkedFor = undefined;
					return;
				}
				// Parked at a provider's usage limit: not over, it continues with the chat.
				if (thread.limit && isTurnOfRun(thread.limit.turnId, turnId)) {
					seen = true;
					if (!parkedFor) {
						parkedFor = thread.limit.providerLabel ?? 'provider';
						parked.add(ctx.waiting(localize('voltWorkflows.usageLimit', "{0}'s usage limit", parkedFor)));
					}
					return;
				}
				const last = thread.last;
				if (last && isTurnOfRun(last.turnId, turnId)) {
					finished = true;
					resolve({ outcome: last.outcome, ...(last.error ? { error: last.error } : {}) });
					return;
				}
				if (thread.queue.some(item => isTurnOfRun(item.id, turnId))) {
					return;
				}
				// It ran and another turn of the chat followed in the same batch.
				if (seen) {
					finished = true;
					resolve({ outcome: 'done' });
				}
			};
			store.add(this.orchestrator.onDidChange(change => {
				if (change.threads.includes(threadId)) {
					check();
				}
			}));
			store.add(ctx.token.onCancellationRequested(() => {
				if (!finished) {
					finished = true;
					void this.orchestrator.cancel(threadId).catch(() => undefined);
					reject(new CancellationError());
				}
			}));
		});
		return { done, check: () => check() };
	}

	/** The chat's last reply: the runtime's transcript, else the stored history. */
	private async finalReply(threadId: string): Promise<string> {
		const messages = this.runtime.getOrCreateSession(threadId).messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role === 'assistant') {
				return message.content;
			}
			if (message.role === 'user' && !message.steer) {
				break;
			}
		}
		const transcript = await this.history.readTranscript(threadId).catch(() => undefined);
		return transcript?.turns.at(-1)?.assistant?.text ?? '';
	}

	private title(ctx: IWorkflowNodeContext): string {
		return `${this.env.workflow.name} · ${nodeDisplayName(ctx.node)}`;
	}

	private model(ctx: IWorkflowNodeContext): string | undefined {
		return text(ctx.config, 'model', 'modelRef')?.trim() || this.env.workflow.settings?.modelRef || undefined;
	}

	/** The run's framing, after the task (and the instructions of the skills it names). */
	private framing(ctx: IWorkflowNodeContext, extra: readonly string[]): string {
		return [
			`[Volt] Step "${nodeDisplayName(ctx.node)}" of the workflow "${this.env.workflow.name}" (run ${ctx.runId}). Nobody is watching: do the task, then end with a short report of what you found and changed.`,
			...extra,
		].join('\n');
	}

	private verdictLine(verdicts: readonly string[]): string {
		return `End your reply with one last line naming exactly one verdict: VERDICT: <${verdicts.join(' | ')}>`;
	}

	/** An agent-like node's result: the reply as `summary`, its verdict as the port, failures to `failed`. */
	private turnResult(ctx: IWorkflowNodeContext, turn: ITurnResult, verdicts: readonly string[], extra: Record<string, WorkflowValue> = {}): IWorkflowNodeResult {
		if (turn.outcome !== 'done') {
			const error = turn.error ?? (turn.outcome === 'cancelled'
				? localize('voltWorkflows.turnStopped', "The agent's turn was stopped.")
				: turn.outcome === 'interrupted' ? localize('voltWorkflows.turnInterrupted', "Volt restarted while the agent worked.") : localize('voltWorkflows.turnFailed', "The agent's turn failed."));
			return this.fail(ctx, error, { threadId: turn.threadId, error }, isTransientFailure(error) || turn.outcome === 'interrupted');
		}
		const { summary, verdict } = splitVerdict(turn.reply, verdicts);
		if (verdicts.length && !verdict) {
			ctx.log('warn', localize('voltWorkflows.noVerdict', "The agent named no verdict ({0}); leaving through done.", verdicts.join(', ')));
		}
		const output: Record<string, WorkflowValue> = {
			summary,
			threadId: turn.threadId,
			...(verdict ? { verdict } : {}),
			...(turn.tokens?.costUsd !== undefined ? { costUsd: turn.tokens.costUsd } : {}),
			...(turn.tokens ? { tokens: { input: turn.tokens.input, output: turn.tokens.output } } : {}),
			...extra,
		};
		const port = verdict && hasPort(ctx, verdict) ? verdict : successPort(ctx);
		// Tokens went to the step with reportTokens already (also for failed turns).
		return { output, ...portOf(port) };
	}

	private async agent(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const prompt = text(ctx.config, 'prompt')?.trim();
		if (!prompt) {
			throw new WorkflowNodeError(NO_PROMPT);
		}
		const skill = text(ctx.config, 'skill')?.trim().replace(/^\//, '');
		const verdicts = list(ctx.config, 'verdicts');
		const servers = list(ctx.config, 'mcpServers', 'mcp');
		const body = skill ? `/${skill} ${prompt}` : prompt;
		const turn = await this.runTurn(ctx, {
			text: `${await expandSlashPrompt(this.customize, body)}\n\n${this.framing(ctx, [
				...(servers.length ? [`Use these MCP servers where they help: ${servers.join(', ')}.`] : []),
				...(verdicts.length ? [this.verdictLine(verdicts)] : []),
			])}`,
			display: body,
			mode: text(ctx.config, 'mode') ?? 'Agent',
			modelRef: this.model(ctx),
			threadId: text(ctx.config, 'session') === 'continue' ? this.lastThread : undefined,
		});
		this.lastThread = turn.threadId;
		return this.turnResult(ctx, turn, verdicts);
	}

	private async skill(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const skill = text(ctx.config, 'skill')?.trim().replace(/^\//, '');
		if (!skill) {
			throw new WorkflowNodeError(localize('voltWorkflows.noSkill', "Pick the skill to run."));
		}
		const prompt = text(ctx.config, 'prompt')?.trim();
		const body = `/${skill}${prompt ? ` ${prompt}` : ''}`;
		const turn = await this.runTurn(ctx, {
			text: `${await expandSlashPrompt(this.customize, body)}\n\n${this.framing(ctx, [])}`,
			display: body,
			mode: 'Agent',
			modelRef: this.model(ctx),
		});
		this.lastThread = turn.threadId;
		return this.turnResult(ctx, turn, [], { skill });
	}

	/**
	 * An agent turn told to call exactly one MCP tool and answer with its result: with the node's
	 * arguments, or with arguments it picks from the node's instructions.
	 */
	private async mcpTool(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const server = text(ctx.config, 'server')?.trim();
		const tool = text(ctx.config, 'tool')?.trim();
		if (!server || !tool) {
			throw new WorkflowNodeError(localize('voltWorkflows.noTool', "Pick the MCP server and the tool."));
		}
		const instructions = text(ctx.config, 'instructions')?.trim();
		const raw = ctx.config.arguments;
		const args = typeof raw === 'string' ? parseJson(raw) ?? raw : raw ?? {};
		const body = instructions
			? `Call the tool \`${tool}\` of the MCP server \`${server}\` exactly once, with the arguments these instructions call for:\n${instructions}`
			: `Call the tool \`${tool}\` of the MCP server \`${server}\` exactly once with these arguments:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``;
		const turn = await this.runTurn(ctx, {
			text: `${body}\nDo nothing else: no other tools, no file changes, no commentary. Reply with the tool's result only, exactly as it came back (JSON stays JSON). If the call failed, reply with its error and a last line: VERDICT: failed`,
			display: body,
			mode: 'Agent',
			modelRef: this.model(ctx),
		});
		if (turn.outcome !== 'done') {
			return this.turnResult(ctx, turn, []);
		}
		const { summary, verdict } = splitVerdict(turn.reply, ['failed']);
		if (verdict === 'failed') {
			return this.fail(ctx, summary || localize('voltWorkflows.toolFailed', "The tool call failed."), { threadId: turn.threadId });
		}
		const textContent = stripFence(summary);
		const port = successPort(ctx);
		return { output: { result: parseJson(textContent) ?? textContent, text: textContent, threadId: turn.threadId, server, tool }, ...portOf(port) };
	}

	/** A delegated piece of work in its own chat (on its own worktree when asked). */
	private async subtask(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const prompt = text(ctx.config, 'prompt')?.trim();
		if (!prompt) {
			throw new WorkflowNodeError(NO_PROMPT);
		}
		const worktree = flag(ctx.config, 'worktree', false);
		const turn = await this.runTurn(ctx, {
			text: `${await expandSlashPrompt(this.customize, prompt)}\n\n${this.framing(ctx, [])}`,
			display: prompt,
			mode: 'Agent',
			modelRef: this.model(ctx),
			worktree,
		});
		const extra: Record<string, WorkflowValue> = {};
		if (worktree) {
			const transcript = await this.history.readTranscript(turn.threadId).catch(() => undefined);
			const path = transcript?.worktreePath ?? this.runtime.workingFolder(turn.threadId);
			if (path) {
				extra.worktree = path;
			}
			if (transcript?.worktreeBranch) {
				extra.branch = transcript.worktreeBranch;
			}
		}
		return this.turnResult(ctx, turn, [], extra);
	}

	/** One of the node's categories (its ports), or `other` when none fits. */
	private async classify(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const categories = list(ctx.config, 'categories');
		if (!categories.length) {
			throw new WorkflowNodeError(localize('voltWorkflows.noCategories', "Add the categories to choose from."));
		}
		const instructions = text(ctx.config, 'instructions')?.trim();
		const body = [
			`Classify the text below into exactly one of these categories: ${categories.join(', ')}. Answer other when none fits.`,
			...(instructions ? [instructions] : []),
			'Do not change files or run commands. Reply with one short sentence of reasoning, then these two last lines:',
			'CONFIDENCE: <a number from 0 to 1>',
			'VERDICT: <category>',
			'',
			`<text>\n${clip(inputText(ctx), INPUT_CHARS)}\n</text>`,
		].join('\n');
		const turn = await this.runTurn(ctx, { text: body, display: localize('voltWorkflows.classifyDisplay', "Classify into {0}", categories.join(', ')), mode: 'Ask', modelRef: this.model(ctx) });
		if (turn.outcome !== 'done') {
			return this.turnResult(ctx, turn, []);
		}
		const { summary, verdict } = splitVerdict(turn.reply, [...categories, 'other']);
		const confidenceLine = /^[ \t>*_`-]*CONFIDENCE[*_`]*\s*:\s*[*_`]*\s*([01](?:\.\d+)?|\.\d+)/im.exec(summary);
		const reason = summary.replace(/^[ \t>*_`-]*CONFIDENCE[^\n]*\n?/im, '').trim();
		const category = verdict ?? 'other';
		if (!verdict) {
			ctx.log('warn', localize('voltWorkflows.noCategory', "The agent named none of the categories; leaving through other."));
		}
		return {
			output: { category, ...(confidenceLine ? { confidence: Math.max(0, Math.min(1, Number(confidenceLine[1]))) } : {}), reason, threadId: turn.threadId },
			port: hasPort(ctx, category) ? category : 'other',
		};
	}

	private async summarize(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const instructions = text(ctx.config, 'instructions')?.trim();
		const body = [
			'Summarize the text below.',
			...(instructions ? [instructions] : []),
			'Do not change files or run commands. Reply with the summary only.',
			'',
			`<text>\n${clip(inputText(ctx), INPUT_CHARS)}\n</text>`,
		].join('\n');
		const turn = await this.runTurn(ctx, { text: body, display: localize('voltWorkflows.summarizeDisplay', "Summarize"), mode: 'Ask', modelRef: this.model(ctx) });
		return this.turnResult(ctx, turn, []);
	}

	//#endregion

	//#region People

	/** Asks in a notification: the options as buttons, or a text answer; no answer in time leaves through `timeout`. */
	private async askUser(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const question = text(ctx.config, 'question')?.trim() || nodeDisplayName(ctx.node);
		const options = list(ctx.config, 'options');
		// Before the engine's own step timeout, so the run can leave through `timeout`.
		const limit = parseWorkflowDuration(ctx.config.timeout) || (ctx.node.timeoutMs ? Math.max(1000, ctx.node.timeoutMs - 250) : undefined);
		const waiting = ctx.waiting(localize('voltWorkflows.waitingAnswer', "Your answer"));
		const store = new DisposableStore();
		try {
			const answer = await new Promise<string | undefined>((resolve, reject) => {
				let handle: { close(): void } | undefined;
				let settled = false;
				const settle = (value: string | undefined) => {
					if (!settled) {
						settled = true;
						handle?.close();
						resolve(value);
					}
				};
				const show = () => {
					const choices: IPromptChoice[] = options.length
						? options.map((option, index) => ({ label: option, isSecondary: index >= 3, run: () => settle(option) }))
						: [{ label: localize('voltWorkflows.answer', "Answer…"), run: () => void ask() }];
					// Closing the question without an answer counts as no answer.
					handle = this.notificationService.prompt(Severity.Info, localize('voltWorkflows.asks', "{0} asks: {1}", this.env.workflow.name, question), choices, { sticky: true, onCancel: () => settle(undefined) });
				};
				const ask = async () => {
					const typed = await this.quickInputService.input({ prompt: question, placeHolder: localize('voltWorkflows.answerPlaceholder', "Your answer to the workflow"), ignoreFocusLost: true }, ctx.token);
					if (typed !== undefined) {
						settle(typed);
					} else if (!settled && !ctx.token.isCancellationRequested) {
						show();
					}
				};
				show();
				store.add(toDisposable(() => handle?.close()));
				store.add(ctx.token.onCancellationRequested(() => reject(new CancellationError())));
				if (limit) {
					const timer = setTimeout(() => settle(undefined), limit);
					store.add(toDisposable(() => clearTimeout(timer)));
				}
			});
			if (answer === undefined) {
				const error = localize('voltWorkflows.noAnswer', "Nobody answered in time.");
				if (hasPort(ctx, 'timeout')) {
					return { output: { answer: null, option: null, timedOut: true, error }, port: 'timeout' };
				}
				throw new WorkflowNodeError(error);
			}
			const index = options.indexOf(answer);
			return { output: { answer, option: index >= 0 ? index : null, timedOut: false }, ...portOf(successPort(ctx)) };
		} finally {
			store.dispose();
			waiting.dispose();
		}
	}

	private async notify(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const title = text(ctx.config, 'title')?.trim();
		const message = text(ctx.config, 'message')?.trim() || (title ? '' : inputText(ctx));
		const level = text(ctx.config, 'severity')?.toLowerCase();
		const severity = level === 'error' ? Severity.Error : level === 'warning' || level === 'warn' ? Severity.Warning : Severity.Info;
		this.notificationService.notify({ severity, message: [title, message].filter(Boolean).join(': '), source: this.env.workflow.name });
		return { output: { title: title ?? '', message, severity: level ?? 'info' }, ...portOf(successPort(ctx)) };
	}

	//#endregion

	//#region Scripts

	private async shell(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const command = text(ctx.config, 'command')?.trim();
		if (!command) {
			throw new WorkflowNodeError(localize('voltWorkflows.noCommand', "The node has no command."));
		}
		return this.runCommand(ctx, command);
	}

	private async packageScript(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const script = text(ctx.config, 'script')?.trim();
		if (!script || !/^[\w:.@/+-]+$/.test(script)) {
			throw new WorkflowNodeError(localize('voltWorkflows.badScript', "Name the package.json script to run (letters, digits and : . @ / + -)."));
		}
		const manager = await this.detectManager(this.cwd(ctx));
		const args = text(ctx.config, 'args')?.trim();
		const command = `${manager} run ${script}${args ? (manager === 'npm' ? ` -- ${args}` : ` ${args}`) : ''}`;
		const result = await this.runCommand(ctx, command);
		return { ...result, output: { ...(result.output as Record<string, WorkflowValue>), script, manager } };
	}

	private async detectManager(folder: URI): Promise<string> {
		for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['yarn.lock', 'yarn']] as const) {
			if (await this.fileService.exists(joinPath(folder, file)).catch(() => false)) {
				return manager;
			}
		}
		return 'npm';
	}

	/** The node's `cwd`, under the working folder. */
	private cwd(ctx: IWorkflowNodeContext): URI {
		const folder = this.requireFolder();
		const sub = text(ctx.config, 'cwd')?.trim();
		return sub ? (/^(?:\/|[a-zA-Z]:[\\/])/.test(sub) ? URI.file(sub) : joinPath(folder, sub)) : folder;
	}

	private async runCommand(ctx: IWorkflowNodeContext, command: string): Promise<IWorkflowNodeResult> {
		const cwd = this.cwd(ctx);
		const env = pairs(ctx.config.env);
		const timeoutMs = this.timeoutOf(ctx, SHELL_TIMEOUT_MS);
		const codes = list(ctx.config, 'successCodes').map(Number).filter(Number.isInteger);
		const success = codes.length ? codes : [0];
		const id = `wf-${generateUuid()}`;
		ctx.log('info', `$ ${command.length > 200 ? `${command.slice(0, 200)}…` : command}`);
		const cancel = ctx.token.onCancellationRequested(() => void this.stdio.cancelExec(id).catch(() => undefined));
		let result;
		try {
			result = await this.stdio.exec({ id, command, cwd: cwd.fsPath, ...(Object.keys(env).length ? { env } : {}), timeoutMs, inlineChars: OUTPUT_CHARS });
		} finally {
			cancel.dispose();
		}
		if (ctx.token.isCancellationRequested || result.cancelled) {
			throw new CancellationError();
		}
		const output: Record<string, WorkflowValue> = {
			exitCode: result.exitCode,
			stdout: tail(result.stdout, OUTPUT_CHARS),
			stderr: tail(result.stderr, OUTPUT_CHARS),
			durationMs: result.durationMs,
			timedOut: result.timedOut,
			command,
		};
		if (result.timedOut) {
			return this.fail(ctx, localize('voltWorkflows.timedOut', "Stopped after {0} s without finishing.", Math.round(timeoutMs / 1000)), output);
		}
		if (result.exitCode === null || !success.includes(result.exitCode)) {
			const last = lastLine(result.stderr) ?? lastLine(result.stdout);
			return this.fail(ctx, localize('voltWorkflows.exitCode', "Exited with code {0}{1}", String(result.exitCode ?? result.signal ?? '?'), last ? `: ${last}` : ''), output);
		}
		ctx.log('info', localize('voltWorkflows.exitOk', "Exited with code {0} in {1} ms", String(result.exitCode), result.durationMs));
		return { output, ...portOf(successPort(ctx)) };
	}

	//#endregion

	//#region HTTP

	private async http(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const url = text(ctx.config, 'url')?.trim();
		const method = (text(ctx.config, 'method')?.trim() || 'GET').toUpperCase();
		return this.request(ctx, url, method, pairs(ctx.config.headers), ctx.config.body, pairs(ctx.config.query));
	}

	private async webhook(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const payload = ctx.config.payload;
		return this.request(ctx, text(ctx.config, 'url')?.trim(), 'POST', {}, payload === undefined || payload === null || payload === '' ? ctx.input ?? {} : payload, {});
	}

	private async slack(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const message = text(ctx.config, 'text')?.trim() || inputText(ctx);
		const channel = text(ctx.config, 'channel')?.trim();
		return this.request(ctx, text(ctx.config, 'webhookUrl')?.trim(), 'POST', {}, { text: message, ...(channel ? { channel } : {}) }, {});
	}

	/** Works for classic connectors (text) and Workflows webhooks (an Adaptive Card), like the automation tool. */
	private async teams(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const message = text(ctx.config, 'text')?.trim() || inputText(ctx);
		return this.request(ctx, text(ctx.config, 'webhookUrl')?.trim(), 'POST', {}, {
			type: 'message', text: message,
			attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: message, wrap: true }] } }],
		}, {});
	}

	private async request(ctx: IWorkflowNodeContext, url: string | undefined, method: string, headers: Record<string, string>, body: WorkflowValue | undefined, query: Record<string, string>): Promise<IWorkflowNodeResult> {
		if (!url || !/^https?:\/\//i.test(url)) {
			throw new WorkflowNodeError(localize('voltWorkflows.badUrl', "The URL must start with http:// or https://."));
		}
		let target = url;
		const params = Object.entries(query);
		if (params.length) {
			target += (target.includes('?') ? '&' : '?') + params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
		}
		const sendsBody = body !== undefined && body !== null && body !== '' && method !== 'GET' && method !== 'HEAD';
		const data = sendsBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
		const hasType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
		const timeoutMs = this.timeoutOf(ctx, HTTP_TIMEOUT_MS);
		const started = Date.now();
		ctx.log('info', `${method} ${redactUrl(target)}`);
		let context;
		try {
			context = await this.requestService.request({
				type: method,
				url: target,
				headers: { ...(data !== undefined && !hasType && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
				...(data !== undefined ? { data } : {}),
				timeout: timeoutMs,
			}, ctx.token);
		} catch (err) {
			if (ctx.token.isCancellationRequested) {
				throw new CancellationError();
			}
			const message = errorText(err);
			return this.fail(ctx, localize('voltWorkflows.requestFailed', "The request failed: {0}", message), { error: message, durationMs: Date.now() - started }, true);
		}
		const status = context.res.statusCode ?? 0;
		const raw = await asText(context).catch(() => null) ?? '';
		const contentType = String(context.res.headers['content-type'] ?? '');
		const parsed = /json/i.test(contentType) || /^\s*[[{]/.test(raw) ? parseJson(raw) : undefined;
		const responseHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(context.res.headers)) {
			if (value !== undefined) {
				responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
			}
		}
		const ok = statusMatches(status, ctx.config.expectStatus);
		const output: Record<string, WorkflowValue> = {
			status,
			ok,
			headers: responseHeaders,
			body: parsed !== undefined ? clipValue(parsed) : clip(raw, OUTPUT_CHARS),
			durationMs: Date.now() - started,
		};
		if (!ok) {
			return this.fail(ctx, localize('voltWorkflows.badStatus', "The server answered {0}{1}", status, raw ? `: ${clip(raw.replace(/\s+/g, ' '), 200)}` : ''), output, status >= 500 || status === 429);
		}
		return { output, ...portOf(successPort(ctx)) };
	}

	//#endregion

	//#region Files

	/** Writes (or appends to) a file under the working folder; paths that leave it are refused. */
	private async writeFile(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		const folder = this.requireFolder();
		const path = text(ctx.config, 'path')?.trim();
		if (!path) {
			throw new WorkflowNodeError(localize('voltWorkflows.noPath', "The node has no file path."));
		}
		const target = /^(?:\/|[a-zA-Z]:[\\/])/.test(path) ? URI.file(path) : joinPath(folder, path);
		if (!isEqualOrParent(target, folder) || target.toString() === folder.toString()) {
			throw new WorkflowNodeError(localize('voltWorkflows.outside', "{0} is outside the workflow's folder.", path));
		}
		const raw = ctx.config.content;
		const content = typeof raw === 'string' ? raw : raw === undefined || raw === null ? inputText(ctx) : JSON.stringify(raw, null, 2);
		const mode = text(ctx.config, 'mode')?.toLowerCase() ?? 'overwrite';
		const append = mode === 'append';
		const exists = await this.fileService.exists(target);
		if (exists && mode === 'create') {
			return this.fail(ctx, localize('voltWorkflows.exists', "{0} already exists.", path), { path });
		}
		let before = '';
		if (append && exists) {
			before = (await this.fileService.readFile(target)).value.toString();
		}
		const next = append ? `${before}${before && !before.endsWith('\n') ? '\n' : ''}${content}` : content;
		await this.fileService.writeFile(target, VSBuffer.fromString(next));
		const relative = relativePath(folder, target) ?? path;
		ctx.log('info', localize('voltWorkflows.wrote', "Wrote {0} ({1} characters)", relative, next.length));
		return { output: { path: relative, uri: target.toString(), bytes: VSBuffer.fromString(next).byteLength, appended: append }, ...portOf(successPort(ctx)) };
	}

	//#endregion

	//#region Git

	/** A program run without a shell; where the stdio service has no `execFile`, a quoted command line. */
	private async execFile(ctx: IWorkflowNodeContext, file: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<IVoltExecFileResult> {
		const env = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
		if (this.stdio.execFile) {
			return raceCancellationError(this.stdio.execFile({ file, args, cwd, env, timeoutMs }), ctx.token);
		}
		const id = `wf-${generateUuid()}`;
		const cancel = ctx.token.onCancellationRequested(() => void this.stdio.cancelExec(id).catch(() => undefined));
		try {
			const result = await this.stdio.exec({ id, command: [file, ...args].map(quoteArg).join(' '), cwd, env, timeoutMs });
			if (result.cancelled) {
				throw new CancellationError();
			}
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(result.timedOut ? { error: 'timed out' } : {}) };
		} finally {
			cancel.dispose();
		}
	}

	private async git(ctx: IWorkflowNodeContext, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<IVoltExecFileResult> {
		// HostGit (B-03): the repository's fsmonitor, hooks and `ext::` remotes never run for a workflow step.
		const id = `wf-git-${generateUuid()}`;
		const cancel = ctx.token.onCancellationRequested(() => void this.stdio.cancelExec(id).catch(() => undefined));
		let result: IVoltExecFileResult;
		try {
			result = await raceCancellationError(runGitThrough(this.stdio, { id, cwd: this.requireFolder().fsPath, args, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs }), ctx.token);
		} finally {
			cancel.dispose();
		}
		// Debug only: a non-zero exit is often the answer (`diff --quiet`); real failures throw with git's message.
		ctx.log('debug', `git ${args.map(arg => arg.length > 80 ? `${arg.slice(0, 80)}…` : arg).join(' ')} → ${result.exitCode ?? result.error ?? '?'}`);
		return result;
	}

	/** Runs git and throws with its message when it fails. */
	private async gitOk(ctx: IWorkflowNodeContext, args: readonly string[], timeoutMs?: number): Promise<string> {
		const result = await this.git(ctx, args, timeoutMs);
		if (result.exitCode !== 0) {
			throw new WorkflowNodeError(gitError(args, result), false, { stdout: tail(result.stdout, OUTPUT_CHARS), stderr: tail(result.stderr, OUTPUT_CHARS) });
		}
		return result.stdout.trim();
	}

	private async currentBranch(ctx: IWorkflowNodeContext): Promise<string | undefined> {
		const result = await this.git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
		const branch = result.stdout.trim();
		return result.exitCode === 0 && branch && branch !== 'HEAD' ? branch : undefined;
	}

	private async branchExists(ctx: IWorkflowNodeContext, branch: string): Promise<boolean> {
		return (await this.git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0;
	}

	private async validBranch(ctx: IWorkflowNodeContext, branch: string): Promise<void> {
		if (branch.startsWith('-') || (await this.git(ctx, ['check-ref-format', '--branch', branch])).exitCode !== 0) {
			throw new WorkflowNodeError(localize('voltWorkflows.badBranch', "\"{0}\" is not a valid branch name.", branch));
		}
	}

	/** Anything else that broke (git missing, the stdio service gone) as a node failure. */
	private async gitStep(ctx: IWorkflowNodeContext, work: () => Promise<IWorkflowNodeResult>): Promise<IWorkflowNodeResult> {
		try {
			return await work();
		} catch (err) {
			if (err instanceof WorkflowNodeError || isCancellationError(err) || ctx.token.isCancellationRequested) {
				throw err;
			}
			return this.fail(ctx, errorText(err), undefined, isTransientFailure(errorText(err)));
		}
	}

	/** Stages everything (unless `addAll` is off) and commits; a clean tree leaves through `nothing`. */
	private gitCommit(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.gitStep(ctx, async () => {
			const message = text(ctx.config, 'message')?.trim();
			if (!message) {
				throw new WorkflowNodeError(localize('voltWorkflows.noMessage', "The commit needs a message."));
			}
			if (flag(ctx.config, 'addAll', true)) {
				await this.gitOk(ctx, ['add', '-A']);
			}
			if ((await this.git(ctx, ['diff', '--cached', '--quiet'])).exitCode !== 1) {
				ctx.log('info', localize('voltWorkflows.nothingToCommit', "Nothing to commit."));
				const head = (await this.git(ctx, ['rev-parse', 'HEAD'])).stdout.trim();
				const clean: WorkflowRecord = { sha: head || null, message, files: 0, committed: false };
				return { output: clean, ...portOf(hasPort(ctx, 'nothing') ? 'nothing' : successPort(ctx)) };
			}
			await this.gitOk(ctx, ['commit', '-m', message], SHELL_TIMEOUT_MS);
			const sha = await this.gitOk(ctx, ['rev-parse', 'HEAD']);
			const files = (await this.git(ctx, ['show', '--name-only', '--format=', 'HEAD'])).stdout.split('\n').filter(line => line.trim()).length;
			const committed: WorkflowRecord = { sha, message, files, committed: true, branch: await this.currentBranch(ctx) ?? null };
			return { output: committed, ...portOf(successPort(ctx)) };
		});
	}

	/** Pushes the checked out branch to its upstream's remote (origin when it has none). */
	private gitPush(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.gitStep(ctx, async () => {
			const branch = await this.currentBranch(ctx);
			if (!branch) {
				throw new WorkflowNodeError(localize('voltWorkflows.detached', "No branch is checked out (detached HEAD)."));
			}
			const upstream = await this.git(ctx, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`]);
			const tracked = upstream.exitCode === 0 ? upstream.stdout.trim() : undefined;
			const remote = (tracked ? (await this.git(ctx, ['config', '--get', `branch.${branch}.remote`])).stdout.trim() : '') || 'origin';
			const setUpstream = !tracked && flag(ctx.config, 'setUpstream', true);
			const result = await this.git(ctx, ['push', ...(setUpstream ? ['--set-upstream'] : []), remote, branch], PUSH_TIMEOUT_MS);
			if (result.exitCode !== 0) {
				throw new WorkflowNodeError(gitError(['push'], result), isTransientFailure(result.stderr), { branch, remote, stderr: tail(result.stderr, OUTPUT_CHARS) });
			}
			return { output: { branch, remote, setUpstream }, ...portOf(successPort(ctx)) };
		});
	}

	/**
	 * Brings the branch up to date with its base (`origin/<base>` after a fetch, else the local
	 * branch) by rebase or merge. A conflict is undone, so the checkout is never left halfway, and
	 * the run leaves through `conflict` with the files.
	 */
	private gitSync(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.gitStep(ctx, async () => {
			const base = text(ctx.config, 'base')?.trim() || 'main';
			if (base.startsWith('-')) {
				throw new WorkflowNodeError(localize('voltWorkflows.badRef', "Branch names cannot start with -."));
			}
			const rebase = (text(ctx.config, 'strategy')?.trim() || 'rebase').toLowerCase() !== 'merge';
			const fetched = await this.git(ctx, ['fetch', 'origin', base], PUSH_TIMEOUT_MS);
			const target = fetched.exitCode === 0 && (await this.git(ctx, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])).exitCode === 0 ? `origin/${base}` : base;
			if (target === base && !await this.branchExists(ctx, base)) {
				throw new WorkflowNodeError(fetched.exitCode !== 0 ? gitError(['fetch'], fetched) : localize('voltWorkflows.noBase', "There is no branch {0}.", base), fetched.exitCode !== 0 && isTransientFailure(fetched.stderr));
			}
			const behind = Number((await this.gitOk(ctx, ['rev-list', '--count', `HEAD..${target}`])) || 0);
			if (behind > 0) {
				const synced = await this.git(ctx, rebase ? ['rebase', '--autostash', target] : ['merge', '--autostash', '--no-edit', target], PUSH_TIMEOUT_MS);
				if (synced.exitCode !== 0) {
					const conflicts = (await this.git(ctx, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
					await this.git(ctx, rebase ? ['rebase', '--abort'] : ['merge', '--abort']);
					const message = conflicts.length
						? localize('voltWorkflows.conflicts', "Conflicts with {0} in {1}", target, conflicts.join(', '))
						: gitError([rebase ? 'rebase' : 'merge'], synced);
					return this.fail(ctx, message, { base, behind, conflicts });
				}
			}
			return { output: { base, behind, conflicts: [] }, ...portOf(successPort(ctx)) };
		});
	}

	/** Creates the branch (from `from`, else HEAD) and switches to it; an existing one is switched to. */
	private gitBranch(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.gitStep(ctx, async () => {
			const name = text(ctx.config, 'name')?.trim();
			if (!name) {
				throw new WorkflowNodeError(localize('voltWorkflows.noBranch', "Name the branch."));
			}
			await this.validBranch(ctx, name);
			const from = text(ctx.config, 'from')?.trim();
			if (from?.startsWith('-')) {
				throw new WorkflowNodeError(localize('voltWorkflows.badRef', "Branch names cannot start with -."));
			}
			const exists = await this.branchExists(ctx, name);
			await this.gitOk(ctx, exists ? ['checkout', name] : ['checkout', '-b', name, ...(from ? [from] : [])]);
			if (exists) {
				ctx.log('info', localize('voltWorkflows.branchExists', "{0} already existed; switched to it.", name));
			}
			return { output: { branch: name, created: !exists }, ...portOf(successPort(ctx)) };
		});
	}

	//#endregion

	//#region GitHub

	private async repo(): Promise<{ readonly folder: string; readonly repo: IVoltPrRepo }> {
		const folder = this.requireFolder().fsPath;
		const repo = await this.pullRequests.resolveRepo(folder);
		if (!repo) {
			throw new WorkflowNodeError(localize('voltWorkflows.noRepo', "The folder is not a git repository with a remote on a known host."));
		}
		return { folder, repo };
	}

	/** The pull request a node is about: its `number`, a URL, the input's (a Pull Request node's output), else the checked out branch's. */
	private async prNumber(ctx: IWorkflowNodeContext, folder: string, repo: IVoltPrRepo): Promise<number> {
		const direct = num(ctx.config, 'number', 'pr', 'pullRequest');
		if (direct !== undefined && Number.isInteger(direct) && direct > 0) {
			return direct;
		}
		const url = text(ctx.config, 'url', 'pr', 'pullRequest');
		const fromUrl = url ? /\/(?:pull|merge_requests)\/(\d+)/.exec(url) : null;
		if (fromUrl) {
			return Number(fromUrl[1]);
		}
		const input = ctx.input;
		if (input && typeof input === 'object' && !Array.isArray(input) && typeof (input as WorkflowRecord).number === 'number' && typeof (input as WorkflowRecord).url === 'string' && /\/(?:pull|merge_requests)\//.test((input as WorkflowRecord).url as string)) {
			return (input as WorkflowRecord).number as number;
		}
		const status = await this.pullRequests.gitStatus(folder);
		if (!status?.branch) {
			throw new WorkflowNodeError(localize('voltWorkflows.noPrBranch', "No pull request number, and no branch checked out to find one by."));
		}
		const found = await this.pullRequests.forBranch({ repo, branch: status.branch, background: true });
		const pr = found.find(candidate => candidate.state === 'open' || candidate.state === 'draft') ?? found[0];
		if (!pr) {
			throw new WorkflowNodeError(localize('voltWorkflows.noPr', "The branch {0} has no pull request.", status.branch));
		}
		return pr.number;
	}

	/** Pull request service failures as node failures (network and rate limits are retryable). */
	private async github(ctx: IWorkflowNodeContext, work: () => Promise<IWorkflowNodeResult>): Promise<IWorkflowNodeResult> {
		try {
			return await work();
		} catch (err) {
			if (ctx.token.isCancellationRequested) {
				throw new CancellationError();
			}
			if (err instanceof WorkflowNodeError || isCancellationError(err)) {
				throw err;
			}
			const code = voltPrErrorCode(err);
			const message = voltPrErrorMessage(err);
			return this.fail(ctx, message, { error: message, ...(code ? { code } : {}) }, code === 'network' || code === 'rateLimited');
		}
	}

	private async gh(ctx: IWorkflowNodeContext, folder: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
		const result = await this.execFile(ctx, 'gh', args, folder, timeoutMs);
		if (result.exitCode !== 0) {
			const message = (result.stderr.trim() || result.error || result.stdout.trim() || `gh exited with ${result.exitCode}`).split('\n')[0];
			throw new WorkflowNodeError(/not found|ENOENT/i.test(result.error ?? '') ? localize('voltWorkflows.noGh', "The GitHub CLI (gh) is not installed.") : message, isTransientFailure(message));
		}
		return result.stdout.trim();
	}

	private repoFlag(repo: IVoltPrRepo): string[] {
		const slug = repo.host === 'github.com' ? `${repo.owner}/${repo.name}` : `${repo.host}/${repo.owner}/${repo.name}`;
		return /^[\w.-]+(?:\/[\w.-]+){1,2}$/.test(slug) ? ['-R', slug] : [];
	}

	private githubPr(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.github(ctx, async () => {
			const { folder, repo } = await this.repo();
			const status = await this.pullRequests.gitStatus(folder);
			const head = status?.branch;
			if (!head || status.isDefaultBranch) {
				throw new WorkflowNodeError(localize('voltWorkflows.prOnDefault', "Commit on a new branch first (not the default branch)."));
			}
			const base = text(ctx.config, 'base')?.trim() || status.defaultBranch || 'main';
			const title = text(ctx.config, 'title')?.trim() || head;
			const body = text(ctx.config, 'body') ?? '';
			const draft = flag(ctx.config, 'draft', false);
			// A run that is retried, or a branch that already has one, answers with the open pull request.
			const existing = (await this.pullRequests.forBranch({ repo, branch: head, background: true })).find(pr => pr.state === 'open' || pr.state === 'draft');
			if (existing) {
				ctx.log('info', localize('voltWorkflows.prExists', "{0} already has #{1}.", head, existing.number));
				return { output: { number: existing.number, url: existing.url, title: existing.title, head, base: existing.baseRefName, draft: existing.state === 'draft', existing: true }, ...portOf(successPort(ctx)) };
			}
			// The branch must be on the remote before the host can open a pull request from it.
			await this.pullRequests.push({ folder });
			const created = await this.pullRequests.create({ repo, head, base, title, body, draft });
			ctx.log('info', localize('voltWorkflows.prOpened', "Opened {0}", created.url));
			return { output: { number: created.number, url: created.url, title: created.title, head, base, draft, existing: false }, ...portOf(successPort(ctx)) };
		});
	}

	/** Waits for the pull request's checks with `gh pr checks --watch` (cancellable), then reads them. */
	private githubWaitCi(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.github(ctx, async () => {
			const { folder, repo } = await this.repo();
			if (repo.provider !== 'github') {
				throw new WorkflowNodeError(localize('voltWorkflows.ciGithubOnly', "Waiting for checks works with GitHub repositories."));
			}
			const number = await this.prNumber(ctx, folder, repo);
			const timeoutMs = this.timeoutOf(ctx, CI_TIMEOUT_MS);
			const interval = 15;
			const waiting = ctx.waiting(localize('voltWorkflows.waitingCi', "CI checks of #{0}", number));
			const id = `wf-${generateUuid()}`;
			const cancel = ctx.token.onCancellationRequested(() => void this.stdio.cancelExec(id).catch(() => undefined));
			let watched;
			try {
				// Only integers and a validated slug go into the command line.
				watched = await this.stdio.exec({ id, command: ['gh', 'pr', 'checks', String(number), '--watch', '--interval', String(interval), ...this.repoFlag(repo)].join(' '), cwd: folder, env: { GH_PROMPT_DISABLED: '1' }, timeoutMs, inlineChars: OUTPUT_CHARS });
			} finally {
				cancel.dispose();
				waiting.dispose();
			}
			if (ctx.token.isCancellationRequested || watched.cancelled) {
				throw new CancellationError();
			}
			const none = /no checks reported/i.test(`${watched.stderr}${watched.stdout}`);
			let checks: { name: string; state: string; bucket?: string; link?: string }[] = [];
			try {
				const json = await this.gh(ctx, folder, ['pr', 'checks', String(number), '--json', 'name,state,bucket,link', ...this.repoFlag(repo)]);
				checks = (parseJson(json) as typeof checks | undefined) ?? [];
			} catch {
				// Older gh without --json: the watch's exit code says enough.
			}
			// gh's buckets: pass, fail, pending, skipping, cancel.
			const conclusionOf = (bucket: string | undefined, state: string) => bucket === 'pass' ? 'success' : bucket === 'fail' ? 'failure' : bucket === 'cancel' ? 'cancelled' : bucket === 'skipping' ? 'skipped' : bucket === 'pending' ? 'pending' : state.toLowerCase();
			const failed = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel').map(check => check.name);
			const output: Record<string, WorkflowValue> = {
				number,
				conclusion: watched.timedOut ? 'timed_out' : none || watched.exitCode === 0 ? 'success' : 'failure',
				checks: checks.map(check => ({ name: check.name, conclusion: conclusionOf(check.bucket, check.state), ...(check.link ? { url: check.link } : {}) })),
				failed,
			};
			if (watched.timedOut) {
				if (hasPort(ctx, 'timeout')) {
					return { output, port: 'timeout' };
				}
				return this.fail(ctx, localize('voltWorkflows.ciTimeout', "The checks of #{0} did not finish within {1} min.", number, Math.round(timeoutMs / 60_000)), output);
			}
			if (watched.exitCode !== 0 && !none) {
				return this.fail(ctx, failed.length ? localize('voltWorkflows.ciFailed', "Failing checks: {0}", failed.join(', ')) : localize('voltWorkflows.ciFailedPlain', "The checks of #{0} failed.", number), output);
			}
			return { output, ...portOf(successPort(ctx)) };
		});
	}

	private githubPrComment(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.github(ctx, async () => {
			const { folder, repo } = await this.repo();
			const body = text(ctx.config, 'body')?.trim() || inputText(ctx);
			if (!body.trim()) {
				throw new WorkflowNodeError(localize('voltWorkflows.noComment', "The comment is empty."));
			}
			const number = await this.prNumber(ctx, folder, repo);
			await this.pullRequests.comment({ repo, number, body });
			return { output: { number, url: prUrl(repo, number) }, ...portOf(successPort(ctx)) };
		});
	}

	/** Ready for review, labels added, reviewers requested: whichever the node sets. */
	private githubUpdatePr(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.github(ctx, async () => {
			const { folder, repo } = await this.repo();
			const number = await this.prNumber(ctx, folder, repo);
			const changed: string[] = [];
			if (flag(ctx.config, 'ready', false)) {
				await this.pullRequests.setDraft({ repo, number, draft: false });
				changed.push('ready');
			}
			const labels = list(ctx.config, 'labels');
			if (labels.length) {
				await this.pullRequests.setLabels({ repo, number, add: labels, remove: [] });
				changed.push('labels');
			}
			const reviewers = list(ctx.config, 'reviewers').map(login => login.replace(/^@/, ''));
			if (reviewers.length) {
				await this.pullRequests.requestReviewers({ repo, number, logins: reviewers });
				changed.push('reviewers');
			}
			if (!changed.length) {
				ctx.log('warn', localize('voltWorkflows.prNothing', "Nothing to change on #{0}.", number));
			}
			return { output: { number, url: prUrl(repo, number), changed }, ...portOf(successPort(ctx)) };
		});
	}

	/** Through the GitHub CLI: the pull request service has no issue comments. */
	private githubIssueComment(ctx: IWorkflowNodeContext): Promise<IWorkflowNodeResult> {
		return this.github(ctx, async () => {
			const { folder, repo } = await this.repo();
			const issue = num(ctx.config, 'issue');
			if (issue === undefined || !Number.isInteger(issue) || issue <= 0) {
				throw new WorkflowNodeError(localize('voltWorkflows.noIssue', "The issue number is missing."));
			}
			const body = text(ctx.config, 'body')?.trim() || inputText(ctx);
			if (!body.trim()) {
				throw new WorkflowNodeError(localize('voltWorkflows.noComment', "The comment is empty."));
			}
			const printed = await this.gh(ctx, folder, ['issue', 'comment', String(issue), '--body', body, ...this.repoFlag(repo)]);
			const url = printed.split('\n').map(line => line.trim()).reverse().find(line => /^https?:\/\//.test(line)) ?? `${repo.webUrl}/issues/${issue}`;
			return { output: { issue, url }, ...portOf(successPort(ctx)) };
		});
	}

	//#endregion

	//#region Results

	/** The node's `timeout` field, else its step timeout, else the kind's default. */
	private timeoutOf(ctx: IWorkflowNodeContext, fallback: number): number {
		return parseWorkflowDuration(ctx.config.timeout) || ctx.node.timeoutMs || fallback;
	}

	/**
	 * A failure, thrown so the engine applies the node's retry policy (when `retryable`) and then
	 * its error handling: a wired failure port (`failed`, `fail`, `conflict`), else the run fails.
	 */
	private fail(_ctx: IWorkflowNodeContext, message: string, output: WorkflowValue | undefined, retryable = false): never {
		const value: WorkflowValue = output && typeof output === 'object' && !Array.isArray(output)
			? { ...(output as WorkflowRecord), error: message }
			: output === undefined || output === null ? { error: message } : { value: output, error: message };
		throw new WorkflowNodeError(message, retryable, value);
	}

	//#endregion
}

//#region Helpers

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A config value as text: the first key that holds a string (or a number or boolean). */
function text(config: WorkflowRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = config[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
	}
	return undefined;
}

function num(config: WorkflowRecord, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = config[key];
		const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim().replace(/^#/, '')) : Number.NaN;
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function flag(config: WorkflowRecord, key: string, fallback: boolean): boolean {
	const value = config[key];
	return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback;
}

/** A list field: an array, or one entry per line or comma. */
function list(config: WorkflowRecord, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = config[key];
		if (Array.isArray(value)) {
			const entries = value.map(entry => typeof entry === 'string' ? entry.trim() : typeof entry === 'number' ? String(entry) : '').filter(Boolean);
			if (entries.length) {
				return entries;
			}
		} else if (typeof value === 'string' && value.trim()) {
			return value.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean);
		}
	}
	return [];
}

/** A `keyValue` field (headers, env, query) as text values; empty names and values left out. */
function pairs(value: WorkflowValue | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, entry] of Object.entries(keyValueRecord(value))) {
		if (name.trim() && entry !== undefined && entry !== null) {
			out[name.trim()] = typeof entry === 'string' ? entry : JSON.stringify(entry);
		}
	}
	return out;
}

/** `expectStatus`: a code, a list of codes, `2xx`-style classes, or `200-299`; 2xx when absent. */
function statusMatches(status: number, expected: WorkflowValue | undefined): boolean {
	const entries = expected === undefined || expected === null || expected === ''
		? ['2xx']
		: Array.isArray(expected) ? expected.map(String) : String(expected).split(/[\s,]+/).filter(Boolean);
	return entries.some(entry => {
		const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(entry);
		if (range) {
			return status >= Number(range[1]) && status <= Number(range[2]);
		}
		const klass = /^([1-5])xx$/i.exec(entry);
		if (klass) {
			return Math.floor(status / 100) === Number(klass[1]);
		}
		return Number(entry) === status;
	});
}

function parseJson(raw: string): WorkflowValue | undefined {
	try {
		return JSON.parse(raw) as WorkflowValue;
	} catch {
		return undefined;
	}
}

function stripFence(value: string): string {
	const fence = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(value);
	return fence ? fence[1] : value;
}

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value;
}

function tail(value: string, max: number): string {
	return value.length > max ? `… (${value.length - max} earlier characters)\n${value.slice(value.length - max)}` : value;
}

/** A parsed body kept whole when small, else as clipped JSON text. */
function clipValue(value: WorkflowValue): WorkflowValue {
	const json = JSON.stringify(value);
	return json.length > OUTPUT_CHARS ? clip(json, OUTPUT_CHARS) : value;
}

function lastLine(value: string): string | undefined {
	const line = value.trim().split('\n').pop()?.trim();
	return line ? (line.length > 200 ? `${line.slice(0, 200)}…` : line) : undefined;
}

/** Upstream input as text for a prompt: a string, an agent's `summary`, else JSON. */
function inputText(ctx: IWorkflowNodeContext): string {
	const explicit = ctx.config.input ?? ctx.config.text;
	const value = explicit !== undefined && explicit !== null && explicit !== '' ? explicit : ctx.input;
	if (typeof value === 'string') {
		return value;
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const key of ['summary', 'text', 'body', 'stdout', 'answer']) {
			const field = (value as WorkflowRecord)[key];
			if (typeof field === 'string' && field.trim()) {
				return field;
			}
		}
	}
	return value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
}

/** The reply without its trailing `VERDICT:` line, and the verdict when it is one of `allowed` (case-insensitive). */
export function splitVerdict(reply: string, allowed: readonly string[]): { readonly summary: string; readonly verdict?: string } {
	const pattern = /^[ \t>*_`#-]*VERDICT[*_`]*\s*:\s*[*_`]*\s*(.+?)\s*[*_`.]*\s*$/gim;
	let match: RegExpExecArray | null;
	let last: RegExpExecArray | undefined;
	while ((match = pattern.exec(reply))) {
		last = match;
	}
	if (!last) {
		return { summary: reply.trim() };
	}
	const named = last[1].replace(/^[<"'`]+|[>"'`]+$/g, '').trim().toLowerCase();
	const verdict = allowed.find(candidate => candidate.toLowerCase() === named);
	const summary = `${reply.slice(0, last.index)}${reply.slice(last.index + last[0].length)}`.trim();
	return { summary, ...(verdict ? { verdict } : {}) };
}

function hasPort(ctx: IWorkflowNodeContext, id: string): boolean {
	return ctx.type.outputs(ctx.config).some(port => port.id === id);
}

/** The port a successful step leaves through: the type's success port, else its first that is not a failure. */
function successPort(ctx: IWorkflowNodeContext): string | undefined {
	const ports = ctx.type.outputs(ctx.config);
	return (ports.find(port => port.kind === 'success') ?? ports.find(port => port.kind !== 'failure' && port.id !== 'failed' && port.id !== 'timeout'))?.id;
}

function portOf(port: string | undefined): { readonly port?: string } {
	return port ? { port } : {};
}

function prUrl(repo: IVoltPrRepo, number: number): string {
	return `${repo.webUrl.replace(/\/+$/, '')}/${repo.provider === 'gitlab' ? '-/merge_requests' : 'pull'}/${number}`;
}

function gitError(args: readonly string[], result: IVoltExecFileResult): string {
	const detail = (result.stderr.trim() || result.error || result.stdout.trim()).split('\n').filter(line => line.trim()).slice(-3).join(' ');
	return `git ${args[0]} failed${detail ? `: ${detail}` : ''}`;
}

/** Hides credentials in a URL for the log. */
function redactUrl(url: string): string {
	return url.replace(/\/\/[^/@]+@/, '//***@').replace(/([?&](?:token|key|secret|signature|sig|password)=)[^&]+/gi, '$1***');
}

/** Only used where the stdio service has no `execFile`. */
function quoteArg(arg: string): string {
	if (/^[\w@%+=:,./-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

//#endregion

/** Cancellable delay for the engine (wait nodes, retry back-off). */
export function workflowDelay(ms: number, token: CancellationToken): Promise<void> {
	return timeout(Math.max(0, ms), token);
}
