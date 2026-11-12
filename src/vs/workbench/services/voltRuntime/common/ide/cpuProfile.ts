/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A V8 `.cpuprofile` (node --cpu-prof, Chrome DevTools, js-debug). */
interface ICpuProfile {
	readonly nodes: readonly {
		readonly id: number;
		readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
		readonly hitCount?: number;
		readonly children?: readonly number[];
	}[];
	readonly startTime: number;
	readonly endTime: number;
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

export interface IHotFunction {
	readonly name: string;
	/** Script URL or path, and 1-based line. */
	readonly location: string;
	readonly selfMs: number;
	readonly totalMs: number;
}

export interface ICpuProfileSummary {
	readonly durationMs: number;
	readonly bySelf: readonly IHotFunction[];
	readonly byTotal: readonly IHotFunction[];
	/** Garbage collection, idle and "(program)" time. */
	readonly gcMs: number;
	readonly idleMs: number;
}

const SPECIAL = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

/**
 * The functions that cost the most: self time (where samples landed) and total time (self plus
 * callees), merged per function and location so recursion and many call paths add up once.
 */
export function summarizeCpuProfile(raw: string, limit = 15): ICpuProfileSummary {
	const profile = JSON.parse(raw) as ICpuProfile;
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	const durationMs = (profile.endTime - profile.startTime) / 1000;
	// Self time per node: the time deltas of the samples that landed on it (hitCount as fallback).
	const selfUs = new Map<number, number>();
	if (profile.samples?.length && profile.timeDeltas?.length) {
		for (let i = 0; i < profile.samples.length; i++) {
			const delta = profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0;
			selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + Math.max(0, delta));
		}
	} else {
		const hits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0) || 1;
		for (const node of profile.nodes) {
			selfUs.set(node.id, ((node.hitCount ?? 0) / hits) * durationMs * 1000);
		}
	}
	const parent = new Map<number, number>();
	for (const node of profile.nodes) {
		for (const child of node.children ?? []) {
			parent.set(child, node.id);
		}
	}
	const key = (id: number) => {
		const frame = byId.get(id)!.callFrame;
		return `${frame.functionName || '(anonymous)'}\u0000${frame.url}\u0000${frame.lineNumber}`;
	};
	const self = new Map<string, number>();
	const total = new Map<string, number>();
	let gcMs = 0;
	let idleMs = 0;
	for (const [id, us] of selfUs) {
		const node = byId.get(id);
		if (!node) {
			continue;
		}
		const name = node.callFrame.functionName;
		if (name === '(garbage collector)') {
			gcMs += us / 1000;
		} else if (name === '(idle)' || name === '(program)') {
			idleMs += us / 1000;
		}
		self.set(key(id), (self.get(key(id)) ?? 0) + us);
		// Each ancestor function gets the time once, however often it recurs on the path.
		const seen = new Set<string>();
		for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
			const k = key(current);
			if (!seen.has(k)) {
				seen.add(k);
				total.set(k, (total.get(k) ?? 0) + us);
			}
		}
	}
	const toHot = ([k]: [string, number]): IHotFunction => {
		const [name, url, line] = k.split('\u0000');
		return { name, location: url ? `${url.replace(/^file:\/\//, '')}:${Number(line) + 1}` : '(native)', selfMs: (self.get(k) ?? 0) / 1000, totalMs: (total.get(k) ?? 0) / 1000 };
	};
	const visible = (k: string) => !SPECIAL.has(k.split('\u0000')[0]);
	return {
		durationMs,
		bySelf: [...self].filter(([k]) => visible(k)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(toHot),
		byTotal: [...total].filter(([k]) => visible(k)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(toHot),
		gcMs,
		idleMs,
	};
}

export function formatCpuProfile(summary: ICpuProfileSummary, shorten: (location: string) => string = location => location): string {
	const ms = (value: number) => value >= 100 ? `${value.toFixed(0)}ms` : `${value.toFixed(1)}ms`;
	const pct = (value: number) => summary.durationMs ? `${((value / summary.durationMs) * 100).toFixed(1)}%` : '';
	return [
		`Profiled ${ms(summary.durationMs)} (GC ${ms(summary.gcMs)}, idle/program ${ms(summary.idleMs)}).`,
		'Hottest by self time:',
		...summary.bySelf.map(item => `  ${ms(item.selfMs).padStart(8)} ${pct(item.selfMs).padStart(6)}  ${item.name}  ${shorten(item.location)}`),
		'Most expensive by total time (with callees):',
		...summary.byTotal.slice(0, 10).map(item => `  ${ms(item.totalMs).padStart(8)} ${pct(item.totalMs).padStart(6)}  ${item.name}  ${shorten(item.location)}`),
	].join('\n');
}
