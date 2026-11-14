/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { categoryFor, IProfileCounter, IProfileFrame, IProfileLane, IProfileMatrix, IProfileTimeline, IVoltProfile, lanesFromSamples, ProfileBuilder, VoltProfileKind, VoltProfileUnit } from './profile.js';

/**
 * Profile files into one model (`IVoltProfile`). Every tool an agent reaches for writes one of these:
 * - V8 `.cpuprofile` (node --cpu-prof, Chrome DevTools, js-debug) and `.heapprofile` (node --heap-prof);
 * - speedscope JSON (py-spy --format speedscope, rbspy, `perf script` through speedscope, pyroscope);
 * - Chrome trace events (`chrome://tracing`, Perfetto JSON, `--trace-event`, `tracing` crates);
 * - folded stacks, one `a;b;c 42` per line (Brendan Gregg's format: perf, dtrace, async-profiler,
 *   `go tool pprof -raw` through stackcollapse, inferno);
 * - Volt's own JSON (`$volt: "profile"`): stacks, series and a matrix an agent wrote itself.
 */

export type ProfileFormat = 'cpuprofile' | 'heapprofile' | 'speedscope' | 'trace' | 'folded' | 'volt';

export class ProfileFormatError extends Error { }

const SUPPORTED = 'a V8 .cpuprofile or .heapprofile, speedscope JSON, Chrome trace events JSON, folded stacks ("a;b;c 42" per line) or Volt profile JSON ({"$volt":"profile", ...})';

/** Which format `text` is in, from its content first and its file name second. */
export function detectProfileFormat(text: string, name = ''): ProfileFormat | undefined {
	const trimmed = text.trimStart();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		let json: unknown;
		try {
			json = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
		return detectJson(json);
	}
	if (/\.(folded|collapsed|stacks)$/i.test(name) || /^[^\n]*\S\s+\d+(?:\.\d+)?\s*$/m.test(trimmed)) {
		return 'folded';
	}
	return undefined;
}

function detectJson(json: unknown): ProfileFormat | undefined {
	if (Array.isArray(json)) {
		return json.some(event => isRecord(event) && typeof event.ph === 'string') ? 'trace' : undefined;
	}
	if (!isRecord(json)) {
		return undefined;
	}
	if (json.$volt === 'profile') {
		return 'volt';
	}
	if (Array.isArray(json.nodes) && typeof json.startTime === 'number') {
		return 'cpuprofile';
	}
	if (isRecord(json.head) && isRecord(json.head.callFrame)) {
		return 'heapprofile';
	}
	if ((typeof json.$schema === 'string' && json.$schema.includes('speedscope')) || (Array.isArray(json.profiles) && isRecord(json.shared))) {
		return 'speedscope';
	}
	if (Array.isArray(json.traceEvents)) {
		return 'trace';
	}
	return undefined;
}

/** Reads any supported profile; throws `ProfileFormatError` with what it expected. */
export function parseProfile(text: string, name = 'profile'): IVoltProfile {
	const format = detectProfileFormat(text, name);
	const title = name.replace(/^.*[\\/]/, '');
	switch (format) {
		case 'cpuprofile': return parseCpuProfile(JSON.parse(text), title);
		case 'heapprofile': return parseHeapProfile(JSON.parse(text), title);
		case 'speedscope': return parseSpeedscope(JSON.parse(text), title);
		case 'trace': return parseChromeTrace(JSON.parse(text), title);
		case 'folded': return parseFolded(text, title);
		case 'volt': return parseVoltProfile(JSON.parse(text), title);
	}
	throw new ProfileFormatError(`Not a profile Volt can read. Expected ${SUPPORTED}.`);
}

// --- V8 CPU profile ------------------------------------------------------------------------------

interface IV8CallFrame {
	readonly functionName: string;
	readonly url: string;
	readonly lineNumber: number;
	readonly columnNumber?: number;
}

interface IV8CpuNode {
	readonly id: number;
	readonly callFrame: IV8CallFrame;
	readonly hitCount?: number;
	readonly children?: readonly number[];
	readonly parent?: number;
}

interface IV8CpuProfile {
	readonly nodes: readonly IV8CpuNode[];
	readonly startTime: number;
	readonly endTime: number;
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

function v8Frame(callFrame: IV8CallFrame): IProfileFrame {
	const name = callFrame.functionName || '(anonymous)';
	const file = callFrame.url ? callFrame.url.replace(/^file:\/\//, '') : undefined;
	return {
		name,
		...(file ? { file } : {}),
		...(file && callFrame.lineNumber >= 0 ? { line: callFrame.lineNumber + 1 } : {}),
		...(file && callFrame.columnNumber !== undefined && callFrame.columnNumber >= 0 ? { column: callFrame.columnNumber + 1 } : {}),
		category: categoryFor(name, file),
	};
}

export function parseCpuProfile(profile: IV8CpuProfile, title = 'CPU profile'): IVoltProfile {
	if (!Array.isArray(profile.nodes) || !profile.nodes.length) {
		throw new ProfileFormatError('The CPU profile has no nodes.');
	}
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	// Children from `children`, or from `parent` (older DevTools saves).
	const children = new Map<number, number[]>();
	const referenced = new Set<number>();
	for (const node of profile.nodes) {
		for (const child of node.children ?? []) {
			(children.get(node.id) ?? children.set(node.id, []).get(node.id)!).push(child);
			referenced.add(child);
		}
		if (node.parent !== undefined && !node.children) {
			(children.get(node.parent) ?? children.set(node.parent, []).get(node.parent)!).push(node.id);
			referenced.add(node.id);
		}
	}
	const root = profile.nodes.find(node => !referenced.has(node.id)) ?? profile.nodes[0];
	const builder = new ProfileBuilder();
	const ours = new Map<number, number>([[root.id, 0]]);
	const stack = [root.id];
	while (stack.length) {
		const id = stack.pop()!;
		const parent = ours.get(id)!;
		for (const childId of children.get(id) ?? []) {
			const child = byId.get(childId);
			if (!child || ours.has(childId)) {
				continue;
			}
			ours.set(childId, builder.child(parent, builder.frame(v8Frame(child.callFrame))));
			stack.push(childId);
		}
	}
	const durationMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
	let timeline: IProfileTimeline | undefined;
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	if (samples.length && deltas.length === samples.length) {
		const times: number[] = new Array(samples.length);
		let clock = 0;
		for (let i = 0; i < samples.length; i++) {
			clock += Math.max(0, deltas[i]);
			times[i] = clock / 1000;
		}
		const interval = samples.length > 1 ? (times[times.length - 1] - times[0]) / (samples.length - 1) : durationMs;
		const durations: number[] = new Array(samples.length);
		const leaves: number[] = new Array(samples.length);
		for (let i = 0; i < samples.length; i++) {
			const next = i + 1 < samples.length ? times[i + 1] : Math.max(times[i] + interval, durationMs);
			durations[i] = Math.max(0, next - times[i]);
			leaves[i] = ours.get(samples[i]) ?? 0;
			builder.nodes[leaves[i]].self += durations[i];
		}
		builder.finishTotals();
		const end = times.length ? times[times.length - 1] + durations[durations.length - 1] : durationMs;
		timeline = { duration: end, sampleTimes: times, sampleDurations: durations, sampleNodes: leaves, lanes: lanesFromSamples(builder.nodes, times, durations, leaves) };
	} else {
		// No samples: hit counts spread over the profile's duration.
		const hits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0) || 1;
		for (const node of profile.nodes) {
			const ourId = ours.get(node.id);
			if (ourId !== undefined) {
				builder.nodes[ourId].self += ((node.hitCount ?? 0) / hits) * durationMs;
			}
		}
		builder.finishTotals();
	}
	return {
		title,
		kind: 'cpu',
		unit: 'milliseconds',
		format: 'cpuprofile',
		frames: builder.frames,
		nodes: builder.nodes,
		...(timeline ? { timeline } : {}),
		meta: { samples: String(samples.length), duration: `${durationMs.toFixed(1)}ms` },
	};
}

// --- V8 sampling heap profile --------------------------------------------------------------------

interface IV8HeapNode {
	readonly callFrame: IV8CallFrame;
	readonly selfSize: number;
	readonly children?: readonly IV8HeapNode[];
}

export function parseHeapProfile(profile: { readonly head: IV8HeapNode }, title = 'Heap profile'): IVoltProfile {
	const builder = new ProfileBuilder();
	const stack: { node: IV8HeapNode; parent: number }[] = (profile.head.children ?? []).map(node => ({ node, parent: 0 }));
	builder.nodes[0].self += profile.head.selfSize ?? 0;
	while (stack.length) {
		const { node, parent } = stack.pop()!;
		const id = builder.child(parent, builder.frame(v8Frame(node.callFrame)));
		builder.nodes[id].self += Math.max(0, node.selfSize ?? 0);
		for (const child of node.children ?? []) {
			stack.push({ node: child, parent: id });
		}
	}
	builder.finishTotals();
	return { title, kind: 'memory', unit: 'bytes', format: 'heapprofile', frames: builder.frames, nodes: builder.nodes, meta: { measure: 'bytes allocated by each call path and still live when sampled' } };
}

// --- speedscope ----------------------------------------------------------------------------------

interface ISpeedscopeFrame {
	readonly name: string;
	readonly file?: string;
	readonly line?: number;
	readonly col?: number;
}

interface ISpeedscopeProfile {
	readonly type: 'evented' | 'sampled';
	readonly name?: string;
	readonly unit: string;
	readonly startValue: number;
	readonly endValue: number;
	readonly events?: readonly { readonly type: 'O' | 'C'; readonly frame: number; readonly at: number }[];
	readonly samples?: readonly (readonly number[])[];
	readonly weights?: readonly number[];
}

interface ISpeedscopeFile {
	readonly shared: { readonly frames: readonly ISpeedscopeFrame[] };
	readonly profiles: readonly ISpeedscopeProfile[];
	readonly name?: string;
}

/** A speedscope unit as a factor to Volt's: time to milliseconds; bytes and plain counts as they are. */
function speedscopeUnit(unit: string): { readonly unit: VoltProfileUnit; readonly factor: number } {
	switch (unit) {
		case 'nanoseconds': return { unit: 'milliseconds', factor: 1e-6 };
		case 'microseconds': return { unit: 'milliseconds', factor: 1e-3 };
		case 'milliseconds': return { unit: 'milliseconds', factor: 1 };
		case 'seconds': return { unit: 'milliseconds', factor: 1000 };
		case 'bytes': return { unit: 'bytes', factor: 1 };
		default: return { unit: 'samples', factor: 1 };
	}
}

export function parseSpeedscope(file: ISpeedscopeFile, title = 'Profile'): IVoltProfile {
	const profiles = file.profiles ?? [];
	if (!profiles.length) {
		throw new ProfileFormatError('The speedscope file has no profiles.');
	}
	// The busiest one (py-spy writes one per thread).
	const profile = [...profiles].sort((a, b) => (b.endValue - b.startValue) - (a.endValue - a.startValue))[0];
	const { unit, factor } = speedscopeUnit(profile.unit);
	const builder = new ProfileBuilder();
	const frameIds = (file.shared?.frames ?? []).map(frame => builder.frame({
		name: frame.name || '(anonymous)',
		...(frame.file ? { file: frame.file } : {}),
		...(frame.line ? { line: frame.line } : {}),
		...(frame.col ? { column: frame.col } : {}),
		category: categoryFor(frame.name, frame.file),
	}));
	let timeline: IProfileTimeline | undefined;
	if (profile.type === 'evented') {
		// Exact open/close events: slices straight from them, selves from what children leave.
		const lanes: IProfileLane[] = [];
		const open: { node: number; start: number }[] = [];
		const start = profile.startValue;
		let node = 0;
		for (const event of profile.events ?? []) {
			const at = (event.at - start) * factor;
			if (event.type === 'O') {
				node = builder.child(node, frameIds[event.frame] ?? builder.frame({ name: `frame ${event.frame}`, category: 'app' }));
				open.push({ node, start: at });
			} else if (open.length) {
				const slice = open.pop()!;
				const lane = lanes[open.length] ??= { start: [], end: [], node: [] };
				lane.start.push(slice.start);
				lane.end.push(at);
				lane.node.push(slice.node);
				builder.nodes[slice.node].total += at - slice.start;
				node = builder.nodes[slice.node].parent;
			}
		}
		// Self is the total minus what the children took; totals were summed per call above.
		for (const n of builder.nodes) {
			n.self = Math.max(0, n.total - n.children.reduce((sum, child) => sum + builder.nodes[child].total, 0));
		}
		builder.finishTotals();
		// Closing order is innermost first: sort each lane (slices never overlap within a lane).
		const sorted = lanes.map(lane => {
			const order = lane.start.map((_, index) => index).sort((a, b) => lane.start[a] - lane.start[b]);
			return { start: order.map(i => lane.start[i]), end: order.map(i => lane.end[i]), node: order.map(i => lane.node[i]) };
		});
		timeline = { duration: (profile.endValue - start) * factor, sampleTimes: [], sampleDurations: [], sampleNodes: [], lanes: sorted };
	} else {
		// Sampled: stacks with weights. Laid end to end in the order given, which is time order for
		// samplers (py-spy), so the chart reads like a timeline.
		const samples = profile.samples ?? [];
		const weights = profile.weights ?? samples.map(() => 1);
		const times: number[] = [];
		const durations: number[] = [];
		const leaves: number[] = [];
		let clock = 0;
		for (let i = 0; i < samples.length; i++) {
			const value = (weights[i] ?? 1) * factor;
			const leaf = builder.addStack(samples[i].map(index => frameIds[index] ?? builder.frame({ name: `frame ${index}`, category: 'app' })), value);
			times.push(clock);
			durations.push(value);
			leaves.push(leaf);
			clock += value;
		}
		builder.finishTotals();
		if (unit === 'milliseconds' || unit === 'samples') {
			timeline = { duration: clock, sampleTimes: times, sampleDurations: durations, sampleNodes: leaves, lanes: lanesFromSamples(builder.nodes, times, durations, leaves) };
		}
	}
	return {
		title: profile.name || file.name || title,
		kind: unit === 'bytes' ? 'memory' : 'cpu',
		unit,
		format: 'speedscope',
		frames: builder.frames,
		nodes: builder.nodes,
		...(timeline ? { timeline } : {}),
		meta: { profiles: String(profiles.length), shown: profile.name ?? '1' },
	};
}

// --- Chrome trace events -------------------------------------------------------------------------

interface ITraceEvent {
	readonly name?: string;
	readonly cat?: string;
	readonly ph: string;
	readonly ts?: number;
	readonly dur?: number;
	readonly pid?: number | string;
	readonly tid?: number | string;
	readonly args?: Record<string, unknown>;
}

export function parseChromeTrace(json: readonly ITraceEvent[] | { readonly traceEvents: readonly ITraceEvent[] }, title = 'Trace'): IVoltProfile {
	const events = (Array.isArray(json) ? json : (json as { traceEvents: readonly ITraceEvent[] }).traceEvents).filter(event => isRecord(event) && typeof event.ph === 'string');
	const timed = events.filter(event => typeof event.ts === 'number');
	if (!timed.length) {
		throw new ProfileFormatError('The trace has no timed events.');
	}
	// A loop, not Math.min(...): traces run to millions of events.
	let origin = Number.POSITIVE_INFINITY;
	for (const event of timed) {
		origin = Math.min(origin, event.ts!);
	}
	// Spans per thread: complete events (X) and begin/end pairs (B/E).
	const threads = new Map<string, { name: string; spans: { name: string; cat?: string; start: number; end: number }[] }>();
	const threadNames = new Map<string, string>();
	const begun = new Map<string, ITraceEvent[]>();
	const counters = new Map<string, [number, number][]>();
	for (const event of events) {
		const key = `${event.pid ?? 0}:${event.tid ?? 0}`;
		if (event.ph === 'M' && event.name === 'thread_name' && typeof event.args?.name === 'string') {
			threadNames.set(key, event.args.name);
			continue;
		}
		if (typeof event.ts !== 'number') {
			continue;
		}
		const at = (event.ts - origin) / 1000;
		const thread = threads.get(key) ?? threads.set(key, { name: key, spans: [] }).get(key)!;
		if (event.ph === 'X') {
			thread.spans.push({ name: event.name ?? '(unnamed)', ...(event.cat ? { cat: event.cat } : {}), start: at, end: at + Math.max(0, (event.dur ?? 0) / 1000) });
		} else if (event.ph === 'B') {
			(begun.get(key) ?? begun.set(key, []).get(key)!).push(event);
		} else if (event.ph === 'E') {
			const open = begun.get(key)?.pop();
			if (open) {
				thread.spans.push({ name: open.name ?? '(unnamed)', ...(open.cat ? { cat: open.cat } : {}), start: (open.ts! - origin) / 1000, end: at });
			}
		} else if (event.ph === 'C' && event.args) {
			for (const [series, value] of Object.entries(event.args)) {
				if (typeof value === 'number') {
					const name = `${event.name ?? 'counter'}${series === 'value' ? '' : ` ${series}`}`;
					(counters.get(name) ?? counters.set(name, []).get(name)!).push([at, value]);
				}
			}
		}
	}
	// The busiest thread is the one shown (the main thread, nearly always).
	let busiest: { key: string; spans: { name: string; cat?: string; start: number; end: number }[]; busy: number } | undefined;
	for (const [key, thread] of threads) {
		const busy = thread.spans.reduce((sum, span) => sum + (span.end - span.start), 0);
		if (!busiest || busy > busiest.busy) {
			busiest = { key, spans: thread.spans, busy };
		}
	}
	const builder = new ProfileBuilder();
	const lanes: IProfileLane[] = [];
	let duration = 0;
	if (busiest?.spans.length) {
		// Nesting from containment: sorted by start (longer first on ties), a span is inside the last open one that contains it.
		const spans = [...busiest.spans].sort((a, b) => a.start - b.start || b.end - a.end);
		const open: { node: number; end: number }[] = [];
		for (const span of spans) {
			while (open.length && open[open.length - 1].end <= span.start) {
				open.pop();
			}
			const parent = open.length ? open[open.length - 1].node : 0;
			const node = builder.child(parent, builder.frame({ name: span.name, category: span.cat ?? 'trace' }));
			builder.nodes[node].total += span.end - span.start;
			const lane = lanes[open.length] ??= { start: [], end: [], node: [] };
			lane.start.push(span.start);
			lane.end.push(span.end);
			lane.node.push(node);
			open.push({ node, end: span.end });
			duration = Math.max(duration, span.end);
		}
		for (const n of builder.nodes) {
			n.self = Math.max(0, n.total - n.children.reduce((sum, child) => sum + builder.nodes[child].total, 0));
		}
		builder.finishTotals();
	}
	const counterList: IProfileCounter[] = [...counters].map(([name, points]) => ({ name, unit: /bytes|memory|heap|rss/i.test(name) ? 'bytes' : 'count', points: points.sort((a, b) => a[0] - b[0]) }));
	duration = Math.max(duration, ...counterList.flatMap(counter => counter.points.length ? [counter.points[counter.points.length - 1][0]] : []));
	return {
		title,
		kind: 'trace',
		unit: 'milliseconds',
		format: 'trace',
		frames: builder.frames,
		nodes: builder.nodes,
		...(lanes.length ? { timeline: { duration, sampleTimes: [], sampleDurations: [], sampleNodes: [], lanes } } : {}),
		...(counterList.length ? { counters: counterList } : {}),
		meta: { threads: String(threads.size), ...(busiest ? { thread: threadNames.get(busiest.key) ?? busiest.key } : {}), events: String(events.length) },
	};
}

// --- Folded stacks -------------------------------------------------------------------------------

/** `name (file:line)` or `name (file:line:col)`, as py-spy and many collapsers write a frame. */
const FRAME_WITH_LOCATION = /^(.*?) \(([^()]*?):(\d+)(?::(\d+))?\)$/;

function foldedFrame(text: string): IProfileFrame {
	const match = FRAME_WITH_LOCATION.exec(text.trim());
	if (match) {
		return { name: match[1], file: match[2], line: Number(match[3]), ...(match[4] ? { column: Number(match[4]) } : {}), category: categoryFor(match[1], match[2]) };
	}
	const name = text.trim() || '(unknown)';
	return { name, category: categoryFor(name, name.includes('/') ? name : undefined) };
}

export function parseFolded(text: string, title = 'Profile', unit: VoltProfileUnit = 'samples', kind: VoltProfileKind = 'cpu'): IVoltProfile {
	const builder = new ProfileBuilder();
	let lines = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const space = line.lastIndexOf(' ');
		if (!line || line.startsWith('#') || space <= 0) {
			continue;
		}
		const value = Number(line.slice(space + 1));
		if (!Number.isFinite(value) || value < 0) {
			continue;
		}
		builder.addStack(line.slice(0, space).split(';').filter(Boolean).map(frame => builder.frame(foldedFrame(frame))), value);
		lines++;
	}
	if (!lines) {
		throw new ProfileFormatError('No folded stacks found: expected lines like "main;parse;tokenize 42".');
	}
	builder.finishTotals();
	return { title, kind, unit, format: 'folded', frames: builder.frames, nodes: builder.nodes, meta: { stacks: String(lines) } };
}

// --- Volt's own format ---------------------------------------------------------------------------

/**
 * What an agent writes to show data in the Profiler without drawing it: `stacks` for a flame graph
 * (a call tree, a bundle by folder, time by phase), `series` for lines over time, `matrix` for a
 * heat map. Any one is enough; together they share one tab.
 */
export interface IVoltProfileFile {
	readonly $volt: 'profile';
	readonly title?: string;
	readonly kind?: VoltProfileKind;
	readonly unit?: VoltProfileUnit;
	readonly stacks?: string | readonly { readonly stack: readonly string[]; readonly value: number }[];
	readonly series?: readonly { readonly name: string; readonly unit?: string; readonly points: readonly (readonly [number, number])[] }[];
	readonly matrix?: { readonly rows: readonly string[]; readonly columns: readonly string[]; readonly values: readonly (readonly number[])[]; readonly unit?: string };
	readonly meta?: Record<string, string>;
}

const UNITS = new Set<string>(['milliseconds', 'bytes', 'samples', 'count', 'none', 'percent']);

function unitOf(value: unknown, fallback: VoltProfileUnit): VoltProfileUnit {
	return typeof value === 'string' && UNITS.has(value) && value !== 'percent' ? value as VoltProfileUnit : fallback;
}

export function parseVoltProfile(file: IVoltProfileFile, title = 'Profile'): IVoltProfile {
	const unit = unitOf(file.unit, 'count');
	const kind: VoltProfileKind = file.kind && ['cpu', 'memory', 'trace', 'usage', 'custom'].includes(file.kind) ? file.kind : 'custom';
	let base: IVoltProfile;
	if (typeof file.stacks === 'string' && file.stacks.trim()) {
		base = parseFolded(file.stacks, file.title ?? title, unit, kind);
	} else if (Array.isArray(file.stacks) && file.stacks.length) {
		const builder = new ProfileBuilder();
		for (const entry of file.stacks as readonly unknown[]) {
			if (isRecord(entry) && Array.isArray(entry.stack) && typeof entry.value === 'number' && Number.isFinite(entry.value)) {
				builder.addStack((entry.stack as unknown[]).filter((name): name is string => typeof name === 'string').map(name => builder.frame(foldedFrame(name))), Math.max(0, entry.value));
			}
		}
		builder.finishTotals();
		base = { title: file.title ?? title, kind, unit, format: 'volt', frames: builder.frames, nodes: builder.nodes, meta: {} };
	} else {
		const builder = new ProfileBuilder();
		base = { title: file.title ?? title, kind, unit, format: 'volt', frames: builder.frames, nodes: builder.nodes, meta: {} };
	}
	const counters: IProfileCounter[] = (file.series ?? []).filter(series => isRecord(series) && typeof series.name === 'string' && Array.isArray(series.points)).map(series => ({
		name: series.name,
		unit: series.unit === 'percent' ? 'percent' : unitOf(series.unit, 'count'),
		points: series.points.filter(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])).map(point => [point[0], point[1]] as const).sort((a, b) => a[0] - b[0]),
	}));
	const matrix: IProfileMatrix | undefined = file.matrix && Array.isArray(file.matrix.rows) && Array.isArray(file.matrix.columns) && Array.isArray(file.matrix.values)
		? { rows: file.matrix.rows.map(String), columns: file.matrix.columns.map(String), values: file.matrix.values.map(row => Array.isArray(row) ? row.map(value => Number.isFinite(value) ? value : 0) : []), unit: file.matrix.unit === 'percent' ? 'percent' : unitOf(file.matrix.unit, 'count') }
		: undefined;
	if (!base.nodes[0].total && !counters.length && !matrix) {
		throw new ProfileFormatError('The Volt profile has no data: give stacks, series or matrix.');
	}
	return {
		...base,
		format: 'volt',
		...(counters.length ? { counters } : {}),
		...(matrix ? { matrix } : {}),
		meta: { ...base.meta, ...(file.meta && isRecord(file.meta) ? Object.fromEntries(Object.entries(file.meta).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {}) },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
