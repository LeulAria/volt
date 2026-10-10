/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoltExecResult, IVoltJobOutput, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolService } from '../../common/hostTools.js';
import { isLongRunningCommand, TERMINAL_START_TOOL_NAME } from '../../common/terminalTools.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { hasManagedTerminals, runTerminalTool } from './terminalTool.js';
import { resolveWorkspaceUri } from './workspacePath.js';

/** A command with no timeout of its own is stopped after this; it stops blocking long before (see YIELD_AFTER_MS). */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/**
 * A command still running after this hands control back to the agent with its output so far and
 * goes on as a job, so a slow build or a server started without `background` never stalls the turn.
 */
const YIELD_AFTER_MS = 25_000;
const INLINE_CHARS = 30_000;

export interface IShellToolHost {
	readonly stdio: IVoltStdioService;
	readonly root: () => URI | undefined;
	/** Where long output is written in full. */
	readonly spillDir?: () => string | undefined;
	/** A log was written; read_file may now open it. */
	readonly onLog?: (path: string) => void;
	/** Managed terminals: servers and watchers run there, visible to the user, instead of as hidden jobs. */
	readonly hostTools?: IVoltHostToolService;
}

export function createShellTools(host: IShellToolHost): IVoltTool[] {
	/** Where each job's last read ended, so a wait looks only at what is new. */
	const jobOffsets = new Map<string, number>();
	const remember = (job: IVoltJobOutput | undefined): IVoltJobOutput | undefined => {
		if (job) {
			jobOffsets.set(job.id, job.offset);
		}
		return job;
	};
	return [
		{
			name: 'shell',
			group: 'shell',
			kind: 'execute',
			parallelSafe: false,
			snippet: 'shell - run a command in the workspace',
			description: [
				'Run a shell command (non-interactive, no stdin) in the workspace and get its exit code with stdout and stderr.',
				'Use for the project\'s own tooling: tests, builds, type-checks, package scripts, git operations.',
				`A command still running after ${YIELD_AFTER_MS / 1000}s returns its output so far and keeps running as a job: continue with job_wait / job_output / job_stop.`,
				'Servers, watchers and other commands that never exit (or background: true) run in a terminal the user can watch; they return once ready with a terminal id for terminal_output / terminal_wait / terminal_stop.',
				'Do not use to read, search, or edit files (read_file, grep, glob, edit_file are faster), or to open a browser.',
			].join(' '),
			schema: objectSchema({
				command: { type: 'string' },
				description: { type: 'string', description: 'Five-word label shown to the user, e.g. "Run unit tests"' },
				cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
				timeout_ms: { type: 'integer', description: `Stop the command after this long (default and max ${MAX_TIMEOUT_MS})` },
				background: { type: 'boolean', description: 'A server or watcher: run it in a managed terminal and return once it is up' },
			}, ['command']),
			timeoutMs: MAX_TIMEOUT_MS + 30_000,
			execute: async (args, ctx) => runShell(host, args, ctx),
		},
		{
			name: 'job_output',
			group: 'shell',
			kind: 'execute',
			parallelSafe: true,
			idempotent: true,
			snippet: 'job_output - read a background job\'s output',
			description: 'Read output from a background job started by shell. Pass the offset from the previous read to get only new output.',
			schema: objectSchema({
				id: { type: 'string' },
				offset: { type: 'integer', description: 'Offset returned by the previous read' },
			}, ['id']),
			execute: async args => {
				const id = pickString(args, 'id') ?? '';
				return jobResult('job_output', remember(await host.stdio.jobOutput(id, pickNumber(args, 'offset', 'since') ?? jobOffsets.get(id))));
			},
		},
		{
			name: 'job_wait',
			group: 'shell',
			kind: 'execute',
			parallelSafe: true,
			idempotent: true,
			snippet: 'job_wait - wait for a background job to print something or exit',
			description: 'Wait until a background job exits, its output matches `until` (a regex such as "ready|listening on"), or timeout_ms passes. Use after starting a server before hitting it.',
			schema: objectSchema({
				id: { type: 'string' },
				until: { type: 'string', description: 'Regex to wait for in the output' },
				timeout_ms: { type: 'integer', description: 'Default 30000, max 600000' },
			}, ['id']),
			timeoutMs: MAX_TIMEOUT_MS + 30_000,
			execute: async args => {
				const id = pickString(args, 'id') ?? '';
				// Only output after the last read counts, so a pattern that matched before cannot end the wait at once.
				return jobResult('job_wait', remember(await host.stdio.jobWait(
					id,
					Math.min(MAX_TIMEOUT_MS, Math.max(100, pickNumber(args, 'timeout_ms', 'timeout') ?? 30_000)),
					pickString(args, 'until', 'pattern'),
					jobOffsets.get(id),
				)));
			},
		},
		{
			name: 'job_stop',
			group: 'shell',
			kind: 'execute',
			parallelSafe: false,
			snippet: 'job_stop - stop a background job',
			description: 'Stop a background job and everything it started.',
			schema: objectSchema({
				id: { type: 'string' },
			}, ['id']),
			execute: async args => {
				const id = pickString(args, 'id') ?? '';
				const before = await host.stdio.jobOutput(id);
				if (!before) {
					return { callId: '', name: 'job_stop', kind: 'execute', text: `No job ${id}.`, isError: true };
				}
				await host.stdio.cancelExec(id);
				return { callId: '', name: 'job_stop', kind: 'execute', text: `Stopped job ${id} (${before.command}).` };
			},
		},
	];
}

async function runShell(host: IShellToolHost, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const command = pickString(args, 'command', 'cmd');
	if (!command) {
		return fail('command is required.');
	}
	const root = host.root();
	const requestedCwd = pickString(args, 'cwd', 'workdir');
	const cwdUri = requestedCwd ? resolveWorkspaceUri(root, requestedCwd) : root;
	if (requestedCwd && !cwdUri) {
		return fail(`cwd ${requestedCwd} is outside the workspace.`);
	}
	const cwd = cwdUri?.fsPath ?? ctx.cwd;
	const background = pickBoolean(args, 'background');
	// Servers and watchers go to a managed terminal: visible to the user, readable by the agent, never blocking.
	if ((background || isLongRunningCommand(command)) && host.hostTools && hasManagedTerminals(host.hostTools)) {
		const started = await runTerminalTool(host.hostTools, TERMINAL_START_TOOL_NAME, {
			command,
			cwd,
			...(pickString(args, 'description') ? { title: pickString(args, 'description') } : {}),
		}, ctx);
		return { ...started, name: 'shell' };
	}
	const explicitTimeout = pickNumber(args, 'timeout_ms', 'timeout');
	const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, explicitTimeout ?? DEFAULT_TIMEOUT_MS));
	const id = `sh-${generateUuid().slice(0, 8)}`;
	const onAbort = () => void host.stdio.cancelExec(id);
	if (ctx.signal.aborted) {
		return fail('Cancelled before the command started.');
	}
	ctx.signal.addEventListener('abort', onAbort);
	let result: IVoltExecResult;
	try {
		result = await host.stdio.exec({
			id,
			command,
			cwd,
			timeoutMs,
			background,
			// A short explicit timeout is the caller's wish to wait it out; otherwise hand back control.
			...(!background && (explicitTimeout === undefined || explicitTimeout > YIELD_AFTER_MS) ? { yieldAfterMs: YIELD_AFTER_MS } : {}),
			inlineChars: INLINE_CHARS,
			spillDir: host.spillDir?.(),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
	}
	if (result.logPath) {
		host.onLog?.(result.logPath);
	}
	const seconds = (result.durationMs / 1000).toFixed(1);
	const output = result.combined.trim() || '(no output)';
	let status: string;
	if (result.running && !background) {
		status = `[still running after ${seconds}s as job ${id}; output so far is above. Keep working, or job_wait (id, until, timeout_ms) for it; job_output reads more, job_stop stops it]`;
	} else if (result.running) {
		status = `[running in the background as job ${id}; use job_wait / job_output / job_stop]`;
	} else if (result.cancelled) {
		status = '[cancelled]';
	} else if (result.timedOut) {
		status = `[timed out after ${Math.round(timeoutMs / 1000)}s and was stopped; raise timeout_ms or run it in the background]`;
	} else {
		status = `[exit ${result.exitCode ?? '?'}${result.signal ? ` (${result.signal})` : ''} · ${seconds}s]`;
	}
	const log = result.logPath ? `\n[Output was long; full log: ${result.logPath}]` : '';
	const failed = !result.running && (result.timedOut || result.cancelled || (result.exitCode !== 0 && result.exitCode !== null));
	return {
		callId: '',
		name: 'shell',
		kind: 'execute',
		text: `$ ${command}\n${output}\n${status}${log}`,
		isError: failed,
		...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
	};
}

function jobResult(name: string, job: IVoltJobOutput | undefined): IToolResult {
	if (!job) {
		return { callId: '', name, kind: 'execute', text: 'No such job. It may have been stopped, or the id is wrong.', isError: true };
	}
	const state = job.running ? 'running' : `exited ${job.exitCode ?? '?'}`;
	const matched = job.matched === undefined ? '' : job.matched ? ' · pattern matched' : ' · pattern not seen yet';
	return {
		callId: '',
		name,
		kind: 'execute',
		text: `[job ${job.id}: ${state}${matched} · offset ${job.offset}]\n${job.output.trim() || '(no new output)'}`,
	};
}

function fail(text: string): IToolResult {
	return { callId: '', name: 'shell', kind: 'execute', text, isError: true };
}
