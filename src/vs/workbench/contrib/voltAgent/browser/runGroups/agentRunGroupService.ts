/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { dirname, normalize } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltUsageService } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService, IOrchPrompt } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { threadStatus } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import {
	accumulateRunUsage,
	EMPTY_RUN_USAGE,
	estimateRunGroup,
	IAgentRunGroupService,
	IRunCostHistory,
	IRunDiffTarget,
	IRunGroup,
	IRunGroupEstimate,
	IRunGroupModel,
	IRunGroupPrompt,
	IRunGroupRollup,
	IRunGroupRun,
	IRunGroupStartRequest,
	IRunSetup,
	IRunSetupStep,
	IRunStats,
	IRunWinnerResult,
	runBranchNames,
	runGroupRollup,
	runGroupTitle,
	RunFollowUpTarget,
	RunStatus,
	runStatus,
	runStopPlan,
	RunWinnerAction,
	runWinnerPlan,
	trackRunClock,
	validateRunSelection,
} from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import {
	currentSetupStep,
	IWorktreeSetupConfig,
	parseWorktreeSetup,
	setupFileIn,
	setupOutputTail,
	WORKTREE_SETUP_FILES,
	WORKTREE_SETUP_TIMEOUT_MS,
	worktreeSetupCommand,
	worktreeSetupEnv,
} from '../../../../services/voltRuntime/common/runGroups/worktreeSetup.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { stashTurnDisplay } from '../orchestration/agentTurnDisplays.js';
import { attachSessionToProject } from '../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

const STORE_VERSION = 1;
/** Why a run's chat is held: its worktree or setup is not ready. */
const SETUP_BLOCK = 'worktree';
const PERSIST_DELAY_MS = 800;
const STATS_DELAY_MS = 1500;
const POLL_MS = 1000;
const CREATE_PULL_REQUEST_COMMAND_ID = 'volt.pullRequest.create';
/** Groups kept in the store; older archived ones drop off. */
const MAX_GROUPS = 200;

interface IStoredGroups {
	readonly version: number;
	readonly groups: readonly IRunGroup[];
}

interface ISetupToken {
	cancelled: boolean;
	execId?: string;
}

export class AgentRunGroupService extends Disposable implements IAgentRunGroupService {

	declare readonly _serviceBrand: undefined;

	private readonly groups = new Map<string, IRunGroup>();
	private readonly groupBySession = new Map<string, string>();
	private readonly setups = new Map<string, ISetupToken>();
	private readonly statsTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly statsInFlight = new Map<string, Promise<void>>();
	/** The run's last snapshot, so an unchanged worktree reuses it instead of writing a new commit. */
	private readonly lastSnapshot = new Map<string, { readonly commit: string; readonly tree: string }>();
	private readonly lastStatus = new Map<string, RunStatus>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private persisting: Promise<void> = Promise.resolve();
	private readonly storeFile: URI;
	private readonly indexDir: URI;
	private readonly ready = new DeferredPromise<void>();
	readonly whenReady: Promise<void> = this.ready.p;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IVoltGitService private readonly git: IVoltGitService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentWorkspaceService private readonly workspace: IAgentWorkspaceService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const home = joinPath(environmentService.userRoamingDataHome, 'voltRunGroups');
		this.storeFile = joinPath(home, 'groups.json');
		this.indexDir = joinPath(home, 'index');
		this._register(orchestrator.onDidChange(change => this.onOrchestratorChange(change.threads)));
		this._register(runtime.onDidEmit(envelope => {
			const groupId = this.groupBySession.get(envelope.sessionId);
			if (!groupId) {
				return;
			}
			const event = envelope.event;
			if (event.type === 'usage') {
				this.updateRun(groupId, envelope.sessionId, run => ({ ...run, usage: accumulateRunUsage(run.usage, event) }));
			} else if (event.type === 'run.end' || event.type === 'tool.end') {
				// One run's activity does not mean its siblings changed: refresh only that run.
				this.scheduleStats(groupId, envelope.sessionId);
			}
		}));
		this._register(toDisposable(() => {
			if (this.persistTimer !== undefined) {
				clearTimeout(this.persistTimer);
			}
			for (const timer of this.statsTimers.values()) {
				clearTimeout(timer);
			}
			for (const token of this.setups.values()) {
				token.cancelled = true;
			}
		}));
		void this.restore();
	}

	//#region Read

	list(): readonly IRunGroup[] {
		return [...this.groups.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	get(groupId: string): IRunGroup | undefined {
		return this.groups.get(groupId);
	}

	groupOf(sessionId: string): IRunGroup | undefined {
		const groupId = this.groupBySession.get(sessionId);
		return groupId ? this.groups.get(groupId) : undefined;
	}

	runStatus(groupId: string, runId: string): RunStatus {
		const run = this.groups.get(groupId)?.runs.find(candidate => candidate.id === runId);
		if (!run) {
			return 'failed';
		}
		const state = this.orchestrator.getState();
		const thread = state.threads[runId];
		return runStatus(run, thread ? { status: threadStatus(state, runId), turns: thread.turns, ...(thread.last ? { lastOutcome: thread.last.outcome } : {}) } : undefined);
	}

	rollup(groupId: string): IRunGroupRollup {
		const group = this.groups.get(groupId);
		return runGroupRollup(group ? group.runs.filter(run => !run.discarded).map(run => this.runStatus(groupId, run.id)) : []);
	}

	//#endregion

	//#region Start

	async start(request: IRunGroupStartRequest): Promise<IRunGroup> {
		await this.whenReady;
		const check = validateRunSelection(request.models);
		if (!check.ok) {
			throw new Error(check.reason);
		}
		const repoRoot = request.repoRoot;
		const branches = await this.git.listBranches({ repoRoot }).catch(() => undefined);
		if (!branches) {
			throw new Error('Running several models needs a git repository: each one gets its own worktree.');
		}
		if (branches.unborn) {
			throw new Error('This repository has no commits yet. Make a first commit to use worktrees.');
		}
		const baseRef = request.baseRef ?? branches.head;
		const commit = await this.revParse(repoRoot, baseRef ?? 'HEAD');
		if (!commit) {
			throw new Error(`Could not find ${baseRef ?? 'HEAD'} to start the runs from.`);
		}
		const names = runBranchNames(request.prompt.text, request.models, new Set(branches.local));
		const title = runGroupTitle(request.prompt.text);
		const group: IRunGroup = {
			id: `rg-${generateUuid().slice(0, 8)}`,
			title,
			prompt: request.prompt,
			createdAt: Date.now(),
			repoRoot,
			...(request.projectId ? { projectId: request.projectId } : {}),
			base: { ...(baseRef ? { ref: baseRef } : {}), commit },
			runs: request.models.map((model, index) => ({
				id: `agent-${generateUuid()}`,
				model,
				branch: names[index],
				setup: { state: 'pending', steps: [] },
				usage: EMPTY_RUN_USAGE,
				workMs: 0,
			})),
			followUp: 'selected',
		};
		this.groups.set(group.id, group);
		for (const run of group.runs) {
			this.groupBySession.set(run.id, group.id);
		}
		await this.persistNow();
		this._onDidChange.fire(group.id);
		// Each run starts on its own: one failing never holds back or rolls back the others.
		for (const run of group.runs) {
			void this.launch(group.id, run.id, request.liveDisplay).catch(err => this.failSetup(group.id, run.id, err));
		}
		return group;
	}

	/** The run's chat: bound to the project, held by a block with its prompt queued, then its worktree. */
	private async launch(groupId: string, runId: string, liveDisplay: unknown): Promise<void> {
		// Registered before the first await, so Stop finds the run's setup however early it comes.
		const token: ISetupToken = { cancelled: false };
		this.setups.set(runId, token);
		const group = this.groups.get(groupId)!;
		const run = group.runs.find(candidate => candidate.id === runId)!;
		const project = this.projectFor(group);
		if (project) {
			attachSessionToProject(this.sessionContext, this.workspace, this.history, runId, project);
		}
		await this.orchestrator.dispatch({ type: 'thread.block', threadId: runId, reason: SETUP_BLOCK });
		const turnId = generateUuid();
		if (liveDisplay) {
			stashTurnDisplay(turnId, liveDisplay as Parameters<typeof stashTurnDisplay>[1]);
		}
		const result = await this.orchestrator.submit(runId, this.promptFor(run, group.prompt), 'auto', turnId);
		if (result.outcome === 'rejected') {
			throw new Error(result.reason ?? 'The orchestrator did not take the prompt.');
		}
		await this.prepare(groupId, runId, 0, token);
	}

	private promptFor(run: IRunGroupRun, prompt: IRunGroupPrompt): IOrchPrompt {
		return {
			text: prompt.text,
			...(prompt.display !== undefined ? { display: prompt.display } : {}),
			...(prompt.mode ? { mode: prompt.mode } : {}),
			modelRef: run.model.ref,
			...(run.model.options ? { options: run.model.options } : {}),
		};
	}

	/** Worktree, then setup steps from `fromStep`, then the chat is let go and its prompt runs. */
	private async prepare(groupId: string, runId: string, fromStep: number, token: ISetupToken = { cancelled: false }): Promise<void> {
		this.setups.set(runId, token);
		const startedAt = Date.now();
		try {
			this.updateRun(groupId, runId, run => ({ ...run, setup: { ...run.setup, state: 'worktree', startedAt, error: undefined, endedAt: undefined } }));
			const group = this.groups.get(groupId)!;
			let run = group.runs.find(candidate => candidate.id === runId)!;
			if (!run.worktreePath) {
				const created = await this.worktrees.create(group.repoRoot, { kind: 'new', name: run.branch, from: group.base.commit });
				this.updateRun(groupId, runId, current => ({ ...current, worktreePath: created.path }));
				// The base travels with the branch, so diffs and merges read it from git too.
				void this.worktrees.git(group.repoRoot, ['config', `branch.${run.branch}.volt-base`, group.base.ref ?? group.base.commit]);
			} else {
				await this.worktrees.ensure(group.repoRoot, run.worktreePath, run.branch);
			}
			run = this.groups.get(groupId)!.runs.find(candidate => candidate.id === runId)!;
			const path = run.worktreePath!;
			this.runtime.rememberWorktree(runId, path, run.branch);
			this.history.open(runId).setMeta({ worktreePath: path, worktreeBranch: run.branch, model: run.model.label });
			this.throwIfCancelled(token);

			const config = await this.readSetupConfig(path, group.repoRoot);
			if (config) {
				const steps: IRunSetupStep[] = config.steps.map((command, index) => {
					const previous = run.setup.steps[index];
					return index < fromStep && previous?.state === 'done' ? previous : { command, state: 'pending' };
				});
				this.updateRun(groupId, runId, current => ({ ...current, setup: { ...current.setup, state: 'running', source: config.source, steps } }));
				await this.runSetup(groupId, runId, config, path, fromStep, token);
			}
			this.throwIfCancelled(token);
			this.updateRun(groupId, runId, current => ({ ...current, setup: { ...current.setup, state: 'done', endedAt: Date.now() } }));
			await this.orchestrator.dispatch({ type: 'thread.block', threadId: runId, reason: undefined });
		} catch (err) {
			if (token.cancelled) {
				this.updateRun(groupId, runId, current => ({
					...current,
					setup: { ...current.setup, state: 'cancelled', endedAt: Date.now(), error: 'Stopped.', steps: current.setup.steps.map(step => step.state === 'running' || step.state === 'pending' ? { ...step, state: 'cancelled' } : step) },
				}));
			} else {
				this.failSetup(groupId, runId, err);
			}
		} finally {
			if (this.setups.get(runId) === token) {
				this.setups.delete(runId);
			}
		}
	}

	private failSetup(groupId: string, runId: string, err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.logService.warn(`[volt run groups] ${runId}: setup failed: ${message}`);
		this.updateRun(groupId, runId, current => ({
			...current,
			setup: { ...current.setup, state: 'failed', endedAt: Date.now(), error: message, steps: current.setup.steps.map(step => step.state === 'running' ? { ...step, state: 'failed' } : step) },
		}));
	}

	private throwIfCancelled(token: ISetupToken): void {
		if (token.cancelled) {
			throw new Error('Stopped.');
		}
	}

	/** `.volt/worktrees.json`, else Cursor's `.cursor/worktrees.json`; the worktree's copy first, then the checkout's. */
	private async readSetupConfig(worktreePath: string, repoRoot: string): Promise<IWorktreeSetupConfig | undefined> {
		const platform = isWindows ? 'windows' : 'unix';
		for (const folder of [worktreePath, repoRoot]) {
			for (const source of WORKTREE_SETUP_FILES) {
				const file = setupFileIn(folder, source);
				let text: string;
				try {
					text = (await this.fileService.readFile(URI.file(file))).value.toString();
				} catch {
					continue;
				}
				const parsed = parseWorktreeSetup(text, source, dirname(file), platform);
				switch (parsed.kind) {
					case 'none':
						return undefined;
					case 'error':
						throw new Error(parsed.error);
					case 'config':
						return parsed.config;
				}
			}
		}
		return undefined;
	}

	/** One shell for every step (Cursor's semantics), progress read from its step markers. */
	private async runSetup(groupId: string, runId: string, config: IWorktreeSetupConfig, worktreePath: string, fromStep: number, token: ISetupToken): Promise<void> {
		const group = this.groups.get(groupId)!;
		const run = group.runs.find(candidate => candidate.id === runId)!;
		const platform = isWindows ? 'windows' : 'unix';
		const script = worktreeSetupCommand(config, worktreePath, platform, fromStep);
		const execId = `volt-setup-${runId.slice(-8)}-${generateUuid().slice(0, 4)}`;
		token.execId = execId;
		const started = Date.now();
		let output = '';
		let offset = 0;
		const apply = (exitCode?: number | null) => {
			const current = Math.max(fromStep, currentSetupStep(output));
			const tail = setupOutputTail(output);
			const now = Date.now();
			this.updateRun(groupId, runId, value => ({
				...value,
				setup: {
					...value.setup,
					steps: value.setup.steps.map((step, index): IRunSetupStep => {
						if (index < fromStep && step.state === 'done') {
							return step;
						}
						if (index < current) {
							return step.state === 'done' ? step : { ...step, state: 'done', endedAt: step.endedAt ?? now };
						}
						if (index === current) {
							if (exitCode === undefined) {
								return { ...step, state: 'running', startedAt: step.startedAt ?? now, tail };
							}
							return { ...step, state: exitCode === 0 ? 'done' : 'failed', startedAt: step.startedAt ?? started, endedAt: now, exitCode, tail };
						}
						return exitCode === 0 ? { ...step, state: 'done', endedAt: now } : step;
					}),
				},
			}));
		};
		const first = await this.stdio.exec({
			id: execId,
			command: platform === 'windows' ? script : `bash -c ${shellQuote(script)}`,
			cwd: worktreePath,
			env: worktreeSetupEnv({ repoRoot: group.repoRoot, worktreePath, branch: run.branch, model: run.model.label }),
			timeoutMs: WORKTREE_SETUP_TIMEOUT_MS,
			background: true,
			backgroundWaitMs: 400,
			inlineChars: 20_000,
		});
		output = first.combined;
		let running = first.running;
		let exitCode = first.exitCode;
		let timedOut = first.timedOut;
		if (running) {
			const job = await this.stdio.jobOutput(execId, 0);
			if (job) {
				output = job.output;
				offset = job.offset;
			}
		}
		while (running && !token.cancelled) {
			if (Date.now() - started >= WORKTREE_SETUP_TIMEOUT_MS) {
				// A background job has no timer of its own once exec returned.
				await this.stdio.cancelExec(execId).catch(() => undefined);
				timedOut = true;
				exitCode = null;
				break;
			}
			apply();
			const job = await this.stdio.jobWait(execId, POLL_MS * 5, undefined, offset);
			if (!job) {
				break;
			}
			output += job.output;
			offset = job.offset;
			running = job.running;
			exitCode = job.exitCode;
		}
		if (token.cancelled) {
			await this.stdio.cancelExec(execId).catch(() => undefined);
			throw new Error('Stopped.');
		}
		apply(exitCode ?? 1);
		if (exitCode !== 0) {
			const failed = this.groups.get(groupId)!.runs.find(candidate => candidate.id === runId)!.setup.steps.find(step => step.state === 'failed');
			throw new Error(timedOut
				? `Setup did not finish within ${Math.round(WORKTREE_SETUP_TIMEOUT_MS / 60_000)} minutes.`
				: `Setup failed${failed ? ` at \`${failed.command}\`` : ''} (exit code ${exitCode ?? 'unknown'}).`);
		}
	}

	//#endregion

	//#region Control

	async stop(groupId: string): Promise<void> {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}
		const plan = runStopPlan(group, runId => this.runStatus(groupId, runId));
		for (const runId of plan.abortSetup) {
			const token = this.setups.get(runId);
			if (token) {
				token.cancelled = true;
				if (token.execId) {
					void this.stdio.cancelExec(token.execId).catch(() => undefined);
				}
			}
		}
		await Promise.all([
			...plan.cancel.map(runId => this.orchestrator.cancel(runId, { cascade: 'all' })),
			...plan.pause.map(runId => this.orchestrator.dispatch({ type: 'queue.pause', threadId: runId, reason: 'stopped' })),
		]);
		this._onDidChange.fire(groupId);
	}

	async retrySetup(groupId: string, runId: string): Promise<void> {
		const run = this.groups.get(groupId)?.runs.find(candidate => candidate.id === runId);
		if (!run || (run.setup.state !== 'failed' && run.setup.state !== 'cancelled')) {
			return;
		}
		await this.orchestrator.ensureThreadLoaded(runId);
		const thread = this.orchestrator.getThread(runId);
		if (!thread?.queue.length && !thread?.turns) {
			// The prompt never reached the chat (it failed before it was queued): queue it again.
			const group = this.groups.get(groupId)!;
			await this.orchestrator.dispatch({ type: 'thread.block', threadId: runId, reason: SETUP_BLOCK });
			await this.orchestrator.submit(runId, this.promptFor(run, group.prompt), 'auto');
		}
		const failedAt = run.setup.steps.findIndex(step => step.state !== 'done');
		await this.prepare(groupId, runId, failedAt < 0 ? 0 : failedAt);
	}

	async followUp(groupId: string, target: string | 'all', prompt: IRunGroupPrompt): Promise<void> {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}
		const runs = group.runs.filter(run => !run.discarded && (target === 'all' || run.id === target));
		await Promise.all(runs.map(run => this.orchestrator.submit(run.id, this.promptFor(run, prompt), 'auto')));
	}

	setFollowUpTarget(groupId: string, target: RunFollowUpTarget): void {
		this.updateGroup(groupId, group => group.followUp === target ? group : { ...group, followUp: target });
	}

	async archive(groupId: string): Promise<void> {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}
		this.updateGroup(groupId, value => ({ ...value, archived: true }));
		await Promise.all(group.runs.filter(run => this.history.get(run.id)).map(run => this.history.setArchived(run.id, true)));
	}

	//#endregion

	//#region Stats and diffs

	/** Refreshes every run in the group. Used by the UI (Refresh, opening the compare view, after a winner). */
	async refreshStats(groupId: string): Promise<void> {
		return this.refreshRunStats(groupId, undefined);
	}

	/** `runId` set: only that run (a single run's activity does not mean its siblings changed). Undefined: the whole group. */
	private refreshRunStats(groupId: string, runId: string | undefined): Promise<void> {
		const key = runId ? `${groupId}\0${runId}` : groupId;
		const pending = this.statsInFlight.get(key);
		if (pending) {
			return pending;
		}
		const work = this.readStats(groupId, runId).finally(() => this.statsInFlight.delete(key));
		this.statsInFlight.set(key, work);
		return work;
	}

	/** `runId` set: debounce and refresh just that run; undefined: the whole group. */
	private scheduleStats(groupId: string, runId?: string): void {
		const key = runId ? `${groupId}\0${runId}` : groupId;
		const existing = this.statsTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.statsTimers.set(key, setTimeout(() => {
			this.statsTimers.delete(key);
			void this.refreshRunStats(groupId, runId);
		}, STATS_DELAY_MS));
	}

	private async readStats(groupId: string, onlyRunId: string | undefined): Promise<void> {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}
		const targets = onlyRunId ? group.runs.filter(run => run.id === onlyRunId) : group.runs;
		await Promise.all(targets.map(async run => {
			if (!run.worktreePath || run.worktreeRemoved) {
				return;
			}
			try {
				const stats = await this.statsFor(group, run);
				this.updateRun(groupId, run.id, current => ({ ...current, stats }));
			} catch (err) {
				this.logService.warn(`[volt run groups] could not read changes of ${run.branch}`, err);
			}
		}));
	}

	private async statsFor(group: IRunGroup, run: IRunGroupRun): Promise<IRunStats> {
		const snapshot = await this.snapshot(group, run);
		const entries = await this.git.diffSummary({ repoRoot: group.repoRoot, from: group.base.commit, to: snapshot });
		const lastMessage = await this.lastMessage(run.id);
		return {
			files: entries.length,
			additions: entries.reduce((sum, entry) => sum + entry.additions, 0),
			deletions: entries.reduce((sum, entry) => sum + entry.deletions, 0),
			snapshot,
			...(lastMessage ? { lastMessage } : {}),
			at: Date.now(),
		};
	}

	/**
	 * A commit of the run's worktree as it is now (pending edits included), in the shared object
	 * store. Reuses the run's last snapshot when the tree has not changed, so a quiet run (most
	 * stats refreshes, since only one run's activity triggers a refresh) costs one `write-tree`
	 * instead of a new commit and ref update every time.
	 */
	private async snapshot(group: IRunGroup, run: IRunGroupRun): Promise<string> {
		const reuse = this.lastSnapshot.get(run.id);
		const result = await this.git.snapshot({
			repoRoot: group.repoRoot,
			workTree: run.worktreePath!,
			indexFile: joinPath(this.indexDir, `${run.id}.index`).fsPath,
			ref: `refs/volt/rg/${group.id}/${run.id.replace(/^agent-/, '')}`,
			message: `Volt run ${run.branch}`,
			...(reuse ? { reuse: { commit: reuse.commit, tree: reuse.tree } } : {}),
		});
		this.lastSnapshot.set(run.id, { commit: result.commit, tree: result.tree });
		return result.commit;
	}

	private async lastMessage(runId: string): Promise<string | undefined> {
		if (!this.history.has(runId)) {
			return undefined;
		}
		try {
			const transcript = await this.history.open(runId).load();
			for (let index = transcript.turns.length - 1; index >= 0; index--) {
				const text = transcript.turns[index].assistant?.text?.trim();
				if (text) {
					return text.length > 600 ? `${text.slice(0, 599).trimEnd()}…` : text;
				}
			}
		} catch {
			// No transcript yet.
		}
		return undefined;
	}

	async diffTarget(groupId: string, from: string | 'base', to: string): Promise<IRunDiffTarget> {
		const group = this.groups.get(groupId);
		const right = group?.runs.find(run => run.id === to);
		if (!group || !right?.worktreePath) {
			throw new Error('That run has no worktree to compare.');
		}
		const left = from === 'base' ? undefined : group.runs.find(run => run.id === from);
		if (from !== 'base' && !left?.worktreePath) {
			throw new Error('That run has no worktree to compare.');
		}
		const [fromCommit, toCommit] = await Promise.all([
			left ? this.snapshot(group, left) : Promise.resolve(group.base.commit),
			this.snapshot(group, right),
		]);
		return {
			repoRoot: group.repoRoot,
			from: fromCommit,
			to: toCommit,
			label: left ? `${left.model.label} ↔ ${right.model.label}` : `${right.model.label} vs ${group.base.ref ?? group.base.commit.slice(0, 7)}`,
			folder: right.worktreePath,
		};
	}

	async estimate(models: readonly IRunGroupModel[]): Promise<IRunGroupEstimate> {
		const usage = this.instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
		const empty: IRunCostHistory = { costPerSession: new Map(), limits: [] };
		if (!usage) {
			return estimateRunGroup(models, empty);
		}
		const [snapshot, limits] = await Promise.all([
			raceTimeout(usage.getUsage().catch(() => undefined), 4000),
			raceTimeout(usage.getLimits().catch(() => undefined), 4000),
		]);
		const costPerSession = new Map<string, number>();
		if (snapshot) {
			const since = Date.now() - 30 * 24 * 3600_000;
			const cost = new Map<string, number>();
			const sessions = new Map<string, Set<number>>();
			for (const bucket of snapshot.buckets) {
				if (bucket.hour >= since) {
					cost.set(bucket.provider, (cost.get(bucket.provider) ?? 0) + bucket.costUsd);
				}
			}
			for (const activity of snapshot.activity) {
				if (activity.hour >= since) {
					const set = sessions.get(activity.provider) ?? new Set<number>();
					activity.sessions.forEach(session => set.add(session));
					sessions.set(activity.provider, set);
				}
			}
			for (const [provider, total] of cost) {
				const count = sessions.get(provider)?.size ?? 0;
				if (count > 0 && total > 0) {
					costPerSession.set(provider, total / count);
				}
			}
		}
		const windows = (limits ?? []).flatMap(group => group.windows.map(window => ({
			family: group.provider,
			label: `${group.provider === 'claude' ? 'Claude' : group.provider === 'codex' ? 'Codex' : 'Cursor'} ${window.label.toLowerCase()}`,
			usedPercent: window.usedPercent,
			...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
		})));
		return estimateRunGroup(models, { costPerSession, limits: windows });
	}

	//#endregion

	//#region Winner

	async pickWinner(groupId: string, runId: string, action: RunWinnerAction, options: { readonly removeOthers: boolean }): Promise<IRunWinnerResult> {
		const group = this.groups.get(groupId);
		if (!group) {
			return { ok: false, error: 'This group no longer exists.' };
		}
		const plan = runWinnerPlan(group, runId, action, id => this.runStatus(groupId, id), options);
		if (plan.error) {
			return { ok: false, error: plan.error };
		}
		let commit: string | undefined;
		let kept: readonly string[] = [];
		for (const step of plan.steps) {
			switch (step.kind) {
				case 'commit': {
					const result = await this.commitPending(step.worktreePath, step.message);
					if (result.error) {
						return { ok: false, error: result.error };
					}
					commit = result.commit;
					break;
				}
				case 'merge': {
					const error = await this.merge(group.repoRoot, step.branch, step.into, step.message);
					if (error) {
						return { ok: false, error };
					}
					break;
				}
				case 'checkout': {
					const error = await this.checkout(group.repoRoot, step.branch, step.detach);
					if (error) {
						return { ok: false, error };
					}
					break;
				}
				case 'pr':
					// The existing pull request flow: it pushes the branch and opens the form for the winner's chat.
					await this.commandService.executeCommand(CREATE_PULL_REQUEST_COMMAND_ID, step.runId);
					break;
				case 'archive':
					for (const id of step.runIds) {
						this.updateRun(groupId, id, run => ({ ...run, discarded: true }));
						if (this.history.get(id)) {
							await this.history.setArchived(id, true).catch(() => undefined);
						}
					}
					break;
				case 'removeWorktrees':
					kept = (await this.removeWorktrees(groupId, step.runIds)).kept ?? [];
					break;
			}
		}
		this.updateGroup(groupId, value => ({ ...value, winner: { runId, action, at: Date.now(), ...(commit ? { commit } : {}) } }));
		void this.refreshStats(groupId);
		return { ok: true, ...(kept.length ? { kept } : {}) };
	}

	async removeWorktrees(groupId: string, runIds: readonly string[]): Promise<IRunWinnerResult> {
		const group = this.groups.get(groupId);
		if (!group) {
			return { ok: false, error: 'This group no longer exists.' };
		}
		const kept: string[] = [];
		for (const runId of runIds) {
			const run = group.runs.find(candidate => candidate.id === runId);
			if (!run?.worktreePath || run.worktreeRemoved || run.id === group.winner?.runId) {
				continue;
			}
			const status = this.runStatus(groupId, runId);
			if (status === 'working' || status === 'needsInput' || status === 'stopping') {
				await this.orchestrator.cancel(runId, { cascade: 'all' });
			}
			const setup = this.setups.get(runId);
			if (setup) {
				setup.cancelled = true;
				if (setup.execId) {
					await this.stdio.cancelExec(setup.execId).catch(() => undefined);
				}
			}
			try {
				const removal = await this.worktrees.remove(group.repoRoot, run.worktreePath, run.branch, { deleteBranch: true, force: true, ownsBranch: true });
				if (removal === 'removed' || removal === 'missing') {
					this.lastSnapshot.delete(runId);
					this.updateRun(groupId, runId, value => ({ ...value, worktreeRemoved: true }));
				} else {
					kept.push(run.worktreePath);
				}
			} catch (err) {
				this.logService.warn(`[volt run groups] could not remove ${run.worktreePath}`, err);
				kept.push(run.worktreePath);
			}
		}
		await this.git.deleteRefs({ repoRoot: group.repoRoot, prefix: `refs/volt/rg/${group.id}/` }).catch(() => undefined);
		return { ok: kept.length === 0, ...(kept.length ? { kept, error: `Kept ${kept.length} worktree${kept.length === 1 ? '' : 's'} that could not be removed.` } : {}) };
	}

	private async commitPending(worktreePath: string, message: string): Promise<{ commit?: string; error?: string }> {
		const status = await this.worktrees.git(worktreePath, ['status', '--porcelain']);
		if (status.exitCode !== 0) {
			return { error: detail(status) || 'Could not read the run\'s worktree.' };
		}
		if (status.stdout.trim()) {
			const added = await this.worktrees.git(worktreePath, ['add', '-A']);
			if (added.exitCode !== 0) {
				return { error: detail(added) };
			}
			const committed = await this.worktrees.git(worktreePath, ['commit', '-m', message]);
			if (committed.exitCode !== 0) {
				return { error: `Could not commit the run's changes: ${detail(committed)}` };
			}
		}
		return { commit: await this.revParse(worktreePath, 'HEAD') };
	}

	/** Merges where the base is checked out (Cline, Paseo); refuses a dirty tree, aborts on conflicts. */
	private async merge(repoRoot: string, branch: string, into: string, message: string): Promise<string | undefined> {
		return this.worktrees.serialize(repoRoot, async () => {
			const target = await this.checkoutOf(repoRoot, into);
			if (!target) {
				return `${into} is not checked out anywhere. Check it out in the project to merge into it.`;
			}
			const dirty = await this.worktrees.git(target, ['status', '--porcelain', '--untracked-files=no']);
			if (dirty.exitCode !== 0 || dirty.stdout.trim()) {
				return `${into} has uncommitted changes in ${target}. Commit or stash them first.`;
			}
			const merged = await this.worktrees.git(target, ['merge', '--no-ff', '--no-edit', '-m', message, branch]);
			if (merged.exitCode === 0) {
				return undefined;
			}
			const conflicts = await this.worktrees.git(target, ['diff', '--name-only', '--diff-filter=U']);
			await this.worktrees.git(target, ['merge', '--abort']);
			const files = conflicts.stdout.split('\n').map(line => line.trim()).filter(Boolean);
			return files.length
				? `Merging ${branch} into ${into} conflicts in ${files.join(', ')}. The merge was undone.`
				: `Could not merge ${branch}: ${detail(merged)}`;
		});
	}

	/** Git checks a branch out in one place: detach the run's worktree, then check the branch out in the project. */
	private async checkout(repoRoot: string, branch: string, worktreePath: string): Promise<string | undefined> {
		return this.worktrees.serialize(repoRoot, async () => {
			const dirty = await this.worktrees.git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
			if (dirty.exitCode !== 0 || dirty.stdout.trim()) {
				return 'The project has uncommitted changes. Commit or stash them before checking out the winner.';
			}
			const detached = await this.worktrees.git(worktreePath, ['checkout', '--detach']);
			if (detached.exitCode !== 0) {
				return `Could not free ${branch} from its worktree: ${detail(detached)}`;
			}
			const checkedOut = await this.worktrees.git(repoRoot, ['checkout', branch]);
			if (checkedOut.exitCode !== 0) {
				await this.worktrees.git(worktreePath, ['checkout', branch]);
				return `Could not check out ${branch}: ${detail(checkedOut)}`;
			}
			return undefined;
		});
	}

	private async checkoutOf(repoRoot: string, branch: string): Promise<string | undefined> {
		const listed = await this.worktrees.git(repoRoot, ['worktree', 'list', '--porcelain']);
		if (listed.exitCode !== 0) {
			return undefined;
		}
		let path: string | undefined;
		for (const line of listed.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				path = line.slice('worktree '.length).trim();
			} else if (line.trim() === `branch refs/heads/${branch}` && path) {
				return path;
			}
		}
		return undefined;
	}

	private async revParse(cwd: string, rev: string): Promise<string | undefined> {
		const result = await this.worktrees.git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
		return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
	}

	//#endregion

	//#region State

	private onOrchestratorChange(threads: readonly string[]): void {
		const touched = new Set<string>();
		const state = this.orchestrator.getState();
		const now = Date.now();
		for (const threadId of threads) {
			const groupId = this.groupBySession.get(threadId);
			if (!groupId) {
				continue;
			}
			touched.add(groupId);
			// Waiting on the user (an approval, a question) is not time the model spent working.
			const thread = state.threads[threadId];
			const busy = !!thread?.active && !thread.inputs.length;
			this.updateRun(groupId, threadId, run => {
				const clock = trackRunClock(run, busy, now);
				return clock === run ? run : { ...run, ...clock, ...(clock.activeSince === undefined ? { activeSince: undefined } : {}) };
			}, false);
			const status = this.runStatus(groupId, threadId);
			if (this.lastStatus.get(threadId) !== status) {
				this.lastStatus.set(threadId, status);
				if (status === 'done' || status === 'failed' || status === 'stopped') {
					this.scheduleStats(groupId, threadId);
				}
			}
		}
		for (const groupId of touched) {
			this._onDidChange.fire(groupId);
		}
	}

	private updateGroup(groupId: string, change: (group: IRunGroup) => IRunGroup): void {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}
		const next = change(group);
		if (next === group) {
			return;
		}
		this.groups.set(groupId, next);
		this.schedulePersist();
		this._onDidChange.fire(groupId);
	}

	private updateRun(groupId: string, runId: string, change: (run: IRunGroupRun) => IRunGroupRun, fire = true): void {
		const group = this.groups.get(groupId);
		const index = group?.runs.findIndex(run => run.id === runId) ?? -1;
		if (!group || index < 0) {
			return;
		}
		const run = group.runs[index];
		const next = change(run);
		if (next === run) {
			return;
		}
		const runs = group.runs.slice();
		runs[index] = stripUndefined(next);
		this.groups.set(groupId, { ...group, runs });
		this.schedulePersist();
		if (fire) {
			this._onDidChange.fire(groupId);
		}
	}

	private projectFor(group: IRunGroup) {
		const byId = group.projectId ? this.sessionContext.getProject(group.projectId) : undefined;
		return byId ?? this.sessionContext.projects.find(project => project.root.scheme === 'file' && normalize(project.root.fsPath) === normalize(group.repoRoot));
	}

	private async restore(): Promise<void> {
		try {
			const raw = (await this.fileService.readFile(this.storeFile)).value.toString();
			const stored = JSON.parse(raw) as IStoredGroups;
			if (stored?.version === STORE_VERSION && Array.isArray(stored.groups)) {
				for (const group of stored.groups as IStoredGroups['groups']) {
					// Nothing Volt was doing survives a restart: a setup cut short can be retried, and the
					// time between then and now was not spent working.
					const runs = group.runs.map((run: IRunGroupRun): IRunGroupRun => stripUndefined({
						...run,
						activeSince: undefined,
						setup: isSetupLive(run.setup) ? { ...run.setup, state: 'cancelled' as const, error: 'Volt restarted before setup finished.', steps: run.setup.steps.map((step: IRunSetupStep) => step.state === 'running' || step.state === 'pending' ? { ...step, state: 'cancelled' as const } : step) } : run.setup,
					}));
					this.groups.set(group.id, { ...group, runs });
					for (const run of runs) {
						this.groupBySession.set(run.id, group.id);
					}
				}
			}
		} catch {
			// First start, or an unreadable file: start empty.
		}
		this.ready.complete();
		await this.orchestrator.whenReady;
		for (const group of this.list().filter(candidate => !candidate.archived).slice(0, 20)) {
			await Promise.all(group.runs.map(run => this.orchestrator.ensureThreadLoaded(run.id).catch(() => undefined)));
			this._onDidChange.fire(group.id);
		}
	}

	private schedulePersist(): void {
		if (this.persistTimer !== undefined) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.persistNow();
		}, PERSIST_DELAY_MS);
	}

	private persistNow(): Promise<void> {
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		const groups = this.list();
		const kept = groups.filter(group => !group.archived).concat(groups.filter(group => group.archived)).slice(0, MAX_GROUPS);
		const body: IStoredGroups = { version: STORE_VERSION, groups: kept };
		this.persisting = this.persisting.then(() => this.fileService.writeFile(this.storeFile, VSBuffer.fromString(JSON.stringify(body))).then(() => undefined), () => undefined)
			.catch(err => this.logService.warn('[volt run groups] could not save groups', err));
		return this.persisting;
	}

	//#endregion
}

function isSetupLive(setup: IRunSetup): boolean {
	return setup.state === 'pending' || setup.state === 'worktree' || setup.state === 'running';
}

function stripUndefined<T extends object>(value: T): T {
	const result: Partial<T> = { ...value };
	for (const key of Object.keys(result) as (keyof T)[]) {
		if (result[key] === undefined) {
			delete result[key];
		}
	}
	return result as T;
}

function detail(result: { readonly stdout: string; readonly stderr: string }): string {
	return (result.stderr || result.stdout).trim();
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}
