/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, dirname, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileQuery, ISearchService, QueryType } from '../../../services/search/common/search.js';
import {
	emptyHttpFlow, evaluateHttpFlowAssert, extractHttpFlowValue, fillHttpFlowVariables, findHttpFlowStep, HTTP_FLOW_FILE_PATTERN, HTTP_FLOW_FILE_SUFFIX, HTTP_FLOW_MAX_ITERATIONS, httpFlowInlineRequest, httpFlowRunSummary, httpFlowStepLabel,
	httpFlowStepsOf, httpFlowTotals, IHttpFlow, IHttpFlowAssertResult, IHttpFlowProblem, IHttpFlowRef, IHttpFlowRequestStep, IHttpFlowResponse, IHttpFlowRun, IHttpFlowRunSummary, IHttpFlowStep, IHttpFlowStepRun, isHttpFlowContainer, parseHttpFlow,
	parseHttpFlowData, serializeHttpFlow, validateHttpFlow,
} from '../common/httpAutomation.js';
import { findHttpItemByPath, httpFileNameFor, httpItemPath, httpRequestsOf, IHttpCollection, IHttpRequest } from '../common/httpCollection.js';
import { HTTP_COLLECTIONS_FOLDER_SETTING, IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpConfinement, IHttpExchange, IVoltHttpService } from './voltHttpService.js';
import { IHttpToolFileEntry, IHttpToolFiles } from './voltHttpToolPages.js';

export const IVoltHttpAutomations = createDecorator<IVoltHttpAutomations>('voltHttpAutomations');

/** The folder under the project's collections folder that new flows are written into. */
export const HTTP_AUTOMATIONS_FOLDER = 'automations';

const SAVE_DELAY_MS = 250;
const HISTORY_KEY = 'volt.http.flowRuns';
const MAX_HISTORY = 20;
const MAX_HISTORY_FLOWS = 60;
const MAX_FILES = 400;
const MAX_STEP_DELAY_MS = 60_000;

export type HttpFlowRun = IHttpFlowRun<IHttpExchange>;
export type HttpFlowStepRun = IHttpFlowStepRun<IHttpExchange>;

// --- Saved requests a step points at ------------------------------------------------------------

export interface IHttpFlowResolvedRef {
	readonly collection: URI;
	readonly request: IHttpRequest;
}

type RefCollections = Pick<IVoltHttpCollections, 'load' | 'collections'>;

/** The saved request a step's `ref` names, or why there is none. */
export async function resolveHttpFlowRef(collections: RefCollections, ref: IHttpFlowRef, flowUri: URI | undefined, root: URI | undefined, readable?: (uri: URI) => Promise<boolean>): Promise<IHttpFlowResolvedRef | string> {
	const name = ref.collection.trim();
	if (!name || !ref.path.length) {
		return 'The step does not say which saved request to send.';
	}
	const candidates: URI[] = [];
	if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(name)) {
		candidates.push(URI.file(name));
	} else {
		if (flowUri) {
			candidates.push(joinPath(dirname(flowUri), name));
		}
		if (root) {
			candidates.push(joinPath(root, name));
		}
	}
	let found: { uri: URI; collection: IHttpCollection } | undefined;
	let unreadable: string | undefined;
	for (const uri of candidates) {
		if (readable && !await readable(uri)) {
			continue;
		}
		const entry = await collections.load(uri).catch(() => undefined);
		if (entry?.error) {
			unreadable = `${basename(uri)} could not be read: ${entry.error}`;
		} else if (entry) {
			found = { uri: entry.uri, collection: entry.collection };
			break;
		}
	}
	if (!found) {
		// Written by hand, a ref may name the collection instead of its file.
		const entries = await collections.collections(root, readable).catch(() => []);
		const wanted = name.toLowerCase();
		const match = entries.find(entry => !entry.error && (entry.collection.name.toLowerCase() === wanted || basename(entry.uri).toLowerCase() === wanted || basename(entry.uri).toLowerCase().replace(/\.(?:postman_collection\.json|http|rest)$/, '') === wanted));
		if (match) {
			found = { uri: match.uri, collection: match.collection };
		}
	}
	if (!found) {
		return unreadable ?? `The collection ${name} was not found in the project.`;
	}
	const item = findHttpItemByPath(found.collection, ref.path);
	if (item?.kind === 'request') {
		return { collection: found.uri, request: item };
	}
	// A request moved to another folder is still the one meant when its name is the only one.
	const sameName = httpRequestsOf(found.collection.items).filter(entry => entry.request.name === ref.path.at(-1));
	if (sameName.length === 1) {
		return { collection: found.uri, request: sameName[0].request };
	}
	return `The request "${ref.path.join(' / ')}" is not in ${basename(found.uri)}.`;
}

/** How a flow names a saved request: its collection file relative to the project (else to the flow file) and its name path. */
export function httpFlowRefFor(flowUri: URI | undefined, root: URI | undefined, collectionUri: URI, collection: IHttpCollection, requestId: string): IHttpFlowRef | undefined {
	const path = httpItemPath(collection, requestId);
	if (!path) {
		return undefined;
	}
	const fromRoot = root && isEqualOrParent(collectionUri, root) ? relativePath(root, collectionUri) : undefined;
	const fromFlow = flowUri ? relativePath(dirname(flowUri), collectionUri) : undefined;
	return { collection: fromRoot ?? fromFlow ?? collectionUri.fsPath, path };
}

// --- The runner ---------------------------------------------------------------------------------

export interface IHttpFlowExecution {
	readonly flow: IHttpFlow;
	readonly flowUri?: URI;
	readonly root?: URI;
	readonly collections: Pick<IVoltHttpCollections, 'send' | 'load' | 'collections'>;
	readonly token?: CancellationToken;
	/** Used when the flow names none. */
	readonly environment?: string;
	readonly confined?: IHttpConfinement;
	/** The data set: one iteration per row. */
	readonly rows?: readonly Readonly<Record<string, string>>[];
	/** Values every iteration starts with besides the flow's own (what the last run left, for a partial run). */
	readonly seed?: Readonly<Record<string, string>>;
	/** Runs this step and the ones after it. */
	readonly fromStepId?: string;
	/** Runs this step alone (with what is inside it). */
	readonly onlyStepId?: string;
	readonly onProgress?: (run: HttpFlowRun) => void;
	/** Waits; resolves early when the token is cancelled. Tests pass one that does not wait. */
	readonly sleep?: (ms: number, token: CancellationToken) => Promise<void>;
}

function cancellableSleep(ms: number, token: CancellationToken): Promise<void> {
	if (ms <= 0 || token.isCancellationRequested) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const listener = token.onCancellationRequested(() => {
			clearTimeout(timer);
			listener.dispose();
			resolve();
		});
		const timer = setTimeout(() => {
			listener.dispose();
			resolve();
		}, ms);
	});
}

interface IStepMode {
	/** Everything here is skipped, for this reason (a disabled group, a condition that did not hold). */
	readonly skip?: string;
	/** Inside a teardown group: runs although an earlier step failed. */
	readonly teardown: boolean;
	/** Inside a setup group: a failure stops the run whatever the settings say. */
	readonly setup: boolean;
	/** The round of the loop the steps are in: part of their keys and names. */
	readonly round: string;
	readonly roundLabel: string;
}

class FlowRunner {

	private readonly run: HttpFlowRun;
	private readonly token: CancellationToken;
	private readonly sleep: (ms: number, token: CancellationToken) => Promise<void>;
	private readonly included: ReadonlySet<string> | undefined;
	private readonly resolved = new Map<string, IHttpFlowResolvedRef | string>();
	private variables: Record<string, string> = {};
	private lastResponse: IHttpFlowResponse | undefined;
	/** A step failed and the rest is skipped (teardown groups aside). */
	private aborted = false;
	private requestsSent = 0;
	private readonly started = Date.now();

	constructor(private readonly execution: IHttpFlowExecution) {
		const flow = execution.flow;
		this.token = execution.token ?? CancellationToken.None;
		this.sleep = execution.sleep ?? cancellableSleep;
		const rows = execution.rows ?? [];
		this.run = {
			id: `${this.started}-${Math.random().toString(36).slice(2, 8)}`,
			flowName: flow.name,
			startedAt: this.started,
			durationMs: 0,
			state: 'running',
			iterations: rows.length ? Math.min(rows.length, HTTP_FLOW_MAX_ITERATIONS) : Math.max(1, Math.min(flow.settings.iterations, HTTP_FLOW_MAX_ITERATIONS)),
			iteration: 0,
			steps: [],
			totals: httpFlowTotals([]),
			variables: {},
		};
		const environment = flow.environment ?? execution.environment;
		if (environment) {
			this.run.environment = environment;
		}
		this.included = this.partial();
	}

	/** The steps a partial run takes: the one asked for with what is in and above it, or it and everything after. */
	private partial(): ReadonlySet<string> | undefined {
		const { flow, onlyStepId, fromStepId } = this.execution;
		const id = onlyStepId ?? fromStepId;
		const found = id ? findHttpFlowStep(flow, id) : undefined;
		if (!found) {
			return undefined;
		}
		const out = new Set<string>(found.ancestors.map(step => step.id));
		if (onlyStepId) {
			for (const step of httpFlowStepsOf([found.step])) {
				out.add(step.id);
			}
			return out;
		}
		const all = httpFlowStepsOf(flow.steps);
		for (const step of all.slice(all.indexOf(found.step))) {
			out.add(step.id);
		}
		return out;
	}

	private get cancelled(): boolean {
		return this.token.isCancellationRequested;
	}

	private emit(): void {
		this.run.totals = httpFlowTotals(this.run.steps);
		this.run.durationMs = Date.now() - this.started;
		this.run.variables = { ...this.variables };
		this.execution.onProgress?.(this.run);
	}

	async execute(): Promise<HttpFlowRun> {
		const { flow, rows = [] } = this.execution;
		const base: Record<string, string> = {};
		for (const row of flow.variables) {
			if (row.enabled && row.key) {
				base[row.key] = row.value;
			}
		}
		this.emit();
		for (let iteration = 0; iteration < this.run.iterations; iteration++) {
			if (this.cancelled) {
				break;
			}
			this.run.iteration = iteration;
			this.aborted = false;
			this.lastResponse = undefined;
			this.variables = { iteration: String(iteration + 1), ...base, ...this.execution.seed, ...rows[iteration] };
			await this.steps(flow.steps, undefined, 0, iteration, { teardown: false, setup: false, round: '', roundLabel: '' });
			if (this.aborted && flow.settings.stopOnFailure) {
				break;
			}
		}
		const totals = httpFlowTotals(this.run.steps);
		this.run.state = this.cancelled ? 'stopped' : totals.failed || totals.errors ? 'failed' : 'passed';
		this.emit();
		return this.run;
	}

	private async steps(steps: readonly IHttpFlowStep[], parentKey: string | undefined, depth: number, iteration: number, mode: IStepMode): Promise<void> {
		for (const step of steps) {
			if (this.included && !this.included.has(step.id)) {
				continue;
			}
			const record: HttpFlowStepRun = {
				key: `${iteration}:${mode.round}${step.id}`,
				stepId: step.id,
				...(parentKey ? { parentKey } : {}),
				depth,
				kind: step.kind,
				name: `${httpFlowStepLabel(step)}${mode.roundLabel}`,
				iteration,
				status: 'running',
				attempts: 0,
				durationMs: 0,
				asserts: [],
				extracted: [],
			};
			this.run.steps.push(record);
			const teardown = mode.teardown || (step.kind === 'group' && step.role === 'teardown');
			const skip = mode.skip ?? (step.disabled ? 'disabled' : this.cancelled ? 'the run was stopped' : this.aborted && !teardown ? 'an earlier step failed' : undefined);
			if (skip && !isHttpFlowContainer(step)) {
				record.status = 'skipped';
				record.error = skip;
				continue;
			}
			const began = Date.now();
			this.emit();
			if (isHttpFlowContainer(step)) {
				// A container that is skipped only because a step failed still looks inside: a teardown group in it runs.
				const hard = mode.skip ?? (step.disabled ? 'disabled' : this.cancelled ? 'the run was stopped' : undefined);
				await this.container(step, record, depth, iteration, { ...mode, ...(hard ? { skip: hard } : {}), teardown, setup: mode.setup || (step.kind === 'group' && step.role === 'setup') }, !!skip);
			} else if (step.kind === 'delay') {
				await this.sleep(Math.max(0, step.ms), this.token);
				record.status = this.cancelled ? 'skipped' : 'passed';
			} else if (step.kind === 'set') {
				for (const row of step.variables) {
					if (row.enabled && row.key) {
						const value = fillHttpFlowVariables(row.value, this.variables);
						this.variables[row.key] = value;
						record.extracted.push({ name: row.key, value, found: true });
					}
				}
				record.status = 'passed';
			} else {
				await this.request(step, record);
			}
			record.durationMs = isHttpFlowContainer(step) || step.kind === 'delay' ? Date.now() - began : record.durationMs;
			if ((record.status === 'failed' || record.status === 'error') && !(step.kind === 'request' && step.continueOnFailure) && (!isHttpFlowContainer(step) || record.error)) {
				if (this.execution.flow.settings.stopOnFailure || mode.setup) {
					this.aborted = true;
				}
			}
			this.emit();
		}
	}

	private async container(step: Extract<IHttpFlowStep, { steps: IHttpFlowStep[] }>, record: HttpFlowStepRun, depth: number, iteration: number, mode: IStepMode, skipped: boolean): Promise<void> {
		const inside = (round: string, roundLabel: string, skip?: string) => this.steps(step.steps, record.key, depth + 1, iteration, { ...mode, round: `${mode.round}${round}`, roundLabel: `${mode.roundLabel}${roundLabel}`, ...(skip ? { skip } : {}) });
		const before = this.run.steps.length;
		if (skipped || step.kind === 'group') {
			await inside('', '');
		} else if (step.kind === 'condition') {
			const result = evaluateHttpFlowAssert(step.if, { ...(this.lastResponse ? { response: this.lastResponse } : {}), variables: this.variables });
			record.asserts.push({ ...result, passed: true, message: result.passed ? result.label : `not met: ${result.message}` });
			await inside('', '', result.passed ? undefined : `the condition was not met (${result.message})`);
		} else {
			let rounds = Math.min(step.times ?? step.max, step.max);
			let items: unknown[] | undefined;
			if (step.forEach) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(this.variables[step.forEach] ?? '');
				} catch {
					parsed = undefined;
				}
				if (!Array.isArray(parsed)) {
					record.status = 'error';
					record.error = `The variable ${step.forEach} does not hold a JSON list to go through${this.variables[step.forEach] === undefined ? ' (it is not set)' : ''}.`;
					return;
				}
				items = parsed;
				rounds = Math.min(parsed.length, step.max, step.times ?? parsed.length);
			}
			let held = !step.until;
			let lastMessage = '';
			for (let round = 0; round < rounds; round++) {
				if (this.cancelled || (this.aborted && !mode.teardown)) {
					break;
				}
				const name = step.as?.trim() || 'item';
				if (items) {
					const item = items[round];
					this.variables[name] = typeof item === 'string' ? item : JSON.stringify(item);
				}
				this.variables[`${name}Index`] = String(round);
				record.attempts = round + 1;
				await inside(`${step.id}#${round}/`, ` #${round + 1}`);
				if (step.until) {
					const result = evaluateHttpFlowAssert(step.until, { ...(this.lastResponse ? { response: this.lastResponse } : {}), variables: this.variables });
					lastMessage = result.message;
					if (result.passed) {
						held = true;
						break;
					}
				}
			}
			if (!held && step.times === undefined && !items && !this.cancelled && !this.aborted) {
				record.status = 'failed';
				record.error = `Gave up after ${record.attempts} round${record.attempts === 1 ? '' : 's'}: ${lastMessage}`;
				return;
			}
		}
		const children = this.run.steps.slice(before).filter(child => child.parentKey === record.key);
		record.status = children.some(child => child.status === 'failed' || child.status === 'error') ? 'failed' : children.length && children.every(child => child.status === 'skipped') ? 'skipped' : 'passed';
		if (record.status === 'skipped' && !record.error) {
			record.error = children[0]?.error;
		}
	}

	private async resolve(step: IHttpFlowRequestStep): Promise<IHttpFlowResolvedRef | { readonly collection: undefined; readonly request: IHttpRequest } | string> {
		if (!step.ref) {
			return step.inline ? { collection: undefined, request: httpFlowInlineRequest(step) } : 'The step has no request: give it a saved request or an inline one.';
		}
		const key = `${step.ref.collection}\n${step.ref.path.join('\n')}`;
		let resolved = this.resolved.get(key);
		if (!resolved) {
			resolved = await resolveHttpFlowRef(this.execution.collections, step.ref, this.execution.flowUri, this.execution.root, this.execution.confined?.readable);
			this.resolved.set(key, resolved);
		}
		return resolved;
	}

	private async request(step: IHttpFlowRequestStep, record: HttpFlowStepRun): Promise<void> {
		const { flow, collections, root, confined } = this.execution;
		const target = await this.resolve(step);
		if (typeof target === 'string') {
			record.status = 'error';
			record.error = target;
			return;
		}
		record.method = target.request.method;
		record.url = target.request.url;
		if (target.collection) {
			record.collection = target.collection.toString();
			record.requestId = target.request.id;
		}
		const timeoutMs = step.timeoutMs || flow.settings.timeoutMs;
		const attempts = 1 + Math.max(0, step.retry?.times ?? 0);
		const began = Date.now();
		for (let attempt = 1; attempt <= attempts; attempt++) {
			if (this.cancelled) {
				break;
			}
			if (attempt > 1 && step.retry) {
				await this.sleep(Math.min(step.retry.delayMs * Math.pow(step.retry.backoff, attempt - 2), MAX_STEP_DELAY_MS), this.token);
			} else if (attempt === 1 && this.requestsSent > 0 && flow.settings.delayMs > 0) {
				await this.sleep(Math.min(flow.settings.delayMs, MAX_STEP_DELAY_MS), this.token);
			}
			if (this.cancelled) {
				break;
			}
			record.attempts = attempt;
			this.requestsSent++;
			const overrides: Record<string, string> = {};
			for (const row of step.variables) {
				if (row.enabled && row.key) {
					overrides[row.key] = fillHttpFlowVariables(row.value, this.variables);
				}
			}
			let exchange: IHttpExchange;
			try {
				exchange = await collections.send(target.request, {
					...(target.collection ? { collection: target.collection } : {}),
					...(root ? { root } : {}),
					token: this.token,
					...(this.run.environment ? { environment: this.run.environment } : {}),
					...(timeoutMs ? { timeoutMs } : {}),
					...(confined ? { confined } : {}),
					variables: { ...this.variables, ...overrides },
				});
			} catch (err) {
				record.status = 'error';
				record.error = err instanceof Error ? err.message : String(err);
				record.durationMs = Date.now() - began;
				return;
			}
			record.exchange = exchange;
			record.method = exchange.method;
			record.url = exchange.url;
			record.statusCode = exchange.response?.status;
			record.durationMs = exchange.response?.durationMs ?? Date.now() - began;
			if (exchange.response) {
				this.lastResponse = exchange.response;
			}
			const last = attempt === attempts;
			const context = { ...(exchange.response ? { response: exchange.response } : {}), variables: { ...this.variables, ...overrides } };
			if (step.retry?.until) {
				// Polling: the condition decides whether to ask again; the assertions judge the answer that met it.
				const until = evaluateHttpFlowAssert(step.retry.until, context);
				if (!until.passed) {
					if (last) {
						record.status = exchange.error ? 'error' : 'failed';
						record.error = `Gave up after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${exchange.error ?? until.message}`;
						return;
					}
					continue;
				}
			}
			const verdict = this.judge(step, exchange, overrides);
			if (verdict.status !== 'passed' && !last && step.retry && !step.retry.until) {
				continue;
			}
			record.status = verdict.status;
			record.error = verdict.error;
			record.asserts = verdict.asserts;
			record.extracted = verdict.extracted;
			Object.assign(this.variables, verdict.values);
			return;
		}
		// Only a stop gets here.
		record.status = 'skipped';
		record.error = 'the run was stopped';
	}

	/** What an answer comes to: what it gives the next steps, and whether it is what the step asks for. */
	private judge(step: IHttpFlowRequestStep, exchange: IHttpExchange, overrides: Readonly<Record<string, string>>): Pick<HttpFlowStepRun, 'status' | 'error' | 'asserts' | 'extracted'> & { readonly values: Record<string, string> } {
		const response = exchange.response;
		if (!response) {
			return { status: 'error', error: exchange.error ?? 'No response.', asserts: [], extracted: [], values: {} };
		}
		const values: Record<string, string> = {};
		const extracted = step.extract.filter(item => item.name.trim()).map(item => extractHttpFlowValue({ ...item, ...(item.path !== undefined ? { path: fillHttpFlowVariables(item.path, this.variables) } : {}) }, response));
		for (const item of extracted) {
			if (item.value !== undefined) {
				values[item.name] = item.value;
			}
		}
		const variables = { ...this.variables, ...overrides, ...values };
		const asserts: IHttpFlowAssertResult[] = step.assert.map(assert => evaluateHttpFlowAssert(assert, { response, variables }));
		let error: string | undefined;
		if (step.runScripts !== false) {
			for (const test of exchange.tests ?? []) {
				if (!test.skipped) {
					asserts.push({ label: test.name, passed: test.passed, message: test.passed ? test.name : `${test.name}: ${test.error ?? 'failed'}` });
				}
			}
			if (exchange.scriptError) {
				error = `The request's script failed: ${exchange.scriptError}`;
			}
		}
		const failed = asserts.some(assert => !assert.passed) || extracted.some(item => !item.found && item.value === undefined);
		return { status: error ? 'error' : failed ? 'failed' : 'passed', error, asserts, extracted, values };
	}
}

/** Runs a flow's steps in order through the collections service and reports each step as it goes. Never rejects. */
export function executeHttpFlow(execution: IHttpFlowExecution): Promise<HttpFlowRun> {
	return new FlowRunner(execution).execute();
}

// --- The service --------------------------------------------------------------------------------

/** A flow file, loaded: one object per file for the whole window. */
export interface IHttpFlowEntry {
	readonly uri: URI;
	flow: IHttpFlow;
	/** Why the file could not be read as a flow; `flow` is empty then. */
	error?: string;
	/** What the reader skipped over in the file. */
	parseProblems: readonly IHttpFlowProblem[];
}

export interface IHttpFlowChange {
	readonly uri: URI;
	/** What `update` was given: a page tells its own edits from everyone else's by it. Absent when the file changed on disk. */
	readonly origin?: unknown;
}

export interface IHttpAutomationRunOptions {
	readonly root?: URI;
	/** Used when the flow names none; the selected one when absent. */
	readonly environment?: string;
	readonly confined?: IHttpConfinement;
	readonly token?: CancellationToken;
	readonly fromStepId?: string;
	readonly onlyStepId?: string;
}

export interface IVoltHttpAutomations extends IHttpToolFiles {
	readonly _serviceBrand: undefined;
	/** A flow's content changed. */
	readonly onDidChangeFlow: Event<IHttpFlowChange>;
	/** A flow's run started, moved on or ended (the flow's file). */
	readonly onDidChangeRun: Event<URI>;

	/** A loaded flow, or undefined until `load` or `list` read it. */
	get(uri: URI): IHttpFlowEntry | undefined;
	load(uri: URI): Promise<IHttpFlowEntry | undefined>;
	/** Changes the flow and saves it shortly after; resolves once it is written. */
	update(uri: URI, mutate: (flow: IHttpFlow) => void, origin?: unknown): Promise<void>;
	/** Writes what `update` has not written yet. */
	flush(uri?: URI): Promise<void>;
	/** Writes a whole flow: over `uri` when given, else as a new file in the project's automations folder. */
	write(root: URI | undefined, flow: IHttpFlow, uri?: URI): Promise<URI>;
	/** What is wrong with the flow before it runs: what the reader skipped, missing requests, incomplete steps. */
	problems(uri: URI, root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpFlowProblem[]>;
	/** The flow's data rows (its inline rows, or its file read as CSV or JSON). */
	dataRows(uri: URI, root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<{ readonly rows: Record<string, string>[]; readonly error?: string }>;

	/** Runs the flow and resolves with the finished run. Rejects when it cannot start (not a flow, already running). */
	run(uri: URI, options?: IHttpAutomationRunOptions): Promise<HttpFlowRun>;
	stop(uri: URI): void;
	isRunning(uri: URI): boolean;
	/** The run in progress, else the last one of this window. */
	runOf(uri: URI): HttpFlowRun | undefined;
	/** The last runs, oldest first (at most 20). */
	historyOf(uri: URI): readonly IHttpFlowRunSummary[];
}

interface IPendingSave {
	timer: ReturnType<typeof setTimeout> | undefined;
	promise: Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
}

export class VoltHttpAutomations extends Disposable implements IVoltHttpAutomations {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeFlow = this._register(new Emitter<IHttpFlowChange>());
	readonly onDidChangeFlow = this._onDidChangeFlow.event;
	private readonly _onDidChangeRun = this._register(new Emitter<URI>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly models = new ResourceMap<IHttpFlowEntry>();
	private readonly loading = new ResourceMap<Promise<IHttpFlowEntry | undefined>>();
	/** What this service last wrote to a file: its own change events are not reloads. */
	private readonly written = new ResourceMap<string>();
	private readonly saves = new ResourceMap<IPendingSave>();
	private readonly indexes = new Map<string, Promise<URI[]>>();
	private readonly running = new ResourceMap<CancellationTokenSource>();
	private readonly runs = new ResourceMap<HttpFlowRun>();
	private readonly changed = new ResourceMap<true>();
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.applyFileChanges(), 150));
	private history: Record<string, IHttpFlowRunSummary[]> | undefined;

	constructor(
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(fileService.onDidFilesChange(event => {
			let any = false;
			for (const uri of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
				if (uri.path.toLowerCase().endsWith(HTTP_FLOW_FILE_SUFFIX)) {
					this.changed.set(uri, true);
					any = true;
				}
			}
			if (any) {
				this.refresh.schedule();
			}
		}));
	}

	override dispose(): void {
		// What was edited in the last moment is still written.
		for (const [uri, save] of this.saves) {
			clearTimeout(save.timer);
			const entry = this.models.get(uri);
			if (entry && !entry.error) {
				void this.fileService.writeFile(uri, VSBuffer.fromString(serializeHttpFlow(entry.flow))).then(undefined, () => undefined);
			}
			save.resolve();
		}
		this.saves.clear();
		for (const source of this.running.values()) {
			source.dispose(true);
		}
		this.running.clear();
		super.dispose();
	}

	// --- Files -----------------------------------------------------------------------------------

	private read(uri: URI): Promise<string | undefined> {
		return this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
	}

	private async applyFileChanges(): Promise<void> {
		const uris = [...this.changed.keys()];
		this.changed.clear();
		let listChanged = false;
		for (const uri of uris) {
			const text = await this.read(uri);
			if (text !== undefined && this.written.get(uri) === text) {
				continue;
			}
			const known = this.models.get(uri);
			if (text === undefined) {
				this.models.delete(uri);
				this.written.delete(uri);
				listChanged = true;
			} else if (known) {
				// Edits not written yet lose to the file: it is what the user (or an agent) has now.
				const save = this.saves.get(uri);
				if (save) {
					clearTimeout(save.timer);
					this.saves.delete(uri);
					save.resolve();
				}
				const name = known.flow.name;
				this.parseInto(known, text);
				this._onDidChangeFlow.fire({ uri });
				listChanged = listChanged || name !== known.flow.name;
			} else {
				listChanged = true;
			}
		}
		if (listChanged) {
			this.indexes.clear();
			this._onDidChange.fire();
		}
	}

	private parseInto(entry: IHttpFlowEntry, text: string): void {
		const fallback = basename(entry.uri).slice(0, -HTTP_FLOW_FILE_SUFFIX.length) || 'Automation';
		const parsed = parseHttpFlow(text, fallback);
		entry.flow = parsed.flow ?? emptyHttpFlow(fallback);
		entry.error = parsed.flow ? undefined : parsed.error ?? 'Not a flow file.';
		entry.parseProblems = parsed.problems;
	}

	get(uri: URI): IHttpFlowEntry | undefined {
		return this.models.get(uri);
	}

	load(uri: URI): Promise<IHttpFlowEntry | undefined> {
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
				const existing = this.models.get(uri);
				if (existing) {
					return existing;
				}
				const entry: IHttpFlowEntry = { uri, flow: emptyHttpFlow(''), parseProblems: [] };
				this.parseInto(entry, text);
				this.models.set(uri, entry);
				return entry;
			});
			this.loading.set(uri, pending);
		}
		return pending;
	}

	private collectionsFolder(root: URI | undefined): URI {
		const base = root ?? this.http.foldersOf(undefined)[0];
		if (!base) {
			throw new Error('Open a project folder to keep automations in.');
		}
		const configured = this.configurationService.getValue<string>(HTTP_COLLECTIONS_FOLDER_SETTING);
		const folder = typeof configured === 'string' ? configured.trim().replace(/^[\\/]+|[\\/]+$/g, '') : 'http';
		return joinPath(folder && !folder.split(/[\\/]/).includes('..') ? joinPath(base, folder) : base, HTTP_AUTOMATIONS_FOLDER);
	}

	private index(root: URI | undefined): Promise<URI[]> {
		const key = root?.toString() ?? '';
		let index = this.indexes.get(key);
		if (!index) {
			index = this.buildIndex(root);
			this.indexes.set(key, index);
		}
		return index;
	}

	private async buildIndex(root: URI | undefined): Promise<URI[]> {
		const folders = this.http.foldersOf(root);
		const found = new ResourceMap<URI>();
		if (folders.length) {
			const query: IFileQuery = { type: QueryType.File, folderQueries: folders.map(folder => ({ folder })), includePattern: { [HTTP_FLOW_FILE_PATTERN]: true }, excludePattern: { '**/node_modules/**': true }, maxResults: MAX_FILES };
			const result = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
			for (const item of result?.results ?? []) {
				found.set(item.resource, item.resource);
			}
		}
		// The folder new flows go into is read where it is: a search skips ignored folders and may lag behind a new file.
		for (const folder of folders) {
			let own: URI;
			try {
				own = this.collectionsFolder(folder);
			} catch {
				continue;
			}
			const stat = await this.fileService.resolve(own).catch(() => undefined);
			for (const child of stat?.children ?? []) {
				if (!child.isDirectory && child.name.toLowerCase().endsWith(HTTP_FLOW_FILE_SUFFIX)) {
					found.set(child.resource, child.resource);
				}
			}
		}
		return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
	}

	async list(root: URI | undefined): Promise<readonly IHttpToolFileEntry[]> {
		const out: IHttpToolFileEntry[] = [];
		for (const uri of await this.index(root)) {
			const entry = await this.load(uri);
			if (!entry) {
				continue;
			}
			const steps = httpFlowStepsOf(entry.flow.steps).filter(step => !isHttpFlowContainer(step)).length;
			out.push({
				uri,
				name: entry.flow.name,
				detail: entry.error ? localize('voltHttp.autoUnreadable', "unreadable") : steps === 1 ? localize('voltHttp.autoOneStep', "1 step") : localize('voltHttp.autoStepCount', "{0} steps", steps),
				...(this.running.has(uri) ? { running: true } : {}),
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	nameOf(uri: URI): string | undefined {
		return this.models.get(uri)?.flow.name;
	}

	private async freeFile(folder: URI, name: string): Promise<URI> {
		const stem = httpFileNameFor(name).replace(/^collection$/, 'automation');
		for (let at = 1; ; at++) {
			const uri = joinPath(folder, `${stem}${at > 1 ? `-${at}` : ''}${HTTP_FLOW_FILE_SUFFIX}`);
			if (!this.models.has(uri) && !await this.fileService.exists(uri)) {
				return uri;
			}
		}
	}

	private async writeNow(entry: IHttpFlowEntry): Promise<void> {
		const text = serializeHttpFlow(entry.flow);
		this.written.set(entry.uri, text);
		await this.fileService.writeFile(entry.uri, VSBuffer.fromString(text));
	}

	async write(root: URI | undefined, flow: IHttpFlow, uri?: URI): Promise<URI> {
		const target = uri ?? await this.freeFile(this.collectionsFolder(root), flow.name);
		const known = this.models.get(target);
		const entry: IHttpFlowEntry = known ?? { uri: target, flow, parseProblems: [] };
		const save = this.saves.get(target);
		if (save) {
			clearTimeout(save.timer);
			this.saves.delete(target);
			save.resolve();
		}
		entry.flow = flow;
		entry.error = undefined;
		entry.parseProblems = [];
		this.models.set(target, entry);
		await this.writeNow(entry);
		this.indexes.clear();
		this._onDidChangeFlow.fire({ uri: target });
		this._onDidChange.fire();
		return target;
	}

	create(root: URI | undefined, name?: string): Promise<URI> {
		return this.write(root, emptyHttpFlow(name?.trim() || localize('voltHttp.autoNewName', "New Automation")));
	}

	async rename(uri: URI, name: string): Promise<void> {
		const next = name.trim();
		if (!next) {
			return;
		}
		await this.require(uri);
		const done = this.update(uri, flow => flow.name = next);
		await this.flush(uri);
		await done;
	}

	async duplicate(uri: URI): Promise<URI> {
		const entry = await this.require(uri);
		const copy = structuredClone(entry.flow);
		copy.name = localize('voltHttp.autoCopyName', "{0} Copy", entry.flow.name);
		const folder = dirname(uri);
		return this.write(undefined, copy, await this.freeFile(folder, copy.name));
	}

	async remove(uri: URI): Promise<void> {
		this.stop(uri);
		const save = this.saves.get(uri);
		if (save) {
			clearTimeout(save.timer);
			this.saves.delete(uri);
			save.resolve();
		}
		await this.fileService.del(uri, { useTrash: true }).catch(() => this.fileService.del(uri));
		this.models.delete(uri);
		this.written.delete(uri);
		this.runs.delete(uri);
		this.indexes.clear();
		this._onDidChange.fire();
	}

	private async require(uri: URI): Promise<IHttpFlowEntry> {
		const entry = await this.load(uri);
		if (!entry) {
			throw new Error(`No automation at ${uri.path}.`);
		}
		if (entry.error) {
			throw new Error(`${basename(uri)} is not a flow that can be used: ${entry.error}`);
		}
		return entry;
	}

	update(uri: URI, mutate: (flow: IHttpFlow) => void, origin?: unknown): Promise<void> {
		const entry = this.models.get(uri);
		if (!entry) {
			return Promise.reject(new Error(`The automation ${uri.path} is not loaded.`));
		}
		if (entry.error) {
			return Promise.reject(new Error(`${basename(uri)} cannot be changed: ${entry.error}`));
		}
		const name = entry.flow.name;
		mutate(entry.flow);
		entry.parseProblems = [];
		this._onDidChangeFlow.fire({ uri, ...(origin !== undefined ? { origin } : {}) });
		if (name !== entry.flow.name) {
			this._onDidChange.fire();
		}
		let save = this.saves.get(uri);
		if (!save) {
			let resolve!: () => void;
			let reject!: (err: unknown) => void;
			const promise = new Promise<void>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			// Whoever does not wait for the write must not see an unhandled rejection.
			promise.catch(() => undefined);
			save = { timer: undefined, promise, resolve, reject };
			this.saves.set(uri, save);
		}
		clearTimeout(save.timer);
		save.timer = setTimeout(() => void this.flush(uri), SAVE_DELAY_MS);
		return save.promise;
	}

	async flush(uri?: URI): Promise<void> {
		const uris = uri ? [uri] : [...this.saves.keys()];
		for (const target of uris) {
			const save = this.saves.get(target);
			if (!save) {
				continue;
			}
			clearTimeout(save.timer);
			this.saves.delete(target);
			const entry = this.models.get(target);
			try {
				if (entry && !entry.error) {
					await this.writeNow(entry);
				}
				save.resolve();
			} catch (err) {
				save.reject(err);
			}
		}
	}

	async problems(uri: URI, root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<readonly IHttpFlowProblem[]> {
		const entry = await this.load(uri);
		if (!entry) {
			return [{ severity: 'error', path: '', message: `No automation at ${uri.path}.` }];
		}
		if (entry.error) {
			return [{ severity: 'error', path: '', message: entry.error }];
		}
		const known = new Map<string, boolean>();
		for (const step of httpFlowStepsOf(entry.flow.steps)) {
			if (step.kind === 'request' && step.ref?.collection.trim() && step.ref.path.length) {
				const key = `${step.ref.collection}\n${step.ref.path.join('\n')}`;
				if (!known.has(key)) {
					known.set(key, typeof await resolveHttpFlowRef(this.collections, step.ref, uri, root, readable) !== 'string');
				}
			}
		}
		return [...entry.parseProblems, ...validateHttpFlow(entry.flow, ref => known.get(`${ref.collection}\n${ref.path.join('\n')}`))];
	}

	async dataRows(uri: URI, root?: URI, readable?: (uri: URI) => Promise<boolean>): Promise<{ readonly rows: Record<string, string>[]; readonly error?: string }> {
		const data = this.models.get(uri)?.flow.data;
		const file = data?.file?.trim();
		if (!file) {
			return { rows: (data?.rows ?? []).slice(0, HTTP_FLOW_MAX_ITERATIONS) };
		}
		const candidates = /^(?:[a-zA-Z]:[\\/]|\/)/.test(file) ? [URI.file(file)] : [joinPath(dirname(uri), file), ...(root ? [joinPath(root, file)] : [])];
		for (const candidate of candidates) {
			if (readable && !await readable(candidate)) {
				continue;
			}
			const text = await this.read(candidate);
			if (text !== undefined) {
				const parsed = parseHttpFlowData(text, file);
				return parsed.error ? parsed : parsed.rows.length ? parsed : { rows: [], error: `The data file ${file} has no rows.` };
			}
		}
		return { rows: [], error: `The data file ${file} could not be read.` };
	}

	// --- Runs ------------------------------------------------------------------------------------

	isRunning(uri: URI): boolean {
		return this.running.has(uri);
	}

	runOf(uri: URI): HttpFlowRun | undefined {
		return this.runs.get(uri);
	}

	stop(uri: URI): void {
		this.running.get(uri)?.cancel();
	}

	async run(uri: URI, options: IHttpAutomationRunOptions = {}): Promise<HttpFlowRun> {
		if (this.running.has(uri)) {
			throw new Error('This automation is already running.');
		}
		const entry = await this.require(uri);
		await this.flush(uri);
		// The run works on the flow as it is now: edits made meanwhile are for the next run.
		const flow = structuredClone(entry.flow);
		const partial = !!(options.fromStepId || options.onlyStepId);
		const previous = this.runs.get(uri);
		const source = new CancellationTokenSource(options.token);
		this.running.set(uri, source);
		this._onDidChange.fire();
		let run: HttpFlowRun;
		try {
			const data = await this.dataRows(uri, options.root, options.confined?.readable);
			if (data.error) {
				run = { id: `${Date.now()}`, flowName: flow.name, startedAt: Date.now(), durationMs: 0, state: 'error', error: data.error, iterations: 0, iteration: 0, steps: [], totals: httpFlowTotals([]), variables: {} };
			} else {
				const environment = options.environment ?? (options.confined ? undefined : this.http.environmentOf(options.root));
				run = await executeHttpFlow({
					flow,
					flowUri: uri,
					...(options.root ? { root: options.root } : {}),
					collections: this.collections,
					token: source.token,
					...(environment ? { environment } : {}),
					...(options.confined ? { confined: options.confined } : {}),
					rows: partial ? data.rows.slice(0, 1) : data.rows,
					...(partial && previous ? { seed: previous.variables } : {}),
					...(options.fromStepId ? { fromStepId: options.fromStepId } : {}),
					...(options.onlyStepId ? { onlyStepId: options.onlyStepId } : {}),
					onProgress: progress => {
						this.runs.set(uri, progress);
						this._onDidChangeRun.fire(uri);
					},
				});
			}
		} catch (err) {
			run = { id: `${Date.now()}`, flowName: flow.name, startedAt: Date.now(), durationMs: 0, state: 'error', error: err instanceof Error ? err.message : String(err), iterations: 0, iteration: 0, steps: [], totals: httpFlowTotals([]), variables: {} };
		} finally {
			this.running.delete(uri);
			source.dispose();
		}
		this.runs.set(uri, run);
		if (!partial) {
			this.remember(uri, run);
		}
		if (flow.settings.persistVariables && !options.confined && run.state !== 'error') {
			await this.persist(run, options.root).catch(() => undefined);
		}
		this._onDidChangeRun.fire(uri);
		this._onDidChange.fire();
		return run;
	}

	/** Writes what the run extracted into the environment it ran with, so the next requests sent by hand have it. */
	private async persist(run: HttpFlowRun, root: URI | undefined): Promise<void> {
		const name = run.environment;
		const names = new Set(run.steps.filter(step => step.kind === 'request').flatMap(step => step.extracted.filter(item => item.value !== undefined).map(item => item.name)));
		if (!name || !names.size) {
			return;
		}
		const entry = (await this.collections.environments(root)).find(item => !item.globals && !item.shared && item.environment.name === name);
		if (!entry) {
			return;
		}
		const rows = entry.environment.variables.map(row => ({ ...row }));
		for (const key of names) {
			const value = run.variables[key];
			if (value === undefined) {
				continue;
			}
			const row = rows.find(item => item.key === key);
			if (row) {
				row.value = value;
				row.enabled = true;
			} else {
				rows.push({ key, value, enabled: true });
			}
		}
		await this.collections.saveEnvironment(entry, entry.environment.name, rows);
	}

	private loadHistory(): Record<string, IHttpFlowRunSummary[]> {
		if (!this.history) {
			try {
				const parsed: unknown = JSON.parse(this.storageService.get(HISTORY_KEY, StorageScope.WORKSPACE) ?? '{}');
				this.history = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, IHttpFlowRunSummary[]> : {};
			} catch {
				this.history = {};
			}
		}
		return this.history;
	}

	private remember(uri: URI, run: HttpFlowRun): void {
		const history = this.loadHistory();
		const key = uri.toString();
		const list = [...(Array.isArray(history[key]) ? history[key] : []), httpFlowRunSummary(run)].slice(-MAX_HISTORY);
		// The flow run last goes last, so the ones not run for longest are dropped first.
		delete history[key];
		history[key] = list;
		const keys = Object.keys(history);
		for (const old of keys.slice(0, Math.max(0, keys.length - MAX_HISTORY_FLOWS))) {
			delete history[old];
		}
		this.storageService.store(HISTORY_KEY, JSON.stringify(history), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	historyOf(uri: URI): readonly IHttpFlowRunSummary[] {
		const list = this.loadHistory()[uri.toString()];
		return Array.isArray(list) ? list : [];
	}
}

registerSingleton(IVoltHttpAutomations, VoltHttpAutomations, InstantiationType.Delayed);
