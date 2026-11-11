/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseProfile } from '../../../../services/voltRuntime/common/profiler/profileFormats.js';
import { functionHeatmap } from '../../../../services/voltRuntime/common/profiler/profileAnalysis.js';
import { categoryColor, drawCounters, drawFlameChart, drawFlameGraph, drawHeatmap, drawOverview, fitText, hitFlameChart, hitFlameGraph, hitHeatmap, IDrawTarget, IProfilerPalette, niceStep, overviewColumns, ROW_HEIGHT, RULER_HEIGHT } from '../../browser/profiler/profilerViews.js';

const PALETTE: IProfilerPalette = { dark: true, background: '#000', foreground: '#fff', muted: '#888', grid: '#333', accent: '#09f', match: '#fc0', note: '#f0a', font: 'sans-serif' };

/** A 2D context that records what is drawn: rectangles and text, enough to check culling and labels. */
function recorder(width = 800, height = 400): IDrawTarget & { readonly rects: { x: number; y: number; w: number; fill: string }[]; readonly texts: string[] } {
	const rects: { x: number; y: number; w: number; fill: string }[] = [];
	const texts: string[] = [];
	const ctx = {
		canvas: { width, height },
		fillStyle: '', strokeStyle: '', lineWidth: 1, font: '11px sans-serif', textBaseline: 'middle', globalAlpha: 1,
		fillRect(x: number, y: number, w: number) { rects.push({ x, y, w, fill: String(this.fillStyle) }); },
		strokeRect() { }, fillText(text: string) { texts.push(text); }, measureText(text: string) { return { width: text.length * 6 }; },
		beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, fill() { }, arc() { }, closePath() { }, setTransform() { },
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, width, height, rects, texts };
}

/** main runs 0-100 ms; parse 10-90 inside it, tokenize 20-30 inside parse; then (idle) 100-110. */
const PROFILE = parseProfile(JSON.stringify({
	nodes: [
		{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 5] },
		{ id: 2, callFrame: { functionName: 'main', url: 'file:///app/main.js', lineNumber: 0 }, children: [3] },
		{ id: 3, callFrame: { functionName: 'parse', url: 'file:///app/parse.js', lineNumber: 4 }, children: [4] },
		{ id: 4, callFrame: { functionName: 'tokenize', url: 'file:///app/parse.js', lineNumber: 20 } },
		{ id: 5, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
	],
	startTime: 0,
	endTime: 110_000,
	samples: [2, 3, 4, 3, 3, 3, 3, 3, 3, 2, 5],
	timeDeltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
}), 'cpu');

const NO_STYLE = { colorOf: () => '#123', isDimmed: () => false, notes: new Map<number, number>() };

function nodeOf(name: string): number {
	return PROFILE.nodes.findIndex(node => PROFILE.frames[node.frame].name === name);
}

suite('Volt profiler views', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the flame chart draws the window\'s calls by depth, and a point hits the call drawn there', () => {
		const target = recorder();
		const model = { ...NO_STYLE, profile: PROFILE, range: { start: 0, end: 110 }, scrollTop: 0 };
		const height = drawFlameChart(target, model, PALETTE);
		assert.strictEqual(height, 3 * ROW_HEIGHT + RULER_HEIGHT + 8);
		assert.ok(target.texts.includes('main') && target.texts.includes('parse') && target.texts.includes('tokenize'));
		// tokenize: 20-30 ms at depth 2.
		const x = (25 / 110) * 800;
		assert.strictEqual(hitFlameChart(model, 800, x, RULER_HEIGHT + 2 * ROW_HEIGHT + 5)?.node, nodeOf('tokenize'));
		assert.strictEqual(hitFlameChart(model, 800, x, RULER_HEIGHT + 5)?.node, nodeOf('main'));
		assert.strictEqual(hitFlameChart(model, 800, x, 5), undefined, 'the ruler is not a call');
		// Zoomed to 40-60 ms: tokenize is off screen and not drawn.
		const zoomed = recorder();
		drawFlameChart(zoomed, { ...model, range: { start: 40, end: 60 } }, PALETTE);
		assert.ok(!zoomed.texts.includes('tokenize'));
		assert.ok(zoomed.texts.includes('parse'));
	});

	test('the flame graph lays out the tree widest first, zooms into a node and keeps its ancestors as context', () => {
		const target = recorder();
		const drawn = drawFlameGraph(target, { ...NO_STYLE, profile: PROFILE, focusNode: 0, zoom: { start: 0, end: 1 }, scrollTop: 0 }, PALETTE);
		const main = drawn.rects.find(rect => rect.node === nodeOf('main'))!;
		const idle = drawn.rects.find(rect => rect.node === nodeOf('(idle)'))!;
		assert.ok(main.x < idle.x, 'the heaviest child is first');
		assert.ok(Math.abs(main.w - (100 / 110) * 800) < 0.5);
		assert.strictEqual(hitFlameGraph(drawn.rects, main.x + 5, main.y + 5), nodeOf('main'));
		const focused = drawFlameGraph(recorder(), { ...NO_STYLE, profile: PROFILE, focusNode: nodeOf('parse'), zoom: { start: 0, end: 1 }, scrollTop: 0 }, PALETTE);
		const parse = focused.rects.find(rect => rect.node === nodeOf('parse'))!;
		assert.strictEqual(parse.w, 800, 'the focus takes the whole width');
		assert.ok(focused.rects.some(rect => rect.node === nodeOf('main') && rect.w === 800), 'its caller stays above it');
		assert.ok(!focused.rects.some(rect => rect.node === nodeOf('(idle)')), 'what is outside the focus is gone');
	});

	test('the heat map and the overview show when each function is busy', () => {
		const heat = functionHeatmap(PROFILE, 4, 11)!;
		const layout = drawHeatmap(recorder(), { rows: heat.frames.map(frame => PROFILE.frames[frame].name), range: heat.range, values: heat.values, max: heat.max, unit: 'milliseconds', scrollTop: 0 }, PALETTE);
		assert.strictEqual(layout.rows, heat.frames.length);
		const parseRow = heat.frames.indexOf(PROFILE.nodes[nodeOf('parse')].frame);
		assert.deepStrictEqual(hitHeatmap(layout, 0, layout.labelWidth + layout.cellWidth * 5.5, layout.top + parseRow * layout.cellHeight + 3), { row: parseRow, column: 5 });
		const columns = overviewColumns(PROFILE, 11, (category, name) => categoryColor(PALETTE, category, name));
		assert.strictEqual(columns.length, 11);
		assert.strictEqual(columns[10].busy, 0, '(idle) is not busy');
		assert.ok(columns[5].busy > 0.99);
		drawOverview(recorder(), columns, [], 110, { start: 0, end: 50 }, PALETTE);
		drawCounters(recorder(), [{ name: 'RSS', unit: 'bytes', points: [[0, 1], [50, 5], [110, 3]] }], { start: 0, end: 110 }, PALETTE, 50);
	});

	test('labels fit their box and ticks land on round numbers', () => {
		const ctx = recorder().ctx;
		assert.strictEqual(fitText(ctx, 'tokenize', 100), 'tokenize');
		assert.ok(fitText(ctx, 'a_very_long_function_name', 60).endsWith('\u2026'));
		assert.strictEqual(fitText(ctx, 'tokenize', 10), '');
		assert.strictEqual(niceStep(1000, 1100), 100);
		assert.strictEqual(niceStep(7, 1100), 1);
		assert.strictEqual(niceStep(0.03, 1100, 110), 0.005);
	});
});
