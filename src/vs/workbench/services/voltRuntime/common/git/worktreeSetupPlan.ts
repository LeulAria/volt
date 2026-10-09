/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/**
 * Worktree setup: what runs in a new worktree before an agent works there. A project describes it
 * in one of three files, read from the new worktree first (its branch may change it), then from
 * the project checkout:
 *
 * - `t3.json` (T3 Code's project file; Volt also reads the same shape as `volt.json`):
 *   `{ "worktreeSubmodules": "recursive" | "top-level" | "none", "scripts": [{ "name", "command",
 *   "runOnWorktreeCreate": true, "async": false }] }`. Scripts marked `runOnWorktreeCreate` run, each
 *   on its own; an `async` one (T3's default) runs alongside the agent instead of before it.
 * - `.volt/worktrees.json` or Cursor's `.cursor/worktrees.json`: `{ "setup-worktree": ["npm ci",
 *   ...] }` (or `-unix` / `-windows`), commands that share one shell, as in Cursor.
 *
 * Submodules are initialized first when the repository has a `.gitmodules`, recursively unless the
 * project file says otherwise (T3's default). Everything here is pure; the runner shows each step,
 * and can be cancelled or retried from the step that failed.
 */

export const PROJECT_FILES = ['t3.json', 'volt.json'] as const;
export const WORKTREE_SETUP_FILES = ['.volt/worktrees.json', '.cursor/worktrees.json'] as const;

/** All blocking steps together. Dependency installs can be slow. */
export const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;

/** Printed before each command of a shared-shell group so one shell can report its progress. */
export const WORKTREE_SETUP_MARKER = '::volt-setup-step';

export type SetupPlatform = 'unix' | 'windows';
export type WorktreeSubmodules = 'recursive' | 'top-level' | 'none';

export interface IProjectScript {
	readonly name: string;
	readonly command: string;
	readonly runOnWorktreeCreate: boolean;
	/** Runs alongside the agent rather than before it (T3's default for project scripts). */
	readonly async: boolean;
}

export interface IProjectFile {
	readonly source: string;
	readonly worktreeSubmodules?: WorktreeSubmodules;
	readonly scripts: readonly IProjectScript[];
}

export type ParseResult<T> = { readonly kind: 'none' } | { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly error: string };

function parseJsonObject(text: string, source: string): { readonly value?: Record<string, unknown>; readonly error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { error: `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { value: parsed as Record<string, unknown> } : { error: `${source} must hold a JSON object.` };
}

/** `t3.json` / `volt.json`. Unknown keys (icon, preview URLs) are T3's and are ignored. */
export function parseProjectFile(text: string, source: string): ParseResult<IProjectFile> {
	const { value, error } = parseJsonObject(text, source);
	if (!value) {
		return { kind: 'error', error: error! };
	}
	const submodules = value.worktreeSubmodules;
	if (submodules !== undefined && submodules !== 'recursive' && submodules !== 'top-level' && submodules !== 'none') {
		return { kind: 'error', error: `${source}: "worktreeSubmodules" must be "recursive", "top-level" or "none".` };
	}
	const rawScripts = value.scripts;
	if (rawScripts !== undefined && !Array.isArray(rawScripts)) {
		return { kind: 'error', error: `${source}: "scripts" must be a list.` };
	}
	const scripts: IProjectScript[] = [];
	for (const [index, raw] of (rawScripts ?? []).entries()) {
		const script = raw as Record<string, unknown> | undefined;
		const command = typeof script?.command === 'string' ? script.command.trim() : '';
		if (!command) {
			return { kind: 'error', error: `${source}: script ${index + 1} needs a "command".` };
		}
		scripts.push({
			name: typeof script?.name === 'string' && script.name.trim() ? script.name.trim() : command,
			command,
			runOnWorktreeCreate: script?.runOnWorktreeCreate === true,
			async: script?.async !== false,
		});
	}
	return { kind: 'ok', value: { source, ...(submodules ? { worktreeSubmodules: submodules } : {}), scripts } };
}

export interface IWorktreesJson {
	readonly source: string;
	readonly commands: readonly string[];
	/** A script path given instead of a list (relative to the file). */
	readonly script?: string;
}

/** `.volt/worktrees.json` / `.cursor/worktrees.json`, Cursor's format. */
export function parseWorktreesJson(text: string, source: string, platform: SetupPlatform): ParseResult<IWorktreesJson> {
	const { value: record, error } = parseJsonObject(text, source);
	if (!record) {
		return { kind: 'error', error: error! };
	}
	const key = platform === 'windows' ? 'setup-worktree-windows' : 'setup-worktree-unix';
	const value = record[key] ?? record['setup-worktree'];
	if (value === undefined || value === null) {
		return { kind: 'none' };
	}
	if (typeof value === 'string') {
		return value.trim() ? { kind: 'ok', value: { source, commands: [value.trim()], script: value.trim() } } : { kind: 'none' };
	}
	if (!Array.isArray(value) || value.some(step => typeof step !== 'string')) {
		return { kind: 'error', error: `${source}: "${key}" must be a list of commands or a script path.` };
	}
	const commands = (value as string[]).map(step => step.trim()).filter(Boolean);
	return commands.length ? { kind: 'ok', value: { source, commands } } : { kind: 'none' };
}

export interface IWorktreeSetupStep {
	readonly label: string;
	/** What it runs, shown under the label. */
	readonly command: string;
	readonly kind: 'submodules' | 'command' | 'script';
	readonly source: string;
	/** Runs alongside the agent: the turn does not wait for it. */
	readonly async?: boolean;
	/** Steps of one `worktrees.json` list share a shell; `group` is the list's index in the plan. */
	readonly group?: number;
}

export interface IWorktreeSetupPlanInput {
	readonly projectFile?: IProjectFile;
	readonly worktreesJson?: IWorktreesJson;
	readonly hasGitmodules: boolean;
}

/** The steps, in order: submodules, then the shared-shell list, then project scripts. */
export function buildWorktreeSetupPlan(input: IWorktreeSetupPlanInput): IWorktreeSetupStep[] {
	const steps: IWorktreeSetupStep[] = [];
	const submodules = input.projectFile?.worktreeSubmodules ?? 'recursive';
	if (input.hasGitmodules && submodules !== 'none') {
		steps.push({
			label: submodules === 'recursive' ? 'Initialize submodules' : 'Initialize top-level submodules',
			command: `git submodule update --init${submodules === 'recursive' ? ' --recursive' : ''}`,
			kind: 'submodules',
			source: input.projectFile?.source ?? '.gitmodules',
		});
	}
	const list = input.worktreesJson;
	if (list) {
		for (const command of list.commands) {
			steps.push({ label: command, command, kind: list.script ? 'script' : 'command', source: list.source, group: 0 });
		}
	}
	for (const script of input.projectFile?.scripts ?? []) {
		if (script.runOnWorktreeCreate) {
			steps.push({ label: script.name, command: script.command, kind: 'script', source: input.projectFile!.source, ...(script.async ? { async: true } : {}) });
		}
	}
	return steps;
}

/**
 * How the runner executes a plan: one unit per shared-shell group, one per other step. `from`
 * skips steps already done (a retry starts at the one that failed).
 */
export interface IWorktreeSetupUnit {
	readonly steps: readonly number[];
	readonly script: string;
	readonly async: boolean;
}

export function worktreeSetupUnits(steps: readonly IWorktreeSetupStep[], worktreePath: string, platform: SetupPlatform, done: ReadonlySet<number> = new Set()): IWorktreeSetupUnit[] {
	const units: IWorktreeSetupUnit[] = [];
	const grouped = new Map<number, number[]>();
	steps.forEach((step, index) => {
		if (done.has(index)) {
			return;
		}
		if (step.group !== undefined) {
			const list = grouped.get(step.group);
			if (list) {
				list.push(index);
				return;
			}
			const created = [index];
			grouped.set(step.group, created);
			units.push({ steps: created, script: '', async: false });
			return;
		}
		units.push({ steps: [index], script: '', async: !!step.async });
	});
	return units.map(unit => ({ ...unit, script: unitScript(unit.steps.map(index => ({ index, step: steps[index] })), worktreePath, platform) }));
}

function unitScript(steps: readonly { index: number; step: IWorktreeSetupStep }[], worktreePath: string, platform: SetupPlatform): string {
	const command = (step: IWorktreeSetupStep) => step.kind === 'script' && steps.length === 1 && /\.(sh|bash|ps1|cmd|bat)$/i.test(step.command)
		? (platform === 'windows'
			? (/\.ps1$/i.test(step.command) ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${quote(step.command, platform)} ${quote(worktreePath, platform)}` : `cmd /c ${quote(step.command, platform)} ${quote(worktreePath, platform)}`)
			: `bash ${quote(step.command, platform)} ${quote(worktreePath, platform)}`)
		: step.command;
	if (platform === 'windows') {
		return steps.map(({ index, step }) => `echo ${WORKTREE_SETUP_MARKER} ${index} && ${command(step)}`).join(' && ');
	}
	// `set -e`: the first failing command ends the group; `cd` and exports carry to the next one.
	return ['set -e', ...steps.map(({ index, step }) => `echo '${WORKTREE_SETUP_MARKER} ${index}'\n${command(step)}`)].join('\n');
}

/** The step the output last announced, or -1 before the first marker. */
export function currentSetupStep(output: string): number {
	let step = -1;
	const pattern = new RegExp(`${WORKTREE_SETUP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)`, 'g');
	for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
		step = Number(match[1]);
	}
	return step;
}

/** Output without markers or colour codes, last `lines` lines, for the step's row. */
export function setupOutputTail(output: string, lines = 6): string {
	const kept = output.split(/\r?\n/).filter(line => !line.startsWith(WORKTREE_SETUP_MARKER)).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
	while (kept.length && !kept[kept.length - 1]) {
		kept.pop();
	}
	return kept.slice(-lines).join('\n');
}

export function worktreeSetupEnv(input: { readonly repoRoot: string; readonly worktreePath: string; readonly branch: string }): Record<string, string> {
	return {
		// Cursor's name for the checkout the worktree came from, and T3's.
		ROOT_WORKTREE_PATH: input.repoRoot,
		T3CODE_PROJECT_ROOT: input.repoRoot,
		VOLT_ROOT_PATH: input.repoRoot,
		VOLT_WORKTREE_PATH: input.worktreePath,
		VOLT_WORKTREE_BRANCH: input.branch,
		NO_COLOR: '1',
		CI: '1',
	};
}

function quote(arg: string, platform: SetupPlatform): string {
	if (/^[\w@%+=:,./~-]+$/.test(arg)) {
		return arg;
	}
	return platform === 'windows' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

//#region Runner

export type WorktreeSetupStepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type WorktreeSetupPhase = 'running' | 'done' | 'failed' | 'cancelled';

export interface IWorktreeSetupStepStatus extends IWorktreeSetupStep {
	readonly state: WorktreeSetupStepState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	/** The last lines of its output. */
	readonly tail?: string;
}

/** One chat's setup, as the card above its composer shows it. */
export interface IWorktreeSetupStatus {
	readonly chatId: string;
	readonly worktreePath: string;
	readonly branch: string;
	readonly steps: readonly IWorktreeSetupStepStatus[];
	readonly phase: WorktreeSetupPhase;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly error?: string;
}

export interface IWorktreeSetupRequest {
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly branch: string;
	/** Asked between steps: the run that needs the worktree was stopped. */
	readonly isCancelled?: () => boolean;
}

export const IAgentWorktreeSetupService = createDecorator<IAgentWorktreeSetupService>('agentWorktreeSetupService');

export interface IAgentWorktreeSetupService {
	readonly _serviceBrand: undefined;
	/** The chat whose setup changed. */
	readonly onDidChange: Event<string>;
	get(chatId: string): IWorktreeSetupStatus | undefined;
	/**
	 * Runs a new worktree's setup for a chat. Resolves once the blocking steps are done (async ones
	 * keep going); rejects when a step fails or the setup is cancelled. A worktree with nothing to
	 * set up resolves at once and shows nothing.
	 */
	run(chatId: string, request: IWorktreeSetupRequest): Promise<void>;
	/** The chat's last setup failed or was cancelled: its next turn retries it first. */
	needsRetry(chatId: string): boolean;
	/** Runs the steps that did not finish, from the first of them. */
	retry(chatId: string, request?: Pick<IWorktreeSetupRequest, 'isCancelled'>): Promise<void>;
	cancel(chatId: string): Promise<void>;
	/** Hides a finished setup's card. */
	dismiss(chatId: string): void;
}

//#endregion
