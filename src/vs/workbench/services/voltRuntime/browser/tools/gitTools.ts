/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { hostGitArgs } from '../../../../../platform/voltGit/common/hostGit.js';
import { IVoltStdioService, runGitThrough } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IChatExec } from '../../common/execContext.js';
import { asRecord, pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';

/**
 * Read-only git. Commits, pushes, and history rewrites go through `shell`, under its approval rules.
 * `exec` says whose chat runs it: a sandboxed chat's git runs in its sandbox, like its shell.
 */
export function createGitTools(stdio: IVoltStdioService, root: () => URI | undefined, exec: () => IChatExec): IVoltTool[] {
	const runGit = (cwd: URI | undefined, argv: readonly string[], name: string, ctx: IToolContext) => runGitIn(stdio, exec(), cwd, argv, name, ctx);
	return [
		{
			name: 'git_status',
			group: 'git',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'git_status - branch and changed files',
			description: 'Current branch, upstream ahead/behind, and changed files (staged, unstaged, untracked). Use before and after a change to see what is modified.',
			schema: objectSchema({}, []),
			execute: async (_args, ctx) => runGit(root(), ['status', '--short', '--branch', '--untracked-files=normal'], 'git_status', ctx),
		},
		{
			name: 'git_diff',
			group: 'git',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'git_diff - the patch of uncommitted changes',
			description: [
				'Show a unified diff. Default: all uncommitted changes against HEAD. staged: only the index. base: compare against a ref (e.g. main).',
				'stat_only: just the per-file summary. paths: limit to files or folders.',
			].join(' '),
			schema: objectSchema({
				paths: { type: 'array', items: { type: 'string' } },
				staged: { type: 'boolean' },
				base: { type: 'string', description: 'Ref to compare against, e.g. main or HEAD~3' },
				stat_only: { type: 'boolean' },
				context: { type: 'integer', description: 'Context lines (default 3)' },
			}, []),
			execute: async (args, ctx) => {
				const context = Math.min(20, Math.max(0, pickNumber(args, 'context') ?? 3));
				const base = pickString(args, 'base', 'ref');
				const argv = ['diff', '--no-color', `-U${context}`];
				if (pickBoolean(args, 'staged')) {
					argv.push('--cached');
				} else {
					argv.push(base ?? 'HEAD');
				}
				if (pickBoolean(args, 'stat_only')) {
					argv.push('--stat');
				}
				return runGit(root(), [...argv, '--', ...paths(args)], 'git_diff', ctx);
			},
		},
		{
			name: 'git_log',
			group: 'git',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'git_log - recent commits',
			description: 'Recent commits, one line each. Limit to paths to see a file\'s history. Use git_show to read one commit.',
			schema: objectSchema({
				paths: { type: 'array', items: { type: 'string' } },
				limit: { type: 'integer', description: 'Default 20' },
				ref: { type: 'string', description: 'Branch or range, e.g. main..HEAD' },
			}, []),
			execute: async (args, ctx) => {
				const limit = Math.min(200, Math.max(1, pickNumber(args, 'limit') ?? 20));
				const ref = pickString(args, 'ref');
				return runGit(root(), ['log', '--no-color', '--date=short', '--format=%h %ad %an %s', `-n${limit}`, ...(ref ? [ref] : []), '--', ...paths(args)], 'git_log', ctx);
			},
		},
		{
			name: 'git_show',
			group: 'git',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'git_show - one commit\'s message and patch',
			description: 'Show a commit\'s message and patch, optionally for one path.',
			schema: objectSchema({
				ref: { type: 'string' },
				path: { type: 'string' },
			}, ['ref']),
			execute: async (args, ctx) => {
				const ref = pickString(args, 'ref', 'commit') ?? 'HEAD';
				const path = pickString(args, 'path');
				return runGit(root(), ['show', '--no-color', '--stat', '--patch', ref, ...(path ? ['--', path] : [])], 'git_show', ctx);
			},
		},
	];
}

function paths(args: unknown): string[] {
	const value = asRecord(args).paths;
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}

export interface IChatGitRequest {
	readonly id: string;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	/** Output kept per stream (default 30,000 characters in a sandbox, 8 MB through HostGit). */
	readonly maxChars?: number;
}

export interface IChatGitResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** git did not run: the sandbox could not be set up, or HostGit refused the repository. */
	readonly refused?: string;
}

/**
 * git for a chat's tools (B-03, B-06, INV-16). A sandboxed chat's runs inside its sandbox, with
 * HostGit's guards (no fsmonitor, hooks or `ext::`); any other chat's goes through HostGit on the
 * host. A sandboxed chat's exec without its sandbox runs nothing. Cancel with `stdio.cancelExec(request.id)`.
 */
export async function runChatGit(stdio: IVoltStdioService, exec: IChatExec, request: IChatGitRequest): Promise<IChatGitResult> {
	if (exec.context.sandboxed && !exec.sandbox) {
		const refused = 'this chat runs in Volt\'s sandbox, and Volt has no sandbox to run git in for it';
		return { exitCode: null, stdout: '', stderr: refused, refused };
	}
	if (exec.sandbox) {
		const result = await stdio.exec({
			id: request.id,
			command: ['git', ...hostGitArgs(['--no-pager', ...request.args], { hooksPath: '/dev/null' })].map(quote).join(' '),
			cwd: request.cwd,
			timeoutMs: request.timeoutMs,
			inlineChars: request.maxChars ?? 30_000,
			...exec,
		});
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(result.refused ? { refused: result.refused.reason } : {}) };
	}
	const result = await runGitThrough(stdio, { id: request.id, cwd: request.cwd, args: ['--no-pager', ...request.args], timeoutMs: request.timeoutMs, maxBytes: request.maxChars ?? 8 * 1024 * 1024 });
	return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr || result.error || '', ...(result.refused ? { refused: result.error ?? result.stderr } : {}) };
}

async function runGitIn(stdio: IVoltStdioService, exec: IChatExec, cwd: URI | undefined, argv: readonly string[], name: string, ctx: IToolContext): Promise<IToolResult> {
	if (!cwd) {
		return { callId: '', name, kind: 'search', text: 'No workspace is open.', isError: true };
	}
	const id = `git-${generateUuid().slice(0, 8)}`;
	const onAbort = () => void stdio.cancelExec(id);
	ctx.signal.addEventListener('abort', onAbort);
	try {
		const result = await runChatGit(stdio, exec, { id, cwd: cwd.fsPath, args: argv, timeoutMs: 30_000 });
		const failed = result.exitCode !== 0;
		const output = (failed ? `${result.stdout}\n${result.stderr}` : result.stdout).trim();
		return {
			callId: '',
			name,
			kind: 'search',
			text: shapeOutput(output) || (failed ? `git ${argv[0]} failed with exit ${result.exitCode}.` : `(no output from git ${argv[0]})`),
			isError: failed,
		};
	} catch (err) {
		return { callId: '', name, kind: 'search', text: err instanceof Error ? err.message : String(err), isError: true };
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
	}
}

function quote(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Long output keeps its head and tail, as shell output does. */
function shapeOutput(text: string, limit = 30_000): string {
	if (text.length <= limit) {
		return text;
	}
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n... ${text.length - limit} characters omitted ...\n${text.slice(-half)}`;
}
