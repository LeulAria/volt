/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { generateUuid } from '../../../base/common/uuid.js';
import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../../base/common/path.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { checkEnforcement, IAttestation, ISandboxBackendCapabilities, ISandboxRunDenial, ISandboxRunResult, redactSandboxText, SandboxBackendId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { IResolvedSandboxPolicy, ISandboxIsolatedRoot, sandboxProxyEnv } from '../common/sandboxResolved.js';
import { IVoltSandboxPolicy, SandboxDimension } from '../common/sandboxSchema.js';
import { ISandboxWorkloadInfo, summarizeSandboxPolicy } from '../common/sandboxWorkloads.js';
import { BubblewrapBackend } from './bubblewrapBackend.js';
import { MxcBackend } from './mxcBackend.js';
import { ISandboxBackend, ISandboxLaunchSpec, SandboxConfirmation, SandboxFault } from './sandboxBackends.js';
import { osBuild } from './sandboxProbeCache.js';
import { IPrincipal, PrincipalKind, SubjectKey } from '../common/principals.js';
import type { NetworkBrokerMode } from '../common/networkBrokerSetting.js';
import { INetworkDenial, NetworkAuditLog, NetworkBroker, NetworkRoute } from './networkBroker.js';
import { ISandboxProxyOptions, SandboxNetworkProxy } from './sandboxProxy.js';
import { ISandboxHostFacts, ISandboxRunContext, resolveSandboxPolicy, sandboxHostFacts } from './sandboxResolver.js';
import { SeatbeltBackend } from './seatbeltBackend.js';
import { UnsupportedBackend } from './unsupportedBackend.js';

/**
 * The one way Volt runs something in the OS sandbox.
 *
 *   policy (composed) -> resolve (tokens, real paths, env) -> enforcement check -> backend launch
 *   -> spawn -> confirm -> run -> terminate the whole tree -> clean up
 *
 * It fails closed at every step: no backend, a dimension the backend cannot enforce (unless the
 * policy marked it best effort), a path it cannot resolve safely, or a backend that does not
 * confirm the sandbox all mean the workload does not run. "Sandboxed" is reported only after the
 * backend confirmed it.
 */

export interface ISandboxLogger {
	info(message: string): void;
	warn(message: string): void;
}

export interface ISandboxRequest {
	readonly command: string;
	readonly args?: readonly string[];
	/** Already composed (see sandboxComposition.ts). */
	readonly policy: IVoltSandboxPolicy;
	readonly context: ISandboxRunContext;
	/** Spawned on a PTY: keeps the terminal session (TIOCSTI is blocked instead). */
	readonly terminal?: boolean;
	/** For logs: "claude-code agent", "terminal_start". */
	readonly label?: string;
	/** Folders hidden from this run except one child each (real paths), e.g. the per-principal package caches. The run folders are added by the manager. */
	readonly isolate?: readonly ISandboxIsolatedRoot[];
	/**
	 * Who it runs as, when a registry minted a principal for it (shown on the Security page): its
	 * network broker route, token, grants and budgets are this principal's. Wins over `subject` and
	 * `principalKind`.
	 */
	readonly principal?: IPrincipal;
	/** Without `principal`: whose run this is (`chat:<id>`), its grants attach to it. Default: a subject of this run alone. */
	readonly subject?: SubjectKey;
	/** Without `principal`: default `agent`; picks the network budget (H.8). */
	readonly principalKind?: PrincipalKind;
}

export interface IPreparedSandbox {
	readonly tag: string;
	readonly backend: SandboxBackendId;
	/** `partial` lists `unenforced`; becomes `initialized`/`partial` only once `confirm` succeeds. */
	readonly expectedStatus: 'initialized' | 'partial';
	readonly unenforced: readonly SandboxDimension[];
	readonly policy: IResolvedSandboxPolicy;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	/** stdio entries from fd 3 up, to append after stdin/stdout/stderr. */
	readonly extraStdio: readonly (number | 'pipe')[];
	/** See {@link ISandboxLaunchSpec.extraStdioDirections}. */
	readonly extraStdioDirections: readonly ('in' | 'out')[];
	readonly onDenial: Event<ISandboxRunDenial>;
	/** SHA-256 of the resolved policy; network grants made later are not part of it (F.9). */
	readonly launchPolicyHash: string;
	/** Attests the spawned process from outside and only then lets the workload run (F.5). */
	confirm(child: ChildProcess): Promise<SandboxConfirmation>;
	/** The evidence the run started on, once `confirm` succeeded. */
	attestation(): IAttestation | undefined;
	/** Kills the whole tree: the workload and everything it started. */
	terminate(child: ChildProcess): Promise<void>;
	/** Who the run is: its route, grants and audit lines are about this principal. */
	readonly principal: IPrincipal;
	/** Hosts the proxy lets through from now on (network `proxy`): live, the next connection (F.9). */
	allowDomains(entries: readonly string[]): void;
	/** Takes back hosts {@link allowDomains} granted; tunnels they allowed close at once (INV-23). Not with the legacy proxy. */
	revokeDomains(entries: readonly string[]): Promise<void>;
	/** The run's network broker route (network `proxy`, broker mode). */
	networkRoute(): NetworkRoute | undefined;
	dispose(): Promise<void>;
}

export interface ISandboxRunOptions {
	/** Written to stdin, then stdin is closed. Absent: stdin is closed at once. */
	readonly stdin?: string;
	/** Never longer than the policy's wall clock. */
	readonly timeoutMs?: number;
	/** Per stream; the middle is dropped beyond it. Default 1 MB. */
	readonly maxOutputBytes?: number;
	readonly signal?: AbortSignal;
}

export interface ISandboxManagerOptions {
	readonly platform?: string;
	readonly backend?: ISandboxBackend;
	readonly runRoot?: string;
	readonly host?: ISandboxHostFacts;
	/** Test builds only: make a launch step fail (FAULT-*). */
	readonly fault?: SandboxFault;
	/** Test builds only: the proxy's resolver and connector (the broker's too). */
	readonly proxy?: ISandboxProxyOptions;
	/** `legacy`: the pre-broker proxy (`volt.sandbox.networkBroker`, one release). Read at every launch. */
	readonly networkMode?: () => NetworkBrokerMode;
	/** A broker shared with other managers; default: one of its own. */
	readonly broker?: NetworkBroker;
	/** Volt's own listener ports, never reachable through the broker. */
	readonly reservedPorts?: () => readonly number[];
}

const RUN_PREFIX = 'volt-sbx-';
/** A long-lived host's record in its run folder (supervisor.ts): a folder whose owner still runs is never swept. */
export const RUN_LEDGER_NAME = 'ledger.json';
/** The canary file in each run folder: denied by the run's own policy, read by the prologue, checked from outside. */
const SENTINEL_NAME = 'canary';
/** After the workload exits, how long its output may keep arriving before the run counts as done. */
const EXIT_DRAIN_MS = 250;

export class SandboxManager {

	private readonly backend: ISandboxBackend;
	private host: Promise<ISandboxHostFacts> | undefined;
	private readonly live = new Map<string, ILiveRun>();
	private readonly _onDidChangeWorkloads = new Emitter<void>();
	/** A run was attested or ended. */
	readonly onDidChangeWorkloads: Event<void> = this._onDidChangeWorkloads.event;

	constructor(
		private readonly logger: ISandboxLogger = { info: () => undefined, warn: () => undefined },
		options: ISandboxManagerOptions = {},
	) {
		const platform = options.platform ?? process.platform;
		this.backend = options.backend ?? createBackend(platform);
		this.runRoot = options.runRoot;
		this.fault = options.fault;
		this.proxyOptions = options.proxy ?? {};
		this.networkMode = options.networkMode ?? (() => 'broker');
		this.broker = options.broker;
		this.ownsBroker = !options.broker;
		this.reservedPorts = options.reservedPorts;
		if (options.host) {
			this.host = Promise.resolve(options.host);
		}
	}

	private readonly fault: SandboxFault | undefined;
	private readonly proxyOptions: ISandboxProxyOptions;
	private readonly networkMode: () => NetworkBrokerMode;
	private broker: NetworkBroker | undefined;
	private readonly ownsBroker: boolean;
	private readonly reservedPorts: (() => readonly number[]) | undefined;

	/** The broker, made on first use; its audit log is `~/.volt/trust/audit/network.log` (denied to every sandbox). */
	private networkBroker(host: ISandboxHostFacts): NetworkBroker {
		this.broker ??= new NetworkBroker({
			...(this.proxyOptions.lookup ? { lookup: this.proxyOptions.lookup } : {}),
			...(this.proxyOptions.connect ? { connect: this.proxyOptions.connect } : {}),
			...(this.proxyOptions.tunnelIdleMs ? { tunnelIdleMs: this.proxyOptions.tunnelIdleMs } : {}),
			...(this.reservedPorts ? { reservedPorts: this.reservedPorts } : {}),
			audit: new NetworkAuditLog(join(host.home, '.volt', 'trust', 'audit', 'network.log')).append,
		});
		return this.broker;
	}

	private readonly runRoot: string | undefined;

	get backendId(): SandboxBackendId {
		return this.backend.id;
	}

	capabilities(): Promise<ISandboxBackendCapabilities> {
		return this.backend.probe();
	}

	private hostFacts(): Promise<ISandboxHostFacts> {
		this.host ??= sandboxHostFacts();
		return this.host;
	}

	/**
	 * Where run folders go: `~/.volt/sandbox/runs`, which no profile makes writable. Not the system
	 * temp folder: agent profiles write there, and a run folder holds the backend's control files
	 * (bubblewrap's bridge sockets) beside the run's own temp. Runs a crash left behind are removed
	 * the first time.
	 */
	private runRootDir(host: ISandboxHostFacts): Promise<string> {
		this.runRootReady ??= (async () => {
			const root = this.runRoot ?? join(host.home, '.volt', 'sandbox', 'runs');
			await fs.mkdir(root, { recursive: true, mode: 0o700 });
			await fs.chmod(root, 0o700).catch(() => undefined);
			const dayAgo = Date.now() - 24 * 3600 * 1000;
			for (const name of await fs.readdir(root).catch(() => [] as string[])) {
				const stat = name.startsWith(RUN_PREFIX) ? await fs.stat(join(root, name)).catch(() => undefined) : undefined;
				// A host that has run for a day (its owner, another Volt process, is alive) keeps its folder.
				if (stat && stat.mtimeMs < dayAgo && !await ownerAlive(join(root, name))) {
					await removeRunDir(join(root, name));
				}
			}
			return root;
		})();
		return this.runRootReady;
	}

	private runRootReady: Promise<string> | undefined;

	/** `~/.volt/sandbox/runs` (or the test's), created on first use. */
	async runRootPath(): Promise<string> {
		return this.runRootDir(await this.hostFacts());
	}

	/** Every live run that was attested or is being attested: agents, commands, terminals, hosts. */
	workloads(): ISandboxWorkloadInfo[] {
		const out: ISandboxWorkloadInfo[] = [];
		for (const [tag, run] of this.live) {
			const attestation = run.prepared.attestation();
			if (!run.child && !attestation) {
				continue; // Prepared, not spawned yet.
			}
			out.push({
				id: tag,
				principalId: run.principal?.id ?? tag,
				...(run.principal ? { subject: run.principal.subject } : {}),
				label: run.label,
				lifetime: 'command',
				backend: run.prepared.backend,
				state: attestation ? 'running' : 'attesting',
				status: run.prepared.unenforced.length ? 'partial' : 'sandboxed',
				unenforced: run.prepared.unenforced,
				...(attestation ? { attestation } : {}),
				policy: summarizeSandboxPolicy(run.prepared.policy),
				startedAt: run.startedAt,
			});
		}
		return out;
	}

	/** The process a live run was confirmed on, if it got that far. */
	processOf(tag: string): ChildProcess | undefined {
		return this.live.get(tag)?.child;
	}

	/** Kills the whole tree of live run `tag`. False when there is no such run or it never spawned. */
	async stop(tag: string): Promise<boolean> {
		const run = this.live.get(tag);
		if (!run?.child) {
			return false;
		}
		this.logger.info(`[volt-sandbox] ${tag} stopped on request`);
		await run.prepared.terminate(run.child);
		return true;
	}

	/**
	 * Everything needed to spawn the workload sandboxed. The caller spawns `command args` with
	 * `env`, `cwd`, `stdio: [in, out, err, ...extraStdio]` and `detached: true`, then awaits
	 * `confirm`. Throws `SandboxUnavailableError` instead of returning anything weaker.
	 */
	async prepare(request: ISandboxRequest): Promise<IPreparedSandbox> {
		const capabilities = await this.backend.probe();
		if (!capabilities.available) {
			throw new SandboxUnavailableError(`No OS sandbox available: ${capabilities.diagnostics.join(' ')}`, 'unavailable', [], capabilities.diagnostics);
		}
		const check = checkEnforcement(request.policy, capabilities);
		if (check.blocking.length) {
			const why = check.blocking.map(d => `${d}${capabilities.notes[d] ? ` (${capabilities.notes[d]})` : ''}`).join('; ');
			throw new SandboxUnavailableError(`This machine's sandbox (${capabilities.backend}) cannot enforce: ${why}`, 'unavailable', check.blocking, capabilities.diagnostics);
		}
		const host = await this.hostFacts();
		const runDir = await fs.realpath(await fs.mkdtemp(join(await this.runRootDir(host), RUN_PREFIX)));
		await fs.chmod(runDir, 0o700);
		const runTmp = join(runDir, 'tmp');
		await fs.mkdir(runTmp, { mode: 0o700 });
		const tag = generateUuid().replace(/-/g, '').slice(0, 16);
		const denials = new Emitter<ISandboxRunDenial>();
		let proxy: SandboxNetworkProxy | undefined;
		let route: NetworkRoute | undefined;
		let spec: ISandboxLaunchSpec | undefined;
		const cleanup = async () => {
			proxy?.dispose();
			route?.dispose();
			await spec?.dispose().catch(() => undefined);
			denials.dispose();
			await removeRunDir(runDir);
		};
		try {
			const { policy: resolved, notes } = await resolveSandboxPolicy(request.policy, request.context, host, runTmp);
			for (const note of notes) {
				this.logger.info(`[volt-sandbox] ${tag} ${redactSandboxText(note, host.home)}`);
			}
			// The canary: a file of this run that its own policy denies (F.5 step 3).
			const sentinel = join(runDir, SENTINEL_NAME);
			await fs.writeFile(sentinel, `volt-canary ${tag}\n`, { mode: 0o600 });
			const proxied = resolved.network.mode === 'proxy';
			const launchPolicy = (proxyEnv: Record<string, string>): IResolvedSandboxPolicy => ({
				...resolved,
				env: {
					...resolved.env,
					...proxyEnv,
					VOLT_SANDBOX: resolved.name,
					VOLT_SANDBOX_TAG: tag,
					...(resolved.network.mode !== 'host' ? { VOLT_SANDBOX_NETWORK_DISABLED: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1' } : {}),
				},
				deny: [...resolved.deny, sentinel],
				sentinel,
				// Every other run's folder (its temp, its control sockets) is out of reach (B-35).
				isolated: [{ root: dirname(runDir), keep: runDir }, ...(request.isolate ?? []), ...(resolved.isolated ?? [])],
			});
			// The hash leaves out environment values (F.3), so it is known before the route exists.
			const launchPolicyHash = policyHash(launchPolicy(proxied ? sandboxProxyEnv(1, 'route') : {}));
			// The launcher's or supervisor's principal when it minted one (same id, this launch's policy hash).
			const principal: IPrincipal = Object.freeze(request.principal ? { ...request.principal, launchPolicyHash } : {
				id: randomBytes(16).toString('base64url'),
				subject: request.subject ?? `chat:run-${tag}`,
				kind: request.principalKind ?? 'agent',
				executionHost: 'local',
				launchPolicyHash,
				createdAt: Date.now(),
			});
			if (proxied && this.networkMode() === 'legacy') {
				proxy = await SandboxNetworkProxy.start(resolved.network.allow, (target, reason) => reason === 'auth'
					// Not this run's request (no token or another's): never a denial row with an "Allow" button.
					? this.logger.warn(`[volt-sandbox] ${tag} proxy refused a request without this run's token`)
					: denials.fire({ kind: 'network', target: reason === 'not-allowed' ? target : `${target} (${reason})`, source: 'proxy' }), {
					...this.proxyOptions,
					// Per run: another process on this machine cannot use this run's grants (B-31).
					token: randomBytes(24).toString('base64url'),
				});
			} else if (proxied) {
				// The network broker (I.4): this principal's own route, token, rules, grants and budgets.
				route = await this.networkBroker(host).openRoute({
					principal,
					allow: resolved.network.allow,
					onDenial: denial => denial.reason === 'auth'
						// Not this run's request (no token or another's): never a denial row with an "Allow" button.
						? this.logger.warn(`[volt-sandbox] ${tag} network broker refused a request without this run's token`)
						: denials.fire({ kind: 'network', target: denialTarget(denial), source: 'proxy', denialId: denial.denialId, promptable: denial.promptable }),
				});
			}
			const routePort = route?.port ?? proxy?.port;
			const policy = launchPolicy(route ? sandboxProxyEnv(route.port, route.token) : proxy ? sandboxProxyEnv(proxy.port, proxy.token) : {});
			spec = await this.backend.launch(policy, request.command, request.args ?? [], {
				tag,
				proxyPort: routePort,
				terminal: !!request.terminal,
				onDenial: denial => denials.fire(denial),
				...(this.fault ? { fault: this.fault } : {}),
			});
			const unenforced = [...new Set([...check.unenforced, ...(spec.unenforced ?? [])])];
			this.logger.info(`[volt-sandbox] ${tag} ${this.backend.id} ${policy.name}${request.label ? ` (${request.label})` : ''} network=${policy.network.mode} unenforced=${unenforced.join(',') || 'none'}`);
			const launched = spec;
			let disposed = false;
			let attestation: IAttestation | undefined;
			const prepared: IPreparedSandbox = {
				tag,
				backend: this.backend.id,
				expectedStatus: unenforced.length ? 'partial' : 'initialized',
				unenforced,
				policy,
				command: launched.command,
				args: launched.args,
				env: launched.env,
				cwd: launched.cwd,
				extraStdio: launched.extraStdio,
				extraStdioDirections: launched.extraStdioDirections,
				onDenial: denials.event,
				launchPolicyHash,
				attestation: () => attestation,
				confirm: async child => {
					const entry = this.live.get(tag);
					if (entry) {
						entry.child = child;
					}
					const confirmation = await launched.confirm(child);
					if (confirmation.ok) {
						if (!confirmation.attestation) {
							// A backend that cannot show evidence from outside does not get to say "sandboxed".
							return { ok: false, error: 'the backend gave no external evidence for the sandbox' };
						}
						attestation = {
							principalId: tag,
							backend: this.backend.id,
							backendVersion: confirmation.attestation.backendVersion,
							osBuild: osBuild(),
							launchPolicyHash,
							evidence: confirmation.attestation.evidence,
							canary: confirmation.attestation.canary,
							unenforced,
							attestedAt: Date.now(),
						};
						this._onDidChangeWorkloads.fire();
					}
					return confirmation;
				},
				terminate: async child => { await launched.terminate(child); },
				principal,
				allowDomains: entries => {
					proxy?.allow(entries);
					void route?.allowHosts(entries).catch(err => this.logger.warn(`[volt-sandbox] ${tag} could not allow hosts: ${err}`));
				},
				revokeDomains: async entries => { await route?.revokeHosts(entries); },
				networkRoute: () => route,
				dispose: async () => {
					if (!disposed) {
						disposed = true;
						this.live.delete(tag);
						if (attestation) {
							this._onDidChangeWorkloads.fire();
						}
						await cleanup();
					}
				},
			};
			this.live.set(tag, { prepared, label: request.label ?? basename(request.command), startedAt: Date.now(), ...(request.principal ? { principal: request.principal } : {}) });
			return prepared;
		} catch (err) {
			await cleanup();
			throw err;
		}
	}

	/** Runs to completion and reports what happened. Never throws: a refusal is status `unavailable`. */
	async run(request: ISandboxRequest, options: ISandboxRunOptions = {}): Promise<ISandboxRunResult> {
		const started = Date.now();
		let prepared: IPreparedSandbox;
		try {
			prepared = await this.prepare(request);
		} catch (err) {
			const host = await this.hostFacts().catch(() => undefined);
			return {
				status: err instanceof SandboxUnavailableError ? err.status : 'failed',
				backend: this.backend.id,
				exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false,
				unenforced: err instanceof SandboxUnavailableError ? err.blocking : [],
				denials: [],
				timing: { prepareMs: Date.now() - started, startMs: 0, totalMs: Date.now() - started },
				error: redactSandboxText((err as Error).message, host?.home),
			};
		}
		const prepareMs = Date.now() - started;
		const denials: ISandboxRunDenial[] = [];
		const listener = prepared.onDenial(denial => {
			if (denials.length < 200) {
				denials.push(denial);
			}
		});
		const cap = options.maxOutputBytes ?? 1024 * 1024;
		const stdout = new CappedText(cap);
		const stderr = new CappedText(cap);
		let child: ChildProcess;
		try {
			child = spawn(prepared.command, [...prepared.args], {
				cwd: prepared.cwd,
				env: prepared.env,
				stdio: ['pipe', 'pipe', 'pipe', ...prepared.extraStdio],
				detached: true,
				// Windows: `detached` would otherwise give the launcher a console window of its own.
				windowsHide: true,
			});
		} catch (err) {
			listener.dispose();
			await prepared.dispose();
			return this.failure('failed', prepared, (err as Error).message, prepareMs, started);
		}
		child.stdout?.on('data', (d: Buffer) => stdout.append(d));
		child.stderr?.on('data', (d: Buffer) => stderr.append(d));
		child.stdin?.on('error', () => undefined);
		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		} else {
			child.stdin?.end();
		}
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
			let settled = false;
			const done = (code: number | null, signal: NodeJS.Signals | null) => {
				if (!settled) {
					settled = true;
					resolve({ code, signal });
				}
			};
			child.once('close', done);
			// A child the workload left behind can hold the pipes open forever: the run is over
			// shortly after the workload itself exits, and the tree kill below takes the rest.
			child.once('exit', (code, signal) => setTimeout(() => done(code, signal), EXIT_DRAIN_MS));
			child.once('error', () => done(null, null));
		});
		const confirmation = await prepared.confirm(child);
		const startMs = Date.now() - started - prepareMs;
		let timedOut = false;
		let cancelled = false;
		const wallClock = Math.min(options.timeoutMs ?? Number.MAX_SAFE_INTEGER, (prepared.policy.limits.wallClockSeconds ?? 24 * 3600) * 1000);
		const timer = setTimeout(() => {
			timedOut = true;
			void prepared.terminate(child);
		}, wallClock);
		const onAbort = () => {
			cancelled = true;
			void prepared.terminate(child);
		};
		options.signal?.addEventListener('abort', onAbort);
		if (options.signal?.aborted) {
			onAbort();
		}
		if (!confirmation.ok) {
			void prepared.terminate(child);
		}
		const { code, signal } = await exited;
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
		// The workload is done; nothing it started may outlive it.
		await prepared.terminate(child);
		for (const stream of child.stdio) {
			stream?.destroy();
		}
		listener.dispose();
		await prepared.dispose();
		if (timedOut) {
			denials.push({ kind: 'limit', target: `wall clock ${Math.round(wallClock / 1000)} s`, source: 'manager' });
		}
		return {
			status: confirmation.ok ? 'completed' : 'failed',
			backend: prepared.backend,
			exitCode: code,
			...(signal ? { signal } : {}),
			stdout: stdout.text(),
			stderr: stderr.text(),
			truncated: stdout.truncated || stderr.truncated,
			timedOut,
			cancelled,
			unenforced: prepared.unenforced,
			denials,
			timing: { prepareMs, startMs, totalMs: Date.now() - started },
			...(confirmation.ok ? {} : { error: redactSandboxText(confirmation.error, prepared.policy.home) }),
			...(confirmation.ok && prepared.attestation() ? { attestation: prepared.attestation() } : {}),
		};
	}

	private failure(status: 'failed', prepared: IPreparedSandbox, message: string, prepareMs: number, started: number): ISandboxRunResult {
		return {
			status, backend: prepared.backend, exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false,
			unenforced: prepared.unenforced, denials: [], timing: { prepareMs, startMs: 0, totalMs: Date.now() - started },
			error: redactSandboxText(message, prepared.policy.home),
		};
	}

	/** Kills every live run (app shutdown). */
	async dispose(): Promise<void> {
		const entries = [...this.live.values()];
		this.live.clear();
		await Promise.all(entries.map(({ child, prepared }) => child ? prepared.terminate(child).catch(() => undefined) : undefined));
		await Promise.all(entries.map(({ prepared }) => prepared.dispose().catch(() => undefined)));
		if (this.ownsBroker) {
			this.broker?.dispose();
		}
		(this.backend as { dispose?(): void }).dispose?.();
		this._onDidChangeWorkloads.dispose();
	}
}

interface ILiveRun {
	child?: ChildProcess;
	readonly prepared: IPreparedSandbox;
	readonly label: string;
	readonly startedAt: number;
	readonly principal?: IPrincipal;
}

/** Whether the run folder holds a host ledger whose owning process is still running. */
async function ownerAlive(runDir: string): Promise<boolean> {
	const text = await fs.readFile(join(runDir, RUN_LEDGER_NAME), 'utf8').catch(() => undefined);
	if (!text) {
		return false;
	}
	try {
		const owner = (JSON.parse(text) as { ownerPid?: unknown }).ownerPid;
		return typeof owner === 'number' && owner > 0 && processAlive(owner);
	} catch {
		return false;
	}
}

/** Whether process `pid` exists (EPERM: it does, as another user's). */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export function createBackend(platform: string): ISandboxBackend {
	switch (platform) {
		case 'darwin': return new SeatbeltBackend();
		case 'linux': return new BubblewrapBackend();
		case 'win32': return new MxcBackend();
		default: return new UnsupportedBackend(platform);
	}
}

/**
 * SHA-256 over the launch policy's canonical JSON (sorted keys). Network allow entries are
 * broker grants, not launch policy (F.3, F.9), and environment values are left out (only names).
 */
export function policyHash(policy: IResolvedSandboxPolicy): string {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map(canonical);
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
		}
		return value;
	};
	const launch = { ...policy, network: { ...policy.network, allow: [] }, env: Object.keys(policy.env).sort() };
	return createHash('sha256').update(JSON.stringify(canonical(launch))).digest('hex');
}

/**
 * A broker denial as the transcript's target: for one an "Allow" could answer, the rule text it
 * would add (`host`, `host:80`, `host:8443`; no port is 443 under I.4); for any other, the
 * destination and why, which no button offers to allow.
 */
export function denialTarget(denial: Pick<INetworkDenial, 'destination' | 'port' | 'reason'>): string {
	const host = denial.destination.includes(':') && !denial.destination.startsWith('[') ? `[${denial.destination}]` : denial.destination;
	const withPort = denial.port === 443 || !Number.isInteger(denial.port) ? host : `${host}:${denial.port}`;
	return denial.reason === 'not-allowed' || denial.reason === 'port' ? withPort : `${withPort} (${denial.reason})`;
}

/** Removes a run folder the manager made, and nothing else. */
async function removeRunDir(dir: string): Promise<void> {
	if (!basename(dir).startsWith(RUN_PREFIX)) {
		return;
	}
	await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
}

/** Keeps the head and the tail when a stream outgrows its cap. */
class CappedText {
	private head = '';
	private tail = '';
	private dropped = 0;
	truncated = false;

	constructor(private readonly cap: number) { }

	append(data: Buffer): void {
		const text = data.toString('utf8');
		const half = Math.floor(this.cap / 2);
		if (this.head.length < half) {
			const room = half - this.head.length;
			this.head += text.slice(0, room);
			this.tail += text.slice(room);
		} else {
			this.tail += text;
		}
		if (this.tail.length > half) {
			this.dropped += this.tail.length - half;
			this.tail = this.tail.slice(this.tail.length - half);
			this.truncated = true;
		}
	}

	text(): string {
		return this.dropped ? `${this.head}\n[... ${this.dropped} characters dropped ...]\n${this.tail}` : this.head + this.tail;
	}
}
