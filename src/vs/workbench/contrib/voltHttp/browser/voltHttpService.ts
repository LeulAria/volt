/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVoltGrpcServiceInfo, IVoltHttpStreamEvent, IVoltHttpStreams } from '../../../../platform/voltHttp/common/voltHttpStreams.js';
import { IVoltHttpOAuth, VoltOAuthSignInResult } from '../../../../platform/voltHttp/common/voltHttpOAuth.js';
import { IVoltHttpCredentials, IVoltHttpNodeOptions, IVoltHttpRequestOptions, IVoltHttpTransport, VOLT_HTTP_VERSION_HEADER } from '../../../../platform/voltHttp/common/voltHttpTransport.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IHttpRequestSpec, IHttpResponseRecord, IHttpScope, missingVariables, parseHttpEnvironments, parseHttpFile, resolveHttpVariables, serializeHttpRequest } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { IHttpSigned, IHttpSignedRequest, signHttpRequest } from '../common/httpAuth.js';
import { encodeHttpUrl, httpSettingsWithDefaults, IHttpAuth, IHttpRequestSettings } from '../common/httpCollection.js';
import { httpSetCookieLines } from '../common/httpCookies.js';
import { httpMcpMessage, httpMcpMethodOf, httpMcpResponseBody, MCP_PROTOCOL_VERSION } from '../common/httpProtocols.js';
import { IHttpScriptAssertion, IHttpScriptBreak } from '../common/httpScriptRuntime.js';
import { httpConfinedCookieJarKey, httpCookieJarKey, HttpCookieJars, IVoltHttpCookies } from './voltHttpCookies.js';

export const IVoltHttpService = createDecorator<IVoltHttpService>('voltHttpService');

const ENV_KEY = 'volt.http.environment';
const HISTORY_KEY = 'volt.http.history';
const MAX_HISTORY = 60;
const MAX_FILES = 400;
const MAX_BODY_KEPT = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Chats' folders outside the window's that are watched for request files at once. */
const MAX_WATCHED_FOLDERS = 8;

export interface IHttpFileEntry {
	readonly uri: URI;
	readonly variables: Readonly<Record<string, string>>;
	readonly requests: readonly IHttpRequestSpec[];
}

/** A request as it went out (variables filled in) and what came back. */
export interface IHttpExchange {
	readonly id: string;
	readonly at: number;
	readonly name?: string;
	readonly source?: { readonly uri: URI; readonly line: number };
	readonly method: string;
	/** The kind of request when it is not plain HTTP. */
	readonly protocol?: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
	readonly response?: IHttpResponseRecord;
	/** A connection's messages, in order (WebSocket, SSE, Socket.IO, MQTT, gRPC); `response.body` is the same as JSON. */
	readonly stream?: readonly IHttpStreamEntry[];
	readonly error?: string;
	/** The folder whose client sent it ('' for the window's): each project has its own history. */
	readonly root?: string;
	/** The collection request it was sent from. */
	readonly request?: { readonly collection: string; readonly id: string };
	/** What the request's scripts reported. */
	readonly tests?: readonly IHttpExchangeTest[];
	readonly logs?: readonly IHttpExchangeLog[];
	readonly scriptError?: string;
	/** What the scripts' breakpoints recorded, in the order they stopped (the script does not pause: see `httpScriptBreakpoints.ts`). */
	readonly breaks?: readonly (IHttpScriptBreak & { readonly phase?: 'preRequest' | 'test' })[];
}

/** One line of a connection's timeline. */
export interface IHttpStreamEntry {
	readonly at: number;
	/** `in` and `out` are messages; `info` and `error` are what the connection itself reports. */
	readonly direction: 'in' | 'out' | 'info' | 'error';
	/** The Socket.IO event, MQTT topic, SSE event name or gRPC method. */
	readonly target?: string;
	readonly data: string;
	/** `data` is base64. */
	readonly binary?: boolean;
	readonly size?: number;
}

export interface IHttpExchangeTest {
	readonly name: string;
	readonly passed: boolean;
	readonly skipped?: boolean;
	readonly error?: string;
	/** What the test did, when the script ran with `detail` (see `IHttpScriptTest`). */
	readonly durationMs?: number;
	readonly assertions?: readonly IHttpScriptAssertion[];
	/** How many assertions it made, when more than `assertions` holds. */
	readonly assertionCount?: number;
	/** Of the assertion that failed, when it compares values. */
	readonly expected?: string;
	readonly actual?: string;
	/** The 1-based line of the script the failure was thrown from. */
	readonly errorLine?: number;
}

export interface IHttpExchangeLog {
	readonly level: 'log' | 'info' | 'warn' | 'error';
	readonly text: string;
	/** The test that was running when it was logged. */
	readonly test?: string;
}

/** A multipart part: text, or a file read when the request goes out. */
export interface IHttpFormPart {
	readonly key: string;
	readonly value: string;
	readonly type?: 'text' | 'file';
}

/**
 * An agent's send for a chat in Volt's sandbox (the `ide http` capability). The request goes out
 * from Volt's process, so it follows the chat's network rules here instead of the OS's.
 */
export interface IHttpConfinement {
	/** Whose named responses `{{name.response...}}` reads and records: the chat's own, never the user's. */
	readonly key: string;
	/** Why the chat's network rules refuse a URL, or undefined. Judged on the URL that goes out; redirects are not followed. */
	readonly urlRefusal: (url: string) => string | undefined;
	/** Whether Volt may read a request or environment file for the chat (the gate's read rule). */
	readonly readable: (uri: URI) => Promise<boolean>;
}

export interface IHttpSendOptions {
	readonly source?: URI;
	readonly fileVariables?: Readonly<Record<string, string>>;
	readonly token?: CancellationToken;
	readonly timeoutMs?: number;
	/** The folder whose request files and environments apply (a chat's); the window's folders when absent. */
	readonly root?: URI;
	/** An agent chat's project: the same as `root` (the name the HTTP Client tab's first callers used). */
	readonly project?: URI;
	/** The environment for this send only; the user's selected one when absent. */
	readonly environment?: string;
	readonly confined?: IHttpConfinement;
	/** The environment's variables, when the caller has them (a collection's send); read from the env files when absent. */
	readonly environmentVariables?: Readonly<Record<string, string>>;
	/** A multipart body: sent instead of the request's `body`, with its boundary in the content type. */
	readonly formdata?: readonly IHttpFormPart[];
	/** A file sent as the body. */
	readonly binaryPath?: string;
	/** The folder relative file paths (form files, a binary body) are read from. */
	readonly base?: URI;
	readonly request?: { readonly collection: string; readonly id: string };
	/** Runs on the exchange before it is recorded (the collection's test scripts): what it returns is added. */
	readonly finish?: (exchange: IHttpExchange) => Promise<Partial<IHttpExchange>>;
	/** The request's Settings tab: TLS, protocol version, redirects, cookies, timeout. The defaults when absent. */
	readonly settings?: IHttpRequestSettings;
	/** The request's effective authorization: what it computes from the request itself (a signature, a nonce) is added as it goes out. */
	readonly auth?: IHttpAuth;
	/** `false`: the cookie jar is neither read nor written for this send. */
	readonly cookies?: boolean;
}

/** Every setting with its value, as a send uses them. */
export type HttpWireSettings = ReturnType<typeof httpSettingsWithDefaults>;

/** One hop of a send: what goes to the transport. */
export interface IHttpHop {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly payload: { readonly data?: string; readonly dataBase64?: string };
}

/** How a send goes out, beyond the request itself. */
interface IHttpWire {
	readonly settings: HttpWireSettings;
	readonly timeoutMs: number;
	readonly token: CancellationToken;
	readonly confined?: IHttpConfinement;
	/** The cookie jar's key; no jar when absent. */
	readonly jar?: string;
	readonly credentials?: IVoltHttpCredentials;
	readonly challenge?: IHttpSigned['challenge'];
}

interface IHttpWireResult {
	response?: IHttpResponseRecord;
	error?: string;
	logs?: IHttpExchangeLog[];
}

export interface IVoltHttpService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeIndex: Event<void>;
	readonly onDidChangeEnvironment: Event<void>;
	readonly onDidSend: Event<IHttpExchange>;
	/** Every .http / .rest file in `root` (a chat's folder), else the window's folders, with its requests. */
	index(root?: URI): Promise<readonly IHttpFileEntry[]>;
	/** `readable`: only environment files it allows are read (a sandboxed chat's). */
	environments(root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>>;
	readonly environment: string | undefined;
	/** `root`: the project whose pick it is; each project keeps its own. */
	setEnvironment(name: string | undefined, root?: URI): void;
	environmentOf(root: URI | undefined): string | undefined;
	readonly history: readonly IHttpExchange[];
	readonly onDidChangeHistory: Event<void>;
	historyOf(root: URI | undefined): readonly IHttpExchange[];
	clearHistory(root: URI | undefined): void;
	removeFromHistory(id: string): void;
	/** Fills in variables, sends, records the exchange (and the named response for chaining). */
	send(request: IHttpRequestSpec, options?: IHttpSendOptions): Promise<IHttpExchange>;
	/** Saves a request into a .http file: replaces the one at `line`, or appends. */
	save(uri: URI, request: IHttpRequestSpec, line?: number): Promise<number>;
	/** The default file new requests go to. */
	defaultFile(): URI | undefined;
	/** `root` (a chat's folder, watched from now on when the window does not hold it), else the window's folders. */
	foldersOf(root: URI | undefined): URI[];
	/** What `{{variables}}` resolve with for a send with these variables (earlier named responses included). */
	scopeOf(fileVariables: Readonly<Record<string, string>>, environmentVariables: Readonly<Record<string, string>>, confined?: IHttpConfinement): IHttpScope;
	/** Adds an exchange made elsewhere (a connection's session) to the history. */
	record(exchange: IHttpExchange): void;
	/** Forgets the MCP session kept for a server, so the next message initializes again. */
	resetMcpSession(url: string, root?: URI): void;
}

/**
 * The HTTP client's one state, shared by the HTTP view, the request editor and the agents' `ide
 * http` capability: the workspace's request files, environments, earlier responses (for
 * `{{login.response.body.$.token}}`) and history. Requests go out through `IVoltHttpTransport`: the
 * main process in the desktop app (no CORS, every response header, the user's proxy settings), the
 * window's request service in the web workbench.
 */
export class VoltHttpService extends Disposable implements IVoltHttpService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIndex = this._register(new Emitter<void>());
	readonly onDidChangeIndex = this._onDidChangeIndex.event;
	private readonly _onDidChangeEnvironment = this._register(new Emitter<void>());
	readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;
	private readonly _onDidSend = this._register(new Emitter<IHttpExchange>());
	readonly onDidSend = this._onDidSend.event;
	private readonly _onDidChangeHistory = this._register(new Emitter<void>());
	readonly onDidChangeHistory = this._onDidChangeHistory.event;

	/** Request files per folder ('' for the window's folders), dropped whenever one changes. */
	private readonly indexes = new Map<string, Promise<ResourceMap<IHttpFileEntry>>>();
	private readonly responses = new Map<string, IHttpResponseRecord>();
	/** Sandboxed chats' named responses, kept apart from the user's (`IHttpConfinement.key`). */
	private readonly confinedResponses = new Map<string, Map<string, IHttpResponseRecord>>();
	/** Chats' folders outside the window's: nothing else watches them, so their request files would go stale. */
	private readonly watched = this._register(new DisposableMap<string>());
	private readonly queryBuilder: QueryBuilder;
	private readonly reindex = this._register(new RunOnceScheduler(() => { this.indexes.clear(); this._onDidChangeIndex.fire(); }, 400));
	/** MCP servers' session ids by project and URL: `initialize` starts one, later messages carry it. */
	private readonly mcpSessions = new Map<string, { id?: string; version?: string }>();
	private _history: IHttpExchange[];
	/** The picked environment per project folder ('' for the window's). */
	private _environments: Record<string, string>;
	/** The cookie jars every send reads and writes. */
	private readonly cookies: IVoltHttpCookies;

	constructor(
		@IVoltHttpTransport private readonly transport: IVoltHttpTransport,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		// The window's jars (`WorkbenchVoltHttpService`); left out by a test that builds the service by hand, which gets jars of its own over the same storage.
		cookies?: IVoltHttpCookies,
	) {
		super();
		this.cookies = cookies ?? this._register(new HttpCookieJars(storage));
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		this._environments = this.readEnvironments();
		this._history = this.readHistory();
		this._register(fileService.onDidFilesChange(e => {
			if (e.rawAdded.concat(e.rawUpdated, e.rawDeleted).some(uri => /\.(?:http|rest)$|http-client(?:\.private)?\.env\.json$/.test(uri.path))) {
				this.reindex.schedule();
			}
		}));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.reindex.schedule()));
	}

	get environment(): string | undefined {
		return this._environments[''];
	}

	environmentOf(root: URI | undefined): string | undefined {
		return this._environments[root?.toString() ?? ''] ?? (root && this.workspace.getWorkspace().folders.some(folder => folder.uri.toString() === root.toString()) ? this._environments[''] : undefined);
	}

	get history(): readonly IHttpExchange[] {
		return this._history;
	}

	historyOf(root: URI | undefined): readonly IHttpExchange[] {
		const key = root?.toString() ?? '';
		return this._history.filter(item => (item.root ?? '') === key);
	}

	clearHistory(root: URI | undefined): void {
		const key = root?.toString() ?? '';
		this._history = this._history.filter(item => (item.root ?? '') !== key);
		this.storeHistory();
		this._onDidChangeHistory.fire();
	}

	removeFromHistory(id: string): void {
		this._history = this._history.filter(item => item.id !== id);
		this.storeHistory();
		this._onDidChangeHistory.fire();
	}

	setEnvironment(name: string | undefined, root?: URI): void {
		const key = root?.toString() ?? '';
		if (name) {
			this._environments[key] = name;
		} else {
			delete this._environments[key];
		}
		this.storage.store(ENV_KEY, JSON.stringify(this._environments), StorageScope.WORKSPACE, StorageTarget.USER);
		this._onDidChangeEnvironment.fire();
	}

	private readEnvironments(): Record<string, string> {
		const raw = this.storage.get(ENV_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
			}
		} catch { /* an older build stored the name alone */ }
		return { '': raw };
	}

	async index(root?: URI): Promise<readonly IHttpFileEntry[]> {
		const key = root?.toString() ?? '';
		let index = this.indexes.get(key);
		if (!index) {
			index = this.buildIndex(this.foldersOf(root));
			this.indexes.set(key, index);
		}
		return [...(await index).values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path));
	}

	foldersOf(root: URI | undefined): URI[] {
		if (!root) {
			return this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri);
		}
		const key = root.toString();
		if (root.scheme === Schemas.file && !this.watched.has(key) && !this.workspace.getWorkspace().folders.some(folder => isEqualOrParent(root, folder.uri))) {
			// The latest few chats' folders: one recursive watcher per chat ever asked would pile up.
			const oldest = this.watched.size >= MAX_WATCHED_FOLDERS ? this.watched.keys().next().value : undefined;
			if (oldest !== undefined) {
				this.watched.deleteAndDispose(oldest);
				this.indexes.delete(oldest);
			}
			this.watched.set(key, this.fileService.watch(root, { recursive: true, excludes: ['**/node_modules/**', '**/.git/**'] }));
		}
		return [root];
	}

	private async buildIndex(folders: readonly URI[]): Promise<ResourceMap<IHttpFileEntry>> {
		const next = new ResourceMap<IHttpFileEntry>();
		if (folders.length) {
			const query = this.queryBuilder.file([...folders], { includePattern: ['**/*.http', '**/*.rest'], excludePattern: [{ pattern: '**/node_modules/**' }], maxResults: MAX_FILES });
			const found = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
			await Promise.all((found?.results ?? []).map(async result => {
				const text = await this.fileService.readFile(result.resource).then(file => file.value.toString(), () => undefined);
				if (text !== undefined) {
					const parsed = parseHttpFile(text);
					next.set(result.resource, { uri: result.resource, variables: parsed.variables, requests: parsed.requests });
				}
			}));
		}
		return next;
	}

	async environments(root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
		const texts: (string | undefined)[] = [];
		for (const folder of root ? [root] : this.workspace.getWorkspace().folders.map(item => item.uri)) {
			for (const name of ['http-client.env.json', 'http-client.private.env.json', '.vscode/http-client.env.json']) {
				const uri = joinPath(folder, name);
				if (readable && !await readable(uri)) {
					continue;
				}
				texts.push(await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined));
			}
		}
		return parseHttpEnvironments(...texts);
	}

	scopeOf(fileVariables: Readonly<Record<string, string>>, environmentVariables: Readonly<Record<string, string>>, confined?: IHttpConfinement): IHttpScope {
		return { file: fileVariables, env: environmentVariables, responses: confined ? this.confinedResponses.get(confined.key) ?? new Map<string, IHttpResponseRecord>() : this.responses };
	}

	record(exchange: IHttpExchange): void {
		this._history = [exchange, ...this._history].slice(0, MAX_HISTORY);
		this.storeHistory();
		this._onDidSend.fire(exchange);
		this._onDidChangeHistory.fire();
	}

	resetMcpSession(url: string, root?: URI): void {
		for (const key of [...this.mcpSessions.keys()]) {
			if (key.endsWith(`|${root?.toString() ?? ''}|${httpRequestUrl(url)}`)) {
				this.mcpSessions.delete(key);
			}
		}
	}

	defaultFile(): URI | undefined {
		const folder = this.workspace.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, 'requests.http') : undefined;
	}

	async send(request: IHttpRequestSpec, options?: IHttpSendOptions): Promise<IHttpExchange> {
		const confined = options?.confined;
		const root = options?.root ?? options?.project;
		const envs = options?.environmentVariables ? {} : await this.environments(root, confined?.readable);
		const source = options?.source && (!confined || await confined.readable(options.source)) ? options.source : undefined;
		const fileVariables = options?.fileVariables ?? (source ? (await this.index(root)).find(entry => entry.uri.toString() === source.toString())?.variables : undefined) ?? {};
		let responses = this.responses;
		if (confined) {
			responses = this.confinedResponses.get(confined.key) ?? new Map<string, IHttpResponseRecord>();
			this.confinedResponses.set(confined.key, responses);
		}
		const environment = options?.environment ?? this.environmentOf(root);
		const scope: IHttpScope = { file: fileVariables, env: options?.environmentVariables ?? ((environment && envs[environment]) || {}), responses };
		const url = resolveHttpVariables(request.url, scope);
		const headers = request.headers.map(([key, value]) => [key, resolveHttpVariables(value, scope)] as const);
		const body = request.body !== undefined ? resolveHttpVariables(request.body, scope) : undefined;
		const base = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			at: Date.now(),
			...(request.name ? { name: request.name } : {}),
			...(options?.source ? { source: { uri: options.source, line: request.line } } : {}),
			method: request.method,
			...(request.protocol && request.protocol !== 'http' ? { protocol: request.protocol } : {}),
			url,
			headers,
			...(body !== undefined ? { body } : {}),
			...(root ? { root: root.toString() } : {}),
			...(options?.request ? { request: options.request } : {}),
		};
		const formdata = options?.formdata?.map(part => ({ ...part, key: resolveHttpVariables(part.key, scope), value: resolveHttpVariables(part.value, scope) }));
		const binaryPath = options?.binaryPath !== undefined ? resolveHttpVariables(options.binaryPath, scope) : undefined;
		const missing = missingVariables([url, ...headers.map(([, value]) => value), body ?? '', ...(formdata ?? []).map(part => `${part.key}\n${part.value}`), binaryPath ?? ''].join('\n'));
		// The URL that goes out, judged by the chat's network rules once its own variables are filled in
		// (before the rest: a host the chat may not reach is the answer, whatever else is missing).
		const refused = confined && !missingVariables(url).length ? confined.urlRefusal(httpRequestUrl(url)) : undefined;
		let exchange: IHttpExchange;
		if (refused) {
			exchange = { ...base, error: `Not sent: ${refused}. This chat runs in Volt's sandbox, whose network rules apply to its requests too. Ask the user to allow the host for this chat, or to send it.` };
		} else if (missing.length) {
			exchange = { ...base, error: `Unresolved variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}${environment ? ` (environment "${environment}")` : ' (no environment selected)'}.` };
		} else {
			// A sandboxed chat's request does not follow redirects: each hop is judged as its own send.
			let payload: { data?: string; dataBase64?: string; headers: readonly (readonly [string, string])[] } | { error: string };
			try {
				payload = await this.payloadOf(headers, body, formdata, binaryPath, options?.base ?? root, confined);
			} catch (err) {
				payload = { error: err instanceof Error ? err.message : String(err) };
			}
			const settings = httpSettingsWithDefaults(options?.settings);
			if ('error' in payload) {
				exchange = { ...base, error: payload.error };
			} else {
				// What the authorization computes from the request itself, once every variable is in and before the first hop.
				const unresolved: string[] = [];
				let signed: IHttpSigned | undefined;
				let signError: string | undefined;
				if (options?.auth && options.auth.type !== 'none' && options.auth.type !== 'inherit') {
					try {
						signed = await signHttpRequest(options.auth, { method: request.method, url, headers: payload.headers, ...(payload.data !== undefined ? { body: payload.data } : {}) }, text => {
							const filled = resolveHttpVariables(text, scope);
							unresolved.push(...missingVariables(filled));
							return filled;
						});
					} catch (err) {
						signError = err instanceof Error ? err.message : String(err);
					}
				}
				const wire: IHttpWire = {
					settings,
					timeoutMs: options?.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					token: options?.token ?? CancellationToken.None,
					...(confined ? { confined } : {}),
					// A sandboxed chat's cookies are its own, never the user's.
					...(options?.cookies !== false ? { jar: confined ? httpConfinedCookieJarKey(confined.key) : httpCookieJarKey(root) } : {}),
					...(signed?.credentials ? { credentials: signed.credentials } : {}),
					...(signed?.challenge ? { challenge: signed.challenge } : {}),
				};
				// The request as it goes out: the signer's URL and headers when it changed them.
				const out = signed && (signed.url !== url || signed.headers !== payload.headers) ? { ...base, url: signed.url, headers: signed.headers } : base;
				// The signer may have added to the URL: a sandboxed chat's send is judged on the URL that goes out.
				const refusedSigned = confined && signed && signed.url !== url ? confined.urlRefusal(httpRequestUrl(signed.url)) : undefined;
				if (signError) {
					exchange = { ...base, error: `Authorization: ${signError}` };
				} else if (unresolved.length) {
					const names = [...new Set(unresolved)];
					exchange = { ...base, error: `Unresolved variable${names.length === 1 ? '' : 's'} in the authorization: ${names.join(', ')}${environment ? ` (environment "${environment}")` : ' (no environment selected)'}.` };
				} else if (refusedSigned) {
					exchange = { ...base, error: `Not sent: ${refusedSigned}. This chat runs in Volt's sandbox, whose network rules apply to its requests too. Ask the user to allow the host for this chat, or to send it.` };
				} else if (request.protocol === 'mcp') {
					exchange = { ...out, ...(await this.executeMcp(out.url, signed?.headers ?? payload.headers, payload.data ?? '', `${confined?.key ?? ''}|${root?.toString() ?? ''}|${httpRequestUrl(url)}`, wire)) };
				} else {
					exchange = { ...out, ...(await this.execute(request.method, out.url, signed?.headers ?? payload.headers, payload, wire)) };
				}
			}
		}
		if (options?.finish) {
			try {
				exchange = { ...exchange, ...(await options.finish(exchange)) };
			} catch (err) {
				exchange = { ...exchange, scriptError: err instanceof Error ? err.message : String(err) };
			}
		}
		if (request.name && exchange.response) {
			responses.set(request.name, exchange.response);
		}
		this._history = [exchange, ...this._history].slice(0, MAX_HISTORY);
		this.storeHistory();
		this._onDidSend.fire(exchange);
		this._onDidChangeHistory.fire();
		return exchange;
	}

	/** The body that goes out: the text as it is, or a multipart or file body built from the files it names. */
	private async payloadOf(headers: readonly (readonly [string, string])[], body: string | undefined, formdata: readonly IHttpFormPart[] | undefined, binaryPath: string | undefined, base: URI | undefined, confined: IHttpConfinement | undefined): Promise<{ data?: string; dataBase64?: string; headers: readonly (readonly [string, string])[] }> {
		const read = async (path: string): Promise<VSBuffer> => {
			const uri = /^(?:[a-zA-Z]:[\\/]|\/)/.test(path) ? URI.file(path) : base ? joinPath(base, path) : undefined;
			if (!uri) {
				throw new Error(`Cannot read ${path}: a relative path needs a project folder.`);
			}
			if (confined && !await confined.readable(uri)) {
				throw new Error(`Not sent: this chat may not read ${path}.`);
			}
			try {
				return (await this.fileService.readFile(uri)).value;
			} catch {
				throw new Error(`Cannot read the file ${path}.`);
			}
		};
		if (formdata) {
			const boundary = `----VoltFormBoundary${generateUuid().replace(/-/g, '')}`;
			const chunks: VSBuffer[] = [];
			for (const part of formdata) {
				if (part.type === 'file') {
					const name = part.value.split(/[\\/]/).pop() ?? 'file';
					chunks.push(VSBuffer.fromString(`--${boundary}\r\nContent-Disposition: form-data; name="${part.key}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), await read(part.value), VSBuffer.fromString('\r\n'));
				} else {
					chunks.push(VSBuffer.fromString(`--${boundary}\r\nContent-Disposition: form-data; name="${part.key}"\r\n\r\n${part.value}\r\n`));
				}
			}
			chunks.push(VSBuffer.fromString(`--${boundary}--\r\n`));
			return { dataBase64: encodeBase64(VSBuffer.concat(chunks)), headers: [...headers.filter(([key]) => key.toLowerCase() !== 'content-type'), ['Content-Type', `multipart/form-data; boundary=${boundary}`]] };
		}
		if (binaryPath) {
			return { dataBase64: encodeBase64(await read(binaryPath)), headers };
		}
		return { ...(body !== undefined ? { data: body } : {}), headers };
	}

	/**
	 * Sends a request and follows what comes back, hop by hop: the transport never follows a redirect
	 * itself (where it can be told so), so each hop gets the jar's cookies for its own URL, stores
	 * what it sets, and the request's settings decide the method and headers of the next one. A
	 * sandboxed chat's send follows none: each hop would be a send of its own to judge.
	 */
	private async execute(method: string, rawUrl: string, headers: readonly (readonly [string, string])[], payload: { data?: string; dataBase64?: string }, wire: IHttpWire): Promise<IHttpWireResult> {
		const { settings, confined, token } = wire;
		const follow = settings.followRedirects && !confined;
		const jar = settings.disableCookies ? undefined : wire.jar;
		const logs: IHttpExchangeLog[] = [];
		const done = (result: IHttpWireResult): IHttpWireResult => logs.length ? { ...result, logs } : result;
		// TLS and protocol settings go through Node. Never for a sandboxed chat: its sends keep Chromium's checks.
		const wanted = httpNodeOptionsOf(settings);
		const node = confined ? undefined : wanted;
		if (confined && wanted) {
			logs.push({ level: 'warn', text: 'The request\'s TLS and protocol settings were not applied: this chat runs in Volt\'s sandbox.' });
		}
		const target = (url: string) => settings.encodeUrl ? encodeHttpUrl(httpRequestUrl(url)) : httpRequestUrl(url);
		let hop: IHttpHop = { method, url: target(rawUrl), headers, payload };
		let credentials = wire.credentials;
		let challenged = false;
		const redirects: { status: number; url: string }[] = [];
		const started = performance.now();
		try {
			for (; ;) {
				const headerRecord: Record<string, string> = {};
				for (const [key, value] of hop.headers) {
					// `Basic user:password` (REST Client's shorthand) goes out base64-encoded.
					const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
					headerRecord[key] = basic ? `Basic ${encodeBase64(VSBuffer.fromString(`${basic[1]}:${basic[2]}`))}` : value;
				}
				if (jar !== undefined) {
					// The jar's cookies for this hop's URL, after the ones the user wrote in a Cookie header of their own.
					const own = Object.keys(headerRecord).find(key => key.toLowerCase() === 'cookie');
					const cookie = this.cookies.header(jar, hop.url, own ? headerRecord[own] : undefined);
					if (cookie) {
						headerRecord[own ?? 'Cookie'] = cookie;
					}
				}
				const body = hop.method !== 'GET' && hop.method !== 'HEAD' ? { ...(hop.payload.data !== undefined ? { data: hop.payload.data } : {}), ...(hop.payload.dataBase64 !== undefined ? { dataBase64: hop.payload.dataBase64 } : {}) } : {};
				const context = await this.transport.request({
					type: hop.method, url: hop.url, headers: headerRecord, ...body, timeout: wire.timeoutMs,
					// The desktop transport hands every redirect back (`manualRedirects`); the web workbench's fetch cannot, and follows by itself.
					followRedirects: follow ? WEB_REDIRECTS : 0, ...(follow ? { manualRedirects: true } : {}), disableCache: true,
					...(credentials ? { credentials } : {}), ...(node ? { node } : {}),
				}, token);
				if (!follow && !context.res.statusCode) {
					// A browser's fetch answers a redirect it may not follow with an opaque response: no status, headers or location.
					return done({
						error: confined
							? 'The server answered with a redirect, which is not followed for a sandboxed chat, and this window cannot see where it points. Send the request to the URL it should go to: its host is judged by the chat\'s network rules.'
							: 'The server answered with a redirect, which the request\'s settings say not to follow, and this window cannot see where it points.'
					});
				}
				const buffer: VSBuffer = await streamToBuffer(context.stream);
				const responseHeaders: Record<string, string> = {};
				let httpVersion: string | undefined;
				for (const [key, value] of Object.entries(context.res.headers)) {
					if (key === VOLT_HTTP_VERSION_HEADER) {
						httpVersion = String(value);
					} else if (value !== undefined) {
						responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
					}
				}
				const setCookies = httpSetCookieLines(context.res.headers);
				if (jar !== undefined) {
					this.cookies.store(jar, hop.url, setCookies);
				}
				const status = context.res.statusCode ?? 0;
				if (status === 401 && wire.challenge && !challenged) {
					// Digest: the 401 carries the challenge the real request answers. Once.
					challenged = true;
					const answer: IHttpSignedRequest | undefined = await wire.challenge(status, responseHeaders);
					const refused = answer && confined ? confined.urlRefusal(httpRequestUrl(answer.url)) : undefined;
					if (answer && !refused) {
						hop = { ...hop, url: target(answer.url), headers: answer.headers };
						continue;
					}
				}
				const location = Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === 'location')?.[1];
				if (follow && location && HTTP_REDIRECT_STATUSES.has(status)) {
					let next: string | undefined;
					try {
						next = new URL(location, hop.url).toString();
					} catch { /* a location that is no URL: the redirect is the answer */ }
					if (next && !/^https?:/i.test(next)) {
						next = undefined;
					}
					if (next && redirects.length >= settings.maxRedirects) {
						logs.push({ level: 'warn', text: `Stopped after ${redirects.length} redirect${redirects.length === 1 ? '' : 's'}: the request's settings allow no more. The next one points to ${next}.` });
						next = undefined;
					}
					if (next) {
						redirects.push({ status, url: hop.url });
						const from = hop;
						hop = httpRedirectHop(from, status, next, settings);
						if (httpHostOf(from.url) !== httpHostOf(next)) {
							// The server's credentials are not another host's to be asked for.
							credentials = undefined;
						}
						continue;
					}
				}
				const durationMs = Math.round(performance.now() - started);
				const text = buffer.byteLength > MAX_BODY_KEPT ? `${buffer.slice(0, MAX_BODY_KEPT).toString()}\n\u2026 (${buffer.byteLength - MAX_BODY_KEPT} more bytes)` : buffer.toString();
				return done({
					response: {
						status, statusText: STATUS_TEXT[status] ?? '', headers: responseHeaders, body: text, durationMs, size: buffer.byteLength,
						...(redirects.length ? { redirects } : {}),
						...(httpVersion ? { httpVersion } : {}),
						...(setCookies.length ? { setCookies } : {}),
					}
				});
			}
		} catch (err) {
			return done({ error: token.isCancellationRequested ? 'Cancelled.' : err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * One MCP message over Streamable HTTP. The server's session is kept between sends: a message
	 * other than `initialize` to a server with no session yet initializes first (and says so in the
	 * log), `initialize` itself is followed by the `notifications/initialized` the protocol asks for,
	 * and an answer that comes as an event stream is read down to its JSON-RPC response.
	 */
	private async executeMcp(url: string, headers: readonly (readonly [string, string])[], body: string, sessionKey: string, wire: IHttpWire): Promise<IHttpWireResult> {
		const logs: IHttpExchangeLog[] = [];
		const has = (name: string) => headers.some(([key]) => key.toLowerCase() === name);
		const post = async (text: string): Promise<{ response?: IHttpResponseRecord; error?: string }> => {
			const session = this.mcpSessions.get(sessionKey);
			const sent: (readonly [string, string])[] = [
				...headers,
				...(session?.id && !has('mcp-session-id') ? [['Mcp-Session-Id', session.id] as const] : []),
				...(session?.version && !has('mcp-protocol-version') ? [['MCP-Protocol-Version', session.version] as const] : []),
			];
			const { logs: wireLogs, ...result } = await this.execute('POST', url, sent, { data: text }, wire);
			// What the wire itself reports (a setting not applied) is said once, however many messages the session takes.
			for (const log of wireLogs ?? []) {
				if (!logs.some(item => item.text === log.text)) {
					logs.push(log);
				}
			}
			const id = result.response ? Object.entries(result.response.headers).find(([key]) => key.toLowerCase() === 'mcp-session-id')?.[1] : undefined;
			if (id) {
				this.mcpSessions.set(sessionKey, { ...this.mcpSessions.get(sessionKey), id });
			}
			return result;
		};
		const initialized = async (result: { response?: IHttpResponseRecord }): Promise<boolean> => {
			const response = result.response;
			if (!response || response.status >= 400) {
				return false;
			}
			let version: string | undefined;
			try {
				const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
				const answer = JSON.parse(httpMcpResponseBody(type, response.body, undefined)) as { result?: { protocolVersion?: unknown } };
				version = typeof answer.result?.protocolVersion === 'string' ? answer.result.protocolVersion : undefined;
			} catch { /* an answer that is not JSON still started the session when the server gave an id */ }
			this.mcpSessions.set(sessionKey, { ...this.mcpSessions.get(sessionKey), version: version ?? MCP_PROTOCOL_VERSION });
			await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
			return true;
		};
		const method = httpMcpMethodOf(body);
		let id: unknown;
		try {
			id = (JSON.parse(body) as { id?: unknown }).id;
		} catch { /* the server says what is wrong with it */ }
		if (method === 'initialize') {
			this.mcpSessions.delete(sessionKey);
		} else if (!this.mcpSessions.has(sessionKey) && !has('mcp-session-id')) {
			const started = await post(httpMcpMessage('initialize', 0));
			if (started.error) {
				return { error: `Could not initialize the MCP session: ${started.error}` };
			}
			if (await initialized(started)) {
				const session = this.mcpSessions.get(sessionKey);
				logs.push({ level: 'info', text: `Initialized the MCP session first${session?.id ? ` (session ${session.id})` : ''}.` });
			}
		}
		let result = await post(body);
		if (result.response?.status === 404 && this.mcpSessions.get(sessionKey)?.id && method !== 'initialize') {
			// The server forgot the session (it restarted): start a new one and send again.
			this.mcpSessions.delete(sessionKey);
			if (await initialized(await post(httpMcpMessage('initialize', 0)))) {
				logs.push({ level: 'info', text: 'The server had dropped the session: initialized a new one and sent again.' });
				result = await post(body);
			}
		}
		if (method === 'initialize' && await initialized(result)) {
			logs.push({ level: 'info', text: 'Session started; sent notifications/initialized.' });
		}
		const response = result.response;
		if (response) {
			const typeKey = Object.keys(response.headers).find(key => key.toLowerCase() === 'content-type');
			const type = typeKey ? response.headers[typeKey] : '';
			if (/text\/event-stream/i.test(type)) {
				// The JSON-RPC answer is what the user asked for; the stream around it is transport.
				logs.push({ level: 'info', text: 'The answer came as an event stream; showing its JSON-RPC message.' });
				return { response: { ...response, body: httpMcpResponseBody(type, response.body, id), headers: { ...response.headers, ...(typeKey ? { [typeKey]: 'application/json' } : {}), 'x-volt-transport': 'text/event-stream' } }, logs };
			}
		}
		return { ...result, ...(logs.length ? { logs } : {}) };
	}

	async save(uri: URI, request: IHttpRequestSpec, line?: number): Promise<number> {
		const existing = await this.fileService.readFile(uri).then(file => file.value.toString(), () => '');
		const block = serializeHttpRequest(request);
		const lines = existing.split('\n');
		let text: string;
		let at: number;
		const parsed = parseHttpFile(existing);
		const current = line ? parsed.requests.find(item => item.line === line) : undefined;
		if (current) {
			// The block runs from its first line (after the separator and @name) to the next ###.
			let start = current.line - 1;
			while (start > 0 && /^\s*(?:#|\/\/)\s*@name/.test(lines[start - 1])) {
				start--;
			}
			let end = start + 1;
			while (end < lines.length && !lines[end].startsWith('###')) {
				end++;
			}
			const trailing = end < lines.length ? [''] : [];
			text = [...lines.slice(0, start), ...block.split('\n'), ...trailing, ...lines.slice(end)].join('\n');
			at = start + 1 + (request.name ? 1 : 0);
		} else {
			const prefix = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n###\n` : '';
			text = `${prefix}${block}\n`;
			at = prefix.split('\n').length + (request.name ? 1 : 0);
		}
		await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		this.indexes.clear();
		this._onDidChangeIndex.fire();
		return at;
	}

	private readHistory(): IHttpExchange[] {
		try {
			const raw = JSON.parse(this.storage.get(HISTORY_KEY, StorageScope.WORKSPACE) ?? '[]') as (Omit<IHttpExchange, 'source'> & { source?: { uri: string; line: number } })[];
			return raw.map(({ source, ...item }): IHttpExchange => ({ ...item, ...(source ? { source: { uri: URI.parse(source.uri), line: source.line } } : {}) }));
		} catch {
			return [];
		}
	}

	private storeHistory(): void {
		// Bodies are kept short in storage; the live session has them whole.
		const compact = this._history.slice(0, MAX_HISTORY).map(item => ({
			...item,
			...(item.source ? { source: { uri: item.source.uri.toString(), line: item.source.line } } : {}),
			...(item.response ? { response: { ...item.response, body: item.response.body.slice(0, 16_000) } } : {}),
		}));
		this.storage.store(HISTORY_KEY, JSON.stringify(compact), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

/** How many redirects the web workbench's fetch may follow by itself (the desktop app follows hop by hop, up to the request's own maximum). */
const WEB_REDIRECTS = 5;

const HTTP_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function httpHostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * The hop after a redirect to `location` (absolute). 301, 302 and 303 go on as GET without the body
 * unless the settings keep the original method; 307 and 308 always keep method and body. Another
 * host does not get the Authorization header (unless the settings say so) nor a Cookie header the
 * user wrote. The Referer is the URL that redirected, unless the settings remove it.
 */
export function httpRedirectHop(hop: IHttpHop, status: number, location: string, settings: Pick<HttpWireSettings, 'followOriginalHttpMethod' | 'followAuthorizationHeader' | 'removeRefererHeaderOnRedirect'>): IHttpHop {
	const toGet = (status === 301 || status === 302 || status === 303) && !settings.followOriginalHttpMethod && hop.method !== 'GET' && hop.method !== 'HEAD';
	const sameHost = httpHostOf(hop.url) === httpHostOf(location);
	const headers = hop.headers.filter(([key]) => {
		const name = key.toLowerCase();
		if (name === 'host' || name === 'referer') {
			return false;
		}
		if (toGet && (name === 'content-type' || name === 'content-length' || name === 'transfer-encoding')) {
			return false;
		}
		if (!sameHost && (name === 'cookie' || (name === 'authorization' && !settings.followAuthorizationHeader))) {
			return false;
		}
		return true;
	});
	if (!settings.removeRefererHeaderOnRedirect) {
		// Without what a referrer never carries: the fragment and a name and password in the URL.
		headers.push(['Referer', hop.url.replace(/#.*$/, '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1')]);
	}
	return { method: toGet ? 'GET' : hop.method, url: location, headers, payload: toGet ? {} : hop.payload };
}

/**
 * What a request's settings ask of Node's own stack, or undefined when Chromium's can send it (the
 * default: the user's proxy and the system's certificates). Chromium takes none of these per
 * request, so a request that turns off certificate verification, pins the HTTP version, disables
 * TLS versions, picks cipher suites or their order, or asks for the strict parser goes through Node.
 */
export function httpNodeOptionsOf(settings: HttpWireSettings): IVoltHttpNodeOptions | undefined {
	const node: IVoltHttpNodeOptions = {
		...(settings.strictSSL ? {} : { rejectUnauthorized: false }),
		...(settings.httpVersion !== 'auto' ? { httpVersion: settings.httpVersion } : {}),
		...(settings.tlsDisabledProtocols.length ? { disabledProtocols: settings.tlsDisabledProtocols } : {}),
		...(settings.tlsCipherSuites.length ? { ciphers: settings.tlsCipherSuites } : {}),
		...(settings.tlsPreferServerCiphers ? { honorCipherOrder: true } : {}),
	};
	if (!Object.keys(node).length && !settings.strictHttpParser) {
		return undefined;
	}
	// Node's parser is strict unless told otherwise; the setting's default is the lenient one, as Postman's.
	return settings.strictHttpParser ? node : { ...node, insecureHTTPParser: true };
}

/** The URL a request goes to: as written, or `http://` in front of one without a scheme (`localhost:3000/x`). */
export function httpRequestUrl(raw: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
	100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
	301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
	409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
	500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/**
 * The web workbench's transport: the window's request service (its fetch, so the server must allow
 * the page's origin). The desktop app replaces it with the main process's (electron-browser).
 */
export class WindowHttpTransport implements IVoltHttpTransport {
	declare readonly _serviceBrand: undefined;
	constructor(@IRequestService private readonly requestService: IRequestService) { }
	request(options: IVoltHttpRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const { dataBase64, ...rest } = options;
		// The window's fetch takes the bytes as they are.
		return this.requestService.request(dataBase64 !== undefined ? { ...rest, data: decodeBase64(dataBase64).buffer as unknown as string } : rest, token);
	}
}

/** The web workbench has no way to hold these connections open outside the page; the desktop app replaces this. */
class NoHttpStreams implements IVoltHttpStreams {
	declare readonly _serviceBrand: undefined;
	readonly onDidStreamEvent = Event.None as Event<IVoltHttpStreamEvent>;
	private refuse(): Promise<never> {
		return Promise.reject(new Error('WebSocket, SSE, Socket.IO, MQTT and gRPC connections need the Volt desktop app.'));
	}
	open(): Promise<void> { return this.refuse(); }
	send(): Promise<void> { return this.refuse(); }
	close(): Promise<void> { return Promise.resolve(); }
	describeGrpc(): Promise<readonly IVoltGrpcServiceInfo[]> { return this.refuse(); }
}

/** The web workbench cannot open a sign-in window of its own: OAuth 2.0 signs in in the browser there. */
class NoHttpOAuth implements IVoltHttpOAuth {
	declare readonly _serviceBrand: undefined;
	signIn(): Promise<VoltOAuthSignInResult> { return Promise.resolve({ unsupported: true }); }
}

registerSingleton(IVoltHttpStreams, NoHttpStreams, InstantiationType.Delayed);
registerSingleton(IVoltHttpOAuth, NoHttpOAuth, InstantiationType.Delayed);
registerSingleton(IVoltHttpTransport, WindowHttpTransport, InstantiationType.Delayed);
/** The window's client: its sends use the jars the Cookies dialog shows (`IVoltHttpCookies`). */
class WorkbenchVoltHttpService extends VoltHttpService {
	constructor(
		@IVoltHttpTransport transport: IVoltHttpTransport,
		@IFileService fileService: IFileService,
		@ISearchService searchService: ISearchService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IStorageService storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoltHttpCookies cookies: IVoltHttpCookies,
	) {
		super(transport, fileService, searchService, workspace, storage, instantiationService, cookies);
	}
}

registerSingleton(IVoltHttpService, WorkbenchVoltHttpService, InstantiationType.Delayed);
