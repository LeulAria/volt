/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { basename, delimiter, join } from '../../../base/common/path.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IServerChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltStdioService, IVoltStdioSpawnOptions } from '../common/voltStdio.js';

const execFileAsync = promisify(execFile);

/** Output kept in memory per command. Beyond this the middle is dropped (head is always kept). */
const MAX_BUFFER_CHARS = 4_000_000;
const HEAD_CHARS = 16_000;
const DEFAULT_INLINE_CHARS = 30_000;
const DEFAULT_BACKGROUND_WAIT_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const MAX_WAIT_MS = 10 * 60_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

export class VoltStdioMainService extends Disposable implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
	private readonly stderr = new Map<string, string>();
	private readonly _onData = this._register(new Emitter<{ id: string; data: string }>());
	private readonly _onExit = this._register(new Emitter<{ id: string; code: number | null; stderr?: string }>());
	readonly onData: Event<{ id: string; data: string }> = this._onData.event;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }> = this._onExit.event;

	/** Foreground commands and background jobs, by caller-chosen id. */
	private readonly runs = new Map<string, ExecRun>();
	private shellEnv: Promise<NodeJS.ProcessEnv> | undefined;
	/**
	 * The window (IPC context, `window:<id>`) that spawned each agent process. Its chats are the
	 * only ones that can use or stop the process, so when that window reloads, loads another
	 * folder, or closes, its agents go too. Without this every reload leaked an agent per chat.
	 */
	private readonly owners = new Map<string, string>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
	) {
		super();
		this._register(lifecycleMainService.onWillLoadWindow(e => this.killOwnedBy(windowOwner(e.window.id))));
		this._register(lifecycleMainService.onBeforeCloseWindow(window => this.killOwnedBy(windowOwner(window.id))));
		this._register(lifecycleMainService.onWillShutdown(() => this.killAll()));
	}

	async spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		return this.spawnFor(undefined, options);
	}

	/** {@link spawn} on behalf of one window; see {@link owners}. */
	async spawnFor(owner: string | undefined, options: IVoltStdioSpawnOptions): Promise<string> {
		const id = generateUuid();
		const child = spawn(options.command, options.args ?? [], {
			cwd: options.cwd,
			env: { ...await this.env(), ...options.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			// Its own process group, so stopping it also stops the workers it starts.
			detached: process.platform !== 'win32',
		});
		this.processes.set(id, child);
		if (owner) {
			this.owners.set(id, owner);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (data: string) => this._onData.fire({ id, data }));
		child.stderr.on('data', (data: string) => {
			this.stderr.set(id, tailText(`${this.stderr.get(id) ?? ''}${data}`, 4_000));
			this.logService.trace(`[volt-stdio:${id}] ${data}`);
		});
		// 'close' waits for stdout to drain; 'exit' can fire while output is still buffered.
		child.on('close', code => {
			const stderr = this.stderr.get(id);
			this.processes.delete(id);
			this.owners.delete(id);
			this.stderr.delete(id);
			this._onExit.fire({ id, code, ...(stderr ? { stderr } : {}) });
		});
		child.on('error', err => this.logService.error('[volt-stdio]', err));
		return id;
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
		killTree(child);
		this.processes.delete(id);
		this.owners.delete(id);
	}

	private killOwnedBy(owner: string): void {
		const ids = [...this.owners].filter(([, value]) => value === owner).map(([id]) => id);
		if (ids.length) {
			this.logService.info(`[volt-stdio] stopping ${ids.length} agent process(es) of ${owner}`);
		}
		for (const id of ids) {
			void this.kill(id);
		}
	}

	private killAll(): void {
		for (const id of [...this.processes.keys()]) {
			void this.kill(id);
		}
		for (const run of this.runs.values()) {
			killTree(run.child);
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
		const env = { ...await this.env(), ...request.env };
		const shell = shellFor(env);
		const started = Date.now();
		const child = spawn(shell.file, shell.args(request.command), {
			cwd: request.cwd,
			env,
			// No stdin: a command that prompts gets EOF instead of hanging the run.
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
			windowsVerbatimArguments: process.platform === 'win32',
		});
		const run = new ExecRun(request.id, request.command, child, started);
		this.runs.set(request.id, run);
		this.pruneFinishedJobs();
		run.onDone(() => {
			if (!request.background) {
				this.runs.delete(request.id);
			}
		});
		const timeout = setTimeout(() => {
			run.timedOut = true;
			killTree(child);
		}, Math.max(1_000, request.timeoutMs));
		run.onDone(() => clearTimeout(timeout));

		if (request.background) {
			await Promise.race([run.done, delay(request.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS)]);
			clearTimeout(timeout);
			if (run.running) {
				// A background job outlives the call; its own timer is the dispose of this service.
				return this.result(run, request, started);
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
		killTree(run.child);
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
		for (const run of this.runs.values()) {
			killTree(run.child);
		}
		this.runs.clear();
		this.stderr.clear();
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
	private readonly outputListeners = new Set<() => void>();
	private readonly doneListeners: (() => void)[] = [];

	constructor(readonly id: string, readonly command: string, readonly child: ChildProcess, readonly startedAt: number) {
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
			child.on('error', err => {
				this.append(this.stderr, `${err.message}\n`);
				finish(127, null);
			});
		});
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

function windowOwner(windowId: number): string {
	return `window:${windowId}`;
}

/**
 * The renderer-facing channel. Same as a proxied service, except `spawn` records which window
 * asked (the IPC context), so that window's agents stop with it.
 */
export function createVoltStdioChannel(service: VoltStdioMainService, disposables: DisposableStore): IServerChannel<string> {
	const proxied = ProxyChannel.fromService(service, disposables);
	return {
		call<T>(ctx: string, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
			if (command === 'spawn') {
				return service.spawnFor(ctx, (arg as [IVoltStdioSpawnOptions])[0]) as Promise<unknown> as Promise<T>;
			}
			return proxied.call<T>(ctx, command, arg, cancellationToken);
		},
		listen<T>(ctx: string, event: string, arg?: unknown): Event<T> {
			return proxied.listen<T>(ctx, event, arg);
		},
	};
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
		: [join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
	const current = (base.PATH ?? '').split(delimiter).filter(Boolean);
	const path = [...current, ...extra].filter((entry, index, all) => all.indexOf(entry) === index);
	return { ...base, PATH: path.join(delimiter) };
}

function tailText(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}
