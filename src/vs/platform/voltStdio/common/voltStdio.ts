/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { ISandboxDenial } from '../../voltSandbox/common/sandboxDenials.js';
import type { IVoltSandboxRequest } from '../../voltSandbox/common/sandboxPolicy.js';

export const IVoltStdioService = createDecorator<IVoltStdioService>('voltStdioService');
export const VOLT_STDIO_CHANNEL_NAME = 'voltStdio';

/**
 * Why Volt starts a process. Every spawn and command says, so the log and the spawn audit can tell
 * work done for a chat (which must run in the chat's sandbox when it has one) from the user's own
 * clicks and Volt's bookkeeping.
 */
export type VoltExecReason =
	/** A chat's agent CLI (ACP, Codex app server, a CLI agent's print mode). */
	| 'agent'
	/** A command a chat's own model runs (the native loop's shell and git tools). */
	| 'agent-shell'
	/** The project's tests, run after a chat's turn changed files. */
	| 'post-turn-check'
	/** A terminal or a helper a chat's agent asked for (terminal_start, docker_ensure, app_open). */
	| 'terminal'
	/** Setup scripts of a chat's new worktree. */
	| 'worktree-setup'
	/** A workflow step. */
	| 'workflow'
	/** A hook the user or the project defined, around a chat's tool calls and turns. */
	| 'hook'
	/** A chat's title or commit message, written by a one-off agent call. */
	| 'title'
	/** Volt asks an agent CLI what it offers (models, login), for no chat. */
	| 'probe'
	/** A Volt MCP server from the project's or the user's config. */
	| 'mcp'
	/** Volt's own bookkeeping for a chat (git status for its change list), with no agent input. */
	| 'volt'
	/** The user clicked something (an install, a setup check, a settings page). */
	| 'user-action';

/**
 * Who a process runs for (spec B-04, B-06, INV-03). A chat's own work names the chat; work Volt
 * does around a chat names it in `onBehalfOf`. A chat in Volt's OS sandbox gets its processes in
 * that sandbox, with its rules: a request that says `sandboxed` but carries no `sandbox` is
 * refused, never run unconfined.
 */
export interface IVoltExecContext {
	/** `chat:<id>`: a chat's agent or tools; `volt`: Volt's own work; `user`: the user's click. */
	readonly principal: `chat:${string}` | 'volt' | 'user';
	/** The chat a `volt` or `user` process acts for, if any. */
	readonly onBehalfOf?: string;
	readonly reason: VoltExecReason;
	/** The chat (principal or `onBehalfOf`) runs in Volt's OS sandbox. */
	readonly sandboxed: boolean;
}

/** Why a spawn or command was refused before anything ran. */
export interface IVoltExecRefusal {
	/** `no-context`: nobody said who it runs for. `no-sandbox`: a sandboxed chat's process without its sandbox. `sandbox`: the sandbox could not be set up. */
	readonly kind: 'no-context' | 'no-sandbox' | 'sandbox';
	readonly reason: string;
}

/** A spawn refused by {@link execRefusal} or by the sandbox: it did not start. */
export class VoltExecRefusedError extends Error {
	constructor(readonly refusal: IVoltExecRefusal) {
		super(refusal.reason);
		this.name = 'VoltExecRefusedError';
	}
}

/**
 * Why a process must not start as asked, or undefined when it may. Fails closed: a request with no
 * context, or a sandboxed chat's request without its sandbox, is refused.
 */
export function execRefusal(context: IVoltExecContext | undefined, sandbox: IVoltSandboxRequest | undefined): IVoltExecRefusal | undefined {
	if (!context || typeof context.reason !== 'string' || typeof context.principal !== 'string') {
		return { kind: 'no-context', reason: 'Volt did not say who this process runs for, so it was not started.' };
	}
	if (context.sandboxed && !sandbox) {
		const chat = context.principal.startsWith('chat:') ? context.principal.slice('chat:'.length) : context.onBehalfOf;
		return { kind: 'no-sandbox', reason: `This chat${chat ? ` (${chat})` : ''} runs in Volt's sandbox, and this ${context.reason} process was asked for without it, so it was not started.` };
	}
	return undefined;
}

/** One line for logs: `chat:abc post-turn-check sandboxed`. */
export function describeExecContext(context: IVoltExecContext): string {
	return `${context.principal}${context.onBehalfOf ? ` for ${context.onBehalfOf}` : ''} ${context.reason}${context.sandboxed ? ' sandboxed' : ''}`;
}

export interface IVoltStdioSpawnOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/**
	 * Run the process tree in the OS sandbox (Seatbelt / bubblewrap). The spawn is rejected with a
	 * `SandboxUnavailableError` when the sandbox cannot be established; it never runs without it.
	 */
	sandbox?: IVoltSandboxRequest;
	/** Who it runs for; see {@link IVoltExecContext}. */
	readonly context: IVoltExecContext;
}

/** A command for a sandboxed chat, to run on a PTY (a managed terminal) inside the chat's sandbox. */
export interface IVoltSandboxedTerminalRequest {
	/** Caller-chosen; names the terminal in the later calls. */
	readonly id: string;
	/** The shell, and its arguments (`-c <command line>`). */
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly sandbox: IVoltSandboxRequest;
	readonly context: IVoltExecContext;
}

/** What to start on the PTY: a fixed launcher that opens the sandbox's control channels, then the sandbox. */
export interface IVoltSandboxedTerminalLaunch {
	readonly file: string;
	readonly args: readonly string[];
	/** The complete environment. Nothing else may be merged in. */
	readonly env: Record<string, string>;
	readonly cwd: string;
}

/** Something the OS sandbox of a spawned process did: a denial, or a warning that it is weaker than asked. */
export interface IVoltSandboxEvent {
	/** The spawn id. */
	readonly id: string;
	readonly denial?: ISandboxDenial;
	readonly warning?: string;
}

export interface IVoltSandboxSupportInfo {
	readonly platform: string;
	readonly mechanism: 'seatbelt' | 'bwrap' | 'none';
	readonly filesystem: boolean;
	readonly network: boolean;
	readonly detail: string;
}

/** One shell command. The caller picks `id` so it can cancel the command or read its job later. */
export interface IVoltExecRequest {
	readonly id: string;
	/** A shell command line, run by the user's shell with their resolved environment. */
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	/** The whole process tree is killed when this passes. */
	readonly timeoutMs: number;
	/**
	 * Keep the process running as a job and return after `backgroundWaitMs` (or on exit, if
	 * sooner) with the output so far. Read it later with `jobOutput` / `jobWait`.
	 */
	readonly background?: boolean;
	readonly backgroundWaitMs?: number;
	/**
	 * A foreground command still running after this long hands control back: the call returns
	 * with the output so far and `running: true`, and the command goes on as a job (read it with
	 * `jobOutput` / `jobWait`). It is stopped only by `timeoutMs` or `cancelExec`.
	 */
	readonly yieldAfterMs?: number;
	/** Characters returned inline per stream. Longer output is shaped head + tail and spilled. */
	readonly inlineChars?: number;
	/** Directory for the full log when output is shaped. */
	readonly spillDir?: string;
	/**
	 * Run the shell in the OS sandbox of this chat (the agent profile). A command that cannot be
	 * sandboxed does not run: the result has `exitCode: null` and says why in `stderr`.
	 */
	readonly sandbox?: IVoltSandboxRequest;
	/** Who it runs for; see {@link IVoltExecContext}. A refused command has `refused` set. */
	readonly context: IVoltExecContext;
}

/** A program run directly, without a shell: its arguments are passed as they are, never parsed. */
export interface IVoltExecFileRequest {
	/** Looked up on the user's PATH (with `.exe`/`.cmd` on Windows) when not a path. */
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs: number;
	/** Output beyond this many bytes per stream fails the call (default 1 MB). */
	readonly maxBytes?: number;
}

export interface IVoltExecFileResult {
	/** Null when the program could not start or was stopped. */
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** Why it did not run to completion (not found, timed out, too much output). */
	readonly error?: string;
}

export interface IVoltExecResult {
	readonly id: string;
	readonly exitCode: number | null;
	readonly signal?: string;
	readonly stdout: string;
	readonly stderr: string;
	/** Both streams interleaved in arrival order, shaped like the others. */
	readonly combined: string;
	/** Output was shaped; `logPath` holds all of it when a spill directory was given. */
	readonly truncated: boolean;
	readonly logPath?: string;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	/** A background job that is still running. */
	readonly running: boolean;
	/** Nothing ran: who it was for did not allow it, or its sandbox could not be set up. */
	readonly refused?: IVoltExecRefusal;
}

export interface IVoltJobOutput {
	readonly id: string;
	readonly command: string;
	readonly output: string;
	/** Pass back as `since` to read only what came after. */
	readonly offset: number;
	readonly running: boolean;
	readonly exitCode: number | null;
	/** `jobWait` only: the `until` pattern matched. */
	readonly matched?: boolean;
}

export interface IVoltStdioService {
	readonly _serviceBrand: undefined;
	readonly onData: Event<{ id: string; data: string }>;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }>;
	spawn(options: IVoltStdioSpawnOptions): Promise<string>;
	write(id: string, data: string): Promise<void>;
	kill(id: string): Promise<void>;
	which(command: string): Promise<string | undefined>;
	/** Runs one command and returns its separated output in a single round trip. */
	exec(request: IVoltExecRequest): Promise<IVoltExecResult>;
	/** Runs a program without a shell (safe for untrusted arguments on every platform). */
	execFile?(request: IVoltExecFileRequest): Promise<IVoltExecFileResult>;
	/** Kills a running command or job and its whole process tree. */
	cancelExec(id: string): Promise<void>;
	jobOutput(id: string, since?: number): Promise<IVoltJobOutput | undefined>;
	/** Waits until the job exits, `until` (a regex source) matches new output, or `timeoutMs` passes. */
	jobWait(id: string, timeoutMs: number, until?: string, since?: number): Promise<IVoltJobOutput | undefined>;
	listJobs(): Promise<readonly IVoltJobOutput[]>;
	/** Denials and warnings of sandboxed spawns. Absent where processes cannot be sandboxed. */
	readonly onSandboxEvent?: Event<IVoltSandboxEvent>;
	/** What OS sandboxing this machine offers. */
	sandboxSupport?(): Promise<IVoltSandboxSupportInfo>;
	/** Lets a sandboxed process (network off) reach more hosts, without a restart. */
	allowSandboxDomains?(id: string, domains: readonly string[]): Promise<void>;
	/**
	 * Whether the sandbox of spawn `id` lets it read or write `path`. For file access the agent
	 * routes through Volt (ACP `fs/*`), which happens outside the agent's process. True when the
	 * spawn is not sandboxed.
	 */
	sandboxAllows?(id: string, path: string, access: 'read' | 'write'): Promise<boolean>;
	/**
	 * A sandboxed chat's terminal (spec F.6). node-pty passes no extra file descriptors, so the
	 * sandbox's control channels are FIFOs in the run's private folder, opened by the launcher this
	 * returns. Start it on a PTY, then {@link confirmSandboxedTerminal}. Rejects (nothing to start)
	 * when the sandbox cannot be set up.
	 */
	prepareSandboxedTerminal?(request: IVoltSandboxedTerminalRequest): Promise<IVoltSandboxedTerminalLaunch>;
	/**
	 * Confirms from outside that process `pid` (the PTY's) is in its sandbox, and resolves with the
	 * line to type so the shell starts; until then the shell does not run and no other input may be
	 * written. Rejects when the sandbox was not established: the process tree is killed.
	 */
	confirmSandboxedTerminal?(id: string, pid: number): Promise<string>;
	/** The terminal exited or is being stopped: its sandbox's whole tree is killed and its run folder removed. */
	endSandboxedTerminal?(id: string): Promise<void>;
}
