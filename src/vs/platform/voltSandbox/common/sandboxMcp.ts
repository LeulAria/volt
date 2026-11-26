/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { composeSandboxPolicy, ISandboxCompositionNote } from './sandboxComposition.js';
import { isPathInside, IVoltSandboxRequest, normalizeSandboxPath, SANDBOX_CACHE_ENV } from './sandboxPolicy.js';
import { AGENT_ENV_INHERIT, agentSystemReadPaths, HOME_TOOLCHAIN_PATHS, isSecretEnvName } from './sandboxProfiles.js';
import { IVoltSandboxPolicy, IVoltSandboxPolicyLayer, networkEntryError } from './sandboxSchema.js';

/**
 * The T4-MCP policy (spec C.2, H.1, H.8, M.3 C6): a stdio MCP server Volt starts for a sandboxed
 * chat runs as its own principal (`mcp:<config digest>`) under the supervisor, with a policy that is
 * the chat's own policy narrowed, so it is never wider than the chat:
 * - reads: the system, the programs on PATH and the user's toolchains, and the chat's workspace;
 *   nothing else of the home folder (not the agent's state, not other projects);
 * - writes: the workspace only when the chat may write it, plus a private temp folder and the
 *   server's own storage (its package caches and `HOME`), both made by Volt for this server;
 * - network: the hosts approved for the server, through Volt's proxy and only those the chat may
 *   reach itself; none when it has none;
 * - no unix sockets, no OS services, no loopback ports, no listening;
 * - the environment is the agent allow list without `HOME`, plus what the server's config sets;
 * - H.8 quotas where the OS enforces them: 64 processes, 100 MB per file. Memory (512 MB) is
 *   polled by the supervisor, which also stops the server after 10 idle minutes.
 */

/** H.8, the T4 MCP row; and F.11's restart budget. */
export const MCP_HOST_QUOTAS = {
	memoryMB: 512,
	processes: 64,
	/** Per file (`RLIMIT_FSIZE`): the closest the OS comes to the storage quota. */
	fileSizeMB: 100,
	/** No traffic for this long: idle. */
	idleAfterMs: 60_000,
	/** No traffic for this long: stopped (the next tool use starts it again). */
	idleStopMs: 10 * 60_000,
	restartsPerMinute: 3,
} as const;

export interface IMcpHostPolicyInput {
	/** The server's name in its config, for the policy's name. */
	readonly server: string;
	/** The chat's compiled agent policy: the MCP policy is never wider. */
	readonly chat: IVoltSandboxPolicy;
	/** What the chat asked for: its level and workspace. */
	readonly request: IVoltSandboxRequest;
	readonly platform: string;
	/** Real path. */
	readonly home: string;
	/** Hosts approved for this server (its config, pinned by the project approval). */
	readonly allowedHosts: readonly string[];
}

export interface IMcpHostPolicy {
	readonly policy: IVoltSandboxPolicy;
	/** What the narrowing dropped because the chat does not allow it (an approved host the chat cannot reach). */
	readonly ignored: readonly ISandboxCompositionNote[];
}

/** The approved hosts that are hosts at all, lower-case, once each. */
export function mcpAllowedHosts(hosts: readonly unknown[] | undefined): string[] {
	const out = new Set<string>();
	for (const host of hosts ?? []) {
		if (typeof host !== 'string') {
			continue;
		}
		const value = host.trim().toLowerCase();
		if (value && value !== 'localhost' && value !== '*' && !networkEntryError(value)) {
			out.add(value);
		}
	}
	return [...out].sort();
}

export function mcpHostPolicy(input: IMcpHostPolicyInput): IMcpHostPolicy {
	const home = normalizeSandboxPath(input.home);
	const workspace = input.request.workspaceRoots.map(normalizeSandboxPath).filter(root => root.startsWith('/') && root !== '/' && !isPathInside(home, root));
	const hosts = mcpAllowedHosts(input.allowedHosts);
	const narrowing: IVoltSandboxPolicyLayer = {
		schemaVersion: 1,
		filesystem: {
			read: ['${system}', '${path}', ...agentSystemReadPaths(input.platform), ...HOME_TOOLCHAIN_PATHS.map(path => `${home}/${path}`), ...workspace],
			write: input.request.level === 'workspace-write' ? workspace.filter(root => !root.endsWith('/.git')) : [],
		},
		network: hosts.length
			? { mode: 'proxy', allow: hosts, loopbackPorts: [], listen: false, listenPorts: [] }
			: { mode: 'none', allow: [], loopbackPorts: [], listen: false, listenPorts: [] },
		process: { limits: { processes: MCP_HOST_QUOTAS.processes, fileSizeMB: MCP_HOST_QUOTAS.fileSizeMB } },
		env: { inherit: AGENT_ENV_INHERIT.filter(name => name !== 'HOME' && !isSecretEnvName(name)) },
		host: { unixSockets: [], systemServices: false },
	};
	// What Volt itself gives every server: its private temp and storage folders (made for it, holding
	// nothing of the user's), and `partial` instead of a refusal where the OS cannot count processes.
	const execution: IVoltSandboxPolicyLayer = {
		schemaVersion: 1,
		name: `mcp ${input.server}`,
		filesystem: { write: ['${tmp}', '${storage}'] },
		bestEffort: ['limits.processes'],
	};
	const composed = composeSandboxPolicy(input.chat, [
		{ source: 'execution', trusted: false, layer: narrowing },
		{ source: 'execution', trusted: true, layer: execution },
	]);
	const cacheEnv = Object.fromEntries(Object.entries(SANDBOX_CACHE_ENV).map(([name, sub]) => [name, `\${storage}/cache/${sub}`]));
	const policy: IVoltSandboxPolicy = {
		...composed.policy,
		// Not the chat's: its config overlay and package caches are the agent's, not the server's.
		env: { inherit: composed.policy.env.inherit, set: { ...cacheEnv, HOME: '${storage}/home', TMPDIR: '${tmp}' } },
	};
	return { policy, ignored: composed.ignored };
}
