/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { join, posix } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import {
	buildWorktreeSetupPlan, currentSetupStep, IAgentWorktreeSetupService, IProjectFile, IWorktreeSetupRequest, IWorktreeSetupStatus, IWorktreeSetupStepStatus, IWorktreesJson,
	parseProjectFile, parseWorktreesJson, PROJECT_FILES, setupOutputTail, WORKTREE_SETUP_FILES, WORKTREE_SETUP_TIMEOUT_MS, worktreeSetupEnv, worktreeSetupUnits,
} from '../../common/git/worktreeSetupPlan.js';

const POLL_MS = 400;

interface ISetupRun {
	status: IWorktreeSetupStatus;
	readonly request: IWorktreeSetupRequest;
	/** The command running now, for Cancel. */
	execId?: string;
	cancelled: boolean;
	/** The blocking part; `retry` starts a new one. */
	done?: Promise<void>;
}

/**
 * Runs worktree setup (see `worktreeSetupPlan.ts`) for the chats that get a new worktree: a
 * composer send on New Worktree, and worktree subagents. Each step's state and last output lines
 * are published for the card above the chat's composer; Cancel kills the running command, Retry
 * picks up at the step that did not finish. Async project scripts run after the blocking steps,
 * alongside the agent.
 */
export class AgentWorktreeSetupService extends Disposable implements IAgentWorktreeSetupService {

	declare readonly _serviceBrand: undefined;

	private readonly runs = new Map<string, ISetupRun>();
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		// Nothing keeps polling a command for a window that is going away.
		for (const run of this.runs.values()) {
			run.cancelled = true;
		}
		super.dispose();
	}

	get(chatId: string): IWorktreeSetupStatus | undefined {
		return this.runs.get(chatId)?.status;
	}

	needsRetry(chatId: string): boolean {
		const phase = this.runs.get(chatId)?.status.phase;
		return phase === 'failed' || phase === 'cancelled';
	}

	dismiss(chatId: string): void {
		const run = this.runs.get(chatId);
		if (run && run.status.phase !== 'running') {
			this.runs.delete(chatId);
			this._onDidChange.fire(chatId);
		}
	}

	async run(chatId: string, request: IWorktreeSetupRequest): Promise<void> {
		const plan = await this.readPlan(request.worktreePath, request.repoRoot);
		if (!plan.steps.length) {
			if (plan.error) {
				throw new Error(plan.error);
			}
			return;
		}
		const run: ISetupRun = {
			status: {
				chatId,
				worktreePath: request.worktreePath,
				branch: request.branch,
				steps: plan.steps.map(step => ({ ...step, state: 'pending' as const })),
				phase: 'running',
				startedAt: Date.now(),
			},
			request,
			cancelled: false,
		};
		this.runs.set(chatId, run);
		this._onDidChange.fire(chatId);
		run.done = this.execute(chatId, run);
		return run.done;
	}

	async retry(chatId: string, request?: Pick<IWorktreeSetupRequest, 'isCancelled'>): Promise<void> {
		const run = this.runs.get(chatId);
		if (!run) {
			return;
		}
		if (run.status.phase === 'running') {
			return run.done;
		}
		run.cancelled = false;
		const { error: _error, endedAt: _endedAt, ...rest } = run.status;
		run.status = {
			...rest,
			phase: 'running',
			steps: run.status.steps.map(step => step.state === 'done' ? step : { ...step, state: 'pending', tail: undefined, exitCode: undefined, startedAt: undefined, endedAt: undefined }),
		};
		const next: ISetupRun = { ...run, request: { ...run.request, ...(request?.isCancelled ? { isCancelled: request.isCancelled } : {}) } };
		this.runs.set(chatId, next);
		this._onDidChange.fire(chatId);
		next.done = this.execute(chatId, next);
		return next.done;
	}

	async cancel(chatId: string): Promise<void> {
		const run = this.runs.get(chatId);
		if (!run || run.status.phase !== 'running') {
			return;
		}
		run.cancelled = true;
		if (run.execId) {
			await this.stdio.cancelExec(run.execId).catch(() => undefined);
		}
	}

	//#region Plan

	private async readPlan(worktreePath: string, repoRoot: string): Promise<{ steps: ReturnType<typeof buildWorktreeSetupPlan>; error?: string }> {
		const platform = isWindows ? 'windows' : 'unix';
		let projectFile: IProjectFile | undefined;
		let worktreesJson: IWorktreesJson | undefined;
		let error: string | undefined;
		// The new worktree's copy first: its branch may set up differently than the checkout.
		for (const folder of [worktreePath, repoRoot]) {
			for (const source of PROJECT_FILES) {
				if (projectFile) {
					break;
				}
				const text = await this.read(join(folder, source));
				if (text !== undefined) {
					const parsed = parseProjectFile(text, source);
					if (parsed.kind === 'ok') {
						projectFile = parsed.value;
					} else if (parsed.kind === 'error') {
						error ??= parsed.error;
					}
				}
			}
			for (const source of WORKTREE_SETUP_FILES) {
				if (worktreesJson) {
					break;
				}
				const file = join(folder, ...source.split(posix.sep));
				const text = await this.read(file);
				if (text !== undefined) {
					const parsed = parseWorktreesJson(text, source, platform);
					if (parsed.kind === 'ok') {
						// A script path is relative to the file that names it.
						worktreesJson = parsed.value.script ? { ...parsed.value, commands: [join(folder, ...source.split(posix.sep).slice(0, -1), parsed.value.script)], script: parsed.value.script } : parsed.value;
					} else if (parsed.kind === 'error') {
						error ??= parsed.error;
					}
				}
			}
		}
		const hasGitmodules = await this.fileService.exists(URI.file(join(worktreePath, '.gitmodules'))).catch(() => false);
		const steps = buildWorktreeSetupPlan({ ...(projectFile ? { projectFile } : {}), ...(worktreesJson ? { worktreesJson } : {}), hasGitmodules });
		if (error) {
			this.logService.warn(`[volt worktree setup] ${error}`);
		}
		return { steps, ...(error ? { error } : {}) };
	}

	private async read(path: string): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(URI.file(path))).value.toString();
		} catch {
			return undefined;
		}
	}

	//#endregion

	//#region Execution

	private update(chatId: string, run: ISetupRun, change: (status: IWorktreeSetupStatus) => IWorktreeSetupStatus): void {
		if (this._store.isDisposed || this.runs.get(chatId) !== run) {
			return;
		}
		run.status = change(run.status);
		this._onDidChange.fire(chatId);
	}

	private setStep(chatId: string, run: ISetupRun, index: number, change: Partial<IWorktreeSetupStepStatus>): void {
		this.update(chatId, run, status => ({ ...status, steps: status.steps.map((step, i) => i === index ? { ...step, ...change } : step) }));
	}

	private async execute(chatId: string, run: ISetupRun): Promise<void> {
		const platform = isWindows ? 'windows' : 'unix';
		const done = new Set(run.status.steps.flatMap((step, index) => step.state === 'done' ? [index] : []));
		const units = worktreeSetupUnits(run.status.steps, run.status.worktreePath, platform, done);
		const blocking = units.filter(unit => !unit.async);
		const background = units.filter(unit => unit.async);
		const started = Date.now();
		try {
			for (const unit of blocking) {
				await this.runUnit(chatId, run, unit.steps, unit.script, WORKTREE_SETUP_TIMEOUT_MS - (Date.now() - started));
			}
		} catch (err) {
			const cancelled = run.cancelled || !!run.request.isCancelled?.();
			this.update(chatId, run, status => ({
				...status,
				phase: cancelled ? 'cancelled' : 'failed',
				endedAt: Date.now(),
				error: cancelled ? 'Setup was cancelled.' : err instanceof Error ? err.message : String(err),
				steps: status.steps.map(step => step.state === 'running' ? { ...step, state: cancelled ? 'cancelled' : 'failed', endedAt: Date.now() } : step),
			}));
			throw new Error(cancelled ? 'Worktree setup was cancelled.' : `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!background.length) {
			this.update(chatId, run, status => ({ ...status, phase: 'done', endedAt: Date.now() }));
			return;
		}
		// Async project scripts keep going alongside the agent; their failure shows on the card only.
		void (async () => {
			try {
				for (const unit of background) {
					await this.runUnit(chatId, run, unit.steps, unit.script, WORKTREE_SETUP_TIMEOUT_MS);
				}
				this.update(chatId, run, status => ({ ...status, phase: 'done', endedAt: Date.now() }));
			} catch (err) {
				this.update(chatId, run, status => ({ ...status, phase: run.cancelled ? 'cancelled' : 'failed', endedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }));
			}
		})();
	}

	/** One shell for the unit's steps; progress read from its step markers. */
	private async runUnit(chatId: string, run: ISetupRun, steps: readonly number[], script: string, budgetMs: number): Promise<void> {
		if (run.cancelled || run.request.isCancelled?.()) {
			throw new Error('Stopped.');
		}
		const platform = isWindows ? 'windows' : 'unix';
		const execId = `volt-setup-${chatId.slice(-8)}-${generateUuid().slice(0, 6)}`;
		run.execId = execId;
		const first = steps[0];
		const now = Date.now();
		this.setStep(chatId, run, first, { state: 'running', startedAt: now });
		let output = '';
		let offset = 0;
		const apply = (exitCode?: number | null) => {
			const marker = currentSetupStep(output);
			const current = steps.includes(marker) ? marker : first;
			const tail = setupOutputTail(output);
			const at = Date.now();
			this.update(chatId, run, status => ({
				...status,
				steps: status.steps.map((step, index) => {
					if (!steps.includes(index)) {
						return step;
					}
					if (index < current) {
						return step.state === 'done' ? step : { ...step, state: 'done', endedAt: step.endedAt ?? at };
					}
					if (index === current) {
						return exitCode === undefined
							? { ...step, state: 'running', startedAt: step.startedAt ?? at, tail }
							: { ...step, state: exitCode === 0 ? 'done' : 'failed', startedAt: step.startedAt ?? at, endedAt: at, exitCode, tail };
					}
					return exitCode === 0 ? { ...step, state: 'done', endedAt: at } : step;
				}),
			}));
		};
		const result = await this.stdio.exec({
			id: execId,
			command: platform === 'windows' ? script : `bash -c ${shellQuote(script)}`,
			cwd: run.status.worktreePath,
			env: worktreeSetupEnv({ repoRoot: run.request.repoRoot, worktreePath: run.status.worktreePath, branch: run.status.branch }),
			timeoutMs: Math.max(30_000, budgetMs),
			background: true,
			backgroundWaitMs: POLL_MS,
			inlineChars: 20_000,
		});
		output = result.combined;
		let running = result.running;
		let exitCode = result.exitCode;
		let timedOut = result.timedOut;
		if (running) {
			const job = await this.stdio.jobOutput(execId, 0);
			if (job) {
				output = job.output;
				offset = job.offset;
			}
		}
		const deadline = Date.now() + budgetMs;
		while (running && !run.cancelled) {
			if (run.request.isCancelled?.()) {
				run.cancelled = true;
				break;
			}
			if (Date.now() >= deadline) {
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
		run.execId = undefined;
		if (run.cancelled) {
			await this.stdio.cancelExec(execId).catch(() => undefined);
			throw new Error('Stopped.');
		}
		apply(exitCode ?? 1);
		if (exitCode !== 0) {
			const failed = run.status.steps.find((step, index) => steps.includes(index) && step.state === 'failed');
			throw new Error(timedOut
				? `it did not finish within ${Math.round(WORKTREE_SETUP_TIMEOUT_MS / 60_000)} minutes`
				: `\`${failed?.command ?? 'setup'}\` exited with code ${exitCode ?? 'unknown'}`);
		}
	}

	//#endregion
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

registerSingleton(IAgentWorktreeSetupService, AgentWorktreeSetupService, InstantiationType.Delayed);
