/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from '../hostTools.js';
import { agentPattern, AgentTerminalStatus, isTerminalLive, lastErrorLine } from '../terminalTools.js';

/**
 * Watched tasks: a command that finishes on its own but takes long (an iOS or Android build, a
 * release bundle, a docker build) runs in a managed terminal while Volt, not the agent, keeps an
 * eye on it. A timer checks it; when it ends Volt decides whether it passed. A failure wakes the
 * agent with the error to fix it, and once the agent's turn ends Volt runs it again, until it
 * passes, the same error keeps coming back, or the attempts or the time run out.
 */
export const TASK_WATCH_TOOL_NAME = 'task_watch';
export const TASK_WATCH_STATUS_TOOL_NAME = 'task_watch_status';
export const TASK_WATCH_STOP_TOOL_NAME = 'task_watch_stop';

export const WATCHED_TASK_TOOL_NAMES = [TASK_WATCH_TOOL_NAME, TASK_WATCH_STATUS_TOOL_NAME, TASK_WATCH_STOP_TOOL_NAME] as const;

export const DEFAULT_CHECK_EVERY_MS = 10_000;
const MIN_CHECK_EVERY_MS = 2_000;
const MAX_CHECK_EVERY_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_MAX_ATTEMPTS = 10;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 45 * 60_000;
const MAX_ATTEMPT_TIMEOUT_MS = 4 * 60 * 60_000;
/** How long a watch keeps re-running a failing task in all. */
export const DEFAULT_BUDGET_MS = 2 * 60 * 60_000;
/** The same error this many attempts in a row: the fixes are not landing, so the loop stops. */
export const STUCK_REPEATS = 3;

export const WATCHED_TASK_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: TASK_WATCH_TOOL_NAME,
		approvalInReadOnlyModes: 'runs a command on your machine',
		title: 'Watching task',
		group: 'terminal',
		description: [
			'Run a long command that finishes on its own (an iOS or Android build such as `xcodebuild`, `./gradlew assembleDebug`, `npx expo run:ios`, `eas build --local`; a release bundle; `docker build`; a long test suite) and let Volt watch it instead of you.',
			'Returns at once. Do not poll it, sleep or re-run it: Volt checks it on a timer, shows its progress and output in the chat, and decides when it ends whether it passed (exit code 0, plus success_pattern when given, and no failure_pattern).',
			'If it fails, Volt sends you a message with the error; fix the cause and end your turn without running the command yourself. Volt then runs it again, and keeps going until it passes, the same error repeats, or the attempts or time run out.',
			'For servers and watchers that never exit use terminal_start instead.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command line, run by the user\'s shell in the project (or cwd).' },
				title: { type: 'string', description: 'Two or three words for the card, e.g. "iOS build", "Android release".' },
				cwd: { type: 'string', description: 'Working directory, relative to the project or absolute inside it.' },
				success_pattern: { type: 'string', description: 'Regex that means it worked, e.g. "BUILD SUCCEEDED|Installed on". Matching it counts as passed even while the process keeps running (an app launch that stays attached).' },
				failure_pattern: { type: 'string', description: 'Regex that means it failed even with exit code 0, e.g. "BUILD FAILED|error:".' },
				check_every_s: { type: 'integer', description: 'Seconds between checks (default 10, 2 to 300).' },
				max_attempts: { type: 'integer', description: 'Runs at most, the first included (default 5, max 10).' },
				attempt_timeout_min: { type: 'integer', description: 'One run longer than this is stopped and counts as failed (hung). Default 45.' },
				auto_fix: { type: 'boolean', description: 'Ask you to fix failures and run it again (default true). False: Volt only reports the result.' },
			},
			required: ['command'],
		},
	},
	{
		name: TASK_WATCH_STATUS_TOOL_NAME,
		title: 'Checked watched task',
		group: 'terminal',
		description: 'The state of this chat\'s watched tasks (or one by id): attempts, results, the current error and the latest output.',
		inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Watch id from task_watch (e.g. "watch-2"); omit for all.' } } },
	},
	{
		name: TASK_WATCH_STOP_TOOL_NAME,
		title: 'Stopped watching task',
		group: 'terminal',
		description: 'Stop a watched task: its run is stopped and Volt no longer re-runs it.',
		inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Watch id from task_watch.' } }, required: ['id'] },
	},
];

export function isWatchedTaskToolName(name: string): boolean {
	return (WATCHED_TASK_TOOL_NAMES as readonly string[]).includes(name);
}

export interface IWatchedTaskSpec {
	readonly command: string;
	readonly label: string | undefined;
	readonly cwd: string | undefined;
	readonly successPattern: string | undefined;
	readonly failurePattern: string | undefined;
	readonly checkEveryMs: number;
	readonly maxAttempts: number;
	readonly attemptTimeoutMs: number;
	readonly budgetMs: number;
	readonly autoFix: boolean;
}

/**
 * - `running`: an attempt runs; the timer checks it.
 * - `fixing`: an attempt failed and the agent is fixing it; the next run starts when its turn ends.
 * - `passed`: the last attempt passed.
 * - `failed`: it failed and nothing re-runs it (auto_fix off, or the agent could not be woken).
 * - `stuck`: the same error came back attempt after attempt.
 * - `exhausted`: out of attempts or time.
 * - `stopped`: the agent or the user stopped it.
 */
export type WatchedTaskState = 'running' | 'fixing' | 'passed' | 'failed' | 'stuck' | 'exhausted' | 'stopped';

export function isWatchLive(state: WatchedTaskState): boolean {
	return state === 'running' || state === 'fixing';
}

export type WatchedAttemptResult = 'passed' | 'failed' | 'timedOut' | 'stopped';

export interface IWatchedAttempt {
	readonly number: number;
	readonly terminalId: string | undefined;
	readonly startedAt: number;
	endedAt?: number;
	result?: WatchedAttemptResult;
	/** Why it failed, one line. */
	reason?: string;
	/** Its error, normalized, to notice the same failure again. */
	signature?: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseWatchArgs(args: Record<string, unknown>): IWatchedTaskSpec | { readonly error: string } {
	const command = text(args.command);
	if (!command) {
		return { error: 'command is required.' };
	}
	return {
		command,
		label: text(args.title),
		cwd: text(args.cwd),
		successPattern: text(args.success_pattern),
		failurePattern: text(args.failure_pattern),
		checkEveryMs: clampInt(args.check_every_s, DEFAULT_CHECK_EVERY_MS / 1000, MIN_CHECK_EVERY_MS / 1000, MAX_CHECK_EVERY_MS / 1000) * 1000,
		maxAttempts: clampInt(args.max_attempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_MAX_ATTEMPTS),
		attemptTimeoutMs: clampInt(args.attempt_timeout_min, DEFAULT_ATTEMPT_TIMEOUT_MS / 60_000, 1, MAX_ATTEMPT_TIMEOUT_MS / 60_000) * 60_000,
		budgetMs: DEFAULT_BUDGET_MS,
		autoFix: args.auto_fix !== false && args.auto_fix !== 'false',
	};
}

/** What a check sees of an attempt's terminal. */
export interface IWatchedTerminalState {
	readonly status: AgentTerminalStatus;
	readonly exitCode?: number;
	readonly error?: string;
}

export interface IAttemptVerdict {
	readonly verdict: 'running' | WatchedAttemptResult;
	readonly reason?: string;
}

/** The line of `output` a pattern matched, trimmed, if any. */
function matchedLine(output: string, pattern: RegExp): string | undefined {
	const match = pattern.exec(output);
	if (!match) {
		return undefined;
	}
	const start = output.lastIndexOf('\n', match.index) + 1;
	const end = output.indexOf('\n', match.index);
	const line = output.slice(start, end < 0 ? undefined : end).trim();
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Lines of build tools that name the failure (xcodebuild, gradle, cargo, tsc, npm, expo). */
const BUILD_ERROR_HINT = /(?:\berror\b[:\s]|\bfailed\b|\bfatal\b|exception|BUILD FAILED|\*\* BUILD FAILED \*\*|FAILURE:|What went wrong|npm ERR!|Command failed|exited with code [1-9]|Undefined symbol|No such module|cannot find|not found)/i;

/** The lines of `output` that say what went wrong, last ones last. */
export function errorLines(output: string, max = 6): string[] {
	const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line && BUILD_ERROR_HINT.test(line));
	// A line repeated (the same error per architecture) counts once.
	const unique = [...new Set(lines)];
	return unique.slice(-max).map(line => line.length > 240 ? `${line.slice(0, 239)}…` : line);
}

/** The line that names the failure: the last real `error` line, before summaries such as "** BUILD FAILED **". */
function primaryError(output: string): string | undefined {
	const lines = errorLines(output, 40);
	return lines.filter(line => /\berror\b/i.test(line) && !/build failed/i.test(line)).at(-1) ?? lines.at(-1);
}

/**
 * Whether an attempt passed, from its terminal and output: a success pattern counts at once, even
 * while it runs; otherwise only an exit decides, and a run past its time counts as hung.
 */
export function judgeAttempt(terminal: IWatchedTerminalState | undefined, output: string, spec: Pick<IWatchedTaskSpec, 'successPattern' | 'failurePattern' | 'attemptTimeoutMs'>, elapsedMs: number): IAttemptVerdict {
	if (!terminal) {
		return { verdict: 'failed', reason: 'Its terminal is gone.' };
	}
	const success = agentPattern(spec.successPattern);
	const failure = agentPattern(spec.failurePattern);
	const failedLine = failure && matchedLine(output, failure);
	if (success && matchedLine(output, success) && !failedLine) {
		return { verdict: 'passed' };
	}
	if (isTerminalLive(terminal.status)) {
		return elapsedMs > spec.attemptTimeoutMs
			? { verdict: 'timedOut', reason: `Still running after ${formatDuration(spec.attemptTimeoutMs)}; it looks hung.` }
			: { verdict: 'running' };
	}
	if (terminal.status === 'stopped') {
		return { verdict: 'stopped', reason: 'It was stopped before it finished.' };
	}
	if (failedLine) {
		return { verdict: 'failed', reason: failedLine };
	}
	if (terminal.status === 'completed' && (terminal.exitCode ?? 0) === 0) {
		return success
			? { verdict: 'failed', reason: `It exited 0 but never printed ${spec.successPattern}.` }
			: { verdict: 'passed' };
	}
	const why = primaryError(output) ?? lastErrorLine(output) ?? terminal.error;
	const code = terminal.exitCode !== undefined ? `exit code ${terminal.exitCode}` : 'it failed';
	return { verdict: 'failed', reason: why ? `${why} (${code})` : `It ended with ${code}.` };
}

/**
 * A failure's fingerprint: its error lines with what changes from run to run taken out (numbers,
 * line:column, hashes, temp paths, timestamps), so the same error twice reads the same.
 */
export function failureSignature(output: string, reason?: string): string {
	const lines = errorLines(output, 4);
	const source = lines.length ? lines : reason ? [reason] : [];
	return source
		.map(line => line
			.toLowerCase()
			.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s'"]*/g, '<tmp>')
			.replace(/\b[0-9a-f]{7,}\b/g, '<hash>')
			.replace(/\d+/g, '#')
			.replace(/\s+/g, ' ')
			.trim())
		.join('\n');
}

export type WatchNextStep =
	| { readonly next: 'fix' }
	| { readonly next: 'stop'; readonly state: Extract<WatchedTaskState, 'failed' | 'stuck' | 'exhausted'>; readonly why: string };

/** After a failed attempt: ask the agent for a fix and run again, or stop (and why). */
export function nextStepAfterFailure(attempts: readonly IWatchedAttempt[], spec: Pick<IWatchedTaskSpec, 'maxAttempts' | 'budgetMs' | 'autoFix'>, startedAt: number, now: number): WatchNextStep {
	// The last attempts in a row, all failed the same way (a pass or another error between resets it).
	const recent = attempts.slice(-STUCK_REPEATS);
	const last = recent.at(-1)?.signature;
	if (recent.length === STUCK_REPEATS && last && recent.every(attempt => attempt.result !== 'passed' && attempt.signature === last)) {
		return { next: 'stop', state: 'stuck', why: `The same error came back ${STUCK_REPEATS} times in a row, so the fixes are not reaching it.` };
	}
	if (!spec.autoFix) {
		return { next: 'stop', state: 'failed', why: 'Auto-fix is off.' };
	}
	if (attempts.length >= spec.maxAttempts) {
		return { next: 'stop', state: 'exhausted', why: `It failed all ${spec.maxAttempts} attempts.` };
	}
	if (now - startedAt >= spec.budgetMs) {
		return { next: 'stop', state: 'exhausted', why: `It has been failing for ${formatDuration(now - startedAt)}.` };
	}
	return { next: 'fix' };
}

/** The message that wakes the agent to fix a failed attempt. */
export function fixPrompt(id: string, title: string, spec: Pick<IWatchedTaskSpec, 'command' | 'maxAttempts'>, attempt: IWatchedAttempt, output: string, repeated: boolean): string {
	const lines = errorLines(output, 12);
	const tail = output.split(/\r?\n/).filter(line => line.trim()).slice(-40).join('\n');
	return [
		`[Volt] Watched task ${id} "${title}" failed (attempt ${attempt.number} of ${spec.maxAttempts}): ${attempt.reason ?? 'it failed'}.`,
		repeated ? 'This is the same error as the previous attempt: the last fix did not change it. Look at the cause again before editing.' : '',
		`Command: ${spec.command}`,
		lines.length ? `Errors:\n${lines.join('\n')}` : '',
		`End of its output:\n\`\`\`\n${tail}\n\`\`\``,
		'Fix the cause, then end your turn. Do not run the command yourself: when your turn ends Volt runs it again and checks it. If it cannot be fixed from here (a missing device, signing, credentials), say so and call task_watch_stop.',
	].filter(Boolean).join('\n\n');
}

/** The message that tells the agent the watch ended without passing. */
export function stopPrompt(id: string, title: string, attempts: number, why: string, reason: string | undefined): string {
	return `[Volt] Stopped watching task ${id} "${title}" after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${why}${reason ? ` Last error: ${reason}` : ''} Tell the user what is blocking it; do not start it again unless they ask.`;
}

/** The last lines of output for the card: blank lines and progress redraws gone, long lines cut. */
export function outputSnapshot(output: string, lines = 8): string[] {
	return output.split(/\r?\n/).map(line => line.replace(/\s+$/, '')).filter(line => line.trim()).slice(-lines).map(line => line.length > 300 ? `${line.slice(0, 299)}…` : line);
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
