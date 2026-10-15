/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, extname, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IVoltLocalServer, IVoltPlayground, IVoltPlaygroundMock, IVoltPlaygroundRequest, IVoltPlaygroundUpdate, matchPlaygroundMock, PLAYGROUND_CONTENT_TYPES, safePlaygroundPath } from '../common/browserAgent.js';

/** Every playground folder lives here, so a sweep can never touch anything else. */
export const PLAYGROUND_ROOT = join(tmpdir(), 'volt-playgrounds');
/** Folders left behind by a crash are removed at the next start after this long. */
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYGROUNDS_PER_CHAT = 12;

interface IEntry {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly dir: string;
	readonly createdAt: number;
	readonly server: http.Server;
	url: string;
	files: Set<string>;
	mocks: readonly IVoltPlaygroundMock[];
	requests: number;
}

/**
 * Throwaway sites for agents: each one is a folder under the OS temp dir served on its own
 * loopback port, so absolute paths (`/api/stats`, `/app.js`) and ES modules work like on a real
 * origin, and nothing is ever written into the user's project.
 */
export class BrowserPlaygrounds {

	private readonly entries = new Map<string, IEntry>();

	constructor(private readonly log: (message: string) => void) {
		void this.sweep();
	}

	async create(request: IVoltPlaygroundRequest): Promise<IVoltPlayground> {
		const mine = [...this.entries.values()].filter(entry => entry.sessionId === request.sessionId);
		if (mine.length >= MAX_PLAYGROUNDS_PER_CHAT) {
			throw new Error(`This chat already has ${mine.length} playgrounds; delete some with playground_delete first.`);
		}
		const id = `pg-${generateUuid().slice(0, 8)}`;
		const dir = join(PLAYGROUND_ROOT, id);
		await fs.mkdir(dir, { recursive: true });
		const entry: IEntry = {
			id,
			sessionId: request.sessionId,
			title: request.title?.trim() || 'Playground',
			dir,
			createdAt: Date.now(),
			server: http.createServer((req, res) => void this.serve(entry, req, res)),
			url: '',
			files: new Set(),
			mocks: request.mocks ?? [],
			requests: 0,
		};
		await this.writeFiles(entry, request.files);
		await new Promise<void>((resolve, reject) => {
			entry.server.once('error', reject);
			entry.server.listen(0, '127.0.0.1', () => resolve());
		});
		entry.url = `http://127.0.0.1:${(entry.server.address() as AddressInfo).port}/`;
		this.entries.set(id, entry);
		this.log(`[volt] playground ${id} serving ${dir} at ${entry.url}`);
		return this.describe(entry);
	}

	async update(update: IVoltPlaygroundUpdate): Promise<IVoltPlayground> {
		const entry = this.entries.get(update.id);
		if (!entry) {
			throw new Error(`No playground ${update.id}. playground_list shows the current ones.`);
		}
		for (const path of update.remove ?? []) {
			const safe = safePlaygroundPath(path);
			if (safe && entry.files.delete(safe)) {
				await fs.rm(join(entry.dir, safe), { force: true });
			}
		}
		if (update.files) {
			await this.writeFiles(entry, update.files);
		}
		if (update.mocks) {
			entry.mocks = update.mocks;
		}
		return this.describe(entry);
	}

	list(sessionId?: string): IVoltPlayground[] {
		return [...this.entries.values()].filter(entry => !sessionId || entry.sessionId === sessionId).map(entry => this.describe(entry));
	}

	async delete(selector: { readonly id?: string; readonly sessionId?: string }): Promise<IVoltPlayground[]> {
		const doomed = [...this.entries.values()].filter(entry => selector.id ? entry.id === selector.id : !!selector.sessionId && entry.sessionId === selector.sessionId);
		const removed: IVoltPlayground[] = [];
		for (const entry of doomed) {
			this.entries.delete(entry.id);
			await new Promise<void>(resolve => {
				entry.server.close(() => resolve());
				entry.server.closeAllConnections?.();
			});
			await fs.rm(entry.dir, { recursive: true, force: true });
			removed.push(this.describe(entry));
			this.log(`[volt] playground ${entry.id} deleted`);
		}
		return removed;
	}

	/** Stops every server and removes every folder (app quit). */
	async dispose(): Promise<void> {
		await Promise.all([...this.entries.keys()].map(id => this.delete({ id })));
	}

	private describe(entry: IEntry): IVoltPlayground {
		return { id: entry.id, sessionId: entry.sessionId, title: entry.title, url: entry.url, dir: entry.dir, files: [...entry.files].sort(), mocks: entry.mocks.length, createdAt: entry.createdAt, requests: entry.requests };
	}

	private async writeFiles(entry: IEntry, files: Readonly<Record<string, string>>): Promise<void> {
		for (const [path, content] of Object.entries(files)) {
			const safe = safePlaygroundPath(path);
			if (!safe) {
				continue;
			}
			const target = join(entry.dir, safe);
			await fs.mkdir(dirname(target), { recursive: true });
			await fs.writeFile(target, content);
			entry.files.add(safe);
		}
	}

	private async serve(entry: IEntry, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		entry.requests++;
		const host = (req.headers.host ?? '').replace(/:\d+$/, '');
		if (host !== '127.0.0.1' && host !== 'localhost') {
			res.writeHead(403).end('Forbidden');
			return;
		}
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const mock = matchPlaygroundMock(entry.mocks, decodeURIComponent(url.pathname), req.method ?? 'GET');
		if (mock) {
			if (mock.delayMs) {
				await new Promise(resolve => setTimeout(resolve, mock.delayMs));
			}
			res.writeHead(mock.status, { 'content-type': mock.contentType, 'cache-control': 'no-store' });
			res.end(mock.body);
			return;
		}
		const requested = decodeURIComponent(url.pathname);
		let path = safePlaygroundPath(requested) ?? '';
		if (!path && requested.replace(/\/+$/, '') !== '') {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
			return;
		}
		if (!path || url.pathname.endsWith('/')) {
			path = path ? `${path}/index.html` : 'index.html';
		}
		if (!entry.files.has(path) && entry.files.has(`${path}/index.html`)) {
			path = `${path}/index.html`;
		}
		if (!entry.files.has(path)) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
			res.end(`Not found: /${path}`);
			return;
		}
		try {
			const content = await fs.readFile(join(entry.dir, path));
			res.writeHead(200, { 'content-type': PLAYGROUND_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
			res.end(content);
		} catch {
			res.writeHead(500).end('Could not read the file');
		}
	}

	/** Removes folders a crashed or killed Volt left behind. Only ever looks inside PLAYGROUND_ROOT. */
	private async sweep(): Promise<void> {
		try {
			const names = await fs.readdir(PLAYGROUND_ROOT);
			for (const name of names) {
				if (!/^pg-[0-9a-f]{8}$/.test(name)) {
					continue;
				}
				const stat = await fs.stat(join(PLAYGROUND_ROOT, name)).catch(() => undefined);
				if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
					await fs.rm(join(PLAYGROUND_ROOT, name), { recursive: true, force: true });
				}
			}
		} catch {
			// No folder yet.
		}
	}
}

function run(file: string, args: readonly string[]): Promise<string> {
	return new Promise(resolve => execFile(file, args as string[], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? ''))));
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output into (pid, command, address, port) rows. */
export function parseLsofListen(output: string): { pid: number; command: string; address: string; port: number }[] {
	const rows: { pid: number; command: string; address: string; port: number }[] = [];
	let pid = 0;
	let command = '';
	for (const line of output.split('\n')) {
		const tag = line[0];
		const value = line.slice(1);
		if (tag === 'p') {
			pid = Number(value);
		} else if (tag === 'c') {
			command = value;
		} else if (tag === 'n') {
			const match = /^(.*):(\d+)$/.exec(value);
			if (match && pid) {
				rows.push({ pid, command, address: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) });
			}
		}
	}
	return rows;
}

/** Dev servers and other listeners on this machine (macOS and Linux, via lsof). Volt's own processes are left out. */
export async function listLocalServers(ownPids: ReadonlySet<number>): Promise<IVoltLocalServer[]> {
	if (process.platform === 'win32') {
		return [];
	}
	const rows = parseLsofListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']))
		.filter(row => !ownPids.has(row.pid) && row.port >= 1024 && (row.address === '*' || row.address === '127.0.0.1' || row.address === '::1' || row.address === '0.0.0.0' || row.address === '::' || row.address === 'localhost'));
	const seen = new Set<string>();
	const unique = rows.filter(row => {
		const key = `${row.pid}:${row.port}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	}).slice(0, 40);
	const pids = [...new Set(unique.map(row => row.pid))];
	const cwds = new Map<number, string>();
	const commands = new Map<number, string>();
	if (pids.length) {
		let pid = 0;
		for (const line of (await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'])).split('\n')) {
			if (line[0] === 'p') {
				pid = Number(line.slice(1));
			} else if (line[0] === 'n' && pid) {
				cwds.set(pid, line.slice(1));
			}
		}
		for (const line of (await run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')])).split('\n')) {
			const match = /^\s*(\d+)\s+(.*)$/.exec(line);
			if (match) {
				commands.set(Number(match[1]), match[2].slice(0, 200));
			}
		}
	}
	return unique.map(row => ({ port: row.port, pid: row.pid, address: row.address, command: commands.get(row.pid) ?? row.command, cwd: cwds.get(row.pid) })).sort((a, b) => a.port - b.port);
}
