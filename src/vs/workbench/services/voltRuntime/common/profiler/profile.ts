/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One model for every profile Volt shows and agents read: a V8 CPU or heap profile, a speedscope
 * file (py-spy, rbspy, perf converted), a Chrome trace, folded stacks from any tool, a process
 * usage recording, or data an agent made up itself (`profile show`). Parsers build it
 * (`profileFormats.ts`), analysis reads it (`profileAnalysis.ts`), the Profiler tab draws it.
 *
 * - `frames`: distinct functions (name, location, category).
 * - `nodes`: the call tree, node 0 a synthetic root; every node's `self` is where the value landed
 *   and `total` is self plus its callees. Values are in `unit` (time is always milliseconds).
 * - `timeline` (when the source has time): samples in time order and the flame chart's slices,
 *   one lane per depth, so a chart can draw any window without walking the whole profile.
 * - `counters`: values over time (memory, CPU %), drawn as lines.
 * - `matrix`: a ready heat map (rows by columns), for data that is not a call tree.
 */

export type VoltProfileKind = 'cpu' | 'memory' | 'trace' | 'usage' | 'custom';

/** Time values are normalized to milliseconds; everything else keeps its own unit. */
export type VoltProfileUnit = 'milliseconds' | 'bytes' | 'samples' | 'count' | 'none';

export interface IProfileFrame {
	readonly name: string;
	/** A path or URL. */
	readonly file?: string;
	/** 1-based. */
	readonly line?: number;
	readonly column?: number;
	/**
	 * Where the code comes from, for color and for "where does time go": `app`, a package
	 * (`react`, `@scope/pkg`), `node`, `native`, `gc`, `idle`, `program`, `thread`, `root`.
	 */
	readonly category: string;
}

export interface IProfileNode {
	readonly frame: number;
	/** -1 for the root. */
	readonly parent: number;
	readonly children: number[];
	readonly depth: number;
	self: number;
	total: number;
}

/** One depth of the flame chart: slices in time order, as parallel arrays (start, end in ms; the node). */
export interface IProfileLane {
	readonly start: number[];
	readonly end: number[];
	readonly node: number[];
}

export interface IProfileTimeline {
	/** Milliseconds; the profile's own start is 0. */
	readonly duration: number;
	/** Samples in time order: when (ms), for how long (ms) and the node they landed on. Empty for traced (evented) data. */
	readonly sampleTimes: number[];
	readonly sampleDurations: number[];
	readonly sampleNodes: number[];
	/** Lane `d` holds the slices at depth `d + 1` (the root has no slice). */
	readonly lanes: IProfileLane[];
}

export interface IProfileCounter {
	readonly name: string;
	readonly unit: VoltProfileUnit | 'percent';
	/** [ms, value], in time order. */
	readonly points: readonly (readonly [number, number])[];
}

export interface IProfileMatrix {
	readonly rows: readonly string[];
	readonly columns: readonly string[];
	/** `values[row][column]`. */
	readonly values: readonly (readonly number[])[];
	readonly unit: VoltProfileUnit | 'percent';
}

export interface IVoltProfile {
	readonly title: string;
	readonly kind: VoltProfileKind;
	readonly unit: VoltProfileUnit;
	/** What it was read from: `cpuprofile`, `heapprofile`, `speedscope`, `trace`, `folded`, `volt`. */
	readonly format: string;
	readonly frames: readonly IProfileFrame[];
	readonly nodes: readonly IProfileNode[];
	readonly timeline?: IProfileTimeline;
	readonly counters?: readonly IProfileCounter[];
	readonly matrix?: IProfileMatrix;
	/** How it was made (command, exit code, process, thread); shown and given to agents as is. */
	readonly meta: Readonly<Record<string, string>>;
}

export const ROOT_FRAME: IProfileFrame = { name: '(root)', category: 'root' };

/** Builds a profile's frames and call tree from stacks, deduplicating frames and paths. */
export class ProfileBuilder {

	readonly frames: IProfileFrame[] = [ROOT_FRAME];
	readonly nodes: IProfileNode[] = [{ frame: 0, parent: -1, children: [], depth: 0, self: 0, total: 0 }];
	private readonly frameIds = new Map<string, number>();
	private readonly childIds = new Map<string, number>();

	frame(frame: IProfileFrame): number {
		const key = `${frame.name}\u0000${frame.file ?? ''}\u0000${frame.line ?? ''}\u0000${frame.column ?? ''}\u0000${frame.category}`;
		let id = this.frameIds.get(key);
		if (id === undefined) {
			id = this.frames.length;
			this.frames.push(frame);
			this.frameIds.set(key, id);
		}
		return id;
	}

	/** The child of `parent` for `frame`, made when it is new. */
	child(parent: number, frame: number): number {
		const key = `${parent}\u0000${frame}`;
		let id = this.childIds.get(key);
		if (id === undefined) {
			id = this.nodes.length;
			this.nodes.push({ frame, parent, children: [], depth: this.nodes[parent].depth + 1, self: 0, total: 0 });
			this.nodes[parent].children.push(id);
			this.childIds.set(key, id);
		}
		return id;
	}

	/** Adds `value` at the end of the path `frames` (outermost first); returns the leaf node. */
	addStack(frames: readonly number[], value: number): number {
		let node = 0;
		for (const frame of frames) {
			node = this.child(node, frame);
		}
		this.nodes[node].self += value;
		return node;
	}

	/** Totals from selves: children are always made after their parent, so one backward pass sums them. */
	finishTotals(): void {
		for (const node of this.nodes) {
			node.total = 0;
		}
		for (let i = this.nodes.length - 1; i >= 0; i--) {
			const node = this.nodes[i];
			node.total += node.self;
			if (node.parent >= 0) {
				this.nodes[node.parent].total += node.total;
			}
		}
	}
}

/**
 * The flame chart's slices from samples: consecutive samples that share a call path up to a depth
 * are one slice at that depth. `times` are sample starts (ms), `durations` how long each counts.
 */
export function lanesFromSamples(nodes: readonly IProfileNode[], times: readonly number[], durations: readonly number[], leaves: readonly number[]): IProfileLane[] {
	const lanes: IProfileLane[] = [];
	const open: { node: number; start: number }[] = [];
	const close = (from: number, at: number) => {
		for (let depth = open.length - 1; depth >= from; depth--) {
			const slice = open[depth];
			const lane = lanes[depth] ??= { start: [], end: [], node: [] };
			lane.start.push(slice.start);
			lane.end.push(at);
			lane.node.push(slice.node);
		}
		open.length = from;
	};
	const path: number[] = [];
	let end = 0;
	for (let i = 0; i < leaves.length; i++) {
		path.length = 0;
		for (let node = leaves[i]; node > 0; node = nodes[node].parent) {
			path.push(node);
		}
		path.reverse();
		const at = times[i];
		let same = 0;
		while (same < path.length && same < open.length && open[same].node === path[same]) {
			same++;
		}
		close(same, at);
		for (let depth = same; depth < path.length; depth++) {
			open.push({ node: path[depth], start: at });
		}
		end = at + (durations[i] ?? 0);
	}
	close(0, end);
	// Each depth has one slice open at a time, so every lane is already in time order.
	return lanes;
}

/** A category from where the code lives: a package for anything under node_modules, else app, node or native. */
export function categoryFor(name: string, file: string | undefined): string {
	if (name === '(garbage collector)' || name === '(GC)' || /^(major|minor|scavenge|mark-?compact)\b/i.test(name)) {
		return 'gc';
	}
	if (name === '(idle)') {
		return 'idle';
	}
	if (name === '(program)') {
		return 'program';
	}
	if (!file) {
		return 'native';
	}
	const normalized = file.replace(/\\/g, '/');
	// The innermost package: node_modules/a/node_modules/b is b's code.
	const packages = [...normalized.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
	if (packages.length) {
		return packages[packages.length - 1][1];
	}
	if (normalized.startsWith('node:') || normalized.startsWith('internal/')) {
		return 'node';
	}
	const site = /site-packages\/([^/]+)/.exec(normalized);
	if (site) {
		return site[1];
	}
	if (/\/lib\/python\d/.test(normalized) || normalized.startsWith('<frozen ')) {
		return 'python';
	}
	return 'app';
}

// --- Units -----------------------------------------------------------------------------------

/** "12.4ms", "1.20s", "830\u00b5s" (written with an escape for the micro sign). */
export function formatMs(ms: number): string {
	const abs = Math.abs(ms);
	if (abs >= 1000) {
		return `${(ms / 1000).toFixed(abs >= 100_000 ? 0 : 2)}s`;
	}
	if (abs >= 10) {
		return `${ms.toFixed(abs >= 100 ? 0 : 1)}ms`;
	}
	if (abs >= 1) {
		return `${ms.toFixed(2)}ms`;
	}
	return `${(ms * 1000).toFixed(0)}\u00b5s`;
}

export function formatBytes(bytes: number): string {
	const abs = Math.abs(bytes);
	if (abs >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	}
	if (abs >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	}
	if (abs >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${Math.round(bytes)} B`;
}

export function formatCount(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (abs >= 10_000) {
		return `${(value / 1_000).toFixed(0)}k`;
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatValue(value: number, unit: VoltProfileUnit | 'percent'): string {
	switch (unit) {
		case 'milliseconds': return formatMs(value);
		case 'bytes': return formatBytes(value);
		case 'percent': return `${value.toFixed(1)}%`;
		default: return formatCount(value);
	}
}

/** `share` of `whole` as a percentage, one decimal. */
export function percent(share: number, whole: number): string {
	return whole > 0 ? `${((share / whole) * 100).toFixed(1)}%` : '0%';
}

/** "parse (src/config.ts:42)", shortened for a reader: paths relative to `root`, packages from node_modules. */
export function frameLabel(frame: IProfileFrame, root?: string): string {
	if (!frame.file) {
		return frame.name;
	}
	return `${frame.name} (${shortPath(frame.file, root)}${frame.line ? `:${frame.line}` : ''})`;
}

export function shortPath(file: string, root?: string): string {
	let path = file.replace(/^file:\/\//, '').replace(/\\/g, '/');
	const base = root?.replace(/\\/g, '/').replace(/\/$/, '');
	if (base && path.startsWith(`${base}/`)) {
		return path.slice(base.length + 1);
	}
	const module = path.lastIndexOf('node_modules/');
	if (module >= 0) {
		path = path.slice(module);
	}
	return path;
}
