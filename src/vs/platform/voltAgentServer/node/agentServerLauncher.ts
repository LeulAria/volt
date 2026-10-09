/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as http from 'http';
import { homedir, networkInterfaces } from 'os';
import { dirname, join, sep } from '../../../base/common/path.js';
import { IAgentServerRuntimeInfo } from '../common/protocol.js';
import { IVoltAgentServerEndpoint } from '../common/agentServerService.js';
import { agentServerPaths, IAgentServerPaths, isProcessAlive, readAgentServerRuntime, readAgentServerToken } from './agentServerFiles.js';
import { installLaunchdJob, restartLaunchdJob, uninstallLaunchdJob } from './launchd.js';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

/** The address phones reach this Mac at: the first private IPv4 address on a real interface. */
export function localNetworkAddress(): string | undefined {
	const candidates: string[] = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === 'IPv4' && !address.internal && !/^(utun|bridge|awdl|llw|vmnet|docker)/.test(name)) {
				candidates.push(address.address);
			}
		}
	}
	return candidates.find(ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) ?? candidates[0];
}

export interface IAgentServerLauncherOptions {
	readonly userDataDir: string;
	/** The Volt build the server code is loaded from (holds `out/volt-agent-server-main.js`). */
	readonly appRoot: string;
	/** An Electron binary of the app's version, run as Node so native modules match. */
	readonly electronPath: string;
	/** The build's commit (packaged builds): a server from another build is replaced. */
	readonly commit?: string;
	readonly log: (message: string) => void;
}

/**
 * Starts, finds and restarts one profile's agent server. Volt's main process and the standalone
 * Volt Agents app both use it, so either one can bring the server up and the other reuses it.
 */
export class AgentServerLauncher {

	readonly paths: IAgentServerPaths;
	private starting: Promise<IVoltAgentServerEndpoint> | undefined;

	constructor(private readonly options: IAgentServerLauncherOptions) {
		this.paths = agentServerPaths(options.userDataDir);
	}

	private get appRoot(): string {
		return this.options.appRoot;
	}

	private get entry(): string {
		return join(this.appRoot, 'out', 'volt-agent-server-main.js');
	}

	ensureRunning(): Promise<IVoltAgentServerEndpoint> {
		this.starting ??= this.doEnsure().finally(() => this.starting = undefined);
		return this.starting;
	}

	private async doEnsure(): Promise<IVoltAgentServerEndpoint> {
		const running = await this.healthy();
		const network = await this.networkAccess();
		const sameBuild = !!running && running.appRoot === this.appRoot && (running.commit ?? undefined) === (this.options.commit ?? undefined);
		if (running && sameBuild && (running.host !== '127.0.0.1') === network) {
			return this.endpoint(running);
		}
		if (running) {
			// One server per profile: two would both write the chats' history.
			this.options.log(`[volt agent server] the running server (pid ${running.pid}) is from ${running.appRoot}${running.commit ? ` at ${running.commit}` : ''}; replacing it with this build's`);
			await this.stopProcess(running.pid);
		}
		const before = running?.pid;
		await this.start();
		return this.endpoint(await this.waitForStart(before));
	}

	async restart(): Promise<IVoltAgentServerEndpoint> {
		const before = (await readAgentServerRuntime(this.paths))?.pid;
		if (this.useLaunchd()) {
			await restartLaunchdJob(this.paths.label).catch(() => this.start());
		} else {
			if (before) {
				await this.stopProcess(before);
			}
			await this.start();
		}
		return this.endpoint(await this.waitForStart(before));
	}

	/** Asks a server to stop (it flushes its history first), then makes sure it is gone. */
	private async stopProcess(pid: number): Promise<void> {
		if (!isProcessAlive(pid)) {
			return;
		}
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			return;
		}
		const deadline = Date.now() + STOP_TIMEOUT_MS;
		while (Date.now() < deadline && isProcessAlive(pid)) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		if (isProcessAlive(pid)) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// gone meanwhile
			}
		}
	}

	async stop(): Promise<void> {
		if (this.useLaunchd()) {
			await uninstallLaunchdJob(this.paths.label);
		}
		const info = await readAgentServerRuntime(this.paths);
		if (info && isProcessAlive(info.pid)) {
			process.kill(info.pid, 'SIGTERM');
		}
	}

	async setNetworkAccess(enabled: boolean): Promise<IVoltAgentServerEndpoint> {
		await fs.mkdir(this.paths.dir, { recursive: true });
		await fs.writeFile(this.networkFile, JSON.stringify({ network: enabled }), { mode: 0o600 });
		return this.restart();
	}

	/** The endpoint of the server that is up now, without starting one. */
	async current(): Promise<IVoltAgentServerEndpoint | undefined> {
		const running = await this.healthy();
		return running ? this.endpoint(running) : undefined;
	}

	private get networkFile(): string {
		return join(this.paths.dir, 'network.json');
	}

	/** Whether the user let phones on the network reach the server (off until they pair one). */
	private async networkAccess(): Promise<boolean> {
		try {
			return JSON.parse(await fs.readFile(this.networkFile, 'utf8')).network === true;
		} catch {
			return false;
		}
	}

	private async start(): Promise<void> {
		const program = [this.options.electronPath, this.entry, '--user-data-dir', this.paths.userDataDir];
		if (await this.networkAccess()) {
			program.push('--host', '0.0.0.0');
		}
		const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', HOME: process.env.HOME ?? '' };
		if (process.env['VSCODE_DEV']) {
			env['VSCODE_DEV'] = '1';
			env['NODE_ENV'] = 'development';
		}
		if (process.env['VOLT_AGENT_SERVER_LOG']) {
			env['VOLT_AGENT_SERVER_LOG'] = process.env['VOLT_AGENT_SERVER_LOG'];
		}
		if (this.useLaunchd()) {
			this.options.log(`[volt agent server] starting ${this.paths.label} with launchd`);
			await installLaunchdJob({ label: this.paths.label, program, env, workingDirectory: this.appRoot, logFile: this.paths.logFile });
			return;
		}
		// Its own process group: quitting the app that started it does not stop it.
		this.options.log(`[volt agent server] starting ${this.paths.label} as a detached process`);
		await fs.mkdir(dirname(this.paths.logFile), { recursive: true });
		const log = await fs.open(this.paths.logFile, 'a');
		const child = spawn(program[0], program.slice(1), { env: { ...process.env, ...env }, cwd: this.appRoot, detached: true, stdio: ['ignore', log.fd, log.fd] });
		child.unref();
		await log.close();
	}

	/**
	 * launchd keeps the server alive across crashes and logins. A launchd job is its own app to
	 * macOS privacy control, so when Volt runs from a protected folder (a dev checkout on the
	 * Desktop) the job could not read its own code without a prompt; Volt then starts the server
	 * itself, and it inherits Volt's access. `VOLT_AGENT_SERVER_LAUNCHD=1|0` overrides.
	 */
	private useLaunchd(): boolean {
		const forced = process.env['VOLT_AGENT_SERVER_LAUNCHD'];
		if (forced === '1' || forced === '0') {
			return forced === '1' && process.platform === 'darwin';
		}
		if (process.platform !== 'darwin') {
			return false;
		}
		const home = homedir();
		const protectedRoots = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents')].map(folder => join(home, folder) + sep);
		return !protectedRoots.some(root => (this.appRoot + sep).startsWith(root));
	}

	/** The server described by runtime.json, if it is alive and answers with our token. */
	private async healthy(): Promise<IAgentServerRuntimeInfo | undefined> {
		const [info, token] = await Promise.all([readAgentServerRuntime(this.paths), readAgentServerToken(this.paths)]);
		if (!info || !token || !isProcessAlive(info.pid)) {
			return undefined;
		}
		return await this.probe(info, token) ? info : undefined;
	}

	private probe(info: IAgentServerRuntimeInfo, token: string): Promise<boolean> {
		return new Promise(resolve => {
			const req = http.get({ host: info.host === '0.0.0.0' ? '127.0.0.1' : info.host, port: info.port, path: '/health', headers: { Authorization: `Bearer ${token}` }, timeout: 2_000 }, res => {
				res.resume();
				resolve(res.statusCode === 200);
			});
			req.on('error', () => resolve(false));
			req.on('timeout', () => {
				req.destroy();
				resolve(false);
			});
		});
	}

	private async waitForStart(previousPid: number | undefined): Promise<IAgentServerRuntimeInfo> {
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const info = await this.healthy();
			if (info && info.pid !== previousPid && info.appRoot === this.appRoot && (info.commit ?? undefined) === (this.options.commit ?? undefined)) {
				return info;
			}
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		throw new Error(`The Volt agent server did not start. See ${this.paths.logFile}.`);
	}

	private async endpoint(info: IAgentServerRuntimeInfo): Promise<IVoltAgentServerEndpoint> {
		const token = await readAgentServerToken(this.paths);
		if (!token) {
			throw new Error('The Volt agent server has no token.');
		}
		const network = info.host !== '127.0.0.1';
		const host = network ? '127.0.0.1' : info.host;
		const lan = network ? localNetworkAddress() : undefined;
		return {
			url: `ws://${host}:${info.port}/ws`,
			token,
			port: info.port,
			pid: info.pid,
			webUrl: `http://${host}:${info.port}/#token=${token}`,
			network,
			pairingUrl: lan ? `http://${lan}:${info.port}/#token=${token}` : undefined,
		};
	}
}
