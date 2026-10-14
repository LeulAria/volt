/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { connect } from 'net';
import { IVoltDevServer, portFromLog } from '../common/browserAgent.js';

const LOG_LIMIT = 16 * 1024;

interface IEntry {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: number;
	port?: number;
	exitCode?: number | null;
	log: string;
}

function canConnect(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ port, host: '127.0.0.1' });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(400, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** Ports the process tree under `root` listens on (lsof + ps), lowest first. */
function treePorts(root: number): Promise<number[]> {
	return new Promise(resolve => execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 3000 }, (_err, out) => {
		const children = new Map<number, number[]>();
		for (const line of String(out ?? '').split('\n')) {
			const [pid, ppid] = line.trim().split(/\s+/).map(Number);
			if (pid && ppid) {
				children.set(ppid, [...children.get(ppid) ?? [], pid]);
			}
		}
		const tree = new Set<number>([root]);
		const queue = [root];
		while (queue.length) {
			for (const child of children.get(queue.shift()!) ?? []) {
				if (!tree.has(child)) {
					tree.add(child);
					queue.push(child);
				}
			}
		}
		execFile('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', [...tree].join(','), '-F', 'n'], { timeout: 3000 }, (_e, listing) => {
			const ports = String(listing ?? '').split('\n').map(line => /^n.*:(\d+)$/.exec(line)?.[1]).filter((port): port is string => !!port).map(Number);
			resolve([...new Set(ports)].sort((a, b) => a - b));
		});
	}));
}

/**
 * Dev servers Volt starts for agents: the project's own start command, run once in its folder, so
 * an agent asked to check something in the browser finds the app already serving. Output is kept
 * (agents read it when a page fails), and every server is stopped when Volt quits.
 */
export class DevServers {

	private readonly entries = new Map<number, IEntry>();

	constructor(
		private readonly env: () => Promise<NodeJS.ProcessEnv>,
		private readonly log: (message: string) => void,
	) { }

	async start(cwd: string, command: string, waitMs: number): Promise<IVoltDevServer> {
		const running = [...this.entries.values()].find(entry => entry.cwd === cwd && entry.command === command && entry.exitCode === undefined);
		if (running) {
			return this.waitForPort(running, waitMs);
		}
		const env = await this.env();
		const shell = process.platform === 'win32' ? (env.ComSpec ?? 'cmd.exe') : (env.SHELL || '/bin/zsh');
		const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
		const child = spawn(shell, args, { cwd, env: { ...env, FORCE_COLOR: '0', BROWSER: 'none' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
		if (!child.pid) {
			throw new Error(`Could not start \`${command}\` in ${cwd}.`);
		}
		const entry: IEntry = { child, pid: child.pid, command, cwd, startedAt: Date.now(), log: '' };
		this.entries.set(entry.pid, entry);
		const append = (chunk: Buffer) => {
			entry.log = (entry.log + chunk.toString()).slice(-LOG_LIMIT);
		};
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.on('exit', code => {
			entry.exitCode = code;
			this.log(`[volt] dev server ${entry.pid} (${command}) exited with ${code}`);
		});
		this.log(`[volt] started dev server ${entry.pid}: ${command} in ${cwd}`);
		return this.waitForPort(entry, waitMs);
	}

	private async waitForPort(entry: IEntry, waitMs: number): Promise<IVoltDevServer> {
		const until = Date.now() + waitMs;
		while (entry.port === undefined && entry.exitCode === undefined && Date.now() < until) {
			const announced = portFromLog(entry.log);
			if (announced && await canConnect(announced)) {
				entry.port = announced;
				break;
			}
			const [port] = await treePorts(entry.pid);
			if (port && await canConnect(port)) {
				entry.port = port;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		return this.describe(entry);
	}

	list(): IVoltDevServer[] {
		return [...this.entries.values()].map(entry => this.describe(entry));
	}

	stop(pid: number): boolean {
		const entry = this.entries.get(pid);
		if (!entry) {
			return false;
		}
		this.kill(entry);
		this.entries.delete(pid);
		return true;
	}

	async dispose(): Promise<void> {
		for (const entry of this.entries.values()) {
			this.kill(entry);
		}
		this.entries.clear();
	}

	private kill(entry: IEntry): void {
		if (entry.exitCode !== undefined) {
			return;
		}
		try {
			// The shell's whole process group: `npm run dev` → node → its workers.
			process.kill(process.platform === 'win32' ? entry.pid : -entry.pid, 'SIGTERM');
		} catch {
			entry.child.kill('SIGTERM');
		}
	}

	private describe(entry: IEntry): IVoltDevServer {
		return { pid: entry.pid, command: entry.command, cwd: entry.cwd, startedAt: entry.startedAt, ...(entry.port !== undefined ? { port: entry.port } : {}), ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}), log: entry.log.slice(-4000) };
	}
}
