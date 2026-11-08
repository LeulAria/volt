/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { constants as fsConstants, Dirent, promises as fs } from 'fs';
import * as net from 'net';
import { release, tmpdir } from 'os';
import { promisify } from 'util';
import { dirname, join } from '../../../base/common/path.js';
import { bridgeHolderArgs, BUBBLEWRAP_FDS, bubblewrapArgs, bubblewrapEnvArgs, bubblewrapRefusals, encodeBubblewrapArgs, hasRlimits, IBubblewrapPathMatch, IBubblewrapPatternMatches, isInsidePath, nsenterArgs, PrlimitResource } from '../common/bwrap.js';
import { allEnforcement, ISandboxBackendCapabilities, redactSandboxText, SandboxEnforcement, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { gitDirWritable } from '../common/sandboxProfiles.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { SandboxDimension } from '../common/sandboxSchema.js';
import { buildSeccompFilter, SeccompArch, seccompArch, seccompInstructions } from '../common/seccomp.js';
import { ISandboxBackend, ISandboxLaunchOptions, ISandboxLaunchSpec, SandboxConfirmation } from './sandboxBackends.js';
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

/** The bounded walk that expands `**\/` patterns into existing paths. */
export const PATTERN_WALK_LIMITS = { maxEntries: 20_000, maxDepth: 8, budgetMs: 500 } as const;
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
	readonly rootLinks: readonly { readonly path: string; readonly target: string }[];
	/** Top-level folders that are real folders (non-merged /usr), bound in trials. */
	readonly rootDirs: readonly string[];
	readonly hostNamespaces: Readonly<Partial<Record<NamespaceName, number>>>;
}

interface IStatusInfo {
	readonly childPid: number;
	readonly namespaces: Readonly<Partial<Record<NamespaceName, number>>>;
}

export class BubblewrapBackend implements ISandboxBackend {

	readonly id = 'bubblewrap' as const;
	private state: Promise<IBubblewrapState | ISandboxBackendCapabilities> | undefined;

	/** Cached: the trials cost a few sandboxes' startup. */
	async probe(): Promise<ISandboxBackendCapabilities> {
		const state = await this.getState();
		return 'capabilities' in state ? state.capabilities : state;
	}

	private getState(): Promise<IBubblewrapState | ISandboxBackendCapabilities> {
		this.state ??= this.doProbe().catch(err => unavailable([], [`The bubblewrap probe failed: ${(err as Error).message}`]));
		return this.state;
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
		const bwrap = await findExecutable('bwrap');
		if (!bwrap) {
			diagnostics.push('bubblewrap is not installed. Install it: `sudo apt install bubblewrap` (Debian, Ubuntu), `sudo dnf install bubblewrap` (Fedora), `sudo pacman -S bubblewrap` (Arch).');
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
		const base: IBubblewrapState = {
			capabilities: unavailable(details, diagnostics),
			bwrap, version, arch, shell, prlimit, socat, nsenter, bridge: false, disableUserns, rootLinks, rootDirs, hostNamespaces,
		};

		// A real trial: the same arguments, filter and confirmation as a run.
		const started = Date.now();
		const core = await this.trial(base, {});
		if (!core.ok) {
			diagnostics.push(...await userNamespaceDiagnostics(core.error));
			return unavailable(details, diagnostics);
		}
		details.push(`user namespaces: ok (trial sandbox in ${Date.now() - started} ms)`);
		details.push(`seccomp: ${arch} filter, ${seccompInstructions(arch, { blockUnixSockets: true }).length} instructions; --disable-userns: ${disableUserns ? 'yes' : 'no (bubblewrap < 0.8; seccomp still refuses new namespaces)'}`);

		const [bridgeTrial, limitsTrial] = await Promise.all([
			socat && nsenter ? this.trial(base, { bridgePort: 41_000 + Math.floor(Math.random() * 1000) }) : Promise.resolve(undefined),
			prlimit ? this.trial(base, { limits: true }) : Promise.resolve(undefined),
		]);
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
		set('filesystem.protectNew', 'partial', `bubblewrap can only mount over paths that exist at launch: deny/protect entries that do not exist yet, pattern matches created during the run or beyond a bounded walk (${PATTERN_WALK_LIMITS.maxEntries} entries, depth ${PATTERN_WALK_LIMITS.maxDepth}, ${PATTERN_WALK_LIMITS.budgetMs} ms), and new .git folders are not covered.`);
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
		return {
			...base,
			prlimit: limits ? prlimit : undefined,
			bridge,
			capabilities: { backend: 'bubblewrap', available: true, enforcement, notes, details, diagnostics },
		};
	}

	/** Starts a trial sandbox through the launch path and waits for it to exit cleanly. */
	private async trial(state: IBubblewrapState, options: { bridgePort?: number; limits?: boolean }): Promise<SandboxConfirmation> {
		const runDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'volt-sbx-probe-'));
		const tmp = join(runDir, 'tmp');
		let spec: ISandboxLaunchSpec | undefined;
		try {
			await fs.mkdir(tmp, { mode: 0o700 });
			const read = ['/usr', ...state.rootDirs];
			const policy: IResolvedSandboxPolicy = {
				name: 'probe', platform: 'linux', readAll: false, read, write: [tmp], writeFiles: [], deny: [], protect: [],
				denyPatterns: [], protectPatterns: [], newRepositoryGuard: [], gitDirs: [],
				network: { mode: 'none', allow: [], loopbackPorts: options.bridgePort ? [options.bridgePort] : [], listen: false },
				unixSockets: [], systemServices: false,
				limits: options.limits ? { processes: 64, openFiles: 256, cpuSeconds: 10, fileSizeMB: 1, memoryMB: 1024 } : {},
				env: { PATH: '/usr/bin:/bin' }, cwd: tmp, tmp, home: tmp,
			};
			const withTools: IBubblewrapState = { ...state, bridge: !!options.bridgePort, prlimit: options.limits ? state.prlimit : undefined };
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
		await fs.mkdir(controlDir, { recursive: true, mode: 0o700 });

		const [kinds, masks, reexpose, walked, hard] = await Promise.all([
			pathKinds([...policy.deny, ...policy.protect, ...policy.writeFiles, ...policy.unixSockets]),
			maskFolders(controlDir),
			reexposedFiles(),
			walkPatterns(policy, { collectSockets: policy.unixSockets.length > 0 }),
			state.prlimit && hasRlimits(policy.limits) ? hardLimits() : Promise.resolve({}),
		]);
		const matches: IPatternWalkResult = { ...walked, protect: [...walked.protect, ...await gitAllowListProtections(policy, walked.protect)] };
		const bwrapArgs = bubblewrapArgs(policy, command, commandArgs, {
			terminal: options.terminal,
			disableUserns: state.disableUserns,
			bridged: ports.length > 0,
			host: { kinds, rootLinks: state.rootLinks, masks, reexpose },
			matches,
			shell: state.shell,
			prlimit: state.prlimit ? { path: state.prlimit, hard } : undefined,
		});
		const blockUnixSockets = policy.unixSockets.length === 0;
		// The host's network namespace: no listening unless granted (B-30). Granted ports cannot be
		// told apart by seccomp, so a grant there allows every port (the agent profile marks it best effort).
		const blockListen = policy.network.mode === 'host' && !policy.network.listen && !policy.network.listenPorts?.length;
		const seccomp = buildSeccompFilter(state.arch, { blockUnixSockets, blockListen });
		const envArgs = Buffer.from(encodeBubblewrapArgs(bubblewrapEnvArgs(policy.env)), 'utf8');

		let bridge: BubblewrapBridge | undefined;
		if (ports.length) {
			bridge = await BubblewrapBridge.start(state, controlDir, ports, policy.home);
		}
		const limitsText = state.prlimit && hasRlimits(policy.limits) ? 'limits via prlimit' : 'no rlimits';
		const patternText = policy.denyPatterns.length || policy.protectPatterns.length
			? `patterns: ${matches.deny.length + matches.protect.length} existing paths${matches.complete ? '' : ' (walk stopped at its budget)'}`
			: '';
		let status: IStatusInfo | undefined;
		let disposed = false;
		return {
			command: bridge ? state.nsenter! : state.bwrap,
			args: bridge ? nsenterArgs(bridge.holderPid, state.bwrap, bwrapArgs) : bwrapArgs,
			// Deliberately empty: see the class comment (the workload's environment goes through `--args`).
			env: {},
			cwd: '/',
			extraStdio: ['pipe', 'pipe', 'pipe', 'pipe'],
			// BUBBLEWRAP_FDS: the readiness line and the status are read; the arguments and the filter are written.
			extraStdioDirections: ['out', 'out', 'in', 'in'],
			confirm: async child => {
				const result = await confirmLaunch(child, {
					envArgs, seccomp, home: policy.home, hostNamespaces: state.hostNamespaces,
					expectNet: policy.network.mode === 'host' ? 'host' : bridge ? bridge.netNamespace : 'new',
				});
				if (!result.ok) {
					return result;
				}
				status = result.status;
				const parts = [
					`bubblewrap ${state.version.join('.')}`,
					`namespaces ${Object.keys(result.status.namespaces).join(', ')}, user`,
					`network ${policy.network.mode}${bridge ? ` (bridged ports ${ports.join(', ')})` : ''}`,
					`seccomp${blockUnixSockets ? ' (unix sockets refused)' : ''}, NoNewPrivs`,
					limitsText,
					...(patternText ? [patternText] : []),
					`pid ${result.status.childPid}`,
				];
				return { ok: true, detail: parts.join('; ') };
			},
			terminate: async child => {
				await killSandbox(child, status);
				await bridge?.stop();
			},
			dispose: async () => {
				if (disposed) {
					return;
				}
				disposed = true;
				await bridge?.stop();
				await fs.rm(controlDir, { recursive: true, force: true }).catch(() => undefined);
			},
		};
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
}

/**
 * Expands `denyPatterns`/`protectPatterns` into the existing paths they match, by a breadth-first
 * walk of their roots bounded by `PATTERN_WALK_LIMITS` (shallow matches first, so a root's own
 * `.env` is always found). A root of `/` (readAll denies) is walked as the working directory, the
 * writable roots and the home folder: walking the whole disk would only spend the budget on
 * system folders. Symlinks are not followed. Also collects socket files when asked.
 */
export async function walkPatterns(policy: IResolvedSandboxPolicy, options: { collectSockets: boolean }, limits: typeof PATTERN_WALK_LIMITS = PATTERN_WALK_LIMITS): Promise<IPatternWalkResult> {
	type Kind = 'deny' | 'protect';
	const patterns: { kind: Kind; pattern: IResolvedPattern }[] = [];
	const expandRoot = (pattern: IResolvedPattern): IResolvedPattern[] => pattern.root === '/'
		? [...new Set([policy.cwd, ...policy.write, policy.home])].map(root => ({ root, names: pattern.names }))
		: [pattern];
	for (const pattern of policy.denyPatterns) {
		patterns.push(...expandRoot(pattern).map(p => ({ kind: 'deny' as const, pattern: p })));
	}
	for (const pattern of policy.protectPatterns) {
		patterns.push(...expandRoot(pattern).map(p => ({ kind: 'protect' as const, pattern: p })));
	}
	const roots = [...new Set([...patterns.map(p => p.pattern.root), ...(options.collectSockets ? policy.write : [])])].sort((a, b) => a.length - b.length);
	const deny = new Map<string, IBubblewrapPathMatch>();
	const protect = new Map<string, IBubblewrapPathMatch>();
	const sockets = new Set<string>();
	const visitedDirs = new Set<string>();
	const started = Date.now();
	let entries = 0;
	let complete = true;
	const queue: { dir: string; depth: number; root: boolean }[] = roots.map(dir => ({ dir, depth: 0, root: true }));
	while (queue.length) {
		if (entries >= limits.maxEntries || Date.now() - started > limits.budgetMs) {
			complete = false;
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
			if (!entry.isDirectory() || depth + 1 > limits.maxDepth || WALK_SKIP.has(entry.name) || deny.has(path)) {
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
	return { deny: [...deny.values()], protect: [...protect.values()], sockets: [...sockets], complete, visited: visitedDirs.size };
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
}

/**
 * Feeds bubblewrap its environment and filter, then waits for both pieces of evidence: the status
 * line with the sandbox's namespaces (written by bubblewrap's monitor), and the readiness line
 * the prologue writes from inside the finished sandbox (`NoNewPrivs:1 Seccomp:2`).
 */
function confirmLaunch(child: ChildProcess, context: IConfirmContext): Promise<{ ok: true; status: IStatusInfo } | { ok: false; error: string }> {
	return new Promise(resolve => {
		// Node types `stdio` as a five-tuple; the extra pipes are there at runtime.
		const stdio = child.stdio as readonly unknown[];
		const marker = stdio[BUBBLEWRAP_FDS.marker] as NodeJS.ReadableStream | null | undefined;
		const status = stdio[BUBBLEWRAP_FDS.status] as NodeJS.ReadableStream | null | undefined;
		const argsPipe = stdio[BUBBLEWRAP_FDS.args] as NodeJS.WritableStream | null | undefined;
		const seccompPipe = stdio[BUBBLEWRAP_FDS.seccomp] as NodeJS.WritableStream | null | undefined;
		let done = false;
		let stderr = '';
		let markerText = '';
		let statusText = '';
		let info: IStatusInfo | undefined;
		let ready: string | undefined;
		const finish = (result: { ok: true; status: IStatusInfo } | { ok: false; error: string }) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(result.ok ? result : { ok: false, error: redactSandboxText(result.error, context.home) });
			}
		};
		const timer = setTimeout(() => finish({ ok: false, error: 'bubblewrap did not confirm the sandbox in time' }), CONFIRM_TIMEOUT_MS);
		if (!marker || !status || !argsPipe || !seccompPipe) {
			finish({ ok: false, error: 'bubblewrap was spawned without its control pipes' });
			return;
		}
		const check = () => {
			if (!info || ready === undefined) {
				return;
			}
			if (!/(?:^|\s)NoNewPrivs:1(?:\s|$)/.test(ready) || !/(?:^|\s)Seccomp:2(?:\s|$)/.test(ready)) {
				finish({ ok: false, error: `the sandbox started without its seccomp filter (${ready.trim() || 'no report'})` });
				return;
			}
			const problem = namespaceProblem(info, context);
			finish(problem ? { ok: false, error: problem } : { ok: true, status: info });
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
			const newline = markerText.indexOf('\n');
			if (newline >= 0) {
				ready = markerText.slice(0, newline);
				check();
			}
		});
		for (const stream of [marker, status, argsPipe, seccompPipe]) {
			stream.on('error', () => undefined);
		}
		// The write-only pipes are sockets too: keep their read side flowing, or their end is never
		// seen and the child's 'close' (which waits for every stdio stream) never comes.
		(argsPipe as unknown as NodeJS.ReadableStream).resume?.();
		(seccompPipe as unknown as NodeJS.ReadableStream).resume?.();
		argsPipe.end(context.envArgs);
		seccompPipe.end(Buffer.from(context.seccomp));
		child.once('error', err => finish({ ok: false, error: `could not start bubblewrap: ${err.message}` }));
		child.once('exit', (code, signal) => setTimeout(() => finish({ ok: false, error: `bubblewrap exited before the workload started (${signal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ''}` }), 100));
	});
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
