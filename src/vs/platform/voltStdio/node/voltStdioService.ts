/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { basename, delimiter, dirname, join } from '../../../base/common/path.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { resolvedPolicyAllows } from '../../voltSandbox/common/sandboxResolved.js';
import { ISandboxLaunch, VoltSandboxLauncher } from '../../voltSandbox/node/sandboxLauncher.js';
import { ChildLedger } from './childLedger.js';
import { IVoltExecFileRequest, IVoltExecFileResult, IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltSandboxEvent, IVoltSandboxStateSync, IVoltSandboxSupportInfo, IVoltStdioService, IVoltStdioSpawnOptions } from '../common/voltStdio.js';

const execFileAsync = promisify(execFile);

/** Output kept in memory per command. Beyond this the middle is dropped (head is always kept). */
const MAX_BUFFER_CHARS = 4_000_000;
const HEAD_CHARS = 16_000;
const DEFAULT_INLINE_CHARS = 30_000;
const DEFAULT_BACKGROUND_WAIT_MS = 3_000;
const KILL_GRACE_MS = 2_000;
/**
 * After the shell exits, how long its pipes may stay open before the command counts as done.
 * A command that backgrounds a child (`server &`, `nohup ...`) leaves the child holding them,
 * and 'close' would otherwise wait for that child to exit.
 */
const EXIT_DRAIN_MS = 250;
const MAX_WAIT_MS = 10 * 60_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

/**
 * Agent processes, shell commands and background jobs, run with the user's resolved shell
 * environment. The main process serves it to windows (see `VoltStdioMainService`, which stops a
 * window's agents with the window); the Volt agent server owns it outright.
 */
export class VoltStdioService extends Disposable implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
	private readonly stderr = new Map<string, string>();
	private readonly _onData = this._register(new Emitter<{ id: string; data: string }>());
	private readonly _onExit = this._register(new Emitter<{ id: string; code: number | null; stderr?: string }>());
	readonly onData: Event<{ id: string; data: string }> = this._onData.event;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }> = this._onExit.event;
	private readonly _onSandboxEvent = this._register(new Emitter<IVoltSandboxEvent>());
	readonly onSandboxEvent: Event<IVoltSandboxEvent> = this._onSandboxEvent.event;

	private readonly sandbox: VoltSandboxLauncher;
	/** The sandbox of each sandboxed spawn, and the spawn of each sandbox tag. */
	private readonly sandboxes = new Map<string, ISandboxLaunch>();
	private readonly sandboxTags = new Map<string, string>();

	/** Foreground commands and background jobs, by caller-chosen id. */
	private readonly runs = new Map<string, ExecRun>();
	private shellEnv: Promise<NodeJS.ProcessEnv> | undefined;
	/**
	 * The window (IPC context, `window:<id>`) that spawned each agent process. Its chats are the
	 * only ones that can use or stop the process, so when that window reloads, loads another
	 * folder, or closes, its agents go too. Without this every reload leaked an agent per chat.
	 */
	private readonly owners = new Map<string, string>();
	/** The window of a process whose exit is being announced, while its exit event fires. */
	private readonly exitOwners = new Map<string, string>();
	/** Output not yet sent, per process: chunks of one tick go to the window as one event. */
	private readonly pendingData = new Map<string, string[]>();
	private dataFlush: NodeJS.Immediate | undefined;

	constructor(
		protected readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
		userDataPath: string,
		/** The agent server's: what it started, so its next start can stop what a crash orphaned. */
		private readonly ledger?: ChildLedger,
	) {
		super();
		this.sandbox = this._register(new VoltSandboxLauncher(userDataPath, logService));
		this._register(this.sandbox.onViolation(e => {
			const id = this.sandboxTags.get(e.tag);
			if (id) {
				this._onSandboxEvent.fire({ id, denial: e.denial });
			}
		}));
	}

	private track(child: ChildProcess, command: string): void {
		if (this.ledger && child.pid) {
			this.ledger.add(child.pid, command);
			child.once('exit', () => this.ledger?.delete(child.pid));
		}
	}

	async spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		return this.spawnFor(undefined, options);
	}

	/** {@link spawn} on behalf of one window; see {@link owners}. */
	async spawnFor(owner: string | undefined, options: IVoltStdioSpawnOptions): Promise<string> {
		const id = generateUuid();
		let command = options.command;
		let args = options.args ?? [];
		let cwd = options.cwd;
		let env: NodeJS.ProcessEnv;
		// Throws SandboxUnavailableError when the sandbox cannot be established: the agent does not start.
		const launch = options.sandbox ? await this.sandbox.prepare(command, args, options.sandbox, { cwd: options.cwd, hostEnv: await this.env(), env: options.env }) : undefined;
		if (launch) {
			command = launch.command;
			args = launch.args;
			cwd = launch.cwd;
			// The profile's environment is complete: the user's minus secrets, plus what Volt set on purpose.
			env = launch.env;
			this.sandboxes.set(id, launch);
			this.sandboxTags.set(launch.tag, id);
			// Diagnostics for sandboxed spawns: exactly what runs, where, from which parent and with which env names.
			this.logService.info(`[volt-sandbox-spawn] ${id} ppid=${process.pid} cwd=${cwd ?? ''} ${launch.mechanism} unenforced=${launch.unenforced.join(',') || 'none'}`);
			this.logService.info(`[volt-sandbox-spawn] ${id} env=${Object.keys(env).sort().join(',')}`);
		} else {
			env = { ...await this.env(), ...options.env };
		}
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe', ...(launch?.extraStdio ?? [])],
			// Its own process group, so stopping it also stops the workers it starts.
			detached: process.platform !== 'win32',
		}) as ChildProcessWithoutNullStreams;
		if (launch) {
			void launch.confirm(child).then(confirmation => {
				if (!confirmation.ok) {
					// Never left running unconfirmed: the agent exits and the transcript says why.
					this.logService.warn(`[volt-sandbox-spawn] ${id} not confirmed: ${confirmation.error}`);
					this._onSandboxEvent.fire({ id, warning: `The sandbox could not be established, so the agent was stopped: ${confirmation.error}` });
					void launch.terminate(child);
				} else if (launch.warnings.length) {
					launch.warnings.forEach(warning => this._onSandboxEvent.fire({ id, warning }));
				}
			});
		}
		this.processes.set(id, child);
		this.track(child, command);
		if (owner) {
			this.owners.set(id, owner);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (data: string) => this.queueData(id, data));
		child.stderr.on('data', (data: string) => {
			this.stderr.set(id, tailText(`${this.stderr.get(id) ?? ''}${data}`, 4_000));
			this.logService.trace(`[volt-stdio:${id}] ${data}`);
		});
		// 'close' waits for stdout to drain; 'exit' can fire while output is still buffered.
		child.on('close', code => {
			// Output always reaches the window before the exit does.
			this.flushData(id);
			const stderr = this.stderr.get(id);
			const owner = this.owners.get(id);
			this.disposeSandbox(id);
			this.processes.delete(id);
			this.owners.delete(id);
			this.stderr.delete(id);
			if (owner) {
				this.exitOwners.set(id, owner);
			}
			try {
				this._onExit.fire({ id, code, ...(stderr ? { stderr } : {}) });
			} finally {
				this.exitOwners.delete(id);
			}
		});
		child.on('error', err => this.logService.error('[volt-stdio]', err));
		return id;
	}

	/**
	 * Agent output arrives in many small chunks; one IPC event per chunk floods the main process
	 * and the window. Chunks of the same tick are joined and sent once.
	 */
	private queueData(id: string, data: string): void {
		const pending = this.pendingData.get(id);
		if (pending) {
			pending.push(data);
		} else {
			this.pendingData.set(id, [data]);
		}
		this.dataFlush ??= setImmediate(() => {
			this.dataFlush = undefined;
			for (const pendingId of [...this.pendingData.keys()]) {
				this.flushData(pendingId);
			}
		});
	}

	private flushData(id: string): void {
		const pending = this.pendingData.get(id);
		if (!pending) {
			return;
		}
		this.pendingData.delete(id);
		this._onData.fire({ id, data: pending.length === 1 ? pending[0] : pending.join('') });
	}

	/** The window that started process or command `id`, if a window did. */
	ownerOf(id: string): string | undefined {
		return this.owners.get(id) ?? this.exitOwners.get(id) ?? this.runs.get(id)?.owner;
	}

	async sandboxSupport(): Promise<IVoltSandboxSupportInfo> {
		return this.sandbox.getSupport();
	}

	async allowSandboxDomains(id: string, domains: readonly string[]): Promise<void> {
		this.sandboxes.get(id)?.allowDomains(domains);
	}

	async sandboxAllows(id: string, path: string, access: 'read' | 'write'): Promise<boolean> {
		const launch = this.sandboxes.get(id);
		if (!launch) {
			return true;
		}
		const resolved = await realpathOfNearest(path);
		// Both spellings must pass, as the OS checks the resolved path and Volt writes the given one.
		return resolvedPolicyAllows(launch.policy, path, access) && resolvedPolicyAllows(launch.policy, resolved, access);
	}

	async syncSandboxState(id: string): Promise<IVoltSandboxStateSync | undefined> {
		return this.sandboxes.get(id)?.syncState();
	}

	private disposeSandbox(id: string): void {
		const launch = this.sandboxes.get(id);
		if (launch) {
			const child = this.processes.get(id);
			if (child) {
				// The agent is gone; nothing it started may outlive it.
				void launch.terminate(child);
			}
			// A moment for the kernel log to deliver the last denials of a process that just ended.
			setTimeout(() => {
				launch.dispose();
				this.sandboxTags.delete(launch.tag);
			}, 3_000);
			this.sandboxes.delete(id);
		}
	}

	async write(id: string, data: string): Promise<void> {
		const child = this.processes.get(id);
		if (!child?.stdin.writable) {
			throw new Error('ACP process is not writable');
		}
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(data, err => err ? reject(err) : resolve());
		});
	}

	async kill(id: string): Promise<void> {
		const child = this.processes.get(id);
		if (!child) {
			return;
		}
		const launch = this.sandboxes.get(id);
		if (launch) {
			// The backend's kill: the whole sandbox, including processes that left the group.
			void launch.terminate(child);
		} else {
			killTree(child);
		}
		this.processes.delete(id);
		this.owners.delete(id);
	}

	protected killOwnedBy(owner: string): void {
		const ids = [...this.owners].filter(([, value]) => value === owner).map(([id]) => id);
		if (ids.length) {
			this.logService.info(`[volt-stdio] stopping ${ids.length} agent process(es) of ${owner}`);
		}
		for (const id of ids) {
			void this.kill(id);
		}
		// Commands and jobs of the window too: a dev server left behind by a reload would hold its port.
		const runs = [...this.runs.values()].filter(run => run.owner === owner && run.running);
		if (runs.length) {
			this.logService.info(`[volt-stdio] stopping ${runs.length} command(s) of ${owner}`);
		}
		for (const run of runs) {
			void this.cancelExec(run.id);
		}
	}

	killAll(): void {
		for (const id of [...this.processes.keys()]) {
			void this.kill(id);
		}
		for (const run of this.runs.values()) {
			run.stop();
		}
	}

	async which(command: string): Promise<string | undefined> {
		try {
			const tool = process.platform === 'win32' ? 'where' : 'which';
			const { stdout } = await execFileAsync(tool, [command], { env: await this.env() });
			return stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		} catch {
			return undefined;
		}
	}

	// --- exec and jobs --------------------------------------------------------------------------

	async exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		return this.execFor(undefined, request);
	}

	async execFile(request: IVoltExecFileRequest): Promise<IVoltExecFileResult> {
		const env = { ...await this.env(), ...request.env };
		return new Promise(resolve => {
			execFile(request.file, [...request.args], {
				cwd: request.cwd,
				env,
				timeout: request.timeoutMs,
				maxBuffer: request.maxBytes ?? 1024 * 1024,
				windowsHide: true,
				encoding: 'utf8',
			}, (err, stdout, stderr) => {
				const failure = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
				resolve({
					exitCode: !failure ? 0 : typeof failure.code === 'number' ? failure.code : null,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					...(failure && typeof failure.code !== 'number' ? { error: failure.killed ? `timed out after ${request.timeoutMs} ms` : failure.message } : {}),
				});
			});
		});
	}

	/** {@link exec} on behalf of one window; its commands stop when it reloads or closes. */
	async execFor(owner: string | undefined, request: IVoltExecRequest): Promise<IVoltExecResult> {
		const env = { ...await this.env(), ...request.env };
		const shell = shellFor(env);
		const started = Date.now();
		let launch: ISandboxLaunch | undefined;
		if (request.sandbox) {
			try {
				launch = await this.sandbox.prepare(shell.file, shell.args(request.command), request.sandbox, { cwd: request.cwd, hostEnv: await this.env(), env: request.env });
			} catch (err) {
				// Refused, never run unsandboxed.
				const message = `Not run: ${(err as Error).message}`;
				return { id: request.id, exitCode: null, stdout: '', stderr: message, combined: message, truncated: false, durationMs: Date.now() - started, timedOut: false, cancelled: false, running: false };
			}
		}
		const child = spawn(launch?.command ?? shell.file, launch?.args ?? shell.args(request.command), {
			cwd: launch?.cwd ?? request.cwd,
			env: launch?.env ?? env,
			// No stdin: a command that prompts gets EOF instead of hanging the run.
			stdio: ['ignore', 'pipe', 'pipe', ...(launch?.extraStdio ?? [])],
			detached: process.platform !== 'win32',
			windowsVerbatimArguments: process.platform === 'win32',
		});
		this.track(child, shell.file);
		const run = new ExecRun(request.id, request.command, child, started, owner, launch);
		this.runs.set(request.id, run);
		this.pruneFinishedJobs();
		if (launch) {
			const sandboxed = launch;
			void sandboxed.confirm(child).then(confirmation => {
				if (!confirmation.ok) {
					run.appendError(`Volt sandbox: ${confirmation.error}\n`);
					void sandboxed.terminate(child);
				}
			});
			// Nothing a sandboxed command started outlives it; then its sandbox is torn down.
			run.onDone(() => void sandboxed.terminate(child).finally(() => sandboxed.dispose()));
		}
		run.onDone(() => {
			// A command that handed control back stays readable as a job.
			if (!request.background && !run.yielded) {
				this.runs.delete(request.id);
			}
		});
		const timeout = setTimeout(() => {
			run.timedOut = true;
			run.stop();
		}, Math.max(1_000, request.timeoutMs));
		run.onDone(() => clearTimeout(timeout));

		if (request.background) {
			await Promise.race([run.done, delay(request.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS)]);
			clearTimeout(timeout);
			if (run.running) {
				// A background job outlives the call; its own timer is the dispose of this service.
				return this.result(run, request, started);
			}
		} else if (request.yieldAfterMs !== undefined && request.yieldAfterMs > 0) {
			await Promise.race([run.done, delay(request.yieldAfterMs)]);
			if (run.running) {
				// Still going: the caller gets control back, the command goes on as a job under its own timeout.
				run.yielded = true;
			}
		} else {
			await run.done;
		}
		return this.result(run, request, started);
	}

	async cancelExec(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		run.cancelled = true;
		run.stop();
		await Promise.race([run.done, delay(KILL_GRACE_MS * 2)]);
		this.runs.delete(id);
	}

	async jobOutput(id: string, since?: number): Promise<IVoltJobOutput | undefined> {
		const run = this.runs.get(id);
		return run ? run.snapshot(since) : undefined;
	}

	async jobWait(id: string, timeoutMs: number, until?: string, since?: number): Promise<IVoltJobOutput | undefined> {
		const run = this.runs.get(id);
		if (!run) {
			return undefined;
		}
		let pattern: RegExp | undefined;
		if (until) {
			try {
				pattern = new RegExp(until, 'm');
			} catch {
				pattern = new RegExp(until.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
			}
		}
		const from = since ?? 0;
		const matches = () => !!pattern && pattern.test(run.combined.since(from).text);
		if (!run.running || matches()) {
			return { ...run.snapshot(since), matched: matches() };
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(finish, Math.min(MAX_WAIT_MS, Math.max(0, timeoutMs)));
			const listener = run.onOutput(() => {
				if (matches()) {
					finish();
				}
			});
			run.onDone(finish);
			function finish() {
				clearTimeout(timer);
				listener();
				resolve();
			}
		});
		return { ...run.snapshot(since), matched: matches() };
	}

	async listJobs(): Promise<readonly IVoltJobOutput[]> {
		return [...this.runs.values()].map(run => run.snapshot(Number.MAX_SAFE_INTEGER));
	}

	/** Finished background jobs stay readable, but not forever. */
	private pruneFinishedJobs(): void {
		const finished = [...this.runs.values()].filter(run => !run.running).sort((a, b) => a.startedAt - b.startedAt);
		for (const run of finished.slice(0, Math.max(0, finished.length - 32))) {
			this.runs.delete(run.id);
		}
	}

	private async result(run: ExecRun, request: IVoltExecRequest, started: number): Promise<IVoltExecResult> {
		const inline = request.inlineChars ?? DEFAULT_INLINE_CHARS;
		const stdout = run.stdout.shaped(inline);
		const stderr = run.stderr.shaped(Math.max(4_000, Math.floor(inline / 2)));
		const combined = run.combined.shaped(inline);
		const truncated = stdout.truncated || stderr.truncated || combined.truncated;
		let logPath: string | undefined;
		if (truncated && !run.running) {
			logPath = await this.spill(request.spillDir ?? join(tmpdir(), 'volt-exec'), request.id, run.combined.full()).catch(() => undefined);
		}
		return {
			id: request.id,
			exitCode: run.exitCode,
			...(run.signal ? { signal: run.signal } : {}),
			stdout: stdout.text,
			stderr: stderr.text,
			combined: combined.text,
			truncated,
			...(logPath ? { logPath } : {}),
			durationMs: Date.now() - started,
			timedOut: run.timedOut,
			cancelled: run.cancelled,
			running: run.running,
		};
	}

	private async spill(dir: string, id: string, text: string): Promise<string> {
		await fs.mkdir(dir, { recursive: true });
		const file = join(dir, `${id.replace(/[^\w.-]/g, '_')}.log`);
		await fs.writeFile(file, text, 'utf8');
		return file;
	}

	/** The user's shell environment, resolved once by the main process and cached. */
	private env(): Promise<NodeJS.ProcessEnv> {
		this.shellEnv ??= getResolvedShellEnv(this.configurationService, this.logService, { _: [] }, process.env)
			.catch(err => {
				this.logService.warn('[volt-stdio] could not resolve the shell environment', err);
				// Not cached: the next command tries again (a slow shell at startup is often fine later).
				this.shellEnv = undefined;
				return {};
			})
			.then(resolved => ({
				...commandEnv({ ...process.env, ...resolved }),
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
			}));
		return this.shellEnv;
	}

	override dispose(): void {
		for (const [id, child] of this.processes) {
			killTree(child);
			this.processes.delete(id);
		}
		this.owners.clear();
		for (const launch of this.sandboxes.values()) {
			launch.dispose();
		}
		this.sandboxes.clear();
		for (const run of this.runs.values()) {
			run.stop();
		}
		this.runs.clear();
		this.stderr.clear();
		if (this.dataFlush) {
			clearImmediate(this.dataFlush);
			this.dataFlush = undefined;
		}
		this.pendingData.clear();
		super.dispose();
	}
}

/** One command's streams and lifecycle. */
class ExecRun {

	readonly stdout = new OutputLog();
	readonly stderr = new OutputLog();
	readonly combined = new OutputLog();
	readonly done: Promise<void>;
	running = true;
	exitCode: number | null = null;
	signal: string | undefined;
	timedOut = false;
	cancelled = false;
	/** A foreground command that outlived its `yieldAfterMs` and is now a job. */
	yielded = false;
	private readonly outputListeners = new Set<() => void>();
	private readonly doneListeners: (() => void)[] = [];

	constructor(readonly id: string, readonly command: string, readonly child: ChildProcess, readonly startedAt: number, readonly owner?: string, private readonly sandbox?: ISandboxLaunch) {
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => this.append(this.stdout, data));
		child.stderr?.on('data', (data: string) => this.append(this.stderr, data));
		this.done = new Promise<void>(resolve => {
			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
				if (!this.running) {
					return;
				}
				this.running = false;
				this.exitCode = code;
				this.signal = signal ?? undefined;
				resolve();
				for (const listener of this.doneListeners.splice(0)) {
					listener();
				}
			};
			child.on('close', finish);
			// The shell is gone but a child it backgrounded still holds the pipes: done anyway.
			child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), EXIT_DRAIN_MS));
			child.on('error', err => {
				this.append(this.stderr, `${err.message}\n`);
				finish(127, null);
			});
		});
	}

	/** Kills the whole tree: through the sandbox backend when sandboxed (it reaches processes that left the group). */
	stop(): void {
		if (this.sandbox) {
			void this.sandbox.terminate(this.child);
		} else {
			killTree(this.child);
		}
	}

	appendError(text: string): void {
		this.append(this.stderr, text);
	}

	onDone(listener: () => void): void {
		if (!this.running) {
			listener();
			return;
		}
		this.doneListeners.push(listener);
	}

	onOutput(listener: () => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	snapshot(since?: number): IVoltJobOutput {
		const slice = this.combined.since(since ?? 0);
		return {
			id: this.id,
			command: this.command,
			output: shapeText(slice.text, DEFAULT_INLINE_CHARS).text,
			offset: slice.offset,
			running: this.running,
			exitCode: this.exitCode,
		};
	}

	private append(log: OutputLog, data: string): void {
		const clean = data.replace(ANSI, '');
		log.append(clean);
		this.combined.append(clean);
		for (const listener of this.outputListeners) {
			listener();
		}
	}
}

/** Head is kept whole; the rest rolls, dropping the middle past `MAX_BUFFER_CHARS`. */
class OutputLog {

	private head = '';
	private readonly chunks: string[] = [];
	/** Characters held in `chunks`. */
	private size = 0;
	/** Characters ever appended; offsets are absolute positions in this stream. */
	private total = 0;

	append(text: string): void {
		if (!text) {
			return;
		}
		this.total += text.length;
		if (this.head.length < HEAD_CHARS) {
			const room = HEAD_CHARS - this.head.length;
			this.head += text.slice(0, room);
			text = text.slice(room);
			if (!text) {
				return;
			}
		}
		this.chunks.push(text);
		this.size += text.length;
		while (this.size > MAX_BUFFER_CHARS && this.chunks.length > 1) {
			this.size -= this.chunks.shift()!.length;
		}
	}

	full(): string {
		const tail = this.chunks.join('');
		const dropped = this.total - this.head.length - tail.length;
		return dropped > 0 ? `${this.head}\n[... ${dropped} characters dropped ...]\n${tail}` : this.head + tail;
	}

	/** Output after absolute offset `offset`, and the offset to pass next time. */
	since(offset: number): { text: string; offset: number } {
		const tail = this.chunks.join('');
		const tailStart = this.total - this.size;
		const from = Math.max(0, Math.min(offset, this.total));
		let text: string;
		if (from < this.head.length) {
			const gap = tailStart > this.head.length ? `\n[... ${tailStart - this.head.length} characters dropped ...]\n` : '';
			text = this.head.slice(from) + gap + tail;
		} else if (from < tailStart) {
			text = `[... ${tailStart - from} characters dropped ...]\n${tail}`;
		} else {
			text = tail.slice(from - tailStart);
		}
		return { text, offset: this.total };
	}

	shaped(limit: number): { text: string; truncated: boolean } {
		return shapeText(this.full(), limit);
	}
}

/** 20% head, 80% tail: failures are usually at the end. */
function shapeText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	const head = Math.max(500, Math.floor(limit * 0.2));
	const tail = Math.max(500, limit - head);
	const omitted = text.length - head - tail;
	return { text: `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(-tail)}`, truncated: true };
}

/** A POSIX shell the model's commands are written for; fish and friends fall back to bash. */
function shellFor(env: NodeJS.ProcessEnv): { file: string; args: (command: string) => string[] } {
	if (process.platform === 'win32') {
		return { file: env.ComSpec || 'cmd.exe', args: command => ['/d', '/s', '/c', `"${command}"`] };
	}
	const preferred = env.SHELL && /^(zsh|bash|sh|dash|ksh)$/.test(basename(env.SHELL)) ? env.SHELL : undefined;
	return { file: preferred ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: command => ['-c', command] };
}

/** The real path of `path`, or of its nearest existing parent plus the rest (a file about to be created). */
async function realpathOfNearest(path: string): Promise<string> {
	const rest: string[] = [];
	let current = path;
	for (let i = 0; i < 64 && current && current !== '/'; i++) {
		try {
			const real = await fs.realpath(current);
			return [real, ...rest].join('/').replace(/\/{2,}/g, '/');
		} catch {
			rest.unshift(basename(current));
			current = dirname(current);
		}
	}
	return path;
}

/** SIGTERM to the whole process group, then SIGKILL after a grace period. */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid || child.exitCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
		return;
	}
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				child.kill(sig);
			} catch {
				// Already gone.
			}
		}
	};
	signal('SIGTERM');
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			signal('SIGKILL');
		}
	}, KILL_GRACE_MS);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** GUI launches omit shell paths such as ~/.local/bin, where Claude Code is installed. */
function commandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = homedir();
	const extra = process.platform === 'win32'
		? [join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps')]
		: [
			join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
			// Docker Desktop and OrbStack put the docker CLI here; a GUI launch's PATH often lacks them.
			join(home, '.docker', 'bin'), join(home, '.orbstack', 'bin'), '/Applications/Docker.app/Contents/Resources/bin',
		];
	const current = (base.PATH ?? '').split(delimiter).filter(Boolean);
	const path = [...current, ...extra].filter((entry, index, all) => all.indexOf(entry) === index);
	return { ...base, PATH: path.join(delimiter) };
}

function tailText(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}
