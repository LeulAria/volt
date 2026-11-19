/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { encodeBase64, streamToBuffer, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltHttpTransport } from '../../../../platform/voltHttp/common/voltHttpTransport.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { resolveHttpVariables } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { findHttpItem, findHttpItemByPath, httpFileNameFor, httpItemPath, httpRequestLabel, httpRequestsOf, httpVariableRecord, httpWireRequest, IHttpFolder, IHttpRequest } from '../common/httpCollection.js';
import { httpProtocolInfo } from '../common/httpProtocols.js';
import { analyzeHttpSecurityExchange, dedupeHttpSecurityFindings, IHttpSecurityAuthorizedHost, emptyHttpSecurityFile, HTTP_SECURITY_FILE_PATTERN, HTTP_SECURITY_FILE_SUFFIX, HTTP_SECURITY_SEVERITIES, httpSecurityHostOf, IHttpSecurityEndpoint, IHttpSecurityExchange, IHttpSecurityFile, IHttpSecurityFinding, IHttpSecurityProbe, IHttpSecurityRequest, IHttpSecurityScanRecord, HttpSecurityTriage, isHttpSecurityCheckEnabled, isHttpSecurityFindingOpen, isHttpSecurityMethodAllowed, maskHttpSecurityUrl, normalizeHttpSecurityOptions, parseHttpSecurityFile, parseHttpSecurityTargets, planHttpSecurityProbes, serializeHttpSecurityFile, sortHttpSecurityFindings, summarizeHttpSecurity, trimHttpSecurityFinding } from '../common/httpSecurity.js';
import { HTTP_COLLECTIONS_FOLDER_SETTING, httpDraftKey, IVoltHttpCollections } from './voltHttpCollections.js';
import { httpRequestUrl, IHttpExchange, IVoltHttpService } from './voltHttpService.js';
import { IHttpToolFileEntry, IHttpToolFiles } from './voltHttpToolPages.js';

export const IVoltHttpSecurity = createDecorator<IVoltHttpSecurity>('voltHttpSecurity');

const MAX_FILES = 200;
const MAX_PROBE_BODY = 512 * 1024;
/**
 * Where the authorizations the user gave in the Volt Client are recorded: `{ [file uri]: { [host]: ISO date } }`.
 * The file's `authorizedHosts` alone authorizes nothing (an agent, a teammate or a script can write
 * the file); a host counts only when this window's own record has it too.
 */
export const HTTP_SECURITY_AUTHORIZATIONS_KEY = 'volt.http.securityAuthorizations';

/** A scan file, loaded: one object per file for the whole window. */
export interface IHttpSecurityEntry {
	readonly uri: URI;
	file: IHttpSecurityFile;
	/** Why the file could not be read; `file` is empty then. */
	error?: string;
}

/** One request a scan's targets stand for. */
export interface IHttpSecurityTargetRequest {
	readonly collection: URI;
	/** The collection as the file and the findings name it. */
	readonly collectionRef: string;
	readonly request: IHttpRequest;
	readonly ancestors: readonly IHttpFolder[];
	readonly path: readonly string[];
}

export type HttpSecurityScanStage = 'resolving' | 'baseline' | 'probing' | 'done';

/** A scan in progress or just finished. Lives in the service: the page that shows it comes and goes. */
export interface IHttpSecurityScanState {
	readonly running: boolean;
	readonly stage: HttpSecurityScanStage;
	/** Active probes are being (or were) sent: the file asks for them and every host is authorized. */
	readonly active: boolean;
	/** Requests in scope. */
	readonly total: number;
	/** Requests done in the stage in hand. */
	readonly done: number;
	/** Requests whose response was read. */
	readonly requests: number;
	/** Extra requests the active checks sent. */
	readonly probes: number;
	/** What is being sent now. */
	readonly current?: string;
	readonly findings: readonly IHttpSecurityFinding[];
	readonly notes: readonly string[];
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly stopped?: boolean;
	readonly error?: string;
}

export interface IHttpSecurityScanOptions {
	/** The project the client is open for; the folder that holds the file when absent. */
	readonly root?: URI;
	/** `false`: passive checks only, whatever the file says. It can never turn active checks on. */
	readonly active?: boolean;
	readonly token?: CancellationToken;
}

export interface IHttpSecurityHosts {
	/** The hosts the targets' URLs resolve to, with how many requests go to each. */
	readonly hosts: readonly { readonly host: string; readonly requests: number }[];
	/** Requests whose URL has a variable nothing fills in yet. */
	readonly unresolved: number;
}

export interface IHttpSecurityResend {
	/** The finding showed again. */
	readonly reproduced: boolean;
	readonly message: string;
	readonly finding?: IHttpSecurityFinding;
}

export interface IVoltHttpSecurity extends IHttpToolFiles {
	readonly _serviceBrand: undefined;
	/** A scan file's content changed (its uri). */
	readonly onDidChangeFile: Event<URI>;
	get(uri: URI): IHttpSecurityEntry | undefined;
	load(uri: URI): Promise<IHttpSecurityEntry | undefined>;
	/** Changes the file's definition and saves it. */
	update(uri: URI, mutate: (file: IHttpSecurityFile) => void): Promise<void>;
	/** The user says (or takes back) that they may test `host`. Only the Volt Client's own UI calls this. */
	setAuthorized(uri: URI, host: string, authorized: boolean, note?: string): Promise<void>;
	/**
	 * The hosts active checks may go to: in the file's `authorizedHosts` and given by the user in
	 * this Volt (recorded outside the file). A host only written into the file is not among them.
	 */
	authorizedHostsOf(uri: URI): readonly IHttpSecurityAuthorizedHost[];
	isAuthorized(uri: URI, host: string | undefined): boolean;
	setTriage(uri: URI, fingerprint: string, triage: HttpSecurityTriage | undefined): Promise<void>;
	/**
	 * Creates or replaces a scan's definition from JSON an agent wrote: name, description, targets,
	 * checks and options. Authorizations, triage and the last scan are never taken from it: an
	 * existing file keeps its own, a new one starts with none.
	 */
	saveDefinition(root: URI | undefined, definition: unknown, uri?: URI): Promise<URI>;
	/** How a file names a collection: its path relative to the project when it is inside it. */
	collectionRef(root: URI | undefined, collection: URI): string;
	collectionUri(root: URI | undefined, ref: string): URI | undefined;
	/** The project a scan file belongs to. */
	rootOf(uri: URI, root?: URI): URI | undefined;
	targetsOf(uri: URI, root?: URI): Promise<readonly IHttpSecurityTargetRequest[]>;
	hostsOf(uri: URI, root?: URI): Promise<IHttpSecurityHosts>;
	/**
	 * Sends each target's request once and runs the passive checks on the answer; then, only when
	 * the file's options ask for active checks and the user authorized every host the targets go
	 * to, the active probes, paced by the file's requests per second. Resolves when the scan ends
	 * (or is stopped) with its final state; the result is saved into the file.
	 */
	scan(uri: URI, options?: IHttpSecurityScanOptions): Promise<IHttpSecurityScanState>;
	stop(uri: URI): void;
	onDidChangeScan(uri: URI): Event<IHttpSecurityScanState>;
	/** The scan running or last run in this window; undefined before one ran (the file's `lastScan` has earlier ones). */
	scanOf(uri: URI): IHttpSecurityScanState | undefined;
	/** The finding's request in its collection, and the exchange the scan made for it when it is still in memory. */
	locate(uri: URI, finding: IHttpSecurityFinding, root?: URI): Promise<{ readonly collection: URI; readonly id: string; readonly exchange?: IHttpExchange } | undefined>;
	/** Sends a finding's request (and, for an active finding, its probe) again and judges the answer anew. */
	resend(uri: URI, fingerprint: string, root?: URI): Promise<IHttpSecurityResend>;
}

/** What a finding of the scan in memory came from, to send it again. */
interface IFindingSource {
	readonly target: IHttpSecurityTargetRequest;
	readonly endpoint: IHttpSecurityEndpoint;
	readonly baseline: IHttpSecurityExchange;
	readonly raw?: IHttpExchange;
	readonly probe?: IHttpSecurityProbe;
}

interface IRun {
	state: IHttpSecurityScanState;
	readonly cancel: CancellationTokenSource;
	readonly sources: Map<string, IFindingSource>;
	promise?: Promise<IHttpSecurityScanState>;
}

export class VoltHttpSecurity extends Disposable implements IVoltHttpSecurity {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeFile = this._register(new Emitter<URI>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly entries = new ResourceMap<IHttpSecurityEntry>();
	private readonly loading = new ResourceMap<Promise<IHttpSecurityEntry | undefined>>();
	/** What this service last wrote to a file: its own change events are not reloads. */
	private readonly written = new ResourceMap<string>();
	private readonly writes = new ResourceMap<Promise<void>>();
	private readonly indexes = new Map<string, Promise<URI[]>>();
	private readonly runs = new ResourceMap<IRun>();
	private readonly scanEmitters = new ResourceMap<Emitter<IHttpSecurityScanState>>();
	/** When the last paced request went out. */
	private lastSendAt = 0;

	constructor(
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpTransport private readonly transport: IVoltHttpTransport,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(fileService.onDidFilesChange(event => {
			const changed = [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted].filter(uri => uri.path.endsWith(HTTP_SECURITY_FILE_SUFFIX));
			if (changed.length) {
				void this.applyFileChanges(changed);
			}
		}));
	}

	override dispose(): void {
		for (const run of this.runs.values()) {
			run.cancel.dispose(true);
		}
		for (const emitter of this.scanEmitters.values()) {
			emitter.dispose();
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

	private parseInto(entry: IHttpSecurityEntry, content: string): void {
		const fallback = basename(entry.uri).slice(0, -HTTP_SECURITY_FILE_SUFFIX.length) || 'Security scan';
		try {
			entry.file = parseHttpSecurityFile(content, fallback);
			entry.error = undefined;
		} catch (err) {
			entry.file = emptyHttpSecurityFile(fallback);
			entry.error = err instanceof Error ? err.message : String(err);
		}
	}

	/** The scan files under `folders`. */
	protected async findFiles(folders: readonly URI[]): Promise<URI[]> {
		if (!folders.length) {
			return [];
		}
		const query = this.instantiationService.createInstance(QueryBuilder).file([...folders], { includePattern: [HTTP_SECURITY_FILE_PATTERN], excludePattern: [{ pattern: '**/node_modules/**' }], maxResults: MAX_FILES });
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

	get(uri: URI): IHttpSecurityEntry | undefined {
		return this.entries.get(uri);
	}

	load(uri: URI): Promise<IHttpSecurityEntry | undefined> {
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
				const entry: IHttpSecurityEntry = { uri, file: emptyHttpSecurityFile('') };
				this.parseInto(entry, content);
				this.entries.set(uri, entry);
				return entry;
			});
			this.loading.set(uri, pending);
		}
		return pending;
	}

	private async require(uri: URI): Promise<IHttpSecurityEntry> {
		const entry = await this.load(uri);
		if (!entry) {
			throw new Error(`The security scan ${uri.path} does not exist.`);
		}
		if (entry.error) {
			throw new Error(`${basename(uri)} cannot be used: ${entry.error}`);
		}
		return entry;
	}

	/** Writes the file (one write at a time per file) and tells everyone showing it. */
	private save(entry: IHttpSecurityEntry): Promise<void> {
		const content = serializeHttpSecurityFile(entry.file);
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

	async update(uri: URI, mutate: (file: IHttpSecurityFile) => void): Promise<void> {
		const entry = await this.require(uri);
		mutate(entry.file);
		await this.save(entry);
	}

	setAuthorized(uri: URI, host: string, authorized: boolean, note?: string): Promise<void> {
		const name = host.trim().toLowerCase();
		const at = new Date(this.now()).toISOString();
		const record = this.readAuthorizations();
		const hosts = { ...(record[uri.toString()] ?? {}) };
		if (authorized && name) {
			hosts[name] = at;
		} else {
			delete hosts[name];
		}
		this.writeAuthorizations(uri, hosts);
		return this.update(uri, file => {
			file.authorizedHosts = file.authorizedHosts.filter(item => item.host.toLowerCase() !== name);
			if (authorized && name) {
				file.authorizedHosts.push({ host: name, at, ...(note ? { note } : {}) });
			}
		});
	}

	private readAuthorizations(): Record<string, Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(HTTP_SECURITY_AUTHORIZATIONS_KEY, StorageScope.APPLICATION, '{}'));
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, Record<string, string>> : {};
		} catch {
			return {};
		}
	}

	private writeAuthorizations(uri: URI, hosts: Record<string, string> | undefined): void {
		const record = this.readAuthorizations();
		if (hosts && Object.keys(hosts).length) {
			record[uri.toString()] = hosts;
		} else {
			delete record[uri.toString()];
		}
		this.storageService.store(HTTP_SECURITY_AUTHORIZATIONS_KEY, JSON.stringify(record), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	authorizedHostsOf(uri: URI): readonly IHttpSecurityAuthorizedHost[] {
		const file = this.entries.get(uri)?.file;
		const given = this.readAuthorizations()[uri.toString()];
		if (!file || !given || typeof given !== 'object') {
			return [];
		}
		return file.authorizedHosts.filter(item => typeof given[item.host.toLowerCase()] === 'string');
	}

	isAuthorized(uri: URI, host: string | undefined): boolean {
		return !!host && this.authorizedHostsOf(uri).some(item => item.host.toLowerCase() === host.toLowerCase());
	}

	setTriage(uri: URI, fingerprint: string, triage: HttpSecurityTriage | undefined): Promise<void> {
		return this.update(uri, file => {
			if (triage) {
				file.triage[fingerprint] = triage;
			} else {
				delete file.triage[fingerprint];
			}
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
			out.push({ uri, name: entry.file.name, detail: this.detailOf(entry), ...(running ? { running } : {}) });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	private detailOf(entry: IHttpSecurityEntry): string {
		if (entry.error) {
			return 'Unreadable';
		}
		const scan = entry.file.lastScan;
		if (!scan) {
			return 'Not scanned yet';
		}
		const summary = summarizeHttpSecurity(scan.findings, entry.file.triage);
		const parts = HTTP_SECURITY_SEVERITIES.filter(severity => summary.bySeverity[severity]).slice(0, 3).map(severity => `${summary.bySeverity[severity]} ${severity}`);
		return parts.length ? parts.join(', ') : 'No open findings';
	}

	nameOf(uri: URI): string | undefined {
		return this.entries.get(uri)?.file.name;
	}

	private folderFor(root: URI | undefined): URI {
		const base = root ?? this.http.foldersOf(undefined)[0];
		if (!base) {
			throw new Error('Open a project folder to keep security scans in.');
		}
		const configured = this.configurationService.getValue<string>(HTTP_COLLECTIONS_FOLDER_SETTING);
		const folder = typeof configured === 'string' ? configured.trim().replace(/^[\\/]+|[\\/]+$/g, '') : 'http';
		return joinPath(folder && !folder.split(/[\\/]/).includes('..') ? joinPath(base, folder) : base, 'security');
	}

	private async addFile(root: URI | undefined, file: IHttpSecurityFile): Promise<URI> {
		const folder = this.folderFor(root);
		const stem = httpFileNameFor(file.name).replace(/^collection$/, 'security-scan');
		let uri = joinPath(folder, `${stem}${HTTP_SECURITY_FILE_SUFFIX}`);
		for (let at = 2; await this.fileService.exists(uri); at++) {
			uri = joinPath(folder, `${stem}-${at}${HTTP_SECURITY_FILE_SUFFIX}`);
		}
		const content = serializeHttpSecurityFile(file);
		this.written.set(uri, content);
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		this.entries.set(uri, { uri, file });
		this.indexes.clear();
		this._onDidChange.fire();
		return uri;
	}

	create(root: URI | undefined, name?: string): Promise<URI> {
		return this.addFile(root, emptyHttpSecurityFile(name?.trim() || 'Security scan'));
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
		// A copy is a new scan: who may be tested, what was triaged and what was found stay with the original.
		const copy = parseHttpSecurityFile(serializeHttpSecurityFile({ ...entry.file, authorizedHosts: [], triage: {}, lastScan: undefined }), entry.file.name);
		copy.name = `${entry.file.name} copy`;
		delete copy.lastScan;
		return this.addFile(root, copy);
	}

	async remove(uri: URI): Promise<void> {
		this.stop(uri);
		await this.fileService.del(uri, { useTrash: true }).catch(() => this.fileService.del(uri));
		this.writeAuthorizations(uri, undefined);
		this.entries.delete(uri);
		this.runs.delete(uri);
		this.indexes.clear();
		this._onDidChange.fire();
	}

	async saveDefinition(root: URI | undefined, definition: unknown, uri?: URI): Promise<URI> {
		const input = typeof definition === 'object' && definition !== null && !Array.isArray(definition) ? definition as Record<string, unknown> : undefined;
		if (!input) {
			throw new Error('A scan definition is a JSON object: { name, description, targets, checks, options }.');
		}
		// Read as a file, so every value passes the same checks; then only the definition is taken from it.
		const parsed = parseHttpSecurityFile(JSON.stringify({ ...input, volt: 'security', authorizedHosts: [], triage: {}, lastScan: undefined }), typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Security scan');
		const existing = uri ? await this.load(uri) : undefined;
		if (uri && existing && !existing.error) {
			await this.update(uri, file => {
				file.name = parsed.name;
				file.description = parsed.description;
				file.targets = parsed.targets;
				file.checks = parsed.checks;
				file.options = parsed.options;
			});
			return uri;
		}
		if (uri) {
			throw new Error(`No security scan at ${uri.path}. Leave the path out to create one.`);
		}
		return this.addFile(root, { ...emptyHttpSecurityFile(parsed.name), description: parsed.description, targets: parsed.targets, checks: parsed.checks, options: parsed.options });
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

	async targetsOf(uri: URI, root?: URI): Promise<readonly IHttpSecurityTargetRequest[]> {
		const entry = await this.require(uri);
		const project = this.rootOf(uri, root);
		const out: IHttpSecurityTargetRequest[] = [];
		const seen = new Set<string>();
		const targets = parseHttpSecurityTargets(entry.file.targets);
		for (const target of targets) {
			const collection = this.collectionUri(project, target.collection);
			const loaded = collection ? await this.collections.load(collection) : undefined;
			if (!collection || !loaded || loaded.error) {
				continue;
			}
			const model = loaded.collection;
			let requests: { readonly request: IHttpRequest; readonly ancestors: readonly IHttpFolder[] }[];
			if (!target.path?.length) {
				requests = httpRequestsOf(model.items);
			} else {
				const item = findHttpItemByPath(model, target.path);
				const found = item ? findHttpItem(model, item.id) : undefined;
				requests = !item || !found ? [] : item.kind === 'request' ? [{ request: item, ancestors: found.ancestors }] : httpRequestsOf(item.items, [...found.ancestors, item]);
			}
			for (const { request, ancestors } of requests) {
				const key = httpDraftKey(collection, request.id);
				if (!seen.has(key)) {
					seen.add(key);
					out.push({ collection, collectionRef: target.collection, request, ancestors, path: httpItemPath(model, request.id) ?? [request.name] });
				}
			}
		}
		return out;
	}

	async hostsOf(uri: URI, root?: URI): Promise<IHttpSecurityHosts> {
		const project = this.rootOf(uri, root);
		const counts = new Map<string, number>();
		let unresolved = 0;
		const scopes = new ResourceMap<Readonly<Record<string, string>>>();
		for (const target of await this.targetsOf(uri, project)) {
			let variables = scopes.get(target.collection);
			if (!variables) {
				const known = await this.collections.variablesFor(project, target.collection);
				variables = httpVariableRecord([...known].map(([key, item]) => ({ key, value: item.value, enabled: true })));
				scopes.set(target.collection, variables);
			}
			const loaded = this.collections.get(target.collection);
			const wire = httpWireRequest(target.request, target.ancestors, loaded && !loaded.error ? loaded.collection : undefined);
			const url = resolveHttpVariables(wire.spec.url, this.http.scopeOf(variables, {}));
			const host = url.includes('{{') ? undefined : httpSecurityHostOf(httpRequestUrl(url));
			if (host) {
				counts.set(host, (counts.get(host) ?? 0) + 1);
			} else {
				unresolved++;
			}
		}
		return { hosts: [...counts].map(([host, requests]) => ({ host, requests })).sort((a, b) => a.host.localeCompare(b.host)), unresolved };
	}

	// --- Scanning --------------------------------------------------------------------------------

	onDidChangeScan(uri: URI): Event<IHttpSecurityScanState> {
		let emitter = this.scanEmitters.get(uri);
		if (!emitter) {
			emitter = new Emitter<IHttpSecurityScanState>();
			this.scanEmitters.set(uri, emitter);
		}
		return emitter.event;
	}

	scanOf(uri: URI): IHttpSecurityScanState | undefined {
		return this.runs.get(uri)?.state;
	}

	stop(uri: URI): void {
		const run = this.runs.get(uri);
		if (run?.state.running) {
			run.cancel.cancel();
		}
	}

	scan(uri: URI, options: IHttpSecurityScanOptions = {}): Promise<IHttpSecurityScanState> {
		const running = this.runs.get(uri);
		if (running?.state.running && running.promise) {
			return running.promise;
		}
		running?.cancel.dispose();
		const run: IRun = {
			state: { running: true, stage: 'resolving', active: false, total: 0, done: 0, requests: 0, probes: 0, findings: [], notes: [], startedAt: this.now() },
			cancel: new CancellationTokenSource(options.token),
			sources: new Map(),
		};
		this.runs.set(uri, run);
		run.promise = this.runScan(uri, run, options).catch(err => {
			this.setState(uri, run, { running: false, stage: 'done', endedAt: this.now(), error: err instanceof Error ? err.message : String(err) });
			return run.state;
		}).finally(() => this._onDidChange.fire());
		this._onDidChange.fire();
		return run.promise;
	}

	private setState(uri: URI, run: IRun, change: Partial<IHttpSecurityScanState>): void {
		run.state = { ...run.state, ...change };
		this.scanEmitters.get(uri)?.fire(run.state);
	}

	protected now(): number {
		return Date.now();
	}

	/** Waits; resolves early when the scan is stopped. */
	protected wait(ms: number, token: CancellationToken): Promise<void> {
		return timeout(ms, token).then(undefined, () => undefined);
	}

	/** Holds the next request back until the file's requests per second allow it. */
	private async pace(requestsPerSecond: number, token: CancellationToken): Promise<void> {
		const due = this.lastSendAt + 1000 / requestsPerSecond;
		const now = this.now();
		if (due > now) {
			await this.wait(due - now, token);
		}
		this.lastSendAt = this.now();
	}

	/**
	 * Whether a probe's request may go out: active checks are on in the file as it is now, its host
	 * is one the user authorized, and its method is one a probe may use. Every probe request passes
	 * through here right before it is sent; nothing else in the scan decides this.
	 */
	private probeRefusal(uri: URI, request: IHttpSecurityRequest): string | undefined {
		const file = this.entries.get(uri)?.file;
		if (!file) {
			return 'the scan file is gone';
		}
		const options = normalizeHttpSecurityOptions(file.options);
		if (!options.active) {
			return 'active checks are off';
		}
		const host = httpSecurityHostOf(request.url);
		if (!this.isAuthorized(uri, host)) {
			return `${host ?? 'the host'} is not authorized`;
		}
		return isHttpSecurityMethodAllowed(request.method, options.includeUnsafeMethods) ? undefined : `${request.method} is not sent by probes`;
	}

	/**
	 * Sends a probe as it is written (no variables filled in, no redirect followed, nothing kept
	 * in the client's history).
	 */
	protected async sendProbe(request: IHttpSecurityRequest, timeoutMs: number, token: CancellationToken): Promise<IHttpSecurityExchange> {
		const headers: Record<string, string> = {};
		for (const [key, value] of request.headers) {
			// `Basic user:password` (the client's shorthand) goes out base64-encoded, as the client sends it.
			const basic = key.toLowerCase() === 'authorization' ? /^Basic\s+([^:\s]+):(.*)$/i.exec(value) : null;
			headers[key] = basic ? `Basic ${encodeBase64(VSBuffer.fromString(`${basic[1]}:${basic[2]}`))}` : value;
		}
		const method = request.method.toUpperCase();
		try {
			const context = await this.transport.request({ type: method, url: httpRequestUrl(request.url), headers, ...(method !== 'GET' && method !== 'HEAD' && request.body !== undefined ? { data: request.body } : {}), timeout: timeoutMs, followRedirects: 0, disableCache: true }, token);
			if (!context.res.statusCode) {
				return { request, error: 'The server answered with a redirect this window cannot read.' };
			}
			const buffer = await streamToBuffer(context.stream);
			const responseHeaders: Record<string, string> = {};
			for (const [key, value] of Object.entries(context.res.headers)) {
				if (value !== undefined) {
					responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
				}
			}
			return { request, response: { status: context.res.statusCode, headers: responseHeaders, body: (buffer.byteLength > MAX_PROBE_BODY ? buffer.slice(0, MAX_PROBE_BODY) : buffer).toString() } };
		} catch (err) {
			return { request, error: token.isCancellationRequested ? 'Cancelled.' : err instanceof Error ? err.message : String(err) };
		}
	}

	private exchangeOf(raw: IHttpExchange): IHttpSecurityExchange {
		const response = raw.response;
		return {
			request: { method: raw.method, url: httpRequestUrl(raw.url), headers: raw.headers, ...(raw.body !== undefined ? { body: raw.body } : {}) },
			...(response ? { response: { status: response.status, headers: response.headers, body: response.body } } : {}),
			...(raw.error ? { error: raw.error } : {}),
		};
	}

	/**
	 * A target's own request, sent the way Send does (its collection's variables, auth and
	 * scripts). A request that changes data is sent only when the user turned those on, and DELETE
	 * never: for those the last response in the client's history is read instead.
	 */
	private async baselineOf(target: IHttpSecurityTargetRequest, root: URI | undefined, includeUnsafeMethods: boolean, requestsPerSecond: number, timeoutMs: number, token: CancellationToken): Promise<{ readonly raw?: IHttpExchange; readonly sent: boolean; readonly note?: string }> {
		const request = this.collections.draftOf(httpDraftKey(target.collection, target.request.id)) ?? target.request;
		const label = httpRequestLabel(request);
		if (httpProtocolInfo(request.protocol).stream) {
			return { sent: false, note: `${label}: a connection (${request.protocol}) is not scanned.` };
		}
		if (!request.url.trim()) {
			return { sent: false, note: `${label}: the request has no URL.` };
		}
		const method = request.method.toUpperCase();
		if (!isHttpSecurityMethodAllowed(method, includeUnsafeMethods) || method === 'TRACE') {
			const collection = target.collection.toString();
			const raw = this.http.historyOf(root).find(item => !!item.response && item.request?.collection === collection && item.request.id === target.request.id);
			const why = method === 'DELETE' ? 'a scan never sends DELETE' : `${method} changes data and those tests are off`;
			return raw ? { raw, sent: false, note: `${label}: not sent (${why}); its last response in the history was read instead.` } : { sent: false, note: `${label}: not sent (${why}) and it has no response in the history to read.` };
		}
		await this.pace(requestsPerSecond, token);
		if (token.isCancellationRequested) {
			return { sent: false };
		}
		const raw = await this.collections.send(request, { collection: target.collection, token, timeoutMs, ...(root ? { root } : {}) });
		if (raw.response) {
			return { raw, sent: true };
		}
		// A {{token}} a login's script sets is in reach once that login has been sent in this window.
		const hint = raw.error && /unresolved variable/i.test(raw.error) ? ' Send the request that sets it (a login, say) in the Volt Client first, then scan again.' : '';
		return { sent: true, note: `${label}: no response (${raw.error ?? 'unknown error'}).${hint}` };
	}

	private async runScan(uri: URI, run: IRun, scanOptions: IHttpSecurityScanOptions): Promise<IHttpSecurityScanState> {
		const token = run.cancel.token;
		const entry = await this.require(uri);
		const root = this.rootOf(uri, scanOptions.root);
		const options = normalizeHttpSecurityOptions(entry.file.options);
		const enabled = (id: string) => isHttpSecurityCheckEnabled(entry.file, id);
		const targets = await this.targetsOf(uri, root);
		const notes: string[] = [];
		const findings = new Map<string, IHttpSecurityFinding>();
		const publish = (change: Partial<IHttpSecurityScanState>) => this.setState(uri, run, { ...change, notes: [...notes], findings: sortHttpSecurityFindings([...findings.values()]) });
		const add = (found: readonly IHttpSecurityFinding[], source: IFindingSource) => {
			for (const finding of found) {
				const known = findings.get(finding.fingerprint);
				findings.set(finding.fingerprint, known ? dedupeHttpSecurityFindings([known, finding])[0] : finding);
				if (!known) {
					run.sources.set(finding.fingerprint, source);
				}
			}
		};
		if (!targets.length) {
			notes.push(entry.file.targets.length ? 'The targets name no request that still exists.' : 'No targets are picked.');
		}
		publish({ stage: 'baseline', total: targets.length });

		// Each request once, the way Send sends it; the passive checks read the answer.
		const baselines: (IFindingSource & { readonly sent: boolean })[] = [];
		let done = 0;
		for (const target of targets) {
			if (token.isCancellationRequested) {
				break;
			}
			publish({ current: httpRequestLabel(target.request) });
			const { raw, sent, note } = await this.baselineOf(target, root, options.includeUnsafeMethods, options.requestsPerSecond, options.timeoutMs, token);
			if (token.isCancellationRequested) {
				break;
			}
			if (note) {
				notes.push(note);
			}
			done++;
			if (raw?.response) {
				const baseline = this.exchangeOf(raw);
				const endpoint: IHttpSecurityEndpoint = { method: raw.method.toUpperCase(), url: maskHttpSecurityUrl(baseline.request.url), collection: target.collectionRef, path: target.path };
				const source: IFindingSource = { target, endpoint, baseline, raw };
				add(analyzeHttpSecurityExchange(baseline, endpoint, { enabled, now: this.now() }), source);
				baselines.push({ ...source, sent });
			}
			publish({ done, requests: baselines.length });
		}

		// Active probes: only when the file asks for them and the user authorized every host in scope.
		const hosts = [...new Set(baselines.map(item => httpSecurityHostOf(item.baseline.request.url)).filter((host): host is string => !!host))];
		const wanted = options.active && scanOptions.active !== false;
		const unauthorized = hosts.filter(host => !this.isAuthorized(uri, host));
		const active = wanted && hosts.length > 0 && !unauthorized.length && !token.isCancellationRequested;
		if (wanted && unauthorized.length) {
			notes.push(`Active checks did not run: ${unauthorized.join(', ')} ${unauthorized.length === 1 ? 'is' : 'are'} not authorized. Only the user can authorize a host, under Setup, Active checks in the Volt Client.`);
		} else if (options.active && scanOptions.active === false) {
			notes.push('Active checks were left out of this scan.');
		}
		let probes = 0;
		if (active) {
			const methodsByPath = new Map<string, Set<string>>();
			const pathKey = (url: string) => url.replace(/[?#].*$/, '');
			for (const item of baselines) {
				const key = pathKey(item.baseline.request.url);
				methodsByPath.set(key, (methodsByPath.get(key) ?? new Set()).add(item.baseline.request.method.toUpperCase()));
			}
			const hostsDone = new Set<string>();
			let blocked: string | undefined;
			done = 0;
			publish({ stage: 'probing', active: true, done });
			for (const item of baselines) {
				if (token.isCancellationRequested || blocked) {
					break;
				}
				const body = item.target.request.body.mode;
				const host = httpSecurityHostOf(item.baseline.request.url) ?? '';
				// A request that was not sent now, or whose body is built from files, has no baseline to replay.
				if (item.sent && body !== 'formdata' && body !== 'binary') {
					const plan = planHttpSecurityProbes(item.baseline, item.endpoint, {
						enabled,
						includeUnsafeMethods: options.includeUnsafeMethods,
						maxProbesPerRequest: options.maxProbesPerRequest,
						knownMethods: [...(methodsByPath.get(pathKey(item.baseline.request.url)) ?? [])],
						skipHostWide: hostsDone.has(host),
					});
					hostsDone.add(host);
					for (const probe of plan) {
						if (token.isCancellationRequested || blocked) {
							break;
						}
						publish({ current: `${httpRequestLabel(item.target.request)}: ${probe.label}` });
						const answers: IHttpSecurityExchange[] = [];
						for (const request of probe.requests) {
							blocked = this.probeRefusal(uri, request);
							if (blocked || token.isCancellationRequested) {
								break;
							}
							if (!probe.burst || !answers.length) {
								await this.pace(options.requestsPerSecond, token);
							}
							if (token.isCancellationRequested) {
								break;
							}
							answers.push(await this.sendProbe(request, options.timeoutMs, token));
							probes++;
						}
						if (answers.length === probe.requests.length && !token.isCancellationRequested) {
							const finding = probe.evaluate(answers);
							if (finding) {
								add([finding], { ...item, probe });
							}
						}
						publish({ probes });
					}
				}
				done++;
				publish({ done, probes });
			}
			if (blocked) {
				notes.push(`Active checks stopped: ${blocked}.`);
			}
		}

		const stopped = token.isCancellationRequested;
		const endedAt = this.now();
		const { current: _current, ...rest } = run.state;
		run.state = rest;
		publish({ running: false, stage: 'done', active, probes, endedAt, ...(stopped ? { stopped } : {}) });
		const record: IHttpSecurityScanRecord = {
			at: new Date(run.state.startedAt).toISOString(),
			durationMs: Math.max(0, endedAt - run.state.startedAt),
			requests: baselines.length,
			probes,
			active,
			...(stopped ? { stopped } : {}),
			...(notes.length ? { notes: [...notes] } : {}),
			findings: run.state.findings.map(finding => trimHttpSecurityFinding(finding)),
		};
		if (this.entries.get(uri)) {
			await this.update(uri, file => file.lastScan = record).catch(() => undefined);
		}
		return run.state;
	}

	async locate(uri: URI, finding: IHttpSecurityFinding, root?: URI): Promise<{ readonly collection: URI; readonly id: string; readonly exchange?: IHttpExchange } | undefined> {
		const source = this.runs.get(uri)?.sources.get(finding.fingerprint);
		if (source) {
			return { collection: source.target.collection, id: source.target.request.id, ...(source.raw ? { exchange: source.raw } : {}) };
		}
		const collection = this.collectionUri(this.rootOf(uri, root), finding.endpoint.collection);
		const loaded = collection ? await this.collections.load(collection) : undefined;
		const item = loaded && !loaded.error && finding.endpoint.path.length ? findHttpItemByPath(loaded.collection, finding.endpoint.path) : undefined;
		return collection && item?.kind === 'request' ? { collection, id: item.id } : undefined;
	}

	async resend(uri: URI, fingerprint: string, root?: URI): Promise<IHttpSecurityResend> {
		const entry = await this.require(uri);
		const run = this.runs.get(uri);
		if (run?.state.running) {
			return { reproduced: false, message: 'A scan is running. Resend when it is done.' };
		}
		const source = run?.sources.get(fingerprint);
		if (!source) {
			return { reproduced: false, message: 'This finding is from an earlier session. Run the scan again to send its request once more.' };
		}
		const options = normalizeHttpSecurityOptions(entry.file.options);
		const token = CancellationToken.None;
		let found: IHttpSecurityFinding | undefined;
		if (source.probe) {
			const answers: IHttpSecurityExchange[] = [];
			for (const request of source.probe.requests) {
				const refused = this.probeRefusal(uri, request);
				if (refused) {
					return { reproduced: false, message: `Not sent: ${refused}.` };
				}
				if (!source.probe.burst || !answers.length) {
					await this.pace(options.requestsPerSecond, token);
				}
				answers.push(await this.sendProbe(request, options.timeoutMs, token));
			}
			found = source.probe.evaluate(answers);
		} else {
			const { raw, sent, note } = await this.baselineOf(source.target, this.rootOf(uri, root), options.includeUnsafeMethods, options.requestsPerSecond, options.timeoutMs, token);
			if (!sent || !raw?.response) {
				return { reproduced: false, message: note ?? 'The request got no response.' };
			}
			found = analyzeHttpSecurityExchange(this.exchangeOf(raw), source.endpoint, { now: this.now() }).find(finding => finding.fingerprint === fingerprint);
		}
		const reproduced = found?.fingerprint === fingerprint;
		return { reproduced, message: reproduced ? 'Sent again: the finding shows again.' : 'Sent again: the finding did not show this time.', ...(reproduced && found ? { finding: found } : {}) };
	}
}

/** The open findings of a scan as "2 high, 1 medium", worst first; for a list row and an agent's answer. */
export function httpSecurityCountsText(findings: readonly IHttpSecurityFinding[], triage: Readonly<Record<string, HttpSecurityTriage>>): string {
	const open = findings.filter(finding => isHttpSecurityFindingOpen(finding, triage));
	const parts = HTTP_SECURITY_SEVERITIES.map(severity => ({ severity, count: open.filter(finding => finding.severity === severity).length })).filter(item => item.count).map(item => `${item.count} ${item.severity}`);
	return parts.length ? parts.join(', ') : 'no open findings';
}

registerSingleton(IVoltHttpSecurity, VoltHttpSecurity, InstantiationType.Delayed);
