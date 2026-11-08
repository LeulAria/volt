/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltPluginAvailability, IVoltPluginFolders, IVoltPluginStatus, IVoltPluginToolRequest, IVoltPluginToolResult } from '../../../../platform/voltPlugins/common/pluginHosts.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IBuildEntryChange, IHostGitRequest, IHostGitResult } from '../../../../platform/voltGit/common/hostGit.js';
import { IVoltExecFileRequest, IVoltExecFileResult, IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltSandboxedTerminalLaunch, IVoltSandboxedTerminalRequest, IVoltSandboxFileResult, IVoltSandboxStateSync, IVoltSandboxSupportInfo, IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../platform/voltStdio/common/voltStdio.js';
import type { ISandboxWorkloadInfo } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';
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
	get onDidChangePlugins() { return this.inner.onDidChangePlugins; }
	pluginAvailability(): Promise<IVoltPluginAvailability> { return this.inner.pluginAvailability ? this.inner.pluginAvailability() : Promise.resolve({ sandboxed: false, refused: 'This Volt has no plugin hosts.' }); }
	invokePluginTool(request: IVoltPluginToolRequest): Promise<IVoltPluginToolResult> { return this.inner.invokePluginTool ? this.inner.invokePluginTool(request) : Promise.resolve({ error: 'This Volt has no plugin hosts.' }); }
	async pluginContext(plugin: string, folders: IVoltPluginFolders): Promise<string | undefined> { return this.inner.pluginContext?.(plugin, folders); }
	async pluginStatus(): Promise<readonly IVoltPluginStatus[]> { return this.inner.pluginStatus ? this.inner.pluginStatus() : []; }
	async restartPlugin(plugin: string): Promise<void> { await this.inner.restartPlugin?.(plugin); }
}

function isStdioService(source: IChannel | IVoltStdioService): source is IVoltStdioService {
	return typeof (source as Partial<IVoltStdioService>).exec === 'function';
}
