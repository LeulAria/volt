/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asText, IRequestService } from '../../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { getWorkflowNodeType } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { parseWorkflowYaml, serializeWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowSchema.js';
import { BUILT_IN_WORKFLOW_TEMPLATES, OFFICIAL_TEMPLATE_SOURCE, parseTemplateIndex, resolveTemplateFileUrl, resolveTemplateSource } from '../../../../services/voltRuntime/common/workflows/workflowTemplates.js';
import { IWorkflowDefinition, IWorkflowIssue, IWorkflowService, IWorkflowSource, IWorkflowTemplateEntry, IWorkflowTemplateSource, WorkflowPermission } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';

/**
 * Workflow templates from three places: the ones bundled with Volt, Volt's official templates
 * repository, and repositories or single YAML files the user added. Templates are just YAML: each
 * is fetched, parsed and validated here, and broken ones are listed with their issues instead of
 * being hidden. Nothing here runs a template: installing saves a copy, and a community copy stays
 * untrusted until the user reviews it in the builder.
 */

export const BUILT_IN_TEMPLATE_SOURCE_ID = 'built-in';

const BUILT_IN_SOURCE: IWorkflowTemplateSource = { id: BUILT_IN_TEMPLATE_SOURCE_ID, label: 'Built-in', url: '', official: true };

export type WorkflowTemplateSourceKind = 'builtIn' | 'official' | 'community';

export interface IWorkflowTemplate {
	/** `<sourceId>/<id>`: unique across sources. */
	readonly key: string;
	readonly id: string;
	readonly sourceId: string;
	readonly sourceLabel: string;
	readonly sourceKind: WorkflowTemplateSourceKind;
	readonly name: string;
	readonly description: string;
	readonly author?: string;
	readonly tags: readonly string[];
	readonly icon?: string;
	readonly nodeTypes: readonly string[];
	/** What its nodes need to run for real, read from the parsed nodes (not only what the index claims). */
	readonly permissions: readonly WorkflowPermission[];
	/** The raw YAML URL; none for built-ins. */
	readonly url?: string;
	/** A page showing the file (GitHub's blob view). */
	readonly htmlUrl?: string;
	readonly yaml?: string;
	/** Content hash of `yaml`: installs record it and updates compare against it. */
	readonly sha?: string;
	readonly definition?: IWorkflowDefinition;
	readonly issues: readonly IWorkflowIssue[];
	/** Parsed without errors: it can be installed. */
	readonly valid: boolean;
	/** Built-in or official. Community templates stay untrusted until reviewed. */
	readonly trusted: boolean;
}

export interface IWorkflowTemplateSourceInfo {
	readonly source: IWorkflowTemplateSource;
	readonly kind: WorkflowTemplateSourceKind;
	readonly loading: boolean;
	/** The last fetch failed (older results, if any, are still listed). */
	readonly error?: string;
	readonly fetchedAt?: number;
	readonly count: number;
	readonly invalid: number;
}

export interface IWorkflowPublishInfo {
	/** GitHub's "new file" page in the official repository: it offers to fork and open a pull request. */
	readonly url: string;
	/** The YAML is in the URL. Long files do not fit; the page opens empty and the user pastes `yaml`. */
	readonly prefilled: boolean;
	readonly yaml: string;
	readonly fileName: string;
	/** The entry to add to the repository's index.json. */
	readonly indexEntry: string;
}

export interface IWorkflowTemplateCheck {
	readonly definition?: IWorkflowDefinition;
	readonly issues: readonly IWorkflowIssue[];
	readonly valid: boolean;
}

export const IWorkflowTemplateService = createDecorator<IWorkflowTemplateService>('voltWorkflowTemplateService');

export interface IWorkflowTemplateService {
	readonly _serviceBrand: undefined;
	/** Sources, fetch state or templates changed. */
	readonly onDidChange: Event<void>;
	sources(): readonly IWorkflowTemplateSourceInfo[];
	/** Every template (or one source's), built-ins first, invalid ones included. */
	list(sourceId?: string): readonly IWorkflowTemplate[];
	get(key: string): IWorkflowTemplate | undefined;
	/** Fetches sources not fetched for a while (the gallery calls it when it opens). */
	ensureFresh(): Promise<void>;
	refresh(sourceId?: string): Promise<void>;
	/** Fetches the URL first and keeps it only when it lists templates. Throws a readable message. */
	addSource(url: string): Promise<IWorkflowTemplateSourceInfo>;
	removeSource(id: string): void;
	/** Saves a copy (never runs it) with where it came from; community copies stay untrusted. */
	install(template: IWorkflowTemplate): Promise<IWorkflowDefinition>;
	/** A newer version of the template the workflow was made from, when its source has one. */
	updatesFor(definition: IWorkflowDefinition): IWorkflowTemplate | undefined;
	publishUrl(definition: IWorkflowDefinition): IWorkflowPublishInfo;
	/** The checks a template gets, on any YAML text. */
	validate(yaml: string): IWorkflowTemplateCheck;
}

//#region Pure helpers

/** Templates bigger than this are not fetched (a workflow file is a few KB). */
const MAX_YAML_CHARS = 256 * 1024;
/** Per source: a repository listing more is cut here. */
const MAX_TEMPLATES_PER_SOURCE = 100;
const FETCH_CONCURRENCY = 4;
/** Sources older than this are fetched again when the gallery opens. */
const STALE_MS = 6 * 60 * 60 * 1000;
/** GitHub rejects longer "new file" URLs; past this the page opens empty. */
const MAX_PREFILL_URL = 7800;
/** Cached YAML kept in storage per file and in total; past that the source is fetched again on start. */
const MAX_CACHED_FILE_CHARS = 64 * 1024;
const MAX_CACHED_TOTAL_CHARS = 2 * 1024 * 1024;

const SOURCES_KEY = 'voltWorkflows.templateSources';
const CACHE_KEY = 'voltWorkflows.templateCache';

export function contentHash(text: string): string {
	const sha = new StringSHA1();
	sha.update(text.replace(/\r\n/g, '\n'));
	return sha.digest();
}

export interface IGithubLocation {
	readonly owner: string;
	readonly repo: string;
	/** Undefined: the default branch. */
	readonly ref?: string;
	/** A folder (or a file, for blob/raw file URLs) inside the repository, no leading slash. */
	readonly path: string;
}

/** `github.com/<owner>/<repo>[/tree|blob/<ref>/<path>]` and `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. */
export function githubLocation(url: string): IGithubLocation | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const parts = parsed.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
	if (parsed.hostname === 'raw.githubusercontent.com' && parts.length >= 3) {
		const [owner, repo, ref, ...rest] = parts;
		return { owner, repo, ref: ref === 'HEAD' ? undefined : ref, path: rest.join('/') };
	}
	if ((parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') && parts.length >= 2) {
		const [owner, rawRepo, kind, ref, ...rest] = parts;
		const repo = rawRepo.replace(/\.git$/, '');
		if ((kind === 'tree' || kind === 'blob') && ref) {
			return { owner, repo, ref, path: rest.join('/') };
		}
		return { owner, repo, path: '' };
	}
	return undefined;
}

/** The GitHub page of a raw file URL (for Open source); undefined for other hosts. */
function githubBlobUrl(rawUrl: string): string | undefined {
	const location = githubLocation(rawUrl);
	if (!location || !location.path) {
		return undefined;
	}
	return `https://github.com/${location.owner}/${location.repo}/blob/${encodeURIComponent(location.ref ?? 'HEAD')}/${location.path.split('/').map(encodeURIComponent).join('/')}`;
}

function fileStem(url: string): string {
	const last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? 'template';
	return decodeURIComponent(last).replace(/\.(ya?ml)$/i, '');
}

/** What a source is called in the sources bar: `owner/repo`, or the host and file. */
export function templateSourceLabel(url: string): string {
	const location = githubLocation(url);
	if (location) {
		const dir = location.path.replace(/\/?index\.json$/i, '');
		return dir ? `${location.owner}/${location.repo}/${dir.split('/').pop()}` : `${location.owner}/${location.repo}`;
	}
	try {
		const parsed = new URL(url);
		return `${parsed.hostname}${parsed.pathname.length > 1 ? `/${fileStem(parsed.pathname)}` : ''}`;
	} catch {
		return url;
	}
}

function normalizeSourceUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

/** Permissions a definition's nodes need, in the type registry's order. */
export function workflowPermissions(definition: IWorkflowDefinition): WorkflowPermission[] {
	const seen = new Set<WorkflowPermission>();
	for (const node of definition.nodes) {
		if (node.disabled) {
			continue;
		}
		for (const permission of getWorkflowNodeType(node.type)?.permissions ?? []) {
			seen.add(permission);
		}
	}
	const order: readonly WorkflowPermission[] = ['agent', 'shell', 'network', 'git', 'filesystem', 'messaging'];
	return order.filter(permission => seen.has(permission));
}

function nodeTypesOf(definition: IWorkflowDefinition): string[] {
	return [...new Set(definition.nodes.map(node => node.type).filter(type => type !== 'start' && type !== 'end'))];
}

/** The template checks: size, the workflow parser's shape and graph checks. */
export function checkTemplateYaml(yaml: string): IWorkflowTemplateCheck {
	if (yaml.length > MAX_YAML_CHARS) {
		return { issues: [{ severity: 'error', code: 'too-large', message: localize('voltWorkflows.templateTooLarge', "The file is larger than {0} KB.", Math.round(MAX_YAML_CHARS / 1024)) }], valid: false };
	}
	if (!yaml.trim()) {
		return { issues: [{ severity: 'error', code: 'empty', message: localize('voltWorkflows.templateEmpty', "The file is empty.") }], valid: false };
	}
	let parsed: { readonly definition?: IWorkflowDefinition; readonly issues: readonly IWorkflowIssue[] };
	try {
		parsed = parseWorkflowYaml(yaml);
	} catch (error) {
		parsed = { issues: [{ severity: 'error', code: 'parse-failed', message: error instanceof Error ? error.message : String(error) }] };
	}
	const issues = [...parsed.issues];
	if (!parsed.definition && !issues.some(issue => issue.severity === 'error')) {
		issues.push({ severity: 'error', code: 'not-a-workflow', message: localize('voltWorkflows.templateNotWorkflow', "The file is not a workflow.") });
	}
	return { definition: parsed.definition, issues, valid: !!parsed.definition && !issues.some(issue => issue.severity === 'error') };
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}

/**
 * The YAML with `source:` set. The author's text (and its comments) is kept when the source block
 * can be appended and reads back the same; otherwise the definition is serialized with it.
 */
export function withWorkflowSource(workflows: Pick<IWorkflowService, 'parse' | 'serialize'>, yaml: string, source: IWorkflowSource): string {
	const parsed = workflows.parse(yaml);
	if (!parsed.definition) {
		return yaml;
	}
	if (!/^source\s*:/m.test(yaml)) {
		const lines = [
			'source:',
			`  kind: ${source.kind}`,
			...(source.url ? [`  url: ${quoteYaml(source.url)}`] : []),
			...(source.sha ? [`  sha: ${quoteYaml(source.sha)}`] : []),
			...(source.templateId ? [`  templateId: ${quoteYaml(source.templateId)}`] : []),
		];
		const appended = `${yaml.replace(/\s*$/, '')}\n\n${lines.join('\n')}\n`;
		const back = workflows.parse(appended).definition?.source;
		if (back && back.kind === source.kind && back.url === source.url && back.sha === source.sha && back.templateId === source.templateId) {
			return appended;
		}
	}
	return workflows.serialize({ ...parsed.definition, source });
}

//#endregion

//#region Cache records

interface ICachedFile {
	readonly entry: IWorkflowTemplateEntry;
	/** Raw YAML URL; none for built-ins. */
	readonly url?: string;
	readonly htmlUrl?: string;
	readonly yaml?: string;
	readonly error?: string;
}

interface ISourceCache {
	readonly fetchedAt: number;
	readonly files: readonly ICachedFile[];
}

interface ISourceState {
	readonly source: IWorkflowTemplateSource;
	readonly kind: WorkflowTemplateSourceKind;
	cache?: ISourceCache;
	error?: string;
	loading?: Promise<void>;
	templates?: readonly IWorkflowTemplate[];
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function isEntry(value: unknown): value is IWorkflowTemplateEntry {
	const entry = value as IWorkflowTemplateEntry | undefined;
	return !!entry && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.path === 'string';
}

function isCache(value: unknown): value is ISourceCache {
	const cache = value as ISourceCache | undefined;
	return !!cache && typeof cache.fetchedAt === 'number' && Array.isArray(cache.files) && cache.files.every(file => isEntry(file?.entry));
}

//#endregion

class WorkflowTemplateService extends Disposable implements IWorkflowTemplateService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly states = new Map<string, ISourceState>();
	private readonly cts = this._register(new CancellationTokenSource());
	/** Our own storage writes come back as change events; skip those. */
	private writing = false;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.states.set(BUILT_IN_TEMPLATE_SOURCE_ID, {
			source: BUILT_IN_SOURCE,
			kind: 'builtIn',
			cache: { fetchedAt: 0, files: BUILT_IN_WORKFLOW_TEMPLATES.map(template => ({ entry: template, yaml: template.yaml })) },
		});
		this.states.set(OFFICIAL_TEMPLATE_SOURCE.id, { source: OFFICIAL_TEMPLATE_SOURCE, kind: 'official' });
		this.loadSources();
		this.loadCache();
		// Another window added a source or fetched one: follow it.
		const storageStore = this._register(new DisposableStore());
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, SOURCES_KEY, storageStore)(() => {
			if (!this.writing) {
				this.loadSources();
				this._onDidChange.fire();
			}
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, CACHE_KEY, storageStore)(() => {
			if (!this.writing) {
				this.loadCache();
				this._onDidChange.fire();
			}
		}));
	}

	//#region Reading

	sources(): readonly IWorkflowTemplateSourceInfo[] {
		return [...this.states.values()].map(state => {
			const templates = this.templatesOf(state);
			return {
				source: state.source,
				kind: state.kind,
				loading: !!state.loading,
				error: state.error,
				fetchedAt: state.kind === 'builtIn' ? undefined : state.cache?.fetchedAt,
				count: templates.length,
				invalid: templates.filter(template => !template.valid).length,
			};
		});
	}

	list(sourceId?: string): readonly IWorkflowTemplate[] {
		if (sourceId) {
			const state = this.states.get(sourceId);
			return state ? this.templatesOf(state) : [];
		}
		return [...this.states.values()].flatMap(state => this.templatesOf(state));
	}

	get(key: string): IWorkflowTemplate | undefined {
		const sourceId = key.slice(0, key.indexOf('/'));
		return this.list(sourceId).find(template => template.key === key);
	}

	validate(yaml: string): IWorkflowTemplateCheck {
		return checkTemplateYaml(yaml);
	}

	private templatesOf(state: ISourceState): readonly IWorkflowTemplate[] {
		if (!state.templates) {
			state.templates = (state.cache?.files ?? [])
				.map(file => this.toTemplate(state, file))
				.sort((a, b) => Number(b.valid) - Number(a.valid) || a.name.localeCompare(b.name));
		}
		return state.templates;
	}

	private toTemplate(state: ISourceState, file: ICachedFile): IWorkflowTemplate {
		const issues: IWorkflowIssue[] = [];
		let definition: IWorkflowDefinition | undefined;
		if (file.error) {
			issues.push({ severity: 'error', code: 'fetch-failed', message: file.error });
		} else if (file.yaml !== undefined) {
			const check = checkTemplateYaml(file.yaml);
			definition = check.definition;
			issues.push(...check.issues);
		} else {
			issues.push({ severity: 'error', code: 'not-fetched', message: localize('voltWorkflows.templateNotFetched', "Not downloaded yet. Refresh the source.") });
		}
		const entry = file.entry;
		const permissions = definition ? workflowPermissions(definition) : [...(entry.permissions ?? [])];
		if (definition) {
			if (entry.id && definition.id !== entry.id) {
				issues.push({ severity: 'warning', code: 'id-mismatch', message: localize('voltWorkflows.templateIdMismatch', "The index calls it \"{0}\" but the file's id is \"{1}\".", entry.id, definition.id) });
			}
			// Review shows what the nodes really do; a short declared list is called out, never trusted.
			const undeclared = entry.permissions ? permissions.filter(permission => !entry.permissions!.includes(permission)) : [];
			if (undeclared.length) {
				issues.push({ severity: 'warning', code: 'undeclared-permissions', message: localize('voltWorkflows.templateUndeclared', "Uses permissions its index entry does not list: {0}.", undeclared.join(', ')) });
			}
		}
		const id = entry.id || definition?.id || fileStem(file.url ?? 'template');
		return {
			key: `${state.source.id}/${id}`,
			id,
			sourceId: state.source.id,
			sourceLabel: state.source.label,
			sourceKind: state.kind,
			name: entry.name || definition?.name || id,
			description: entry.description || definition?.description || '',
			author: entry.author,
			tags: entry.tags ?? definition?.tags ?? [],
			icon: entry.icon,
			nodeTypes: definition ? nodeTypesOf(definition) : [...(entry.nodeTypes ?? [])],
			permissions,
			url: file.url,
			htmlUrl: file.htmlUrl ?? (file.url ? githubBlobUrl(file.url) : undefined),
			yaml: file.yaml,
			sha: file.yaml !== undefined ? contentHash(file.yaml) : undefined,
			definition,
			issues,
			valid: !!definition && !issues.some(issue => issue.severity === 'error'),
			trusted: state.kind !== 'community',
		};
	}

	//#endregion

	//#region Fetching

	async ensureFresh(): Promise<void> {
		const now = Date.now();
		await Promise.all([...this.states.values()]
			.filter(state => state.kind !== 'builtIn' && !state.loading && (!state.cache || now - state.cache.fetchedAt > STALE_MS || state.cache.files.some(file => file.yaml === undefined && !file.error)))
			.map(state => this.refresh(state.source.id)));
	}

	async refresh(sourceId?: string): Promise<void> {
		const targets = sourceId ? [this.states.get(sourceId)].filter((state): state is ISourceState => !!state) : [...this.states.values()];
		await Promise.all(targets.filter(state => state.kind !== 'builtIn').map(state => this.refreshState(state)));
	}

	private refreshState(state: ISourceState): Promise<void> {
		if (state.loading) {
			return state.loading;
		}
		state.loading = (async () => {
			try {
				const cache = await this.fetchSource(state.source, this.cts.token);
				if (this.states.get(state.source.id) !== state) {
					return; // Removed while fetching.
				}
				state.cache = cache;
				state.error = undefined;
				state.templates = undefined;
				this.saveCache();
			} catch (error) {
				// Keep what was fetched before; the sources bar says the refresh failed.
				state.error = error instanceof Error ? error.message : String(error);
				this.logService.warn(`[voltWorkflows] template source ${state.source.url}: ${state.error}`);
			} finally {
				state.loading = undefined;
				this._onDidChange.fire();
			}
		})();
		this._onDidChange.fire();
		return state.loading;
	}

	private async fetchSource(source: IWorkflowTemplateSource, token: CancellationToken): Promise<ISourceCache> {
		const resolved = resolveTemplateSource(source.url);
		if (resolved.error) {
			throw new Error(resolved.error);
		}
		if (resolved.singleYamlUrl) {
			const url = resolved.singleYamlUrl;
			const file = await this.fetchFile({ id: '', name: '', description: '', path: url.split('/').pop() ?? url }, url, undefined, token);
			return { fetchedAt: Date.now(), files: [file] };
		}
		if (!resolved.indexUrl) {
			throw new Error(localize('voltWorkflows.sourceUnknown', "{0} is not a templates repository, an index.json or a .yaml file.", source.url));
		}
		let indexText: string | undefined;
		try {
			indexText = await this.fetchText(resolved.indexUrl, token);
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 404)) {
				throw error;
			}
		}
		let entries: { readonly entry: IWorkflowTemplateEntry; readonly url: string; readonly htmlUrl?: string }[];
		if (indexText !== undefined) {
			let raw: unknown;
			try {
				raw = JSON.parse(indexText);
			} catch {
				throw new Error(localize('voltWorkflows.indexNotJson', "{0} is not valid JSON.", resolved.indexUrl));
			}
			const { index, errors } = parseTemplateIndex(raw);
			if (!index) {
				throw new Error(localize('voltWorkflows.indexInvalid', "index.json is not a template index: {0}", errors.join('; ') || localize('voltWorkflows.unknownProblem', "unknown problem")));
			}
			const base = resolved.rawBase ?? resolved.indexUrl.replace(/[^/]*$/, '');
			// Entries resolve inside the index's folder only: a community index cannot point a file elsewhere.
			entries = index.templates.flatMap(entry => {
				const url = resolveTemplateFileUrl(base, entry.path);
				return url ? [{ entry, url }] : [];
			});
		} else {
			// No index.json: list the folder's YAML files through GitHub, so a plain repo works too.
			const location = githubLocation(source.url) ?? (resolved.rawBase ? githubLocation(resolved.rawBase) : undefined);
			if (!location) {
				throw new Error(localize('voltWorkflows.noIndex', "There is no index.json at {0}.", resolved.indexUrl));
			}
			entries = await this.listGithubYaml(location, token);
			if (!entries.length) {
				throw new Error(localize('voltWorkflows.noYaml', "{0}/{1} has no index.json and no .yaml files.", location.owner, location.repo));
			}
		}
		const queue = entries.slice(0, MAX_TEMPLATES_PER_SOURCE).map((item, index) => ({ ...item, index }));
		const files: ICachedFile[] = new Array(queue.length);
		await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
			while (queue.length) {
				const item = queue.shift()!;
				files[item.index] = await this.fetchFile(item.entry, item.url, item.htmlUrl, token);
			}
		}));
		return { fetchedAt: Date.now(), files };
	}

	/** One template file; a failure becomes the template's issue, not the source's. */
	private async fetchFile(entry: IWorkflowTemplateEntry, url: string, htmlUrl: string | undefined, token: CancellationToken): Promise<ICachedFile> {
		try {
			const yaml = await this.fetchText(url, token);
			return { entry, url, htmlUrl, yaml };
		} catch (error) {
			if (token.isCancellationRequested) {
				throw error;
			}
			return { entry, url, htmlUrl, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async listGithubYaml(location: IGithubLocation, token: CancellationToken, depth = 0): Promise<{ entry: IWorkflowTemplateEntry; url: string; htmlUrl?: string }[]> {
		const path = location.path.replace(/\/?index\.json$/i, '');
		const url = `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${location.ref ? `?ref=${encodeURIComponent(location.ref)}` : ''}`;
		const text = await this.fetchText(url, token, { Accept: 'application/vnd.github+json' });
		let listing: unknown;
		try {
			listing = JSON.parse(text);
		} catch {
			throw new Error(localize('voltWorkflows.githubListing', "GitHub did not list {0}.", path || location.repo));
		}
		if (!Array.isArray(listing)) {
			// A file path: GitHub answers with the file itself.
			const file = listing as { type?: string; name?: string; download_url?: string; html_url?: string };
			return file.type === 'file' && file.download_url && /\.ya?ml$/i.test(file.name ?? '')
				? [{ entry: { id: '', name: '', description: '', path: file.name! }, url: file.download_url, htmlUrl: file.html_url }]
				: [];
		}
		const items = listing as { type?: string; name?: string; path?: string; download_url?: string | null; html_url?: string }[];
		const yaml = items
			.filter(item => item.type === 'file' && typeof item.name === 'string' && /\.ya?ml$/i.test(item.name) && item.download_url)
			.map(item => ({ entry: { id: '', name: '', description: '', path: item.path ?? item.name! }, url: item.download_url!, htmlUrl: item.html_url }));
		if (yaml.length || depth > 0) {
			return yaml;
		}
		// The official layout keeps the files one level down (`workflow-templates/templates/*.yaml`).
		const folder = items.find(item => item.type === 'dir' && (item.name === 'templates' || item.name === 'workflow-templates'));
		return folder?.path ? this.listGithubYaml({ ...location, path: folder.path }, token, depth + 1) : [];
	}

	private async fetchText(url: string, token: CancellationToken, headers?: Record<string, string>): Promise<string> {
		const context = await this.requestService.request({ type: 'GET', url, headers: { 'User-Agent': 'Volt', ...headers }, timeout: 20000 }, token);
		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			if (status === 403 && context.res.headers['x-ratelimit-remaining'] === '0') {
				throw new HttpError(status, localize('voltWorkflows.rateLimited', "GitHub's hourly limit for anonymous requests was reached. Try again later, or add an index.json to the repository."));
			}
			throw new HttpError(status, status === 404
				? localize('voltWorkflows.notFound', "Not found: {0}", url)
				: localize('voltWorkflows.httpError', "{0} answered {1}.", new URL(url).hostname, status));
		}
		const length = Number(context.res.headers['content-length']);
		if (length > MAX_YAML_CHARS * 4) {
			throw new Error(localize('voltWorkflows.tooLarge', "{0} is too large.", url));
		}
		const text = (await asText(context)) ?? '';
		if (text.length > MAX_YAML_CHARS * 4) {
			throw new Error(localize('voltWorkflows.tooLarge', "{0} is too large.", url));
		}
		return text;
	}

	//#endregion

	//#region Sources

	async addSource(url: string): Promise<IWorkflowTemplateSourceInfo> {
		const trimmed = url.trim();
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new Error(localize('voltWorkflows.sourceNotUrl', "Enter a GitHub repository, an index.json or a .yaml URL."));
		}
		if (parsed.protocol !== 'https:') {
			throw new Error(localize('voltWorkflows.sourceHttps', "Template sources must use https."));
		}
		const normalized = normalizeSourceUrl(trimmed);
		const existing = [...this.states.values()].find(state => state.kind !== 'builtIn' && normalizeSourceUrl(state.source.url) === normalized);
		if (existing) {
			throw new Error(localize('voltWorkflows.sourceExists', "{0} is already a source.", existing.source.label));
		}
		const resolved = resolveTemplateSource(trimmed);
		if (resolved.error) {
			throw new Error(resolved.error);
		}
		const source: IWorkflowTemplateSource = { id: `community-${contentHash(normalized).slice(0, 12)}`, label: templateSourceLabel(trimmed), url: trimmed };
		const cache = await this.fetchSource(source, this.cts.token);
		if (!cache.files.length) {
			throw new Error(localize('voltWorkflows.sourceEmpty', "No templates found at {0}.", trimmed));
		}
		const state: ISourceState = { source, kind: 'community', cache };
		this.states.set(source.id, state);
		this.saveSources();
		this.saveCache();
		this._onDidChange.fire();
		return this.sources().find(info => info.source.id === source.id)!;
	}

	removeSource(id: string): void {
		const state = this.states.get(id);
		if (!state || state.kind !== 'community') {
			return;
		}
		this.states.delete(id);
		this.saveSources();
		this.saveCache();
		this._onDidChange.fire();
	}

	private loadSources(): void {
		let stored: unknown;
		try {
			stored = JSON.parse(this.storageService.get(SOURCES_KEY, StorageScope.APPLICATION, '[]'));
		} catch {
			stored = [];
		}
		const sources = (Array.isArray(stored) ? stored : []).filter((value): value is IWorkflowTemplateSource => typeof value?.id === 'string' && typeof value?.url === 'string' && typeof value?.label === 'string');
		const keep = new Set(sources.map(source => source.id));
		for (const [id, state] of this.states) {
			if (state.kind === 'community' && !keep.has(id)) {
				this.states.delete(id);
			}
		}
		for (const source of sources) {
			if (!this.states.has(source.id)) {
				// Stored sources are never official, whatever the stored record says.
				this.states.set(source.id, { source: { id: source.id, label: source.label, url: source.url }, kind: 'community' });
			}
		}
	}

	private saveSources(): void {
		const sources = [...this.states.values()].filter(state => state.kind === 'community').map(state => state.source);
		this.write(() => this.storageService.store(SOURCES_KEY, JSON.stringify(sources), StorageScope.APPLICATION, StorageTarget.USER));
	}

	private loadCache(): void {
		let stored: Record<string, unknown> = {};
		try {
			const value = JSON.parse(this.storageService.get(CACHE_KEY, StorageScope.APPLICATION, '{}'));
			stored = value && typeof value === 'object' ? value : {};
		} catch {
			// Fetched again.
		}
		for (const state of this.states.values()) {
			const cache = stored[state.source.id];
			if (state.kind !== 'builtIn' && isCache(cache) && (!state.cache || cache.fetchedAt > state.cache.fetchedAt)) {
				state.cache = cache;
				state.templates = undefined;
			}
		}
	}

	private saveCache(): void {
		const out: Record<string, ISourceCache> = {};
		let budget = MAX_CACHED_TOTAL_CHARS;
		for (const state of this.states.values()) {
			if (state.kind === 'builtIn' || !state.cache) {
				continue;
			}
			// Big files are left out; ensureFresh fetches a source again when one is missing.
			out[state.source.id] = {
				fetchedAt: state.cache.fetchedAt,
				files: state.cache.files.map(file => {
					const keep = file.yaml !== undefined && file.yaml.length <= MAX_CACHED_FILE_CHARS && file.yaml.length <= budget;
					if (keep) {
						budget -= file.yaml!.length;
					}
					return keep || file.yaml === undefined ? file : { entry: file.entry, url: file.url, htmlUrl: file.htmlUrl };
				}),
			};
		}
		this.write(() => this.storageService.store(CACHE_KEY, JSON.stringify(out), StorageScope.APPLICATION, StorageTarget.MACHINE));
	}

	private write(store: () => void): void {
		this.writing = true;
		try {
			store();
		} finally {
			this.writing = false;
		}
	}

	//#endregion

	//#region Install, updates, publish

	async install(template: IWorkflowTemplate): Promise<IWorkflowDefinition> {
		if (!template.valid || template.yaml === undefined) {
			const problem = template.issues.find(issue => issue.severity === 'error')?.message;
			throw new Error(problem
				? localize('voltWorkflows.installInvalid', "\"{0}\" has problems and can't be used: {1}", template.name, problem)
				: localize('voltWorkflows.installNotReady', "\"{0}\" isn't downloaded yet.", template.name));
		}
		const source: IWorkflowSource = {
			kind: template.trusted ? 'template' : 'community',
			...(template.url ? { url: template.url } : {}),
			...(template.sha ? { sha: template.sha } : {}),
			templateId: template.id,
		};
		const result = await this.workflows.saveYaml(withWorkflowSource(this.workflows, template.yaml, source));
		if (!result.definition) {
			throw new Error(result.issues.find(issue => issue.severity === 'error')?.message ?? localize('voltWorkflows.installFailed', "\"{0}\" could not be saved.", template.name));
		}
		// Kind `template` (Volt's own, reviewed in its repository) is trusted as is; `community` waits for the user.
		return result.definition;
	}

	updatesFor(definition: IWorkflowDefinition): IWorkflowTemplate | undefined {
		const source = definition.source;
		if (!source?.templateId || !source.sha || (source.kind !== 'template' && source.kind !== 'community')) {
			return undefined;
		}
		return this.list().find(template => template.valid
			&& template.id === source.templateId
			&& (source.url ? template.url === source.url : template.sourceKind === 'builtIn')
			&& !!template.sha && template.sha !== source.sha);
	}

	publishUrl(definition: IWorkflowDefinition): IWorkflowPublishInfo {
		// A template carries the workflow, not this copy's history or where it came from.
		const { source: _source, revision: _revision, ...rest } = definition;
		const yaml = serializeWorkflow(rest);
		const fileName = `${definition.id}.yaml`;
		const official = githubLocation(OFFICIAL_TEMPLATE_SOURCE.url) ?? { owner: 'LeulAria', repo: 'volt', ref: 'main', path: 'workflow-templates' };
		const folder = [...official.path.split('/').filter(Boolean), 'templates'].map(encodeURIComponent).join('/');
		const base = `https://github.com/${official.owner}/${official.repo}/new/${encodeURIComponent(official.ref ?? 'main')}/${folder}?filename=${encodeURIComponent(fileName)}`;
		const full = `${base}&value=${encodeURIComponent(yaml)}`;
		const prefilled = full.length <= MAX_PREFILL_URL;
		const entry: IWorkflowTemplateEntry = {
			id: definition.id,
			name: definition.name,
			description: definition.description ?? '',
			path: `templates/${fileName}`,
			...(definition.tags?.length ? { tags: definition.tags } : {}),
			nodeTypes: nodeTypesOf(definition),
			permissions: workflowPermissions(definition),
		};
		return { url: prefilled ? full : base, prefilled, yaml, fileName, indexEntry: JSON.stringify(entry, null, 2) };
	}

	//#endregion
}

registerSingleton(IWorkflowTemplateService, WorkflowTemplateService, InstantiationType.Delayed);
