/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'child_process';
import { ISandboxBackendCapabilities, ISandboxRunDenial, SandboxBackendId } from '../common/sandboxBackend.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { SandboxDimension } from '../common/sandboxSchema.js';

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
	/** Test builds only: make one launch step fail (FAULT-*). A fault can only refuse, never widen. */
	readonly fault?: SandboxFault;
}

/**
 * Launch steps a test can make fail.
 * - `attest`: the external attestation reports a failure, as if the evidence were wrong.
 * - `withhold-go`: attestation passes but the go byte is never sent (the backend waits until killed).
 * - `wrong-go`: a byte other than the go byte is sent.
 */
export type SandboxFault = 'attest' | 'withhold-go' | 'wrong-go';

/** What the parent observed about the sandboxed process from outside it, and what the canary reported (F.12). */
export interface ISandboxEvidence {
	readonly evidence: Readonly<Record<string, string | number | boolean>>;
	readonly canary: Readonly<Record<string, string>>;
	/** `bubblewrap --version`, the helper and macOS version. */
	readonly backendVersion: string;
}

export type SandboxConfirmation =
	| { readonly ok: true; readonly detail: string; readonly attestation?: ISandboxEvidence }
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
	 * The launch protocol's second half (F.5): waits for the prologue's ready line, attests the
	 * process from outside (Seatbelt: `sandbox_check` on its pid; bubblewrap: its `/proc` status
	 * and namespaces), checks the canary, and only then sends the go byte that lets the workload
	 * run. Resolves with an error, and never sends the go byte, when any of it fails or the
	 * launcher died first. Never resolves `ok` on a guess or on the workload's own word.
	 */
	confirm(child: ChildProcess): Promise<SandboxConfirmation>;
	/** Dimensions this launch cannot enforce beyond the backend's report (shown, never blocking). */
	readonly unenforced?: readonly SandboxDimension[];
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
