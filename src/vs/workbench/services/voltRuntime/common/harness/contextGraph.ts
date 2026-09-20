/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextChannel, IContextItem, estimateTokens } from './contextEngine.js';

/**
 * Context graph. Items are nodes; retrieval, summary, and dependency links are edges. The
 * packer still does the budget math - this decides *which* item of a channel is the one
 * worth keeping when two compete.
 *
 * Edges exist so a retrieved file that supports the goal outranks a retrieved file that
 * merely matched a token, and so a summary of six turns is preferred over any one of them.
 */

export type ContextEdgeKind = 'retrieved-for' | 'summarizes' | 'depends-on' | 'supports';

export interface IContextNode {
	readonly id: string;
	readonly channel: ContextChannel;
	readonly label: string;
	readonly text: string;
	readonly score: number;
	readonly pinned?: boolean;
}

export interface IContextEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: ContextEdgeKind;
}

export interface IContextGraph {
	readonly nodes: readonly IContextNode[];
	readonly edges: readonly IContextEdge[];
}

export function buildContextGraph(items: readonly IContextItem[], query = ''): IContextGraph {
	const tokens = tokenize(query);
	const nodes: IContextNode[] = items.map(item => ({
		id: item.id,
		channel: item.channel,
		label: item.id,
		text: item.text,
		score: scoreItem(item, tokens),
		...(item.pinned ? { pinned: true } : {}),
	}));

	const edges: IContextEdge[] = [];
	const byChannel = new Map<ContextChannel, IContextNode[]>();
	for (const node of nodes) {
		const list = byChannel.get(node.channel) ?? [];
		list.push(node);
		byChannel.set(node.channel, list);
	}

	const goal = byChannel.get('goal')?.[0];
	if (goal) {
		for (const node of nodes) {
			if (node.id === goal.id) {
				continue;
			}
			if (node.channel === 'files' || node.channel === 'memory' || node.channel === 'evidence') {
				edges.push({ from: node.id, to: goal.id, kind: 'retrieved-for' });
			}
			if (node.channel === 'rules' || node.channel === 'plan') {
				edges.push({ from: node.id, to: goal.id, kind: 'supports' });
			}
		}
	}

	const history = byChannel.get('history') ?? [];
	for (const node of history) {
		if (/\[Earlier turns were compacted/.test(node.text) || /\[Condensed account/.test(node.text)) {
			for (const other of history) {
				if (other.id !== node.id) {
					edges.push({ from: node.id, to: other.id, kind: 'summarizes' });
				}
			}
		}
	}

	return { nodes, edges };
}

/**
 * Flatten the graph back into packer items, highest graph-score first within each channel
 * so the round-robin packer sees the most useful entry of every channel first.
 */
export function prioritizeGraph(graph: IContextGraph): IContextItem[] {
	const inbound = new Map<string, number>();
	for (const edge of graph.edges) {
		inbound.set(edge.from, (inbound.get(edge.from) ?? 0) + (edge.kind === 'supports' || edge.kind === 'retrieved-for' ? 0.1 : 0.05));
	}
	return [...graph.nodes]
		.sort((a, b) => {
			if (!!a.pinned !== !!b.pinned) {
				return a.pinned ? -1 : 1;
			}
			return (b.score + (inbound.get(b.id) ?? 0)) - (a.score + (inbound.get(a.id) ?? 0));
		})
		.map(node => ({
			id: node.id,
			channel: node.channel,
			text: node.text,
			priority: node.score,
			...(node.pinned ? { pinned: true } : {}),
		}));
}

export function graphTokens(graph: IContextGraph): number {
	return graph.nodes.reduce((total, node) => total + estimateTokens(node.text), 0);
}

function scoreItem(item: IContextItem, tokens: readonly string[]): number {
	if (item.pinned) {
		return 1;
	}
	const base = item.priority;
	if (!tokens.length) {
		return base;
	}
	const hay = item.text.toLowerCase();
	const hits = tokens.filter(token => hay.includes(token)).length;
	return Math.min(1, base + hits * 0.05);
}

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9_./-]+/).filter(token => token.length > 1);
}
