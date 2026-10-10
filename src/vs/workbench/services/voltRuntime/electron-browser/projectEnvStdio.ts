/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltSandboxSupportInfo, IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../platform/voltStdio/common/voltStdio.js';
import { projectRunEnv } from '../common/projectRunEnv.js';

/**
 * The main-process stdio service, with each project's environment added to the agent processes
 * and commands run in it (Project Settings > Environment). Everything else passes straight through.
 */
export class ProjectEnvVoltStdioService implements IVoltStdioService {

	declare readonly _serviceBrand: undefined;

	private readonly inner: IVoltStdioService;

	constructor(channel: IChannel) {
		this.inner = ProxyChannel.toService<IVoltStdioService>(channel);
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
	cancelExec(id: string): Promise<void> { return this.inner.cancelExec(id); }
	jobOutput(id: string, since?: number): Promise<IVoltJobOutput | undefined> { return this.inner.jobOutput(id, since); }
	jobWait(id: string, timeoutMs: number, until?: string, since?: number): Promise<IVoltJobOutput | undefined> { return this.inner.jobWait(id, timeoutMs, until, since); }
	listJobs(): Promise<readonly IVoltJobOutput[]> { return this.inner.listJobs(); }
	sandboxSupport(): Promise<IVoltSandboxSupportInfo> { return this.inner.sandboxSupport!(); }
	allowSandboxDomains(id: string, domains: readonly string[]): Promise<void> { return this.inner.allowSandboxDomains!(id, domains); }
	sandboxAllows(id: string, path: string, access: 'read' | 'write'): Promise<boolean> { return this.inner.sandboxAllows!(id, path, access); }
}
