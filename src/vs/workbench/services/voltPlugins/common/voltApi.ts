/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltHostToolInfo, IVoltHostToolResult } from '../../voltRuntime/common/hostTools.js';
import { HOST_TOOL_SANDBOX_CLASSES } from '../../voltRuntime/common/hostToolSandbox.js';
import { ICapabilityReporter, ICapabilityRequest, IVoltPluginPrincipal, toolClassCapability, VoltCapabilityError } from './capabilities.js';
import { IVoltContributes, IVoltPluginManifest, IVoltToolContribution } from './voltContributions.js';

/**
 * The `volt.*` API a Volt feature or plugin gets through its `IVoltPluginContext` (spec H.11: a
 * feature imports only `base/`, its broker interfaces, this facade and the UI kit).
 *
 * Every method names the capability it uses (G.8) and asks the context's `ICapabilityReporter`
 * first. In report mode the call then runs as it does today; a call the manifest doesn't cover is
 * only logged. When the Policy Authority replaces the reporter, a refused call throws
 * `VoltCapabilityError` instead. The capability is decided here, from the method and its target,
 * never from anything the plugin passes as its identity.
 */

/** `engines.volt` ranges are checked against this (H.4). */
export const VOLT_API_VERSION = '1.0.0';

export type VoltToolHandler = (args: Record<string, unknown>, call: { readonly sessionId?: string }) => Promise<IVoltHostToolResult> | IVoltHostToolResult;
export type VoltCommandHandler = (...args: unknown[]) => unknown;

export interface IVoltToolsApi {
	/** Serves a tool the manifest declares in `contributes.voltTools` (`tools.register`, plus the capability its class implies). */
	register(name: string, handler: VoltToolHandler): IDisposable;
	/** The tools this plugin declares. */
	readonly declared: readonly IVoltToolContribution[];
}

/** The plugin's own key-value storage (`storage.own`), kept per profile. */
export interface IVoltStorageApi {
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): void;
	keys(): readonly string[];
}

/** Other chats, through the same tools agents use (`thread_*`). */
export interface IVoltAgentsApi {
	/** `agents.read:any`. */
	list(options?: { readonly project?: string; readonly query?: string }): Promise<IVoltHostToolResult>;
	/** `agents.read:any`; a chat's turns. */
	read(chatId: string): Promise<IVoltHostToolResult>;
	/** `agents.send`. */
	send(chatId: string, message: string): Promise<IVoltHostToolResult>;
	/** `agents.create`. */
	create(options: { readonly title: string; readonly message?: string; readonly model?: string }): Promise<IVoltHostToolResult>;
}

/** What the plugin shows (`ui.contribute`): its manifest entries, and whether each is on. */
export interface IVoltUiApi {
	readonly contributions: Pick<IVoltContributes, 'voltSlotItems' | 'voltSettingsPages' | 'voltSurfaces' | 'voltDock'>;
	isOn(part: 'item' | 'section' | 'surface' | 'dock', id: string): boolean;
}

/** Settings. Its own (`config.own`: keys its `voltModule.settings` name) need nothing; others are reported. */
export interface IVoltSettingsApi {
	get<T = unknown>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
	readonly onDidChange: Event<{ affects(key: string): boolean }>;
}

export interface IVoltCommandsApi {
	/** Its own commands (`commands.own`) need nothing; another's is `commands.execute:<id>`. */
	execute<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined>;
	/** Registers one of its own commands (`voltModule.commands`). */
	register(id: string, handler: VoltCommandHandler): IDisposable;
}

/**
 * A reference to a secret the plugin may use but never read (`secrets.use:<service>`). The value
 * stays in the secrets broker; a request names the ref and the broker adds the credential.
 */
export interface IVoltSecretRef {
	readonly service: string;
}

export interface IVoltNetRequest {
	readonly url: string;
	readonly method?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/** The broker authenticates the request with it. */
	readonly secret?: IVoltSecretRef;
}

export interface IVoltNetResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** Network through the broker (`net.connect` per host). Interface only until the network broker (P3). */
export interface IVoltNetApi {
	fetch(request: IVoltNetRequest): Promise<IVoltNetResponse>;
}

/** Secrets by reference. Interface only until the secrets broker (P3). */
export interface IVoltSecretsApi {
	ref(service: string): IVoltSecretRef;
}

export interface IVoltApi {
	readonly version: string;
	readonly tools: IVoltToolsApi;
	readonly storage: IVoltStorageApi;
	readonly agents: IVoltAgentsApi;
	readonly ui: IVoltUiApi;
	readonly settings: IVoltSettingsApi;
	readonly commands: IVoltCommandsApi;
	readonly net: IVoltNetApi;
	readonly secrets: IVoltSecretsApi;
}

/** What a feature or plugin gets when it activates. Disposing `subscriptions` unloads what it registered. */
export interface IVoltPluginContext {
	/** Set by core from the manifest it loaded, never by the plugin. */
	readonly extensionId: string;
	/** The `voltModule.feature` it carries, for a built-in feature. */
	readonly featureId?: string;
	readonly manifest: IVoltPluginManifest;
	readonly volt: IVoltApi;
	readonly subscriptions: DisposableStore;
}

/**
 * What the facade calls once a call is allowed: Volt's services as they are today. The window binds
 * it to workbench services (`voltPluginService.ts`); the brokers replace parts of it later.
 */
export interface IVoltApiBackend {
	registerTool(info: IVoltHostToolInfo, invoke: (args: Record<string, unknown>, sessionId: string | undefined) => Promise<IVoltHostToolResult>): IDisposable;
	invokeTool(name: string, args: Record<string, unknown>): Promise<IVoltHostToolResult>;
	storageGet(key: string): string | undefined;
	storageSet(key: string, value: string | undefined): void;
	storageKeys(prefix: string): readonly string[];
	getSetting(key: string): unknown;
	updateSetting(key: string, value: unknown): Promise<void>;
	readonly onDidChangeSettings: Event<{ affects(key: string): boolean }>;
	executeCommand(id: string, args: readonly unknown[]): Promise<unknown>;
	registerCommand(id: string, handler: VoltCommandHandler): IDisposable;
	isOn(part: 'item' | 'section' | 'surface' | 'dock', id: string): boolean;
}

/** The facade could not do this yet: the broker behind it isn't built. */
export class VoltApiUnavailableError extends Error {
	constructor(api: string, until: string) {
		super(`volt.${api} is not available yet (it arrives with ${until}).`);
		this.name = 'VoltApiUnavailableError';
	}
}

function matchesSetting(declared: readonly string[], key: string): boolean {
	return declared.some(setting => setting.endsWith('.') ? key.startsWith(setting) : key === setting);
}

/**
 * Builds the `volt` object for one plugin. `principal` comes from core's own record of the
 * manifest; every method checks with `reporter` before it calls `backend`.
 */
export function createVoltApi(principal: IVoltPluginPrincipal, manifest: IVoltPluginManifest, backend: IVoltApiBackend, reporter: ICapabilityReporter, subscriptions: DisposableStore): IVoltApi {
	const contributes = manifest.contributes ?? {};
	const ownCommands = contributes.voltModule?.commands ?? [];
	const ownSettings = contributes.voltModule?.settings ?? [];
	const declaredTools = contributes.voltTools ?? [];
	const storagePrefix = `volt.plugin.${principal.extensionId}.`;

	const check = (request: ICapabilityRequest): void => {
		const verdict = reporter.check(principal, request);
		if (!verdict.allowed) {
			const denial = verdict.denial;
			throw new VoltCapabilityError(request.capability, request.target, denial?.deniedBy ?? 'manifest', denial?.reason ?? `${request.capability} was denied`);
		}
	};

	const tools: IVoltToolsApi = {
		declared: declaredTools,
		register(name, handler) {
			check({ api: 'tools.register', capability: 'tools.register', target: name });
			const declared = declaredTools.find(tool => tool.name === name);
			// The class Volt knows for the name wins over a lower one; an undeclared tool is treated as escaping.
			const toolClass = Object.prototype.hasOwnProperty.call(HOST_TOOL_SANDBOX_CLASSES, name) ? HOST_TOOL_SANDBOX_CLASSES[name] : declared?.class ?? 'escapes';
			if (!declared) {
				check({ api: 'tools.register', capability: 'full', target: `undeclared tool ${name}` });
			}
			const implied = toolClassCapability(toolClass);
			if (implied !== 'tools.register') {
				check({ api: 'tools.register', capability: implied, target: name });
			}
			const info: IVoltHostToolInfo = {
				name,
				title: declared?.title ?? name,
				description: declared?.description ?? '',
				inputSchema: declared?.inputSchema ?? { type: 'object', properties: {} },
				...(declared?.approvalInReadOnlyModes ? { approvalInReadOnlyModes: declared.approvalInReadOnlyModes } : {}),
			};
			const registration = backend.registerTool(info, async (args, sessionId) => handler(args, { sessionId }));
			subscriptions.add(registration);
			return registration;
		},
	};

	const storage: IVoltStorageApi = {
		get<T>(key: string): T | undefined {
			check({ api: 'storage.get', capability: 'storage.own', target: key });
			const raw = backend.storageGet(storagePrefix + key);
			if (raw === undefined) {
				return undefined;
			}
			try {
				return JSON.parse(raw) as T;
			} catch {
				return undefined;
			}
		},
		set(key, value) {
			check({ api: 'storage.set', capability: 'storage.own', target: key });
			backend.storageSet(storagePrefix + key, value === undefined ? undefined : JSON.stringify(value));
		},
		delete(key) {
			check({ api: 'storage.delete', capability: 'storage.own', target: key });
			backend.storageSet(storagePrefix + key, undefined);
		},
		keys() {
			check({ api: 'storage.keys', capability: 'storage.own' });
			return backend.storageKeys(storagePrefix).map(key => key.slice(storagePrefix.length));
		},
	};

	const agents: IVoltAgentsApi = {
		list(options) {
			check({ api: 'agents.list', capability: 'agents.read:any' });
			return backend.invokeTool('thread_list', { ...(options?.project ? { project: options.project } : {}), ...(options?.query ? { query: options.query } : {}) });
		},
		read(chatId) {
			check({ api: 'agents.read', capability: 'agents.read:any', target: chatId });
			return backend.invokeTool('thread_read', { thread_id: chatId });
		},
		send(chatId, message) {
			check({ api: 'agents.send', capability: 'agents.send', target: chatId });
			return backend.invokeTool('thread_send', { thread_id: chatId, message });
		},
		create(options) {
			check({ api: 'agents.create', capability: 'agents.create' });
			return backend.invokeTool('thread_launch', { title: options.title, ...(options.message ? { message: options.message } : {}), ...(options.model ? { model: options.model } : {}) });
		},
	};

	const ui: IVoltUiApi = {
		contributions: {
			...(contributes.voltSlotItems ? { voltSlotItems: contributes.voltSlotItems } : {}),
			...(contributes.voltSettingsPages ? { voltSettingsPages: contributes.voltSettingsPages } : {}),
			...(contributes.voltSurfaces ? { voltSurfaces: contributes.voltSurfaces } : {}),
			...(contributes.voltDock ? { voltDock: contributes.voltDock } : {}),
		},
		isOn(part, id) {
			check({ api: 'ui.isOn', capability: 'ui.contribute', target: `${part}:${id}` });
			return backend.isOn(part, id);
		},
	};

	// A setting outside its own is not something the catalog grants: reported as `full` until the
	// Authority has a config capability.
	const settingCapability = (key: string) => matchesSetting(ownSettings, key) ? 'config.own' : 'full';
	const settings: IVoltSettingsApi = {
		get<T>(key: string): T | undefined {
			check({ api: 'settings.get', capability: settingCapability(key), target: key });
			return backend.getSetting(key) as T | undefined;
		},
		update(key, value) {
			check({ api: 'settings.update', capability: settingCapability(key), target: key });
			return backend.updateSetting(key, value);
		},
		onDidChange: backend.onDidChangeSettings,
	};

	const commands: IVoltCommandsApi = {
		async execute<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
			check({ api: 'commands.execute', capability: ownCommands.includes(id) ? 'commands.own' : `commands.execute:${id}`, target: id });
			return await backend.executeCommand(id, args) as T | undefined;
		},
		register(id, handler) {
			check({ api: 'commands.register', capability: ownCommands.includes(id) ? 'commands.own' : 'full', target: id });
			const registration = backend.registerCommand(id, handler);
			subscriptions.add(registration);
			return registration;
		},
	};

	const net: IVoltNetApi = {
		async fetch(request) {
			let host: string;
			try {
				host = new URL(request.url).host;
			} catch {
				host = request.url;
			}
			check({ api: 'net.fetch', capability: 'net.connect', target: host });
			if (request.secret) {
				check({ api: 'net.fetch', capability: `secrets.use:${request.secret.service}`, target: host });
			}
			throw new VoltApiUnavailableError('net.fetch', 'the network broker');
		},
	};

	const secrets: IVoltSecretsApi = {
		ref(service) {
			check({ api: 'secrets.ref', capability: `secrets.use:${service}`, target: service });
			return Object.freeze({ service });
		},
	};

	return Object.freeze({ version: VOLT_API_VERSION, tools, storage, agents, ui, settings, commands, net, secrets });
}

/** One extension's validated Volt contributions, as the window loaded them. */
export interface IVoltPluginEntry {
	readonly extensionId: string;
	readonly firstParty: boolean;
	readonly manifest: IVoltPluginManifest;
	/** Problems found in its Volt contribution points (those entries were left out). */
	readonly problems: readonly string[];
}

export const IVoltPluginService = createDecorator<IVoltPluginService>('voltPluginService');

/** Volt contributions of every enabled extension, and the contexts plugins activate with. */
export interface IVoltPluginService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly reporter: ICapabilityReporter;
	plugins(): readonly IVoltPluginEntry[];
	plugin(extensionId: string): IVoltPluginEntry | undefined;
	/**
	 * The context an enabled extension activates with; undefined when it isn't loaded. One per
	 * extension: its `subscriptions` are disposed when the extension goes away (disabled or removed).
	 */
	getContext(extensionId: string): IVoltPluginContext | undefined;
}
