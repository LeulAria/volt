/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { defaultNodeConfig, getWorkflowNodeType, nodeOutputs } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowEdge, IWorkflowGroup, IWorkflowNode, IWorkflowPosition, WorkflowRecord, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';

/**
 * The builder's one source of truth: the definition being edited, its undo/redo history, the
 * selection and the dirty state. The canvas, the inspector, the block picker and the YAML editor
 * all change the workflow through `apply` (or a helper built on it), so every edit is undoable
 * the same way and everyone redraws from `onDidChange`. Pure: no DOM.
 */

export type WorkflowEditSource = 'canvas' | 'inspector' | 'picker' | 'yaml' | 'layout' | 'external' | 'undo' | 'redo';

export interface IWorkflowModelChange {
	readonly definition: IWorkflowDefinition;
	readonly previous: IWorkflowDefinition;
	readonly label: string;
	readonly source: WorkflowEditSource;
}

interface IHistoryEntry {
	readonly definition: IWorkflowDefinition;
	readonly label: string;
	readonly coalesce?: string;
	readonly at: number;
}

/** Edits with the same coalesce key this close together are one undo step (a drag, typing). */
const COALESCE_MS = 1200;
const HISTORY_LIMIT = 200;

export interface IAddNodeOptions {
	readonly config?: WorkflowRecord;
	readonly name?: string;
	/** Connect an output port of an existing node to the new node. */
	readonly connectFrom?: { readonly nodeId: string; readonly port: string };
	/** Connect the new node's first output to this node (inserting into an edge). */
	readonly connectTo?: { readonly nodeId: string; readonly toPort?: string };
	/** Replace this edge by from → new → to. */
	readonly splitEdgeId?: string;
}

export function edgeId(from: string, port: string, to: string, toPort?: string): string {
	return `${from}.${port}->${to}${toPort && toPort !== 'in' ? `.${toPort}` : ''}`;
}

/** A node id not used yet, from the type (`agent`, `agent_2`, …). */
export function uniqueNodeId(definition: Pick<IWorkflowDefinition, 'nodes'>, base: string): string {
	const stem = (base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '') || 'node').slice(0, 48);
	const taken = new Set(definition.nodes.map(node => node.id));
	if (!taken.has(stem)) {
		return stem;
	}
	for (let n = 2; ; n++) {
		const candidate = `${stem}_${n}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

export class WorkflowEditorModel extends Disposable {

	private current: IWorkflowDefinition;
	private saved: IWorkflowDefinition;
	private savedJson: string;
	private readonly undoStack: IHistoryEntry[] = [];
	private readonly redoStack: IHistoryEntry[] = [];
	private selected: readonly string[] = [];
	private wasDirty = false;

	private readonly _onDidChange = this._register(new Emitter<IWorkflowModelChange>());
	readonly onDidChange: Event<IWorkflowModelChange> = this._onDidChange.event;
	private readonly _onDidChangeSelection = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeSelection: Event<readonly string[]> = this._onDidChangeSelection.event;
	private readonly _onDidChangeDirty = this._register(new Emitter<boolean>());
	readonly onDidChangeDirty: Event<boolean> = this._onDidChangeDirty.event;

	constructor(definition: IWorkflowDefinition, private readonly clock: () => number = Date.now) {
		super();
		this.current = definition;
		this.saved = definition;
		this.savedJson = JSON.stringify(definition);
	}

	get definition(): IWorkflowDefinition {
		return this.current;
	}

	get dirty(): boolean {
		return this.current !== this.saved && JSON.stringify(this.current) !== this.savedJson;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	get undoLabel(): string | undefined {
		return this.undoStack.at(-1)?.label;
	}

	get redoLabel(): string | undefined {
		return this.redoStack.at(-1)?.label;
	}

	get selection(): readonly string[] {
		return this.selected;
	}

	node(id: string): IWorkflowNode | undefined {
		return this.current.nodes.find(node => node.id === id);
	}

	//#region Core

	/** Changes the definition as one undo step (merged with the previous step of the same `coalesce` key). */
	apply(label: string, mutate: (definition: IWorkflowDefinition) => IWorkflowDefinition, source: WorkflowEditSource = 'canvas', coalesce?: string): void {
		const previous = this.current;
		const next = mutate(previous);
		if (next === previous) {
			return;
		}
		const now = this.clock();
		const top = this.undoStack.at(-1);
		if (!(coalesce && top?.coalesce === coalesce && now - top.at < COALESCE_MS)) {
			this.undoStack.push({ definition: previous, label, coalesce, at: now });
			if (this.undoStack.length > HISTORY_LIMIT) {
				this.undoStack.shift();
			}
		} else {
			this.undoStack[this.undoStack.length - 1] = { ...top, at: now };
		}
		this.redoStack.length = 0;
		this.set(next, previous, label, source);
	}

	/** Swaps in a whole definition (a YAML edit, a reload from disk). Undoable unless told otherwise. */
	replace(definition: IWorkflowDefinition, source: WorkflowEditSource, options?: { readonly undoable?: boolean; readonly label?: string }): void {
		if (definition === this.current) {
			return;
		}
		const label = options?.label ?? 'Replace workflow';
		if (options?.undoable === false) {
			this.set(definition, this.current, label, source);
			return;
		}
		this.apply(label, () => definition, source);
	}

	undo(): void {
		const entry = this.undoStack.pop();
		if (!entry) {
			return;
		}
		this.redoStack.push({ definition: this.current, label: entry.label, at: this.clock() });
		this.set(entry.definition, this.current, entry.label, 'undo');
	}

	redo(): void {
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}
		this.undoStack.push({ definition: this.current, label: entry.label, at: this.clock() });
		this.set(entry.definition, this.current, entry.label, 'redo');
	}

	/** After a save: the saved definition (with its bumped revision) becomes the clean state, not an undo step. */
	markSaved(definition: IWorkflowDefinition = this.current): void {
		if (definition !== this.current) {
			// Keep the user's history pointing at the same content; only the stored revision moved.
			this.current = definition;
		}
		this.saved = definition;
		this.savedJson = JSON.stringify(definition);
		this.syncDirty();
	}

	setSelection(ids: readonly string[]): void {
		const known = ids.filter(id => this.current.nodes.some(node => node.id === id));
		if (known.length === this.selected.length && known.every((id, i) => id === this.selected[i])) {
			return;
		}
		this.selected = known;
		this._onDidChangeSelection.fire(known);
	}

	private set(next: IWorkflowDefinition, previous: IWorkflowDefinition, label: string, source: WorkflowEditSource): void {
		this.current = next;
		if (this.selected.some(id => !next.nodes.some(node => node.id === id))) {
			this.selected = this.selected.filter(id => next.nodes.some(node => node.id === id));
			this._onDidChangeSelection.fire(this.selected);
		}
		this._onDidChange.fire({ definition: next, previous, label, source });
		this.syncDirty();
	}

	private syncDirty(): void {
		const dirty = this.dirty;
		if (dirty !== this.wasDirty) {
			this.wasDirty = dirty;
			this._onDidChangeDirty.fire(dirty);
		}
	}

	//#endregion

	//#region Helpers

	/** Adds a node of `type` at `position` (connected as asked) and selects it. Returns its id. */
	addNode(type: string, position: IWorkflowPosition, options: IAddNodeOptions = {}, source: WorkflowEditSource = 'picker'): string {
		const nodeType = getWorkflowNodeType(type);
		const id = uniqueNodeId(this.current, type);
		const node: IWorkflowNode = {
			id,
			type,
			position: { x: Math.round(position.x), y: Math.round(position.y) },
			config: { ...(nodeType ? defaultNodeConfig(nodeType) : {}), ...options.config },
			...(options.name ? { name: options.name } : {}),
		};
		this.apply(`Add ${nodeType?.label ?? type}`, definition => {
			let edges = definition.edges;
			const split = options.splitEdgeId ? edges.find(edge => edge.id === options.splitEdgeId) : undefined;
			const firstOut = nodeOutputs(node)[0]?.id;
			if (split) {
				edges = edges.filter(edge => edge.id !== split.id);
				edges = [...edges, makeEdge(split.from, split.port, id), ...(firstOut ? [makeEdge(id, firstOut, split.to, split.toPort)] : [])];
			}
			if (options.connectFrom) {
				edges = [...edges, makeEdge(options.connectFrom.nodeId, options.connectFrom.port, id)];
			}
			if (options.connectTo && firstOut) {
				edges = [...edges, makeEdge(id, firstOut, options.connectTo.nodeId, options.connectTo.toPort)];
			}
			return { ...definition, nodes: [...definition.nodes, node], edges: dedupeEdges(edges) };
		}, source);
		this.setSelection([id]);
		return id;
	}

	/** Pastes nodes (ids remapped when taken), their inner edges and groups, offset by `delta`. Returns the new ids. */
	insertNodes(nodes: readonly IWorkflowNode[], edges: readonly IWorkflowEdge[], delta: IWorkflowPosition, groups: readonly IWorkflowGroup[] = [], label = 'Paste'): string[] {
		const ids = new Map<string, string>();
		let scratch: Pick<IWorkflowDefinition, 'nodes'> = this.current;
		const added: IWorkflowNode[] = [];
		for (const node of nodes) {
			const type = getWorkflowNodeType(node.type);
			if (type?.singleton && this.current.nodes.some(existing => existing.type === node.type)) {
				continue;
			}
			const id = uniqueNodeId(scratch, node.id);
			ids.set(node.id, id);
			const copy: IWorkflowNode = { ...node, id, position: { x: Math.round(node.position.x + delta.x), y: Math.round(node.position.y + delta.y) } };
			added.push(copy);
			scratch = { nodes: [...scratch.nodes, copy] };
		}
		if (!added.length) {
			return [];
		}
		const newEdges = edges.flatMap(edge => {
			const from = ids.get(edge.from);
			const to = ids.get(edge.to);
			return from && to ? [makeEdge(from, edge.port, to, edge.toPort, edge.label)] : [];
		});
		const takenGroups = new Set((this.current.groups ?? []).map(group => group.id));
		const newGroups = groups.flatMap(group => {
			const members = group.nodes.flatMap(id => ids.get(id) ?? []);
			if (!members.length) {
				return [];
			}
			let id = group.id;
			for (let n = 2; takenGroups.has(id); n++) {
				id = `${group.id}_${n}`;
			}
			takenGroups.add(id);
			return [{ ...group, id, nodes: members }];
		});
		this.apply(label, definition => ({
			...definition,
			nodes: [...definition.nodes, ...added],
			edges: dedupeEdges([...definition.edges, ...newEdges]),
			...(newGroups.length ? { groups: [...(definition.groups ?? []), ...newGroups] } : {}),
		}), 'canvas');
		const result = added.map(node => node.id);
		this.setSelection(result);
		return result;
	}

	updateNode(id: string, patch: Partial<Omit<IWorkflowNode, 'id'>>, source: WorkflowEditSource = 'inspector', coalesce?: string, label = 'Edit node'): void {
		this.apply(label, definition => {
			const index = definition.nodes.findIndex(node => node.id === id);
			if (index < 0) {
				return definition;
			}
			const nodes = [...definition.nodes];
			nodes[index] = { ...nodes[index], ...patch };
			return { ...definition, nodes, edges: pruneEdges(definition.edges, nodes) };
		}, source, coalesce);
	}

	/** Sets one config value (`undefined` removes it). Typing in a field coalesces into one undo step. */
	setNodeConfig(id: string, key: string, value: WorkflowValue | undefined, source: WorkflowEditSource = 'inspector'): void {
		const node = this.node(id);
		if (!node) {
			return;
		}
		const config: Record<string, WorkflowValue> = { ...node.config };
		if (value === undefined) {
			delete config[key];
		} else {
			config[key] = value;
		}
		this.updateNode(id, { config }, source, `config:${id}:${key}`, 'Edit setting');
	}

	/** Renames a node id and rewires its edges and groups. False when the id is taken or invalid. */
	renameNodeId(id: string, next: string): boolean {
		if (id === next || !/^[a-z][a-z0-9_-]{0,63}$/.test(next) || this.current.nodes.some(node => node.id === next)) {
			return false;
		}
		// Read before applying: the change prunes ids that no longer exist from the selection.
		const selection = this.selected.map(selected => selected === id ? next : selected);
		this.apply('Rename node id', definition => ({
			...definition,
			nodes: definition.nodes.map(node => node.id === id ? { ...node, id: next } : node),
			edges: definition.edges.map(edge => edge.from === id || edge.to === id ? makeEdge(edge.from === id ? next : edge.from, edge.port, edge.to === id ? next : edge.to, edge.toPort, edge.label) : edge),
			...(definition.groups ? { groups: definition.groups.map(group => ({ ...group, nodes: group.nodes.map(member => member === id ? next : member) })) } : {}),
		}), 'inspector');
		this.setSelection(selection);
		return true;
	}

	/** Moves nodes; a drag passes one coalesce key so the whole drag is one undo step. */
	moveNodes(moves: readonly { readonly id: string; readonly position: IWorkflowPosition }[], coalesce?: string, source: WorkflowEditSource = 'canvas', label = 'Move'): void {
		const byId = new Map(moves.map(move => [move.id, move.position]));
		this.apply(label, definition => ({
			...definition,
			nodes: definition.nodes.map(node => {
				const position = byId.get(node.id);
				return position && (position.x !== node.position.x || position.y !== node.position.y) ? { ...node, position: { x: Math.round(position.x), y: Math.round(position.y) } } : node;
			}),
		}), source, coalesce);
	}

	removeNodes(ids: readonly string[]): void {
		const gone = new Set(ids.filter(id => getWorkflowNodeType(this.node(id)?.type ?? '')?.type !== 'start' || this.current.nodes.filter(node => node.type === 'start').length > 1));
		if (!gone.size) {
			return;
		}
		this.apply(gone.size === 1 ? 'Delete node' : `Delete ${gone.size} nodes`, definition => ({
			...definition,
			nodes: definition.nodes.filter(node => !gone.has(node.id)),
			edges: definition.edges.filter(edge => !gone.has(edge.from) && !gone.has(edge.to)),
			...(definition.groups ? { groups: definition.groups.map(group => ({ ...group, nodes: group.nodes.filter(id => !gone.has(id)) })).filter(group => group.nodes.length) } : {}),
		}), 'canvas');
	}

	/** Connects an output port to a node. Returns the edge id, or undefined (self-loop onto itself, unknown nodes). */
	connect(from: string, port: string, to: string, toPort?: string): string | undefined {
		if (from === to || !this.node(from) || !this.node(to)) {
			return undefined;
		}
		const edge = makeEdge(from, port, to, toPort);
		if (this.current.edges.some(existing => existing.id === edge.id)) {
			return edge.id;
		}
		this.apply('Connect', definition => ({ ...definition, edges: [...definition.edges, edge] }), 'canvas');
		return edge.id;
	}

	disconnect(edgeIds: readonly string[]): void {
		const gone = new Set(edgeIds);
		this.apply(gone.size === 1 ? 'Delete connection' : 'Delete connections', definition => {
			const edges = definition.edges.filter(edge => !gone.has(edge.id));
			return edges.length === definition.edges.length ? definition : { ...definition, edges };
		}, 'canvas');
	}

	groupNodes(ids: readonly string[], title = 'Group'): string | undefined {
		const members = ids.filter(id => this.node(id));
		if (!members.length) {
			return undefined;
		}
		const taken = new Set((this.current.groups ?? []).map(group => group.id));
		let id = 'group';
		for (let n = 2; taken.has(id); n++) {
			id = `group_${n}`;
		}
		this.apply('Group', definition => ({
			...definition,
			groups: [...(definition.groups ?? []).map(group => ({ ...group, nodes: group.nodes.filter(node => !members.includes(node)) })).filter(group => group.nodes.length), { id, title, nodes: members }],
		}), 'canvas');
		return id;
	}

	updateGroup(id: string, patch: Partial<Omit<IWorkflowGroup, 'id'>>): void {
		this.apply('Edit group', definition => ({ ...definition, groups: (definition.groups ?? []).map(group => group.id === id ? { ...group, ...patch } : group) }), 'canvas', `group:${id}`);
	}

	ungroup(id: string): void {
		this.apply('Ungroup', definition => ({ ...definition, groups: (definition.groups ?? []).filter(group => group.id !== id) }), 'canvas');
	}

	//#endregion
}

function makeEdge(from: string, port: string, to: string, toPort?: string, label?: string): IWorkflowEdge {
	return { id: edgeId(from, port, to, toPort), from, port, to, ...(toPort && toPort !== 'in' ? { toPort } : {}), ...(label ? { label } : {}) };
}

function dedupeEdges(edges: readonly IWorkflowEdge[]): IWorkflowEdge[] {
	const seen = new Set<string>();
	return edges.filter(edge => !seen.has(edge.id) && !!seen.add(edge.id));
}

/** Drops edges leaving through a port the node no longer has (an If case removed, a verdict renamed). */
function pruneEdges(edges: readonly IWorkflowEdge[], nodes: readonly IWorkflowNode[]): readonly IWorkflowEdge[] {
	const byId = new Map(nodes.map(node => [node.id, node]));
	const kept = edges.filter(edge => {
		const node = byId.get(edge.from);
		if (!node || !getWorkflowNodeType(node.type)) {
			return true;
		}
		return nodeOutputs(node).some(port => port.id === edge.port);
	});
	return kept.length === edges.length ? edges : kept;
}
