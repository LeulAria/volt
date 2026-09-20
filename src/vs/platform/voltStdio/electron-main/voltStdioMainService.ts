/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltStdioService, IVoltStdioSpawnOptions } from '../common/voltStdio.js';

const execFileAsync = promisify(execFile);

export class VoltStdioMainService extends Disposable implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
	private readonly stderr = new Map<string, string>();
	private readonly _onData = this._register(new Emitter<{ id: string; data: string }>());
	private readonly _onExit = this._register(new Emitter<{ id: string; code: number | null; stderr?: string }>());
	readonly onData: Event<{ id: string; data: string }> = this._onData.event;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }> = this._onExit.event;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	async spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		const id = generateUuid();
		const child = spawn(options.command, options.args ?? [], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.processes.set(id, child);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (data: string) => this._onData.fire({ id, data }));
		child.stderr.on('data', (data: string) => {
			this.stderr.set(id, tailText(`${this.stderr.get(id) ?? ''}${data}`, 4_000));
			this.logService.warn(`[volt-stdio:${id}] ${data}`);
		});
		child.on('exit', code => {
			const stderr = this.stderr.get(id);
			this.processes.delete(id);
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
		child.kill();
		this.processes.delete(id);
	}

	async which(command: string): Promise<string | undefined> {
		try {
			const tool = process.platform === 'win32' ? 'where' : 'which';
			const { stdout } = await execFileAsync(tool, [command]);
			return stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		} catch {
			return undefined;
		}
	}

	override dispose(): void {
		for (const [id, child] of this.processes) {
			child.kill();
			this.processes.delete(id);
		}
		this.stderr.clear();
		super.dispose();
	}
}

function tailText(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}
