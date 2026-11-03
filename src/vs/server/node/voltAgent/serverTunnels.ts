/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { constants as fsConstants, promises as fs } from 'fs';
import { Resolver } from 'dns';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { connect, LookupFunction } from 'net';
import { homedir, hostname, userInfo } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename, delimiter, join } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IVoltConnectStatus, IVoltSshTunnelOptions, IVoltTunnelStatus, VOLT_ENVIRONMENT_PATH, VoltTunnelKind } from '../../../platform/voltAgentServer/common/protocol.js';
import { writeFileAtomic } from '../../../platform/voltAgentServer/node/agentServerFiles.js';
import { parseSshTarget } from '../../../platform/voltDevices/common/deviceCommands.js';
import { ChildLedger } from '../../../platform/voltStdio/node/childLedger.js';
import { reachableAddresses } from './serverPairing.js';

/** How long a tunnel may take to come up before it counts as failed. */
const START_TIMEOUT_MS = 45_000;
/** A tunnel that was up and dropped is started again, waiting longer each time, up to this many tries. */
const MAX_RESTARTS = 6;
/** Tailscale, cloudflared and Remote Login are looked up at most this often. */
const PROBE_TTL_MS = 5_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

interface ITunnelsFile {
	cloudflare?: boolean;
	ssh?: IVoltSshTunnelOptions & { on?: boolean };
}

export interface IServerTunnelsOptions {
	/** Where `tunnels.json` lives (the server's own folder). */
	readonly dir: string;
	readonly environmentId: () => string;
	/** The user's shell environment: PATH with Homebrew, and SSH_AUTH_SOCK for their keys. */
	readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>;
	/** Opens the loopback listener tunnels forward to (once) and resolves its port. */
	readonly listen: () => Promise<number>;
	readonly port: () => number;
	readonly network: boolean;
	readonly childLedger: ChildLedger;
	readonly logService: ILogService;
}

/** The first of `names` on PATH or at one of `extra`, runnable. */
async function findProgram(env: NodeJS.ProcessEnv, names: readonly string[], extra: readonly string[] = []): Promise<string | undefined> {
	const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
	const candidates = [...dirs.flatMap(dir => names.map(name => join(dir, name))), ...extra];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// next
		}
	}
	return undefined;
}

const BREW_BIN = ['/opt/homebrew/bin', '/usr/local/bin'];

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile(file, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
		});
	});
}

const publicResolver = new Resolver({ timeout: 3_000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '1.0.0.1']);

/** GETs JSON (5s timeout). `publicDns`: the host name is looked up with Cloudflare's resolver, not the system's. */
function getJson(url: string, publicDns: boolean): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const lookup: LookupFunction | undefined = publicDns
			? (hostname, options, callback) => publicResolver.resolve4(hostname, (err, addresses) => {
				if (err || !addresses.length) {
					callback(err ?? new Error(`no address for ${hostname}`), '', 4);
				} else if (options.all) {
					(callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, addresses.map(address => ({ address, family: 4 })));
				} else {
					callback(null, addresses[0], 4);
				}
			})
			: undefined;
		const get = url.startsWith('https:') ? httpsGet : httpGet;
		const request = get(url, { timeout: 5_000, ...(lookup ? { lookup } : {}) }, response => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => body += chunk);
			response.on('end', () => {
				try {
					resolve(response.statusCode === 200 ? JSON.parse(body) : undefined);
				} catch (err) {
					reject(err);
				}
			});
		});
		request.on('timeout', () => request.destroy(new Error('timed out')));
		request.on('error', reject);
	});
}

/** Whether something accepts connections on `port` here (Remote Login's sshd on 22). */
function listening(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ host: '127.0.0.1', port, timeout: 600 });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		socket.once('timeout', () => done(false));
	});
}

/** Plain `Host` names from ~/.ssh/config (no `*`, `?` or `!` patterns), in file order. */
export function sshConfigHosts(text: string): string[] {
	const hosts: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
		if (!match) {
			continue;
		}
		for (const name of match[1].split(/\s+/)) {
			if (name && !/[*?!]/.test(name) && !hosts.includes(name)) {
				hosts.push(name);
			}
		}
	}
	return hosts.slice(0, 50);
}

/** The quick tunnel's address in cloudflared's log (it prints it in a box). */
export function cloudflareQuickUrl(line: string): string | undefined {
	return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)?.[0];
}

/** What a failed `ssh` said, in words for the Add Device dialog. */
export function explainSshFailure(lines: readonly string[], target: string): string {
	const said = lines.filter(line => !line.startsWith('debug') && !/^(Authenticated|Transferred|Bytes per second)/.test(line));
	const text = said.join('\n');
	if (/Permission denied/i.test(text)) {
		return `The server refused this computer's SSH key. Volt signs in with keys only: check that \`ssh ${target}\` works in Terminal without a password.`;
	}
	if (/remote port forwarding failed|Address already in use/i.test(text)) {
		return 'The server would not open that port: it is in use or not allowed. Pick another port.';
	}
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
		return `The server's host key does not match the one this computer knows. Connect once with \`ssh ${target}\` in Terminal to check it.`;
	}
	const host = target.replace(/^[^@]*@/, '');
	if (/Could not resolve hostname/i.test(text)) {
		return `No server is called ${host}. Check the name, or add it to ~/.ssh/config.`;
	}
	if (/Connection refused/i.test(text)) {
		return `${host} is not accepting SSH connections.`;
	}
	if (/timed out/i.test(text)) {
		return `${host} did not answer. Check the address and that this computer can reach it.`;
	}
	return said.slice(-2).join(' ') || 'ssh stopped.';
}

interface ITunnelCommand {
	readonly file: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

interface ITunnelSpec {
	readonly kind: VoltTunnelKind;
	readonly ssh?: IVoltSshTunnelOptions;
	command(port: number): Promise<ITunnelCommand>;
	/** Reads one output line. `url` once the address is known, `up` once traffic can flow. */
	read(line: string): { url?: string; up?: boolean } | undefined;
	/** Why it stopped, from the lines it printed. */
	failure(lines: readonly string[]): string;
	/** Whether this computer reaches the server through `url`, with what to do when not. */
	check(url: string): Promise<{ reachable: boolean; note?: string }>;
}

/** Runs one tunnel process: starts it, reads its address, and starts it again when it drops. */
class TunnelRunner extends Disposable {

	private child: ChildProcess | undefined;
	private status: IVoltTunnelStatus;
	private lines: string[] = [];
	private restarts = 0;
	private stopped = false;
	private startTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingUrl: string | undefined;
	private upSeen = false;

	constructor(
		private readonly spec: ITunnelSpec,
		private readonly port: () => Promise<number>,
		private readonly ledger: ChildLedger,
		private readonly logService: ILogService,
		private readonly changed: () => void,
	) {
		super();
		this.status = { kind: spec.kind, state: 'starting', ...(spec.ssh ? { ssh: spec.ssh } : {}) };
		this._register(toDisposable(() => this.kill()));
	}

	get current(): IVoltTunnelStatus {
		return this.status;
	}

	private set(next: Partial<IVoltTunnelStatus>): void {
		this.status = { ...this.status, ...next };
		this.changed();
	}

	async start(): Promise<void> {
		this.lines = [];
		this.pendingUrl = undefined;
		this.upSeen = false;
		let command: ITunnelCommand;
		try {
			command = await this.spec.command(await this.port());
		} catch (err) {
			this.set({ state: 'error', error: err instanceof Error ? err.message : String(err), url: undefined });
			return;
		}
		if (this.stopped) {
			return;
		}
		this.logService.info(`[volt agent server] starting the ${this.spec.kind} tunnel: ${basename(command.file)} ${command.args.filter(arg => !arg.includes('token')).join(' ')}`);
		// Its own process group, recorded: a server killed outright does not leave it running.
		const child = this.child = spawn(command.file, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		this.ledger.add(child.pid, basename(command.file));
		let buffer = '';
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			const parts = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? '';
			for (const line of parts) {
				this.onLine(line.trim());
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.once('error', err => this.onExit(child, err.message));
		child.once('exit', code => this.onExit(child, `exit code ${code}`));
		this.startTimer = setTimeout(() => {
			if (this.child === child && this.status.state !== 'on') {
				this.lines.push('The tunnel did not come up in time.');
				child.kill('SIGTERM');
			}
		}, START_TIMEOUT_MS);
	}

	private onLine(line: string): void {
		if (!line) {
			return;
		}
		this.lines.push(line);
		if (this.lines.length > 60) {
			this.lines.shift();
		}
		const read = this.spec.read(line);
		if (read?.url) {
			this.pendingUrl = read.url;
		}
		this.upSeen ||= !!read?.up;
		if (this.upSeen && this.pendingUrl && this.status.state !== 'on') {
			clearTimeout(this.startTimer);
			this.restarts = 0;
			const url = this.pendingUrl;
			this.set({ state: 'on', url, error: undefined, reachable: undefined, note: undefined });
			this.logService.info(`[volt agent server] the ${this.spec.kind} tunnel is up at ${url}`);
			void this.spec.check(url).then(result => {
				if (this.status.url === url && this.status.state === 'on') {
					this.set({ reachable: result.reachable, note: result.note });
				}
			});
		}
	}

	private onExit(child: ChildProcess, reason: string): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.ledger.delete(child.pid);
		clearTimeout(this.startTimer);
		if (this.stopped) {
			return;
		}
		const wasUp = this.status.state === 'on';
		const why = this.spec.failure(this.lines) || reason;
		this.logService.warn(`[volt agent server] the ${this.spec.kind} tunnel stopped (${reason}): ${why}`);
		// A tunnel that worked and dropped (sleep, Wi-Fi change) comes back; one that never came up has a problem to fix.
		if ((wasUp || this.restarts > 0) && this.restarts < MAX_RESTARTS) {
			this.restarts++;
			this.set({ state: 'starting', note: 'Reconnecting…', reachable: undefined });
			this.retryTimer = setTimeout(() => void this.start(), Math.min(30_000, 2_000 * 2 ** (this.restarts - 1)));
			return;
		}
		this.set({ state: 'error', error: why, url: undefined, reachable: undefined, note: undefined });
	}

	private kill(): void {
		this.stopped = true;
		clearTimeout(this.startTimer);
		clearTimeout(this.retryTimer);
		const child = this.child;
		this.child = undefined;
		if (child?.pid) {
			const pid = child.pid;
			const signal = (name: NodeJS.Signals) => {
				try {
					process.kill(-pid, name);
				} catch {
					child.kill(name);
				}
			};
			signal('SIGTERM');
			// cloudflared drains connections for up to 30s on SIGTERM; a stopped tunnel should be gone now.
			const force = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					signal('SIGKILL');
				}
			}, 3_000);
			child.once('exit', () => clearTimeout(force));
			this.ledger.delete(pid);
		}
	}
}

/**
 * The other ways in besides this Wi-Fi: a Cloudflare quick tunnel (an https address on the
 * internet, no account), an `ssh -R` to a server of the user's, and what Tailscale says about this
 * computer. Tunnels forward to a second listener on loopback that never hands out the local
 * session, and they come back with the server (tunnels.json).
 */
export class ServerTunnels extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly runners = new Map<VoltTunnelKind, TunnelRunner>();
	private config: ITunnelsFile = {};
	private tunnelPort: number | undefined;
	private probes: { at: number; value: Promise<Pick<IVoltConnectStatus, 'tailscale' | 'cloudflared' | 'remoteLogin' | 'sshHosts'>> } | undefined;
	private installing: Promise<void> | undefined;
	private installError: string | undefined;

	constructor(private readonly options: IServerTunnelsOptions) {
		super();
		this._register(toDisposable(() => {
			for (const runner of this.runners.values()) {
				runner.dispose();
			}
			this.runners.clear();
		}));
	}

	private get file(): string {
		return join(this.options.dir, 'tunnels.json');
	}

	/** Starts the tunnels that were on when the server last stopped. */
	async resume(): Promise<void> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as ITunnelsFile;
			this.config = parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return;
		}
		if (this.config.cloudflare) {
			this.run(this.cloudflareSpec());
		}
		if (this.config.ssh?.on) {
			this.run(this.sshSpec(this.config.ssh));
		}
	}

	/** Whether a tunnel is up or coming up (the server stays up for it); a failed one does not count. */
	get active(): boolean {
		return [...this.runners.values()].some(runner => runner.current.state !== 'error');
	}

	/** Base URLs of the tunnels that are up, for pairing links. */
	urls(): { via: VoltTunnelKind; url: string }[] {
		return [...this.runners.values()].map(runner => runner.current).filter(status => status.state === 'on' && !!status.url).map(status => ({ via: status.kind, url: status.url! }));
	}

	async status(): Promise<IVoltConnectStatus> {
		const probes = await this.probe();
		const tunnels: IVoltTunnelStatus[] = (['cloudflare', 'ssh'] as const).map(kind => this.runners.get(kind)?.current
			?? { kind, state: 'off', ...(kind === 'ssh' && this.config.ssh ? { ssh: { target: this.config.ssh.target, remotePort: this.config.ssh.remotePort, ...(this.config.ssh.publicUrl ? { publicUrl: this.config.ssh.publicUrl } : {}) } } : {}) });
		return {
			network: this.options.network,
			port: this.options.port(),
			...(this.tunnelPort ? { tunnelPort: this.tunnelPort } : {}),
			...(this.options.network ? { lanAddress: reachableAddresses().find(address => address.kind === 'lan')?.ip } : {}),
			...probes,
			cloudflared: { ...probes.cloudflared, ...(this.installing ? { installing: true } : {}), ...(this.installError ? { installError: this.installError } : {}) },
			user: userInfo().username,
			hostname: hostname(),
			tunnels,
		};
	}

	/** Opens the tunnel listener without starting a tunnel (for `ssh -L` from another computer). */
	async ensureListener(): Promise<number> {
		this.tunnelPort = await this.options.listen();
		return this.tunnelPort;
	}

	async start(kind: VoltTunnelKind, ssh?: IVoltSshTunnelOptions): Promise<IVoltTunnelStatus> {
		if (kind === 'ssh') {
			const options = validSshOptions(ssh);
			this.config.ssh = { ...options, on: true };
			this.run(this.sshSpec(options));
		} else {
			this.config.cloudflare = true;
			this.run(this.cloudflareSpec());
		}
		await this.save();
		return this.runners.get(kind)!.current;
	}

	async stop(kind: VoltTunnelKind): Promise<void> {
		this.runners.get(kind)?.dispose();
		this.runners.delete(kind);
		if (kind === 'ssh') {
			if (this.config.ssh) {
				this.config.ssh.on = false;
			}
		} else {
			this.config.cloudflare = false;
		}
		await this.save();
		this._onDidChange.fire();
	}

	/** `brew install cloudflared`, in the background; status() shows it running. */
	installCloudflared(): Promise<void> {
		this.installing ??= (async () => {
			this.installError = undefined;
			const env = await this.options.resolveEnv();
			const brew = await findProgram(env, ['brew'], BREW_BIN.map(dir => join(dir, 'brew')));
			if (!brew) {
				throw new Error('Homebrew is not installed. Install cloudflared from developers.cloudflare.com, then try again.');
			}
			this.options.logService.info('[volt agent server] installing cloudflared with Homebrew');
			const result = await run(brew, ['install', 'cloudflared'], { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' }, INSTALL_TIMEOUT_MS);
			if (result.code !== 0) {
				throw new Error(result.stderr.trim().split('\n').slice(-2).join(' ') || 'brew install cloudflared failed.');
			}
		})().catch(err => {
			this.installError = err instanceof Error ? err.message : String(err);
			this.options.logService.warn('[volt agent server] could not install cloudflared', err);
		}).finally(() => {
			this.installing = undefined;
			this.probes = undefined;
			this._onDidChange.fire();
		});
		this.probes = undefined;
		return Promise.resolve();
	}

	private run(spec: ITunnelSpec): void {
		this.runners.get(spec.kind)?.dispose();
		const runner = new TunnelRunner(spec, () => this.ensureListener(), this.options.childLedger, this.options.logService, () => this._onDidChange.fire());
		this.runners.set(spec.kind, runner);
		void runner.start();
		this._onDidChange.fire();
	}

	private async save(): Promise<void> {
		try {
			await fs.mkdir(this.options.dir, { recursive: true, mode: 0o700 });
			await writeFileAtomic(this.file, JSON.stringify(this.config, undefined, '\t'), 0o600);
		} catch (err) {
			this.options.logService.warn('[volt agent server] could not save the tunnels', err);
		}
	}

	/**
	 * Whether the server answers as itself at `url` (a tunnel to someone else's would not).
	 * `publicDns` resolves the name with Cloudflare's resolver: asking the system's too early makes
	 * it (and the Wi-Fi router, which phones on this network use) cache "no such name" for a while.
	 */
	private async reaches(url: string, tries: number, gapMs: number, publicDns = false): Promise<boolean> {
		for (let i = 0; i < tries; i++) {
			await new Promise(resolve => setTimeout(resolve, gapMs));
			const environment = await getJson(`${url}${VOLT_ENVIRONMENT_PATH}`, publicDns).catch(() => undefined) as { environmentId?: string } | undefined;
			if (environment?.environmentId === this.options.environmentId()) {
				return true;
			}
		}
		return false;
	}

	private cloudflareSpec(): ITunnelSpec {
		return {
			kind: 'cloudflare',
			command: async port => {
				const env = await this.options.resolveEnv();
				const file = await findProgram(env, ['cloudflared'], BREW_BIN.map(dir => join(dir, 'cloudflared')));
				if (!file) {
					throw new Error('cloudflared is not installed.');
				}
				return { file, args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], env };
			},
			read: line => {
				const url = cloudflareQuickUrl(line);
				return url ? { url } : /Registered tunnel connection/i.test(line) ? { up: true } : undefined;
			},
			failure: lines => {
				const errors = lines.filter(line => /\bERR\b|error|failed/i.test(line));
				const last = errors[errors.length - 1] ?? lines[lines.length - 1] ?? '';
				if (/429|Too Many Requests/i.test(last)) {
					return 'Cloudflare is limiting new quick tunnels right now. Wait a minute, then try again.';
				}
				return last.replace(/^\S+\s+(ERR|WRN|INF)\s+/, '').trim();
			},
			check: async url => await this.reaches(url, 8, 3_000, true)
				? { reachable: true }
				: { reachable: false, note: 'Cloudflare does not answer at this address yet. Wait a minute, or stop the tunnel and start it again.' },
		};
	}

	private sshSpec(options: IVoltSshTunnelOptions): ITunnelSpec {
		let host = parseSshTarget(options.target)?.host ?? options.target;
		return {
			kind: 'ssh',
			ssh: options,
			command: async port => {
				const env = await this.options.resolveEnv();
				const file = await findProgram(env, ['ssh'], ['/usr/bin/ssh']);
				if (!file) {
					throw new Error('ssh is not installed.');
				}
				const target = parseSshTarget(options.target);
				const destination = target ? (target.user ? `${target.user}@${target.host}` : target.host) : options.target;
				// The real host name behind a ~/.ssh/config alias, for the address devices open.
				const resolved = await run(file, ['-G', ...(target?.port ? ['-p', String(target.port)] : []), destination], env, 5_000);
				host = /^hostname\s+(\S+)/m.exec(resolved.stdout)?.[1] ?? host;
				return {
					file,
					args: [
						'-v', '-N', '-T',
						// Keys or an agent only, never a prompt; new hosts are trusted once, changed keys never.
						'-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
						'-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
						'-o', 'ControlMaster=no', '-o', 'ControlPath=none',
						...(target?.port ? ['-p', String(target.port)] : []),
						'-R', `0.0.0.0:${options.remotePort}:127.0.0.1:${port}`,
						destination,
					],
					env,
				};
			},
			read: line => /remote forward success for: listen/i.test(line)
				? { url: options.publicUrl ?? `http://${host.includes(':') ? `[${host}]` : host}:${options.remotePort}`, up: true }
				: undefined,
			failure: lines => explainSshFailure(lines, options.target),
			check: async url => await this.reaches(url, 3, 1_500)
				? { reachable: true }
				: {
					reachable: false,
					note: options.publicUrl
						? `This computer cannot open ${url}. Check that it forwards to port ${options.remotePort} on the server.`
						: `The tunnel is up, but ${host}:${options.remotePort} does not answer from outside. Set "GatewayPorts clientspecified" in the server's sshd_config (then reload sshd), or open the port in its firewall.`,
				},
		};
	}

	private probe(): Promise<Pick<IVoltConnectStatus, 'tailscale' | 'cloudflared' | 'remoteLogin' | 'sshHosts'>> {
		if (this.probes && Date.now() - this.probes.at < PROBE_TTL_MS) {
			return this.probes.value;
		}
		const value = (async () => {
			const env = await this.options.resolveEnv();
			const [tailscale, cloudflared, brew, remoteLogin, sshHosts] = await Promise.all([
				this.tailscale(env),
				findProgram(env, ['cloudflared'], BREW_BIN.map(dir => join(dir, 'cloudflared'))),
				findProgram(env, ['brew'], BREW_BIN.map(dir => join(dir, 'brew'))),
				listening(22),
				fs.readFile(join(homedir(), '.ssh', 'config'), 'utf8').then(sshConfigHosts, () => []),
			]);
			return { tailscale, cloudflared: { installed: !!cloudflared, canInstall: !!brew }, remoteLogin, sshHosts };
		})();
		this.probes = { at: Date.now(), value };
		return value;
	}

	private async tailscale(env: NodeJS.ProcessEnv): Promise<IVoltConnectStatus['tailscale']> {
		const ip = reachableAddresses().find(address => address.kind === 'tailnet')?.ip;
		const appInstalled = process.platform === 'darwin' && await fs.access('/Applications/Tailscale.app').then(() => true, () => false);
		const cli = await findProgram(env, ['tailscale'], ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', ...BREW_BIN.map(dir => join(dir, 'tailscale'))]);
		if (!cli) {
			return { installed: appInstalled || !!ip, running: !!ip, ...(ip ? { ip } : {}) };
		}
		const result = await run(cli, ['status', '--json'], env, 4_000);
		try {
			const status = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; CurrentTailnet?: { Name?: string } };
			const running = status.BackendState === 'Running';
			const selfIp = status.Self?.TailscaleIPs?.find(address => address.includes('.')) ?? ip;
			const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
			return { installed: true, running, ...(running && selfIp ? { ip: selfIp } : {}), ...(running && dnsName ? { dnsName } : {}), ...(status.CurrentTailnet?.Name ? { tailnet: status.CurrentTailnet.Name } : {}) };
		} catch {
			return { installed: true, running: !!ip, ...(ip ? { ip } : {}) };
		}
	}
}

/** Checks what the dialog sent before anything runs with it. */
function validSshOptions(value: IVoltSshTunnelOptions | undefined): IVoltSshTunnelOptions {
	const target = String(value?.target ?? '').trim();
	// A `Host` alias from ~/.ssh/config, or user@host[:port]; never something ssh reads as an option.
	if (!target || target.startsWith('-') || !(parseSshTarget(target) || /^[A-Za-z0-9._-]+$/.test(target))) {
		throw new Error('Enter the server as user@host, host:port or a Host from ~/.ssh/config.');
	}
	const remotePort = Number(value?.remotePort);
	if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
		throw new Error('Pick a port on the server from 1024 to 65535.');
	}
	let publicUrl: string | undefined;
	if (value?.publicUrl?.trim()) {
		try {
			const url = new URL(value.publicUrl.trim());
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				throw new Error();
			}
			publicUrl = `${url.protocol}//${url.host}`;
		} catch {
			throw new Error('The public address must be an http:// or https:// URL.');
		}
	}
	return { target, remotePort, ...(publicUrl ? { publicUrl } : {}) };
}
