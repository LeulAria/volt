/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { encodeBase64, streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IHttpRequestSpec, IHttpResponseRecord, IHttpScope, missingVariables, parseHttpEnvironments, parseHttpFile, resolveHttpVariables, serializeHttpRequest } from '../../../services/voltRuntime/common/ide/httpFile.js';

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
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
	readonly response?: IHttpResponseRecord;
	readonly error?: string;
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
	/** The environment for this send only; the user's selected one when absent. */
	readonly environment?: string;
	readonly confined?: IHttpConfinement;
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
	setEnvironment(name: string | undefined): void;
	readonly history: readonly IHttpExchange[];
	/** Fills in variables, sends, records the exchange (and the named response for chaining). */
	send(request: IHttpRequestSpec, options?: IHttpSendOptions): Promise<IHttpExchange>;
	/** Saves a request into a .http file: replaces the one at `line`, or appends. */
	save(uri: URI, request: IHttpRequestSpec, line?: number): Promise<number>;
	/** The default file new requests go to. */
	defaultFile(): URI | undefined;
}

/**
 * The HTTP client's one state, shared by the HTTP view, the request editor and the agents' `ide
 * http` capability: the workspace's request files, environments, earlier responses (for
 * `{{login.response.body.$.token}}`) and history. Requests go out through the editor's request
 * service (node, so no CORS, with the user's proxy settings).
 */
export class VoltHttpService extends Disposable implements IVoltHttpService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIndex = this._register(new Emitter<void>());
	readonly onDidChangeIndex = this._onDidChangeIndex.event;
	private readonly _onDidChangeEnvironment = this._register(new Emitter<void>());
	readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;
	private readonly _onDidSend = this._register(new Emitter<IHttpExchange>());
	readonly onDidSend = this._onDidSend.event;

	/** Request files per folder ('' for the window's folders), dropped whenever one changes. */
	private readonly indexes = new Map<string, Promise<ResourceMap<IHttpFileEntry>>>();
	private readonly responses = new Map<string, IHttpResponseRecord>();
	/** Sandboxed chats' named responses, kept apart from the user's (`IHttpConfinement.key`). */
	private readonly confinedResponses = new Map<string, Map<string, IHttpResponseRecord>>();
	/** Chats' folders outside the window's: nothing else watches them, so their request files would go stale. */
	private readonly watched = this._register(new DisposableMap<string>());
	private readonly queryBuilder: QueryBuilder;
	private readonly reindex = this._register(new RunOnceScheduler(() => { this.indexes.clear(); this._onDidChangeIndex.fire(); }, 400));
	private _history: IHttpExchange[];
	private _environment: string | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		this._environment = storage.get(ENV_KEY, StorageScope.WORKSPACE);
		this._history = this.readHistory();
		this._register(fileService.onDidFilesChange(e => {
			if (e.rawAdded.concat(e.rawUpdated, e.rawDeleted).some(uri => /\.(?:http|rest)$|http-client(?:\.private)?\.env\.json$/.test(uri.path))) {
				this.reindex.schedule();
			}
		}));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.reindex.schedule()));
	}

	get environment(): string | undefined {
		return this._environment;
	}

	get history(): readonly IHttpExchange[] {
		return this._history;
	}

	setEnvironment(name: string | undefined): void {
		this._environment = name;
		if (name) {
			this.storage.store(ENV_KEY, name, StorageScope.WORKSPACE, StorageTarget.USER);
		} else {
			this.storage.remove(ENV_KEY, StorageScope.WORKSPACE);
		}
		this._onDidChangeEnvironment.fire();
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

	/** `root` (a chat's folder, watched from now on when the window does not hold it), else the window's folders. */
	private foldersOf(root: URI | undefined): URI[] {
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

	defaultFile(): URI | undefined {
		const folder = this.workspace.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, 'requests.http') : undefined;
	}

	async send(request: IHttpRequestSpec, options?: IHttpSendOptions): Promise<IHttpExchange> {
		const confined = options?.confined;
		const envs = await this.environments(options?.root, confined?.readable);
		const source = options?.source && (!confined || await confined.readable(options.source)) ? options.source : undefined;
		const fileVariables = options?.fileVariables ?? (source ? (await this.index(options?.root)).find(entry => entry.uri.toString() === source.toString())?.variables : undefined) ?? {};
		let responses = this.responses;
		if (confined) {
			responses = this.confinedResponses.get(confined.key) ?? new Map<string, IHttpResponseRecord>();
			this.confinedResponses.set(confined.key, responses);
		}
		const environment = options?.environment ?? this._environment;
		const scope: IHttpScope = { file: fileVariables, env: (environment && envs[environment]) || {}, responses };
		const url = resolveHttpVariables(request.url, scope);
		const headers = request.headers.map(([key, value]) => [key, resolveHttpVariables(value, scope)] as const);
		const body = request.body !== undefined ? resolveHttpVariables(request.body, scope) : undefined;
		const base = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			at: Date.now(),
			...(request.name ? { name: request.name } : {}),
			...(options?.source ? { source: { uri: options.source, line: request.line } } : {}),
			method: request.method,
			url,
			headers,
			...(body !== undefined ? { body } : {}),
		};
		const missing = missingVariables([url, ...headers.map(([, value]) => value), body ?? ''].join('\n'));
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
			exchange = { ...base, ...(await this.execute(request.method, url, headers, body, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, options?.token ?? CancellationToken.None, confined ? 0 : 5)) };
		}
		if (request.name && exchange.response) {
			responses.set(request.name, exchange.response);
		}
		this._history = [exchange, ...this._history].slice(0, MAX_HISTORY);
		this.storeHistory();
		this._onDidSend.fire(exchange);
		return exchange;
	}

	private async execute(method: string, rawUrl: string, headers: readonly (readonly [string, string])[], body: string | undefined, timeoutMs: number, token: CancellationToken, followRedirects: number): Promise<{ response?: IHttpResponseRecord; error?: string }> {
		const url = httpRequestUrl(rawUrl);
		const headerRecord: Record<string, string> = {};
		for (const [key, value] of headers) {
			// `Basic user:password` (REST Client's shorthand) goes out base64-encoded.
			const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
			headerRecord[key] = basic ? `Basic ${encodeBase64(VSBuffer.fromString(`${basic[1]}:${basic[2]}`))}` : value;
		}
		const started = performance.now();
		try {
			const context = await this.requestService.request({ type: method, url, headers: headerRecord, ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { data: body } : {}), timeout: timeoutMs, followRedirects, disableCache: true }, token);
			if (!followRedirects && !context.res.statusCode) {
				// A browser's fetch answers a redirect it may not follow with an opaque response: no status, headers or location.
				return { error: 'The server answered with a redirect, which is not followed for a sandboxed chat, and this window cannot see where it points. Send the request to the URL it should go to: its host is judged by the chat\'s network rules.' };
			}
			const buffer: VSBuffer = await streamToBuffer(context.stream);
			const durationMs = Math.round(performance.now() - started);
			const responseHeaders: Record<string, string> = {};
			for (const [key, value] of Object.entries(context.res.headers)) {
				if (value !== undefined) {
					responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
				}
			}
			const text = buffer.byteLength > MAX_BODY_KEPT ? `${buffer.slice(0, MAX_BODY_KEPT).toString()}\n\u2026 (${buffer.byteLength - MAX_BODY_KEPT} more bytes)` : buffer.toString();
			const status = context.res.statusCode ?? 0;
			return { response: { status, statusText: STATUS_TEXT[status] ?? '', headers: responseHeaders, body: text, durationMs, size: buffer.byteLength } };
		} catch (err) {
			return { error: token.isCancellationRequested ? 'Cancelled.' : err instanceof Error ? err.message : String(err) };
		}
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

registerSingleton(IVoltHttpService, VoltHttpService, InstantiationType.Delayed);
