/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import type { Duplex } from 'stream';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import type { Socket } from 'net';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../base/common/path.js';
import { IPrincipal, SubjectKey } from '../common/principals.js';
import { composeSandboxPolicy } from '../common/sandboxComposition.js';
import { IAttestation, redactSandboxText, SandboxBackendId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { IVoltSandboxPolicy, parseSandboxPolicyLayer, SandboxDimension } from '../common/sandboxSchema.js';
import { isLiveWorkloadState, ISandboxResourceSample, ISandboxWorkloadInfo, SandboxExitReason, SandboxWorkloadState, summarizeSandboxPolicy } from '../common/sandboxWorkloads.js';
import type { INetworkPrincipalView, NetworkRoute } from './networkBroker.js';
import { PrincipalRegistry } from './principalRegistry.js';
import { IPreparedSandbox, ISandboxLogger, processAlive, RUN_LEDGER_NAME, SandboxManager } from './sandboxManager.js';
import { ISandboxRunContext } from './sandboxResolver.js';

const execFileAsync = promisify(execFile);

/**
 * The Execution Supervisor for long-lived sandboxed hosts (spec F.4-F.11, `lifetime: 'host'`):
 * a plugin host, an MCP server, a helper that keeps running. `SandboxManager` stays the facade for
 * one-shot runs (`prepare`/`run`); every host is still launched through it, so a host gets exactly
 * the launch protocol a command gets: policy resolved, backend launched, the process attested from
 * outside, and only then the go byte (F.5).
 *
 * On top of that the supervisor keeps, per host:
 * - its lifecycle (F.6): launching, attesting, running, idle, backoff, broken, stopping, stopped;
 * - its IPC channel: a Node `ipc` socketpair carried as one more inherited fd (`NODE_CHANNEL_FD`),
 *   opened to the caller only after the go byte. It has no path, so no other sandbox can reach it;
 * - a restart budget with backoff (F.11): 1 s, 2 s, 4 s; the third crash in a minute marks it
 *   broken and keeps the tail of its stderr. A restart recompiles the policy from the caller's
 *   current one (never looser than the caller now says) and runs as a new principal;
 * - idle stop, the host budget (at most N live hosts; over it the least recently used idle host is
 *   stopped, else the start is refused, never co-hosted);
 * - resource accounting events at 1 Hz from the sources it is given (`ISandboxResourceSource`: a
 *   process-table poll here; kernel layers such as cgroups plug in the same way);
 * - its attestation record (F.12);
 * - a ledger in its run folder, so the next start of Volt reaps what a crash of this one left
 *   (F.11). Quitting kills every host's tree.
 *
 * Refusals are a typed result, never a throw and never an unsandboxed retry.
 */

export interface IHostCommand {
	/** An executable and its arguments. */
	readonly file: string;
	readonly args: readonly string[];
}

/** A Node host: Volt's own runtime as Node (`ELECTRON_RUN_AS_NODE`), running `fork` with `args`. */
export interface IHostFork {
	readonly fork: string;
	readonly args?: readonly string[];
	readonly execArgv?: readonly string[];
	/**
	 * Launcher-reserved `VSCODE_*` names the Node host needs (F.7: written last, after the policy's
	 * env): the extension host's entry point and its NLS configuration. Only names in
	 * {@link HOST_RESERVED_ENV} are taken; anything else is refused.
	 */
	readonly reservedEnv?: Readonly<Record<string, string>>;
}

/** The reserved names a Node host may be given (H.1 T3 host). Never a secret: these are fixed values Volt computes. */
export const HOST_RESERVED_ENV: ReadonlySet<string> = new Set([
	'VSCODE_ESM_ENTRYPOINT', 'VSCODE_HANDLES_UNCAUGHT_ERRORS', 'VSCODE_NLS_CONFIG', 'VSCODE_EXTHOST_WILL_SEND_SOCKET', 'VSCODE_DEV',
]);

export interface IHostStartRequest {
	/** Minted by the caller (or the supervisor's registry) before the call. */
	readonly principal: IPrincipal;
	/** "volt.memory plugin host", "mcp: github". */
	readonly label: string;
	readonly command: IHostCommand | IHostFork;
	/** The composed policy, or a function giving the current one: a restart recompiles from it. */
	readonly policy: IVoltSandboxPolicy | (() => IVoltSandboxPolicy | Promise<IVoltSandboxPolicy>);
	readonly context: ISandboxRunContext;
	/** The `NODE_CHANNEL_FD` channel. Default: on for Node hosts, off otherwise. */
	readonly ipc?: boolean;
	/**
	 * `pipe`: the host speaks on stdin and stdout (a stdio MCP server). Like the channel, they are
	 * open to the caller only after the go byte ({@link ISandboxedHost.write}, `onStdout`), and their
	 * traffic is activity. Default: no stdin, stdout dropped.
	 */
	readonly stdio?: 'pipe';
	/** Who the host works for (`chat:<id>`): shown with it, and {@link SandboxSupervisor.stopFor} stops it with them. */
	readonly onBehalfOf?: { readonly subject: SubjectKey; readonly label?: string };
	/**
	 * A raw socketpair for a protocol of the host's own (`volt-plugin/1`, H.3): one more inherited fd
	 * after the backend's, its number in `VOLT_HOST_CHANNEL_FD`. Like the `ipc` channel it has no
	 * path and is handed to the caller only after the go byte.
	 */
	readonly stream?: boolean;
	/** Crash restarts; `maxPerMinute: 0` never restarts. Default 3 (F.11). */
	readonly restart?: { readonly maxPerMinute: number };
	/** No activity (RPC either way, `touch`) for `afterMs`: idle; for `stopAfterMs`: stopped. Default: never. */
	readonly idle?: { readonly afterMs: number; readonly stopAfterMs: number };
	/** Polled limits (F.8): a tree over them is killed (`resource`) and that counts as a crash. */
	readonly limits?: { readonly memoryMB?: number };
	/** What the network broker judges a host that is not a chat by (its manifest, or an MCP server's approved hosts). */
	readonly networkView?: INetworkPrincipalView;
}

/** Which step refused (F.5 rule 5); `policy`: the Policy Authority refused the launch. */
export type SandboxHostRefusal = 'disabled' | 'budget' | 'probe' | 'attest' | 'ipc' | 'launch' | 'policy' | SandboxDimension;

export type HostStartResult =
	| { readonly ok: true; readonly host: ISandboxedHost }
	| { readonly ok: false; readonly refused: SandboxHostRefusal; readonly reason: string };

export interface IHostExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly reason: SandboxExitReason;
	/** Whether the supervisor will start it again (crash within the restart budget). */
	readonly restarting: boolean;
}

export interface ISandboxedHost {
	/** Stable across restarts. */
	readonly id: string;
	/** The current instance: a restart runs as a new principal of the same subject. */
	readonly principal: IPrincipal;
	readonly label: string;
	readonly backend: SandboxBackendId;
	readonly state: SandboxWorkloadState;
	readonly unenforced: readonly SandboxDimension[];
	readonly attestation: IAttestation | undefined;
	/** The process Volt spawned (the sandbox's root), while one runs. */
	readonly pid: number | undefined;
	readonly restarts: number;
	/** Its process exited and the supervisor is handling that exit (closing its channel revokes its principal then). */
	readonly exiting?: boolean;
	readonly lastResources: ISandboxResourceSample | undefined;
	readonly onDidChangeState: Event<SandboxWorkloadState>;
	readonly onExit: Event<IHostExit>;
	readonly onResource: Event<ISandboxResourceSample>;
	/** The `stream` channel while it runs (after the go byte); every byte on it is this host's principal's. */
	readonly channel: Duplex | undefined;
	/** The id its principal is bound to in the registry (the supervisor's `registry`), while it runs. */
	readonly channelId: string | undefined;
	/** Messages from the host on its channel; only after the go byte. */
	readonly onMessage: Event<unknown>;
	/**
	 * Sends on the channel; false when it is not running or has no channel. `handle`: a connected
	 * socket passed along (SCM_RIGHTS on the socketpair), as VS Code hands an extension host its
	 * connection; it has no path, so nothing else can reach it.
	 */
	send(message: unknown, handle?: Socket): boolean;
	/** The host's network broker route (network `proxy`): its live "Allow host" grants go here. */
	networkRoute(): NetworkRoute | undefined;
	/** What a `stdio: 'pipe'` host writes to stdout; only after the go byte. */
	readonly onStdout: Event<string>;
	/** Writes to a `stdio: 'pipe'` host's stdin; false when it is not running or has no stdin. */
	write(data: string): boolean;
	readonly onBehalfOf: IHostStartRequest['onBehalfOf'];
	/** Activity that is not RPC (its view is visible, a tool call is waiting): resets the idle budget. */
	touch(): void;
	/** Stops it and starts it again with the policy recompiled (an OS-level grant changed, F.9). */
	relaunch(reason: string): Promise<boolean>;
	terminate(reason?: SandboxExitReason): Promise<void>;
	/** The last 64 KB of its stderr. */
	stderrTail(): string;
}

/** Where the supervisor gets resource numbers. The polling source is built in; kernel layers (C4) add theirs. */
export interface ISandboxResourceSource {
	readonly id: string;
	/** Numbers per root pid, for the trees under `roots`. A source that cannot measure a tree leaves it out. */
	sample(roots: readonly number[]): Promise<ReadonlyMap<number, Partial<Pick<ISandboxResourceSample, 'cpuMs' | 'memoryBytes' | 'processes'>>>>;
}

export interface ISandboxSupervisorOptions {
	/** The feature flag (`volt.sandbox.supervisor.enabled`); read at every start. Default: on. */
	readonly enabled?: () => boolean;
	/** At most this many live hosts (H.2). Default 24. */
	readonly maxHosts?: number;
	/** The first backoff step; doubles per crash in the window. Default 1 s (F.11). */
	readonly backoffMs?: number;
	/** The restart budget's window. Default 60 s. */
	readonly crashWindowMs?: number;
	/** Resource sampling period for hosts. Default 1 s (F.8). */
	readonly sampleMs?: number;
	/** Default: the process-table poll. */
	readonly resourceSources?: readonly ISandboxResourceSource[];
	/** Binds each host's channel to its principal, mints the principal of a restart, closes it on exit. */
	readonly registry?: PrincipalRegistry;
	/** Volt's runtime for Node hosts. Default: `process.execPath`. */
	readonly nodeRuntime?: string;
}

const DEFAULT_MAX_HOSTS = 24;
const DEFAULT_RESTARTS_PER_MINUTE = 3;
const STDERR_TAIL_BYTES = 64 * 1024;
/** Where a `stream` host finds its channel. */
export const HOST_CHANNEL_FD_ENV = 'VOLT_HOST_CHANNEL_FD';
/** How long a stopping host may take before its exit counts as done anyway. */
const STOP_TIMEOUT_MS = 5_000;
const LEDGER_VERSION = 1;

/** One host's record in its run folder, read back by the next start of Volt (F.11). */
interface IHostLedger {
	readonly version: number;
	readonly ownerPid: number;
	readonly tag: string;
	readonly pid: number;
	readonly principalId: string;
	readonly subject: string;
	readonly label: string;
	readonly startedAt: number;
}

export class SandboxSupervisor extends Disposable {

	private readonly hosts = new Map<string, SandboxHost>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	/** A host started, changed state or went away. */
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private sampler: ReturnType<typeof setInterval> | undefined;
	private sampling = false;
	private readonly sources: readonly ISandboxResourceSource[];
	private disposing = false;

	constructor(
		readonly manager: SandboxManager,
		private readonly logger: ISandboxLogger = { info: () => undefined, warn: () => undefined },
		private readonly options: ISandboxSupervisorOptions = {},
	) {
		super();
		this.sources = options.resourceSources ?? [new PollingResourceSource()];
	}

	get enabled(): boolean {
		return this.options.enabled?.() ?? true;
	}

	/**
	 * Starts a host and resolves once it is attested and told to go (F.4, F.5). Never throws, and
	 * never runs anything unsandboxed: a refusal says which step refused.
	 */
	async start(request: IHostStartRequest): Promise<HostStartResult> {
		if (this.disposing) {
			return { ok: false, refused: 'disabled', reason: 'Volt is quitting.' };
		}
		if (!this.enabled) {
			return { ok: false, refused: 'disabled', reason: 'Sandboxed hosts are turned off (volt.sandbox.supervisor.enabled).' };
		}
		const ipc = request.ipc ?? ('fork' in request.command && !request.stream);
		if ((ipc || request.stream) && this.manager.backendId === 'mxc') {
			// Windows channels are named pipes with a DACL for the container (F.5 step 4); not built yet.
			return { ok: false, refused: 'ipc', reason: 'A host channel is not available on Windows yet.' };
		}
		const room = await this.makeRoom();
		if (!room) {
			return { ok: false, refused: 'budget', reason: `At most ${this.maxHosts} sandboxed hosts run at once, and none is idle.` };
		}
		const host = new SandboxHost(randomBytes(8).toString('hex'), request, ipc, this, this.logger);
		this.hosts.set(host.id, host);
		const refusal = await host.launch();
		if (refusal) {
			this.hosts.delete(host.id);
			host.dispose();
			this._onDidChange.fire();
			return { ok: false, ...refusal };
		}
		this.ensureSampler();
		return { ok: true, host };
	}

	/** Every host, live or broken (stopped ones leave the list). */
	list(): readonly ISandboxedHost[] {
		return [...this.hosts.values()];
	}

	/** The Security page's rows: every sandboxed process this host runs, hosts and one-shot runs, with fresh resource numbers. */
	async workloads(): Promise<ISandboxWorkloadInfo[]> {
		const hostTags = new Set([...this.hosts.values()].map(host => host.tag).filter((tag): tag is string => !!tag));
		const commands = this.manager.workloads().filter(row => !hostTags.has(row.id));
		const pids = new Map<string, number>();
		for (const row of commands) {
			const pid = this.manager.processOf(row.id)?.pid;
			if (pid) {
				pids.set(row.id, pid);
			}
		}
		const samples = await this.sample([...pids.values()]);
		const rows: ISandboxWorkloadInfo[] = commands.map(row => {
			const sample = samples.get(pids.get(row.id) ?? -1);
			return sample ? { ...row, resources: sample } : row;
		});
		for (const host of this.hosts.values()) {
			rows.push(host.info());
		}
		return rows.sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Stops host or run `id` (a host's id or a run's tag) and its whole tree. */
	async stop(id: string): Promise<boolean> {
		const host = this.hosts.get(id) ?? [...this.hosts.values()].find(candidate => candidate.tag === id);
		if (host) {
			await host.terminate('stopped');
			return true;
		}
		return this.manager.stop(id);
	}

	/** Stops every host working for `subject` (a chat that closed, or whose grants were revoked) with their trees. Returns how many. */
	async stopFor(subject: SubjectKey, reason: SandboxExitReason = 'stopped'): Promise<number> {
		const hosts = [...this.hosts.values()].filter(host => host.onBehalfOf?.subject === subject && host.state !== 'stopped' && host.state !== 'failed');
		await Promise.all(hosts.map(host => host.terminate(reason)));
		return hosts.length;
	}

	/**
	 * F.11: the run folders a crashed Volt left behind. Each host's ledger names its owner; one
	 * whose owner is gone has its surviving processes (found by the run's tag) killed and its folder
	 * removed. Folders of another live Volt process are left alone. Returns how many it reaped.
	 */
	async recover(): Promise<number> {
		if (!this.enabled) {
			return 0;
		}
		const root = await this.manager.runRootPath();
		let reaped = 0;
		for (const name of await fs.readdir(root).catch(() => [] as string[])) {
			if (!name.startsWith('volt-sbx-')) {
				continue;
			}
			const dir = join(root, name);
			const ledger = await readLedger(join(dir, RUN_LEDGER_NAME));
			if (!ledger || ledger.ownerPid === process.pid || processAlive(ledger.ownerPid)) {
				continue;
			}
			const killed = await killTagged(ledger.tag);
			this.logger.info(`[volt-sandbox] reaped host ${ledger.tag} (${ledger.label}) left by process ${ledger.ownerPid}: ${killed} process(es) killed`);
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
			reaped++;
		}
		return reaped;
	}

	// --- for SandboxHost ---------------------------------------------------------------------------

	get maxHosts(): number {
		return this.options.maxHosts ?? DEFAULT_MAX_HOSTS;
	}

	get backoffMs(): number {
		return this.options.backoffMs ?? 1_000;
	}

	get crashWindowMs(): number {
		return this.options.crashWindowMs ?? 60_000;
	}

	get registry(): PrincipalRegistry | undefined {
		return this.options.registry;
	}

	get nodeRuntime(): string {
		return this.options.nodeRuntime ?? process.execPath;
	}

	get quitting(): boolean {
		return this.disposing;
	}

	/** Called by a host that reached a final state. */
	forget(host: SandboxHost): void {
		if (host.state === 'stopped' || host.state === 'failed') {
			this.hosts.delete(host.id);
			host.dispose();
		}
		this._onDidChange.fire();
	}

	/** Called by a host whose state changed. */
	changed(host: SandboxHost): void {
		if (host.state === 'running') {
			this.ensureSampler();
		}
		this._onDidChange.fire();
	}

	/** Under the budget, or made so by stopping the least recently used idle host. */
	private async makeRoom(): Promise<boolean> {
		const live = [...this.hosts.values()].filter(host => isLiveWorkloadState(host.state));
		if (live.length < this.maxHosts) {
			return true;
		}
		const idle = live.filter(host => host.state === 'idle').sort((a, b) => a.lastActivity - b.lastActivity)[0];
		if (!idle) {
			return false;
		}
		this.logger.info(`[volt-sandbox] host budget (${this.maxHosts}) reached: stopping idle host ${idle.label}`);
		await idle.terminate('budget');
		return true;
	}

	private ensureSampler(): void {
		const ms = this.options.sampleMs ?? 1_000;
		if (this.sampler || ms <= 0) {
			return;
		}
		this.sampler = setInterval(() => void this.tick(), ms);
		// Accounting must not keep Volt (or a test run) alive.
		(this.sampler as { unref?(): void }).unref?.();
	}

	private async tick(): Promise<void> {
		if (this.sampling) {
			return;
		}
		const running = [...this.hosts.values()].filter(host => (host.state === 'running' || host.state === 'idle') && host.pid);
		if (!running.length) {
			// No timers while nothing runs.
			clearInterval(this.sampler);
			this.sampler = undefined;
			return;
		}
		this.sampling = true;
		try {
			const samples = await this.sample(running.map(host => host.pid!));
			for (const host of running) {
				const sample = host.pid ? samples.get(host.pid) : undefined;
				if (sample) {
					host.recordSample(sample);
				}
			}
		} finally {
			this.sampling = false;
		}
	}

	/** One sample per root from every source; a later source's numbers win (a kernel layer over the poll). */
	private async sample(roots: readonly number[]): Promise<Map<number, ISandboxResourceSample>> {
		const out = new Map<number, ISandboxResourceSample>();
		if (!roots.length) {
			return out;
		}
		const at = Date.now();
		const results = await Promise.all(this.sources.map(source => source.sample(roots).then(values => ({ source, values }), () => undefined)));
		for (const root of roots) {
			let merged: { cpuMs: number; memoryBytes: number; processes: number } | undefined;
			const used: string[] = [];
			for (const result of results) {
				const value = result?.values.get(root);
				if (!result || !value) {
					continue;
				}
				merged = { cpuMs: value.cpuMs ?? merged?.cpuMs ?? 0, memoryBytes: value.memoryBytes ?? merged?.memoryBytes ?? 0, processes: value.processes ?? merged?.processes ?? 0 };
				used.push(result.source.id);
			}
			if (merged) {
				out.set(root, { at, ...merged, sources: used });
			}
		}
		return out;
	}

	/** Volt quits: every host's whole tree goes, before the manager disposes its runs. */
	shutdown(): Promise<void> {
		// Once: `dispose` (synchronous, for the owner's disposables) and an owner awaiting it share the same kills.
		this.shutdownDone ??= (async () => {
			this.disposing = true;
			clearInterval(this.sampler);
			this.sampler = undefined;
			await Promise.all([...this.hosts.values()].map(host => host.terminate('quit').catch(() => undefined)));
		})();
		return this.shutdownDone;
	}

	private shutdownDone: Promise<void> | undefined;

	override dispose(): void {
		void this.shutdown();
		for (const host of this.hosts.values()) {
			host.dispose();
		}
		this.hosts.clear();
		super.dispose();
	}
}

/** One long-lived host: its launches, its channel, its budgets. */
class SandboxHost implements ISandboxedHost {

	private _state: SandboxWorkloadState = 'launching';
	private _principal: IPrincipal;
	private prepared: IPreparedSandbox | undefined;
	private child: ChildProcess | undefined;
	private exited: Promise<void> | undefined;
	private stopReason: SandboxExitReason | undefined;
	private relaunching = false;
	private backoffTimer: ReturnType<typeof setTimeout> | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private crashes: number[] = [];
	private stderr = '';
	private _channelId: string | undefined;
	private _channel: Duplex | undefined;
	private _backend: SandboxBackendId;
	private _attestation: IAttestation | undefined;
	private _restarts = 0;
	private _lastResources: ISandboxResourceSample | undefined;
	private detail: string | undefined;
	private disposed = false;
	/** Its process has exited and the exit is being handled: it is not a host anyone can stop now. */
	private _exiting = false;
	readonly startedAt = Date.now();
	lastActivity = Date.now();
	tag: string | undefined;

	get exiting(): boolean {
		return this._exiting;
	}

	private readonly _onDidChangeState = new Emitter<SandboxWorkloadState>();
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onExit = new Emitter<IHostExit>();
	readonly onExit = this._onExit.event;
	private readonly _onResource = new Emitter<ISandboxResourceSample>();
	readonly onResource = this._onResource.event;
	/** Messages that came before anyone listened (a host may speak first): delivered to the first listener. */
	private unheard: unknown[] = [];
	private readonly _onMessage = new Emitter<unknown>({
		onDidAddFirstListener: () => queueMicrotask(() => {
			const pending = this.unheard;
			this.unheard = [];
			for (const message of pending) {
				this._onMessage.fire(message);
			}
		}),
	});
	readonly onMessage = this._onMessage.event;
	private readonly _onStdout = new Emitter<string>({ onDidAddFirstListener: () => this.flushStdout() });
	readonly onStdout = this._onStdout.event;
	private stdoutBuffer: string[] = [];
	/** The current instance got its go byte: its stdin and stdout are the caller's. */
	private released = false;

	constructor(
		readonly id: string,
		private readonly request: IHostStartRequest,
		private readonly ipc: boolean,
		private readonly supervisor: SandboxSupervisor,
		private readonly logger: ISandboxLogger,
	) {
		this._principal = request.principal;
		this._backend = supervisor.manager.backendId;
	}

	get principal(): IPrincipal { return this._principal; }
	get label(): string { return this.request.label; }
	get onBehalfOf(): IHostStartRequest['onBehalfOf'] { return this.request.onBehalfOf; }
	get backend(): SandboxBackendId { return this._backend; }
	get state(): SandboxWorkloadState { return this._state; }
	get unenforced(): readonly SandboxDimension[] { return this.prepared?.unenforced ?? this._attestation?.unenforced ?? []; }
	get attestation(): IAttestation | undefined { return this._attestation; }
	get pid(): number | undefined { return this._state === 'running' || this._state === 'idle' || this._state === 'stopping' ? this.child?.pid : undefined; }
	get restarts(): number { return this._restarts; }
	get channel(): Duplex | undefined { return this._state === 'running' || this._state === 'idle' ? this._channel : undefined; }
	get channelId(): string | undefined { return this._channelId; }
	get lastResources(): ISandboxResourceSample | undefined { return this._lastResources; }

	stderrTail(): string {
		return this.stderr;
	}

	info(): ISandboxWorkloadInfo {
		const policy = this.prepared?.policy;
		const unenforced = this.unenforced;
		return {
			id: this.id,
			principalId: this._principal.id,
			subject: this._principal.subject,
			label: this.label,
			...(this.request.onBehalfOf ? { onBehalfOf: this.request.onBehalfOf } : {}),
			lifetime: 'host',
			backend: this._backend,
			state: this._state,
			status: unenforced.length ? 'partial' : 'sandboxed',
			unenforced,
			...(this._attestation ? { attestation: this._attestation } : {}),
			policy: policy ? summarizeSandboxPolicy(policy) : { name: this.label, network: 'none', allowedHosts: 0, readsEverything: false, read: [], write: [], denied: 0, limits: {} },
			startedAt: this.startedAt,
			restarts: this._restarts,
			...(this._lastResources ? { resources: this._lastResources } : {}),
			...(this.detail ? { detail: this.detail } : {}),
		};
	}

	private setState(state: SandboxWorkloadState): void {
		if (this._state !== state) {
			this._state = state;
			if (!this.disposed) {
				this._onDidChangeState.fire(state);
				this.supervisor.changed(this);
			}
		}
	}

	/** One launch: policy, prepare, spawn, attest, go. Undefined when it runs; else why it refused. */
	async launch(): Promise<{ refused: SandboxHostRefusal; reason: string } | undefined> {
		this._exiting = false;
		this.setState('launching');
		this.released = false;
		this.stdoutBuffer = [];
		const request = this.request;
		let policy: IVoltSandboxPolicy;
		try {
			policy = typeof request.policy === 'function' ? await request.policy() : request.policy;
		} catch (err) {
			return this.fail('launch', `The host's policy could not be computed: ${(err as Error).message}`);
		}
		const fork = 'fork' in request.command ? request.command : undefined;
		let file: string;
		let args: string[];
		const reserved = Object.entries(fork?.reservedEnv ?? {});
		const unknownReserved = reserved.find(([name]) => !HOST_RESERVED_ENV.has(name));
		if (unknownReserved) {
			return this.fail('launch', `${unknownReserved[0]} is not a name a host may be given.`);
		}
		if (fork) {
			const runtime = this.supervisor.nodeRuntime;
			// The runtime must be readable inside: its bundle, as a trusted layer over the caller's policy.
			const layer = parseSandboxPolicyLayer({ schemaVersion: 1, filesystem: { read: [await runtimeRoot(runtime)] } });
			if (!layer.ok) {
				return this.fail('launch', `Volt's runtime folder cannot be named in a policy: ${layer.errors.map(error => error.message).join('; ')}`);
			}
			policy = composeSandboxPolicy(policy, [{ source: 'execution', trusted: true, layer: layer.value }]).policy;
			file = runtime;
			// No debugger by signal (INV-30); the caller's flags after Volt's.
			args = ['--disable-sigusr1', ...(fork.execArgv ?? []), fork.fork, ...(fork.args ?? [])];
		} else {
			const command = request.command as IHostCommand;
			file = command.file;
			args = [...command.args];
		}
		let prepared: IPreparedSandbox;
		try {
			prepared = await this.supervisor.manager.prepare({ command: file, args, policy, context: request.context, label: request.label, principal: this._principal, ...(request.networkView ? { networkView: request.networkView } : {}) });
		} catch (err) {
			if (err instanceof SandboxUnavailableError) {
				return this.fail(err.blocking[0] ?? 'probe', err.message);
			}
			return this.fail('launch', (err as Error).message);
		}
		this.prepared = prepared;
		this.tag = prepared.tag;
		this._backend = prepared.backend;
		const piped = request.stdio === 'pipe';
		let child: ChildProcess;
		const streamFd = request.stream ? 3 + prepared.extraStdio.length : undefined;
		try {
			child = spawn(prepared.command, [...prepared.args], {
				cwd: prepared.cwd,
				// Reserved names last (F.7): Node as Node; `NODE_CHANNEL_FD` Node itself adds for the `ipc` entry.
				env: { ...prepared.env, ...Object.fromEntries(reserved), ...(fork ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...(streamFd !== undefined ? { [HOST_CHANNEL_FD_ENV]: String(streamFd) } : {}) },
				stdio: [piped ? 'pipe' : 'ignore', piped ? 'pipe' : 'ignore', 'pipe', ...prepared.extraStdio, ...(streamFd !== undefined ? ['pipe' as const] : []), ...(this.ipc ? ['ipc' as const] : [])],
				detached: true,
				windowsHide: true,
			});
		} catch (err) {
			await prepared.dispose();
			this.prepared = undefined;
			return this.fail('launch', (err as Error).message);
		}
		this.child = child;
		child.stderr?.on('data', (data: Buffer) => {
			this.stderr = (this.stderr + data.toString('utf8')).slice(-STDERR_TAIL_BYTES);
		});
		if (piped) {
			// A host that exits while Volt writes must not take Volt down with EPIPE.
			child.stdin?.on('error', () => undefined);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (data: string) => {
				// Nothing reaches the caller before the go byte (F.5 step 4); the workload has not run before it anyway.
				if (this.child !== child || !this.released) {
					return;
				}
				if (this._state === 'running' || this._state === 'idle') {
					this.activity();
				}
				if (this._onStdout.hasListeners()) {
					this._onStdout.fire(data);
				} else {
					// Between the go byte and the caller's first listener: kept, not lost.
					this.stdoutBuffer.push(data);
				}
			});
		}
		this.exited = new Promise<void>(resolve => {
			let done = false;
			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
				if (!done) {
					done = true;
					void this.onChildExit(child, prepared, code, signal).finally(resolve);
				}
			};
			child.once('exit', finish);
			child.once('error', () => finish(null, null));
		});
		this.setState('attesting');
		const confirmation = await prepared.confirm(child);
		if (!confirmation.ok) {
			this.stopReason = 'refused';
			await prepared.terminate(child);
			await this.exited;
			return this.fail('attest', redactSandboxText(confirmation.error, prepared.policy.home));
		}
		if (this.stopReason) {
			// Stopped while it was being attested: it never gets to run.
			await prepared.terminate(child);
			await this.exited;
			return this.fail('launch', 'It was stopped while it started.');
		}
		this._attestation = prepared.attestation();
		this.released = true;
		// Only now is the channel open to anyone (F.5 step 4).
		if (streamFd !== undefined) {
			const stream = child.stdio[streamFd] as Duplex | null;
			if (!stream) {
				this.stopReason = 'refused';
				await prepared.terminate(child);
				await this.exited;
				return this.fail('ipc', 'The host\'s channel could not be opened.');
			}
			stream.on('error', () => undefined);
			stream.on('data', () => {
				if (this._state === 'running' || this._state === 'idle') {
					this.activity();
				}
			});
			this._channel = stream;
		}
		if (this.ipc) {
			child.on('message', message => {
				if (this._state === 'running' || this._state === 'idle') {
					this.activity();
					if (this._onMessage.hasListeners()) {
						this._onMessage.fire(message);
					} else if (this.unheard.length < 64) {
						this.unheard.push(message);
					}
				}
			});
			child.on('error', () => undefined);
		}
		if ((this.ipc || this._channel) && this.supervisor.registry) {
			this._channelId = `host:${this.id}:${prepared.tag}`;
			try {
				this.supervisor.registry.bind(this._channelId, this._principal);
			} catch (err) {
				this.logger.warn(`[volt-sandbox] host ${this.label}: its principal could not be bound to the channel: ${(err as Error).message}`);
				this._channelId = undefined;
			}
		}
		this.lastActivity = Date.now();
		// Running before the ledger write, so a host's first message (it may send one at once) is not dropped.
		this.setState('running');
		await this.writeLedger(prepared, child);
		this.scheduleIdle();
		this.logger.info(`[volt-sandbox] host ${this.label} ${prepared.tag} running (${this._backend}, pid ${child.pid}, policy ${prepared.launchPolicyHash.slice(0, 12)}${this._restarts ? `, restart ${this._restarts}` : ''})`);
		return undefined;
	}

	private fail(refused: SandboxHostRefusal, reason: string): { refused: SandboxHostRefusal; reason: string } {
		this.detail = reason;
		this.setState('failed');
		this.logger.warn(`[volt-sandbox] host ${this.label} refused (${refused}): ${reason}`);
		return { refused, reason };
	}

	private async writeLedger(prepared: IPreparedSandbox, child: ChildProcess): Promise<void> {
		const dir = dirname(prepared.policy.tmp);
		if (!basename(dir).startsWith('volt-sbx-') || !child.pid) {
			return;
		}
		const ledger: IHostLedger = {
			version: LEDGER_VERSION, ownerPid: process.pid, tag: prepared.tag, pid: child.pid,
			principalId: this._principal.id, subject: this._principal.subject, label: this.request.label, startedAt: Date.now(),
		};
		const file = join(dir, RUN_LEDGER_NAME);
		const temp = `${file}.${process.pid}.tmp`;
		try {
			await fs.writeFile(temp, JSON.stringify(ledger), { mode: 0o600 });
			await fs.rename(temp, file);
		} catch (err) {
			this.logger.warn(`[volt-sandbox] host ${this.label}: no ledger (${(err as Error).message}); a crash of Volt would leave it to the watchdog`);
		}
	}

	private async onChildExit(child: ChildProcess, prepared: IPreparedSandbox, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		clearTimeout(this.idleTimer);
		this._exiting = true;
		const wasRunning = this._state === 'running' || this._state === 'idle' || this._state === 'stopping';
		// Nothing the host started may outlive it.
		await prepared.terminate(child).catch(() => undefined);
		for (const stream of child.stdio) {
			stream?.destroy();
		}
		if (child.connected) {
			child.disconnect();
		}
		if (this._channelId) {
			this.supervisor.registry?.closeChannel(this._channelId);
			this._channelId = undefined;
		}
		this._channel = undefined;
		await prepared.dispose();
		if (this.prepared === prepared) {
			this.child = undefined;
		}
		if (!wasRunning || this.stopReason === 'refused') {
			return; // The launch path reports it.
		}
		const reason: SandboxExitReason = this.stopReason ?? (this.relaunching ? 'stopped' : code === 0 ? 'exit' : 'crash');
		const restart = this.relaunching || ((reason === 'crash' || reason === 'resource') && !this.supervisor.quitting && this.withinBudget());
		this._onExit.fire({ code, signal, reason, restarting: restart });
		this.logger.info(`[volt-sandbox] host ${this.label} ${prepared.tag} exited (${reason}, ${signal ?? code})${restart ? ', restarting' : ''}`);
		if (restart) {
			const delay = this.relaunching ? 0 : this.supervisor.backoffMs * 2 ** (this.recentCrashes() - 1);
			this.relaunching = false;
			this.stopReason = undefined;
			this.setState('backoff');
			this.backoffTimer = setTimeout(() => void this.restart(), delay);
			return;
		}
		if (reason === 'crash' || reason === 'resource') {
			const last = this.stderr.trim().split('\n').pop();
			this.detail = `Stopped after ${this.recentCrashes()} crashes in ${Math.round(this.supervisor.crashWindowMs / 1000)} s${last ? `: ${redactSandboxText(last, prepared.policy.home)}` : ''}`;
			this.setState('broken');
		} else {
			this.detail = reason;
			this.setState('stopped');
		}
		this.supervisor.forget(this);
	}

	/** Records this crash; true while the host may still restart (F.11). */
	private withinBudget(): boolean {
		const max = this.request.restart?.maxPerMinute ?? DEFAULT_RESTARTS_PER_MINUTE;
		this.crashes.push(Date.now());
		return max > 0 && this.recentCrashes() < max;
	}

	private recentCrashes(): number {
		const since = Date.now() - this.supervisor.crashWindowMs;
		this.crashes = this.crashes.filter(at => at >= since);
		return this.crashes.length;
	}

	private async restart(): Promise<void> {
		this.backoffTimer = undefined;
		if (this.disposed || this.stopReason || this.supervisor.quitting) {
			this.setState('stopped');
			this.supervisor.forget(this);
			return;
		}
		// Same subject, new principal (F.4): the old one's channel is closed already.
		const previous = this._principal;
		this._principal = this.supervisor.registry
			? this.supervisor.registry.mint({ subject: previous.subject, kind: previous.kind, launchPolicyHash: '', ...(previous.packageDigest ? { packageDigest: previous.packageDigest } : {}), ...(previous.signer ? { signer: previous.signer } : {}), ...(previous.parent && this.supervisor.registry.isLive(previous.parent) ? { parent: previous.parent } : {}) })
			: Object.freeze({ ...previous, id: randomBytes(16).toString('base64url'), createdAt: Date.now() });
		this._restarts++;
		this._attestation = undefined;
		const refusal = await this.launch();
		if (refusal) {
			// A restart that is refused does not run anything; the host is broken, with the reason.
			this.detail = refusal.reason;
			this.setState('broken');
			this.supervisor.forget(this);
		}
	}

	private activity(): void {
		this.lastActivity = Date.now();
		if (this._state === 'idle') {
			this.setState('running');
		}
		this.scheduleIdle();
	}

	private scheduleIdle(): void {
		const idle = this.request.idle;
		if (!idle) {
			return;
		}
		clearTimeout(this.idleTimer);
		const now = Date.now();
		const quietFor = now - this.lastActivity;
		if (this._state === 'running') {
			this.idleTimer = setTimeout(() => {
				if (this._state === 'running' && Date.now() - this.lastActivity >= idle.afterMs) {
					this.setState('idle');
				}
				this.scheduleIdle();
			}, Math.max(0, idle.afterMs - quietFor));
		} else if (this._state === 'idle') {
			this.idleTimer = setTimeout(() => {
				if (this._state === 'idle' && Date.now() - this.lastActivity >= idle.stopAfterMs) {
					void this.terminate('idle');
				} else {
					this.scheduleIdle();
				}
			}, Math.max(0, idle.stopAfterMs - quietFor));
		}
	}

	recordSample(sample: ISandboxResourceSample): void {
		this._lastResources = sample;
		this._onResource.fire(sample);
		const limit = this.request.limits?.memoryMB;
		if (limit !== undefined && sample.memoryBytes > limit * 1024 * 1024 && this._state === 'running') {
			this.logger.warn(`[volt-sandbox] host ${this.label} uses ${Math.round(sample.memoryBytes / 1048576)} MB, over its ${limit} MB: killed`);
			this.stopReason = 'resource';
			void this.kill();
		}
	}

	send(message: unknown, handle?: Socket): boolean {
		const child = this.child;
		if (!this.ipc || !child?.connected || (this._state !== 'running' && this._state !== 'idle')) {
			return false;
		}
		this.activity();
		return handle ? child.send(message as object, handle) : child.send(message as object);
	}

	networkRoute(): NetworkRoute | undefined {
		return this.prepared?.networkRoute();
	}

	write(data: string): boolean {
		const stdin = this.child?.stdin;
		if (this.request.stdio !== 'pipe' || !this.released || !stdin?.writable || (this._state !== 'running' && this._state !== 'idle')) {
			return false;
		}
		this.activity();
		stdin.write(data);
		return true;
	}

	private flushStdout(): void {
		const pending = this.stdoutBuffer;
		this.stdoutBuffer = [];
		for (const data of pending) {
			this._onStdout.fire(data);
		}
	}

	touch(): void {
		if (this._state === 'running' || this._state === 'idle') {
			this.activity();
		}
	}

	async relaunch(reason: string): Promise<boolean> {
		if (this._state !== 'running' && this._state !== 'idle') {
			return false;
		}
		this.logger.info(`[volt-sandbox] host ${this.label}: relaunch (${reason})`);
		this.relaunching = true;
		await this.kill();
		return true;
	}

	async terminate(reason: SandboxExitReason = 'stopped'): Promise<void> {
		if (this._state === 'stopped' || this._state === 'failed' || this._state === 'broken') {
			if (this._state === 'broken' && reason === 'stopped') {
				// A broken host leaves the list when the user dismisses it.
				this.setState('stopped');
				this.supervisor.forget(this);
			}
			return;
		}
		this.stopReason = reason;
		this.relaunching = false;
		if (this.backoffTimer) {
			clearTimeout(this.backoffTimer);
			this.backoffTimer = undefined;
			this.detail = reason;
			this.setState('stopped');
			this.supervisor.forget(this);
			return;
		}
		await this.kill();
	}

	private async kill(): Promise<void> {
		const child = this.child;
		const prepared = this.prepared;
		if (!child || !prepared) {
			return;
		}
		if (this._state === 'running' || this._state === 'idle') {
			this.setState('stopping');
		}
		await prepared.terminate(child).catch(() => undefined);
		const exited = this.exited;
		if (exited) {
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))]);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.idleTimer);
		clearTimeout(this.backoffTimer);
		for (const emitter of [this._onDidChangeState, this._onExit, this._onResource, this._onMessage, this._onStdout] as Emitter<unknown>[]) {
			emitter.dispose();
		}
	}
}

/** What a Node host must read to start: on macOS the whole `.app` (the framework is outside `MacOS/`), else the runtime's folder. */
async function runtimeRoot(runtime: string): Promise<string> {
	const real = await fs.realpath(runtime).catch(() => runtime);
	const app = real.indexOf('.app/');
	return process.platform === 'darwin' && app > 0 ? real.slice(0, app + 4) : dirname(real);
}

async function readLedger(file: string): Promise<IHostLedger | undefined> {
	const text = await fs.readFile(file, 'utf8').catch(() => undefined);
	if (!text) {
		return undefined;
	}
	try {
		const value = JSON.parse(text) as Partial<IHostLedger>;
		if (value.version === LEDGER_VERSION && typeof value.ownerPid === 'number' && value.ownerPid > 0 && typeof value.tag === 'string' && /^[a-f0-9]{16}$/.test(value.tag) && typeof value.label === 'string') {
			return value as IHostLedger;
		}
	} catch {
		// Torn or foreign: not a ledger.
	}
	return undefined;
}

interface IProcessEntry {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly rssBytes: number;
	readonly cpuMs: number;
	readonly tagged?: boolean;
}

/**
 * Kills every process still carrying `VOLT_SANDBOX_TAG=<tag>`, everything below them, and the rest
 * of their process groups (a run is spawned detached, so its group is its own; on macOS the
 * environment of platform binaries such as `/bin/sleep` cannot be read, so the group is how they
 * are found). Only through tagged processes: a pid or process group from a ledger may have been
 * reused since. Returns how many were signalled.
 */
export async function killTagged(tag: string): Promise<number> {
	if (!/^[a-f0-9]{8,64}$/.test(tag) || process.platform === 'win32') {
		return 0; // Windows: the MXC job closed with its owner.
	}
	const table = await processTable(`VOLT_SANDBOX_TAG=${tag}`);
	const children = new Map<number, number[]>();
	const groups = new Map<number, number[]>();
	for (const row of table) {
		children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
		groups.set(row.pgid, [...(groups.get(row.pgid) ?? []), row.pid]);
	}
	// Never Volt's own group (nor launchd's / init's).
	const ownGroup = table.find(row => row.pid === process.pid)?.pgid;
	const tagged = table.filter(row => row.tagged);
	const doomed = new Set<number>();
	const queue = [...tagged.map(row => row.pid), ...tagged.flatMap(row => row.pgid > 1 && row.pgid !== ownGroup ? groups.get(row.pgid) ?? [] : [])];
	while (queue.length) {
		const pid = queue.pop()!;
		if (pid === process.pid || doomed.has(pid)) {
			continue;
		}
		doomed.add(pid);
		queue.push(...(children.get(pid) ?? []));
	}
	for (const pid of doomed) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Gone already.
		}
	}
	return doomed.size;
}

/** Every process of this user: pid, parent, group, resident memory, CPU so far, and whether its environment holds `needle`. */
async function processTable(needle?: string): Promise<IProcessEntry[]> {
	if (process.platform === 'linux') {
		return linuxProcessTable(needle);
	}
	try {
		// `-E` appends the environment (visible for this user's non-platform processes), which is where the tag is.
		const { stdout } = await execFileAsync('/bin/ps', [...(needle ? ['-E', '-ww'] : []), '-axo', `pid=,ppid=,pgid=,rss=,time=${needle ? ',command=' : ''}`], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
		const rows: IProcessEntry[] = [];
		for (const line of stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s(.*))?$/.exec(line);
			if (match) {
				rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssBytes: Number(match[4]) * 1024, cpuMs: parseCpuTime(match[5]), ...(needle ? { tagged: (match[6] ?? '').includes(needle) } : {}) });
			}
		}
		return rows;
	} catch {
		return [];
	}
}

/** `ps` CPU time: `[[dd-]hh:]mm:ss[.cc]`. */
export function parseCpuTime(text: string): number {
	const [days, rest] = text.includes('-') ? [Number(text.split('-')[0]), text.split('-')[1]] : [0, text];
	const parts = rest.split(':').map(Number);
	let seconds = 0;
	for (const part of parts) {
		seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
	}
	return Math.round((days * 86400 + seconds) * 1000);
}

/** `/proc`: ppid, CPU (clock ticks of 10 ms) and resident pages from each `stat`; the tag from `environ`. */
async function linuxProcessTable(needle?: string): Promise<IProcessEntry[]> {
	const names = await fs.readdir('/proc').catch(() => [] as string[]);
	const pageSize = 4096;
	const rows = await Promise.all(names.filter(name => /^\d+$/.test(name)).map(async name => {
		const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
		const close = stat?.lastIndexOf(')') ?? -1;
		if (!stat || close < 0) {
			return undefined;
		}
		// After "pid (comm) ": state(3) ppid(4) pgrp(5) ... utime(14) stime(15) ... rss(24).
		const fields = stat.slice(close + 2).split(' ');
		const ppid = Number(fields[1]);
		const pgid = Number(fields[2]);
		const ticks = Number(fields[11]) + Number(fields[12]);
		const rss = Number(fields[21]);
		let tagged: boolean | undefined;
		if (needle) {
			const environ = await fs.readFile(`/proc/${name}/environ`, 'latin1').catch(() => '');
			tagged = environ.split('\0').includes(needle);
		}
		return { pid: Number(name), ppid, pgid, rssBytes: rss * pageSize, cpuMs: ticks * 10, ...(tagged !== undefined ? { tagged } : {}) } satisfies IProcessEntry;
	}));
	return rows.filter((row): row is NonNullable<typeof row> => !!row);
}

/** The built-in accounting (F.8 on macOS and Windows; on Linux until cgroups land): one process-table read for every tree. */
export class PollingResourceSource implements ISandboxResourceSource {

	readonly id = 'poll';

	async sample(roots: readonly number[]): Promise<ReadonlyMap<number, { cpuMs: number; memoryBytes: number; processes: number }>> {
		const out = new Map<number, { cpuMs: number; memoryBytes: number; processes: number }>();
		if (process.platform === 'win32') {
			return out;
		}
		const table = await processTable();
		const byPid = new Map(table.map(row => [row.pid, row]));
		const children = new Map<number, number[]>();
		for (const row of table) {
			children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
		}
		for (const root of roots) {
			if (!byPid.has(root)) {
				continue;
			}
			let cpuMs = 0;
			let memoryBytes = 0;
			let processes = 0;
			const seen = new Set<number>();
			const queue = [root];
			while (queue.length) {
				const pid = queue.pop()!;
				const row = byPid.get(pid);
				if (!row || seen.has(pid)) {
					continue;
				}
				seen.add(pid);
				cpuMs += row.cpuMs;
				memoryBytes += row.rssBytes;
				processes++;
				queue.push(...(children.get(pid) ?? []));
			}
			out.set(root, { cpuMs, memoryBytes, processes });
		}
		return out;
	}
}
