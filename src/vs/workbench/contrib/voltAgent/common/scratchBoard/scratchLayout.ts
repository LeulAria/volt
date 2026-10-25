/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Vec } from './scratchMath.js';

/**
 * Layered auto-layout (a small Sugiyama): break cycles, rank by longest path, give an edge that
 * skips ranks a waypoint on every rank it passes, order each rank by barycentres, then pull nodes
 * over their neighbours without breaking the order. Deterministic. The waypoints take room in their
 * ranks, so a long edge runs in a gap of its own instead of through the nodes it passes.
 */

export interface ILayoutNode {
	readonly id: string;
	readonly width: number;
	readonly height: number;
}

export interface ILayoutEdge {
	readonly from: string;
	readonly to: string;
	/** Room across the ranks for the edge's label, so its waypoints keep the label off the nodes beside it. */
	readonly labelWidth?: number;
	/** The label's size along the flow: the gap between the two ranks it joins grows to hold it. */
	readonly labelLength?: number;
}

export type LayoutDirection = 'TB' | 'BT' | 'LR' | 'RL';

export interface ILayeredLayout {
	/** Top-left position of each node. */
	readonly positions: Map<string, Vec>;
	/** Bend points, in edge direction, for each edge that skips ranks; keyed `from>to`. */
	readonly routes: Map<string, Vec[]>;
}

const DEFAULT_NODE_GAP = 48;
const DEFAULT_RANK_GAP = 80;
/** Air on either side of a label in the gap between two ranks: the line's bend and arrowhead. */
const LABEL_GAP_AIR = 28;
const ORDER_SWEEPS = 6;
const PLACE_SWEEPS = 6;
/** Room a waypoint takes in its rank: the line and some air. */
const WAYPOINT_CROSS = 24;

interface IWorkNode {
	readonly id: string;
	readonly index: number;
	/** A long edge's waypoint, not a node. */
	readonly waypoint?: boolean;
	/** Size across the ranks (width for TB). */
	readonly cross: number;
	/** Size along the rank axis (height for TB). */
	readonly along: number;
	rank: number;
	order: number;
	/** Centre on the cross axis. */
	center: number;
	readonly preds: number[];
	readonly succs: number[];
}

/** Top-left position of each node. */
export function layeredLayout(nodes: readonly ILayoutNode[], edges: readonly ILayoutEdge[], direction: LayoutDirection, spacing?: { readonly node?: number; readonly rank?: number }): Map<string, Vec> {
	return layeredLayoutWithRoutes(nodes, edges, direction, spacing).positions;
}

/** Node positions, and the bend points that keep long edges clear of the nodes they pass. */
export function layeredLayoutWithRoutes(nodes: readonly ILayoutNode[], edges: readonly ILayoutEdge[], direction: LayoutDirection, spacing?: { readonly node?: number; readonly rank?: number }): ILayeredLayout {
	const nodeGap = spacing?.node ?? DEFAULT_NODE_GAP;
	const rankGap = spacing?.rank ?? DEFAULT_RANK_GAP;
	const horizontal = direction === 'LR' || direction === 'RL';
	const result = new Map<string, Vec>();
	const routes = new Map<string, Vec[]>();

	const indexById = new Map<string, number>();
	const work: IWorkNode[] = [];
	for (const node of nodes) {
		if (indexById.has(node.id)) {
			continue;
		}
		const w = Math.max(0, node.width), h = Math.max(0, node.height);
		indexById.set(node.id, work.length);
		work.push({ id: node.id, index: work.length, cross: horizontal ? h : w, along: horizontal ? w : h, rank: 0, order: 0, center: 0, preds: [], succs: [] });
	}
	if (!work.length) {
		return { positions: result, routes };
	}

	// Unique edges between known nodes, no self loops.
	const seen = new Set<string>();
	const pairs: [number, number][] = [];
	const labelWidth = new Map<string, number>();
	const labelLength = new Map<string, number>();
	for (const edge of edges) {
		const a = indexById.get(edge.from), b = indexById.get(edge.to);
		if (a === undefined || b === undefined || a === b) {
			continue;
		}
		const key = `${a}>${b}`;
		// Either direction: a back edge is laid out reversed.
		if (edge.labelWidth) {
			labelWidth.set(key, Math.max(edge.labelWidth, labelWidth.get(key) ?? 0));
			labelWidth.set(`${b}>${a}`, Math.max(edge.labelWidth, labelWidth.get(`${b}>${a}`) ?? 0));
		}
		if (edge.labelLength) {
			// Two links between the same steps (there and back) need room for both labels.
			const pair = `${Math.min(a, b)}>${Math.max(a, b)}`;
			labelLength.set(pair, (labelLength.has(pair) ? labelLength.get(pair)! + 4 : 0) + edge.labelLength);
		}
		if (!seen.has(key)) {
			seen.add(key);
			pairs.push([a, b]);
		}
	}

	const dag = breakCycles(work.length, pairs);
	for (const [a, b] of dag) {
		work[a].succs.push(b);
		work[b].preds.push(a);
	}

	const components = connectedComponents(work.length, dag);
	let crossOffset = 0;
	const placed: { component: number[]; ranks: number[][]; rankStart: number[]; rankSize: number[]; minCross: number; maxCross: number }[] = [];
	/** Each long edge's waypoints, from its upper end down; keyed by the laid-out (acyclic) pair. */
	const chains = new Map<string, number[]>();
	for (const nodesOfComponent of components) {
		const ranks = rankComponent(work, nodesOfComponent);
		const component = [...nodesOfComponent, ...insertWaypoints(work, ranks, chains, key => Math.max(WAYPOINT_CROSS, labelWidth.get(key) ?? 0))];
		orderRanks(work, ranks);
		placeRanks(work, ranks, nodeGap);
		let minCross = Infinity, maxCross = -Infinity;
		for (const i of component) {
			minCross = Math.min(minCross, work[i].center - work[i].cross / 2);
			maxCross = Math.max(maxCross, work[i].center + work[i].cross / 2);
		}
		const rankSize = ranks.map(rank => Math.max(0, ...rank.map(i => work[i].along)));
		// A labelled edge between neighbouring ranks sits in the gap between them, label and all.
		const rankIndex = new Map<number, number>();
		ranks.forEach((rank, r) => rank.forEach(i => rankIndex.set(i, r)));
		const gapAfter = ranks.map(() => rankGap);
		for (const [a, b] of dag) {
			const ra = rankIndex.get(a), rb = rankIndex.get(b);
			const length = labelLength.get(`${Math.min(a, b)}>${Math.max(a, b)}`);
			if (length && ra !== undefined && rb !== undefined && Math.abs(ra - rb) === 1) {
				gapAfter[Math.min(ra, rb)] = Math.max(gapAfter[Math.min(ra, rb)], length + LABEL_GAP_AIR * 2);
			}
		}
		const rankStart: number[] = [];
		let along = 0;
		for (let r = 0; r < ranks.length; r++) {
			rankStart.push(along);
			along += rankSize[r] + gapAfter[r];
		}
		placed.push({ component, ranks, rankStart, rankSize, minCross, maxCross });
	}

	// Components side by side across the ranks, aligned at the first rank.
	const totalAlong = Math.max(0, ...placed.map(p => p.rankStart.length ? p.rankStart[p.rankStart.length - 1] + p.rankSize[p.rankSize.length - 1] : 0));
	const waypointAt = new Map<number, Vec>();
	for (const p of placed) {
		const shift = crossOffset - p.minCross;
		for (let r = 0; r < p.ranks.length; r++) {
			for (const i of p.ranks[r]) {
				const node = work[i];
				if (node.waypoint) {
					// The middle of its rank band, where the nodes beside it are widest.
					let along = p.rankStart[r] + p.rankSize[r] / 2;
					if (direction === 'BT' || direction === 'RL') {
						along = totalAlong - along;
					}
					const cross = node.center + shift;
					waypointAt.set(i, horizontal ? [along, cross] : [cross, along]);
					continue;
				}
				const crossPos = node.center - node.cross / 2 + shift;
				// Centred within its rank band.
				let alongPos = p.rankStart[r] + (p.rankSize[r] - node.along) / 2;
				if (direction === 'BT' || direction === 'RL') {
					alongPos = totalAlong - alongPos - node.along;
				}
				result.set(node.id, horizontal ? [alongPos, crossPos] : [crossPos, alongPos]);
			}
		}
		crossOffset += (p.maxCross - p.minCross) + nodeGap * 2;
	}

	for (const edge of edges) {
		const a = indexById.get(edge.from), b = indexById.get(edge.to);
		if (a === undefined || b === undefined) {
			continue;
		}
		const forward = chains.get(`${a}>${b}`);
		const chain = forward ?? chains.get(`${b}>${a}`)?.slice().reverse();
		const points = chain?.map(i => waypointAt.get(i)).filter((p): p is Vec => !!p);
		if (points?.length) {
			routes.set(`${edge.from}>${edge.to}`, points);
		}
	}
	return { positions: result, routes };
}

/**
 * Splits every edge that skips ranks into a chain through one waypoint per rank it passes, so
 * ordering and placement make room for it like for a node. Returns the waypoints' indices.
 */
function insertWaypoints(work: IWorkNode[], ranks: number[][], chains: Map<string, number[]>, crossFor: (key: string) => number): number[] {
	const rankOf = new Map<number, number>();
	ranks.forEach((rank, r) => rank.forEach(i => rankOf.set(i, r)));
	const added: number[] = [];
	for (let r = 0; r < ranks.length; r++) {
		for (const i of [...ranks[r]]) {
			for (const s of [...work[i].succs]) {
				const to = rankOf.get(s);
				if (to === undefined || to - r < 2) {
					continue;
				}
				const key = `${i}>${s}`;
				const cross = crossFor(key);
				const chain: number[] = [];
				let previous = i;
				for (let k = r + 1; k < to; k++) {
					const index = work.length;
					work.push({ id: '', index, waypoint: true, cross, along: 0, rank: k, order: 0, center: 0, preds: [previous], succs: [] });
					if (previous === i) {
						work[i].succs[work[i].succs.indexOf(s)] = index;
					} else {
						work[previous].succs.push(index);
					}
					ranks[k].push(index);
					chain.push(index);
					added.push(index);
					previous = index;
				}
				work[previous].succs.push(s);
				work[s].preds[work[s].preds.indexOf(i)] = previous;
				chains.set(key, chain);
			}
		}
	}
	return added;
}

/** Reverses back edges found by a DFS in node order, so the rest is acyclic. */
function breakCycles(count: number, pairs: readonly [number, number][]): [number, number][] {
	const out: number[][] = Array.from({ length: count }, () => []);
	for (const [a, b] of pairs) {
		out[a].push(b);
	}
	const state = new Uint8Array(count); // 0 new, 1 on stack, 2 done
	const back = new Set<string>();
	for (let start = 0; start < count; start++) {
		if (state[start]) {
			continue;
		}
		// Iterative DFS so a long chain cannot overflow the stack.
		const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
		state[start] = 1;
		while (stack.length) {
			const frame = stack[stack.length - 1];
			if (frame.next < out[frame.node].length) {
				const to = out[frame.node][frame.next++];
				if (state[to] === 1) {
					back.add(`${frame.node}>${to}`);
				} else if (state[to] === 0) {
					state[to] = 1;
					stack.push({ node: to, next: 0 });
				}
			} else {
				state[frame.node] = 2;
				stack.pop();
			}
		}
	}
	const result: [number, number][] = [];
	const seen = new Set<string>();
	for (const [a, b] of pairs) {
		const pair: [number, number] = back.has(`${a}>${b}`) ? [b, a] : [a, b];
		const key = `${pair[0]}>${pair[1]}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(pair);
		}
	}
	return result;
}

function connectedComponents(count: number, pairs: readonly [number, number][]): number[][] {
	const parent = Array.from({ length: count }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (const [a, b] of pairs) {
		const ra = find(a), rb = find(b);
		if (ra !== rb) {
			parent[Math.max(ra, rb)] = Math.min(ra, rb);
		}
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < count; i++) {
		const root = find(i);
		let group = groups.get(root);
		if (!group) {
			group = [];
			groups.set(root, group);
		}
		group.push(i);
	}
	// Ordered by each component's first node.
	return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

/** Longest-path ranks, then sources pulled down next to their first successor. */
function rankComponent(work: IWorkNode[], component: readonly number[]): number[][] {
	const inComponent = new Set(component);
	const indegree = new Map<number, number>();
	for (const i of component) {
		indegree.set(i, work[i].preds.length);
		work[i].rank = 0;
	}
	const queue = component.filter(i => indegree.get(i) === 0).sort((a, b) => a - b);
	const topo: number[] = [];
	while (queue.length) {
		const i = queue.shift()!;
		topo.push(i);
		for (const s of work[i].succs) {
			if (!inComponent.has(s)) {
				continue;
			}
			work[s].rank = Math.max(work[s].rank, work[i].rank + 1);
			const left = indegree.get(s)! - 1;
			indegree.set(s, left);
			if (left === 0) {
				// Keep the queue in node order for a stable result.
				let at = queue.length;
				while (at > 0 && queue[at - 1] > s) {
					at--;
				}
				queue.splice(at, 0, s);
			}
		}
	}
	// A source far above its only successor sits right above it instead.
	for (let k = topo.length - 1; k >= 0; k--) {
		const node = work[topo[k]];
		if (node.preds.length === 0 && node.succs.length) {
			node.rank = Math.max(0, Math.min(...node.succs.map(s => work[s].rank)) - 1);
		}
	}
	const maxRank = Math.max(0, ...component.map(i => work[i].rank));
	const ranks: number[][] = Array.from({ length: maxRank + 1 }, () => []);
	for (const i of topo) {
		ranks[work[i].rank].push(i);
	}
	return ranks.filter(rank => rank.length);
}

/** Barycentre sweeps down and up; ties keep the earlier order. */
function orderRanks(work: IWorkNode[], ranks: number[][]): void {
	const rankLength = new Map<number, number>();
	ranks.forEach(rank => rank.forEach((i, order) => {
		work[i].order = order;
		rankLength.set(i, rank.length);
	}));
	// Relative place in its rank, so ranks of different sizes compare.
	const position = (i: number) => work[i].order / Math.max(1, (rankLength.get(i) ?? 1) - 1);
	let best = ranks.map(rank => [...rank]);
	let bestCrossings = countCrossings(work, ranks);
	for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep++) {
		const down = sweep % 2 === 0;
		const sequence = down ? ranks.map((_, r) => r).slice(1) : ranks.map((_, r) => r).reverse().slice(1);
		for (const r of sequence) {
			const rank = ranks[r];
			const keyed = rank.map(i => {
				const neighbours = down ? work[i].preds : work[i].succs;
				const values = neighbours.map(position);
				const bary = values.length ? values.reduce((a, b) => a + b, 0) / values.length : position(i);
				return { i, bary, order: work[i].order };
			});
			keyed.sort((a, b) => a.bary - b.bary || a.order - b.order);
			ranks[r] = keyed.map(k => k.i);
			ranks[r].forEach((i, order) => { work[i].order = order; });
		}
		const crossings = countCrossings(work, ranks);
		if (crossings < bestCrossings) {
			bestCrossings = crossings;
			best = ranks.map(rank => [...rank]);
		}
	}
	for (let r = 0; r < ranks.length; r++) {
		ranks[r] = best[r];
		ranks[r].forEach((i, order) => { work[i].order = order; });
	}
}

/** Crossings between adjacent-rank edges (long edges count segment by segment, through their waypoints). */
function countCrossings(work: IWorkNode[], ranks: number[][]): number {
	const rankOf = new Map<number, number>();
	ranks.forEach((rank, r) => rank.forEach(i => rankOf.set(i, r)));
	const edges: { a: number; b: number; ra: number }[] = [];
	for (const rank of ranks) {
		for (const i of rank) {
			for (const s of work[i].succs) {
				const ra = rankOf.get(i), rb = rankOf.get(s);
				if (ra !== undefined && rb !== undefined) {
					edges.push({ a: work[i].order, b: work[s].order, ra });
				}
			}
		}
	}
	let crossings = 0;
	for (let x = 0; x < edges.length; x++) {
		for (let y = x + 1; y < edges.length; y++) {
			const e = edges[x], f = edges[y];
			if (e.ra === f.ra && (e.a - f.a) * (e.b - f.b) < 0) {
				crossings++;
			}
		}
	}
	return crossings;
}

/** Cross-axis centres: each rank packed in order, then pulled over its neighbours. */
function placeRanks(work: IWorkNode[], ranks: number[][], gap: number): void {
	for (const rank of ranks) {
		let cursor = 0;
		for (const i of rank) {
			work[i].center = cursor + work[i].cross / 2;
			cursor += work[i].cross + gap;
		}
		const shift = (cursor - gap) / 2;
		for (const i of rank) {
			work[i].center -= shift;
		}
	}
	for (let sweep = 0; sweep < PLACE_SWEEPS; sweep++) {
		const down = sweep % 2 === 0;
		const sequence = down ? ranks.map((_, r) => r).slice(1) : ranks.map((_, r) => r).reverse().slice(1);
		for (const r of sequence) {
			const rank = ranks[r];
			const desired = rank.map(i => {
				const neighbours = down ? work[i].preds : work[i].succs;
				return neighbours.length ? neighbours.reduce((sum, n) => sum + work[n].center, 0) / neighbours.length : work[i].center;
			});
			const placed = isotonicPlacement(rank.map(i => work[i].cross), desired, gap);
			rank.forEach((i, k) => { work[i].center = placed[k]; });
		}
	}
}

/**
 * Centres as close as possible (least squares) to `desired` while keeping the order and at least
 * `gap` between neighbours: shift out the separations, then pool adjacent violators.
 */
function isotonicPlacement(sizes: readonly number[], desired: readonly number[], gap: number): number[] {
	const n = sizes.length;
	const offsets: number[] = [0];
	for (let k = 1; k < n; k++) {
		offsets.push(offsets[k - 1] + (sizes[k - 1] + sizes[k]) / 2 + gap);
	}
	const blocks: { sum: number; count: number }[] = [];
	for (let k = 0; k < n; k++) {
		blocks.push({ sum: desired[k] - offsets[k], count: 1 });
		while (blocks.length > 1) {
			const last = blocks[blocks.length - 1];
			const prev = blocks[blocks.length - 2];
			if (prev.sum / prev.count <= last.sum / last.count) {
				break;
			}
			prev.sum += last.sum;
			prev.count += last.count;
			blocks.pop();
		}
	}
	const out: number[] = [];
	for (const block of blocks) {
		const value = block.sum / block.count;
		for (let c = 0; c < block.count; c++) {
			out.push(value + offsets[out.length]);
		}
	}
	return out;
}
