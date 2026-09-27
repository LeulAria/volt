/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoltExecResult, IVoltJobOutput, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { resolveWorkspaceUri } from './workspacePath.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const INLINE_CHARS = 30_000;

export interface IShellToolHost {
	readonly stdio: IVoltStdioService;
	readonly root: () => URI | undefined;
	/** Where long output is written in full. */
	readonly spillDir?: () => string | undefined;
	/** A log was written; read_file may now open it. */
	readonly onLog?: (path: string) => void;
}

export function createShellTools(host: IShellToolHost): IVoltTool[] {
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
				'Set background: true for servers and watchers, then use job_wait / job_output / job_stop with the returned job id.',
				'Do not use to read, search, or edit files (read_file, grep, glob, edit_file are faster), or to open a browser.',
			].join(' '),
			schema: objectSchema({
				command: { type: 'string' },
				description: { type: 'string', description: 'Five-word label shown to the user, e.g. "Run unit tests"' },
				cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
				timeout_ms: { type: 'integer', description: `Stop the command after this long (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
				background: { type: 'boolean', description: 'Keep running as a job; returns after a few seconds with early output' },
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
			execute: async args => jobResult('job_output', await host.stdio.jobOutput(pickString(args, 'id') ?? '', pickNumber(args, 'offset', 'since'))),
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
			execute: async args => jobResult('job_wait', await host.stdio.jobWait(
				pickString(args, 'id') ?? '',
				Math.min(MAX_TIMEOUT_MS, Math.max(100, pickNumber(args, 'timeout_ms', 'timeout') ?? 30_000)),
				pickString(args, 'until', 'pattern'),
			)),
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
	const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, pickNumber(args, 'timeout_ms', 'timeout') ?? DEFAULT_TIMEOUT_MS));
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
	if (result.running) {
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
