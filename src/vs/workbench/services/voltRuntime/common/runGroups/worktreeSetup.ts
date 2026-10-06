/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, join, posix } from '../../../../../base/common/path.js';

/**
 * Worktree setup: commands a repository asks to run in every new worktree before an agent works
 * there (install dependencies, copy `.env`). Volt reads its own `.volt/worktrees.json` and, so a
 * repo already set up for Cursor works unchanged, Cursor's `.cursor/worktrees.json`:
 *
 * ```json
 * { "setup-worktree": ["npm ci", "cp $ROOT_WORKTREE_PATH/.env .env"] }
 * ```
 *
 * `setup-worktree-unix` / `setup-worktree-windows` win over `setup-worktree` on their platform.
 * A value is a list of commands, or the path of a script relative to the file. As in Cursor the
 * commands share one shell, run in the new worktree, and see the project checkout as
 * `$ROOT_WORKTREE_PATH`; a script gets the worktree path as its argument.
 */

/** Looked up in the new worktree first, then in the project checkout (Cursor's order). */
export const WORKTREE_SETUP_FILES = ['.volt/worktrees.json', '.cursor/worktrees.json'] as const;

/** The whole setup, all steps together. Dependency installs can be slow. */
export const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;

/** Printed before each step so one shell can report which step it is on. */
export const WORKTREE_SETUP_MARKER = '::volt-setup-step';

export type SetupPlatform = 'unix' | 'windows';

export interface IWorktreeSetupConfig {
	/** Repo-relative path of the file the steps came from. */
	readonly source: string;
	/** What the user wrote, one entry per step (a command, or the script's path). */
	readonly steps: readonly string[];
	/** Set when the value was a script path: the absolute script to run. */
	readonly script?: string;
}

export type WorktreeSetupParse =
	| { readonly kind: 'none' }
	| { readonly kind: 'config'; readonly config: IWorktreeSetupConfig }
	| { readonly kind: 'error'; readonly source: string; readonly error: string };

/**
 * `text` is the file's content; `fileDir` is the absolute folder holding it (script paths are
 * relative to it). A file with no setup for this platform is `none`.
 */
export function parseWorktreeSetup(text: string, source: string, fileDir: string, platform: SetupPlatform): WorktreeSetupParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { kind: 'error', source, error: `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { kind: 'error', source, error: `${source} must hold a JSON object.` };
	}
	const record = parsed as Record<string, unknown>;
	const key = platform === 'windows' ? 'setup-worktree-windows' : 'setup-worktree-unix';
	const value = record[key] ?? record['setup-worktree'];
	if (value === undefined || value === null) {
		return { kind: 'none' };
	}
	if (typeof value === 'string') {
		const path = value.trim();
		if (!path) {
			return { kind: 'none' };
		}
		const script = isAbsolute(path) ? path : join(fileDir, path);
		return { kind: 'config', config: { source, steps: [path], script } };
	}
	if (!Array.isArray(value)) {
		return { kind: 'error', source, error: `${source}: "${key}" must be a list of commands or a script path.` };
	}
	const steps = value.filter((step): step is string => typeof step === 'string').map(step => step.trim()).filter(Boolean);
	if (steps.length !== value.length && value.some(step => typeof step !== 'string')) {
		return { kind: 'error', source, error: `${source}: every setup step must be a string.` };
	}
	return steps.length ? { kind: 'config', config: { source, steps } } : { kind: 'none' };
}

export interface IWorktreeSetupEnv {
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly branch: string;
	readonly model: string;
}

export function worktreeSetupEnv(input: IWorktreeSetupEnv): Record<string, string> {
	return {
		ROOT_WORKTREE_PATH: input.repoRoot,
		VOLT_ROOT_PATH: input.repoRoot,
		VOLT_WORKTREE_PATH: input.worktreePath,
		VOLT_RUN_BRANCH: input.branch,
		VOLT_RUN_MODEL: input.model,
		// Setup output is shown as text: no color codes, no prompts.
		NO_COLOR: '1',
		CI: '1',
	};
}

/**
 * One shell line for the whole setup, starting at step `from` (a retry resumes at the step that
 * failed). Each step prints a marker first, so progress can be read from the output, and the
 * shell stops at the first failing step.
 */
export function worktreeSetupCommand(config: IWorktreeSetupConfig, worktreePath: string, platform: SetupPlatform, from = 0): string {
	if (config.script) {
		const script = platform === 'windows'
			? (/\.ps1$/i.test(config.script) ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${quote(config.script, platform)} ${quote(worktreePath, platform)}` : `cmd /c ${quote(config.script, platform)} ${quote(worktreePath, platform)}`)
			: `bash ${quote(config.script, platform)} ${quote(worktreePath, platform)}`;
		return platform === 'windows' ? script : `echo '${WORKTREE_SETUP_MARKER} 0' && ${script}`;
	}
	const steps = config.steps.slice(from);
	if (platform === 'windows') {
		return steps.map((step, index) => `echo ${WORKTREE_SETUP_MARKER} ${from + index} && ${step}`).join(' && ');
	}
	// `set -e` with a subshell per step: a failing step ends the setup, `cd` and exports carry over.
	return ['set -e', ...steps.map((step, index) => `echo '${WORKTREE_SETUP_MARKER} ${from + index}'\n${step}`)].join('\n');
}

/** The step the output last announced, or -1 before the first marker. */
export function currentSetupStep(output: string): number {
	let step = -1;
	const pattern = new RegExp(`${escapeRegExp(WORKTREE_SETUP_MARKER)} (\\d+)`, 'g');
	for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
		step = Number(match[1]);
	}
	return step;
}

/** The output without markers, last `lines` lines, for the inline progress row. */
export function setupOutputTail(output: string, lines = 6): string {
	const kept = output.split(/\r?\n/).filter(line => !line.startsWith(WORKTREE_SETUP_MARKER)).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
	while (kept.length && !kept[kept.length - 1]) {
		kept.pop();
	}
	return kept.slice(-lines).join('\n');
}

/** Repo-relative config path → where to read it in a folder. */
export function setupFileIn(folder: string, source: string): string {
	return join(folder, ...source.split(posix.sep));
}

function quote(arg: string, platform: SetupPlatform): string {
	if (/^[\w@%+=:,./~-]+$/.test(arg)) {
		return arg;
	}
	return platform === 'windows' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
