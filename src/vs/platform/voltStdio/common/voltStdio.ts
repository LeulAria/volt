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

export interface IVoltStdioSpawnOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** Run the process tree in the OS sandbox (Seatbelt / Landlock). */
	sandbox?: IVoltSandboxRequest;
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
	readonly mechanism: 'seatbelt' | 'landlock' | 'bwrap' | 'none';
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
	/** Characters returned inline per stream. Longer output is shaped head + tail and spilled. */
	readonly inlineChars?: number;
	/** Directory for the full log when output is shaped. */
	readonly spillDir?: string;
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
}
