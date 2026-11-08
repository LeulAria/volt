/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { constants, existsSync, promises as fs } from 'fs';
import { PassThrough, Writable } from 'stream';
import { promisify } from 'util';
import { dirname, join } from '../../../base/common/path.js';
import { IVoltSandboxRequest } from '../common/sandboxPolicy.js';
import { ISandboxLaunch, VoltSandboxLauncher } from './sandboxLauncher.js';

const execFileAsync = promisify(execFile);

/**
 * Sandboxed workloads on a PTY (spec F.6): a sandboxed chat's managed terminals.
 *
 * node-pty passes only stdin, stdout and stderr, but every backend confirms its sandbox over extra
 * file descriptors (fd 3 up). So the run's folder (`~/.volt/sandbox/runs/<run>`, 0700) gets a
 * `pty` folder with one 0600 FIFO per channel, and the PTY starts a fixed launcher that opens
 * them as fds 3.. (each open waits for Volt's end) and then execs the backend exactly as a pipe
 * launch would. Volt reads and writes the other ends and runs the backend's own confirmation.
 *
 * The workload never runs before that confirmation: inside the sandbox a gate reads one line from
 * the PTY with echo off and execs the shell only when it is the run's go line, which Volt types
 * once the sandbox is confirmed. Any other input, or EOF, ends the run with 125. Volt writes
 * nothing else to the PTY before the go line.
 */

/** Runs inside the sandbox, first: waits for the go line, then becomes the workload. */
export const PTY_GATE_SCRIPT = [
	'stty -echo 2>/dev/null',
	'IFS= read -r go',
	'stty echo 2>/dev/null',
	'[ -n "$VOLT_PTY_GO" ] && [ "$go" = "$VOLT_PTY_GO" ] || { printf "volt: the sandbox was not confirmed, so nothing ran\\n" >&2; exit 125; }',
	'unset VOLT_PTY_GO',
	'exec "$@"',
].join('\n');

/** `$0` of the gate, shown by `ps` until the workload execs. */
const PTY_GATE_ARGV0 = 'volt-sandbox-gate';
/** `$0` of the launcher outside the sandbox. */
const PTY_LAUNCHER_ARGV0 = 'volt-sandbox-pty';
/** How long the confirmation may take, channels included; the backends time out on their own first. */
const CONFIRM_LIMIT_MS = 20_000;

/**
 * The launcher, run on the PTY as the user before the sandbox exists: opens the FIFOs (given as its
 * first arguments) as fds 3.. in the backend's directions, then execs the backend's command. The
 * text depends only on the number and direction of the channels, never on a path or a command.
 */
export function ptyLauncherScript(directions: readonly ('in' | 'out')[]): string {
	if (!directions.length || directions.length > 9) {
		throw new Error(`a PTY launch carries 1 to 9 channels, not ${directions.length}`);
	}
	// `out`: the sandbox writes, so the launcher opens it for writing; `in`: Volt writes it.
	const opens = directions.map((direction, index) => `${3 + index}${direction === 'out' ? '>' : '<'}"$${index + 1}"`).join(' ');
	return `exec ${opens} || exit 125\nshift ${directions.length}\nexec "$@"`;
}

/** Where `mkfifo` lives: the system's, never one found on PATH. */
function mkfifoPath(): string {
	const found = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(path => existsSync(path));
	if (!found) {
		throw new Error('mkfifo is missing, so a terminal cannot be sandboxed on this machine');
	}
	return found;
}

/** One control channel of the backend, carried by a FIFO: the stream the backend's `confirm` uses, and its FIFO end. */
interface IPtyChannel {
	readonly path: string;
	readonly direction: 'in' | 'out';
	readonly stream: PassThrough | FifoWriter;
	/** Volt's end, once open. */
	readonly holder: { handle?: fs.FileHandle };
}

/** A `Writable` for the backend that holds what it writes until Volt's end of the FIFO is open. */
class FifoWriter extends Writable {
	constructor(private readonly opened: Promise<fs.FileHandle | undefined>) {
		super();
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.opened.then(handle => handle ? handle.write(chunk).then(() => callback(), callback) : callback(new Error('the channel closed')), callback);
	}

	override _final(callback: (error?: Error | null) => void): void {
		// Closing Volt's end is the EOF the launcher waits for (bubblewrap reads `--args` until it).
		this.opened.then(handle => handle ? handle.close().then(() => callback(), () => callback()) : callback(), () => callback());
	}
}

/**
 * What the backends' `confirm` and `terminate` see of a process started on a PTY: its pid, the
 * channel streams at fds 3.., and its exit as `exit` and `close` events.
 */
class PtyChildProcess extends EventEmitter {
	readonly stdin = null;
	readonly stdout = null;
	readonly stderr = null;
	readonly stdio: readonly (PassThrough | FifoWriter | null)[];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	constructor(readonly pid: number, channels: readonly IPtyChannel[]) {
		super();
		this.stdio = [null, null, null, ...channels.map(channel => channel.stream)];
	}

	exited(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitCode !== null || this.signalCode !== null) {
			return;
		}
		this.exitCode = code ?? (signal ? null : 0);
		this.signalCode = signal;
		this.emit('exit', code, signal);
		this.emit('close', code, signal);
	}

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		try {
			process.kill(this.pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

export interface ISandboxedPtyOptions {
	readonly cwd?: string;
	/** The user's environment the profile filters. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
	/** What Volt sets on purpose (the terminal's own variables). */
	readonly env?: Readonly<Record<string, string>>;
	readonly label?: string;
}

/** What to start on the PTY. */
export interface ISandboxedPtyLaunch {
	readonly file: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
}

/**
 * One sandboxed PTY workload: prepared (sandbox resolved, FIFOs made), started by the caller on a
 * PTY, confirmed, then let go. Refuses at every step rather than running anything unconfirmed.
 */
export class SandboxedPtySession {

	private readonly channels: IPtyChannel[] = [];
	private child: PtyChildProcess | undefined;
	private aborted = false;
	private ended = false;

	private constructor(
		private readonly sandbox: ISandboxLaunch,
		private readonly go: string,
		readonly launch: ISandboxedPtyLaunch,
		private readonly channelPaths: readonly string[],
	) { }

	/** Resolves the chat's sandbox for `file args` on a PTY. Throws when it cannot be set up: nothing is to be started. */
	static async prepare(launcher: VoltSandboxLauncher, file: string, args: readonly string[], request: IVoltSandboxRequest, options: ISandboxedPtyOptions): Promise<SandboxedPtySession> {
		if (process.platform === 'win32') {
			throw new Error('Terminals cannot be sandboxed on Windows yet');
		}
		const go = randomBytes(16).toString('hex');
		const sandbox = await launcher.prepare('/bin/sh', ['-c', PTY_GATE_SCRIPT, PTY_GATE_ARGV0, file, ...args], request, {
			cwd: options.cwd,
			hostEnv: options.hostEnv,
			env: { ...options.env, VOLT_PTY_GO: go },
			terminal: true,
			label: options.label ?? 'terminal',
		});
		try {
			const directions = sandbox.extraStdioDirections;
			if (sandbox.extraStdio.length !== directions.length || sandbox.extraStdio.some(entry => entry !== 'pipe')) {
				throw new Error('this sandbox passes descriptors a PTY cannot carry');
			}
			// The run's own folder: 0700, under ~/.volt/sandbox/runs, removed with the run.
			const dir = join(dirname(sandbox.policy.tmp), 'pty');
			await fs.mkdir(dir, { mode: 0o700 });
			await fs.chmod(dir, 0o700);
			const paths = directions.map((_, index) => join(dir, `fd${3 + index}`));
			await execFileAsync(mkfifoPath(), ['-m', '600', '--', ...paths], { env: { PATH: '/usr/bin:/bin' }, timeout: 5_000 });
			for (const path of paths) {
				const stat = await fs.lstat(path);
				if (!stat.isFIFO() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
					throw new Error('a control channel of the terminal is not the FIFO Volt made');
				}
			}
			const launch: ISandboxedPtyLaunch = {
				file: '/bin/sh',
				args: ['-c', ptyLauncherScript(directions), PTY_LAUNCHER_ARGV0, ...paths, sandbox.command, ...sandbox.args],
				env: { ...sandbox.env },
				cwd: sandbox.cwd,
			};
			return new SandboxedPtySession(sandbox, go, launch, paths);
		} catch (err) {
			sandbox.dispose();
			throw err;
		}
	}

	get policy(): ISandboxLaunch['policy'] {
		return this.sandbox.policy;
	}

	get mechanism(): ISandboxLaunch['mechanism'] {
		return this.sandbox.mechanism;
	}

	/**
	 * After the caller started {@link launch} on a PTY as process `pid`: opens Volt's ends of the
	 * channels, runs the backend's confirmation, and returns the text to write to the PTY so the
	 * workload starts. Throws (after killing the tree) when the sandbox was not established.
	 */
	async confirm(pid: number): Promise<string> {
		if (this.child || this.ended) {
			throw new Error('this terminal was already started');
		}
		const directions = this.sandbox.extraStdioDirections;
		// One open at a time, in the launcher's order: each blocks a thread until the launcher opens its end.
		let previous: Promise<unknown> = Promise.resolve();
		for (let index = 0; index < this.channelPaths.length; index++) {
			const path = this.channelPaths[index];
			const direction = directions[index];
			const holder: { handle?: fs.FileHandle } = {};
			const opened: Promise<fs.FileHandle | undefined> = previous.then(() => this.aborted ? undefined : fs.open(path, direction === 'out' ? constants.O_RDONLY : constants.O_WRONLY)).then(handle => {
				if (handle && this.aborted) {
					void handle.close().catch(() => undefined);
					return undefined;
				}
				holder.handle = handle;
				return handle;
			}, () => undefined);
			previous = opened;
			const stream = direction === 'out' ? new PassThrough() : new FifoWriter(opened);
			const channel: IPtyChannel = { path, direction, stream, holder };
			if (stream instanceof PassThrough) {
				void opened.then(handle => {
					if (!handle) {
						stream.end();
						return;
					}
					const source = handle.createReadStream();
					source.on('error', () => stream.end());
					source.pipe(stream);
				});
			}
			stream.on('error', () => undefined);
			this.channels.push(channel);
		}
		const child = new PtyChildProcess(pid, this.channels);
		this.child = child;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const confirmation = await Promise.race([
			this.sandbox.confirm(child as unknown as ChildProcess),
			new Promise<{ ok: false; error: string }>(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'the sandbox did not confirm in time' }), CONFIRM_LIMIT_MS); }),
		]);
		clearTimeout(timer);
		if (!confirmation.ok) {
			await this.end();
			throw new Error(`The terminal's sandbox could not be established, so nothing ran: ${confirmation.error}`);
		}
		return `${this.go}\r`;
	}

	/** The PTY's process exited (the backends' early-exit checks and kills look at this). */
	exited(code: number | null, signal: NodeJS.Signals | null): void {
		this.child?.exited(code, signal);
	}

	/** Kills the sandbox's whole tree, unblocks channels still waiting, and removes the run folder. Safe to call more than once. */
	async end(): Promise<void> {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.abort();
		if (this.child) {
			await this.sandbox.terminate(this.child as unknown as ChildProcess).catch(() => undefined);
		}
		for (const channel of this.channels) {
			channel.stream.destroy();
			await channel.holder.handle?.close().catch(() => undefined);
		}
		this.sandbox.dispose();
	}

	/** Opens of Volt's ends that still wait for the launcher are released by opening the other end ourselves. */
	private abort(): void {
		if (this.aborted) {
			return;
		}
		this.aborted = true;
		const directions = this.sandbox.extraStdioDirections;
		this.channelPaths.forEach((path, index) => {
			if (this.channels[index]?.holder.handle) {
				return;
			}
			// Volt reads `out` channels: a writer releases its open; it writes `in` channels: a reader does.
			const flags = (directions[index] === 'out' ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NONBLOCK;
			void fs.open(path, flags).then(handle => handle.close(), () => undefined);
		});
	}
}
