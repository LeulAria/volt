/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The declarative sandbox policy (schema version 1) and its strict parser.
 *
 * A policy says what a sandboxed workload may touch. It never says how: backends turn a resolved
 * policy into bubblewrap arguments or a Seatbelt profile. Parsing rejects anything it does not
 * understand (unknown fields, relative paths, `..`, control characters, non-NFC text, oversized
 * lists) instead of guessing, because a policy can come from an untrusted repository.
 *
 * See docs/security/sandbox/02-design.md for the reference.
 */

export const SANDBOX_POLICY_SCHEMA_VERSION = 1;

/** `none`: no network at all. `proxy`: only through Volt's filtering proxy. `host`: the machine's network, unfiltered. */
export type SandboxNetworkMode = 'none' | 'proxy' | 'host';

export const SANDBOX_NETWORK_MODES: readonly SandboxNetworkMode[] = ['none', 'proxy', 'host'];

/** Every policy dimension a backend may or may not enforce. */
export type SandboxDimension =
	| 'filesystem.read'
	| 'filesystem.write'
	| 'filesystem.deny'
	| 'filesystem.protect'
	| 'filesystem.protectNew'
	/** `**\/name` denies (`.env`) cover every match in the readable roots at launch (B-27). Mandatory unless best effort. */
	| 'filesystem.denyPatterns'
	| 'network.none'
	| 'network.proxy'
	| 'network.loopbackPorts'
	| 'network.listen'
	| 'host.unixSockets'
	| 'process.tree'
	| 'process.isolation'
	| 'syscalls'
	| 'env.clear'
	| 'limits.cpu'
	| 'limits.memory'
	| 'limits.processes'
	| 'limits.fileSize'
	| 'limits.openFiles'
	| 'limits.wallClock'
	/** macOS: the sandbox is its own TCC-responsible process and does not inherit Volt's privacy grants (B-13). */
	| 'platform.tcc';

export const SANDBOX_DIMENSIONS: readonly SandboxDimension[] = [
	'filesystem.read', 'filesystem.write', 'filesystem.deny', 'filesystem.protect', 'filesystem.protectNew', 'filesystem.denyPatterns',
	'network.none', 'network.proxy', 'network.loopbackPorts', 'network.listen',
	'host.unixSockets', 'process.tree', 'process.isolation', 'syscalls', 'env.clear',
	'limits.cpu', 'limits.memory', 'limits.processes', 'limits.fileSize', 'limits.openFiles', 'limits.wallClock',
	'platform.tcc',
];

export interface ISandboxFilesystemPolicy {
	/** Readable, with everything below. `/` means the whole filesystem except `deny`. */
	readonly read: readonly string[];
	/** Writable (and readable), with everything below. Never `/` or the home folder itself. */
	readonly write: readonly string[];
	/** Neither readable nor writable, even inside `read` or `write`. Accepts `**\/name` patterns. */
	readonly deny: readonly string[];
	/** Readable but never writable, even inside `write`. Accepts `**\/name` patterns. */
	readonly protect: readonly string[];
	/**
	 * Entries of the built-in credential denies this policy lifts (`${home}/.ssh`). Only honoured
	 * from a trusted layer; an untrusted layer that sets it is refused.
	 */
	readonly unmask: readonly string[];
}

export interface ISandboxNetworkPolicy {
	readonly mode: SandboxNetworkMode;
	/** With `proxy`: hosts the proxy lets through (`example.com`, `*.example.com`, `example.com:8443`, or `*` for every public host). */
	readonly allow: readonly string[];
	/** Host loopback TCP ports the workload may connect to directly (Volt's MCP server). */
	readonly loopbackPorts: readonly number[];
	/** May listen on any loopback port (trusted layers only; agent profiles never set it, B-30). */
	readonly listen: boolean;
	/** Loopback ports the workload may listen on, granted one by one (a dev server's port). */
	readonly listenPorts?: readonly number[];
}

export interface ISandboxLimits {
	readonly cpuSeconds?: number;
	readonly memoryMB?: number;
	readonly processes?: number;
	readonly fileSizeMB?: number;
	readonly openFiles?: number;
	readonly wallClockSeconds?: number;
}

export interface ISandboxProcessPolicy {
	readonly limits: ISandboxLimits;
}

export interface ISandboxEnvPolicy {
	/** Host variables copied in by name. `*` copies every variable that is not secret-like (trusted layers only). */
	readonly inherit: readonly string[];
	/** Variables set to fixed values. `${tmp}`-style tokens are expanded. */
	readonly set: Readonly<Record<string, string>>;
}

export interface ISandboxHostPolicy {
	/** Unix sockets the workload may connect to. Every other socket is unreachable. */
	readonly unixSockets: readonly string[];
	/**
	 * The OS's own services stay reachable (macOS: Keychain, launchd lookups, notifications), as
	 * agent CLIs need. On macOS this makes the Seatbelt base allow-by-default with explicit denies,
	 * which is weaker; Linux exposes no session services either way. Trusted layers only.
	 */
	readonly systemServices: boolean;
}

export interface IVoltSandboxPolicy {
	readonly schemaVersion: typeof SANDBOX_POLICY_SCHEMA_VERSION;
	/** Shown in diagnostics. */
	readonly name?: string;
	readonly filesystem: ISandboxFilesystemPolicy;
	readonly network: ISandboxNetworkPolicy;
	readonly process: ISandboxProcessPolicy;
	readonly env: ISandboxEnvPolicy;
	readonly host: ISandboxHostPolicy;
	/**
	 * Dimensions that may run unenforced when the backend cannot enforce them. The run is then
	 * reported `partial` with exactly these listed. Everything else is required: a backend that
	 * cannot enforce it refuses to run.
	 */
	readonly bestEffort: readonly SandboxDimension[];
}

/** A layer: any section or field may be absent, meaning "no change". */
export interface IVoltSandboxPolicyLayer {
	readonly schemaVersion: typeof SANDBOX_POLICY_SCHEMA_VERSION;
	readonly name?: string;
	readonly filesystem?: Partial<ISandboxFilesystemPolicy>;
	readonly network?: Partial<ISandboxNetworkPolicy>;
	readonly process?: { readonly limits?: ISandboxLimits };
	readonly env?: Partial<ISandboxEnvPolicy>;
	readonly host?: Partial<ISandboxHostPolicy>;
	readonly bestEffort?: readonly SandboxDimension[];
}

// --- Limits -------------------------------------------------------------------------------------

/** Bounds per limit: a policy outside them is malformed, not clamped. */
export const SANDBOX_LIMIT_BOUNDS: Readonly<Record<keyof ISandboxLimits, readonly [number, number]>> = {
	cpuSeconds: [1, 7 * 24 * 3600],
	memoryMB: [16, 1024 * 1024],
	processes: [1, 65536],
	fileSizeMB: [1, 1024 * 1024],
	openFiles: [16, 1024 * 1024],
	wallClockSeconds: [1, 7 * 24 * 3600],
};

const LIMIT_DIMENSION: Readonly<Record<keyof ISandboxLimits, SandboxDimension>> = {
	cpuSeconds: 'limits.cpu',
	memoryMB: 'limits.memory',
	processes: 'limits.processes',
	fileSizeMB: 'limits.fileSize',
	openFiles: 'limits.openFiles',
	wallClockSeconds: 'limits.wallClock',
};

export function limitDimension(limit: keyof ISandboxLimits): SandboxDimension {
	return LIMIT_DIMENSION[limit];
}

// --- Path entries -------------------------------------------------------------------------------

/**
 * Tokens a path may start with. The manager expands them per run:
 * - `${workspace}`: each workspace root of the run.
 * - `${home}`: the user's home folder (real path).
 * - `${tmp}`: a private temp folder made for this run and removed after it.
 * - `${storage}`: the workload's own persistent folder (an extension's storage).
 * - `${system}`: the platform's system folders (binaries, libraries, certificates), alone only.
 * - `${path}`: the install folders of the programs on the host PATH, alone only.
 */
export const SANDBOX_PATH_TOKENS = ['workspace', 'home', 'tmp', 'storage', 'system', 'path'] as const;
export type SandboxPathToken = typeof SANDBOX_PATH_TOKENS[number];
const STANDALONE_TOKENS: ReadonlySet<string> = new Set(['system', 'path']);

export const MAX_PATH_LENGTH = 4096;
export const MAX_LIST_ENTRIES = 256;
export const MAX_POLICY_BYTES = 256 * 1024;

/** A `**\/` pattern: one to four literal names matched at any depth below a writable root. */
const PATTERN_NAME = /^[^/*?[\]{}\\]+$/;

export type PathEntryKind = 'path' | 'pattern';

/** Why `entry` is not a valid path entry, or undefined when it is. */
export function pathEntryError(entry: unknown, allowPattern: boolean): string | undefined {
	if (typeof entry !== 'string') {
		return 'must be a string';
	}
	if (!entry.length || entry.length > MAX_PATH_LENGTH) {
		return `must be 1 to ${MAX_PATH_LENGTH} characters`;
	}
	if (/[\u0000-\u001f\u007f]/.test(entry)) {
		return 'must not contain control characters';
	}
	if (entry.normalize('NFC') !== entry) {
		return 'must be in Unicode NFC form';
	}
	if (entry.includes('\\')) {
		return 'must use forward slashes';
	}
	if (entry.startsWith('**/')) {
		if (!allowPattern) {
			return '`**/` patterns are only allowed in `deny` and `protect`';
		}
		const names = entry.slice(3).split('/');
		if (names.length > 4 || names.some(name => !PATTERN_NAME.test(name) || name === '.' || name === '..')) {
			return '`**/` must be followed by one to four literal names';
		}
		return undefined;
	}
	let rest: string;
	const token = /^\$\{([a-z]+)\}/.exec(entry);
	if (token) {
		if (!(SANDBOX_PATH_TOKENS as readonly string[]).includes(token[1])) {
			return `unknown token \${${token[1]}}`;
		}
		rest = entry.slice(token[0].length);
		if (STANDALONE_TOKENS.has(token[1]) && rest) {
			return `\${${token[1]}} must stand alone`;
		}
		if (rest && !rest.startsWith('/')) {
			return `\${${token[1]}} must be followed by "/" or nothing`;
		}
	} else if (entry.startsWith('/')) {
		rest = entry;
	} else {
		return 'must be absolute or start with a token such as ${workspace}';
	}
	if (rest.includes('$')) {
		return 'tokens are only allowed at the start';
	}
	if (rest === '/' && !token) {
		return undefined;
	}
	if (rest) {
		const segments = rest.slice(1).split('/');
		if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
			return 'must not contain empty, "." or ".." segments or a trailing slash';
		}
	}
	return undefined;
}

export function pathEntryKind(entry: string): PathEntryKind {
	return entry.startsWith('**/') ? 'pattern' : 'path';
}

// --- Network entries ----------------------------------------------------------------------------

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Why `entry` is not a valid network allow entry, or undefined. Hosts must be lower-case ASCII (punycode). */
export function networkEntryError(entry: unknown): string | undefined {
	if (typeof entry !== 'string') {
		return 'must be a string';
	}
	if (entry === '*') {
		return undefined;
	}
	if (entry.length > 260) {
		return 'is too long';
	}
	const { host, port } = splitAllowEntry(entry);
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
		return 'has an invalid port';
	}
	if (host !== host.toLowerCase()) {
		return 'must be lower case';
	}
	if (!HOSTNAME.test(host) && !IPV4.test(host)) {
		return 'must be a hostname (`example.com`, `*.example.com`), an IPv4 address, or `*`';
	}
	return undefined;
}

/** `example.com:8443` as host and port. */
export function splitAllowEntry(entry: string): { host: string; port?: number } {
	const colon = entry.lastIndexOf(':');
	if (colon > 0 && /^\d{1,5}$/.test(entry.slice(colon + 1))) {
		return { host: entry.slice(0, colon), port: Number(entry.slice(colon + 1)) };
	}
	return { host: entry };
}

// --- Environment entries ------------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const MAX_ENV_VALUE = 32 * 1024;

export function envNameError(name: unknown, allowStar: boolean): string | undefined {
	if (name === '*' && allowStar) {
		return undefined;
	}
	if (typeof name !== 'string' || !ENV_NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
		return 'must be a variable name ([A-Za-z_][A-Za-z0-9_]*)';
	}
	return undefined;
}

// --- Parser -------------------------------------------------------------------------------------

export interface ISandboxPolicyError {
	/** JSON path of the offending value: `filesystem.write[2]`. */
	readonly path: string;
	readonly message: string;
}

export type SandboxParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly errors: readonly ISandboxPolicyError[] };

const TOP_KEYS = ['schemaVersion', 'name', 'filesystem', 'network', 'process', 'env', 'host', 'bestEffort'];
const FILESYSTEM_KEYS = ['read', 'write', 'deny', 'protect', 'unmask'];
const NETWORK_KEYS = ['mode', 'allow', 'loopbackPorts', 'listen', 'listenPorts'];
const PROCESS_KEYS = ['limits'];
const LIMIT_KEYS = Object.keys(SANDBOX_LIMIT_BOUNDS);
const ENV_KEYS = ['inherit', 'set'];
const HOST_KEYS = ['unixSockets', 'systemServices'];

class PolicyReader {

	readonly errors: ISandboxPolicyError[] = [];

	fail(path: string, message: string): undefined {
		if (this.errors.length < 100) {
			this.errors.push({ path, message });
		}
		return undefined;
	}

	object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> | undefined {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return this.fail(path, 'must be an object');
		}
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!keys.includes(key)) {
				this.fail(path ? `${path}.${key}` : key, 'is not a known field');
			}
		}
		return record;
	}

	list<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T | undefined): T[] | undefined {
		if (!Array.isArray(value)) {
			return this.fail(path, 'must be an array');
		}
		if (value.length > MAX_LIST_ENTRIES) {
			return this.fail(path, `must have at most ${MAX_LIST_ENTRIES} entries`);
		}
		const out: T[] = [];
		value.forEach((entry, index) => {
			const parsed = item(entry, `${path}[${index}]`);
			if (parsed !== undefined && !out.includes(parsed)) {
				out.push(parsed);
			}
		});
		return out;
	}

	paths(value: unknown, path: string, allowPattern: boolean, forbidWriteRoots = false): string[] | undefined {
		return this.list(value, path, (entry, at) => {
			const error = pathEntryError(entry, allowPattern);
			if (error) {
				return this.fail(at, error);
			}
			const text = entry as string;
			if (forbidWriteRoots && (text === '/' || text === '${home}' || text === '${system}' || text === '${path}')) {
				return this.fail(at, 'must not make the whole filesystem, the home folder, system folders or PATH writable');
			}
			return text;
		});
	}
}

function readLimits(reader: PolicyReader, value: unknown, path: string): ISandboxLimits | undefined {
	const record = reader.object(value, path, LIMIT_KEYS);
	if (!record) {
		return undefined;
	}
	const limits: Record<string, number> = {};
	for (const key of LIMIT_KEYS) {
		const v = record[key];
		if (v === undefined) {
			continue;
		}
		const [min, max] = SANDBOX_LIMIT_BOUNDS[key as keyof ISandboxLimits];
		if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
			reader.fail(`${path}.${key}`, `must be an integer from ${min} to ${max}`);
			continue;
		}
		limits[key] = v;
	}
	return limits;
}

/** Reads one layer. Absent fields stay absent. */
function readLayer(input: unknown, reader: PolicyReader): IVoltSandboxPolicyLayer | undefined {
	const top = reader.object(input, '', TOP_KEYS);
	if (!top) {
		return undefined;
	}
	if (top.schemaVersion !== SANDBOX_POLICY_SCHEMA_VERSION) {
		reader.fail('schemaVersion', `must be ${SANDBOX_POLICY_SCHEMA_VERSION}`);
	}
	const layer: { -readonly [K in keyof IVoltSandboxPolicyLayer]: IVoltSandboxPolicyLayer[K] } = { schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION };
	if (top.name !== undefined) {
		if (typeof top.name !== 'string' || top.name.length > 120 || /[\u0000-\u001f\u007f]/.test(top.name)) {
			reader.fail('name', 'must be a short single-line string');
		} else {
			layer.name = top.name;
		}
	}
	if (top.filesystem !== undefined) {
		const fs = reader.object(top.filesystem, 'filesystem', FILESYSTEM_KEYS);
		if (fs) {
			const out: { -readonly [K in keyof ISandboxFilesystemPolicy]?: ISandboxFilesystemPolicy[K] } = {};
			if (fs.read !== undefined) { out.read = reader.paths(fs.read, 'filesystem.read', false); }
			if (fs.write !== undefined) { out.write = reader.paths(fs.write, 'filesystem.write', false, true); }
			if (fs.deny !== undefined) { out.deny = reader.paths(fs.deny, 'filesystem.deny', true); }
			if (fs.protect !== undefined) { out.protect = reader.paths(fs.protect, 'filesystem.protect', true); }
			if (fs.unmask !== undefined) { out.unmask = reader.paths(fs.unmask, 'filesystem.unmask', false); }
			layer.filesystem = out;
		}
	}
	if (top.network !== undefined) {
		const net = reader.object(top.network, 'network', NETWORK_KEYS);
		if (net) {
			const out: { -readonly [K in keyof ISandboxNetworkPolicy]?: ISandboxNetworkPolicy[K] } = {};
			if (net.mode !== undefined) {
				if (!SANDBOX_NETWORK_MODES.includes(net.mode as SandboxNetworkMode)) {
					reader.fail('network.mode', `must be one of ${SANDBOX_NETWORK_MODES.join(', ')}`);
				} else {
					out.mode = net.mode as SandboxNetworkMode;
				}
			}
			if (net.allow !== undefined) {
				out.allow = reader.list(net.allow, 'network.allow', (entry, at) => {
					const error = networkEntryError(entry);
					return error ? reader.fail(at, error) : entry as string;
				});
			}
			if (net.loopbackPorts !== undefined) {
				out.loopbackPorts = reader.list(net.loopbackPorts, 'network.loopbackPorts', (entry, at) =>
					typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 65535 ? entry : reader.fail(at, 'must be a port from 1 to 65535'));
			}
			if (net.listenPorts !== undefined) {
				out.listenPorts = reader.list(net.listenPorts, 'network.listenPorts', (entry, at) =>
					typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 65535 ? entry : reader.fail(at, 'must be a port from 1 to 65535'));
			}
			if (net.listen !== undefined) {
				if (typeof net.listen !== 'boolean') {
					reader.fail('network.listen', 'must be true or false');
				} else {
					out.listen = net.listen;
				}
			}
			layer.network = out;
		}
	}
	if (top.process !== undefined) {
		const proc = reader.object(top.process, 'process', PROCESS_KEYS);
		if (proc && proc.limits !== undefined) {
			layer.process = { limits: readLimits(reader, proc.limits, 'process.limits') };
		} else if (proc) {
			layer.process = {};
		}
	}
	if (top.env !== undefined) {
		const env = reader.object(top.env, 'env', ENV_KEYS);
		if (env) {
			const out: { -readonly [K in keyof ISandboxEnvPolicy]?: ISandboxEnvPolicy[K] } = {};
			if (env.inherit !== undefined) {
				out.inherit = reader.list(env.inherit, 'env.inherit', (entry, at) => {
					const error = envNameError(entry, true);
					return error ? reader.fail(at, error) : entry as string;
				});
			}
			if (env.set !== undefined) {
				const set = reader.object(env.set, 'env.set', Object.keys(env.set && typeof env.set === 'object' ? env.set : {}));
				if (set) {
					const entries: [string, string][] = [];
					for (const [name, value] of Object.entries(set)) {
						const error = envNameError(name, false);
						if (error) {
							reader.fail(`env.set.${name}`, error);
						} else if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || value.includes('\u0000')) {
							reader.fail(`env.set.${name}`, `must be a string of at most ${MAX_ENV_VALUE} characters without NUL`);
						} else {
							entries.push([name, value]);
						}
					}
					if (entries.length > MAX_LIST_ENTRIES) {
						reader.fail('env.set', `must have at most ${MAX_LIST_ENTRIES} variables`);
					}
					out.set = Object.fromEntries(entries);
				}
			}
			layer.env = out;
		}
	}
	if (top.host !== undefined) {
		const host = reader.object(top.host, 'host', HOST_KEYS);
		if (host) {
			const out: { -readonly [K in keyof ISandboxHostPolicy]?: ISandboxHostPolicy[K] } = {};
			if (host.unixSockets !== undefined) {
				out.unixSockets = reader.paths(host.unixSockets, 'host.unixSockets', false);
			}
			if (host.systemServices !== undefined) {
				if (typeof host.systemServices !== 'boolean') {
					reader.fail('host.systemServices', 'must be true or false');
				} else {
					out.systemServices = host.systemServices;
				}
			}
			layer.host = out;
		}
	}
	if (top.bestEffort !== undefined) {
		layer.bestEffort = reader.list(top.bestEffort, 'bestEffort', (entry, at) =>
			SANDBOX_DIMENSIONS.includes(entry as SandboxDimension) ? entry as SandboxDimension : reader.fail(at, 'is not a sandbox dimension'));
	}
	return layer;
}

/** A layer from untrusted input (a repository's `.volt/sandbox.json`, a request). */
export function parseSandboxPolicyLayer(input: unknown): SandboxParseResult<IVoltSandboxPolicyLayer> {
	const reader = new PolicyReader();
	const layer = readLayer(input, reader);
	return reader.errors.length || !layer ? { ok: false, errors: reader.errors } : { ok: true, value: layer };
}

/** A complete policy: absent fields take the most restrictive value (nothing readable, no network, no limits relaxed). */
export function parseSandboxPolicy(input: unknown): SandboxParseResult<IVoltSandboxPolicy> {
	const parsed = parseSandboxPolicyLayer(input);
	return parsed.ok ? { ok: true, value: completeSandboxPolicy(parsed.value) } : parsed;
}

/** JSON text, size-capped before parsing. */
export function parseSandboxPolicyText(text: string, asLayer: true): SandboxParseResult<IVoltSandboxPolicyLayer>;
export function parseSandboxPolicyText(text: string, asLayer: false): SandboxParseResult<IVoltSandboxPolicy>;
export function parseSandboxPolicyText(text: string, asLayer: boolean): SandboxParseResult<IVoltSandboxPolicyLayer | IVoltSandboxPolicy> {
	if (text.length > MAX_POLICY_BYTES) {
		return { ok: false, errors: [{ path: '', message: `policy is larger than ${MAX_POLICY_BYTES} bytes` }] };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		return { ok: false, errors: [{ path: '', message: `not valid JSON: ${(err as Error).message}` }] };
	}
	return asLayer ? parseSandboxPolicyLayer(value) : parseSandboxPolicy(value);
}

/** A layer with every absent field set to its most restrictive value. */
export function completeSandboxPolicy(layer: IVoltSandboxPolicyLayer): IVoltSandboxPolicy {
	return {
		schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION,
		...(layer.name ? { name: layer.name } : {}),
		filesystem: {
			read: layer.filesystem?.read ?? [],
			write: layer.filesystem?.write ?? [],
			deny: layer.filesystem?.deny ?? [],
			protect: layer.filesystem?.protect ?? [],
			unmask: layer.filesystem?.unmask ?? [],
		},
		network: {
			mode: layer.network?.mode ?? 'none',
			allow: layer.network?.allow ?? [],
			loopbackPorts: layer.network?.loopbackPorts ?? [],
			listen: layer.network?.listen ?? false,
			...(layer.network?.listenPorts?.length ? { listenPorts: layer.network.listenPorts } : {}),
		},
		process: { limits: { ...layer.process?.limits } },
		env: { inherit: layer.env?.inherit ?? [], set: { ...layer.env?.set } },
		host: { unixSockets: layer.host?.unixSockets ?? [], systemServices: layer.host?.systemServices ?? false },
		bestEffort: layer.bestEffort ?? [],
	};
}
