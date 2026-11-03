/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { approximateSize, evaluateExpression, hasTemplates, isTruthy, resolveTemplates, stringifyValue } from './workflowExpressions.js';
import { loopBody, upstreamNodes, validateWorkflow, workflowBackEdges, downstreamNodes } from './workflowGraph.js';
import { formatWorkflowDuration, keyValueRecord, parseWorkflowDuration, workflowItemsList } from './workflowNodeCatalog.js';
import { defaultNodeConfig, getWorkflowNodeType, nodeDisplayName } from './workflowNodes.js';
import {
	IWorkflowDefinition, IWorkflowEdge, IWorkflowEngineHost, IWorkflowExecution, IWorkflowLogEntry, IWorkflowNode, IWorkflowNodeContext, IWorkflowNodeResult, IWorkflowNodeType,
	IWorkflowRun, IWorkflowRunOptions, IWorkflowRunTrigger, IWorkflowScope, IWorkflowSimulationOptions, IWorkflowStepRecord, IWorkflowTokenUsage, WORKFLOW_DEFAULT_CONCURRENCY,
	WORKFLOW_DEFAULT_MAX_STEPS, WORKFLOW_HARD_MAX_STEPS, WORKFLOW_MAX_DEPTH, WorkflowApprovalDecision, WorkflowLogLevel, WorkflowNodeError, WorkflowNodeState, WorkflowRecord,
	WorkflowRunEvent, WorkflowRunStatus, WorkflowValue,
} from './workflowTypes.js';

/**
 * Runs a workflow graph: control nodes here, task nodes through the host's executors (or
 * simulated), with concurrency, retries, timeouts, loops, approvals, sub-workflows, stepping and
 * cancellation. Pure: the clock, delays, executors and approvals come from the host.
 *
 * Scheduling is token based. The start node fires first; a node runs once per token that reaches
 * it, so two branches meeting at a plain node run it twice and a Join is how branches merge.
 * - Not taken: when a node leaves through one port, the edges of its other ports are "dead". A
 *   node whose every incoming edge is dead is skipped (state `skipped`, recorded once if it never
 *   ran) and its edges die too, so a Join never waits for a branch that cannot come. Back-edges
 *   into loops never decide anything (a loop is entered from outside, the body returns to it).
 * - Join `all` fires once every incoming edge has fired or died (at least one fired: its output is
 *   a record of those outputs by upstream node id); `any` fires on the first and absorbs the rest
 *   of that round. When nothing else can run, a Join still waiting on branches that never started
 *   (unreachable sources) fires with what it has.
 * - Loop: entered from outside it starts at pass 0; each token back through a back-edge is the
 *   next pass. It leaves through `repeat` while passes < max and `while` holds, else `exhausted`.
 *   Its exit is not decided while it repeats, so nodes after `exhausted` wait. Each repeat resets
 *   the body's edge and join state.
 * - For each: the body is every node reachable from `item` without passing back through the
 *   for-each node. Items run one after another, each in its own scope (`item`, `loop.index`);
 *   a pass ends when nothing in the body can run any more. An item's result is the last value
 *   sent back into the for-each node through a back-edge, else the last output produced in the
 *   pass. Then `done` fires with `{ items, results, count }`.
 * - Routing control nodes (if, switch, loop, fork, wait, approval, set variables, disabled nodes)
 *   pass their input on unchanged; their step output says what they decided.
 * - Failure: an executor's failure-kind port (`failed`, `conflict`, …) is a normal outcome when
 *   wired; unwired, the run fails. A thrown error goes by `onError`: `continue` leaves through
 *   the first port, `route` and the default go to a wired failure port, and otherwise (or with
 *   `fail`) the run fails and every running node is cancelled.
 */

/** Step outputs bigger than this are stored truncated (scope keeps the full value for the run). */
export const WORKFLOW_MAX_OUTPUT_BYTES = 256 * 1024;
export const WORKFLOW_MAX_LOG_ENTRIES = 1000;
const RETRY_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 10;

/** Simulated durations at speed 1, so the canvas animates; agents take longest. */
const PACING_MS: { readonly [type: string]: number } = {
	agent: 1600, subtask: 1400, skill: 1200, summarize: 900, classify: 700, ask_user: 600, mcp_tool: 600,
	shell: 700, package_script: 700, http: 450, webhook: 350, github_wait_ci: 900,
};
const CATEGORY_PACING_MS: { readonly [category: string]: number } = { git: 450, integrations: 400, scripts: 500, data: 250, outputs: 250 };
const CONTROL_PACING_MS = 150;
const SIMULATED_WAIT_CAP_MS = 1500;

/** Long text keeps its start; big structures become a marker with a JSON preview. */
export function truncateWorkflowValue(value: WorkflowValue | undefined, maxBytes = WORKFLOW_MAX_OUTPUT_BYTES): WorkflowValue | undefined {
	if (value === undefined || value === null || typeof value !== 'object' && typeof value !== 'string') {
		return value;
	}
	if (typeof value === 'string') {
		return value.length > maxBytes ? `${value.slice(0, maxBytes)}\n… [truncated ${value.length - maxBytes} characters]` : value;
	}
	if (approximateSize(value, maxBytes + 1) <= maxBytes) {
		return value;
	}
	const json = JSON.stringify(value);
	return json.length <= maxBytes ? value : { truncated: true, bytes: json.length, preview: json.slice(0, 16 * 1024) };
}

/**
 * A host for simulations: no executors (task nodes simulate), approvals answered by
 * `autoApprove` or the base host, sub-workflows run by the base host in simulate mode.
 */
export function createSimulationHost(base: Partial<IWorkflowEngineHost>, options?: IWorkflowSimulationOptions): IWorkflowEngineHost {
	return {
		executor: () => undefined,
		requestApproval: (request, token) => {
			if (options?.autoApprove) {
				return Promise.resolve(options.autoApprove);
			}
			// Without a base host the run waits for execution.resolveApproval().
			return base.requestApproval ? base.requestApproval(request, token) : new Promise<WorkflowApprovalDecision>(() => { });
		},
		runSubworkflow: (workflowId, inputs, parent, token) => base.runSubworkflow
			? base.runSubworkflow(workflowId, inputs, { ...parent, mode: 'simulate' }, token)
			: Promise.reject(new WorkflowNodeError('Sub-workflows cannot run in this simulation')),
		now: base.now,
		delay: base.delay,
		newId: base.newId,
	};
}

export function startWorkflowRun(definition: IWorkflowDefinition, host: IWorkflowEngineHost, options: IWorkflowRunOptions): IWorkflowExecution {
	return new WorkflowExecution(definition, host, options);
}

//#region Internals

interface IFrame {
	readonly item?: WorkflowValue;
	readonly loop?: WorkflowRecord;
}

interface IJoinArrival {
	readonly from: string;
	readonly value: WorkflowValue;
	readonly frame: IFrame;
}

/** Where tokens flow: the whole graph, or one pass of a for-each body. */
interface IRegion {
	/** Undefined: every node. */
	readonly nodes?: ReadonlySet<string>;
	/** The for-each node a body pass belongs to. */
	readonly owner?: string;
	/** Edge state this round; absent = pending. */
	readonly edgeState: Map<string, 'fired' | 'dead'>;
	readonly joins: Map<string, Map<string, IJoinArrival>>;
	/** `any` joins that already fired this round. */
	readonly joinRound: Set<string>;
	readonly loops: Map<string, { iteration: number; readonly entryFrame: IFrame }>;
	/** Activations created and not finished (queued, paused, running, waiting). */
	active: number;
	readonly returned: WorkflowValue[];
	lastOutput?: WorkflowValue;
	onIdle?: () => void;
}

interface IActivation {
	readonly node: IWorkflowNode;
	readonly type: IWorkflowNodeType | undefined;
	readonly region: IRegion;
	readonly input: WorkflowValue;
	readonly frame: IFrame;
	readonly via?: IWorkflowEdge;
	readonly step: number;
}

type AttemptResult = { readonly ok: IWorkflowNodeResult } | { readonly error: string; readonly output?: WorkflowValue };

class TimeoutError extends Error { }

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clampInt(value: WorkflowValue | undefined, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function isRecord(value: unknown): value is WorkflowRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FINAL_STATES = new Set<WorkflowNodeState>(['success', 'failed', 'skipped', 'cancelled']);

//#endregion

class WorkflowExecution implements IWorkflowExecution {

	private readonly emitter = new Emitter<WorkflowRunEvent>();
	readonly onDidChange: Event<WorkflowRunEvent> = this.emitter.event;
	readonly done: Promise<IWorkflowRun>;
	private resolveDone!: (run: IWorkflowRun) => void;

	private readonly cts: CancellationTokenSource;
	private readonly disposables: IDisposable[] = [];
	private readonly now: () => number;
	private readonly mode: IWorkflowRunOptions['mode'];
	private readonly runId: string;
	private readonly depth: number;
	private readonly maxSteps: number;
	private readonly trigger: IWorkflowRunTrigger;

	private readonly nodes = new Map<string, IWorkflowNode>();
	private readonly outgoing = new Map<string, IWorkflowEdge[]>();
	private readonly incoming = new Map<string, IWorkflowEdge[]>();
	private readonly backEdges: ReadonlySet<string>;
	private readonly bodies = new Map<string, ReadonlySet<string>>();

	// Run state.
	private status: WorkflowRunStatus = 'queued';
	private readonly startedAt: number;
	private finishedAt: number | undefined;
	private inputs: WorkflowRecord = {};
	private payload: WorkflowValue = null;
	private readonly variables: Record<string, WorkflowValue> = {};
	private readonly nodeOutputs: Record<string, WorkflowValue> = {};
	private readonly steps: IWorkflowStepRecord[] = [];
	private readonly stepCounts = new Map<string, number>();
	private readonly liveSteps = new Map<number, WorkflowNodeState>();
	private logs: IWorkflowLogEntry[] = [];
	private readonly traversed: string[] = [];
	private error: string | undefined;
	private endNodeId: string | undefined;
	private outcome: 'success' | 'failure' | undefined;
	private executed = 0;
	private readonly ran = new Set<string>();
	private readonly skippedOnce = new Set<string>();
	private readonly seeded = new Set<string>();
	private stopped: 'failed' | 'cancelled' | undefined;
	private finished = false;
	private snapshotCache: IWorkflowRun | undefined;

	// Concurrency, stepping, approvals.
	private slots: number;
	private readonly slotWaiters: (() => void)[] = [];
	private stepping: boolean;
	private pauseRequested = false;
	private stepCredit = false;
	private readonly breakpoints: ReadonlySet<string>;
	private readonly gateWaiters: (() => void)[] = [];
	private readonly approvals = new Map<string, (decision: WorkflowApprovalDecision) => void>();

	private readonly root: IRegion = WorkflowExecution.region();

	constructor(
		private readonly definition: IWorkflowDefinition,
		private readonly host: IWorkflowEngineHost,
		private readonly options: IWorkflowRunOptions,
	) {
		this.done = new Promise(resolve => this.resolveDone = resolve);
		this.now = () => host.now?.() ?? Date.now();
		this.mode = options.mode;
		this.runId = options.runId ?? host.newId?.() ?? generateUuid();
		this.depth = options.depth ?? 0;
		this.maxSteps = clampInt(definition.settings?.maxSteps, 1, WORKFLOW_HARD_MAX_STEPS, WORKFLOW_DEFAULT_MAX_STEPS);
		this.slots = clampInt(definition.settings?.concurrency, 1, 64, WORKFLOW_DEFAULT_CONCURRENCY);
		this.stepping = !!options.stepping && !options.onlyNode;
		this.breakpoints = new Set(options.onlyNode ? [] : options.breakpoints ?? []);
		this.trigger = options.trigger ?? { kind: 'manual' };
		this.startedAt = this.now();
		this.cts = new CancellationTokenSource();

		for (const node of definition.nodes) {
			if (!this.nodes.has(node.id)) {
				this.nodes.set(node.id, node);
			}
		}
		for (const edge of definition.edges) {
			if (this.nodes.has(edge.from) && this.nodes.has(edge.to)) {
				this.outgoing.set(edge.from, [...(this.outgoing.get(edge.from) ?? []), edge]);
				this.incoming.set(edge.to, [...(this.incoming.get(edge.to) ?? []), edge]);
			}
		}
		this.backEdges = workflowBackEdges(definition);
		Object.assign(this.variables, definition.variables ?? {});

		if (options.token) {
			this.disposables.push(options.token.onCancellationRequested(() => this.cancel()));
		}
		// Start on a microtask so callers can subscribe to onDidChange first.
		queueMicrotask(() => this.begin());
	}

	private static region(nodes?: ReadonlySet<string>, owner?: string): IRegion {
		return { nodes, owner, edgeState: new Map(), joins: new Map(), joinRound: new Set(), loops: new Map(), active: 0, returned: [] };
	}

	//#region Public API

	get run(): IWorkflowRun {
		return this.snapshotCache ??= this.snapshot();
	}

	get paused(): boolean {
		return !this.finished && (this.pauseRequested || this.stepping);
	}

	cancel(): void {
		if (this.finished || this.stopped) {
			return;
		}
		this.stopped = 'cancelled';
		this.log('warn', 'Run cancelled');
		this.halt();
	}

	pause(): void {
		if (!this.finished && !this.pauseRequested) {
			this.pauseRequested = true;
			this.refreshStatus();
		}
	}

	resume(): void {
		if (this.finished) {
			return;
		}
		this.stepping = false;
		this.pauseRequested = false;
		this.stepCredit = false;
		this.releaseGate(Infinity);
		this.refreshStatus();
	}

	step(): void {
		if (this.finished) {
			return;
		}
		if (this.gateWaiters.length) {
			this.releaseGate(1);
		} else if (this.paused) {
			// Pressed while a node still runs: let the next node through when it arrives.
			this.stepCredit = true;
		}
	}

	resolveApproval(nodeId: string, decision: WorkflowApprovalDecision): void {
		const resolve = this.approvals.get(nodeId);
		if (resolve) {
			this.approvals.delete(nodeId);
			resolve(decision);
		}
	}

	dispose(): void {
		this.cancel();
		this.cleanup();
		this.emitter.dispose();
	}

	//#endregion

	//#region Records and events

	private snapshot(): IWorkflowRun {
		const tokens = this.totalTokens();
		return {
			id: this.runId,
			workflowId: this.definition.id,
			workflowName: this.definition.name,
			revision: this.definition.revision,
			mode: this.mode,
			status: this.status,
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
			trigger: this.trigger,
			inputs: this.inputs,
			steps: [...this.steps],
			variables: { ...this.variables },
			logs: [...this.logs],
			tokens,
			error: this.error,
			endNodeId: this.endNodeId,
			outcome: this.outcome,
			traversed: [...this.traversed],
			depth: this.depth,
		};
	}

	private totalTokens(): IWorkflowTokenUsage | undefined {
		let total: { input: number; output: number; costUsd?: number } | undefined;
		for (const step of this.steps) {
			if (step.tokens) {
				total ??= { input: 0, output: 0 };
				total.input += step.tokens.input;
				total.output += step.tokens.output;
				if (step.tokens.costUsd !== undefined) {
					total.costUsd = (total.costUsd ?? 0) + step.tokens.costUsd;
				}
			}
		}
		return total;
	}

	private fire(event: (run: IWorkflowRun) => WorkflowRunEvent): void {
		this.snapshotCache = undefined;
		if (this.emitter.hasListeners()) {
			this.emitter.fire(event(this.run));
		}
	}

	private log(level: WorkflowLogLevel, message: string, nodeId?: string, stepId?: string): void {
		const entry: IWorkflowLogEntry = { at: this.now(), level, message, nodeId, stepId };
		this.logs.push(entry);
		if (this.logs.length > WORKFLOW_MAX_LOG_ENTRIES) {
			this.logs = this.logs.slice(-WORKFLOW_MAX_LOG_ENTRIES);
		}
		this.fire(run => ({ kind: 'log', run, entry }));
	}

	private addStep(node: IWorkflowNode, state: WorkflowNodeState, frame: IFrame, input?: WorkflowValue): number {
		const n = (this.stepCounts.get(node.id) ?? 0) + 1;
		this.stepCounts.set(node.id, n);
		const iteration = typeof frame.loop?.index === 'number' ? frame.loop.index : undefined;
		const step: IWorkflowStepRecord = { id: `${node.id}#${n}`, nodeId: node.id, attempt: 1, iteration, state, input: input === undefined ? undefined : truncateWorkflowValue(input) };
		const index = this.steps.push(step) - 1;
		if (!FINAL_STATES.has(state)) {
			this.liveSteps.set(index, state);
		}
		this.fire(run => ({ kind: 'step', run, step }));
		return index;
	}

	private updateStep(index: number, patch: Partial<IWorkflowStepRecord>): void {
		const previous = this.steps[index];
		// A finished step keeps its state (a cancelled step does not turn failed later).
		if (FINAL_STATES.has(previous.state) && patch.state && patch.state !== previous.state) {
			return;
		}
		const step: IWorkflowStepRecord = { ...previous, ...patch };
		this.steps[index] = step;
		if (FINAL_STATES.has(step.state)) {
			this.liveSteps.delete(index);
		} else {
			this.liveSteps.set(index, step.state);
		}
		this.fire(run => ({ kind: 'step', run, step }));
		if (patch.state) {
			this.refreshStatus();
		}
	}

	private setStatus(status: WorkflowRunStatus): void {
		if (this.status !== status) {
			this.status = status;
			this.fire(run => ({ kind: 'run', run }));
		}
	}

	private refreshStatus(): void {
		if (this.finished || this.status === 'queued') {
			return;
		}
		let running = false;
		let waiting = false;
		for (const state of this.liveSteps.values()) {
			running ||= state === 'running';
			waiting ||= state === 'waiting';
		}
		this.setStatus(this.gateWaiters.length && !running && !waiting ? 'paused' : waiting && !running ? 'waiting' : 'running');
	}

	//#endregion

	//#region Lifecycle

	private begin(): void {
		this.setStatus('running');
		if (this.stopped) {
			return this.finish();
		}
		const structural = validateWorkflow(this.definition).filter(issue => issue.severity === 'error' && (issue.code === 'no-start' || issue.code === 'multiple-start' || issue.code === 'cycle'));
		if (structural.length) {
			this.failRun(structural[0].message);
			return this.finish();
		}
		if (!this.prepareInputs()) {
			return this.finish();
		}
		if (this.options.token?.isCancellationRequested) {
			this.cancel();
			return this.finish();
		}
		const timeoutMs = this.definition.settings?.timeoutMs;
		if (timeoutMs && timeoutMs > 0) {
			this.delay(timeoutMs, this.cts.token).then(() => this.failRun(`Run timed out after ${formatWorkflowDuration(timeoutMs)}`), () => { });
		}

		const previous = this.options.previousRun;
		const target = this.options.onlyNode ?? this.options.retryFrom;
		if (target) {
			const node = this.nodes.get(target);
			if (!node) {
				this.failRun(`No node "${target}" in this workflow`);
				return this.finish();
			}
			this.seed(previous, target, !!this.options.retryFrom);
			this.activate(this.root, node, this.previousInput(node, previous), {});
		} else {
			const start = this.definition.nodes.find(node => getWorkflowNodeType(node.type)?.control === 'start')!;
			this.activate(this.root, start, null, {});
		}
	}

	/** Inputs with defaults and light coercion; required ones missing fail real runs and get placeholders in simulations. */
	private prepareInputs(): boolean {
		const given = this.options.inputs ?? {};
		const inputs: Record<string, WorkflowValue> = { ...given };
		for (const def of this.definition.inputs ?? []) {
			let value: WorkflowValue | undefined = given[def.name] ?? def.default;
			if (value === undefined || value === null || value === '') {
				if (!def.required) {
					continue;
				}
				if (this.mode === 'execute') {
					this.failRun(`Missing required input "${def.name}"`);
					return false;
				}
				value = def.type === 'number' ? 0 : def.type === 'boolean' ? false : def.type === 'json' ? null : `<${def.name}>`;
				this.log('warn', `Input "${def.name}" is missing; the simulation uses ${JSON.stringify(value)}`);
			} else if (typeof value === 'string') {
				if (def.type === 'number' && Number.isFinite(Number(value))) {
					value = Number(value);
				} else if (def.type === 'boolean' && /^(true|false)$/i.test(value)) {
					value = value.toLowerCase() === 'true';
				} else if (def.type === 'json') {
					try {
						value = JSON.parse(value);
					} catch {
						// Kept as text.
					}
				}
			}
			inputs[def.name] = value ?? null;
		}
		this.inputs = inputs;
		this.payload = this.trigger.payload ?? this.options.simulation?.payload ?? (this.mode === 'simulate' ? this.definition.trigger.samplePayload : undefined) ?? null;
		this.fire(run => ({ kind: 'run', run }));
		return true;
	}

	/** onlyNode / retryFrom: outputs of earlier nodes from the previous run, and (retry) its path so far. */
	private seed(previous: IWorkflowRun | undefined, target: string, retry: boolean): void {
		const outputs = new Map<string, WorkflowValue>();
		for (const step of previous?.steps ?? []) {
			if (step.output !== undefined && (step.state === 'success' || step.state === 'failed' || step.state === 'skipped')) {
				outputs.set(step.nodeId, step.output);
			}
		}
		// Retry: everything that ran and does not come after the retried node (parallel branches too).
		const after = new Set(downstreamNodes(this.definition, target));
		const before = new Set([...outputs.keys(), ...upstreamNodes(this.definition, target)].filter(id => !retry || !after.has(id)));
		before.delete(target);
		for (const id of before) {
			const output = outputs.get(id) ?? this.nodes.get(id)?.pinnedOutput;
			if (output !== undefined) {
				this.nodeOutputs[id] = output;
				this.seeded.add(id);
			}
		}
		if (!retry || !previous) {
			return;
		}
		Object.assign(this.variables, previous.variables);
		const traversed = new Set(previous.traversed);
		for (const edgeId of previous.traversed) {
			const edge = this.definition.edges.find(candidate => candidate.id === edgeId);
			if (edge && this.seeded.has(edge.from)) {
				this.traversed.push(edgeId);
			}
		}
		// Joins after the retried node already hold the branches that ran before it.
		for (const id of after) {
			if (getWorkflowNodeType(this.nodes.get(id)?.type ?? '')?.control !== 'join') {
				continue;
			}
			for (const edge of this.incoming.get(id) ?? []) {
				if (!before.has(edge.from) || after.has(edge.from)) {
					continue;
				}
				if (traversed.has(edge.id) && this.seeded.has(edge.from)) {
					this.root.edgeState.set(edge.id, 'fired');
					this.joinArrivals(this.root, id).set(edge.id, { from: edge.from, value: this.nodeOutputs[edge.from], frame: {} });
				} else {
					this.root.edgeState.set(edge.id, 'dead');
				}
			}
		}
		this.fire(run => ({ kind: 'run', run }));
	}

	/** A node's input from earlier outputs: a record by node id for a join, else the first upstream output. */
	private previousInput(node: IWorkflowNode, previous: IWorkflowRun | undefined): WorkflowValue {
		const incoming = (this.incoming.get(node.id) ?? []).filter(edge => !this.backEdges.has(edge.id));
		const upstream = incoming.length ? incoming : this.incoming.get(node.id) ?? [];
		const known = upstream.filter(edge => this.nodeOutputs[edge.from] !== undefined);
		if (getWorkflowNodeType(node.type)?.control === 'join') {
			const record: Record<string, WorkflowValue> = {};
			for (const edge of known) {
				record[edge.from] = this.nodeOutputs[edge.from];
			}
			return record;
		}
		if (!known.length && previous) {
			const own = [...previous.steps].reverse().find(step => step.nodeId === node.id && step.input !== undefined);
			return own?.input ?? null;
		}
		return known.length ? this.nodeOutputs[known[0].from] : null;
	}

	private failRun(message: string): void {
		if (this.finished || this.stopped) {
			return;
		}
		this.stopped = 'failed';
		this.error = message;
		this.log('error', message);
		this.halt();
	}

	/** Cancels everything in flight; activations drain and the run finishes when the graph is idle. */
	private halt(): void {
		this.cts.cancel();
		this.releaseGate(Infinity);
		while (this.slotWaiters.length) {
			this.slotWaiters.shift()!();
		}
		for (const resolve of [...this.approvals.values()]) {
			resolve('reject');
		}
		this.approvals.clear();
		if (this.root.active === 0 && this.status !== 'queued') {
			this.finish();
		}
	}

	private finish(): void {
		if (this.finished) {
			return;
		}
		let status: WorkflowRunStatus;
		if (this.stopped === 'cancelled') {
			status = 'cancelled';
		} else if (this.stopped === 'failed') {
			status = 'failed';
		} else if (this.outcome === 'failure') {
			status = 'failed';
			this.error ??= `Ended as a failure at ${nodeDisplayName(this.nodes.get(this.endNodeId!)!)}`;
		} else {
			status = 'succeeded';
		}
		const at = this.now();
		this.finished = true;
		this.finishedAt = at;
		this.status = status;
		for (const index of [...this.liveSteps.keys()]) {
			this.updateStep(index, { state: 'cancelled', finishedAt: at });
		}
		this.fire(run => ({ kind: 'run', run }));
		this.cleanup();
		this.resolveDone(this.run);
	}

	private cleanup(): void {
		while (this.disposables.length) {
			this.disposables.pop()!.dispose();
		}
		if (!this.finished) {
			return;
		}
		this.cts.dispose(true);
	}

	//#endregion

	//#region Waiting primitives

	private delay(ms: number, token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		if (!(ms > 0)) {
			return Promise.resolve();
		}
		if (this.host.delay) {
			return this.host.delay(ms, token).then(() => {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
			});
		}
		return timeout(ms, token);
	}

	/** Settles with the promise, or rejects as soon as the token is cancelled (executors that ignore tokens). */
	private race<T>(promise: Promise<T>, token: CancellationToken): Promise<T> {
		if (token.isCancellationRequested) {
			promise.then(undefined, () => { });
			return Promise.reject(new CancellationError());
		}
		return new Promise<T>((resolve, reject) => {
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				reject(new CancellationError());
			});
			promise.then(value => {
				listener.dispose();
				resolve(value);
			}, error => {
				listener.dispose();
				reject(error);
			});
		});
	}

	private pace(type: IWorkflowNodeType, token: CancellationToken): Promise<void> {
		const speed = this.options.simulation?.speed ?? 1;
		if (this.mode !== 'simulate' || !(speed > 0)) {
			return Promise.resolve();
		}
		const base = type.control !== 'task' ? CONTROL_PACING_MS : PACING_MS[type.type] ?? CATEGORY_PACING_MS[type.category] ?? 300;
		return this.delay(base * speed, token);
	}

	private async gate(act: IActivation): Promise<void> {
		const breakpoint = this.breakpoints.has(act.node.id);
		if (!this.stepping && !this.pauseRequested && !breakpoint) {
			return;
		}
		if (this.stepCredit) {
			this.stepCredit = false;
			return;
		}
		if (breakpoint && !this.stepping && !this.pauseRequested) {
			// A breakpoint holds the whole run, like a debugger.
			this.pauseRequested = true;
			this.log('info', `Paused before ${nodeDisplayName(act.node)}`, act.node.id);
		}
		await new Promise<void>(resolve => {
			this.gateWaiters.push(resolve);
			this.refreshStatus();
		});
	}

	private releaseGate(count: number): void {
		for (let i = 0; i < count && this.gateWaiters.length; i++) {
			this.gateWaiters.shift()!();
		}
	}

	private async acquireSlot(): Promise<void> {
		if (this.slots > 0) {
			this.slots--;
			return;
		}
		await new Promise<void>(resolve => this.slotWaiters.push(resolve));
	}

	private releaseSlot(): void {
		const next = this.slotWaiters.shift();
		if (next) {
			next();
		} else {
			this.slots++;
		}
	}

	//#endregion

	//#region Token flow

	private inRegion(region: IRegion, nodeId: string): boolean {
		return !region.nodes || region.nodes.has(nodeId);
	}

	/** Incoming edges that can bring a token in this region (back-edges never count). */
	private entryEdges(region: IRegion, nodeId: string): IWorkflowEdge[] {
		return (this.incoming.get(nodeId) ?? []).filter(edge => !this.backEdges.has(edge.id) && (this.inRegion(region, edge.from) || edge.from === region.owner));
	}

	private joinArrivals(region: IRegion, joinId: string): Map<string, IJoinArrival> {
		let arrivals = region.joins.get(joinId);
		if (!arrivals) {
			region.joins.set(joinId, arrivals = new Map());
		}
		return arrivals;
	}

	private activate(region: IRegion, node: IWorkflowNode, input: WorkflowValue, frame: IFrame, via?: IWorkflowEdge): void {
		region.active++;
		const step = this.addStep(node, 'queued', frame, input);
		void this.runActivation({ node, type: getWorkflowNodeType(node.type), region, input, frame, via, step });
	}

	private deliver(region: IRegion, edge: IWorkflowEdge, value: WorkflowValue, frame: IFrame): void {
		this.traversed.push(edge.id);
		this.fire(run => ({ kind: 'edge', run, edgeId: edge.id }));
		if (!this.inRegion(region, edge.to)) {
			if (edge.to === region.owner) {
				region.returned.push(value);
			}
			return;
		}
		const target = this.nodes.get(edge.to)!;
		if (getWorkflowNodeType(target.type)?.control === 'join') {
			region.edgeState.set(edge.id, 'fired');
			this.joinArrivals(region, target.id).set(edge.id, { from: edge.from, value, frame });
			this.propagate(region, this.checkJoin(region, target));
			return;
		}
		region.edgeState.delete(edge.id);
		this.activate(region, target, value, frame, edge);
	}

	/** Marks edges dead and skips what can no longer run, transitively. */
	private propagate(region: IRegion, dead: readonly IWorkflowEdge[]): void {
		const queue = [...dead];
		let guard = 0;
		while (queue.length && guard++ < 100_000) {
			const edge = queue.shift()!;
			if (!this.inRegion(region, edge.to) || this.backEdges.has(edge.id)) {
				continue;
			}
			region.edgeState.set(edge.id, 'dead');
			const target = this.nodes.get(edge.to)!;
			if (getWorkflowNodeType(target.type)?.control === 'join') {
				queue.push(...this.checkJoin(region, target));
				continue;
			}
			const entries = this.entryEdges(region, target.id);
			if (entries.every(entry => region.edgeState.get(entry.id) === 'dead')) {
				entries.forEach(entry => region.edgeState.delete(entry.id));
				queue.push(...this.skip(target));
			}
		}
	}

	/** A node no token can reach: recorded as skipped once (if it never ran); all its edges die. */
	private skip(node: IWorkflowNode): readonly IWorkflowEdge[] {
		if (!this.ran.has(node.id) && !this.skippedOnce.has(node.id)) {
			this.skippedOnce.add(node.id);
			const at = this.now();
			const index = this.addStep(node, 'skipped', {});
			this.updateStep(index, { startedAt: at, finishedAt: at });
		}
		return this.outgoing.get(node.id) ?? [];
	}

	/** Fires or skips a join once its incoming edges are decided; returns edges that died with it. */
	private checkJoin(region: IRegion, join: IWorkflowNode, force = false): readonly IWorkflowEdge[] {
		const entries = this.entryEdges(region, join.id);
		const arrivals = this.joinArrivals(region, join.id);
		if (force) {
			// Nothing else can run: branches that never started will not come.
			for (const edge of entries) {
				if (!region.edgeState.has(edge.id)) {
					region.edgeState.set(edge.id, 'dead');
				}
			}
		}
		const fired = entries.filter(edge => region.edgeState.get(edge.id) === 'fired');
		const pending = entries.filter(edge => !region.edgeState.has(edge.id));
		const record = () => {
			const value: Record<string, WorkflowValue> = {};
			let frame: IFrame = {};
			for (const edge of fired) {
				const arrival = arrivals.get(edge.id);
				if (arrival) {
					value[arrival.from] = arrival.value;
					frame = arrival.frame;
				}
			}
			return { value, frame };
		};
		const reset = () => {
			entries.forEach(edge => region.edgeState.delete(edge.id));
			arrivals.clear();
			region.joinRound.delete(join.id);
		};
		if (join.config.mode === 'any') {
			const firedBefore = region.joinRound.has(join.id);
			if (fired.length && !firedBefore) {
				region.joinRound.add(join.id);
				const { value, frame } = record();
				this.activate(region, join, value, frame);
			}
			if (pending.length) {
				return [];
			}
			const anyFired = region.joinRound.has(join.id);
			reset();
			return anyFired ? [] : this.skip(join);
		}
		if (pending.length) {
			return [];
		}
		const { value, frame } = record();
		reset();
		if (fired.length) {
			this.activate(region, join, value, frame);
			return [];
		}
		return this.skip(join);
	}

	private finishActivation(region: IRegion): void {
		region.active--;
		if (region.active > 0) {
			return;
		}
		if (!this.stopped) {
			// Joins still waiting on branches that can never start fire with what they have.
			for (const joinId of [...region.joins.keys()]) {
				const arrivals = region.joins.get(joinId)!;
				const touched = arrivals.size > 0 || this.entryEdges(region, joinId).some(edge => region.edgeState.has(edge.id));
				if (touched) {
					this.propagate(region, this.checkJoin(region, this.nodes.get(joinId)!, true));
				}
			}
			if (region.active > 0) {
				return;
			}
		}
		if (region === this.root) {
			this.finish();
		} else {
			region.onIdle?.();
		}
	}

	private route(act: IActivation, ports: readonly string[], value: WorkflowValue, options?: { readonly frame?: IFrame; readonly keep?: readonly string[] }): void {
		if (this.options.onlyNode || this.stopped) {
			return;
		}
		const taken = new Set(ports);
		const keep = new Set(options?.keep ?? []);
		const edges = this.outgoing.get(act.node.id) ?? [];
		this.propagate(act.region, edges.filter(edge => !taken.has(edge.port) && !keep.has(edge.port)));
		for (const edge of edges) {
			if (taken.has(edge.port) && !this.stopped) {
				this.deliver(act.region, edge, value, options?.frame ?? act.frame);
			}
		}
	}

	//#endregion

	//#region Running nodes

	private async runActivation(act: IActivation): Promise<void> {
		try {
			await this.gate(act);
			if (this.stopped) {
				this.updateStep(act.step, { state: 'cancelled', finishedAt: this.now() });
				return;
			}
			if (!act.node.disabled || this.options.onlyNode) {
				if (++this.executed > this.maxSteps) {
					this.updateStep(act.step, { state: 'failed', finishedAt: this.now(), error: 'Step budget exhausted' });
					this.failRun(`Step budget exhausted (${this.maxSteps} steps)`);
					return;
				}
			}
			await this.execute(act);
		} catch (error) {
			if (this.stopped || isCancellationError(error)) {
				this.updateStep(act.step, { state: 'cancelled', finishedAt: this.now() });
			} else {
				this.updateStep(act.step, { state: 'failed', finishedAt: this.now(), error: messageOf(error) });
				this.failRun(`${nodeDisplayName(act.node)}: ${messageOf(error)}`);
			}
		} finally {
			this.finishActivation(act.region);
		}
	}

	private scope(act: IActivation): IWorkflowScope {
		return {
			inputs: this.inputs,
			trigger: this.triggerScope(),
			nodes: { ...this.nodeOutputs },
			vars: { ...this.variables },
			item: act.frame.item,
			loop: act.frame.loop,
			run: { id: this.runId, mode: this.mode, workflowId: this.definition.id },
			input: act.input,
		};
	}

	/** `trigger.*` in templates: the run trigger's fields and the payload. */
	private triggerScope(): WorkflowRecord {
		const { kind, label, automationId, automationRunId, parentRunId, repository } = this.trigger;
		const value: Record<string, WorkflowValue> = { kind, payload: this.payload };
		for (const [key, entry] of Object.entries({ label, automationId, automationRunId, parentRunId, repository })) {
			if (entry !== undefined) {
				value[key] = entry;
			}
		}
		return value;
	}

	/** Config with templates resolved; expression fields stay as written (the node evaluates them). */
	private resolveConfig(type: IWorkflowNodeType, config: WorkflowRecord, scope: IWorkflowScope): WorkflowRecord {
		const fields = new Map(type.fields.map(field => [field.key, field]));
		const resolved: Record<string, WorkflowValue> = {};
		for (const key of Object.keys(config)) {
			const field = fields.get(key);
			if (field?.kind === 'expression') {
				resolved[key] = config[key];
				continue;
			}
			try {
				resolved[key] = resolveTemplates(config[key], scope, { now: this.now });
			} catch (error) {
				throw new WorkflowNodeError(`${field?.label ?? key}: ${messageOf(error)}`);
			}
		}
		return resolved;
	}

	private evaluate(source: WorkflowValue | undefined, scope: IWorkflowScope, label: string): WorkflowValue {
		if (typeof source !== 'string' || !source.trim()) {
			throw new WorkflowNodeError(`${label} is empty`);
		}
		try {
			return evaluateExpression(source, scope, { now: this.now });
		} catch (error) {
			throw new WorkflowNodeError(`${label}: ${messageOf(error)}`);
		}
	}

	private async execute(act: IActivation): Promise<void> {
		const { node, type } = act;
		this.ran.add(node.id);
		const startedAt = this.now();
		if (!type) {
			this.updateStep(act.step, { state: 'running', startedAt });
			throw new Error(`Unknown node type "${node.type}"`);
		}
		const config: WorkflowRecord = { ...defaultNodeConfig(type), ...node.config };
		this.updateStep(act.step, { state: 'running', startedAt });

		if (node.disabled && type.control !== 'start' && !this.options.onlyNode) {
			this.nodeOutputs[node.id] = act.input;
			this.updateStep(act.step, { state: 'skipped', finishedAt: this.now(), output: truncateWorkflowValue(act.input) });
			const first = type.outputs(config)[0];
			this.route(act, first ? [first.id] : [], act.input);
			return;
		}

		const scope = this.scope(act);
		let resolved: WorkflowRecord;
		try {
			resolved = this.resolveConfig(type, config, scope);
		} catch (error) {
			return this.failNode(act, type, config, messageOf(error), undefined, undefined);
		}
		this.updateStep(act.step, { resolvedConfig: resolved });

		try {
			switch (type.control) {
				case 'start': return await this.runStart(act, type);
				case 'end': return await this.runEnd(act, type, resolved);
				case 'if': return await this.runIf(act, type, config, scope);
				case 'switch': return await this.runSwitch(act, type, config, scope);
				case 'loop': return await this.runLoop(act, type, config, scope);
				case 'forEach': return await this.runForEach(act, type, config, resolved, scope);
				case 'fork': return await this.runFork(act, type, config);
				case 'join': return await this.runPassThrough(act, type, act.input, act.input);
				case 'wait': return await this.runWait(act, resolved);
				case 'approval': return await this.runApproval(act, type, config, resolved);
				case 'setVariables': return await this.runSetVariables(act, type, resolved);
				case 'subworkflow': return await this.runTask(act, type, config, resolved, (_attempt, token) => this.callSubworkflow(resolved, token));
				default: return await this.runTask(act, type, config, resolved, (attempt, token) => this.attemptTask(act, type, resolved, scope, attempt, token));
			}
		} catch (error) {
			if (this.stopped || isCancellationError(error)) {
				throw error;
			}
			return this.failNode(act, type, config, messageOf(error), error instanceof WorkflowNodeError ? error.output : undefined, undefined);
		}
	}

	/** Records a success and sends `value` down `ports` (the node's other ports' edges die). */
	private succeed(act: IActivation, output: WorkflowValue, ports: readonly string[], value: WorkflowValue, options?: { readonly frame?: IFrame; readonly keep?: readonly string[]; readonly tokens?: IWorkflowTokenUsage }): void {
		this.nodeOutputs[act.node.id] = output;
		act.region.lastOutput = output;
		this.updateStep(act.step, { state: 'success', finishedAt: this.now(), output: truncateWorkflowValue(output), port: ports[0], ...(options?.tokens ? { tokens: this.addTokens(this.steps[act.step].tokens, options.tokens) } : {}) });
		this.route(act, ports, value, options);
	}

	private runPassThrough(act: IActivation, type: IWorkflowNodeType, output: WorkflowValue, value: WorkflowValue): Promise<void> {
		return this.pace(type, this.cts.token).then(() => this.succeed(act, output, ['next'], value));
	}

	/**
	 * A failed node: through its failure port when the error came with one (wired), or by onError.
	 * Unhandled, the run fails.
	 */
	private failNode(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, message: string, output: WorkflowValue | undefined, failurePort: string | undefined): void {
		const ports = type.outputs(config);
		const wired = (port: string | undefined) => !!port && (this.outgoing.get(act.node.id) ?? []).some(edge => edge.port === port);
		const mode = act.node.onError;
		let route: string | undefined;
		if (failurePort) {
			route = wired(failurePort) ? failurePort : mode === 'continue' ? ports[0]?.id : undefined;
		} else if (mode === 'continue') {
			route = ports[0]?.id;
		} else if (mode !== 'fail') {
			const failure = ports.find(port => port.kind === 'failure')?.id;
			route = wired(failure) ? failure : undefined;
		}
		const value: WorkflowValue = output ?? { error: message };
		const name = nodeDisplayName(act.node);
		this.updateStep(act.step, { state: 'failed', finishedAt: this.now(), error: message, output: truncateWorkflowValue(value), port: route });
		if (route && !this.stopped && !this.options.onlyNode) {
			this.nodeOutputs[act.node.id] = value;
			act.region.lastOutput = value;
			this.log('warn', `${name} failed (${message}); continuing through "${route}"`, act.node.id, this.steps[act.step].id);
			this.route(act, [route], value);
			return;
		}
		if (this.options.onlyNode) {
			this.nodeOutputs[act.node.id] = value;
		}
		this.failRun(`${name}: ${message}`);
	}

	private async runStart(act: IActivation, type: IWorkflowNodeType): Promise<void> {
		await this.pace(type, this.cts.token);
		const output: WorkflowRecord = { payload: this.payload, inputs: this.inputs };
		this.succeed(act, output, ['next'], output);
	}

	private async runEnd(act: IActivation, type: IWorkflowNodeType, resolved: WorkflowRecord): Promise<void> {
		await this.pace(type, this.cts.token);
		const output = resolved.output ?? null;
		const outcome = resolved.status === 'failure' ? 'failure' : 'success';
		if (!this.endNodeId && !this.options.onlyNode) {
			// The first End reached decides the outcome; other branches still finish.
			this.endNodeId = act.node.id;
			this.outcome = outcome;
			this.log(outcome === 'failure' ? 'error' : 'info', `Reached ${nodeDisplayName(act.node)} (${outcome})`, act.node.id, this.steps[act.step].id);
		}
		this.succeed(act, output, [], output);
	}

	private async runIf(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, scope: IWorkflowScope): Promise<void> {
		const result = isTruthy(this.evaluate(config.condition, scope, 'Condition'));
		await this.pace(type, this.cts.token);
		this.succeed(act, { result }, [result ? 'true' : 'false'], act.input);
	}

	private async runSwitch(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, scope: IWorkflowScope): Promise<void> {
		const value = this.evaluate(config.value, scope, 'Value');
		const text = stringifyValue(value);
		const match = type.outputs(config).find(port => port.id !== 'default' && port.id === text)?.id ?? 'default';
		await this.pace(type, this.cts.token);
		this.succeed(act, { value, case: match }, [match], act.input);
	}

	private bodyOf(nodeId: string, port: string): ReadonlySet<string> {
		const key = `${nodeId}\u0000${port}`;
		let body = this.bodies.get(key);
		if (!body) {
			this.bodies.set(key, body = loopBody(this.definition, nodeId, port));
		}
		return body;
	}

	private async runLoop(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, scope: IWorkflowScope): Promise<void> {
		const { region, node } = act;
		let state = region.loops.get(node.id);
		const returning = !!state && !!act.via && this.backEdges.has(act.via.id);
		if (!state || !returning) {
			state = { iteration: 0, entryFrame: act.frame };
			region.loops.set(node.id, state);
		} else {
			state.iteration++;
		}
		const max = clampInt(config.max, 1, 1000, 3);
		const loop: WorkflowRecord = { index: state.iteration, iteration: state.iteration + 1, max };
		let repeat = state.iteration < max;
		if (repeat && typeof config.while === 'string' && config.while.trim()) {
			repeat = isTruthy(this.evaluate(config.while, { ...scope, loop }, 'While'));
		}
		this.updateStep(act.step, { iteration: state.iteration });
		await this.pace(type, this.cts.token);
		if (repeat) {
			// A fresh pass: forget the body's edge and join state from the last one.
			const body = this.bodyOf(node.id, 'repeat');
			for (const id of body) {
				for (const edge of this.incoming.get(id) ?? []) {
					region.edgeState.delete(edge.id);
				}
				region.joins.delete(id);
				region.joinRound.delete(id);
				if (id !== node.id) {
					region.loops.delete(id);
				}
			}
			this.log('debug', `${nodeDisplayName(node)}: pass ${state.iteration + 1} of ${max}`, node.id, this.steps[act.step].id);
			this.succeed(act, { iteration: state.iteration + 1, max }, ['repeat'], act.input, { frame: { ...state.entryFrame, loop }, keep: ['exhausted'] });
		} else {
			region.loops.delete(node.id);
			this.succeed(act, { iteration: state.iteration, max }, ['exhausted'], act.input, { frame: state.entryFrame });
		}
	}

	private async runForEach(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, resolved: WorkflowRecord, scope: IWorkflowScope): Promise<void> {
		const { node } = act;
		// A bare expression (`nodes.find.files`) is evaluated; templates and YAML lists are already resolved.
		const raw = config.items;
		const value = typeof raw === 'string' && raw.trim() && !hasTemplates(raw) ? this.evaluate(raw, scope, 'Items') : resolved.items;
		const all = workflowItemsList(value);
		if (!all) {
			throw new WorkflowNodeError(`Items must be a list, not ${isRecord(value) ? 'a map' : typeof value}`);
		}
		const maxItems = clampInt(config.maxItems, 1, 1000, 50);
		const items = all.slice(0, maxItems);
		if (all.length > maxItems) {
			this.log('warn', `${nodeDisplayName(node)}: ${all.length} items, running the first ${maxItems}`, node.id, this.steps[act.step].id);
		}
		await this.pace(type, this.cts.token);
		const body = this.bodyOf(node.id, 'item');
		const edges = (this.outgoing.get(node.id) ?? []).filter(edge => edge.port === 'item');
		const results: WorkflowValue[] = [];
		// Execute step on a for-each resolves its items without running the body.
		for (let index = 0; index < (this.options.onlyNode ? 0 : items.length); index++) {
			if (this.stopped) {
				return;
			}
			const pass = WorkflowExecution.region(body, node.id);
			const frame: IFrame = { ...act.frame, item: items[index], loop: { index, iteration: index + 1, max: items.length } };
			const idle = new Promise<void>(resolve => pass.onIdle = resolve);
			pass.active++;
			for (const edge of edges) {
				this.deliver(pass, edge, items[index], frame);
			}
			this.finishActivation(pass);
			await idle;
			if (this.stopped) {
				return;
			}
			results.push(pass.returned.length ? pass.returned[pass.returned.length - 1] : pass.lastOutput ?? null);
		}
		const output: WorkflowRecord = { items, results, count: items.length };
		this.succeed(act, output, ['done'], output);
	}

	private async runFork(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord): Promise<void> {
		await this.pace(type, this.cts.token);
		const ports = type.outputs(config).map(port => port.id);
		this.succeed(act, { branches: ports.length }, ports, act.input);
	}

	private async runWait(act: IActivation, resolved: WorkflowRecord): Promise<void> {
		const ms = parseWorkflowDuration(resolved.duration);
		if (ms === undefined) {
			throw new WorkflowNodeError(`Not a duration: ${stringifyValue(resolved.duration)}`);
		}
		// Simulations compress waits so the canvas does not sit still for minutes.
		const speed = this.options.simulation?.speed ?? 1;
		const waitMs = this.mode === 'simulate' ? Math.min(ms, SIMULATED_WAIT_CAP_MS) * Math.max(0, speed) : ms;
		this.updateStep(act.step, { state: 'waiting', waitingFor: `Timer (${formatWorkflowDuration(ms)})` });
		await this.delay(waitMs, this.cts.token);
		this.updateStep(act.step, { state: 'running', waitingFor: undefined });
		this.succeed(act, { waitedMs: waitMs }, ['next'], act.input);
	}

	private async runApproval(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, resolved: WorkflowRecord): Promise<void> {
		const { node } = act;
		const stepId = this.steps[act.step].id;
		const title = stringifyValue(resolved.title) || 'Approve to continue?';
		this.updateStep(act.step, { state: 'waiting', waitingFor: 'Approval' });
		this.log('info', `Waiting for approval: ${title}`, node.id, stepId);
		let decision: WorkflowApprovalDecision | 'timeout';
		const auto = this.mode === 'simulate' ? this.options.simulation?.autoApprove : undefined;
		if (auto) {
			await this.pace(type, this.cts.token);
			decision = auto;
		} else {
			const source = new CancellationTokenSource(this.cts.token);
			try {
				const contenders: Promise<WorkflowApprovalDecision | 'timeout'>[] = [
					new Promise<WorkflowApprovalDecision>(resolve => this.approvals.set(node.id, resolve)),
					this.host.requestApproval({ runId: this.runId, workflowId: this.definition.id, nodeId: node.id, stepId, title, detail: stringifyValue(resolved.detail) || undefined }, source.token),
				];
				const limit = parseWorkflowDuration(resolved.timeout);
				if (limit) {
					contenders.push(this.delay(limit, source.token).then(() => 'timeout' as const));
				}
				decision = await this.race(Promise.race(contenders), this.cts.token);
			} finally {
				this.approvals.delete(node.id);
				source.dispose(true);
			}
		}
		if (this.stopped) {
			throw new CancellationError();
		}
		this.updateStep(act.step, { state: 'running', waitingFor: undefined });
		const output: WorkflowRecord = { decision, decidedAt: this.now() };
		if (decision === 'approve') {
			this.succeed(act, output, ['approved'], act.input);
		} else {
			this.failNode(act, type, config, decision === 'timeout' ? 'No decision before the timeout' : 'Rejected', output, 'rejected');
		}
	}

	private async runSetVariables(act: IActivation, type: IWorkflowNodeType, resolved: WorkflowRecord): Promise<void> {
		const values = keyValueRecord(resolved.variables);
		await this.pace(type, this.cts.token);
		Object.assign(this.variables, values);
		this.fire(run => ({ kind: 'run', run }));
		this.succeed(act, values, ['next'], act.input);
	}

	private async callSubworkflow(resolved: WorkflowRecord, token: CancellationToken): Promise<IWorkflowNodeResult> {
		const workflowId = stringifyValue(resolved.workflow).trim();
		if (!workflowId) {
			throw new WorkflowNodeError('No workflow selected');
		}
		if (this.depth + 1 > WORKFLOW_MAX_DEPTH) {
			throw new WorkflowNodeError(`Sub-workflows nest at most ${WORKFLOW_MAX_DEPTH} deep`);
		}
		const child = await this.host.runSubworkflow(workflowId, keyValueRecord(resolved.inputs), { runId: this.runId, depth: this.depth + 1, mode: this.mode }, token);
		const endOutput = child.steps.find(step => step.nodeId === child.endNodeId && step.state === 'success')?.output ?? null;
		const output: WorkflowRecord = { runId: child.id, status: child.status, outcome: child.outcome ?? null, output: endOutput, ...(child.error ? { error: child.error } : {}) };
		return { output, port: child.status === 'succeeded' ? 'done' : 'failed', tokens: child.tokens };
	}

	private addTokens(a: IWorkflowTokenUsage | undefined, b: IWorkflowTokenUsage): IWorkflowTokenUsage {
		const costUsd = a?.costUsd !== undefined || b.costUsd !== undefined ? (a?.costUsd ?? 0) + (b.costUsd ?? 0) : undefined;
		return { input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output, ...(costUsd !== undefined ? { costUsd } : {}) };
	}

	/** One attempt of a task node: simulated (pinned, injected failure, `simulate`), pure, or the executor. */
	private async attemptTask(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, scope: IWorkflowScope, attempt: number, token: CancellationToken): Promise<IWorkflowNodeResult> {
		const { node } = act;
		const stepId = this.steps[act.step].id;
		const context: IWorkflowNodeContext = {
			runId: this.runId,
			mode: this.mode,
			workflow: this.definition,
			node,
			type,
			config,
			input: act.input,
			scope,
			attempt,
			stepId,
			token,
			log: (level, message) => this.log(level, message, node.id, stepId),
			setVariable: (name, value) => {
				this.variables[name] = value;
				this.fire(run => ({ kind: 'run', run }));
			},
			reportTokens: usage => this.updateStep(act.step, { tokens: this.addTokens(this.steps[act.step].tokens, usage) }),
			reportThread: threadId => this.updateStep(act.step, { threadId }),
			waiting: reason => {
				this.updateStep(act.step, { state: 'waiting', waitingFor: reason });
				let disposed = false;
				return {
					dispose: () => {
						if (!disposed && this.steps[act.step].state === 'waiting') {
							this.updateStep(act.step, { state: 'running', waitingFor: undefined });
						}
						disposed = true;
					}
				};
			},
		};
		if (this.mode === 'simulate') {
			await this.pace(type, token);
			if (node.pinnedOutput !== undefined) {
				const ports = type.outputs(config);
				const verdict = isRecord(node.pinnedOutput) && typeof node.pinnedOutput.verdict === 'string' ? node.pinnedOutput.verdict : undefined;
				return { output: node.pinnedOutput, port: ports.find(port => port.id === verdict)?.id };
			}
			if (this.options.simulation?.failNodes?.includes(node.id)) {
				const failure = type.outputs(config).find(port => port.kind === 'failure');
				if (failure) {
					return { output: { error: 'Simulated failure' }, port: failure.id };
				}
				throw new WorkflowNodeError('Simulated failure');
			}
			return type.simulate ? await type.simulate(context) : { output: {} };
		}
		if (type.pure) {
			return type.simulate ? await type.simulate(context) : { output: {} };
		}
		const executor = this.host.executor(type.type);
		if (!executor) {
			throw new WorkflowNodeError(`No executor for ${type.label} nodes: this node cannot run for real here`);
		}
		return executor.execute(context);
	}

	/** Runs attempts under the node's slot, timeout and retry policy, then routes the result. */
	private async runTask(act: IActivation, type: IWorkflowNodeType, config: WorkflowRecord, resolved: WorkflowRecord, attemptFn: (attempt: number, token: CancellationToken) => Promise<IWorkflowNodeResult>): Promise<void> {
		this.updateStep(act.step, { state: 'queued' });
		await this.acquireSlot();
		let result: AttemptResult;
		try {
			if (this.stopped) {
				throw new CancellationError();
			}
			this.updateStep(act.step, { state: 'running' });
			result = await this.attempts(act, attemptFn);
		} finally {
			this.releaseSlot();
		}
		if ('error' in result) {
			return this.failNode(act, type, config, result.error, result.output, undefined);
		}
		const ports = type.outputs(resolved);
		const port = result.ok.port ?? ports[0]?.id;
		const def = ports.find(candidate => candidate.id === port);
		if (port !== undefined && !def) {
			return this.failNode(act, type, config, `Finished through "${port}", which is not an output of this node`, result.ok.output, undefined);
		}
		const output = result.ok.output ?? null;
		if (result.ok.tokens) {
			this.updateStep(act.step, { tokens: this.addTokens(this.steps[act.step].tokens, result.ok.tokens) });
		}
		if (def?.kind === 'failure') {
			const error = isRecord(output) && typeof output.error === 'string' ? output.error : `Finished through "${def.label}"`;
			return this.failNode(act, type, config, error, output, def.id);
		}
		this.succeed(act, output, port === undefined ? [] : [port], output);
	}

	private async attempts(act: IActivation, attemptFn: (attempt: number, token: CancellationToken) => Promise<IWorkflowNodeResult>): Promise<AttemptResult> {
		const { node } = act;
		const maxAttempts = 1 + clampInt(node.retry?.attempts, 0, MAX_RETRY_ATTEMPTS, 0);
		const baseDelay = Math.max(0, node.retry?.delayMs ?? RETRY_DELAY_MS);
		const maxDelay = Math.max(baseDelay, node.retry?.maxDelayMs ?? RETRY_MAX_DELAY_MS);
		const timeoutMs = node.timeoutMs && node.timeoutMs > 0 ? node.timeoutMs : undefined;
		for (let attempt = 1; ; attempt++) {
			if (attempt > 1) {
				this.updateStep(act.step, { attempt });
			}
			const source = new CancellationTokenSource(this.cts.token);
			try {
				const contenders: Promise<IWorkflowNodeResult>[] = [attemptFn(attempt, source.token)];
				if (timeoutMs) {
					contenders.push(new Promise<never>((_, reject) => this.delay(timeoutMs, source.token).then(() => reject(new TimeoutError()), () => { })));
				}
				return { ok: await this.race(Promise.race(contenders), this.cts.token) };
			} catch (error) {
				if (this.stopped || (isCancellationError(error) && this.cts.token.isCancellationRequested)) {
					throw error instanceof CancellationError ? error : new CancellationError();
				}
				const timedOut = error instanceof TimeoutError;
				const message = timedOut ? `Timed out after ${formatWorkflowDuration(timeoutMs!)}` : messageOf(error);
				const retryable = timedOut || (error instanceof WorkflowNodeError && error.retryable);
				if (retryable && attempt < maxAttempts) {
					const wait = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
					this.log('warn', `${nodeDisplayName(node)}: attempt ${attempt} failed (${message}); retrying in ${formatWorkflowDuration(wait)}`, node.id, this.steps[act.step].id);
					source.dispose(true);
					await this.delay(wait, this.cts.token);
					continue;
				}
				return { error: message, output: error instanceof WorkflowNodeError ? error.output : undefined };
			} finally {
				// Cancels the attempt's token (a timed-out executor) and its pending timeout.
				source.dispose(true);
			}
		}
	}

	//#endregion
}
