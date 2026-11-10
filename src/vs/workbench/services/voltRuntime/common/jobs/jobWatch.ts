/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from '../hostTools.js';

/**
 * Watched jobs: work an agent left running past its turn (a background or `nohup` command, a
 * benchmark, a CI run or a deploy) while the user waits for its result. The agent tells Volt how to
 * check it; Volt runs that check on a timer, shows the progress under the agent's last reply, and
 * wakes the agent when the job ends so it reports the result it promised. Pure rules here; the
 * window's service runs the checks and draws the row.
 */
export const WATCH_JOB_TOOL_NAME = 'watch_job';
export const UNWATCH_JOB_TOOL_NAME = 'unwatch_job';

export const JOB_WATCH_TOOL_NAMES = [WATCH_JOB_TOOL_NAME, UNWATCH_JOB_TOOL_NAME] as const;

export const DEFAULT_EVERY_MS = 5_000;
const MIN_EVERY_MS = 2_000;
const MAX_EVERY_MS = 300_000;
export const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60_000;
/** One check that takes longer than this is a check that did not work, not a finished job. */
export const CHECK_TIMEOUT_MS = 20_000;
/** Checks that could not run this many times in a row end the watch. */
export const MAX_BROKEN_CHECKS = 5;
/** What the row shows of a line. */
const LINE_CHARS = 160;
/** Output handed to the agent when it is woken. */
const WAKE_OUTPUT_CHARS = 1_500;
const WAKE_OUTPUT_LINES = 20;

export const JOB_WATCH_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: WATCH_JOB_TOOL_NAME,
		title: 'Watching job',
		group: 'terminal',
		approvalInReadOnlyModes: 'runs a check command on your machine',
		description: [
			'Tell Volt how to check a job you left running (a background or nohup command, a benchmark, a long build, a CI run or deploy you started) when the user is waiting for its result.',
			'Call it right before you end your turn instead of sleeping or polling: Volt runs `check` every few seconds, shows the user live progress under your reply, and sends you a message when the job ends so you can report the result. Returns the first check at once.',
			'How Volt reads a check: with `pid`, the job is done when that process exits; with `done_pattern`, when the check\'s output matches it; otherwise when the check exits 0 (any other exit code means still running), e.g. `test -f out/done` or `! pgrep -f run.py`.',
			'`fail_pattern` matching means it failed. The last line the check prints is shown as its progress; "3/8", "40%" or a JSON line {"progress":0.4,"status":"…","done":false} fill a progress bar.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Two to four words for the user, e.g. "Benchmark", "iOS build", "CI run".' },
				check: { type: 'string', description: 'Shell command Volt runs in the project (or cwd) to check the job, e.g. `tail -n 1 bench.log`, `gh run view 123 --json status -q .status`. Fast (a few seconds at most) and read-only. Optional with `pid`.' },
				every_s: { type: 'integer', description: 'Seconds between checks (default 5, 2 to 300).' },
				pid: { type: 'integer', description: 'Process id of the job (e.g. from `cmd > out.log 2>&1 & echo $!`): done when it exits.' },
				done_pattern: { type: 'string', description: 'Regex: the job is done when the check\'s output matches, e.g. "^completed|DONE".' },
				fail_pattern: { type: 'string', description: 'Regex: the job failed when the check\'s output matches, e.g. "failure|Traceback|error:".' },
				cwd: { type: 'string', description: 'Folder the check runs in, relative to the project or absolute.' },
				timeout_min: { type: 'integer', description: 'Stop waiting after this many minutes and tell you it still runs (default 120).' },
				wake: { type: 'boolean', description: 'Send you a message when it ends (default true). False: Volt only shows it to the user.' },
			},
			required: ['title'],
		},
	},
	{
		name: UNWATCH_JOB_TOOL_NAME,
		title: 'Stopped watching job',
		group: 'terminal',
		description: 'Stop watching a job (Volt stops checking it; the job itself keeps running). Without `id`, every job this chat watches.',
		inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Watch id from watch_job (e.g. "job-2").' } } },
	},
];

export function isJobWatchToolName(name: string): boolean {
	return (JOB_WATCH_TOOL_NAMES as readonly string[]).includes(name);
}

export interface IJobWatchSpec {
	readonly title: string;
	readonly check: string | undefined;
	readonly everyMs: number;
	readonly pid: number | undefined;
	readonly donePattern: string | undefined;
	readonly failPattern: string | undefined;
	readonly cwd: string | undefined;
	readonly timeoutMs: number;
	readonly wake: boolean;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A title fit for the row and for the notice's quotes (which {@link jobWakeEnd} reads back). */
export function jobTitle(value: string): string {
	return clip(value.replace(/\s+/g, ' ').replace(/"/g, '\'').trim(), 60);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** "5", 5, "3s", "3 seconds", "every 3 seconds", "1m", "2 min" → milliseconds; undefined when unreadable. */
export function parseEvery(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
	}
	const match = typeof value === 'string' ? /^(?:every\s*)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?$/i.exec(value.trim()) : null;
	if (!match) {
		return undefined;
	}
	const amount = Number(match[1]);
	const unit = (match[2] ?? 's').toLowerCase();
	const ms = unit.startsWith('ms') || unit.startsWith('milli') ? amount : unit.startsWith('m') ? amount * 60_000 : amount * 1000;
	return ms > 0 ? ms : undefined;
}

function validRegex(source: string | undefined, name: string): string | undefined {
	if (source === undefined) {
		return undefined;
	}
	try {
		new RegExp(source, 'im');
	} catch (err) {
		throw new Error(`${name} is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
	}
	return source;
}

export function parseJobWatchArgs(args: Record<string, unknown>): IJobWatchSpec | { readonly error: string } {
	const check = text(args.check) ?? text(args.command);
	const rawPid = typeof args.pid === 'string' ? Number(args.pid.trim()) : args.pid;
	const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
	if (args.pid !== undefined && args.pid !== null && pid === undefined) {
		return { error: 'pid must be a positive whole number.' };
	}
	if (!check && pid === undefined) {
		return { error: 'Give `check` (a command Volt runs to check the job), `pid`, or both.' };
	}
	let donePattern: string | undefined;
	let failPattern: string | undefined;
	try {
		donePattern = validRegex(text(args.done_pattern), 'done_pattern');
		failPattern = validRegex(text(args.fail_pattern), 'fail_pattern');
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	const every = parseEvery(args.every_s ?? args.every) ?? DEFAULT_EVERY_MS;
	const timeoutMin = typeof args.timeout_min === 'number' ? args.timeout_min : typeof args.timeout_min === 'string' ? Number(args.timeout_min) : NaN;
	return {
		title: jobTitle(text(args.title) ?? (check ? clip(check, 40) : `Process ${pid}`)),
		check,
		everyMs: clamp(every, MIN_EVERY_MS, MAX_EVERY_MS),
		pid,
		donePattern,
		failPattern,
		cwd: text(args.cwd),
		timeoutMs: Number.isFinite(timeoutMin) && timeoutMin > 0 ? clamp(timeoutMin * 60_000, 60_000, MAX_JOB_TIMEOUT_MS) : DEFAULT_JOB_TIMEOUT_MS,
		wake: args.wake !== false && args.wake !== 'false',
	};
}

//#region Reading a check

/** One run of the check (and of the pid probe, when there is a pid). */
export interface IJobCheckRun {
	readonly exitCode: number | null;
	readonly output: string;
	readonly timedOut: boolean;
	/** With a pid: whether that process still runs. */
	readonly alive?: boolean;
}

/** `broken`: the check itself did not work (not found, timed out); the job's state is unknown. */
export type JobCheckState = 'running' | 'done' | 'failed' | 'broken';

export interface IJobCheckOutcome {
	readonly state: JobCheckState;
	/** What the row shows: the check's last line, or the status of its JSON line. */
	readonly line?: string;
	/** 0 to 1, when the check said how far along the job is. */
	readonly progress?: number;
	/** Why, for `broken` and `failed`. */
	readonly reason?: string;
}

interface IJsonStatus {
	readonly line?: string;
	readonly progress?: number;
	readonly done?: boolean;
	readonly failed?: boolean;
	readonly error?: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Output as lines a person reads: no colour codes, and a line redrawn with `\r` only as last drawn. */
export function cleanOutputLines(output: string): string[] {
	return output.replace(ANSI, '').split(/\n/).map(line => {
		const drawn = line.split('\r').filter(part => part.trim());
		return (drawn.at(-1) ?? '').trim();
	}).filter(Boolean);
}

function clip(value: string, chars: number): string {
	return value.length > chars ? `${value.slice(0, chars - 1)}…` : value;
}

/** `progress` is a share (0.4) or, above 1, a percentage; `percent` always a percentage. */
function fraction(value: unknown, percent = false): number | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : NaN;
	if (!Number.isFinite(number) || number < 0) {
		return undefined;
	}
	const share = percent || number > 1 ? number / 100 : number;
	return share <= 1 ? share : undefined;
}

function jsonStatus(line: string | undefined): IJsonStatus | undefined {
	if (!line || !line.startsWith('{') || !line.endsWith('}')) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const status = text(record.status) ?? text(record.message) ?? text(record.step);
	const error = text(record.error);
	return {
		line: status ?? error,
		progress: record.progress !== undefined ? fraction(record.progress) : fraction(record.percent, true),
		done: record.done === true || record.finished === true || record.complete === true,
		failed: record.failed === true || record.ok === false || !!error,
		error,
	};
}

/** How far along a line says the job is: "40%", "3/8", "run 4 of 5". */
export function progressOf(line: string): number | undefined {
	const percents = [...line.matchAll(/(?<![\w.])(\d{1,3}(?:\.\d+)?)\s*%/g)].map(match => Number(match[1])).filter(value => value <= 100);
	if (percents.length) {
		return percents[percents.length - 1] / 100;
	}
	// "3/8", "[3/8]", "run 5/10: …", "4 of 5"; not dates, paths or times ("2026/11/06", "out/1/2", "5/10:30").
	const counts = [...line.matchAll(/(?<![\w/.:-])(\d+)\s*(?:\/|of|out of)\s*(\d+)(?![\w/.]|:\d)/gi)]
		.map(match => [Number(match[1]), Number(match[2])] as const)
		.filter(([done, total]) => total > 0 && done <= total);
	if (counts.length) {
		const [done, total] = counts[counts.length - 1];
		return done / total;
	}
	return undefined;
}

function matches(pattern: string | undefined, output: string): boolean {
	if (!pattern) {
		return false;
	}
	try {
		return new RegExp(pattern, 'im').test(output);
	} catch {
		return false;
	}
}

/** What one check says about the job. */
export function judgeJobCheck(spec: Pick<IJobWatchSpec, 'pid' | 'donePattern' | 'failPattern' | 'check'>, run: IJobCheckRun): IJobCheckOutcome {
	const lines = cleanOutputLines(run.output);
	const last = lines.at(-1);
	const json = jsonStatus(last);
	const shown = json ? json.line : last;
	const line = shown ? clip(shown, LINE_CHARS) : undefined;
	const progress = json?.progress ?? (shown ? progressOf(shown) : undefined);
	const base = { ...(line ? { line } : {}), ...(progress !== undefined ? { progress } : {}) };
	if (spec.check && run.timedOut) {
		return { ...base, state: 'broken', reason: `the check took longer than ${CHECK_TIMEOUT_MS / 1000}s` };
	}
	if (spec.check && (run.exitCode === 126 || run.exitCode === 127)) {
		return { ...base, state: 'broken', reason: `the check could not run (exit ${run.exitCode})${last ? `: ${clip(last, LINE_CHARS)}` : ''}` };
	}
	const output = lines.join('\n');
	if (matches(spec.failPattern, output) || json?.failed) {
		return { ...base, state: 'failed', reason: json?.error ?? line ?? 'fail_pattern matched' };
	}
	if (json?.done || matches(spec.donePattern, output)) {
		return { ...base, state: 'done', ...(progress !== undefined ? { progress: 1 } : {}) };
	}
	if (spec.pid !== undefined) {
		return run.alive === false ? { ...base, state: 'done', ...(progress !== undefined ? { progress: 1 } : {}) } : { ...base, state: 'running' };
	}
	if (spec.donePattern) {
		return { ...base, state: 'running' };
	}
	return run.exitCode === 0 ? { ...base, state: 'done', ...(progress !== undefined ? { progress: 1 } : {}) } : { ...base, state: 'running' };
}

/** The last line of output worth showing, and how far along it says the job is (an agent's own background command). */
export function latestOutputLine(output: string): { readonly line?: string; readonly progress?: number } {
	const last = cleanOutputLines(output).at(-1);
	if (!last) {
		return {};
	}
	const json = jsonStatus(last);
	const shown = json ? json.line : last;
	const progress = json?.progress ?? (shown ? progressOf(shown) : undefined);
	return { ...(shown ? { line: clip(shown, LINE_CHARS) } : {}), ...(progress !== undefined ? { progress } : {}) };
}

//#endregion

//#region Telling the agent and the user

/** "0:07", "2:14", "1:02:14": the row's running clock. */
export function formatJobClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, '0');
	return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "12s", "2m 14s", "1h 5m". */
export function formatJobDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) {
		return `${total}s`;
	}
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return hours ? `${hours}h ${minutes}m` : `${minutes}m ${total % 60}s`;
}

/** How a watch ended. */
export type JobEnd = 'done' | 'failed' | 'timedOut' | 'broken';

export const JOB_WAKE_PREFIX = '[Volt] Background job';

export interface IJobWakeInput {
	readonly id: string;
	readonly title: string;
	readonly end: JobEnd;
	readonly durationMs: number;
	/** The agent's own background command (Claude's `run_in_background`), not a watch_job. */
	readonly agentTask?: boolean;
	readonly check?: string;
	readonly output?: string;
	readonly reason?: string;
	/** Where the job's whole output is. */
	readonly outputFile?: string;
	readonly exitCode?: number;
}

function outputTail(output: string | undefined): string | undefined {
	const lines = cleanOutputLines(output ?? '');
	if (!lines.length) {
		return undefined;
	}
	const tail = lines.slice(-WAKE_OUTPUT_LINES).join('\n');
	return tail.length > WAKE_OUTPUT_CHARS ? `…${tail.slice(-WAKE_OUTPUT_CHARS)}` : tail;
}

/** The message that wakes the agent, and the one line the chat shows for it. */
export function jobWakeMessage(input: IJobWakeInput): { readonly text: string; readonly summary: string } {
	const name = `"${jobTitle(input.title)}"`;
	const took = formatJobDuration(input.durationMs);
	const tail = outputTail(input.output);
	const source = input.agentTask
		? `the background command you started${input.exitCode !== undefined ? `, exit ${input.exitCode}` : ''}`
		: `watch ${input.id}`;
	const where = input.agentTask
		? `${input.outputFile ? ` Its whole output is in ${input.outputFile}.` : ''}${tail ? ` Its last lines:\n\`\`\`\n${tail}\n\`\`\`` : ''}`
		: tail ? ` The last check${input.check ? ` (\`${input.check}\`)` : ''} printed:\n\`\`\`\n${tail}\n\`\`\`` : '';
	switch (input.end) {
		case 'done':
			return {
				text: `${JOB_WAKE_PREFIX} ${name} finished after ${took} (${source}).${where}\nThe user is waiting for its result: read what it produced and give them what you said you would. Volt is no longer watching it.`,
				summary: `${input.title} finished · ${took}`,
			};
		case 'failed':
			return {
				text: `${JOB_WAKE_PREFIX} ${name} failed after ${took} (${source})${input.reason ? `: ${input.reason}` : ''}.${where}\nTell the user what went wrong, and fix it if you can. Volt is no longer watching it.`,
				summary: `${input.title} failed · ${took}`,
			};
		case 'timedOut':
			return {
				text: `${JOB_WAKE_PREFIX} ${name} still runs after ${took} (${source}); Volt stopped waiting for it (timeout_min).${where}\nCheck where it stands and tell the user; call watch_job again to keep waiting.`,
				summary: `${input.title} still running after ${took}`,
			};
		case 'broken':
			return {
				text: `${JOB_WAKE_PREFIX} ${name}: Volt stopped watching it after ${took} (${source}) because its check did not work ${MAX_BROKEN_CHECKS} times in a row${input.reason ? ` (${input.reason})` : ''}.${where}\nCheck the job yourself, and call watch_job with a check that works if the user is still waiting.`,
				summary: `Stopped watching ${input.title}: its check did not work`,
			};
	}
}

/** How a notice Volt sent ended, read back from its text (for the transcript's icon). */
export function jobWakeEnd(agentText: string | undefined): JobEnd | undefined {
	if (!agentText?.startsWith(JOB_WAKE_PREFIX)) {
		return undefined;
	}
	const rest = agentText.slice(JOB_WAKE_PREFIX.length);
	return /^ "[^"]*" finished/.test(rest) ? 'done'
		: /^ "[^"]*" failed/.test(rest) ? 'failed'
			: /^ "[^"]*" still runs/.test(rest) ? 'timedOut'
				: 'broken';
}

//#endregion
