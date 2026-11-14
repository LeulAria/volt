/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { categoryFor, formatBytes, formatMs, IVoltProfile } from '../../common/profiler/profile.js';
import { categoryCosts, compareProfiles, describeFrame, diffProfiles, findFrames, frameRelations, frameTimeRange, functionCosts, functionHeatmap, summarizeComparison, summarizeProfile, topFunctions } from '../../common/profiler/profileAnalysis.js';
import { detectProfileFormat, parseProfile, ProfileFormatError } from '../../common/profiler/profileFormats.js';

const frame = (functionName: string, url = '', lineNumber = -1) => ({ functionName, url, lineNumber, columnNumber: -1, scriptId: '1' });

/**
 * main (app) runs 0-6 ms: 1 ms itself, then fib 1-6 ms, which recurses into fib 3-6 ms.
 * Then the garbage collector 6-7 and (program) 7-8. One sample per millisecond.
 */
const CPU = JSON.stringify({
	nodes: [
		{ id: 1, callFrame: frame('(root)'), children: [2, 3, 4] },
		{ id: 2, callFrame: frame('(program)') },
		{ id: 3, callFrame: frame('main', 'file:///repo/main.js', 0), children: [5] },
		{ id: 4, callFrame: frame('(garbage collector)') },
		{ id: 5, callFrame: frame('fib', 'file:///repo/main.js', 2), children: [6] },
		{ id: 6, callFrame: frame('fib', 'file:///repo/main.js', 2) },
	],
	startTime: 0,
	endTime: 8000,
	samples: [3, 5, 5, 6, 6, 6, 4, 2],
	timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
});

function frameNamed(profile: IVoltProfile, name: string): number {
	const index = profile.frames.findIndex(item => item.name === name);
	assert.ok(index > 0, name);
	return index;
}

suite('Volt profiler: formats and analysis', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a V8 CPU profile: self and total per function, recursion counted once, a timeline of slices', () => {
		assert.strictEqual(detectProfileFormat(CPU), 'cpuprofile');
		const profile = parseProfile(CPU, '/tmp/CPU.cpuprofile');
		assert.strictEqual(profile.title, 'CPU.cpuprofile');
		assert.strictEqual(profile.unit, 'milliseconds');
		assert.strictEqual(profile.nodes[0].total, 8);
		const fib = frameNamed(profile, 'fib');
		const main = frameNamed(profile, 'main');
		assert.deepStrictEqual(profile.frames[fib], { name: 'fib', file: '/repo/main.js', line: 3, category: 'app' });
		const costs = new Map(functionCosts(profile).map(cost => [cost.frame, cost]));
		assert.deepStrictEqual([costs.get(fib)?.self, costs.get(fib)?.total], [5, 5], 'fib inside fib is not counted twice');
		assert.deepStrictEqual([costs.get(main)?.self, costs.get(main)?.total], [1, 6]);
		assert.deepStrictEqual(topFunctions(profile, { by: 'self', limit: 2 }).map(cost => profile.frames[cost.frame].name), ['fib', 'main'], '(program) is not work');
		const lanes = profile.timeline!.lanes;
		assert.deepStrictEqual([lanes[0].start, lanes[0].end], [[0, 6, 7], [6, 7, 8]]);
		assert.deepStrictEqual([lanes[1].start, lanes[1].end], [[1], [6]]);
		assert.deepStrictEqual([lanes[2].start, lanes[2].end], [[3], [6]]);
		assert.deepStrictEqual(frameTimeRange(profile, fib), { start: 1, end: 6 });
	});

	test('a time window counts only what ran inside it', () => {
		const profile = parseProfile(CPU, 'cpu');
		const fib = frameNamed(profile, 'fib');
		const inside = new Map(functionCosts(profile, { start: 2.5, end: 4.5 }).map(cost => [cost.frame, cost]));
		assert.strictEqual(inside.get(fib)?.self, 2);
		assert.deepStrictEqual([inside.get(frameNamed(profile, 'main'))?.self, inside.get(frameNamed(profile, 'main'))?.total], [0, 2], 'main itself ran only at 0-1, but fib under it ran here');
		const relations = frameRelations(profile, fib);
		assert.deepStrictEqual(relations.callers.map(item => profile.frames[item.frame].name), ['main', 'fib']);
		assert.ok(describeFrame(profile, fib, '/repo').startsWith('fib (main.js:3): self 5.00ms (62.5%)'));
	});

	test('categories name packages from node_modules, and gc is its own', () => {
		assert.strictEqual(categoryFor('parse', '/repo/node_modules/acorn/dist/acorn.js'), 'acorn');
		assert.strictEqual(categoryFor('x', '/repo/node_modules/a/node_modules/@scope/b/i.js'), '@scope/b');
		assert.strictEqual(categoryFor('readFile', 'node:fs'), 'node');
		assert.strictEqual(categoryFor('(garbage collector)', undefined), 'gc');
		assert.strictEqual(categoryFor('loads', '/usr/lib/python3.12/site-packages/numpy/core.py'), 'numpy');
		const profile = parseProfile(CPU, 'cpu');
		assert.deepStrictEqual(categoryCosts(profile).map(item => item.category), ['app', 'gc', 'program']);
	});

	test('folded stacks, with file:line frames, and two runs compared', () => {
		const base = parseProfile('main;parse (src/parse.ts:10);tokenize 30\nmain;parse (src/parse.ts:10) 10\nmain;render 60\n', 'before.folded');
		assert.strictEqual(base.format, 'folded');
		const parse = frameNamed(base, 'parse');
		assert.deepStrictEqual(base.frames[parse], { name: 'parse', file: 'src/parse.ts', line: 10, category: 'app' });
		assert.deepStrictEqual(topFunctions(base, { by: 'self' }).map(cost => [base.frames[cost.frame].name, cost.self]), [['render', 60], ['tokenize', 30], ['parse', 10]]);
		const next = parseProfile('main;parse (src/parse.ts:10);tokenize 5\nmain;parse (src/parse.ts:10) 10\nmain;render 70\n', 'after.folded');
		const comparison = compareProfiles(base, next);
		assert.deepStrictEqual(comparison.regressions.map(item => item.frame.name), ['render']);
		assert.deepStrictEqual(comparison.improvements.map(item => item.frame.name), ['tokenize']);
		const text = summarizeComparison(base, next);
		assert.ok(text.startsWith('before.folded \u2192 after.folded: 100 \u2192 85 (-15.0%).'), text);
		const diff = diffProfiles(base, next);
		const tokenize = diff.profile.nodes.findIndex(node => diff.profile.frames[node.frame].name === 'tokenize');
		assert.deepStrictEqual([diff.base[tokenize], diff.next[tokenize]], [30, 5]);
		assert.strictEqual(diff.profile.nodes[0].total, 85, 'widths are the new run\'s');
	});

	test('speedscope: evented frames become exact slices; sampled ones a timeline in order', () => {
		const evented = parseProfile(JSON.stringify({
			$schema: 'https://www.speedscope.app/file-format-schema.json',
			shared: { frames: [{ name: 'a', file: 'a.py', line: 1 }, { name: 'b' }] },
			profiles: [{ type: 'evented', name: 'main', unit: 'milliseconds', startValue: 0, endValue: 10, events: [{ type: 'O', frame: 0, at: 0 }, { type: 'O', frame: 1, at: 2 }, { type: 'C', frame: 1, at: 5 }, { type: 'C', frame: 0, at: 10 }] }],
		}), 'py.json');
		assert.strictEqual(evented.format, 'speedscope');
		const costs = new Map(functionCosts(evented).map(cost => [evented.frames[cost.frame].name, cost]));
		assert.deepStrictEqual([costs.get('a')?.self, costs.get('a')?.total, costs.get('b')?.total], [7, 10, 3]);
		assert.deepStrictEqual(evented.timeline!.lanes[1].start, [2]);
		const sampled = parseProfile(JSON.stringify({
			shared: { frames: [{ name: 'a' }, { name: 'b' }] },
			profiles: [{ type: 'sampled', unit: 'microseconds', startValue: 0, endValue: 3000, samples: [[0], [0, 1], [0, 1]], weights: [1000, 1000, 1000] }],
		}), 'sampled.json');
		assert.strictEqual(sampled.nodes[0].total, 3);
		assert.deepStrictEqual(sampled.timeline!.lanes[1].start, [1]);
	});

	test('Chrome trace events: nested spans of the busiest thread, counters as lines', () => {
		const profile = parseProfile(JSON.stringify({
			traceEvents: [
				{ ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'main' } },
				{ ph: 'X', name: 'request', pid: 1, tid: 2, ts: 1000, dur: 10000 },
				{ ph: 'X', name: 'db', pid: 1, tid: 2, ts: 2000, dur: 6000 },
				{ ph: 'B', name: 'render', pid: 1, tid: 2, ts: 12000 },
				{ ph: 'E', pid: 1, tid: 2, ts: 14000 },
				{ ph: 'X', name: 'idle', pid: 1, tid: 3, ts: 1000, dur: 1000 },
				{ ph: 'C', name: 'heap', pid: 1, ts: 1000, args: { used: 1024 } },
				{ ph: 'C', name: 'heap', pid: 1, ts: 9000, args: { used: 4096 } },
			],
		}), 'trace.json');
		assert.strictEqual(profile.meta.thread, 'main');
		const costs = new Map(functionCosts(profile).map(cost => [profile.frames[cost.frame].name, cost]));
		assert.deepStrictEqual([costs.get('request')?.total, costs.get('request')?.self, costs.get('db')?.total, costs.get('render')?.total], [10, 4, 6, 2]);
		assert.strictEqual(profile.counters?.[0].name, 'heap used');
		assert.strictEqual(profile.counters?.[0].unit, 'bytes');
		assert.deepStrictEqual(profile.counters?.[0].points, [[0, 1024], [8, 4096]]);
	});

	test('Volt\'s own format: stacks, series and a matrix an agent writes to show data without drawing it', () => {
		const profile = parseProfile(JSON.stringify({
			$volt: 'profile', title: 'Bundle', unit: 'bytes',
			stacks: [{ stack: ['src', 'components', 'Chart.tsx'], value: 120_000 }, { stack: ['node_modules', 'lodash'], value: 70_000 }],
			series: [{ name: 'RSS', unit: 'bytes', points: [[0, 100], [10, 300], [20, 200]] }],
			matrix: { rows: ['GET /a', 'GET /b'], columns: ['p50', 'p99'], values: [[12, 80], [5, 400]], unit: 'milliseconds' },
		}), 'bundle.voltprofile.json');
		assert.strictEqual(profile.title, 'Bundle');
		assert.strictEqual(profile.nodes[0].total, 190_000);
		const summary = summarizeProfile(profile);
		assert.ok(summary.includes('Chart.tsx'));
		assert.ok(summary.includes('RSS: start 100 B, peak 300 B at 10.0ms'));
		assert.ok(summary.includes('GET /b @ p99 = 400ms'));
		assert.throws(() => parseProfile('{"$volt":"profile"}'), ProfileFormatError);
		assert.throws(() => parseProfile('hello'), /Not a profile Volt can read/);
	});

	test('the summary an agent reads: by source, hottest functions with file:line, stacks and notes', () => {
		const profile = parseProfile(CPU, 'CPU.cpuprofile');
		const text = summarizeProfile(profile, { root: '/repo' });
		assert.ok(text.startsWith('CPU.cpuprofile (cpuprofile), 8.00ms long, time: 8.00ms'), text);
		assert.ok(text.includes('By source: app 75.0% \u00b7 gc 12.5% \u00b7 program 12.5%'), text);
		assert.ok(text.includes('5.00ms  62.5%  fib (main.js:3)'), text);
		assert.ok(text.includes('1. main > fib > fib  (37.5%)'), text);
		assert.ok(text.includes('Garbage collection takes 12.5%'), text);
		assert.ok(text.includes('fib alone holds 62.5%'), text);
		assert.ok(summarizeProfile(profile, { range: { start: 2.5, end: 4.5 } }).includes('window 2.50ms to 4.50ms of 8.00ms'));
	});

	test('the heat map spreads each function\'s self time over time buckets', () => {
		const profile = parseProfile(CPU, 'cpu');
		const heat = functionHeatmap(profile, 4, 8)!;
		const row = heat.frames.indexOf(frameNamed(profile, 'fib'));
		assert.deepStrictEqual([...heat.values[row]], [0, 1, 1, 1, 1, 1, 0, 0]);
		assert.strictEqual(heat.measure, 'self');
		assert.strictEqual(heat.max, 1);
		assert.deepStrictEqual(findFrames(profile, 'FIB').map(index => profile.frames[index].name), ['fib']);
	});

	test('values print in their units', () => {
		assert.strictEqual(formatMs(0.25), '250\u00b5s');
		assert.strictEqual(formatMs(12.34), '12.3ms');
		assert.strictEqual(formatMs(1500), '1.50s');
		assert.strictEqual(formatBytes(1536), '1.5 KB');
		assert.strictEqual(formatBytes(5 * 1024 * 1024), '5.0 MB');
	});
});
