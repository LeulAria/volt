/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISandboxLimits, IVoltSandboxPolicy, limitDimension, SANDBOX_DIMENSIONS, SandboxDimension } from './sandboxSchema.js';

/**
 * What a backend promises, the isolation states a run moves through, and the check that refuses
 * a policy a backend cannot enforce. Backend-independent: nothing here knows about bubblewrap or
 * Seatbelt.
 */

export type SandboxBackendId = 'bubblewrap' | 'seatbelt' | 'mxc' | 'unsupported';

/**
 * Dimensions the spec lets a platform enforce only partly (F.3 "optional", F.8): resource limits
 * that are polled rather than hard, and protections for paths created after launch. A backend
 * may list these in `optional`; anything else it does not enforce stays blocking.
 */
export const OPTIONAL_DIMENSIONS: readonly SandboxDimension[] = ['filesystem.protectNew', 'limits.cpu', 'limits.memory', 'limits.processes', 'limits.fileSize', 'limits.openFiles'];

/** How well a backend enforces one dimension. `partial` carries the reason in `notes`. */
export type SandboxEnforcement = 'enforced' | 'partial' | 'unsupported';

export interface ISandboxBackendCapabilities {
	readonly backend: SandboxBackendId;
	/** The backend can run anything at all. False: every run is refused with `diagnostics`. */
	readonly available: boolean;
	readonly enforcement: Readonly<Record<SandboxDimension, SandboxEnforcement>>;
	/** Why a dimension is partial or unsupported, in one line each. */
	readonly notes: Readonly<Partial<Record<SandboxDimension, string>>>;
	/** Version strings and probe results: "bubblewrap 0.9.0", "user namespaces: ok". */
	readonly details: readonly string[];
	/** Actionable problems: "Install bubblewrap: sudo apt install bubblewrap". */
	readonly diagnostics: readonly string[];
	/**
	 * Dimensions this platform enforces only partly by design, which run as `partial` instead of
	 * refusing even when a policy did not mark them best effort. Only `OPTIONAL_DIMENSIONS` count.
	 */
	readonly optional?: readonly SandboxDimension[];
}

/**
 * - `unavailable`: refused before anything ran (no backend, or a required dimension it cannot enforce).
 * - `partial`: running, with exactly `unenforced` not enforced (all of them marked best effort).
 * - `initialized`: running, every dimension of the policy enforced, confirmed by the backend.
 * - `failed`: the backend could not establish the sandbox; the workload did not run.
 * - `completed`: ran and exited.
 */
export type SandboxIsolationStatus = 'unavailable' | 'partial' | 'initialized' | 'failed' | 'completed';

export interface ISandboxEnforcementCheck {
	/** Dimensions the policy uses that the backend does not fully enforce. */
	readonly unenforced: readonly SandboxDimension[];
	/** The subset that is not best effort: any of these refuses the run. */
	readonly blocking: readonly SandboxDimension[];
}

/**
 * The dimensions a policy actually depends on. A policy with no network never needs
 * `network.proxy`. `syscalls` (kernel attack-surface reduction) is how a backend hardens itself,
 * not something a policy asks for: it is reported in the capabilities, never required.
 */
export function dimensionsUsed(policy: IVoltSandboxPolicy): SandboxDimension[] {
	const used = new Set<SandboxDimension>(['filesystem.write', 'process.tree', 'process.isolation', 'env.clear', 'host.unixSockets']);
	if (!policy.filesystem.read.includes('/')) {
		used.add('filesystem.read');
	}
	if (policy.filesystem.deny.some(entry => !entry.startsWith('**/'))) {
		used.add('filesystem.deny');
	}
	if (policy.filesystem.protect.some(entry => !entry.startsWith('**/'))) {
		used.add('filesystem.protect');
	}
	// Any deny or protect entry may name a path that does not exist at launch (a pattern always
	// can): guarding those is its own dimension, which bubblewrap cannot enforce.
	if (policy.filesystem.deny.length || policy.filesystem.protect.length) {
		used.add('filesystem.protectNew');
	}
	if (policy.network.mode === 'none') {
		used.add('network.none');
	}
	if (policy.network.mode === 'proxy') {
		used.add('network.proxy');
	}
	if (policy.network.mode !== 'host') {
		if (policy.network.loopbackPorts.length) {
			used.add('network.loopbackPorts');
		}
		if (!policy.network.listen) {
			used.add('network.listen');
		}
	}
	for (const [key, value] of Object.entries(policy.process.limits) as [keyof ISandboxLimits, number | undefined][]) {
		if (value !== undefined) {
			used.add(limitDimension(key));
		}
	}
	return SANDBOX_DIMENSIONS.filter(dimension => used.has(dimension));
}

export function checkEnforcement(policy: IVoltSandboxPolicy, capabilities: ISandboxBackendCapabilities): ISandboxEnforcementCheck {
	const unenforced = dimensionsUsed(policy).filter(dimension => capabilities.enforcement[dimension] !== 'enforced');
	const optional = (capabilities.optional ?? []).filter(dimension => OPTIONAL_DIMENSIONS.includes(dimension));
	return { unenforced, blocking: unenforced.filter(dimension => !policy.bestEffort.includes(dimension) && !optional.includes(dimension)) };
}

export function allEnforcement(value: SandboxEnforcement): Record<SandboxDimension, SandboxEnforcement> {
	return Object.fromEntries(SANDBOX_DIMENSIONS.map(dimension => [dimension, value])) as Record<SandboxDimension, SandboxEnforcement>;
}

/** Something the sandbox stopped or noticed during a run. */
export interface ISandboxRunDenial {
	readonly kind: 'read' | 'write' | 'network' | 'process' | 'launch' | 'limit';
	readonly target: string;
	/** `os`: kernel log or a backend report. `proxy`: Volt's network proxy. `manager`: limits and timeouts. */
	readonly source: 'os' | 'proxy' | 'manager';
	readonly process?: string;
}

export interface ISandboxRunResult {
	readonly status: SandboxIsolationStatus;
	readonly backend: SandboxBackendId;
	/** Null when the workload never ran or was killed by a signal. */
	readonly exitCode: number | null;
	readonly signal?: string;
	readonly stdout: string;
	readonly stderr: string;
	/** Output beyond the cap was dropped from the middle. */
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly unenforced: readonly SandboxDimension[];
	readonly denials: readonly ISandboxRunDenial[];
	readonly timing: { readonly prepareMs: number; readonly startMs: number; readonly totalMs: number };
	/** Why it was refused or failed, for `unavailable` and `failed`. Redacted. */
	readonly error?: string;
}

/** Thrown when a run is refused: no backend, a dimension it cannot enforce, or a bad policy. */
export class SandboxUnavailableError extends Error {
	constructor(
		message: string,
		readonly status: 'unavailable' | 'failed',
		readonly blocking: readonly SandboxDimension[] = [],
		readonly diagnostics: readonly string[] = [],
	) {
		super(message);
		this.name = 'SandboxUnavailableError';
	}
}

/**
 * Replaces the home folder with `~` and drops anything that looks like a secret, so diagnostics
 * and logs can be shown and shared.
 */
export function redactSandboxText(text: string, home: string | undefined): string {
	let out = text;
	if (home && home.length > 1) {
		out = out.split(home).join('~');
	}
	return out
		.replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…')
		.replace(/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1…')
		.replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Z0-9_]*=)[^\s'"]+/gi, '$1…');
}
