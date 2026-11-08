/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { composeSandboxPolicy } from './sandboxComposition.js';
import { builtinProfile, isSecretEnvName } from './sandboxProfiles.js';
import { envNameError, IVoltSandboxPolicy, IVoltSandboxPolicyLayer, networkEntryError, pathEntryError, SANDBOX_POLICY_SCHEMA_VERSION } from './sandboxSchema.js';

/**
 * Capabilities: the words an install sheet uses ("read workspace files", "connect to
 * api.github.com") and the evaluator that turns the ones a user granted into a sandbox policy.
 *
 * A capability is a request, not a permission. Nothing here trusts what a manifest declares: the
 * evaluator starts from `restricted` and adds only what is in the granted set, and the result is
 * enforced by the OS sandbox like any other policy. Unknown capabilities are errors.
 *
 * Grammar: `<kind>` or `<kind>:<argument>`.
 * - `fs.read:workspace`, `fs.write:workspace`, `fs.read:<path>`, `fs.write:<path>`
 * - `net.connect:<host>`, `net.connect:*` (any public host, via the proxy), `net.host` (unfiltered)
 * - `net.listen`, `net.loopback:<port>`
 * - `process.exec` (implied: everything runs as processes inside the sandbox)
 * - `git.local` (workspace git, hooks and config still protected), `git.remote:<host>`
 * - `env:<NAME>`, `socket:<path>`
 */

export type SandboxRisk = 'low' | 'medium' | 'high' | 'critical';

export const SANDBOX_RISK_ORDER: Readonly<Record<SandboxRisk, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface ISandboxCapabilityInfo {
	readonly id: string;
	readonly risk: SandboxRisk;
	/** What the install sheet says: "Read and change files in the workspace". */
	readonly description: string;
}

interface ICapabilityKind {
	readonly argument: 'none' | 'required' | 'optional';
	validate?(argument: string): string | undefined;
	describe(argument: string | undefined): Omit<ISandboxCapabilityInfo, 'id'>;
	layer(argument: string | undefined): Omit<IVoltSandboxPolicyLayer, 'schemaVersion'>;
}

function pathArgument(argument: string): string | undefined {
	return argument === 'workspace' ? undefined : pathEntryError(argument, false) ?? (argument === '/' ? 'cannot grant the whole filesystem' : undefined);
}

function pathRisk(argument: string, write: boolean): SandboxRisk {
	if (argument === '${home}' || argument === '/') {
		return 'critical';
	}
	if (argument.startsWith('${home}')) {
		return write ? 'critical' : 'high';
	}
	return write ? 'high' : 'medium';
}

function pathText(argument: string): string {
	return argument.replace(/^\$\{home\}/, '~').replace(/^\$\{workspace\}/, 'the workspace').replace(/^\$\{storage\}/, 'its own storage');
}

const KINDS: Readonly<Record<string, ICapabilityKind>> = {
	'fs.read': {
		argument: 'required',
		validate: pathArgument,
		describe: arg => arg === 'workspace'
			? { risk: 'low', description: 'Read files in the workspace' }
			: { risk: pathRisk(arg!, false), description: `Read files in ${pathText(arg!)}` },
		layer: arg => ({ filesystem: { read: [arg === 'workspace' ? '${workspace}' : arg!] } }),
	},
	'fs.write': {
		argument: 'required',
		validate: argument => argument === 'workspace' ? undefined : pathArgument(argument) ?? (argument === '${home}' ? 'cannot grant writing the whole home folder' : undefined),
		describe: arg => arg === 'workspace'
			? { risk: 'medium', description: 'Read and change files in the workspace (git hooks, editor tasks and shell startup files stay protected)' }
			: { risk: pathRisk(arg!, true), description: `Read and change files in ${pathText(arg!)}` },
		layer: arg => ({ filesystem: { write: [arg === 'workspace' ? '${workspace}' : arg!] } }),
	},
	'net.connect': {
		argument: 'required',
		validate: networkEntryError,
		describe: arg => arg === '*'
			? { risk: 'high', description: 'Connect to any public internet host (local network and cloud metadata stay blocked)' }
			: { risk: 'medium', description: `Connect to ${arg}` },
		layer: arg => ({ network: { mode: 'proxy', allow: [arg!] } }),
	},
	'net.host': {
		argument: 'none',
		describe: () => ({ risk: 'critical', description: 'Use the network without any filtering, including your local network and services on this machine' }),
		layer: () => ({ network: { mode: 'host' } }),
	},
	'net.listen': {
		argument: 'none',
		describe: () => ({ risk: 'low', description: 'Listen for connections on this machine (local servers)' }),
		layer: () => ({ network: { listen: true } }),
	},
	'net.loopback': {
		argument: 'required',
		validate: arg => /^\d{1,5}$/.test(arg) && Number(arg) >= 1 && Number(arg) <= 65535 ? undefined : 'must be a port',
		describe: arg => ({ risk: 'high', description: `Connect to the local service on port ${arg}` }),
		layer: arg => ({ network: { loopbackPorts: [Number(arg)] } }),
	},
	'process.exec': {
		argument: 'none',
		describe: () => ({ risk: 'low', description: 'Run programs (they run inside the same sandbox)' }),
		layer: () => ({}),
	},
	'git.local': {
		argument: 'none',
		describe: () => ({ risk: 'medium', description: 'Use git in the workspace (commit, branch; hooks and git config stay protected)' }),
		layer: () => ({ filesystem: { write: ['${workspace}'] } }),
	},
	'git.remote': {
		argument: 'required',
		validate: networkEntryError,
		describe: arg => ({ risk: 'high', description: `Push to and pull from ${arg} over HTTPS` }),
		layer: arg => ({ network: { mode: 'proxy', allow: [arg!] } }),
	},
	'env': {
		argument: 'required',
		validate: arg => envNameError(arg, false),
		describe: arg => isSecretEnvName(arg!)
			? { risk: 'high', description: `Read the environment variable ${arg}, which may hold a secret` }
			: { risk: 'low', description: `Read the environment variable ${arg}` },
		layer: arg => ({ env: { inherit: [arg!] } }),
	},
	'socket': {
		argument: 'required',
		validate: arg => pathEntryError(arg, false),
		describe: arg => /docker|podman|containerd/i.test(arg!)
			? { risk: 'critical', description: `Use ${arg}, which controls containers and gives full control of this machine` }
			: { risk: 'high', description: `Talk to the local service at ${arg}` },
		layer: arg => ({ host: { unixSockets: [arg!] } }),
	},
};

export interface ISandboxCapabilityError {
	readonly id: string;
	readonly message: string;
}

function split(id: string): { kind: string; argument: string | undefined } {
	const colon = id.indexOf(':');
	return colon < 0 ? { kind: id, argument: undefined } : { kind: id.slice(0, colon), argument: id.slice(colon + 1) };
}

/** Description and risk of one capability, or why it is invalid. */
export function describeCapability(id: unknown): ISandboxCapabilityInfo | ISandboxCapabilityError {
	if (typeof id !== 'string' || id.length > 4200) {
		return { id: String(id), message: 'must be a short string' };
	}
	const { kind, argument } = split(id);
	const definition = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : undefined;
	if (!definition) {
		return { id, message: `unknown capability "${kind}"` };
	}
	if (definition.argument === 'none' && argument !== undefined) {
		return { id, message: `"${kind}" takes no argument` };
	}
	if (definition.argument === 'required' && !argument) {
		return { id, message: `"${kind}" needs an argument` };
	}
	const error = argument !== undefined ? definition.validate?.(argument) : undefined;
	if (error) {
		return { id, message: error };
	}
	return { id, ...definition.describe(argument) };
}

function isError(info: ISandboxCapabilityInfo | ISandboxCapabilityError): info is ISandboxCapabilityError {
	return 'message' in info;
}

/** The install sheet: valid capabilities sorted by risk (highest first), and the invalid ones. */
export function describeCapabilities(ids: readonly unknown[]): { readonly capabilities: readonly ISandboxCapabilityInfo[]; readonly errors: readonly ISandboxCapabilityError[] } {
	const capabilities: ISandboxCapabilityInfo[] = [];
	const errors: ISandboxCapabilityError[] = [];
	for (const id of ids) {
		const info = describeCapability(id);
		if (isError(info)) {
			errors.push(info);
		} else if (!capabilities.some(existing => existing.id === info.id)) {
			capabilities.push(info);
		}
	}
	capabilities.sort((a, b) => SANDBOX_RISK_ORDER[b.risk] - SANDBOX_RISK_ORDER[a.risk] || a.id.localeCompare(b.id));
	return { capabilities, errors };
}

export interface ISandboxCapabilityEvaluation {
	readonly policy: IVoltSandboxPolicy;
	/** Requested but not granted: left out of the policy. */
	readonly ungranted: readonly string[];
	readonly errors: readonly ISandboxCapabilityError[];
	/** The highest risk among the granted capabilities. */
	readonly risk: SandboxRisk;
}

/**
 * The policy for a workload that requested `requested` and was granted `granted` by the user.
 * Starts from `restricted`; only capabilities that are both requested and granted are added, so a
 * grant cannot be widened by a manifest that later requests more. Invalid ids are errors and add
 * nothing.
 */
export function evaluateCapabilities(requested: readonly unknown[], granted: ReadonlySet<string>): ISandboxCapabilityEvaluation {
	const { capabilities, errors } = describeCapabilities(requested);
	const ungranted: string[] = [];
	const layers: Omit<IVoltSandboxPolicyLayer, 'schemaVersion'>[] = [];
	let risk: SandboxRisk = 'low';
	for (const capability of capabilities) {
		if (!granted.has(capability.id)) {
			ungranted.push(capability.id);
			continue;
		}
		const { kind, argument } = split(capability.id);
		layers.push(KINDS[kind].layer(argument));
		if (SANDBOX_RISK_ORDER[capability.risk] > SANDBOX_RISK_ORDER[risk]) {
			risk = capability.risk;
		}
	}
	// Granted capabilities are the user's decision, so they apply as one trusted layer.
	const merged = layers.reduce<IVoltSandboxPolicyLayer>((acc, layer) => composeLayer(acc, layer), { schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION });
	const { policy } = composeSandboxPolicy(builtinProfile('restricted'), [{ source: 'execution', trusted: true, layer: merged }]);
	return { policy: { ...policy, name: 'capabilities' }, ungranted, errors, risk };
}

function composeLayer(a: IVoltSandboxPolicyLayer, b: Omit<IVoltSandboxPolicyLayer, 'schemaVersion'>): IVoltSandboxPolicyLayer {
	const list = <T>(x: readonly T[] | undefined, y: readonly T[] | undefined) => x || y ? [...new Set([...(x ?? []), ...(y ?? [])])] : undefined;
	const modeOrder = { none: 0, proxy: 1, host: 2 } as const;
	const mode = a.network?.mode && b.network?.mode ? (modeOrder[a.network.mode] >= modeOrder[b.network.mode] ? a.network.mode : b.network.mode) : a.network?.mode ?? b.network?.mode;
	return {
		schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION,
		filesystem: { read: list(a.filesystem?.read, b.filesystem?.read), write: list(a.filesystem?.write, b.filesystem?.write) },
		network: {
			...(mode ? { mode } : {}),
			allow: list(a.network?.allow, b.network?.allow),
			loopbackPorts: list(a.network?.loopbackPorts, b.network?.loopbackPorts),
			...(a.network?.listen || b.network?.listen ? { listen: true } : {}),
		},
		env: { inherit: list(a.env?.inherit, b.env?.inherit) },
		host: { unixSockets: list(a.host?.unixSockets, b.host?.unixSockets) },
	};
}
