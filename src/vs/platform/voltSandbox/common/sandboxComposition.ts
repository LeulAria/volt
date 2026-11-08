/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isInjectionEnvName, isReservedEnvName, isSecretEnvName } from './sandboxProfiles.js';
import { ISandboxLimits, IVoltSandboxPolicy, IVoltSandboxPolicyLayer, SandboxDimension, SandboxNetworkMode, splitAllowEntry } from './sandboxSchema.js';

/**
 * Policy layering. Layers apply in order on top of a base profile:
 *
 *   built-in profile -> user settings (trusted) -> workspace file (untrusted) -> per-run request
 *
 * A trusted layer (the user, or Volt acting on an explicit user grant) may widen or narrow. An
 * untrusted layer (anything that ships inside a repository, or a request from code Volt does not
 * trust) may only narrow: every widening it attempts is dropped and recorded, so the result is
 * never wider than the layers before it. Denies and protections only ever grow.
 */

export type SandboxLayerSource = 'builtin' | 'user' | 'workspace' | 'execution';

export interface ISandboxLayer {
	readonly source: SandboxLayerSource;
	/** Only the user and Volt itself are trusted. A repository never is. */
	readonly trusted: boolean;
	readonly layer: IVoltSandboxPolicyLayer;
}

/** A widening an untrusted layer attempted, and why it was dropped. */
export interface ISandboxCompositionNote {
	readonly source: SandboxLayerSource;
	readonly field: string;
	readonly value: string;
	readonly reason: string;
}

export interface ISandboxComposition {
	readonly policy: IVoltSandboxPolicy;
	readonly ignored: readonly ISandboxCompositionNote[];
	readonly sources: readonly SandboxLayerSource[];
}

const NETWORK_ORDER: Record<SandboxNetworkMode, number> = { none: 0, proxy: 1, host: 2 };

/** True when path entry `child` is provably `parent` or below it. Different tokens are never provable. */
export function entryInside(child: string, parent: string): boolean {
	if (parent === '/') {
		return !child.startsWith('**/');
	}
	return child === parent || child.startsWith(`${parent}/`);
}

/** Whether allow entry `parent` covers `child`. An entry without a port means ports 80 and 443. */
export function allowCovers(parent: string, child: string): boolean {
	if (parent === '*') {
		return true;
	}
	if (child === '*') {
		return false;
	}
	const p = splitAllowEntry(parent);
	const c = splitAllowEntry(child);
	if (p.port !== c.port) {
		return false;
	}
	if (p.host === c.host) {
		return true;
	}
	if (p.host.startsWith('*.')) {
		const base = p.host.slice(2);
		const host = c.host.startsWith('*.') ? c.host.slice(2) : c.host;
		return host === base || host.endsWith(`.${base}`);
	}
	return false;
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
	return [...new Set([...a, ...b])];
}

export function composeSandboxPolicy(base: IVoltSandboxPolicy, layers: readonly ISandboxLayer[]): ISandboxComposition {
	let policy = base;
	const ignored: ISandboxCompositionNote[] = [];
	for (const entry of layers) {
		policy = entry.trusted ? widen(policy, entry.layer) : narrow(policy, entry, ignored);
	}
	return { policy, ignored, sources: layers.map(layer => layer.source) };
}

/** A trusted layer: lists add, scalars replace, denies and protections still only grow. */
function widen(current: IVoltSandboxPolicy, layer: IVoltSandboxPolicyLayer): IVoltSandboxPolicy {
	const fs = layer.filesystem ?? {};
	const net = layer.network ?? {};
	return {
		...current,
		...(layer.name ? { name: layer.name } : {}),
		filesystem: {
			read: union(current.filesystem.read, fs.read ?? []),
			write: union(current.filesystem.write, fs.write ?? []),
			deny: union(current.filesystem.deny, fs.deny ?? []),
			protect: union(current.filesystem.protect, fs.protect ?? []),
			unmask: union(current.filesystem.unmask, fs.unmask ?? []),
		},
		network: {
			mode: net.mode ?? current.network.mode,
			allow: union(current.network.allow, net.allow ?? []),
			loopbackPorts: union(current.network.loopbackPorts, net.loopbackPorts ?? []),
			listen: net.listen ?? current.network.listen,
		},
		process: { limits: { ...current.process.limits, ...layer.process?.limits } },
		env: {
			inherit: union(current.env.inherit, (layer.env?.inherit ?? []).filter(name => !isReservedEnvName(name))),
			set: { ...current.env.set, ...withoutReserved(layer.env?.set) },
		},
		host: {
			unixSockets: union(current.host.unixSockets, layer.host?.unixSockets ?? []),
			systemServices: layer.host?.systemServices ?? current.host.systemServices,
		},
		bestEffort: union(current.bestEffort, layer.bestEffort ?? []),
	};
}

function withoutReserved(set: Readonly<Record<string, string>> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(set ?? {}).filter(([name]) => !isReservedEnvName(name)));
}

/** An untrusted layer: only what it can prove is inside the current policy survives. */
function narrow(current: IVoltSandboxPolicy, entry: ISandboxLayer, ignored: ISandboxCompositionNote[]): IVoltSandboxPolicy {
	const { layer, source } = entry;
	const note = (field: string, value: string, reason: string) => ignored.push({ source, field, value, reason });
	const fs = layer.filesystem ?? {};

	const intersectPaths = (field: string, have: readonly string[], want: readonly string[] | undefined): readonly string[] => {
		if (!want) {
			return have;
		}
		const out: string[] = [];
		for (const path of want) {
			if (have.some(parent => entryInside(path, parent))) {
				out.push(path);
			} else {
				note(field, path, 'not inside what the policy already allows');
			}
		}
		// Entries already narrower than every requested one stay, so narrowing never widens.
		for (const path of have) {
			if (!out.includes(path) && want.some(parent => entryInside(path, parent))) {
				out.push(path);
			}
		}
		return out;
	};

	if (fs.unmask?.length) {
		for (const path of fs.unmask) {
			note('filesystem.unmask', path, 'only a trusted layer may lift a credential deny');
		}
	}

	const net = layer.network ?? {};
	let mode = current.network.mode;
	if (net.mode !== undefined) {
		if (NETWORK_ORDER[net.mode] > NETWORK_ORDER[mode]) {
			note('network.mode', net.mode, `cannot widen network from ${mode}`);
		} else {
			mode = net.mode;
		}
	}
	let allow: readonly string[] = current.network.allow;
	if (mode === 'none') {
		allow = [];
	} else if (net.allow) {
		const narrowingHost = current.network.mode === 'host' && mode === 'proxy';
		const out: string[] = [];
		for (const host of net.allow) {
			if (narrowingHost || current.network.allow.some(parent => allowCovers(parent, host))) {
				out.push(host);
			} else {
				note('network.allow', host, 'not covered by the hosts already allowed');
			}
		}
		allow = out;
	}
	let loopbackPorts = current.network.loopbackPorts;
	if (net.loopbackPorts) {
		for (const port of net.loopbackPorts) {
			if (!current.network.loopbackPorts.includes(port)) {
				note('network.loopbackPorts', String(port), 'port not already allowed');
			}
		}
		loopbackPorts = current.network.loopbackPorts.filter(port => net.loopbackPorts!.includes(port));
	}
	let listen = current.network.listen;
	if (net.listen !== undefined) {
		if (net.listen && !listen) {
			note('network.listen', 'true', 'cannot allow listening');
		}
		listen = listen && net.listen;
	}

	const limits: { -readonly [K in keyof ISandboxLimits]: ISandboxLimits[K] } = { ...current.process.limits };
	for (const [key, value] of Object.entries(layer.process?.limits ?? {}) as [keyof ISandboxLimits, number][]) {
		const have = limits[key];
		if (have !== undefined && value > have) {
			note(`process.limits.${key}`, String(value), `cannot raise above ${have}`);
		} else {
			limits[key] = value;
		}
	}

	let inherit = current.env.inherit;
	if (layer.env?.inherit) {
		const out: string[] = [];
		for (const name of layer.env.inherit) {
			const allowed = current.env.inherit.includes(name) || (name !== '*' && current.env.inherit.includes('*') && !isSecretEnvName(name));
			if (allowed && !isReservedEnvName(name)) {
				out.push(name);
			} else {
				note('env.inherit', name, 'not already inherited');
			}
		}
		inherit = out;
	}
	const set: Record<string, string> = { ...current.env.set };
	for (const [name, value] of Object.entries(layer.env?.set ?? {})) {
		if (isReservedEnvName(name)) {
			note('env.set', name, 'reserved for Volt');
		} else if (isInjectionEnvName(name)) {
			note('env.set', name, 'a loader or interpreter hook');
		} else {
			set[name] = value;
		}
	}

	let unixSockets = current.host.unixSockets;
	if (layer.host?.unixSockets) {
		for (const socket of layer.host.unixSockets) {
			if (!current.host.unixSockets.includes(socket)) {
				note('host.unixSockets', socket, 'socket not already allowed');
			}
		}
		unixSockets = current.host.unixSockets.filter(socket => layer.host!.unixSockets!.includes(socket));
	}
	let systemServices = current.host.systemServices;
	if (layer.host?.systemServices !== undefined) {
		if (layer.host.systemServices && !systemServices) {
			note('host.systemServices', 'true', 'cannot open system services');
		}
		systemServices = systemServices && layer.host.systemServices;
	}

	let bestEffort: readonly SandboxDimension[] = current.bestEffort;
	if (layer.bestEffort) {
		for (const dimension of layer.bestEffort) {
			if (!current.bestEffort.includes(dimension)) {
				note('bestEffort', dimension, 'cannot relax enforcement');
			}
		}
		bestEffort = current.bestEffort.filter(dimension => layer.bestEffort!.includes(dimension));
	}

	return {
		...current,
		filesystem: {
			read: intersectPaths('filesystem.read', current.filesystem.read, fs.read),
			write: intersectPaths('filesystem.write', current.filesystem.write, fs.write),
			deny: union(current.filesystem.deny, fs.deny ?? []),
			protect: union(current.filesystem.protect, fs.protect ?? []),
			unmask: current.filesystem.unmask,
		},
		network: { mode, allow, loopbackPorts, listen },
		process: { limits },
		env: { inherit, set },
		host: { unixSockets, systemServices },
		bestEffort,
	};
}
