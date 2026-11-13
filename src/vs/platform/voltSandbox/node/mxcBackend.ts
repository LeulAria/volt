/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, release, version as osVersion } from 'os';
import { promisify } from 'util';
import { dirname, isAbsolute, join } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { verifyHelperBinary } from '../../voltHelpers/node/helperIntegrity.js';
import {
	buildMxcRequest, checkMxcEvidence, checkMxcProbe, checkWindowsFloor, classifyWindowsImage, IMxcProbe, IMxcStatus, isWindowsPathInside, MXC_HELPER_DIGESTS, MXC_HELPER_ID,
	MXC_SDK_VERSION, MxcArch, mxcControlText, MxcPolicyError, normalizeWindowsPath, parseMxcAttestation, parseMxcStatus, parseWindowsVersion, PE_DYNAMIC_BASE, readPeInfo,
	WXC_EXEC_DIGESTS, WXC_EXEC_HELPER_ID, windowsCommandLine, windowsPathKey, workloadEnv,
} from '../common/mxc.js';
import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { SandboxDimension } from '../common/sandboxSchema.js';
import { gitAllowListProtections, walkPatterns } from './bubblewrapBackend.js';
import { ISandboxBackend, ISandboxLaunchOptions, ISandboxLaunchSpec, SandboxConfirmation, SandboxFault } from './sandboxBackends.js';

const execFileAsync = promisify(execFile);

/**
 * Windows 11: MXC ProcessContainer (BaseContainer through the OS's PSEC API) via Microsoft's
 * signed `wxc-exec.exe`, ported from VS Code's last MXC launcher (microsoft/vscode#317669, removed
 * in #340446) without its UI and without the Node SDK, which needs Node 24.
 *
 * One run:
 *   1. The binaries are checked against pinned digests and run from a Volt-owned copy.
 *   2. The policy becomes a `version: "1.0.0"` request (common/mxc.ts); its process is Volt's
 *      prologue, never the workload.
 *   3. The prologue starts inside the container, runs the canary, writes `ready` and waits.
 *   4. Volt attests the prologue from OUTSIDE (`volt-mxc-helper attest`: AppContainer token, Low
 *      integrity, job membership, image, parent = this run's wxc-exec) and checks the canary
 *      (the run's sentinel, which the manager's policy denies). That evidence is the run's
 *      attestation (F.12).
 *   5. Only then does it write the go file (the launch protocol's go byte, F.5: `go <nonce>`;
 *      anything else and the prologue exits); the prologue starts the workload with exactly the
 *      standard handles and polls the job's CPU, memory and process count.
 * Killing wxc-exec closes MXC's job (KILL_ON_JOB_CLOSE), which ends the whole tree.
 */

export interface IMxcBackendOptions {
	/** Folder holding `<arch>\wxc-exec.exe` and `<arch>\volt-mxc-helper.exe`. Default: VOLT_MXC_DIR, then the app's resources. */
	readonly binaryDir?: string;
	/** Where verified copies of the binaries are kept: a folder only Volt writes. Default `~/.volt/sandbox/bin`. */
	readonly copyDir?: string;
	/** A host loopback port no sandbox may reach (the canary connects to it). */
	readonly canaryPort?: number;
	/** Run the surrogate-spawn trials (schtasks, WSL) in the probe. Default true. */
	readonly surrogateTrials?: boolean;
	/** Folder of a Volt-prepared AppContainer-compatible MSYS2 runtime copy (see `isApprovedMsysRuntime`). */
	readonly msysRuntimeRoot?: string;
}

interface IMxcState {
	readonly capabilities: ISandboxBackendCapabilities;
	readonly wxcExec: string;
	readonly helper: string;
	readonly arch: MxcArch;
	readonly systemRoot: string;
	/** For the attestation: the Windows build and the wxc-exec release, as the probe reported them. */
	readonly version: string;
}

const CONFIRM_TIMEOUT_MS = 120_000;
const ATTEST_TIMEOUT_MS = 10_000;
/** `fault: withhold-go`: how long the backend waits, without writing the go file, before refusing. */
const WITHHELD_GO_MS = 750;
const LIMIT_POLL_MS = 1_000;

/**
 * SHA-256 digests of AppContainer-compatible MSYS2 runtimes (`msys-2.0.dll`) that CI runs Git
 * Bash with under MXC through this backend (WIN-MSYS-2, windows-11-arm, x64 Git under emulation).
 *
 * f8f7af36...: xoviat/cygwin release v0.4.0, branch `mxc` (microsoft/mxc#1061): the MSYS2 runtime
 * with an ALL APPLICATION PACKAGES ACE on its named objects, its shared directories in the
 * container's own namespace, and AppContainer-safe pipes. Not upstream; LGPL-3.0+ (Cygwin), so
 * shipping it means shipping its source too.
 *
 * A digest here only accepts images under `msysRuntimeRoot`, a prepared copy (this runtime, every
 * image opted into ASLR). Volt does not prepare one or set the option yet (D-15 stays "refuse" for
 * users until the owner decides to distribute the runtime), so Git Bash is still refused in
 * sandboxed chats.
 */
export const APPROVED_MSYS_RUNTIMES: readonly string[] = ['f8f7af36410ccc7c724cf48570c489de60e51ec687488e25e85d79285a0b57df'];

export class MxcBackend implements ISandboxBackend {

	readonly id = 'mxc' as const;
	private state: Promise<IMxcState | ISandboxBackendCapabilities> | undefined;

	constructor(private readonly options: IMxcBackendOptions = {}) { }

	async probe(): Promise<ISandboxBackendCapabilities> {
		const state = await this.getState();
		return 'capabilities' in state ? state.capabilities : state;
	}

	private getState(): Promise<IMxcState | ISandboxBackendCapabilities> {
		this.state ??= this.doProbe().catch(err => unavailable([], [`The Windows sandbox probe failed: ${(err as Error).message}`]));
		return this.state;
	}

	private async doProbe(): Promise<IMxcState | ISandboxBackendCapabilities> {
		if (process.platform !== 'win32') {
			return unavailable([], [`MXC runs on Windows only (this is ${process.platform}).`]);
		}
		const arch: MxcArch | undefined = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
		if (!arch) {
			return unavailable([], [`The Windows sandbox supports x64 and arm64, not ${process.arch}.`]);
		}
		const details: string[] = [];
		const os = await windowsVersion();
		const support = checkWindowsFloor(os.version, os.installationType);
		if (!support.ok) {
			return unavailable(details, [support.reason, ...(!os.version && os.error ? [os.error] : [])]);
		}
		details.push(`Windows 11 ${support.release} (${os.version?.build}.${os.version?.ubr})${support.note ? `; ${support.note}` : ''}`);
		const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';

		const binaries = await this.verifiedBinaries(arch);
		if ('error' in binaries) {
			return unavailable(details, [binaries.error]);
		}
		details.push(`MXC ${MXC_SDK_VERSION} wxc-exec (${arch})`);

		const probeText = await execFileAsync(binaries.wxcExec, ['--probe'], { timeout: 10_000, env: launcherEnv(systemRoot), windowsHide: true }).then(r => r.stdout, () => '');
		let probe: IMxcProbe | undefined;
		try {
			probe = JSON.parse(probeText);
		} catch {
			probe = undefined;
		}
		const probed = checkMxcProbe(probe);
		if (!probed.ok) {
			return unavailable(details, [probed.reason]);
		}
		if (!probed.enumerate) {
			return unavailable(details, ['This Windows build cannot grant folder listing without reads (PSEC fs_enumerate), which tools need to find their files.']);
		}

		const enforcement = allEnforcement('enforced');
		const notes: ISandboxBackendCapabilities['notes'] = {
			'filesystem.read': 'Only listed folders are readable, plus what Windows grants every app container (ALL APPLICATION PACKAGES, mostly system folders; microsoft/mxc#1533). Folders above each grant can be listed, not read.',
			'filesystem.protectNew': 'Protected paths are fixed at launch: a protected file or a pattern match created during the run is not guarded.',
			'network.proxy': 'Connections reach only Volt\'s proxy; DNS lookups still go through the Windows DNS Client, a side channel (microsoft/mxc#1666).',
			'network.loopbackPorts': 'MXC opens either every host loopback port or none (microsoft/mxc#1665), so single ports are refused.',
			'network.listen': 'A sandboxed process can bind a port, but neither the host nor the network can connect to it.',
			'host.unixSockets': 'No socket grants: AF_UNIX sockets are files, covered by the filesystem policy.',
			'syscalls': 'Win32k stays reachable: Node and most tools cannot start without it (ui.disable is false).',
			'limits.cpu': 'MXC has no limit fields: the job\'s CPU time is polled once a second and the tree killed over the limit.',
			'limits.memory': 'Polled once a second from the job\'s peak commit; the tree is killed over the limit.',
			'limits.processes': 'Polled once a second; "no new processes" cannot be enforced on Windows.',
			'limits.fileSize': 'Windows has no per-file size limit for a process.',
			'limits.openFiles': 'Windows has no per-process handle limit Volt can set under MXC.',
		};
		enforcement['filesystem.protectNew'] = 'partial';
		enforcement['network.loopbackPorts'] = 'unsupported';
		enforcement['syscalls'] = 'partial';
		enforcement['limits.cpu'] = 'partial';
		enforcement['limits.memory'] = 'partial';
		enforcement['limits.processes'] = 'partial';
		enforcement['limits.fileSize'] = 'unsupported';
		enforcement['limits.openFiles'] = 'unsupported';
		const capabilities: ISandboxBackendCapabilities = {
			backend: 'mxc', available: true, enforcement, notes, details, diagnostics: [],
			optional: ['filesystem.protectNew', 'limits.cpu', 'limits.memory', 'limits.processes', 'limits.fileSize', 'limits.openFiles'],
		};
		const state: IMxcState = { capabilities, wxcExec: binaries.wxcExec, helper: binaries.helper, arch, systemRoot, version: details.join(', ') };

		// A real trial: a deny-by-default container must start, attest, and keep a write outside
		// its policy (and any surrogate spawn) from landing.
		const trial = await this.trial(state).catch(err => (err as Error).message);
		if (trial) {
			return unavailable(details, [`A trial sandbox failed: ${trial}`]);
		}
		details.push('trial: attested AppContainer, write outside refused');
		return state;
	}

	/** Pinned digests, checked on a copy in a Volt-owned folder that is then run. */
	private async verifiedBinaries(arch: MxcArch): Promise<{ wxcExec: string; helper: string } | { error: string }> {
		const source = this.options.binaryDir ?? process.env.VOLT_MXC_DIR ?? defaultMxcDir();
		if (!source) {
			return { error: 'The Windows sandbox binaries are not part of this build.' };
		}
		const copies = this.options.copyDir ?? join(homedir(), '.volt', 'sandbox', 'bin');
		const out: Record<string, string> = {};
		for (const [helperId, name, digest] of [[WXC_EXEC_HELPER_ID, 'wxc-exec.exe', WXC_EXEC_DIGESTS[arch]], [MXC_HELPER_ID, 'volt-mxc-helper.exe', MXC_HELPER_DIGESTS[arch]]] as const) {
			const copy = join(copies, digest.slice(0, 16), name);
			let check = await verifyHelperBinary(helperId, copy);
			if (!check.ok) {
				const original = join(source, arch, name);
				const verified = await verifyHelperBinary(helperId, original);
				if (!verified.ok) {
					return { error: `${name} is missing or not the pinned build: ${verified.reason}` };
				}
				await fs.mkdir(dirname(copy), { recursive: true });
				await fs.rm(copy, { force: true });
				await fs.copyFile(original, copy);
				check = await verifyHelperBinary(helperId, copy);
				if (!check.ok) {
					return { error: check.reason ?? `${name} copy failed verification` };
				}
			}
			out[name] = copy;
		}
		return { wxcExec: out['wxc-exec.exe'], helper: out['volt-mxc-helper.exe'] };
	}

	private async trial(state: IMxcState): Promise<string | undefined> {
		const parent = join(homedir(), '.volt', 'sandbox');
		await fs.mkdir(parent, { recursive: true });
		const base = await fs.realpath(await fs.mkdtemp(join(parent, 'trial-')));
		try {
			const tmp = join(base, 'tmp');
			const outside = join(base, 'outside');
			await fs.mkdir(tmp, { recursive: true });
			await fs.mkdir(outside, { recursive: true });
			const task = `VoltSandboxTrial${randomBytes(4).toString('hex')}`;
			const marker = join(outside, 'escaped.txt');
			const surrogates = this.options.surrogateTrials === false ? '' :
				`(schtasks /create /tn ${task} /tr "cmd /c echo x" /sc once /st 23:59 /f >nul 2>&1) & (wsl.exe -e sh -c "echo x > '/mnt/${marker[0].toLowerCase()}${marker.slice(2).replace(/\\/g, '/')}'" >nul 2>&1) & `;
			const policy: IResolvedSandboxPolicy = {
				name: 'trial', platform: 'win32', readAll: false, read: [state.systemRoot], write: [tmp], writeFiles: [], deny: [], protect: [], gitDirs: [],
				denyPatterns: [], protectPatterns: [], newRepositoryGuard: [], network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
				unixSockets: [], systemServices: false, limits: {}, env: {}, cwd: tmp, tmp, home: homedir(),
			};
			const spec = await this.launchWith(state, policy, join(state.systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', `${surrogates}echo x> "${marker}"`], { tag: 'trial', terminal: false, onDenial: () => undefined });
			try {
				const result = await runSpec(spec);
				if (!result.confirmation.ok) {
					return result.confirmation.error;
				}
			} finally {
				await spec.dispose();
			}
			if (await exists(marker)) {
				return 'a write outside the policy landed';
			}
			const taskExists = await execFileAsync(join(state.systemRoot, 'System32', 'schtasks.exe'), ['/query', '/tn', task], { windowsHide: true }).then(() => true, () => false);
			if (taskExists) {
				await execFileAsync(join(state.systemRoot, 'System32', 'schtasks.exe'), ['/delete', '/tn', task, '/f'], { windowsHide: true }).catch(() => undefined);
				return 'a scheduled task created inside the sandbox was registered (surrogate spawn)';
			}
			return undefined;
		} finally {
			await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
		}
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		const state = await this.getState();
		if (!('wxcExec' in state)) {
			throw new SandboxUnavailableError(`Windows sandbox unavailable: ${state.diagnostics.join(' ')}`, 'unavailable', [], state.diagnostics);
		}
		return this.launchWith(state, policy, command, args, options);
	}

	private async launchWith(state: IMxcState, policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		const refuse = (message: string, dimension?: SandboxDimension): never => { throw new SandboxUnavailableError(message, 'unavailable', dimension ? [dimension] : []); };
		// Binaries are verified again right before every launch (INV-27).
		for (const [helperId, path] of [[WXC_EXEC_HELPER_ID, state.wxcExec], [MXC_HELPER_ID, state.helper]] as const) {
			const check = await verifyHelperBinary(helperId, path);
			if (!check.ok) {
				refuse(check.reason ?? `${helperId} failed verification`);
			}
		}

		// What runs: resolved here on the workload's own PATH (system folders first), never by a
		// PATH search inside the container (no current-folder lookup).
		let workloadPath: Record<string, string> = {};
		try {
			workloadPath = workloadEnv(policy, state.systemRoot, [...policy.write, ...policy.writeFiles]);
		} catch (err) {
			refuse((err as Error).message, err instanceof MxcPolicyError ? err.dimension : undefined);
		}
		const file = await resolveWindowsCommand(command, workloadPath);
		if (!file) {
			refuse(`Command not found in the sandbox's PATH: ${command}`);
		}
		const image = await fs.open(file!, 'r').then(async handle => {
			try {
				const size = Math.min((await handle.stat()).size, 64 * 1024 * 1024);
				const buffer = Buffer.alloc(size);
				await handle.read(buffer, 0, size, 0);
				return buffer;
			} finally {
				await handle.close();
			}
		}, () => undefined);
		const pe = image ? readPeInfo(image) : undefined;
		const approved = !!pe && await isApprovedMsysRuntime(file!, pe.dllCharacteristics, this.options.msysRuntimeRoot);
		const kind = classifyWindowsImage(file!, pe, approved);
		if (kind.reason) {
			refuse(kind.reason);
		}
		let commandLine = '';
		try {
			commandLine = windowsCommandLine(file!, args, join(state.systemRoot, 'System32', 'cmd.exe'));
		} catch (err) {
			refuse((err as Error).message);
		}

		// The run folder: <runDir>\tmp (the workload's, read-write), <runDir>\ctl (read-only to it),
		// and the request and sentinel beside them, outside every grant.
		const runDir = dirname(policy.tmp);
		const ctlDir = join(runDir, 'ctl');
		await fs.mkdir(ctlDir, { recursive: true });
		const nonce = randomBytes(16).toString('hex');
		const statusFile = join(policy.tmp, `.volt-mxc-status-${nonce}`);
		const goFile = join(ctlDir, `go-${nonce}`);
		const controlFile = join(ctlDir, 'prologue.txt');
		const requestFile = join(runDir, 'mxc-request.json');
		// The manager's canary (a file of this run its policy denies); the probe's trial brings none.
		const sentinel = policy.sentinel ?? join(runDir, 'sentinel');
		if (!policy.sentinel) {
			await fs.writeFile(sentinel, 'volt sandbox canary\n');
		}

		const walk = await walkPatterns(policy, { collectSockets: false });
		const existing = new Set<string>();
		for (const path of policy.protect) {
			if (await exists(path)) {
				existing.add(windowsPathKey(path));
			}
		}
		let request;
		try {
			request = buildMxcRequest({
				policy, helperPath: state.helper, controlFile, controlDir: ctlDir, systemRoot: state.systemRoot, proxyPort: options.proxyPort,
				// The .git allow list (B-03): everything a sandboxed writer may not change in a git folder is read-only.
				patternDeny: walk.deny.map(m => m.path), patternProtect: [...walk.protect, ...await gitAllowListProtections(policy, [...walk.deny, ...walk.protect])].map(m => m.path), existing,
				timeoutMs: policy.limits.wallClockSeconds ? (policy.limits.wallClockSeconds + 30) * 1000 : 0,
			});
			// The helper copy lives in Volt's own folder: the container reads (runs) it from there.
			request = { ...request, filesystem: { ...request.filesystem, readonlyPaths: [...request.filesystem.readonlyPaths, dirname(state.helper)], deniedPaths: [...request.filesystem.deniedPaths, ...await isolatedSiblings(policy, request.filesystem)] } };
			await fs.writeFile(controlFile, mxcControlText({
				nonce, statusFile, goFile, sentinel, network: policy.network.mode, canaryPort: this.options.canaryPort, limits: policy.limits, temp: normalizeWindowsPath(policy.tmp), commandLine,
			}));
		} catch (err) {
			if (err instanceof MxcPolicyError) {
				refuse(err.message, err.dimension);
			}
			throw err;
		}
		await fs.writeFile(requestFile, JSON.stringify(request, null, '\t'));

		let launcherPid: number | undefined;
		let poll: ReturnType<typeof setInterval> | undefined;
		let reportedLimit = false;
		const readStatus = async (): Promise<IMxcStatus> => parseMxcStatus(await fs.readFile(statusFile, 'utf8').catch(() => ''));
		const reportLimit = async () => {
			const status = await readStatus();
			if (status.limit && !reportedLimit) {
				reportedLimit = true;
				options.onDenial({ kind: 'limit', target: `${status.limit.resource} ${status.limit.value}`, source: 'os' });
			}
		};
		return {
			command: state.wxcExec,
			args: [requestFile],
			// wxc-exec runs as the user, before the sandbox exists: a fixed minimal environment (F.7.3).
			env: launcherEnv(state.systemRoot),
			cwd: runDir,
			extraStdio: [],
			extraStdioDirections: [],
			confirm: async (child: ChildProcess): Promise<SandboxConfirmation> => {
				launcherPid = child.pid;
				const confirmation = await this.confirm(state, child, readStatus, { nonce, goFile, network: policy.network.mode, fault: options.fault });
				if (confirmation.ok) {
					poll = setInterval(() => void reportLimit(), LIMIT_POLL_MS);
				}
				return confirmation;
			},
			terminate: async (child: ChildProcess) => {
				await reportLimit();
				const pid = child.pid ?? launcherPid;
				if (pid) {
					// Ending wxc-exec closes MXC's job, which has KILL_ON_JOB_CLOSE: the whole tree goes.
					await execFileAsync(join(state.systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
					try {
						child.kill();
					} catch {
						// Gone already.
					}
				}
			},
			dispose: async () => {
				if (poll) {
					clearInterval(poll);
					poll = undefined;
				}
			},
		};
	}

	private async confirm(state: IMxcState, child: ChildProcess, readStatus: () => Promise<IMxcStatus>, run: { nonce: string; goFile: string; network: IResolvedSandboxPolicy['network']['mode']; fault: SandboxFault | undefined }): Promise<SandboxConfirmation> {
		let stderr = '';
		child.stderr?.on('data', (data: Buffer | string) => { stderr = (stderr + data.toString()).slice(-4_000); });
		let exited = false;
		child.once('exit', () => { exited = true; });
		// A launcher that could not be spawned never exits: without this the loop waits out the whole timeout.
		child.once('error', err => { exited = true; stderr ||= err.message; });
		const started = Date.now();
		let status = await readStatus();
		while (!status.ready && !exited && Date.now() - started < CONFIRM_TIMEOUT_MS) {
			await new Promise(resolve => setTimeout(resolve, 10));
			status = await readStatus();
		}
		if (!status.ready) {
			return { ok: false, error: exited ? `wxc-exec exited before the sandbox started${stderr ? `: ${describeWxcError(stderr)}` : ''}` : 'the sandbox did not start in time' };
		}
		const attestation = await execFileAsync(state.helper, ['attest', String(status.ready.pid)], { timeout: ATTEST_TIMEOUT_MS, windowsHide: true, env: launcherEnv(state.systemRoot) })
			.then(r => parseMxcAttestation(r.stdout), err => parseMxcAttestation((err as { stdout?: string }).stdout ?? ''));
		const check = checkMxcEvidence(status, attestation, { nonce: run.nonce, helperPath: state.helper, launcherPid: child.pid, network: run.network, canaryPort: this.options.canaryPort });
		if (!check.ok || run.fault === 'attest') {
			return { ok: false, error: `Windows sandbox attestation failed: ${check.error ?? 'fault injection'}` };
		}
		if (run.fault === 'withhold-go') {
			await new Promise(resolve => setTimeout(resolve, WITHHELD_GO_MS));
			return { ok: false, error: 'the go file was withheld (fault injection)' };
		}
		// Written beside it and renamed: the prologue polls the go file and must never see it half written.
		// A go file without this run's nonce makes the prologue exit (fault `wrong-go`).
		const partial = `${run.goFile}.partial`;
		await fs.writeFile(partial, run.fault === 'wrong-go' ? 'go wrong-nonce' : `go ${run.nonce}`);
		await fs.rename(partial, run.goFile);
		if (run.fault === 'wrong-go') {
			return { ok: false, error: 'a wrong go file was written (fault injection)' };
		}
		const sentinel = status.ready?.sentinel;
		return {
			ok: true,
			detail: `MXC ProcessContainer attested (pid ${check.evidence.pid}, ${check.evidence.appContainerSid}, Low integrity, in job)`,
			attestation: { evidence: check.evidence, canary: { credOpen: sentinel === 0 ? 'open' : 'denied', sentinelError: String(sentinel) }, backendVersion: state.version },
		};
	}
}

function unavailable(details: string[], diagnostics: string[]): ISandboxBackendCapabilities {
	return { backend: 'mxc', available: false, enforcement: allEnforcement('unsupported'), notes: {}, details, diagnostics };
}

/** `<app>\resources\win32\mxc`, where a packaged build carries `<arch>\wxc-exec.exe` and the helper. */
function defaultMxcDir(): string | undefined {
	try {
		return join(dirname(FileAccess.asFileUri('').fsPath), 'resources', 'win32', 'mxc');
	} catch {
		return undefined;
	}
}

/**
 * Folders hidden from the run except one child (B-35: other runs' folders, other principals'
 * package caches). MXC grants only listed folders, so they are out of reach unless a grant holds
 * one of their roots; then every existing child but the kept one is denied. A child created
 * after launch inherits the grant: the residual is noted in 05-limitations.md.
 */
async function isolatedSiblings(policy: IResolvedSandboxPolicy, filesystem: { readonly readonlyPaths: readonly string[]; readonly readwritePaths: readonly string[] }): Promise<string[]> {
	const out: string[] = [];
	for (const { root, keep } of policy.isolated ?? []) {
		if (![...filesystem.readonlyPaths, ...filesystem.readwritePaths].some(grant => isWindowsPathInside(root, grant))) {
			continue;
		}
		for (const name of await fs.readdir(root).catch(() => [] as string[])) {
			const child = join(root, name);
			if (windowsPathKey(child) !== windowsPathKey(keep)) {
				out.push(normalizeWindowsPath(child));
			}
		}
	}
	return out;
}

/** wxc-exec's environment: nothing of Volt's, nothing of the user's (F.7.3). */
function launcherEnv(systemRoot: string): Record<string, string> {
	return { SystemRoot: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}` };
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

async function windowsVersion(): Promise<{ version: ReturnType<typeof parseWindowsVersion>; installationType?: string; error?: string }> {
	const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
	// `ver` prints build and update (10.0.26200.9725); the registry is the fallback.
	let error: string | undefined;
	const ver = await execFileAsync(join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'ver'], { timeout: 10_000, windowsHide: true }).then(r => r.stdout, err => {
		error = (err as Error).message;
		return '';
	});
	let version = parseWindowsVersion(ver);
	const reg = (name: string) => execFileAsync(join(systemRoot, 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', name], { timeout: 10_000, windowsHide: true })
		.then(r => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(r.stdout)?.[1]?.trim(), () => undefined);
	if (!version) {
		const build = await reg('CurrentBuildNumber') ?? /^10\.0\.(\d+)/.exec(release())?.[1];
		const ubrText = await reg('UBR');
		const ubr = ubrText ? Number.parseInt(ubrText, ubrText.startsWith('0x') ? 16 : 10) : NaN;
		version = build && Number.isFinite(ubr) ? parseWindowsVersion(`10.0.${build}.${ubr}`) : undefined;
	}
	const installationType = await reg('InstallationType') ?? (/server/i.test(osVersion()) ? 'Server' : 'Client');
	return { version, installationType, error };
}

/**
 * The absolute program `command` names: as given when absolute, else the first match on the
 * workload's PATH with PATHEXT, searched on the host before launch. The current folder is never
 * searched (a planted `git.exe` in the workspace must not win).
 */
export async function resolveWindowsCommand(command: string, workloadEnvironment: Readonly<Record<string, string>>): Promise<string | undefined> {
	const env = (name: string) => Object.entries(workloadEnvironment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	const extensions = (env('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
	const candidates = (base: string) => /\.[A-Za-z0-9]{1,4}$/.test(base) ? [base] : extensions.map(ext => base + ext.toLowerCase());
	if (isAbsolute(command)) {
		for (const candidate of [command, ...candidates(command)]) {
			if (await fs.stat(candidate).then(s => s.isFile(), () => false)) {
				return normalizeWindowsPath(candidate);
			}
		}
		return undefined;
	}
	if (/[\\/]/.test(command)) {
		return undefined;
	}
	for (const dir of (env('PATH') ?? '').split(';').filter(Boolean)) {
		for (const candidate of candidates(join(dir, command))) {
			if (await fs.stat(candidate).then(s => s.isFile(), () => false)) {
				return normalizeWindowsPath(candidate);
			}
		}
	}
	return undefined;
}

/**
 * An MSYS2 image may run only from a Volt-prepared runtime copy: under `root`, next to an
 * `msys-2.0.dll` whose digest CI has approved, and opted into ASLR (PSEC relocates images that
 * are not, which breaks Cygwin's fork).
 */
export async function isApprovedMsysRuntime(file: string, dllCharacteristics: number, root: string | undefined): Promise<boolean> {
	if (!root || !APPROVED_MSYS_RUNTIMES.length || !isWindowsPathInside(file, root) || !(dllCharacteristics & PE_DYNAMIC_BASE)) {
		return false;
	}
	const dll = await fs.readFile(join(dirname(file), 'msys-2.0.dll')).catch(() => undefined);
	return !!dll && APPROVED_MSYS_RUNTIMES.includes(createHash('sha256').update(dll).digest('hex'));
}

/** wxc-exec reports failures as a JSON object on stderr; keep its message. */
function describeWxcError(stderr: string): string {
	const json = /\{"error":\{[^]*\}\}/.exec(stderr)?.[0];
	if (json) {
		try {
			const error = JSON.parse(json).error;
			return `${error.code}: ${error.message ?? error.extended_error ?? ''}`.trim();
		} catch {
			// Fall through to the raw text.
		}
	}
	return stderr.trim().split(/\r?\n/).slice(-3).join(' ');
}

/** Spawns a launch spec the way the manager does and waits for it (the probe trial). */
async function runSpec(spec: ISandboxLaunchSpec): Promise<{ confirmation: SandboxConfirmation; code: number | null }> {
	const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
	const exited = new Promise<number | null>(resolve => {
		child.once('exit', code => resolve(code));
		child.once('error', () => resolve(null));
	});
	const confirmation = await spec.confirm(child);
	if (!confirmation.ok) {
		await spec.terminate(child);
	}
	const code = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000))]);
	await spec.terminate(child);
	return { confirmation, code };
}
