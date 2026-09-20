/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { truncateHeadTail } from '../../common/harness/toolResult.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { resolveWorkspaceUri } from './workspacePath.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const BACKGROUND_GRACE_MS = 800;

export function createShellTool(stdio: IVoltStdioService, root: () => URI | undefined): IVoltTool {
	return {
		name: 'shell',
		group: 'shell',
		kind: 'execute',
		parallelSafe: false,
		snippet: 'shell - run a command in the workspace (title required)',
		description: [
			'Run a shell command in the workspace.',
			'Use when you need the project\'s own tools (tests, git, package scripts, a dev server).',
			'Do not use to read or edit files (use read_file / edit_file), to search (use grep / glob), or to open a browser.',
			'Background long-running servers. Prefer package.json scripts over inventing a command.',
		].join(' '),
		schema: objectSchema({
			command: { type: 'string' },
			title: { type: 'string', description: 'Short human label, e.g. "run tests"' },
			cwd: { type: 'string' },
			background: { type: 'boolean' },
			timeout_ms: { type: 'integer', description: 'Kill the command after this many milliseconds. Default 60000.' },
		}, ['command', 'title']),
		execute: async (args, ctx) => runShell(stdio, root(), args, ctx),
	};
}

async function runShell(stdio: IVoltStdioService, root: URI | undefined, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const command = pickString(args, 'command', 'cmd');
	if (!command) {
		return fail('command is required.');
	}
	const title = pickString(args, 'title') ?? firstToken(command);
	const cwdUri = resolveWorkspaceUri(root, pickString(args, 'cwd', 'workdir')) ?? root;
	const cwd = cwdUri?.fsPath ?? ctx.cwd;
	const background = pickBoolean(args, 'background');
	const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, pickNumber(args, 'timeout_ms', 'timeout') ?? DEFAULT_TIMEOUT_MS));
	const { bin, argv } = shellInvocation(command);
	let id: string;
	try {
		id = await stdio.spawn({ command: bin, args: argv, cwd });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}

	if (background) {
		const early = await collectOutput(stdio, id, BACKGROUND_GRACE_MS, ctx.signal, false);
		const text = truncateHeadTail([
			`Started in background [${title}] id=${id}`,
			cwd ? `cwd: ${cwd}` : '',
			early.output.trim() ? early.output : '(no output yet)',
		].filter(Boolean).join('\n')).text;
		return { callId: '', name: 'shell', kind: 'execute', text };
	}

	const result = await collectOutput(stdio, id, timeoutMs, ctx.signal, true);
	const body = [
		`$ ${command}`,
		result.output,
		result.timedOut ? `[timed out after ${timeoutMs}ms]` : `exit ${result.code ?? '?'}`,
	].join('\n');
	return {
		callId: '',
		name: 'shell',
		kind: 'execute',
		text: truncateHeadTail(body).text,
		isError: result.timedOut || (result.code !== 0 && result.code !== null),
	};
}

function shellInvocation(command: string): { bin: string; argv: string[] } {
	if (isWindows) {
		return { bin: 'cmd.exe', argv: ['/d', '/s', '/c', command] };
	}
	return { bin: '/bin/zsh', argv: ['-lc', command] };
}

function firstToken(command: string): string {
	return command.trim().split(/\s+/, 1)[0] || 'command';
}

function collectOutput(
	stdio: IVoltStdioService,
	id: string,
	timeoutMs: number,
	signal: AbortSignal,
	killOnTimeout: boolean,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	return new Promise(resolve => {
		let output = '';
		let settled = false;
		const data = stdio.onData(event => {
			if (event.id === id) {
				output += event.data;
			}
		});
		const exit = stdio.onExit(event => {
			if (event.id === id) {
				finish(event.code, false);
			}
		});
		const timer = setTimeout(() => {
			if (killOnTimeout) {
				void stdio.kill(id);
			}
			finish(null, true);
		}, timeoutMs);
		const onAbort = () => {
			void stdio.kill(id);
			finish(null, true);
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort);
		function finish(code: number | null, timedOut: boolean): void {
			if (settled) {
				return;
			}
			settled = true;
			data.dispose();
			exit.dispose();
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve({ code, output, timedOut });
		}
	});
}

function fail(text: string): IToolResult {
	return { callId: '', name: 'shell', kind: 'execute', text, isError: true };
}
