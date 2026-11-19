/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVoltHttpLoad, IVoltLoadProgress, IVoltLoadSample, IVoltLoadSpec, IVoltLoadTarget, VoltLoadMode } from '../../../../platform/voltHttp/common/voltHttpLoad.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { resolveHttpVariables } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { findHttpItem, findHttpItemByPath, httpFileNameFor, httpWireRequest } from '../common/httpCollection.js';
import { addHttpPerfRun, emptyHttpPerfFile, HTTP_PERF_FILE_PATTERN, HTTP_PERF_FILE_SUFFIX, HTTP_PERF_FOLDER, httpPerfDetail, httpPerfHostOf, httpPerfHostsToConfirm, httpPerfSpec, httpPerfUnresolved, IHttpPerfCaps, IHttpPerfFile, IHttpPerfRun, IHttpPerfRunConfig, IHttpPerfTarget, parseHttpPerfDefinition, parseHttpPerfFile, resolveHttpPerfText, serializeHttpPerfFile, summarizeHttpPerfRun } from '../common/httpPerformance.js';
import { HTTP_COLLECTIONS_FOLDER_SETTING, IVoltHttpCollections } from './voltHttpCollections.js';
import { httpRequestUrl, IVoltHttpService } from './voltHttpService.js';
import { IHttpToolFileEntry, IHttpToolFiles } from './voltHttpToolPages.js';

export const IVoltHttpPerformance = createDecorator<IVoltHttpPerformance>('voltHttpPerformance');

const MAX_FILES = 200;
/**
 * The hosts the user confirmed in this Volt, by file: a host only written into the file (by an
 * agent, or a file from elsewhere) does not count until the user confirms it here too.
 */
export const HTTP_PERF_CONFIRMATIONS_KEY = 'volt.http.perfConfirmedHosts';

/** A performance test file, loaded: one object per file for the whole window. */
export interface IHttpPerfEntry {
	readonly uri: URI;
	file: IHttpPerfFile;
	/** Why the file could not be read; `file` is empty then. */
	error?: string;
}

/** One target of a file as it will be sent. */
export interface IHttpPerfPreparedTarget {
	readonly id: string;
	readonly name: string;
	readonly method: string;
	/** With the variables filled in (the engine's own tokens left). */
	readonly url: string;
	readonly host?: string;
	/** `{{names}}` nothing fills in. */
	readonly missing: readonly string[];
	/** Why it cannot be sent (the request is gone, a body kind the engine cannot send). */
	readonly problem?: string;
	/** What the engine gets; undefined when the target cannot be sent. */
	readonly load?: IVoltLoadTarget;
}

export interface IHttpPerfPrepared {
	readonly targets: readonly IHttpPerfPreparedTarget[];
	/** Every host the load goes to. */
	readonly hosts: readonly string[];
	/** The hosts that are neither local nor confirmed by the user in this Volt. */
	readonly toConfirm: readonly string[];
	/** Why the run cannot start (no targets, unresolved variables, broken targets); empty when it can. */
	readonly problems: readonly string[];
}

/** A run in progress or just finished. Lives in the service: the page that shows it comes and goes. */
export interface IHttpPerfRunState {
	readonly running: boolean;
	readonly mode: VoltLoadMode;
	readonly by: 'user' | 'agent';
	readonly startedAt: number;
	readonly endedAt?: number;
	/** What was asked: users, length, profile. */
	readonly config: IHttpPerfRunConfig;
	/** Seconds the run lasts at most, warm-up included (a run by request count may end sooner). */
	readonly plannedSec: number;
	readonly warmupSec: number;
	/** The request count that ends the run, when it is one. */
	readonly requests?: number;
	/** One per second while it runs. */
	readonly samples: readonly IVoltLoadSample[];
	/** Stop was asked and the engine is handing over what it measured. */
	readonly stopping?: boolean;
	/** The finished run as the file keeps it. */
	readonly result?: IHttpPerfRun;
	readonly error?: string;
}

export interface IHttpPerfRunOptions {
	/** The project the client is open for; the folder that holds the file when absent. */
	readonly root?: URI;
	/** Lower users and time (an agent's run). */
	readonly caps?: IHttpPerfCaps;
	readonly by?: 'user' | 'agent';
	/** Stops the run when cancelled. */
	readonly token?: CancellationToken;
}

export interface IVoltHttpPerformance extends IHttpToolFiles {
	readonly _serviceBrand: undefined;
	/** A file's content changed (its uri). */
	readonly onDidChangeFile: Event<URI>;
	/** A run of the file started, got a second of samples, or ended (its uri). */
	readonly onDidChangeRun: Event<URI>;
	get(uri: URI): IHttpPerfEntry | undefined;
	load(uri: URI): Promise<IHttpPerfEntry | undefined>;
	/** Changes the file's definition and saves it. */
	update(uri: URI, mutate: (file: IHttpPerfFile) => void): Promise<void>;
	/**
	 * Creates or replaces a test's definition from JSON an agent wrote. Confirmed hosts and runs are
	 * never taken from it: an existing file keeps its own, a new one starts with none.
	 */
	saveDefinition(root: URI | undefined, definition: unknown, uri?: URI): Promise<URI>;
	/** The user says they may load these hosts. Only the Volt Client's own UI calls this. */
	confirmHosts(uri: URI, hosts: readonly string[]): Promise<void>;
	/** The hosts the user confirmed for the file in this Volt. */
	confirmedHostsOf(uri: URI): readonly string[];
	/** How a file names a collection: its path relative to the project when it is inside it. */
	collectionRef(root: URI | undefined, collection: URI): string;
	collectionUri(root: URI | undefined, ref: string): URI | undefined;
	/** The project a file belongs to. */
	rootOf(uri: URI, root?: URI): URI | undefined;
	/** The file's targets as they would be sent now, with what stands in the way. */
	prepare(uri: URI, root?: URI): Promise<IHttpPerfPrepared>;
	/**
	 * Runs the test and resolves with its final state; the run is saved into the file (the last ten
	 * are kept). Rejects before anything is sent when a target cannot be sent, a variable is not
	 * filled or a host is neither local nor confirmed by the user. Running again while it runs
	 * returns the run in progress.
	 */
	run(uri: URI, options?: IHttpPerfRunOptions): Promise<IHttpPerfRunState>;
	stop(uri: URI): void;
	/** The run in progress or last run in this window; undefined before one ran (the file's `runs` has earlier ones). */
	runOf(uri: URI): IHttpPerfRunState | undefined;
	/** Keeps a model's reading of a run with it in the file. */
	setAnalysis(uri: URI, runId: string, analysis: { readonly text: string; readonly model: string }): Promise<void>;
}

interface IRun {
	state: IHttpPerfRunState;
	id?: string;
	thresholds: IHttpPerfFile['thresholds'];
	resolve: (state: IHttpPerfRunState) => void;
	readonly promise: Promise<IHttpPerfRunState>;
	listener?: IDisposable;
}

/** `Basic user:password` (the client's shorthand) goes out base64-encoded, as the client sends it. */
function encodeBasicShorthand(key: string, value: string): string {
	const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
	return basic ? `Basic ${encodeBase64(VSBuffer.fromString(`${basic[1]}:${basic[2]}`))}` : value;
}

export class VoltHttpPerformance extends Disposable implements IVoltHttpPerformance {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeFile = this._register(new Emitter<URI>());
	readonly onDidChangeFile = this._onDidChangeFile.event;
	private readonly _onDidChangeRun = this._register(new Emitter<URI>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly entries = new ResourceMap<IHttpPerfEntry>();
	private readonly loading = new ResourceMap<Promise<IHttpPerfEntry | undefined>>();
	/** What this service last wrote to a file: its own change events are not reloads. */
	private readonly written = new ResourceMap<string>();
	private readonly writes = new ResourceMap<Promise<void>>();
	private readonly indexes = new Map<string, Promise<URI[]>>();
	private readonly runs = new ResourceMap<IRun>();
	/** The engine's run ids, to the file they run. */
	private readonly byId = new Map<string, URI>();
	/** Progress that came before `start` returned its id (other windows' runs report here too). */
	private readonly early = new Map<string, IVoltLoadProgress[]>();
	private starting = 0;

	constructor(
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpLoad private readonly engine: IVoltHttpLoad,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(fileService.onDidFilesChange(event => {
			const changed = [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted].filter(uri => uri.path.endsWith(HTTP_PERF_FILE_SUFFIX));
			if (changed.length) {
				void this.applyFileChanges(changed);
			}
		}));
		this._register(engine.onDidProgress(progress => this.onProgress(progress)));
	}

	override dispose(): void {
		for (const [, run] of this.runs) {
			if (run.state.running && run.id) {
				void this.engine.stop(run.id).catch(() => undefined);
			}
			run.listener?.dispose();
		}
		super.dispose();
	}

	// --- Files -----------------------------------------------------------------------------------

	private async applyFileChanges(uris: readonly URI[]): Promise<void> {
		let any = false;
		for (const uri of uris) {
			const content = await this.read(uri);
			if (content !== undefined && this.written.get(uri) === content) {
				continue;
			}
			any = true;
			const known = this.entries.get(uri);
			if (content === undefined) {
				this.entries.delete(uri);
			} else if (known) {
				this.parseInto(known, content);
				this._onDidChangeFile.fire(uri);
			}
		}
		if (any) {
			this.indexes.clear();
			this._onDidChange.fire();
		}
	}

	private read(uri: URI): Promise<string | undefined> {
		return this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
	}

	private parseInto(entry: IHttpPerfEntry, content: string): void {
		const fallback = basename(entry.uri).slice(0, -HTTP_PERF_FILE_SUFFIX.length) || 'Performance test';
		try {
			entry.file = parseHttpPerfFile(content, fallback);
			entry.error = undefined;
		} catch (err) {
			entry.file = emptyHttpPerfFile(fallback);
			entry.error = err instanceof Error ? err.message : String(err);
		}
	}

	/** The test files under `folders`. */
	protected async findFiles(folders: readonly URI[]): Promise<URI[]> {
		if (!folders.length) {
			return [];
		}
		const query = this.instantiationService.createInstance(QueryBuilder).file([...folders], { includePattern: [HTTP_PERF_FILE_PATTERN], excludePattern: [{ pattern: '**/node_modules/**' }], maxResults: MAX_FILES });
		const found = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
		return (found?.results ?? []).map(result => result.resource);
	}

	private index(root: URI | undefined): Promise<URI[]> {
		const key = root?.toString() ?? '';
		let index = this.indexes.get(key);
		if (!index) {
			index = this.findFiles(this.http.foldersOf(root)).then(uris => uris.sort((a, b) => a.path.localeCompare(b.path)));
			this.indexes.set(key, index);
		}
		return index;
	}

	get(uri: URI): IHttpPerfEntry | undefined {
		return this.entries.get(uri);
	}

	load(uri: URI): Promise<IHttpPerfEntry | undefined> {
		const known = this.entries.get(uri);
		if (known) {
			return Promise.resolve(known);
		}
		let pending = this.loading.get(uri);
		if (!pending) {
			pending = this.read(uri).then(content => {
				this.loading.delete(uri);
				if (content === undefined) {
					return undefined;
				}
				const existing = this.entries.get(uri);
				if (existing) {
					return existing;
				}
				const entry: IHttpPerfEntry = { uri, file: emptyHttpPerfFile('') };
				this.parseInto(entry, content);
				this.entries.set(uri, entry);
				return entry;
			});
			this.loading.set(uri, pending);
		}
		return pending;
	}

	private async require(uri: URI): Promise<IHttpPerfEntry> {
		const entry = await this.load(uri);
		if (!entry) {
			throw new Error(`The performance test ${uri.path} does not exist.`);
		}
		if (entry.error) {
			throw new Error(`${basename(uri)} cannot be used: ${entry.error}`);
		}
		return entry;
	}

	/** Writes the file (one write at a time per file) and tells everyone showing it. */
	private save(entry: IHttpPerfEntry): Promise<void> {
		const content = serializeHttpPerfFile(entry.file);
		this.written.set(entry.uri, content);
		this._onDidChangeFile.fire(entry.uri);
		this._onDidChange.fire();
		const next = (this.writes.get(entry.uri) ?? Promise.resolve()).catch(() => undefined).then(async () => {
			// A later change is already queued behind this one with newer text.
			if (this.written.get(entry.uri) === content) {
				await this.fileService.writeFile(entry.uri, VSBuffer.fromString(content));
			}
		});
		this.writes.set(entry.uri, next);
		return next;
	}

	async update(uri: URI, mutate: (file: IHttpPerfFile) => void): Promise<void> {
		const entry = await this.require(uri);
		mutate(entry.file);
		await this.save(entry);
	}

	// --- Confirmed hosts -------------------------------------------------------------------------

	private readConfirmations(): Record<string, Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(HTTP_PERF_CONFIRMATIONS_KEY, StorageScope.APPLICATION, '{}'));
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, Record<string, string>> : {};
		} catch {
			return {};
		}
	}

	private writeConfirmations(uri: URI, hosts: Record<string, string> | undefined): void {
		const record = this.readConfirmations();
		if (hosts && Object.keys(hosts).length) {
			record[uri.toString()] = hosts;
		} else {
			delete record[uri.toString()];
		}
		this.storageService.store(HTTP_PERF_CONFIRMATIONS_KEY, JSON.stringify(record), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	confirmedHostsOf(uri: URI): readonly string[] {
		const file = this.entries.get(uri)?.file;
		const given = this.readConfirmations()[uri.toString()];
		if (!file || !given || typeof given !== 'object') {
			return [];
		}
		return file.confirmedHosts.map(item => item.host.toLowerCase()).filter(host => typeof given[host] === 'string');
	}

	async confirmHosts(uri: URI, hosts: readonly string[]): Promise<void> {
		const names = [...new Set(hosts.map(host => host.trim().toLowerCase()).filter(Boolean))];
		if (!names.length) {
			return;
		}
		const at = new Date(this.now()).toISOString();
		const given = { ...(this.readConfirmations()[uri.toString()] ?? {}) };
		for (const name of names) {
			given[name] = at;
		}
		this.writeConfirmations(uri, given);
		await this.update(uri, file => {
			file.confirmedHosts = [...file.confirmedHosts.filter(item => !names.includes(item.host.toLowerCase())), ...names.map(host => ({ host, at }))];
		});
	}

	// --- IHttpToolFiles --------------------------------------------------------------------------

	async list(root: URI | undefined): Promise<readonly IHttpToolFileEntry[]> {
		const out: IHttpToolFileEntry[] = [];
		for (const uri of await this.index(root)) {
			const entry = await this.load(uri);
			if (!entry) {
				continue;
			}
			const running = !!this.runs.get(uri)?.state.running;
			out.push({ uri, name: entry.file.name, detail: entry.error ? 'Unreadable' : httpPerfDetail(entry.file), ...(running ? { running } : {}) });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	nameOf(uri: URI): string | undefined {
		return this.entries.get(uri)?.file.name;
	}

	private folderFor(root: URI | undefined): URI {
		const base = root ?? this.http.foldersOf(undefined)[0];
		if (!base) {
			throw new Error('Open a project folder to keep performance tests in.');
		}
		const configured = this.configurationService.getValue<string>(HTTP_COLLECTIONS_FOLDER_SETTING);
		const folder = typeof configured === 'string' ? configured.trim().replace(/^[\\/]+|[\\/]+$/g, '') : 'http';
		return joinPath(folder && !folder.split(/[\\/]/).includes('..') ? joinPath(base, folder) : base, HTTP_PERF_FOLDER);
	}

	private async addFile(root: URI | undefined, file: IHttpPerfFile): Promise<URI> {
		const folder = this.folderFor(root);
		const stem = httpFileNameFor(file.name).replace(/^collection$/, 'performance-test');
		let uri = joinPath(folder, `${stem}${HTTP_PERF_FILE_SUFFIX}`);
		for (let at = 2; await this.fileService.exists(uri); at++) {
			uri = joinPath(folder, `${stem}-${at}${HTTP_PERF_FILE_SUFFIX}`);
		}
		const content = serializeHttpPerfFile(file);
		this.written.set(uri, content);
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		this.entries.set(uri, { uri, file });
		this.indexes.clear();
		this._onDidChange.fire();
		return uri;
	}

	create(root: URI | undefined, name?: string): Promise<URI> {
		return this.addFile(root, emptyHttpPerfFile(name?.trim() || 'Performance test'));
	}

	async rename(uri: URI, name: string): Promise<void> {
		const next = name.trim();
		if (next) {
			await this.update(uri, file => file.name = next);
		}
	}

	async duplicate(uri: URI): Promise<URI> {
		const entry = await this.require(uri);
		const root = this.http.foldersOf(undefined).find(folder => isEqualOrParent(uri, folder));
		// A copy is a new test: the hosts the user confirmed and the runs stay with the original.
		const copy = parseHttpPerfFile(serializeHttpPerfFile({ ...entry.file, confirmedHosts: [], runs: [] }), entry.file.name);
		copy.name = `${entry.file.name} copy`;
		return this.addFile(root, copy);
	}

	async remove(uri: URI): Promise<void> {
		this.stop(uri);
		await this.fileService.del(uri, { useTrash: true }).catch(() => this.fileService.del(uri));
		this.writeConfirmations(uri, undefined);
		this.entries.delete(uri);
		this.indexes.clear();
		this._onDidChange.fire();
	}

	async saveDefinition(root: URI | undefined, definition: unknown, uri?: URI): Promise<URI> {
		const name = typeof definition === 'object' && definition !== null && typeof (definition as { name?: unknown }).name === 'string' ? ((definition as { name: string }).name.trim() || 'Performance test') : 'Performance test';
		const parsed = parseHttpPerfDefinition(definition, name);
		const existing = uri ? await this.load(uri) : undefined;
		if (uri && existing && !existing.error) {
			await this.update(uri, file => Object.assign(file, parsed));
			return uri;
		}
		if (uri) {
			throw new Error(`No performance test at ${uri.path}. Leave the path out to create one.`);
		}
		return this.addFile(root, { ...emptyHttpPerfFile(parsed.name), ...parsed });
	}

	// --- Targets ---------------------------------------------------------------------------------

	rootOf(uri: URI, root?: URI): URI | undefined {
		return root ?? this.http.foldersOf(undefined).find(folder => isEqualOrParent(uri, folder)) ?? this.http.foldersOf(undefined)[0];
	}

	collectionRef(root: URI | undefined, collection: URI): string {
		return (root && relativePath(root, collection)) || collection.toString();
	}

	collectionUri(root: URI | undefined, ref: string): URI | undefined {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
			return URI.parse(ref);
		}
		return root && !ref.split(/[\\/]/).includes('..') ? joinPath(root, ref) : undefined;
	}

	private async prepareTarget(target: IHttpPerfTarget, project: URI | undefined, mode: VoltLoadMode): Promise<IHttpPerfPreparedTarget> {
		let spec: { readonly name?: string; readonly method: string; readonly url: string; readonly headers: readonly (readonly [string, string])[]; readonly body?: string };
		let collection: URI | undefined;
		let problem: string | undefined;
		if (target.ref) {
			collection = this.collectionUri(project, target.ref.collection);
			const loaded = collection ? await this.collections.load(collection) : undefined;
			const item = loaded && !loaded.error ? findHttpItemByPath(loaded.collection, target.ref.path) : undefined;
			const found = loaded && item?.kind === 'request' ? findHttpItem(loaded.collection, item.id) : undefined;
			if (!loaded || loaded.error || !item || item.kind !== 'request' || !found) {
				const where = `${target.ref.collection}${target.ref.path.length ? ` / ${target.ref.path.join(' / ')}` : ''}`;
				return { id: target.id, name: target.name || target.ref.path[target.ref.path.length - 1] || target.ref.collection, method: '', url: '', missing: [], problem: `The request ${where} is not in the project any more.` };
			}
			const wire = httpWireRequest(item, found.ancestors, loaded.collection);
			spec = wire.spec;
			if (wire.formdata || wire.binaryPath) {
				problem = 'Form-data and file bodies are not sent by performance tests: give the request a raw body.';
			}
		} else if (target.inline) {
			spec = target.inline;
		} else {
			return { id: target.id, name: target.name || 'Target', method: '', url: '', missing: [], problem: 'The target has neither a request nor a URL.' };
		}
		const known = await this.collections.variablesFor(project, collection);
		const record: Record<string, string> = {};
		for (const [key, item] of known) {
			record[key] = item.value;
		}
		const scope = this.http.scopeOf(record, {});
		const fill = (text: string) => resolveHttpPerfText(text, part => resolveHttpVariables(part, scope));
		const url = fill(spec.url.trim());
		const headers = spec.headers.map(([key, value]) => [fill(key), encodeBasicShorthand(key, fill(value))] as const);
		const body = spec.body !== undefined && mode !== 'sse' ? fill(spec.body) : undefined;
		const missing = [...new Set([url, ...headers.flat(), body ?? ''].flatMap(httpPerfUnresolved))];
		const wire = url && !missing.length ? httpRequestUrl(url) : url;
		const host = missing.length ? undefined : httpPerfHostOf(wire);
		if (!problem && !url) {
			problem = 'The target has no URL.';
		} else if (!problem && !missing.length) {
			const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(wire)?.[1]?.toLowerCase();
			if (mode === 'ws' ? !scheme || !['ws', 'wss', 'http', 'https'].includes(scheme) : scheme !== 'http' && scheme !== 'https') {
				problem = mode === 'ws' ? `A WebSocket test needs ws:// or wss:// URLs, not ${scheme}://.` : `${mode === 'sse' ? 'An event stream' : 'A request'} needs an http:// or https:// URL, not ${scheme}://.`;
			}
		}
		const name = target.name || spec.name || `${spec.method} ${spec.url}`;
		const method = mode === 'http' ? (spec.method || 'GET').toUpperCase() : 'GET';
		return {
			id: target.id, name, method, url: wire, missing, ...(host ? { host } : {}), ...(problem ? { problem } : {}),
			...(!problem && !missing.length ? { load: { name, method, url: wire, headers, ...(body !== undefined && body !== '' && mode === 'http' ? { body } : {}), weight: target.weight } } : {}),
		};
	}

	async prepare(uri: URI, root?: URI): Promise<IHttpPerfPrepared> {
		const entry = await this.require(uri);
		const project = this.rootOf(uri, root);
		const file = entry.file;
		const targets = await Promise.all(file.targets.map(target => this.prepareTarget(target, project, file.mode)));
		const problems: string[] = [];
		if (!targets.length) {
			problems.push('Add a request or a URL under Targets first.');
		}
		for (const target of targets) {
			if (target.problem) {
				problems.push(`${target.name}: ${target.problem}`);
			} else if (target.missing.length) {
				problems.push(`${target.name}: nothing fills ${target.missing.map(name => `{{${name}}}`).join(', ')}. Pick an environment that has ${target.missing.length === 1 ? 'it' : 'them'}, or set ${target.missing.length === 1 ? 'it' : 'them'} in the collection.`);
			}
		}
		if (targets.length && targets.every(target => !target.problem && !target.missing.length && !(target.load?.weight ?? 1)) && file.mode === 'http' && file.load.order === 'weighted') {
			problems.push('Every target has weight 0: give one a weight above 0.');
		}
		const urls = targets.filter(target => target.host).map(target => target.url);
		const hosts = [...new Set(targets.map(target => target.host).filter((host): host is string => !!host))].sort();
		const confirmed = new Set(this.confirmedHostsOf(uri));
		return { targets, hosts, toConfirm: httpPerfHostsToConfirm(urls, [...confirmed].map(host => ({ host, at: '' }))), problems };
	}

	// --- Runs ------------------------------------------------------------------------------------

	runOf(uri: URI): IHttpPerfRunState | undefined {
		return this.runs.get(uri)?.state;
	}

	stop(uri: URI): void {
		const run = this.runs.get(uri);
		if (!run?.state.running || run.state.stopping) {
			return;
		}
		this.setState(uri, run, { stopping: true });
		if (run.id) {
			void this.engine.stop(run.id).catch(() => undefined);
		}
	}

	async run(uri: URI, options: IHttpPerfRunOptions = {}): Promise<IHttpPerfRunState> {
		const running = this.runs.get(uri);
		if (running?.state.running) {
			return running.promise;
		}
		const entry = await this.require(uri);
		const prepared = await this.prepare(uri, options.root);
		if (prepared.problems.length) {
			throw new Error(prepared.problems.join('\n'));
		}
		if (prepared.toConfirm.length) {
			throw new Error(`Not started: ${prepared.toConfirm.join(', ')} ${prepared.toConfirm.length === 1 ? 'is' : 'are'} not this machine or a private network, and the user has not confirmed in the Volt Client that they may send load there.`);
		}
		const file = entry.file;
		const spec: IVoltLoadSpec = httpPerfSpec(file, prepared.targets.map(target => target.load!), options.caps);
		const config: IHttpPerfRunConfig = {
			users: spec.users,
			...(spec.requests ? { requests: spec.requests } : { durationSec: spec.durationSec }),
			profile: file.load.profile,
			...(spec.rps ? { rps: spec.rps } : {}),
			warmupSec: spec.warmupSec ?? 0,
			targets: spec.targets.length,
			by: options.by ?? 'user',
		};
		let resolve!: (state: IHttpPerfRunState) => void;
		const promise = new Promise<IHttpPerfRunState>(done => resolve = done);
		const run: IRun = {
			state: {
				running: true, mode: file.mode, by: options.by ?? 'user', startedAt: this.now(), config,
				plannedSec: (spec.warmupSec ?? 0) + (spec.durationSec ?? 0), warmupSec: spec.warmupSec ?? 0,
				...(spec.requests ? { requests: spec.requests } : {}), samples: [],
			},
			thresholds: [...file.thresholds],
			resolve,
			promise,
		};
		this.runs.set(uri, run);
		if (options.token) {
			run.listener = options.token.onCancellationRequested(() => this.stop(uri));
		}
		this._onDidChange.fire();
		this._onDidChangeRun.fire(uri);
		this.starting++;
		try {
			const id = await this.engine.start(spec);
			run.id = id;
			this.byId.set(id, uri);
			if (run.state.stopping) {
				void this.engine.stop(id).catch(() => undefined);
			}
			for (const progress of this.early.get(id) ?? []) {
				this.onProgress(progress);
			}
			this.early.delete(id);
		} catch (err) {
			this.finish(uri, run, { error: err instanceof Error ? err.message : String(err) });
		} finally {
			if (--this.starting === 0) {
				this.early.clear();
			}
		}
		return promise;
	}

	private onProgress(progress: IVoltLoadProgress): void {
		const uri = this.byId.get(progress.id);
		if (!uri) {
			if (!this.starting) {
				return;
			}
			// Perhaps a run whose `start` has not returned its id yet: kept for it (a few at most).
			const pending = this.early.get(progress.id) ?? [];
			if (pending.length < 50) {
				pending.push(progress);
				this.early.set(progress.id, pending);
			}
			return;
		}
		const run = this.runs.get(uri);
		if (!run || run.id !== progress.id || !run.state.running) {
			return;
		}
		if (progress.type === 'sample' && progress.sample) {
			this.setState(uri, run, { samples: [...run.state.samples, progress.sample] });
		} else if (progress.type === 'done' && progress.result) {
			const result = summarizeHttpPerfRun(progress.result, run.thresholds, run.state.config);
			this.finish(uri, run, { result });
			void this.update(uri, file => file.runs = addHttpPerfRun(file.runs, result)).catch(() => undefined);
		} else if (progress.type === 'error') {
			this.finish(uri, run, { error: progress.error ?? 'The run broke off.' });
		}
	}

	private finish(uri: URI, run: IRun, change: Partial<IHttpPerfRunState>): void {
		if (run.id) {
			this.byId.delete(run.id);
		}
		run.listener?.dispose();
		this.setState(uri, run, { ...change, running: false, stopping: false, endedAt: this.now() });
		this._onDidChange.fire();
		run.resolve(run.state);
	}

	private setState(uri: URI, run: IRun, change: Partial<IHttpPerfRunState>): void {
		run.state = { ...run.state, ...change };
		this._onDidChangeRun.fire(uri);
	}

	async setAnalysis(uri: URI, runId: string, analysis: { readonly text: string; readonly model: string }): Promise<void> {
		const at = this.now();
		await this.update(uri, file => {
			file.runs = file.runs.map(run => run.id === runId ? { ...run, analysis: { text: analysis.text, model: analysis.model, at } } : run);
		});
		const live = this.runs.get(uri);
		if (live?.state.result?.id === runId) {
			live.state = { ...live.state, result: { ...live.state.result, analysis: { text: analysis.text, model: analysis.model, at } } };
		}
	}

	protected now(): number {
		return Date.now();
	}
}

/** The web workbench cannot generate load: the desktop app replaces this (electron-browser). */
class NoVoltHttpLoad implements IVoltHttpLoad {
	declare readonly _serviceBrand: undefined;
	readonly onDidProgress = Event.None as Event<IVoltLoadProgress>;
	start(): Promise<string> {
		return Promise.reject(new Error('Performance tests run in the desktop app.'));
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
}

// Registered before the desktop app's main-process service (electron-browser), which wins there.
registerSingleton(IVoltHttpLoad, NoVoltHttpLoad, InstantiationType.Delayed);
registerSingleton(IVoltHttpPerformance, VoltHttpPerformance, InstantiationType.Delayed);
