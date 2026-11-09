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
	/**
	 * Backends that expand patterns by a bounded walk (bubblewrap, MXC) may leave this root's walk
	 * unfinished without refusing the run: a read-only install (a toolchain) or a shared temp
	 * folder, never the workspace or a folder it writes (B-27, 05-limitations.md).
	 */
	readonly bestEffort?: boolean;
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
	const fold = policy.platform === 'darwin' ? FOLD_CASE : KEEP_CASE;
	const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
	const fp = fold(p);
	const inside = (root: string, exact = false) => root === '/' || p === root || (!exact && p.startsWith(`${root}/`));
	// Roots and names come folded once per policy (they are fixed once resolved); only the path is folded per call.
	const insideFolded = (root: IFoldedRoot) => root.root === '/' || fp === root.folded || fp.startsWith(root.below);
	// The path's components below a root, folded, by the root's length (patterns share their roots).
	const below = new Map<number, string[]>();
	const matches = (pattern: IFoldedPattern) => {
		if (!insideFolded(pattern) || fp === pattern.folded) {
			return false;
		}
		const at = pattern.root === '/' ? 1 : pattern.root.length + 1;
		let parts = below.get(at);
		if (!parts) {
			parts = p.slice(at).split('/').map(fold);
			below.set(at, parts);
		}
		const names = pattern.names;
		for (let i = 0; i + names.length <= parts.length; i++) {
			if (names.every((name, j) => parts[i + j] === name)) {
				return true;
			}
		}
		return false;
	};
	const deny = foldedRoots(policy.deny, fold);
	if (deny.some(insideFolded) || foldedPatterns(policy.denyPatterns, fold).some(matches)) {
		return false;
	}
	if ((policy.isolated ?? []).some(({ root, keep }) => insideFolded(foldedRoot(root, fold)) && !inside(keep))) {
		return false;
	}
	if (access === 'read') {
		return policy.readAll || policy.read.some(root => inside(root)) || policy.write.some(root => inside(root)) || policy.writeFiles.some(file => inside(file, true));
	}
	if (foldedRoots(policy.protect, fold).some(insideFolded) || foldedPatterns(policy.protectPatterns, fold).some(matches)) {
		return false;
	}
	const name = fold(p.slice(p.lastIndexOf('/') + 1));
	if (name === '.git' && foldedRoots(policy.newRepositoryGuard, fold).some(insideFolded)) {
		return false;
	}
	for (const dir of policy.gitDirs) {
		const root = foldedRoot(dir.root, fold);
		if (!insideFolded(root)) {
			continue;
		}
		const parts = fp === root.folded ? [] : (dir.root === '/' ? p.slice(1) : p.slice(dir.root.length + 1)).split('/');
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

const FOLD_CASE = (s: string) => s.toLowerCase();
const KEEP_CASE = (s: string) => s;

interface IFoldedRoot {
	readonly root: string;
	readonly folded: string;
	/** `<folded>/`: what a path strictly below the root starts with. */
	readonly below: string;
}

interface IFoldedPattern extends IFoldedRoot {
	readonly names: readonly string[];
}

function foldedRoot(root: string, fold: (s: string) => string): IFoldedRoot {
	const folded = fold(root);
	return { root, folded, below: `${folded}/` };
}

/**
 * Folded copies of a resolved policy's lists, kept per list (and per fold: a policy resolved for
 * macOS folds case). Resolved policies are never changed in place; a new list is a new key.
 */
const foldedRootLists = new WeakMap<readonly string[], { readonly fold: (s: string) => string; readonly roots: readonly IFoldedRoot[] }>();
const foldedPatternLists = new WeakMap<readonly IResolvedPattern[], { readonly fold: (s: string) => string; readonly patterns: readonly IFoldedPattern[] }>();
function foldedRoots(list: readonly string[], fold: (s: string) => string): readonly IFoldedRoot[] {
	const known = foldedRootLists.get(list);
	if (known?.fold === fold && known.roots.length === list.length) {
		return known.roots;
	}
	const roots = list.map(root => foldedRoot(root, fold));
	foldedRootLists.set(list, { fold, roots });
	return roots;
}

function foldedPatterns(list: readonly IResolvedPattern[], fold: (s: string) => string): readonly IFoldedPattern[] {
	const known = foldedPatternLists.get(list);
	if (known?.fold === fold && known.patterns.length === list.length) {
		return known.patterns;
	}
	const patterns = list.map(pattern => ({ ...foldedRoot(pattern.root, fold), names: pattern.names.map(fold) }));
	foldedPatternLists.set(list, { fold, patterns });
	return patterns;
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
