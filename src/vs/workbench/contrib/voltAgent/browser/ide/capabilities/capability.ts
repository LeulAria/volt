/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { joinPath, relativePath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { IVoltSandboxSettings } from '../../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltStdioService } from '../../../../../../platform/voltStdio/common/voltStdio.js';
import { runChatGit } from '../../../../../services/voltRuntime/browser/tools/gitTools.js';
import { IChatExec } from '../../../../../services/voltRuntime/common/execContext.js';
import { IVoltHostFileChange } from '../../../../../services/voltRuntime/common/hostTools.js';
import { shellQuote } from '../../../../../services/voltRuntime/common/ide/testFrameworks.js';
import { stripAnsi } from '../../../../../services/voltRuntime/common/ide/testReports.js';
import { isWindows } from '../../../../../../base/common/platform.js';

/** What an `ide` capability call gets: where it works, for which chat, and a way to run programs. */
export interface IIdeCapabilityContext {
	/** The chat's folder (its worktree), or the workspace's first folder. */
	readonly root: URI | undefined;
	readonly chatId: string | undefined;
	readonly token: CancellationToken;
	readonly cli: IdeCli;
	/**
	 * A sandboxed chat's call: its sandbox, and the gate's rules for files an op finds or makes rather
	 * than files the agent named (conflicted files, a report, a profile the sandboxed program wrote).
	 * See {@link confinedReadRefusal}.
	 */
	readonly confinement?: IIdeConfinement;
}

export interface IIdeConfinement {
	readonly sandbox: IVoltSandboxSettings;
	readonly readRefusal?: (path: string) => Promise<string | undefined>;
	readonly writeRefusal?: (path: string) => Promise<string | undefined>;
	/** The chat's temp folder, which its sandbox may write (`ISandboxPathContext.tmpdir`). */
	readonly tmpdir?: string;
}

/**
 * Why a sandboxed chat's op may not read `uri` from Volt's process, or undefined when it may (or the
 * chat is not sandboxed). Without the gate's rule it may not: Volt cannot tell.
 */
export async function confinedReadRefusal(ctx: IIdeCapabilityContext, uri: URI): Promise<string | undefined> {
	if (!ctx.confinement) {
		return undefined;
	}
	return ctx.confinement.readRefusal ? ctx.confinement.readRefusal(uri.fsPath) : `Volt cannot tell whether this sandboxed chat may read ${uri.fsPath}`;
}

export interface IIdeCapabilityResult {
	readonly text: string;
	readonly isError?: boolean;
	/** Files the call changed, for the chat's change set. */
	readonly changes?: readonly IVoltHostFileChange[];
}

/** One capability of the `ide` tool (see `ideCapabilities.ts` for the ops it offers). */
export interface IIdeCapability {
	readonly id: string;
	invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult>;
}

export interface ICliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** The program is not installed (or could not start). */
	readonly missing?: boolean;
	/** Nothing ran: the chat's sandbox could not be set up, or HostGit refused the repository. Why. */
	readonly refused?: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** What the IDE tools answer for a chat without a project folder: nothing runs (Volt's own folder is never a stand-in). */
export const NO_PROJECT_FOLDER = 'this chat has no project folder, so nothing was run. Open a folder for the chat (or start it in a project) and try again.';

const NO_FOLDER: ICliResult = { code: null, stdout: '', stderr: NO_PROJECT_FOLDER, refused: NO_PROJECT_FOLDER };

/**
 * Runs programs for capabilities: without a shell when the platform offers it (arguments are never
 * parsed, so names from the agent cannot inject), with the user's environment, bounded in time.
 * `exec` says whose they are: a sandboxed chat's run in its sandbox, through the shell with every
 * argument quoted (a program run without a shell cannot be sandboxed). git always goes through
 * {@link git}: HostGit's guards, in the chat's sandbox when it has one.
 */
export class IdeCli {

	constructor(private readonly stdio: IVoltStdioService, private readonly cwd: string | undefined, private readonly exec: IChatExec) { }

	/** The programs run in the chat's OS sandbox. */
	get sandboxed(): boolean {
		return !!this.exec.sandbox;
	}

	async run(file: string, args: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> }): Promise<ICliResult> {
		const cwd = options?.cwd ?? this.cwd;
		if (!cwd) {
			return NO_FOLDER;
		}
		const timeoutMs = options?.timeoutMs ?? 60_000;
		if (this.stdio.execFile && !options?.env && !this.exec.context.sandboxed && !this.exec.sandbox) {
			const result = await this.stdio.execFile({ file, args, ...(cwd ? { cwd } : {}), timeoutMs, maxBytes: MAX_OUTPUT });
			const missing = !!result.error && /ENOENT|not found|cannot find/i.test(result.error);
			return { code: result.exitCode, stdout: result.stdout, stderr: result.error && !result.stderr ? result.error : result.stderr, ...(missing ? { missing } : {}) };
		}
		return this.shell([file, ...args].map(arg => shellQuote(arg, isWindows)).join(' '), { ...(cwd ? { cwd } : {}), timeoutMs, ...(options?.env ? { env: options.env } : {}) });
	}

	/** A shell command line (the agent's own command, as written). */
	async shell(command: string, options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> }): Promise<ICliResult> {
		const cwd = options?.cwd ?? this.cwd;
		if (!cwd) {
			return NO_FOLDER;
		}
		const result = await this.stdio.exec({ id: `volt-ide-${generateUuid()}`, command, cwd, ...(options?.env ? { env: options.env } : {}), timeoutMs: options?.timeoutMs ?? 120_000, inlineChars: 200_000, ...this.exec });
		if (result.refused) {
			return { code: null, stdout: '', stderr: result.refused.reason, refused: result.refused.reason };
		}
		const missing = result.exitCode === 127 || /command not found|is not recognized/.test(result.stderr);
		return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(missing ? { missing } : {}) };
	}

	/** git in the chat's folder: through HostGit (no fsmonitor, hooks or `ext::`), inside the chat's sandbox when it has one. */
	async git(args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<ICliResult> {
		if (!this.cwd) {
			return NO_FOLDER;
		}
		const result = await runChatGit(this.stdio, this.exec, { id: `volt-ide-git-${generateUuid()}`, cwd: this.cwd, args, timeoutMs: options?.timeoutMs ?? 30_000, maxChars: MAX_OUTPUT });
		const missing = result.exitCode === 127 || /command not found|is not recognized|ENOENT/.test(result.stderr);
		return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(missing ? { missing } : {}), ...(result.refused ? { refused: result.refused } : {}) };
	}
}

export function ok(text: string, changes?: readonly IVoltHostFileChange[]): IIdeCapabilityResult {
	return { text, ...(changes?.length ? { changes } : {}) };
}

export function fail(text: string): IIdeCapabilityResult {
	return { text, isError: true };
}

/** A CLI result as tool text: the output (trimmed to the last lines), or why it failed. */
export function cliText(result: ICliResult, tool: string, maxLines = 120): IIdeCapabilityResult {
	if (result.refused) {
		return fail(`${tool} did not run: ${result.refused}`);
	}
	if (result.missing) {
		return fail(`${tool} is not installed or not on PATH.`);
	}
	const out = tail(stripAnsi(result.stdout).trim(), maxLines);
	const err = tail(stripAnsi(result.stderr).trim(), 40);
	if (result.code !== 0) {
		return fail(`${tool} exited with ${result.code ?? 'no code'}.${err ? `\n${err}` : ''}${out ? `\n${out}` : ''}`);
	}
	return ok(out || err || 'Done.');
}

export function tail(text: string, maxLines: number): string {
	const lines = text.split('\n');
	return lines.length > maxLines ? `[${lines.length - maxLines} earlier lines]\n${lines.slice(-maxLines).join('\n')}` : text;
}

export function str(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = args[key];
	return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined;
}

export function num(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = args[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

export function list(args: Readonly<Record<string, unknown>>, key: string): string[] {
	const value = args[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

export function resolvePath(root: URI | undefined, raw: string | undefined): URI | undefined {
	if (!raw) {
		return undefined;
	}
	return isAbsolute(raw) ? URI.file(raw) : root ? joinPath(root, raw) : undefined;
}

export function display(root: URI | undefined, uri: URI): string {
	return (root && relativePath(root, uri)) || uri.fsPath;
}

/** A Kubernetes/Docker name or a git ref: no spaces, no option-looking values. */
export function safeName(value: string | undefined): string | undefined {
	return value && /^[\w][\w.:/@+=-]*$/.test(value) ? value : undefined;
}
