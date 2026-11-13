/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { close as closeFd, constants as fsConstants, Dirent, existsSync, fstatSync, FSWatcher, open as openFd, promises as fs, watch } from 'fs';
import * as net from 'net';
import { release, tmpdir } from 'os';
import { promisify } from 'util';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, join } from '../../../base/common/path.js';
import { helperIntegrity, verifyHelperBinary } from '../../voltHelpers/node/helperIntegrity.js';
import { bridgeHolderArgs, BUBBLEWRAP_FDS, bubblewrapArgs, bubblewrapEnvArgs, bubblewrapRefusals, encodeBubblewrapArgs, hasRlimits, IBubblewrapPathMatch, IBubblewrapPatternMatches, ILandlockInvocation, isInsidePath, LANDLOCK_SCOPE_ABI, nsenterArgs, PrlimitResource } from '../common/bwrap.js';
import { allEnforcement, ISandboxBackendCapabilities, ISandboxLayerState, parseReadyLine, redactSandboxText, SANDBOX_GO, SANDBOX_WRONG_GO, SandboxEnforcement, SandboxSecondLayerId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { gitDirWritable } from '../common/sandboxProfiles.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { ISandboxLimits, SandboxDimension } from '../common/sandboxSchema.js';
import { buildSeccompFilter, SeccompArch, seccompArch, seccompInstructions } from '../common/seccomp.js';
import { ISandboxBackend, ISandboxLaunchOptions, ISandboxLaunchSpec, SandboxConfirmation, SandboxFault } from './sandboxBackends.js';
import { binaryDigest, osBuild, ProbeCache } from './sandboxProbeCache.js';
import { isInside } from './sandboxResolver.js';

const execFileAsync = promisify(execFile);

/**
 * Linux: bubblewrap with a seccomp filter.
 *
 * The workload runs in new user, pid, mount, ipc, uts and cgroup namespaces (and a network
 * namespace unless the policy says `host`), with the filesystem the policy describes (see
 * common/bwrap.ts), no capabilities, NoNewPrivs and the filter from common/seccomp.ts. It is
 * started by a constant shell prologue that reports the sandbox's state from inside before
 * exec'ing the workload; only that report confirms the run.
 *
 * Network `proxy` and `loopbackPorts`: the sandbox's network namespace has no route out, so a
 * bridge carries those ports in. A tiny "holder" bubblewrap owns a fresh network namespace and
 * runs one socat per port, listening on its 127.0.0.1:<port> and forwarding to a unix socket in
 * the run's control folder, where this backend forwards to the host's 127.0.0.1:<port>. The
 * sandbox is spawned inside the holder's user and network namespaces with `nsenter`, so it sees
 * the bridges on its own loopback. Chosen over the alternatives after trying them:
 * - socat inside the sandbox needs `socket(AF_UNIX)`, which the filter refuses to every sandboxed
 *   process when no socket is granted; exempting the bridge would need a second, nested
 *   bubblewrap per run (works, but doubles startup, needs bwrap/sh/socat visible inside every
 *   policy's mounts, and races the workload: socat may not be listening yet when it starts).
 * - joining the sandbox's own network namespace from the host fails: with `--dev`, bubblewrap
 *   nests a second user namespace (to mount devpts as root), and the joiner must be in the one
 *   that owns the network namespace.
 * The holder's processes are outside the sandbox's pid and mount namespaces, in a parent user
 * namespace the workload has no capabilities in, and they are listening before the sandbox
 * exists, so there is no startup race. `--disable-userns` stays on.
 *
 * Environment: bubblewrap itself runs unsandboxed, so it is spawned with an empty environment
 * (a policy may set `LD_PRELOAD` for its workload; it must never load into the launcher) and the
 * workload's variables arrive as `--setenv` pairs through `--args FD`, off the command line.
 * `ISandboxLaunchSpec.env` is therefore empty for this backend.
 *
 * Limits: bubblewrap has none. prlimit runs inside the sandbox's user namespace, where Linux 5.14+
 * counts RLIMIT_NPROC per user namespace, so `processes` caps this sandbox, not the user.
 */

const CONFIRM_TIMEOUT_MS = 20_000;
const BRIDGE_TIMEOUT_MS = 5_000;
const TERMINATE_WAIT_MS = 2_000;
const MIN_VERSION: readonly [number, number, number] = [0, 4, 0];
/** CVE-2026-87766 (GHSA-pxhw-h44j-8pfx) is fixed here; older builds must pass the CVE trial (B-20, D-04). */
export const BUBBLEWRAP_FIXED_VERSION: readonly [number, number, number] = [0, 12, 0];
/** `--bind-fd` / `--ro-bind-fd` (B-33). */
const BIND_FD_VERSION: readonly [number, number, number] = [0, 10, 0];
/**
 * Only the system's bubblewrap: Ubuntu's AppArmor `bwrap-userns-restrict` profile is bound to
 * this path, and a copy elsewhere (PATH, a bundle) is a binary nobody vetted (J.2 distro gating).
 */
export const SYSTEM_BWRAP = '/usr/bin/bwrap';
/** `O_PATH` from linux/fcntl.h (the same on x86_64 and arm64); Node does not export it. */
const O_PATH = 0o10000000;
const WITHHELD_GO_MS = 750;

/** The bounded walk that expands `**\/` patterns into existing paths. Stopping at any limit refuses the run (B-27). */
export const PATTERN_WALK_LIMITS = { maxEntries: 50_000, maxDepth: 12, budgetMs: 1_500 } as const;
/** Folders the walk never descends into: large, regenerated, and never where secrets or hooks live. */
const WALK_SKIP: ReadonlySet<string> = new Set(['node_modules', '.cache', '.npm', '.pnpm-store', '.yarn', '.cargo', '.rustup', '.gradle', '.m2', '.nvm', '.venv', '__pycache__', 'snap', '.Trash']);

const TOP_LEVEL = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const MASK_CANDIDATES = ['/tmp', '/var/tmp', '/run', '/var/run', '/dev/shm'];
const NAMESPACES = ['mnt', 'pid', 'ipc', 'uts', 'net', 'cgroup'] as const;
type NamespaceName = typeof NAMESPACES[number];

interface IBubblewrapState {
	readonly capabilities: ISandboxBackendCapabilities;
	readonly bwrap: string;
	readonly version: readonly number[];
	readonly arch: SeccompArch;
	readonly shell: string;
	readonly prlimit?: string;
	readonly socat?: string;
	readonly nsenter?: string;
	/** The bridge trial passed: proxy and loopback ports can be carried in. */
	readonly bridge: boolean;
	readonly disableUserns: boolean;
	/** bubblewrap 0.10+: roots are bound from verified `O_PATH` fds. */
	readonly bindFd: boolean;
	/** `bubblewrap 0.13.1`, for the attestation record. */
	readonly versionText: string;
	readonly rootLinks: readonly { readonly path: string; readonly target: string }[];
	/** Top-level folders that are real folders (non-merged /usr), bound in trials. */
	readonly rootDirs: readonly string[];
	readonly hostNamespaces: Readonly<Partial<Record<NamespaceName, number>>>;
	/** The Landlock layer (C4), when the kernel has it and its trials passed. */
	readonly landlock?: ILandlockInvocation;
	/** The cgroup layer (C4), when systemd's user manager gives the user a delegated scope. */
	readonly cgroup?: ICgroupFacts;
	/** Why a second layer is absent, for every run's attestation. */
	readonly absent: Readonly<{ landlock?: string; cgroup?: string }>;
}

interface ICgroupFacts {
	readonly systemdRun: string;
	/** Asks the user manager how a scope ended (an OOM kill) and clears a failed one. */
	readonly systemctl: string;
	/** `XDG_RUNTIME_DIR` for systemd-run, which finds the user manager's bus there. */
	readonly runtimeDir: string;
	/** `cgroup.kill` (Linux 5.14+): one write ends the whole scope. */
	readonly kill: boolean;
	/** A process limit alone gets a scope too (before 5.14, RLIMIT_NPROC counts the user's processes). */
	readonly forProcesses: boolean;
}

type ILayerProbe<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

export const LANDLOCK_HELPER_ID = 'volt-landlock';

/** Where `volt-landlock` is: this build's verified helper, or (from sources) the one built into `.build`. */
export async function landlockHelperPath(): Promise<string | undefined> {
	const integrity = helperIntegrity();
	const bundled = await integrity.bundledPath(LANDLOCK_HELPER_ID);
	if (bundled || !integrity.developerMode) {
		return bundled;
	}
	const dev = join(dirname(FileAccess.asFileUri('').fsPath), '.build', 'volt-helpers', LANDLOCK_HELPER_ID);
	if (!existsSync(dev)) {
		return undefined;
	}
	return (await integrity.trustDeveloperHelper(LANDLOCK_HELPER_ID, dev)).ok ? dev : undefined;
}

/**
 * Reports a scope's cgroup path (relative to the cgroup root), its memory.max and pids.max, and
 * whether it has cgroup.kill. The trial runs it as the scope's own process.
 */
const CGROUP_TRIAL_SCRIPT = 'p=$(sed -n "s/^0:://p" /proc/self/cgroup); d=/sys/fs/cgroup$p; printf "%s|%s|%s|%s\\n" "$p" "$(cat "$d/memory.max")" "$(cat "$d/pids.max")" "$([ -e "$d/cgroup.kill" ] && echo kill)"';

/**
 * The cgroup layer behind its probe (C4, J.2): `systemd-run --user --scope` must reach the user
 * manager and give a trial scope the memory and pids limits it asked for, which needs cgroup v2
 * with `memory` and `pids` delegated to the user (systemd 252+ does by default). Otherwise the
 * layer is off and memory stays a per-process RLIMIT_AS (`partial`).
 */
async function probeCgroup(shell: string): Promise<ILayerProbe<Omit<ICgroupFacts, 'forProcesses'>>> {
	const [systemdRun, systemctl] = await Promise.all([findExecutable('systemd-run'), findExecutable('systemctl')]);
	if (!systemdRun || !systemctl) {
		return { ok: false, why: `${systemdRun ? 'systemctl' : 'systemd-run'} is not installed` };
	}
	const runtimeDir = `/run/user/${process.getuid?.() ?? -1}`;
	if (!existsSync(join(runtimeDir, 'systemd'))) {
		return { ok: false, why: `no systemd user manager runs for this user (${runtimeDir}/systemd is missing)` };
	}
	if ((await fs.readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8').catch(() => undefined)) === undefined) {
		return { ok: false, why: 'cgroup v2 is not mounted at /sys/fs/cgroup' };
	}
	const unit = `volt-sbx-probe-${process.pid}-${Date.now()}`;
	const output = await execFileAsync(systemdRun, [...systemdRunArgs(unit, { memoryMB: 64, processes: 32 }), shell, '-c', CGROUP_TRIAL_SCRIPT], { timeout: 10_000, env: { XDG_RUNTIME_DIR: runtimeDir } })
		.then(r => r.stdout.trim(), (err: Error & { stderr?: string }) => `error: ${(err.stderr || err.message).trim().split('\n')[0].slice(0, 200)}`);
	const [path, memory, pids, kill] = output.split('|');
	if (!path?.endsWith(`/${unit}.scope`)) {
		return { ok: false, why: output.startsWith('error: ') ? `systemd-run --user --scope failed: ${output.slice(7)}` : 'the trial did not run in its own scope' };
	}
	if (memory !== String(64 * 1024 * 1024) || pids !== '32') {
		return { ok: false, why: `the user manager does not delegate the memory and pids controllers (the trial scope had memory.max ${memory || 'missing'}, pids.max ${pids || 'missing'})` };
	}
	return { ok: true, value: { systemdRun, systemctl, runtimeDir, kill: kill === 'kill' } };
}

/** What `systemd-run --scope` adds to the environment it execs with (measured on systemd 255). */
const SYSTEMD_RUN_ADDS = ['INVOCATION_ID'];

/**
 * `systemd-run` arguments for a run's scope, up to the command (F.8: memory and pids from the
 * policy). Not `--collect`: a scope the kernel OOM-killed stays loaded as failed with
 * `Result=oom-kill` until the backend has read it (CgroupScope.stop), because an OOM kill can end a
 * run, and systemd remove its cgroup, before memory.events can be read. A scope that ends well is
 * unloaded at once either way.
 */
function systemdRunArgs(unit: string, limits: { readonly memoryMB?: number; readonly processes?: number }): string[] {
	const out = ['--user', '--scope', '--quiet', `--unit=${unit}`];
	if (limits.memoryMB !== undefined) {
		// No swap: the limit is on the memory the run holds, not a hint to page it out.
		out.push('-p', `MemoryMax=${Math.max(1, Math.floor(limits.memoryMB))}M`, '-p', 'MemorySwapMax=0');
	}
	if (limits.processes !== undefined) {
		out.push('-p', `TasksMax=${Math.max(1, Math.floor(limits.processes))}`);
	}
	out.push('--');
	return out;
}

interface IStatusInfo {
	readonly childPid: number;
	readonly namespaces: Readonly<Partial<Record<NamespaceName, number>>>;
}

export class BubblewrapBackend implements ISandboxBackend {

	readonly id = 'bubblewrap' as const;
	private readonly cache = new ProbeCache<IBubblewrapState | ISandboxBackendCapabilities>(state => !('capabilities' in state ? state.capabilities : state).available);

	/** Cached per (OS build, bubblewrap digest): the trials cost a few sandboxes' startup; an upgrade re-probes. */
	async probe(): Promise<ISandboxBackendCapabilities> {
		const state = await this.getState();
		return 'capabilities' in state ? state.capabilities : state;
	}

	private async getState(): Promise<IBubblewrapState | ISandboxBackendCapabilities> {
		const landlock = process.platform === 'linux' ? await landlockHelperPath().catch(() => undefined) : undefined;
		const key = `bubblewrap|${osBuild()}|${await binaryDigest(SYSTEM_BWRAP)}|${landlock ? await binaryDigest(landlock) : 'no landlock helper'}`;
		return this.cache.get(key, () => this.doProbe().catch(err => unavailable([], [`The bubblewrap probe failed: ${(err as Error).message}`])));
	}

	private async doProbe(): Promise<IBubblewrapState | ISandboxBackendCapabilities> {
		if (process.platform !== 'linux') {
			return unavailable([], [`bubblewrap runs on Linux only (this is ${process.platform}).`]);
		}
		const arch = seccompArch(process.arch);
		const details: string[] = [];
		const diagnostics: string[] = [];
		const kernel = release();
		details.push(`Linux ${kernel} ${process.arch}`);
		if (!arch) {
			diagnostics.push(`Volt has no seccomp filter for ${process.arch}; its Linux sandbox supports x64 and arm64.`);
		}
		const bwrap = await fs.access(SYSTEM_BWRAP, fsConstants.X_OK).then(() => SYSTEM_BWRAP, () => undefined);
		if (!bwrap) {
			const elsewhere = await findExecutable('bwrap');
			diagnostics.push(elsewhere
				? `Volt uses only the system bubblewrap at ${SYSTEM_BWRAP} (AppArmor's bwrap profile is bound to it), not ${elsewhere}. Install your distribution's package (bubblewrap ${BUBBLEWRAP_FIXED_VERSION.join('.')} or later).`
				: 'bubblewrap is not installed. Install it: `sudo apt install bubblewrap` (Debian, Ubuntu), `sudo dnf install bubblewrap` (Fedora), `sudo pacman -S bubblewrap` (Arch).');
		}
		const shell = await fs.realpath('/bin/sh').catch(() => undefined);
		if (!shell) {
			diagnostics.push('/bin/sh is missing.');
		}
		if (!arch || !bwrap || !shell) {
			return unavailable(details, diagnostics);
		}
		const versionText = await execFileAsync(bwrap, ['--version'], { timeout: 5_000, env: {} }).then(r => r.stdout.trim(), () => '');
		const version = (/(\d+)\.(\d+)\.(\d+)/.exec(versionText) ?? []).slice(1).map(Number);
		const stat = await fs.stat(bwrap);
		const setuid = (stat.mode & 0o4000) !== 0;
		details.push(`${versionText || 'bubblewrap (unknown version)'} (${bwrap}${setuid ? ', setuid' : ''})`);
		if (version.length !== 3 || compareVersions(version, MIN_VERSION) < 0) {
			diagnostics.push(`bubblewrap ${version.join('.') || '(unknown)'} is too old; Volt needs ${MIN_VERSION.join('.')} or later.`);
			return unavailable(details, diagnostics);
		}
		const [prlimitPath, socat, nsenter] = await Promise.all([findExecutable('prlimit'), findExecutable('socat'), findExecutable('nsenter')]);
		const prlimit = prlimitPath ? await fs.realpath(prlimitPath).catch(() => prlimitPath) : undefined;
		const rootLinks: { path: string; target: string }[] = [];
		const rootDirs: string[] = [];
		for (const path of TOP_LEVEL) {
			const st = await fs.lstat(path).catch(() => undefined);
			if (st?.isSymbolicLink()) {
				const target = await fs.readlink(path).catch(() => undefined);
				if (target) {
					rootLinks.push({ path, target });
				}
			} else if (st?.isDirectory()) {
				rootDirs.push(path);
			}
		}
		const hostNamespaces: Partial<Record<NamespaceName, number>> = {};
		for (const name of NAMESPACES) {
			const st = await fs.stat(`/proc/self/ns/${name}`).catch(() => undefined);
			if (st) {
				hostNamespaces[name] = st.ino;
			}
		}
		const disableUserns = compareVersions(version, [0, 8, 0]) >= 0;
		const bindFd = compareVersions(version, BIND_FD_VERSION) >= 0;
		const base: IBubblewrapState = {
			capabilities: unavailable(details, diagnostics),
			bwrap, version, arch, shell, prlimit, socat, nsenter, bridge: false, disableUserns, rootLinks, rootDirs, hostNamespaces,
			bindFd, versionText: versionText || `bubblewrap ${version.join('.')}`, absent: {},
		};

		// CVE-2026-87766: setup-time file creation follows symlinks in bound content onto the host.
		// Fixed in 0.12.0; an older build passes only on evidence (a backport), never on its version.
		const cve = await cveTrial(base);
		if (!cve.ok) {
			diagnostics.push(compareVersions(version, BUBBLEWRAP_FIXED_VERSION) < 0
				? `bubblewrap ${version.join('.')} has CVE-2026-87766 (a sandbox setup escape, fixed in ${BUBBLEWRAP_FIXED_VERSION.join('.')}), and Volt's trial confirmed it: ${cve.detail}. Install bubblewrap ${BUBBLEWRAP_FIXED_VERSION.join('.')} or later as ${SYSTEM_BWRAP} (Ubuntu 24.04 and Debian 12 ship older versions: use your distribution's backports or build it from https://github.com/containers/bubblewrap/releases).`
				: `bubblewrap ${version.join('.')} failed Volt's CVE-2026-87766 trial: ${cve.detail}.`);
			return unavailable(details, diagnostics);
		}
		details.push(`CVE-2026-87766: ${cve.detail}`);

		// A real trial: the same arguments, filter and confirmation as a run.
		const started = Date.now();
		const core = await this.trial(base, {});
		if (!core.ok) {
			diagnostics.push(...await userNamespaceDiagnostics(core.error));
			return unavailable(details, diagnostics);
		}
		details.push(`user namespaces: ok (trial sandbox in ${Date.now() - started} ms, attested from /proc)`);
		details.push(`seccomp: ${arch} filter, ${seccompInstructions(arch, { blockUnixSockets: true }).length} instructions, socket families inet/inet6, netlink route, unix when granted; --disable-userns: ${disableUserns ? 'yes' : 'no (bubblewrap < 0.8; seccomp still refuses new namespaces)'}`);
		details.push(bindFd ? 'roots: bound from verified O_PATH fds (--bind-fd)' : `roots: bound by path (bubblewrap < ${BIND_FD_VERSION.join('.')} has no --bind-fd), so roots under shared temp folders are refused`);

		const [bridgeTrial, limitsTrial, landlock, cgroup] = await Promise.all([
			socat && nsenter ? this.trial(base, { bridgePort: 41_000 + Math.floor(Math.random() * 1000) }) : Promise.resolve(undefined),
			prlimit ? this.trial(base, { limits: true }) : Promise.resolve(undefined),
			this.probeLandlock(base),
			probeCgroup(shell),
		]);
		details.push(landlock.ok
			? `landlock: ABI ${landlock.value.abi}, a second layer on reads, writes and devices${landlock.value.abi >= LANDLOCK_SCOPE_ABI ? ', abstract unix sockets and signals scoped' : ''} (${landlock.value.path}, trials ok)`
			: `landlock: off (${landlock.why})`);
		details.push(cgroup.ok
			? `cgroups: a systemd user scope per run with a memory or process limit (memory.max, pids.max${cgroup.value.kill ? ', cgroup.kill' : ''}), trial ok`
			: `cgroups: off (${cgroup.why}); memory is limited per process (RLIMIT_AS)`);
		const bridge = !!bridgeTrial?.ok;
		if (bridge) {
			details.push(`network bridge: ok (${socat} in a holder namespace, joined with ${nsenter})`);
		} else if (!socat || !nsenter) {
			diagnostics.push(`Network through Volt's proxy needs ${!socat ? 'socat' : 'nsenter (util-linux)'}: \`sudo apt install ${!socat ? 'socat' : 'util-linux'}\`.`);
		} else {
			diagnostics.push(`The network bridge trial failed: ${bridgeTrial?.ok === false ? bridgeTrial.error : 'unknown error'}`);
		}
		const limits = !!limitsTrial?.ok;
		if (prlimit && !limits) {
			diagnostics.push(`prlimit could not apply limits in a trial sandbox: ${limitsTrial?.ok === false ? limitsTrial.error : 'unknown error'}`);
		} else if (!prlimit) {
			diagnostics.push('Resource limits need prlimit (util-linux): `sudo apt install util-linux`.');
		}
		const kernelVersion = (/^(\d+)\.(\d+)/.exec(kernel) ?? []).slice(1).map(Number);
		const nprocPerUserns = kernelVersion.length === 2 && compareVersions(kernelVersion, [5, 14]) >= 0;
		if (limits) {
			details.push(`limits: ${prlimit} inside the sandbox's user namespace; cpu, file size, open files and memory are per process (RLIMIT_*)${nprocPerUserns ? ', processes per sandbox (Linux 5.14+)' : ''}`);
		}
		details.push(
			'listen: sockets listen inside the sandbox\'s own network namespace; nothing outside it can connect',
			'writeFiles: bound in place; atomic replace (write a sibling, rename over it) fails',
			'unix sockets: with none granted, seccomp refuses socket(AF_UNIX); granted ones are bound in and other socket files the walk finds are hidden; granting one with readAll or host network is refused',
			'denials: bubblewrap reports none; refused operations fail with EACCES, EROFS or EPERM in the workload',
		);

		const enforcement = allEnforcement('enforced');
		const notes: Partial<Record<SandboxDimension, string>> = {};
		const set = (dimension: SandboxDimension, value: SandboxEnforcement, note?: string) => {
			enforcement[dimension] = value;
			if (note) {
				notes[dimension] = note;
			}
		};
		set('filesystem.protectNew', 'partial', 'bubblewrap can only mount over paths that exist at launch: deny/protect entries that do not exist yet, pattern matches created during the run, and new .git folders are not covered.');
		notes['filesystem.denyPatterns'] = `Every existing match in the readable roots is masked at launch; a bounded walk finds them (${PATTERN_WALK_LIMITS.maxEntries} entries, depth ${PATTERN_WALK_LIMITS.maxDepth}, ${PATTERN_WALK_LIMITS.budgetMs} ms, skipping package and build caches), and a walk that stops early refuses the run.`;
		if (!bridge) {
			const why = !socat || !nsenter ? `needs ${!socat ? 'socat' : 'nsenter'} to bridge ports into the sandbox's network namespace` : 'the network bridge trial failed';
			set('network.proxy', 'unsupported', `${why[0].toUpperCase()}${why.slice(1)}; the sandbox has no network at all instead.`);
			set('network.loopbackPorts', 'unsupported', `${why[0].toUpperCase()}${why.slice(1)}.`);
		}
		if (limits) {
			set('limits.memory', 'partial', 'RLIMIT_AS caps virtual address space per process, not resident memory: runtimes that reserve large ranges (V8, Go, the JVM) can fail well below the limit.');
			if (!nprocPerUserns) {
				set('limits.processes', 'partial', `Linux ${kernel} counts RLIMIT_NPROC across all of the user's processes (per user namespace needs 5.14).`);
			}
		} else {
			const note = prlimit ? 'prlimit failed in a trial sandbox.' : 'Needs prlimit (util-linux) inside the sandbox.';
			for (const dimension of ['limits.cpu', 'limits.memory', 'limits.processes', 'limits.fileSize', 'limits.openFiles'] as const) {
				set(dimension, 'unsupported', note);
			}
		}
		if (cgroup.ok) {
			// Hard, for the whole tree (J.2): the run's own scope, memory.max and pids.max.
			set('limits.memory', 'enforced', 'cgroup v2 memory.max on the run\'s own systemd user scope: resident memory of the whole tree; the kernel kills the whole scope when it passes the limit (memory.oom.group).');
			if (!nprocPerUserns) {
				set('limits.processes', 'enforced', 'cgroup v2 pids.max on the run\'s own systemd user scope.');
			}
		}
		return {
			...base,
			prlimit: limits ? prlimit : undefined,
			bridge,
			...(landlock.ok ? { landlock: landlock.value } : {}),
			// From 5.14 RLIMIT_NPROC already counts per sandbox: a process limit alone needs no scope.
			...(cgroup.ok ? { cgroup: { ...cgroup.value, forProcesses: !nprocPerUserns } } : {}),
			absent: { ...(landlock.ok ? {} : { landlock: landlock.why }), ...(cgroup.ok ? {} : { cgroup: cgroup.why }) },
			capabilities: { backend: 'bubblewrap', available: true, enforcement, notes, details, diagnostics },
		};
	}

	/**
	 * Landlock behind its probe (C4): the helper of this build, the kernel's ABI, a check on the
	 * host that a domain without a write rule really refuses a write, then a trial sandbox through
	 * the launch path. Anything missing leaves the layer off and says why; it never refuses a run.
	 */
	private async probeLandlock(base: IBubblewrapState): Promise<ILayerProbe<ILandlockInvocation>> {
		const path = await landlockHelperPath().catch(() => undefined);
		if (!path) {
			return { ok: false, why: 'this build has no volt-landlock helper' };
		}
		const verified = await verifyHelperBinary(LANDLOCK_HELPER_ID, path);
		if (!verified.ok) {
			return { ok: false, why: `the volt-landlock helper failed its integrity check: ${verified.reason}` };
		}
		const abi = Number(/^abi (\d+)$/m.exec(await execFileAsync(path, ['probe'], { timeout: 5_000, env: {} }).then(r => r.stdout, () => ''))?.[1] ?? 0);
		if (!(abi >= 1)) {
			return { ok: false, why: 'the kernel has no Landlock, or it is not enabled (lsm=)' };
		}
		const dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'volt-sbx-landlock-'));
		try {
			const target = join(dir, 'refused');
			// Everything readable, nothing writable: the write must fail and leave nothing behind.
			const wrote = await execFileAsync(path, [String(abi), '-r', '/', '--', base.shell, '-c', ': > "$1"', 'volt-landlock-probe', target], { timeout: 5_000, env: {} }).then(() => true, () => false);
			if (wrote || existsSync(target)) {
				return { ok: false, why: `Landlock ABI ${abi} did not refuse a write outside its rules` };
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
		const invocation: ILandlockInvocation = { path, abi };
		const trial = await this.trial(base, { landlock: invocation });
		return trial.ok ? { ok: true, value: invocation } : { ok: false, why: `a trial sandbox with Landlock failed: ${trial.error}` };
	}

	/** Starts a trial sandbox through the launch path and waits for it to exit cleanly. */
	private async trial(state: IBubblewrapState, options: { bridgePort?: number; limits?: boolean; landlock?: ILandlockInvocation }): Promise<SandboxConfirmation> {
		const runDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'volt-sbx-probe-'));
		const tmp = join(runDir, 'tmp');
		let spec: ISandboxLaunchSpec | undefined;
		try {
			await fs.mkdir(tmp, { mode: 0o700 });
			// The canary sits in the writable folder, so only its deny mask keeps it unreadable.
			const sentinel = join(tmp, 'canary');
			await fs.writeFile(sentinel, 'volt-canary\n', { mode: 0o600 });
			const read = ['/usr', ...state.rootDirs];
			const policy: IResolvedSandboxPolicy = {
				name: 'probe', platform: 'linux', readAll: false, read, write: [tmp], writeFiles: [], deny: [sentinel], protect: [],
				denyPatterns: [], protectPatterns: [], newRepositoryGuard: [], gitDirs: [],
				network: { mode: 'none', allow: [], loopbackPorts: options.bridgePort ? [options.bridgePort] : [], listen: false },
				unixSockets: [], systemServices: false,
				limits: options.limits ? { processes: 64, openFiles: 256, cpuSeconds: 10, fileSizeMB: 1, memoryMB: 1024 } : {},
				env: { PATH: '/usr/bin:/bin' }, cwd: tmp, tmp, home: tmp, sentinel,
			};
			const withTools: IBubblewrapState = { ...state, bridge: !!options.bridgePort, prlimit: options.limits ? state.prlimit : undefined, landlock: options.landlock };
			spec = await this.createSpec(withTools, policy, state.shell, ['-c', 'exit 0'], { tag: 'probe', terminal: false, onDenial: () => undefined });
			const child = spawn(spec.command, [...spec.args], { env: spec.env, cwd: spec.cwd, stdio: ['ignore', 'ignore', 'pipe', ...spec.extraStdio], detached: true });
			const exited = new Promise<number | null>(resolve => {
				child.once('close', code => resolve(code));
				child.once('error', () => resolve(null));
			});
			const confirmation = await spec.confirm(child);
			const code = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))]);
			await spec.terminate(child);
			if (!confirmation.ok) {
				return confirmation;
			}
			return code === 0 ? confirmation : { ok: false, error: `the trial sandbox exited with ${code}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		} finally {
			await spec?.dispose().catch(() => undefined);
			await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		const state = await this.getState();
		if (!('capabilities' in state) || !state.capabilities.available) {
			const capabilities = 'capabilities' in state ? state.capabilities : state;
			throw new SandboxUnavailableError(`Linux sandbox unavailable: ${capabilities.diagnostics.join(' ')}`, 'unavailable', [], capabilities.diagnostics);
		}
		return this.createSpec(state, policy, command, args, options);
	}

	private async createSpec(state: IBubblewrapState, policy: IResolvedSandboxPolicy, command: string, commandArgs: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		// Ports to carry in. Without a working bridge the sandbox simply has no network (reported
		// `unsupported`, so the manager only gets here when the policy accepted that).
		const ports = policy.network.mode === 'host' || !state.bridge ? [] : [...new Set([
			...(policy.network.mode === 'proxy' ? [requireProxyPort(options.proxyPort)] : []),
			...policy.network.loopbackPorts,
		])];
		const controlDir = join(dirname(policy.tmp), 'ctl');
		const refusals = bubblewrapRefusals(policy, { controlDir, shell: state.shell, prlimit: state.prlimit, limitsApplied: !!state.prlimit });
		if (refusals.length) {
			throw new SandboxUnavailableError(`The Linux sandbox cannot enforce this policy: ${refusals.map(r => r.reason).join('; ')}`, 'unavailable', [...new Set(refusals.map(r => r.dimension))]);
		}
		const sentinel = policy.sentinel;
		if (!sentinel || !policy.deny.includes(sentinel)) {
			throw new SandboxUnavailableError('The run has no canary sentinel the policy denies', 'unavailable');
		}
		// Without --bind-fd a root is bound by path, after it was checked: under a folder every
		// sandbox can write, another one could swap it for a symlink in between (B-33). A PTY
		// launch passes only FIFOs through the terminal (sandboxPty.ts), never open fds, so it binds
		// by path too, under the same rule.
		const roots = bindableRoots(policy);
		const bindFd = state.bindFd && !options.terminal;
		if (!bindFd) {
			const temps = await agentWritableTemps();
			const shared = roots.filter(root => temps.some(temp => root !== temp && isInsidePath(root, temp)));
			if (shared.length) {
				const why = state.bindFd ? 'a terminal cannot carry the folders\' file descriptors' : `needs ${BIND_FD_VERSION.join('.')}+ for --bind-fd`;
				throw new SandboxUnavailableError(`bubblewrap ${state.version.join('.')} cannot bind ${shared.join(', ')} race-free (${why}): a folder under a shared temp folder could be swapped while the sandbox is set up`, 'unavailable', ['filesystem.read']);
			}
		}
		await fs.mkdir(controlDir, { recursive: true, mode: 0o700 });

		const [kinds, masks, reexpose, walked, hard] = await Promise.all([
			pathKinds([...policy.deny, ...policy.protect, ...policy.writeFiles, ...policy.unixSockets]),
			maskFolders(controlDir),
			reexposedFiles(),
			walkPatterns(policy, { collectSockets: policy.unixSockets.length > 0 }),
			state.prlimit && hasRlimits(policy.limits) ? hardLimits() : Promise.resolve({}),
		]);
		const matches: IPatternWalkResult = { ...walked, protect: [...walked.protect, ...await gitAllowListProtections(policy, walked.protect)] };
		if (policy.denyPatterns.length && !matches.complete) {
			// A `.env` the walk did not reach would stay readable: refuse rather than run with less (B-27).
			throw new SandboxUnavailableError(`The Linux sandbox could not check every folder for ${policy.denyPatterns.map(p => p.names.join('/')).filter((n, i, all) => all.indexOf(n) === i).slice(0, 4).join(', ')} files before starting (it stopped after ${matches.visited} folders${matches.unfinished ? `, at ${redactSandboxText(matches.unfinished, policy.home)}` : ''}: over ${PATTERN_WALK_LIMITS.maxEntries} entries, deeper than ${PATTERN_WALK_LIMITS.maxDepth} levels or slower than ${PATTERN_WALK_LIMITS.budgetMs} ms). Open a smaller folder, or narrow what the sandbox reads.`, 'unavailable', ['filesystem.denyPatterns']);
		}
		// Second layers (C4). Landlock: the helper checked like every helper, right before the launch;
		// one that fails refuses the run (the probe found it good, so a change is tampering).
		if (state.landlock) {
			const verified = await verifyHelperBinary(LANDLOCK_HELPER_ID, state.landlock.path);
			if (!verified.ok) {
				throw new SandboxUnavailableError(`The Landlock helper failed its integrity check: ${verified.reason}`, 'unavailable');
			}
		}
		// The run's own systemd scope, when it has a limit only a cgroup holds for the whole tree.
		const scope = state.cgroup && (policy.limits.memoryMB !== undefined || (state.cgroup.forProcesses && policy.limits.processes !== undefined))
			? new CgroupScope(state.cgroup, `volt-sbx-${options.tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}-${process.pid}-${++scopeCount}`, policy.limits)
			: undefined;
		// With memory in the cgroup, RLIMIT_AS (which breaks V8, Go and the JVM well below its value) is dropped.
		const rlimits = scope?.memoryMB !== undefined ? { ...policy, limits: { ...policy.limits, memoryMB: undefined } } : policy;
		const opened = bindFd ? await openRoots(roots) : { fds: new Map<string, number>(), close: () => undefined };
		let bwrapArgs: string[];
		try {
			bwrapArgs = bubblewrapArgs(rlimits, command, commandArgs, {
				terminal: options.terminal,
				disableUserns: state.disableUserns,
				bridged: ports.length > 0,
				host: { kinds, rootLinks: state.rootLinks, masks, reexpose },
				matches,
				shell: state.shell,
				prlimit: state.prlimit ? { path: state.prlimit, hard } : undefined,
				sentinel,
				bindFds: new Map([...opened.fds.keys()].map((path, index) => [path, BUBBLEWRAP_FDS.firstRoot + index])),
				...(state.landlock ? { landlock: state.landlock } : {}),
				// systemd-run passes its own environment on to bubblewrap; the workload starts from the policy's.
				...(scope ? { unsetEnv: [...Object.keys(scope.env), ...SYSTEMD_RUN_ADDS] } : {}),
			});
		} catch (err) {
			opened.close();
			throw err;
		}
		const blockUnixSockets = policy.unixSockets.length === 0;
		// The host's network namespace: no listening unless granted (B-30). Granted ports cannot be
		// told apart by seccomp, so a grant there allows every port (the agent profile marks it best effort).
		const blockListen = policy.network.mode === 'host' && !policy.network.listen && !policy.network.listenPorts?.length;
		const seccomp = buildSeccompFilter(state.arch, { blockUnixSockets, blockListen });
		const envArgs = Buffer.from(encodeBubblewrapArgs(bubblewrapEnvArgs(policy.env)), 'utf8');

		let bridge: BubblewrapBridge | undefined;
		if (ports.length) {
			try {
				bridge = await BubblewrapBridge.start(state, controlDir, ports, policy.home);
			} catch (err) {
				opened.close();
				throw err;
			}
		}
		const limitsText = state.prlimit && hasRlimits(rlimits.limits) ? 'limits via prlimit' : 'no rlimits';
		const patternText = policy.denyPatterns.length || policy.protectPatterns.length
			? `patterns: ${matches.deny.length + matches.protect.length} existing paths`
			: '';
		const layers: Partial<Record<SandboxSecondLayerId, ISandboxLayerState>> = {
			landlock: state.landlock
				? { active: true, detail: `ABI ${state.landlock.abi}: reads, writes and devices mirrored before the prologue${state.landlock.abi >= LANDLOCK_SCOPE_ABI ? '; abstract unix sockets and signals scoped' : ''}` }
				: { active: false, detail: state.absent.landlock ?? 'off' },
			cgroup: { active: false, detail: state.cgroup ? 'the run has no memory limit' : state.absent.cgroup ?? 'off' },
		};
		let status: IStatusInfo | undefined;
		let disposed = false;
		const inner = bridge ? [state.nsenter!, ...nsenterArgs(bridge.holderPid, state.bwrap, bwrapArgs)] : [state.bwrap, ...bwrapArgs];
		return {
			command: scope ? scope.facts.systemdRun : inner[0],
			args: scope ? [...systemdRunArgs(scope.unit, scope.limits), ...inner] : inner.slice(1),
			// Deliberately empty (see the class comment: the workload's environment goes through `--args`),
			// except for where systemd-run finds the user manager, which bubblewrap unsets again.
			env: scope ? { ...scope.env } : {},
			cwd: '/',
			// BUBBLEWRAP_FDS: marker, status, args, seccomp, go; then the root fds for --bind-fd (never on a PTY).
			extraStdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', ...opened.fds.values()],
			// The readiness line and the status are read; the arguments, the filter and the go byte are written.
			// A root fd is passed as is: Volt neither reads nor writes it, so it counts as `in`.
			extraStdioDirections: ['out', 'out', 'in', 'in', 'in', ...[...opened.fds.values()].map(() => 'in' as const)],
			confirm: async child => {
				// The spawn holds its own copies of the root fds now.
				opened.close();
				const result = await confirmLaunch(child, {
					envArgs, seccomp, home: policy.home, hostNamespaces: state.hostNamespaces, fault: options.fault,
					expectNet: policy.network.mode === 'host' ? 'host' : bridge ? bridge.netNamespace : 'new',
					// The workload is attested; before it may run, its scope must be the one asked for.
					...(scope ? { beforeGo: async (pid: number) => scope.attach(pid) } : {}),
				});
				if (!result.ok) {
					return result;
				}
				status = result.status;
				if (scope) {
					layers.cgroup = { active: true, detail: scope.describe() };
					scope.watch(options);
				}
				const parts = [
					`bubblewrap ${state.version.join('.')}`,
					`namespaces ${Object.keys(result.status.namespaces).join(', ')}, user`,
					`network ${policy.network.mode}${bridge ? ` (bridged ports ${ports.join(', ')})` : ''}`,
					`seccomp${blockUnixSockets ? ' (unix sockets refused)' : ''}, NoNewPrivs`,
					limitsText,
					...(state.landlock ? [`landlock ABI ${state.landlock.abi}`] : []),
					...(scope ? [`cgroup ${scope.path}`] : []),
					...(patternText ? [patternText] : []),
					`pid ${result.status.childPid}`,
					`attested from /proc (pid ${result.workloadPid})`,
				];
				const evidence = { ...result.evidence, ...(state.landlock ? { landlockAbi: state.landlock.abi } : {}), ...(scope ? { cgroup: scope.path! } : {}) };
				return {
					ok: true,
					detail: parts.join('; '),
					attestation: { evidence, canary: { credOpen: result.cred }, backendVersion: state.versionText, layers },
				};
			},
			terminate: async child => {
				opened.close();
				// One write ends the whole scope (F.10); the pid namespace's init goes with it anyway.
				await scope?.kill();
				await killSandbox(child, status);
				await bridge?.stop();
			},
			dispose: async () => {
				if (disposed) {
					return;
				}
				disposed = true;
				opened.close();
				await scope?.stop(options);
				await bridge?.stop();
				await fs.rm(controlDir, { recursive: true, force: true }).catch(() => undefined);
			},
		};
	}
}

/** Folders the sandbox binds from the host: the outermost read roots and every write root. */
function bindableRoots(policy: IResolvedSandboxPolicy): string[] {
	const reads = policy.readAll ? [] : policy.read.filter(path => !policy.read.some(other => other !== path && isInsidePath(path, other)));
	return [...new Set([...reads, ...policy.write])];
}

/** Temp folders every agent profile may write: `/tmp`, `/var/tmp`, `/dev/shm` and `os.tmpdir()`. */
async function agentWritableTemps(): Promise<string[]> {
	const out = new Set<string>();
	for (const dir of ['/tmp', '/var/tmp', '/dev/shm', tmpdir()]) {
		out.add(await fs.realpath(dir).catch(() => dir));
	}
	return [...out];
}

/**
 * Opens each user-owned root `O_PATH|O_NOFOLLOW` and checks the fd is the folder the policy named
 * (its `/proc/self/fd` link reads back the same path, and it is not a symlink), so the mount
 * bubblewrap makes from it cannot be redirected by a later swap. Roots owned by another user
 * (root's `/usr`) cannot be swapped by a same-user process and stay bound by path. A root that
 * fails the check refuses the run.
 */
async function openRoots(roots: readonly string[]): Promise<{ readonly fds: ReadonlyMap<string, number>; close(): void }> {
	const fds = new Map<string, number>();
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			for (const fd of fds.values()) {
				closeFd(fd, () => undefined);
			}
		}
	};
	const uid = process.getuid?.();
	try {
		for (const root of roots) {
			const fd = await new Promise<number | undefined>(resolve => openFd(root, O_PATH | fsConstants.O_NOFOLLOW, (err, value) => resolve(err ? undefined : value)));
			if (fd === undefined) {
				continue; // Missing: bubblewrap's `-try` binds leave it out, which is stricter.
			}
			const st = fstatSync(fd);
			if (st.uid !== uid) {
				closeFd(fd, () => undefined);
				continue;
			}
			fds.set(root, fd);
			const target = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => undefined);
			if (st.isSymbolicLink() || target !== root) {
				throw new SandboxUnavailableError(`The sandbox root ${root} changed while the sandbox was being set up (now ${target ?? 'unreadable'})`, 'failed', ['filesystem.read']);
			}
		}
	} catch (err) {
		close();
		throw err;
	}
	return { fds, close };
}

/**
 * CVE-2026-87766 on evidence: a fixture whose bound content holds a symlink to `/oldroot/<host
 * folder>` (the host's root during setup), and a `--dir` below that link. A vulnerable bubblewrap
 * creates the folder on the host, outside the fixture; a fixed one (`openat2(RESOLVE_IN_ROOT)`)
 * keeps it inside the sandbox or refuses.
 */
async function cveTrial(state: IBubblewrapState): Promise<{ readonly ok: boolean; readonly detail: string }> {
	const fixture = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'volt-sbx-cve-'));
	try {
		const bound = join(fixture, 'bound');
		const outside = join(fixture, 'outside');
		await fs.mkdir(bound);
		await fs.mkdir(outside);
		await fs.symlink(`/oldroot${outside}`, join(bound, 'link'));
		const args = [
			'--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session',
			'--ro-bind', '/usr', '/usr',
			...state.rootLinks.flatMap(link => ['--symlink', link.target, link.path]),
			...state.rootDirs.flatMap(dir => ['--ro-bind', dir, dir]),
			'--bind', bound, bound,
			'--dir', `${bound}/link/volt-cve-probe`,
			'--', state.shell, '-c', 'exit 0',
		];
		const result = await execFileAsync(state.bwrap, args, { timeout: 10_000, env: {} }).then(() => 'ran', (err: Error) => `refused (${err.message.split('\n')[0].slice(0, 160)})`);
		const escaped = await fs.lstat(join(outside, 'volt-cve-probe')).then(() => true, () => false);
		return escaped
			? { ok: false, detail: 'a folder bubblewrap created during setup landed outside the bound fixture' }
			: { ok: true, detail: `setup-time creation stayed inside the sandbox (trial ${result})` };
	} catch (err) {
		return { ok: false, detail: `the trial could not run: ${(err as Error).message}` };
	} finally {
		await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
	}
}

function requireProxyPort(port: number | undefined): number {
	if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new SandboxUnavailableError('Network mode `proxy` needs the proxy port', 'unavailable', ['network.proxy']);
	}
	return port;
}

function unavailable(details: readonly string[], diagnostics: readonly string[]): ISandboxBackendCapabilities {
	return { backend: 'bubblewrap', available: false, enforcement: allEnforcement('unsupported'), notes: {}, details, diagnostics };
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) {
			return d;
		}
	}
	return 0;
}

/** The system's copy first: a PATH entry is only a fallback. */
async function findExecutable(name: string): Promise<string | undefined> {
	const dirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':').filter(dir => dir.startsWith('/'))];
	for (const dir of dirs) {
		const path = join(dir, name);
		try {
			await fs.access(path, fsConstants.X_OK);
			if ((await fs.stat(path)).isFile()) {
				return path;
			}
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/**
 * Why unprivileged user namespaces failed, as actions the user can take. `error` is bubblewrap's
 * own message from the trial.
 */
async function userNamespaceDiagnostics(error: string): Promise<string[]> {
	const read = (path: string) => fs.readFile(path, 'utf8').then(text => text.trim(), () => undefined);
	const [apparmor, clone, max] = await Promise.all([
		read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
		read('/proc/sys/kernel/unprivileged_userns_clone'),
		read('/proc/sys/user/max_user_namespaces'),
	]);
	const out = [`bubblewrap could not start a sandbox: ${error}`];
	if (apparmor === '1') {
		out.push('Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns=1). Allow bubblewrap with a profile: write `abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }` to /etc/apparmor.d/bwrap, then run `sudo apparmor_parser -r /etc/apparmor.d/bwrap`.');
	}
	if (clone === '0') {
		out.push('Unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0). Enable them: `sudo sysctl -w kernel.unprivileged_userns_clone=1`, and add it to /etc/sysctl.d/ to keep it.');
	}
	if (max === '0') {
		out.push('User namespaces are disabled (user.max_user_namespaces=0). Enable them: `sudo sysctl -w user.max_user_namespaces=15000`, and add it to /etc/sysctl.d/ to keep it.');
	}
	if (/proc/i.test(error) && /Operation not permitted/i.test(error)) {
		out.push('Mounting /proc was refused, which happens in containers that mask /proc paths (Docker: run with `--security-opt systempaths=unconfined`).');
	}
	return out;
}

/**
 * Kind of each path that exists. A symlink counts as missing: a mount over it lands on its target
 * (and fails while that is not mounted yet), and the resolver lists the target itself, which is
 * what a mount can cover. The link's own name stays best effort (`filesystem.protectNew`).
 */
async function pathKinds(paths: readonly string[]): Promise<Map<string, 'dir' | 'file'>> {
	const out = new Map<string, 'dir' | 'file'>();
	await Promise.all([...new Set(paths)].map(async path => {
		const st = await fs.lstat(path).catch(() => undefined);
		if (st && !st.isSymbolicLink()) {
			out.set(path, st.isDirectory() ? 'dir' : 'file');
		}
	}));
	return out;
}

/** Folders whose sockets must not be visible: real folders only (`/var/run` is usually a link into `/run`). */
async function maskFolders(controlDir: string): Promise<string[]> {
	const candidates = [...MASK_CANDIDATES, `/run/user/${process.getuid?.() ?? -1}`, controlDir];
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime?.startsWith('/')) {
		candidates.push(runtime);
	}
	const out: string[] = [];
	for (const path of candidates) {
		const st = await fs.lstat(path).catch(() => undefined);
		if (st?.isDirectory()) {
			out.push(path);
		}
	}
	return out;
}

/** `/etc/resolv.conf` usually points into `/run`, which is masked: its target stays readable. */
async function reexposedFiles(): Promise<string[]> {
	const target = await fs.realpath('/etc/resolv.conf').catch(() => undefined);
	return target && !isInsidePath(target, '/etc') ? [target] : [];
}

/** The sandbox inherits these hard limits; asking prlimit for more would fail. */
async function hardLimits(): Promise<Partial<Record<PrlimitResource, number>>> {
	const text = await fs.readFile('/proc/self/limits', 'utf8').catch(() => '');
	const names: Record<string, PrlimitResource> = { 'Max cpu time': 'cpu', 'Max file size': 'fsize', 'Max processes': 'nproc', 'Max open files': 'nofile', 'Max address space': 'as' };
	const out: Partial<Record<PrlimitResource, number>> = {};
	for (const line of text.split('\n')) {
		const cols = line.split(/\s{2,}/);
		const resource = names[cols[0]];
		if (resource && /^\d+$/.test(cols[2] ?? '')) {
			out[resource] = Number(cols[2]);
		}
	}
	return out;
}

export interface IPatternWalkResult extends IBubblewrapPatternMatches {
	/** False when the walk stopped at a limit before visiting everything. */
	readonly complete: boolean;
	readonly visited: number;
	/** When not complete: a required folder the walk did not finish (for the refusal). */
	readonly unfinished?: string;
}

/**
 * Expands `denyPatterns`/`protectPatterns` into the existing paths they match, by a breadth-first
 * walk of their roots bounded by `PATTERN_WALK_LIMITS` (shallow matches first, so a root's own
 * `.env` is always found). A root of `/` (readAll denies) is walked as the working directory, the
 * writable roots and the home folder: walking the whole disk would only spend the budget on
 * system folders. Symlinks are not followed. Also collects socket files when asked.
 *
 * `complete` covers the required roots: the workspace, the writes, the patterns' own roots and a
 * home the sandbox can read. With narrow reads the home is not readable, only the toolchains in
 * it (`~/.cargo`, `~/.dotnet`, `~/go`); they, and the shared temp folders an agent may write
 * (`/tmp`), are walked after the required roots, with what is left of the budget, best effort: an
 * install or a busy `/tmp` would otherwise refuse every run.
 */
export async function walkPatterns(policy: IResolvedSandboxPolicy, options: { collectSockets: boolean }, limits: { readonly [K in keyof typeof PATTERN_WALK_LIMITS]: number } = PATTERN_WALK_LIMITS): Promise<IPatternWalkResult> {
	type Kind = 'deny' | 'protect';
	const patterns: { kind: Kind; pattern: IResolvedPattern }[] = [];
	// A pattern anywhere (`**/.env`) is looked for where the sandbox can see it: the workspace, the
	// writes and the home. With narrow reads the home itself is not visible, only the read roots
	// inside it are; walking all of it (a checkout, caches, a big home) would only make the walk
	// incomplete, which refuses the run (B-27), for files the sandbox cannot reach anyway.
	const homeVisible = policy.readAll || policy.read.some(root => isInside(policy.home, root));
	const homeRoots = homeVisible ? [policy.home] : policy.read.filter(root => isInside(root, policy.home));
	// Best effort (see above), as the resolver marks its own expansions of `**/`: read-only
	// toolchains in an unreadable home, and the shared temp folders an agent may write.
	const temps = await agentWritableTemps();
	const expandRoot = (pattern: IResolvedPattern): IResolvedPattern[] => pattern.root === '/'
		? [...new Set([policy.cwd, ...policy.write, ...homeRoots])].map(root => ({
			root, names: pattern.names,
			...(root !== policy.cwd && (temps.includes(root) || (!homeVisible && !policy.write.includes(root))) ? { bestEffort: true } : {}),
		}))
		: [pattern];
	for (const pattern of policy.denyPatterns) {
		patterns.push(...expandRoot(pattern).map(p => ({ kind: 'deny' as const, pattern: p })));
	}
	for (const pattern of policy.protectPatterns) {
		patterns.push(...expandRoot(pattern).map(p => ({ kind: 'protect' as const, pattern: p })));
	}
	// A root is walked best effort only when every pattern on it is, and never the working directory.
	const required = (root: string) => root === policy.cwd || patterns.some(({ pattern }) => pattern.root === root && !pattern.bestEffort) || (options.collectSockets && policy.write.includes(root) && !temps.includes(root));
	const roots = [...new Set([...patterns.map(p => p.pattern.root), ...(options.collectSockets ? policy.write : [])])].sort((a, b) => a.length - b.length);
	const deny = new Map<string, IBubblewrapPathMatch>();
	const protect = new Map<string, IBubblewrapPathMatch>();
	const sockets = new Set<string>();
	const visitedDirs = new Set<string>();
	const started = Date.now();
	let entries = 0;
	let complete = true;
	let unfinished: string | undefined;
	const stop = (bestEffort: boolean, dir: string | undefined) => {
		if (!bestEffort && complete) {
			complete = false;
			unfinished = dir;
		}
	};
	// The required roots' folders first, then the best-effort ones.
	const queues: { dir: string; depth: number; root: boolean }[][] = [
		roots.filter(required).map(dir => ({ dir, depth: 0, root: true })),
		roots.filter(dir => !required(dir)).map(dir => ({ dir, depth: 0, root: true })),
	];
	while (queues[0].length || queues[1].length) {
		const bestEffort = !queues[0].length;
		const queue = bestEffort ? queues[1] : queues[0];
		if (entries >= limits.maxEntries || Date.now() - started > limits.budgetMs) {
			stop(bestEffort, queue[0]?.dir);
			break;
		}
		const { dir, depth, root } = queue.shift()!;
		if (visitedDirs.has(dir)) {
			continue;
		}
		visitedDirs.add(dir);
		let list: Dirent[];
		try {
			list = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		entries += list.length;
		const names = new Map(list.map(entry => [entry.name, entry]));
		for (const { kind, pattern } of patterns) {
			// The resolver's comparison: Windows paths (MXC uses this walk too) are case-insensitive with `\`.
			if (!isInside(dir, pattern.root)) {
				continue;
			}
			const first = names.get(pattern.names[0]);
			if (!first) {
				continue;
			}
			const path = join(dir, ...pattern.names);
			let matchKind: 'dir' | 'file' | undefined;
			if (pattern.names.length === 1 && !first.isSymbolicLink()) {
				matchKind = first.isDirectory() ? 'dir' : 'file';
			} else {
				const st = await fs.stat(path).catch(() => undefined);
				matchKind = st ? (st.isDirectory() ? 'dir' : 'file') : undefined;
			}
			if (matchKind) {
				(kind === 'deny' ? deny : protect).set(path, { path, kind: matchKind });
			}
		}
		for (const entry of list) {
			const path = join(dir, entry.name);
			if (options.collectSockets && entry.isSocket()) {
				sockets.add(path);
			}
			if (!entry.isDirectory() || WALK_SKIP.has(entry.name) || deny.has(path)) {
				continue;
			}
			if (depth + 1 > limits.maxDepth) {
				// A folder the walk will not look into: a match there would stay readable.
				stop(bestEffort, path);
				continue;
			}
			// A repository's `.git` is matched from its parent (`.git/config`, `.git/hooks`), so the
			// walk never enters one. A `.git` that is a root itself (a linked worktree's common
			// folder) is walked for `config.worktree`, minus its objects.
			if (entry.name === '.git' || (entry.name === 'objects' && root && /[\\/]\.git$/.test(dir))) {
				continue;
			}
			queue.push({ dir: path, depth: depth + 1, root: false });
		}
	}
	return { deny: [...deny.values()], protect: [...protect.values()], sockets: [...sockets], complete, visited: visitedDirs.size, ...(unfinished ? { unfinished } : {}) };
}

/**
 * The Linux side of the `.git` allow list (B-03). Bind mounts can only cover paths that exist, so
 * every existing name in each git folder, and in each linked worktree's folder below it, that the
 * allow list does not make writable is protected (read-only bind). A name created during the run
 * (a `commondir` that was not there at launch) is not covered: that is `filesystem.protectNew`,
 * reported partial, until Landlock lands. HostGit refuses a redirected repository on the host
 * either way (INV-16). Git folders: each `anyDepth` root's own `.git`, the ones the pattern walk
 * found (`**\/.git/config` and friends), and each `.git` that is itself a writable root.
 */
export async function gitAllowListProtections(policy: IResolvedSandboxPolicy, found: readonly IBubblewrapPathMatch[]): Promise<IBubblewrapPathMatch[]> {
	const gitDirs = new Set<string>();
	for (const dir of policy.gitDirs) {
		gitDirs.add(dir.anyDepth ? join(dir.root, '.git') : dir.root);
	}
	if (policy.gitDirs.some(dir => dir.anyDepth)) {
		for (const match of found) {
			// Windows (the MXC backend shares this) separates with backslashes.
			const at = Math.max(match.path.lastIndexOf('/.git/'), match.path.lastIndexOf('\\.git\\'));
			if (at >= 0) {
				gitDirs.add(match.path.slice(0, at + 5));
			}
		}
	}
	const out: IBubblewrapPathMatch[] = [];
	const list = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
	const add = async (gitDir: string, relative: string, entry: Dirent) => {
		if (!entry.isSymbolicLink() && !gitDirWritable(relative)) {
			out.push({ path: join(gitDir, relative), kind: entry.isDirectory() ? 'dir' : 'file' });
		}
	};
	for (const gitDir of gitDirs) {
		const st = await fs.lstat(gitDir).catch(() => undefined);
		if (!st?.isDirectory()) {
			continue;
		}
		for (const entry of await list(gitDir)) {
			if (entry.name === 'worktrees' && entry.isDirectory()) {
				for (const worktree of await list(join(gitDir, 'worktrees'))) {
					if (!worktree.isDirectory()) {
						await add(gitDir, `worktrees/${worktree.name}`, worktree);
						continue;
					}
					for (const inner of await list(join(gitDir, 'worktrees', worktree.name))) {
						await add(gitDir, `worktrees/${worktree.name}/${inner.name}`, inner);
					}
				}
				continue;
			}
			await add(gitDir, entry.name, entry);
		}
		for (const name of ['alternates', 'http-alternates']) {
			const path = join(gitDir, 'objects', 'info', name);
			if ((await fs.lstat(path).catch(() => undefined))?.isFile()) {
				out.push({ path, kind: 'file' });
			}
		}
	}
	return out;
}

interface IConfirmContext {
	readonly envArgs: Buffer;
	readonly seccomp: Uint8Array;
	readonly home: string;
	readonly hostNamespaces: Readonly<Partial<Record<NamespaceName, number>>>;
	/** `new`: a namespace of its own; a number: the bridge holder's; `host`: unchanged. */
	readonly expectNet: 'new' | 'host' | number;
	readonly fault: SandboxFault | undefined;
	/** After the attestation, before the go byte: a second layer's own check (the run's scope); an error refuses. */
	readonly beforeGo?: (workloadPid: number) => Promise<string | undefined>;
}

type LinuxConfirmation =
	| { readonly ok: true; readonly status: IStatusInfo; readonly workloadPid: number; readonly evidence: Record<string, string | number | boolean>; readonly cred: string }
	| { readonly ok: false; readonly error: string };

/**
 * The parent's half of the launch protocol (F.5): feeds bubblewrap its environment and filter,
 * waits for bubblewrap's status line (only to find the sandbox's pid 1) and the prologue's ready
 * line, then attests the prologue's process from the host's `/proc` (see `attestFromProc`): the
 * workload cannot influence any of that. Only then is the go byte sent on fd 7.
 */
function confirmLaunch(child: ChildProcess, context: IConfirmContext): Promise<LinuxConfirmation> {
	return new Promise(resolve => {
		// Node types `stdio` as a five-tuple; the extra pipes are there at runtime.
		const stdio = child.stdio as readonly unknown[];
		const marker = stdio[BUBBLEWRAP_FDS.marker] as NodeJS.ReadableStream | null | undefined;
		const status = stdio[BUBBLEWRAP_FDS.status] as NodeJS.ReadableStream | null | undefined;
		const argsPipe = stdio[BUBBLEWRAP_FDS.args] as NodeJS.WritableStream | null | undefined;
		const seccompPipe = stdio[BUBBLEWRAP_FDS.seccomp] as NodeJS.WritableStream | null | undefined;
		const go = stdio[BUBBLEWRAP_FDS.go] as NodeJS.WritableStream | null | undefined;
		let done = false;
		let exited = false;
		let stderr = '';
		let markerText = '';
		let statusText = '';
		let info: IStatusInfo | undefined;
		let ready: { readonly pid: number; readonly cred: string } | undefined;
		let attesting = false;
		const finish = (result: LinuxConfirmation) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(result.ok ? result : { ok: false, error: redactSandboxText(result.error, context.home) });
			}
		};
		const timer = setTimeout(() => finish({ ok: false, error: 'bubblewrap did not confirm the sandbox in time' }), CONFIRM_TIMEOUT_MS);
		if (!marker || !status || !argsPipe || !seccompPipe || !go) {
			finish({ ok: false, error: 'bubblewrap was spawned without its control pipes' });
			return;
		}
		const check = () => {
			if (!info || !ready || attesting) {
				return;
			}
			attesting = true;
			const problem = namespaceProblem(info, context);
			if (problem) {
				finish({ ok: false, error: problem });
				return;
			}
			const statusInfo = info;
			const readyLine = ready;
			void attestFromProc(statusInfo, readyLine.pid, context).then(async attested => {
				if (done || exited) {
					return;
				}
				if (!attested.ok) {
					finish(attested);
					return;
				}
				if (context.fault === 'attest') {
					finish({ ok: false, error: 'the sandbox could not be attested (fault injection)' });
					return;
				}
				// The canary counts only now that we know who ran it.
				if (readyLine.cred !== 'denied') {
					finish({ ok: false, error: 'the canary could read the run\'s sentinel credential' });
					return;
				}
				const layerProblem = await context.beforeGo?.(attested.pid);
				if (done || exited) {
					return;
				}
				if (layerProblem) {
					finish({ ok: false, error: layerProblem });
					return;
				}
				if (context.fault === 'withhold-go') {
					await new Promise(r => setTimeout(r, WITHHELD_GO_MS));
					finish({ ok: false, error: 'the go byte was withheld (fault injection)' });
					return;
				}
				if (context.fault === 'wrong-go') {
					go.end(SANDBOX_WRONG_GO);
					finish({ ok: false, error: 'a wrong go byte was sent (fault injection)' });
					return;
				}
				// Attested: only now may the workload run.
				go.end(SANDBOX_GO);
				finish({ ok: true, status: statusInfo, workloadPid: attested.pid, evidence: attested.evidence, cred: readyLine.cred });
			});
		};
		child.stderr?.on('data', (data: Buffer | string) => { stderr = (stderr + data.toString()).slice(-4_000); });
		status.on('data', (data: Buffer | string) => {
			statusText += data.toString();
			const lines = statusText.split('\n');
			statusText = lines.pop() ?? '';
			for (const line of lines) {
				const parsed = parseStatusLine(line);
				if (parsed && !info) {
					info = parsed;
					check();
				}
			}
			// bubblewrap writes each JSON object followed by a newline; tolerate a final one without.
			if (!info && statusText.trim().endsWith('}')) {
				const parsed = parseStatusLine(statusText);
				if (parsed) {
					info = parsed;
					statusText = '';
					check();
				}
			}
		});
		marker.on('data', (data: Buffer | string) => {
			if (ready !== undefined) {
				return;
			}
			markerText += data.toString();
			ready = parseReadyLine(markerText);
			if (!ready && markerText.includes('\n')) {
				finish({ ok: false, error: `the sandbox's prologue sent no ready line (${markerText.trim().slice(0, 80)})` });
				return;
			}
			check();
		});
		for (const stream of [marker, status, argsPipe, seccompPipe, go]) {
			stream.on('error', () => undefined);
		}
		// The write-only pipes are sockets too: keep their read side flowing, or their end is never
		// seen and the child's 'close' (which waits for every stdio stream) never comes.
		for (const stream of [argsPipe, seccompPipe, go]) {
			(stream as unknown as NodeJS.ReadableStream).resume?.();
		}
		argsPipe.end(context.envArgs);
		seccompPipe.end(Buffer.from(context.seccomp));
		child.once('error', err => finish({ ok: false, error: `could not start bubblewrap: ${err.message}` }));
		child.once('exit', (code, signal) => {
			exited = true;
			setTimeout(() => finish({ ok: false, error: `bubblewrap exited before the workload started (${signal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ''}` }), 100);
		});
	});
}

const ATTEST_NAMESPACES = ['mnt', 'pid', 'ipc', 'uts', 'user', 'net', 'cgroup'] as const;

/**
 * External evidence from the host side (F.5, J.2): the process that wrote the ready line is a
 * child of the sandbox's pid 1 (bubblewrap's `child-pid`), its pid inside its namespace is the
 * one it reported, and the kernel says it runs with NoNewPrivs, in seccomp filter mode with at
 * least one filter, and in namespaces other than ours (the network one too unless `host`).
 */
async function attestFromProc(info: IStatusInfo, innerPid: number, context: IConfirmContext): Promise<{ ok: true; pid: number; evidence: Record<string, string | number | boolean> } | { ok: false; error: string }> {
	const pid = await sandboxChild(info.childPid, innerPid);
	if (pid === undefined) {
		return { ok: false, error: `no process ${innerPid} of the sandbox's pid namespace was found under its pid 1 (${info.childPid})` };
	}
	const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
	const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim();
	const evidence: Record<string, string | number | boolean> = { pid, innerPid };
	const noNewPrivs = Number(field('NoNewPrivs'));
	const seccompMode = Number(field('Seccomp'));
	const filtersText = field('Seccomp_filters');
	evidence.noNewPrivs = noNewPrivs;
	evidence.seccomp = seccompMode;
	if (filtersText !== undefined) {
		evidence.seccompFilters = Number(filtersText);
	}
	if (noNewPrivs !== 1 || seccompMode !== 2 || (filtersText !== undefined && !(Number(filtersText) >= 1))) {
		return { ok: false, error: `the sandbox process runs without its seccomp filter (NoNewPrivs ${field('NoNewPrivs') ?? '?'}, Seccomp ${field('Seccomp') ?? '?'}, filters ${filtersText ?? '?'})` };
	}
	for (const name of ATTEST_NAMESPACES) {
		const [theirs, ours] = await Promise.all([
			fs.stat(`/proc/${pid}/ns/${name}`).then(st => st.ino, () => undefined),
			fs.stat(`/proc/self/ns/${name}`).then(st => st.ino, () => undefined),
		]);
		if (theirs === undefined) {
			if (name === 'cgroup') {
				continue; // `--unshare-cgroup-try`: kernels without cgroup namespaces.
			}
			return { ok: false, error: `the sandbox process's ${name} namespace could not be read` };
		}
		evidence[`ns${name[0].toUpperCase()}${name.slice(1)}`] = theirs;
		const shared = theirs === ours;
		if (shared && !(name === 'net' && context.expectNet === 'host') && name !== 'cgroup') {
			return { ok: false, error: `the sandbox process shares Volt's ${name} namespace` };
		}
		if (name === 'net' && typeof context.expectNet === 'number' && theirs !== context.expectNet) {
			return { ok: false, error: 'the sandbox process is not in its network bridge\'s namespace' };
		}
	}
	return { ok: true, pid, evidence };
}

/**
 * The host pid of the sandbox process whose pid inside its namespace is `innerPid`, among the
 * children of the sandbox's pid 1. bubblewrap's own init stays pid 1 and runs the command as its
 * child; `NSpid` gives a process's pid in each nested namespace, the innermost last.
 */
async function sandboxChild(init: number, innerPid: number): Promise<number | undefined> {
	const listed = await fs.readFile(`/proc/${init}/task/${init}/children`, 'utf8').then(text => text.trim().split(/\s+/).filter(Boolean).map(Number), () => undefined);
	const candidates = listed ?? await childrenByScan(init);
	for (const pid of [init, ...candidates]) {
		const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
		const ppid = Number(/^PPid:\s*(\d+)$/m.exec(status)?.[1]);
		const nspid = /^NSpid:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
		if ((pid === init || ppid === init) && nspid.length > 1 && nspid[nspid.length - 1] === innerPid && nspid[0] === pid) {
			return pid;
		}
	}
	return undefined;
}

/** Without `CONFIG_PROC_CHILDREN`: every process whose parent is `pid`. */
async function childrenByScan(pid: number): Promise<number[]> {
	const out: number[] = [];
	for (const name of await fs.readdir('/proc').catch(() => [] as string[])) {
		if (/^\d+$/.test(name)) {
			const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8').catch(() => '');
			if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid) {
				out.push(Number(name));
			}
		}
	}
	return out;
}

function parseStatusLine(line: string): IStatusInfo | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const childPid = record['child-pid'];
	if (typeof childPid !== 'number' || !Number.isInteger(childPid) || childPid <= 1) {
		return undefined;
	}
	const namespaces: Partial<Record<NamespaceName, number>> = {};
	for (const name of NAMESPACES) {
		const ino = record[`${name}-namespace`];
		if (typeof ino === 'number') {
			namespaces[name] = ino;
		}
	}
	return { childPid, namespaces };
}

/** Why the reported namespaces are not the ones the policy needs, or undefined. */
function namespaceProblem(info: IStatusInfo, context: IConfirmContext): string | undefined {
	for (const name of ['mnt', 'pid', 'ipc', 'uts'] as const) {
		const ino = info.namespaces[name];
		if (ino === undefined || ino === context.hostNamespaces[name]) {
			return `bubblewrap did not create a ${name} namespace`;
		}
	}
	if (context.expectNet === 'new') {
		const ino = info.namespaces.net;
		if (ino === undefined || ino === context.hostNamespaces.net) {
			return 'bubblewrap did not create a network namespace';
		}
	}
	// Joined through nsenter: bubblewrap reports no network namespace of its own. nsenter fails
	// before bubblewrap runs if it cannot join, and the readiness line comes from inside.
	return undefined;
}

/**
 * Kills the sandbox: bubblewrap's monitor (our child, whose pid-1 inside the sandbox has
 * PDEATHSIG=SIGKILL) and that pid-1 directly when it is still the same process. When a pid
 * namespace's init dies the kernel kills every process in it, so daemons that double-forked or
 * called setsid go too. Resolves once the init is gone (or after a short wait).
 */
async function killSandbox(child: ChildProcess, status: IStatusInfo | undefined): Promise<void> {
	const kill = (pid: number) => {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Gone already.
		}
	};
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		kill(-child.pid);
		kill(child.pid);
	}
	if (!status) {
		return;
	}
	const pidNs = status.namespaces.pid;
	const isOurs = () => pidNs !== undefined && isLiveMember(status.childPid, 'pid', pidNs);
	if (await isOurs()) {
		kill(status.childPid);
	}
	const deadline = Date.now() + TERMINATE_WAIT_MS;
	while (Date.now() < deadline && await isOurs()) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

/**
 * Whether `pid` is still the process we started (its namespace is the one bubblewrap reported)
 * and not a zombie. bubblewrap's monitor exits without reaping the sandbox's pid-1, which stays a
 * zombie until the system's init reaps it; by then the kernel has killed every process of its
 * pid namespace, so a zombie counts as gone.
 */
async function isLiveMember(pid: number, namespace: NamespaceName, ino: number): Promise<boolean> {
	if ((await fs.stat(`/proc/${pid}/ns/${namespace}`).catch(() => undefined))?.ino !== ino) {
		return false;
	}
	const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
	const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
	return state !== '' && state !== 'Z' && state !== 'X';
}

let scopeCount = 0;
/** How often a run's scope is read for the kernel's OOM and pids events (a change to memory.events also wakes a watcher). */
const CGROUP_POLL_MS = 500;
const MB = 1024 * 1024;

/**
 * One run's systemd user scope (F.8, F.10). `systemd-run --scope` moves itself into the new scope
 * and then becomes the run's first process, so bubblewrap and everything below it are in it from
 * the start, under memory.max and pids.max. Before the go byte the backend checks from outside that
 * the attested workload is in that scope with those limits; then it makes an OOM kill take the
 * whole scope (memory.oom.group), reports the kernel's OOM kills as a resource violation and the
 * pids limit as a denial, and ends the scope with one write to cgroup.kill. systemd removes the
 * scope once it is empty.
 */
class CgroupScope {

	readonly env: Readonly<Record<string, string>>;
	readonly limits: { readonly memoryMB?: number; readonly processes?: number };
	/** The scope's path below the cgroup root, once attached. */
	path: string | undefined;
	private dir: string | undefined;
	private poll: ReturnType<typeof setInterval> | undefined;
	private watcher: FSWatcher | undefined;
	private memoryReported = false;
	private pidsReported = false;

	constructor(readonly facts: ICgroupFacts, readonly unit: string, limits: ISandboxLimits) {
		this.env = { XDG_RUNTIME_DIR: facts.runtimeDir };
		this.limits = {
			...(limits.memoryMB !== undefined ? { memoryMB: Math.max(1, Math.floor(limits.memoryMB)) } : {}),
			...(limits.processes !== undefined && (facts.forProcesses || limits.memoryMB !== undefined) ? { processes: Math.max(1, Math.floor(limits.processes)) } : {}),
		};
	}

	get memoryMB(): number | undefined {
		return this.limits.memoryMB;
	}

	/** Checks the attested workload is in this scope with its limits; an answer is why not. */
	async attach(pid: number): Promise<string | undefined> {
		const text = await fs.readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '');
		const path = /^0::(.*)$/m.exec(text)?.[1]?.trim();
		if (!path || !path.endsWith(`/${this.unit}.scope`)) {
			return `the sandbox is not in its own cgroup scope (${path || 'no cgroup v2 entry'})`;
		}
		const dir = `/sys/fs/cgroup${path}`;
		const read = (name: string) => fs.readFile(join(dir, name), 'utf8').then(value => value.trim(), () => 'missing');
		if (this.limits.memoryMB !== undefined) {
			const memory = await read('memory.max');
			if (memory !== String(this.limits.memoryMB * MB)) {
				return `the sandbox's cgroup scope has memory.max ${memory}, not ${this.limits.memoryMB} MB`;
			}
			// An OOM kill takes the whole tree, not its largest process (the backend also kills on the event).
			await fs.writeFile(join(dir, 'memory.oom.group'), '1').catch(() => undefined);
		}
		if (this.limits.processes !== undefined) {
			const pids = await read('pids.max');
			if (pids !== String(this.limits.processes)) {
				return `the sandbox's cgroup scope has pids.max ${pids}, not ${this.limits.processes}`;
			}
		}
		this.path = path;
		this.dir = dir;
		return undefined;
	}

	describe(): string {
		const limits = [
			...(this.limits.memoryMB !== undefined ? [`memory.max ${this.limits.memoryMB} MB (whole tree, OOM kills the scope)`] : []),
			...(this.limits.processes !== undefined ? [`pids.max ${this.limits.processes}`] : []),
		];
		return `systemd user scope ${this.path}: ${limits.join(', ')}${this.facts.kill ? '; cgroup.kill ends it' : ''}`;
	}

	watch(options: Pick<ISandboxLaunchOptions, 'onDenial' | 'onResourceViolation'>): void {
		if (!this.dir || this.poll) {
			return;
		}
		this.poll = setInterval(() => void this.check(options), CGROUP_POLL_MS);
		try {
			this.watcher = watch(join(this.dir, 'memory.events'), () => void this.check(options));
			this.watcher.on('error', () => undefined);
		} catch {
			// The poll still sees it.
		}
	}

	/** Reads the scope's events; answers whether memory.events could be read (the scope still exists). */
	private async check(options: Pick<ISandboxLaunchOptions, 'onDenial' | 'onResourceViolation'>): Promise<boolean> {
		const dir = this.dir;
		if (!dir) {
			return false;
		}
		const count = (text: string, name: string) => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
		let memoryRead = false;
		if (this.limits.memoryMB !== undefined && !this.memoryReported) {
			const events = await fs.readFile(join(dir, 'memory.events'), 'utf8').catch(() => undefined);
			memoryRead = events !== undefined;
			if (events !== undefined && !this.memoryReported && (count(events, 'oom_kill') > 0 || count(events, 'oom_group_kill') > 0)) {
				this.memoryReported = true;
				const peak = await fs.readFile(join(dir, 'memory.peak'), 'utf8').then(value => Math.round(Number(value.trim()) / MB), () => 0);
				options.onResourceViolation?.({ dimension: 'limits.memory', limit: this.limits.memoryMB, observed: peak > 0 ? peak : this.limits.memoryMB, by: 'cgroup' });
				await this.kill();
			}
		}
		if (this.limits.processes !== undefined && !this.pidsReported) {
			const events = await fs.readFile(join(dir, 'pids.events'), 'utf8').catch(() => '');
			if (!this.pidsReported && count(events, 'max') > 0) {
				this.pidsReported = true;
				options.onDenial({ kind: 'limit', target: `processes ${this.limits.processes}`, source: 'os' });
			}
		}
		return memoryRead;
	}

	/** Every process of the scope, at once (Linux 5.14+); older kernels rely on the pid namespace. */
	async kill(): Promise<void> {
		if (this.dir && this.facts.kill) {
			await fs.writeFile(join(this.dir, 'cgroup.kill'), '1').catch(() => undefined);
		}
	}

	/**
	 * The last accounting, then no more watching. An OOM kill usually ends the run, and systemd
	 * removes the scope, before memory.events can be read: the user manager keeps the scope loaded
	 * as failed (`Result=oom-kill`, see systemdRunArgs) until it is read and cleared here.
	 */
	async stop(options: Pick<ISandboxLaunchOptions, 'onDenial' | 'onResourceViolation'>): Promise<void> {
		if (this.poll) {
			clearInterval(this.poll);
			this.poll = undefined;
		}
		this.watcher?.close();
		this.watcher = undefined;
		const memoryRead = await this.check(options);
		this.dir = undefined;
		// The run is over: counters read now are final. No OOM in them, nothing to ask (a scope that
		// ends well unloads itself); otherwise the user manager has the answer and a failed unit to clear.
		if (this.limits.memoryMB === undefined || (memoryRead && !this.memoryReported)) {
			return;
		}
		const ended = await this.ended();
		if (ended?.result === 'oom-kill' && this.limits.memoryMB !== undefined && !this.memoryReported) {
			this.memoryReported = true;
			options.onResourceViolation?.({ dimension: 'limits.memory', limit: this.limits.memoryMB, observed: this.limits.memoryMB, by: 'cgroup' });
		}
		if (ended?.state === 'failed') {
			await execFileAsync(this.facts.systemctl, ['--user', 'reset-failed', `${this.unit}.scope`], { timeout: 5_000, env: { ...this.env } }).catch(() => undefined);
		}
	}

	/** How the user manager says the scope ended, once it has (a scope still stopping is waited for, up to a second). */
	private async ended(): Promise<{ readonly state: string; readonly result: string } | undefined> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const text = await execFileAsync(this.facts.systemctl, ['--user', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Result', `${this.unit}.scope`], { timeout: 5_000, env: { ...this.env } })
				.then(r => r.stdout, () => undefined);
			if (text === undefined) {
				return undefined;
			}
			const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
			const state = field('ActiveState');
			if (field('LoadState') === 'not-found' || state === 'inactive' || state === 'failed') {
				return { state, result: field('Result') };
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return undefined;
	}
}

/**
 * The network bridge for one run: unix sockets in the control folder that forward to the host's
 * loopback ports, and the holder bubblewrap whose socats listen on its own loopback.
 */
class BubblewrapBridge {

	private stopped = false;

	private constructor(
		private readonly servers: readonly net.Server[],
		private readonly sockets: Set<net.Socket>,
		private readonly holder: ChildProcess,
		readonly holderPid: number,
		readonly netNamespace: number,
	) { }

	static async start(state: IBubblewrapState, controlDir: string, ports: readonly number[], home: string): Promise<BubblewrapBridge> {
		if (!state.socat || !state.nsenter) {
			throw new SandboxUnavailableError('The network bridge needs socat and nsenter', 'unavailable', ['network.proxy']);
		}
		const sockets = new Set<net.Socket>();
		const servers: net.Server[] = [];
		const closeAll = () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			for (const server of servers) {
				server.close();
			}
		};
		try {
			for (const port of ports) {
				const path = join(controlDir, `${port}.sock`);
				if (path.length > 100) {
					throw new SandboxUnavailableError(`The run folder's path is too long for a unix socket: ${path}`, 'unavailable', ['network.proxy']);
				}
				const server = net.createServer(downstream => {
					const upstream = net.connect({ host: '127.0.0.1', port });
					for (const socket of [downstream, upstream]) {
						sockets.add(socket);
						socket.on('close', () => sockets.delete(socket));
					}
					downstream.on('error', () => upstream.destroy());
					upstream.on('error', () => downstream.destroy());
					downstream.pipe(upstream);
					upstream.pipe(downstream);
				});
				servers.push(server);
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen(path, () => resolve());
				});
			}
		} catch (err) {
			closeAll();
			throw err;
		}
		const holder = spawn(state.bwrap, bridgeHolderArgs(state.socat, controlDir, ports, state.shell), { env: {}, cwd: '/', stdio: ['ignore', 'ignore', 'pipe', 'pipe'], detached: true });
		const ready = await new Promise<{ pid: number; net: number } | string>(resolve => {
			let stderr = '';
			let statusText = '';
			let pid: number | undefined;
			let netNs: number | undefined;
			const listening = new Set<number>();
			const timer = setTimeout(() => resolve(`the bridge did not start in time${stderr ? `: ${stderr.trim()}` : ''}`), BRIDGE_TIMEOUT_MS);
			const check = () => {
				if (pid !== undefined && netNs !== undefined && listening.size === ports.length) {
					clearTimeout(timer);
					resolve({ pid, net: netNs });
				}
			};
			holder.stderr?.on('data', (data: Buffer | string) => {
				const text = data.toString();
				// socat keeps logging connections at -d -d; only the start matters, but the pipe must keep draining.
				if (listening.size < ports.length) {
					stderr = (stderr + text).slice(-4_000);
					for (const match of stderr.matchAll(/listening on AF=2 127\.0\.0\.1:(\d+)/g)) {
						listening.add(Number(match[1]));
					}
					check();
				}
			});
			(holder.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (data: Buffer | string) => {
				statusText += data.toString();
				const match = /"child-pid":\s*(\d+)[^}]*"net-namespace":\s*(\d+)/.exec(statusText);
				if (match && pid === undefined) {
					pid = Number(match[1]);
					netNs = Number(match[2]);
					check();
				}
			});
			holder.once('error', err => { clearTimeout(timer); resolve(`could not start the bridge: ${err.message}`); });
			holder.once('exit', code => { clearTimeout(timer); resolve(`the bridge exited (${code})${stderr ? `: ${stderr.trim()}` : ''}`); });
		});
		const bridge = typeof ready === 'string' ? undefined : new BubblewrapBridge(servers, sockets, holder, ready.pid, ready.net);
		// The holder must still be the process we started: its network namespace is the one it reported.
		const verified = bridge && (await fs.stat(`/proc/${bridge.holderPid}/ns/net`).catch(() => undefined))?.ino === bridge.netNamespace;
		if (!bridge || !verified) {
			closeAll();
			try {
				process.kill(-holder.pid!, 'SIGKILL');
			} catch {
				// Gone already.
			}
			const why = typeof ready === 'string' ? ready : 'the bridge holder could not be verified';
			throw new SandboxUnavailableError(`The network bridge failed: ${redactSandboxText(why, home)}`, 'failed', ['network.proxy']);
		}
		return bridge;
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		for (const socket of this.sockets) {
			socket.destroy();
		}
		for (const server of this.servers) {
			server.close();
		}
		const kill = (target: number) => {
			try {
				process.kill(target, 'SIGKILL');
			} catch {
				// Gone already.
			}
		};
		// The holder's init dies with its monitor (PDEATHSIG), but kill it directly while it is
		// provably still the same process.
		if (await isLiveMember(this.holderPid, 'net', this.netNamespace)) {
			kill(this.holderPid);
		}
		const pid = this.holder.pid;
		if (pid && this.holder.exitCode === null && this.holder.signalCode === null) {
			const exited = new Promise<void>(resolve => this.holder.once('exit', () => resolve()));
			kill(-pid);
			kill(pid);
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, TERMINATE_WAIT_MS))]);
		}
	}
}
