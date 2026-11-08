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
	/**
	 * The layer each path, host and port entry of the result came from (`filesystem.write:/a`,
	 * `network.allow:x.com`, `network.listenPorts:3000`): the base profile's are `builtin`.
	 */
	readonly origins: Readonly<Record<string, SandboxLayerSource>>;
}

export interface ISandboxCompositionOptions {
	/**
	 * The real path of an absolute path entry (symlinks resolved; for a path that does not exist
	 * yet, its nearest existing parent's real path plus the rest), or undefined when it cannot be
	 * told (a token). Without it, containment is judged on the text alone, which a symlink fools.
	 */
	realpath?(path: string): string | undefined;
}

const NETWORK_ORDER: Record<SandboxNetworkMode, number> = { none: 0, proxy: 1, host: 2 };

/** True when path entry `child` is provably `parent` or below it. Different tokens are never provable. */
export function entryInside(child: string, parent: string): boolean {
	if (parent === '/') {
		return !child.startsWith('**/');
	}
	return child === parent || child.startsWith(`${parent}/`);
}

/** Ports an allow entry without one stands for. */
const DEFAULT_PORTS: readonly number[] = [80, 443];

/** Whether port `child` (undefined: 80 and 443) is within port `parent` (undefined: 80 and 443). */
function portCovered(parent: number | undefined, child: number | undefined): boolean {
	if (parent === undefined) {
		return child === undefined || DEFAULT_PORTS.includes(child);
	}
	return child === parent;
}

/**
 * Whether allow entry `parent` covers `child`. An entry without a port means ports 80 and 443, and
 * so does `*` (every public host on the web ports): `*` never covers `evil.com:6379` (B-32).
 */
export function allowCovers(parent: string, child: string): boolean {
	if (child === '*') {
		return parent === '*';
	}
	const c = splitAllowEntry(child);
	if (parent === '*') {
		return portCovered(undefined, c.port);
	}
	const p = splitAllowEntry(parent);
	if (!portCovered(p.port, c.port)) {
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

export function composeSandboxPolicy(base: IVoltSandboxPolicy, layers: readonly ISandboxLayer[], options: ISandboxCompositionOptions = {}): ISandboxComposition {
	let policy = base;
	const ignored: ISandboxCompositionNote[] = [];
	const origins: Record<string, SandboxLayerSource> = {};
	const record = (from: IVoltSandboxPolicy, source: SandboxLayerSource) => {
		for (const [field, values] of originFields(from)) {
			for (const value of values) {
				origins[`${field}:${value}`] ??= source;
			}
		}
	};
	record(base, 'builtin');
	for (const entry of layers) {
		policy = entry.trusted ? widen(policy, entry.layer) : narrow(policy, entry, ignored, options);
		record(policy, entry.source);
	}
	// Only what the result holds.
	const kept = new Set(originFields(policy).flatMap(([field, values]) => values.map(value => `${field}:${value}`)));
	for (const key of Object.keys(origins)) {
		if (!kept.has(key)) {
			delete origins[key];
		}
	}
	return { policy, ignored, sources: layers.map(layer => layer.source), origins };
}

function originFields(policy: IVoltSandboxPolicy): [string, readonly (string | number)[]][] {
	return [
		['filesystem.read', policy.filesystem.read],
		['filesystem.write', policy.filesystem.write],
		['filesystem.unmask', policy.filesystem.unmask],
		['network.allow', policy.network.allow],
		['network.loopbackPorts', policy.network.loopbackPorts],
		['network.listenPorts', policy.network.listenPorts ?? []],
		['host.unixSockets', policy.host.unixSockets],
	];
}

/** A trusted layer: lists add, scalars replace, denies and protections still only grow. */
function widen(current: IVoltSandboxPolicy, layer: IVoltSandboxPolicyLayer): IVoltSandboxPolicy {
	const fs = layer.filesystem ?? {};
	const net = layer.network ?? {};
	const listenPorts = union(current.network.listenPorts ?? [], net.listenPorts ?? []);
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
			...(listenPorts.length ? { listenPorts } : {}),
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
function narrow(current: IVoltSandboxPolicy, entry: ISandboxLayer, ignored: ISandboxCompositionNote[], options: ISandboxCompositionOptions): IVoltSandboxPolicy {
	const { layer, source } = entry;
	const note = (field: string, value: string, reason: string) => ignored.push({ source, field, value, reason });
	const fs = layer.filesystem ?? {};
	const real = (path: string): string | undefined => path.startsWith('/') ? options.realpath?.(path) : undefined;
	/** Inside `parent` by text, and still inside once both are resolved (a symlink cannot carry it out, B-32). */
	const insideReally = (path: string, parent: string): boolean => {
		if (!entryInside(path, parent)) {
			return false;
		}
		const resolved = real(path);
		if (resolved === undefined || parent === '/') {
			return true;
		}
		return entryInside(resolved, real(parent) ?? parent);
	};

	const intersectPaths = (field: string, have: readonly string[], want: readonly string[] | undefined): readonly string[] => {
		if (!want) {
			return have;
		}
		const out: string[] = [];
		for (const path of want) {
			if (have.some(parent => insideReally(path, parent))) {
				out.push(path);
			} else if (have.some(parent => entryInside(path, parent))) {
				note(field, path, 'resolves outside what the policy already allows through a symlink');
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
	let listenPorts = current.network.listenPorts ?? [];
	if (net.listenPorts) {
		for (const port of net.listenPorts) {
			if (!listenPorts.includes(port) && !current.network.listen) {
				note('network.listenPorts', String(port), 'port not already allowed for listening');
			}
		}
		// A port the policy may already listen on (by grant, or because it may listen anywhere) stays.
		listenPorts = net.listenPorts.filter(port => listenPorts.includes(port) || current.network.listen);
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
		network: { mode, allow, loopbackPorts, listen, ...(listenPorts.length ? { listenPorts: [...new Set(listenPorts)] } : {}) },
		process: { limits },
		env: { inherit, set },
		host: { unixSockets, systemServices },
		bestEffort,
	};
}
