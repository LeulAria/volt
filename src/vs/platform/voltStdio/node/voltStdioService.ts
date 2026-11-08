/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { Emitter, Event } from '../../../base/common/event.js';
import { basename, delimiter, dirname, join } from '../../../base/common/path.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { childEnvFromHost } from '../../voltHelpers/common/childEnv.js';
import { buildEntryPurposeOf, IBuildEntryChange, IHostGitRequest, IHostGitResult } from '../../voltGit/common/hostGit.js';
import { BuildEntryGuard, buildEntryGuard } from '../../voltGit/node/buildEntryGuard.js';
import { runHostGit } from '../../voltGit/node/hostGit.js';
import type { IVoltSandboxRequest } from '../../voltSandbox/common/sandboxPolicy.js';
import { POLICY_AUTHORITY_MODE_SETTING, readPolicyAuthorityMode } from '../../voltSandbox/common/authority.js';
import { brokerReadFile, brokerWriteFile, defaultFsdPath } from '../../voltFiles/node/sandboxFileBroker.js';
import { SafeOpenError } from '../../voltFiles/node/safeOpen.js';
import { resolvedPolicyAllows } from '../../voltSandbox/common/sandboxResolved.js';
import { ISandboxLaunch, VoltSandboxLauncher } from '../../voltSandbox/node/sandboxLauncher.js';
import { ISandboxWorkloadInfo, SANDBOX_SUPERVISOR_SETTING } from '../../voltSandbox/common/sandboxWorkloads.js';
import { NETWORK_BROKER_SETTING, readNetworkBrokerMode } from '../../voltSandbox/common/networkBrokerSetting.js';
import { ChildLedger } from './childLedger.js';
import { SandboxedPtySession } from '../../voltSandbox/node/sandboxPty.js';
import { ISandboxedHost } from '../../voltSandbox/node/supervisor.js';
import { describeExecContext, execRefusal, IVoltExecContext, IVoltExecFileRequest, IVoltExecFileResult, IVoltExecRefusal, IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltSandboxedMcpRequest, IVoltSandboxedTerminalLaunch, IVoltSandboxedTerminalRequest, IVoltSandboxEvent, IVoltSandboxFileResult, IVoltSandboxStateSync, IVoltSandboxSupportInfo, IVoltStdioService, IVoltStdioSpawnOptions, VoltExecRefusedError } from '../common/voltStdio.js';

const execFileAsync = promisify(execFile);

/** Output kept in memory per command. Beyond this the middle is dropped (head is always kept). */
const MAX_BUFFER_CHARS = 4_000_000;
const HEAD_CHARS = 16_000;
const DEFAULT_INLINE_CHARS = 30_000;
const DEFAULT_BACKGROUND_WAIT_MS = 3_000;
const KILL_GRACE_MS = 2_000;
/**
 * After the shell exits, how long its pipes may stay open before the command counts as done.
 * A command that backgrounds a child (`server &`, `nohup ...`) leaves the child holding them,
 * and 'close' would otherwise wait for that child to exit.
 */
const EXIT_DRAIN_MS = 250;
const MAX_WAIT_MS = 10 * 60_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

/**
 * Agent processes, shell commands and background jobs, run with the user's resolved shell
 * environment. The main process serves it to windows (see `VoltStdioMainService`, which stops a
 * window's agents with the window); the Volt agent server owns it outright.
 */
export class VoltStdioService extends Disposable implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
	private readonly stderr = new Map<string, string>();
	private readonly _onData = this._register(new Emitter<{ id: string; data: string }>());
	private readonly _onExit = this._register(new Emitter<{ id: string; code: number | null; stderr?: string }>());
	readonly onData: Event<{ id: string; data: string }> = this._onData.event;
	readonly onExit: Event<{ id: string; code: number | null; stderr?: string }> = this._onExit.event;
	private readonly _onSandboxEvent = this._register(new Emitter<IVoltSandboxEvent>());
	readonly onSandboxEvent: Event<IVoltSandboxEvent> = this._onSandboxEvent.event;

	private readonly sandbox: VoltSandboxLauncher;
	/** The sandbox of each sandboxed spawn, and the spawn of each sandbox tag. */
	private readonly sandboxes = new Map<string, ISandboxLaunch>();
	private readonly sandboxTags = new Map<string, string>();

	/** Sandboxed MCP servers (supervisor hosts) by spawn id: written, read and killed like spawns. */
	private readonly hosts = new Map<string, { readonly host: ISandboxedHost; readonly listeners: DisposableStore }>();

	/** Sandboxed terminals (PTY workloads), by caller-chosen id, and the window that asked. */
	private readonly terminals = new Map<string, { readonly session: SandboxedPtySession; readonly owner: string | undefined }>();
	/** Foreground commands and background jobs, by caller-chosen id. */
	private readonly runs = new Map<string, ExecRun>();
	/** HostGit calls that were given an id, for `cancelExec`. */
	private readonly gitRuns = new Map<string, ChildProcess>();
	private shellEnv: Promise<NodeJS.ProcessEnv> | undefined;
	/**
	 * The window (IPC context, `window:<id>`) that spawned each agent process. Its chats are the
	 * only ones that can use or stop the process, so when that window reloads, loads another
	 * folder, or closes, its agents go too. Without this every reload leaked an agent per chat.
	 */
	private readonly owners = new Map<string, string>();
	/** The window of a process whose exit is being announced, while its exit event fires. */
	private readonly exitOwners = new Map<string, string>();
	/** Output not yet sent, per process: chunks of one tick go to the window as one event. */
	private readonly pendingData = new Map<string, string[]>();
	private dataFlush: NodeJS.Immediate | undefined;

	constructor(
		protected readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
		userDataPath: string,
		/** The agent server's: what it started, so its next start can stop what a crash orphaned. */
		private readonly ledger?: ChildLedger,
	) {
		super();
		// The supervisor path's rollback flag (application scope): off, no long-lived host starts.
		const supervisorEnabled = () => this.configurationService.getValue<boolean>(SANDBOX_SUPERVISOR_SETTING) !== false;
		this.sandbox = this._register(new VoltSandboxLauncher(userDataPath, logService, {
			mode: () => readPolicyAuthorityMode(this.configurationService.getValue(POLICY_AUTHORITY_MODE_SETTING)),
			supervisorEnabled,
			networkMode: () => readNetworkBrokerMode(this.configurationService.getValue(NETWORK_BROKER_SETTING)),
		}));
		this._register(this.sandbox.onViolation(e => {
			const id = this.sandboxTags.get(e.tag);
			if (id) {
				this._onSandboxEvent.fire({ id, denial: e.denial });
			}
		}));
		this.onDidChangeSandboxWorkloads = Event.any(this.sandbox.supervisor.onDidChange, this.sandbox.supervisor.manager.onDidChangeWorkloads);
		// F.11: hosts a crashed Volt left behind are reaped once, at start.
		if (supervisorEnabled()) {
			void this.sandbox.supervisor.recover().catch(err => this.logService.warn(`[volt-sandbox] recovery of earlier hosts failed: ${err}`));
		}
	}

	readonly onDidChangeSandboxWorkloads: Event<void>;

	async sandboxWorkloads(): Promise<readonly ISandboxWorkloadInfo[]> {
		return this.sandbox.supervisor.workloads();
	}

	async stopSandboxWorkload(id: string): Promise<boolean> {
		this.logService.info(`[volt-sandbox] stop requested for workload ${id}`);
		return this.sandbox.supervisor.stop(id);
	}

	async spawnSandboxedMcp(request: IVoltSandboxedMcpRequest): Promise<string> {
		return this.spawnSandboxedMcpFor(undefined, request);
	}

	/**
	 * {@link spawnSandboxedMcp} on behalf of one window: its output and exit go to that window, and
	 * it stops when the window does. Refused (typed, never run unsandboxed) when the request is not a
	 * sandboxed chat's own, or when the supervisor refuses it at any step.
	 */
	async spawnSandboxedMcpFor(owner: string | undefined, request: IVoltSandboxedMcpRequest): Promise<string> {
		const refuse = (refusal: IVoltExecRefusal): never => {
			this.logService.warn(`[volt-exec] refused MCP server ${request.server}: ${refusal.reason}`);
			throw new VoltExecRefusedError(refusal);
		};
		const refusal = execRefusal(request.context, request.sandbox);
		if (refusal) {
			refuse(refusal);
		}
		if (!request.sandbox || !request.context.sandboxed) {
			refuse({ kind: 'no-sandbox', reason: `The ${request.server} MCP server was asked for without its chat's sandbox, so it was not started.` });
		}
		if (request.context.principal !== `chat:${request.chatId}`) {
			refuse({ kind: 'no-context', reason: `The ${request.server} MCP server was asked for by ${request.context.principal}, not by the chat it would work for, so it was not started.` });
		}
		await this.snapshotBuildEntries(request.sandbox);
		const result = await this.sandbox.startMcpHost({
			chatId: request.chatId,
			...(request.chatLabel ? { chatLabel: request.chatLabel } : {}),
			server: request.server,
			digest: request.digest,
			command: request.command,
			args: [...request.args ?? []],
			...(request.cwd ? { cwd: request.cwd } : {}),
			hostEnv: await this.env(),
			...(request.env ? { env: request.env } : {}),
			sandbox: request.sandbox,
			...(request.allowedHosts?.length ? { allowedHosts: request.allowedHosts } : {}),
		});
		if (!result.ok) {
			return refuse({ kind: 'sandbox', step: result.refused, reason: `Volt's sandbox refused the ${request.server} MCP server (${result.refused}): ${result.reason}` });
		}
		const host = result.host;
		const id = generateUuid();
		this.logService.info(`[volt-sandbox-spawn] ${id} MCP ${request.server} for chat ${request.chatId} as host ${host.id} (${host.backend}, ${host.principal.subject})`);
		const listeners = new DisposableStore();
		this.hosts.set(id, { host, listeners });
		if (owner) {
			this.owners.set(id, owner);
		}
		let restarts = host.restarts;
		const finish = (code: number | null) => {
			if (!this.hosts.has(id)) {
				return;
			}
			this.flushData(id);
			this.hosts.delete(id);
			listeners.dispose();
			const windowOwner = this.owners.get(id);
			this.owners.delete(id);
			const stderr = tailText(host.stderrTail(), 4_000);
			if (windowOwner) {
				this.exitOwners.set(id, windowOwner);
			}
			try {
				this._onExit.fire({ id, code, ...(stderr ? { stderr } : {}) });
			} finally {
				this.exitOwners.delete(id);
			}
		};
		listeners.add(host.onStdout(data => this.queueData(id, data)));
		listeners.add(host.onExit(exit => {
			if (exit.restarting) {
				this.flushData(id);
				this._onSandboxEvent.fire({ id, host: 'restarting', warning: `The ${request.server} MCP server stopped (${exit.reason}); Volt is starting it again.` });
			} else {
				finish(exit.code);
			}
		}));
		listeners.add(host.onDidChangeState(state => {
			if (state === 'running' && host.restarts > restarts) {
				restarts = host.restarts;
				this._onSandboxEvent.fire({ id, host: 'restarted' });
			} else if (state === 'stopped' || state === 'failed' || state === 'broken') {
				finish(null);
			}
		}));
		return id;
	}

	async stopSandboxedHosts(chatId: string): Promise<number> {
		const stopped = await this.sandbox.stopChatHosts(chatId);
		if (stopped) {
			this.logService.info(`[volt-sandbox] stopped ${stopped} host(s) of chat ${chatId}`);
		}
		return stopped;
	}

	private track(child: ChildProcess, command: string): void {
		if (this.ledger && child.pid) {
			this.ledger.add(child.pid, command);
			child.once('exit', () => this.ledger?.delete(child.pid));
		}
	}

	async spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		return this.spawnFor(undefined, options);
	}

	/** {@link spawn} on behalf of one window; see {@link owners}. */
	async spawnFor(owner: string | undefined, options: IVoltStdioSpawnOptions): Promise<string> {
		const refusal = execRefusal(options.context, options.sandbox) ?? await this.buildEntryRefusal(options.context, options.sandbox, options.cwd);
		if (refusal) {
			// Refused, never run unsandboxed (INV-03, INV-14).
			this.logService.warn(`[volt-exec] refused spawn of ${basename(options.command)}: ${refusal.reason}`);
			throw new VoltExecRefusedError(refusal);
		}
		const id = generateUuid();
		this.logService.trace(`[volt-exec] spawn ${id} ${basename(options.command)} (${describeExecContext(options.context)})`);
		let command = options.command;
		let args = options.args ?? [];
		let cwd = options.cwd;
		let env: NodeJS.ProcessEnv;
		if (options.sandbox) {
			await this.snapshotBuildEntries(options.sandbox);
		}
		// Throws SandboxUnavailableError when the sandbox cannot be established: the agent does not start.
		const launch = options.sandbox ? await this.sandbox.prepare(command, args, options.sandbox, { cwd: options.cwd, hostEnv: await this.env(), env: options.env }) : undefined;
		if (launch) {
			command = launch.command;
			args = launch.args;
			cwd = launch.cwd;
			// The profile's environment is complete: the user's minus secrets, plus what Volt set on purpose.
			env = launch.env;
			this.sandboxes.set(id, launch);
			this.sandboxTags.set(launch.tag, id);
			// Diagnostics for sandboxed spawns: exactly what runs, where, from which parent and with which env names.
			this.logService.info(`[volt-sandbox-spawn] ${id} ppid=${process.pid} cwd=${cwd ?? ''} ${launch.mechanism} unenforced=${launch.unenforced.join(',') || 'none'}`);
			this.logService.info(`[volt-sandbox-spawn] ${id} env=${Object.keys(env).sort().join(',')}`);
		} else {
			env = { ...await this.env(), ...options.env };
		}
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe', ...(launch?.extraStdio ?? [])],
			// Its own process group, so stopping it also stops the workers it starts.
			detached: process.platform !== 'win32',
		}) as ChildProcessWithoutNullStreams;
		if (launch) {
			void launch.confirm(child).then(confirmation => {
				if (!confirmation.ok) {
					// Never left running unconfirmed: the agent exits and the transcript says why.
					this.logService.warn(`[volt-sandbox-spawn] ${id} not confirmed: ${confirmation.error}`);
					this._onSandboxEvent.fire({ id, warning: `The sandbox could not be established, so the agent was stopped: ${confirmation.error}` });
					void launch.terminate(child);
				} else {
					const attestation = launch.attestation();
					if (attestation) {
						this.logService.info(`[volt-sandbox-spawn] ${id} attested ${attestation.backend} ${JSON.stringify(attestation.evidence)} policy=${attestation.launchPolicyHash.slice(0, 12)}`);
					}
					launch.warnings.forEach(warning => this._onSandboxEvent.fire({ id, warning }));
				}
			});
		}
		this.processes.set(id, child);
		this.track(child, command);
		if (owner) {
			this.owners.set(id, owner);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (data: string) => this.queueData(id, data));
		child.stderr.on('data', (data: string) => {
			this.stderr.set(id, tailText(`${this.stderr.get(id) ?? ''}${data}`, 4_000));
			this.logService.trace(`[volt-stdio:${id}] ${data}`);
		});
		// 'close' waits for stdout to drain; 'exit' can fire while output is still buffered.
		child.on('close', code => {
			// Output always reaches the window before the exit does.
			this.flushData(id);
			const stderr = this.stderr.get(id);
			const owner = this.owners.get(id);
			this.disposeSandbox(id);
			this.processes.delete(id);
			this.owners.delete(id);
			this.stderr.delete(id);
			if (owner) {
				this.exitOwners.set(id, owner);
			}
			try {
				this._onExit.fire({ id, code, ...(stderr ? { stderr } : {}) });
			} finally {
				this.exitOwners.delete(id);
			}
		});
		child.on('error', err => this.logService.error('[volt-stdio]', err));
		return id;
	}

	/**
	 * Agent output arrives in many small chunks; one IPC event per chunk floods the main process
	 * and the window. Chunks of the same tick are joined and sent once.
	 */
	private queueData(id: string, data: string): void {
		const pending = this.pendingData.get(id);
		if (pending) {
			pending.push(data);
		} else {
			this.pendingData.set(id, [data]);
		}
		this.dataFlush ??= setImmediate(() => {
			this.dataFlush = undefined;
			for (const pendingId of [...this.pendingData.keys()]) {
				this.flushData(pendingId);
			}
		});
	}

	private flushData(id: string): void {
		const pending = this.pendingData.get(id);
		if (!pending) {
			return;
		}
		this.pendingData.delete(id);
		this._onData.fire({ id, data: pending.length === 1 ? pending[0] : pending.join('') });
	}

	/** The window that started process or command `id`, if a window did. */
	ownerOf(id: string): string | undefined {
		return this.owners.get(id) ?? this.exitOwners.get(id) ?? this.runs.get(id)?.owner;
	}

	async git(request: IHostGitRequest): Promise<IHostGitResult> {
		const id = request.id;
		return runHostGit(request, { baseEnv: await this.env() }, child => {
			if (id) {
				this.gitRuns.set(id, child);
				child.once('close', () => this.gitRuns.delete(id));
			}
		});
	}

	async buildEntryChanges(root: string): Promise<readonly IBuildEntryChange[]> {
		return this.buildEntries().changes(root);
	}

	async acceptBuildEntries(root: string, paths?: readonly string[]): Promise<void> {
		await this.buildEntries().accept(root, paths);
		this.logService.info(`[volt-build-entry] the user accepted ${paths ? paths.length : 'all'} change(s) in ${root}`);
	}

	/**
	 * I.6: before a sandboxed writer starts, the execution-bearing files of the folders it may write
	 * are recorded, so what it changes there is shown before Volt runs any of it for the user.
	 */
	private async snapshotBuildEntries(request: IVoltSandboxRequest): Promise<void> {
		const roots = [...(request.level === 'workspace-write' ? request.workspaceRoots : []), ...(request.extraWritableRoots ?? [])]
			.filter(root => !/[\\/]\.git$/.test(root));
		await Promise.all(roots.map(root => this.buildEntries().snapshot(root).catch(err => this.logService.warn(`[volt-build-entry] could not record ${root}`, err))));
	}

	/** The build-entry guard this service records to and checks (I.6); the one every Volt process shares. */
	protected buildEntries(): BuildEntryGuard {
		return buildEntryGuard();
	}

	/**
	 * I.6, enforced where the process starts: project-defined commands that run outside any sandbox
	 * for the user (an unsandboxed chat's worktree setup) wait while files that run code changed in
	 * their folder since a sandboxed writer worked there. The window shows the review and accepts it
	 * first (`reviewBuildEntries`); a caller that skipped it is refused here, never run.
	 */
	private async buildEntryRefusal(context: IVoltExecContext, sandbox: IVoltSandboxRequest | undefined, cwd: string | undefined): Promise<IVoltExecRefusal | undefined> {
		const purpose = buildEntryPurposeOf(context.reason, !!sandbox);
		if (!purpose || !cwd) {
			return undefined;
		}
		const changes = await this.buildEntries().unreviewed([cwd], purpose).catch(() => undefined);
		if (changes === undefined) {
			return { kind: 'build-entry', reason: `Volt could not check what changed in ${cwd} since a sandboxed agent worked there, so its ${context.reason} did not run.` };
		}
		return changes.length ? { kind: 'build-entry', reason: `${changes.length} file(s) that run code changed in ${cwd} since a sandboxed agent worked there (${changes.slice(0, 3).map(change => basename(change.path)).join(', ')}). Review them before Volt runs its ${context.reason} outside the sandbox.` } : undefined;
	}

	async sandboxSupport(): Promise<IVoltSandboxSupportInfo> {
		return this.sandbox.getSupport();
	}

	async allowSandboxDomains(id: string, domains: readonly string[]): Promise<void> {
		this.sandboxes.get(id)?.allowDomains(domains);
	}

	async sandboxAllows(id: string, path: string, access: 'read' | 'write'): Promise<boolean> {
		const launch = this.sandboxes.get(id);
		if (!launch) {
			// A running spawn without a sandbox is unconfined. An id this service does not know (never
			// spawned here, or already gone) is refused: it may have been sandboxed (INV-13).
			return this.processes.has(id);
		}
		const resolved = await realpathOfNearest(path);
		// Both spellings must pass, as the OS checks the resolved path and Volt writes the given one.
		return resolvedPolicyAllows(launch.policy, path, access) && resolvedPolicyAllows(launch.policy, resolved, access);
	}

	async sandboxReadFile(id: string, path: string): Promise<IVoltSandboxFileResult> {
		const launch = this.sandboxes.get(id);
		if (!launch) {
			return { ok: false, reason: 'Volt does not know this sandboxed process' };
		}
		try {
			const read = await brokerReadFile(launch.policy, path, { fsdPath: defaultFsdPath() });
			return { ok: true, path: read.finalPath, content: read.content.toString('utf8') };
		} catch (err) {
			return { ok: false, reason: this.fileRefusal(id, path, 'read', err) };
		}
	}

	async sandboxWriteFile(id: string, path: string, content: string): Promise<IVoltSandboxFileResult> {
		const launch = this.sandboxes.get(id);
		if (!launch) {
			return { ok: false, reason: 'Volt does not know this sandboxed process' };
		}
		try {
			const written = await brokerWriteFile(launch.policy, path, Buffer.from(content, 'utf8'), { fsdPath: defaultFsdPath() });
			return { ok: true, path: written.finalPath, ...(written.before ? { content: written.before.toString('utf8') } : {}) };
		} catch (err) {
			return { ok: false, reason: this.fileRefusal(id, path, 'write', err) };
		}
	}

	private fileRefusal(id: string, path: string, access: 'read' | 'write', err: unknown): string {
		const reason = err instanceof Error ? err.message : String(err);
		this.logService.info(`[volt-sandbox-files] ${id} ${access} ${path} refused: ${err instanceof SafeOpenError ? `${err.refusal}: ` : ''}${reason}`);
		return reason;
	}

	// --- sandboxed terminals ----------------------------------------------------------------------

	async prepareSandboxedTerminal(request: IVoltSandboxedTerminalRequest): Promise<IVoltSandboxedTerminalLaunch> {
		return this.prepareSandboxedTerminalFor(undefined, request);
	}

	/** {@link prepareSandboxedTerminal} on behalf of one window; its terminals' sandboxes end with it. */
	async prepareSandboxedTerminalFor(owner: string | undefined, request: IVoltSandboxedTerminalRequest): Promise<IVoltSandboxedTerminalLaunch> {
		// A terminal of a sandboxed chat runs only in its sandbox: no request without one.
		const refusal = execRefusal(request.context, request.sandbox) ?? (request.sandbox ? undefined : { kind: 'no-sandbox' as const, reason: 'A sandboxed terminal needs its sandbox.' });
		if (refusal) {
			throw new VoltExecRefusedError(refusal);
		}
		if (this.terminals.has(request.id)) {
			throw new Error(`terminal ${request.id} is already prepared`);
		}
		let session: SandboxedPtySession;
		try {
			session = await SandboxedPtySession.prepare(this.sandbox, request.file, request.args, request.sandbox, { cwd: request.cwd, hostEnv: await this.env(), env: request.env, label: request.context.reason });
		} catch (err) {
			throw new VoltExecRefusedError({ kind: 'sandbox', reason: (err as Error).message });
		}
		this.terminals.set(request.id, { session, owner });
		this.logService.info(`[volt-sandbox-spawn] terminal ${request.id} (${describeExecContext(request.context)}) ${session.mechanism} cwd=${session.launch.cwd}`);
		return session.launch;
	}

	async confirmSandboxedTerminal(id: string, pid: number): Promise<string> {
		const entry = this.terminals.get(id);
		if (!entry) {
			throw new Error(`No sandboxed terminal ${id}`);
		}
		try {
			return await entry.session.confirm(pid);
		} catch (err) {
			this.terminals.delete(id);
			this.logService.warn(`[volt-sandbox-spawn] terminal ${id} not confirmed: ${(err as Error).message}`);
			throw err;
		}
	}

	async endSandboxedTerminal(id: string): Promise<void> {
		const entry = this.terminals.get(id);
		this.terminals.delete(id);
		if (entry) {
			entry.session.exited(null, 'SIGKILL');
			await entry.session.end();
		}
	}

	async syncSandboxState(id: string): Promise<IVoltSandboxStateSync | undefined> {
		return this.sandboxes.get(id)?.syncState();
	}

	private disposeSandbox(id: string): void {
		const launch = this.sandboxes.get(id);
		if (launch) {
			const child = this.processes.get(id);
			if (child) {
				// The agent is gone; nothing it started may outlive it.
				void launch.terminate(child);
			}
			// A moment for the kernel log to deliver the last denials of a process that just ended.
			setTimeout(() => {
				launch.dispose();
				this.sandboxTags.delete(launch.tag);
			}, 3_000);
			this.sandboxes.delete(id);
		}
	}

	async write(id: string, data: string): Promise<void> {
		const host = this.hosts.get(id)?.host;
		if (host) {
			if (!host.write(data)) {
				throw new Error(`The sandboxed process is not running (${host.state})`);
			}
			return;
		}
		const child = this.processes.get(id);
		if (!child?.stdin.writable) {
			throw new Error('ACP process is not writable');
		}
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(data, err => err ? reject(err) : resolve());
		});
	}

	async kill(id: string): Promise<void> {
		const host = this.hosts.get(id)?.host;
		if (host) {
			// Its whole tree; resolves (and the exit reaches the caller) when it is gone.
			await host.terminate('stopped');
			return;
		}
		const child = this.processes.get(id);
		if (!child) {
			return;
		}
		const launch = this.sandboxes.get(id);
		if (launch) {
			// The backend's kill: the whole sandbox, including processes that left the group.
			void launch.terminate(child);
		} else {
			killTree(child);
		}
		this.processes.delete(id);
		this.owners.delete(id);
	}

	protected killOwnedBy(owner: string): void {
		// Agent processes and sandboxed MCP servers alike (`kill` knows which).
		const ids = [...this.owners].filter(([, value]) => value === owner).map(([id]) => id);
		if (ids.length) {
			this.logService.info(`[volt-stdio] stopping ${ids.length} agent process(es) of ${owner}`);
		}
		for (const id of ids) {
			void this.kill(id);
		}
		// Commands and jobs of the window too: a dev server left behind by a reload would hold its port.
		const runs = [...this.runs.values()].filter(run => run.owner === owner && run.running);
		if (runs.length) {
			this.logService.info(`[volt-stdio] stopping ${runs.length} command(s) of ${owner}`);
		}
		for (const run of runs) {
			void this.cancelExec(run.id);
		}
		for (const [id, entry] of [...this.terminals]) {
			if (entry.owner === owner) {
				void this.endSandboxedTerminal(id);
			}
		}
	}

	killAll(): void {
		for (const id of [...this.processes.keys()]) {
			void this.kill(id);
		}
		for (const id of [...this.terminals.keys()]) {
			void this.endSandboxedTerminal(id);
		}
		for (const run of this.runs.values()) {
			run.stop();
		}
		// Long-lived sandboxed hosts and their whole trees.
		void this.sandbox.supervisor.shutdown();
	}

	async which(command: string): Promise<string | undefined> {
		try {
			const tool = process.platform === 'win32' ? 'where' : 'which';
			const { stdout } = await execFileAsync(tool, [command], { env: await this.env() });
			return stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		} catch {
			return undefined;
		}
	}

	// --- exec and jobs --------------------------------------------------------------------------

	async exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		return this.execFor(undefined, request);
	}

	async execFile(request: IVoltExecFileRequest): Promise<IVoltExecFileResult> {
		const env = { ...await this.env(), ...request.env };
		return new Promise(resolve => {
			execFile(request.file, [...request.args], {
				cwd: request.cwd,
				env,
				timeout: request.timeoutMs,
				maxBuffer: request.maxBytes ?? 1024 * 1024,
				windowsHide: true,
				encoding: 'utf8',
			}, (err, stdout, stderr) => {
				const failure = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
				resolve({
					exitCode: !failure ? 0 : typeof failure.code === 'number' ? failure.code : null,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					...(failure && typeof failure.code !== 'number' ? { error: failure.killed ? `timed out after ${request.timeoutMs} ms` : failure.message } : {}),
				});
			});
		});
	}

	/** {@link exec} on behalf of one window; its commands stop when it reloads or closes. */
	async execFor(owner: string | undefined, request: IVoltExecRequest): Promise<IVoltExecResult> {
		const started = Date.now();
		const refused = (refusal: IVoltExecRefusal): IVoltExecResult => {
			const message = `Not run: ${refusal.reason}`;
			return { id: request.id, exitCode: null, stdout: '', stderr: message, combined: message, truncated: false, durationMs: Date.now() - started, timedOut: false, cancelled: false, running: false, refused: refusal };
		};
		const refusal = execRefusal(request.context, request.sandbox) ?? await this.buildEntryRefusal(request.context, request.sandbox, request.cwd);
		if (refusal) {
			// Refused, never run unsandboxed (INV-03, INV-14).
			this.logService.warn(`[volt-exec] refused command ${request.id}: ${refusal.reason}`);
			return refused(refusal);
		}
		this.logService.trace(`[volt-exec] command ${request.id} (${describeExecContext(request.context)})`);
		const env = { ...await this.env(), ...request.env };
		const shell = shellFor(env);
		let launch: ISandboxLaunch | undefined;
		if (request.sandbox) {
			await this.snapshotBuildEntries(request.sandbox);
			try {
				launch = await this.sandbox.prepare(shell.file, shell.args(request.command), request.sandbox, { cwd: request.cwd, hostEnv: await this.env(), env: request.env, label: request.context.reason, kind: 'task' });
			} catch (err) {
				// Refused, never run unsandboxed.
				return refused({ kind: 'sandbox', reason: (err as Error).message });
			}
		}
		const child = spawn(launch?.command ?? shell.file, launch?.args ?? shell.args(request.command), {
			cwd: launch?.cwd ?? request.cwd,
			env: launch?.env ?? env,
			// No stdin: a command that prompts gets EOF instead of hanging the run.
			stdio: ['ignore', 'pipe', 'pipe', ...(launch?.extraStdio ?? [])],
			detached: process.platform !== 'win32',
			windowsVerbatimArguments: process.platform === 'win32',
		});
		this.track(child, shell.file);
		const run = new ExecRun(request.id, request.command, child, started, owner, launch);
		this.runs.set(request.id, run);
		this.pruneFinishedJobs();
		if (launch) {
			const sandboxed = launch;
			void sandboxed.confirm(child).then(confirmation => {
				if (!confirmation.ok) {
					run.appendError(`Volt sandbox: ${confirmation.error}\n`);
					void sandboxed.terminate(child);
				}
			});
			// Nothing a sandboxed command started outlives it; then its sandbox is torn down.
			run.onDone(() => void sandboxed.terminate(child).finally(() => sandboxed.dispose()));
		}
		run.onDone(() => {
			// A command that handed control back stays readable as a job.
			if (!request.background && !run.yielded) {
				this.runs.delete(request.id);
			}
		});
		const timeout = setTimeout(() => {
			run.timedOut = true;
			run.stop();
		}, Math.max(1_000, request.timeoutMs));
		run.onDone(() => clearTimeout(timeout));

		if (request.background) {
			await Promise.race([run.done, delay(request.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS)]);
			clearTimeout(timeout);
			if (run.running) {
				// A background job outlives the call; its own timer is the dispose of this service.
				return this.result(run, request, started);
			}
		} else if (request.yieldAfterMs !== undefined && request.yieldAfterMs > 0) {
			await Promise.race([run.done, delay(request.yieldAfterMs)]);
			if (run.running) {
				// Still going: the caller gets control back, the command goes on as a job under its own timeout.
				run.yielded = true;
			}
		} else {
			await run.done;
		}
		return this.result(run, request, started);
	}

	async cancelExec(id: string): Promise<void> {
		const git = this.gitRuns.get(id);
		if (git) {
			git.kill('SIGKILL');
			this.gitRuns.delete(id);
		}
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		run.cancelled = true;
		run.stop();
		await Promise.race([run.done, delay(KILL_GRACE_MS * 2)]);
		this.runs.delete(id);
	}

	async jobOutput(id: string, since?: number): Promise<IVoltJobOutput | undefined> {
		const run = this.runs.get(id);
		return run ? run.snapshot(since) : undefined;
	}

	async jobWait(id: string, timeoutMs: number, until?: string, since?: number): Promise<IVoltJobOutput | undefined> {
		const run = this.runs.get(id);
		if (!run) {
			return undefined;
		}
		let pattern: RegExp | undefined;
		if (until) {
			try {
				pattern = new RegExp(until, 'm');
			} catch {
				pattern = new RegExp(until.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
			}
		}
		const from = since ?? 0;
		const matches = () => !!pattern && pattern.test(run.combined.since(from).text);
		if (!run.running || matches()) {
			return { ...run.snapshot(since), matched: matches() };
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(finish, Math.min(MAX_WAIT_MS, Math.max(0, timeoutMs)));
			const listener = run.onOutput(() => {
				if (matches()) {
					finish();
				}
			});
			run.onDone(finish);
			function finish() {
				clearTimeout(timer);
				listener();
				resolve();
			}
		});
		return { ...run.snapshot(since), matched: matches() };
	}

	async listJobs(): Promise<readonly IVoltJobOutput[]> {
		return [...this.runs.values()].map(run => run.snapshot(Number.MAX_SAFE_INTEGER));
	}

	/** Finished background jobs stay readable, but not forever. */
	private pruneFinishedJobs(): void {
		const finished = [...this.runs.values()].filter(run => !run.running).sort((a, b) => a.startedAt - b.startedAt);
		for (const run of finished.slice(0, Math.max(0, finished.length - 32))) {
			this.runs.delete(run.id);
		}
	}

	private async result(run: ExecRun, request: IVoltExecRequest, started: number): Promise<IVoltExecResult> {
		const inline = request.inlineChars ?? DEFAULT_INLINE_CHARS;
		const stdout = run.stdout.shaped(inline);
		const stderr = run.stderr.shaped(Math.max(4_000, Math.floor(inline / 2)));
		const combined = run.combined.shaped(inline);
		const truncated = stdout.truncated || stderr.truncated || combined.truncated;
		let logPath: string | undefined;
		if (truncated && !run.running) {
			logPath = await this.spill(request.spillDir ?? join(tmpdir(), 'volt-exec'), request.id, run.combined.full()).catch(() => undefined);
		}
		return {
			id: request.id,
			exitCode: run.exitCode,
			...(run.signal ? { signal: run.signal } : {}),
			stdout: stdout.text,
			stderr: stderr.text,
			combined: combined.text,
			truncated,
			...(logPath ? { logPath } : {}),
			durationMs: Date.now() - started,
			timedOut: run.timedOut,
			cancelled: run.cancelled,
			running: run.running,
		};
	}

	private async spill(dir: string, id: string, text: string): Promise<string> {
		await fs.mkdir(dir, { recursive: true });
		const file = join(dir, `${id.replace(/[^\w.-]/g, '_')}.log`);
		await fs.writeFile(file, text, 'utf8');
		return file;
	}

	/**
	 * The user's shell environment, resolved once by the main process and cached, minus Volt's own
	 * plumbing (`VSCODE_IPC_HOOK*`, `ELECTRON_*`) and secret-looking names (B-38, INV-24; see
	 * `childEnv.ts`). Every child starts from it; what a caller sets on purpose is added on top.
	 */
	private env(): Promise<NodeJS.ProcessEnv> {
		this.shellEnv ??= getResolvedShellEnv(this.configurationService, this.logService, { _: [] }, process.env)
			.catch(err => {
				this.logService.warn('[volt-stdio] could not resolve the shell environment', err);
				// Not cached: the next command tries again (a slow shell at startup is often fine later).
				this.shellEnv = undefined;
				return {};
			})
			.then(resolved => ({
				...childEnvFromHost(commandEnv({ ...process.env, ...resolved })),
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
			}));
		return this.shellEnv;
	}

	override dispose(): void {
		for (const [id, child] of this.processes) {
			killTree(child);
			this.processes.delete(id);
		}
		this.owners.clear();
		// The hosts themselves go with the launcher's supervisor (registered below), whole trees.
		for (const { listeners } of this.hosts.values()) {
			listeners.dispose();
		}
		this.hosts.clear();
		for (const launch of this.sandboxes.values()) {
			launch.dispose();
		}
		this.sandboxes.clear();
		for (const id of [...this.terminals.keys()]) {
			void this.endSandboxedTerminal(id);
		}
		for (const run of this.runs.values()) {
			run.stop();
		}
		this.runs.clear();
		this.stderr.clear();
		if (this.dataFlush) {
			clearImmediate(this.dataFlush);
			this.dataFlush = undefined;
		}
		this.pendingData.clear();
		super.dispose();
	}
}

/** One command's streams and lifecycle. */
class ExecRun {

	readonly stdout = new OutputLog();
	readonly stderr = new OutputLog();
	readonly combined = new OutputLog();
	readonly done: Promise<void>;
	running = true;
	exitCode: number | null = null;
	signal: string | undefined;
	timedOut = false;
	cancelled = false;
	/** A foreground command that outlived its `yieldAfterMs` and is now a job. */
	yielded = false;
	private readonly outputListeners = new Set<() => void>();
	private readonly doneListeners: (() => void)[] = [];

	constructor(readonly id: string, readonly command: string, readonly child: ChildProcess, readonly startedAt: number, readonly owner?: string, private readonly sandbox?: ISandboxLaunch) {
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => this.append(this.stdout, data));
		child.stderr?.on('data', (data: string) => this.append(this.stderr, data));
		this.done = new Promise<void>(resolve => {
			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
				if (!this.running) {
					return;
				}
				this.running = false;
				this.exitCode = code;
				this.signal = signal ?? undefined;
				resolve();
				for (const listener of this.doneListeners.splice(0)) {
					listener();
				}
			};
			child.on('close', finish);
			// The shell is gone but a child it backgrounded still holds the pipes: done anyway.
			child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), EXIT_DRAIN_MS));
			child.on('error', err => {
				this.append(this.stderr, `${err.message}\n`);
				finish(127, null);
			});
		});
	}

	/** Kills the whole tree: through the sandbox backend when sandboxed (it reaches processes that left the group). */
	stop(): void {
		if (this.sandbox) {
			void this.sandbox.terminate(this.child);
		} else {
			killTree(this.child);
		}
	}

	appendError(text: string): void {
		this.append(this.stderr, text);
	}

	onDone(listener: () => void): void {
		if (!this.running) {
			listener();
			return;
		}
		this.doneListeners.push(listener);
	}

	onOutput(listener: () => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	snapshot(since?: number): IVoltJobOutput {
		const slice = this.combined.since(since ?? 0);
		return {
			id: this.id,
			command: this.command,
			output: shapeText(slice.text, DEFAULT_INLINE_CHARS).text,
			offset: slice.offset,
			running: this.running,
			exitCode: this.exitCode,
		};
	}

	private append(log: OutputLog, data: string): void {
		const clean = data.replace(ANSI, '');
		log.append(clean);
		this.combined.append(clean);
		for (const listener of this.outputListeners) {
			listener();
		}
	}
}

/** Head is kept whole; the rest rolls, dropping the middle past `MAX_BUFFER_CHARS`. */
class OutputLog {

	private head = '';
	private readonly chunks: string[] = [];
	/** Characters held in `chunks`. */
	private size = 0;
	/** Characters ever appended; offsets are absolute positions in this stream. */
	private total = 0;

	append(text: string): void {
		if (!text) {
			return;
		}
		this.total += text.length;
		if (this.head.length < HEAD_CHARS) {
			const room = HEAD_CHARS - this.head.length;
			this.head += text.slice(0, room);
			text = text.slice(room);
			if (!text) {
				return;
			}
		}
		this.chunks.push(text);
		this.size += text.length;
		while (this.size > MAX_BUFFER_CHARS && this.chunks.length > 1) {
			this.size -= this.chunks.shift()!.length;
		}
	}

	full(): string {
		const tail = this.chunks.join('');
		const dropped = this.total - this.head.length - tail.length;
		return dropped > 0 ? `${this.head}\n[... ${dropped} characters dropped ...]\n${tail}` : this.head + tail;
	}

	/** Output after absolute offset `offset`, and the offset to pass next time. */
	since(offset: number): { text: string; offset: number } {
		const tail = this.chunks.join('');
		const tailStart = this.total - this.size;
		const from = Math.max(0, Math.min(offset, this.total));
		let text: string;
		if (from < this.head.length) {
			const gap = tailStart > this.head.length ? `\n[... ${tailStart - this.head.length} characters dropped ...]\n` : '';
			text = this.head.slice(from) + gap + tail;
		} else if (from < tailStart) {
			text = `[... ${tailStart - from} characters dropped ...]\n${tail}`;
		} else {
			text = tail.slice(from - tailStart);
		}
		return { text, offset: this.total };
	}

	shaped(limit: number): { text: string; truncated: boolean } {
		return shapeText(this.full(), limit);
	}
}

/** 20% head, 80% tail: failures are usually at the end. */
function shapeText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	const head = Math.max(500, Math.floor(limit * 0.2));
	const tail = Math.max(500, limit - head);
	const omitted = text.length - head - tail;
	return { text: `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(-tail)}`, truncated: true };
}

/** A POSIX shell the model's commands are written for; fish and friends fall back to bash. */
function shellFor(env: NodeJS.ProcessEnv): { file: string; args: (command: string) => string[] } {
	if (process.platform === 'win32') {
		return { file: env.ComSpec || 'cmd.exe', args: command => ['/d', '/s', '/c', `"${command}"`] };
	}
	const preferred = env.SHELL && /^(zsh|bash|sh|dash|ksh)$/.test(basename(env.SHELL)) ? env.SHELL : undefined;
	return { file: preferred ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: command => ['-c', command] };
}

/** The real path of `path`, or of its nearest existing parent plus the rest (a file about to be created). */
async function realpathOfNearest(path: string): Promise<string> {
	const rest: string[] = [];
	let current = path;
	for (let i = 0; i < 64 && current && current !== '/'; i++) {
		try {
			const real = await fs.realpath(current);
			return [real, ...rest].join('/').replace(/\/{2,}/g, '/');
		} catch {
			rest.unshift(basename(current));
			current = dirname(current);
		}
	}
	return path;
}

/** SIGTERM to the whole process group, then SIGKILL after a grace period. */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid || child.exitCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
		return;
	}
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				child.kill(sig);
			} catch {
				// Already gone.
			}
		}
	};
	signal('SIGTERM');
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			signal('SIGKILL');
		}
	}, KILL_GRACE_MS);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** GUI launches omit shell paths such as ~/.local/bin, where Claude Code is installed. */
function commandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = homedir();
	const extra = process.platform === 'win32'
		? [join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps')]
		: [
			join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
			// Docker Desktop and OrbStack put the docker CLI here; a GUI launch's PATH often lacks them.
			join(home, '.docker', 'bin'), join(home, '.orbstack', 'bin'), '/Applications/Docker.app/Contents/Resources/bin',
		];
	const current = (base.PATH ?? '').split(delimiter).filter(Boolean);
	const path = [...current, ...extra].filter((entry, index, all) => all.indexOf(entry) === index);
	return { ...base, PATH: path.join(delimiter) };
}

function tailText(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}
