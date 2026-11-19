/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createBlobWorker } from '../../../../base/browser/webWorkerFactory.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoltGrpcServiceInfo, IVoltHttpStreamEvent, IVoltHttpStreamMessage, IVoltHttpStreams, IVoltHttpStreamSpec } from '../../../../platform/voltHttp/common/voltHttpStreams.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { missingVariables, resolveHttpVariables } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { httpGrpcTarget, httpProtocolInfo, HttpProtocol, IHttpMessage } from '../common/httpProtocols.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { cloneHttp, effectiveHttpAuth, emptyHttpCollection, findHttpItem, httpFileNameFor, httpRequestsOf, httpVariableRecord, httpWireRequest, IHttpCollection, IHttpEnvironment, IHttpFolder, IHttpItem, IHttpKeyValue, IHttpRequest, HttpCollectionFormat, keepHttpIds, newHttpId, withNewHttpIds } from '../common/httpCollection.js';
import { collectionToHttpFile, httpFileToCollection, parseHttpClientEnvFile, refreshHttpFileModel, updateHttpClientEnvFile } from '../common/httpDotHttp.js';
import { detectHttpImport, IHttpImport } from '../common/httpImport.js';
import { collectionToPostman, environmentToPostman, isPostmanCollection, postmanToCollection, postmanToEnvironment } from '../common/httpPostman.js';
import { httpScriptWorkerSource, IHttpScriptInput, IHttpScriptOutput, IHttpScriptRequest, IHttpScriptVariables } from '../common/httpScriptRuntime.js';
import { httpRequestUrl, IHttpConfinement, IHttpExchange, IHttpExchangeLog, IHttpExchangeTest, IHttpStreamEntry, IVoltHttpService } from './voltHttpService.js';

export const IVoltHttpCollections = createDecorator<IVoltHttpCollections>('voltHttpCollections');

/** Where a project's new collections and environments are written, relative to its folder. */
export const HTTP_COLLECTIONS_FOLDER_SETTING = 'volt.http.collectionsFolder';

const COLLECTION_FILE = /\.(?:http|rest)$|\.postman_collection\.json$/i;
const ENVIRONMENT_FILE = /\.postman_(?:environment|globals)\.json$|(?:^|\/)http-client(?:\.private)?\.env\.json$/i;
const MAX_FILES = 400;
const SCRIPT_TIMEOUT_MS = 5000;

/** A collection file, loaded: one object per file for the whole window, whoever shows it. */
export interface IHttpCollectionEntry {
	readonly uri: URI;
	collection: IHttpCollection;
	/** Why the file could not be read as a collection; `collection` is empty then. */
	error?: string;
	/** The file's JSON indentation, kept on save. */
	indent: string;
}

export interface IHttpEnvironmentEntry {
	/** The file and the environment's name in it. */
	readonly id: string;
	readonly uri: URI;
	readonly environment: IHttpEnvironment;
	/** A Postman globals file: its variables always apply. */
	readonly globals: boolean;
	/** `http-client.env.json`'s `$shared`: merged under that file's environments. */
	readonly shared: boolean;
}

export interface IHttpSendContext {
	/** The collection the request belongs to: its variables, auth and scripts apply. */
	readonly collection?: URI;
	/** The project the client is open for. */
	readonly root?: URI;
	readonly token?: CancellationToken;
	readonly environment?: string;
	readonly timeoutMs?: number;
	readonly confined?: IHttpConfinement;
	/** A connection's send (WebSocket, SSE...): how long it listens before the exchange is made. */
	readonly stream?: IHttpStreamRunOptions;
	/** Of the post-response tests, run only those with these names ("Run Test" on a request with no response yet). */
	readonly onlyTests?: readonly string[];
	/** Values for this send only (a flow's extracted values, a data row): they win over every other scope. */
	readonly variables?: Readonly<Record<string, string>>;
	/** Lines of the request's own scripts where the run records what is in reach (snapshot breakpoints). */
	readonly breakpoints?: { readonly preRequest?: readonly number[]; readonly test?: readonly number[] };
}

type HttpExchangeBreak = NonNullable<IHttpExchange['breaks']>[number];

/** A streaming request ready to connect: every variable filled in, auth applied, proto files read. */
export interface IHttpStreamPlan {
	readonly protocol: HttpProtocol;
	readonly spec: IVoltHttpStreamSpec;
	/** The request's own messages, sent in order once the connection opens. */
	readonly messages: readonly IVoltHttpStreamMessage[];
	/** Fills in `{{variables}}` the way the plan's own fields were (for messages typed later). */
	readonly resolve: (text: string) => string;
}

export interface IHttpStreamRunOptions {
	/** How long to stay connected after the request's messages went out (ms). 3000 when absent, at most 60000. */
	readonly waitMs?: number;
	/** Stop once this many messages came in. */
	readonly maxMessages?: number;
}

export interface IHttpRunOptions extends IHttpSendContext {
	/** The folder to run; the whole collection when absent. */
	readonly folderId?: string;
	readonly delayMs?: number;
	readonly stopOnFailure?: boolean;
	readonly iterations?: number;
	readonly onProgress?: (result: IHttpRunResult, index: number, total: number) => void;
}

export interface IHttpRunResult {
	readonly requestId: string;
	readonly name: string;
	readonly path: readonly string[];
	readonly iteration: number;
	readonly exchange: IHttpExchange;
}

export interface IHttpRunSummary {
	readonly results: readonly IHttpRunResult[];
	readonly requests: number;
	readonly passed: number;
	readonly failed: number;
	readonly errors: number;
	readonly durationMs: number;
	readonly stopped: boolean;
}

export interface IHttpImportResult {
	readonly kind: IHttpImport['kind'];
	/** The file written (a collection or an environment). */
	readonly uri?: URI;
	/** A pasted cURL command: a request to open, saved nowhere yet. */
	readonly request?: IHttpRequest;
	readonly message: string;
}

export interface IVoltHttpCollections {
	readonly _serviceBrand: undefined;
	/** A collection changed (its uri), or the set of collection files did (undefined). */
	readonly onDidChange: Event<URI | undefined>;
	readonly onDidChangeEnvironments: Event<void>;
	/** An open request's unsaved edits changed (its key). */
	readonly onDidChangeDraft: Event<string>;

	/** The project's collection files (`.http`, `.rest`, `*.postman_collection.json`), loaded. */
	collections(root: URI | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpCollectionEntry[]>;
	/** A loaded collection, or undefined until `load` or `collections` read it. */
	get(uri: URI): IHttpCollectionEntry | undefined;
	load(uri: URI): Promise<IHttpCollectionEntry | undefined>;

	createCollection(root: URI | undefined, name: string, format: HttpCollectionFormat): Promise<URI>;
	deleteCollection(uri: URI): Promise<void>;
	/** Changes the collection's own fields (name, description, variables, auth, scripts) and saves. */
	updateCollection(uri: URI, mutate: (collection: IHttpCollection) => void): Promise<void>;
	addItem(uri: URI, parentId: string | undefined, item: IHttpItem, index?: number): Promise<string>;
	updateItem(uri: URI, id: string, mutate: (item: IHttpItem) => void): Promise<void>;
	removeItem(uri: URI, id: string): Promise<void>;
	duplicateItem(uri: URI, id: string): Promise<string>;
	moveItem(from: URI, id: string, to: URI, parentId: string | undefined, index?: number): Promise<void>;

	/** Reads `text` as a Postman collection or environment, OpenAPI, HAR, `.http` or cURL and writes what it holds into the project. */
	importText(root: URI | undefined, text: string, fileName?: string): Promise<IHttpImportResult>;
	/** The collection as a Postman v2.1 JSON or an `.http` file's text. */
	exportText(uri: URI, format: HttpCollectionFormat): string;

	environments(root: URI | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpEnvironmentEntry[]>;
	createEnvironment(root: URI | undefined, name: string, variables?: readonly IHttpKeyValue[]): Promise<IHttpEnvironmentEntry>;
	saveEnvironment(entry: IHttpEnvironmentEntry, name: string, variables: readonly IHttpKeyValue[]): Promise<void>;
	deleteEnvironment(entry: IHttpEnvironmentEntry): Promise<void>;
	/** Every variable a request of `collection` sees, by where it comes from (for highlighting and hovers). */
	variablesFor(root: URI | undefined, collection: URI | undefined): Promise<ReadonlyMap<string, { readonly value: string; readonly source: string }>>;
	/** Gives a variable in reach a new value where it is defined (the selected environment, the collection or the globals). False when it is defined nowhere. */
	setVariable(root: URI | undefined, collection: URI | undefined, name: string, value: string): Promise<boolean>;

	draftOf(key: string): IHttpRequest | undefined;
	setDraft(key: string, request: IHttpRequest | undefined): void;

	/** Sends a request with its collection's variables, inherited auth and scripts; the exchange carries the tests. */
	send(request: IHttpRequest, context: IHttpSendContext): Promise<IHttpExchange>;
	/** Sends a collection's (or folder's) requests in order and reports each one's tests. */
	run(uri: URI, options: IHttpRunOptions): Promise<IHttpRunSummary>;

	/**
	 * Runs the request's post-response scripts again on a response already in hand (after its tests
	 * changed). With `only`, just the tests of those names run: their results take the place of the
	 * ones the exchange had, and every other result stays as it was.
	 */
	retest(request: IHttpRequest, context: IHttpSendContext, exchange: IHttpExchange, only?: readonly string[]): Promise<IHttpExchange>;
	/** What a streaming request connects with. Rejects with what is missing (a variable, a method, a file). */
	streamPlan(request: IHttpRequest, context: IHttpSendContext): Promise<IHttpStreamPlan>;
	/** The services and methods a gRPC request's server offers (from its .proto file, else reflection). */
	describeGrpc(request: IHttpRequest, context: IHttpSendContext): Promise<readonly IVoltGrpcServiceInfo[]>;
}

interface IRootIndex {
	readonly collections: URI[];
	readonly environments: URI[];
}

/** Values scripts set while the window is open (Postman's "current values"): never written to the files. */
interface IVariableOverlay {
	environment: Record<string, Record<string, string>>;
	collection: Record<string, Record<string, string>>;
	globals: Record<string, string>;
}

export class VoltHttpCollections extends Disposable implements IVoltHttpCollections {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI | undefined>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeEnvironments = this._register(new Emitter<void>());
	readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
	private readonly _onDidChangeDraft = this._register(new Emitter<string>());
	readonly onDidChangeDraft = this._onDidChangeDraft.event;

	private readonly models = new ResourceMap<IHttpCollectionEntry>();
	private readonly loading = new ResourceMap<Promise<IHttpCollectionEntry | undefined>>();
	/** What this service last wrote to a file: its own change events are not reloads. */
	private readonly written = new ResourceMap<string>();
	private readonly writes = new ResourceMap<Promise<void>>();
	private readonly indexes = new Map<string, Promise<IRootIndex>>();
	private readonly drafts = new Map<string, IHttpRequest>();
	private readonly overlays = new Map<string, IVariableOverlay>();
	private readonly queryBuilder: QueryBuilder;
	private readonly changed = new ResourceMap<true>();
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.applyFileChanges(), 150));

	constructor(
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IVoltHttpStreams private readonly streams: IVoltHttpStreams,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		this._register(fileService.onDidFilesChange(event => {
			let any = false;
			for (const uri of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
				if (COLLECTION_FILE.test(uri.path) || ENVIRONMENT_FILE.test(uri.path)) {
					this.changed.set(uri, true);
					any = true;
				}
			}
			if (any) {
				this.refresh.schedule();
			}
		}));
	}

	// --- Files -----------------------------------------------------------------------------------

	private async applyFileChanges(): Promise<void> {
		const uris = [...this.changed.keys()];
		this.changed.clear();
		let environments = false;
		let listChanged = false;
		for (const uri of uris) {
			if (ENVIRONMENT_FILE.test(uri.path)) {
				environments = true;
				continue;
			}
			const text = await this.read(uri);
			if (text !== undefined && this.written.get(uri) === text) {
				continue;
			}
			const known = this.models.get(uri);
			if (text === undefined) {
				if (known) {
					this.models.delete(uri);
				}
				listChanged = true;
			} else if (known) {
				this.parseInto(known, text);
				this._onDidChange.fire(uri);
			} else {
				listChanged = true;
			}
		}
		if (listChanged || environments) {
			this.indexes.clear();
		}
		if (listChanged) {
			this._onDidChange.fire(undefined);
		}
		if (environments) {
			this._onDidChangeEnvironments.fire();
		}
	}

	private read(uri: URI): Promise<string | undefined> {
		return this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
	}

	private index(root: URI | undefined): Promise<IRootIndex> {
		const key = root?.toString() ?? '';
		let index = this.indexes.get(key);
		if (!index) {
			index = this.buildIndex(this.http.foldersOf(root));
			this.indexes.set(key, index);
		}
		return index;
	}

	private async buildIndex(folders: readonly URI[]): Promise<IRootIndex> {
		const out: IRootIndex = { collections: [], environments: [] };
		if (!folders.length) {
			return out;
		}
		const query = this.queryBuilder.file([...folders], {
			includePattern: ['**/*.http', '**/*.rest', '**/*.postman_collection.json', '**/*.postman_environment.json', '**/*.postman_globals.json', '**/http-client.env.json', '**/http-client.private.env.json'],
			excludePattern: [{ pattern: '**/node_modules/**' }],
			maxResults: MAX_FILES,
		});
		const found = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
		for (const result of found?.results ?? []) {
			(ENVIRONMENT_FILE.test(result.resource.path) ? out.environments : out.collections).push(result.resource);
		}
		// The well-known environment files are read where they are: a search skips ignored files, and the private one usually is.
		for (const folder of folders) {
			for (const name of ['http-client.env.json', 'http-client.private.env.json', '.vscode/http-client.env.json']) {
				const uri = joinPath(folder, name);
				if (!out.environments.some(known => known.toString() === uri.toString()) && await this.fileService.exists(uri)) {
					out.environments.push(uri);
				}
			}
		}
		const byPath = (a: URI, b: URI) => a.path.localeCompare(b.path);
		out.collections.sort(byPath);
		out.environments.sort(byPath);
		return out;
	}

	private parseInto(entry: IHttpCollectionEntry, text: string): void {
		const previous = entry.error ? undefined : entry.collection;
		const fallbackName = basename(entry.uri).replace(/\.(?:postman_collection\.json|http|rest)$/i, '');
		try {
			let next: IHttpCollection;
			if (/\.json$/i.test(entry.uri.path)) {
				const json: unknown = JSON.parse(text);
				if (!isPostmanCollection(json)) {
					throw new Error('Not a Postman collection.');
				}
				next = postmanToCollection(json);
				entry.indent = /^\{\r?\n( +)"/.exec(text)?.[1] ?? '\t';
			} else {
				next = httpFileToCollection(text, fallbackName);
			}
			keepHttpIds(next, previous);
			entry.collection = next;
			entry.error = undefined;
		} catch (err) {
			entry.collection = emptyHttpCollection(fallbackName, /\.json$/i.test(entry.uri.path) ? 'postman' : 'http');
			entry.error = err instanceof Error ? err.message : String(err);
		}
	}

	get(uri: URI): IHttpCollectionEntry | undefined {
		return this.models.get(uri);
	}

	load(uri: URI): Promise<IHttpCollectionEntry | undefined> {
		const known = this.models.get(uri);
		if (known) {
			return Promise.resolve(known);
		}
		let pending = this.loading.get(uri);
		if (!pending) {
			pending = this.read(uri).then(text => {
				this.loading.delete(uri);
				if (text === undefined) {
					return undefined;
				}
				// A load that raced another keeps the first one's object: there is one per file.
				const existing = this.models.get(uri);
				if (existing) {
					return existing;
				}
				const entry: IHttpCollectionEntry = { uri, collection: emptyHttpCollection('', 'http'), indent: '\t' };
				this.parseInto(entry, text);
				this.models.set(uri, entry);
				return entry;
			});
			this.loading.set(uri, pending);
		}
		return pending;
	}

	async collections(root: URI | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpCollectionEntry[]> {
		const index = await this.index(root);
		const out: IHttpCollectionEntry[] = [];
		for (const uri of index.collections) {
			if (readable && !await readable(uri)) {
				continue;
			}
			const entry = await this.load(uri);
			if (entry) {
				out.push(entry);
			}
		}
		return out;
	}

	private require(uri: URI): IHttpCollectionEntry {
		const entry = this.models.get(uri);
		if (!entry) {
			throw new Error(`The collection ${uri.path} is not loaded.`);
		}
		if (entry.error) {
			throw new Error(`${basename(uri)} cannot be changed: ${entry.error}`);
		}
		return entry;
	}

	private textOf(entry: IHttpCollectionEntry): string {
		return entry.collection.format === 'postman'
			? `${JSON.stringify(collectionToPostman(entry.collection), null, entry.indent)}\n`
			: collectionToHttpFile(entry.collection);
	}

	/** Writes the collection to its file (one write at a time per file) and tells everyone showing it. */
	private save(entry: IHttpCollectionEntry): Promise<void> {
		const text = this.textOf(entry);
		if (entry.collection.format === 'http') {
			refreshHttpFileModel(entry.collection, text);
		}
		this.written.set(entry.uri, text);
		this._onDidChange.fire(entry.uri);
		const next = (this.writes.get(entry.uri) ?? Promise.resolve()).catch(() => undefined).then(async () => {
			// A later change is already queued behind this one with newer text.
			if (this.written.get(entry.uri) === text) {
				await this.fileService.writeFile(entry.uri, VSBuffer.fromString(text));
			}
		});
		this.writes.set(entry.uri, next);
		return next;
	}

	private folderFor(root: URI | undefined): URI {
		const base = root ?? this.http.foldersOf(undefined)[0];
		if (!base) {
			throw new Error('Open a project folder to keep collections in.');
		}
		const configured = this.configurationService.getValue<string>(HTTP_COLLECTIONS_FOLDER_SETTING);
		const folder = typeof configured === 'string' ? configured.trim().replace(/^[\\/]+|[\\/]+$/g, '') : 'http';
		return folder && !folder.split(/[\\/]/).includes('..') ? joinPath(base, folder) : base;
	}

	private async freeFile(folder: URI, name: string, extension: string): Promise<URI> {
		const stem = httpFileNameFor(name);
		for (let at = 1; ; at++) {
			const uri = joinPath(folder, `${stem}${at > 1 ? `-${at}` : ''}${extension}`);
			if (!await this.fileService.exists(uri)) {
				return uri;
			}
		}
	}

	private async writeNew(uri: URI, text: string): Promise<void> {
		this.written.set(uri, text);
		await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		this.indexes.clear();
	}

	private async addCollectionFile(root: URI | undefined, collection: IHttpCollection): Promise<URI> {
		const uri = await this.freeFile(this.folderFor(root), collection.name, collection.format === 'postman' ? '.postman_collection.json' : '.http');
		const entry: IHttpCollectionEntry = { uri, collection, indent: '\t' };
		const text = this.textOf(entry);
		if (collection.format === 'http') {
			refreshHttpFileModel(collection, text);
		}
		await this.writeNew(uri, text);
		this.models.set(uri, entry);
		this._onDidChange.fire(undefined);
		return uri;
	}

	createCollection(root: URI | undefined, name: string, format: HttpCollectionFormat): Promise<URI> {
		return this.addCollectionFile(root, emptyHttpCollection(name.trim() || 'New Collection', format));
	}

	async deleteCollection(uri: URI): Promise<void> {
		await this.fileService.del(uri, { useTrash: true }).catch(() => this.fileService.del(uri));
		this.models.delete(uri);
		this.indexes.clear();
		this._onDidChange.fire(undefined);
	}

	updateCollection(uri: URI, mutate: (collection: IHttpCollection) => void): Promise<void> {
		const entry = this.require(uri);
		mutate(entry.collection);
		return this.save(entry);
	}

	private listOf(entry: IHttpCollectionEntry, parentId: string | undefined): IHttpItem[] {
		if (!parentId) {
			return entry.collection.items;
		}
		const parent = findHttpItem(entry.collection, parentId)?.item;
		if (parent?.kind !== 'folder') {
			throw new Error('That folder is not in the collection any more.');
		}
		return parent.items;
	}

	private checkFits(entry: IHttpCollectionEntry, item: IHttpItem, parentId: string | undefined): void {
		if (entry.collection.format === 'http' && (item.kind === 'folder' || parentId)) {
			throw new Error('An .http file holds requests only, no folders. Use a Postman collection for folders.');
		}
	}

	async addItem(uri: URI, parentId: string | undefined, item: IHttpItem, index?: number): Promise<string> {
		const entry = this.require(uri);
		this.checkFits(entry, item, parentId);
		const list = this.listOf(entry, parentId);
		const added = cloneHttp(item);
		if (entry.collection.format === 'http' && added.kind === 'request' && added.auth.type === 'inherit') {
			added.auth.type = 'none';
		}
		list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, added);
		await this.save(entry);
		return added.id;
	}

	updateItem(uri: URI, id: string, mutate: (item: IHttpItem) => void): Promise<void> {
		const entry = this.require(uri);
		const found = findHttpItem(entry.collection, id);
		if (!found) {
			throw new Error('That item is not in the collection any more.');
		}
		mutate(found.item);
		return this.save(entry);
	}

	removeItem(uri: URI, id: string): Promise<void> {
		const entry = this.require(uri);
		const found = findHttpItem(entry.collection, id);
		if (!found) {
			return Promise.resolve();
		}
		found.siblings.splice(found.index, 1);
		return this.save(entry);
	}

	async duplicateItem(uri: URI, id: string): Promise<string> {
		const entry = this.require(uri);
		const found = findHttpItem(entry.collection, id);
		if (!found) {
			throw new Error('That item is not in the collection any more.');
		}
		const copy = withNewHttpIds(found.item);
		copy.name = `${found.item.name || 'Request'} Copy`;
		if (copy.kind === 'request') {
			copy.extra = entry.collection.format === 'http' ? undefined : copy.extra;
			copy.line = undefined;
		}
		found.siblings.splice(found.index + 1, 0, copy);
		await this.save(entry);
		return copy.id;
	}

	async moveItem(from: URI, id: string, to: URI, parentId: string | undefined, index?: number): Promise<void> {
		const source = this.require(from);
		const target = this.require(to);
		const found = findHttpItem(source.collection, id);
		if (!found) {
			return;
		}
		const item = found.item;
		this.checkFits(target, item, parentId);
		if (item.kind === 'folder' && parentId && (parentId === id || findHttpItem({ ...source.collection, items: item.items }, parentId))) {
			throw new Error('A folder cannot move into itself.');
		}
		const list = this.listOf(target, parentId);
		let at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
		if (list === found.siblings && found.index < at) {
			at--;
		}
		found.siblings.splice(found.index, 1);
		if (source !== target && item.kind === 'request') {
			// A block's text and line belong to the file it came from.
			item.extra = source.collection.format === target.collection.format && target.collection.format === 'postman' ? item.extra : undefined;
			item.line = undefined;
			if (target.collection.format === 'http' && item.auth.type === 'inherit') {
				item.auth.type = 'none';
			}
		}
		list.splice(at, 0, item);
		if (source !== target) {
			await this.save(source);
		}
		await this.save(target);
	}

	// --- Import and export ---------------------------------------------------------------------

	async importText(root: URI | undefined, text: string, fileName?: string): Promise<IHttpImportResult> {
		const detected = detectHttpImport(text, fileName);
		switch (detected.kind) {
			case 'collection': {
				const collection = detected.collection;
				let uri: URI;
				if (detected.source === 'http') {
					// An `.http` file comes in as it was written.
					uri = await this.freeFile(this.folderFor(root), collection.name || (fileName ?? 'requests').replace(/\.(?:http|rest)$/i, ''), '.http');
					await this.writeNew(uri, text.endsWith('\n') ? text : `${text}\n`);
					this._onDidChange.fire(undefined);
				} else {
					uri = await this.addCollectionFile(root, collection);
				}
				const count = httpRequestsOf(collection.items).length;
				return { kind: 'collection', uri, message: `Imported "${collection.name}" (${count} request${count === 1 ? '' : 's'}).` };
			}
			case 'environment': {
				const entry = await this.createEnvironment(root, detected.environment.name, detected.environment.variables, detected.environment.extra);
				return { kind: 'environment', uri: entry.uri, message: `Imported the environment "${detected.environment.name}" (${detected.environment.variables.length} variable${detected.environment.variables.length === 1 ? '' : 's'}).` };
			}
			case 'request':
				return { kind: 'request', request: detected.request, message: 'Read the cURL command as a request.' };
			default:
				return { kind: 'unknown', message: detected.reason };
		}
	}

	exportText(uri: URI, format: HttpCollectionFormat): string {
		const entry = this.require(uri);
		if (format === 'postman') {
			const collection = entry.collection.format === 'postman' ? entry.collection : { ...cloneHttp(entry.collection), format: 'postman' as const, extra: undefined, items: entry.collection.items.map(item => ({ ...cloneHttp(item), extra: undefined })) };
			return `${JSON.stringify(collectionToPostman(collection), null, '\t')}\n`;
		}
		return collectionToHttpFile(entry.collection.format === 'http' ? entry.collection : cloneHttp(entry.collection));
	}

	// --- Environments ----------------------------------------------------------------------------

	async environments(root: URI | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpEnvironmentEntry[]> {
		const index = await this.index(root);
		const out: IHttpEnvironmentEntry[] = [];
		for (const uri of index.environments) {
			if (readable && !await readable(uri)) {
				continue;
			}
			const text = await this.read(uri);
			if (text === undefined) {
				continue;
			}
			if (/http-client(?:\.private)?\.env\.json$/i.test(uri.path)) {
				for (const item of parseHttpClientEnvFile(text)) {
					out.push({ id: `${uri.toString()}#${item.name}`, uri, environment: { format: 'http-client', name: item.name, variables: item.variables }, globals: false, shared: item.name === '$shared' });
				}
				continue;
			}
			try {
				const json: unknown = JSON.parse(text);
				const environment = postmanToEnvironment(json);
				const globals = /\.postman_globals\.json$/i.test(uri.path) || (json as { _postman_variable_scope?: unknown })._postman_variable_scope === 'globals';
				out.push({ id: `${uri.toString()}#${environment.name}`, uri, environment, globals, shared: false });
			} catch { /* not an environment after all */ }
		}
		return out;
	}

	async createEnvironment(root: URI | undefined, name: string, variables: readonly IHttpKeyValue[] = [], extra?: unknown): Promise<IHttpEnvironmentEntry> {
		const environment: IHttpEnvironment = { format: 'postman', name: name.trim() || 'New Environment', variables: variables.map(row => ({ ...row })), ...(extra !== undefined ? { extra } : {}) };
		const globals = (extra as { _postman_variable_scope?: unknown } | undefined)?._postman_variable_scope === 'globals';
		const uri = await this.freeFile(this.folderFor(root), environment.name, globals ? '.postman_globals.json' : '.postman_environment.json');
		await this.writeNew(uri, `${JSON.stringify(environmentToPostman(environment), null, '\t')}\n`);
		this._onDidChangeEnvironments.fire();
		return { id: `${uri.toString()}#${environment.name}`, uri, environment, globals, shared: false };
	}

	async saveEnvironment(entry: IHttpEnvironmentEntry, name: string, variables: readonly IHttpKeyValue[]): Promise<void> {
		const next = name.trim() || entry.environment.name;
		let text: string;
		if (entry.environment.format === 'http-client') {
			let current = await this.read(entry.uri) ?? '{}';
			if (next !== entry.environment.name) {
				current = updateHttpClientEnvFile(current, entry.environment.name, undefined);
			}
			text = updateHttpClientEnvFile(current, next, variables);
		} else {
			text = `${JSON.stringify(environmentToPostman({ ...entry.environment, name: next, variables: variables.map(row => ({ ...row })) }), null, '\t')}\n`;
		}
		await this.writeNew(entry.uri, text);
		this._onDidChangeEnvironments.fire();
	}

	async deleteEnvironment(entry: IHttpEnvironmentEntry): Promise<void> {
		if (entry.environment.format === 'http-client') {
			await this.writeNew(entry.uri, updateHttpClientEnvFile(await this.read(entry.uri) ?? '{}', entry.environment.name, undefined));
		} else {
			await this.fileService.del(entry.uri, { useTrash: true }).catch(() => this.fileService.del(entry.uri));
			this.indexes.clear();
		}
		this._onDidChangeEnvironments.fire();
	}

	private overlayOf(root: URI | undefined): IVariableOverlay {
		const key = root?.toString() ?? '';
		let overlay = this.overlays.get(key);
		if (!overlay) {
			overlay = { environment: {}, collection: {}, globals: {} };
			this.overlays.set(key, overlay);
		}
		return overlay;
	}

	/** The variables a send of `collection` starts with, by scope. */
	private async scopes(root: URI | undefined, collection: URI | undefined, environmentName: string | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<IHttpScriptVariables> {
		const overlay = this.overlayOf(root);
		const entries = await this.environments(root, readable);
		const globals: Record<string, string> = {};
		const environment: Record<string, string> = {};
		for (const entry of entries) {
			if (entry.globals) {
				Object.assign(globals, httpVariableRecord(entry.environment.variables));
			}
		}
		if (environmentName) {
			// The same name in several files (http-client.env.json and its private twin) merges, `$shared` underneath.
			const picked = entries.filter(entry => !entry.globals && entry.environment.name === environmentName);
			for (const entry of entries) {
				if (entry.shared && picked.some(item => item.environment.format === 'http-client')) {
					Object.assign(environment, httpVariableRecord(entry.environment.variables));
				}
			}
			for (const entry of picked) {
				Object.assign(environment, httpVariableRecord(entry.environment.variables));
			}
		}
		const model = collection ? this.models.get(collection) : undefined;
		return {
			environment: { ...environment, ...overlay.environment[environmentName ?? ''] },
			collection: { ...(model ? httpVariableRecord(model.collection.variables) : {}), ...(collection ? overlay.collection[collection.toString()] : {}) },
			globals: { ...globals, ...overlay.globals },
			local: {},
		};
	}

	async variablesFor(root: URI | undefined, collection: URI | undefined): Promise<ReadonlyMap<string, { readonly value: string; readonly source: string }>> {
		const environmentName = this.http.environmentOf(root);
		const scopes = await this.scopes(root, collection, environmentName);
		const out = new Map<string, { value: string; source: string }>();
		const add = (record: Record<string, string>, source: string) => {
			for (const [key, value] of Object.entries(record)) {
				out.set(key, { value, source });
			}
		};
		add(scopes.globals, 'Globals');
		add(scopes.collection, 'Collection');
		add(scopes.environment, environmentName ?? 'Environment');
		return out;
	}

	async setVariable(root: URI | undefined, collection: URI | undefined, name: string, value: string): Promise<boolean> {
		const environmentName = this.http.environmentOf(root);
		const overlay = this.overlayOf(root);
		const entries = await this.environments(root);
		const withRow = (list: readonly IHttpEnvironmentEntry[]) => [...list].reverse().find(entry => entry.environment.variables.some(row => row.key === name && row.enabled !== false));
		const write = async (entry: IHttpEnvironmentEntry) => {
			await this.saveEnvironment(entry, entry.environment.name, entry.environment.variables.map(row => row.key === name && row.enabled !== false ? { ...row, value } : row));
		};
		// The same order a send reads them in: the environment wins over the collection, which wins over the globals.
		// A value a script set this session lies over the file's, so it takes the new value too.
		const inEnvironment = environmentName ? overlay.environment[environmentName] : undefined;
		const environmentEntry = environmentName ? withRow(entries.filter(entry => !entry.globals && entry.environment.name === environmentName)) ?? withRow(entries.filter(entry => entry.shared)) : undefined;
		if (environmentEntry || (inEnvironment && name in inEnvironment)) {
			if (inEnvironment && name in inEnvironment) {
				inEnvironment[name] = value;
			}
			if (environmentEntry) {
				await write(environmentEntry);
			} else {
				this._onDidChangeEnvironments.fire();
			}
			return true;
		}
		const model = collection ? this.models.get(collection) : undefined;
		const inCollection = collection ? overlay.collection[collection.toString()] : undefined;
		const collectionRow = model?.collection.variables.some(row => row.key === name && row.enabled !== false);
		if (collection && (collectionRow || (inCollection && name in inCollection))) {
			if (inCollection && name in inCollection) {
				inCollection[name] = value;
			}
			if (collectionRow) {
				await this.updateCollection(collection, next => next.variables = next.variables.map(row => row.key === name && row.enabled !== false ? { ...row, value } : row));
			}
			this._onDidChangeEnvironments.fire();
			return true;
		}
		const globalsEntry = withRow(entries.filter(entry => entry.globals));
		if (globalsEntry || name in overlay.globals) {
			if (name in overlay.globals) {
				overlay.globals[name] = value;
			}
			if (globalsEntry) {
				await write(globalsEntry);
			} else {
				this._onDidChangeEnvironments.fire();
			}
			return true;
		}
		return false;
	}

	// --- Drafts ----------------------------------------------------------------------------------

	draftOf(key: string): IHttpRequest | undefined {
		return this.drafts.get(key);
	}

	setDraft(key: string, request: IHttpRequest | undefined): void {
		if (request) {
			this.drafts.set(key, request);
		} else if (!this.drafts.delete(key)) {
			return;
		}
		this._onDidChangeDraft.fire(key);
	}

	// --- Sending ---------------------------------------------------------------------------------

	/** Runs a script off the window's thread, with no network or files; a script that hangs is stopped. */
	protected runScript(input: IHttpScriptInput): Promise<IHttpScriptOutput> {
		const failed = (error: string): IHttpScriptOutput => ({ tests: [], logs: [], error, variables: input.variables, request: input.request });
		return new Promise<IHttpScriptOutput>(resolve => {
			let worker: Worker | undefined;
			// The breakpoints are compiled into the worker's source: the worker reports stops only for a script built with them.
			const url = URL.createObjectURL(new Blob([httpScriptWorkerSource(input.script, input.breakpoints)], { type: 'text/javascript' }));
			let settled = false;
			const done = (output: IHttpScriptOutput) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				worker?.terminate();
				URL.revokeObjectURL(url);
				resolve(output);
			};
			const timer = setTimeout(() => done(failed(`The script ran longer than ${SCRIPT_TIMEOUT_MS / 1000} seconds and was stopped.`)), SCRIPT_TIMEOUT_MS);
			try {
				worker = createBlobWorker(url);
				worker.onmessage = event => done(event.data as IHttpScriptOutput);
				worker.onerror = event => done(failed((event.message || 'The script could not run.').replace(/^Uncaught /, '')));
				worker.postMessage(input);
			} catch (err) {
				done(failed(err instanceof Error ? err.message : String(err)));
			}
		});
	}

	send(request: IHttpRequest, context: IHttpSendContext): Promise<IHttpExchange> {
		return this.sendWithScripts(request, context, 0).then(result => result.exchange);
	}

	private async sendWithScripts(request: IHttpRequest, context: IHttpSendContext, iteration: number): Promise<{ exchange: IHttpExchange; nextRequest?: string | null }> {
		const entry = context.collection ? this.models.get(context.collection) : undefined;
		const collection = entry && !entry.error ? entry.collection : undefined;
		const ancestors: readonly IHttpFolder[] = collection ? findHttpItem(collection, request.id)?.ancestors ?? [] : [];
		const environmentName = context.environment ?? this.http.environmentOf(context.root);
		let variables = await this.scopes(context.root, context.collection, environmentName, context.confined?.readable);
		const before = cloneHttp(variables);
		if (context.variables) {
			variables = { ...variables, local: { ...variables.local, ...context.variables } };
		}
		const wire = httpWireRequest(request, ancestors, collection);
		let scriptRequest: IHttpScriptRequest = { name: request.name, method: wire.spec.method, url: wire.spec.url, headers: wire.spec.headers.map(([key, value]) => [key, value]), ...(wire.spec.body !== undefined ? { body: wire.spec.body } : {}) };
		const tests: IHttpExchangeTest[] = [];
		const logs: IHttpExchangeLog[] = [];
		let scriptError: string | undefined;
		let nextRequest: string | null | undefined;
		const breaks: HttpExchangeBreak[] = [];
		const breaksAsked = !!(context.breakpoints?.preRequest?.length || context.breakpoints?.test?.length);
		const scriptsOf = (phase: 'preRequest' | 'test') => [collection?.scripts[phase], ...ancestors.map(folder => folder.scripts[phase]), request.scripts[phase]].filter((script): script is string => !!script?.trim());
		const run = async (phase: 'preRequest' | 'test', response?: IHttpExchange['response']) => {
			for (const script of scriptsOf(phase)) {
				// Breakpoints are set in the request's own script editor: they apply to that script, not the folders' or the collection's.
				const marked = script === request.scripts[phase] ? context.breakpoints?.[phase] : undefined;
				const output = await this.runScript({ script, phase, request: scriptRequest, ...(response ? { response: { ...response, headers: { ...response.headers } } } : {}), variables, iteration, detail: true, ...(marked?.length ? { breakpoints: [...marked] } : {}), ...(environmentName ? { environmentName } : {}), ...(phase === 'test' && context.onlyTests ? { onlyTests: context.onlyTests } : {}) });
				breaks.push(...(output.breaks ?? []).map(stop => ({ ...stop, phase })));
				variables = output.variables ?? variables;
				if (phase === 'preRequest' && output.request) {
					scriptRequest = output.request;
				}
				tests.push(...output.tests ?? []);
				logs.push(...output.logs ?? []);
				if (output.error) {
					scriptError = scriptError ? `${scriptError}\n${output.error}` : output.error;
				}
				if (output.nextRequest !== undefined) {
					nextRequest = output.nextRequest;
				}
			}
		};
		if (httpProtocolInfo(request.protocol).stream) {
			// A connection: open it, send its messages, listen for a while, close; the tests read what came in.
			let exchange = await this.runStream(request, context, context.stream);
			if (exchange.response) {
				await run('test', exchange.response);
			}
			exchange = { ...exchange, ...(tests.length ? { tests } : {}), ...(logs.length ? { logs } : {}), ...(scriptError ? { scriptError } : {}), ...(breaks.length || breaksAsked ? { breaks } : {}) };
			this.http.record(exchange);
			this.keepScriptVariables(context.root, context.collection, environmentName, before, variables);
			return { exchange, nextRequest };
		}
		await run('preRequest');
		const { body: _wireBody, ...wireRest } = wire.spec;
		const exchange = await this.http.send({ ...wireRest, method: scriptRequest.method, url: scriptRequest.url, headers: scriptRequest.headers, ...(scriptRequest.body !== undefined ? { body: scriptRequest.body } : {}) }, {
			...(context.root ? { root: context.root } : {}),
			...(context.token ? { token: context.token } : {}),
			...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
			...(context.confined ? { confined: context.confined } : {}),
			...(environmentName ? { environment: environmentName } : {}),
			// Local and environment values win over the collection's, those over globals.
			environmentVariables: { ...variables.environment, ...variables.local },
			fileVariables: { ...variables.globals, ...variables.collection },
			...(wire.formdata ? { formdata: wire.formdata } : {}),
			...(wire.binaryPath ? { binaryPath: wire.binaryPath } : {}),
			...(context.collection ? { base: dirname(context.collection), request: { collection: context.collection.toString(), id: request.id } } : {}),
			// How it goes out: the request's Settings tab, and the authorization that signs the request as it is sent.
			...(request.settings ? { settings: request.settings } : {}),
			auth: effectiveHttpAuth(request, ancestors, collection).auth,
			finish: async sent => {
				if (sent.response) {
					await run('test', sent.response);
				}
				const allLogs = [...(sent.logs ?? []), ...logs];
				return { ...(tests.length ? { tests } : {}), ...(allLogs.length ? { logs: allLogs } : {}), ...(scriptError ? { scriptError } : {}), ...(breaks.length || breaksAsked ? { breaks } : {}) };
			},
		});
		this.keepScriptVariables(context.root, context.collection, environmentName, before, variables);
		return { exchange, nextRequest };
	}

	async retest(request: IHttpRequest, context: IHttpSendContext, exchange: IHttpExchange, only?: readonly string[]): Promise<IHttpExchange> {
		const response = exchange.response;
		if (!response) {
			return exchange;
		}
		const entry = context.collection ? this.models.get(context.collection) : undefined;
		const collection = entry && !entry.error ? entry.collection : undefined;
		const ancestors: readonly IHttpFolder[] = collection ? findHttpItem(collection, request.id)?.ancestors ?? [] : [];
		const environmentName = context.environment ?? this.http.environmentOf(context.root);
		let variables = await this.scopes(context.root, context.collection, environmentName, context.confined?.readable);
		const before = cloneHttp(variables);
		const scriptRequest: IHttpScriptRequest = { name: request.name, method: exchange.method, url: exchange.url, headers: exchange.headers.map(([key, value]) => [key, value]), ...(exchange.body !== undefined ? { body: exchange.body } : {}) };
		const tests: IHttpExchangeTest[] = [];
		const logs: IHttpExchangeLog[] = [];
		let scriptError: string | undefined;
		const breaks: HttpExchangeBreak[] = [];
		const marked = context.breakpoints?.test;
		for (const script of [collection?.scripts.test, ...ancestors.map(folder => folder.scripts.test), request.scripts.test].filter((item): item is string => !!item?.trim())) {
			const own = script === request.scripts.test && marked?.length ? { breakpoints: [...marked] } : {};
			const output = await this.runScript({ script, phase: 'test', request: scriptRequest, response: { ...response, headers: { ...response.headers } }, variables, iteration: 0, detail: true, ...own, ...(environmentName ? { environmentName } : {}), ...(only ? { onlyTests: only } : {}) });
			breaks.push(...(output.breaks ?? []).map(stop => ({ ...stop, phase: 'test' as const })));
			variables = output.variables ?? variables;
			tests.push(...output.tests ?? []);
			logs.push(...output.logs ?? []);
			if (output.error) {
				scriptError = scriptError ? `${scriptError}\n${output.error}` : output.error;
			}
		}
		this.keepScriptVariables(context.root, context.collection, environmentName, before, variables);
		const { tests: _tests, logs: _logs, scriptError: _scriptError, breaks: _breaks, ...rest } = exchange;
		// The pre-request stops of the send stay (the request did not run again); the test stops are this run's.
		const kept = [...(exchange.breaks ?? []).filter(stop => stop.phase === 'preRequest'), ...breaks];
		const breakFields = kept.length || marked?.length ? { breaks: kept } : {};
		if (only) {
			const merged = mergeHttpTests(exchange.tests ?? [], tests);
			return { ...rest, ...(merged.length ? { tests: merged } : {}), ...(logs.length ? { logs } : {}), ...(scriptError ? { scriptError } : {}), ...breakFields };
		}
		return { ...rest, ...(tests.length ? { tests } : {}), ...(logs.length ? { logs } : {}), ...(scriptError ? { scriptError } : {}), ...breakFields };
	}

	// --- Connections -----------------------------------------------------------------------------

	async streamPlan(request: IHttpRequest, context: IHttpSendContext): Promise<IHttpStreamPlan> {
		const protocol = request.protocol ?? 'http';
		const info = httpProtocolInfo(protocol);
		if (!info.stream) {
			throw new Error(`${info.label} requests are sent, not connected.`);
		}
		const entry = context.collection ? this.models.get(context.collection) : undefined;
		const collection = entry && !entry.error ? entry.collection : undefined;
		const ancestors: readonly IHttpFolder[] = collection ? findHttpItem(collection, request.id)?.ancestors ?? [] : [];
		const environmentName = context.environment ?? this.http.environmentOf(context.root);
		const variables = await this.scopes(context.root, context.collection, environmentName, context.confined?.readable);
		const scope = this.http.scopeOf({ ...variables.globals, ...variables.collection }, { ...variables.environment, ...variables.local }, context.confined);
		const resolve = (text: string) => resolveHttpVariables(text, scope);
		const wire = httpWireRequest(request, ancestors, collection);
		const url = resolve(wire.spec.url).trim();
		const options = Object.fromEntries(Object.entries(request.options ?? {}).map(([key, value]) => [key, resolve(value)]));
		const headers: Record<string, string> = {};
		let username: string | undefined;
		let password: string | undefined;
		for (const [key, raw] of wire.spec.headers) {
			const value = resolve(raw);
			const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
			if (basic && protocol === 'mqtt') {
				// A broker takes the name and password in its CONNECT packet, not a header.
				username = basic[1];
				password = basic[2];
				continue;
			}
			headers[key] = basic ? `Basic ${btoa(unescape(encodeURIComponent(`${basic[1]}:${basic[2]}`)))}` : value;
		}
		const own = (request.messages ?? []).filter(message => message.body.trim() || message.target).map(message => ({ ...message, body: resolve(message.body), ...(message.target ? { target: resolve(message.target) } : {}) }));
		const missing = missingVariables([url, ...Object.values(headers), ...Object.values(options), ...own.map(message => `${message.target ?? ''}\n${message.body}`), protocol === 'grpc' ? resolve(request.body.raw) : ''].join('\n'));
		if (!url) {
			throw new Error('Enter where to connect.');
		}
		if (missing.length) {
			throw new Error(`Unresolved variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}${environmentName ? ` (environment "${environmentName}")` : ' (no environment selected)'}.`);
		}
		// A sandboxed chat's connection is judged like its requests: by the host it goes to.
		const judged = httpRequestUrl(url.replace(/^(?:wss|mqtts|ssl|grpcs)(?=:\/\/)/i, 'https').replace(/^(?:ws|mqtt|tcp|grpc)(?=:\/\/)/i, 'http'));
		const refused = context.confined?.urlRefusal(judged);
		if (refused) {
			throw new Error(`Not connected: ${refused}. This chat runs in Volt's sandbox, whose network rules apply to its connections too.`);
		}
		const messages: IVoltHttpStreamMessage[] = own.map((message: IHttpMessage) => ({ data: message.body, ...(message.target ? { target: message.target } : {}) }));
		const base = { headers, ...(context.timeoutMs ? { connectTimeoutMs: Math.min(context.timeoutMs, 60_000) } : {}) };
		switch (protocol) {
			case 'ws': return { protocol, spec: { kind: 'ws', url, ...base }, messages, resolve };
			case 'sse': return { protocol, spec: { kind: 'sse', url: httpRequestUrl(url), ...base }, messages: [], resolve };
			case 'socketio': return { protocol, spec: { kind: 'socketio', url: httpRequestUrl(url), ...base, socketio: { ...(options.path ? { path: options.path } : {}), ...(options.auth ? { auth: options.auth } : {}) } }, messages, resolve };
			case 'mqtt': {
				const subscribe = (options.subscribe ?? '').split(/[\n,]/).map(topic => topic.trim()).filter(Boolean);
				const untargeted = messages.find(message => !message.target);
				if (untargeted) {
					throw new Error('Every MQTT message needs a topic to publish to.');
				}
				return { protocol, spec: { kind: 'mqtt', url: /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `mqtt://${url}`, ...base, mqtt: { ...(options.clientId ? { clientId: options.clientId } : {}), ...(username !== undefined ? { username, password: password ?? '' } : {}), subscribe, ...(options.qos === '1' ? { qos: 1 as const } : {}) } }, messages, resolve };
			}
			default: {
				const target = httpGrpcTarget(url);
				if (!target.service || !target.method) {
					throw new Error('Pick the service and method to call.');
				}
				const protos = options.proto ? await this.readProtos(options.proto, context) : undefined;
				return { protocol: 'grpc', spec: { kind: 'grpc', url: target.address, ...base, grpc: { service: target.service, method: target.method, ...(protos ? { protos } : {}), message: resolve(request.body.raw) } }, messages: [], resolve };
			}
		}
	}

	/** A `.proto` file and the files it imports, by the names the imports use. */
	private async readProtos(path: string, context: IHttpSendContext): Promise<Record<string, string>> {
		const base = context.collection ? dirname(context.collection) : context.root;
		const locate = (name: string, from?: URI): URI[] => {
			if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(name)) {
				return [URI.file(name)];
			}
			return [...(from ? [joinPath(dirname(from), name)] : []), ...(base ? [joinPath(base, name)] : []), ...(context.root ? [joinPath(context.root, name)] : [])];
		};
		const out: Record<string, string> = {};
		const pending: { name: string; from?: URI }[] = [{ name: path }];
		while (pending.length && Object.keys(out).length < 40) {
			const next = pending.shift()!;
			if (next.name in out || next.name.startsWith('google/protobuf/')) {
				continue;
			}
			let found: { uri: URI; text: string } | undefined;
			for (const uri of locate(next.name, next.from)) {
				if (context.confined && !await context.confined.readable(uri)) {
					continue;
				}
				const text = await this.read(uri);
				if (text !== undefined) {
					found = { uri, text };
					break;
				}
			}
			if (!found) {
				if (next.name === path) {
					throw new Error(`Cannot read the .proto file ${path}.`);
				}
				continue;
			}
			out[next.name] = found.text;
			for (const match of found.text.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm)) {
				pending.push({ name: match[1], from: found.uri });
			}
		}
		return out;
	}

	async describeGrpc(request: IHttpRequest, context: IHttpSendContext): Promise<readonly IVoltGrpcServiceInfo[]> {
		// The address and the proto are all a description needs: a method is what it is asked for.
		const probe = { ...cloneHttp(request), url: `${httpGrpcTarget(request.url.trim()).address}/_._/_` };
		const plan = await this.streamPlan(probe, context);
		return this.streams.describeGrpc(plan.spec.url, plan.spec.headers, plan.spec.grpc?.protos);
	}

	/** Connects, sends the request's messages, listens for `waitMs` (or until `maxMessages` came in), closes: one exchange. */
	async runStream(request: IHttpRequest, context: IHttpSendContext, options: IHttpStreamRunOptions = {}): Promise<IHttpExchange> {
		const started = Date.now();
		const protocol = request.protocol ?? 'ws';
		const base = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			at: started,
			...(request.name ? { name: request.name } : {}),
			method: request.method,
			protocol,
			url: request.url,
			headers: [] as (readonly [string, string])[],
			...(context.root ? { root: context.root.toString() } : {}),
			...(context.collection ? { request: { collection: context.collection.toString(), id: request.id } } : {}),
		};
		let plan: IHttpStreamPlan;
		try {
			plan = await this.streamPlan(request, context);
		} catch (err) {
			return { ...base, error: err instanceof Error ? err.message : String(err) };
		}
		const id = generateUuid();
		const entries: IHttpStreamEntry[] = [];
		const waitMs = Math.max(0, Math.min(options.waitMs ?? 3000, 60_000));
		let status = 0;
		let handshake: Readonly<Record<string, string>> = {};
		let failure: string | undefined;
		let closeText: string | undefined;
		let received = 0;
		await new Promise<void>(resolve => {
			let finished = false;
			let linger: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (!finished) {
					finished = true;
					clearTimeout(linger);
					listener.dispose();
					cancel?.dispose();
					void this.streams.close(id).catch(() => undefined);
					resolve();
				}
			};
			const cancel = context.token?.onCancellationRequested(() => {
				failure ??= 'Cancelled.';
				finish();
			});
			const listener = this.streams.onDidStreamEvent((event: IVoltHttpStreamEvent) => {
				if (event.id !== id || finished) {
					return;
				}
				switch (event.type) {
					case 'open':
						status = event.status ?? (protocol === 'ws' ? 101 : 200);
						handshake = event.headers ?? {};
						entries.push({ at: event.at, direction: 'info', data: event.text ?? 'Connected' });
						for (const message of plan.messages) {
							void this.streams.send(id, message).catch(err => entries.push({ at: Date.now(), direction: 'error', data: err instanceof Error ? err.message : String(err) }));
						}
						linger = setTimeout(finish, waitMs);
						break;
					case 'message':
					case 'sent':
						entries.push({ at: event.at, direction: event.type === 'message' ? 'in' : 'out', data: event.data ?? '', ...(event.target ? { target: event.target } : {}), ...(event.binary ? { binary: true } : {}), ...(event.size !== undefined ? { size: event.size } : {}) });
						if (event.type === 'message' && ++received >= (options.maxMessages ?? Number.POSITIVE_INFINITY)) {
							finish();
						}
						break;
					case 'info':
						if (protocol === 'grpc' && !status) {
							status = 200;
						}
						entries.push({ at: event.at, direction: 'info', data: event.text ?? event.data ?? '' });
						break;
					case 'error':
						failure = event.text ?? event.data ?? 'The connection failed.';
						entries.push({ at: event.at, direction: 'error', data: failure });
						break;
					case 'close':
						closeText = [event.code !== undefined ? String(event.code) : '', event.text ?? ''].filter(Boolean).join(' ');
						finish();
						break;
				}
			});
			this.streams.open(id, plan.spec).catch(err => {
				failure = err instanceof Error ? err.message : String(err);
				finish();
			});
		});
		const sentBase = { ...base, url: plan.spec.url, headers: Object.entries(plan.spec.headers ?? {}) };
		if (!status && failure) {
			return { ...sentBase, error: failure, ...(entries.length ? { stream: entries } : {}) };
		}
		const body = JSON.stringify(entries.filter(entry => entry.direction === 'in' || entry.direction === 'out').map(entry => ({ direction: entry.direction, ...(entry.target ? { target: entry.target } : {}), data: parsedOrText(entry.data, entry.binary) })), null, 2);
		return {
			...sentBase,
			response: { status, statusText: failure ?? closeText ?? '', headers: { ...handshake, 'content-type': 'application/json' }, body, durationMs: Date.now() - started, size: entries.reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.size ?? entry.data.length : 0), 0) },
			stream: entries,
			...(failure ? { scriptError: failure } : {}),
		};
	}

	/** What the scripts set or removed stays for the next sends (until the window closes). */
	private keepScriptVariables(root: URI | undefined, collection: URI | undefined, environmentName: string | undefined, before: IHttpScriptVariables, after: IHttpScriptVariables): void {
		const overlay = this.overlayOf(root);
		const changed = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) !== JSON.stringify(b);
		let any = false;
		if (changed(before.environment, after.environment)) {
			overlay.environment[environmentName ?? ''] = { ...overlay.environment[environmentName ?? ''], ...after.environment };
			any = true;
		}
		if (collection && changed(before.collection, after.collection)) {
			overlay.collection[collection.toString()] = { ...overlay.collection[collection.toString()], ...after.collection };
			any = true;
		}
		if (changed(before.globals, after.globals)) {
			overlay.globals = { ...overlay.globals, ...after.globals };
			any = true;
		}
		if (any) {
			this._onDidChangeEnvironments.fire();
		}
	}

	async run(uri: URI, options: IHttpRunOptions): Promise<IHttpRunSummary> {
		const entry = await this.load(uri);
		if (!entry || entry.error) {
			throw new Error(entry?.error ?? `No collection at ${uri.path}.`);
		}
		let items: readonly IHttpItem[] = entry.collection.items;
		let base: readonly IHttpFolder[] = [];
		if (options.folderId) {
			const found = findHttpItem(entry.collection, options.folderId);
			if (found?.item.kind !== 'folder') {
				throw new Error('That folder is not in the collection.');
			}
			items = found.item.items;
			base = [...found.ancestors, found.item];
		}
		const requests = httpRequestsOf(items, base);
		const started = Date.now();
		const results: IHttpRunResult[] = [];
		const iterations = Math.max(1, Math.min(options.iterations ?? 1, 100));
		const total = requests.length * iterations;
		let stopped = false;
		outer: for (let iteration = 0; iteration < iterations; iteration++) {
			let at = 0;
			let jumps = 0;
			while (at < requests.length) {
				if (options.token?.isCancellationRequested) {
					stopped = true;
					break outer;
				}
				const { request, ancestors } = requests[at];
				const { exchange, nextRequest } = await this.sendWithScripts(request, { ...options, collection: uri }, iteration);
				const result: IHttpRunResult = { requestId: request.id, name: request.name, path: [...ancestors.map(folder => folder.name), request.name], iteration, exchange };
				results.push(result);
				options.onProgress?.(result, results.length, total);
				const failed = !!exchange.error || !!exchange.scriptError || exchange.tests?.some(test => !test.passed && !test.skipped);
				if (failed && options.stopOnFailure) {
					stopped = true;
					break outer;
				}
				if (nextRequest === null) {
					break;
				}
				const jump = typeof nextRequest === 'string' ? requests.findIndex(item => item.request.name === nextRequest) : -1;
				// A script that keeps jumping back must not run for ever.
				if (jump >= 0 && jumps++ < requests.length * 4) {
					at = jump;
				} else {
					at++;
				}
				if (options.delayMs && at < requests.length) {
					await timeout(Math.min(options.delayMs, 10_000));
				}
			}
		}
		let passed = 0;
		let failed = 0;
		let errors = 0;
		for (const { exchange } of results) {
			passed += exchange.tests?.filter(test => test.passed).length ?? 0;
			failed += exchange.tests?.filter(test => !test.passed && !test.skipped).length ?? 0;
			errors += exchange.error || exchange.scriptError ? 1 : 0;
		}
		return { results, requests: results.length, passed, failed, errors, durationMs: Date.now() - started, stopped };
	}
}

/**
 * The results of a run of some tests laid over the ones in hand: each takes the place of the
 * earlier result of the same name (the n-th of a name replaces the n-th), a new name goes last.
 */
export function mergeHttpTests(current: readonly IHttpExchangeTest[], rerun: readonly IHttpExchangeTest[]): IHttpExchangeTest[] {
	const merged = [...current];
	const taken = new Set<number>();
	for (const test of rerun) {
		const at = merged.findIndex((candidate, index) => candidate.name === test.name && !taken.has(index));
		if (at < 0) {
			taken.add(merged.push(test) - 1);
		} else {
			merged[at] = test;
			taken.add(at);
		}
	}
	return merged;
}

/** A message's payload for a test to read: its JSON value when it is JSON, else the text. */
function parsedOrText(data: string, binary: boolean | undefined): unknown {
	if (binary) {
		return data;
	}
	try {
		return JSON.parse(data);
	} catch {
		return data;
	}
}

/** The key an open request's unsaved edits are kept under: shared by every client showing that request. */
export function httpDraftKey(collection: URI | undefined, id: string): string {
	return collection ? `${collection.toString()}#${id}` : `untitled:${id}`;
}

export function newUntitledHttpId(): string {
	return newHttpId();
}

registerSingleton(IVoltHttpCollections, VoltHttpCollections, InstantiationType.Delayed);
