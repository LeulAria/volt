/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { chatLaunchView, evaluateLaunch, IAdminPolicy, ILaunchDecision, IWorkspaceRestriction, PolicyAuthorityMode, PolicySnapshot } from '../common/authority.js';
import { ILaunchCompileInput, ILaunchCompileRecord, ISandboxCompositionNote, ISandboxLayer, LaunchPolicyCache, launchCompileRecord, launchPolicyBytes } from '../common/compile.js';
import { chatSubject, ICallContext, IPrincipal, PrincipalKind, SubjectKey } from '../common/principals.js';
import { IAttestation, ISandboxBackendCapabilities, SandboxBackendId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { ISandboxDenial, isNoiseDenial } from '../common/sandboxDenials.js';
import { agentStatePlan } from '../common/agentState.js';
import { AGENT_STATE_ROOT, agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest, nativeSandboxOffArgs } from '../common/sandboxPolicy.js';
import { AGENT_CONFIG_NAMES } from '../common/sandboxProfiles.js';
import { AgentStateOverlay, IAgentStateSync } from './agentStateOverlay.js';
import type { NetworkBrokerMode } from '../common/networkBrokerSetting.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { IVoltSandboxPolicy, SandboxDimension } from '../common/sandboxSchema.js';
import { readAdminPolicy, systemAdminPolicySource } from './adminPolicy.js';
import { NetworkViewProvider } from './networkBroker.js';
import { PrincipalRegistry } from './principalRegistry.js';
import { IPreparedSandbox, SandboxManager } from './sandboxManager.js';
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
	/** Who runs: minted for this launch by the registry, sealed with the resolved policy's hash (F.1). */
	readonly principal: IPrincipal;
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

/**
 * One launch where the earlier composition and the Policy Authority disagreed (M.3 step 2):
 * `refused`, the Authority refused a launch the earlier composition would have run (explained by
 * the decision's layer and the request it denied); `policy`, both run it but the compiled policy's
 * bytes differ (explained by the narrowing layers' notes).
 */
export interface ILaunchShadowDiff {
	readonly at: number;
	readonly subject: SubjectKey;
	readonly mode: PolicyAuthorityMode;
	readonly kind: 'refused' | 'policy';
	readonly decision: ILaunchDecision;
	readonly ignored?: readonly ISandboxCompositionNote[];
}

export interface IVoltSandboxLauncherOptions {
	readonly platform?: string;
	/** Tests: a manager with a fake backend. */
	readonly manager?: SandboxManager;
	/** `volt.sandbox.policyAuthority.mode`; default `enforce`. */
	readonly mode?: () => PolicyAuthorityMode;
	/** The managed policy; default: the system's managed locations (`adminPolicy.ts`), read once. */
	readonly admin?: () => Promise<IAdminPolicy & { readonly source?: string; readonly problem?: string }>;
	readonly workspace?: IWorkspaceRestriction;
	readonly now?: () => number;
	/** This execution host's id, for the principals it mints. */
	readonly executionHost?: string;
	/** The supervisor's feature flag (`volt.sandbox.supervisor.enabled`). */
	readonly supervisorEnabled?: () => boolean;
	/** `volt.sandbox.networkBroker`, read at every launch; default the network broker. Not with `manager`. */
	readonly networkMode?: () => NetworkBrokerMode;
}

const MAX_KEPT = 500;

/** Who a launch is for: the chat (its state key), or the workspace's anonymous principal for a run with no chat. */
export function launchSubject(request: Pick<IVoltSandboxRequest, 'providerId' | 'workspaceRoots' | 'stateKey'>): SubjectKey {
	return chatSubject(request.stateKey !== undefined ? request.stateKey : `run-${sandboxCacheKey(request)}`);
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

	private readonly _onDidShadowDiff = this._register(new Emitter<ILaunchShadowDiff>());
	readonly onDidShadowDiff: Event<ILaunchShadowDiff> = this._onDidShadowDiff.event;

	private readonly manager: SandboxManager;
	/** Long-lived hosts (plugin hosts, MCP servers) and the Security page's view of every sandboxed process. */
	readonly supervisor: SandboxSupervisor;
	private agentHost: Promise<Omit<IAgentSandboxHost, 'sshAuthSock'>> | undefined;
	private readonly recent = new Map<string, number>();
	/** Mints every principal this execution host runs, and binds hosts' channels to them. */
	readonly registry: PrincipalRegistry;
	private readonly cache = new LaunchPolicyCache();
	private readonly mode: () => PolicyAuthorityMode;
	private readonly now: () => number;
	private readonly readAdmin: () => Promise<IAdminPolicy & { readonly source?: string; readonly problem?: string }>;
	private admin: Promise<IAdminPolicy> | undefined;
	private workspace: IWorkspaceRestriction | undefined;
	private layers: readonly ISandboxLayer[] = [];
	private epoch = 0;
	private readonly _shadowDiffs: ILaunchShadowDiff[] = [];
	private readonly compiles: ILaunchCompileRecord[] = [];

	constructor(
		/** Volt's user data: never readable by a sandboxed agent (agent-server token, MCP state). */
		private readonly userDataDir: string,
		private readonly logger: ILogger,
		options: IVoltSandboxLauncherOptions = {},
	) {
		super();
		const sandboxLogger = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m) };
		this.manager = options.manager ?? new SandboxManager(sandboxLogger, { platform: options.platform ?? process.platform, ...(options.networkMode ? { networkMode: options.networkMode } : {}) });
		this.now = options.now ?? Date.now;
		this.registry = this._register(new PrincipalRegistry(options.executionHost ?? `launcher:${process.pid}`, this.now));
		// Disposed at once (its disposal starts killing the hosts); the shutdown below waits for those kills.
		// With the registry: a host's channel is bound to its principal (identity is the channel, H.3).
		this.supervisor = this._register(new SandboxSupervisor(this.manager, sandboxLogger, { registry: this.registry, ...(options.supervisorEnabled ? { enabled: options.supervisorEnabled } : {}) }));
		// Hosts first (their whole trees), then every other run the manager still has.
		this._register(toDisposable(() => void this.shutdown()));
		this.mode = options.mode ?? (() => 'enforce');
		this.readAdmin = options.admin ?? (() => readAdminPolicy(systemAdminPolicySource()));
		this.workspace = options.workspace;
		this.cache.invalidate(this.epoch);
	}

	/** Volt quits: every sandboxed process tree goes. */
	async shutdown(): Promise<void> {
		this.shutdownDone ??= (async () => {
			await this.supervisor.shutdown();
			await this.manager.dispose();
		})();
		return this.shutdownDone;
	}

	private shutdownDone: Promise<void> | undefined;

	/**
	 * Where the network broker gets the view of principals that are not chats: plugin hosts (their
	 * manifest), MCP servers (their approved `allowedHosts`, acting for their parent chat). See
	 * `NetworkBroker.registerViewProvider`.
	 */
	registerNetworkViewProvider(provider: NetworkViewProvider): IDisposable {
		return this.manager.registerNetworkViewProvider(provider);
	}

	/** A view provider's answer changed for `subjects`: their open tunnels are judged again. */
	networkViewsChanged(subjects: readonly SubjectKey[], narrowed: boolean): void {
		this.manager.networkViewsChanged(subjects, narrowed);
	}

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
	 *
	 * The launch goes principal (minted here) -> Policy Authority (`evaluateLaunch`) -> Policy
	 * Compiler (`compile.ts`) -> SandboxManager (spec F.5, M.3 C2 step 4). A launch the Authority
	 * refuses is refused here, before any folder, overlay or backend is touched (LAUNCH-AUTH-1). In
	 * `shadow` mode the earlier composition (`agentSandboxPolicy` straight from the request) acts and
	 * the Authority's result is only compared; every difference is recorded either way.
	 */
	async prepare(command: string, args: readonly string[], request: IVoltSandboxRequest, options: { cwd?: string; hostEnv: Readonly<Record<string, string | undefined>>; env?: Readonly<Record<string, string>>; terminal?: boolean; label?: string; kind?: PrincipalKind }): Promise<ISandboxLaunch> {
		const host = await this.hostFacts();
		const mode = this.mode();
		const principal = this.registry.mint({ subject: launchSubject(request), kind: options.kind ?? 'agent', launchPolicyHash: '' });
		let sealed = principal;
		let launched = false;
		try {
			const epoch = this.epoch;
			const decision = await this.judge(principal, request, host, epoch);
			if (!decision.allow) {
				this.recordDiff({ subject: principal.subject, mode, kind: 'refused', decision });
				if (mode === 'enforce') {
					// A typed refusal the chat shows; never retried without the sandbox (F.5 rule 5).
					throw new SandboxUnavailableError(`Volt's sandbox policy refused this launch: ${decision.reason}.`, 'unavailable');
				}
			}
			const sshAuthSock = options.hostEnv.SSH_AUTH_SOCK && await fs.stat(options.hostEnv.SSH_AUTH_SOCK).then(s => s.isSocket(), () => false) ? options.hostEnv.SSH_AUTH_SOCK : undefined;
			// Package caches per principal: one chat's sandbox cannot plant a package another one runs (B-35).
			const cacheDir = join(host.cacheDir, sandboxCacheKey(request));
			await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
			// The chat's own copy of the CLI's config (B-05); without a chat to key it, the config stays read-only.
			const statePlan = request.stateKey !== undefined ? agentStatePlan(request.providerId, request.stateKey, { platform: host.platform, home: host.home, root: this.stateRoot(host.home), hostEnv: options.hostEnv }, AGENT_CONFIG_NAMES) : undefined;
			const overlay = statePlan ? await AgentStateOverlay.prepare(statePlan, { warn: message => this.logger.warn(message) }) : undefined;
			const agentHost: IAgentSandboxHost = { ...host, cacheDir, ...(sshAuthSock ? { sshAuthSock } : {}), ...(statePlan ? { statePlan } : {}) };
			const policy = this.policyFor(principal.subject, mode, decision, { subject: principal.subject, epoch, request, host: agentHost, ...this.layers.length ? { layers: this.layers } : {} });
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
				// The network broker's route, token, grants and budgets are this principal's; its chat's
				// grants attach to the chat, not to this one run (I.4 routes).
				principal,
			});
			sealed = this.registry.sealLaunchPolicy(principal, prepared.launchPolicyHash);
			launched = true;
			return this.launch(prepared, overlay, policy, sealed);
		} finally {
			if (!launched) {
				this.registry.retire(principal.id);
			}
		}
	}

	/** The Authority's decision for this launch, over a snapshot of the chat, the managed policy and the workspace's restrictions. */
	private async judge(principal: IPrincipal, request: IVoltSandboxRequest, host: Omit<IAgentSandboxHost, 'sshAuthSock'>, epoch: number): Promise<ILaunchDecision> {
		const admin = await this.adminPolicy();
		const snapshot = PolicySnapshot.build({
			epoch,
			asOf: this.now(),
			chats: [chatLaunchView(principal.subject, request)],
			home: host.home,
			...Object.keys(admin).length ? { admin } : {},
			...this.workspace ? { workspace: this.workspace } : {},
		});
		const context: ICallContext = { principal, onBehalfOf: [], requestId: `launch:${principal.id}` };
		return evaluateLaunch(snapshot, context, request.workspaceRoots);
	}

	/**
	 * The policy that acts: the compiled one in `enforce`, the earlier composition in `shadow`.
	 * Both are computed when they can be, and a difference is recorded with what explains it.
	 */
	private policyFor(subject: SubjectKey, mode: PolicyAuthorityMode, decision: ILaunchDecision, input: ILaunchCompileInput): IVoltSandboxPolicy {
		const compiled = decision.allow ? this.cache.compile(decision, input) : undefined;
		if (compiled) {
			this.compiles.push(launchCompileRecord(compiled, input));
			if (this.compiles.length > MAX_KEPT) {
				this.compiles.shift();
			}
		}
		const legacy = agentSandboxPolicy(input.request, input.host);
		if (compiled && launchPolicyBytes(compiled.policy) !== launchPolicyBytes(legacy)) {
			this.recordDiff({ subject, mode, kind: 'policy', decision, ignored: compiled.ignored });
		}
		return mode === 'enforce' && compiled ? compiled.policy : legacy;
	}

	private recordDiff(diff: Omit<ILaunchShadowDiff, 'at'>): void {
		const entry: ILaunchShadowDiff = { at: this.now(), ...diff };
		this._shadowDiffs.push(entry);
		if (this._shadowDiffs.length > MAX_KEPT) {
			this._shadowDiffs.shift();
		}
		const what = diff.kind === 'refused'
			? `the Authority refused (${diff.decision.deniedBy}/${diff.decision.code}: ${diff.decision.reason}${diff.decision.denied ? `; ${diff.decision.denied.capability} ${diff.decision.denied.target ?? ''}` : ''})`
			: `the compiled policy differs (${diff.ignored?.map(note => `${note.field} ${note.value}: ${note.reason}`).join('; ') || 'narrowing layers'})`;
		this.logger.warn(`[volt-sandbox] policy authority ${diff.mode}: ${diff.subject} launch: ${what}; ${diff.mode === 'enforce' ? 'the Authority acted' : 'the earlier composition acted'}`);
		this._onDidShadowDiff.fire(entry);
	}

	/** Launch differences between the earlier composition and the Authority (the last 500). */
	get shadowDiffs(): readonly ILaunchShadowDiff[] {
		return this._shadowDiffs;
	}

	/** The compile cache: hits, misses, entries, and the epoch it holds. */
	get cacheStats(): { readonly hits: number; readonly misses: number; readonly size: number; readonly epoch: number } {
		return { hits: this.cache.hits, misses: this.cache.misses, size: this.cache.size, epoch: this.cache.currentEpoch };
	}

	/** Principals minted for launches that have not ended yet. */
	get livePrincipals(): number {
		return this.registry.size;
	}

	/** The last compiles, for replay (POL-DET-1). */
	get compileLog(): readonly ILaunchCompileRecord[] {
		return this.compiles;
	}

	/** The policy inputs changed (a managed policy, a workspace restriction): a new epoch, and every cached compile goes. */
	invalidate(changes: { readonly admin?: IAdminPolicy; readonly workspace?: IWorkspaceRestriction; readonly layers?: readonly ISandboxLayer[] } = {}): number {
		if (changes.admin) {
			this.admin = Promise.resolve(changes.admin);
		}
		if ('workspace' in changes) {
			this.workspace = changes.workspace;
		}
		if (changes.layers) {
			this.layers = changes.layers;
		}
		this.epoch++;
		this.cache.invalidate(this.epoch);
		return this.epoch;
	}

	private adminPolicy(): Promise<IAdminPolicy> {
		this.admin ??= this.readAdmin().then(({ source: _source, problem, ...policy }) => {
			if (problem) {
				this.logger.warn(`[volt-sandbox] managed policy: ${problem}`);
			}
			return policy;
		}, () => ({ unreadable: true }));
		return this.admin;
	}

	private launch(prepared: IPreparedSandbox, overlay: AgentStateOverlay | undefined, policy: IVoltSandboxPolicy, principal: IPrincipal): ISandboxLaunch {
		const listener = prepared.onDenial(denial => {
			if (denial.kind === 'process' || denial.kind === 'limit') {
				return;
			}
			this.report(prepared.tag, { kind: denial.kind, target: denial.target, source: denial.source === 'proxy' ? 'proxy' : 'os', ...(denial.process ? { process: denial.process } : {}), ...(denial.promptable === false ? { promptable: false } : {}) });
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
			principal,
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
					this.registry.retire(principal.id);
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
