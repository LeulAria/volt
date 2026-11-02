/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { dirname, isEqual, joinPath } from '../../../../../base/common/resources.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { createSimulationHost, startWorkflowRun } from '../../../../services/voltRuntime/common/workflows/workflowEngine.js';
import { validateWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { getWorkflowNodeType } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { blankWorkflow, parseWorkflowYaml, serializeWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowSchema.js';
import {
	IWorkflowApprovalRequest, IWorkflowDefinition, IWorkflowEngineHost, IWorkflowExecution, IWorkflowIssue, IWorkflowRevision, IWorkflowRun, IWorkflowRunTrigger, IWorkflowSaveResult,
	IWorkflowService, IWorkflowSimulationOptions, IWorkflowStartOptions, IWorkflowSummary, WORKFLOW_ID_PATTERN, WORKFLOW_MAX_DEPTH, WorkflowApprovalDecision, WorkflowNodeError, WorkflowRecord,
	WorkflowRunEvent, WorkflowRunMode, WorkflowRunStatus, WorkflowValue,
} from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { IWorkflowRunEnvironment, WorkflowExecutors, workflowDelay } from './workflowExecutors.js';

/** Revisions kept in `.history/<id>/` besides the current one. */
const HISTORY_KEPT = 50;
/** Finished runs kept per workflow. */
const RUNS_KEPT = 50;
/** A step's input, output or resolved config longer than this (as JSON) is cut when the run is stored. */
const STORED_VALUE_CHARS = 16 * 1024;
const LOGS_KEPT = 500;
/** Another window (or a text editor) changed the folder: read it this soon after (writes come in bursts). */
const RELOAD_DELAY_MS = 300;
const TRUST_KEY = 'volt.workflows.trusted';
const TRUST_KEPT = 500;
const RUNS_FILE_VERSION = 1;
/** Sources whose workflows run for real only once their content was reviewed. */
const UNTRUSTED_SOURCES = new Set(['community', 'import', 'describe']);
/** Runs started without anyone at the screen: an untrusted workflow fails instead of asking. */
const UNATTENDED_TRIGGERS = new Set(['automation', 'schedule', 'event']);

interface IEntry {
	readonly id: string;
	/** The file's text as stored (comments kept). */
	readonly yaml: string;
	/** Undefined when the file does not parse into a workflow. */
	readonly definition?: IWorkflowDefinition;
	readonly issues: readonly IWorkflowIssue[];
	readonly updatedAt: number;
}

interface ILive {
	readonly execution: IWorkflowExecution;
	readonly workflowId: string;
	/** Saved workflows get their runs recorded; an unsaved builder draft does not. */
	readonly record: boolean;
	readonly store: DisposableStore;
}

interface IRevisionsIndex {
	readonly revisions: readonly IWorkflowRevision[];
}

/** A workflow saved or deleted, here or in another window (the automation bridge links its trigger). */
export interface IWorkflowStoreChange {
	readonly id: string;
	/** Undefined: the workflow was deleted. */
	readonly definition: IWorkflowDefinition | undefined;
	/** This window wrote it; else it was read from disk. */
	readonly local: boolean;
}

/** The service as the automation bridge sees it: also tells which workflow was saved or deleted. */
export interface IWorkflowStoreEvents {
	readonly onDidSaveWorkflow: Event<IWorkflowStoreChange>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isFinished(status: WorkflowRunStatus): boolean {
	return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * Keeps the user's workflows as YAML files (`User/voltWorkflows/<id>.yaml`, the earlier revisions
 * under `.history/<id>/`, finished runs under `.runs/<id>.json`), reloads them when another window
 * or a text editor changes the folder, and starts runs: simulations with simulated executors,
 * real runs with the executors in `workflowExecutors.ts` after the workflow checks out and, for
 * workflows from outside Volt, after the user reviewed what it may do.
 */
export class WorkflowService extends Disposable implements IWorkflowService, IWorkflowStoreEvents {

	declare readonly _serviceBrand: undefined;

	private readonly root: URI;
	private readonly historyRoot: URI;
	private readonly runsRoot: URI;
	private readonly entries = new Map<string, IEntry>();
	/** Finished runs by workflow, newest first. */
	private readonly records = new Map<string, IWorkflowRun[]>();
	/** The runs files as this window last read or wrote them. */
	private readonly runsText = new Map<string, string>();
	private readonly live = new Map<string, ILive>();
	private readonly hashes = new WeakMap<IWorkflowDefinition, string>();
	private loaded = false;
	/** Every disk read and write goes through here, one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private readonly reloadSoon = this._register(new RunOnceScheduler(() => void this.enqueue(() => this.reload()), RELOAD_DELAY_MS));
	private readonly staleRuns = new Set<string>();
	private readonly reloadRunsSoon = this._register(new RunOnceScheduler(() => void this.enqueue(() => this.reloadRuns()), RELOAD_DELAY_MS));
	/** Which automations run which workflow, as last told: a change redraws the list. */
	private links = '';
	readonly whenReady: Promise<void>;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeRun = this._register(new Emitter<WorkflowRunEvent>());
	readonly onDidChangeRun: Event<WorkflowRunEvent> = this._onDidChangeRun.event;

	private readonly _onDidSaveWorkflow = this._register(new Emitter<IWorkflowStoreChange>());
	readonly onDidSaveWorkflow: Event<IWorkflowStoreChange> = this._onDidSaveWorkflow.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAutomationService private readonly automations: IAutomationService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.root = joinPath(environmentService.userRoamingDataHome, 'voltWorkflows');
		this.historyRoot = joinPath(this.root, '.history');
		this.runsRoot = joinPath(this.root, '.runs');
		this.whenReady = this.enqueue(() => this.load());
		this._register(fileService.onDidFilesChange(e => {
			if (!this.loaded) {
				return;
			}
			for (const resource of [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]) {
				const folder = dirname(resource);
				if (isEqual(folder, this.root) && resource.path.endsWith('.yaml')) {
					this.reloadSoon.schedule();
				} else if (isEqual(folder, this.runsRoot) && resource.path.endsWith('.json')) {
					this.staleRuns.add(resource.path.slice(resource.path.lastIndexOf('/') + 1, -'.json'.length));
					this.reloadRunsSoon.schedule();
				}
			}
		}));
		this._register(automations.onDidChange(() => {
			if (this.loaded && this.linkKey() !== this.links) {
				this._onDidChange.fire();
			}
		}));
		this._register(lifecycleService.onWillShutdown(e => e.join(this.shutdown(), { id: 'voltWorkflows', label: localize('voltWorkflows.saving', "Saving workflows") })));
	}

	//#region Store

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work, work);
		this.queue = next.catch(err => this.logService.error('[volt workflows] a disk operation failed', err));
		return next;
	}

	private fileOf(id: string): URI {
		return joinPath(this.root, `${id}.yaml`);
	}

	private historyOf(id: string): URI {
		return joinPath(this.historyRoot, id);
	}

	private runsFileOf(id: string): URI {
		return joinPath(this.runsRoot, `${id}.json`);
	}

	private async writeText(file: URI, text: string): Promise<void> {
		const atomic = this.fileService.hasCapability(file, FileSystemProviderCapabilities.FileAtomicWrite) ? { atomic: { postfix: '.vsctmp' } } as const : undefined;
		await this.fileService.writeFile(file, VSBuffer.fromString(text), atomic);
	}

	private async load(): Promise<void> {
		await this.fileService.createFolder(this.runsRoot).catch(() => undefined);
		this._register(this.fileService.watch(this.root));
		this._register(this.fileService.watch(this.runsRoot));
		for (const entry of await this.readEntries()) {
			this.entries.set(entry.id, entry);
		}
		await Promise.all([...this.entries.keys()].map(id => this.readRuns(id)));
		this.loaded = true;
		this.links = this.linkKey();
		if (this.entries.size) {
			this._onDidChange.fire();
		}
	}

	private async readEntries(): Promise<IEntry[]> {
		let children;
		try {
			children = (await this.fileService.resolve(this.root, { resolveMetadata: true })).children ?? [];
		} catch {
			return [];
		}
		const files = children.filter(child => child.isFile && child.name.endsWith('.yaml') && WORKFLOW_ID_PATTERN.test(child.name.slice(0, -'.yaml'.length)));
		const entries = await Promise.all(files.map(async file => {
			const id = file.name.slice(0, -'.yaml'.length);
			const known = this.entries.get(id);
			try {
				const yaml = (await this.fileService.readFile(file.resource)).value.toString();
				return known && known.yaml === yaml ? known : parseEntry(id, yaml, file.mtime ?? Date.now());
			} catch (err) {
				this.logService.warn(`[volt workflows] could not read ${file.name}`, err);
				return undefined;
			}
		}));
		return entries.filter((entry): entry is IEntry => !!entry);
	}

	/** The folder changed on disk: take in what other windows or an editor wrote. */
	private async reload(): Promise<void> {
		const next = new Map((await this.readEntries()).map(entry => [entry.id, entry]));
		const changes: IWorkflowStoreChange[] = [];
		for (const [id, entry] of next) {
			if (this.entries.get(id) !== entry) {
				changes.push({ id, definition: entry.definition, local: false });
				if (!this.records.has(id)) {
					await this.readRuns(id);
				}
			}
		}
		for (const id of this.entries.keys()) {
			if (!next.has(id)) {
				changes.push({ id, definition: undefined, local: false });
				this.records.delete(id);
			}
		}
		if (!changes.length) {
			return;
		}
		this.entries.clear();
		for (const [id, entry] of next) {
			this.entries.set(id, entry);
		}
		for (const change of changes) {
			this._onDidSaveWorkflow.fire(change);
		}
		this._onDidChange.fire();
	}

	/**
	 * Writes a workflow. An existing id is an update (a new revision, the old text kept in history);
	 * `create` makes a new one under a free id from its own or its name. `yaml` keeps the user's
	 * text (comments and order) with its `id` and `revision` lines brought up to date.
	 */
	private async write(input: IWorkflowDefinition, options: { readonly create?: boolean; readonly message?: string; readonly yaml?: string }): Promise<IWorkflowSaveResult> {
		const existing = !options.create && input.id ? this.entries.get(input.id) : undefined;
		const id = existing?.id ?? this.freeId(input.id && WORKFLOW_ID_PATTERN.test(input.id) ? input.id : workflowSlug(input.name));
		const index = existing ? await this.readIndex(id) : undefined;
		const previous = existing ? Math.max(existing.definition?.revision ?? 0, ...(index?.revisions.map(entry => entry.revision) ?? [])) : 0;
		const revision = previous + 1;
		let definition: IWorkflowDefinition = { ...input, id, revision };
		let text = serializeWorkflow(definition);
		let issues: readonly IWorkflowIssue[] = validateWorkflow(definition);
		if (options.yaml !== undefined) {
			const patched = withTopLevel(options.yaml, { id, revision });
			const parsed = parseWorkflowYaml(patched);
			if (parsed.definition && parsed.definition.id === id && parsed.definition.revision === revision) {
				text = patched;
				definition = parsed.definition;
				issues = parsed.issues;
			}
		}
		// Saving what is already stored makes no new revision.
		if (existing?.definition && options.yaml === undefined && existing.yaml === serializeWorkflow({ ...definition, revision: existing.definition.revision })) {
			return { definition: existing.definition, issues: existing.issues };
		}
		if (existing?.definition && options.yaml !== undefined && existing.yaml === withTopLevel(options.yaml, { id, revision: existing.definition.revision ?? previous })) {
			return { definition: existing.definition, issues: existing.issues };
		}
		const kept = existing ? await this.keepRevision(id, previous, existing.yaml, index ?? { revisions: [] }) : { revisions: [] };
		await this.writeText(this.fileOf(id), text);
		await this.noteRevision(id, revision, options.message, kept);
		this.entries.set(id, { id, yaml: text, definition, issues, updatedAt: Date.now() });
		this._onDidSaveWorkflow.fire({ id, definition, local: true });
		this._onDidChange.fire();
		return { definition, issues };
	}

	private freeId(preferred: string): string {
		const base = WORKFLOW_ID_PATTERN.test(preferred) ? preferred : workflowSlug(preferred);
		if (!this.entries.has(base)) {
			return base;
		}
		for (let n = 2; ; n++) {
			const candidate = `${base.slice(0, 60)}-${n}`;
			if (!this.entries.has(candidate)) {
				return candidate;
			}
		}
	}

	//#endregion

	//#region History

	private async readIndex(id: string): Promise<IRevisionsIndex> {
		try {
			const raw: unknown = JSON.parse((await this.fileService.readFile(joinPath(this.historyOf(id), 'revisions.json'))).value.toString());
			const list = raw && typeof raw === 'object' && Array.isArray((raw as { revisions?: unknown }).revisions) ? (raw as { revisions: unknown[] }).revisions : [];
			return {
				revisions: list.flatMap(entry => {
					const value = entry as Partial<IWorkflowRevision> | undefined;
					return value && typeof value.revision === 'number' && typeof value.at === 'number'
						? [{ revision: value.revision, at: value.at, ...(typeof value.message === 'string' && value.message ? { message: value.message } : {}) }]
						: [];
				}),
			};
		} catch {
			return { revisions: [] };
		}
	}

	/** The text being replaced goes to history (only the latest `HISTORY_KEPT` stay); returns the index with it. */
	private async keepRevision(id: string, revision: number, yaml: string, index: IRevisionsIndex): Promise<IRevisionsIndex> {
		const folder = this.historyOf(id);
		try {
			await this.writeText(joinPath(folder, `${revision}.yaml`), yaml);
			const stat = await this.fileService.resolve(folder);
			const kept = (stat.children ?? [])
				.map(child => ({ child, revision: /^(\d+)\.yaml$/.exec(child.name)?.[1] }))
				.filter((entry): entry is { child: typeof entry.child; revision: string } => entry.revision !== undefined)
				.sort((a, b) => Number(b.revision) - Number(a.revision));
			await Promise.all(kept.slice(HISTORY_KEPT).map(entry => this.fileService.del(entry.child.resource).catch(() => undefined)));
		} catch (err) {
			this.logService.warn(`[volt workflows] could not keep revision ${revision} of ${id}`, err);
		}
		// A revision saved before the index existed is listed from now on, at the time it was replaced.
		return index.revisions.some(entry => entry.revision === revision) ? index : { revisions: [...index.revisions, { revision, at: Date.now() }] };
	}

	private async noteRevision(id: string, revision: number, message: string | undefined, current: IRevisionsIndex): Promise<void> {
		const revisions = [...current.revisions.filter(entry => entry.revision !== revision), { revision, at: Date.now(), ...(message?.trim() ? { message: message.trim() } : {}) }]
			.sort((a, b) => b.revision - a.revision)
			.slice(0, HISTORY_KEPT + 1);
		await this.writeIndex(id, { revisions });
	}

	private async writeIndex(id: string, index: IRevisionsIndex): Promise<void> {
		await this.writeText(joinPath(this.historyOf(id), 'revisions.json'), JSON.stringify(index, null, '\t')).catch(err => this.logService.warn(`[volt workflows] could not write the revisions of ${id}`, err));
	}

	//#endregion

	//#region API

	list(): readonly IWorkflowSummary[] {
		this.links = this.linkKey();
		return [...this.entries.values()].map(entry => this.summarize(entry)).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private summarize(entry: IEntry): IWorkflowSummary {
		const definition = entry.definition;
		const last = this.runs(entry.id)[0];
		return {
			id: entry.id,
			name: definition?.name ?? entry.id,
			...(definition?.description ? { description: definition.description } : {}),
			revision: definition?.revision ?? 0,
			updatedAt: entry.updatedAt,
			trigger: definition?.trigger ?? { type: 'manual' },
			nodeCount: definition?.nodes.length ?? 0,
			...(definition?.source ? { source: definition.source } : {}),
			automationIds: this.automations.list().filter(automation => automation.workflowId === entry.id).map(automation => automation.id),
			...(last ? { lastRun: { id: last.id, status: last.status, at: last.startedAt, mode: last.mode } } : {}),
			trusted: definition ? this.isTrusted(definition) : true,
			issues: entry.issues.filter(issue => issue.severity !== 'info').length,
		};
	}

	private linkKey(): string {
		return this.automations.list().flatMap(automation => automation.workflowId ? [`${automation.id}:${automation.workflowId}`] : []).join(',');
	}

	get(id: string): IWorkflowDefinition | undefined {
		return this.entries.get(id)?.definition;
	}

	getYaml(id: string): string | undefined {
		return this.entries.get(id)?.yaml;
	}

	async create(seed?: Partial<IWorkflowDefinition>): Promise<IWorkflowDefinition> {
		await this.whenReady;
		const name = seed?.name?.trim() || localize('voltWorkflows.untitled', "Untitled workflow");
		const definition: IWorkflowDefinition = { ...blankWorkflow('workflow', name), ...seed, name, id: seed?.id ?? '', revision: undefined };
		const result = await this.enqueue(() => this.write(definition, { create: true }));
		return result.definition!;
	}

	async save(definition: IWorkflowDefinition, message?: string): Promise<IWorkflowSaveResult> {
		await this.whenReady;
		return this.enqueue(() => this.write(definition, { message, create: !definition.id || !this.entries.has(definition.id) }));
	}

	async saveYaml(yaml: string, id?: string): Promise<IWorkflowSaveResult> {
		await this.whenReady;
		const parsed = parseWorkflowYaml(yaml);
		if (!parsed.definition) {
			return { issues: parsed.issues };
		}
		const update = !!id && this.entries.has(id);
		const definition = id ? { ...parsed.definition, id } : parsed.definition;
		return this.enqueue(() => this.write(definition, { yaml, create: !update }));
	}

	parse(yaml: string): IWorkflowSaveResult {
		const parsed = parseWorkflowYaml(yaml);
		return { ...(parsed.definition ? { definition: parsed.definition } : {}), issues: parsed.issues };
	}

	serialize(definition: IWorkflowDefinition): string {
		return serializeWorkflow(definition);
	}

	async duplicate(id: string): Promise<IWorkflowDefinition | undefined> {
		await this.whenReady;
		const source = this.get(id);
		if (!source) {
			return undefined;
		}
		// A new id from the copy's name; the content (and so its trust) stays the same.
		const copy: IWorkflowDefinition = { ...source, id: '', revision: undefined, name: localize('voltWorkflows.copyName', "{0} (copy)", source.name) };
		return (await this.enqueue(() => this.write(copy, { create: true }))).definition;
	}

	async delete(id: string): Promise<void> {
		await this.whenReady;
		await this.enqueue(async () => {
			if (!this.entries.has(id)) {
				return;
			}
			await this.fileService.del(this.fileOf(id)).catch(err => {
				if (!(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
					throw err;
				}
			});
			await Promise.all([
				this.fileService.del(this.historyOf(id), { recursive: true }).catch(() => undefined),
				this.fileService.del(this.runsFileOf(id)).catch(() => undefined),
			]);
			this.entries.delete(id);
			this.records.delete(id);
			this.runsText.delete(id);
			this._onDidSaveWorkflow.fire({ id, definition: undefined, local: true });
			this._onDidChange.fire();
		});
	}

	async revisions(id: string): Promise<readonly IWorkflowRevision[]> {
		await this.whenReady;
		const entry = this.entries.get(id);
		if (!entry) {
			return [];
		}
		const index = await this.readIndex(id);
		const current = entry.definition?.revision;
		const byRevision = new Map(index.revisions.map(revision => [revision.revision, revision]));
		if (current !== undefined && !byRevision.has(current)) {
			byRevision.set(current, { revision: current, at: entry.updatedAt });
		}
		// History files the index does not know (written by an older build, or the index was lost).
		try {
			for (const child of (await this.fileService.resolve(this.historyOf(id), { resolveMetadata: true })).children ?? []) {
				const match = /^(\d+)\.yaml$/.exec(child.name);
				if (match && !byRevision.has(Number(match[1]))) {
					byRevision.set(Number(match[1]), { revision: Number(match[1]), at: child.mtime ?? 0 });
				}
			}
		} catch {
			// No history yet.
		}
		return [...byRevision.values()].sort((a, b) => b.revision - a.revision);
	}

	async readRevision(id: string, revision: number): Promise<string | undefined> {
		await this.whenReady;
		const entry = this.entries.get(id);
		if (!entry) {
			return undefined;
		}
		if (entry.definition?.revision === revision) {
			return entry.yaml;
		}
		try {
			return (await this.fileService.readFile(joinPath(this.historyOf(id), `${revision}.yaml`))).value.toString();
		} catch {
			return undefined;
		}
	}

	//#endregion

	//#region Trust

	private contentHash(definition: IWorkflowDefinition): string {
		let hash = this.hashes.get(definition);
		if (!hash) {
			// What it does, not how it looks or what it is called.
			const normalized: IWorkflowDefinition = {
				...definition,
				id: 'workflow',
				name: 'workflow',
				description: undefined,
				revision: undefined,
				tags: undefined,
				groups: undefined,
				source: undefined,
				nodes: definition.nodes.map(node => ({ ...node, position: { x: 0, y: 0 }, color: undefined, name: undefined, notes: undefined })),
			};
			let text: string;
			try {
				text = serializeWorkflow(normalized);
			} catch {
				text = JSON.stringify(normalized);
			}
			const sha = new StringSHA1();
			sha.update(text);
			hash = sha.digest();
			this.hashes.set(definition, hash);
		}
		return hash;
	}

	private trustedHashes(): string[] {
		try {
			const raw: unknown = JSON.parse(this.storageService.get(TRUST_KEY, StorageScope.PROFILE, '[]'));
			return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
		} catch {
			return [];
		}
	}

	isTrusted(definition: IWorkflowDefinition): boolean {
		return !UNTRUSTED_SOURCES.has(definition.source?.kind ?? 'blank') || this.trustedHashes().includes(this.contentHash(definition));
	}

	async trust(definition: IWorkflowDefinition): Promise<void> {
		const hash = this.contentHash(definition);
		const hashes = this.trustedHashes().filter(entry => entry !== hash);
		this.storageService.store(TRUST_KEY, JSON.stringify([...hashes, hash].slice(-TRUST_KEPT)), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChange.fire();
	}

	private async confirmTrust(definition: IWorkflowDefinition): Promise<boolean> {
		const from = definition.source?.url ?? (definition.source?.kind === 'describe'
			? localize('voltWorkflows.fromAgent', "an agent's draft")
			: definition.source?.kind === 'import' ? localize('voltWorkflows.fromImport', "an import") : localize('voltWorkflows.fromCommunity', "a community template"));
		const lines = describeWorkflowPermissions(definition);
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltWorkflows.trustTitle', "Run \"{0}\" for real?", definition.name),
			detail: [
				localize('voltWorkflows.trustFrom', "This workflow came from {0} and has not been reviewed yet. Running it will:", from),
				'',
				...lines.map(line => `• ${line}`),
				'',
				localize('voltWorkflows.trustNote', "Only run workflows you trust. Changing what it does asks again."),
			].join('\n'),
			primaryButton: localize({ key: 'voltWorkflows.trustRun', comment: ['&& denotes a mnemonic'] }, "&&Trust and Run"),
		});
		return confirmed;
	}

	//#endregion

	//#region Runs

	async start(workflow: string | IWorkflowDefinition, options: IWorkflowStartOptions): Promise<IWorkflowExecution> {
		await this.whenReady;
		const definition = typeof workflow === 'string' ? this.get(workflow) : workflow;
		if (!definition) {
			throw new Error(localize('voltWorkflows.missing', "There is no workflow {0}.", String(workflow)));
		}
		const depth = options.depth ?? 0;
		if (depth > WORKFLOW_MAX_DEPTH) {
			throw new WorkflowNodeError(localize('voltWorkflows.tooDeep', "Sub-workflows nest more than {0} deep.", WORKFLOW_MAX_DEPTH));
		}
		if (options.mode === 'execute') {
			const error = validateWorkflow(definition).find(issue => issue.severity === 'error');
			if (error) {
				throw new Error(localize('voltWorkflows.invalid', "\"{0}\" cannot run: {1}", definition.name, error.message));
			}
			if (!this.isTrusted(definition)) {
				if (this.unattended(options.trigger)) {
					throw new Error(localize('voltWorkflows.untrustedUnattended', "\"{0}\" came from outside Volt and is not trusted yet: open it and run it once to review what it does.", definition.name));
				}
				if (!await this.confirmTrust(definition)) {
					throw new CancellationError();
				}
				await this.trust(definition);
			}
		}
		const { previousRunId, ...rest } = options;
		const previousRun = previousRunId ? this.getRun(previousRunId) : (options.onlyNode || options.retryFrom) ? this.records.get(definition.id)?.[0] : undefined;
		const runId = options.runId ?? `wr-${generateUuid().replace(/-/g, '').slice(0, 12)}`;
		const store = new DisposableStore();
		const env: IWorkflowRunEnvironment = { runId, workflow: definition, ...(options.trigger ? { trigger: options.trigger } : {}) };
		const host = options.mode === 'execute' ? this.executeHost(env, store) : this.simulateHost(env, options.simulation);
		let execution: IWorkflowExecution;
		try {
			execution = startWorkflowRun(definition, host, { ...rest, runId, depth, ...(previousRun ? { previousRun } : {}) });
		} catch (err) {
			store.dispose();
			throw err;
		}
		const live: ILive = { execution, workflowId: definition.id, record: this.entries.has(definition.id), store };
		this.live.set(execution.run.id, live);
		store.add(execution.onDidChange(event => this._onDidChangeRun.fire(event)));
		void execution.done.then(
			run => this.finished(live, run),
			err => {
				this.logService.error(`[volt workflows] run ${execution.run.id} of ${definition.id} ended with an error`, err);
				this.finished(live, { ...execution.run, status: execution.run.status === 'cancelled' ? 'cancelled' : 'failed', error: execution.run.error ?? errorText(err), finishedAt: execution.run.finishedAt ?? Date.now() });
			});
		this._onDidChange.fire();
		return execution;
	}

	private unattended(trigger: IWorkflowRunTrigger | undefined): boolean {
		for (let current = trigger, hops = 0; current && hops <= WORKFLOW_MAX_DEPTH + 1; hops++) {
			if (UNATTENDED_TRIGGERS.has(current.kind)) {
				return true;
			}
			current = current.kind === 'subworkflow' && current.parentRunId ? this.live.get(current.parentRunId)?.execution.run.trigger : undefined;
		}
		return false;
	}

	private finished(live: ILive, run: IWorkflowRun): void {
		if (this.live.get(run.id) !== live) {
			return;
		}
		this.live.delete(run.id);
		live.store.dispose();
		live.execution.dispose();
		if (live.record) {
			this.record(run);
		}
		this._onDidChange.fire();
	}

	private executeHost(env: IWorkflowRunEnvironment, store: DisposableStore): IWorkflowEngineHost {
		const executors = store.add(this.instantiationService.createInstance(WorkflowExecutors, env));
		return {
			executor: type => executors.executor(type),
			requestApproval: (request, token) => this.requestApproval(env.workflow, request, token),
			runSubworkflow: (workflowId, inputs, parent, token) => this.runSubworkflow(workflowId, inputs, parent, token),
			delay: (ms, token) => workflowDelay(ms, token),
		};
	}

	/** Simulated executors; approvals ask (or resolve to `autoApprove`), sub-workflows simulate too. */
	private simulateHost(env: IWorkflowRunEnvironment, options: IWorkflowSimulationOptions | undefined): IWorkflowEngineHost {
		return createSimulationHost({
			requestApproval: (request, token) => this.requestApproval(env.workflow, request, token),
			runSubworkflow: (workflowId, inputs, parent, token) => this.runSubworkflow(workflowId, inputs, parent, token),
			delay: (ms, token) => workflowDelay(ms, token),
		}, options);
	}

	/**
	 * Asks in a notification; the builder's Approve or Reject (`execution.resolveApproval`) may
	 * answer first, and then the notification goes away.
	 */
	private requestApproval(workflow: IWorkflowDefinition, request: IWorkflowApprovalRequest, token: CancellationToken): Promise<WorkflowApprovalDecision> {
		return new Promise<WorkflowApprovalDecision>((resolve, reject) => {
			const store = new DisposableStore();
			let settled = false;
			const finish = (decision: WorkflowApprovalDecision | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				store.dispose();
				handle.close();
				if (decision) {
					resolve(decision);
				} else {
					reject(new CancellationError());
				}
			};
			const handle = this.notificationService.prompt(
				Severity.Info,
				request.detail ? localize('voltWorkflows.approvalDetail', "{0}: {1}. {2}", workflow.name, request.title, request.detail) : localize('voltWorkflows.approval', "{0}: {1}", workflow.name, request.title),
				[
					{ label: localize('voltWorkflows.approve', "Approve"), run: () => finish('approve') },
					{ label: localize('voltWorkflows.reject', "Reject"), run: () => finish('reject') },
				],
				{ sticky: true },
			);
			store.add(token.onCancellationRequested(() => finish(undefined)));
			store.add(this.onDidChangeRun(event => {
				if (event.run.id !== request.runId) {
					return;
				}
				const stepDone = event.kind === 'step' && event.step.id === request.stepId && event.step.state !== 'waiting' && event.step.state !== 'running' && event.step.state !== 'queued';
				if (stepDone || (event.kind === 'run' && isFinished(event.run.status))) {
					finish(undefined);
				}
			}));
		});
	}

	private async runSubworkflow(workflowId: string, inputs: WorkflowRecord, parent: { readonly runId: string; readonly depth: number; readonly mode: WorkflowRunMode }, token: CancellationToken): Promise<IWorkflowRun> {
		if (parent.depth + 1 > WORKFLOW_MAX_DEPTH) {
			throw new WorkflowNodeError(localize('voltWorkflows.tooDeep', "Sub-workflows nest more than {0} deep.", WORKFLOW_MAX_DEPTH));
		}
		const parentRun = this.live.get(parent.runId)?.execution.run;
		const execution = await this.start(workflowId, {
			mode: parent.mode,
			inputs,
			depth: parent.depth + 1,
			trigger: {
				kind: 'subworkflow',
				parentRunId: parent.runId,
				...(parentRun ? { label: parentRun.workflowName } : {}),
				...(parentRun?.trigger.repository ? { repository: parentRun.trigger.repository } : {}),
			},
		});
		const listener = token.onCancellationRequested(() => execution.cancel());
		try {
			return await execution.done;
		} finally {
			listener.dispose();
		}
	}

	activeExecution(workflowId: string): IWorkflowExecution | undefined {
		let latest: IWorkflowExecution | undefined;
		for (const live of this.live.values()) {
			if (live.workflowId === workflowId && !isFinished(live.execution.run.status) && (!latest || live.execution.run.startedAt >= latest.run.startedAt)) {
				latest = live.execution;
			}
		}
		return latest;
	}

	/** Runs in progress first, then the recorded ones, newest first. */
	runs(workflowId: string): readonly IWorkflowRun[] {
		const running = [...this.live.values()].filter(live => live.workflowId === workflowId).map(live => live.execution.run).sort((a, b) => b.startedAt - a.startedAt);
		const recorded = this.records.get(workflowId) ?? [];
		return running.length ? [...running, ...recorded.filter(run => !this.live.has(run.id))] : recorded;
	}

	getRun(runId: string): IWorkflowRun | undefined {
		const live = this.live.get(runId);
		if (live) {
			return live.execution.run;
		}
		for (const runs of this.records.values()) {
			const run = runs.find(candidate => candidate.id === runId);
			if (run) {
				return run;
			}
		}
		return undefined;
	}

	async clearRuns(workflowId: string): Promise<void> {
		await this.whenReady;
		await this.enqueue(async () => {
			this.records.delete(workflowId);
			this.runsText.delete(workflowId);
			await this.fileService.del(this.runsFileOf(workflowId)).catch(() => undefined);
		});
		this._onDidChange.fire();
	}

	private record(run: IWorkflowRun): void {
		const compact = compactRun(run);
		const runs = [compact, ...(this.records.get(run.workflowId) ?? []).filter(entry => entry.id !== run.id)].slice(0, RUNS_KEPT);
		this.records.set(run.workflowId, runs);
		void this.enqueue(() => this.writeRuns(run.workflowId));
	}

	/** Merges with runs other windows recorded since this one read the file, then writes. */
	private async writeRuns(workflowId: string): Promise<void> {
		const file = this.runsFileOf(workflowId);
		let disk: IWorkflowRun[] = [];
		try {
			const text = (await this.fileService.readFile(file)).value.toString();
			if (text !== this.runsText.get(workflowId)) {
				disk = parseRuns(text);
			}
		} catch {
			// No file yet.
		}
		const byId = new Map<string, IWorkflowRun>();
		for (const run of [...disk, ...(this.records.get(workflowId) ?? [])]) {
			byId.set(run.id, run);
		}
		const runs = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUNS_KEPT);
		this.records.set(workflowId, runs);
		const text = JSON.stringify({ version: RUNS_FILE_VERSION, runs });
		try {
			await this.writeText(file, text);
			this.runsText.set(workflowId, text);
		} catch (err) {
			this.logService.error(`[volt workflows] could not save the runs of ${workflowId}`, err);
		}
		if (disk.length) {
			this._onDidChange.fire();
		}
	}

	private async readRuns(workflowId: string): Promise<void> {
		try {
			const text = (await this.fileService.readFile(this.runsFileOf(workflowId))).value.toString();
			if (text === this.runsText.get(workflowId)) {
				return;
			}
			this.runsText.set(workflowId, text);
			this.records.set(workflowId, parseRuns(text));
		} catch {
			// No runs yet.
		}
	}

	private async reloadRuns(): Promise<void> {
		const ids = [...this.staleRuns].filter(id => this.entries.has(id));
		this.staleRuns.clear();
		const before = ids.map(id => this.records.get(id));
		await Promise.all(ids.map(id => this.readRuns(id)));
		if (ids.some((id, index) => this.records.get(id) !== before[index])) {
			this._onDidChange.fire();
		}
	}

	/** Runs in progress when the window closes are recorded as stopped; queued writes finish. */
	private async shutdown(): Promise<void> {
		for (const live of [...this.live.values()]) {
			const run = live.execution.run;
			if (live.record && !isFinished(run.status)) {
				this.record({ ...run, status: 'cancelled', error: localize('voltWorkflows.closed', "Volt closed during the run."), finishedAt: Date.now() });
			}
		}
		await this.queue;
	}

	//#endregion
}

//#region Helpers

function parseEntry(id: string, yaml: string, updatedAt: number): IEntry {
	const parsed = parseWorkflowYaml(yaml);
	// The file name is the id: a copied file keeps working under its new name.
	return { id, yaml, ...(parsed.definition ? { definition: { ...parsed.definition, id } } : {}), issues: parsed.issues, updatedAt };
}

function parseRuns(text: string): IWorkflowRun[] {
	try {
		const raw: unknown = JSON.parse(text);
		const runs = raw && typeof raw === 'object' && Array.isArray((raw as { runs?: unknown }).runs) ? (raw as { runs: unknown[] }).runs : [];
		return runs.filter((run): run is IWorkflowRun => {
			const value = run as Partial<IWorkflowRun> | undefined;
			return !!value && typeof value.id === 'string' && typeof value.workflowId === 'string' && typeof value.status === 'string' && typeof value.startedAt === 'number' && Array.isArray(value.steps);
		}).sort((a, b) => b.startedAt - a.startedAt).slice(0, RUNS_KEPT);
	} catch {
		return [];
	}
}

/** What a stored run keeps: step values cut to `STORED_VALUE_CHARS`, the latest `LOGS_KEPT` log lines. */
function compactRun(run: IWorkflowRun): IWorkflowRun {
	return {
		...run,
		steps: run.steps.map(step => ({
			...step,
			...(step.input !== undefined ? { input: cutValue(step.input) } : {}),
			...(step.output !== undefined ? { output: cutValue(step.output) } : {}),
			...(step.resolvedConfig !== undefined ? { resolvedConfig: cutRecord(step.resolvedConfig) } : {}),
		})),
		variables: cutRecord(run.variables),
		inputs: cutRecord(run.inputs),
		logs: run.logs.slice(-LOGS_KEPT),
	};
}

function cutValue(value: WorkflowValue): WorkflowValue {
	const json = JSON.stringify(value) ?? '';
	return json.length > STORED_VALUE_CHARS ? `${json.slice(0, STORED_VALUE_CHARS)}… (cut: ${json.length} characters in all)` : value;
}

function cutRecord(value: WorkflowRecord): WorkflowRecord {
	const cut = cutValue(value);
	return typeof cut === 'string' ? { truncated: cut } : value;
}

/** A workflow id from a name: lower-case words joined by dashes, starting with a letter. */
export function workflowSlug(name: string): string {
	const base = name.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
	return /^[a-z]/.test(base) ? base : `workflow${base ? `-${base}` : ''}`.slice(0, 56);
}

/**
 * Sets top-level `key: value` lines of YAML text, keeping everything else as written. A missing
 * `id` goes after `version:` (or first), a missing `revision` after `id:`.
 */
function withTopLevel(text: string, values: { readonly id: string; readonly revision: number }): string {
	let out = text;
	for (const [key, value] of [['id', values.id], ['revision', String(values.revision)]] as const) {
		const line = new RegExp(`^${key}:[^\\n]*$`, 'm');
		if (line.test(out)) {
			out = out.replace(line, `${key}: ${value}`);
			continue;
		}
		const after = key === 'id' ? /^version:[^\n]*$/m : /^id:[^\n]*$/m;
		const anchor = after.exec(out);
		out = anchor
			? `${out.slice(0, anchor.index + anchor[0].length)}\n${key}: ${value}${out.slice(anchor.index + anchor[0].length)}`
			: `${key}: ${value}\n${out}`;
	}
	return out;
}

function clipLine(value: string, max = 80): string {
	const line = value.trim().split('\n')[0] ?? '';
	return line.length > max || value.trim().includes('\n') ? `${line.slice(0, max)}…` : line;
}

/** What a workflow does outside Volt, in plain words, for the trust prompt and the template preview. */
export function describeWorkflowPermissions(definition: IWorkflowDefinition): string[] {
	const lines = new Set<string>();
	const str = (config: WorkflowRecord, ...keys: string[]) => {
		for (const key of keys) {
			const value = config[key];
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
		return '';
	};
	for (const node of definition.nodes) {
		if (node.disabled) {
			continue;
		}
		const config = node.config;
		switch (node.type) {
			case 'shell':
				lines.add(localize('voltWorkflows.permShell', "Runs shell commands: {0}", clipLine(str(config, 'command', 'script', 'run')) || '…'));
				continue;
			case 'package_script':
				lines.add(localize('voltWorkflows.permScript', "Runs a package script: {0}", str(config, 'script', 'name') || '…'));
				continue;
			case 'http':
			case 'webhook':
				lines.add(localize('voltWorkflows.permCalls', "Calls {0}", clipLine(str(config, 'url', 'webhookUrl')) || localize('voltWorkflows.permUrl', "a URL")));
				continue;
			case 'slack_message':
				lines.add(localize('voltWorkflows.permSlack', "Posts to Slack"));
				continue;
			case 'teams_message':
				lines.add(localize('voltWorkflows.permTeams', "Posts to Microsoft Teams"));
				continue;
			case 'git_push':
				lines.add(localize('voltWorkflows.permPush', "Pushes to git"));
				continue;
			case 'git_commit':
				lines.add(localize('voltWorkflows.permCommit', "Commits to git"));
				continue;
			case 'git_sync':
				lines.add(localize('voltWorkflows.permSync', "Pulls and rebases git branches"));
				continue;
			case 'git_branch':
				lines.add(localize('voltWorkflows.permBranch', "Creates and switches git branches"));
				continue;
			case 'github_pr':
				lines.add(localize('voltWorkflows.permPr', "Opens pull requests on GitHub"));
				continue;
			case 'github_update_pr':
				lines.add(localize('voltWorkflows.permUpdatePr', "Edits pull requests on GitHub"));
				continue;
			case 'github_pr_comment':
			case 'github_issue_comment':
				lines.add(localize('voltWorkflows.permComment', "Comments on GitHub"));
				continue;
			case 'github_wait_ci':
				lines.add(localize('voltWorkflows.permChecks', "Reads CI checks on GitHub"));
				continue;
			case 'write_file':
				lines.add(localize('voltWorkflows.permWrite', "Writes files: {0}", str(config, 'path', 'file') || '…'));
				continue;
			case 'mcp_tool':
				lines.add(localize('voltWorkflows.permMcp', "Calls the MCP tool {0} of {1}", str(config, 'tool', 'toolName') || '…', str(config, 'server', 'mcpServer') || '…'));
				continue;
			case 'agent':
			case 'skill':
			case 'subtask':
			case 'classify':
			case 'summarize':
				lines.add(localize('voltWorkflows.permAgent', "Runs AI agents in the repository (they can edit files and run commands)"));
				continue;
			case 'subworkflow':
				lines.add(localize('voltWorkflows.permSub', "Runs the workflow {0}", str(config, 'workflow', 'workflowId') || '…'));
				continue;
		}
		for (const permission of getWorkflowNodeType(node.type)?.permissions ?? []) {
			lines.add(permission === 'shell' ? localize('voltWorkflows.permShellAny', "Runs shell commands")
				: permission === 'network' ? localize('voltWorkflows.permNetwork', "Makes network requests")
					: permission === 'git' ? localize('voltWorkflows.permGit', "Changes git repositories")
						: permission === 'filesystem' ? localize('voltWorkflows.permFiles', "Writes files")
							: permission === 'messaging' ? localize('voltWorkflows.permMessages', "Sends messages")
								: localize('voltWorkflows.permAgent', "Runs AI agents in the repository (they can edit files and run commands)"));
		}
	}
	if (!lines.size) {
		lines.add(localize('voltWorkflows.permNone', "Nothing outside Volt: no commands, network requests or agents"));
	}
	return [...lines];
}

//#endregion
