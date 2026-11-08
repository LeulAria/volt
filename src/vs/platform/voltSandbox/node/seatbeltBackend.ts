/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, join } from '../../../base/common/path.js';
import { helperIntegrity, verifyHelperBinary } from '../../voltHelpers/node/helperIntegrity.js';
import { allEnforcement, ISandboxBackendCapabilities, parseReadyLine, redactSandboxText, SANDBOX_GO, SANDBOX_WRONG_GO, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { denialKindForOperation } from '../common/sandboxDenials.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { SandboxDimension } from '../common/sandboxSchema.js';
import { buildSeatbeltProfile, MDNS_SOCKET, parseSeatbeltLogLine, SANDBOX_EXEC_PATH, SEATBELT_FDS, SEATBELT_PROLOGUE, SEATBELT_TAG_PREFIX } from '../common/seatbelt.js';
import { ISandboxBackend, ISandboxEvidence, ISandboxLaunchOptions, ISandboxLaunchSpec, SandboxConfirmation, SandboxFault } from './sandboxBackends.js';
import { binaryDigest, osBuild, ProbeCache } from './sandboxProbeCache.js';

const execFileAsync = promisify(execFile);

/** The watchdog: when Volt's end of its stdin closes (Volt exited or crashed), it kills the run's process group. */
const WATCHDOG = 'read _ ; kill -KILL -- "-$1" 2>/dev/null';
const CONFIRM_TIMEOUT_MS = 15_000;
const ATTEST_TIMEOUT_MS = 5_000;
/** `fault: withhold-go`: how long the backend holds the go pipe open, without the byte, before refusing. */
const WITHHELD_GO_MS = 750;

export const SANDBOX_HELPER_ID = 'volt-sandbox-helper';

/**
 * TCC-protected folders. A disclaimed process is its own responsible process and has no access
 * there (verified on macOS 26.6: `ls ~/Desktop` fails with EPERM), so a run whose workspace is
 * inside one keeps Volt's responsibility and reports `platform.tcc` as not enforced.
 */
const TCC_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'];

export interface ISeatbeltBackendOptions {
	/** Where `volt-sandbox-helper` is; default: see {@link defaultHelperPath}. Checked like the default before every launch. */
	readonly helperPath?: string;
}

/**
 * macOS: Seatbelt through `/usr/bin/sandbox-exec`. Deny-default for workloads; allow-default
 * with explicit denies for policies that need the OS's services (agent CLIs).
 *
 * Every sandbox root is spawned through `volt-sandbox-helper spawn`, which execs `sandbox-exec`
 * with TCC responsibility disclaimed (B-13): the sandbox does not inherit Volt's privacy grants.
 * The prologue then waits for the go byte, which this backend sends only after it attested the
 * process from outside with `sandbox_check` (B-29, F.5). The helper is checked before every
 * launch (INV-27) by Volt's one helper checker: its code signature on signed builds, the helper
 * manifest's digest on unsigned ones, the session's pin when running from sources.
 */
export class SeatbeltBackend implements ISandboxBackend {

	readonly id = 'seatbelt' as const;
	private readonly cache = new ProbeCache<ISandboxBackendCapabilities>();
	private monitor: ChildProcess | undefined;
	private readonly listeners = new Map<string, ISandboxLaunchOptions['onDenial']>();
	private attestor: SeatbeltAttestor | undefined;
	private macosVersion: Promise<string> | undefined;
	private helperPath: Promise<string | undefined> | undefined;

	constructor(private readonly options: ISeatbeltBackendOptions = {}) { }

	private helper(): Promise<string | undefined> {
		this.helperPath ??= this.options.helperPath ? Promise.resolve(this.options.helperPath) : defaultHelperPath().catch(() => undefined);
		return this.helperPath;
	}

	/** Cached per (OS build, sandbox-exec digest, helper digest): an OS update or a new helper re-probes. */
	async probe(): Promise<ISandboxBackendCapabilities> {
		const helper = await this.helper();
		const key = `seatbelt|${osBuild()}|${await binaryDigest(SANDBOX_EXEC_PATH)}|${helper ? await binaryDigest(helper) : 'no helper'}`;
		return this.cache.get(key, () => this.doProbe(helper));
	}

	private async doProbe(helper: string | undefined): Promise<ISandboxBackendCapabilities> {
		const enforcement = allEnforcement('enforced');
		const notes: ISandboxBackendCapabilities['notes'] = {
			'process.tree': 'No PID namespace: the run is a process group plus its descendants and tagged processes. A process that double-forks, calls setsid and clears its environment outlives the kill, still sandboxed.',
			'limits.processes': 'RLIMIT_NPROC counts every process of the user on macOS, so it cannot cap one sandbox.',
			'limits.memory': 'macOS does not enforce RLIMIT_AS or RLIMIT_RSS.',
			'syscalls': 'Seatbelt mediates operations (files, mach services, IOKit, sysctl), not raw system calls.',
			'platform.tcc': `A run whose workspace is in ${TCC_FOLDERS.map(folder => `~/${folder}`).join(', ')} or /Volumes keeps Volt's privacy permissions: a process of its own would have no access to those folders.`,
		};
		enforcement['process.tree'] = 'partial';
		enforcement['limits.processes'] = 'unsupported';
		enforcement['limits.memory'] = 'unsupported';
		enforcement['syscalls'] = 'partial';
		const unavailable = (diagnostic: string): ISandboxBackendCapabilities => ({ backend: 'seatbelt', available: false, enforcement: allEnforcement('unsupported'), notes, details: [], diagnostics: [diagnostic] });
		if (!existsSync(SANDBOX_EXEC_PATH)) {
			return unavailable(`${SANDBOX_EXEC_PATH} is missing.`);
		}
		// The helper and both private SPIs it uses: without them nothing could be attested.
		if (!helper) {
			return unavailable('The sandbox helper (volt-sandbox-helper) is missing from this build. Developers: node build/volt/sandbox-helper/build.mjs [--install out]');
		}
		const verified = await verifyHelperBinary(SANDBOX_HELPER_ID, helper);
		if (!verified.ok) {
			return unavailable(`The sandbox helper failed its integrity check: ${verified.reason}`);
		}
		const spi = await execFileAsync(helper, ['probe'], { timeout: 10_000 }).then(r => r.stdout.trim(), err => String((err as { stdout?: string }).stdout ?? (err as Error).message).trim());
		if (spi !== 'ok') {
			return unavailable(`This macOS lacks the private interfaces Volt's sandbox needs to verify itself (${spi}).`);
		}
		// A real trial: a deny-default profile must start a process and keep it from writing.
		const profile = '(version 1)(deny default)(allow process-exec process-fork)(allow file-read* (literal "/") (subpath "/usr") (subpath "/System") (subpath "/bin"))(allow file-read-metadata)';
		try {
			await execFileAsync(SANDBOX_EXEC_PATH, ['-p', profile, '/usr/bin/true'], { timeout: 10_000 });
		} catch (err) {
			return unavailable(`sandbox-exec could not start a sandboxed process: ${(err as Error).message}`);
		}
		const escaped = await execFileAsync(SANDBOX_EXEC_PATH, ['-p', profile, '/usr/bin/touch', '/private/tmp/.volt-sandbox-probe'], { timeout: 10_000 }).then(() => true, () => false);
		if (escaped) {
			return unavailable('A trial sandbox could write outside its policy; Seatbelt is not enforcing.');
		}
		// And the whole launch protocol once: disclaimed spawn, ready, external attestation, go byte.
		const trial = await this.trial(helper);
		if (!trial.ok) {
			return unavailable(`The trial sandbox could not be attested: ${trial.error}`);
		}
		const version = await this.version();
		return { backend: 'seatbelt', available: true, enforcement, notes, details: [`macOS ${version}`, `${SANDBOX_EXEC_PATH}`, `attestation: sandbox_check from outside, TCC responsibility disclaimed (${helper})`], diagnostics: [] };
	}

	private version(): Promise<string> {
		this.macosVersion ??= execFileAsync('/usr/bin/sw_vers', ['-productVersion']).then(r => r.stdout.trim(), () => 'unknown');
		return this.macosVersion;
	}

	/** A sandboxed `true` through the launch path: must be attested and then exit 0. */
	private async trial(helper: string): Promise<SandboxConfirmation> {
		const dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'volt-sbx-probe-'));
		let spec: ISandboxLaunchSpec | undefined;
		try {
			const sentinel = join(dir, 'canary');
			await fs.writeFile(sentinel, 'volt-canary\n', { mode: 0o600 });
			const policy: IResolvedSandboxPolicy = {
				// The sentinel's folder is readable, so the deny rule itself is what keeps the canary out.
				name: 'probe', platform: 'darwin', readAll: false, read: ['/usr', '/System', '/bin', '/private/var/select', dir], write: [], writeFiles: [], deny: [sentinel], protect: [],
				denyPatterns: [], protectPatterns: [], newRepositoryGuard: [], gitDirs: [],
				network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
				unixSockets: [], systemServices: false, limits: {},
				env: { PATH: '/usr/bin:/bin' }, cwd: dir, tmp: dir, home: dir, sentinel,
			};
			spec = await this.createSpec(helper, policy, '/usr/bin/true', [], { tag: 'probe', terminal: false, onDenial: () => undefined }, false);
			const child = spawn(spec.command, [...spec.args], { env: spec.env, cwd: spec.cwd, stdio: ['ignore', 'ignore', 'pipe', ...spec.extraStdio], detached: true });
			const exited = new Promise<number | null>(resolve => {
				child.once('close', code => resolve(code));
				child.once('error', () => resolve(null));
			});
			const confirmation = await spec.confirm(child);
			if (!confirmation.ok) {
				await spec.terminate(child);
				return confirmation;
			}
			const code = await Promise.race([exited, new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))]);
			await spec.terminate(child);
			return code === 0 ? confirmation : { ok: false, error: `the trial sandbox exited with ${code}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		} finally {
			await spec?.dispose().catch(() => undefined);
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		const capabilities = await this.probe();
		if (!capabilities.available) {
			throw new SandboxUnavailableError(`macOS sandbox unavailable: ${capabilities.diagnostics.join(' ')}`, 'unavailable', [], capabilities.diagnostics);
		}
		return this.createSpec(await this.helper(), policy, command, args, options, true);
	}

	private async createSpec(helper: string | undefined, policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions, listen: boolean): Promise<ISandboxLaunchSpec> {
		if (!helper) {
			throw new SandboxUnavailableError('The sandbox helper is missing', 'unavailable');
		}
		// Immediately before every launch: the binary that disclaims and attests is the one we built.
		const verified = await verifyHelperBinary(SANDBOX_HELPER_ID, helper);
		if (!verified.ok) {
			throw new SandboxUnavailableError(`The sandbox helper failed its integrity check: ${verified.reason}`, 'unavailable');
		}
		const sentinel = policy.sentinel;
		if (!sentinel || /[\t\n]/.test(sentinel) || !policy.deny.includes(sentinel)) {
			throw new SandboxUnavailableError('The run has no canary sentinel the policy denies', 'unavailable');
		}
		let profile: string;
		try {
			profile = buildSeatbeltProfile(policy, { tag: options.tag, proxyPort: options.proxyPort });
		} catch (err) {
			throw new SandboxUnavailableError((err as Error).message, 'unavailable');
		}
		const limit = (value: number | undefined, scale = 1) => value === undefined ? '-' : String(Math.max(1, Math.floor(value * scale)));
		// `ulimit -f` counts 1024-byte blocks in macOS /bin/sh (measured: 2048 blocks allowed a 2 MB file).
		const prologueArgs = [limit(policy.limits.cpuSeconds), limit(policy.limits.fileSizeMB, 1024), limit(policy.limits.openFiles), sentinel];
		const sandboxArgs = ['-p', profile, '--', '/bin/sh', '-c', SEATBELT_PROLOGUE, 'volt-sandbox', ...prologueArgs, command, ...args];
		const disclaim = !touchesTccFolder(policy);
		if (listen) {
			this.listen(options.tag, options.onDenial);
		}
		const attestor = this.attestor ??= new SeatbeltAttestor(helper);
		let watchdog: ChildProcess | undefined;
		let pgid: number | undefined;
		return {
			// The helper becomes sandbox-exec (same pid, same fds), its own responsible process.
			command: disclaim ? helper : SANDBOX_EXEC_PATH,
			args: disclaim ? ['spawn', SANDBOX_EXEC_PATH, ...sandboxArgs] : sandboxArgs,
			env: { ...policy.env, VOLT_SANDBOX_TAG: options.tag },
			cwd: policy.cwd,
			// SEATBELT_FDS: fd 3 carries the prologue's ready line out, fd 4 the go byte in.
			extraStdio: ['pipe', 'pipe'],
			extraStdioDirections: ['out', 'in'],
			...(disclaim ? {} : { unenforced: ['platform.tcc'] satisfies SandboxDimension[] }),
			confirm: async child => {
				pgid = child.pid;
				if (pgid) {
					watchdog = spawn('/bin/sh', ['-c', WATCHDOG, 'volt-sandbox-watchdog', String(pgid)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
					watchdog.on('error', () => undefined);
					watchdog.unref();
				}
				const result = await confirmLaunch(child, {
					attestor, sentinel, network: policy.network.mode, fault: options.fault, disclaim,
					version: `macOS ${await this.version()} sandbox-exec, ${helper}`,
				});
				return result.ok ? result : { ok: false, error: redactSandboxText(result.error, policy.home) };
			},
			terminate: async child => {
				const target = child.pid ?? pgid;
				if (target) {
					// The helper's sweep (no `ps` spawn); `ps -E` only if the helper is gone.
					await killRun(target, options.tag, { table: needle => attestor.sweep(needle).catch(() => processTable(needle)) });
				}
			},
			dispose: async () => {
				// The run is over: the watchdog must not fire later at a recycled process group.
				watchdog?.kill('SIGKILL');
				watchdog = undefined;
				// Late denials of a process that just exited still arrive for a moment.
				if (listen) {
					setTimeout(() => this.unlisten(options.tag), 2_000);
				}
			},
		};
	}

	// --- denials from the kernel log ------------------------------------------------------------

	private listen(tag: string, onDenial: ISandboxLaunchOptions['onDenial']): void {
		this.listeners.set(tag, onDenial);
		if (this.monitor) {
			return;
		}
		const child = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', `eventMessage CONTAINS "${SEATBELT_TAG_PREFIX}"`], { stdio: ['ignore', 'pipe', 'ignore'] });
		this.monitor = child;
		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			buffer += data;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const violation = parseSeatbeltLogLine(line);
				const listener = violation && this.listeners.get(violation.tag);
				const kind = violation && denialKindForOperation(violation.operation);
				if (violation && listener && kind) {
					listener({ kind: kind === 'launch' ? 'launch' : kind, target: violation.target, source: 'os', process: violation.process });
				}
			}
		});
		child.on('error', () => undefined);
		child.on('close', () => {
			if (this.monitor === child) {
				this.monitor = undefined;
			}
		});
	}

	private unlisten(tag: string): void {
		this.listeners.delete(tag);
		if (!this.listeners.size && this.monitor) {
			const monitor = this.monitor;
			this.monitor = undefined;
			monitor.kill();
		}
	}

	dispose(): void {
		this.monitor?.kill();
		this.monitor = undefined;
		this.listeners.clear();
		this.attestor?.dispose();
		this.attestor = undefined;
	}
}

/**
 * Where `volt-sandbox-helper` is: the build's own (`out/volt-helpers`, listed in the helper
 * manifest by build/volt/helpers/buildHelpers.mjs, or by `build/volt/sandbox-helper/build.mjs
 * --install out` in a checkout), else, running from sources (VSCODE_DEV), the one build.mjs made
 * in `.build/volt-helpers`, pinned for the rest of the session (unsigned helpers developer mode).
 */
async function defaultHelperPath(): Promise<string | undefined> {
	const integrity = helperIntegrity();
	const bundled = await integrity.bundledPath(SANDBOX_HELPER_ID);
	if (bundled || !integrity.developerMode) {
		return bundled;
	}
	const dev = join(dirname(FileAccess.asFileUri('').fsPath), '.build', 'volt-helpers', SANDBOX_HELPER_ID);
	if (!existsSync(dev)) {
		return undefined;
	}
	return (await integrity.trustDeveloperHelper(SANDBOX_HELPER_ID, dev)).ok ? dev : undefined;
}

/** Whether the run works in a folder only Volt's own TCC grants reach. */
export function touchesTccFolder(policy: IResolvedSandboxPolicy, home: string = homedir()): boolean {
	const homes = [...new Set([home, policy.home])];
	const folders = [...homes.flatMap(h => TCC_FOLDERS.map(folder => `${h}/${folder}`)), '/Volumes'].map(path => path.toLowerCase());
	const roots = [policy.cwd, ...policy.write, ...(policy.readAll ? [] : policy.read)].map(path => path.toLowerCase());
	return roots.some(root => folders.some(folder => root === folder || root.startsWith(`${folder}/`) || folder.startsWith(`${root}/`)));
}

interface IConfirmContext {
	readonly attestor: SeatbeltAttestor;
	readonly sentinel: string;
	readonly network: IResolvedSandboxPolicy['network']['mode'];
	readonly fault: SandboxFault | undefined;
	readonly disclaim: boolean;
	readonly version: string;
}

/**
 * The parent's half of the launch protocol: the ready line (informational), then evidence from
 * outside the process, then the canary, then the go byte. Nothing the workload or the prologue
 * says makes it `ok`: the pid in the ready line must be the process we spawned, and
 * `sandbox_check` on that pid must say it is sandboxed and that the run's sentinel, the network
 * and the DNS socket are denied to it.
 */
function confirmLaunch(child: ChildProcess, context: IConfirmContext): Promise<SandboxConfirmation> {
	return new Promise(resolve => {
		const stdio = child.stdio as readonly unknown[];
		const status = stdio[SEATBELT_FDS.status] as NodeJS.ReadableStream | null | undefined;
		const go = stdio[SEATBELT_FDS.go] as NodeJS.WritableStream | null | undefined;
		let done = false;
		let text = '';
		let stderr = '';
		let exited = false;
		const finish = (result: SandboxConfirmation) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		const timer = setTimeout(() => finish({ ok: false, error: 'the sandbox did not confirm in time' }), CONFIRM_TIMEOUT_MS);
		child.stderr?.on('data', (data: Buffer | string) => { stderr = (stderr + data.toString()).slice(-2_000); });
		if (!status || !go) {
			finish({ ok: false, error: 'no status or go pipe' });
			return;
		}
		go.on('error', () => undefined);
		// The go pipe is a socket: keep its read side flowing, or the child's 'close' never comes.
		(go as unknown as NodeJS.ReadableStream).resume?.();
		status.on('error', () => undefined);
		let attesting = false;
		status.on('data', (data: Buffer | string) => {
			text += data.toString();
			const ready = parseReadyLine(text);
			if (!ready || attesting) {
				return;
			}
			attesting = true;
			void attest(child, ready, context).then(async result => {
				if (done || exited) {
					return;
				}
				if (!result.ok) {
					finish(result);
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
				finish(result);
			});
		});
		child.once('exit', (code, signal) => {
			exited = true;
			setTimeout(() => finish({ ok: false, error: `sandbox-exec exited before the workload started (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}` }), 50);
		});
	});
}

async function attest(child: ChildProcess, ready: { readonly pid: number; readonly cred: string }, context: IConfirmContext): Promise<SandboxConfirmation> {
	if (!child.pid || ready.pid !== child.pid) {
		return { ok: false, error: `the ready line names process ${ready.pid}, not the sandbox's ${child.pid}` };
	}
	const queries: [string, string, string][] = [['sandbox_check', '-', '-'], ['credentialDenied', 'file-read-data', context.sentinel]];
	if (context.network !== 'host') {
		queries.push(['networkDenied', 'network-outbound', '-'], ['dnsDenied', 'network-outbound', MDNS_SOCKET]);
	}
	let answers: number[];
	try {
		answers = await context.attestor.check(ready.pid, queries.map(([, operation, path]) => [operation, path]));
	} catch (err) {
		return { ok: false, error: `the sandbox could not be attested: ${(err as Error).message}` };
	}
	const evidence: Record<string, string | number | boolean> = { pid: ready.pid, responsibility: context.disclaim ? 'disclaimed' : 'inherited' };
	queries.forEach(([name], index) => evidence[name] = answers[index]);
	const failed = queries.filter((_, index) => answers[index] !== 1).map(([name]) => `${name}=${answers[queries.findIndex(q => q[0] === name)]}`);
	if (context.fault === 'attest') {
		failed.push('fault injection');
	}
	if (failed.length) {
		return { ok: false, error: `the process is not sandboxed as required (sandbox_check: ${failed.join(', ')})` };
	}
	// The canary only means something now that we know who ran it.
	if (ready.cred !== 'denied') {
		return { ok: false, error: 'the canary could read the run\'s sentinel credential' };
	}
	const attestation: ISandboxEvidence = { evidence, canary: { credOpen: ready.cred }, backendVersion: context.version };
	return { ok: true, detail: `Seatbelt applied and attested (pid ${ready.pid}${context.disclaim ? ', own TCC responsibility' : ''})`, attestation };
}

/**
 * `volt-sandbox-helper serve`, kept running: answers `sandbox_check` queries about other
 * processes in well under a millisecond, where a helper process per launch would cost several,
 * and the process-tree sweep a run's teardown needs (see `killRun`).
 */
class SeatbeltAttestor {

	private child: ChildProcess | undefined;
	private buffer = '';
	private sequence = 0;
	private readonly pending = new Map<string, (value: string | Error) => void>();

	constructor(private readonly helper: string) { }

	check(pid: number, queries: readonly (readonly [string, string])[]): Promise<number[]> {
		return Promise.all(queries.map(async ([operation, path]) => {
			const value = await this.request(`${pid}\t${operation}\t${path}`);
			if (!/^-?\d+$/.test(value)) {
				throw new Error(`bad answer: ${value}`);
			}
			return Number(value);
		}));
	}

	/** Every process, as `processTable` gives it, from one call into the running helper. */
	async sweep(needle: string | undefined): Promise<IProcessRow[]> {
		const value = await this.request(`sweep\t${needle ?? '-'}\t-`);
		if (value.startsWith('-')) {
			throw new Error(`the sandbox helper could not list processes (${value})`);
		}
		const rows: IProcessRow[] = [];
		for (const entry of value.split(' ')) {
			const fields = entry.split(':').map(Number);
			if (fields.length === 4 && fields.every(Number.isInteger)) {
				rows.push({ pid: fields[0], ppid: fields[1], pgid: fields[2], tagged: fields[3] === 1 });
			}
		}
		if (!rows.length) {
			throw new Error('the sandbox helper listed no processes');
		}
		return rows;
	}

	private request(body: string): Promise<string> {
		const child = this.ensure();
		return new Promise<string>((resolve, reject) => {
			if (body.includes('\n') || body.split('\t').length !== 3) {
				reject(new Error('a query with a tab or newline'));
				return;
			}
			const id = String(++this.sequence);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('the sandbox helper did not answer'));
			}, ATTEST_TIMEOUT_MS);
			this.pending.set(id, value => {
				clearTimeout(timer);
				if (value instanceof Error) {
					reject(value);
				} else {
					resolve(value);
				}
			});
			child.stdin?.write(`${id}\t${body}\n`);
		});
	}

	private ensure(): ChildProcess {
		if (this.child) {
			return this.child;
		}
		const child = spawn(this.helper, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
		this.child = child;
		this.buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			this.buffer += data;
			const lines = this.buffer.split('\n');
			this.buffer = lines.pop() ?? '';
			for (const line of lines) {
				const tab = line.indexOf('\t');
				const answer = tab > 0 ? this.pending.get(line.slice(0, tab)) : undefined;
				if (answer) {
					this.pending.delete(line.slice(0, tab));
					answer(line.slice(tab + 1).trim());
				}
			}
		});
		const gone = (why: string) => {
			if (this.child === child) {
				this.child = undefined;
			}
			for (const answer of this.pending.values()) {
				answer(new Error(why));
			}
			this.pending.clear();
		};
		child.on('error', err => gone(`the sandbox helper failed: ${err.message}`));
		child.on('exit', code => gone(`the sandbox helper exited (${code})`));
		child.stdin?.on('error', () => undefined);
		// An idle helper must not keep Volt (or a test run) alive.
		child.unref();
		for (const stream of [child.stdin, child.stdout] as unknown as ({ unref?(): void } | null)[]) {
			stream?.unref?.();
		}
		return child;
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
	}
}

/**
 * Kills a run: its process group, every descendant reachable through parent pids (including
 * ones that moved to their own group or session), and any process still carrying the run's tag.
 * The responsible process does not help here: under a disclaimed root every new process is its
 * own (measured on macOS 26.6), so a double-forked `setsid` daemon with a cleared environment
 * still escapes the sweep, and stays sandboxed (`process.tree` is partial).
 */
export async function killRun(pgid: number, tag: string, options: { readonly table?: (needle: string | undefined) => Promise<IProcessRow[]> } = {}): Promise<void> {
	const kill = (pid: number, group = false) => {
		try {
			process.kill(group ? -pid : pid, 'SIGKILL');
		} catch {
			// Gone already.
		}
	};
	// Snapshot the tree first: once the root dies, its children are reparented and lose the link.
	// One scan gives parents, groups and environments (the tag).
	const needle = /^[a-f0-9]{8,64}$/.test(tag) ? `VOLT_SANDBOX_TAG=${tag}` : undefined;
	const table = await (options.table ?? processTable)(needle);
	kill(pgid, true);
	const children = new Map<number, number[]>();
	for (const row of table) {
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const doomed = new Set<number>(table.filter(row => row.pgid === pgid).map(row => row.pid));
	const queue = [pgid, ...doomed];
	while (queue.length) {
		const pid = queue.pop()!;
		for (const child of children.get(pid) ?? []) {
			if (!doomed.has(child)) {
				doomed.add(child);
				queue.push(child);
			}
		}
	}
	for (const row of table) {
		// Still carrying the run's tag: started inside it and moved away (setsid), env kept.
		if (row.tagged) {
			doomed.add(row.pid);
		}
	}
	for (const pid of doomed) {
		if (pid !== process.pid) {
			kill(pid);
		}
	}
}

interface IProcessRow { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly tagged: boolean }

/** Every process: pid, parent, group, and whether its argv or environment holds `needle` (visible for this user's processes). */
async function processTable(needle: string | undefined): Promise<IProcessRow[]> {
	try {
		const { stdout } = await execFileAsync('/bin/ps', ['-E', '-ww', '-axo', 'pid=,ppid=,pgid=,command='], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
		const rows: IProcessRow[] = [];
		for (const line of stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
			if (match) {
				rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tagged: !!needle && match[4].includes(needle) });
			}
		}
		return rows;
	} catch {
		return [];
	}
}
