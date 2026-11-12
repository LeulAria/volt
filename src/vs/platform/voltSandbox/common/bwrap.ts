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
 * pattern match created during the run, a new `.git` (`newRepositoryGuard`) and a name the `.git`
 * allow list leaves read-only but that is created during the run (a new `commondir`) are not covered.
 */

/**
 * File descriptors the backend passes, in `extraStdio` order (fd 3 up). The readiness script
 * relies on fd 3 (ready) and fd 7 (go). Root fds for `--bind-fd` follow from `firstRoot`.
 */
export const BUBBLEWRAP_FDS = { marker: 3, status: 4, args: 5, seccomp: 6, go: 7, firstRoot: 8 } as const;

/**
 * Runs inside the finished sandbox (after the mounts and the seccomp filter, as the first process
 * of the workload), the launch protocol's prologue (F.5): runs the canary (the run's sentinel
 * credential must be unreadable: masked, so ENOENT or empty), writes
 * `volt-sandbox-ready <pid> cred=<open|denied>` to fd 3, then blocks on fd 7 for the go byte.
 * The backend sends `g` and a newline only after it attested this process from outside (its `/proc` status:
 * NoNewPrivs, seccomp mode and filters, and namespaces); any other byte, EOF or nothing means
 * the workload never runs (exit 125). The ready line itself proves nothing: an unsandboxed
 * process can write the same. Constant: the sentinel and the workload arrive as positional
 * arguments, never as script text.
 */
export const BUBBLEWRAP_READY_SCRIPT = 's=$1; shift; l=; { read -r l < "$s"; } 2>/dev/null; if [ -n "$l" ]; then k=open; else k=denied; fi; printf \'volt-sandbox-ready %s cred=%s\\n\' "$$" "$k" >&3 || exit 125; exec 3>&-; g=; read -r g <&7; exec 7<&-; [ "$g" = g ] || exit 125; exec "$@"';

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
	/** The run's canary file (denied by the policy), read by the readiness script. */
	readonly sentinel: string;
	/**
	 * Roots bound from an fd the backend opened `O_PATH|O_NOFOLLOW` and verified (bubblewrap 0.10+
	 * `--bind-fd`): what is mounted is what was checked, even if the path is swapped meanwhile (B-33).
	 */
	readonly bindFds?: ReadonlyMap<string, number>;
	/** The Landlock layer (C4): bubblewrap's payload restricts itself before the prologue runs. */
	readonly landlock?: ILandlockInvocation;
	/** Variables bubblewrap itself was given that the workload must not inherit (`systemd-run`'s bus folder). */
	readonly unsetEnv?: readonly string[];
}

/** `build/volt/volt-landlock.c`, bound read-only at its own path and exec'd as bubblewrap's payload. */
export interface ILandlockInvocation {
	readonly path: string;
	/** The ABI the probe measured (1 or more): the helper refuses a kernel with less. */
	readonly abi: number;
}

/** Landlock ABI 6: abstract unix sockets and signals scoped to the sandbox (a second layer for LNX-UNIX-1). */
export const LANDLOCK_SCOPE_ABI = 6;

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
 * The workload command after `--`: the Landlock helper and its rules when the layer is on, the
 * readiness script, then prlimit when limits apply, then the command. Throws for a command
 * bubblewrap or the shell could take as an option.
 */
export function bubblewrapCommand(command: string, args: readonly string[], options: Pick<IBubblewrapArgsOptions, 'shell' | 'prlimit' | 'sentinel' | 'landlock'>, limits: ISandboxLimits, landlockRules: readonly string[] = []): string[] {
	if (!command || command.startsWith('-') || command.includes('\0') || args.some(arg => arg.includes('\0'))) {
		throw new Error('The sandboxed command must be a program name or path (not empty, not starting with "-", no NUL)');
	}
	if (!options.sentinel.startsWith('/') || options.sentinel.includes('\0')) {
		throw new Error('The canary sentinel must be an absolute path');
	}
	const out = ['--'];
	if (options.landlock) {
		if (!options.landlock.path.startsWith('/') || !Number.isInteger(options.landlock.abi) || options.landlock.abi < 1) {
			throw new Error('The Landlock helper needs an absolute path and an ABI of 1 or more');
		}
		out.push(options.landlock.path, String(options.landlock.abi), ...landlockRules, '--');
	}
	out.push(options.shell, '-c', BUBBLEWRAP_READY_SCRIPT, BUBBLEWRAP_READY_ARGV0, options.sentinel);
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

	// Environment first: `--args` inserts its arguments where it appears. Unset before, so a
	// policy that sets one of these names still gets its own value.
	for (const name of options.unsetEnv ?? []) {
		push('--unsetenv', name);
	}
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

	// The binds below, in order: the base reads (1), the reads under a mask (3), the writes (4).
	const reads = outermost(policy.read);
	const masks = outermost(['/tmp', '/dev/shm', ...options.host.masks.filter(mask => mask !== '/tmp' && mask !== '/dev/shm' && isVisibleInSandbox(policy, mask))]);
	const maskedReads = [...new Set(policy.read)].sort(byDepth).filter(path => masks.some(mask => isInsidePath(path, mask)));
	const allWrites = [...new Set(policy.write)].sort(byDepth);
	const bindsLeft = new Map<string, number>();
	for (const path of [...(policy.readAll ? [] : reads), ...maskedReads, ...allWrites]) {
		bindsLeft.set(path, (bindsLeft.get(path) ?? 0) + 1);
	}

	// Roots the backend opened as fds bind from the fd, so a path swapped after the check cannot
	// redirect the mount (B-33); the others by path. bubblewrap closes an fd once it bound it, so
	// a root bound more than once (a read under a mask, a read that is also a write) binds from
	// its fd only the last time: a later bind at the same path covers everything earlier there.
	const bindRoot = (path: string, writable: boolean) => {
		const fd = options.bindFds?.get(path);
		const left = (bindsLeft.get(path) ?? 1) - 1;
		bindsLeft.set(path, left);
		if (fd === undefined) {
			push(writable ? '--bind-try' : '--ro-bind-try', path, path);
		} else if (left === 0) {
			push(writable ? '--bind-fd' : '--ro-bind-fd', String(fd), path);
		}
	};

	// 1. Base.
	if (policy.readAll) {
		push('--ro-bind', '/', '/');
	} else {
		for (const path of reads) {
			bindRoot(path, false);
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
	for (const mask of masks) {
		push('--tmpfs', mask);
	}
	for (const path of maskedReads) {
		bindRoot(path, false);
	}

	// 3b. Isolated folders (every run folder, every principal's cache): an empty tmpfs, made
	// read-only at the end; this run's own child is bound back by the writes below (B-35).
	const isolated = (policy.isolated ?? []).filter(({ root }) => isVisibleInSandbox(policy, root) && !masks.some(mask => isInsidePath(root, mask)));
	for (const { root } of isolated) {
		push('--tmpfs', root);
	}

	// 4. Writes, then files and sockets that must stay usable.
	for (const path of allWrites) {
		bindRoot(path, true);
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

	for (const { root } of isolated) {
		push('--remount-ro', root);
	}

	// The Landlock helper, at its own path (before the root is frozen: its mount point may be new).
	if (options.landlock) {
		push('--ro-bind', options.landlock.path, options.landlock.path);
	}

	// bubblewrap builds a minimal root on a tmpfs, writable by the sandbox's user: freeze it, so a
	// write outside the writable roots fails (EROFS) instead of landing in memory. Non-recursive:
	// the binds and tmpfs mounts on top keep their own modes.
	if (!policy.readAll) {
		push('--remount-ro', '/');
	}

	push('--chdir', policy.cwd);
	const rules = options.landlock ? landlockRules(policy, { masks, writeFiles: policy.writeFiles.filter(path => kindOf(path) === 'file'), reexpose: options.host.reexpose, abi: options.landlock.abi }) : [];
	push(...bubblewrapCommand(command, commandArgs, options, policy.limits, rules));
	return args;
}

/**
 * The Landlock rules mirroring a run's mounts (see build/volt/volt-landlock.c): read roots
 * readable (or `/` with readAll), a narrow sandbox's `/` listable, write roots and the private
 * tmpfs masks writable, existing single files writable, `/dev` and `/proc` usable, and, from ABI 6,
 * abstract unix sockets and signals scoped to the sandbox. Grants only: a denied or protected path
 * below a granted root stays covered by its mount, as without Landlock.
 */
export function landlockRules(policy: IResolvedSandboxPolicy, facts: { readonly masks: readonly string[]; readonly writeFiles: readonly string[]; readonly reexpose: readonly string[]; readonly abi: number }): string[] {
	const out: string[] = [];
	const rule = (flag: string, path: string) => {
		if (!path.startsWith('/') || path.includes('\0')) {
			throw new Error(`A Landlock rule needs an absolute path: ${path}`);
		}
		out.push(flag, path);
	};
	if (policy.readAll) {
		rule('-r', '/');
	} else {
		rule('-l', '/');
		for (const path of outermost([...policy.read, ...facts.reexpose])) {
			rule('-r', path);
		}
	}
	for (const path of outermost([...policy.write, ...facts.masks])) {
		rule('-w', path);
	}
	for (const path of facts.writeFiles) {
		rule('-f', path);
	}
	rule('-d', '/dev');
	rule('-d', '/proc');
	if (facts.abi >= LANDLOCK_SCOPE_ABI) {
		out.push('-s');
	}
	return out;
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
