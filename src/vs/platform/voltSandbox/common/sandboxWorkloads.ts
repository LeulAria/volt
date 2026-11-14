/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAttestation, ISandboxRunDenial, redactSandboxText, SandboxBackendId } from './sandboxBackend.js';
import { isNoiseDenial } from './sandboxDenials.js';
import { IResolvedSandboxPolicy } from './sandboxResolved.js';
import { SandboxDimension } from './sandboxSchema.js';

/**
 * What the execution host reports about the sandboxed processes it runs (spec F.4, F.6, F.8,
 * F.12): one row per workload for the Security page. Pure types and helpers; the supervisor that
 * keeps them is `node/supervisor.ts`.
 */

/** Feature flag (application scope) for the supervisor path of long-lived hosts (M.3 C5 rollback). */
export const SANDBOX_SUPERVISOR_SETTING = 'volt.sandbox.supervisor.enabled';

/** `command`: one-shot or one per chat (agents, commands, terminals). `host`: started by the supervisor, restarted on a crash. */
export type SandboxWorkloadLifetime = 'command' | 'host';

/** F.6, as far as a running workload can be in it. */
export type SandboxWorkloadState =
	| 'launching'
	| 'attesting'
	| 'running'
	| 'idle'
	| 'backoff'
	| 'broken'
	| 'stopping'
	| 'stopped'
	| 'failed';

/** Why a host's process ended. */
export type SandboxExitReason =
	/** It exited on its own with code 0. */
	| 'exit'
	/** It exited on its own otherwise, or was killed by a signal it did not get from Volt. */
	| 'crash'
	/** Someone asked: the Security page, the owner, a revocation. */
	| 'stopped'
	/** No activity for its idle budget. */
	| 'idle'
	/** Stopped to make room under the host budget. */
	| 'budget'
	/** Over a resource limit (F.8). */
	| 'resource'
	/** Volt is quitting. */
	| 'quit'
	/** The launch was refused or not attested; nothing ran. */
	| 'refused';

/** One sample of a workload's tree (F.8): 1 Hz for hosts, on request for the rest. */
export interface ISandboxResourceSample {
	readonly at: number;
	/** User + system CPU of every process in the tree, cumulative, in milliseconds. */
	readonly cpuMs: number;
	/** Resident memory of the tree (`poll`), or its physical footprint (`tracking`: the macOS helper). */
	readonly memoryBytes: number;
	/** Processes in the tree, the root included. */
	readonly processes: number;
	/** Which accounting sources the numbers came from (`poll`, a kernel layer's id). */
	readonly sources: readonly string[];
}

/** The policy a workload runs under, short enough to show. Paths under the home folder start with `~`. */
export interface ISandboxPolicySummary {
	readonly name: string;
	readonly network: 'none' | 'proxy' | 'host';
	/** Hosts the network proxy lets through when the run started; later grants are not part of the launch policy. */
	readonly allowedHosts: number;
	readonly readsEverything: boolean;
	readonly read: readonly string[];
	readonly write: readonly string[];
	readonly denied: number;
	readonly limits: { readonly memoryMB?: number; readonly cpuSeconds?: number; readonly wallClockSeconds?: number; readonly openFiles?: number };
}

export interface ISandboxWorkloadInfo {
	/** The run's tag; `stop` takes it. */
	readonly id: string;
	/** The principal's id once a registry mints it; the tag until then. */
	readonly principalId: string;
	/** `chat:<id>`, `firstparty:volt.x`, `mcp:<digest>`; absent for runs no principal was minted for yet. */
	readonly subject?: string;
	/** "claude-code agent", "terminal_start", the host's name. */
	readonly label: string;
	/** Who a host works for (an MCP server's chat): `subject` is `chat:<id>`, `label` the chat's title when known. */
	readonly onBehalfOf?: { readonly subject: string; readonly label?: string };
	readonly lifetime: SandboxWorkloadLifetime;
	readonly backend: SandboxBackendId;
	readonly state: SandboxWorkloadState;
	/** `sandboxed`: every dimension enforced. `partial`: `unenforced` lists what is not. */
	readonly status: 'sandboxed' | 'partial';
	readonly unenforced: readonly SandboxDimension[];
	/** External evidence the run started on (F.12). Absent until attested. */
	readonly attestation?: IAttestation;
	readonly policy: ISandboxPolicySummary;
	readonly startedAt: number;
	/** Hosts: launches after the first one (crash restarts). */
	readonly restarts?: number;
	readonly resources?: ISandboxResourceSample;
	/** A broken host's last error, or the reason it stopped. */
	readonly detail?: string;
	/**
	 * Hosts: what the sandbox refused it that a person should hear about ({@link isUserFacingDenial}),
	 * one entry per kind and target, least recent first, at most {@link MAX_WORKLOAD_DENIALS}.
	 */
	readonly denials?: readonly ISandboxWorkloadDenial[];
	/** Hosts: every user-facing refusal since it started, including those dropped from `denials`. */
	readonly deniedCount?: number;
}

/** One refusal a host met (all times it met it), as the window warns about it. */
export interface ISandboxWorkloadDenial {
	readonly kind: ISandboxRunDenial['kind'];
	/** A path (the home folder shown as `~`), or `host:port` for the network. */
	readonly target: string;
	/** Epoch ms of the last time. */
	readonly at: number;
	readonly count: number;
}

export const MAX_WORKLOAD_DENIALS = 20;

/**
 * Whether a refusal is something the host tried, not the runtime's own background noise: the
 * kernel also denies, on every launch, the run's own canary (the sandbox checking itself), Mach
 * lookups of system daemons (`launch`), and the preference and logging files CoreFoundation reads
 * at start. Telling the user about those would bury the one that matters.
 */
export function isUserFacingDenial(denial: Pick<ISandboxRunDenial, 'kind' | 'target'>): boolean {
	if (denial.kind === 'launch') {
		return false;
	}
	if (denial.kind === 'read' || denial.kind === 'write') {
		const target = denial.target;
		// The transcript's noise list, except temp folders: another run's temp is worth a warning here.
		const noise = isNoiseDenial({ kind: denial.kind, target, source: 'os' }) && !/^\/(private\/)?var\/folders\//.test(target);
		return !(noise
			|| /\/volt-sbx-[^/]+\/canary$/.test(target)
			|| target.endsWith('/.CFUserTextEncoding'));
	}
	return true;
}

/**
 * `routedHosts`: the hosts the network broker lets it reach that the policy does not list (an
 * extension host's declared `net.connect` targets live in its manifest view, not in its policy).
 */
export function summarizeSandboxPolicy(policy: IResolvedSandboxPolicy, routedHosts: readonly string[] = []): ISandboxPolicySummary {
	const redact = (path: string) => redactSandboxText(path, policy.home);
	return {
		name: policy.name,
		network: policy.network.mode,
		allowedHosts: new Set([...policy.network.allow, ...routedHosts]).size,
		readsEverything: policy.readAll,
		read: policy.readAll ? [] : policy.read.map(redact),
		write: policy.write.map(redact),
		denied: policy.deny.length + policy.denyPatterns.length,
		limits: {
			...(policy.limits.memoryMB !== undefined ? { memoryMB: policy.limits.memoryMB } : {}),
			...(policy.limits.cpuSeconds !== undefined ? { cpuSeconds: policy.limits.cpuSeconds } : {}),
			...(policy.limits.wallClockSeconds !== undefined ? { wallClockSeconds: policy.limits.wallClockSeconds } : {}),
			...(policy.limits.openFiles !== undefined ? { openFiles: policy.limits.openFiles } : {}),
		},
	};
}

/** Whether a host in this state still counts against the host budget and may be stopped. */
export function isLiveWorkloadState(state: SandboxWorkloadState): boolean {
	return state === 'launching' || state === 'attesting' || state === 'running' || state === 'idle' || state === 'backoff' || state === 'stopping';
}
