/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { encodeBase64, streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
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

export interface IVoltHttpService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeIndex: Event<void>;
	readonly onDidChangeEnvironment: Event<void>;
	readonly onDidSend: Event<IHttpExchange>;
	/** Every .http / .rest file in the workspace with its requests. */
	index(): Promise<readonly IHttpFileEntry[]>;
	environments(): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>>;
	readonly environment: string | undefined;
	setEnvironment(name: string | undefined): void;
	readonly history: readonly IHttpExchange[];
	/** Fills in variables, sends, records the exchange (and the named response for chaining). */
	send(request: IHttpRequestSpec, options?: { readonly source?: URI; readonly fileVariables?: Readonly<Record<string, string>>; readonly token?: CancellationToken; readonly timeoutMs?: number }): Promise<IHttpExchange>;
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

	private files: ResourceMap<IHttpFileEntry> | undefined;
	private indexing: Promise<void> | undefined;
	private readonly responses = new Map<string, IHttpResponseRecord>();
	private readonly queryBuilder: QueryBuilder;
	private readonly reindex = this._register(new RunOnceScheduler(() => { this.files = undefined; this._onDidChangeIndex.fire(); }, 400));
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

	async index(): Promise<readonly IHttpFileEntry[]> {
		if (!this.files) {
			this.indexing ??= this.buildIndex().finally(() => this.indexing = undefined);
			await this.indexing;
		}
		return [...(this.files ?? new ResourceMap()).values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path));
	}

	private async buildIndex(): Promise<void> {
		const folders = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
		const next = new ResourceMap<IHttpFileEntry>();
		if (folders.length) {
			const query = this.queryBuilder.file(folders, { includePattern: ['**/*.http', '**/*.rest'], excludePattern: [{ pattern: '**/node_modules/**' }], maxResults: MAX_FILES });
			const found = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
			await Promise.all((found?.results ?? []).map(async result => {
				const text = await this.fileService.readFile(result.resource).then(file => file.value.toString(), () => undefined);
				if (text !== undefined) {
					const parsed = parseHttpFile(text);
					next.set(result.resource, { uri: result.resource, variables: parsed.variables, requests: parsed.requests });
				}
			}));
		}
		this.files = next;
	}

	async environments(): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
		const texts: (string | undefined)[] = [];
		for (const folder of this.workspace.getWorkspace().folders) {
			for (const name of ['http-client.env.json', 'http-client.private.env.json', '.vscode/http-client.env.json']) {
				texts.push(await this.fileService.readFile(joinPath(folder.uri, name)).then(file => file.value.toString(), () => undefined));
			}
		}
		return parseHttpEnvironments(...texts);
	}

	defaultFile(): URI | undefined {
		const folder = this.workspace.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, 'requests.http') : undefined;
	}

	async send(request: IHttpRequestSpec, options?: { readonly source?: URI; readonly fileVariables?: Readonly<Record<string, string>>; readonly token?: CancellationToken; readonly timeoutMs?: number }): Promise<IHttpExchange> {
		const envs = await this.environments();
		const fileVariables = options?.fileVariables ?? (options?.source ? (await this.index()).find(entry => entry.uri.toString() === options.source!.toString())?.variables : undefined) ?? {};
		const scope: IHttpScope = { file: fileVariables, env: (this._environment && envs[this._environment]) || {}, responses: this.responses };
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
		let exchange: IHttpExchange;
		if (missing.length) {
			exchange = { ...base, error: `Unresolved variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}${this._environment ? ` (environment "${this._environment}")` : ' (no environment selected)'}.` };
		} else {
			exchange = { ...base, ...(await this.execute(request.method, url, headers, body, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, options?.token ?? CancellationToken.None)) };
		}
		if (request.name && exchange.response) {
			this.responses.set(request.name, exchange.response);
		}
		this._history = [exchange, ...this._history].slice(0, MAX_HISTORY);
		this.storeHistory();
		this._onDidSend.fire(exchange);
		return exchange;
	}

	private async execute(method: string, rawUrl: string, headers: readonly (readonly [string, string])[], body: string | undefined, timeoutMs: number, token: CancellationToken): Promise<{ response?: IHttpResponseRecord; error?: string }> {
		const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
		const headerRecord: Record<string, string> = {};
		for (const [key, value] of headers) {
			// `Basic user:password` (REST Client's shorthand) goes out base64-encoded.
			const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
			headerRecord[key] = basic ? `Basic ${encodeBase64(VSBuffer.fromString(`${basic[1]}:${basic[2]}`))}` : value;
		}
		const started = performance.now();
		try {
			const context = await this.requestService.request({ type: method, url, headers: headerRecord, ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { data: body } : {}), timeout: timeoutMs, followRedirects: 5, disableCache: true }, token);
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
		this.files = undefined;
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

const STATUS_TEXT: Readonly<Record<number, string>> = {
	100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
	301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
	409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
	500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

registerSingleton(IVoltHttpService, VoltHttpService, InstantiationType.Delayed);
