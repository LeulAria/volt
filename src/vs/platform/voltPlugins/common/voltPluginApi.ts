/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `volt` API a T2 plugin sees inside its Compartment (spec H.1): the types of the object the
 * host endows (`node/pluginHostRuntime.ts`). Every call is a `volt-plugin/1` request to core,
 * decided there by the Authority for this plugin's principal; nothing here names who is calling.
 *
 * A plugin is one bundled CommonJS-style file that sets `module.exports.activate(volt)`; it
 * registers its tool handlers (names from its manifest's `voltTools`) and, with `agents.context`
 * declared, a context provider, while it activates.
 */

export type VoltPluginFileRoot = 'workspace' | 'project' | 'home';

export interface IVoltPluginEntry {
	readonly name: string;
	readonly kind: 'file' | 'directory';
}

/** Files under a root core resolves for the call: `workspace` the open folder, `project` the chat's folder, `home` the user's. */
export interface IVoltPluginFiles {
	/** Undefined when the file does not exist. */
	read(root: VoltPluginFileRoot, path: string): Promise<string | undefined>;
	/** `path` is the absolute path written (for messages). */
	write(root: VoltPluginFileRoot, path: string, text: string): Promise<{ readonly created: boolean; readonly path?: string }>;
	list(root: VoltPluginFileRoot, path?: string): Promise<readonly IVoltPluginEntry[]>;
	delete(root: VoltPluginFileRoot, path: string): Promise<boolean>;
}

/** The plugin's own storage (`storage.own`). */
export interface IVoltPluginStorage {
	read(path: string): Promise<string | undefined>;
	write(path: string, text: string): Promise<void>;
	list(dir?: string): Promise<readonly IVoltPluginEntry[]>;
	delete(path: string): Promise<boolean>;
}

/** What a tool handler or context provider gets: the files of the call it serves. */
export interface IVoltPluginCallContext {
	readonly call?: string;
	readonly files: IVoltPluginFiles;
}

export type VoltPluginToolResult = string | { readonly text?: string; readonly error?: string };

export interface IVoltPluginApi {
	readonly apiVersion: string;
	readonly tools: {
		register(name: string, handler: (args: Readonly<Record<string, unknown>>, context: IVoltPluginCallContext) => VoltPluginToolResult | Promise<VoltPluginToolResult>): void;
	};
	readonly context: {
		register(provider: (context: IVoltPluginCallContext) => string | undefined | Promise<string | undefined>): void;
	};
	readonly storage: IVoltPluginStorage;
	/** Files outside a call (the open folder, the home folder). */
	readonly files: IVoltPluginFiles;
	readonly log: {
		info(...parts: unknown[]): void;
		warn(...parts: unknown[]): void;
		error(...parts: unknown[]): void;
	};
}
