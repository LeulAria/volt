/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISandboxLimits, SandboxNetworkMode } from './sandboxSchema.js';

/**
 * A policy with every token expanded and every path canonical (real paths, `/private/tmp` rather
 * than `/tmp` on macOS). Backends build bubblewrap arguments or a Seatbelt profile from this and
 * nothing else; they never see raw policy text, so no user string reaches a profile unvalidated.
 */
export interface IResolvedSandboxPolicy {
	readonly name: string;
	readonly platform: string;
	/** The whole filesystem is readable except `deny` (agent CLIs). False: only `read` and `write`. */
	readonly readAll: boolean;
	/** Existing folders and files readable with everything below. */
	readonly read: readonly string[];
	/** Existing folders writable with everything below. */
	readonly write: readonly string[];
	/** Single existing files writable in place (atomic-write siblings `<file>.lock`/`.tmp*` too). */
	readonly writeFiles: readonly string[];
	/** Neither readable nor writable. May not exist yet. */
	readonly deny: readonly string[];
	/** Readable, never writable. May not exist yet. */
	readonly protect: readonly string[];
	/** `**\/a/b` entries, anchored at roots: each matches `<root>/(any depth/)a/b` and below. */
	readonly denyPatterns: readonly IResolvedPattern[];
	readonly protectPatterns: readonly IResolvedPattern[];
	/** Workspace roots where creating a new `.git` entry is refused (a new repository brings its own config and hooks). */
	readonly newRepositoryGuard: readonly string[];
	readonly network: IResolvedNetwork;
	/** Unix sockets the workload may connect to (real paths). */
	readonly unixSockets: readonly string[];
	/** OS services (Keychain, launchd lookups) stay reachable; macOS only. Agent CLIs need them. */
	readonly systemServices: boolean;
	readonly limits: ISandboxLimits;
	/** The complete environment of the workload. Nothing else is inherited. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	/** The run's private temp folder: created before, removed after. */
	readonly tmp: string;
	/** The real home folder, for redaction and the backends' own masks. */
	readonly home: string;
}

export interface IResolvedPattern {
	readonly root: string;
	/** Literal path components, at least one. */
	readonly names: readonly string[];
}

export interface IResolvedNetwork {
	readonly mode: SandboxNetworkMode;
	/** Hosts the proxy lets through (mode `proxy`). */
	readonly allow: readonly string[];
	/** Host loopback ports reachable directly. */
	readonly loopbackPorts: readonly number[];
	readonly listen: boolean;
}

/**
 * Whether `policy` lets the workload read or write `path`, by the same rules the backends enforce.
 * For file access Volt performs on the workload's behalf (ACP `fs/*`), which happens outside the
 * sandbox. Pass the canonical path as well as the given one: both must pass.
 */
export function resolvedPolicyAllows(policy: IResolvedSandboxPolicy, path: string, access: 'read' | 'write'): boolean {
	if (!path.startsWith('/') || path.split('/').some(segment => segment === '..')) {
		return false;
	}
	const fold = policy.platform === 'darwin' ? (s: string) => s.toLowerCase() : (s: string) => s;
	const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
	const inside = (root: string, exact = false) => root === '/' || p === root || (!exact && p.startsWith(`${root}/`));
	const insideFolded = (root: string) => root === '/' || fold(p) === fold(root) || fold(p).startsWith(`${fold(root)}/`);
	const matches = (pattern: IResolvedPattern) => {
		if (!insideFolded(pattern.root) || fold(p) === fold(pattern.root)) {
			return false;
		}
		const parts = (pattern.root === '/' ? p.slice(1) : p.slice(pattern.root.length + 1)).split('/').map(fold);
		const names = pattern.names.map(fold);
		for (let i = 0; i + names.length <= parts.length; i++) {
			if (names.every((name, j) => parts[i + j] === name)) {
				return true;
			}
		}
		return false;
	};
	if (policy.deny.some(insideFolded) || policy.denyPatterns.some(matches)) {
		return false;
	}
	if (access === 'read') {
		return policy.readAll || [...policy.read, ...policy.write].some(root => inside(root)) || policy.writeFiles.some(file => inside(file, true));
	}
	if (policy.protect.some(insideFolded) || policy.protectPatterns.some(matches)) {
		return false;
	}
	const name = fold(p.slice(p.lastIndexOf('/') + 1));
	if (name === '.git' && policy.newRepositoryGuard.some(root => insideFolded(root))) {
		return false;
	}
	return policy.write.some(root => inside(root))
		|| policy.writeFiles.some(file => p === file || (p.startsWith(`${file}.`) && /^\.(lock|tmp|backup|bak|swp)/.test(p.slice(file.length))));
}

/** Inside the sandbox, Volt's proxy is reached at this address on both platforms. */
export function sandboxProxyUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/** Proxy variables most HTTP clients honour. Set by the manager only; no policy may set them. */
export function sandboxProxyEnv(port: number): Record<string, string> {
	const url = sandboxProxyUrl(port);
	const noProxy = 'localhost,127.0.0.1,::1';
	return {
		HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url,
		ALL_PROXY: url, all_proxy: url,
		NO_PROXY: noProxy, no_proxy: noProxy,
		NODE_USE_ENV_PROXY: '1',
		npm_config_proxy: url, npm_config_https_proxy: url,
		GIT_HTTP_PROXY: url,
	};
}
