/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * T2 plugin hosts as the rest of Volt sees them (spec H.1, H.9, F.13): the calls a window or the
 * agent server makes through the stdio service, the status rows for the crash UI, and the two
 * settings. Pure; the hosts themselves are `node/pluginHost.ts`.
 */

/** Built-in plugins that run in a T2 host: the extension id and its folder under `extensions/`. */
export const BUILTIN_T2_PLUGINS: readonly { readonly id: string; readonly folder: string }[] = [
	{ id: 'volt.memory', folder: 'volt-memory' },
];

export const MEMORY_PLUGIN_ID = 'volt.memory';

/**
 * Rollback (roadmap P1): off runs Volt's own plugins in-process, as before the T2 host. Read per
 * call; the in-process binding is labelled `Not sandboxed (setting)`.
 */
export const PLUGIN_SANDBOXED_HOSTS_SETTING = 'volt.plugins.sandboxedHosts';

/**
 * F.13 degraded mode, decided once per machine when the OS cannot sandbox at all (a static fact,
 * never a failed attestation): `allow` runs Volt's own plugins in-process, labelled
 * `Not sandboxed (OS unsupported)`; `deny` turns those features off; `ask` asks once.
 */
export const PLUGIN_UNSANDBOXED_FALLBACK_SETTING = 'volt.plugins.unsandboxedFallback';
export type PluginUnsandboxedFallback = 'ask' | 'allow' | 'deny';

export function readUnsandboxedFallback(value: unknown): PluginUnsandboxedFallback {
	return value === 'allow' || value === 'deny' ? value : 'ask';
}

/** What this execution host can do for T2 plugins, from static facts only (F.13). */
export interface IVoltPluginAvailability {
	/** A T2 host can be started here. */
	readonly sandboxed: boolean;
	/**
	 * Set when it can't, and why, if that is a static fact of this machine (no OS sandbox, an
	 * unsupported platform): only then may the degraded mode apply.
	 */
	readonly unsupported?: string;
	/** Set when it can't for another reason (the supervisor is turned off): the features refuse. */
	readonly refused?: string;
}

/** Core's record of the folders a call is about (never the plugin's say). */
export interface IVoltPluginFolders {
	/** The open workspace's first folder. */
	readonly workspace?: string;
	/** The chat's own folder for this call (its worktree, else its project). */
	readonly project?: string;
}

export interface IVoltPluginToolRequest {
	readonly plugin: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly folders?: IVoltPluginFolders;
}

export interface IVoltPluginToolResult {
	readonly text?: string;
	readonly error?: string;
}

export type VoltPluginState = 'stopped' | 'starting' | 'running' | 'idle' | 'restarting' | 'broken' | 'refused';

export interface IVoltPluginStatus {
	readonly id: string;
	readonly label: string;
	readonly state: VoltPluginState;
	readonly restarts: number;
	/** Why it is broken or refused. */
	readonly detail?: string;
	/** The last lines of its stderr (H.9: shown on its page). */
	readonly stderr?: string;
	readonly principalId?: string;
	readonly pid?: number;
	/** The last cold start: start to the plugin activated. */
	readonly coldStartMs?: number;
	/** Of which: spawn to the handshake. */
	readonly handshakeMs?: number;
}
