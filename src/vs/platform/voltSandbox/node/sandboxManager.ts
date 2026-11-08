/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { generateUuid } from '../../../base/common/uuid.js';
import { promises as fs } from 'fs';
import { basename, join } from '../../../base/common/path.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { checkEnforcement, ISandboxBackendCapabilities, ISandboxRunDenial, ISandboxRunResult, redactSandboxText, SandboxBackendId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { IResolvedSandboxPolicy, sandboxProxyEnv } from '../common/sandboxResolved.js';
import { IVoltSandboxPolicy, SandboxDimension } from '../common/sandboxSchema.js';
import { BubblewrapBackend } from './bubblewrapBackend.js';
import { MxcBackend } from './mxcBackend.js';
import { ISandboxBackend, ISandboxLaunchSpec, SandboxConfirmation } from './sandboxBackends.js';
import { SandboxNetworkProxy } from './sandboxProxy.js';
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
	readonly onDenial: Event<ISandboxRunDenial>;
	confirm(child: ChildProcess): Promise<SandboxConfirmation>;
	/** Kills the whole tree: the workload and everything it started. */
	terminate(child: ChildProcess): Promise<void>;
	/** Hosts the proxy lets through from now on (network `proxy`). */
	allowDomains(entries: readonly string[]): void;
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

const RUN_PREFIX = 'volt-sbx-';
/** After the workload exits, how long its output may keep arriving before the run counts as done. */
const EXIT_DRAIN_MS = 250;

export class SandboxManager {

	private readonly backend: ISandboxBackend;
	private host: Promise<ISandboxHostFacts> | undefined;
	private readonly live = new Map<string, { child?: ChildProcess; prepared: IPreparedSandbox }>();

	constructor(
		private readonly logger: ISandboxLogger = { info: () => undefined, warn: () => undefined },
		options: { readonly platform?: string; readonly backend?: ISandboxBackend; readonly runRoot?: string; readonly host?: ISandboxHostFacts } = {},
	) {
		const platform = options.platform ?? process.platform;
		this.backend = options.backend ?? createBackend(platform);
		this.runRoot = options.runRoot;
		if (options.host) {
			this.host = Promise.resolve(options.host);
		}
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
				if (stat && stat.mtimeMs < dayAgo) {
					await removeRunDir(join(root, name));
				}
			}
			return root;
		})();
		return this.runRootReady;
	}

	private runRootReady: Promise<string> | undefined;

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
		let spec: ISandboxLaunchSpec | undefined;
		const cleanup = async () => {
			proxy?.dispose();
			await spec?.dispose().catch(() => undefined);
			denials.dispose();
			await removeRunDir(runDir);
		};
		try {
			const { policy: resolved, notes } = await resolveSandboxPolicy(request.policy, request.context, host, runTmp);
			for (const note of notes) {
				this.logger.info(`[volt-sandbox] ${tag} ${redactSandboxText(note, host.home)}`);
			}
			if (resolved.network.mode === 'proxy') {
				proxy = await SandboxNetworkProxy.start(resolved.network.allow, (target, reason) => denials.fire({ kind: 'network', target: reason === 'not-allowed' ? target : `${target} (${reason})`, source: 'proxy' }));
			}
			const env: Record<string, string> = {
				...resolved.env,
				...(proxy ? sandboxProxyEnv(proxy.port) : {}),
				VOLT_SANDBOX: resolved.name,
				VOLT_SANDBOX_TAG: tag,
				...(resolved.network.mode !== 'host' ? { VOLT_SANDBOX_NETWORK_DISABLED: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1' } : {}),
			};
			const policy: IResolvedSandboxPolicy = { ...resolved, env };
			spec = await this.backend.launch(policy, request.command, request.args ?? [], {
				tag,
				proxyPort: proxy?.port,
				terminal: !!request.terminal,
				onDenial: denial => denials.fire(denial),
			});
			this.logger.info(`[volt-sandbox] ${tag} ${this.backend.id} ${policy.name}${request.label ? ` (${request.label})` : ''} network=${policy.network.mode} unenforced=${check.unenforced.join(',') || 'none'}`);
			const launched = spec;
			let disposed = false;
			const prepared: IPreparedSandbox = {
				tag,
				backend: this.backend.id,
				expectedStatus: check.unenforced.length ? 'partial' : 'initialized',
				unenforced: check.unenforced,
				policy,
				command: launched.command,
				args: launched.args,
				env: launched.env,
				cwd: launched.cwd,
				extraStdio: launched.extraStdio,
				onDenial: denials.event,
				confirm: child => {
					const entry = this.live.get(tag);
					if (entry) {
						entry.child = child;
					}
					return launched.confirm(child);
				},
				terminate: async child => { await launched.terminate(child); },
				allowDomains: entries => proxy?.allow(entries),
				dispose: async () => {
					if (!disposed) {
						disposed = true;
						this.live.delete(tag);
						await cleanup();
					}
				},
			};
			this.live.set(tag, { prepared });
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
		(this.backend as { dispose?(): void }).dispose?.();
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
