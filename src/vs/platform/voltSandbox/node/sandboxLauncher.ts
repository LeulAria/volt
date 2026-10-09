/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { bwrapArgs, LANDLOCK_HELPER_SOURCE, landlockArgs } from '../common/landlock.js';
import { denialKindForOperation, ISandboxDenial, isNoiseDenial } from '../common/sandboxDenials.js';
import { ISandboxHostInfo, ISandboxPlan, IVoltSandboxRequest, nativeSandboxOffArgs, resolveSandboxPlan, sandboxEnv } from '../common/sandboxPolicy.js';
import { buildSeatbeltProfile, parseSeatbeltLogLine, SANDBOX_EXEC_PATH, seatbeltCommand, SEATBELT_TAG_PREFIX } from '../common/seatbelt.js';
import { SandboxNetworkProxy } from './sandboxProxy.js';

const execFileAsync = promisify(execFile);

export type SandboxMechanism = 'seatbelt' | 'landlock' | 'bwrap' | 'none';

export interface IVoltSandboxSupport {
	readonly platform: string;
	readonly mechanism: SandboxMechanism;
	/** Writes are confined. */
	readonly filesystem: boolean;
	/** Network can be limited to Volt's proxy. */
	readonly network: boolean;
	/** One line for the UI: "macOS Seatbelt", "Landlock ABI 5", "No Landlock in this kernel (5.10)". */
	readonly detail: string;
}

export interface ISandboxLaunch {
	readonly command: string;
	readonly args: string[];
	readonly env: Record<string, string>;
	readonly tag: string;
	readonly plan: ISandboxPlan;
	readonly mechanism: SandboxMechanism;
	/** Shown in the transcript: the sandbox is weaker than asked (no Landlock, no network filter). */
	readonly warnings: readonly string[];
	/** Hosts the user allows later (network off). */
	allowDomains(domains: readonly string[]): void;
	dispose(): void;
}

export interface ISandboxViolationEvent {
	readonly tag: string;
	readonly denial: ISandboxDenial;
}

interface ILogger {
	info(message: string): void;
	warn(message: string, ...args: unknown[]): void;
}

/**
 * Wraps agent commands in the OS sandbox: Seatbelt on macOS, Landlock (Volt's own helper, else
 * bubblewrap) on Linux. Watches the kernel log for denials on macOS and reports them per launch.
 */
export class VoltSandboxLauncher extends Disposable {

	private readonly _onViolation = this._register(new Emitter<ISandboxViolationEvent>());
	readonly onViolation: Event<ISandboxViolationEvent> = this._onViolation.event;

	private host: Promise<ISandboxHostInfo> | undefined;
	private helper: Promise<string | undefined> | undefined;
	private support: Promise<IVoltSandboxSupport> | undefined;
	private readonly liveTags = new Set<string>();
	private monitor: ChildProcess | undefined;
	private readonly recent = new Map<string, number>();

	constructor(
		/** Where the compiled Linux helper is kept (Volt's user data). */
		private readonly stateDir: string,
		private readonly logger: ILogger,
		private readonly platform: string = process.platform,
	) {
		super();
	}

	getSupport(): Promise<IVoltSandboxSupport> {
		this.support ??= this.detectSupport();
		return this.support;
	}

	private async detectSupport(): Promise<IVoltSandboxSupport> {
		if (this.platform === 'darwin') {
			const ok = existsSync(SANDBOX_EXEC_PATH);
			return { platform: 'darwin', mechanism: ok ? 'seatbelt' : 'none', filesystem: ok, network: ok, detail: ok ? 'macOS Seatbelt' : 'sandbox-exec is missing' };
		}
		if (this.platform === 'linux') {
			const helper = await this.ensureHelper();
			if (helper) {
				const abi = await this.landlockAbi(helper);
				if (abi > 0) {
					return { platform: 'linux', mechanism: 'landlock', filesystem: true, network: abi >= 4, detail: abi >= 4 ? `Landlock ABI ${abi}` : `Landlock ABI ${abi} (network limits need Linux 6.7)` };
				}
			}
			const bwrap = await which('bwrap');
			if (bwrap) {
				return { platform: 'linux', mechanism: 'bwrap', filesystem: true, network: false, detail: 'bubblewrap (no Landlock; network is not limited)' };
			}
			return { platform: 'linux', mechanism: 'none', filesystem: false, network: false, detail: helper ? 'This kernel has no Landlock and bubblewrap is not installed' : 'No C compiler for the Landlock helper and bubblewrap is not installed' };
		}
		return { platform: this.platform, mechanism: 'none', filesystem: false, network: false, detail: 'OS sandboxing is not available on this platform' };
	}

	/**
	 * The command, arguments and environment that run `command args` sandboxed by `request`.
	 * The caller spawns it and calls `dispose` when the process ends.
	 */
	async prepare(command: string, args: readonly string[], request: IVoltSandboxRequest): Promise<ISandboxLaunch> {
		const host = await this.hostInfo();
		const tag = generateUuid().replace(/-/g, '').slice(0, 16);
		const resolved: IVoltSandboxRequest = {
			...request,
			workspaceRoots: await withRealpaths(request.workspaceRoots),
			extraWritableRoots: await withRealpaths(request.extraWritableRoots ?? []),
		};
		const plan = resolveSandboxPlan(resolved, host);
		const support = await this.getSupport();
		const warnings: string[] = [];
		let proxy: SandboxNetworkProxy | undefined;
		if (plan.network === 'proxy') {
			proxy = await SandboxNetworkProxy.start(plan.allowedDomains, hostName => this.report(tag, { kind: 'network', target: hostName, source: 'proxy' }));
		}
		const env = sandboxEnv(plan, proxy?.url, tag);
		const agentArgs = [...nativeSandboxOffArgs(request.providerId), ...args];
		let wrapped: { command: string; args: string[] };
		switch (support.mechanism) {
			case 'seatbelt':
				wrapped = seatbeltCommand(buildSeatbeltProfile(plan, tag), command, agentArgs);
				this.watch(tag);
				break;
			case 'landlock': {
				const helper = (await this.ensureHelper())!;
				const ports = [...(proxy ? [proxy.port] : []), ...plan.loopbackPorts];
				wrapped = { command: helper, args: [...landlockArgs(plan, ports), '--', command, ...agentArgs] };
				if (plan.network === 'proxy' && !support.network) {
					warnings.push(`Network is not limited: ${support.detail}.`);
				}
				break;
			}
			case 'bwrap': {
				const existing = { ...plan, denyReadSubpaths: plan.denyReadSubpaths.filter(path => existsSync(path)) };
				wrapped = { command: 'bwrap', args: [...bwrapArgs(existing), '--', command, ...agentArgs] };
				if (plan.network === 'proxy') {
					warnings.push('Network is not limited: no Landlock in this kernel, so only HTTP clients that honour the proxy are filtered.');
				}
				break;
			}
			default:
				wrapped = { command, args: [...args] };
				warnings.push(`The agent runs without a sandbox: ${support.detail}.`);
		}
		this.logger.info(`[volt-sandbox] ${support.mechanism} ${plan.level} network=${plan.network} tag=${tag} roots=${plan.writableSubpaths.length}`);
		let disposed = false;
		return {
			command: wrapped.command,
			args: wrapped.args,
			env,
			tag,
			plan,
			mechanism: support.mechanism,
			warnings,
			allowDomains: domains => proxy?.allow(domains),
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				proxy?.dispose();
				this.unwatch(tag);
			},
		};
	}

	private report(tag: string, denial: ISandboxDenial): void {
		if (isNoiseDenial(denial)) {
			return;
		}
		const key = `${tag}|${denial.kind}|${denial.target}`;
		const now = Date.now();
		if ((this.recent.get(key) ?? 0) > now - 10_000) {
			return;
		}
		this.recent.set(key, now);
		if (this.recent.size > 500) {
			for (const [k, at] of this.recent) {
				if (at < now - 10_000) {
					this.recent.delete(k);
				}
			}
		}
		this._onViolation.fire({ tag, denial });
	}

	// --- macOS: the kernel log ------------------------------------------------------------------

	private watch(tag: string): void {
		this.liveTags.add(tag);
		if (this.monitor || this.platform !== 'darwin') {
			return;
		}
		const child = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', `eventMessage CONTAINS "${SEATBELT_TAG_PREFIX}"`], { stdio: ['ignore', 'pipe', 'ignore'] });
		this.monitor = child;
		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			// ndjson: one record per line; newlines inside messages are escaped.
			buffer += data;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				this.onLogLine(line);
			}
		});
		child.on('error', err => this.logger.warn('[volt-sandbox] log stream failed', err));
		child.on('close', () => {
			if (this.monitor === child) {
				this.monitor = undefined;
			}
		});
	}

	private onLogLine(line: string): void {
		const violation = parseSeatbeltLogLine(line);
		if (!violation || !this.liveTags.has(violation.tag)) {
			return;
		}
		const kind = denialKindForOperation(violation.operation);
		if (!kind) {
			return;
		}
		this.report(violation.tag, { kind, target: violation.target, source: 'os', process: violation.process });
	}

	private unwatch(tag: string): void {
		this.liveTags.delete(tag);
		if (!this.liveTags.size && this.monitor) {
			// Late denials of a process that just exited are not worth a running log stream.
			const monitor = this.monitor;
			this.monitor = undefined;
			monitor.kill();
		}
	}

	// --- host facts and the Linux helper --------------------------------------------------------

	private hostInfo(): Promise<ISandboxHostInfo> {
		this.host ??= (async () => {
			const home = await fs.realpath(homedir()).catch(() => homedir());
			const tmp = await fs.realpath(tmpdir()).catch(() => tmpdir());
			let darwinUserCacheDir: string | undefined;
			if (this.platform === 'darwin') {
				darwinUserCacheDir = await execFileAsync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']).then(r => r.stdout.trim(), () => undefined);
				darwinUserCacheDir = darwinUserCacheDir ? await fs.realpath(darwinUserCacheDir).catch(() => darwinUserCacheDir) : undefined;
			}
			return { platform: this.platform, home, tmpdir: tmp, darwinUserCacheDir, uid: process.getuid?.() };
		})();
		return this.host;
	}

	/** Compiles the helper once per source version; undefined when no compiler works. */
	ensureHelper(): Promise<string | undefined> {
		this.helper ??= (async () => {
			const digest = createHash('sha256').update(LANDLOCK_HELPER_SOURCE).digest('hex').slice(0, 12);
			const dir = join(this.stateDir, 'volt-sandbox');
			const binary = join(dir, `volt-landlock-${digest}`);
			if (existsSync(binary)) {
				return binary;
			}
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			const source = join(dir, `volt-landlock-${digest}.c`);
			await fs.writeFile(source, LANDLOCK_HELPER_SOURCE, { mode: 0o600 });
			for (const compiler of ['cc', 'gcc', 'clang']) {
				try {
					await execFileAsync(compiler, ['-O2', '-o', `${binary}.tmp`, source], { timeout: 60_000 });
					await fs.rename(`${binary}.tmp`, binary);
					this.logger.info(`[volt-sandbox] compiled the Landlock helper with ${compiler}`);
					return binary;
				} catch {
					// Try the next compiler.
				}
			}
			this.logger.warn('[volt-sandbox] no C compiler could build the Landlock helper');
			return undefined;
		})();
		return this.helper;
	}

	private async landlockAbi(helper: string): Promise<number> {
		try {
			const { stdout } = await execFileAsync(helper, ['--probe'], { timeout: 5_000 });
			return Number.parseInt(stdout.trim(), 10) || 0;
		} catch {
			return 0;
		}
	}

	override dispose(): void {
		this.monitor?.kill();
		this.monitor = undefined;
		super.dispose();
	}
}

/** Each existing path, plus its resolved form when a symlink leads elsewhere (Seatbelt checks resolved paths). */
async function withRealpaths(paths: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const path of paths) {
		out.push(path);
		const real = await fs.realpath(path).catch(() => undefined);
		if (real && real !== path) {
			out.push(real);
		}
	}
	return [...new Set(out)];
}

async function which(command: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('which', [command]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}
