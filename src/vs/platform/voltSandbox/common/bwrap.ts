/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IResolvedSandboxPolicy } from './sandboxResolved.js';
import { ISandboxLimits, limitDimension, SandboxDimension } from './sandboxSchema.js';

/**
 * bubblewrap arguments for a resolved policy. Pure: everything it needs to know about the host
 * (which paths exist, which top-level folders are symlinks, what a bounded walk found for `**\/`
 * patterns) is passed in by the node backend. Every value lands in its own argv slot after the
 * option that takes it, and the workload comes after `--`, so no policy string is ever parsed as
 * an option or by a shell.
 *
 * Mount order (bubblewrap applies them in order; a later mount covers an earlier one):
 *  1. The base: `--ro-bind / /` (readAll), or each `read` root plus the host's top-level symlinks
 *     (`/bin -> usr/bin`; the resolver canonicalises reads to `/usr/bin`, but ELF interpreters
 *     and `#!/bin/sh` need the link).
 *  2. A fresh `/dev` and `/proc`.
 *  3. Masks: empty tmpfs over `/tmp`, `/var/tmp`, `/run`, `/var/run`, `/dev/shm` and the user's
 *     runtime folder, so host unix sockets (D-Bus, X11, ssh-agent, tmux, the editor's IPC) are not
 *     even visible. Reads below a mask are bound again after it.
 *  4. Writes, single writable files and granted sockets (read-write binds), and files the masks
 *     would break (`/etc/resolv.conf -> /run/...`).
 *  5. Pins: every folder between a writable root and a protected or denied path is bound onto
 *     itself. A mount point cannot be renamed or removed (EBUSY), so `mv .git x; mkdir .git` cannot
 *     move a protected `.git/config` aside and plant a new one in its place.
 *  6. `protect`: read-only binds over existing paths inside writable roots.
 *  7. `deny`: an empty read-only tmpfs over folders, `/dev/null` over files. Last, so a deny wins
 *     over every read, write and protect.
 *
 * What bubblewrap cannot do (reported by the backend, see `BUBBLEWRAP_LIMITATIONS`): it can only
 * mount over paths that exist at launch, so a `deny`/`protect` entry that does not exist yet, a
 * pattern match created during the run, and a new `.git` (`newRepositoryGuard`) are not covered.
 */

/** File descriptors the backend passes, in `extraStdio` order (fd 3 up). The readiness script relies on fd 3. */
export const BUBBLEWRAP_FDS = { marker: 3, status: 4, args: 5, seccomp: 6 } as const;

/**
 * Runs inside the finished sandbox (after the mounts and the seccomp filter, as the first process
 * of the workload): reports its own `NoNewPrivs` and `Seccomp` state on fd 3, closes fd 3, then
 * execs the workload. The backend only reports the sandbox as established once this line arrives
 * with `Seccomp:2`, so a launcher that failed half way is never mistaken for a running sandbox.
 * Constant: the workload arrives as positional arguments, never as script text.
 */
export const BUBBLEWRAP_READY_SCRIPT = 'while read -r k v; do case $k in NoNewPrivs:|Seccomp:) printf \'%s%s \' "$k" "$v" >&3;; esac; done < /proc/self/status; printf \'\\n\' >&3; exec 3>&-; exec "$@"';

/** `$0` of the readiness script, shown by `ps` inside the sandbox until the workload execs. */
export const BUBBLEWRAP_READY_ARGV0 = 'volt-sandbox';

/**
 * The network bridge (see bubblewrapBackend.ts): one socat per port, listening on the holder's
 * loopback and forwarding each connection to `<port>.sock` in the working directory, where the
 * backend listens on the host. Constant; `$1` is socat's path and the rest are validated port
 * numbers. Relative socket names keep every path out of socat's address syntax.
 */
export const BUBBLEWRAP_BRIDGE_SCRIPT = 'socat=$1; shift; for port in "$@"; do "$socat" -d -d TCP-LISTEN:"$port",bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:"$port".sock & done; wait';

export type BubblewrapPathKind = 'dir' | 'file' | 'missing';

export interface IBubblewrapPathMatch {
	readonly path: string;
	readonly kind: Exclude<BubblewrapPathKind, 'missing'>;
}

/** Facts about the host the builder needs. Gathered by the backend at launch. */
export interface IBubblewrapHostLayout {
	/** Kind of every `deny`, `protect`, `writeFiles` and `unixSockets` path; absent means missing. */
	readonly kinds: ReadonlyMap<string, BubblewrapPathKind>;
	/** Top-level symlinks (`/bin` -> `usr/bin`), recreated when their target is readable. */
	readonly rootLinks: readonly { readonly path: string; readonly target: string }[];
	/** Existing folders (not symlinks) to cover with an empty tmpfs when visible: `/tmp`, `/run`, the runtime folder. */
	readonly masks: readonly string[];
	/** Files below a mask that must stay readable where `/etc` is (`/etc/resolv.conf` -> `/run/systemd/resolve/...`). */
	readonly reexpose: readonly string[];
}

/** What the bounded walk found for `denyPatterns` and `protectPatterns`, and unix sockets to hide. */
export interface IBubblewrapPatternMatches {
	readonly deny: readonly IBubblewrapPathMatch[];
	readonly protect: readonly IBubblewrapPathMatch[];
	/** Socket files below visible roots, hidden when unix sockets are allowed for the granted ones. */
	readonly sockets: readonly string[];
}

export interface IBubblewrapArgsOptions {
	/** On a PTY: keep the terminal session (job control); TIOCSTI is refused by seccomp instead of `--new-session`. */
	readonly terminal: boolean;
	/** bubblewrap 0.8+: `--disable-userns`. */
	readonly disableUserns: boolean;
	/** The network namespace is the bridge holder's (spawned through nsenter), so no `--unshare-net`. */
	readonly bridged: boolean;
	readonly host: IBubblewrapHostLayout;
	readonly matches: IBubblewrapPatternMatches;
	/** The shell for the readiness script, as seen inside the sandbox. */
	readonly shell: string;
	/** Limits, applied by prlimit inside the sandbox. Undefined: none applied. */
	readonly prlimit?: IPrlimitInvocation;
}

export interface IPrlimitInvocation {
	/** prlimit's path inside the sandbox. */
	readonly path: string;
	/** The hard limits the sandbox inherits; a requested limit above one is lowered to it (setrlimit cannot raise). */
	readonly hard: Readonly<Partial<Record<PrlimitResource, number>>>;
}

export type PrlimitResource = 'cpu' | 'fsize' | 'nofile' | 'nproc' | 'as';

export function isInsidePath(path: string, root: string): boolean {
	return root === '/' || path === root || path.startsWith(`${root}/`);
}

function byDepth(a: string, b: string): number {
	return a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Drops entries already covered by another entry of the same list. */
function outermost(paths: readonly string[]): string[] {
	const sorted = [...new Set(paths)].sort(byDepth);
	const out: string[] = [];
	for (const path of sorted) {
		if (!out.some(root => isInsidePath(path, root))) {
			out.push(path);
		}
	}
	return out;
}

/** The deepest writable root containing `path`. */
function writableRootOf(path: string, roots: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const root of roots) {
		if (isInsidePath(path, root) && (!best || root.length > best.length)) {
			best = root;
		}
	}
	return best;
}

/** Limits as prlimit options. Soft = hard, so the workload cannot raise them back. */
export function prlimitOptions(limits: ISandboxLimits, hard: Readonly<Partial<Record<PrlimitResource, number>>>): string[] {
	const out: string[] = [];
	const add = (resource: PrlimitResource, value: number | undefined) => {
		if (value === undefined) {
			return;
		}
		const ceiling = hard[resource];
		const v = Math.floor(ceiling !== undefined ? Math.min(value, ceiling) : value);
		out.push(`--${resource}=${v}:${v}`);
	};
	const mb = 1024 * 1024;
	add('cpu', limits.cpuSeconds);
	add('fsize', limits.fileSizeMB !== undefined ? limits.fileSizeMB * mb : undefined);
	add('nofile', limits.openFiles);
	add('nproc', limits.processes);
	add('as', limits.memoryMB !== undefined ? limits.memoryMB * mb : undefined);
	return out;
}

/** The limits prlimit applies; the wall clock is the manager's own timer. */
const RLIMIT_KEYS: readonly (keyof ISandboxLimits)[] = ['cpuSeconds', 'fileSizeMB', 'openFiles', 'processes', 'memoryMB'];

export function hasRlimits(limits: ISandboxLimits): boolean {
	return RLIMIT_KEYS.some(key => limits[key] !== undefined);
}

/** Folders that are visible inside the sandbox before masks (readAll: everything). */
function visibleRoots(policy: IResolvedSandboxPolicy): string[] {
	return policy.readAll ? ['/'] : [...policy.read, ...policy.write];
}

export function isVisibleInSandbox(policy: IResolvedSandboxPolicy, path: string): boolean {
	return visibleRoots(policy).some(root => isInsidePath(path, root));
}

/**
 * The `--setenv` arguments for the workload's environment, sent through `--args FD` so values
 * never appear in a command line, and so bubblewrap itself (which runs unsandboxed) is spawned
 * with an empty environment: a policy may set `LD_PRELOAD`, which must reach the workload but
 * never the launcher. Names bubblewrap's setenv would reject are dropped.
 */
export function bubblewrapEnvArgs(env: Readonly<Record<string, string>>): string[] {
	const out: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!name || name.includes('=') || name.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
			continue;
		}
		out.push('--setenv', name, value);
	}
	return out;
}

/** NUL-separated, as `--args FD` reads them. */
export function encodeBubblewrapArgs(args: readonly string[]): string {
	return args.map(arg => `${arg}\0`).join('');
}

/**
 * The workload command after `--`: the readiness script, then prlimit when limits apply, then the
 * command. Throws for a command bubblewrap or the shell could take as an option.
 */
export function bubblewrapCommand(command: string, args: readonly string[], options: Pick<IBubblewrapArgsOptions, 'shell' | 'prlimit'>, limits: ISandboxLimits): string[] {
	if (!command || command.startsWith('-') || command.includes('\0') || args.some(arg => arg.includes('\0'))) {
		throw new Error('The sandboxed command must be a program name or path (not empty, not starting with "-", no NUL)');
	}
	const out = ['--', options.shell, '-c', BUBBLEWRAP_READY_SCRIPT, BUBBLEWRAP_READY_ARGV0];
	if (options.prlimit) {
		const limitArgs = prlimitOptions(limits, options.prlimit.hard);
		if (limitArgs.length) {
			out.push(options.prlimit.path, ...limitArgs, '--');
		}
	}
	out.push(command, ...args);
	return out;
}

/** bubblewrap's arguments, everything after the `bwrap` path. */
export function bubblewrapArgs(policy: IResolvedSandboxPolicy, command: string, commandArgs: readonly string[], options: IBubblewrapArgsOptions): string[] {
	const kinds = options.host.kinds;
	const kindOf = (path: string): BubblewrapPathKind => kinds.get(path) ?? 'missing';
	const args: string[] = [];
	const push = (...values: string[]) => args.push(...values);

	// Environment first: `--args` inserts its arguments where it appears.
	push('--args', String(BUBBLEWRAP_FDS.args));

	// Namespaces. A user namespace always (unprivileged bubblewrap needs it), so the workload has
	// no capabilities on the host and none it could use in the sandbox (`--cap-drop ALL`).
	push('--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
	if (policy.network.mode !== 'host' && !options.bridged) {
		push('--unshare-net');
	}
	push('--die-with-parent');
	if (options.disableUserns) {
		push('--disable-userns');
	}
	if (!options.terminal) {
		push('--new-session');
	}
	push('--cap-drop', 'ALL', '--hostname', 'volt-sandbox');
	push('--json-status-fd', String(BUBBLEWRAP_FDS.status), '--seccomp', String(BUBBLEWRAP_FDS.seccomp));

	// 1. Base.
	const reads = outermost(policy.read);
	if (policy.readAll) {
		push('--ro-bind', '/', '/');
	} else {
		for (const path of reads) {
			push('--ro-bind-try', path, path);
		}
		for (const link of options.host.rootLinks) {
			const absolute = link.target.startsWith('/') ? link.target : `/${link.target}`;
			if (reads.some(root => isInsidePath(absolute, root)) && !reads.some(root => isInsidePath(link.path, root))) {
				push('--symlink', link.target, link.path);
			}
		}
	}

	// 2. Devices and processes of the sandbox only.
	push('--dev', '/dev', '--proc', '/proc');

	// 3. Masks. `/tmp` and `/dev/shm` always exist in the sandbox; the others only when visible.
	const masks = outermost(['/tmp', '/dev/shm', ...options.host.masks.filter(mask => mask !== '/tmp' && mask !== '/dev/shm' && isVisibleInSandbox(policy, mask))]);
	for (const mask of masks) {
		push('--tmpfs', mask);
	}
	for (const path of [...new Set(policy.read)].sort(byDepth).filter(path => masks.some(mask => isInsidePath(path, mask)))) {
		push('--ro-bind-try', path, path);
	}

	// 4. Writes, then files and sockets that must stay usable.
	const allWrites = [...new Set(policy.write)].sort(byDepth);
	for (const path of allWrites) {
		push('--bind-try', path, path);
	}
	for (const path of policy.writeFiles) {
		// A missing file cannot be bound; leaving it out is stricter, never wider.
		if (kindOf(path) === 'file') {
			push('--bind-try', path, path);
		}
	}
	for (const path of policy.unixSockets) {
		if (kindOf(path) !== 'missing') {
			push('--bind-try', path, path);
		}
	}
	if (isVisibleInSandbox(policy, '/etc')) {
		for (const path of options.host.reexpose) {
			if (!isVisibleInSandbox(policy, path) || masks.some(mask => isInsidePath(path, mask))) {
				push('--ro-bind-try', path, path);
			}
		}
	}

	// Protected and denied paths that exist, with what the walk found for patterns.
	const writable = [...allWrites, ...policy.writeFiles];
	const protect: IBubblewrapPathMatch[] = [];
	for (const path of policy.protect) {
		const kind = kindOf(path);
		// Outside writable roots a path is read-only already; a missing one cannot be covered.
		if (kind !== 'missing' && writable.some(root => isInsidePath(path, root))) {
			protect.push({ path, kind });
		}
	}
	protect.push(...options.matches.protect.filter(match => writable.some(root => isInsidePath(match.path, root))));
	const deny: IBubblewrapPathMatch[] = [];
	for (const path of policy.deny) {
		const kind = kindOf(path);
		if (kind !== 'missing' && (isVisibleInSandbox(policy, path) || policy.writeFiles.includes(path))) {
			deny.push({ path, kind });
		}
	}
	deny.push(...options.matches.deny);
	if (policy.unixSockets.length) {
		// Unix sockets are allowed for the granted ones: hide the other sockets the walk found.
		for (const path of options.matches.sockets) {
			if (!policy.unixSockets.includes(path)) {
				deny.push({ path, kind: 'file' });
			}
		}
	}
	const denyDirs = deny.filter(match => match.kind === 'dir').map(match => match.path);
	const insideDenied = (path: string) => denyDirs.some(dir => path !== dir && isInsidePath(path, dir));

	// 5. Pins.
	const pins = new Set<string>();
	for (const { path } of [...protect, ...deny]) {
		const root = writableRootOf(path, allWrites);
		if (!root || insideDenied(path)) {
			continue;
		}
		const parts = path.slice(root.length + 1).split('/');
		let current = root;
		for (const part of parts.slice(0, -1)) {
			current = `${current}/${part}`;
			if (!allWrites.includes(current)) {
				pins.add(current);
			}
		}
	}
	for (const pin of [...pins].sort(byDepth)) {
		push('--bind', pin, pin);
	}

	// 6. Protect.
	const protectedPaths = new Set<string>();
	for (const { path } of protect.sort((a, b) => byDepth(a.path, b.path))) {
		if (!protectedPaths.has(path) && !insideDenied(path)) {
			protectedPaths.add(path);
			push('--ro-bind', path, path);
		}
	}

	// 7. Deny.
	const deniedPaths = new Set<string>();
	for (const { path, kind } of deny.sort((a, b) => byDepth(a.path, b.path))) {
		if (deniedPaths.has(path) || insideDenied(path)) {
			continue;
		}
		deniedPaths.add(path);
		if (kind === 'dir') {
			push('--tmpfs', path, '--remount-ro', path);
		} else {
			push('--ro-bind', '/dev/null', path);
		}
	}

	// bubblewrap builds a minimal root on a tmpfs, writable by the sandbox's user: freeze it, so a
	// write outside the writable roots fails (EROFS) instead of landing in memory. Non-recursive:
	// the binds and tmpfs mounts on top keep their own modes.
	if (!policy.readAll) {
		push('--remount-ro', '/');
	}

	push('--chdir', policy.cwd);
	push(...bubblewrapCommand(command, commandArgs, options, policy.limits));
	return args;
}

/**
 * Arguments of the network bridge holder: a tiny bubblewrap that owns a fresh network namespace
 * (loopback only) and runs one socat per port in it. It has no seccomp filter and the host's
 * filesystem read-only: it runs only the constant bridge script, never workload code. The
 * sandbox is then spawned inside its user and network namespaces with `nsenter`.
 */
export function bridgeHolderArgs(socat: string, controlDir: string, ports: readonly number[], shell: string): string[] {
	for (const port of ports) {
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			throw new Error(`Cannot bridge port ${port}: only unprivileged ports (1024-65535)`);
		}
	}
	return [
		'--unshare-user', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session',
		'--ro-bind', '/', '/',
		// `--dev` would make bubblewrap nest a second user namespace (to mount devpts as root), and
		// nsenter must join the namespace that owns the network namespace. The holder is trusted.
		'--dev-bind', '/dev', '/dev',
		'--chdir', controlDir,
		'--json-status-fd', '3',
		'--', shell, '-c', BUBBLEWRAP_BRIDGE_SCRIPT, 'volt-bridge', socat, ...ports.map(String),
	];
}

/** Arguments of `nsenter` that run the sandbox inside the bridge holder's namespaces. */
export function nsenterArgs(holderPid: number, bwrap: string, bwrapArgs: readonly string[]): string[] {
	return [`--user=/proc/${holderPid}/ns/user`, `--net=/proc/${holderPid}/ns/net`, '--preserve-credentials', '--', bwrap, ...bwrapArgs];
}

export interface IBubblewrapRefusal {
	readonly dimension: SandboxDimension;
	readonly reason: string;
}

/**
 * Policy shapes this backend cannot enforce as reported, whatever the host: the backend refuses
 * them at launch rather than run with less.
 */
export function bubblewrapRefusals(policy: IResolvedSandboxPolicy, facts: { readonly controlDir: string; readonly shell: string; readonly prlimit?: string; readonly limitsApplied: boolean }): IBubblewrapRefusal[] {
	const out: IBubblewrapRefusal[] = [];
	if (policy.unixSockets.length && (policy.readAll || policy.network.mode === 'host')) {
		out.push({
			dimension: 'host.unixSockets',
			reason: policy.readAll
				? 'granting a unix socket allows AF_UNIX, and with the whole filesystem readable every other socket file would be reachable too'
				: 'granting a unix socket allows AF_UNIX, and the host network namespace exposes abstract sockets (X11, D-Bus)',
		});
	}
	const writable = [...policy.write, ...policy.writeFiles];
	if (writable.some(root => isInsidePath(facts.controlDir, root))) {
		out.push({ dimension: 'filesystem.write', reason: `the sandbox's control folder would be writable from inside: ${facts.controlDir}` });
	}
	if (!isVisibleInSandbox(policy, facts.shell)) {
		out.push({ dimension: 'process.isolation', reason: `${facts.shell} is not readable in the sandbox (add \${system} to read)` });
	}
	if (facts.limitsApplied && hasRlimits(policy.limits) && (!facts.prlimit || !isVisibleInSandbox(policy, facts.prlimit))) {
		for (const key of RLIMIT_KEYS) {
			if (policy.limits[key] !== undefined) {
				out.push({ dimension: limitDimension(key), reason: `limits need ${facts.prlimit ?? 'prlimit'} readable in the sandbox (add \${system} to read)` });
			}
		}
	}
	for (const port of policy.network.loopbackPorts) {
		if (port < 1024) {
			out.push({ dimension: 'network.loopbackPorts', reason: `port ${port} is privileged and cannot be bridged into the sandbox` });
		}
	}
	return out;
}
