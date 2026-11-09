/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAdminPolicy } from '../../voltSandbox/common/authority.js';
import { Event } from '../../../base/common/event.js';
import { IVoltPluginAvailability, IVoltPluginFolders, IVoltPluginStatus, IVoltPluginToolRequest, IVoltPluginToolResult } from '../../voltPlugins/common/pluginHosts.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IBuildEntryChange, IHostGitRequest, IHostGitResult } from '../../voltGit/common/hostGit.js';
import type { ISandboxDenial } from '../../voltSandbox/common/sandboxDenials.js';
import type { IVoltSandboxRequest } from '../../voltSandbox/common/sandboxPolicy.js';
import type { ISandboxWorkloadInfo } from '../../voltSandbox/common/sandboxWorkloads.js';
import type { SubjectKey } from '../../voltSandbox/common/principals.js';
import type { ITrustChange, ITrustCommitResult, ITrustHistoryEntry, ITrustState } from '../../voltSandbox/common/trust.js';

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
	/**
	 * `no-context`: nobody said who it runs for. `no-sandbox`: a sandboxed chat's process without its
	 * sandbox. `sandbox`: the sandbox could not be set up. `build-entry`: project-defined commands
	 * outside the sandbox while files that run code changed unreviewed (I.6).
	 */
	readonly kind: 'no-context' | 'no-sandbox' | 'sandbox' | 'build-entry';
	readonly reason: string;
	/**
	 * A sandboxed host: the supervisor's step that refused (F.5 rule 5): `disabled` (the supervisor
	 * flag is off), `policy`, `budget`, `probe`, `attest`, `launch`, or a sandbox dimension.
	 */
	readonly step?: string;
}

/**
 * A stdio MCP server for a sandboxed chat, run as a long-lived sandboxed host under Volt's
 * supervisor (spec M.3 C6): its own principal, a policy that is the chat's narrowed, attested before
 * it runs, quotas, idle stop and crash restarts. The id it returns works with `write`, `kill`,
 * `onData` and `onExit` like a spawn's.
 */
export interface IVoltSandboxedMcpRequest {
	/** The chat it works for: its servers stop with it ({@link IVoltStdioService.stopSandboxedHosts}). */
	readonly chatId: string;
	/** The chat's title, for the Security page. */
	readonly chatLabel?: string;
	/** The server's name in its config. */
	readonly server: string;
	/** sha256 (hex) of the server's canonical config (`mcpConfigDigest`): its principal's subject. */
	readonly digest: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	/** Hosts approved for the server (its config); none: no network. */
	readonly allowedHosts?: readonly string[];
	/** The chat's sandbox. Required: a host for a chat that is not sandboxed is refused. */
	readonly sandbox: IVoltSandboxRequest;
	readonly context: IVoltExecContext;
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
	/**
	 * A sandboxed host crashed and the supervisor restarts it (`restarting`), or the new instance runs
	 * (`restarted`): what the old instance was asked is lost, and a protocol must start over.
	 */
	readonly host?: 'restarting' | 'restarted';
}

export interface IVoltSandboxSupportInfo {
	readonly platform: string;
	readonly mechanism: 'seatbelt' | 'bwrap' | 'mxc' | 'none';
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
	/**
	 * A sandboxed command: what its sandbox stopped while it ran (noise and quiet denials left out),
	 * so the chat can show its Volt Guard card for a command its own model ran (native models).
	 */
	readonly sandboxDenials?: readonly ISandboxDenial[];
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
	/** The managed (admin) policy this execution host enforces; the window's gates judge by it too. */
	managedPolicy?(): Promise<IAdminPolicy>;
	/** Lets a sandboxed process (network off) reach more hosts, without a restart. */
	allowSandboxDomains?(id: string, domains: readonly string[]): Promise<void>;
	/**
	 * Whether the sandbox of spawn `id` lets it read or write `path`. For file access the agent
	 * routes through Volt (ACP `fs/*`), which happens outside the agent's process. True when the
	 * spawn is running and not sandboxed; false for an id this service does not know (fails closed).
	 */
	sandboxAllows?(id: string, path: string, access: 'read' | 'write'): Promise<boolean>;
	/**
	 * Runs git through HostGit (`platform/voltGit/common/hostGit.ts`): the only way Volt's own code
	 * runs git. No repository fsmonitor, hook or `ext::` remote runs, and a redirected repository
	 * (a planted `commondir`) is refused. Cancel with `cancelExec(request.id)`.
	 */
	git?(request: IHostGitRequest): Promise<IHostGitResult>;
	/** Execution-bearing files in `root` that changed since a sandboxed writer started there (I.6). */
	buildEntryChanges?(root: string): Promise<readonly IBuildEntryChange[]>;
	/** The user reviewed the changes in `root` (all, or `paths`): they become the baseline. */
	acceptBuildEntries?(root: string, paths?: readonly string[]): Promise<void>;
	/**
	 * Reads `path` for sandboxed spawn `id`: checked against its sandbox on the real path, opened
	 * without following a symlink anywhere in the path (B-17). Refused for an id that is not a
	 * running sandboxed spawn.
	 */
	sandboxReadFile?(id: string, path: string): Promise<IVoltSandboxFileResult>;
	/** Writes `path` for sandboxed spawn `id`, the same way; a file with more than one link is refused. */
	sandboxWriteFile?(id: string, path: string, content: string): Promise<IVoltSandboxFileResult>;
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
	/**
	 * After a turn of sandboxed spawn `id`: copies the allowed keys of its config overlay back to the
	 * user's config (B-05) and says what it kept out. Undefined when the spawn has no overlay.
	 */
	syncSandboxState?(id: string): Promise<IVoltSandboxStateSync | undefined>;
	/**
	 * Every sandboxed process this service runs (agents, commands, terminals, long-lived hosts),
	 * with its principal, backend, attestation evidence, policy and resource use: the Security page.
	 */
	sandboxWorkloads?(): Promise<readonly ISandboxWorkloadInfo[]>;
	/** Stops sandboxed workload `id` (a row of {@link sandboxWorkloads}) and its whole process tree. */
	stopSandboxWorkload?(id: string): Promise<boolean>;
	/** A sandboxed workload started, changed state or ended. */
	readonly onDidChangeSandboxWorkloads?: Event<void>;
	/** Whether Volt's T2 plugins (Memory) can run in sandboxed hosts here (spec H.1, F.13). */
	pluginAvailability?(): Promise<IVoltPluginAvailability>;
	/** Calls a tool of a built-in T2 plugin; its host starts on the first call (H.2). Never throws: a refusal is `error`. */
	invokePluginTool?(request: IVoltPluginToolRequest): Promise<IVoltPluginToolResult>;
	/** The context block a built-in T2 plugin adds to a new agent's prompt (capped), if any. */
	pluginContext?(plugin: string, folders: IVoltPluginFolders): Promise<string | undefined>;
	/** Every built-in T2 plugin's state (H.9: broken plugins, their stderr). */
	pluginStatus?(): Promise<readonly IVoltPluginStatus[]>;
	/** "Restart" on a broken plugin. */
	restartPlugin?(plugin: string): Promise<void>;
	/** A T2 plugin's state changed. */
	readonly onDidChangePlugins?: Event<void>;
	/**
	 * Starts a stdio MCP server for a sandboxed chat under the supervisor (see
	 * {@link IVoltSandboxedMcpRequest}). Resolves once it is attested and running. Rejects with a
	 * {@link VoltExecRefusedError} (message `... (<step>): <reason>`) when it is refused; nothing ran.
	 */
	spawnSandboxedMcp?(request: IVoltSandboxedMcpRequest): Promise<string>;
	/** The chat closed or its grants were revoked: every host started for it stops, whole trees. */
	stopSandboxedHosts?(chatId: string): Promise<number>;
	/**
	 * The Allow buttons of a network denial card (spec I.4 "Approval", P4): names the broker's
	 * denial of spawn `id` and the epoch it was refused at; the broker rebuilds the rule from its own
	 * record. `run`: this run of the agent; `chat`: every later run of the chat, kept in the grant
	 * store until revoked. Refused when the denial is not that spawn's, or the epoch moved.
	 */
	approveSandboxDenial?(id: string, denialId: string, expectedEpoch: number, scope: 'run' | 'chat'): Promise<IVoltSandboxApproval>;
	/** Skip on a denial card: counts toward the route's refusals (two auto-deny, G.12). */
	refuseSandboxDenial?(id: string, denialId: string): Promise<boolean>;
	/** The grant store (`~/.volt/trust/grants.json`) as the Access page shows it. */
	trustState?(): Promise<ITrustState>;
	/** Records the user's grants and refusals, revokes, and drops subjects; revocations close tunnels they allowed. */
	trustCommit?(change: ITrustChange): Promise<ITrustCommitResult>;
	/** The Access page's history: the Authority's decision log and the brokers' audit logs, newest first. */
	trustHistory?(limit: number, subject?: SubjectKey): Promise<readonly ITrustHistoryEntry[]>;
	/** Open routes' prompt budgets (G.12). */
	trustPromptBudgets?(): Promise<readonly IVoltPromptBudget[]>;
	/** The Access page was opened: prompts may be offered again (G.12). */
	resetPromptBudgets?(subject?: SubjectKey): Promise<void>;
	/** The grant store changed (in this process or another Volt process). */
	readonly onDidChangeTrust?: Event<{ readonly epoch: number; readonly narrowed: boolean }>;
}

export type IVoltSandboxApproval = { readonly ok: true; readonly epoch: number } | { readonly ok: false; readonly epoch: number; readonly reason: string };

export interface IVoltPromptBudget {
	readonly subject: SubjectKey;
	readonly refusals: number;
	readonly autoDenied: boolean;
	readonly promptsToday: number;
}

/** What one merge of an agent's config overlay did. */
export interface IVoltSandboxStateSync {
	/** Keys copied back to the user's config. */
	readonly applied: readonly string[];
	/** Changes kept out of it (MCP servers, trusted folders, permissions), as key paths. */
	readonly dropped: readonly string[];
}

/** HostGit through the stdio service; a service without it (a test double, a null host) refuses. */
export async function runGitThrough(stdio: IVoltStdioService, request: IHostGitRequest): Promise<IHostGitResult> {
	if (!stdio.git) {
		return { exitCode: null, stdout: '', stderr: 'git is not available here', error: 'git is not available here', refused: true };
	}
	try {
		return await stdio.git(request);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: null, stdout: '', stderr: message, error: message };
	}
}

/** A file read or written for a sandboxed spawn. */
export type IVoltSandboxFileResult =
	| {
		readonly ok: true;
		/** The final path of the opened file. */
		readonly path: string;
		/** Read: the file's text. Write: what it held before (undefined when the write created it). */
		readonly content?: string;
	}
	| { readonly ok: false; readonly reason: string };
