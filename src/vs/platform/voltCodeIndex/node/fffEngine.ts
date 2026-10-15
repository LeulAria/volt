/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { get } from 'https';
import type { IncomingMessage } from 'http';
import { delimiter, dirname, join, relative, sep } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { IVoltFffStatus } from '../common/voltCodeIndex.js';
import { FFF_VERSION, fffAsset, parseFffFindFiles, parseFffVersion } from '../common/fff.js';

/** A warm FFF answers in 1-5 ms; anything slower than this is broken or overloaded. */
const CALL_TIMEOUT_MS = 2_500;
/**
 * The first call waits for FFF's initial scan (0.4 s for 100k files measured); past this the index
 * answers and FFF keeps scanning in its own process for the next call.
 */
const FIRST_CALL_TIMEOUT_MS = 3_000;
/** After a failed start, the next try for that folder. */
const RETRY_AFTER_MS = 60_000;
/** FFF exits on its own after this much idle time (and when Volt's index process exits). */
const IDLE_TIMEOUT_SECS = 20 * 60;
/**
 * FFF processes alive at once, least recently used stopped first. Each holds its folder's file
 * list and a watcher, and chats in their own worktrees each have a folder: without a cap, parallel
 * chats left one process per worktree running.
 */
const MAX_PROCESSES = 2;
const VERSION_TTL_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface IRpcResponse {
	readonly id?: number;
	readonly result?: { readonly content?: readonly { readonly type: string; readonly text?: string }[]; readonly isError?: boolean };
	readonly error?: { readonly message?: string };
}

/** One `fff-mcp` process serving one folder over MCP's newline-delimited JSON-RPC on stdio. */
class FffProcess {

	private readonly child: ChildProcess;
	private buffer = '';
	private nextId = 0;
	private readonly pending = new Map<number, { resolve(response: IRpcResponse): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private readonly ready: Promise<void>;
	exited: string | undefined;
	answered = false;

	constructor(binary: string, readonly base: string, dataDir: string, private readonly log: (message: string) => void, private readonly timeouts: IFffTimeouts) {
		const args = [
			'--no-update-check',
			'--idle-timeout-secs', String(IDLE_TIMEOUT_SECS),
			'--frecency-db', join(dataDir, 'frecency.db'),
			'--history-db', join(dataDir, 'history.db'),
			'--log-file', join(dataDir, 'logs', 'fff_mcp.log'),
			base,
		];
		// No shell: the folder is an argument, never part of a command line.
		this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
		this.child.stdout!.setEncoding('utf8');
		this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
		this.child.on('error', err => this.onExit(`failed to start: ${err.message}`));
		this.child.on('exit', (code, signal) => this.onExit(`exited (${signal ?? code})`));
		this.child.stdin!.on('error', () => { /* reported by exit */ });
		this.ready = this.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'volt', version: FFF_VERSION },
		}, timeouts.callMs).then(() => this.notify('notifications/initialized'));
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			let message: IRpcResponse;
			try {
				message = JSON.parse(line) as IRpcResponse;
			} catch {
				this.log(`[fff] unexpected output: ${line.slice(0, 200)}`);
				continue;
			}
			const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
			if (waiter) {
				this.pending.delete(message.id!);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
		}
	}

	private onExit(reason: string): void {
		this.exited ??= reason;
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`FFF ${reason}`));
		}
		this.pending.clear();
	}

	private notify(method: string): void {
		this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
	}

	private request(method: string, params: object, timeoutMs: number): Promise<IRpcResponse> {
		if (this.exited) {
			return Promise.reject(new Error(`FFF ${this.exited}`));
		}
		const id = ++this.nextId;
		return new Promise<IRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`FFF did not answer within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	/** The first text block of a tool's answer. */
	async callTool(name: string, args: object): Promise<string> {
		await this.ready;
		const response = await this.request('tools/call', { name, arguments: args }, this.answered ? this.timeouts.callMs : this.timeouts.firstCallMs);
		if (response.error) {
			throw new Error(`FFF: ${response.error.message ?? 'error'}`);
		}
		const text = response.result?.content?.find(block => block.type === 'text')?.text ?? '';
		if (response.result?.isError) {
			throw new Error(`FFF: ${text.slice(0, 200)}`);
		}
		this.answered = true;
		return text;
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	dispose(): void {
		this.onExit('stopped');
		this.child.kill();
	}
}

export interface IFffTimeouts {
	readonly callMs: number;
	readonly firstCallMs: number;
	readonly retryAfterMs: number;
}

const DEFAULT_TIMEOUTS: IFffTimeouts = { callMs: CALL_TIMEOUT_MS, firstCallMs: FIRST_CALL_TIMEOUT_MS, retryAfterMs: RETRY_AFTER_MS };

export type FffFindResult =
	| { readonly kind: 'results'; readonly paths: readonly string[]; readonly total?: number }
	| { readonly kind: 'skipped'; readonly reason: string };

/** The folder FFF indexes for `root`: it moves up to the git work tree, as `fff-mcp` does. */
export async function fffBaseFor(root: string): Promise<string> {
	let dir = root;
	for (let i = 0; i < 64; i++) {
		if (await fs.stat(join(dir, '.git')).then(() => true, () => false)) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return root;
}

/** Root-relative paths from base-relative ones, dropping what lies outside `root`. */
export function toRootPaths(paths: readonly string[], base: string, root: string): string[] {
	const prefix = relative(base, root).split(sep).join('/');
	if (!prefix) {
		return [...paths];
	}
	const head = `${prefix}/`;
	return paths.filter(path => path.startsWith(head)).map(path => path.slice(head.length));
}

/**
 * FFF for Volt's code index process: finds the binary, keeps one process per folder, and maps
 * its answers to the index's root-relative paths. Every failure is a `skipped` answer with the
 * reason, never an exception, so the index's own fuzzy search can answer instead.
 */
export class FffEngine {

	private readonly processes = new Map<string, FffProcess>();
	private readonly failedAt = new Map<string, { at: number; reason: string }>();
	private versionCache: { key: string; at: number; status: IVoltFffStatus } | undefined;
	private installing: Promise<IVoltFffStatus> | undefined;

	constructor(
		/** Volt's tools folder; FFF goes in `fff/<version>` below it. */
		private readonly toolsDir: string,
		private readonly log: (message: string) => void,
		private readonly timeouts: IFffTimeouts = DEFAULT_TIMEOUTS,
	) { }

	private get fffDir(): string {
		return join(this.toolsDir, 'fff');
	}

	private get managedBinary(): string {
		return join(this.fffDir, FFF_VERSION, isWindows ? 'fff-mcp.exe' : 'fff-mcp');
	}

	private async onPath(): Promise<string | undefined> {
		const names = isWindows ? ['fff-mcp.exe'] : ['fff-mcp'];
		for (const dir of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
			for (const name of names) {
				const candidate = join(dir, name);
				if (await fs.access(candidate).then(() => true, () => false)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	/** The binary to run: the setting, then Volt's install, then PATH. */
	private async resolve(settingPath: string | undefined): Promise<{ path: string; managed: boolean } | undefined> {
		if (settingPath) {
			return { path: settingPath, managed: false };
		}
		if (await fs.access(this.managedBinary).then(() => true, () => false)) {
			return { path: this.managedBinary, managed: true };
		}
		const found = await this.onPath();
		return found ? { path: found, managed: false } : undefined;
	}

	private version(binary: string): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(binary, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
				const version = parseFffVersion(String(stdout));
				if (version) {
					resolve(version);
				} else {
					reject(err ?? new Error(`unexpected --version output: ${String(stdout).slice(0, 100)}`));
				}
			});
		});
	}

	async status(settingPath?: string): Promise<IVoltFffStatus> {
		const key = settingPath ?? '';
		if (this.versionCache && this.versionCache.key === key && Date.now() - this.versionCache.at < VERSION_TTL_MS) {
			return { ...this.versionCache.status, running: this.running() };
		}
		const base = { bundledVersion: FFF_VERSION, running: this.running() };
		let status: IVoltFffStatus;
		const found = await this.resolve(settingPath);
		if (!found) {
			status = { ...base, state: fffAsset(process.platform, process.arch) ? 'missing' : 'unsupported' };
		} else {
			try {
				status = { ...base, state: 'ready', path: found.path, managed: found.managed, version: await this.version(found.path) };
			} catch (err) {
				status = { ...base, state: 'error', path: found.path, managed: found.managed, error: err instanceof Error ? err.message : String(err) };
			}
		}
		this.versionCache = { key, at: Date.now(), status };
		return status;
	}

	private running(): number {
		let count = 0;
		for (const process of this.processes.values()) {
			if (!process.exited) {
				count++;
			}
		}
		return count;
	}

	async findFiles(root: string, query: string, limit: number, settingPath?: string): Promise<FffFindResult> {
		const base = await fffBaseFor(root);
		const failed = this.failedAt.get(base);
		if (failed && Date.now() - failed.at < this.timeouts.retryAfterMs) {
			return { kind: 'skipped', reason: failed.reason };
		}
		let process = this.processes.get(base);
		if (!process || process.exited) {
			const status = await this.status(settingPath);
			if (status.state !== 'ready' || !status.path) {
				return { kind: 'skipped', reason: status.state === 'error' ? `FFF unusable: ${status.error}` : 'FFF not installed' };
			}
			process?.dispose();
			this.processes.delete(base);
			for (const [folder, older] of this.processes) {
				if (this.processes.size < MAX_PROCESSES) {
					break;
				}
				older.dispose();
				this.processes.delete(folder);
				this.log(`[fff] stopped ${folder} (at most ${MAX_PROCESSES} at once)`);
			}
			process = new FffProcess(status.path, base, this.fffDir, this.log, this.timeouts);
			this.log(`[fff] started ${status.path} (${status.version}) for ${base}`);
		}
		// Most recently used last: the first entries are the ones stopped for a new folder.
		this.processes.delete(base);
		this.processes.set(base, process);
		const scoped = relative(base, root).split(sep).join('/');
		try {
			// A path prefix narrows FFF to the project when the git root is above it.
			const text = await process.callTool('find_files', { query: scoped ? `${scoped}/ ${query}` : query, maxResults: limit + 10 });
			const parsed = parseFffFindFiles(text);
			const paths = toRootPaths(parsed.paths, base, root);
			this.failedAt.delete(base);
			return { kind: 'results', paths, ...(parsed.total !== undefined && !scoped ? { total: parsed.total } : {}) };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (process.exited) {
				this.processes.delete(base);
				this.failedAt.set(base, { at: Date.now(), reason });
			}
			this.log(`[fff] ${base}: ${reason}`);
			return { kind: 'skipped', reason };
		}
	}

	/** Downloads the pinned release binary for this machine, checks its SHA-256, and puts it in place. */
	install(): Promise<IVoltFffStatus> {
		this.installing ??= this.doInstall().finally(() => this.installing = undefined);
		return this.installing;
	}

	private async doInstall(): Promise<IVoltFffStatus> {
		const musl = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
		const asset = fffAsset(process.platform, process.arch, musl);
		if (!asset) {
			return { state: 'unsupported', bundledVersion: FFF_VERSION, running: this.running(), error: `FFF has no release for ${process.platform}-${process.arch}` };
		}
		const target = this.managedBinary;
		const temp = `${target}.${process.pid}.download`;
		await fs.mkdir(dirname(target), { recursive: true });
		try {
			const sha256 = await download(asset.url, temp);
			if (sha256 !== asset.sha256) {
				throw new Error(`checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${sha256}`);
			}
			await fs.chmod(temp, 0o755);
			await fs.rename(temp, target);
			this.log(`[fff] installed ${asset.name} ${FFF_VERSION}`);
		} catch (err) {
			await fs.rm(temp, { force: true });
			return { state: 'error', bundledVersion: FFF_VERSION, running: this.running(), error: err instanceof Error ? err.message : String(err) };
		}
		this.versionCache = undefined;
		this.failedAt.clear();
		return this.status();
	}

	/** Stops the process serving `root` (its folder was unloaded). */
	async stop(root: string): Promise<void> {
		const base = await fffBaseFor(root);
		this.processes.get(base)?.dispose();
		this.processes.delete(base);
	}

	dispose(): void {
		for (const process of this.processes.values()) {
			process.dispose();
		}
		this.processes.clear();
	}
}

/** Streams `url` (following redirects) into `file`; returns the SHA-256 of what was written. */
function download(url: string, file: string, redirects = 5): Promise<string> {
	return new Promise((resolve, reject) => {
		const request = get(url, { headers: { 'User-Agent': 'Volt' }, timeout: DOWNLOAD_TIMEOUT_MS }, (response: IncomingMessage) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirects <= 0) {
					reject(new Error('too many redirects'));
					return;
				}
				const next = new URL(response.headers.location, url);
				if (next.protocol !== 'https:') {
					reject(new Error(`refusing a non-https redirect to ${next.host}`));
					return;
				}
				download(next.href, file, redirects - 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`download failed: HTTP ${status}`));
				return;
			}
			const hash = createHash('sha256');
			const out = createWriteStream(file, { mode: 0o600 });
			response.on('data', (chunk: Buffer) => hash.update(chunk));
			response.pipe(out);
			out.on('finish', () => resolve(hash.digest('hex')));
			out.on('error', reject);
			response.on('error', reject);
		});
		request.on('timeout', () => request.destroy(new Error('download timed out')));
		request.on('error', reject);
	});
}
