/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { IAttestation, ISandboxBackendCapabilities, SandboxBackendId } from '../common/sandboxBackend.js';
import { ISandboxDenial, isNoiseDenial } from '../common/sandboxDenials.js';
import { agentStatePlan } from '../common/agentState.js';
import { AGENT_STATE_ROOT, agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest, nativeSandboxOffArgs } from '../common/sandboxPolicy.js';
import { AGENT_CONFIG_NAMES } from '../common/sandboxProfiles.js';
import { AgentStateOverlay, IAgentStateSync } from './agentStateOverlay.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { SandboxDimension } from '../common/sandboxSchema.js';
import { SandboxManager } from './sandboxManager.js';
import { SandboxSupervisor } from './supervisor.js';
import { sandboxHostFacts } from './sandboxResolver.js';
import { SandboxConfirmation } from './sandboxBackends.js';

const execFileAsync = promisify(execFile);

export type SandboxMechanism = 'seatbelt' | 'bwrap' | 'mxc' | 'none';

export interface IVoltSandboxSupport {
	readonly platform: string;
	readonly mechanism: SandboxMechanism;
	/** Writes are confined. */
	readonly filesystem: boolean;
	/** Network can be limited to Volt's proxy. */
	readonly network: boolean;
	/** One line for the UI: "macOS Seatbelt", "bubblewrap 0.9.0", or why there is none. */
	readonly detail: string;
}

/** A prepared agent launch. The caller spawns it, then must `confirm` before trusting it and `dispose` after. */
export interface ISandboxLaunch {
	readonly command: string;
	readonly args: string[];
	/** The agent's complete environment. Nothing else may be merged in. */
	readonly env: Record<string, string>;
	readonly cwd: string;
	/** stdio entries from fd 3 up. */
	readonly extraStdio: readonly (number | 'pipe')[];
	/** Which way each of them carries data (see `ISandboxLaunchSpec.extraStdioDirections`). */
	readonly extraStdioDirections: readonly ('in' | 'out')[];
	readonly tag: string;
	readonly policy: IResolvedSandboxPolicy;
	readonly mechanism: SandboxMechanism;
	/** Dimensions running best effort (status `partial`). Shown in the transcript. */
	readonly unenforced: readonly SandboxDimension[];
	readonly warnings: readonly string[];
	/** Attests the spawned process from outside, then lets the agent run (F.5). Never `ok` without evidence. */
	confirm(child: ChildProcess): Promise<SandboxConfirmation>;
	/** The external evidence the agent started on, once `confirm` succeeded (F.12). */
	attestation(): IAttestation | undefined;
	terminate(child: ChildProcess): Promise<void>;
	/** Hosts the user allows later (network off): the running agent's next connection goes through. */
	allowDomains(domains: readonly string[]): void;
	/** After a turn: the allowed keys of the agent's config overlay go back to the user's config (B-05). */
	syncState(): Promise<IAgentStateSync | undefined>;
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

const UNENFORCED_TEXT: Partial<Record<SandboxDimension, string>> = {
	'filesystem.protectNew': 'protected files that do not exist yet (new git hooks, editor tasks) are not guarded on this OS',
	'process.tree': 'a process that detaches itself completely can outlive the agent (it stays sandboxed)',
};

/**
 * Agent CLI processes in the OS sandbox: builds the agent profile for a chat's request and runs
 * it through the SandboxManager. Refuses (throws) when the sandbox cannot be established; never
 * hands back an unsandboxed command.
 */
export class VoltSandboxLauncher extends Disposable {

	private readonly _onViolation = this._register(new Emitter<ISandboxViolationEvent>());
	readonly onViolation: Event<ISandboxViolationEvent> = this._onViolation.event;

	private readonly manager: SandboxManager;
	/** Long-lived hosts (plugin hosts, MCP servers) and the Security page's view of every sandboxed process. */
	readonly supervisor: SandboxSupervisor;
	private agentHost: Promise<Omit<IAgentSandboxHost, 'sshAuthSock'>> | undefined;
	private readonly recent = new Map<string, number>();

	constructor(
		/** Volt's user data: never readable by a sandboxed agent (agent-server token, MCP state). */
		private readonly userDataDir: string,
		private readonly logger: ILogger,
		platform: string = process.platform,
		/** The supervisor's feature flag (`volt.sandbox.supervisor.enabled`). */
		supervisorEnabled?: () => boolean,
	) {
		super();
		const sandboxLogger = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m) };
		this.manager = new SandboxManager(sandboxLogger, { platform });
		this.supervisor = new SandboxSupervisor(this.manager, sandboxLogger, { ...(supervisorEnabled ? { enabled: supervisorEnabled } : {}) });
		// Hosts first (their whole trees), then every other run the manager still has.
		this._register(toDisposable(() => void this.shutdown()));
	}

	/** Volt quits: every sandboxed process tree goes. */
	async shutdown(): Promise<void> {
		this.shutdownDone ??= (async () => {
			await this.supervisor.shutdown();
			this.supervisor.dispose();
			await this.manager.dispose();
		})();
		return this.shutdownDone;
	}

	private shutdownDone: Promise<void> | undefined;

	async getSupport(): Promise<IVoltSandboxSupport> {
		const capabilities = await this.manager.capabilities();
		return supportFrom(capabilities);
	}

	capabilities(): Promise<ISandboxBackendCapabilities> {
		return this.manager.capabilities();
	}

	/**
	 * The command, arguments and environment that run `command args` sandboxed by `request`.
	 * `hostEnv` is the user's environment the profile filters; `env` is what Volt sets on purpose.
	 */
	async prepare(command: string, args: readonly string[], request: IVoltSandboxRequest, options: { cwd?: string; hostEnv: Readonly<Record<string, string | undefined>>; env?: Readonly<Record<string, string>>; terminal?: boolean; label?: string }): Promise<ISandboxLaunch> {
		const host = await this.hostFacts();
		const sshAuthSock = options.hostEnv.SSH_AUTH_SOCK && await fs.stat(options.hostEnv.SSH_AUTH_SOCK).then(s => s.isSocket(), () => false) ? options.hostEnv.SSH_AUTH_SOCK : undefined;
		// Package caches per principal: one chat's sandbox cannot plant a package another one runs (B-35).
		const cacheDir = join(host.cacheDir, sandboxCacheKey(request));
		await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
		// The chat's own copy of the CLI's config (B-05); without a chat to key it, the config stays read-only.
		const statePlan = request.stateKey !== undefined ? agentStatePlan(request.providerId, request.stateKey, { platform: host.platform, home: host.home, root: this.stateRoot(host.home), hostEnv: options.hostEnv }, AGENT_CONFIG_NAMES) : undefined;
		const overlay = statePlan ? await AgentStateOverlay.prepare(statePlan, { warn: message => this.logger.warn(message) }) : undefined;
		const policy = agentSandboxPolicy(request, { ...host, cacheDir, ...(sshAuthSock ? { sshAuthSock } : {}), ...(statePlan ? { statePlan } : {}) });
		// The overlay's variables win over the user's own (`CLAUDE_CONFIG_DIR` set in their shell).
		const env = statePlan ? { ...options.env, ...statePlan.env } : options.env;
		const prepared = await this.manager.prepare({
			command,
			args: [...nativeSandboxOffArgs(request.providerId), ...args],
			policy,
			context: { workspaceRoots: request.workspaceRoots.filter(root => !root.endsWith('/.git')), cwd: options.cwd, hostEnv: options.hostEnv, env },
			terminal: !!options.terminal,
			label: options.label ?? `${request.providerId} agent`,
			isolate: [{ root: host.cacheDir, keep: cacheDir }],
		});
		const listener = prepared.onDenial(denial => {
			if (denial.kind === 'process' || denial.kind === 'limit') {
				return;
			}
			this.report(prepared.tag, { kind: denial.kind, target: denial.target, source: denial.source === 'proxy' ? 'proxy' : 'os', ...(denial.process ? { process: denial.process } : {}) });
		});
		const warnings = prepared.unenforced.map(dimension => `Sandbox is partial here: ${UNENFORCED_TEXT[dimension] ?? dimension}.`);
		if (policy.network.listen) {
			warnings.push('Sandbox is partial here: with the network on, Linux cannot limit listening to the ports you allowed, so the agent may listen on any port.');
		}
		let disposed = false;
		return {
			command: prepared.command,
			args: [...prepared.args],
			env: { ...prepared.env },
			cwd: prepared.cwd,
			extraStdio: prepared.extraStdio,
			extraStdioDirections: prepared.extraStdioDirections,
			tag: prepared.tag,
			policy: prepared.policy,
			mechanism: mechanismOf(prepared.backend),
			unenforced: prepared.unenforced,
			warnings,
			confirm: child => prepared.confirm(child),
			attestation: () => prepared.attestation(),
			terminate: child => prepared.terminate(child),
			allowDomains: domains => prepared.allowDomains(domains),
			syncState: async () => {
				if (!overlay) {
					return undefined;
				}
				const result = await overlay.sync();
				// A refreshed login needs the provider's word that it is the same account: not on the turn's path.
				void overlay.syncCredentials().catch(err => this.logger.warn(`[volt-sandbox] agent login merge failed: ${err}`));
				return result;
			},
			dispose: () => {
				if (!disposed) {
					disposed = true;
					listener.dispose();
					void prepared.dispose();
					if (overlay) {
						void overlay.sync().then(() => overlay.syncCredentials()).catch(err => this.logger.warn(`[volt-sandbox] agent state merge failed: ${err}`));
					}
				}
			},
		};
	}

	/** `~/.volt/sandbox/agent-state`: per-chat config overlays (agentState.ts). Old ones are pruned once. */
	private stateRoot(home: string): string {
		const root = join(home, AGENT_STATE_ROOT);
		if (!this.stateRootPruned) {
			this.stateRootPruned = true;
			void AgentStateOverlay.prune(root).catch(() => undefined);
		}
		return root;
	}

	private stateRootPruned = false;

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

	private hostFacts(): Promise<Omit<IAgentSandboxHost, 'sshAuthSock'>> {
		this.agentHost ??= (async () => {
			const facts = await sandboxHostFacts();
			const temps = new Set<string>([facts.tmpRoot]);
			for (const dir of ['/tmp', '/var/tmp']) {
				temps.add(await fs.realpath(dir).catch(() => dir));
			}
			if (facts.platform === 'darwin') {
				const cache = await execFileAsync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']).then(r => fs.realpath(r.stdout.trim()), () => undefined);
				if (cache) {
					temps.add(cache);
				}
			}
			// The root of the per-principal caches (see `sandboxCacheKey`); each run gets its own child.
			const cacheRoot = join(facts.home, '.volt', 'sandbox-cache');
			await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
			const cacheDir = await fs.realpath(cacheRoot).catch(() => cacheRoot);
			const userDataDir = await fs.realpath(this.userDataDir).catch(() => this.userDataDir);
			return {
				platform: facts.platform,
				home: facts.home,
				tempDirs: [...temps].filter(dir => dir !== '/' && dir !== facts.home),
				uid: process.getuid?.(),
				userDataDir,
				sshPrivateKeys: await sshPrivateKeys(join(facts.home, '.ssh')),
				cacheDir,
			};
		})();
		return this.agentHost;
	}

}

/**
 * Whose package cache a run uses: the agent provider and the chat's workspace. Chats of one
 * project share one; another project's chat (or another provider) cannot read or poison it.
 * Becomes the principal's subject once principals are minted by the registry (F.1).
 */
export function sandboxCacheKey(request: Pick<IVoltSandboxRequest, 'providerId' | 'workspaceRoots'>): string {
	return createHash('sha256').update([request.providerId, ...request.workspaceRoots].join('\0')).digest('hex').slice(0, 16);
}

function mechanismOf(backend: SandboxBackendId): SandboxMechanism {
	return backend === 'seatbelt' ? 'seatbelt' : backend === 'bubblewrap' ? 'bwrap' : backend === 'mxc' ? 'mxc' : 'none';
}

export function supportFrom(capabilities: ISandboxBackendCapabilities): IVoltSandboxSupport {
	const platform = process.platform;
	if (!capabilities.available) {
		return { platform, mechanism: 'none', filesystem: false, network: false, detail: capabilities.diagnostics[0] ?? 'No OS sandbox on this machine' };
	}
	return {
		platform,
		mechanism: mechanismOf(capabilities.backend),
		filesystem: capabilities.enforcement['filesystem.write'] === 'enforced',
		network: capabilities.enforcement['network.proxy'] === 'enforced',
		detail: capabilities.details[0] ?? capabilities.backend,
	};
}

/** Files in `~/.ssh` that hold a private key, judged by content rather than name. */
export async function sshPrivateKeys(dir: string): Promise<string[]> {
	const out: string[] = [];
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		const path = join(dir, name);
		const handle = await fs.open(path, 'r').catch(() => undefined);
		if (!handle) {
			continue;
		}
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 1024 * 1024) {
				continue;
			}
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
			const head = buffer.subarray(0, bytesRead).toString('latin1');
			if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|PuTTY-User-Key-File/.test(head)) {
				out.push(await fs.realpath(path).catch(() => path));
			}
		} finally {
			await handle.close();
		}
	}
	return out;
}
