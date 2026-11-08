/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IBuildEntryChange, IHostGitRequest, IHostGitResult } from '../../../../platform/voltGit/common/hostGit.js';
import { IVoltExecFileRequest, IVoltExecFileResult, IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltPromptBudget, IVoltSandboxApproval, IVoltSandboxedMcpRequest, IVoltSandboxedTerminalLaunch, IVoltSandboxedTerminalRequest, IVoltSandboxFileResult, IVoltSandboxStateSync, IVoltSandboxSupportInfo, IVoltStdioService, IVoltStdioSpawnOptions, VoltExecRefusedError } from '../../../../platform/voltStdio/common/voltStdio.js';
import type { ISandboxWorkloadInfo } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';
import type { SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { EMPTY_TRUST_STATE, ITrustChange, ITrustCommitResult, ITrustHistoryEntry, ITrustState } from '../../../../platform/voltSandbox/common/trust.js';
import { projectRunEnv } from './projectRunEnv.js';

/**
 * The stdio service (the main process's over its channel, or the agent server's own), with each
 * project's environment added to the agent processes and commands run in it (Project Settings >
 * Environment). Everything else passes straight through.
 */
export class ProjectEnvVoltStdioService implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly inner: IVoltStdioService;

	constructor(source: IChannel | IVoltStdioService) {
		this.inner = isStdioService(source) ? source : ProxyChannel.toService<IVoltStdioService>(source);
	}

	get onData() { return this.inner.onData; }
	get onExit() { return this.inner.onExit; }
	get onSandboxEvent() { return this.inner.onSandboxEvent; }

	spawn(options: IVoltStdioSpawnOptions): Promise<string> {
		const env = projectRunEnv(options.cwd);
		return this.inner.spawn(env ? { ...options, env: { ...env, ...options.env } } : options);
	}

	write(id: string, data: string): Promise<void> { return this.inner.write(id, data); }
	kill(id: string): Promise<void> { return this.inner.kill(id); }
	which(command: string): Promise<string | undefined> { return this.inner.which(command); }
	/** Commands get the project's environment too (a project's DOCKER_HOST or PATH additions). */
	exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		const env = projectRunEnv(request.cwd);
		return this.inner.exec(env ? { ...request, env: { ...env, ...request.env } } : request);
	}
	execFile(request: IVoltExecFileRequest): Promise<IVoltExecFileResult> {
		const env = projectRunEnv(request.cwd);
		return this.inner.execFile!(env ? { ...request, env: { ...env, ...request.env } } : request);
	}
	cancelExec(id: string): Promise<void> { return this.inner.cancelExec(id); }
	jobOutput(id: string, since?: number): Promise<IVoltJobOutput | undefined> { return this.inner.jobOutput(id, since); }
	jobWait(id: string, timeoutMs: number, until?: string, since?: number): Promise<IVoltJobOutput | undefined> { return this.inner.jobWait(id, timeoutMs, until, since); }
	listJobs(): Promise<readonly IVoltJobOutput[]> { return this.inner.listJobs(); }
	sandboxSupport(): Promise<IVoltSandboxSupportInfo> { return this.inner.sandboxSupport!(); }
	allowSandboxDomains(id: string, domains: readonly string[]): Promise<void> { return this.inner.allowSandboxDomains!(id, domains); }
	sandboxAllows(id: string, path: string, access: 'read' | 'write'): Promise<boolean> { return this.inner.sandboxAllows!(id, path, access); }
	/** Git runs with the user's environment only: HostGit drops anything that would redirect it. */
	git(request: IHostGitRequest): Promise<IHostGitResult> { return this.inner.git!(request); }
	buildEntryChanges(root: string): Promise<readonly IBuildEntryChange[]> { return this.inner.buildEntryChanges!(root); }
	acceptBuildEntries(root: string, paths?: readonly string[]): Promise<void> { return this.inner.acceptBuildEntries!(root, paths); }
	sandboxReadFile(id: string, path: string): Promise<IVoltSandboxFileResult> { return this.inner.sandboxReadFile!(id, path); }
	sandboxWriteFile(id: string, path: string, content: string): Promise<IVoltSandboxFileResult> { return this.inner.sandboxWriteFile!(id, path, content); }
	prepareSandboxedTerminal(request: IVoltSandboxedTerminalRequest): Promise<IVoltSandboxedTerminalLaunch> {
		const env = projectRunEnv(request.cwd);
		return this.inner.prepareSandboxedTerminal!(env ? { ...request, env: { ...env, ...request.env } } : request);
	}
	confirmSandboxedTerminal(id: string, pid: number): Promise<string> { return this.inner.confirmSandboxedTerminal!(id, pid); }
	endSandboxedTerminal(id: string): Promise<void> { return this.inner.endSandboxedTerminal!(id); }
	async syncSandboxState(id: string): Promise<IVoltSandboxStateSync | undefined> { return this.inner.syncSandboxState ? this.inner.syncSandboxState(id) : undefined; }
	get onDidChangeSandboxWorkloads() { return this.inner.onDidChangeSandboxWorkloads; }
	async sandboxWorkloads(): Promise<readonly ISandboxWorkloadInfo[]> { return this.inner.sandboxWorkloads ? this.inner.sandboxWorkloads() : []; }
	async stopSandboxWorkload(id: string): Promise<boolean> { return this.inner.stopSandboxWorkload ? this.inner.stopSandboxWorkload(id) : false; }
	/** A sandboxed chat's MCP server gets the project's environment too, as its unsandboxed spawn does. */
	spawnSandboxedMcp(request: IVoltSandboxedMcpRequest): Promise<string> {
		if (!this.inner.spawnSandboxedMcp) {
			// Refused, never started another way: this host cannot run sandboxed MCP servers.
			return Promise.reject(new VoltExecRefusedError({ kind: 'sandbox', step: 'disabled', reason: `Volt cannot run the ${request.server} MCP server in a sandbox here, so it was not started.` }));
		}
		const env = projectRunEnv(request.cwd);
		return this.inner.spawnSandboxedMcp(env ? { ...request, env: { ...env, ...request.env } } : request);
	}
	async stopSandboxedHosts(chatId: string): Promise<number> { return this.inner.stopSandboxedHosts ? this.inner.stopSandboxedHosts(chatId) : 0; }
	async approveSandboxDenial(id: string, denialId: string, expectedEpoch: number, scope: 'run' | 'chat'): Promise<IVoltSandboxApproval> {
		return this.inner.approveSandboxDenial ? this.inner.approveSandboxDenial(id, denialId, expectedEpoch, scope) : { ok: false, epoch: expectedEpoch, reason: 'this host has no network broker' };
	}
	async refuseSandboxDenial(id: string, denialId: string): Promise<boolean> { return this.inner.refuseSandboxDenial ? this.inner.refuseSandboxDenial(id, denialId) : false; }
	async trustState(): Promise<ITrustState> { return this.inner.trustState ? this.inner.trustState() : EMPTY_TRUST_STATE; }
	trustCommit(change: ITrustChange): Promise<ITrustCommitResult> {
		return this.inner.trustCommit ? this.inner.trustCommit(change) : Promise.reject(new Error('this host has no grant store'));
	}
	async trustHistory(limit: number, subject?: SubjectKey): Promise<readonly ITrustHistoryEntry[]> { return this.inner.trustHistory ? this.inner.trustHistory(limit, subject) : []; }
	async trustPromptBudgets(): Promise<readonly IVoltPromptBudget[]> { return this.inner.trustPromptBudgets ? this.inner.trustPromptBudgets() : []; }
	async resetPromptBudgets(subject?: SubjectKey): Promise<void> { await this.inner.resetPromptBudgets?.(subject); }
	get onDidChangeTrust() { return this.inner.onDidChangeTrust; }
}

function isStdioService(source: IChannel | IVoltStdioService): source is IVoltStdioService {
	return typeof (source as Partial<IVoltStdioService>).exec === 'function';
}
