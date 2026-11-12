/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, getRandomValues } from 'crypto';
import { createRequire } from 'node:module';
import * as net from 'net';
import { join } from '../../../base/common/path.js';
import { HOST_METHODS, CORE_METHODS, HOST_NOTIFICATIONS, PluginFileRoot, VOLT_PLUGIN_API_VERSIONS, VOLT_PLUGIN_PROTOCOL, VoltPluginError } from '../common/pluginProtocol.js';
import { PluginRpc } from '../common/pluginRpc.js';

/**
 * The inside of a T2 plugin host (spec H.1): runs in `pluginHostMain.js`, which the supervisor
 * starts as `<Volt> --disable-sigusr1 pluginHostMain.js` with `ELECTRON_RUN_AS_NODE=1`, in the OS
 * sandbox, with its channel on `VOLT_HOST_CHANNEL_FD`.
 *
 *   SES `lockdown()` -> open the channel -> `$/hello` (protocol and API versions; a mismatch
 *   exits 2) -> `host/activate` (core sends the bundle; its digest is checked) -> the bundle runs
 *   in a `Compartment` -> tool calls and context requests until the channel closes.
 *
 * The Compartment's only endowments are the `volt` API proxy, `console`, timers,
 * `TextEncoder`/`TextDecoder`, `URL`, `crypto.getRandomValues` and `WebAssembly`: no `require`, no
 * Node built-ins, no `process`. Everything the `volt` API does is a request to core on the
 * channel, where the Authority decides it; the host has no identity to claim (the channel is its
 * principal). SES is the inner wall; the OS sandbox around the process is the one that holds when
 * SES is escaped (CVE-2023-39532 is why).
 */

declare const lockdown: (options?: Record<string, unknown>) => void;
declare const harden: <T>(value: T) => T;
declare class Compartment {
	constructor(options?: { globals?: Record<string, unknown>; __options__?: true });
	evaluate(source: string): unknown;
	readonly globalThis: Record<string, unknown>;
}

export const PLUGIN_HOST_SDK = 'volt-t2-host/1.0.0';

/** A timer longer than this, or any interval, is a live resource: the host is not idle while it holds one (H.2). */
const LIVE_TIMER_MS = 60_000;
/** Exit codes: 2 a protocol or API mismatch at the handshake (H.3), 3 a broken channel, 4 a bundle that would not load. */
const EXIT_MISMATCH = 2;
const EXIT_CHANNEL = 3;

export interface IPluginHostRunOptions {
	/** The channel's fd (from `VOLT_HOST_CHANNEL_FD`). */
	readonly fd: number;
	/**
	 * Test builds only: extra endowments for the Compartment, so a test can simulate an SES escape
	 * (`test/node/fixtures/escapeHostMain.ts`) and show the OS sandbox still holds. The production
	 * entry (`pluginHostMain.ts`) never passes it.
	 */
	readonly testEndowments?: (channel: IPluginHostTestChannel) => Record<string, unknown>;
}

/** What an escaped plugin would reach of its own channel (test builds only): requests past the SDK, and raw bytes. */
export interface IPluginHostTestChannel {
	/** A request with exactly these params: no SDK in between, nothing dropped or copied. */
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params: unknown): void;
	/** Bytes written to the channel as they are, outside the host's RPC. */
	write(bytes: Uint8Array): void;
}

type ToolHandler = (args: Record<string, unknown>, context: unknown) => unknown;
type ContextProvider = (context: unknown) => unknown;

/** A plain, JSON-only copy of a value a plugin gave the API: no getters, proxies or prototypes reach the channel. */
function plain(value: unknown): unknown {
	if (value === undefined) {
		return undefined;
	}
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}

function message(error: unknown): string {
	if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return String(error);
}

export async function runPluginHost(options: IPluginHostRunOptions): Promise<void> {
	// SES before anything of the plugin's: the realm's intrinsics are frozen from here on.
	// Core names where `ses` is (a packaged build keeps it in node_modules.asar); else the usual lookup.
	const require = createRequire(import.meta.url);
	const ses = process.argv.find(arg => arg.startsWith('--ses='))?.slice('--ses='.length);
	require(ses ? join(ses, 'dist', 'ses.cjs') : 'ses');
	const started = performance.now();
	// Locale methods stay the host's (`localeTaming: 'unsafe'`): sorting and case must match core's
	// (notes are sorted with `localeCompare`); the locale is all they reveal.
	lockdown({ errorTaming: 'unsafe', consoleTaming: 'unsafe', stackFiltering: 'concise', overrideTaming: 'moderate', localeTaming: 'unsafe' });
	const lockdownMs = performance.now() - started;

	const socket = new net.Socket({ fd: options.fd, readable: true, writable: true });
	socket.on('error', () => process.exit(EXIT_CHANNEL));
	socket.on('close', () => process.exit(0));

	const tools = new Map<string, ToolHandler>();
	let contextProvider: ContextProvider | undefined;
	let activated = false;
	let live = 0;
	let reportedLive = 0;

	const rpc: PluginRpc = new PluginRpc({
		write: bytes => { socket.write(bytes); },
		remote: CORE_METHODS,
		handlers: {
			methods: HOST_METHODS,
			notifications: HOST_NOTIFICATIONS,
			handleRequest: async (method, params) => {
				switch (method) {
					case 'host/activate': return activate(params as { source: string; digest: string; id: string; tools: string[] });
					case 'tool/invoke': return invokeTool(params as { name: string; args: Record<string, unknown>; call?: string });
					case 'context/provide': return provideContext(params as { call?: string });
				}
				throw new VoltPluginError('NotFound', `no method ${method}`);
			},
		},
		onFatal: () => process.exit(EXIT_CHANNEL),
	});
	socket.on('data', (chunk: Buffer) => rpc.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));

	const notifyLive = () => {
		if (live !== reportedLive) {
			reportedLive = live;
			rpc.notify('host/live', { count: live });
		}
	};

	// --- the `volt` API: every call is a request on the channel -----------------------------------

	const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => rpc.request(method, plain(params));
	const filesFor = (call: string | undefined) => harden({
		read: async (root: PluginFileRoot, path: string): Promise<string | undefined> => {
			try {
				return ((await request('files/read', { root, path, ...(call ? { call } : {}) })) as { text?: string }).text;
			} catch (err) {
				if (err instanceof VoltPluginError && err.type === 'NotFound') {
					return undefined;
				}
				throw new Error(message(err));
			}
		},
		write: async (root: PluginFileRoot, path: string, text: string): Promise<{ created: boolean; path?: string }> => wrap(request('files/write', { root, path, text, ...(call ? { call } : {}) })) as Promise<{ created: boolean; path?: string }>,
		list: async (root: PluginFileRoot, path = ''): Promise<readonly { name: string; kind: 'file' | 'directory' }[]> => ((await wrap(request('files/list', { root, path, ...(call ? { call } : {}) }))) as { entries: { name: string; kind: 'file' | 'directory' }[] }).entries,
		delete: async (root: PluginFileRoot, path: string): Promise<boolean> => ((await wrap(request('files/delete', { root, path, ...(call ? { call } : {}) }))) as { deleted: boolean }).deleted,
	});
	/** Errors cross into the Compartment as plain `Error`s with the typed name: no host object leaks in. */
	const wrap = async (promise: Promise<unknown>): Promise<unknown> => {
		try {
			return await promise;
		} catch (err) {
			const error = new Error(message(err));
			error.name = err instanceof VoltPluginError ? err.type : 'Error';
			throw error;
		}
	};
	const storage = harden({
		read: async (path: string): Promise<string | undefined> => {
			try {
				return ((await request('storage/read', { path })) as { text?: string }).text;
			} catch (err) {
				if (err instanceof VoltPluginError && err.type === 'NotFound') {
					return undefined;
				}
				throw new Error(message(err));
			}
		},
		write: async (path: string, text: string): Promise<void> => { await wrap(request('storage/write', { path, text })); },
		list: async (dir = ''): Promise<readonly { name: string; kind: 'file' | 'directory' }[]> => ((await wrap(request('storage/list', { dir }))) as { entries: { name: string; kind: 'file' | 'directory' }[] }).entries,
		delete: async (path: string): Promise<boolean> => ((await wrap(request('storage/delete', { path }))) as { deleted: boolean }).deleted,
	});
	const log = (level: 'info' | 'warn' | 'error') => (...parts: unknown[]) => rpc.notify('log', { level, message: parts.map(part => typeof part === 'string' ? part : message(part)).join(' ').slice(0, 8192) });
	const volt = harden({
		apiVersion: '1.0.0',
		tools: {
			register: (name: string, handler: ToolHandler) => {
				if (activated) {
					throw new Error('tools are registered while the plugin activates');
				}
				if (typeof name !== 'string' || typeof handler !== 'function') {
					throw new TypeError('register(name, handler)');
				}
				tools.set(name, handler);
			},
		},
		context: {
			register: (provider: ContextProvider) => {
				if (typeof provider !== 'function') {
					throw new TypeError('register(provider)');
				}
				contextProvider = provider;
			},
		},
		storage,
		files: filesFor(undefined),
		log: { info: log('info'), warn: log('warn'), error: log('error') },
	});

	// --- timers: live resources are reported so the host is not stopped while it holds them --------

	const timers = new Map<unknown, boolean>();
	const track = (handle: unknown, isLive: boolean) => {
		timers.set(handle, isLive);
		if (isLive) {
			live++;
			notifyLive();
		}
	};
	const untrack = (handle: unknown) => {
		if (timers.get(handle)) {
			live--;
			notifyLive();
		}
		timers.delete(handle);
	};
	const endowedTimers = harden({
		setTimeout: (fn: () => void, ms?: number) => {
			const handle: { id?: ReturnType<typeof setTimeout> } = {};
			handle.id = setTimeout(() => { untrack(handle); fn(); }, ms);
			track(handle, (ms ?? 0) > LIVE_TIMER_MS);
			return handle;
		},
		clearTimeout: (handle: { id?: ReturnType<typeof setTimeout> }) => { if (handle?.id) { clearTimeout(handle.id); untrack(handle); } },
		setInterval: (fn: () => void, ms?: number) => {
			const handle: { id?: ReturnType<typeof setInterval> } = {};
			handle.id = setInterval(fn, Math.max(10, ms ?? 0));
			track(handle, true);
			return handle;
		},
		clearInterval: (handle: { id?: ReturnType<typeof setInterval> }) => { if (handle?.id) { clearInterval(handle.id); untrack(handle); } },
	});

	// --- the host's methods --------------------------------------------------------------------

	async function activate(params: { source: string; digest: string; id: string; tools: string[] }): Promise<{ tools: string[]; context: boolean }> {
		if (activated) {
			throw new VoltPluginError('InvalidArgument', 'this host already runs a plugin: one subject per process (H.6)');
		}
		if (createHash('sha256').update(params.source).digest('hex') !== params.digest) {
			throw new VoltPluginError('InvalidArgument', 'the bundle does not match its digest');
		}
		const consoleEndowment = harden({ log: log('info'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('info') });
		const compartment = new Compartment({
			globals: {
				volt,
				console: consoleEndowment,
				...endowedTimers,
				TextEncoder,
				TextDecoder,
				URL,
				crypto: harden({ getRandomValues: (array: Uint8Array) => getRandomValues(array) }),
				WebAssembly,
				...(options.testEndowments ? options.testEndowments({ request: (method, value) => rpc.request(method, value), notify: (method, value) => rpc.notify(method, value), write: bytes => { socket.write(bytes); } }) : {}),
			},
			__options__: true,
		});
		// The bundle is one CommonJS-style file (H.5): it sets `module.exports.activate`.
		const exports = compartment.evaluate(`(function () { const module = { exports: {} }; const exports = module.exports;\n${params.source}\n;return module.exports; })()`) as { activate?: (api: unknown) => unknown } | undefined;
		if (!exports || typeof exports.activate !== 'function') {
			throw new VoltPluginError('InvalidArgument', 'the bundle has no activate function');
		}
		await exports.activate(volt);
		activated = true;
		const declared = new Set(params.tools);
		const undeclared = [...tools.keys()].filter(name => !declared.has(name));
		for (const name of undeclared) {
			// The manifest is the source of truth for tools (H.2): a handler for anything else is dropped.
			tools.delete(name);
		}
		if (undeclared.length) {
			log('warn')(`tools not in the manifest were not registered: ${undeclared.join(', ')}`);
		}
		return { tools: [...tools.keys()], context: !!contextProvider };
	}

	function callContext(call: string | undefined): unknown {
		return harden({ ...(call ? { call } : {}), files: filesFor(call) });
	}

	async function invokeTool(params: { name: string; args: Record<string, unknown>; call?: string }): Promise<{ text?: string; error?: string }> {
		const handler = tools.get(params.name);
		if (!handler) {
			throw new VoltPluginError('NotFound', `this plugin has no tool ${params.name}`);
		}
		try {
			const result = await handler(harden(params.args), callContext(params.call));
			if (typeof result === 'string') {
				return { text: result };
			}
			const value = plain(result) as { text?: unknown; error?: unknown } | undefined;
			if (value && typeof value.error === 'string') {
				return { error: value.error.slice(0, 64 * 1024) };
			}
			return { text: value && typeof value.text === 'string' ? value.text : '' };
		} catch (err) {
			return { error: message(err).slice(0, 64 * 1024) };
		}
	}

	async function provideContext(params: { call?: string }): Promise<{ text?: string }> {
		if (!contextProvider) {
			return {};
		}
		const text = await contextProvider(callContext(params.call));
		return typeof text === 'string' && text ? { text: text.slice(0, 64 * 1024) } : {};
	}

	// --- the handshake ---------------------------------------------------------------------------

	try {
		const answer = await rpc.request('$/hello', { protocol: VOLT_PLUGIN_PROTOCOL, apiVersions: VOLT_PLUGIN_API_VERSIONS, sdk: PLUGIN_HOST_SDK }) as { protocol: string; apiVersion: string };
		if (answer.protocol !== VOLT_PLUGIN_PROTOCOL || !/^1\./.test(answer.apiVersion)) {
			process.exit(EXIT_MISMATCH);
		}
	} catch {
		process.exit(EXIT_MISMATCH);
	}
	rpc.notify('log', { level: 'info', message: `lockdown ${lockdownMs.toFixed(1)} ms` });
}
