/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, join, sep } from '../../../base/common/path.js';
import { declaredFileRoots, IFilesScope } from '../../voltFiles/common/filesBroker.js';
import { FilesBroker } from '../../voltFiles/node/filesBroker.js';
import { ISafeOpenOptions, SafeOpenError, safeReadFile, safeWriteFile } from '../../voltFiles/node/safeOpen.js';
import { defaultFsdPath } from '../../voltFiles/node/sandboxFileBroker.js';
import { IAccessRequest, IDeclaredCapability, IManifestView, PolicyAuthority } from '../../voltSandbox/common/authority.js';
import { BrokerError, IBrokerAudit, MemoryBrokerAudit } from '../../voltSandbox/common/broker.js';
import { IGrant } from '../../voltSandbox/common/grants.js';
import { extensionSubject, ICallContext, IPrincipal, SubjectKey } from '../../voltSandbox/common/principals.js';
import { builtinProfile } from '../../voltSandbox/common/sandboxProfiles.js';
import { IVoltSandboxPolicy, SandboxDimension } from '../../voltSandbox/common/sandboxSchema.js';
import { ISandboxResourceSample } from '../../voltSandbox/common/sandboxWorkloads.js';
import { INetworkPrincipalView } from '../../voltSandbox/node/networkBroker.js';
import { PrincipalRegistry } from '../../voltSandbox/node/principalRegistry.js';
import { ISandboxLogger } from '../../voltSandbox/node/sandboxManager.js';
import { ISandboxedHost, SandboxSupervisor } from '../../voltSandbox/node/supervisor.js';
import { apiVersionSatisfies, CORE_METHODS, CORE_NOTIFICATIONS, HOST_METHODS, PluginFileRoot, VOLT_PLUGIN_API_VERSION, VOLT_PLUGIN_PROTOCOL, VoltPluginError } from '../common/pluginProtocol.js';
import { PluginRpc } from '../common/pluginRpc.js';

/**
 * Core's side of T2 plugin hosts (spec H.1-H.3, H.6, H.8, H.9): the `MainThreadVolt*`
 * equivalents for tools, storage and context, served on each host's `volt-plugin/1` channel.
 *
 * - One host per plugin (H.6): one subject, one process, never two plugins together. Started by
 *   the supervisor on the first tool call or context request (H.2), from the manifest's tool list,
 *   which is complete before anything starts. Stopped after 5 minutes with no RPC and no live
 *   resource; the host budget (24) is the supervisor's.
 * - Identity is the channel: every request is answered for the principal the registry bound to
 *   that host's channel. Nothing in a payload says who sent it (and the protocol rejects payloads
 *   that try).
 * - Every call is decided by the Policy Authority: `storage.own` for the plugin's storage,
 *   `files.read:*` / `files.write` (through the files broker, `writeMode: 'broker'`) for the
 *   workspace and home, `tools.register` for a tool call, `agents.context` for context. A
 *   built-in gets its manifest within its first-party ceiling, with no prompt (G.10).
 * - Quotas (H.8): 256 MB (killed above it, counts as a crash), 50% of one core over 10 s (the
 *   same), no child processes (macOS; Linux caps the task count), 100 MB of storage, network none
 *   unless the manifest declares hosts (then only the broker, 50 MB a day).
 * - Crashes (H.9, F.11): restarts with backoff, at most 3 a minute, then broken with its stderr
 *   kept; a broken channel is an exit, never core's crash.
 */

export interface IT2PluginTool {
	readonly name: string;
	/** Its own deadline (at most 10 min); default 30 s. */
	readonly deadlineMs?: number;
}

/** A T2 plugin as core recorded it from its manifest: never anything the plugin says about itself. */
export interface IT2PluginDescriptor {
	/** The extension id, lower case (`volt.memory`). */
	readonly id: string;
	readonly firstParty: boolean;
	/** `engines.volt` (H.4). */
	readonly enginesVolt?: string;
	/** The one bundled file (H.5), absolute. */
	readonly bundle: string;
	/** `contributes.voltTools`. */
	readonly tools: readonly IT2PluginTool[];
	/** `contributes.voltCapabilities` (required and optional). */
	readonly declared: readonly IDeclaredCapability[];
	/** Its own storage (`storage.own`). */
	readonly storageDir: string;
	/** For the Security page: "Memory". */
	readonly label?: string;
}

/** Core's record of the folders a call is about (never the plugin's say). */
export interface IT2CallFolders {
	/** The open workspace's first folder. */
	readonly workspace?: string;
	/** The chat's own folder for this call (its worktree, else its project). */
	readonly project?: string;
}

export type T2PluginState = 'stopped' | 'starting' | 'running' | 'idle' | 'restarting' | 'broken' | 'refused';

export interface IT2PluginStatus {
	readonly id: string;
	readonly label: string;
	readonly state: T2PluginState;
	readonly restarts: number;
	/** Why it is broken or refused. */
	readonly detail?: string;
	/** The last lines of its stderr (H.9). */
	readonly stderr?: string;
	readonly principalId?: string;
	readonly pid?: number;
	/** The last cold start: `start` to the plugin activated. */
	readonly coldStartMs?: number;
	/** Of which: spawn to the handshake. */
	readonly handshakeMs?: number;
}

export interface IT2ToolResult {
	readonly text?: string;
	readonly error?: string;
}

export interface IVoltPluginHostServiceOptions {
	readonly supervisor: SandboxSupervisor;
	readonly registry: PrincipalRegistry;
	readonly home: string;
	readonly platform?: string;
	readonly logger?: ISandboxLogger;
	/** The folders a call names when its caller gives none. */
	readonly defaultFolders?: () => IT2CallFolders;
	/** Test builds only: another host entry (the SES-escape fixture). */
	readonly hostEntry?: string;
	/** Default: idle after 60 s, stopped after 5 min (H.2). */
	readonly idle?: { readonly afterMs: number; readonly stopAfterMs: number };
	/** How long starting and activating may take. Default 20 s. */
	readonly activationTimeoutMs?: number;
	/** H.8 defaults. */
	readonly storageQuotaBytes?: number;
	readonly memoryMB?: number;
	readonly cpu?: { readonly share: number; readonly windowMs: number };
	readonly maxRestartsPerMinute?: number;
	readonly audit?: IBrokerAudit;
	/** Grants core holds for plugins (the grant store); a built-in needs none (its ceiling, G.10). */
	readonly grants?: () => readonly IGrant[];
	readonly safeOpen?: ISafeOpenOptions;
	readonly now?: () => number;
}

export const T2_LIMITS = Object.freeze({
	memoryMB: 256,
	cpuShare: 0.5,
	cpuWindowMs: 10_000,
	storageBytes: 100 * 1024 * 1024,
	idleAfterMs: 60_000,
	idleStopMs: 5 * 60_000,
	/** Context a plugin adds to an agent's prompt (H.11 #13: capped). */
	contextChars: 16 * 1024,
	/** How often a host holding live resources is kept from going idle. */
	liveTouchMs: 30_000,
});

/** Where the `ses` package is: the app's `node_modules` (a checkout's too), or inside `node_modules.asar` in a packaged build. */
export function sesLocation(): string | undefined {
	const app = dirname(FileAccess.asFileUri('').fsPath.replace(/[\\/]+$/, ''));
	return [join(app, 'node_modules', 'ses'), join(app, 'node_modules.asar', 'ses')].find(dir => existsSync(join(dir, 'dist', 'ses.cjs')));
}

/** Volt's own code the host process must read: `out/` (the host and the protocol), `ses`, and the app's `package.json` (ESM). */
export function t2HostReads(): string[] {
	const out = FileAccess.asFileUri('').fsPath.replace(/[\\/]+$/, '');
	const ses = sesLocation();
	// Inside an asar archive the archive file is what the OS reads.
	return [...new Set([out, ...(ses ? [ses.includes('.asar') ? dirname(ses) : ses] : []), join(dirname(out), 'package.json')])];
}

/** `out/vs/platform/voltPlugins/node/pluginHostMain.js`. */
export function t2HostEntry(): string {
	return FileAccess.asFileUri('vs/platform/voltPlugins/node/pluginHostMain.js').fsPath;
}

/**
 * The T2 host's OS policy (H.1, H.8): system folders and Volt's own code read-only, a private
 * temp folder, nothing of the user's, network none (or only the broker, for the hosts the
 * manifest declares), no child processes, 256 MB.
 */
export function t2HostPolicy(reads: readonly string[], networkHosts: readonly string[], platform: string = process.platform, memoryMB: number = T2_LIMITS.memoryMB): IVoltSandboxPolicy {
	const base = builtinProfile('restricted');
	const bestEffort: SandboxDimension[] = [...new Set<SandboxDimension>([...base.bestEffort, 'limits.memory'])];
	return {
		...base,
		filesystem: { ...base.filesystem, read: ['${system}', ...reads] },
		network: networkHosts.length ? { mode: 'proxy', allow: [...networkHosts], loopbackPorts: [], listen: false } : base.network,
		// Linux counts threads in pids.max (TasksMax): Node needs its own. macOS counts processes: spawn none.
		process: { limits: { memoryMB, processes: platform === 'linux' ? 32 : 1, fileSizeMB: 64, openFiles: 256 } },
		bestEffort,
		name: 't2-plugin',
	};
}

function hostsDeclared(declared: readonly IDeclaredCapability[]): string[] {
	return declared.filter(entry => entry.id.replace(/@\d+$/, '') === 'net.connect').flatMap(entry => entry.targets ?? []);
}

function fileTargets(declared: readonly IDeclaredCapability[]): string[] {
	return declared.filter(entry => /^files\./.test(entry.id)).flatMap(entry => entry.targets ?? []);
}

/** A broker refusal as the protocol's typed error. */
function pluginError(err: unknown, capability: string): VoltPluginError {
	if (err instanceof VoltPluginError) {
		return err;
	}
	if (err instanceof BrokerError) {
		switch (err.code) {
			case 'denied': return new VoltPluginError('VoltCapabilityError', err.message, { capability, deniedBy: err.decision?.deniedBy ?? 'floor' });
			case 'unauthenticated': return new VoltPluginError('VoltCapabilityError', err.message, { capability, deniedBy: 'caller' });
			case 'invalid':
			case 'handle': return new VoltPluginError('InvalidArgument', err.message);
			case 'limit': return new VoltPluginError('RateLimited', err.message);
			case 'io': return new VoltPluginError(/does not exist|not found|ENOENT/i.test(err.message) ? 'NotFound' : 'Internal', err.message);
		}
	}
	if (err instanceof SafeOpenError) {
		return new VoltPluginError(err.refusal === 'missing' ? 'NotFound' : err.refusal === 'io' ? 'Internal' : 'VoltCapabilityError', err.message, err.refusal === 'missing' || err.refusal === 'io' ? undefined : { capability, deniedBy: 'floor' });
	}
	return VoltPluginError.from(err);
}

export class VoltPluginHostService extends Disposable {

	private readonly plugins = new Map<string, T2Plugin>();
	private readonly authority: PolicyAuthority;
	private epoch = 1;
	readonly files: FilesBroker;
	private readonly _onDidChange = this._register(new Emitter<string>());
	/** A plugin's state changed (its id). */
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(readonly options: IVoltPluginHostServiceOptions) {
		super();
		this.authority = this._register(new PolicyAuthority(this.snapshotInput()));
		this.files = this._register(new FilesBroker({
			authority: this.authority,
			callers: options.registry,
			audit: options.audit ?? new MemoryBrokerAudit(),
			scope: principal => this.filesScope(principal),
			safeOpen: options.safeOpen ?? { fsdPath: defaultFsdPath() },
			...(options.now ? { now: options.now } : {}),
		}));
		this._register(toDisposable(() => {
			for (const plugin of this.plugins.values()) {
				plugin.dispose();
			}
			this.plugins.clear();
		}));
	}

	get logger(): ISandboxLogger {
		return this.options.logger ?? { info: () => undefined, warn: () => undefined };
	}

	/** Records a plugin from its manifest. Its tools are known now; its host starts on first use. */
	register(descriptor: IT2PluginDescriptor): IDisposable {
		const id = descriptor.id.toLowerCase();
		if (this.plugins.has(id)) {
			throw new Error(`plugin ${id} is registered already`);
		}
		const plugin = new T2Plugin({ ...descriptor, id }, this, () => this._onDidChange.fire(id));
		this.plugins.set(id, plugin);
		this.refreshAuthority([plugin.subject]);
		return toDisposable(() => {
			if (this.plugins.get(id) === plugin) {
				this.plugins.delete(id);
				plugin.dispose();
				this.refreshAuthority([plugin.subject]);
			}
		});
	}

	/** Every registered plugin's state (H.9: the Security page, the status bar's count of broken plugins). */
	status(): IT2PluginStatus[] {
		return [...this.plugins.values()].map(plugin => plugin.status());
	}

	/** Whether the plugin declares a context provider's capability (it is asked only then). */
	providesContext(id: string): boolean {
		return !!this.plugins.get(id.toLowerCase())?.descriptor.declared.some(entry => entry.id.replace(/@\d+$/, '') === 'agents.context');
	}

	async invokeTool(id: string, name: string, args: Record<string, unknown>, folders: IT2CallFolders = {}, signal?: AbortSignal): Promise<IT2ToolResult> {
		const plugin = this.plugins.get(id.toLowerCase());
		if (!plugin) {
			return { error: `No plugin ${id} is installed.` };
		}
		return plugin.invokeTool(name, args, folders, signal);
	}

	async provideContext(id: string, folders: IT2CallFolders = {}): Promise<string | undefined> {
		return this.plugins.get(id.toLowerCase())?.provideContext(folders);
	}

	/** Starts the plugin's host now (warm-up); resolves when it is activated, or with why not. */
	async activate(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
		const plugin = this.plugins.get(id.toLowerCase());
		if (!plugin) {
			return { ok: false, reason: `no plugin ${id}` };
		}
		try {
			await plugin.ensure();
			return { ok: true };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	/** "Restart" on a stopped or broken plugin (H.9): its next use starts it fresh. */
	async restart(id: string): Promise<void> {
		await this.plugins.get(id.toLowerCase())?.reset();
	}

	async stop(id: string): Promise<void> {
		await this.plugins.get(id.toLowerCase())?.stop();
	}

	/** The broker's view of a plugin principal (its manifest), for the network broker's providers. */
	networkView(principal: IPrincipal): INetworkPrincipalView | undefined {
		const plugin = [...this.plugins.values()].find(candidate => candidate.subject === principal.subject);
		return plugin ? { manifest: plugin.manifest() } : undefined;
	}

	// --- for T2Plugin ------------------------------------------------------------------------------

	evaluate(request: IAccessRequest, context: ICallContext): void {
		const decision = this.authority.evaluate({ surface: 'broker', ...request }, context);
		if (!decision.allow) {
			throw new VoltPluginError('VoltCapabilityError', decision.reason, { capability: request.capability, ...(request.target ? { target: request.target } : {}), deniedBy: decision.deniedBy ?? 'authority' });
		}
	}

	now(): number {
		return (this.options.now ?? Date.now)();
	}

	private snapshotInput() {
		return {
			epoch: this.epoch,
			asOf: this.now(),
			manifests: [...this.plugins.values()].map(plugin => plugin.manifest()),
			grants: [...this.options.grants?.() ?? []],
			home: this.options.home,
		};
	}

	private refreshAuthority(subjects: readonly SubjectKey[]): void {
		this.epoch++;
		this.authority.update(this.snapshotInput(), { subjects, narrowed: true });
	}

	private filesScope(principal: IPrincipal): IFilesScope | undefined {
		const plugin = [...this.plugins.values()].find(candidate => candidate.subject === principal.subject);
		if (!plugin) {
			return undefined;
		}
		return {
			roots: plugin.liveFolders(),
			declaredRoots: declaredFileRoots(fileTargets(plugin.descriptor.declared), this.options.home),
			home: this.options.home,
			platform: this.options.platform ?? process.platform,
		};
	}
}

interface IReady {
	readonly host: ISandboxedHost;
	readonly rpc: PluginRpc;
	readonly tools: ReadonlySet<string>;
	readonly context: boolean;
	readonly channelId: string;
}

/** One plugin: its host (at most one process), its channel, its calls, its quotas. */
class T2Plugin {

	readonly subject: SubjectKey;
	private host: ISandboxedHost | undefined;
	private ready: Promise<IReady> | undefined;
	private readonly hostListeners: IDisposable[] = [];
	private readonly calls = new Map<string, IT2CallFolders>();
	private state: T2PluginState = 'stopped';
	private detail: string | undefined;
	private restarts = 0;
	private coldStartMs: number | undefined;
	private handshakeMs: number | undefined;
	private liveTimer: ReturnType<typeof setInterval> | undefined;
	private cpuSamples: { at: number; cpuMs: number }[] = [];
	private storageUsage: number | undefined;
	private requestCount = 0;
	private disposed = false;

	constructor(
		readonly descriptor: IT2PluginDescriptor,
		private readonly service: VoltPluginHostService,
		private readonly changed: () => void,
	) {
		this.subject = extensionSubject(descriptor.id, descriptor.firstParty);
	}

	manifest(): IManifestView {
		const declared = [...this.descriptor.declared];
		return { subject: this.subject, declared, network: hostsDeclared(declared).length ? 'broker' : 'none' };
	}

	status(): IT2PluginStatus {
		const stderr = this.host?.stderrTail().trim().split('\n').slice(-20).join('\n');
		return {
			id: this.descriptor.id,
			label: this.descriptor.label ?? this.descriptor.id,
			state: this.state,
			restarts: this.restarts,
			...(this.detail ? { detail: this.detail } : {}),
			...(stderr ? { stderr } : {}),
			...(this.host ? { principalId: this.host.principal.id } : {}),
			...(this.host?.pid ? { pid: this.host.pid } : {}),
			...(this.coldStartMs !== undefined ? { coldStartMs: this.coldStartMs } : {}),
			...(this.handshakeMs !== undefined ? { handshakeMs: this.handshakeMs } : {}),
		};
	}

	/** Folders the files broker lets this plugin reach now: the default ones and those of calls in flight. */
	liveFolders(): string[] {
		const all = [this.service.options.defaultFolders?.() ?? {}, ...this.calls.values()];
		return [...new Set(all.flatMap(folders => [folders.workspace, folders.project]).filter((path): path is string => !!path))];
	}

	private setState(state: T2PluginState, detail?: string): void {
		this.state = state;
		this.detail = detail;
		this.changed();
	}

	// --- lifecycle -------------------------------------------------------------------------------

	/** The running, activated host: started now if it is not (H.2 lazy activation). */
	ensure(): Promise<IReady> {
		if (this.disposed) {
			return Promise.reject(new VoltPluginError('Cancelled', `${this.descriptor.id} is uninstalled`));
		}
		if (this.state === 'broken') {
			return Promise.reject(new VoltPluginError('Internal', `${this.label} stopped after repeated crashes${this.detail ? ` (${this.detail})` : ''}. Restart it from its page or the status bar.`));
		}
		this.ready ??= this.start();
		return this.ready;
	}

	private get label(): string {
		return this.descriptor.label ?? this.descriptor.id;
	}

	private async start(): Promise<IReady> {
		const options = this.service.options;
		const started = this.service.now();
		this.setState('starting');
		try {
			if (this.descriptor.enginesVolt && !apiVersionSatisfies(VOLT_PLUGIN_API_VERSION, this.descriptor.enginesVolt)) {
				throw new VoltPluginError('InvalidArgument', `${this.descriptor.id} needs volt ${this.descriptor.enginesVolt}; this Volt serves ${VOLT_PLUGIN_API_VERSION}`);
			}
			const source = await fs.readFile(this.descriptor.bundle, 'utf8');
			const digest = createHash('sha256').update(source).digest('hex');
			const principal = options.registry.mint({ subject: this.subject, kind: 't2', launchPolicyHash: '', packageDigest: digest, signer: this.descriptor.firstParty ? 'volt' : 'local' });
			const result = await options.supervisor.start({
				principal,
				label: `${this.label} plugin host`,
				command: { fork: options.hostEntry ?? t2HostEntry(), args: [`--ses=${sesLocation() ?? ''}`] },
				policy: t2HostPolicy(t2HostReads(), hostsDeclared(this.descriptor.declared), options.platform, options.memoryMB),
				context: { workspaceRoots: [], hostEnv: {} },
				stream: true,
				ipc: false,
				restart: { maxPerMinute: options.maxRestartsPerMinute ?? 3 },
				idle: options.idle ?? { afterMs: T2_LIMITS.idleAfterMs, stopAfterMs: T2_LIMITS.idleStopMs },
				limits: { memoryMB: options.memoryMB ?? T2_LIMITS.memoryMB },
				networkView: { manifest: this.manifest() },
			});
			if (!result.ok) {
				options.registry.retire(principal.id);
				// A refusal never runs it some other way (F.13: a failed launch is never degraded mode).
				throw new VoltPluginError('Internal', `${this.label} could not start in its sandbox (${result.refused}): ${result.reason}`);
			}
			const host = result.host;
			this.host = host;
			this.watch(host);
			const ready = await this.attach(host, source, digest, started);
			this.coldStartMs = this.service.now() - started;
			return ready;
		} catch (err) {
			this.ready = undefined;
			const error = VoltPluginError.from(err);
			if (!this.host) {
				this.setState('refused', error.message);
			}
			throw error;
		}
	}

	private watch(host: ISandboxedHost): void {
		this.hostListeners.push(
			host.onExit(exit => {
				this.ready = undefined;
				this.setLive(0);
				if (exit.restarting) {
					this.restarts++;
					this.setState('restarting', `${exit.reason} (${exit.signal ?? exit.code})`);
				}
			}),
			host.onDidChangeState(state => {
				if (state === 'running' && this.state === 'restarting' && !this.ready) {
					// A restart is a new principal on a new channel: handshake and activate again.
					this.ready = (async () => {
						const source = await fs.readFile(this.descriptor.bundle, 'utf8');
						return this.attach(host, source, createHash('sha256').update(source).digest('hex'), this.service.now());
					})();
					this.ready.catch(err => this.service.logger.warn(`[volt-plugin] ${this.descriptor.id} did not come back after a restart: ${err}`));
				} else if (state === 'idle' && this.state === 'running') {
					this.setState('idle');
				} else if (state === 'running' && this.state === 'idle') {
					this.setState('running');
				} else if (state === 'broken') {
					this.ready = undefined;
					this.setState('broken', this.lastDetail(host));
				} else if (state === 'stopped' || state === 'failed') {
					this.release();
					this.setState('stopped');
				}
			}),
			host.onResource(sample => this.checkCpu(host, sample)),
		);
	}

	private lastDetail(host: ISandboxedHost): string | undefined {
		const last = host.stderrTail().trim().split('\n').pop();
		return last ? `last error: ${last.slice(0, 300)}` : undefined;
	}

	/** Handshake and activation on the host's current channel. */
	private async attach(host: ISandboxedHost, source: string, digest: string, started: number): Promise<IReady> {
		const channel = host.channel;
		const channelId = host.channelId;
		if (!channel || !channelId) {
			throw new VoltPluginError('Internal', `${this.label}'s host has no channel`);
		}
		let hello: (() => void) | undefined;
		const helloSeen = new Promise<void>(resolve => hello = resolve);
		let greeted = false;
		const rpc: PluginRpc = new PluginRpc({
			write: bytes => { channel.write(bytes); },
			remote: HOST_METHODS,
			handlers: {
				methods: CORE_METHODS,
				notifications: CORE_NOTIFICATIONS,
				handleRequest: async (method, params, signal) => {
					const context = this.service.options.registry.contextFor(channelId, `t2:${this.descriptor.id}:${++this.requestCount}`);
					if (!context) {
						// The channel's principal is revoked: nothing it sends is anyone's.
						throw new VoltPluginError('VoltCapabilityError', 'this host\'s principal is no longer live', { capability: method, deniedBy: 'caller' });
					}
					if (method === '$/hello') {
						const p = params as { protocol: string; apiVersions: string[] };
						if (p.protocol !== VOLT_PLUGIN_PROTOCOL || !p.apiVersions.some(range => apiVersionSatisfies(VOLT_PLUGIN_API_VERSION, range))) {
							throw new VoltPluginError('InvalidArgument', `core speaks ${VOLT_PLUGIN_PROTOCOL} with API ${VOLT_PLUGIN_API_VERSION}`);
						}
						greeted = true;
						hello?.();
						return { protocol: VOLT_PLUGIN_PROTOCOL, apiVersion: VOLT_PLUGIN_API_VERSION };
					}
					if (!greeted) {
						throw new VoltPluginError('InvalidArgument', 'the handshake comes first');
					}
					return this.serve(context, method, params, signal);
				},
				handleNotification: (method, params) => {
					if (method === 'host/live') {
						this.setLive((params as { count: number }).count);
					} else if (method === 'log') {
						const { level, message } = params as { level: string; message: string };
						(level === 'info' ? this.service.logger.info : this.service.logger.warn)(`[volt-plugin] ${this.descriptor.id}: ${message}`);
					}
				},
			},
			onActivity: () => host.touch(),
			onFatal: error => {
				this.service.logger.warn(`[volt-plugin] ${this.descriptor.id}: its channel broke (${error.message}); stopping the host`);
				void host.terminate('crash');
			},
		});
		const onData = (chunk: Buffer) => rpc.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		channel.on('data', onData);
		const closed = () => rpc.close();
		channel.once('close', closed);
		const timeout = this.service.options.activationTimeoutMs ?? 20_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([helloSeen, new Promise<never>((_, reject) => timer = setTimeout(() => reject(new VoltPluginError('DeadlineExceeded', `${this.label}'s host did not say hello within ${timeout} ms`)), timeout))]);
			this.handshakeMs = this.service.now() - started;
			const answer = await rpc.request('host/activate', { source, digest, id: this.descriptor.id, tools: this.descriptor.tools.map(tool => tool.name) }, { deadlineMs: timeout }) as { tools: string[]; context: boolean };
			this.setState('running');
			return { host, rpc, tools: new Set(answer.tools), context: answer.context, channelId };
		} catch (err) {
			channel.off('data', onData);
			rpc.close();
			// A host that does not finish starting is stopped (and counts as a crash for its budget).
			void host.terminate('crash');
			throw VoltPluginError.from(err);
		} finally {
			clearTimeout(timer);
		}
	}

	private setLive(count: number): void {
		if (count > 0 && !this.liveTimer) {
			// A live resource (a long timer, an interval) keeps the host from idling out (H.2).
			this.liveTimer = setInterval(() => this.host?.touch(), T2_LIMITS.liveTouchMs);
			(this.liveTimer as { unref?(): void }).unref?.();
		} else if (count === 0 && this.liveTimer) {
			clearInterval(this.liveTimer);
			this.liveTimer = undefined;
		}
	}

	/** H.8: over half a core averaged over 10 s is killed as `resource`, which counts as a crash. */
	private checkCpu(host: ISandboxedHost, sample: ISandboxResourceSample): void {
		const cpu = this.service.options.cpu ?? { share: T2_LIMITS.cpuShare, windowMs: T2_LIMITS.cpuWindowMs };
		this.cpuSamples.push({ at: sample.at, cpuMs: sample.cpuMs });
		while (this.cpuSamples.length > 2 && sample.at - this.cpuSamples[1].at >= cpu.windowMs) {
			this.cpuSamples.shift();
		}
		const first = this.cpuSamples[0];
		const span = sample.at - first.at;
		if (span >= cpu.windowMs && (sample.cpuMs - first.cpuMs) / span > cpu.share) {
			this.service.logger.warn(`[volt-plugin] ${this.descriptor.id} used ${Math.round((sample.cpuMs - first.cpuMs) / span * 100)}% of a core over ${Math.round(span / 1000)} s, over its ${Math.round(cpu.share * 100)}%: stopped`);
			this.cpuSamples = [];
			void host.terminate('resource');
		}
	}

	private release(): void {
		for (const listener of this.hostListeners.splice(0)) {
			listener.dispose();
		}
		this.setLive(0);
		this.host = undefined;
		this.ready = undefined;
		this.cpuSamples = [];
	}

	async reset(): Promise<void> {
		const host = this.host;
		this.release();
		if (host) {
			await host.terminate('stopped');
			// A broken host leaves the supervisor's list only once it is dismissed.
			await host.terminate('stopped');
		}
		this.setState('stopped');
	}

	async stop(): Promise<void> {
		const host = this.host;
		if (host) {
			await host.terminate('stopped');
		}
		this.release();
		this.setState('stopped');
	}

	dispose(): void {
		this.disposed = true;
		const host = this.host;
		this.release();
		void host?.terminate('stopped');
	}

	// --- calls into the plugin -------------------------------------------------------------------

	async invokeTool(name: string, args: Record<string, unknown>, folders: IT2CallFolders, signal?: AbortSignal): Promise<IT2ToolResult> {
		const tool = this.descriptor.tools.find(candidate => candidate.name === name);
		if (!tool) {
			return { error: `${this.label} has no tool ${name}.` };
		}
		const call = randomBytes(12).toString('base64url');
		try {
			const ready = await this.ensure();
			if (!ready.tools.has(name)) {
				return { error: `${this.label} did not register ${name}.` };
			}
			const context = this.service.options.registry.contextFor(ready.channelId, `t2-call:${call}`);
			if (!context) {
				return { error: `${this.label}'s host is not running.` };
			}
			this.service.evaluate({ capability: 'tools.register', target: name, edge: 'tool' }, context);
			this.calls.set(call, await realFolders({ ...this.service.options.defaultFolders?.(), ...folders }));
			const result = await ready.rpc.request('tool/invoke', { name, args, call }, { ...(tool.deadlineMs ? { deadlineMs: tool.deadlineMs } : {}), ...(signal ? { signal } : {}) }) as IT2ToolResult;
			return result.error !== undefined ? { error: result.error } : { text: result.text ?? '' };
		} catch (err) {
			const error = VoltPluginError.from(err);
			return { error: error.type === 'Cancelled' && this.state === 'restarting' ? `${this.label} stopped while it worked on this (it is restarting). Try again.` : error.message };
		} finally {
			this.calls.delete(call);
		}
	}

	async provideContext(folders: IT2CallFolders): Promise<string | undefined> {
		const call = randomBytes(12).toString('base64url');
		try {
			const ready = await this.ensure();
			if (!ready.context) {
				return undefined;
			}
			const context = this.service.options.registry.contextFor(ready.channelId, `t2-context:${call}`);
			if (!context) {
				return undefined;
			}
			this.service.evaluate({ capability: 'agents.context', edge: 'context' }, context);
			this.calls.set(call, await realFolders({ ...this.service.options.defaultFolders?.(), ...folders }));
			const answer = await ready.rpc.request('context/provide', { call }) as { text?: string };
			const text = answer.text?.trim();
			// Capped (H.11 #13); the plugin labels its own block, and core never lets it run past the cap.
			return text ? text.slice(0, T2_LIMITS.contextChars) : undefined;
		} catch (err) {
			this.service.logger.warn(`[volt-plugin] ${this.descriptor.id}: no context (${err instanceof Error ? err.message : String(err)})`);
			return undefined;
		} finally {
			this.calls.delete(call);
		}
	}

	// --- what the plugin asks of core -------------------------------------------------------------

	private async serve(context: ICallContext, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
		void signal;
		const p = params as { path?: string; dir?: string; text?: string; root?: PluginFileRoot; call?: string };
		if (method.startsWith('storage/')) {
			this.service.evaluate({ capability: 'storage.own', target: p.path ?? p.dir ?? '' }, context);
			return this.storage(method, p);
		}
		if (method.startsWith('files/')) {
			return this.filesCall(context, method, p);
		}
		throw new VoltPluginError('NotFound', `no method ${method}`);
	}

	private async storageRoot(): Promise<string> {
		await fs.mkdir(this.descriptor.storageDir, { recursive: true, mode: 0o700 });
		return fs.realpath(this.descriptor.storageDir);
	}

	private async storage(method: string, p: { path?: string; dir?: string; text?: string }): Promise<unknown> {
		const root = await this.storageRoot();
		const at = (relative: string) => relative ? join(root, ...relative.split('/')) : root;
		const request = (path: string) => ({ root, path, refuseHardLinks: true, floor: (final: string) => final === root || final.startsWith(root + sep) ? undefined : `${final} is outside this plugin's storage` });
		const safeOpen = this.service.options.safeOpen ?? { fsdPath: defaultFsdPath() };
		switch (method) {
			case 'storage/read': {
				try {
					return { text: (await safeReadFile(request(at(p.path!)), safeOpen)).content.toString('utf8') };
				} catch (err) {
					throw pluginError(err, 'storage.own');
				}
			}
			case 'storage/write': {
				const bytes = Buffer.byteLength(p.text!, 'utf8');
				const path = at(p.path!);
				const before = await fs.lstat(path).then(stat => stat.size, () => 0);
				const used = await this.storageBytes(root);
				const quota = this.service.options.storageQuotaBytes ?? T2_LIMITS.storageBytes;
				if (used - before + bytes > quota) {
					throw new VoltPluginError('VoltCapabilityError', `${this.label}'s storage is full (${Math.round(quota / 1024 / 1024)} MB)`, { capability: 'storage.own', target: p.path!, deniedBy: 'quota' });
				}
				await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
				try {
					await safeWriteFile(request(path), new TextEncoder().encode(p.text!), safeOpen);
				} catch (err) {
					throw pluginError(err, 'storage.own');
				}
				this.storageUsage = used - before + bytes;
				return {};
			}
			case 'storage/list': {
				const dir = at(p.dir ?? '');
				if (await fs.realpath(dir).catch(() => undefined) !== dir) {
					return { entries: [] };
				}
				const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
				return { entries: entries.filter(entry => entry.isFile() || entry.isDirectory()).slice(0, 1000).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })) };
			}
			case 'storage/delete': {
				const path = at(p.path!);
				const stat = await fs.lstat(path).catch(() => undefined);
				if (!stat?.isFile() || await fs.realpath(dirname(path)).catch(() => undefined) !== dirname(path)) {
					return { deleted: false };
				}
				await fs.unlink(path);
				this.storageUsage = undefined;
				return { deleted: true };
			}
		}
		throw new VoltPluginError('NotFound', `no method ${method}`);
	}

	/** Bytes in the plugin's storage, counted once and kept up to date by its writes. */
	private async storageBytes(root: string): Promise<number> {
		if (this.storageUsage === undefined) {
			let total = 0;
			const walk = async (dir: string, depth: number): Promise<void> => {
				for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
					const path = join(dir, entry.name);
					if (entry.isFile()) {
						total += (await fs.lstat(path).catch(() => undefined))?.size ?? 0;
					} else if (entry.isDirectory() && depth < 8) {
						await walk(path, depth + 1);
					}
				}
			};
			await walk(root, 0);
			this.storageUsage = total;
		}
		return this.storageUsage;
	}

	private async filesCall(context: ICallContext, method: string, p: { path?: string; text?: string; root?: PluginFileRoot; call?: string }): Promise<unknown> {
		const folders = (p.call ? this.calls.get(p.call) : undefined) ?? await realFolders(this.service.options.defaultFolders?.() ?? {});
		const base = p.root === 'home' ? this.service.options.home : p.root === 'project' ? folders.project ?? folders.workspace : folders.workspace;
		if (!base) {
			throw new VoltPluginError('NotFound', p.root === 'home' ? 'no home folder' : 'no folder is open for this call');
		}
		const path = p.path ? join(base, ...p.path.split('/')) : base;
		const files = this.service.files;
		const write = method === 'files/write' || method === 'files/delete';
		const capability = write ? 'files.write' : 'files.read';
		try {
			switch (method) {
				case 'files/read': {
					if (!await fs.lstat(path).then(() => true, () => false)) {
						throw new VoltPluginError('NotFound', `${p.path} does not exist`);
					}
					const { handle } = await files.open(context, { path, mode: 'read' });
					try {
						const parts: Uint8Array[] = [];
						let offset = 0;
						for (; ;) {
							const { data, eof } = await files.read(context, { handle, offset });
							parts.push(data);
							offset += data.byteLength;
							if (eof || !data.byteLength || offset > 4 * 1024 * 1024) {
								break;
							}
						}
						return { text: Buffer.concat(parts).toString('utf8') };
					} finally {
						await files.close(context, { handle }).catch(() => undefined);
					}
				}
				case 'files/write': {
					const { handle } = await files.open(context, { path, mode: 'write' });
					try {
						const { created } = await files.write(context, { handle, data: p.text ?? '' });
						return { created, path };
					} finally {
						await files.close(context, { handle }).catch(() => undefined);
					}
				}
				case 'files/list': {
					if (!await fs.lstat(path).then(stat => stat.isDirectory(), () => false)) {
						return { entries: [] };
					}
					return await files.list(context, { path });
				}
				case 'files/delete':
					return await files.delete(context, { path });
			}
		} catch (err) {
			throw pluginError(err, capability);
		}
		throw new VoltPluginError('NotFound', `no method ${method}`);
	}
}

/** The folders as real paths (the broker judges real paths); a folder that does not exist is left out. */
async function realFolders(folders: IT2CallFolders): Promise<IT2CallFolders> {
	const real = async (path: string | undefined) => path ? fs.realpath(path).catch(() => undefined) : undefined;
	const [workspace, project] = await Promise.all([real(folders.workspace), real(folders.project)]);
	return { ...(workspace ? { workspace } : {}), ...(project ? { project } : {}) };
}
