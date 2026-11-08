/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `volt-plugin/1` (spec H.3): the wire between core and a T2 plugin host. Pure, so both ends (core
 * in `node/pluginHost.ts`, the host in `node/pluginHostMain.ts`) share one implementation.
 *
 * - Transport: the socketpair the supervisor gave the host. No other endpoint exists.
 * - Framing: a 4-byte big-endian length, then UTF-8 JSON; at most 16 MiB per frame. A binary
 *   payload is its own frame (the length's top bit set, then a 4-byte id) sent before the JSON
 *   frame that names it as `{ "$bin": id }`.
 * - Semantics: JSON-RPC 2.0 requests, responses and notifications, both directions.
 * - Identity: none in messages. The channel is the principal (INV-01); a payload with a field
 *   named `extensionId`, `principal` or `caller`, at any depth, is rejected.
 * - Validation: every method has a schema; unknown fields are rejected, strings must be NFC and
 *   are length-capped.
 * - Errors are typed (`VoltPluginErrorType`).
 */

export const VOLT_PLUGIN_PROTOCOL = 'volt-plugin/1';
/** The `volt` API this core serves; `engines.volt` ranges are checked against it (H.4). */
export const VOLT_PLUGIN_API_VERSION = '1.0.0';
/** What the handshake offers: every 1.x minor. */
export const VOLT_PLUGIN_API_VERSIONS: readonly string[] = ['1.x'];

export interface PluginProtocolLimits {
	readonly maxFrameBytes: number;
	readonly maxInFlight: number;
	readonly defaultDeadlineMs: number;
	readonly maxDeadlineMs: number;
	readonly callsPerSecond: number;
	readonly burst: number;
	readonly maxStringLength: number;
	readonly maxDepth: number;
	readonly maxPendingBinaries: number;
}

export const PLUGIN_PROTOCOL_LIMITS: PluginProtocolLimits = Object.freeze({
	/** Bytes of one frame's body. */
	maxFrameBytes: 16 * 1024 * 1024,
	/** Requests in flight per direction (H.3 backpressure). */
	maxInFlight: 64,
	/** A request's deadline unless the method (a tool) declares its own. */
	defaultDeadlineMs: 30_000,
	/** The longest deadline a tool may declare. */
	maxDeadlineMs: 10 * 60_000,
	/** Token bucket on incoming calls: refill per second, and the burst it holds (above Part L's 20k messages a second, 10k calls each way). */
	callsPerSecond: 10_000,
	burst: 10_000,
	/** A string without its own `maxLength`. */
	maxStringLength: 1024 * 1024,
	/** Nesting of any value. */
	maxDepth: 32,
	/** Binary frames waiting for the JSON frame that names them. */
	maxPendingBinaries: 64,
});

/** Field names no payload may carry (H.3): who a message is from is the channel's to say. */
export const IDENTITY_FIELDS: readonly string[] = ['extensionId', 'principal', 'caller'];

// --- errors ---------------------------------------------------------------------------------------

export type VoltPluginErrorType =
	/** The Authority (or a quota) refused: `capability`, `target`, `deniedBy` say which and why. */
	| 'VoltCapabilityError'
	| 'NotFound'
	| 'InvalidArgument'
	/** Over the in-flight limit or the call rate. */
	| 'RateLimited'
	| 'Internal'
	/** The caller cancelled (`$/cancel`), or the channel closed. */
	| 'Cancelled'
	/** The request passed its deadline. */
	| 'DeadlineExceeded';

const ERROR_CODES: Readonly<Record<VoltPluginErrorType, number>> = {
	VoltCapabilityError: -32001,
	NotFound: -32002,
	RateLimited: -32003,
	DeadlineExceeded: -32004,
	InvalidArgument: -32602,
	Internal: -32603,
	Cancelled: -32800,
};

export interface IVoltCapabilityErrorData {
	readonly capability: string;
	readonly target?: string;
	readonly deniedBy: string;
}

export class VoltPluginError extends Error {
	constructor(
		readonly type: VoltPluginErrorType,
		message: string,
		readonly capability?: IVoltCapabilityErrorData,
	) {
		super(message);
		this.name = type;
	}

	get code(): number {
		return ERROR_CODES[this.type];
	}

	toJSON(): IRpcErrorObject {
		return { code: this.code, message: this.message, data: { type: this.type, ...(this.capability ?? {}) } };
	}

	static from(error: unknown): VoltPluginError {
		if (error instanceof VoltPluginError) {
			return error;
		}
		return new VoltPluginError('Internal', error instanceof Error ? error.message : String(error));
	}

	/** The error a response carries, as a typed error (an unknown type is `Internal`). */
	static fromObject(value: IRpcErrorObject): VoltPluginError {
		const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {};
		const type = typeof data.type === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, data.type) ? data.type as VoltPluginErrorType : 'Internal';
		const message = typeof value.message === 'string' ? value.message.slice(0, 4096) : 'error';
		if (type === 'VoltCapabilityError' && typeof data.capability === 'string' && typeof data.deniedBy === 'string') {
			return new VoltPluginError(type, message, { capability: data.capability, deniedBy: data.deniedBy, ...(typeof data.target === 'string' ? { target: data.target } : {}) });
		}
		return new VoltPluginError(type, message);
	}
}

// --- JSON-RPC shapes ------------------------------------------------------------------------------

export interface IRpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface IRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

export interface IRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

export interface IRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly result?: unknown;
	readonly error?: IRpcErrorObject;
}

export type RpcMessage = IRpcRequest | IRpcNotification | IRpcResponse;

// --- schemas --------------------------------------------------------------------------------------

/** The schema language every method's params and results are checked with: a small, closed JSON Schema subset. */
export type PluginSchema =
	| { readonly type: 'object'; readonly properties: Readonly<Record<string, PluginSchema>>; readonly required?: readonly string[]; /** A map: any key, each value this schema. */ readonly values?: PluginSchema; readonly maxProperties?: number }
	| { readonly type: 'string'; readonly maxLength?: number; readonly enum?: readonly string[]; readonly pattern?: RegExp }
	| { readonly type: 'integer'; readonly minimum?: number; readonly maximum?: number }
	| { readonly type: 'boolean' }
	| { readonly type: 'array'; readonly items: PluginSchema; readonly maxItems?: number }
	| { readonly type: 'bytes'; readonly maxBytes?: number }
	/** Any JSON value (a tool's arguments): bounded in depth, every string and key checked. */
	| { readonly type: 'json' };

function invalid(path: string, message: string): VoltPluginError {
	return new VoltPluginError('InvalidArgument', `${path || 'params'}: ${message}`);
}

function checkString(value: string, path: string, max: number): void {
	if (value.length > max) {
		throw invalid(path, `longer than ${max} characters`);
	}
	if (value.normalize('NFC') !== value) {
		throw invalid(path, 'not in Unicode NFC form');
	}
}

function checkKey(key: string, path: string, limits: PluginProtocolLimits): void {
	if (IDENTITY_FIELDS.includes(key)) {
		throw invalid(path ? `${path}.${key}` : key, 'identity is the channel\'s: a payload may not name an extensionId, principal or caller');
	}
	checkString(key, path, 256);
	void limits;
}

/**
 * Throws an `InvalidArgument` unless `value` is exactly what `schema` describes: unknown fields,
 * identity fields at any depth, non-NFC or over-long strings, and anything nested too deep are
 * all refused.
 */
export function validatePluginValue(value: unknown, schema: PluginSchema, path = '', limits: PluginProtocolLimits = PLUGIN_PROTOCOL_LIMITS, depth = 0): void {
	if (depth > limits.maxDepth) {
		throw invalid(path, `nested deeper than ${limits.maxDepth}`);
	}
	switch (schema.type) {
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
				throw invalid(path, 'must be an object');
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record);
			if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
				throw invalid(path, `more than ${schema.maxProperties} fields`);
			}
			for (const key of keys) {
				checkKey(key, path, limits);
				const child = Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : schema.values;
				if (!child) {
					throw invalid(path ? `${path}.${key}` : key, 'unknown field');
				}
				if (record[key] !== undefined) {
					validatePluginValue(record[key], child, path ? `${path}.${key}` : key, limits, depth + 1);
				}
			}
			for (const key of schema.required ?? []) {
				if (record[key] === undefined) {
					throw invalid(path ? `${path}.${key}` : key, 'is required');
				}
			}
			return;
		}
		case 'string':
			if (typeof value !== 'string') {
				throw invalid(path, 'must be a string');
			}
			checkString(value, path, schema.maxLength ?? limits.maxStringLength);
			if (schema.enum && !schema.enum.includes(value)) {
				throw invalid(path, `must be one of ${schema.enum.join(', ')}`);
			}
			if (schema.pattern && !schema.pattern.test(value)) {
				throw invalid(path, 'is not in the expected form');
			}
			return;
		case 'integer':
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
				throw invalid(path, `must be a whole number${schema.minimum !== undefined ? ` from ${schema.minimum}` : ''}${schema.maximum !== undefined ? ` to ${schema.maximum}` : ''}`);
			}
			return;
		case 'boolean':
			if (typeof value !== 'boolean') {
				throw invalid(path, 'must be true or false');
			}
			return;
		case 'array':
			if (!Array.isArray(value)) {
				throw invalid(path, 'must be an array');
			}
			if (schema.maxItems !== undefined && value.length > schema.maxItems) {
				throw invalid(path, `more than ${schema.maxItems} items`);
			}
			value.forEach((item, i) => validatePluginValue(item, schema.items, `${path}[${i}]`, limits, depth + 1));
			return;
		case 'bytes':
			if (!(value instanceof Uint8Array)) {
				throw invalid(path, 'must be bytes');
			}
			if (schema.maxBytes !== undefined && value.byteLength > schema.maxBytes) {
				throw invalid(path, `more than ${schema.maxBytes} bytes`);
			}
			return;
		case 'json':
			checkJson(value, path, limits, depth);
			return;
	}
}

function checkJson(value: unknown, path: string, limits: PluginProtocolLimits, depth: number): void {
	if (depth > limits.maxDepth) {
		throw invalid(path, `nested deeper than ${limits.maxDepth}`);
	}
	if (value === null || typeof value === 'boolean') {
		return;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw invalid(path, 'must be a finite number');
		}
		return;
	}
	if (typeof value === 'string') {
		checkString(value, path, limits.maxStringLength);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, i) => checkJson(item, `${path}[${i}]`, limits, depth + 1));
		return;
	}
	if (typeof value === 'object' && !(value instanceof Uint8Array)) {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			checkKey(key, path, limits);
			checkJson(item, path ? `${path}.${key}` : key, limits, depth + 1);
		}
		return;
	}
	throw invalid(path, 'must be a JSON value');
}

/** Rejects any payload that names an identity field, wherever it is (H.3), without a schema. */
export function assertNoIdentityFields(value: unknown, path = '', depth = 0): void {
	if (depth > PLUGIN_PROTOCOL_LIMITS.maxDepth || !value || typeof value !== 'object' || value instanceof Uint8Array) {
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, i) => assertNoIdentityFields(item, `${path}[${i}]`, depth + 1));
		return;
	}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (IDENTITY_FIELDS.includes(key)) {
			throw invalid(path ? `${path}.${key}` : key, 'identity is the channel\'s: a payload may not name an extensionId, principal or caller');
		}
		assertNoIdentityFields(item, path ? `${path}.${key}` : key, depth + 1);
	}
}

// --- framing --------------------------------------------------------------------------------------

/** The length word's top bit: the frame is binary (a 4-byte id, then the bytes). */
const BINARY_FLAG = 0x80000000;

/** A fatal error of the stream itself (a frame over the limit, bytes that are not JSON): the channel closes. */
export class PluginProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PluginProtocolError';
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function header(length: number, binary: boolean): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, (binary ? BINARY_FLAG : 0) + length, false);
	return out;
}

/**
 * The frames for one message: a binary frame for each `Uint8Array` in it, then the JSON frame that
 * names them. Throws `InvalidArgument` for a frame over the limit (nothing is sent then).
 */
export function encodeMessage(message: RpcMessage, nextBinaryId: () => number, limits: PluginProtocolLimits = PLUGIN_PROTOCOL_LIMITS): Uint8Array[] {
	const frames: Uint8Array[] = [];
	const text = JSON.stringify(message, (_key, value) => {
		if (value instanceof Uint8Array) {
			if (value.byteLength + 4 > limits.maxFrameBytes) {
				throw new VoltPluginError('InvalidArgument', `a binary payload is larger than ${limits.maxFrameBytes} bytes`);
			}
			const id = nextBinaryId();
			const idBytes = new Uint8Array(4);
			new DataView(idBytes.buffer).setUint32(0, id, false);
			frames.push(header(value.byteLength + 4, true), idBytes, value);
			return { $bin: id };
		}
		return value;
	});
	const body = encoder.encode(text);
	if (body.byteLength > limits.maxFrameBytes) {
		throw new VoltPluginError('InvalidArgument', `the message is larger than ${limits.maxFrameBytes} bytes`);
	}
	frames.push(header(body.byteLength, false), body);
	return frames;
}

/**
 * Turns the byte stream into messages. `push` returns the messages complete so far and throws a
 * {@link PluginProtocolError} for a frame over the limit, a body that is not UTF-8 JSON, or a
 * reference to a binary frame that never came: the stream is then unusable.
 */
export class FrameDecoder {

	private chunks: Uint8Array[] = [];
	private buffered = 0;
	private readonly binaries = new Map<number, Uint8Array>();

	constructor(private readonly limits: PluginProtocolLimits = PLUGIN_PROTOCOL_LIMITS) { }

	push(chunk: Uint8Array): unknown[] {
		this.chunks.push(chunk);
		this.buffered += chunk.byteLength;
		const out: unknown[] = [];
		while (this.buffered >= 4) {
			const word = new DataView(this.peek(4).buffer).getUint32(0, false);
			const binary = (word & BINARY_FLAG) !== 0;
			const length = word & ~BINARY_FLAG;
			if (length > this.limits.maxFrameBytes + (binary ? 4 : 0)) {
				throw new PluginProtocolError(`a frame of ${length} bytes is over the ${this.limits.maxFrameBytes}-byte limit`);
			}
			if (this.buffered < 4 + length) {
				break;
			}
			this.take(4);
			const body = this.take(length);
			if (binary) {
				if (length < 4) {
					throw new PluginProtocolError('a binary frame without its id');
				}
				if (this.binaries.size >= this.limits.maxPendingBinaries) {
					throw new PluginProtocolError('too many binary frames without the message that names them');
				}
				this.binaries.set(new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false), body.slice(4));
				continue;
			}
			let text: string;
			try {
				text = decoder.decode(body);
			} catch {
				throw new PluginProtocolError('a frame is not UTF-8');
			}
			let value: unknown;
			try {
				value = JSON.parse(text, (_key, item) => {
					if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.$bin === 'number' && Object.keys(item).length === 1) {
						const bytes = this.binaries.get(item.$bin);
						if (!bytes) {
							throw new PluginProtocolError(`a message names binary frame ${item.$bin}, which did not come before it`);
						}
						this.binaries.delete(item.$bin);
						return bytes;
					}
					return item;
				});
			} catch (err) {
				throw err instanceof PluginProtocolError ? err : new PluginProtocolError('a frame is not JSON');
			}
			out.push(value);
		}
		return out;
	}

	private peek(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let at = 0;
		for (const chunk of this.chunks) {
			const part = chunk.subarray(0, n - at);
			out.set(part, at);
			at += part.byteLength;
			if (at === n) {
				break;
			}
		}
		return out;
	}

	private take(n: number): Uint8Array {
		const first = this.chunks[0];
		if (first && first.byteLength >= n) {
			const out = first.subarray(0, n);
			if (first.byteLength === n) {
				this.chunks.shift();
			} else {
				this.chunks[0] = first.subarray(n);
			}
			this.buffered -= n;
			return out;
		}
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const chunk = this.chunks[0];
			const part = chunk.subarray(0, n - at);
			out.set(part, at);
			at += part.byteLength;
			if (part.byteLength === chunk.byteLength) {
				this.chunks.shift();
			} else {
				this.chunks[0] = chunk.subarray(part.byteLength);
			}
		}
		this.buffered -= n;
		return out;
	}
}

/** What a frame is, by shape: anything else is a protocol error. */
export function classifyMessage(value: unknown): { kind: 'request'; message: IRpcRequest } | { kind: 'notification'; message: IRpcNotification } | { kind: 'response'; message: IRpcResponse } | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
		return undefined;
	}
	const message = value as Record<string, unknown>;
	const id = message.id;
	const hasId = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
	if (typeof message.method === 'string') {
		if (message.method.length > 128) {
			return undefined;
		}
		return hasId ? { kind: 'request', message: value as IRpcRequest } : message.id === undefined ? { kind: 'notification', message: value as IRpcNotification } : undefined;
	}
	if (hasId && ('result' in message || (message.error && typeof message.error === 'object'))) {
		return { kind: 'response', message: value as IRpcResponse };
	}
	return undefined;
}

// --- the methods both ends speak ------------------------------------------------------------------

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** A relative path below a root: segments of letters, digits, `.`, `_` and `-`, no `.` or `..` segment. */
export const RELATIVE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;
const PATH: PluginSchema = { type: 'string', maxLength: 512, pattern: RELATIVE_PATH };
const DIR: PluginSchema = { type: 'string', maxLength: 512, pattern: /^(?:|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7})$/ };
const TEXT: PluginSchema = { type: 'string', maxLength: 4 * 1024 * 1024 };
const CALL: PluginSchema = { type: 'string', maxLength: 64, pattern: /^[A-Za-z0-9_-]{1,64}$/ };
/** Folders `files/*` names: the open workspace's first folder, the chat's folder for this call, the user's home. */
export const PLUGIN_FILE_ROOTS = ['workspace', 'project', 'home'] as const;
export type PluginFileRoot = typeof PLUGIN_FILE_ROOTS[number];
const ROOT: PluginSchema = { type: 'string', enum: PLUGIN_FILE_ROOTS };
const ENTRIES: PluginSchema = { type: 'object', properties: { entries: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { name: { type: 'string', maxLength: 255 }, kind: { type: 'string', enum: ['file', 'directory'] } }, required: ['name', 'kind'] } } }, required: ['entries'] };
const EMPTY: PluginSchema = { type: 'object', properties: {} };

export interface IPluginMethod {
	readonly params: PluginSchema;
	readonly result: PluginSchema;
}

/** Methods the host calls on core (the `volt` API's storage, files and context halves). */
export const CORE_METHODS: Readonly<Record<string, IPluginMethod>> = Object.freeze({
	'$/hello': {
		params: { type: 'object', properties: { protocol: { type: 'string', maxLength: 64 }, apiVersions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } }, sdk: { type: 'string', maxLength: 64 } }, required: ['protocol', 'apiVersions'] },
		result: { type: 'object', properties: { protocol: { type: 'string' }, apiVersion: { type: 'string' } }, required: ['protocol', 'apiVersion'] },
	},
	'storage/read': {
		params: { type: 'object', properties: { path: PATH }, required: ['path'] },
		result: { type: 'object', properties: { text: TEXT } },
	},
	'storage/write': {
		params: { type: 'object', properties: { path: PATH, text: TEXT }, required: ['path', 'text'] },
		result: EMPTY,
	},
	'storage/list': {
		params: { type: 'object', properties: { dir: DIR } },
		result: ENTRIES,
	},
	'storage/delete': {
		params: { type: 'object', properties: { path: PATH }, required: ['path'] },
		result: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] },
	},
	'files/read': {
		params: { type: 'object', properties: { root: ROOT, path: PATH, call: CALL }, required: ['root', 'path'] },
		result: { type: 'object', properties: { text: TEXT } },
	},
	'files/write': {
		params: { type: 'object', properties: { root: ROOT, path: PATH, text: TEXT, call: CALL }, required: ['root', 'path', 'text'] },
		result: { type: 'object', properties: { created: { type: 'boolean' }, path: { type: 'string', maxLength: 4096 } }, required: ['created'] },
	},
	'files/list': {
		params: { type: 'object', properties: { root: ROOT, path: DIR, call: CALL }, required: ['root'] },
		result: ENTRIES,
	},
	'files/delete': {
		params: { type: 'object', properties: { root: ROOT, path: PATH, call: CALL }, required: ['root', 'path'] },
		result: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] },
	},
});

/** Notifications the host sends core. */
export const CORE_NOTIFICATIONS: Readonly<Record<string, PluginSchema>> = Object.freeze({
	'$/cancel': { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] },
	/** Live resources the host holds (timers over 60 s, intervals): while any are, it is not idle (H.2). */
	'host/live': { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 1_000_000 } }, required: ['count'] },
	'log': { type: 'object', properties: { level: { type: 'string', enum: ['info', 'warn', 'error'] }, message: { type: 'string', maxLength: 8192 } }, required: ['level', 'message'] },
});

const TOOL_RESULT: PluginSchema = { type: 'object', properties: { text: TEXT, error: { type: 'string', maxLength: 64 * 1024 } } };

/** Methods core calls on the host. */
export const HOST_METHODS: Readonly<Record<string, IPluginMethod>> = Object.freeze({
	'host/activate': {
		params: {
			type: 'object',
			properties: {
				source: { type: 'string', maxLength: 8 * 1024 * 1024 },
				digest: { type: 'string', pattern: /^[0-9a-f]{64}$/ },
				id: { type: 'string', maxLength: 128 },
				tools: { type: 'array', maxItems: 256, items: { type: 'string', pattern: NAME } },
			},
			required: ['source', 'digest', 'id', 'tools'],
		},
		result: { type: 'object', properties: { tools: { type: 'array', maxItems: 256, items: { type: 'string', pattern: NAME } }, context: { type: 'boolean' } }, required: ['tools', 'context'] },
	},
	'tool/invoke': {
		params: { type: 'object', properties: { name: { type: 'string', pattern: NAME }, args: { type: 'object', properties: {}, values: { type: 'json' }, maxProperties: 256 }, call: CALL }, required: ['name', 'args'] },
		result: TOOL_RESULT,
	},
	'context/provide': {
		params: { type: 'object', properties: { call: CALL } },
		result: { type: 'object', properties: { text: { type: 'string', maxLength: 64 * 1024 } } },
	},
});

export const HOST_NOTIFICATIONS: Readonly<Record<string, PluginSchema>> = Object.freeze({
	'$/cancel': { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] },
});

/** Whether `version` (x.y.z) satisfies `range` (`*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `1.x`). */
export function apiVersionSatisfies(version: string, range: string): boolean {
	const parse = (text: string) => {
		const match = /^(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(text.trim());
		return match ? [Number(match[1]), match[2] === 'x' || match[2] === undefined ? undefined : Number(match[2]), match[3] === 'x' || match[3] === undefined ? undefined : Number(match[3])] as const : undefined;
	};
	const v = parse(version);
	const spec = range.trim();
	if (!v || v[1] === undefined || v[2] === undefined) {
		return false;
	}
	if (spec === '*' || spec === 'x') {
		return true;
	}
	const op = /^(\^|~|>=)?\s*(.*)$/.exec(spec)!;
	const r = parse(op[2]);
	if (!r) {
		return false;
	}
	const [major, minor = 0, patch = 0] = [r[0], r[1] ?? 0, r[2] ?? 0];
	const cmp = v[0] - major || v[1] - minor || v[2] - patch;
	switch (op[1]) {
		case '>=': return cmp >= 0;
		case '^': return v[0] === major && (major !== 0 || v[1] === minor) && cmp >= 0;
		case '~': return v[0] === major && v[1] === minor && cmp >= 0;
		default:
			// `1.x`, `1.2.x`, `1.2.3`: each given part must match.
			return v[0] === r[0] && (r[1] === undefined || v[1] === r[1]) && (r[2] === undefined || v[2] === r[2]);
	}
}
