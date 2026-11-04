/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'child_process';
import { ISandboxBackendCapabilities, ISandboxRunDenial, SandboxBackendId } from '../common/sandboxBackend.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';

/**
 * The contract between the manager and an OS backend. A backend turns a resolved policy into a
 * process launch and proves the isolation was established. It never decides policy, never widens
 * what it was given, and refuses (throws) rather than launching with less than it reported.
 */

export interface ISandboxLaunchOptions {
	/** Unique per run: tags denials and names temp files. */
	readonly tag: string;
	/** Volt's filtering proxy on the host's loopback, when the network mode is `proxy`. */
	readonly proxyPort?: number;
	/** A PTY or a pipe: on a PTY the backend keeps the terminal's session (job control) and blocks TIOCSTI instead. */
	readonly terminal: boolean;
	readonly onDenial: (denial: ISandboxRunDenial) => void;
}

export type SandboxConfirmation =
	| { readonly ok: true; readonly detail: string }
	| { readonly ok: false; readonly error: string };

export interface ISandboxLaunchSpec {
	/** What to spawn: `/usr/bin/bwrap`, `/usr/bin/sandbox-exec`. */
	readonly command: string;
	readonly args: readonly string[];
	/**
	 * The environment to spawn `command` with. Seatbelt: the workload's whole environment
	 * (sandbox-exec is a platform binary that ignores loader variables). bubblewrap: empty, because
	 * bwrap runs outside the sandbox; the workload's variables reach it through `--setenv` on a pipe.
	 */
	readonly env: Readonly<Record<string, string>>;
	/** Host-side working directory for the spawn (the backend maps it inside the sandbox). */
	readonly cwd: string;
	/** File descriptors from 3 up: a number passes that open fd, `pipe` makes a pipe the backend reads in `confirm`. */
	readonly extraStdio: readonly (number | 'pipe')[];
	/**
	 * Resolves once the backend has evidence the sandbox is in place (bubblewrap's status fd,
	 * Seatbelt's post-`sandbox_init` marker), or with an error when the launcher failed before
	 * running the workload. Never resolves `ok` on a guess.
	 */
	confirm(child: ChildProcess): Promise<SandboxConfirmation>;
	/** Kills the whole process tree; resolves once every process found is signalled. Safe to call more than once and after exit. */
	terminate(child: ChildProcess): Promise<void> | void;
	/** Closes fds, stops bridges, deletes the backend's temp files. */
	dispose(): Promise<void>;
}

export interface ISandboxBackend {
	readonly id: SandboxBackendId;
	/** Cached by the caller; cheap enough to run at startup. */
	probe(): Promise<ISandboxBackendCapabilities>;
	/** Throws `SandboxUnavailableError` when it cannot enforce the policy as probed. */
	launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec>;
}
