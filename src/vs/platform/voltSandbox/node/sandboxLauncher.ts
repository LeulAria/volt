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
import { composeLaunchLayers, ILaunchCompileInput, ILaunchCompileRecord, ISandboxComposition, ISandboxCompositionNote, ISandboxLayer, LaunchPolicyCache, launchCompileRecord, launchPolicyBytes } from '../common/compile.js';
import { describeIgnoredEntries, ISandboxPolicyFilesInfo } from '../common/sandboxPolicyFiles.js';
import { ISandboxPolicyFileLayers, SandboxPolicyFiles } from './sandboxPolicyFiles.js';
import { chatSubject, corePrincipal, ICallContext, IPrincipal, PrincipalKind, SubjectKey } from '../common/principals.js';
import { MCP_HOST_QUOTAS, mcpHostPolicy } from '../common/sandboxMcp.js';
import { isLiveWorkloadState } from '../common/sandboxWorkloads.js';
import { IAttestation, ISandboxBackendCapabilities, redactSandboxText, SandboxBackendId, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { ISandboxDenial, isNoiseDenial, isQuietDenial } from '../common/sandboxDenials.js';
import { agentStatePlan } from '../common/agentState.js';
import { AGENT_STATE_ROOT, agentQuietDomains, agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest, nativeSandboxOffArgs } from '../common/sandboxPolicy.js';
import { AGENT_CONFIG_NAMES } from '../common/sandboxProfiles.js';
import { AgentStateOverlay, IAgentStateSync } from './agentStateOverlay.js';
import type { NetworkBrokerMode } from '../common/networkBrokerSetting.js';
import type { INetworkGrantSource, NetworkViewProvider } from './networkBroker.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { IVoltSandboxPolicy, SandboxDimension } from '../common/sandboxSchema.js';
import { readAdminPolicy, systemAdminPolicySource } from './adminPolicy.js';
import { PrincipalRegistry } from './principalRegistry.js';
import { IPreparedSandbox, SandboxManager } from './sandboxManager.js';
import { HostStartResult, killTagged, SandboxSupervisor } from './supervisor.js';
import { SandboxedExtensionHosts } from './extensionHostSandbox.js';
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
	/** Where the network broker's grants live (the grant store); not with `manager`. */
	readonly grants?: () => Promise<INetworkGrantSource | undefined>;
	/** `~/.volt/sandbox.json` and the workspaces' `.volt/sandbox.json`; tests point the user's elsewhere. */
	readonly policyFiles?: SandboxPolicyFiles;
}

/** A stdio MCP server Volt starts for a sandboxed chat (see {@link VoltSandboxLauncher.startMcpHost}). */
export interface IMcpHostLaunch {
	readonly chatId: string;
	/** The chat's title, for the Security page. */
	readonly chatLabel?: string;
	/** Its name in the config. */
	readonly server: string;
	/** sha256 (hex) of its canonical config: its subject, `mcp:<digest>`. */
	readonly digest: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	/** The user's environment the policy's allow list copies from. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
	/** The server's own `env` from its config. */
	readonly env?: Readonly<Record<string, string>>;
	/** The chat's sandbox: the server's is that, narrowed. */
	readonly sandbox: IVoltSandboxRequest;
	/** Hosts approved for the server; none: no network. */
	readonly allowedHosts?: readonly string[];
	/** Defaults: H.8 (`MCP_HOST_QUOTAS`). */
	readonly idle?: { readonly afterMs: number; readonly stopAfterMs: number };
	readonly memoryMB?: number;
}

class McpHostPolicyRefusal extends Error { }

const MAX_KEPT = 500;

/** Who a launch is for: the chat (its state key), or the workspace's anonymous principal for a run with no chat. */
export function launchSubject(request: Pick<IVoltSandboxRequest, 'providerId' | 'workspaceRoots' | 'stateKey'>): SubjectKey {
	return chatSubject(request.stateKey !== undefined ? request.stateKey : `run-${sandboxCacheKey(request)}`);
}

export interface ISandboxViolationEvent {
	readonly tag: string;
	readonly denial: ISandboxDenial;
}

/** Where a run's denials are judged from: the home folder and the chat's folders (see `isQuietDenial`). */
interface IDenialContext {
	readonly home: string;
	readonly roots: readonly string[];
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

	private readonly _onDidChangeManagedPolicy = this._register(new Emitter<void>());
	/** The managed (admin) policy was read or changed: every gate that judges by it re-judges. */
	readonly onDidChangeManagedPolicy: Event<void> = this._onDidChangeManagedPolicy.event;

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
	/** The managed policy once read: what the network broker judges by. */
	private adminNow: IAdminPolicy | undefined;
	private workspace: IWorkspaceRestriction | undefined;
	private layers: readonly ISandboxLayer[] = [];
	private readonly policyFiles: SandboxPolicyFiles;
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
		// The broker judges connections by the managed policy as last read here (launches, `invalidate`).
		// Runs a dead Volt left behind are reaped by their tag before their folders go (FAIL-CRASH-1).
		this.manager = options.manager ?? new SandboxManager(sandboxLogger, { platform: options.platform ?? process.platform, ...(options.networkMode ? { networkMode: options.networkMode } : {}), ...(options.grants ? { grants: options.grants } : {}), adminPolicy: () => this.adminNow, reap: killTagged });
		this.now = options.now ?? Date.now;
		this.registry = new PrincipalRegistry(options.executionHost ?? `launcher:${process.pid}`, this.now);
		// Disposed at once (its disposal starts killing the hosts); the shutdown below waits for those kills.
		// Its hosts' principals (and their restarts') are this registry's, so revoking a chat's anchor stops them.
		this.supervisor = this._register(new SandboxSupervisor(this.manager, sandboxLogger, { ...(options.supervisorEnabled ? { enabled: options.supervisorEnabled } : {}), registry: this.registry }));
		this._register(this.registry);
		this._register(this.registry.onDidRevoke(principal => this.onPrincipalRevoked(principal)));
		// Hosts first (their whole trees), then every other run the manager still has.
		this._register(toDisposable(() => void this.shutdown()));
		this.mode = options.mode ?? (() => 'enforce');
		this.readAdmin = options.admin ?? (() => readAdminPolicy(systemAdminPolicySource()));
		this.workspace = options.workspace;
		this.policyFiles = options.policyFiles ?? new SandboxPolicyFiles();
		this.cache.invalidate(this.epoch);
	}

	/** T3 extension hosts (P2) under this launcher's supervisor: listed on the Security page with every other host. */
	extensionHosts(): SandboxedExtensionHosts {
		this._extensionHosts ??= new SandboxedExtensionHosts(this.supervisor, this.registry);
		return this._extensionHosts;
	}

	private _extensionHosts: SandboxedExtensionHosts | undefined;

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
			// The policy files, before any folder is made: a broken `~/.volt/sandbox.json` refuses here.
			const files = await this.readPolicyFiles(request, host);
			if (files.refusal) {
				throw new SandboxUnavailableError(files.refusal, 'unavailable');
			}
			// The backend's probe (once per process, cached) runs while the folders and the overlay are made.
			void this.manager.capabilities().catch(() => undefined);
			const sshAuthSock = options.hostEnv.SSH_AUTH_SOCK && await fs.stat(options.hostEnv.SSH_AUTH_SOCK).then(s => s.isSocket(), () => false) ? options.hostEnv.SSH_AUTH_SOCK : undefined;
			// Package caches per principal: one chat's sandbox cannot plant a package another one runs (B-35).
			const cacheDir = join(host.cacheDir, sandboxCacheKey(request));
			await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
			// The chat's own copy of the CLI's config (B-05); without a chat to key it, the config stays read-only.
			const statePlan = request.stateKey !== undefined ? agentStatePlan(request.providerId, request.stateKey, { platform: host.platform, home: host.home, root: this.stateRoot(host.home), hostEnv: options.hostEnv }, AGENT_CONFIG_NAMES) : undefined;
			const overlay = statePlan ? await AgentStateOverlay.prepare(statePlan, { warn: message => this.logger.warn(message) }) : undefined;
			const agentHost: IAgentSandboxHost = { ...host, cacheDir, ...(sshAuthSock ? { sshAuthSock } : {}), ...(statePlan ? { statePlan } : {}) };
			const { policy, ignored, contained } = this.policyFor(principal.subject, mode, decision, this.compileInput(principal.subject, epoch, request, agentHost, files), files);
			// The overlay's variables win over the user's own (`CLAUDE_CONFIG_DIR` set in their shell).
			const env = statePlan ? { ...options.env, ...statePlan.env } : options.env;
			const prepared = await this.manager.prepare({
				command,
				args: [...nativeSandboxOffArgs(request.providerId), ...args],
				policy,
				context: { workspaceRoots: request.workspaceRoots.filter(root => !root.endsWith('/.git')), cwd: options.cwd, hostEnv: options.hostEnv, env, ...contained.length ? { contained } : {} },
				terminal: !!options.terminal,
				label: options.label ?? `${request.providerId} agent`,
				isolate: [{ root: host.cacheDir, keep: cacheDir }],
				// The network broker's route, token, grants and budgets are this principal's; its chat's
				// grants attach to the chat, not to this one run (I.4 routes).
				principal,
				// The CLI's own telemetry stays blocked without a card inviting the user to allow it.
				quietHosts: agentQuietDomains(request.providerId),
			});
			sealed = this.registry.sealLaunchPolicy(principal, prepared.launchPolicyHash);
			launched = true;
			// The folders above these are the ones a CLI or a tool probes by itself (quiet denials).
			const given = [...request.workspaceRoots, ...request.extraWritableRoots ?? []];
			const roots = [...new Set([...given, ...await Promise.all(given.map(root => fs.realpath(root).catch(() => root)))])];
			return this.launch(prepared, overlay, policy, sealed, [...files.warnings, ...describeIgnoredEntries([...files.ignored, ...ignored], policyFileName)], { home: host.home, roots });
		} catch (err) {
			// Every failure here (a cache or overlay folder that can't be made, a config that can't be
			// linked) is the sandbox refusing, typed, so the chat says so and never retries it (FAIL-TYPED-1).
			throw err instanceof SandboxUnavailableError ? err : new SandboxUnavailableError(`Volt could not prepare the sandbox: ${redactSandboxText(err instanceof Error ? err.message : String(err), host.home)}`, 'unavailable');
		} finally {
			if (!launched) {
				this.registry.retire(principal.id);
			}
		}
	}

	/**
	 * A stdio MCP server for a sandboxed chat, as a long-lived host under the supervisor (spec C.2,
	 * H.1 T4, H.8, M.3 C6). Its principal is `mcp:<config digest>`, started for the chat's anchor
	 * principal: revoking the anchor ({@link stopChatHosts}) stops every server of the chat. The chat's
	 * launch is judged by the Policy Authority and compiled as an agent launch would be; the server's
	 * policy is that narrowed (`mcpHostPolicy`), so never wider than the chat, and recompiled the same
	 * way for every restart. Attested before the go byte, H.8 quotas, idle stop, F.11 restarts.
	 * Refusals are a typed result; nothing runs unsandboxed.
	 */
	async startMcpHost(launch: IMcpHostLaunch): Promise<HostStartResult> {
		if (!this.supervisor.enabled) {
			return { ok: false, refused: 'disabled', reason: 'Sandboxed hosts are turned off (volt.sandbox.supervisor.enabled).' };
		}
		if (!/^[a-f0-9]{16,128}$/.test(launch.digest)) {
			return { ok: false, refused: 'launch', reason: 'The MCP server has no valid config digest.' };
		}
		const host = await this.hostFacts();
		// The server's own request: the chat's rules, without the chat's agent state.
		const { stateKey: _stateKey, ...request } = launch.sandbox;
		const subject = chatSubject(launch.chatId);
		const judgeAs = corePrincipal(`mcp-launch:${launch.chatId}`, subject, 'mcp');
		/** What the policy files narrowed to, as of the latest compute: the resolver checks it at each (re)start. */
		let contained: ISandboxComposition['contained'] = [];
		const compute = async (): Promise<IVoltSandboxPolicy> => {
			const epoch = this.epoch;
			const mode = this.mode();
			const decision = await this.judge(judgeAs, request, host, epoch);
			if (!decision.allow) {
				this.recordDiff({ subject, mode, kind: 'refused', decision });
				if (mode === 'enforce') {
					throw new McpHostPolicyRefusal(`Volt's sandbox policy refused this chat's launch: ${decision.reason}.`);
				}
			}
			const files = await this.readPolicyFiles(request, host);
			if (files.refusal) {
				throw new McpHostPolicyRefusal(files.refusal);
			}
			const chat = this.policyFor(subject, mode, decision, this.compileInput(subject, epoch, request, { ...host, cacheDir: join(host.cacheDir, sandboxCacheKey(request)) }, files), files);
			contained = chat.contained;
			return mcpHostPolicy({ server: launch.server, chat: chat.policy, request, platform: host.platform, home: host.home, allowedHosts: launch.allowedHosts ?? [] }).policy;
		};
		let first: IVoltSandboxPolicy | undefined;
		try {
			first = await compute();
		} catch (err) {
			return { ok: false, refused: err instanceof McpHostPolicyRefusal ? 'policy' : 'launch', reason: (err as Error).message };
		}
		// The server's own storage (its HOME and package caches): one per chat and server, never another's.
		const storageDir = join(host.cacheDir, `mcp-${createHash('sha256').update(`${launch.chatId}\0${launch.digest}`).digest('hex').slice(0, 16)}`);
		await fs.mkdir(join(storageDir, 'home'), { recursive: true, mode: 0o700 });
		let anchor = this.chatAnchors.get(launch.chatId);
		if (!anchor || !this.registry.isLive(anchor.id)) {
			anchor = this.registry.mint({ subject, kind: 'agent', launchPolicyHash: '' });
			this.chatAnchors.set(launch.chatId, anchor);
		}
		const principal = this.registry.mint({ subject: `mcp:${launch.digest}`, kind: 'mcp', launchPolicyHash: '', parent: anchor.id });
		const result = await this.supervisor.start({
			principal,
			label: `MCP ${launch.server}`,
			command: { file: launch.command, args: [...launch.args] },
			policy: async () => {
				if (first) {
					const policy = first;
					first = undefined;
					return policy;
				}
				return compute();
			},
			context: {
				workspaceRoots: request.workspaceRoots.filter(root => !root.endsWith('/.git')),
				...(launch.cwd ? { cwd: launch.cwd } : {}),
				storageDir,
				hostEnv: launch.hostEnv,
				...(launch.env ? { env: launch.env } : {}),
				// Read by the resolver after `policy` above ran for this (re)start.
				get contained() { return contained; },
			},
			ipc: false,
			stdio: 'pipe',
			onBehalfOf: { subject, ...(launch.chatLabel ? { label: launch.chatLabel } : {}) },
			restart: { maxPerMinute: MCP_HOST_QUOTAS.restartsPerMinute },
			idle: { afterMs: launch.idle?.afterMs ?? MCP_HOST_QUOTAS.idleAfterMs, stopAfterMs: launch.idle?.stopAfterMs ?? MCP_HOST_QUOTAS.idleStopMs },
			limits: { memoryMB: launch.memoryMB ?? MCP_HOST_QUOTAS.memoryMB },
		});
		if (!result.ok) {
			this.retire(principal.id);
			return result;
		}
		const started = result.host;
		// Each instance's principal ends with its process; a restart runs as a new one (F.4).
		const exits = started.onExit(() => this.retire(started.principal.id));
		const states = started.onDidChangeState(state => {
			if (state === 'stopped' || state === 'failed' || state === 'broken') {
				this.retire(started.principal.id);
				if (state !== 'broken') {
					exits.dispose();
					states.dispose();
				}
			}
		});
		return result;
	}

	/**
	 * The chat closed, or its grants were revoked: its anchor principal is revoked, which revokes and
	 * stops every MCP server started for it, whole trees. Returns how many hosts were stopped.
	 */
	async stopChatHosts(chatId: string): Promise<number> {
		const anchor = this.chatAnchors.get(chatId);
		this.chatAnchors.delete(chatId);
		const before = this.supervisor.list().filter(host => host.onBehalfOf?.subject === chatSubject(chatId) && isLiveWorkloadState(host.state)).length;
		if (anchor) {
			this.registry.retire(anchor.id);
		}
		// Hosts whose principal is between instances (backoff) have no live child principal to revoke.
		await this.supervisor.stopFor(chatSubject(chatId));
		return before;
	}

	private readonly chatAnchors = new Map<string, IPrincipal>();
	/** Principals being retired by their own exit: their revocation must not stop the host again (a restart). */
	private readonly retiring = new Set<string>();

	private retire(principalId: string): void {
		this.retiring.add(principalId);
		try {
			this.registry.retire(principalId);
		} finally {
			this.retiring.delete(principalId);
		}
	}

	/** A revoked principal's host stops, whole tree (F.9: plugin or grant revoked, kill). */
	private onPrincipalRevoked(principal: IPrincipal): void {
		if (this.retiring.has(principal.id)) {
			return;
		}
		for (const host of this.supervisor.list()) {
			// A host whose process just exited revokes its own principal when its channel closes: that exit is
			// not a stop (a crash stays a crash, restarted within its budget or broken with its stderr).
			if (host.principal.id === principal.id && isLiveWorkloadState(host.state) && !host.exiting) {
				this.logger.info(`[volt-sandbox] ${host.label}: its principal was revoked; stopping it`);
				void host.terminate('stopped');
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
	private policyFor(subject: SubjectKey, mode: PolicyAuthorityMode, decision: ILaunchDecision, input: ILaunchCompileInput, files: ISandboxPolicyFileLayers): Pick<ISandboxComposition, 'policy' | 'ignored' | 'contained'> {
		const compiled = decision.allow ? this.cache.compile(decision, input) : undefined;
		if (compiled) {
			this.compiles.push(launchCompileRecord(compiled, input));
			if (this.compiles.length > MAX_KEPT) {
				this.compiles.shift();
			}
		}
		// The policy files apply in both modes: they are the user's and the repository's, not the Authority's.
		const legacy = composeLaunchLayers(agentSandboxPolicy(input.request, input.host), files.layers, files.realpaths);
		if (compiled && launchPolicyBytes(compiled.policy) !== launchPolicyBytes(legacy.policy)) {
			this.recordDiff({ subject, mode, kind: 'policy', decision, ignored: compiled.ignored });
		}
		return mode === 'enforce' && compiled ? compiled : legacy;
	}

	/** A launch's compile input: the policy files' layers first, then the launcher's own narrowing layers (never trusted). */
	private compileInput(subject: SubjectKey, epoch: number, request: IVoltSandboxRequest, host: IAgentSandboxHost, files: ISandboxPolicyFileLayers): ILaunchCompileInput {
		const layers = [...files.layers, ...this.layers.map(layer => ({ ...layer, trusted: false }))];
		return { subject, epoch, request, host, ...layers.length ? { layers } : {}, ...files.realpaths ? { realpaths: files.realpaths } : {} };
	}

	private async readPolicyFiles(request: IVoltSandboxRequest, host: Omit<IAgentSandboxHost, 'sshAuthSock'>): Promise<ISandboxPolicyFileLayers> {
		return this.policyFiles.read(host.home, request.workspaceRoots, await this.adminPolicy());
	}

	/**
	 * What the policy files do to a chat with `request` (its Access menu): the files, what was ignored
	 * from them, and the refusal a broken user file causes. Read and composed as a launch would.
	 */
	async policyFilesInfo(request: IVoltSandboxRequest): Promise<ISandboxPolicyFilesInfo> {
		const host = await this.hostFacts();
		const files = await this.readPolicyFiles(request, host);
		if (files.refusal) {
			return { files: files.files, ignored: files.ignored, refusal: files.refusal };
		}
		const { ignored } = composeLaunchLayers(agentSandboxPolicy(request, { ...host, cacheDir: join(host.cacheDir, sandboxCacheKey(request)) }), files.layers, files.realpaths);
		return { files: files.files, ignored: [...files.ignored, ...ignored] };
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
			this.adminNow = changes.admin;
			this.manager.currentBroker?.adminChanged();
			this._onDidChangeManagedPolicy.fire();
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

	/** The managed policy, read on first use (launches, plugin hosts, the network broker judge by it). */
	managedPolicy(): Promise<IAdminPolicy> {
		return this.adminPolicy();
	}

	/**
	 * Reads the managed policy again; when it changed (an MDM push, `/etc/volt/policy.json` edited),
	 * every consumer gets it through {@link invalidate}: launches, the broker (open tunnels re-judged),
	 * plugin hosts, and over {@link onDidChangeManagedPolicy} the windows' gates. True when it changed.
	 */
	async refreshManagedPolicy(): Promise<boolean> {
		const before = await this.adminPolicy();
		const read = await this.readAdmin().then(({ source: _source, problem: _problem, ...policy }): IAdminPolicy => policy, (): IAdminPolicy => ({ unreadable: true }));
		if (JSON.stringify(sortedAdmin(read)) === JSON.stringify(sortedAdmin(this.adminNow ?? before))) {
			return false;
		}
		this.logger.info(`[volt-sandbox] the managed policy changed${read.unreadable ? ' and can\'t be read: third parties get nothing' : ''}`);
		this.invalidate({ admin: read });
		return true;
	}

	/** Re-reads the managed policy every `intervalMs` (a few stats) while Volt runs; see {@link refreshManagedPolicy}. */
	watchManagedPolicy(intervalMs: number): IDisposable {
		const timer = setInterval(() => void this.refreshManagedPolicy().catch(() => undefined), intervalMs);
		(timer as { unref?(): void }).unref?.();
		return this._register(toDisposable(() => clearInterval(timer)));
	}

	/** The managed policy once read; undefined before. */
	get managedPolicyNow(): IAdminPolicy | undefined {
		return this.adminNow;
	}

	private adminPolicy(): Promise<IAdminPolicy> {
		if (!this.admin) {
			const admin = this.readAdmin().then(({ source: _source, problem, ...policy }): IAdminPolicy => {
				if (problem) {
					this.logger.warn(`[volt-sandbox] managed policy: ${problem}`);
				}
				return policy;
			}, (): IAdminPolicy => ({ unreadable: true }));
			this.admin = admin;
			// Registered first, so the policy is the broker's before any launch that awaited it goes on.
			void admin.then(policy => {
				if (this.admin === admin) {
					this.adminNow = policy;
					this.manager.currentBroker?.adminChanged();
					this._onDidChangeManagedPolicy.fire();
				}
			});
		}
		return this.admin;
	}

	private launch(prepared: IPreparedSandbox, overlay: AgentStateOverlay | undefined, policy: IVoltSandboxPolicy, principal: IPrincipal, notices: readonly string[], where: IDenialContext): ISandboxLaunch {
		const listener = prepared.onDenial(denial => {
			if (denial.kind === 'process' || denial.kind === 'limit') {
				return;
			}
			this.report(prepared.tag, { kind: denial.kind, target: denial.target, source: denial.source === 'proxy' ? 'proxy' : 'os', ...(denial.process ? { process: denial.process } : {}), ...(denial.promptable === false ? { promptable: false } : {}), ...(denial.denialId ? { denialId: denial.denialId } : {}), ...(denial.epoch !== undefined ? { epoch: denial.epoch } : {}) }, where);
		});
		// The policy files' problems and ignored entries first: they explain the rules this run has.
		const warnings = [...notices, ...prepared.unenforced.map(dimension => `Sandbox is partial here: ${UNENFORCED_TEXT[dimension] ?? dimension}.`)];
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

	private report(tag: string, denial: ISandboxDenial, { home, roots }: IDenialContext): void {
		if (isNoiseDenial(denial)) {
			return;
		}
		const quiet = isQuietDenial(denial, home, roots);
		// A quiet read (by the shell) never hides the agent's own read of the same file (by `cat`).
		const key = `${tag}|${denial.kind}|${denial.target}${quiet ? `|quiet|${denial.process ?? ''}` : ''}`;
		const now = Date.now();
		if ((this.recent.get(key) ?? 0) > now - 10_000) {
			return;
		}
		if (quiet) {
			// Still denied, and on record here; no card in the chat (a shell's or a tool's own startup read).
			this.recent.set(key, now);
			this.logger.info(`[volt-sandbox] ${tag} quiet denial: ${denial.kind} ${redactSandboxText(denial.target, home)}${denial.process ? ` (${denial.process})` : ''}`);
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
			// The root of the per-principal caches (see `sandboxCacheKey`); each run gets its own child.
			const cacheRoot = join(facts.home, '.volt', 'sandbox-cache');
			// Independent lookups, made together; the temp folders keep this order.
			const [shared, darwinCache, cacheDir, userDataDir, keys] = await Promise.all([
				Promise.all(['/tmp', '/var/tmp'].map(dir => fs.realpath(dir).catch(() => dir))),
				facts.platform === 'darwin' ? execFileAsync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']).then(r => fs.realpath(r.stdout.trim()), () => undefined) : Promise.resolve(undefined),
				fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 }).then(() => fs.realpath(cacheRoot).catch(() => cacheRoot)),
				fs.realpath(this.userDataDir).catch(() => this.userDataDir),
				sshPrivateKeys(join(facts.home, '.ssh')),
			]);
			const temps = new Set<string>([facts.tmpRoot, ...shared, ...darwinCache ? [darwinCache] : []]);
			return {
				platform: facts.platform,
				home: facts.home,
				tempDirs: [...temps].filter(dir => dir !== '/' && dir !== facts.home),
				uid: process.getuid?.(),
				userDataDir,
				sshPrivateKeys: keys,
				cacheDir,
			};
		})();
		return this.agentHost;
	}

}

/** How the transcript names the file an ignored entry came from. */
function policyFileName(source: ISandboxCompositionNote['source']): string | undefined {
	return source === 'user' ? '~/.volt/sandbox.json' : source === 'workspace' ? '.volt/sandbox.json' : undefined;
}

/**
 * Whose package cache a run uses: the agent provider and the chat's workspace. Chats of one
 * project share one; another project's chat (or another provider) cannot read or poison it.
 * Becomes the principal's subject once principals are minted by the registry (F.1).
 */
export function sandboxCacheKey(request: Pick<IVoltSandboxRequest, 'providerId' | 'workspaceRoots'>): string {
	return createHash('sha256').update([request.providerId, ...request.workspaceRoots].join('\0')).digest('hex').slice(0, 16);
}

/** A managed policy with its lists sorted, so two reads of the same policy compare equal. */
function sortedAdmin(policy: IAdminPolicy): IAdminPolicy {
	return {
		...(policy.unreadable ? { unreadable: true } : {}),
		...(policy.denyCapabilities ? { denyCapabilities: [...policy.denyCapabilities].sort() } : {}),
		...(policy.denyHosts ? { denyHosts: [...policy.denyHosts].sort() } : {}),
		...(policy.maxThirdPartyClass ? { maxThirdPartyClass: policy.maxThirdPartyClass } : {}),
	};
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
