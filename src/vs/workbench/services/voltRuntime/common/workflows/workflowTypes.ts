/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/**
 * Workflows: a graph of nodes (agents, checks, git steps, branches, loops) started by a trigger,
 * stored as versioned YAML. This file is the shared contract: the typed definition the YAML maps
 * to, the node type registry's shape, the engine's run records and events, and the service the
 * builder, the automations and the agent tools talk to. Everything here is pure.
 *
 * Canonical form: YAML (`workflowYaml.ts` + `workflowSchema.ts`). The canvas, the inspector and the
 * YAML editor all edit an `IWorkflowDefinition`; saving serializes it back.
 */

/** The `version:` a workflow file declares. Older versions are migrated on read (`workflowSchema.ts`). */
export const WORKFLOW_SCHEMA_VERSION = 1;

/** Node and edge ids: lower-case letters, digits, `_` and `-`, starting with a letter. */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Nesting limit for sub-workflow calls (a workflow calling itself stops here). */
export const WORKFLOW_MAX_DEPTH = 5;
/** Default and hard cap of node executions per run (loops count every pass). */
export const WORKFLOW_DEFAULT_MAX_STEPS = 200;
export const WORKFLOW_HARD_MAX_STEPS = 2000;
/** Default parallel node executions per run (fork branches, independent paths). */
export const WORKFLOW_DEFAULT_CONCURRENCY = 4;

//#region Definition

/** JSON-like values: what YAML scalars, lists and maps parse to. */
export type WorkflowValue = string | number | boolean | null | readonly WorkflowValue[] | { readonly [key: string]: WorkflowValue };
export type WorkflowRecord = { readonly [key: string]: WorkflowValue };

/** Node accent colours; the UI maps each to theme-aware Volt colours, never raw hex in YAML. */
export type WorkflowNodeColor = 'default' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'teal';
export const WORKFLOW_NODE_COLORS: readonly WorkflowNodeColor[] = ['default', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'teal'];

export interface IWorkflowPosition {
	readonly x: number;
	readonly y: number;
}

export interface IWorkflowRetryPolicy {
	/** Extra attempts after the first (0 = no retry). */
	readonly attempts: number;
	/** Delay before the first retry; doubles each time up to `maxDelayMs`. */
	readonly delayMs?: number;
	readonly maxDelayMs?: number;
}

/**
 * What a thrown node error does. Unset: a wired failure-kind port catches it (like `route`), else
 * the run fails; so a node's `failed` edge works without any setting.
 */
export type WorkflowErrorMode =
	/** The run fails, even when a failure port is wired. */
	| 'fail'
	/** The node is marked failed and the run continues down its first output port. */
	| 'continue'
	/** The run continues down the node's `failed` port (nodes without one behave like `fail`). */
	| 'route';

export interface IWorkflowNode {
	readonly id: string;
	/** A registered node type (`IWorkflowNodeType.type`): `start`, `agent`, `if`, `shell`, … */
	readonly type: string;
	/** Display name; the type's label when absent. */
	readonly name?: string;
	readonly position: IWorkflowPosition;
	readonly color?: WorkflowNodeColor;
	/** Disabled nodes are skipped (state `skipped`) and pass their input through their first port. */
	readonly disabled?: boolean;
	readonly notes?: string;
	/** The type's typed configuration (see its `fields`). Values may hold `{{ … }}` templates. */
	readonly config: WorkflowRecord;
	readonly retry?: IWorkflowRetryPolicy;
	readonly timeoutMs?: number;
	readonly onError?: WorkflowErrorMode;
	/** Output used instead of running the node in simulations and single-node runs. */
	readonly pinnedOutput?: WorkflowValue;
}

export interface IWorkflowEdge {
	/** Stable id; `<from>.<port>-><to>` when the YAML gives none. */
	readonly id: string;
	readonly from: string;
	/** An output port of `from` (see the type's `outputs`). */
	readonly port: string;
	readonly to: string;
	/** An input port of `to`; `in` when absent. */
	readonly toPort?: string;
	readonly label?: string;
}

/** A titled, coloured frame around nodes (n8n-style section). */
export interface IWorkflowGroup {
	readonly id: string;
	readonly title: string;
	readonly color?: WorkflowNodeColor;
	readonly nodes: readonly string[];
}

export type WorkflowTriggerType = 'manual' | 'schedule' | 'event';

/**
 * What starts the workflow. `manual`: Run in the builder, a chat or an automation. `schedule` and
 * `event` are carried out by a linked automation (one scheduler, one webhook path for both).
 */
export interface IWorkflowTrigger {
	readonly type: WorkflowTriggerType;
	/** schedule: a five-field cron expression or macro (`*\/5 * * * *`, `@daily`). */
	readonly cron?: string;
	/** schedule: every N minutes (alternative to `cron`). */
	readonly everyMinutes?: number;
	/** schedule: IANA zone (`Europe/Berlin`); local time when absent. */
	readonly timezone?: string;
	/** event: an `AutomationProvider` (`github`, `slack`, `webhook`, …). */
	readonly provider?: string;
	/** event: an event of that provider (`pr.opened`). */
	readonly event?: string;
	/** event: narrows the event (branch, channel, label). */
	readonly option?: string;
	/** event: payload filters, one `path op value` each (see `automationWebhooks.ts`). */
	readonly filters?: readonly string[];
	/** Sample payload for simulations and the Input tab of the start node. */
	readonly samplePayload?: WorkflowValue;
}

export type WorkflowInputType = 'string' | 'number' | 'boolean' | 'json';

export interface IWorkflowInputDef {
	readonly name: string;
	readonly type: WorkflowInputType;
	readonly description?: string;
	readonly default?: WorkflowValue;
	readonly required?: boolean;
}

export interface IWorkflowSettings {
	readonly concurrency?: number;
	readonly maxSteps?: number;
	/** Whole-run timeout. */
	readonly timeoutMs?: number;
	/** Stored URI string of the folder agent, shell and git nodes work in. */
	readonly repository?: string;
	/** Default model (catalog ref) of agent nodes that set none. */
	readonly modelRef?: string;
}

export type WorkflowSourceKind = 'blank' | 'template' | 'community' | 'import' | 'describe';

/** Where a workflow came from. Community and imported workflows stay untrusted until reviewed. */
export interface IWorkflowSource {
	readonly kind: WorkflowSourceKind;
	/** The YAML's URL (raw GitHub URL for community templates). */
	readonly url?: string;
	/** Commit or content hash the copy was made from (updates compare against it). */
	readonly sha?: string;
	readonly templateId?: string;
}

export interface IWorkflowDefinition {
	readonly version: number;
	/** Slug, unique among the user's workflows; the file name. */
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/** Bumped on every save; history keeps earlier revisions. */
	readonly revision?: number;
	readonly tags?: readonly string[];
	readonly trigger: IWorkflowTrigger;
	readonly inputs?: readonly IWorkflowInputDef[];
	/** Initial run variables (`{{ vars.name }}`); Set Variable nodes change them during a run. */
	readonly variables?: WorkflowRecord;
	readonly settings?: IWorkflowSettings;
	readonly nodes: readonly IWorkflowNode[];
	readonly edges: readonly IWorkflowEdge[];
	readonly groups?: readonly IWorkflowGroup[];
	readonly source?: IWorkflowSource;
}

//#endregion

//#region Validation

export type WorkflowIssueSeverity = 'error' | 'warning' | 'info';

export interface IWorkflowIssue {
	readonly severity: WorkflowIssueSeverity;
	readonly message: string;
	/** Stable machine code (`unknown-node-type`, `cycle`, `yaml-syntax`, …). */
	readonly code: string;
	readonly nodeId?: string;
	readonly edgeId?: string;
	/** The config field the issue is about. */
	readonly field?: string;
	/** YAML location (1-based), when the issue came from a file. */
	readonly line?: number;
	readonly column?: number;
	/** JSON-pointer-like path into the document (`nodes[2].config.prompt`). */
	readonly path?: string;
}

//#endregion

//#region Node types

export type WorkflowNodeCategory = 'trigger' | 'ai' | 'flow' | 'scripts' | 'git' | 'mcp' | 'skills' | 'integrations' | 'data' | 'outputs' | 'custom';

export const WORKFLOW_NODE_CATEGORIES: readonly { readonly id: WorkflowNodeCategory; readonly label: string }[] = [
	{ id: 'trigger', label: 'Triggers' },
	{ id: 'ai', label: 'AI Agents' },
	{ id: 'flow', label: 'Flow Control' },
	{ id: 'scripts', label: 'Scripts & Checks' },
	{ id: 'git', label: 'Git & GitHub' },
	{ id: 'mcp', label: 'MCP' },
	{ id: 'skills', label: 'Skills' },
	{ id: 'integrations', label: 'Integrations' },
	{ id: 'data', label: 'Data' },
	{ id: 'outputs', label: 'Outputs' },
	{ id: 'custom', label: 'Custom Tools' },
];

/** What a node needs to run for real. Untrusted workflows ask before using any of these. */
export type WorkflowPermission = 'agent' | 'shell' | 'network' | 'git' | 'filesystem' | 'messaging';

export type WorkflowPortKind = 'neutral' | 'success' | 'failure' | 'loop';

export interface IWorkflowPortDef {
	readonly id: string;
	readonly label: string;
	readonly kind?: WorkflowPortKind;
	readonly description?: string;
}

export type WorkflowFieldKind =
	| 'text' | 'multiline' | 'number' | 'boolean' | 'select' | 'duration'
	/** Rich prompt: templates, `/` skills, `@` tools (the composer-like editor). */
	| 'prompt'
	/** A `{{ }}`-free safe expression (`workflowExpressions.ts`), e.g. an If condition. */
	| 'expression'
	/** Catalog model ref, picked with the composer's model picker. */
	| 'model'
	| 'skill' | 'mcpServer' | 'workflow' | 'repository' | 'cron'
	/** Ordered `key: value` pairs (HTTP headers, variables). */
	| 'keyValue'
	/** A list of strings (switch cases, verdicts). */
	| 'list'
	/** JSON / YAML-ish structured value (request body, mock payload). */
	| 'json'
	/** Multi-line text shown with a code font (shell command). Never evaluated as code by Volt. */
	| 'code';

export interface IWorkflowFieldOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface IWorkflowFieldDef {
	readonly key: string;
	readonly label: string;
	readonly kind: WorkflowFieldKind;
	readonly description?: string;
	readonly placeholder?: string;
	readonly required?: boolean;
	readonly default?: WorkflowValue;
	readonly options?: readonly IWorkflowFieldOption[];
	readonly min?: number;
	readonly max?: number;
	/** `{{ … }}` templates are resolved before the node runs. */
	readonly templates?: boolean;
	/** Shown under "Advanced" in the inspector. */
	readonly advanced?: boolean;
	/** Display language for `code` / `json` fields (`shellscript`, `json`). */
	readonly language?: string;
	/** Shown only when another field has one of these values. */
	readonly visibleWhen?: { readonly key: string; readonly equals: readonly WorkflowValue[] };
}

/** An output a node produces, for `{{ nodes.<id>.<key> }}` and the inspector's "Outputs for templates". */
export interface IWorkflowOutputDef {
	readonly key: string;
	readonly description: string;
}

/** How the engine treats the node; `task` nodes run through an executor. */
export type WorkflowControlKind = 'task' | 'start' | 'end' | 'if' | 'switch' | 'loop' | 'forEach' | 'fork' | 'join' | 'wait' | 'approval' | 'subworkflow' | 'setVariables';

export type WorkflowNodeShape = 'card' | 'round' | 'pill';

export interface IWorkflowNodeType {
	readonly type: string;
	readonly category: WorkflowNodeCategory;
	/** Submenu inside the category in pickers ("GitHub", "Slack"). */
	readonly group?: string;
	readonly label: string;
	readonly description: string;
	/** A codicon id (`robot`, `git-pull-request`); the UI renders it with `ThemeIcon.fromId`. */
	readonly icon: string;
	readonly color?: WorkflowNodeColor;
	readonly shape?: WorkflowNodeShape;
	readonly keywords?: string;
	/** Badge in pickers ("MCP", "Beta"). */
	readonly badge?: string;
	readonly control: WorkflowControlKind;
	/** Input ports; empty for start nodes. Most nodes have one `in`. */
	readonly inputs: readonly IWorkflowPortDef[];
	/** Output ports for a given config (If: true/false, Switch: its cases, Agent: verdicts + done/failed). */
	outputs(config: WorkflowRecord): readonly IWorkflowPortDef[];
	readonly fields: readonly IWorkflowFieldDef[];
	readonly outputDocs: readonly IWorkflowOutputDef[];
	readonly permissions: readonly WorkflowPermission[];
	/** Only one per workflow (start). */
	readonly singleton?: boolean;
	/** Hidden from pickers (legacy types kept for old files). */
	readonly hidden?: boolean;
	/** No side effects: real runs use `simulate` too (transform, filter, template, log). */
	readonly pure?: boolean;
	/** One line under the node's title on the canvas ("claude · /review"). */
	summary?(config: WorkflowRecord): string | undefined;
	/** Type-specific checks beyond required fields and kinds. */
	validate?(node: IWorkflowNode, definition: IWorkflowDefinition): readonly IWorkflowIssue[];
	/** The node's result in a simulation (no side effects). Defaults to the pinned output or `{}`. */
	simulate?(context: IWorkflowNodeContext): IWorkflowNodeResult | Promise<IWorkflowNodeResult>;
}

//#endregion

//#region Runs

export type WorkflowNodeState = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting' | 'cancelled';
export type WorkflowRunMode = 'simulate' | 'execute';
export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IWorkflowTokenUsage {
	readonly input: number;
	readonly output: number;
	readonly costUsd?: number;
}

export interface IWorkflowLogEntry {
	readonly at: number;
	readonly level: WorkflowLogLevel;
	readonly message: string;
	readonly nodeId?: string;
	readonly stepId?: string;
}

/** One execution of one node (a loop runs a node several times: several steps). */
export interface IWorkflowStepRecord {
	/** `<nodeId>#<n>`, n counting this node's executions in the run. */
	readonly id: string;
	readonly nodeId: string;
	readonly attempt: number;
	/** Loop / for-each pass this step belongs to (0-based), when inside one. */
	readonly iteration?: number;
	readonly state: WorkflowNodeState;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly input?: WorkflowValue;
	/** The node's config with templates resolved, as it ran. */
	readonly resolvedConfig?: WorkflowRecord;
	readonly output?: WorkflowValue;
	/** The output port the run left through. */
	readonly port?: string;
	readonly error?: string;
	readonly tokens?: IWorkflowTokenUsage;
	/** The chat an agent node ran in. */
	readonly threadId?: string;
	/** Waiting nodes: what they wait for ("Approval", "CI checks"). */
	readonly waitingFor?: string;
}

export type WorkflowTriggerKind = 'manual' | 'schedule' | 'event' | 'automation' | 'subworkflow' | 'agent';

export interface IWorkflowRunTrigger {
	readonly kind: WorkflowTriggerKind;
	readonly label?: string;
	readonly payload?: WorkflowValue;
	readonly automationId?: string;
	readonly automationRunId?: string;
	readonly parentRunId?: string;
	/** Stored URI string of the folder this run works in (the automation's repository); else `settings.repository`. */
	readonly repository?: string;
}

export interface IWorkflowRun {
	readonly id: string;
	readonly workflowId: string;
	readonly workflowName: string;
	readonly revision?: number;
	readonly mode: WorkflowRunMode;
	readonly status: WorkflowRunStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly trigger: IWorkflowRunTrigger;
	readonly inputs: WorkflowRecord;
	readonly steps: readonly IWorkflowStepRecord[];
	readonly variables: WorkflowRecord;
	readonly logs: readonly IWorkflowLogEntry[];
	readonly tokens?: IWorkflowTokenUsage;
	readonly error?: string;
	/** The End node that finished the run, and what it declared. */
	readonly endNodeId?: string;
	readonly outcome?: 'success' | 'failure';
	/** Edge ids traversed, in order (the canvas animates them). */
	readonly traversed: readonly string[];
	readonly depth?: number;
}

export type WorkflowRunEvent =
	| { readonly kind: 'run'; readonly run: IWorkflowRun }
	| { readonly kind: 'step'; readonly run: IWorkflowRun; readonly step: IWorkflowStepRecord }
	| { readonly kind: 'edge'; readonly run: IWorkflowRun; readonly edgeId: string }
	| { readonly kind: 'log'; readonly run: IWorkflowRun; readonly entry: IWorkflowLogEntry };

/** What expressions and templates can read: `inputs.*`, `trigger.*`, `nodes.<id>.*`, `vars.*`, `item`, `loop`. */
export interface IWorkflowScope {
	readonly inputs: WorkflowRecord;
	readonly trigger: WorkflowValue;
	/** Last output of each node that ran. */
	readonly nodes: { readonly [nodeId: string]: WorkflowValue };
	readonly vars: WorkflowRecord;
	/** For-each: the current item. */
	readonly item?: WorkflowValue;
	/** Loop / for-each: `{ index, iteration, max }`. */
	readonly loop?: WorkflowRecord;
	readonly run: { readonly id: string; readonly mode: WorkflowRunMode; readonly workflowId: string };
	/** The node's upstream output (`{{ input.summary }}`); same as the context's `input`. Added by the engine workstream. */
	readonly input?: WorkflowValue;
}

export interface IWorkflowNodeContext {
	readonly runId: string;
	readonly mode: WorkflowRunMode;
	readonly workflow: IWorkflowDefinition;
	readonly node: IWorkflowNode;
	readonly type: IWorkflowNodeType;
	/** The node's config with `{{ }}` templates resolved against `scope`. */
	readonly config: WorkflowRecord;
	/** Upstream output: the previous node's output, or a record by node id after a join. */
	readonly input: WorkflowValue;
	readonly scope: IWorkflowScope;
	readonly attempt: number;
	readonly stepId: string;
	readonly token: CancellationToken;
	log(level: WorkflowLogLevel, message: string): void;
	setVariable(name: string, value: WorkflowValue): void;
	reportTokens(usage: IWorkflowTokenUsage): void;
	reportThread(threadId: string): void;
	/** Marks the step `waiting` (with a reason) until the returned disposable is disposed. */
	waiting(reason: string): IDisposable;
}

export interface IWorkflowNodeResult {
	readonly output?: WorkflowValue;
	/** The output port to leave through; the first port when absent. */
	readonly port?: string;
	readonly tokens?: IWorkflowTokenUsage;
}

/** Thrown by executors: `retryable` failures are retried under the node's retry policy. */
export class WorkflowNodeError extends Error {
	constructor(message: string, readonly retryable = false, readonly output?: WorkflowValue) {
		super(message);
		this.name = 'WorkflowNodeError';
	}
}

/** Runs one `task` node for real. Control nodes (if, loop, join, …) are the engine's. */
export interface IWorkflowExecutor {
	execute(context: IWorkflowNodeContext): Promise<IWorkflowNodeResult>;
}

export type WorkflowApprovalDecision = 'approve' | 'reject';

export interface IWorkflowApprovalRequest {
	readonly runId: string;
	readonly workflowId: string;
	readonly nodeId: string;
	readonly stepId: string;
	readonly title: string;
	readonly detail?: string;
}

/** What the engine needs from its environment. Simulations pass simulated pieces. */
export interface IWorkflowEngineHost {
	/** The executor of a task node type in `execute` mode. */
	executor(type: string): IWorkflowExecutor | undefined;
	requestApproval(request: IWorkflowApprovalRequest, token: CancellationToken): Promise<WorkflowApprovalDecision>;
	/** Runs another saved workflow to completion (sub-workflow node). */
	runSubworkflow(workflowId: string, inputs: WorkflowRecord, parent: { readonly runId: string; readonly depth: number; readonly mode: WorkflowRunMode }, token: CancellationToken): Promise<IWorkflowRun>;
	now?(): number;
	/** Cancellable delay (wait nodes, retry backoff, simulated durations). */
	delay?(ms: number, token: CancellationToken): Promise<void>;
	newId?(): string;
}

export interface IWorkflowSimulationOptions {
	/** Nodes that fail in this simulation (to test error paths). */
	readonly failNodes?: readonly string[];
	/** 1 = default pacing (a few hundred ms per node so the canvas animates); 0 = instant. */
	readonly speed?: number;
	/** Trigger payload; the trigger's `samplePayload` when absent. */
	readonly payload?: WorkflowValue;
	/** Approval gates resolve to this without asking (default: ask). */
	readonly autoApprove?: WorkflowApprovalDecision;
}

export interface IWorkflowRunOptions {
	readonly mode: WorkflowRunMode;
	readonly runId?: string;
	readonly inputs?: WorkflowRecord;
	readonly trigger?: IWorkflowRunTrigger;
	readonly token?: CancellationToken;
	/** Pause before every node; `step()` runs one, `resume()` runs on. */
	readonly stepping?: boolean;
	/** Pause before these nodes. */
	readonly breakpoints?: readonly string[];
	/** Run only this node, with inputs taken from `previousRun` (Execute step). */
	readonly onlyNode?: string;
	/** Retry from this node: reuse `previousRun`'s outputs of everything before it. */
	readonly retryFrom?: string;
	readonly previousRun?: IWorkflowRun;
	readonly simulation?: IWorkflowSimulationOptions;
	readonly depth?: number;
}

/** A run in progress. `run` is an immutable snapshot replaced on every change. */
export interface IWorkflowExecution extends IDisposable {
	readonly run: IWorkflowRun;
	readonly onDidChange: Event<WorkflowRunEvent>;
	readonly done: Promise<IWorkflowRun>;
	readonly paused: boolean;
	cancel(): void;
	pause(): void;
	resume(): void;
	/** While paused: run the next ready node, then pause again. */
	step(): void;
	resolveApproval(nodeId: string, decision: WorkflowApprovalDecision): void;
}

//#endregion

//#region Templates

/** One entry of a template index (`workflow-templates/index.json` in a templates repository). */
export interface IWorkflowTemplateEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Path of the YAML inside the repository. */
	readonly path: string;
	readonly author?: string;
	readonly tags?: readonly string[];
	readonly icon?: string;
	/** Node types it uses (for the gallery's chips and permission preview). */
	readonly nodeTypes?: readonly string[];
	readonly permissions?: readonly WorkflowPermission[];
}

export interface IWorkflowTemplateIndex {
	readonly version: number;
	readonly templates: readonly IWorkflowTemplateEntry[];
}

/** A source of templates: Volt's official repository or one the user added. */
export interface IWorkflowTemplateSource {
	readonly id: string;
	readonly label: string;
	/** `https://github.com/<owner>/<repo>` (optionally `/tree/<ref>/<dir>`), or a raw URL of an index.json or a single .yaml. */
	readonly url: string;
	readonly official?: boolean;
}

//#endregion

//#region Service

export interface IWorkflowSummary {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly revision: number;
	readonly updatedAt: number;
	readonly trigger: IWorkflowTrigger;
	readonly nodeCount: number;
	readonly source?: IWorkflowSource;
	/** Automations that run it (linked, or picking it in their Workflow menu). */
	readonly automationIds: readonly string[];
	readonly lastRun?: { readonly id: string; readonly status: WorkflowRunStatus; readonly at: number; readonly mode: WorkflowRunMode };
	readonly trusted: boolean;
	readonly issues: number;
}

export interface IWorkflowRevision {
	readonly revision: number;
	readonly at: number;
	readonly message?: string;
}

export interface IWorkflowSaveResult {
	readonly definition?: IWorkflowDefinition;
	readonly issues: readonly IWorkflowIssue[];
}

export interface IWorkflowStartOptions extends Omit<IWorkflowRunOptions, 'token' | 'previousRun'> {
	/** Use this run's outputs for `onlyNode` / `retryFrom` (by id; the latest run when absent). */
	readonly previousRunId?: string;
}

export const IWorkflowService = createDecorator<IWorkflowService>('voltWorkflowService');

export interface IWorkflowService {
	readonly _serviceBrand: undefined;
	/** The list or a definition changed (here or in another window). */
	readonly onDidChange: Event<void>;
	/** Every live run's events, for the canvas, the run panel and automations. */
	readonly onDidChangeRun: Event<WorkflowRunEvent>;
	readonly whenReady: Promise<void>;

	list(): readonly IWorkflowSummary[];
	get(id: string): IWorkflowDefinition | undefined;
	/** The stored YAML text (comments kept as written). */
	getYaml(id: string): string | undefined;
	/** A new workflow with a start node, saved, from a seed. */
	create(seed?: Partial<IWorkflowDefinition>): Promise<IWorkflowDefinition>;
	/** Validates and writes the definition as YAML; bumps the revision and keeps the old one in history. */
	save(definition: IWorkflowDefinition, message?: string): Promise<IWorkflowSaveResult>;
	/** Parses and saves YAML text (the YAML editor's save, paste, import). No `id`: a new workflow. */
	saveYaml(yaml: string, id?: string): Promise<IWorkflowSaveResult>;
	/** Parses without saving: definition and issues (validation as you type, paste preview). */
	parse(yaml: string): IWorkflowSaveResult;
	serialize(definition: IWorkflowDefinition): string;
	duplicate(id: string): Promise<IWorkflowDefinition | undefined>;
	delete(id: string): Promise<void>;
	revisions(id: string): Promise<readonly IWorkflowRevision[]>;
	readRevision(id: string, revision: number): Promise<string | undefined>;

	/** Starts a run (simulation or for real). Untrusted workflows ask before an `execute` run. */
	start(workflow: string | IWorkflowDefinition, options: IWorkflowStartOptions): Promise<IWorkflowExecution>;
	/** The workflow's run in progress, if any. */
	activeExecution(workflowId: string): IWorkflowExecution | undefined;
	/** Recorded runs, newest first. */
	runs(workflowId: string): readonly IWorkflowRun[];
	getRun(runId: string): IWorkflowRun | undefined;
	clearRuns(workflowId: string): Promise<void>;

	/** Community and imported workflows run for real only once trusted (per content hash). */
	isTrusted(definition: IWorkflowDefinition): boolean;
	trust(definition: IWorkflowDefinition): Promise<void>;
}

//#endregion
