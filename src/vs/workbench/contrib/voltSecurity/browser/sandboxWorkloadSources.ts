/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltAgentServerMainService } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { ISandboxWorkloadDenial, ISandboxWorkloadInfo } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';

/**
 * Where a window's sandboxed processes run. The desktop has two supervisors: its main process
 * (agents, commands, MCP servers, plugin hosts) and its local agent server, where opted-in
 * extensions run in their own sandboxed hosts (P6). A browser workbench's stdio already is the
 * server's. The Security page lists both, and the denial warnings watch both.
 */
export interface ISandboxWorkloadSource {
	readonly id: 'window' | 'agent-server';
	load(): Promise<readonly ISandboxWorkloadInfo[]>;
	stop(id: string): Promise<boolean>;
	/** When it pushes changes; a source without it is polled while it matters. */
	readonly onDidChange?: Event<void>;
}

export function sandboxWorkloadSources(accessor: ServicesAccessor): ISandboxWorkloadSource[] {
	const stdio = accessor.get(IVoltStdioService);
	const sources: ISandboxWorkloadSource[] = [];
	if (stdio.sandboxWorkloads) {
		sources.push({
			id: 'window',
			load: () => stdio.sandboxWorkloads!().catch(() => []),
			stop: id => (stdio.stopSandboxWorkload?.(id) ?? Promise.resolve(false)).catch(() => false),
			...(stdio.onDidChangeSandboxWorkloads ? { onDidChange: stdio.onDidChangeSandboxWorkloads } : {}),
		});
	}
	const server = isWeb ? undefined : accessor.get(IVoltAgentServerMainService);
	if (typeof server?.sandboxWorkloads === 'function') {
		sources.push({
			id: 'agent-server',
			load: () => server.sandboxWorkloads().catch(() => []),
			stop: id => server.stopSandboxWorkload(id).catch(() => false),
		});
	}
	return sources;
}

/** What the host tried, in a few words: "read ~/.ssh/id_ed25519", "connect to evil.example:443". */
export function describeSandboxDenial(denial: Pick<ISandboxWorkloadDenial, 'kind' | 'target'>): string {
	switch (denial.kind) {
		case 'read': return localize('voltDenial.read', "read {0}", denial.target);
		case 'write': return localize('voltDenial.write', "write {0}", denial.target);
		case 'network': {
			// The kernel's refusals carry no address: `localhost:<port>` (one of this machine's own
			// addresses, see seatbelt.ts) or `remote:*:<port>` (anywhere else, around Volt's proxy).
			const local = /^localhost:(\d+)$/.exec(denial.target);
			if (local) {
				return localize('voltDenial.networkLocal', "connect to port {0} on this machine", local[1]);
			}
			const direct = /^remote:\*:(\d+)$/.exec(denial.target);
			if (direct) {
				return localize('voltDenial.networkDirect', "connect directly to port {0}, around Volt's network filter", direct[1]);
			}
			return localize('voltDenial.network', "connect to {0}", denial.target);
		}
		case 'process': return localize('voltDenial.process', "start {0}", denial.target);
		case 'limit': return localize('voltDenial.limit', "go over its limit ({0})", denial.target);
		default: return denial.target;
	}
}
