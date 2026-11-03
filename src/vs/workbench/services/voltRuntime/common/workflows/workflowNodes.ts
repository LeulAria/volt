/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WORKFLOW_NODE_TYPES } from './workflowNodeCatalog.js';
import { IWorkflowNode, IWorkflowNodeType, IWorkflowPortDef, WorkflowNodeCategory, WorkflowRecord, WorkflowValue } from './workflowTypes.js';

/**
 * The node type registry: every type the builder offers, the YAML accepts and the engine runs.
 * Definitions live in `workflowNodeCatalog.ts`; this file is the lookup everyone shares.
 */

let index: Map<string, IWorkflowNodeType> | undefined;

function types(): Map<string, IWorkflowNodeType> {
	if (!index) {
		index = new Map(WORKFLOW_NODE_TYPES.map(type => [type.type, type]));
	}
	return index;
}

export function getWorkflowNodeType(type: string): IWorkflowNodeType | undefined {
	return types().get(type);
}

/** Every registered type in catalog order, hidden ones included (pickers filter `hidden`). */
export function workflowNodeTypes(): readonly IWorkflowNodeType[] {
	return WORKFLOW_NODE_TYPES;
}

export function workflowNodeTypesIn(category: WorkflowNodeCategory): readonly IWorkflowNodeType[] {
	return WORKFLOW_NODE_TYPES.filter(type => type.category === category && !type.hidden);
}

/** A new node's config: every field's default. */
export function defaultNodeConfig(type: IWorkflowNodeType): WorkflowRecord {
	const config: Record<string, WorkflowValue> = {};
	for (const field of type.fields) {
		if (field.default !== undefined) {
			config[field.key] = field.default;
		}
	}
	return config;
}

/** The node's output ports for its current config; none for an unknown type. */
export function nodeOutputs(node: Pick<IWorkflowNode, 'type' | 'config'>): readonly IWorkflowPortDef[] {
	return getWorkflowNodeType(node.type)?.outputs(node.config) ?? [];
}

export function nodeInputs(node: Pick<IWorkflowNode, 'type'>): readonly IWorkflowPortDef[] {
	return getWorkflowNodeType(node.type)?.inputs ?? [{ id: 'in', label: 'In' }];
}

export function nodeDisplayName(node: Pick<IWorkflowNode, 'type' | 'name' | 'id'>): string {
	return node.name?.trim() || getWorkflowNodeType(node.type)?.label || node.id;
}
