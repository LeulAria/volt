/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Node's own HTTP/2: gRPC needs it and nothing in the product wraps it yet.
// eslint-disable-next-line local/code-import-patterns
import * as http2 from 'http2';
import * as zlib from 'zlib';
import { IVoltGrpcServiceInfo, IVoltHttpStreamMessage, IVoltHttpStreamSpec } from '../common/voltHttpStreams.js';
import { IProtoMessage, IProtoMethod, IProtoService, ProtoJson, ProtoRegistry } from '../common/voltProto.js';
import { IVoltStreamConnection, VoltStreamEmit } from './voltStreamConnection.js';

/**
 * gRPC for the Volt Client on Node's `http2` alone: one HTTP/2 connection per call, the schema from
 * the request's `.proto` files or the server's reflection service, and messages as JSON text.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

const NO_REFLECTION = 'This server does not offer reflection. Add the .proto file to the request.';

const STATUS_NAMES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
	'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

const STATUS_CANCELLED = 1;
const STATUS_UNKNOWN = 2;
const STATUS_UNIMPLEMENTED = 12;
const STATUS_INTERNAL = 13;
const STATUS_UNAVAILABLE = 14;

/** Headers the call sets itself; metadata cannot replace them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'te', 'user-agent', 'grpc-accept-encoding', 'grpc-encoding',
	'grpc-message-type', 'content-length', 'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

function statusText(code: number, message: string): string {
	const name = STATUS_NAMES[code] ?? `STATUS_${code}`;
	// Some servers (grpc-js) send "OK" as the message of an OK status; the name says it already.
	return message && message !== name ? `${name}: ${message}` : name;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

//#region connection

interface IGrpcTarget {
	/** `http://host:port` or `https://host:port`, what `http2.connect` takes. */
	readonly authority: string;
	/** `host:port`, for messages. */
	readonly display: string;
	readonly host: string;
	readonly tls: boolean;
}

function parseTarget(url: string): IGrpcTarget {
	const text = url.trim();
	if (!text) {
		throw new Error('Enter the server address, like localhost:50051.');
	}
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(text);
	const scheme = match ? match[1].toLowerCase() : 'http';
	if (scheme !== 'http' && scheme !== 'grpc' && scheme !== 'https' && scheme !== 'grpcs') {
		throw new Error(`${scheme}:// is not a gRPC address. Use host:port, http://, grpc://, https:// or grpcs://.`);
	}
	const tls = scheme === 'https' || scheme === 'grpcs';
	let parsed: URL;
	try {
		parsed = new URL(`${tls ? 'https' : 'http'}://${match ? match[2] : text}`);
	} catch {
		throw new Error(`${text} is not a server address. Use host:port.`);
	}
	if (!parsed.hostname) {
		throw new Error(`${text} is not a server address. Use host:port.`);
	}
	const port = parsed.port || (tls ? '443' : '80');
	return { authority: `${parsed.protocol}//${parsed.hostname}:${port}`, display: `${parsed.hostname}:${port}`, host: parsed.hostname, tls };
}

/** What to try when the server does not speak what the address says. */
function otherSchemeHint(target: IGrpcTarget): string {
	return target.tls ? ' If it is a plaintext server, use http:// or grpc://.' : ' If it expects TLS, use https:// or grpcs://.';
}

/** A connection failure as a sentence. */
function describeTransportError(error: unknown, target: IGrpcTarget): string {
	let code = '';
	let current: unknown = error;
	for (let i = 0; i < 5 && !code && current instanceof Error; i++) {
		code = String((current as NodeJS.ErrnoException).code ?? '');
		current = current.cause;
	}
	// OpenSSL's errors are a line of codes; `reason` is the part that reads ("wrong version number").
	const reason = error instanceof Error ? (error as Error & { reason?: unknown }).reason : undefined;
	const message = (typeof reason === 'string' && reason ? reason : messageOf(error)).split(/[\n;]/)[0].trim().replace(/\.$/, '');
	const where = target.display;
	const plaintextHint = otherSchemeHint(target);
	switch (code) {
		case 'ECONNREFUSED': return `Could not connect to ${where}: the connection was refused. Is the server running?`;
		case 'ENOTFOUND':
		case 'EAI_AGAIN': return `Could not find the host ${target.host}.`;
		case 'ETIMEDOUT': return `Connecting to ${where} timed out.`;
		case 'EHOSTUNREACH':
		case 'ENETUNREACH': return `${where} cannot be reached from this machine.`;
		case 'ECONNRESET':
		case 'EPIPE': return `${where} closed the connection.${plaintextHint}`;
		case 'ERR_HTTP2_ERROR':
		case 'ERR_HTTP2_SESSION_ERROR':
		case 'ERR_HTTP2_GOAWAY_SESSION': return `${where} did not answer as an HTTP/2 server, which gRPC needs (${message}).${plaintextHint}`;
		case 'DEPTH_ZERO_SELF_SIGNED_CERT':
		case 'SELF_SIGNED_CERT_IN_CHAIN':
		case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
		case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
		case 'CERT_HAS_EXPIRED':
		case 'ERR_TLS_CERT_ALTNAME_INVALID': return `The TLS certificate of ${where} was not accepted: ${message}.`;
	}
	if (code.startsWith('ERR_SSL') || code === 'EPROTO' || code.startsWith('ERR_TLS')) {
		return `The TLS handshake with ${where} failed (${message}).${plaintextHint}`;
	}
	return `The connection to ${where} failed: ${message}`;
}

class GrpcConnection {

	readonly session: http2.ClientHttp2Session;
	/** The first thing that went wrong on the connection. */
	error: Error | undefined;
	private readonly ready: Promise<void>;

	constructor(readonly target: IGrpcTarget, timeoutMs: number) {
		const session = this.session = http2.connect(target.authority, target.tls ? { ALPNProtocols: ['h2'] } : {});
		session.on('error', error => { this.error ??= error; });
		this.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Could not connect to ${target.display} within ${Math.round(timeoutMs / 100) / 10} s.`));
				session.destroy();
			}, timeoutMs);
			session.once('connect', () => {
				clearTimeout(timer);
				resolve();
			});
			session.once('error', error => {
				clearTimeout(timer);
				reject(new Error(describeTransportError(error, target)));
			});
			session.once('close', () => {
				clearTimeout(timer);
				reject(new Error(`The connection to ${target.display} closed.`));
			});
		});
		this.ready.catch(() => { /* whoever waits gets it; nobody waiting is fine too */ });
	}

	whenReady(): Promise<void> {
		return this.ready;
	}

	/** Lets what is on the wire go out (a cancel, say), then closes. */
	close(): void {
		const session = this.session;
		if (session.destroyed) {
			return;
		}
		if (session.connecting || session.closed) {
			session.destroy();
			return;
		}
		const timer = setTimeout(() => session.destroy(), 1000);
		session.once('close', () => clearTimeout(timer));
		session.close();
	}
}

//#endregion

//#region one HTTP/2 stream speaking gRPC framing

interface IGrpcEnd {
	/** The grpc-status, or what the failure maps to. */
	readonly code: number;
	/** The grpc-message, percent-decoded. */
	readonly message: string;
	/** Trailer metadata besides the status. */
	readonly trailers: Record<string, string>;
	/** Set when the call broke off without a gRPC status: a sentence saying how. */
	readonly failure?: string;
}

interface IGrpcStreamHandlers {
	headers(status: number, headers: Record<string, string>): void;
	message(payload: Buffer, wireSize: number): void;
	end(end: IGrpcEnd): void;
}

function flattenHeaders(headers: http2.IncomingHttpHeaders, skip?: ReadonlySet<string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.startsWith(':') || value === undefined || skip?.has(key)) {
			continue;
		}
		out[key] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return out;
}

const STATUS_HEADERS: ReadonlySet<string> = new Set(['grpc-status', 'grpc-message']);

function percentDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

function single(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** What an HTTP status means when the answer carries no grpc-status. */
function statusOfHttp(status: number): number {
	switch (status) {
		case 400: return STATUS_INTERNAL;
		case 401: return 16;
		case 403: return 7;
		case 404: return STATUS_UNIMPLEMENTED;
		case 429: case 502: case 503: case 504: return STATUS_UNAVAILABLE;
		default: return STATUS_UNKNOWN;
	}
}

/** The metadata to send: lower-case names, none of the headers the call sets itself. */
function requestMetadata(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const key = name.trim().toLowerCase();
		if (!key || key.startsWith(':') || RESERVED_HEADERS.has(key)) {
			continue;
		}
		if (!/^[a-z0-9_.-]+$/.test(key)) {
			throw new Error(`"${name}" cannot be a metadata name (letters, digits, "-", "_" and "." only).`);
		}
		out[key] = String(value);
	}
	return out;
}

class GrpcStream {

	private readonly request: http2.ClientHttp2Stream;
	private pending: Buffer = Buffer.alloc(0);
	private responseHeaders: http2.IncomingHttpHeaders | undefined;
	private trailers: http2.IncomingHttpHeaders | undefined;
	private error: Error | undefined;
	private failure: string | undefined;
	private ended = false;

	constructor(private readonly connection: GrpcConnection, path: string, metadata: Record<string, string>, private readonly handlers: IGrpcStreamHandlers) {
		const request = this.request = connection.session.request({
			...metadata,
			[http2.constants.HTTP2_HEADER_METHOD]: 'POST',
			[http2.constants.HTTP2_HEADER_PATH]: path,
			'content-type': 'application/grpc+proto',
			'te': 'trailers',
			'grpc-accept-encoding': 'identity,gzip',
			'user-agent': 'volt-client',
		}, { endStream: false });
		request.on('response', headers => {
			this.responseHeaders = headers;
			handlers.headers(Number(headers[http2.constants.HTTP2_HEADER_STATUS]) || 0, flattenHeaders(headers));
		});
		request.on('trailers', headers => { this.trailers = headers; });
		request.on('data', (chunk: Buffer) => this.onData(chunk));
		request.on('error', error => { this.error ??= error; });
		// A broken connection reports on the session a moment after the stream closes.
		request.on('close', () => setImmediate(() => this.finish()));
	}

	/** Writes one message, framed. `done` runs once it is handed to the connection. */
	write(payload: Uint8Array, done: () => void): void {
		const frame = Buffer.allocUnsafe(5 + payload.length);
		frame.writeUInt8(0, 0);
		frame.writeUInt32BE(payload.length, 1);
		frame.set(payload, 5);
		this.request.write(frame, error => {
			if (!error) {
				done();
			}
		});
	}

	/** Half-close: no more request messages. */
	end(): void {
		if (!this.request.writableEnded && !this.request.destroyed) {
			this.request.end();
		}
	}

	/** RST_STREAM CANCEL. Nothing is reported afterwards. */
	cancel(): void {
		this.ended = true;
		if (!this.request.closed && !this.request.destroyed) {
			this.request.close(http2.constants.NGHTTP2_CANCEL);
		}
	}

	private onData(chunk: Buffer): void {
		if (this.ended || this.failure !== undefined) {
			return;
		}
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		// A message is a flag byte, a 4-byte length and that many bytes, wherever the chunks break.
		while (this.pending.length >= 5) {
			const compressed = this.pending.readUInt8(0);
			const length = this.pending.readUInt32BE(1);
			if (this.pending.length < 5 + length) {
				return;
			}
			let payload = this.pending.subarray(5, 5 + length);
			this.pending = this.pending.subarray(5 + length);
			if (compressed === 1) {
				const encoding = single(this.responseHeaders?.['grpc-encoding']) ?? 'identity';
				try {
					if (encoding === 'gzip') {
						payload = zlib.gunzipSync(payload);
					} else if (encoding === 'deflate') {
						payload = zlib.inflateSync(payload);
					} else {
						throw new Error(`the server compressed a message with ${encoding}, which is not supported`);
					}
				} catch (error) {
					this.fail(`A response message could not be read: ${messageOf(error)}.`);
					return;
				}
			} else if (compressed !== 0) {
				this.fail('The response is not gRPC: a message starts with an unknown flag.');
				return;
			}
			this.handlers.message(payload, length);
			if (this.ended) {
				return;
			}
		}
	}

	private fail(failure: string): void {
		this.failure = failure;
		if (!this.request.closed && !this.request.destroyed) {
			this.request.close(http2.constants.NGHTTP2_CANCEL);
		}
	}

	private finish(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		// The status is in the trailers, or in the headers when the response is nothing else.
		const carrier = this.trailers?.['grpc-status'] !== undefined ? this.trailers : this.responseHeaders?.['grpc-status'] !== undefined ? this.responseHeaders : undefined;
		const trailers = this.trailers ? flattenHeaders(this.trailers, STATUS_HEADERS) : {};
		if (this.failure !== undefined) {
			this.handlers.end({ code: STATUS_INTERNAL, message: '', trailers, failure: this.failure });
			return;
		}
		if (carrier) {
			const code = Number(single(carrier['grpc-status']));
			if (this.pending.length && code === 0) {
				this.handlers.end({ code: STATUS_INTERNAL, message: '', trailers, failure: 'The response ended in the middle of a message.' });
				return;
			}
			this.handlers.end({ code: Number.isInteger(code) && code >= 0 ? code : STATUS_UNKNOWN, message: percentDecode(single(carrier['grpc-message']) ?? ''), trailers });
			return;
		}
		const target = this.connection.target;
		const httpStatus = Number(this.responseHeaders?.[http2.constants.HTTP2_HEADER_STATUS]) || 0;
		const transportError = this.connection.error ?? (this.error && (this.error as NodeJS.ErrnoException).code !== 'ERR_HTTP2_STREAM_ERROR' ? this.error : undefined);
		const resetCode = this.request.rstCode;
		if (transportError) {
			this.handlers.end({ code: STATUS_UNAVAILABLE, message: '', trailers, failure: describeTransportError(transportError, target) });
		} else if (httpStatus && httpStatus !== 200) {
			this.handlers.end({ code: statusOfHttp(httpStatus), message: '', trailers, failure: `${target.display} answered HTTP ${httpStatus}, not a gRPC response.` });
		} else if (!this.responseHeaders) {
			this.handlers.end({ code: STATUS_UNAVAILABLE, message: '', trailers, failure: `${target.display} closed the call before answering.${otherSchemeHint(target)}` });
		} else if (resetCode) {
			const code = resetCode === http2.constants.NGHTTP2_CANCEL ? STATUS_CANCELLED : resetCode === http2.constants.NGHTTP2_REFUSED_STREAM ? STATUS_UNAVAILABLE : STATUS_INTERNAL;
			this.handlers.end({ code, message: '', trailers, failure: `The server reset the call (HTTP/2 error ${resetCode}).` });
		} else {
			this.handlers.end({ code: STATUS_UNKNOWN, message: '', trailers, failure: `${target.display} ended the response without a gRPC status. Is it a gRPC server?` });
		}
	}
}

//#endregion

//#region schema: protos or reflection

function hasProtos(protos: Readonly<Record<string, string>> | undefined): protos is Readonly<Record<string, string>> {
	return !!protos && Object.keys(protos).length > 0;
}

/** The reflection service's messages (v1 and v1alpha are the same on the wire). */
const REFLECTION_PROTO = `syntax = "proto3";
package grpc.reflection.v1;
message ServerReflectionRequest {
	string host = 1;
	oneof message_request {
		string file_by_filename = 3;
		string file_containing_symbol = 4;
		string all_extension_numbers_of_type = 6;
		string list_services = 7;
	}
}
message ServerReflectionResponse {
	string valid_host = 1;
	ServerReflectionRequest original_request = 2;
	oneof message_response {
		FileDescriptorResponse file_descriptor_response = 4;
		ListServiceResponse list_services_response = 6;
		ErrorResponse error_response = 7;
	}
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }`;

let reflectionRegistry: ProtoRegistry | undefined;

class GrpcStatusError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

interface IReflectionAnswer {
	readonly files: Uint8Array[];
	readonly services: string[];
	readonly error: string | undefined;
}

/** One reflection stream: a question at a time, each answered in order. */
class ReflectionClient {

	answered = false;
	private readonly stream: GrpcStream;
	private readonly waiting: { resolve(answer: IReflectionAnswer): void; reject(error: Error): void }[] = [];
	private over: Error | undefined;

	constructor(connection: GrpcConnection, version: string, metadata: Record<string, string>) {
		reflectionRegistry ??= ProtoRegistry.fromProtos({ 'reflection.proto': REFLECTION_PROTO });
		const registry = reflectionRegistry;
		this.stream = new GrpcStream(connection, `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`, metadata, {
			headers: () => { },
			message: payload => {
				const waiter = this.waiting.shift();
				if (!waiter) {
					return;
				}
				try {
					waiter.resolve(readReflectionAnswer(registry.decode('grpc.reflection.v1.ServerReflectionResponse', payload)));
					this.answered = true;
				} catch (error) {
					waiter.reject(new Error(`The reflection answer could not be read: ${messageOf(error)}`));
				}
			},
			end: end => {
				this.over = new GrpcStatusError(end.code, end.failure ?? (end.code === 0 ? 'The server ended reflection early.' : `Reflection failed: ${statusText(end.code, end.message)}`));
				for (const waiter of this.waiting.splice(0)) {
					waiter.reject(this.over);
				}
			},
		});
	}

	ask(request: Record<string, string>): Promise<IReflectionAnswer> {
		if (this.over) {
			return Promise.reject(this.over);
		}
		return new Promise<IReflectionAnswer>((resolve, reject) => {
			this.waiting.push({ resolve, reject });
			this.stream.write(reflectionRegistry!.encode('grpc.reflection.v1.ServerReflectionRequest', request), () => { });
		});
	}

	dispose(): void {
		this.stream.cancel();
		this.over ??= new Error('Reflection was stopped.');
		for (const waiter of this.waiting.splice(0)) {
			waiter.reject(this.over);
		}
	}
}

function readReflectionAnswer(answer: ProtoJson): IReflectionAnswer {
	const out: IReflectionAnswer = { files: [], services: [], error: undefined };
	if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
		return out;
	}
	const error = answer['errorResponse'];
	if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
		return { ...out, error: String(error['errorMessage'] || `error ${String(error['errorCode'])}`) };
	}
	const files = answer['fileDescriptorResponse'];
	if (typeof files === 'object' && files !== null && !Array.isArray(files) && Array.isArray(files['fileDescriptorProto'])) {
		for (const file of files['fileDescriptorProto']) {
			out.files.push(Buffer.from(String(file), 'base64'));
		}
	}
	const services = answer['listServicesResponse'];
	if (typeof services === 'object' && services !== null && !Array.isArray(services) && Array.isArray(services['service'])) {
		for (const service of services['service']) {
			if (typeof service === 'object' && service !== null && !Array.isArray(service) && typeof service['name'] === 'string') {
				out.services.push(service['name']);
			}
		}
	}
	return out;
}

/** Runs `work` on the server's reflection service: v1, or v1alpha when the server only has that. */
async function withReflection<T>(connection: GrpcConnection, metadata: Record<string, string>, work: (client: ReflectionClient) => Promise<T>): Promise<T> {
	for (const version of ['v1', 'v1alpha']) {
		const client = new ReflectionClient(connection, version, metadata);
		try {
			return await work(client);
		} catch (error) {
			if (!(error instanceof GrpcStatusError && error.code === STATUS_UNIMPLEMENTED && !client.answered)) {
				throw error;
			}
		} finally {
			client.dispose();
		}
	}
	throw new Error(NO_REFLECTION);
}

/** Loads the file that defines `symbol` and every file it depends on. */
async function loadSymbol(client: ReflectionClient, registry: ProtoRegistry, symbol: string): Promise<void> {
	const answer = await client.ask({ fileContainingSymbol: symbol });
	if (answer.error !== undefined) {
		throw new Error(`The server's reflection does not know ${symbol} (${answer.error}).`);
	}
	const pending: string[] = [];
	const add = (files: readonly Uint8Array[]) => {
		for (const bytes of files) {
			pending.push(...registry.addDescriptor(bytes).imports);
		}
	};
	add(answer.files);
	const asked = new Set<string>();
	while (pending.length) {
		const name = pending.pop()!;
		if (asked.has(name) || registry.hasFile(name)) {
			continue;
		}
		asked.add(name);
		// A dependency the server cannot give only matters when one of its types is used.
		add((await client.ask({ fileByFilename: name })).files);
	}
}

interface IGrpcMethod {
	readonly service: IProtoService;
	readonly method: IProtoMethod;
	readonly input: IProtoMessage;
	readonly output: IProtoMessage;
}

function findMethod(registry: ProtoRegistry, serviceName: string, methodName: string): IGrpcMethod {
	const service = registry.services.get(serviceName);
	if (!service) {
		const known = [...registry.services.keys()];
		throw new Error(known.length ? `There is no service ${serviceName}. The schema has: ${known.join(', ')}.` : `There is no service ${serviceName}: the schema defines no service.`);
	}
	const method = service.methods.find(candidate => candidate.name === methodName);
	if (!method) {
		throw new Error(`${serviceName} has no method ${methodName}. It has: ${service.methods.map(candidate => candidate.name).join(', ')}.`);
	}
	return { service, method, ...registry.methodTypes(service, method) };
}

function describeServices(registry: ProtoRegistry, services: readonly IProtoService[]): IVoltGrpcServiceInfo[] {
	return services.map(service => ({
		name: service.fullName,
		methods: service.methods.map(method => {
			let template = '{}';
			try {
				template = JSON.stringify(registry.templateOf(registry.methodTypes(service, method).input.fullName), undefined, 2);
			} catch {
				// A method whose request type is missing is still worth listing.
			}
			return { name: method.name, clientStreaming: method.clientStreaming, serverStreaming: method.serverStreaming, template };
		}),
	}));
}

/** What the server at `url` offers, from the given `.proto` texts or else its reflection service. */
export async function describeGrpc(url: string, headers: Readonly<Record<string, string>> | undefined, protos: Readonly<Record<string, string>> | undefined): Promise<readonly IVoltGrpcServiceInfo[]> {
	if (hasProtos(protos)) {
		const registry = ProtoRegistry.fromProtos(protos);
		return describeServices(registry, [...registry.services.values()]);
	}
	const metadata = requestMetadata(headers);
	const connection = new GrpcConnection(parseTarget(url), DEFAULT_CONNECT_TIMEOUT_MS);
	try {
		await connection.whenReady();
		const registry = new ProtoRegistry();
		const names = await withReflection(connection, metadata, async client => {
			const answer = await client.ask({ listServices: '*' });
			if (answer.error !== undefined) {
				throw new Error(`The server's reflection could not list its services (${answer.error}).`);
			}
			const listed = answer.services.filter(name => !name.startsWith('grpc.reflection.'));
			for (const name of listed) {
				if (!registry.services.has(name)) {
					await loadSymbol(client, registry, name);
				}
			}
			return listed;
		});
		const services: IProtoService[] = [];
		for (const name of names) {
			const service = registry.services.get(name);
			if (service) {
				services.push(service);
			}
		}
		return describeServices(registry, services);
	} finally {
		connection.close();
	}
}

//#endregion

//#region the call

function kindOf(method: IProtoMethod): string {
	if (method.clientStreaming) {
		return method.serverStreaming ? 'bidirectional streaming' : 'client streaming';
	}
	return method.serverStreaming ? 'server streaming' : 'unary';
}

class GrpcCall implements IVoltStreamConnection {

	/** `close` went out; nothing is reported after it. */
	private done = false;
	/** The request side is closed (or will be, once what is queued has gone out). */
	private halfClosed = false;
	private connection: GrpcConnection | undefined;
	private stream: GrpcStream | undefined;
	private registry: ProtoRegistry | undefined;
	private method: IGrpcMethod | undefined;
	/** Messages sent before the call was up. */
	private readonly queue: IVoltHttpStreamMessage[] = [];

	constructor(private readonly spec: IVoltHttpStreamSpec, private readonly emit: VoltStreamEmit) {
		// Never report from inside `openGrpcCall`: the caller does not hold the connection yet.
		queueMicrotask(() => this.start().catch(error => this.fail(messageOf(error))));
	}

	private async start(): Promise<void> {
		const grpc = this.spec.grpc;
		const serviceName = (grpc?.service ?? '').trim().replace(/^[/.]+/, '');
		const methodName = (grpc?.method ?? '').trim();
		if (!grpc || !serviceName || !methodName) {
			throw new Error('A gRPC call needs a service and a method.');
		}
		const metadata = requestMetadata(this.spec.headers);
		let registry = hasProtos(grpc.protos) ? ProtoRegistry.fromProtos(grpc.protos) : undefined;
		const target = parseTarget(this.spec.url);
		if (this.done) {
			return;
		}
		const connection = this.connection = new GrpcConnection(target, Math.max(1, this.spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS));
		await connection.whenReady();
		if (this.done) {
			return;
		}
		if (!registry) {
			const reflected = registry = new ProtoRegistry();
			await withReflection(connection, metadata, client => loadSymbol(client, reflected, serviceName));
			if (this.done) {
				return;
			}
		}
		this.registry = registry;
		const found = this.method = findMethod(registry, serviceName, methodName);
		const method = found.method;

		// A unary or server-streaming call is its one request message, so nothing typed means an empty one.
		const firstText = (grpc.message ?? '').trim();
		const first = firstText || !method.clientStreaming ? this.encode(firstText || '{}') : undefined;

		this.stream = new GrpcStream(connection, `/${serviceName}/${methodName}`, metadata, {
			headers: (status, headers) => this.report({ type: 'open', status, headers, text: `${serviceName}/${methodName} (${kindOf(method)})` }),
			message: (payload, wireSize) => this.onMessage(payload, wireSize),
			end: end => this.onEnd(end),
		});
		this.report({ type: 'info', text: `Calling ${serviceName}/${methodName} on ${target.display}` });
		if (first) {
			this.write(first);
		}
		const queued = this.queue.splice(0);
		if (!method.clientStreaming) {
			this.stream.end();
			this.halfClosed = true;
			if (queued.some(message => message.data.trim() !== '')) {
				this.report({ type: 'info', text: `${methodName} takes one request message; what was sent after it was left out.` });
			}
			return;
		}
		this.halfClosed = false;
		for (const message of queued) {
			this.deliver(message);
		}
	}

	send(message: IVoltHttpStreamMessage): void {
		if (this.done) {
			throw new Error('The call is over.');
		}
		if (this.halfClosed) {
			throw new Error(this.method && !this.method.method.clientStreaming
				? `${this.method.method.name} takes one request message, and it was sent.`
				: 'The request side of this call is closed; no more messages can be sent.');
		}
		if (!this.stream) {
			// Still connecting or reading the schema: it goes out, in order, once the call is up.
			this.queue.push(message);
			this.halfClosed = !!message.end;
			return;
		}
		this.deliver(message);
	}

	close(): void {
		if (this.done) {
			return;
		}
		this.done = true;
		this.stream?.cancel();
		this.connection?.close();
		this.emit({ type: 'close', code: STATUS_CANCELLED, text: STATUS_NAMES[STATUS_CANCELLED] });
	}

	private deliver(message: IVoltHttpStreamMessage): void {
		const text = message.data.trim();
		if (text) {
			this.write(this.encode(text));
		}
		if (message.end) {
			this.stream?.end();
			this.halfClosed = true;
		}
	}

	private encode(text: string): { readonly bytes: Uint8Array; readonly pretty: string } {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new Error(`The message is not valid JSON: ${messageOf(error)}`);
		}
		return { bytes: this.registry!.encode(this.method!.input.fullName, value), pretty: JSON.stringify(value, undefined, 2) };
	}

	private write(message: { readonly bytes: Uint8Array; readonly pretty: string }): void {
		const target = this.method!.method.name;
		this.stream!.write(message.bytes, () => this.report({ type: 'sent', target, data: message.pretty, size: message.bytes.length }));
	}

	private onMessage(payload: Buffer, wireSize: number): void {
		const method = this.method!;
		let data: string;
		try {
			data = JSON.stringify(this.registry!.decode(method.output.fullName, payload), undefined, 2);
		} catch (error) {
			this.report({ type: 'info', text: `A response message is not a ${method.output.fullName}: ${messageOf(error)}` });
			this.report({ type: 'message', target: method.method.name, data: payload.toString('base64'), binary: true, size: wireSize });
			return;
		}
		this.report({ type: 'message', target: method.method.name, data, size: wireSize });
	}

	private onEnd(end: IGrpcEnd): void {
		if (end.failure !== undefined) {
			this.fail(end.failure);
			return;
		}
		if (Object.keys(end.trailers).length) {
			this.report({ type: 'info', text: 'Trailers', headers: end.trailers });
		}
		const text = statusText(end.code, end.message);
		if (end.code !== 0) {
			this.report({ type: 'error', text });
		}
		this.finish({ type: 'close', code: end.code, text });
	}

	/** It broke: `error`, then `close`. */
	private fail(text: string): void {
		this.report({ type: 'error', text });
		this.finish({ type: 'close' });
	}

	private finish(close: Parameters<VoltStreamEmit>[0]): void {
		if (this.done) {
			return;
		}
		this.done = true;
		this.stream?.cancel();
		this.connection?.close();
		this.emit(close);
	}

	private report(event: Parameters<VoltStreamEmit>[0]): void {
		if (!this.done) {
			this.emit(event);
		}
	}
}

/**
 * Starts one gRPC call. `spec.grpc.message` goes out as soon as the call is up; a unary or
 * server-streaming method is then half-closed, a client-streaming or bidirectional one stays open
 * for `send` until a message with `end`. `close` cancels the call.
 */
export function openGrpcCall(spec: IVoltHttpStreamSpec, emit: VoltStreamEmit): IVoltStreamConnection {
	return new GrpcCall(spec, emit);
}

//#endregion
