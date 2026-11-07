/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseCron } from '../automations/automationCron.js';
import { AUTOMATION_EVENTS, AUTOMATION_PROVIDERS, IAutomationEventNode } from '../automations/automationTriggers.js';
import { parseWebhookFilter } from '../automations/automationWebhooks.js';
import { autoLayout, validateWorkflow } from './workflowGraph.js';
import { getWorkflowNodeType, nodeOutputs } from './workflowNodes.js';
import {
	IWorkflowDefinition, IWorkflowEdge, IWorkflowGroup, IWorkflowInputDef, IWorkflowIssue, IWorkflowNode, IWorkflowPosition, IWorkflowRetryPolicy, IWorkflowSettings,
	IWorkflowSource, IWorkflowTrigger, WORKFLOW_HARD_MAX_STEPS, WORKFLOW_ID_PATTERN, WORKFLOW_NODE_COLORS, WORKFLOW_SCHEMA_VERSION, WorkflowErrorMode, WorkflowInputType,
	WorkflowIssueSeverity, WorkflowNodeColor, WorkflowRecord, WorkflowSourceKind, WorkflowTriggerType, WorkflowValue,
} from './workflowTypes.js';
import { IYamlParseResult, parseYaml, stringifyYaml } from './workflowYaml.js';

/**
 * YAML text to IWorkflowDefinition and back. Reading checks the shape with line numbers (unknown keys warn,
 * wrong types are errors), migrates older file versions, fills in defaults (manual trigger, edge
 * ports, a layout for nodes without a position) and appends the graph checks. Writing is
 * canonical: fixed key order, `from: node.port` edges, `[x, y]` positions, `|` blocks for prompts,
 * so a definition always gives the same text and files diff well.
 */

export interface IWorkflowParseResult {
	readonly definition?: IWorkflowDefinition;
	/** Syntax and shape issues, then `validateWorkflow`'s graph issues (with YAML lines where known). */
	readonly issues: readonly IWorkflowIssue[];
}

/** The comment at the top of every file Volt writes. */
export const WORKFLOW_FILE_HEADER = 'Volt workflow · https://github.com/LeulAria/volt/tree/main/workflow-templates';

type Path = readonly (string | number)[];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const TOP_KEYS = ['version', 'id', 'name', 'description', 'revision', 'tags', 'trigger', 'inputs', 'variables', 'settings', 'nodes', 'edges', 'groups', 'source'];
const TRIGGER_KEYS = ['type', 'cron', 'everyMinutes', 'timezone', 'provider', 'event', 'option', 'filters', 'samplePayload'];
const SCHEDULE_KEYS = ['cron', 'everyMinutes', 'timezone'];
const EVENT_KEYS = ['provider', 'event', 'option', 'filters'];
const INPUT_KEYS = ['name', 'type', 'description', 'default', 'required'];
const SETTINGS_KEYS = ['concurrency', 'maxSteps', 'timeoutMs', 'repository', 'modelRef'];
const NODE_KEYS = ['id', 'type', 'name', 'position', 'color', 'disabled', 'notes', 'config', 'retry', 'timeoutMs', 'onError', 'pinnedOutput'];
const EDGE_KEYS = ['from', 'to', 'port', 'toPort', 'label', 'id'];
const GROUP_KEYS = ['id', 'title', 'color', 'nodes'];
const SOURCE_KEYS = ['kind', 'url', 'sha', 'templateId'];
const RETRY_KEYS = ['attempts', 'delayMs', 'maxDelayMs'];

const TRIGGER_TYPES: readonly WorkflowTriggerType[] = ['manual', 'schedule', 'event'];
const INPUT_TYPES: readonly WorkflowInputType[] = ['string', 'number', 'boolean', 'json'];
const ERROR_MODES: readonly WorkflowErrorMode[] = ['fail', 'continue', 'route'];
const SOURCE_KINDS: readonly WorkflowSourceKind[] = ['blank', 'template', 'community', 'import', 'describe'];
/** Providers an event trigger can name (`schedule` is a trigger type of its own). */
const EVENT_PROVIDERS: readonly string[] = AUTOMATION_PROVIDERS.filter(provider => provider !== 'schedule');

/** Input names are read as `{{ inputs.<name> }}`, so they are identifiers. */
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RETRY_ATTEMPTS = 10;
const MAX_CONCURRENCY = 32;
const MAX_DELAY_MS = 3_600_000;
const MAX_TIMEOUT_MS = 7 * 86_400_000;
const MAX_EVERY_MINUTES = 31 * 24 * 60;

function isRecord(value: WorkflowValue | undefined): value is WorkflowRecord {
	return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: WorkflowValue | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** `nodes[2].config.prompt`; keys that are not identifiers in brackets. */
export function formatWorkflowPath(path: Path): string {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			out += `[${segment}]`;
		} else if (/^[A-Za-z_$][\w$-]*$/.test(segment)) {
			out += out ? `.${segment}` : segment;
		} else {
			out += `[${JSON.stringify(segment)}]`;
		}
	}
	return out;
}

/** A slug for ids: lower-case ASCII, `-` between words, starting with a letter. */
export function slugifyWorkflowId(text: string): string {
	let slug = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (slug && !/^[a-z]/.test(slug)) {
		slug = `w-${slug}`;
	}
	return slug.slice(0, 64).replace(/-+$/, '') || 'workflow';
}

/** The id an edge gets when the YAML gives none (`work.done->review`). */
export function defaultEdgeId(edge: Pick<IWorkflowEdge, 'from' | 'port' | 'to' | 'toPort'>): string {
	return `${edge.from}.${edge.port}->${edge.to}${edge.toPort && edge.toPort !== 'in' ? `.${edge.toPort}` : ''}`;
}

function eventLeaves(nodes: readonly IAutomationEventNode[]): string[] {
	return nodes.flatMap(node => [...(node.event ? [node.event] : []), ...(node.children ? eventLeaves(node.children) : [])]);
}

function isTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

function valueKind(value: WorkflowValue): string {
	return value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? 'a map' : typeof value === 'string' ? 'text' : typeof value;
}

function locateNearest(yaml: IYamlParseResult | undefined, path: Path): { readonly line: number; readonly column: number } | undefined {
	for (let length = path.length; yaml && length >= 0; length--) {
		const at = yaml.locate(path.slice(0, length));
		if (at) {
			return at;
		}
	}
	return undefined;
}

function located(issue: IWorkflowIssue, path: Path, yaml: IYamlParseResult | undefined): IWorkflowIssue {
	const at = issue.line === undefined ? locateNearest(yaml, path) : undefined;
	return {
		...issue,
		...(issue.path === undefined && path.length ? { path: formatWorkflowPath(path) } : {}),
		...(at ? { line: at.line, column: at.column } : {}),
	};
}

//#region Migrations

/**
 * Upgrades a document from an older file version one step at a time: entry `n` turns version n
 * into n + 1. Version 1 is the first format, so the table stays empty until the format changes;
 * a change adds an entry here and bumps `WORKFLOW_SCHEMA_VERSION`.
 */
export const WORKFLOW_MIGRATIONS: { readonly [fromVersion: number]: (document: WorkflowRecord) => WorkflowRecord } = {};

export function migrateWorkflowDocument(document: WorkflowRecord, version: number, migrations = WORKFLOW_MIGRATIONS, target = WORKFLOW_SCHEMA_VERSION): { readonly document?: WorkflowRecord; readonly error?: string } {
	let current = document;
	for (let from = version; from < target; from++) {
		const step = migrations[from];
		if (!step) {
			return { error: `No migration from workflow version ${from} to ${from + 1}` };
		}
		current = step(current);
	}
	return { document: version === target ? current : { ...current, version: target } };
}

//#endregion

//#region Reading

class DefinitionReader {
	readonly issues: IWorkflowIssue[] = [];
	/** Where each node and edge sits in the YAML lists (skipped entries shift definition indexes). */
	private readonly nodeIndex = new Map<string, number>();
	private readonly edgeIndex = new Map<string, number>();
	/** Nodes without a usable position: laid out after reading. */
	private readonly unplaced = new Set<string>();

	constructor(private readonly yaml: IYamlParseResult | undefined) { }

	read(raw: WorkflowValue): IWorkflowDefinition | undefined {
		if (!isRecord(raw)) {
			this.report('error', 'invalid-workflow', raw === null
				? 'The file is empty: a workflow needs at least a "name" and "nodes"'
				: `A workflow file is a map of keys (name, trigger, nodes, edges, …), not ${valueKind(raw)}`, []);
			return undefined;
		}
		const version = this.readVersion(raw);
		if (version === undefined) {
			return undefined;
		}
		const migrated = migrateWorkflowDocument(raw, version);
		if (!migrated.document) {
			this.report('error', 'migration-failed', migrated.error ?? 'This workflow version cannot be read', ['version']);
			return undefined;
		}
		const doc = migrated.document;
		this.unknownKeys(doc, TOP_KEYS, [], 'workflow');

		const name = this.text(doc, 'name', []);
		if (!name?.trim()) {
			this.report('error', 'missing-name', 'A workflow needs a "name"', name === undefined ? [] : ['name']);
		}
		const id = this.readId(doc, name);
		const nodes = this.readNodes(doc.nodes, ['nodes']);
		const definition: Mutable<IWorkflowDefinition> = {
			version: WORKFLOW_SCHEMA_VERSION,
			id,
			name: name ?? id,
			trigger: this.readTrigger(doc.trigger, ['trigger']),
			nodes,
			edges: this.readEdges(doc.edges, ['edges'], nodes),
		};
		const description = this.text(doc, 'description', []);
		if (description !== undefined) {
			definition.description = description;
		}
		const revision = this.integer(doc, 'revision', [], 0, Number.MAX_SAFE_INTEGER);
		if (revision !== undefined) {
			definition.revision = revision;
		}
		const tags = this.strings(doc, 'tags', []);
		if (tags) {
			definition.tags = tags;
		}
		const inputs = this.readInputs(doc.inputs, ['inputs']);
		if (inputs) {
			definition.inputs = inputs;
		}
		if (doc.variables !== undefined && doc.variables !== null) {
			if (isRecord(doc.variables)) {
				definition.variables = doc.variables;
			} else {
				this.report('error', 'invalid-variables', `"variables" is a map of names to starting values, not ${valueKind(doc.variables)}`, ['variables']);
			}
		}
		const settings = this.readSettings(doc.settings, ['settings']);
		if (settings) {
			definition.settings = settings;
		}
		const groups = this.readGroups(doc.groups, ['groups'], nodes);
		if (groups) {
			definition.groups = groups;
		}
		const source = this.readSource(doc.source, ['source']);
		if (source) {
			definition.source = source;
		}
		return this.place(definition);
	}

	/** `validateWorkflow`'s issues that the shape checks did not already report, located in the YAML. */
	graphIssues(definition: IWorkflowDefinition, reported: readonly IWorkflowIssue[]): IWorkflowIssue[] {
		let graph: readonly IWorkflowIssue[];
		try {
			graph = validateWorkflow(definition);
		} catch (error) {
			return [{ severity: 'warning', code: 'graph-check-failed', message: `The graph checks failed: ${error instanceof Error ? error.message : String(error)}` }];
		}
		const key = (issue: IWorkflowIssue) => `${issue.code}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}|${issue.field ?? ''}`;
		const seen = new Set(reported.map(key));
		return graph.filter(issue => !seen.has(key(issue))).map(issue => located(issue, this.graphIssuePath(issue), this.yaml));
	}

	private graphIssuePath(issue: IWorkflowIssue): Path {
		const nodeIndex = issue.nodeId !== undefined ? this.nodeIndex.get(issue.nodeId) : undefined;
		if (nodeIndex !== undefined) {
			if (!issue.field) {
				return ['nodes', nodeIndex];
			}
			return NODE_KEYS.includes(issue.field) ? ['nodes', nodeIndex, issue.field] : ['nodes', nodeIndex, 'config', issue.field];
		}
		const edgeIndex = issue.edgeId !== undefined ? this.edgeIndex.get(issue.edgeId) : undefined;
		if (edgeIndex !== undefined) {
			return ['edges', edgeIndex];
		}
		if (issue.field && TOP_KEYS.includes(issue.field)) {
			return [issue.field];
		}
		return [];
	}

	private place(definition: Mutable<IWorkflowDefinition>): IWorkflowDefinition {
		if (!this.unplaced.size) {
			return definition;
		}
		let layout: ReadonlyMap<string, IWorkflowPosition> | undefined;
		try {
			layout = autoLayout(definition, { only: this.unplaced });
		} catch {
			layout = undefined; // keep the placeholder positions; the canvas can lay out later
		}
		definition.nodes = definition.nodes.map(node => {
			const position = this.unplaced.has(node.id) ? layout?.get(node.id) : undefined;
			return position ? { ...node, position: { x: position.x, y: position.y } } : node;
		});
		return definition;
	}

	//#region Sections

	private readVersion(doc: WorkflowRecord): number | undefined {
		const value = doc.version;
		if (value === undefined || value === null) {
			this.report('info', 'missing-version', 'No "version": read as version 1', []);
			return 1;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
			this.report('error', 'invalid-version', `"version" must be a whole number (1 or more), not ${valueKind(value)}`, ['version']);
			return WORKFLOW_SCHEMA_VERSION;
		}
		if (value > WORKFLOW_SCHEMA_VERSION) {
			this.report('error', 'newer-version', `This workflow was made by a newer Volt (file version ${value}; this Volt reads up to version ${WORKFLOW_SCHEMA_VERSION}). Update Volt to open it.`, ['version']);
			return undefined;
		}
		return value;
	}

	private readId(doc: WorkflowRecord, name: string | undefined): string {
		const id = this.text(doc, 'id', []);
		if (id === undefined) {
			return slugifyWorkflowId(name ?? '');
		}
		if (!WORKFLOW_ID_PATTERN.test(id)) {
			const slug = slugifyWorkflowId(id);
			this.report('error', 'invalid-id', `"${id}" is not a valid workflow id: use lower-case letters, digits, "-" and "_", starting with a letter (like "${slug}")`, ['id']);
			return slug;
		}
		return id;
	}

	private readTrigger(raw: WorkflowValue | undefined, path: Path): IWorkflowTrigger {
		if (raw === undefined || raw === null) {
			return { type: 'manual' };
		}
		if (typeof raw === 'string') {
			if (raw === 'manual') {
				return { type: 'manual' };
			}
			this.report('error', 'invalid-trigger', TRIGGER_TYPES.includes(raw as WorkflowTriggerType)
				? `A ${raw} trigger needs its settings: write it as a map (type: ${raw}, ${raw === 'schedule' ? 'cron: \'0 9 * * *\'' : 'provider: github, event: pr.opened'})`
				: `Unknown trigger "${raw}": use manual, schedule or event`, path);
			return { type: 'manual' };
		}
		if (!isRecord(raw)) {
			this.report('error', 'invalid-trigger', `The trigger is a map (type: manual, schedule or event, and its settings), not ${valueKind(raw)}`, path);
			return { type: 'manual' };
		}
		this.unknownKeys(raw, TRIGGER_KEYS, path, 'trigger');
		const typeText = this.text(raw, 'type', path);
		let type: WorkflowTriggerType;
		if (typeText === undefined) {
			type = raw.cron !== undefined || raw.everyMinutes !== undefined ? 'schedule' : raw.provider !== undefined || raw.event !== undefined ? 'event' : 'manual';
		} else if (TRIGGER_TYPES.includes(typeText as WorkflowTriggerType)) {
			type = typeText as WorkflowTriggerType;
		} else {
			this.report('error', 'invalid-trigger-type', `Unknown trigger type "${typeText}": use manual, schedule or event`, [...path, 'type']);
			type = 'manual';
		}
		const trigger: Mutable<IWorkflowTrigger> = { type };

		const cron = this.text(raw, 'cron', path);
		if (cron !== undefined) {
			trigger.cron = cron;
			const error = parseCron(cron).error;
			if (error) {
				this.report('error', 'invalid-cron', `Invalid cron "${cron}": ${error}`, [...path, 'cron']);
			}
		}
		const everyMinutes = this.integer(raw, 'everyMinutes', path, 1, MAX_EVERY_MINUTES);
		if (everyMinutes !== undefined) {
			trigger.everyMinutes = everyMinutes;
		}
		const timezone = this.text(raw, 'timezone', path);
		if (timezone !== undefined) {
			trigger.timezone = timezone;
			if (!isTimeZone(timezone)) {
				this.report('error', 'invalid-timezone', `Unknown time zone "${timezone}": use an IANA name like Europe/Berlin or America/New_York`, [...path, 'timezone']);
			}
		}

		const provider = this.text(raw, 'provider', path);
		const knownProvider = provider !== undefined && EVENT_PROVIDERS.includes(provider);
		if (provider !== undefined) {
			trigger.provider = provider;
			if (!knownProvider) {
				this.report('error', 'invalid-provider', `Unknown event provider "${provider}": use ${EVENT_PROVIDERS.join(', ')}`, [...path, 'provider']);
			}
		}
		const event = this.text(raw, 'event', path);
		if (event !== undefined) {
			trigger.event = event;
			const known = knownProvider && provider !== 'webhook' ? eventLeaves(AUTOMATION_EVENTS[provider as keyof typeof AUTOMATION_EVENTS]) : undefined;
			if (known && !known.includes(event)) {
				this.report('warning', 'unknown-event', `"${event}" is not a ${provider} event Volt knows (${known.join(', ')})`, [...path, 'event']);
			}
		}
		const option = this.text(raw, 'option', path);
		if (option !== undefined) {
			trigger.option = option;
		}
		const filters = this.strings(raw, 'filters', path);
		if (filters) {
			trigger.filters = filters;
			filters.forEach((filter, index) => {
				if (!parseWebhookFilter(filter)) {
					this.report('error', 'invalid-filter', `Invalid filter "${filter}": write "path op value", like "payload.ref matches ^refs/tags/" (ops: =, !=, contains, matches, in, exists, missing)`, [...path, 'filters', index]);
				}
			});
		}
		if (raw.samplePayload !== undefined) {
			trigger.samplePayload = raw.samplePayload;
		}

		if (type === 'schedule') {
			if (trigger.cron === undefined && trigger.everyMinutes === undefined) {
				this.report('error', 'missing-schedule', 'A schedule trigger needs "cron" (like \'0 9 * * 1-5\') or "everyMinutes"', path);
			} else if (trigger.cron !== undefined && trigger.everyMinutes !== undefined) {
				this.report('warning', 'schedule-conflict', '"cron" and "everyMinutes" are both set; the cron expression is used', [...path, 'everyMinutes']);
			}
		}
		if (type === 'event') {
			if (provider === undefined) {
				this.report('error', 'missing-provider', `An event trigger needs a "provider" (${EVENT_PROVIDERS.join(', ')})`, path);
			} else if (knownProvider && provider !== 'webhook' && event === undefined) {
				this.report('error', 'missing-event', `An event trigger needs the ${provider} "event" it starts on`, path);
			}
		}
		for (const key of type === 'schedule' ? [] : SCHEDULE_KEYS) {
			if (raw[key] !== undefined) {
				this.report('warning', 'unused-trigger-field', `"${key}" only applies to schedule triggers`, [...path, key]);
			}
		}
		for (const key of type === 'event' ? [] : EVENT_KEYS) {
			if (raw[key] !== undefined) {
				this.report('warning', 'unused-trigger-field', `"${key}" only applies to event triggers`, [...path, key]);
			}
		}
		return trigger;
	}

	private readInputs(raw: WorkflowValue | undefined, path: Path): IWorkflowInputDef[] | undefined {
		if (raw === undefined || raw === null) {
			return undefined;
		}
		const entries: { readonly value: WorkflowValue; readonly path: Path; readonly name?: string }[] = [];
		if (Array.isArray(raw)) {
			raw.forEach((value, index) => entries.push({ value, path: [...path, index] }));
		} else if (isRecord(raw)) {
			// map form: `inputs: { task: string, retries: { type: number, default: 2 } }`
			for (const name of Object.keys(raw)) {
				entries.push({ value: raw[name], path: [...path, name], name });
			}
		} else {
			this.report('error', 'invalid-inputs', `"inputs" is a list of { name, type, description, default, required }, not ${valueKind(raw)}`, path);
			return undefined;
		}
		const inputs: IWorkflowInputDef[] = [];
		const names = new Set<string>();
		for (const entry of entries) {
			let value = entry.value;
			if (entry.name === undefined && typeof value === 'string') {
				value = { name: value };
			} else if (entry.name !== undefined && (value === null || typeof value === 'string')) {
				value = value === null ? {} : { type: value };
			}
			if (!isRecord(value)) {
				this.report('error', 'invalid-input', `Each input is a map (name, type, description, default, required), not ${valueKind(value)}`, entry.path);
				continue;
			}
			this.unknownKeys(value, INPUT_KEYS, entry.path, 'input');
			const name = entry.name ?? this.text(value, 'name', entry.path);
			if (!name) {
				this.report('error', 'missing-input-name', 'Each input needs a "name"', entry.path);
				continue;
			}
			if (!INPUT_NAME.test(name)) {
				this.report('error', 'invalid-input-name', `"${name}" cannot be an input name: use letters, digits and _ (templates read it as inputs.${name})`, entry.name === undefined ? [...entry.path, 'name'] : entry.path);
			}
			if (names.has(name)) {
				this.report('error', 'duplicate-input', `Another input is already named "${name}"`, entry.path);
				continue;
			}
			names.add(name);
			const typeText = this.text(value, 'type', entry.path);
			let type: WorkflowInputType = 'string';
			if (typeText !== undefined) {
				if (INPUT_TYPES.includes(typeText as WorkflowInputType)) {
					type = typeText as WorkflowInputType;
				} else {
					this.report('error', 'invalid-input-type', `Unknown input type "${typeText}": use string, number, boolean or json`, [...entry.path, 'type']);
				}
			}
			const input: Mutable<IWorkflowInputDef> = { name, type };
			const description = this.text(value, 'description', entry.path);
			if (description !== undefined) {
				input.description = description;
			}
			if (value.default !== undefined) {
				input.default = value.default;
				const fits = type === 'json' || value.default === null || typeof value.default === type;
				if (!fits) {
					this.report('warning', 'input-default-type', `The default of "${name}" is ${valueKind(value.default)}, but the input is a ${type}`, [...entry.path, 'default']);
				}
			}
			const required = this.boolean(value, 'required', entry.path);
			if (required !== undefined) {
				input.required = required;
			}
			inputs.push(input);
		}
		return inputs;
	}

	private readSettings(raw: WorkflowValue | undefined, path: Path): IWorkflowSettings | undefined {
		if (raw === undefined || raw === null) {
			return undefined;
		}
		if (!isRecord(raw)) {
			this.report('error', 'invalid-settings', `"settings" is a map (concurrency, maxSteps, timeoutMs, repository, modelRef), not ${valueKind(raw)}`, path);
			return undefined;
		}
		this.unknownKeys(raw, SETTINGS_KEYS, path, 'setting');
		const settings: Mutable<IWorkflowSettings> = {};
		const concurrency = this.integer(raw, 'concurrency', path, 1, MAX_CONCURRENCY);
		if (concurrency !== undefined) {
			settings.concurrency = concurrency;
		}
		const maxSteps = this.integer(raw, 'maxSteps', path, 1, WORKFLOW_HARD_MAX_STEPS);
		if (maxSteps !== undefined) {
			settings.maxSteps = maxSteps;
		}
		const timeoutMs = this.integer(raw, 'timeoutMs', path, 1, MAX_TIMEOUT_MS);
		if (timeoutMs !== undefined) {
			settings.timeoutMs = timeoutMs;
		}
		const repository = this.text(raw, 'repository', path);
		if (repository !== undefined) {
			settings.repository = repository;
		}
		const modelRef = this.text(raw, 'modelRef', path);
		if (modelRef !== undefined) {
			settings.modelRef = modelRef;
		}
		return settings;
	}

	private readNodes(raw: WorkflowValue | undefined, path: Path): IWorkflowNode[] {
		if (raw === undefined || raw === null) {
			this.report('error', 'missing-nodes', 'A workflow needs "nodes": a list with at least a start node', []);
			return [];
		}
		if (!Array.isArray(raw)) {
			this.report('error', 'invalid-nodes', `"nodes" is a list (- id: start, type: start, …), not ${valueKind(raw)}`, path);
			return [];
		}
		// ids written in the file, so a derived id never takes one a later node uses
		const written = new Set(raw.map(item => isRecord(item) && typeof item.id === 'string' ? item.id : undefined).filter((id): id is string => !!id));
		const nodes: IWorkflowNode[] = [];
		raw.forEach((item, index) => {
			const at = [...path, index];
			if (!isRecord(item)) {
				this.report('error', 'invalid-node', `Each node is a map with at least "id" and "type", not ${valueKind(item)}`, at);
				return;
			}
			const type = this.text(item, 'type', at);
			let id = this.text(item, 'id', at);
			if (!type) {
				this.report('error', 'missing-node-type', `Node ${id ? `"${id}"` : index + 1} needs a "type"`, at, id ? { nodeId: id } : {});
				return;
			}
			if (!id) {
				const base = WORKFLOW_ID_PATTERN.test(type) ? type : 'node';
				let n = 1;
				id = base;
				while (written.has(id) || this.nodeIndex.has(id)) {
					id = `${base}_${++n}`;
				}
				this.report('error', 'missing-node-id', `This ${type} node needs an "id" (read as "${id}")`, at, { nodeId: id });
			} else if (!WORKFLOW_ID_PATTERN.test(id)) {
				this.report('error', 'invalid-node-id', `"${id}" is not a valid node id: use lower-case letters, digits, "-" and "_", starting with a letter`, [...at, 'id'], { nodeId: id });
			}
			if (this.nodeIndex.has(id)) {
				this.report('error', 'duplicate-node-id', `Another node already has the id "${id}"; node ids must be unique`, [...at, 'id'], { nodeId: id });
				return;
			}
			this.nodeIndex.set(id, index);
			this.unknownKeys(item, NODE_KEYS, at, 'node', id);
			if (!getWorkflowNodeType(type)) {
				this.report('warning', 'unknown-node-type', `Unknown node type "${type}": the node is kept, but this version of Volt cannot run it`, [...at, 'type'], { nodeId: id });
			}
			const node: Mutable<IWorkflowNode> = {
				id,
				type,
				position: this.readPosition(item.position, [...at, 'position'], id),
				config: this.readConfig(item.config, [...at, 'config'], id),
			};
			const name = this.text(item, 'name', at);
			if (name !== undefined) {
				node.name = name;
			}
			const color = this.text(item, 'color', at);
			if (color !== undefined) {
				if (WORKFLOW_NODE_COLORS.includes(color as WorkflowNodeColor)) {
					node.color = color as WorkflowNodeColor;
				} else {
					this.report('warning', 'invalid-color', `Unknown color "${color}": use ${WORKFLOW_NODE_COLORS.join(', ')}`, [...at, 'color'], { nodeId: id });
				}
			}
			const disabled = this.boolean(item, 'disabled', at);
			if (disabled !== undefined) {
				node.disabled = disabled;
			}
			const notes = this.text(item, 'notes', at);
			if (notes !== undefined) {
				node.notes = notes;
			}
			const retry = this.readRetry(item.retry, [...at, 'retry'], id);
			if (retry) {
				node.retry = retry;
			}
			const timeoutMs = this.integer(item, 'timeoutMs', at, 1, MAX_TIMEOUT_MS);
			if (timeoutMs !== undefined) {
				node.timeoutMs = timeoutMs;
			}
			const onError = this.text(item, 'onError', at);
			if (onError !== undefined) {
				if (ERROR_MODES.includes(onError as WorkflowErrorMode)) {
					node.onError = onError as WorkflowErrorMode;
				} else {
					this.report('error', 'invalid-on-error', `Unknown onError "${onError}": use fail, continue or route`, [...at, 'onError'], { nodeId: id });
				}
			}
			if (item.pinnedOutput !== undefined) {
				node.pinnedOutput = item.pinnedOutput;
			}
			nodes.push(node);
		});
		return nodes;
	}

	private readPosition(raw: WorkflowValue | undefined, path: Path, nodeId: string): IWorkflowPosition {
		if (Array.isArray(raw) && raw.length === 2 && isFiniteNumber(raw[0]) && isFiniteNumber(raw[1])) {
			return { x: raw[0], y: raw[1] };
		}
		if (isRecord(raw) && isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
			this.unknownKeys(raw, ['x', 'y'], path, 'position');
			return { x: raw.x, y: raw.y };
		}
		if (raw !== undefined && raw !== null) {
			this.report('error', 'invalid-position', '"position" is [x, y] or { x, y } in canvas pixels', path, { nodeId });
		}
		this.unplaced.add(nodeId);
		return { x: 0, y: 0 };
	}

	private readConfig(raw: WorkflowValue | undefined, path: Path, nodeId: string): WorkflowRecord {
		if (raw === undefined || raw === null) {
			return {};
		}
		if (isRecord(raw)) {
			return raw;
		}
		this.report('error', 'invalid-config', `"config" is a map of the node's settings, not ${valueKind(raw)}`, path, { nodeId });
		return {};
	}

	private readRetry(raw: WorkflowValue | undefined, path: Path, nodeId: string): IWorkflowRetryPolicy | undefined {
		if (raw === undefined || raw === null) {
			return undefined;
		}
		if (typeof raw === 'number') {
			if (Number.isInteger(raw) && raw >= 0 && raw <= MAX_RETRY_ATTEMPTS) {
				return { attempts: raw };
			}
			this.report('error', 'invalid-retry', `"retry" takes 0 to ${MAX_RETRY_ATTEMPTS} extra attempts`, path, { nodeId });
			return undefined;
		}
		if (!isRecord(raw)) {
			this.report('error', 'invalid-retry', '"retry" is a number of attempts, or { attempts, delayMs, maxDelayMs }', path, { nodeId });
			return undefined;
		}
		this.unknownKeys(raw, RETRY_KEYS, path, 'retry setting', nodeId);
		const attempts = this.integer(raw, 'attempts', path, 0, MAX_RETRY_ATTEMPTS);
		if (attempts === undefined) {
			if (raw.attempts === undefined) {
				this.report('error', 'invalid-retry', '"retry" needs "attempts"', path, { nodeId });
			}
			return undefined;
		}
		const retry: Mutable<IWorkflowRetryPolicy> = { attempts };
		const delayMs = this.integer(raw, 'delayMs', path, 0, MAX_DELAY_MS);
		if (delayMs !== undefined) {
			retry.delayMs = delayMs;
		}
		const maxDelayMs = this.integer(raw, 'maxDelayMs', path, 0, MAX_DELAY_MS);
		if (maxDelayMs !== undefined) {
			retry.maxDelayMs = maxDelayMs;
		}
		return retry;
	}

	private readEdges(raw: WorkflowValue | undefined, path: Path, nodes: readonly IWorkflowNode[]): IWorkflowEdge[] {
		if (raw === undefined || raw === null) {
			return [];
		}
		if (!Array.isArray(raw)) {
			this.report('error', 'invalid-edges', `"edges" is a list of { from: node.port, to: node }, not ${valueKind(raw)}`, path);
			return [];
		}
		const byId = new Map(nodes.map(node => [node.id, node]));
		const edges: IWorkflowEdge[] = [];
		raw.forEach((item, index) => {
			const at = [...path, index];
			if (!isRecord(item)) {
				this.report('error', 'invalid-edge', `Each edge is a map ({ from: node.port, to: node }), not ${valueKind(item)}`, at);
				return;
			}
			this.unknownKeys(item, EDGE_KEYS, at, 'edge');
			const fromText = this.text(item, 'from', at)?.trim();
			const toText = this.text(item, 'to', at)?.trim();
			if (!fromText) {
				this.report('error', 'missing-edge-from', 'This edge needs "from": the node and port it leaves (start.next)', at);
				return;
			}
			if (!toText) {
				this.report('error', 'missing-edge-to', 'This edge needs "to": the node it goes to', at);
				return;
			}
			const from = splitEndpoint(fromText);
			const to = splitEndpoint(toText);
			const port = this.endpointPort(item, 'port', from, at) ?? nodeOutputs(byId.get(from.node) ?? { type: '', config: {} })[0]?.id;
			if (!port) {
				this.report('error', 'missing-edge-port', byId.has(from.node)
					? `"${from.node}" has no output ports to leave from`
					: `Say which port of "${from.node}" this edge leaves: from: ${from.node}.<port>`, [...at, 'from']);
				return;
			}
			const toPort = this.endpointPort(item, 'toPort', to, at);
			const edge: Mutable<IWorkflowEdge> = { id: '', from: from.node, port, to: to.node };
			if (toPort && toPort !== 'in') {
				edge.toPort = toPort;
			}
			const label = this.text(item, 'label', at);
			if (label !== undefined) {
				edge.label = label;
			}
			const id = this.text(item, 'id', at);
			edge.id = id ?? defaultEdgeId(edge);
			if (this.edgeIndex.has(edge.id)) {
				this.report('error', 'duplicate-edge', id !== undefined ? `Another edge already has the id "${id}"` : `This edge repeats ${from.node}.${port} -> ${defaultEdgeId(edge).split('->')[1]}`, at, { edgeId: edge.id });
				return;
			}
			this.edgeIndex.set(edge.id, index);
			edges.push(edge);
		});
		return edges;
	}

	/** The port in `node.port`, or the separate `port` / `toPort` key (the dotted form wins). */
	private endpointPort(item: WorkflowRecord, key: 'port' | 'toPort', endpoint: { readonly node: string; readonly port?: string }, path: Path): string | undefined {
		const separate = this.text(item, key, path);
		if (separate !== undefined && endpoint.port !== undefined && separate !== endpoint.port) {
			this.report('warning', 'edge-port-conflict', `"${key === 'port' ? 'from' : 'to'}" names port "${endpoint.port}" but "${key}" says "${separate}"; "${endpoint.port}" is used`, [...path, key]);
		}
		return endpoint.port ?? (separate || undefined);
	}

	private readGroups(raw: WorkflowValue | undefined, path: Path, nodes: readonly IWorkflowNode[]): IWorkflowGroup[] | undefined {
		if (raw === undefined || raw === null) {
			return undefined;
		}
		if (!Array.isArray(raw)) {
			this.report('error', 'invalid-groups', `"groups" is a list of { id, title, color, nodes }, not ${valueKind(raw)}`, path);
			return undefined;
		}
		const nodeIds = new Set(nodes.map(node => node.id));
		const ids = new Set<string>();
		const groups: IWorkflowGroup[] = [];
		raw.forEach((item, index) => {
			const at = [...path, index];
			if (!isRecord(item)) {
				this.report('error', 'invalid-group', `Each group is a map (id, title, color, nodes), not ${valueKind(item)}`, at);
				return;
			}
			this.unknownKeys(item, GROUP_KEYS, at, 'group');
			const id = this.text(item, 'id', at);
			if (!id) {
				this.report('error', 'missing-group-id', 'Each group needs an "id"', at);
				return;
			}
			if (!WORKFLOW_ID_PATTERN.test(id)) {
				this.report('error', 'invalid-group-id', `"${id}" is not a valid group id: use lower-case letters, digits, "-" and "_", starting with a letter`, [...at, 'id']);
			}
			if (ids.has(id)) {
				this.report('error', 'duplicate-group', `Another group already has the id "${id}"`, [...at, 'id']);
				return;
			}
			ids.add(id);
			const members = this.strings(item, 'nodes', at) ?? [];
			members.forEach((member, memberIndex) => {
				if (!nodeIds.has(member)) {
					this.report('warning', 'unknown-group-node', `Group "${id}" lists "${member}", which is not a node`, [...at, 'nodes', memberIndex]);
				}
			});
			const group: Mutable<IWorkflowGroup> = { id, title: this.text(item, 'title', at) ?? id, nodes: members };
			const color = this.text(item, 'color', at);
			if (color !== undefined) {
				if (WORKFLOW_NODE_COLORS.includes(color as WorkflowNodeColor)) {
					group.color = color as WorkflowNodeColor;
				} else {
					this.report('warning', 'invalid-color', `Unknown color "${color}": use ${WORKFLOW_NODE_COLORS.join(', ')}`, [...at, 'color']);
				}
			}
			groups.push(group);
		});
		return groups;
	}

	private readSource(raw: WorkflowValue | undefined, path: Path): IWorkflowSource | undefined {
		if (raw === undefined || raw === null) {
			return undefined;
		}
		if (!isRecord(raw)) {
			this.report('error', 'invalid-source', `"source" is a map (kind, url, sha, templateId), not ${valueKind(raw)}`, path);
			return undefined;
		}
		this.unknownKeys(raw, SOURCE_KEYS, path, 'source');
		const kind = this.text(raw, 'kind', path);
		if (!kind || !SOURCE_KINDS.includes(kind as WorkflowSourceKind)) {
			this.report('error', 'invalid-source', `"source.kind" must be one of ${SOURCE_KINDS.join(', ')}`, kind ? [...path, 'kind'] : path);
			return undefined;
		}
		const source: Mutable<IWorkflowSource> = { kind: kind as WorkflowSourceKind };
		for (const key of ['url', 'sha', 'templateId'] as const) {
			const value = this.text(raw, key, path);
			if (value !== undefined) {
				source[key] = value;
			}
		}
		return source;
	}

	//#endregion

	//#region Typed reads

	private report(severity: WorkflowIssueSeverity, code: string, message: string, path: Path, extra: Pick<IWorkflowIssue, 'nodeId' | 'edgeId' | 'field'> = {}): void {
		this.issues.push(located({ severity, code, message, ...extra }, path, this.yaml));
	}

	private unknownKeys(record: WorkflowRecord, known: readonly string[], path: Path, what: string, nodeId?: string): void {
		for (const key of Object.keys(record)) {
			if (!known.includes(key)) {
				this.report('warning', 'unknown-key', `Unknown ${what} key "${key}" (ignored)`, [...path, key], nodeId ? { nodeId } : {});
			}
		}
	}

	/** Text; numbers and booleans are taken as their text (`name: 2026 plan`). */
	private text(record: WorkflowRecord, key: string, path: Path): string | undefined {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		this.report('error', 'invalid-value', `"${key}" must be text, not ${valueKind(value)}`, [...path, key]);
		return undefined;
	}

	private integer(record: WorkflowRecord, key: string, path: Path, min: number, max: number): number | undefined {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
			const range = max >= Number.MAX_SAFE_INTEGER ? `${min} or more` : `${min} to ${max}`;
			this.report('error', 'invalid-value', `"${key}" must be a whole number from ${range}, not ${typeof value === 'number' ? value : valueKind(value)}`, [...path, key]);
			return undefined;
		}
		return value;
	}

	private boolean(record: WorkflowRecord, key: string, path: Path): boolean | undefined {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== 'boolean') {
			this.report('error', 'invalid-value', `"${key}" must be true or false, not ${valueKind(value)}`, [...path, key]);
			return undefined;
		}
		return value;
	}

	/** A list of text; a single text value is read as a list of one. */
	private strings(record: WorkflowRecord, key: string, path: Path): string[] | undefined {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value === 'string') {
			return [value];
		}
		if (!Array.isArray(value)) {
			this.report('error', 'invalid-value', `"${key}" must be a list of text, not ${valueKind(value)}`, [...path, key]);
			return undefined;
		}
		const out: string[] = [];
		value.forEach((item, index) => {
			if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
				out.push(String(item));
			} else {
				this.report('error', 'invalid-value', `"${key}" must be a list of text; item ${index + 1} is ${valueKind(item)}`, [...path, key, index]);
			}
		});
		return out;
	}

	//#endregion
}

function splitEndpoint(text: string): { readonly node: string; readonly port?: string } {
	const dot = text.indexOf('.');
	return dot < 0 ? { node: text } : { node: text.slice(0, dot), port: text.slice(dot + 1) || undefined };
}

/** Parses workflow YAML; `definition` is set whenever the document has a usable shape (even with graph errors). */
export function parseWorkflowYaml(text: string): IWorkflowParseResult {
	const yaml = parseYaml(text);
	const issues: IWorkflowIssue[] = yaml.errors.map(error => ({ severity: 'error', code: 'yaml-syntax', message: error.message, line: error.line, column: error.column }));
	if (yaml.value === undefined) {
		return { issues };
	}
	return readWorkflow(yaml.value, yaml, issues);
}

/** The same checks for a value parsed elsewhere (a JSON import, an agent tool's arguments); no line numbers. */
export function readWorkflowDocument(value: WorkflowValue): IWorkflowParseResult {
	return readWorkflow(value, undefined, []);
}

function readWorkflow(value: WorkflowValue, yaml: IYamlParseResult | undefined, issues: IWorkflowIssue[]): IWorkflowParseResult {
	const reader = new DefinitionReader(yaml);
	const definition = reader.read(value);
	issues.push(...reader.issues);
	if (!definition) {
		return { issues };
	}
	issues.push(...reader.graphIssues(definition, issues));
	return { definition, issues };
}

//#endregion

//#region Writing

/** Copies `keys` of `source` in that order, leaving out absent ones. */
function pick(source: object, keys: readonly string[]): Record<string, WorkflowValue> {
	const values = source as { readonly [key: string]: WorkflowValue | undefined };
	const out: Record<string, WorkflowValue> = {};
	for (const key of keys) {
		const value = values[key];
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

/** The node type's fields first, in their inspector order, then any other keys as they are. */
function orderedConfig(node: IWorkflowNode): Record<string, WorkflowValue> {
	const fields = getWorkflowNodeType(node.type)?.fields.map(field => field.key) ?? [];
	const keys = [...fields.filter(key => Object.prototype.hasOwnProperty.call(node.config, key)), ...Object.keys(node.config).filter(key => !fields.includes(key))];
	const out: Record<string, WorkflowValue> = {};
	for (const key of keys) {
		const value = node.config[key];
		if (value !== undefined) {
			Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
		}
	}
	return out;
}

function nodeDocument(node: IWorkflowNode): WorkflowValue {
	const doc: Record<string, WorkflowValue> = { id: node.id, type: node.type };
	if (node.name !== undefined) {
		doc.name = node.name;
	}
	doc.position = [node.position.x, node.position.y];
	Object.assign(doc, pick(node, ['color', 'disabled', 'notes']));
	const config = orderedConfig(node);
	if (Object.keys(config).length) {
		doc.config = config;
	}
	if (node.retry) {
		doc.retry = pick(node.retry, RETRY_KEYS);
	}
	Object.assign(doc, pick(node, ['timeoutMs', 'onError', 'pinnedOutput']));
	return doc;
}

function edgeDocument(edge: IWorkflowEdge): WorkflowValue {
	const doc: Record<string, WorkflowValue> = {
		from: `${edge.from}.${edge.port}`,
		to: edge.toPort && edge.toPort !== 'in' ? `${edge.to}.${edge.toPort}` : edge.to,
	};
	if (edge.label !== undefined) {
		doc.label = edge.label;
	}
	if (edge.id !== defaultEdgeId(edge)) {
		doc.id = edge.id;
	}
	return doc;
}

/** A plain object in the canonical YAML shape (key order, `from: node.port` edges, positions as [x, y]). */
export function workflowToDocument(definition: IWorkflowDefinition): WorkflowValue {
	const doc: Record<string, WorkflowValue> = pick(definition, ['version', 'id', 'name', 'description', 'revision', 'tags']);
	doc.trigger = pick(definition.trigger, TRIGGER_KEYS);
	if (definition.inputs) {
		doc.inputs = definition.inputs.map(input => pick(input, INPUT_KEYS));
	}
	if (definition.variables) {
		doc.variables = definition.variables;
	}
	if (definition.settings) {
		doc.settings = pick(definition.settings, SETTINGS_KEYS);
	}
	doc.nodes = definition.nodes.map(nodeDocument);
	doc.edges = definition.edges.map(edgeDocument);
	if (definition.groups) {
		doc.groups = definition.groups.map(group => pick(group, GROUP_KEYS));
	}
	if (definition.source) {
		doc.source = pick(definition.source, SOURCE_KEYS);
	}
	return doc;
}

/** Canonical YAML for a definition (deterministic: the same definition always gives the same text). */
export function serializeWorkflow(definition: IWorkflowDefinition): string {
	return stringifyYaml(workflowToDocument(definition), { header: [WORKFLOW_FILE_HEADER], inlineArrayMax: 8 });
}

/** A fresh definition: a start node and nothing else. */
export function blankWorkflow(id: string, name: string): IWorkflowDefinition {
	return {
		version: WORKFLOW_SCHEMA_VERSION,
		id,
		name,
		trigger: { type: 'manual' },
		inputs: [{ name: 'task', type: 'string', description: 'What to do' }],
		nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} }],
		edges: [],
	};
}

//#endregion

//#region JSON Schema

/** The node types Volt ships, offered by editors; other types still validate by shape (newer files, extensions). */
export const WORKFLOW_SCHEMA_NODE_TYPES: readonly string[] = [
	'start', 'agent', 'ask_user', 'subtask', 'classify', 'summarize',
	'end', 'if', 'switch', 'loop', 'for_each', 'fork', 'join', 'wait', 'approval', 'subworkflow', 'set_variables',
	'shell', 'http', 'webhook', 'package_script',
	'git_commit', 'git_push', 'git_sync', 'git_branch', 'github_pr', 'github_wait_ci', 'github_pr_comment', 'github_update_pr', 'github_issue_comment',
	'mcp_tool', 'skill', 'slack_message', 'teams_message',
	'transform', 'filter', 'parse_json', 'template', 'notify', 'log', 'write_file',
];

const SCHEMA_ID = '^[a-z][a-z0-9_-]{0,63}$';
const SCHEMA_ENDPOINT = '^[a-z][a-z0-9_-]{0,63}(\\.\\S+)?$';
const SCHEMA_URL = 'https://raw.githubusercontent.com/LeulAria/volt/main/workflow-templates/schema/workflow.schema.json';

/** The JSON Schema (draft 2020-12) of a workflow file, for editors and the templates repository's CI. */
export const WORKFLOW_JSON_SCHEMA: { readonly [key: string]: WorkflowValue } = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_URL,
	title: 'Volt workflow',
	description: 'A Volt workflow: a trigger, nodes (agents, checks, git steps, branches, loops) and the edges between their ports. Format: https://github.com/LeulAria/volt/tree/main/workflow-templates',
	type: 'object',
	required: ['name', 'nodes'],
	additionalProperties: false,
	properties: {
		version: { description: 'File format version. Volt reads older versions by migrating them; missing means 1.', type: 'integer', minimum: 1, default: WORKFLOW_SCHEMA_VERSION },
		id: { description: 'Slug, unique among your workflows (the file name). Derived from the name when absent.', $ref: '#/$defs/id' },
		name: { description: 'Display name.', type: 'string', minLength: 1 },
		description: { type: 'string' },
		revision: { description: 'Bumped on every save; history keeps earlier revisions.', type: 'integer', minimum: 0 },
		tags: { type: 'array', items: { type: 'string' } },
		trigger: { $ref: '#/$defs/trigger' },
		inputs: {
			description: 'Values a run starts with, read as {{ inputs.<name> }}.',
			anyOf: [
				{ type: 'array', items: { $ref: '#/$defs/input' } },
				{ type: 'object', propertyNames: { pattern: INPUT_NAME.source }, additionalProperties: { anyOf: [{ enum: INPUT_TYPES }, { type: 'null' }, { $ref: '#/$defs/inputFields' }] } },
			],
		},
		variables: { description: 'Starting run variables, read as {{ vars.<name> }}; Set Variables nodes change them.', type: 'object' },
		settings: { $ref: '#/$defs/settings' },
		nodes: { type: 'array', items: { $ref: '#/$defs/node' } },
		edges: { type: 'array', items: { $ref: '#/$defs/edge' } },
		groups: { type: 'array', items: { $ref: '#/$defs/group' } },
		source: { $ref: '#/$defs/source' },
	},
	$defs: {
		id: { type: 'string', pattern: SCHEMA_ID },
		color: { enum: WORKFLOW_NODE_COLORS },
		trigger: {
			description: 'What starts the workflow. Schedules and events run through a linked automation.',
			anyOf: [
				{ const: 'manual' },
				{
					type: 'object',
					additionalProperties: false,
					properties: {
						type: { enum: TRIGGER_TYPES, default: 'manual' },
						cron: { description: 'schedule: a five-field cron expression or macro (quote it: \'*/5 * * * *\', \'@daily\').', type: 'string' },
						everyMinutes: { description: 'schedule: every N minutes (instead of cron).', type: 'integer', minimum: 1, maximum: MAX_EVERY_MINUTES },
						timezone: { description: 'schedule: an IANA time zone (Europe/Berlin); local time when absent.', type: 'string' },
						provider: { description: 'event: where the event comes from.', enum: EVENT_PROVIDERS },
						event: { description: 'event: the provider\'s event (pr.opened, push, issue.created).', type: 'string' },
						option: { description: 'event: narrows the event (a branch, a channel, a label).', type: 'string' },
						filters: { description: 'event: payload filters, one "path op value" each (payload.ref matches ^refs/tags/).', type: 'array', items: { type: 'string' } },
						samplePayload: { description: 'A payload for simulations and the start node\'s Input tab.' },
					},
					allOf: [
						{ if: { properties: { type: { const: 'schedule' } }, required: ['type'] }, then: { anyOf: [{ required: ['cron'] }, { required: ['everyMinutes'] }] } },
						{ if: { properties: { type: { const: 'event' } }, required: ['type'] }, then: { required: ['provider'] } },
					],
				},
			],
		},
		inputFields: {
			type: 'object',
			additionalProperties: false,
			properties: {
				type: { enum: INPUT_TYPES, default: 'string' },
				description: { type: 'string' },
				default: { description: 'The value when the run gives none.' },
				required: { type: 'boolean' },
			},
		},
		input: {
			type: 'object',
			required: ['name'],
			additionalProperties: false,
			properties: {
				name: { type: 'string', pattern: INPUT_NAME.source },
				type: { enum: INPUT_TYPES, default: 'string' },
				description: { type: 'string' },
				default: { description: 'The value when the run gives none.' },
				required: { type: 'boolean' },
			},
		},
		settings: {
			type: 'object',
			additionalProperties: false,
			properties: {
				concurrency: { description: 'Nodes that run at the same time (fork branches, independent paths).', type: 'integer', minimum: 1, maximum: MAX_CONCURRENCY },
				maxSteps: { description: 'Node executions per run; loops count every pass.', type: 'integer', minimum: 1, maximum: WORKFLOW_HARD_MAX_STEPS },
				timeoutMs: { description: 'Whole-run timeout.', type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
				repository: { description: 'The folder agent, shell and git nodes work in (a stored URI).', type: 'string' },
				modelRef: { description: 'Default model of agent nodes that set none.', type: 'string' },
			},
		},
		position: {
			description: 'Canvas position in pixels: [x, y] or { x, y }. Laid out automatically when absent.',
			anyOf: [
				{ type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], minItems: 2, maxItems: 2 },
				{ type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } } },
			],
		},
		node: {
			type: 'object',
			required: ['id', 'type'],
			additionalProperties: false,
			properties: {
				id: { $ref: '#/$defs/id' },
				type: { description: 'The node type (agent, shell, if, loop, github_pr, …).', anyOf: [{ enum: WORKFLOW_SCHEMA_NODE_TYPES }, { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$' }] },
				name: { type: 'string' },
				position: { $ref: '#/$defs/position' },
				color: { $ref: '#/$defs/color' },
				disabled: { description: 'Skipped in runs; passes its input through its first port.', type: 'boolean' },
				notes: { type: 'string' },
				config: { description: 'The node type\'s settings; text values may hold {{ … }} templates.', type: 'object' },
				retry: {
					anyOf: [
						{ type: 'integer', minimum: 0, maximum: MAX_RETRY_ATTEMPTS },
						{
							type: 'object',
							required: ['attempts'],
							additionalProperties: false,
							properties: {
								attempts: { description: 'Extra attempts after the first.', type: 'integer', minimum: 0, maximum: MAX_RETRY_ATTEMPTS },
								delayMs: { type: 'integer', minimum: 0, maximum: MAX_DELAY_MS },
								maxDelayMs: { type: 'integer', minimum: 0, maximum: MAX_DELAY_MS },
							},
						},
					],
				},
				timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
				onError: { description: 'fail: the run fails; continue: go on down the first port; route: go on down the failed port.', enum: ERROR_MODES },
				pinnedOutput: { description: 'Output used instead of running the node in simulations.' },
			},
		},
		edge: {
			type: 'object',
			required: ['from', 'to'],
			additionalProperties: false,
			properties: {
				from: { description: 'node.port it leaves (start.next, review.approve); the node\'s first port when only the node is given.', type: 'string', pattern: SCHEMA_ENDPOINT },
				port: { description: 'The port, when "from" names only the node.', type: 'string' },
				to: { description: 'The node it goes to (node.port for a port other than in).', type: 'string', pattern: SCHEMA_ENDPOINT },
				toPort: { type: 'string' },
				label: { type: 'string' },
				id: { description: 'Stable id; from.port->to when absent.', type: 'string' },
			},
		},
		group: {
			type: 'object',
			required: ['id', 'nodes'],
			additionalProperties: false,
			properties: {
				id: { $ref: '#/$defs/id' },
				title: { type: 'string' },
				color: { $ref: '#/$defs/color' },
				nodes: { type: 'array', items: { type: 'string' } },
			},
		},
		source: {
			description: 'Where the workflow came from. Community and imported workflows stay untrusted until reviewed.',
			type: 'object',
			required: ['kind'],
			additionalProperties: false,
			properties: {
				kind: { enum: SOURCE_KINDS },
				url: { type: 'string' },
				sha: { type: 'string' },
				templateId: { type: 'string' },
			},
		},
	},
};

//#endregion
