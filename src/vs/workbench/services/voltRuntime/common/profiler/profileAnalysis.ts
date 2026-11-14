/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatValue, frameLabel, IProfileFrame, IVoltProfile, percent, ProfileBuilder, VoltProfileUnit } from './profile.js';

/**
 * What a profile says, for the agent (compact text that names functions by file:line) and for the
 * Profiler tab (heat map cells, a function's callers and callees, a diff between two runs). All of
 * it is computed from the call tree, or from the timeline when a time window is asked for.
 */

export interface ITimeRange {
	readonly start: number;
	readonly end: number;
}

export interface IFunctionCost {
	readonly frame: number;
	readonly self: number;
	/** With callees, counted once per stack (recursion does not add up twice). */
	readonly total: number;
}

/** Each node's total inside a time window (ms), from samples or, for traced data, from slices. */
export function nodeTotalsInRange(profile: IVoltProfile, range: ITimeRange): Float64Array {
	const totals = new Float64Array(profile.nodes.length);
	const timeline = profile.timeline;
	if (!timeline) {
		return totals;
	}
	const clip = (start: number, end: number) => Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
	if (timeline.sampleTimes.length) {
		for (let i = 0; i < timeline.sampleTimes.length; i++) {
			const weight = clip(timeline.sampleTimes[i], timeline.sampleTimes[i] + timeline.sampleDurations[i]);
			if (weight <= 0) {
				continue;
			}
			for (let node = timeline.sampleNodes[i]; node >= 0; node = profile.nodes[node].parent) {
				totals[node] += weight;
			}
		}
		return totals;
	}
	for (const lane of timeline.lanes) {
		for (let i = firstEndingAfter(lane.end, range.start); i < lane.start.length && lane.start[i] < range.end; i++) {
			totals[lane.node[i]] += clip(lane.start[i], lane.end[i]);
		}
	}
	totals[0] = profile.nodes[0].children.reduce((sum, child) => sum + totals[child], 0);
	return totals;
}

/** Index of the first slice of a lane (sorted, non-overlapping) that ends after `time`. */
export function firstEndingAfter(ends: readonly number[], time: number): number {
	let low = 0;
	let high = ends.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (ends[mid] <= time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/**
 * Self and total per function. A function's total is the sum over its outermost occurrences on
 * each path, so `a > b > a` counts `a` once. `range` restricts it to a time window.
 */
export function functionCosts(profile: IVoltProfile, range?: ITimeRange): IFunctionCost[] {
	const { nodes } = profile;
	const totals = range ? nodeTotalsInRange(profile, range) : Float64Array.from(nodes, node => node.total);
	const self = new Float64Array(profile.frames.length);
	const total = new Float64Array(profile.frames.length);
	for (let i = 1; i < nodes.length; i++) {
		const nodeTotal = totals[i];
		if (nodeTotal <= 0) {
			continue;
		}
		const childTotal = nodes[i].children.reduce((sum, child) => sum + totals[child], 0);
		self[nodes[i].frame] += Math.max(0, nodeTotal - childTotal);
		let outermost = true;
		for (let up = nodes[i].parent; up > 0; up = nodes[up].parent) {
			if (nodes[up].frame === nodes[i].frame) {
				outermost = false;
				break;
			}
		}
		if (outermost) {
			total[nodes[i].frame] += nodeTotal;
		}
	}
	const costs: IFunctionCost[] = [];
	for (let frame = 1; frame < profile.frames.length; frame++) {
		if (self[frame] > 0 || total[frame] > 0) {
			costs.push({ frame, self: self[frame], total: total[frame] });
		}
	}
	return costs;
}

/** The value the whole profile (or window) adds up to. */
export function profileTotal(profile: IVoltProfile, range?: ITimeRange): number {
	return range ? nodeTotalsInRange(profile, range)[0] : profile.nodes[0].total;
}

/** Frames that are not work: idle, (program), (root). Kept out of "hottest" lists. */
export function isBookkeeping(frame: IProfileFrame): boolean {
	return frame.category === 'idle' || frame.category === 'program' || frame.category === 'root';
}

export interface ITopOptions {
	readonly by: 'self' | 'total';
	readonly limit?: number;
	readonly range?: ITimeRange;
	/** Only functions whose name or file contains this (case-insensitive). */
	readonly filter?: string;
}

export function topFunctions(profile: IVoltProfile, options: ITopOptions): IFunctionCost[] {
	const filter = options.filter?.toLowerCase();
	return functionCosts(profile, options.range)
		.filter(cost => (options.by === 'self' ? cost.self : cost.total) > 0 && !isBookkeeping(profile.frames[cost.frame]))
		.filter(cost => !filter || profile.frames[cost.frame].name.toLowerCase().includes(filter) || !!profile.frames[cost.frame].file?.toLowerCase().includes(filter))
		.sort((a, b) => (options.by === 'self' ? b.self - a.self || b.total - a.total : b.total - a.total || b.self - a.self))
		.slice(0, options.limit ?? 15);
}

/** Self time per category (app, each package, gc, node...), largest first. */
export function categoryCosts(profile: IVoltProfile, range?: ITimeRange): { readonly category: string; readonly value: number }[] {
	const byCategory = new Map<string, number>();
	for (const cost of functionCosts(profile, range)) {
		const category = profile.frames[cost.frame].category;
		byCategory.set(category, (byCategory.get(category) ?? 0) + cost.self);
	}
	return [...byCategory].map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/** The call paths that end in the most self time: the stacks a fix should start from. */
export function hottestStacks(profile: IVoltProfile, limit = 3): { readonly frames: number[]; readonly self: number }[] {
	const leaves = profile.nodes
		.map((node, index) => ({ node, index }))
		.filter(({ node, index }) => index > 0 && node.self > 0 && !isBookkeeping(profile.frames[node.frame]))
		.sort((a, b) => b.node.self - a.node.self)
		.slice(0, limit);
	return leaves.map(({ node, index }) => {
		const frames: number[] = [];
		for (let current = index; current > 0; current = profile.nodes[current].parent) {
			frames.push(profile.nodes[current].frame);
		}
		return { frames: frames.reverse(), self: node.self };
	});
}

export interface IFrameRelations {
	readonly self: number;
	readonly total: number;
	/** Who calls it, with how much of its total comes through each. */
	readonly callers: readonly { readonly frame: number; readonly value: number }[];
	/** What it calls, with each callee's total under it. */
	readonly callees: readonly { readonly frame: number; readonly value: number }[];
}

/** A function's cost, callers and callees, merged over every node it appears in. */
export function frameRelations(profile: IVoltProfile, frame: number, range?: ITimeRange): IFrameRelations {
	const { nodes } = profile;
	const totals = range ? nodeTotalsInRange(profile, range) : Float64Array.from(nodes, node => node.total);
	const callers = new Map<number, number>();
	const callees = new Map<number, number>();
	let self = 0;
	let total = 0;
	for (let i = 1; i < nodes.length; i++) {
		if (nodes[i].frame !== frame || totals[i] <= 0) {
			continue;
		}
		const childTotal = nodes[i].children.reduce((sum, child) => sum + totals[child], 0);
		self += Math.max(0, totals[i] - childTotal);
		let outermost = true;
		for (let up = nodes[i].parent; up > 0; up = nodes[up].parent) {
			if (nodes[up].frame === frame) {
				outermost = false;
				break;
			}
		}
		if (outermost) {
			total += totals[i];
		}
		const parentFrame = nodes[i].parent > 0 ? nodes[nodes[i].parent].frame : 0;
		callers.set(parentFrame, (callers.get(parentFrame) ?? 0) + totals[i]);
		for (const child of nodes[i].children) {
			if (totals[child] > 0) {
				callees.set(nodes[child].frame, (callees.get(nodes[child].frame) ?? 0) + totals[child]);
			}
		}
	}
	const sorted = (map: Map<number, number>) => [...map].map(([f, value]) => ({ frame: f, value })).sort((a, b) => b.value - a.value);
	return { self, total, callers: sorted(callers), callees: sorted(callees) };
}

/** Frames whose name or file contains `query` (case-insensitive), costliest first. */
export function findFrames(profile: IVoltProfile, query: string): number[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [];
	}
	const costs = new Map(functionCosts(profile).map(cost => [cost.frame, cost.self + cost.total]));
	const found: number[] = [];
	profile.frames.forEach((frame, index) => {
		if (index > 0 && (frame.name.toLowerCase().includes(needle) || !!frame.file?.toLowerCase().includes(needle))) {
			found.push(index);
		}
	});
	return found.sort((a, b) => (costs.get(b) ?? 0) - (costs.get(a) ?? 0));
}

/** When a function first and last ran on the timeline: what to zoom to for it. */
export function frameTimeRange(profile: IVoltProfile, frame: number): ITimeRange | undefined {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const lane of profile.timeline?.lanes ?? []) {
		for (let i = 0; i < lane.node.length; i++) {
			if (profile.nodes[lane.node[i]].frame === frame) {
				start = Math.min(start, lane.start[i]);
				end = Math.max(end, lane.end[i]);
			}
		}
	}
	return Number.isFinite(start) ? { start, end } : undefined;
}

// --- Heat map ------------------------------------------------------------------------------------

export interface IHeatmap {
	/** Row labels' frames (functions), costliest first. */
	readonly frames: readonly number[];
	readonly range: ITimeRange;
	readonly buckets: number;
	/** `values[row][bucket]`: the function's self time in that slice of time. */
	readonly values: readonly Float64Array[];
	readonly max: number;
	/** Self time from samples; traced data has only inclusive time. */
	readonly measure: 'self' | 'inclusive';
}

/** Where each of the costliest functions spends its time, over time: rows are functions, columns time buckets. */
export function functionHeatmap(profile: IVoltProfile, rows = 24, buckets = 120, range?: ITimeRange): IHeatmap | undefined {
	const timeline = profile.timeline;
	if (!timeline || timeline.duration <= 0) {
		return undefined;
	}
	const window = range ?? { start: 0, end: timeline.duration };
	const width = Math.max(1e-9, window.end - window.start);
	const frames = topFunctions(profile, { by: timeline.sampleTimes.length ? 'self' : 'total', limit: rows, range: window }).map(cost => cost.frame);
	const rowOf = new Map(frames.map((frame, row) => [frame, row]));
	const values = frames.map(() => new Float64Array(buckets));
	const add = (frame: number, start: number, end: number) => {
		const row = rowOf.get(frame);
		if (row === undefined) {
			return;
		}
		const from = Math.max(start, window.start);
		const to = Math.min(end, window.end);
		if (to <= from) {
			return;
		}
		// Spread the time over the buckets it covers.
		let at = from;
		while (at < to) {
			const bucket = Math.min(buckets - 1, Math.floor(((at - window.start) / width) * buckets));
			const bucketEnd = window.start + ((bucket + 1) / buckets) * width;
			const piece = Math.min(to, bucketEnd) - at;
			values[row][bucket] += piece;
			at += Math.max(piece, 1e-9);
		}
	};
	if (timeline.sampleTimes.length) {
		for (let i = 0; i < timeline.sampleTimes.length; i++) {
			add(profile.nodes[timeline.sampleNodes[i]].frame, timeline.sampleTimes[i], timeline.sampleTimes[i] + timeline.sampleDurations[i]);
		}
	} else {
		for (const lane of timeline.lanes) {
			for (let i = firstEndingAfter(lane.end, window.start); i < lane.start.length && lane.start[i] < window.end; i++) {
				add(profile.nodes[lane.node[i]].frame, lane.start[i], lane.end[i]);
			}
		}
	}
	let max = 0;
	for (const row of values) {
		for (const value of row) {
			max = Math.max(max, value);
		}
	}
	return { frames, range: window, buckets, values, max, measure: timeline.sampleTimes.length ? 'self' : 'inclusive' };
}

// --- Comparing two runs --------------------------------------------------------------------------

function frameKey(frame: IProfileFrame): string {
	return `${frame.name}\u0000${frame.file ?? ''}\u0000${frame.line ?? ''}`;
}

export interface IFunctionDelta {
	readonly frame: IProfileFrame;
	readonly baseSelf: number;
	readonly nextSelf: number;
	readonly baseTotal: number;
	readonly nextTotal: number;
}

export interface IProfileComparison {
	readonly baseTotal: number;
	readonly nextTotal: number;
	/** Biggest self-time increases first. */
	readonly regressions: readonly IFunctionDelta[];
	/** Biggest decreases first (functions gone in the new run included). */
	readonly improvements: readonly IFunctionDelta[];
}

export function compareProfiles(base: IVoltProfile, next: IVoltProfile, limit = 10): IProfileComparison {
	const merged = new Map<string, { frame: IProfileFrame; baseSelf: number; nextSelf: number; baseTotal: number; nextTotal: number }>();
	const entry = (frame: IProfileFrame) => {
		const key = frameKey(frame);
		return merged.get(key) ?? merged.set(key, { frame, baseSelf: 0, nextSelf: 0, baseTotal: 0, nextTotal: 0 }).get(key)!;
	};
	for (const cost of functionCosts(base)) {
		const item = entry(base.frames[cost.frame]);
		item.baseSelf += cost.self;
		item.baseTotal += cost.total;
	}
	for (const cost of functionCosts(next)) {
		const item = entry(next.frames[cost.frame]);
		item.nextSelf += cost.self;
		item.nextTotal += cost.total;
	}
	const all = [...merged.values()].filter(item => !isBookkeeping(item.frame));
	return {
		baseTotal: base.nodes[0].total,
		nextTotal: next.nodes[0].total,
		regressions: all.filter(item => item.nextSelf > item.baseSelf).sort((a, b) => (b.nextSelf - b.baseSelf) - (a.nextSelf - a.baseSelf)).slice(0, limit),
		improvements: all.filter(item => item.nextSelf < item.baseSelf).sort((a, b) => (a.nextSelf - a.baseSelf) - (b.nextSelf - b.baseSelf)).slice(0, limit),
	};
}

export interface IProfileDiff {
	/** Both runs' call trees merged by path; node totals are the new run's. */
	readonly profile: IVoltProfile;
	/** Per merged node: its total in the old run and in the new one. */
	readonly base: Float64Array;
	readonly next: Float64Array;
}

/** A tree for a differential flame graph: the new run's shape, each path colored by how it changed. */
export function diffProfiles(base: IVoltProfile, next: IVoltProfile): IProfileDiff {
	const builder = new ProfileBuilder();
	const totals: [number[], number[]] = [[], []];
	const add = (profile: IVoltProfile, which: 0 | 1) => {
		const ours = new Int32Array(profile.nodes.length);
		for (let i = 1; i < profile.nodes.length; i++) {
			const node = profile.nodes[i];
			const frame = profile.frames[node.frame];
			const id = builder.child(ours[node.parent], builder.frame({ name: frame.name, ...(frame.file ? { file: frame.file } : {}), ...(frame.line ? { line: frame.line } : {}), category: frame.category }));
			ours[i] = id;
			totals[which][id] = (totals[which][id] ?? 0) + node.total;
		}
		totals[which][0] = (totals[which][0] ?? 0) + profile.nodes[0].total;
	};
	add(base, 0);
	add(next, 1);
	const baseTotals = Float64Array.from(builder.nodes, (_, index) => totals[0][index] ?? 0);
	const nextTotals = Float64Array.from(builder.nodes, (_, index) => totals[1][index] ?? 0);
	// Widths are the new run's: the graph shows the program as it is now.
	for (let i = 0; i < builder.nodes.length; i++) {
		builder.nodes[i].total = nextTotals[i];
		builder.nodes[i].self = Math.max(0, nextTotals[i] - builder.nodes[i].children.reduce((sum, child) => sum + nextTotals[child], 0));
	}
	return {
		profile: { title: `${base.title} \u2192 ${next.title}`, kind: next.kind, unit: next.unit, format: 'diff', frames: builder.frames, nodes: builder.nodes, meta: {} },
		base: baseTotals,
		next: nextTotals,
	};
}

// --- Text for agents -----------------------------------------------------------------------------

export interface ISummaryOptions {
	/** The workspace folder: paths print relative to it. */
	readonly root?: string;
	readonly range?: ITimeRange;
	readonly limit?: number;
	readonly filter?: string;
}

/** Code that belongs to the runtime rather than the program: left out of "with callees" lists and stack heads. */
const RUNTIME_CATEGORIES = new Set(['node', 'native', 'root', 'program', 'idle']);

function valueOf(profile: IVoltProfile, value: number): string {
	return formatValue(value, profile.unit);
}

/**
 * A profile as an agent reads it, in a few hundred tokens: what it measured, where the value goes
 * by category, the hottest functions by self and by total with file:line, the stacks to start a
 * fix from, and notes on patterns worth acting on. Counters and a heat matrix get their own lines.
 */
export function summarizeProfile(profile: IVoltProfile, options: ISummaryOptions = {}): string {
	const lines: string[] = [];
	const total = profileTotal(profile, options.range);
	const limit = options.limit ?? 12;
	const what = profile.kind === 'memory' ? 'memory allocated' : profile.unit === 'milliseconds' ? 'time' : profile.unit;
	const header = [`${profile.title} (${profile.format}${profile.kind !== 'cpu' ? `, ${profile.kind}` : ''})`];
	if (profile.timeline) {
		header.push(options.range ? `window ${valueOf(profile, options.range.start)} to ${valueOf(profile, options.range.end)} of ${valueOf(profile, profile.timeline.duration)}` : `${valueOf(profile, profile.timeline.duration)} long`);
	}
	if (total > 0) {
		header.push(`${what}: ${valueOf(profile, total)}`);
	}
	const extra = Object.entries(profile.meta).filter(([key]) => key !== 'duration').map(([key, value]) => `${key} ${value}`);
	lines.push(`${header.join(', ')}${extra.length ? ` (${extra.join(', ')})` : ''}.`);
	if (total > 0) {
		const categories = categoryCosts(profile, options.range).filter(item => item.value / total >= 0.005).slice(0, 8);
		if (categories.length > 1) {
			lines.push(`By source: ${categories.map(item => `${item.category} ${percent(item.value, total)}`).join(' \u00b7 ')}`);
		}
		const bySelf = topFunctions(profile, { by: 'self', limit, ...(options.range ? { range: options.range } : {}), ...(options.filter ? { filter: options.filter } : {}) });
		if (bySelf.length) {
			lines.push(`Hottest by self ${profile.kind === 'memory' ? 'size' : 'time'} (where the ${what} lands):`);
			for (const cost of bySelf) {
				lines.push(`  ${valueOf(profile, cost.self).padStart(9)} ${percent(cost.self, total).padStart(6)}  ${frameLabel(profile.frames[cost.frame], options.root)}`);
			}
		}
		// The runtime's own wrappers (module loading, the event loop) are on every stack and say nothing.
		const byTotal = topFunctions(profile, { by: 'total', limit: 40, ...(options.range ? { range: options.range } : {}), ...(options.filter ? { filter: options.filter } : {}) })
			.filter(cost => !RUNTIME_CATEGORIES.has(profile.frames[cost.frame].category))
			.filter(cost => !bySelf.slice(0, 3).some(item => item.frame === cost.frame && item.self / Math.max(cost.total, 1e-9) > 0.9))
			.slice(0, Math.min(limit, 8));
		if (byTotal.length) {
			lines.push('Costliest with callees (total):');
			for (const cost of byTotal) {
				lines.push(`  ${valueOf(profile, cost.total).padStart(9)} ${percent(cost.total, total).padStart(6)}  ${frameLabel(profile.frames[cost.frame], options.root)}`);
			}
		}
		if (!options.range) {
			const stacks = hottestStacks(profile, 3);
			if (stacks.length) {
				lines.push('Hottest stacks (outermost first; start a fix at the deepest frame you own):');
				stacks.forEach((stack, index) => {
					// From the first frame that is not the runtime's: that is where the program starts.
					const first = stack.frames.findIndex(frame => !RUNTIME_CATEGORIES.has(profile.frames[frame].category));
					const names = stack.frames.slice(Math.max(0, first)).map(frame => profile.frames[frame].name);
					const shown = names.length > 6 ? [...names.slice(0, 1), '\u2026', ...names.slice(-4)] : names;
					lines.push(`  ${index + 1}. ${first > 0 ? '\u2026 > ' : ''}${shown.join(' > ')}  (${percent(stack.self, total)})`);
				});
			}
		}
		const notes = profileNotes(profile, total, bySelf, categories, options.range);
		if (notes.length) {
			lines.push('Notes:', ...notes.map(note => `  - ${note}`));
		}
	}
	for (const counter of profile.counters ?? []) {
		if (!counter.points.length) {
			continue;
		}
		let peak = counter.points[0];
		let sum = 0;
		for (const point of counter.points) {
			if (point[1] > peak[1]) {
				peak = point;
			}
			sum += point[1];
		}
		const first = counter.points[0][1];
		const last = counter.points[counter.points.length - 1][1];
		lines.push(`${counter.name}: start ${formatValue(first, counter.unit)}, peak ${formatValue(peak[1], counter.unit)} at ${formatValue(peak[0], 'milliseconds')}, end ${formatValue(last, counter.unit)}, mean ${formatValue(sum / counter.points.length, counter.unit)} (${counter.points.length} points)${counter.unit === 'bytes' && last > first * 1.5 && last > 50 * 1024 * 1024 ? '. It keeps growing: look for a leak or an unbounded cache.' : ''}`);
	}
	if (profile.matrix) {
		const cells: { row: string; column: string; value: number }[] = [];
		profile.matrix.values.forEach((values, row) => values.forEach((value, column) => cells.push({ row: profile.matrix!.rows[row] ?? `${row}`, column: profile.matrix!.columns[column] ?? `${column}`, value })));
		const top = cells.sort((a, b) => b.value - a.value).slice(0, 8);
		lines.push(`Heat map ${profile.matrix.rows.length} x ${profile.matrix.columns.length}; largest cells: ${top.map(cell => `${cell.row} @ ${cell.column} = ${formatValue(cell.value, profile.matrix!.unit)}`).join('; ')}`);
	}
	return lines.join('\n');
}

function profileNotes(profile: IVoltProfile, total: number, bySelf: readonly IFunctionCost[], categories: readonly { category: string; value: number }[], range: ITimeRange | undefined): string[] {
	const notes: string[] = [];
	const share = (category: string) => (categories.find(item => item.category === category)?.value ?? 0) / total;
	if (profile.kind === 'cpu' || profile.kind === 'trace') {
		if (share('gc') > 0.1) {
			notes.push(`Garbage collection takes ${percent(share('gc') * total, total)}: allocation pressure. Allocate less in the hot loops (reuse objects and arrays, avoid temporary strings), or take a heap profile (profile heap) to see what allocates.`);
		}
		const waiting = share('idle') + share('program');
		if (waiting > 0.5) {
			notes.push(`The process was idle or in the runtime ${percent(waiting * total, total)} of the time: wall time goes to waiting (I/O, timers, network, child processes), which a CPU profile cannot attribute. Measure the waits (profile sample, tracing, timing logs) instead.`);
		}
		if (bySelf[0] && bySelf[0].self / total > 0.25) {
			notes.push(`${profile.frames[bySelf[0].frame].name} alone holds ${percent(bySelf[0].self, total)} of the ${range ? 'window' : 'profile'}: start there.`);
		} else if (bySelf.length >= 8 && bySelf[0].self / total < 0.05) {
			notes.push('The profile is flat (no function above 5%): small local fixes will not move it much; look for work that can be skipped, batched or cached higher up the stack.');
		}
		const pkg = categories.find(item => !['app', 'gc', 'idle', 'program', 'node', 'native', 'root', 'python', 'trace'].includes(item.category));
		if (pkg && pkg.value / total > 0.3) {
			notes.push(`The package ${pkg.category} takes ${percent(pkg.value, total)}: check how it is called (inputs, call count, options) before optimizing your own code.`);
		}
	}
	if (profile.kind === 'memory' && bySelf[0] && bySelf[0].self / total > 0.3) {
		notes.push(`${profile.frames[bySelf[0].frame].name} allocates ${percent(bySelf[0].self, total)} of the sampled memory.`);
	}
	return notes;
}

/** A function in a few lines: its cost, location, top callers and callees. */
export function describeFrame(profile: IVoltProfile, frame: number, root?: string, range?: ITimeRange): string {
	const relations = frameRelations(profile, frame, range);
	const total = profileTotal(profile, range);
	const label = (index: number) => index === 0 ? '(top level)' : frameLabel(profile.frames[index], root);
	const lines = [
		`${frameLabel(profile.frames[frame], root)}: self ${valueOf(profile, relations.self)} (${percent(relations.self, total)}), total ${valueOf(profile, relations.total)} (${percent(relations.total, total)}), category ${profile.frames[frame].category}.`,
	];
	if (relations.callers.length) {
		lines.push(`Called from: ${relations.callers.slice(0, 5).map(item => `${label(item.frame)} ${percent(item.value, relations.total || total)}`).join('; ')}`);
	}
	if (relations.callees.length) {
		lines.push(`Calls: ${relations.callees.slice(0, 6).map(item => `${label(item.frame)} ${valueOf(profile, item.value)}`).join('; ')}`);
	}
	return lines.join('\n');
}

/** Two runs compared for an agent: totals, then what got slower and faster, by function. */
export function summarizeComparison(base: IVoltProfile, next: IVoltProfile, root?: string, limit = 8): string {
	const comparison = compareProfiles(base, next, limit);
	const unit: VoltProfileUnit = next.unit;
	const delta = comparison.nextTotal - comparison.baseTotal;
	const change = comparison.baseTotal > 0 ? ` (${delta >= 0 ? '+' : ''}${((delta / comparison.baseTotal) * 100).toFixed(1)}%)` : '';
	const row = (item: IFunctionDelta) => `  ${(item.nextSelf - item.baseSelf >= 0 ? '+' : '') + formatValue(item.nextSelf - item.baseSelf, unit)}  ${formatValue(item.baseSelf, unit)} \u2192 ${formatValue(item.nextSelf, unit)}  ${frameLabel(item.frame, root)}`;
	const lines = [`${base.title} \u2192 ${next.title}: ${formatValue(comparison.baseTotal, unit)} \u2192 ${formatValue(comparison.nextTotal, unit)}${change}.`];
	if (comparison.regressions.length) {
		lines.push('Slower or bigger (self):', ...comparison.regressions.map(row));
	}
	if (comparison.improvements.length) {
		lines.push('Faster or smaller (self):', ...comparison.improvements.map(row));
	}
	if (!comparison.regressions.length && !comparison.improvements.length) {
		lines.push('No function changed.');
	}
	if (base.unit === 'milliseconds' && Math.abs(delta) / Math.max(comparison.baseTotal, 1e-9) < 0.03) {
		lines.push('Note: under 3% apart, within the noise of one run each. Benchmark (profile bench) before calling it a win.');
	}
	return lines.join('\n');
}
