/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EXPRESSION_ROOTS, checkTemplate, expressionReferences, hasTemplates, parseExpression, templateReferences } from './workflowExpressions.js';
import { parseWorkflowDuration } from './workflowNodeCatalog.js';
import { getWorkflowNodeType, nodeDisplayName, nodeOutputs } from './workflowNodes.js';
import { IWorkflowDefinition, IWorkflowEdge, IWorkflowFieldDef, IWorkflowIssue, IWorkflowNode, IWorkflowNodeType, IWorkflowPosition, WORKFLOW_HARD_MAX_STEPS, WORKFLOW_ID_PATTERN, WorkflowIssueSeverity, WorkflowValue } from './workflowTypes.js';

/**
 * Graph checks, traversal helpers and auto-layout.
 *
 * Cycles: a workflow is a DAG except for edges that return into a `loop` or `for_each` node from
 * nodes it leads to ("back-edges"). Every cycle must pass through one of those, so the graph
 * without back-edges is acyclic; the engine bounds loops with their limits and the step budget.
 */

const LOOP_CONTROLS = new Set(['loop', 'forEach']);

//#region Traversal

/** Edges leaving `nodeId` (through `port` when given). */
export function outgoingEdges(definition: IWorkflowDefinition, nodeId: string, port?: string): readonly IWorkflowEdge[] {
	return definition.edges.filter(edge => edge.from === nodeId && (port === undefined || edge.port === port));
}

export function incomingEdges(definition: IWorkflowDefinition, nodeId: string): readonly IWorkflowEdge[] {
	return definition.edges.filter(edge => edge.to === nodeId);
}

function adjacency(definition: IWorkflowDefinition, direction: 'out' | 'in'): Map<string, IWorkflowEdge[]> {
	const map = new Map<string, IWorkflowEdge[]>();
	for (const edge of definition.edges) {
		const key = direction === 'out' ? edge.from : edge.to;
		let list = map.get(key);
		if (!list) {
			map.set(key, list = []);
		}
		list.push(edge);
	}
	return map;
}

/** Nodes reachable from `from` (excluded unless on a cycle), never walking through `stopAt`. */
function reach(out: Map<string, IWorkflowEdge[]>, from: Iterable<string>, stopAt?: string): Set<string> {
	const seen = new Set<string>();
	const queue = [...from];
	while (queue.length) {
		const id = queue.shift()!;
		for (const edge of out.get(id) ?? []) {
			if (edge.to !== stopAt && !seen.has(edge.to)) {
				seen.add(edge.to);
				queue.push(edge.to);
			}
		}
	}
	return seen;
}

/** Every node `nodeId` depends on (nodes with a path to it), nearest first. Includes itself only when on a cycle. */
export function upstreamNodes(definition: IWorkflowDefinition, nodeId: string): readonly string[] {
	const into = adjacency(definition, 'in');
	const order: string[] = [];
	const seen = new Set<string>();
	const queue = [nodeId];
	while (queue.length) {
		const id = queue.shift()!;
		for (const edge of into.get(id) ?? []) {
			if (!seen.has(edge.from)) {
				seen.add(edge.from);
				order.push(edge.from);
				queue.push(edge.from);
			}
		}
	}
	return order;
}

/** Every node `nodeId` leads to, nearest first. */
export function downstreamNodes(definition: IWorkflowDefinition, nodeId: string): readonly string[] {
	return [...reach(adjacency(definition, 'out'), [nodeId])];
}

/**
 * The body of a loop or for-each: nodes reachable from its `port` edges (every port when absent)
 * without passing back through the node itself.
 */
export function loopBody(definition: IWorkflowDefinition, nodeId: string, port?: string): ReadonlySet<string> {
	const out = adjacency(definition, 'out');
	const first = outgoingEdges(definition, nodeId, port).map(edge => edge.to).filter(id => id !== nodeId);
	const body = reach(out, first, nodeId);
	first.forEach(id => body.add(id));
	return body;
}

/** Edges that return into a loop or for-each node from nodes it leads to: drawn back, ignored for ordering. */
export function workflowBackEdges(definition: IWorkflowDefinition): ReadonlySet<string> {
	const out = adjacency(definition, 'out');
	const back = new Set<string>();
	for (const node of definition.nodes) {
		const type = getWorkflowNodeType(node.type);
		if (!type || !LOOP_CONTROLS.has(type.control)) {
			continue;
		}
		const descendants = reach(out, [node.id], node.id);
		for (const edge of definition.edges) {
			if (edge.to === node.id && (edge.from === node.id || descendants.has(edge.from))) {
				back.add(edge.id);
			}
		}
	}
	return back;
}

/**
 * Nodes in dependency order, ignoring back-edges (stable: ties keep the file's order). Nodes on a
 * cycle that does not pass a loop (an invalid file) come last, in file order.
 */
export function topologicalOrder(definition: IWorkflowDefinition): readonly string[] {
	const back = workflowBackEdges(definition);
	const ids = new Set(definition.nodes.map(node => node.id));
	const indegree = new Map(definition.nodes.map(node => [node.id, 0]));
	const out = new Map<string, string[]>();
	for (const edge of definition.edges) {
		if (back.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to)) {
			continue;
		}
		indegree.set(edge.to, indegree.get(edge.to)! + 1);
		out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
	}
	const order: string[] = [];
	const done = new Set<string>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const node of definition.nodes) {
			if (!done.has(node.id) && indegree.get(node.id) === 0) {
				done.add(node.id);
				order.push(node.id);
				for (const to of out.get(node.id) ?? []) {
					indegree.set(to, indegree.get(to)! - 1);
				}
				progress = true;
			}
		}
	}
	for (const node of definition.nodes) {
		if (!done.has(node.id)) {
			order.push(node.id);
		}
	}
	return order;
}

/** Edges on a cycle that does not pass through a loop node (each cycle reported once, by one of its edges). */
function illegalCycleEdges(definition: IWorkflowDefinition, back: ReadonlySet<string>): IWorkflowEdge[] {
	const out = new Map<string, IWorkflowEdge[]>();
	for (const edge of definition.edges) {
		if (!back.has(edge.id)) {
			out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
		}
	}
	const state = new Map<string, 1 | 2>();
	const found: IWorkflowEdge[] = [];
	for (const node of definition.nodes) {
		if (state.has(node.id)) {
			continue;
		}
		// Iterative DFS: an edge into a node still on the stack closes a cycle.
		const stack: { id: string; next: number }[] = [{ id: node.id, next: 0 }];
		state.set(node.id, 1);
		while (stack.length) {
			const top = stack[stack.length - 1];
			const edges = out.get(top.id) ?? [];
			if (top.next >= edges.length) {
				state.set(top.id, 2);
				stack.pop();
				continue;
			}
			const edge = edges[top.next++];
			const seen = state.get(edge.to);
			if (seen === 1) {
				found.push(edge);
			} else if (seen === undefined) {
				state.set(edge.to, 1);
				stack.push({ id: edge.to, next: 0 });
			}
		}
	}
	return found;
}

//#endregion

//#region Validation

export function hasErrors(issues: readonly IWorkflowIssue[]): boolean {
	return issues.some(issue => issue.severity === 'error');
}

function isRecord(value: unknown): value is { readonly [key: string]: WorkflowValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: WorkflowValue | undefined): boolean {
	return value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

const TEXT_KINDS = new Set(['text', 'multiline', 'prompt', 'code', 'model', 'skill', 'mcpServer', 'workflow', 'repository', 'cron']);

/** Why a field's value does not fit its kind, or undefined. Template strings fit any kind but expressions. */
function fieldValueProblem(field: IWorkflowFieldDef, value: WorkflowValue): string | undefined {
	if (field.kind !== 'expression' && typeof value === 'string' && hasTemplates(value)) {
		return undefined;
	}
	switch (field.kind) {
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return 'must be a number';
			}
			if (field.min !== undefined && value < field.min) {
				return `must be at least ${field.min}`;
			}
			if (field.max !== undefined && value > field.max) {
				return `must be at most ${field.max}`;
			}
			return undefined;
		case 'boolean':
			return typeof value === 'boolean' ? undefined : 'must be true or false';
		case 'select':
			if (typeof value !== 'string') {
				return 'must be one of the options';
			}
			return !field.options || field.options.some(option => option.value === value) ? undefined : `must be one of ${field.options.map(option => option.value).join(', ')}`;
		case 'duration':
			return parseWorkflowDuration(value) !== undefined ? undefined : 'must be a duration like 30s, 5m or 1h';
		case 'expression':
			return typeof value === 'string' ? undefined : 'must be an expression';
		case 'keyValue':
			return isRecord(value) || Array.isArray(value) ? undefined : 'must be a list of key: value pairs';
		case 'list':
			return Array.isArray(value) && value.every(entry => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') ? undefined : 'must be a list of values';
		case 'json':
			return undefined;
	}
	if (TEXT_KINDS.has(field.kind)) {
		return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? undefined : 'must be text';
	}
	return undefined;
}

/** Every string inside a value, with its path below the field (`headers.Authorization`). */
function strings(value: WorkflowValue | undefined, path: string, into: { path: string; text: string }[]): void {
	if (typeof value === 'string') {
		into.push({ path, text: value });
	} else if (Array.isArray(value)) {
		value.forEach((entry, i) => strings(entry, `${path}[${i}]`, into));
	} else if (isRecord(value)) {
		for (const key of Object.keys(value)) {
			strings(value[key], `${path}.${key}`, into);
		}
	}
}

interface IValidationContext {
	readonly definition: IWorkflowDefinition;
	readonly issues: IWorkflowIssue[];
	readonly ids: ReadonlySet<string>;
	readonly upstream: (nodeId: string) => ReadonlySet<string>;
	readonly inLoopBody: ReadonlySet<string>;
}

function checkReferences(ctx: IValidationContext, node: IWorkflowNode, field: string, refs: readonly string[], path: string, severityCap: WorkflowIssueSeverity): void {
	const inputs = ctx.definition.inputs;
	for (const ref of refs) {
		const [rootName, second] = ref.split('.');
		const at = { nodeId: node.id, field, path };
		if (!EXPRESSION_ROOTS.includes(rootName)) {
			ctx.issues.push({ severity: cap('warning', severityCap), code: 'template-unknown-name', message: `"${rootName}" is not something templates can read (use ${EXPRESSION_ROOTS.join(', ')})`, ...at });
		} else if (rootName === 'nodes' && second) {
			if (!ctx.ids.has(second)) {
				ctx.issues.push({ severity: cap('warning', severityCap), code: 'template-unknown-node', message: `No node "${second}" (in ${ref})`, ...at });
			} else if (!ctx.upstream(node.id).has(second)) {
				ctx.issues.push({ severity: cap('warning', severityCap), code: 'template-not-upstream', message: `"${second}" does not run before this node, so ${ref} is empty`, ...at });
			}
		} else if (rootName === 'inputs' && second && inputs?.length && !inputs.some(input => input.name === second)) {
			ctx.issues.push({ severity: 'info', code: 'template-unknown-input', message: `The workflow has no input "${second}"`, ...at });
		} else if ((rootName === 'item' || rootName === 'loop') && !ctx.inLoopBody.has(node.id)) {
			ctx.issues.push({ severity: 'info', code: 'template-outside-loop', message: `${rootName} is only set inside a loop or for-each`, ...at });
		}
	}
}

const SEVERITY_RANK: { readonly [severity in WorkflowIssueSeverity]: number } = { error: 2, warning: 1, info: 0 };

function cap(severity: WorkflowIssueSeverity, max: WorkflowIssueSeverity): WorkflowIssueSeverity {
	return SEVERITY_RANK[severity] > SEVERITY_RANK[max] ? max : severity;
}

function validateFields(ctx: IValidationContext, node: IWorkflowNode, index: number, type: IWorkflowNodeType): void {
	// A disabled node does not run: its config problems are warnings, so drafts can run around it.
	const severity: WorkflowIssueSeverity = node.disabled ? 'warning' : 'error';
	const known = new Set(type.fields.map(field => field.key));
	for (const field of type.fields) {
		const value = node.config[field.key];
		const path = `nodes[${index}].config.${field.key}`;
		const at = { nodeId: node.id, field: field.key, path };
		// A missing key runs with the field's default; an explicitly empty one does not.
		if (isEmpty(value)) {
			if (field.required && isEmpty(value === undefined ? field.default : value)) {
				ctx.issues.push({ severity, code: 'required-field', message: `${field.label} is required`, ...at });
			}
			continue;
		}
		const problem = fieldValueProblem(field, value);
		if (problem) {
			ctx.issues.push({ severity, code: /^must be at (least|most)/.test(problem) ? 'field-range' : 'field-type', message: `${field.label} ${problem}`, ...at });
			continue;
		}
		if (field.kind === 'expression') {
			const parsed = parseExpression(value as string);
			if (parsed.error) {
				ctx.issues.push({ severity, code: 'expression-syntax', message: `${field.label}: ${parsed.error}${parsed.offset !== undefined ? ` (at ${parsed.offset + 1})` : ''}`, ...at });
			} else {
				checkReferences(ctx, node, field.key, expressionReferences(value as string), path, severity);
			}
			continue;
		}
		checkTemplatesIn(ctx, node, field.key, value, path, severity);
	}
	// Keys no field describes still get their templates resolved, so check them too.
	for (const key of Object.keys(node.config)) {
		if (!known.has(key)) {
			checkTemplatesIn(ctx, node, key, node.config[key], `nodes[${index}].config.${key}`, severity);
		}
	}
}

function checkTemplatesIn(ctx: IValidationContext, node: IWorkflowNode, key: string, value: WorkflowValue, path: string, severity: WorkflowIssueSeverity): void {
	const texts: { path: string; text: string }[] = [];
	strings(value, path, texts);
	for (const { path: at, text } of texts) {
		if (!hasTemplates(text)) {
			continue;
		}
		const error = checkTemplate(text);
		if (error) {
			ctx.issues.push({ severity, code: 'template-syntax', message: `${error.message}${error.offset !== undefined ? ` (at ${error.offset + 1})` : ''}`, nodeId: node.id, field: key, path: at });
		} else {
			checkReferences(ctx, node, key, templateReferences(text), at, severity);
		}
	}
}

/** Every check: structure (start, ports, types, ids), required fields, expressions, cycles, reachability. */
export function validateWorkflow(definition: IWorkflowDefinition): readonly IWorkflowIssue[] {
	const issues: IWorkflowIssue[] = [];
	const byId = new Map<string, IWorkflowNode>();
	const nodeIndex = new Map<string, number>();

	// Ids and types.
	definition.nodes.forEach((node, index) => {
		const path = `nodes[${index}]`;
		if (!WORKFLOW_ID_PATTERN.test(node.id)) {
			issues.push({ severity: 'error', code: 'invalid-id', message: `"${node.id}" is not a valid node id (lower-case letters, digits, - and _, starting with a letter)`, nodeId: node.id, path: `${path}.id` });
		}
		if (byId.has(node.id)) {
			issues.push({ severity: 'error', code: 'duplicate-id', message: `Two nodes are called "${node.id}"`, nodeId: node.id, path: `${path}.id` });
		} else {
			byId.set(node.id, node);
			nodeIndex.set(node.id, index);
		}
		if (!getWorkflowNodeType(node.type)) {
			issues.push({ severity: 'error', code: 'unknown-node-type', message: `Unknown node type "${node.type}"`, nodeId: node.id, path: `${path}.type` });
		}
	});

	// Start and other one-per-workflow types.
	const starts = definition.nodes.filter(node => getWorkflowNodeType(node.type)?.control === 'start');
	if (starts.length === 0) {
		issues.push({ severity: 'error', code: 'no-start', message: 'The workflow needs a Start node' });
	}
	const singletonCounts = new Map<string, IWorkflowNode[]>();
	for (const node of definition.nodes) {
		if (getWorkflowNodeType(node.type)?.singleton) {
			singletonCounts.set(node.type, [...(singletonCounts.get(node.type) ?? []), node]);
		}
	}
	for (const [type, nodes] of singletonCounts) {
		for (const node of nodes.slice(1)) {
			issues.push({ severity: 'error', code: type === 'start' ? 'multiple-start' : 'singleton', message: `Only one ${getWorkflowNodeType(type)!.label} node is allowed`, nodeId: node.id, path: `nodes[${nodeIndex.get(node.id) ?? 0}]` });
		}
	}
	const start = starts[0];
	if (start?.disabled) {
		issues.push({ severity: 'warning', code: 'disabled-start', message: 'The Start node is disabled; it runs anyway', nodeId: start.id });
	}

	// Edges.
	const edgeIds = new Set<string>();
	const edgeKeys = new Set<string>();
	const validEdges: IWorkflowEdge[] = [];
	definition.edges.forEach((edge, index) => {
		const path = `edges[${index}]`;
		if (edgeIds.has(edge.id)) {
			issues.push({ severity: 'error', code: 'duplicate-edge-id', message: `Two connections have the id "${edge.id}"`, edgeId: edge.id, path });
		}
		edgeIds.add(edge.id);
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) {
			issues.push({ severity: 'error', code: 'edge-unknown-node', message: `Connection ${edge.id} refers to a missing node "${!from ? edge.from : edge.to}"`, edgeId: edge.id, path });
			return;
		}
		const fromType = getWorkflowNodeType(from.type);
		const toType = getWorkflowNodeType(to.type);
		if (fromType && !fromType.outputs(from.config).some(port => port.id === edge.port)) {
			issues.push({ severity: 'error', code: 'edge-unknown-port', message: `${nodeDisplayName(from)} has no output "${edge.port}"`, edgeId: edge.id, nodeId: from.id, path: `${path}.port` });
			return;
		}
		if (toType && !toType.inputs.some(port => port.id === (edge.toPort ?? 'in'))) {
			issues.push({ severity: 'error', code: 'edge-unknown-input', message: toType.inputs.length ? `${nodeDisplayName(to)} has no input "${edge.toPort}"` : `Nothing can lead into ${nodeDisplayName(to)}`, edgeId: edge.id, nodeId: to.id, path });
			return;
		}
		const key = `${edge.from}\u0000${edge.port}\u0000${edge.to}\u0000${edge.toPort ?? 'in'}`;
		if (edgeKeys.has(key)) {
			issues.push({ severity: 'warning', code: 'duplicate-edge', message: `${nodeDisplayName(from)} is connected to ${nodeDisplayName(to)} twice through "${edge.port}"`, edgeId: edge.id, path });
		}
		edgeKeys.add(key);
		validEdges.push(edge);
	});
	const graph: IWorkflowDefinition = { ...definition, edges: validEdges };

	// Cycles must pass through a loop or for-each node.
	const back = workflowBackEdges(graph);
	for (const edge of illegalCycleEdges(graph, back)) {
		issues.push({ severity: 'error', code: 'cycle', message: `${nodeDisplayName(byId.get(edge.from)!)} → ${nodeDisplayName(byId.get(edge.to)!)} closes a cycle without a Loop node; route repeats through a Loop`, edgeId: edge.id, nodeId: edge.to });
	}

	// Reachability from the start.
	const out = adjacency(graph, 'out');
	if (start) {
		const reached = reach(out, [start.id]);
		reached.add(start.id);
		for (const node of definition.nodes) {
			if (!reached.has(node.id) && byId.get(node.id) === node) {
				issues.push({ severity: 'warning', code: 'unreachable', message: `${nodeDisplayName(node)} is not connected to the Start node, so it never runs`, nodeId: node.id });
			}
		}
	}

	// Upstream sets (lazily, per node) and loop bodies for template checks.
	const upstreamCache = new Map<string, ReadonlySet<string>>();
	const upstream = (nodeId: string) => {
		let set = upstreamCache.get(nodeId);
		if (!set) {
			upstreamCache.set(nodeId, set = new Set(upstreamNodes(graph, nodeId)));
		}
		return set;
	};
	const inLoopBody = new Set<string>();
	for (const node of definition.nodes) {
		const type = getWorkflowNodeType(node.type);
		if (type && LOOP_CONTROLS.has(type.control)) {
			const loopPort = type.outputs(node.config).find(port => port.kind === 'loop')?.id;
			loopBody(graph, node.id, loopPort).forEach(id => inLoopBody.add(id));
		}
	}
	const ctx: IValidationContext = { definition, issues, ids: new Set(byId.keys()), upstream, inLoopBody };

	// Per node: fields, ports, type rules.
	const into = adjacency(graph, 'in');
	definition.nodes.forEach((node, index) => {
		const type = getWorkflowNodeType(node.type);
		if (!type || byId.get(node.id) !== node) {
			return;
		}
		validateFields(ctx, node, index, type);

		const ports = type.outputs(node.config);
		const wired = new Set((out.get(node.id) ?? []).map(edge => edge.port));
		for (const port of ports) {
			if (!wired.has(port.id)) {
				issues.push({
					severity: 'info', code: 'unwired-port', nodeId: node.id, path: `nodes[${index}].outputs.${port.id}`,
					message: port.kind === 'failure' ? `"${port.label}" is not connected: the run fails when ${nodeDisplayName(node)} ends there` : `"${port.label}" is not connected: the run ends there`,
				});
			}
		}

		if (type.control === 'join' && (into.get(node.id)?.length ?? 0) < 2) {
			issues.push({ severity: 'info', code: 'join-single-input', message: `${nodeDisplayName(node)} has fewer than two incoming branches`, nodeId: node.id });
		}
		if (type.control === 'loop' && !wired.has('repeat')) {
			issues.push({ severity: 'warning', code: 'loop-no-body', message: `Nothing is connected to "repeat" of ${nodeDisplayName(node)}`, nodeId: node.id });
		}
		if (type.control === 'forEach') {
			if (!wired.has('item')) {
				issues.push({ severity: 'warning', code: 'for-each-empty-body', message: `Nothing is connected to "item" of ${nodeDisplayName(node)}, so nothing runs per item`, nodeId: node.id });
			} else {
				const body = loopBody(graph, node.id, 'item');
				for (const id of body) {
					if (getWorkflowNodeType(byId.get(id)?.type ?? '')?.control === 'end') {
						issues.push({ severity: 'warning', code: 'for-each-end-in-body', message: `${nodeDisplayName(byId.get(id)!)} is inside the per-item body of ${nodeDisplayName(node)}: reaching it ends the whole run`, nodeId: id });
					}
				}
				const afterDone = loopBody(graph, node.id, 'done');
				const shared = [...body].filter(id => afterDone.has(id)).map(id => nodeDisplayName(byId.get(id)!));
				if (shared.length) {
					issues.push({ severity: 'warning', code: 'for-each-shared-body', message: `${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` and ${shared.length - 3} more` : ''} run once per item and again after "done" of ${nodeDisplayName(node)}`, nodeId: node.id });
				}
			}
		}
		for (const extra of type.validate?.(node, definition) ?? []) {
			issues.push(node.disabled && extra.severity === 'error' ? { ...extra, severity: 'warning' } : extra);
		}
	});

	// Inputs and settings.
	const inputNames = new Set<string>();
	(definition.inputs ?? []).forEach((input, index) => {
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(input.name)) {
			issues.push({ severity: 'error', code: 'invalid-input', message: `"${input.name}" is not a valid input name`, path: `inputs[${index}].name` });
		} else if (inputNames.has(input.name)) {
			issues.push({ severity: 'error', code: 'duplicate-input', message: `Two inputs are called "${input.name}"`, path: `inputs[${index}].name` });
		}
		inputNames.add(input.name);
	});
	const settings = definition.settings;
	if (settings?.concurrency !== undefined && (!Number.isInteger(settings.concurrency) || settings.concurrency < 1)) {
		issues.push({ severity: 'error', code: 'settings-range', message: 'Concurrency must be a whole number of at least 1', path: 'settings.concurrency' });
	}
	if (settings?.maxSteps !== undefined) {
		if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1) {
			issues.push({ severity: 'error', code: 'settings-range', message: 'Max steps must be a whole number of at least 1', path: 'settings.maxSteps' });
		} else if (settings.maxSteps > WORKFLOW_HARD_MAX_STEPS) {
			issues.push({ severity: 'warning', code: 'settings-range', message: `Max steps is capped at ${WORKFLOW_HARD_MAX_STEPS}`, path: 'settings.maxSteps' });
		}
	}
	if (settings?.timeoutMs !== undefined && !(settings.timeoutMs > 0)) {
		issues.push({ severity: 'error', code: 'settings-range', message: 'The run timeout must be positive', path: 'settings.timeoutMs' });
	}
	return issues;
}

//#endregion

//#region Layout

export interface IWorkflowLayoutOptions {
	/** Horizontal gap between layers and vertical gap between nodes, in canvas px. */
	readonly layerGap?: number;
	readonly nodeGap?: number;
	/**
	 * Node sizes by id (the canvas measures them); a default card size otherwise. `input` and
	 * `outputs` (px from the node's top to its input handle and to each output port) let the
	 * layout line nodes up by where their edges meet them, so chains come out straight; nodes are
	 * centred on each other without them.
	 */
	readonly sizes?: ReadonlyMap<string, { readonly width: number; readonly height: number; readonly input?: number; readonly outputs?: readonly number[] }>;
	/** Only lay out these nodes (the selection); the others stay put. */
	readonly only?: ReadonlySet<string>;
	readonly snap?: number;
}

/** Card sizes when the canvas has not measured a node. */
export const WORKFLOW_DEFAULT_NODE_SIZE = { width: 240, height: 72 } as const;
const SHAPE_SIZES = { card: WORKFLOW_DEFAULT_NODE_SIZE, round: { width: 160, height: 56 }, pill: { width: 200, height: 44 } } as const;
const DUMMY_HEIGHT = 16;
const SWEEPS = 12;

interface ILayoutEdge {
	readonly from: string;
	readonly to: string;
	/** Port position of the source (0 = top), and how many ports it has. */
	readonly port: number;
	readonly ports: number;
}

/**
 * Left-to-right layered layout (start on the left, branches stacked, loops drawn back). Positions
 * (top-left corners) by node id. Back-edges into loops are left out of the layering; layers come
 * from the longest path; long edges get placeholder slots so they route between nodes; barycenter
 * sweeps order each layer to cut crossings, with a node's first port's targets above its later
 * ones; vertical positions pull toward neighbours without overlapping (isotonic regression). The
 * result is anchored at the start node (or the selection's top-left) so the graph does not jump.
 */
export function autoLayout(definition: IWorkflowDefinition, options?: IWorkflowLayoutOptions): ReadonlyMap<string, IWorkflowPosition> {
	const layerGap = options?.layerGap ?? 96;
	const nodeGap = options?.nodeGap ?? 40;
	const snap = options?.snap && options.snap > 0 ? options.snap : 0;
	const result = new Map<string, IWorkflowPosition>(definition.nodes.map(node => [node.id, node.position]));
	const nodes = definition.nodes.filter((node, index) => (!options?.only || options.only.has(node.id)) && definition.nodes.findIndex(other => other.id === node.id) === index);
	if (!nodes.length) {
		return result;
	}
	const ids = new Set(nodes.map(node => node.id));
	const byId = new Map(nodes.map(node => [node.id, node]));
	const sizeOf = (id: string) => {
		const measured = options?.sizes?.get(id);
		if (measured) {
			return measured;
		}
		const node = byId.get(id);
		const shape = (node && getWorkflowNodeType(node.type)?.shape) ?? 'card';
		return SHAPE_SIZES[shape];
	};

	// Edges inside the laid-out set, without back-edges and self-loops; any other cycle is broken by DFS.
	const back = new Set(workflowBackEdges(definition));
	// A loop entered only from its own body (tests fail → retry → fix → tests) would be a root and
	// land in the first column, far from everything it joins. Lay its entries out as forward edges
	// instead; the DFS below then breaks the cycle where the body returns to the step it retries.
	for (const node of nodes) {
		const control = getWorkflowNodeType(node.type)?.control;
		const into = definition.edges.filter(edge => edge.to === node.id && edge.from !== node.id && ids.has(edge.from));
		if (control && LOOP_CONTROLS.has(control) && into.length && into.every(edge => back.has(edge.id))) {
			for (const edge of into) {
				back.delete(edge.id);
			}
		}
	}
	const candidates = definition.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to && !back.has(edge.id));
	const portIndex = (edge: IWorkflowEdge) => {
		const ports = nodeOutputs(byId.get(edge.from)!);
		const index = ports.findIndex(port => port.id === edge.port);
		return { port: index < 0 ? ports.length : index, ports: Math.max(1, ports.length) };
	};
	const broken = new Set(illegalCycleEdges({ ...definition, nodes, edges: candidates }, new Set()).map(edge => edge.id));
	const edges: ILayoutEdge[] = candidates.filter(edge => !broken.has(edge.id)).map(edge => ({ from: edge.from, to: edge.to, ...portIndex(edge) }));

	// Longest-path layers.
	const layerOf = new Map<string, number>();
	const order = topologicalOrder({ ...definition, nodes, edges: candidates.filter(edge => !broken.has(edge.id)) });
	const incoming = new Map<string, ILayoutEdge[]>();
	for (const edge of edges) {
		incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
	}
	for (const id of order) {
		const preds = incoming.get(id) ?? [];
		layerOf.set(id, preds.length ? Math.max(...preds.map(edge => (layerOf.get(edge.from) ?? 0) + 1)) : 0);
	}

	// Placeholder nodes along edges spanning several layers.
	type Item = { readonly id: string; readonly dummy: boolean };
	const items = new Map<string, Item>(nodes.map(node => [node.id, { id: node.id, dummy: false }]));
	const segments: ILayoutEdge[] = [];
	let dummyCount = 0;
	for (const edge of edges) {
		const from = layerOf.get(edge.from)!;
		const to = layerOf.get(edge.to)!;
		let previous = edge.from;
		let previousPort = edge.port;
		let previousPorts = edge.ports;
		for (let layer = from + 1; layer < to; layer++) {
			const id = `\u0000dummy${dummyCount++}`;
			items.set(id, { id, dummy: true });
			layerOf.set(id, layer);
			segments.push({ from: previous, to: id, port: previousPort, ports: previousPorts });
			previous = id;
			previousPort = 0;
			previousPorts = 1;
		}
		segments.push({ from: previous, to: edge.to, port: previousPort, ports: previousPorts });
	}
	const layerCount = Math.max(...[...layerOf.values()]) + 1;
	const layers: string[][] = Array.from({ length: layerCount }, () => []);
	const preds = new Map<string, ILayoutEdge[]>();
	const succs = new Map<string, ILayoutEdge[]>();
	for (const segment of segments) {
		preds.set(segment.to, [...(preds.get(segment.to) ?? []), segment]);
		succs.set(segment.from, [...(succs.get(segment.from) ?? []), segment]);
	}

	// Initial order: depth-first from the roots, first port first, so branches start in port order.
	const visited = new Set<string>();
	const visit = (id: string) => {
		const stack = [id];
		while (stack.length) {
			const current = stack.pop()!;
			if (visited.has(current)) {
				continue;
			}
			visited.add(current);
			layers[layerOf.get(current)!].push(current);
			const next = [...(succs.get(current) ?? [])].sort((a, b) => a.port - b.port);
			for (let i = next.length - 1; i >= 0; i--) {
				stack.push(next[i].to);
			}
		}
	};
	const startNode = nodes.find(node => getWorkflowNodeType(node.type)?.control === 'start');
	if (startNode) {
		visit(startNode.id);
	}
	for (const id of [...order, ...items.keys()]) {
		if (!(preds.get(id)?.length)) {
			visit(id);
		}
	}
	for (const id of items.keys()) {
		visit(id);
	}

	// Barycenter sweeps; keep the order with the fewest crossings.
	const position = new Map<string, number>();
	const index = () => layers.forEach(layer => layer.forEach((id, i) => position.set(id, i)));
	index();
	const slot = (segment: ILayoutEdge) => position.get(segment.from)! + (segment.port + 1) / (segment.ports + 1) - 0.5;
	const crossings = () => {
		let total = 0;
		for (let layer = 1; layer < layers.length; layer++) {
			const list = layers[layer].flatMap(id => (preds.get(id) ?? []).map(segment => [slot(segment), position.get(id)!] as const));
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					if ((list[i][0] - list[j][0]) * (list[i][1] - list[j][1]) < 0) {
						total++;
					}
				}
			}
		}
		return total;
	};
	let best = layers.map(layer => [...layer]);
	let bestCrossings = crossings();
	for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep++) {
		const down = sweep % 2 === 0;
		for (let step = 1; step < layers.length; step++) {
			const layer = down ? step : layers.length - 1 - step;
			const key = new Map<string, number>();
			for (const id of layers[layer]) {
				const neighbours = down ? (preds.get(id) ?? []).map(slot) : (succs.get(id) ?? []).map(segment => position.get(segment.to)!);
				key.set(id, neighbours.length ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length : position.get(id)!);
			}
			layers[layer].sort((a, b) => key.get(a)! - key.get(b)! || position.get(a)! - position.get(b)!);
			layers[layer].forEach((id, i) => position.set(id, i));
		}
		const count = crossings();
		if (count < bestCrossings) {
			bestCrossings = count;
			best = layers.map(layer => [...layer]);
		}
	}
	best.forEach((layer, i) => layers[i] = layer);
	index();

	// Columns: each layer as wide as its widest node.
	const height = (id: string) => items.get(id)!.dummy ? DUMMY_HEIGHT : sizeOf(id).height;
	const columnX: number[] = [];
	let x = 0;
	for (const layer of layers) {
		x = snap ? Math.ceil(x / snap) * snap : x;
		columnX.push(x);
		const width = Math.max(0, ...layer.filter(id => !items.get(id)!.dummy).map(id => sizeOf(id).width));
		x += width + layerGap;
	}

	// Rows: start stacked and centred, then pull toward neighbours a few times. `center` is each
	// node's anchor line: where its edges meet it when the sizes say so, else its middle.
	const anchorOf = (id: string) => items.get(id)!.dummy ? DUMMY_HEIGHT / 2 : options?.sizes?.get(id)?.input ?? height(id) / 2;
	const center = new Map<string, number>();
	for (const layer of layers) {
		const total = layer.reduce((sum, id) => sum + height(id), 0) + nodeGap * Math.max(0, layer.length - 1);
		let y = -total / 2;
		for (const id of layer) {
			center.set(id, y + anchorOf(id));
			y += height(id) + nodeGap;
		}
	}
	const portOffset = (segment: ILayoutEdge) => {
		const ports = items.get(segment.from)!.dummy ? undefined : options?.sizes?.get(segment.from)?.outputs;
		if (ports?.length) {
			return ports[Math.min(segment.port, ports.length - 1)] - anchorOf(segment.from);
		}
		if (segment.ports <= 1) {
			return 0;
		}
		const spacing = Math.min(28, height(segment.from) / segment.ports);
		return (segment.port - (segment.ports - 1) / 2) * spacing;
	};
	const place = (layer: readonly string[], desired: readonly number[]) => {
		// Isotonic regression (pool adjacent violators) of desired centres minus fixed offsets: the
		// closest positions that keep the order and the gaps.
		const offsets: number[] = [];
		let offset = 0;
		layer.forEach((id, i) => {
			if (i > 0) {
				offset += (height(layer[i - 1]) - anchorOf(layer[i - 1])) + anchorOf(id) + nodeGap;
			}
			offsets.push(offset);
		});
		const blocks: { sum: number; count: number }[] = [];
		desired.forEach((value, i) => {
			blocks.push({ sum: value - offsets[i], count: 1 });
			while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].count > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count) {
				const last = blocks.pop()!;
				blocks[blocks.length - 1].sum += last.sum;
				blocks[blocks.length - 1].count += last.count;
			}
		});
		let i = 0;
		for (const block of blocks) {
			const mean = block.sum / block.count;
			for (let k = 0; k < block.count; k++, i++) {
				center.set(layer[i], mean + offsets[i]);
			}
		}
	};
	for (let pass = 0; pass < 8; pass++) {
		const down = pass % 2 === 0;
		for (let step = down ? 1 : layers.length - 2; down ? step < layers.length : step >= 0; step += down ? 1 : -1) {
			const layer = layers[step];
			const desired = layer.map(id => {
				const neighbours = down
					? (preds.get(id) ?? []).map(segment => center.get(segment.from)! + portOffset(segment))
					: (succs.get(id) ?? []).map(segment => center.get(segment.to)! - portOffset(segment));
				return neighbours.length ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length : center.get(id)!;
			});
			place(layer, desired);
		}
	}

	// Top-left corners, snapped without letting snapping close a gap.
	const local = new Map<string, IWorkflowPosition>();
	for (let layer = 0; layer < layers.length; layer++) {
		let floor = -Infinity;
		for (const id of layers[layer]) {
			let y = center.get(id)! - anchorOf(id);
			if (snap) {
				y = Math.max(Math.round(y / snap) * snap, floor === -Infinity ? -Infinity : Math.ceil(floor / snap) * snap);
			}
			floor = y + height(id) + nodeGap;
			if (!items.get(id)!.dummy) {
				local.set(id, { x: columnX[layer], y });
			}
		}
	}

	// Anchor: the start node stays put in a full layout; a selection keeps its top-left corner.
	let dx: number;
	let dy: number;
	if (!options?.only && startNode) {
		dx = startNode.position.x - local.get(startNode.id)!.x;
		dy = startNode.position.y - local.get(startNode.id)!.y;
	} else {
		dx = Math.min(...nodes.map(node => node.position.x)) - Math.min(...[...local.values()].map(p => p.x));
		dy = Math.min(...nodes.map(node => node.position.y)) - Math.min(...[...local.values()].map(p => p.y));
	}
	if (snap) {
		dx = Math.round(dx / snap) * snap;
		dy = Math.round(dy / snap) * snap;
	}
	for (const [id, p] of local) {
		result.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
	}
	return result;
}

//#endregion
