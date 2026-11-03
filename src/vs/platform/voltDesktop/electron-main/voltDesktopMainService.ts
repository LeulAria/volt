/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltDesktopActResult, IVoltDesktopApp, IVoltDesktopCapture, IVoltDesktopService, IVoltDesktopSettle, IVoltDesktopStatus, IVoltDesktopTree, VoltDesktopAction } from '../common/voltDesktop.js';

interface IPending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS: Partial<Record<string, number>> = { tree: 20_000, activate: 40_000, window: 10_000, menu: 10_000, type: 30_000, drag: 60_000, settle: 12_000, capture: 15_000, paste: 10_000 };

type Backend = 'mac' | 'windows' | 'linux';

/** The helper for this OS: macOS accessibility (Swift), Windows UI Automation (C# run by PowerShell), Linux AT-SPI (Python). */
function backendFor(platform: NodeJS.Platform): Backend | undefined {
	return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
}

const UNSUPPORTED = 'Desktop control works on macOS, Windows and Linux.';

/**
 * Runs the desktop helper for this OS and sends it one JSON request per line; every helper speaks
 * the same protocol (see `VoltDesktop.swift`). On macOS that is `VoltDesktop.swift`, compiled on
 * first use with the system's Swift compiler and cached by the source's hash in Volt's data folder;
 * on Windows `VoltDesktop.windows.ps1`, which compiles `VoltDesktop.windows.cs` the same way; on
 * Linux `volt_desktop_linux.py`. A request that does not answer in time restarts the helper, so one
 * stuck app never blocks the next call.
 */
export class VoltDesktopMainService extends Disposable implements IVoltDesktopService {

	declare readonly _serviceBrand: undefined;

	private child: ChildProcess | undefined;
	private starting: Promise<ChildProcess> | undefined;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, IPending>();

	constructor(
		@IEnvironmentMainService private readonly environmentService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.stop(new Error('Volt is closing.'))));
	}

	private readonly backend = backendFor(process.platform);

	async status(prompt = false): Promise<IVoltDesktopStatus> {
		if (!this.backend) {
			return { supported: false, trusted: false, screen: false, error: UNSUPPORTED };
		}
		try {
			const result = await this.request('status', { prompt }) as { trusted: boolean; screen: boolean; events?: boolean };
			return { supported: true, backend: this.backend, trusted: result.trusted, screen: result.screen, events: result.events };
		} catch (err) {
			return { supported: true, backend: this.backend, trusted: false, screen: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async apps(): Promise<IVoltDesktopApp[]> {
		return await this.request('apps', {}) as IVoltDesktopApp[];
	}

	async tree(target: { readonly app?: string; readonly pid?: number; readonly window?: string; readonly max?: number }): Promise<IVoltDesktopTree> {
		return await this.request('tree', { ...target }) as IVoltDesktopTree;
	}

	async act(action: VoltDesktopAction): Promise<IVoltDesktopActResult> {
		const { kind, ...args } = action;
		const result = await this.request(kind, args);
		return result && typeof result === 'object' ? result as IVoltDesktopActResult : {};
	}

	async settle(target: { readonly app?: string; readonly pid?: number; readonly quietMs?: number; readonly startMs?: number; readonly maxMs?: number }): Promise<IVoltDesktopSettle> {
		return await this.request('settle', { ...target }) as IVoltDesktopSettle;
	}

	async capture(rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): Promise<IVoltDesktopCapture> {
		return await this.request('capture', { ...rect }) as IVoltDesktopCapture;
	}

	private async request(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.backend) {
			throw new Error(UNSUPPORTED);
		}
		const child = await this.running();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The app did not answer ${cmd} in time.`));
				// The helper may be stuck inside an unresponsive app: start a fresh one next time.
				this.stop(new Error('The desktop helper was restarted.'));
			}, TIMEOUT_MS[cmd] ?? 8000);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin?.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
		});
	}

	private stop(err: Error): void {
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		this.buffer = '';
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(err);
			this.pending.delete(id);
		}
		if (child && child.exitCode === null) {
			child.kill();
		}
	}

	private running(): Promise<ChildProcess> {
		if (this.child) {
			return Promise.resolve(this.child);
		}
		this.starting ??= this.launch().catch(err => {
			this.starting = undefined;
			throw err;
		});
		return this.starting;
	}

	private async launch(): Promise<ChildProcess> {
		const [command, args] = await this.helperCommand(this.backend!);
		const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		child.stdout?.setEncoding('utf8');
		// What the helper says before it is up (a missing Python module, say) explains a failed start.
		let stderr = '';
		child.stderr?.on('data', chunk => {
			stderr = `${stderr}${chunk}`.slice(-2000);
			this.logService.trace('[volt-desktop] helper:', String(chunk));
		});
		await new Promise<void>((resolve, reject) => {
			// Windows compiles its helper on the first start, which takes PowerShell a while.
			const timer = setTimeout(() => reject(new Error(`The desktop helper did not start.${stderr ? ` ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)), this.backend === 'windows' ? 60_000 : 10_000);
			child.stdout?.on('data', (chunk: string) => {
				this.buffer += chunk;
				for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
					const line = this.buffer.slice(0, at);
					this.buffer = this.buffer.slice(at + 1);
					let reply: { id?: number; ok?: boolean; result?: unknown; error?: string };
					try {
						reply = JSON.parse(line) as typeof reply;
					} catch {
						continue;
					}
					if (reply.id === 0) {
						clearTimeout(timer);
						resolve();
						continue;
					}
					const pending = reply.id !== undefined ? this.pending.get(reply.id) : undefined;
					if (pending) {
						this.pending.delete(reply.id!);
						clearTimeout(pending.timer);
						if (reply.ok) {
							pending.resolve(reply.result);
						} else {
							pending.reject(new Error(reply.error ?? 'The desktop helper failed.'));
						}
					}
				}
			});
			child.on('error', err => {
				clearTimeout(timer);
				reject((err as NodeJS.ErrnoException).code === 'ENOENT' && this.backend === 'linux'
					? new Error('Desktop control on Linux needs python3 with AT-SPI: install python3-gi and gir1.2-atspi-2.0 (Debian/Ubuntu) or python3-gobject and at-spi2-core (Fedora), plus xdotool.')
					: err);
			});
			child.on('exit', () => {
				clearTimeout(timer);
				reject(new Error(`The desktop helper exited.${stderr ? ` ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`));
				if (this.child === child) {
					this.stop(new Error('The desktop helper exited.'));
				}
			});
		});
		this.child = child;
		return child;
	}

	private helperSource(name: string): string {
		return FileAccess.asFileUri(`vs/platform/voltDesktop/node/helper/${name}`).fsPath;
	}

	/** How to start this OS's helper. */
	private async helperCommand(backend: Backend): Promise<[string, string[]]> {
		const folder = join(this.environmentService.userDataPath, 'volt-desktop');
		switch (backend) {
			case 'mac':
				return [await this.helperBinary(), []];
			case 'windows':
				// The script compiles the C# into this folder once per version of the source.
				await fs.mkdir(folder, { recursive: true });
				return [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperSource('VoltDesktop.windows.ps1'), folder, String(process.pid)]];
			case 'linux':
				return ['python3', [this.helperSource('volt_desktop_linux.py')]];
		}
	}

	/** The compiled helper for the current source, building it when the source changed. */
	private async helperBinary(): Promise<string> {
		const source = this.helperSource('VoltDesktop.swift');
		const code = await fs.readFile(source);
		const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
		const folder = join(this.environmentService.userDataPath, 'volt-desktop');
		const binary = join(folder, `volt-desktop-${hash}`);
		try {
			await fs.access(binary);
			return binary;
		} catch {
			// not built yet
		}
		await fs.mkdir(folder, { recursive: true });
		const partial = `${binary}.${process.pid}.tmp`;
		this.logService.info('[volt-desktop] compiling the desktop helper');
		await new Promise<void>((resolve, reject) => {
			execFile('/usr/bin/xcrun', ['swiftc', '-O', '-o', partial, source], { timeout: 180_000 }, (error, _stdout, stderr) => {
				if (error) {
					const missing = /xcrun: error|no developer tools|invalid active developer path/i.test(`${stderr}${error.message}`);
					reject(new Error(missing
						? 'Desktop control needs the Xcode Command Line Tools to build its helper: run `xcode-select --install`, then try again.'
						: `The desktop helper did not compile: ${(stderr || error.message).split('\n').slice(0, 3).join(' ')}`));
					return;
				}
				resolve();
			});
		});
		await fs.rename(partial, binary);
		return binary;
	}
}
