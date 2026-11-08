/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { IncomingMessage, request, type Server } from 'http';
import { connect } from 'net';
import { delimiter, join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { createAuthenticatedServer, freeLoopbackPort, ListenerAuth, listenOn, loopbackHostNames, newListenerSecret, secretsEqual } from '../../voltListeners/node/listenerAuth.js';
import { childEnvFromHost } from '../../voltHelpers/common/childEnv.js';
import { HelperIntegrity, helperIntegrity } from '../../voltHelpers/node/helperIntegrity.js';
import { DEVICE_HUB_LOCKFILE, DEVICE_HUB_MANIFEST, DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION } from '../common/deviceHubPin.js';

export { DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION };
/** What a finished install says in `.install-complete`: installs from before the pin are redone. */
const INSTALL_SENTINEL = `pinned ${DEVICE_HUB_VERSION}`;
const READY_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 240_000;
const ATTACH_TIMEOUT = 60_000;

/**
 * Expo's device hub (MIT, https://github.com/expo/expo-device-hub), run as a child on a loopback
 * port. Its serve-sim streams an iOS simulator's screens as H.264 (both displays of an iPhone Duo)
 * and takes touches, keys and hinge commands over a WebSocket, through the simulator's own HID, so
 * no AXe or idb is needed. Installed with `npm ci` into `toolsDir` on first use from a lockfile
 * pinned in Volt's code (every package's registry integrity, no install scripts); the whole tree
 * is checked against a pinned digest before every launch (spec I.11, B-14).
 */
export class DeviceHub {

	private starting: Promise<{ hub: string; window: string }> | undefined;
	private proxy: Server | undefined;
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
		/** Folders to put first on the hub's PATH: serve-emu runs `adb` by name, which the SDK does not put on PATH. */
		private readonly extraPath: () => Promise<readonly string[]> = async () => [],
		private readonly integrity: HelperIntegrity = helperIntegrity(),
	) {
		process.once('exit', () => this.dispose());
	}

	/** Installs and starts the hub ahead of the first attach. */
	async prewarm(): Promise<void> {
		await this.origin();
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
		// Attached right after `simctl boot`, launchd_sim may not have been up yet.
		const captured = boot ?? await this.bootOf(udid);
		if (captured) {
			this.boots.set(udid, captured);
		}
		return window;
	}

	/**
	 * The window's base URL for a running Android device's stream. serve-emu starts its capture
	 * when the window's socket opens (`/vendor/serve-emu/ws?device=<serial>`); asking for its
	 * stream mode here starts it a little earlier.
	 */
	async attachAndroid(serial: string): Promise<string> {
		const { hub, window } = await this.origin();
		const response = await fetch(`${hub}/vendor/serve-emu/api/stream-mode?device=${encodeURIComponent(serial)}`, { signal: AbortSignal.timeout(ATTACH_TIMEOUT) }).catch(() => undefined);
		const body = await response?.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined;
		if (body?.ok === false) {
			throw new Error(`The device hub could not stream ${serial}: ${body.error ?? response?.status}`);
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
		const port = await freeLoopbackPort();
		const env = childEnvFromHost(await this.env());
		// The hub's native modules (serve-sim, node-datachannel) are built for Node, not Electron.
		const node = await this.which('node');
		const command = node ?? process.execPath;
		const extra = await this.extraPath().catch(() => []);
		const childEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: '0', NO_COLOR: '1' };
		if (extra.length) {
			childEnv.PATH = [...extra, env.PATH].filter(Boolean).join(delimiter);
		}
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
		const started = Date.now();
		const deadline = started + READY_TIMEOUT;
		while (Date.now() < deadline) {
			if (exited) {
				throw new Error(`The device hub stopped while starting: ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
			}
			// Its page, not /api/devices: that lists every simulator and emulator (8 s with an emulator running).
			const ready = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
			if (ready) {
				this.logService.info(`[volt-devices] device hub ${DEVICE_HUB_VERSION} on ${origin} (pid ${child.pid}, ready in ${Date.now() - started} ms)`);
				this.hubPort = port;
				this.proxyBase ??= this.startProxy();
				return { hub: origin, window: await this.proxyBase };
			}
			// It usually answers within a second: look often until then.
			await new Promise(resolve => setTimeout(resolve, Date.now() - started < 1000 ? 50 : 250));
		}
		child.kill();
		throw new Error('The device hub did not answer within 30 seconds.');
	}

	/**
	 * Forwards `/<secret>/...` (HTTP and WebSocket) to the current hub for Volt's window, adding
	 * CORS. The path's first segment is a per-launch bearer (the window can't put a header on a
	 * `<video>` or a WebSocket), checked by the listener library: Host must be loopback, sockets and
	 * writes need the window's Origin.
	 */
	private async startProxy(): Promise<string> {
		const secret = newListenerSecret();
		const prefix = `/${secret}`;
		let port = 0;
		const auth = new ListenerAuth<true>({
			hosts: () => ({ names: loopbackHostNames(port) }),
			extract: req => {
				const match = /^\/([A-Za-z0-9_-]{43})\//.exec(req.url ?? '');
				return match ? { secret: match[1], via: 'path' } : undefined;
			},
			verify: candidate => secretsEqual(candidate, secret) || undefined,
			browserOrigins: ['vscode-file://vscode-app'],
		});
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
		const proxy = createAuthenticatedServer(auth, (req, res) => {
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
		}, (req, socket, head) => {
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
		port = await listenOn(proxy, 0);
		this.proxy = proxy;
		return `http://127.0.0.1:${port}${prefix}`;
	}

	/**
	 * The hub's CLI entry: installs the pinned tree the first time (or over an install from before
	 * the pin), then checks the installed tree. A tree that does not match is refused, never run.
	 */
	private async install(): Promise<string> {
		const dir = join(this.toolsDir, DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION);
		const entry = join(dir, 'node_modules', DEVICE_HUB_PACKAGE, 'dist', 'server', 'cli.mjs');
		const sentinel = join(dir, '.install-complete');
		if (!await fs.readFile(sentinel, 'utf8').then(text => text.trim() === INSTALL_SENTINEL, () => false)) {
			await this.installPinned(dir);
		}
		// Before every launch: a file changed since the install is refused.
		await this.integrity.assert('device-hub', dir);
		return entry;
	}

	private async installPinned(dir: string): Promise<void> {
		const npm = await this.which('npm');
		if (!npm) {
			throw new Error('Live simulator streaming needs npm to install Expo\'s device hub once. Install Node.js (https://nodejs.org) and try again.');
		}
		this.logService.info(`[volt-devices] installing ${DEVICE_HUB_PACKAGE}@${DEVICE_HUB_VERSION} (pinned) into ${dir}`);
		const staging = `${dir}.staging-${process.pid}`;
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(staging, { recursive: true });
		try {
			await fs.writeFile(join(staging, 'package.json'), JSON.stringify(DEVICE_HUB_MANIFEST, null, '\t'));
			await fs.writeFile(join(staging, 'package-lock.json'), JSON.stringify(DEVICE_HUB_LOCKFILE, null, '\t'));
			const env = childEnvFromHost(await this.env());
			// `npm ci` installs exactly the lockfile and checks every tarball against its integrity
			// hash; no package runs an install script.
			await new Promise<void>((resolve, reject) => {
				execFile(npm, ['ci', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], { cwd: staging, env, timeout: INSTALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
					if (error) {
						reject(new Error(`Could not install Expo's device hub: ${String(stderr).trim().split('\n').pop() || error.message}`));
					} else {
						resolve();
					}
				});
			});
			await this.integrity.assert('device-hub', staging);
			await fs.writeFile(join(staging, '.install-complete'), `${INSTALL_SENTINEL}\n`);
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rename(staging, dir);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}
}
