/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createServer as createHttpServer, IncomingMessage, request } from 'http';
import { connect, createServer, Socket } from 'net';
import { generateUuid } from '../../../base/common/uuid.js';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';

export const DEVICE_HUB_PACKAGE = 'expo-device-hub';
export const DEVICE_HUB_VERSION = '0.15.3';
const READY_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 240_000;
const ATTACH_TIMEOUT = 60_000;

/**
 * Expo's device hub (MIT, https://github.com/expo/expo-device-hub), run as a child on a loopback
 * port. Its serve-sim streams an iOS simulator's screens as H.264 (both displays of an iPhone Duo)
 * and takes touches, keys and hinge commands over a WebSocket, through the simulator's own HID, so
 * no AXe or idb is needed. Installed with npm into `toolsDir` on first use, like T3 Code does.
 */
export class DeviceHub {

	private starting: Promise<{ hub: string; window: string }> | undefined;
	private proxy: ReturnType<typeof createHttpServer> | undefined;
	/** The window's base URL. It outlives hub restarts: the proxy forwards to `hubPort`. */
	private proxyBase: Promise<string> | undefined;
	private hubPort = 0;
	private child: ChildProcess | undefined;
	private disposed = false;
	/**
	 * The boot each attached simulator's helper captures, by its `launchd_sim` pid. A helper
	 * outlives a reboot it did not see and then streams a frozen frame and drops touches.
	 */
	private readonly boots = new Map<string, string>();

	constructor(
		private readonly toolsDir: string,
		private readonly env: () => Promise<NodeJS.ProcessEnv>,
		private readonly which: (name: string) => Promise<string | undefined>,
		private readonly logService: ILogService,
	) {
		process.once('exit', () => this.dispose());
	}

	/**
	 * The hub's origin for this process, and the base URL the window uses: a loopback proxy that
	 * only answers Volt's own window (`vscode-file:` origin) with the random path prefix. The hub
	 * itself answers http(s) origins only, so the window cannot reach it directly.
	 */
	private origin(): Promise<{ hub: string; window: string }> {
		if (!this.starting) {
			const starting = this.start();
			this.starting = starting;
			starting.catch(() => {
				if (this.starting === starting) {
					this.starting = undefined;
				}
			});
		}
		return this.starting;
	}

	/** Attaches serve-sim to a booted simulator (idempotent), then returns the window's base URL. */
	async attach(udid: string): Promise<string> {
		const boot = await this.bootOf(udid);
		const known = this.boots.get(udid);
		if (known && boot && known !== boot) {
			// Rebooted behind the helper's back. serve-sim cannot drop one helper of a running
			// simulator, so the hub starts again (about a second).
			this.logService.info(`[volt-devices] ${udid} rebooted since its stream started; restarting the device hub`);
			await this.restart();
		}
		const { hub: origin, window } = await this.origin();
		const response = await fetch(`${origin}/vendor/serve-sim/grid/api/start`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ udid }),
			signal: AbortSignal.timeout(ATTACH_TIMEOUT),
		});
		const body = await response.json().catch(() => undefined) as { ok?: boolean; error?: string; message?: string } | undefined;
		if (!response.ok || body?.ok === false) {
			throw new Error(`The device hub could not stream ${udid}: ${body?.error ?? body?.message ?? response.status}`);
		}
		if (boot) {
			this.boots.set(udid, boot);
		}
		return window;
	}

	/** The bundle id in front on a streamed simulator, from its helper; undefined when not streamed. */
	async foreground(udid: string): Promise<string | undefined> {
		const starting = this.starting;
		if (!this.boots.has(udid) || !starting) {
			return undefined;
		}
		const { hub } = await starting;
		const response = await fetch(`${hub}/vendor/serve-sim/helper/${encodeURIComponent(udid)}/foreground`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
		const body = await response?.json().catch(() => undefined) as { bundleId?: unknown } | undefined;
		return typeof body?.bundleId === 'string' && body.bundleId ? body.bundleId : undefined;
	}

	/** Whether a helper may be attached to `udid` (so it should hear about a shutdown). */
	streams(udid: string): boolean {
		return this.boots.has(udid);
	}

	/**
	 * Stops `udid`'s helper and shuts the simulator down: serve-sim's own shutdown, which also clears
	 * a helper left over from a shutdown it did not see. False when no helper was attached.
	 */
	async shutdown(udid: string): Promise<boolean> {
		const starting = this.starting;
		if (!this.boots.delete(udid) || !starting) {
			return false;
		}
		const { hub } = await starting;
		await fetch(`${hub}/vendor/serve-sim/grid/api/shutdown`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ udid }),
			signal: AbortSignal.timeout(ATTACH_TIMEOUT),
		}).catch(() => undefined);
		return true;
	}

	/** The pid of the simulator's `launchd_sim`, which changes with every boot. */
	private bootOf(udid: string): Promise<string | undefined> {
		if (!/^[0-9A-F-]{36}$/i.test(udid)) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => execFile('pgrep', ['-f', `launchd_sim .*${udid}`], { timeout: 5000 }, (_error, stdout) => {
			resolve(String(stdout).trim().split(/\s+/)[0] || undefined);
		}));
	}

	private async restart(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		this.boots.clear();
		if (child && child.exitCode === null) {
			const exited = new Promise(resolve => child.once('exit', resolve));
			child.kill();
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.proxy?.close();
		this.proxy = undefined;
		this.proxyBase = undefined;
		this.child?.kill();
		this.child = undefined;
	}

	private async start(): Promise<{ hub: string; window: string }> {
		const entry = await this.install();
		const port = await freePort();
		const env = await this.env();
		// The hub's native modules (serve-sim, node-datachannel) are built for Node, not Electron.
		const node = await this.which('node');
		const command = node ?? process.execPath;
		const childEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: '0', NO_COLOR: '1' };
		if (node) {
			delete childEnv['ELECTRON_RUN_AS_NODE'];
		} else {
			childEnv['ELECTRON_RUN_AS_NODE'] = '1';
		}
		const child = spawn(command, [entry, '--port', String(port), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		this.child = child;
		let output = '';
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString('utf8')).slice(-4000);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		let exited = false;
		child.once('exit', code => {
			exited = true;
			if (this.child === child) {
				this.child = undefined;
				this.starting = undefined;
				this.boots.clear();
			}
			// A restart kills it on purpose (no exit code then).
			if (!this.disposed && code !== null) {
				this.logService.warn(`[volt-devices] device hub exited (${code}): ${output.trim().split('\n').slice(-5).join(' | ')}`);
			}
		});
		const origin = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + READY_TIMEOUT;
		while (Date.now() < deadline) {
			if (exited) {
				throw new Error(`The device hub stopped while starting: ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
			}
			const ready = await fetch(`${origin}/api/devices`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
			if (ready) {
				this.logService.info(`[volt-devices] device hub ${DEVICE_HUB_VERSION} on ${origin} (pid ${child.pid})`);
				this.hubPort = port;
				this.proxyBase ??= this.startProxy();
				return { hub: origin, window: await this.proxyBase };
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		child.kill();
		throw new Error('The device hub did not answer within 30 seconds.');
	}

	/** Forwards `/<token>/...` (HTTP and WebSocket) to the current hub for Volt's window, adding CORS. */
	private async startProxy(): Promise<string> {
		const prefix = `/${generateUuid()}`;
		const allowed = (req: IncomingMessage) => {
			const origin = req.headers.origin;
			return (!origin || origin === 'vscode-file://vscode-app') && !!req.url?.startsWith(`${prefix}/`);
		};
		const cors = (req: IncomingMessage): Record<string, string> => req.headers.origin ? {
			'access-control-allow-origin': req.headers.origin,
			'access-control-allow-headers': 'content-type',
			'access-control-allow-methods': 'GET, POST, OPTIONS',
		} : {};
		const upstreamHeaders = (req: IncomingMessage) => {
			const headers = { ...req.headers, host: `127.0.0.1:${this.hubPort}` };
			delete headers.origin;
			delete headers.referer;
			return headers;
		};
		const proxy = createHttpServer((req, res) => {
			if (!allowed(req)) {
				res.writeHead(403).end();
				return;
			}
			if (req.method === 'OPTIONS') {
				res.writeHead(204, cors(req)).end();
				return;
			}
			const upstream = request({ host: '127.0.0.1', port: this.hubPort, path: req.url!.slice(prefix.length), method: req.method, headers: upstreamHeaders(req) }, response => {
				res.writeHead(response.statusCode ?? 502, { ...response.headers, ...cors(req) });
				response.pipe(res);
			});
			upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
			res.on('close', () => upstream.destroy());
			req.pipe(upstream);
		});
		proxy.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
			if (!allowed(req)) {
				socket.destroy();
				return;
			}
			// Touches are tiny writes: send each at once instead of waiting to batch them.
			socket.setNoDelay(true);
			const upstream = connect(this.hubPort, '127.0.0.1', () => {
				upstream.setNoDelay(true);
				const lines = [`${req.method} ${req.url!.slice(prefix.length)} HTTP/1.1`];
				for (const [name, value] of Object.entries(upstreamHeaders(req))) {
					for (const item of Array.isArray(value) ? value : [value]) {
						if (item !== undefined) {
							lines.push(`${name}: ${item}`);
						}
					}
				}
				upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
				if (head.length) {
					upstream.write(head);
				}
				socket.pipe(upstream).pipe(socket);
			});
			const close = () => {
				socket.destroy();
				upstream.destroy();
			};
			upstream.on('error', close);
			socket.on('error', close);
			upstream.on('close', close);
			socket.on('close', close);
		});
		const port = await new Promise<number>((resolve, reject) => {
			proxy.once('error', reject);
			proxy.listen(0, '127.0.0.1', () => {
				const address = proxy.address();
				resolve(typeof address === 'object' && address ? address.port : 0);
			});
		});
		this.proxy = proxy;
		return `http://127.0.0.1:${port}${prefix}`;
	}

	/** The hub's CLI entry, installing `expo-device-hub` with npm the first time. */
	private async install(): Promise<string> {
		const dir = join(this.toolsDir, DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION);
		const entry = join(dir, 'node_modules', DEVICE_HUB_PACKAGE, 'dist', 'server', 'cli.mjs');
		const sentinel = join(dir, '.install-complete');
		if (await fs.readFile(sentinel, 'utf8').then(text => text.trim() === DEVICE_HUB_VERSION, () => false)) {
			return entry;
		}
		const npm = await this.which('npm');
		if (!npm) {
			throw new Error('Live simulator streaming needs npm to install Expo\'s device hub once. Install Node.js (https://nodejs.org) and try again.');
		}
		this.logService.info(`[volt-devices] installing ${DEVICE_HUB_PACKAGE}@${DEVICE_HUB_VERSION} into ${dir}`);
		const staging = `${dir}.staging-${process.pid}`;
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(staging, { recursive: true });
		const env = await this.env();
		await new Promise<void>((resolve, reject) => {
			execFile(npm, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', `${DEVICE_HUB_PACKAGE}@${DEVICE_HUB_VERSION}`], { env: { ...env, ELECTRON_RUN_AS_NODE: undefined }, timeout: INSTALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(`Could not install Expo's device hub: ${String(stderr).trim().split('\n').pop() || error.message}`));
				} else {
					resolve();
				}
			});
		});
		await fs.writeFile(join(staging, '.install-complete'), `${DEVICE_HUB_VERSION}\n`);
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rename(staging, dir);
		return entry;
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => port ? resolve(port) : reject(new Error('No free port for the device hub')));
		});
	});
}
