/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { gitDirWritable } from './sandboxProfiles.js';
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
	/** Git folders whose contents are writable only by the allow list (`gitDirWritable`, B-03). */
	readonly gitDirs: readonly IResolvedGitDir[];
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
	/**
	 * Folders hidden except one child: every run folder but this run's own, every principal's
	 * package cache but its own (B-35). Neither readable nor writable, like `deny`.
	 */
	readonly isolated?: readonly ISandboxIsolatedRoot[];
	/** A file the policy denies, read by the prologue's canary and checked from outside (F.5). */
	readonly sentinel?: string;
}

export interface ISandboxIsolatedRoot {
	readonly root: string;
	/** The one child of `root` that stays as the rest of the policy says. */
	readonly keep: string;
}

export interface IResolvedPattern {
	readonly root: string;
	/** Literal path components, at least one. */
	readonly names: readonly string[];
}

/**
 * `anyDepth`: every `.git` folder below `root` (at any depth, including `root/.git`), whenever it
 * appears. Otherwise `root` itself is a git folder (a linked worktree's common `.git`, written
 * directly).
 */
export interface IResolvedGitDir {
	readonly root: string;
	readonly anyDepth: boolean;
}

export interface IResolvedNetwork {
	readonly mode: SandboxNetworkMode;
	/** Hosts the proxy lets through (mode `proxy`). */
	readonly allow: readonly string[];
	/** Host loopback ports reachable directly. */
	readonly loopbackPorts: readonly number[];
	/** Listening on any loopback port (trusted policies only). */
	readonly listen: boolean;
	/** Loopback ports granted for listening one by one. */
	readonly listenPorts?: readonly number[];
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
	if ((policy.isolated ?? []).some(({ root, keep }) => insideFolded(root) && !inside(keep))) {
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
	for (const dir of policy.gitDirs) {
		if (!insideFolded(dir.root)) {
			continue;
		}
		const parts = fold(p) === fold(dir.root) ? [] : (dir.root === '/' ? p.slice(1) : p.slice(dir.root.length + 1)).split('/');
		const at = dir.anyDepth ? parts.findIndex(part => fold(part) === '.git') : -1;
		if (dir.anyDepth && at < 0) {
			continue;
		}
		if (!gitDirWritable(parts.slice(at + 1).join('/'))) {
			return false;
		}
	}
	return policy.write.some(root => inside(root))
		|| policy.writeFiles.some(file => p === file || (p.startsWith(`${file}.`) && /^\.(lock|tmp|backup|bak|swp)/.test(p.slice(file.length))));
}

/**
 * Inside the sandbox, Volt's proxy is reached at this address on both platforms. With a token,
 * the URL carries it as Basic credentials (`volt:<token>`), which curl, git, Node, Python and Go
 * send as `Proxy-Authorization`: the proxy serves only this run (B-31). The token is a per-run
 * route key, not a user secret; it opens nothing but this run's own egress rules.
 */
export function sandboxProxyUrl(port: number, token?: string): string {
	return token ? `http://volt:${encodeURIComponent(token)}@127.0.0.1:${port}` : `http://127.0.0.1:${port}`;
}

/** Proxy variables most HTTP clients honour. Set by the manager only; no policy may set them. */
export function sandboxProxyEnv(port: number, token?: string): Record<string, string> {
	const url = sandboxProxyUrl(port, token);
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
