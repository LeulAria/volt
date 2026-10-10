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
import { IVoltDesktopApp, IVoltDesktopService, IVoltDesktopStatus, IVoltDesktopTree, VoltDesktopAction } from '../common/voltDesktop.js';

interface IPending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS: Partial<Record<string, number>> = { tree: 20_000, activate: 20_000, menu: 10_000, type: 30_000 };

/**
 * Runs `VoltDesktop.swift` (compiled on first use with the system's Swift compiler and cached by
 * the source's hash in Volt's data folder) and sends it one JSON request per line. A request that
 * does not answer in time restarts the helper, so one stuck app never blocks the next call.
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

	async status(prompt = false): Promise<IVoltDesktopStatus> {
		if (process.platform !== 'darwin') {
			return { supported: false, trusted: false, screen: false, error: 'Desktop control works on macOS for now.' };
		}
		try {
			const result = await this.request('status', { prompt }) as { trusted: boolean; screen: boolean };
			return { supported: true, trusted: result.trusted, screen: result.screen };
		} catch (err) {
			return { supported: true, trusted: false, screen: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async apps(): Promise<IVoltDesktopApp[]> {
		return await this.request('apps', {}) as IVoltDesktopApp[];
	}

	async tree(target: { readonly app?: string; readonly pid?: number; readonly window?: string; readonly max?: number }): Promise<IVoltDesktopTree> {
		return await this.request('tree', { ...target }) as IVoltDesktopTree;
	}

	async act(action: VoltDesktopAction): Promise<void> {
		const { kind, ...args } = action;
		await this.request(kind, args);
	}

	private async request(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		if (process.platform !== 'darwin') {
			throw new Error('Desktop control works on macOS for now.');
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
		const binary = await this.helperBinary();
		const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdout?.setEncoding('utf8');
		child.stderr?.on('data', chunk => this.logService.trace('[volt-desktop] helper:', String(chunk)));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('The desktop helper did not start.')), 10_000);
			child.stdout?.on('data', (chunk: string) => {
				this.buffer += chunk;
				for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
					const line = this.buffer.slice(0, at);
					this.buffer = this.buffer.slice(at + 1);
					let reply: { id?: number; ok?: boolean; result?: unknown; error?: string };
					try {
						reply = JSON.parse(line);
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
				reject(err);
			});
			child.on('exit', () => {
				clearTimeout(timer);
				reject(new Error('The desktop helper exited.'));
				if (this.child === child) {
					this.stop(new Error('The desktop helper exited.'));
				}
			});
		});
		this.child = child;
		return child;
	}

	/** The compiled helper for the current source, building it when the source changed. */
	private async helperBinary(): Promise<string> {
		const source = FileAccess.asFileUri('vs/platform/voltDesktop/node/helper/VoltDesktop.swift').fsPath;
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
