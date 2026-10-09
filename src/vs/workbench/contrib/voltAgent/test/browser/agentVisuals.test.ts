/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Color } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IColorTheme } from '../../../../../platform/theme/common/themeService.js';
import { isVoltHostTool, voltHostToolName } from '../../../../services/voltRuntime/common/hostTools.js';
import { AgentSegment } from '../../browser/blocks/agentBlocks.js';
import { describeHostToolActivity } from '../../browser/blocks/agentHostToolActivity.js';
import { buildTranscriptRows, splitWorkedRows } from '../../browser/chrome/agentTranscript.js';
import { buildVisualPage, inlineLocalImages, localImagePaths } from '../../browser/visuals/agentVisualPage.js';
import { chartPaletteVariables } from '../../browser/visuals/agentVisuals.js';
import { xychartToChartSpec } from '../../browser/blocks/agentMermaid.js';
import { fenceChartSpec } from '../../browser/blocks/agentMarkdown.js';
import { IVoltChartsHandle, voltChartsRuntime } from '../../browser/visuals/voltChartsRuntime.js';

suite('Agent visuals', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const charts = voltChartsRuntime(mainWindow);
	const handles: IVoltChartsHandle[] = [];
	let host: HTMLElement;

	setup(() => {
		host = mainWindow.document.createElement('div');
		host.style.width = '728px';
		mainWindow.document.body.appendChild(host);
	});

	teardown(() => {
		for (const handle of handles.splice(0)) {
			handle.dispose();
		}
		host.remove();
	});

	function render(visual: unknown): IVoltChartsHandle {
		const handle = charts.render(host, visual, { animate: false, locale: 'en-US' });
		handles.push(handle);
		handle.layout();
		return handle;
	}

	test('inspect counts what a visual draws and names what an agent should fix', () => {
		assert.deepStrictEqual(charts.inspect({ charts: [] }).charts, 0);
		const line = charts.inspect({ charts: [{ type: 'line', title: 'Cost', series: [{ name: 'Cost', data: [1, 2, null, 4] }], x: { start: '2026-10-01', step: 'day' } }] });
		assert.deepStrictEqual({ charts: line.charts, points: line.points, problems: line.problems }, { charts: 1, points: 3, problems: [] });
		const heat = charts.inspect({ charts: [{ type: 'heatmap', rows: ['Mon', 'Tue'], columns: ['1a', '2a'], values: [[1, 2]] }] });
		assert.ok(heat.problems.some(problem => problem.includes('"values" must have 2 rows of 2 numbers')), heat.problems.join('\n'));
		const unknown = charts.inspect({ charts: [{ type: 'polar-area', series: [{ name: 'a', data: [1] }] }] });
		assert.ok(unknown.problems.some(problem => problem.includes('unknown chart type "polar-area"') && problem.includes('sankey')), unknown.problems.join('\n'));
		const empty = charts.inspect({ charts: [{ type: 'line', title: 'Nothing', series: [{ name: 'x', data: [] }] }] });
		assert.strictEqual(empty.points, 0);
		assert.ok(empty.problems.some(problem => problem.includes('has no values to draw')));
	});

	test('reads x values as dates, epochs, categories or numbers', () => {
		const csv = charts.toCsv({
			charts: [{
				type: 'line', title: 'Requests', x: { start: '2026-10-01', step: 'day', timeZone: 'UTC' },
				series: [{ name: 'Claude', data: [3, 4] }, { name: 'Codex', data: [1, null] }],
			}],
		});
		assert.strictEqual(csv, '# Requests\nx,Claude,Codex\n2026-10-01T00:00:00.000Z,3,1\n2026-10-02T00:00:00.000Z,4,');
		assert.strictEqual(charts.toCsv({ type: 'bar', categories: ['Edit', 'Search'], series: [{ name: 'Calls', data: [5, 9] }] }), 'x,Calls\nEdit,5\nSearch,9');
		assert.strictEqual(charts.toCsv({ type: 'line', series: [{ name: 'p', data: [[1759276800000, 2]] }], x: { timeZone: 'UTC' } }), 'x,p\n2025-10-01T00:00:00.000Z,2');
	});

	test('formats each unit the way a developer reads it', () => {
		render({
			type: 'stats', items: [
				{ label: 'Total model cost', value: 18.42, unit: 'usd' },
				{ label: 'tokens', value: 12_500_000, unit: 'tokens' },
				{ label: 'latency', value: 42, unit: 'ms' },
				{ label: 'time to first token', value: 1800, unit: 'ms' },
				{ label: 'share', value: 51.2, unit: 'percent' },
				{ label: 'installs', value: 85012, unit: 'count' },
				{ label: 'tiny', value: 0.0042, unit: 'usd' },
			],
		});
		const values = [...host.querySelectorAll('.vc-stat-value')].map(element => element.textContent);
		assert.deepStrictEqual(values, ['$18.42', '12.5M', '42 ms', '1.8s', '51%', '85K', '$0.0042']);
	});

	test('guesses units from the words around the numbers', () => {
		render({ type: 'line', title: 'Daily cost', x: { start: '2026-10-01', step: 'day' }, series: [{ name: 'Spend', data: [1.5, 12, 30] }] });
		const ticks = [...host.querySelectorAll('.vc-tick text')].map(element => element.textContent);
		assert.ok(ticks.length >= 2 && ticks.every(label => label === '0' || label?.startsWith('$')), ticks.join(' '));
	});

	test('draws a line with round ticks and reads points with the keyboard', () => {
		render({ type: 'line', title: 'Requests', x: { start: '2026-10-01', step: 'day', timeZone: 'UTC' }, unit: 'count', series: [{ name: 'Requests', data: [3, 9, 4, 12, 7, 8, 15, 6, 4, 10] }] });
		const line = host.querySelector('path.vc-line');
		assert.ok(line?.getAttribute('d')?.startsWith('M'));
		const ticks = [...host.querySelectorAll('.vc-tick text')].map(element => element.textContent);
		assert.deepStrictEqual(ticks.slice(0, 2), ['0', '5']);
		const plot = host.querySelector<HTMLElement>('.vc-plot')!;
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		const live = host.querySelector('.vc-sr')!.textContent ?? '';
		assert.ok(live.includes('Oct 9') && live.includes('4'), live);
	});

	test('keeps a lone spike when thousands of points are thinned to the pixels', () => {
		const data = Array.from({ length: 5000 }, (_, index) => index === 3210 ? 9800 : 80);
		render({ type: 'line', x: { start: Date.UTC(2026, 9, 1), step: 60_000 }, unit: 'count', series: [{ name: 'Tokens/sec', data }], height: 200 });
		const d = host.querySelector('path.vc-line')!.getAttribute('d')!;
		const ys = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => Number(match[2]));
		assert.ok(ys.length < 3000, `drew ${ys.length} points`);
		const top = Math.min(...ys);
		const bottom = Math.max(...ys);
		assert.ok(bottom - top > 120, 'the spike reaches near the top of the plot');
	});

	test('shows an empty state instead of a blank box', () => {
		render({ type: 'area', series: [{ name: 'Cost', data: [] }], empty: { title: 'No usage yet', message: 'Usage will appear as your agents run.' } });
		assert.strictEqual(host.querySelector('.vc-empty-title')?.textContent, 'No usage yet');
		assert.strictEqual(host.querySelectorAll('.vc-tick').length, 0);
	});

	test('renders every chart type without throwing', () => {
		const everything = {
			title: 'Everything',
			charts: [
				{ type: 'share', x: { start: '2026-07-06', step: 'day' }, series: [{ name: 'A', data: [1, 2, 3] }, { name: 'Other', data: [3, 2, 1] }], annotations: [{ x: '2026-07-07', label: 'Ship' }] },
				{ type: 'stacked-bar', categories: ['a', 'b'], series: [{ name: 'x', data: [1, 2] }, { name: 'y', data: [2, 1] }] },
				{ type: 'scatter', series: [{ name: 's', data: [{ x: '2026-10-01T10:00:00Z', y: 1, size: 3, href: 'volt://session/abc' }] }] },
				{ type: 'heatmap', rows: ['Mon'], columns: ['1a', '2a'], values: [[1, 2]] },
				{ type: 'treemap', data: { name: 'repo', children: [{ name: 'src', children: [{ name: 'a.ts', value: 10, color: 2 }, { name: 'b.ts', value: 5, color: 9 }] }] } },
				{ type: 'row', charts: [{ type: 'donut', data: [{ label: 'a', value: 2 }, { label: 'b', value: 1 }] }, { type: 'ranked', data: [{ label: 'src/a.ts', value: 4 }] }] },
				{ type: 'cumulative', values: [100, 50, 10, 5, 1, 1, 1, 1, 1, 1], entity: 'installs', measure: 'turns' },
			],
		};
		render(everything);
		assert.strictEqual(charts.inspect(everything).empty, 0, 'no chart reads as empty');
		assert.strictEqual(charts.inspect({ type: 'row', charts: [{ type: 'donut', data: [{ label: 'a', value: 1 }] }, { type: 'heatmap', rows: ['Mon'] }] }).empty, 1, 'an empty chart inside a row counts');
		assert.strictEqual(host.querySelector('.vc-visual-title')?.textContent, 'Everything');
		assert.ok(host.querySelectorAll('.vc-tile').length >= 2);
		assert.ok(host.querySelectorAll('.vc-heat-cell').length === 2);
		assert.ok(host.querySelector('.vc-anno text')?.textContent === 'Ship');
		assert.ok([...host.querySelectorAll('.vc-callout text')].some(text => text.textContent?.startsWith('top 10%')));
	});

	test('draws the showcase types: gauge, rings, radar, funnel, sunburst, sankey and candles', () => {
		render({
			charts: [
				{ type: 'gauge', data: [{ label: 'Conventional', value: 98, max: 100 }, { label: 'Tests', value: 41 }], unit: 'percent' },
				{ type: 'rings', data: [{ label: 'web', value: 50 }, { label: 'server', value: 32 }, { label: 'mobile', value: 22 }], unit: 'percent' },
				{ type: 'radar', axes: ['Commits', 'Authors', 'Files'], series: [{ name: 'web', data: [1136, 101, 1292] }, { name: 'server', data: [729, 91, 1719] }] },
				{ type: 'funnel', data: [{ label: 'Tracked', value: 5338 }, { label: 'Touched', value: 4772 }, { label: '50+ commits', value: 15 }] },
				{ type: 'sunburst', data: { name: 'repo', children: [{ name: 'apps', children: [{ name: 'web', value: 40 }, { name: 'server', value: 60 }] }, { name: 'docs', value: 5 }] } },
				{ type: 'sankey', links: [{ source: 'Ana', target: 'fix', value: 6 }, { source: 'Ana', target: 'feat', value: 2 }, { source: 'fix', target: 'web', value: 4 }, { source: 'fix', target: 'server', value: 2 }, { source: 'feat', target: 'web', value: 2 }] },
				{ type: 'candlestick', data: [{ x: '2026-10-01', open: 10, high: 12, low: 9, close: 11 }, ['2026-10-02', 11, 11.5, 8, 9]] },
			],
		});
		assert.strictEqual(host.querySelectorAll('.vc-gauge-lit').length, 40);
		assert.strictEqual(host.querySelectorAll('.vc-gauge-lit[style*="opacity: 1"]').length, 39, 'the first gauge lights 98% of its notches');
		assert.strictEqual(host.querySelectorAll('.vc-ring-arc').length, 3);
		assert.strictEqual(host.querySelectorAll('.vc-radar-area').length, 2);
		assert.strictEqual(host.querySelectorAll('.vc-funnel-seg').length, 3);
		assert.ok([...host.querySelectorAll('.vc-note')].some(note => note.textContent?.includes('log-scaled')), 'a 5338-to-15 funnel switches to a log scale and says so');
		assert.strictEqual(host.querySelectorAll('.vc-sb-arc').length, 4);
		assert.strictEqual(host.querySelectorAll('.vc-sk-link').length, 5);
		assert.strictEqual(host.querySelectorAll('.vc-candle').length, 2);
		const sankeyNodes = [...host.querySelectorAll<SVGRectElement>('.vc-sk-node')];
		const xOf = (index: number) => Number(sankeyNodes[index].getAttribute('x'));
		assert.ok(xOf(0) < xOf(1) && xOf(1) < xOf(3), 'authors, then commit types, then packages');
		const showcase = charts.inspect({
			charts: [
				{ type: 'gauge', value: 4, max: 10 }, { type: 'rings', data: [{ label: 'web', value: 50 }] }, { type: 'radar', axes: ['a', 'b', 'c'], series: [{ name: 's', data: [1, 2, 3] }] },
				{ type: 'funnel', data: [{ label: 'a', value: 5 }, { label: 'b', value: 2 }] }, { type: 'sunburst', data: { name: 'r', children: [{ name: 'a', value: 1 }] } },
				{ type: 'sankey', links: [{ source: 'a', target: 'b', value: 1 }] }, { type: 'candlestick', data: [['2026-10-01', 1, 2, 0.5, 1.5]] }, { type: 'stats', items: [{ label: 'a', value: 1 }] },
			],
		});
		assert.strictEqual(showcase.empty, 0, showcase.problems.join('\n'));
		const inspect = charts.inspect({ charts: [{ type: 'sankey', links: [] }, { type: 'radar', axes: ['a', 'b'], series: [{ name: 's', data: [1, 2] }] }] });
		assert.ok(inspect.problems.some(problem => problem.includes('"links"')), inspect.problems.join('\n'));
		assert.ok(inspect.problems.some(problem => problem.includes('3 or more')), inspect.problems.join('\n'));
	});

	test('draws a line series over bars as a composed chart, kept out of the bar totals', () => {
		render({
			type: 'bar',
			x: { start: '2026-10-01', step: 'day' },
			headline: { aggregate: 'sum' },
			series: [{ name: 'Commits', data: [10, 20, 30] }, { name: '7-day average', type: 'line', data: [10, 15, 20] }],
		});
		assert.strictEqual(host.querySelectorAll('.vc-line').length, 1);
		assert.strictEqual(host.querySelectorAll('.vc-line.vc-ref').length, 0, 'the overlay is a solid series line, not a muted reference');
		assert.strictEqual(host.querySelector('.vc-metric-value')?.textContent, '60', 'the headline sums the bars only');
	});

	test('draws a bar chart over many long names as a ranked list, and keeps word units off the axis', () => {
		const files = ['apps/web/src/components/ChatView.tsx', 'apps/web/src/components/chat/MessagesTimeline.tsx', 'apps/server/src/ws.ts', 'apps/web/src/components/Sidebar.tsx', 'apps/web/src/components/chat/ChatComposer.tsx', 'packages/contracts/src/settings.ts'];
		render({ type: 'bar', title: 'Hottest files', unit: { suffix: ' commits' }, categories: files, series: [{ name: 'Commits', data: [199, 129, 115, 100, 92, 79] }] });
		assert.strictEqual(host.querySelectorAll('.vc-ranked-row').length, 6);
		assert.strictEqual(host.querySelector('.vc-ranked-value')?.textContent, '199 commits');
		handles.pop()!.dispose();
		render({ type: 'bar', categories: ['Mon', 'Tue', 'Wed'], unit: { suffix: ' commits' }, series: [{ name: 'Commits', data: [100, 200, 150] }] });
		assert.strictEqual(host.querySelectorAll('.vc-ranked-row').length, 0, 'short labels keep their bars');
		const ticks = [...host.querySelectorAll('.vc-tick text')].map(element => element.textContent);
		assert.ok(ticks.includes('200') && ticks.every(label => !label?.includes('commits')), ticks.join(' '));
	});

	test('switches between variants of any chart', () => {
		render({
			type: 'bar', title: 'Commits by weekday', categories: ['Mon', 'Tue'],
			variants: [{ label: 'Local', series: [{ name: 'Commits', data: [3, 4] }] }, { label: 'UTC', series: [{ name: 'Commits', data: [5, 1] }] }],
		});
		const buttons = [...host.querySelectorAll<HTMLButtonElement>('.vc-variant-head .vc-seg button')];
		assert.deepStrictEqual(buttons.map(button => button.textContent), ['Local', 'UTC']);
		assert.strictEqual(host.querySelector('.vc-title')?.textContent, 'Commits by weekday');
		buttons[1].click();
		assert.strictEqual(buttons[1].getAttribute('aria-pressed'), 'true');
		assert.strictEqual(charts.toCsv({ type: 'bar', title: 'C', categories: ['Mon'], variants: [{ label: 'A', series: [{ name: 's', data: [1] }] }, { label: 'B', series: [{ name: 's', data: [2] }] }] }), '# C · A\nx,s\nMon,1\n\n# C · B\nx,s\nMon,2');
	});

	test('does not read "size" as bytes, and warns when a treemap promises colors it lacks', () => {
		render({ type: 'scatter', title: 'Size vs. churn', series: [{ name: 'Files', data: [[1000, 50], [5000, 120], [9000, 200]] }] });
		const ticks = [...host.querySelectorAll('.vc-tick text')].map(element => element.textContent);
		assert.ok(ticks.every(label => !label?.includes('B')), ticks.join(' '));
		const report = charts.inspect({ charts: [{ type: 'treemap', colorLabel: 'edits in 60 days', data: { name: 'repo', children: [{ name: 'a.ts', value: 10 }] } }] });
		assert.ok(report.problems.some(problem => problem.includes('no tile has a numeric "color"')), report.problems.join('\n'));
	});

	test('wraps an agent page without touching its own markup', () => {
		const page = buildVisualPage('<!doctype html><html><head><title>x</title><!-- <head> --></head><body><p>Hi</p></body></html>', { themeCss: ':root{--volt-chart-accent:#123456}', kind: 'dark' });
		assert.ok(page.startsWith('<!doctype html><html><head><meta charset="utf-8">'));
		assert.ok(page.includes('window.VoltCharts=('));
		assert.ok(page.includes('<style id="volt-visual-theme">:root{--volt-chart-accent:#123456}</style>'));
		assert.ok(page.endsWith('<title>x</title><!-- <head> --></head><body><p>Hi</p></body></html>'));
		assert.ok(!/<\/script>[\s\S]*VoltCharts/.test(page.slice(0, page.indexOf('window.VoltCharts'))), 'the engine script is not closed early');
		assert.ok(buildVisualPage('<p>fragment</p>', { themeCss: '', kind: 'light' }).endsWith('<body><p>fragment</p></body></html>'));
	});

	test('finds and embeds local images', () => {
		const html = '<img src="/Users/me/shot.png"><div style="background:url(/tmp/bg.webp)"></div><img src="https://x.dev/a.png"><img src="file:///tmp/c.jpg">';
		assert.deepStrictEqual(localImagePaths(html), ['/Users/me/shot.png', '/tmp/bg.webp', 'file:///tmp/c.jpg']);
		const inlined = inlineLocalImages(html, new Map([['/Users/me/shot.png', 'data:image/png;base64,AA']]));
		assert.ok(inlined.startsWith('<img src="data:image/png;base64,AA">'));
	});

	test('takes chart hues from the theme, mixing orange when the theme has none', () => {
		const colors: Record<string, string> = {
			'textLink.foreground': '#81A1C1', 'sideBar.background': '#141414',
			'charts.green': '#3FA266', 'charts.red': '#E34671', 'charts.yellow': '#F1B467', 'charts.blue': '#3794FF', 'charts.purple': '#B180D7', 'charts.orange': '#D18616',
			'terminal.ansiBrightBlue': '#87A6C4', 'terminal.ansiMagenta': '#B48EAD', 'terminal.ansiCyan': '#88C0D0', 'terminal.ansiBrightMagenta': '#B48EAD',
		};
		const declared = new Set(['textLink.foreground', 'sideBar.background', 'charts.green', 'charts.red', 'charts.yellow', 'terminal.ansiBrightBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiBrightMagenta']);
		const theme = {
			type: ColorScheme.DARK,
			getColor: (id: string) => colors[id] ? Color.fromHex(colors[id]) : undefined,
			defines: (id: string) => declared.has(id),
		} as unknown as IColorTheme;
		const palette = chartPaletteVariables(theme);
		assert.strictEqual(palette['--volt-chart-accent'], '#81a1c1');
		assert.strictEqual(palette['--volt-chart-blue'], '#87a6c4', 'the theme\'s terminal blue beats the default chart blue');
		assert.strictEqual(palette['--volt-chart-purple'], '#b48ead');
		assert.strictEqual(palette['--volt-chart-green'], '#3fa266');
		assert.strictEqual(palette['--volt-chart-orange'], Color.fromHex('#EA7D6C').toString(), 'red and yellow mixed');
		assert.notStrictEqual(palette['--volt-chart-pink'], palette['--volt-chart-purple']);
	});

	test('render tools are Volt tools with short rows, and visuals sit above the answer', () => {
		assert.strictEqual(voltHostToolName('mcp__volt__render_chart'), 'render_chart');
		assert.ok(isVoltHostTool('volt: render_html'));
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__render_chart', undefined, JSON.stringify({ title: 'Cost by day', charts: [] })), { tool: 'render_chart', label: 'Rendered chart', detail: 'Cost by day' });
		const segments: AgentSegment[] = [
			{ kind: 'activity', item: { kind: 'browser', label: 'Rendered chart', callId: 'c1' } },
			{ kind: 'block', block: { id: 'visual-1', type: 'visual', status: 'complete', kind: 'chart', title: 'Cost', ref: 'volt-attachment:a.json' } },
			{ kind: 'activity', item: { kind: 'read', label: 'Read', path: 'a.ts', callId: 'c2' } },
			{ kind: 'text', text: 'Costs doubled.' },
		];
		const { work, answer } = splitWorkedRows(buildTranscriptRows(segments, undefined, false));
		assert.ok(work.every(row => !(row.kind === 'block' && row.block.type === 'visual')));
		assert.deepStrictEqual(answer.map(row => row.kind === 'block' ? row.block.type : row.kind), ['visual', 'markdown']);
	});

	test('a render call still streaming in holds a skeleton slot until its visual arrives', () => {
		const running: AgentSegment[] = [
			{ kind: 'text', text: 'Pulling the numbers.' },
			{ kind: 'activity', item: { kind: 'browser', label: 'Rendered chart', callId: 'c1', browserTool: 'render_chart', input: '{"title":"Cost by day","charts":[' } },
		];
		const pending = buildTranscriptRows(running, undefined, true).filter(row => row.kind === 'block' && row.block.type === 'visual');
		assert.strictEqual(pending.length, 1);
		const block = pending[0].kind === 'block' && pending[0].block.type === 'visual' ? pending[0].block : undefined;
		assert.deepStrictEqual({ ref: block?.ref, kind: block?.kind, title: block?.title }, { ref: '', kind: 'chart', title: 'Cost by day' });
		// Done (a result came back), or not live: no placeholder.
		const done: AgentSegment[] = [running[0], { kind: 'activity', item: { ...(running[1] as { item: object }).item, kind: 'browser', label: 'Rendered chart', result: 'ok' } }];
		assert.ok(!buildTranscriptRows(done, undefined, true).some(row => row.kind === 'block' && row.block.type === 'visual'));
		assert.ok(!buildTranscriptRows(running, undefined, false).some(row => row.kind === 'block' && row.block.type === 'visual'));
	});

	test('draws a mermaid xychart as a Volt chart: quotes gone, bars and lines kept', () => {
		const spec = xychartToChartSpec([
			'xychart-beta',
			'    title "GDP per person, thousand USD"',
			'    x-axis ["Liechtenstein", "Luxembourg", "United States"]',
			'    y-axis "Thousand USD" 0 --> 250',
			'    bar [227, 159, 94]',
			'    line [200, 150, 100]',
		].join('\n'));
		assert.deepStrictEqual(spec, {
			type: 'bar',
			title: 'GDP per person, thousand USD',
			unit: 'number',
			categories: ['Liechtenstein', 'Luxembourg', 'United States'],
			x: { type: 'category' },
			series: [{ name: 'Series 1', data: [227, 159, 94] }, { name: 'Series 2', data: [200, 150, 100], type: 'line' }],
			y: { label: 'Thousand USD', min: 0, max: 250 },
		});
		assert.strictEqual(xychartToChartSpec('xychart-beta\n  title "Still streaming"\n  x-axis [a, b]'), undefined);
		assert.strictEqual(xychartToChartSpec('flowchart LR\n  A --> B'), undefined);
		assert.deepStrictEqual((xychartToChartSpec('xychart-beta\n x-axis "Week" 1 --> 3\n line [1, 2, 3]') as { categories: string[] }).categories, ['1', '2', '3']);
		// Fences: a volt-chart JSON spec draws; one still streaming is a skeleton; other code stays code.
		assert.ok(typeof fenceChartSpec('volt-chart', '{"type":"bar","series":[]}') === 'object');
		assert.strictEqual(fenceChartSpec('volt-chart', '{"type":"bar","ser', true), 'pending');
		assert.strictEqual(fenceChartSpec('json', '{"a":1}'), undefined);
		assert.ok(typeof fenceChartSpec('mermaid', 'xychart-beta\n bar [1, 2]') === 'object');
	});

	test('a date pill rides the x axis with the cursor and names the point in short form', () => {
		render({ type: 'bar', x: { start: '2026-10-01', step: 'day', timeZone: 'UTC' }, unit: 'count', series: [{ name: 'Commits', data: [3, 9, 4, 12] }] });
		const plot = host.querySelector<HTMLElement>('.vc-plot')!;
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		const pill = host.querySelector('.vc-pill')!;
		assert.ok(pill.classList.contains('vc-shown'));
		assert.strictEqual(pill.textContent, 'Oct4');
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		render({ type: 'line', pill: false, x: { start: '2026-10-01', step: 'day' }, series: [{ name: 'a', data: [1, 2] }] });
		host.querySelectorAll<HTMLElement>('.vc-plot')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		assert.ok(!host.querySelectorAll('.vc-pill')[1].classList.contains('vc-shown'), '"pill": false keeps it off');
	});

	test('style options shape fills, backdrops, bands and bars', () => {
		render({
			charts: [
				{ type: 'area', style: { fill: 'pattern', stroke: false, background: 'dots', bands: [{ from: 4, to: 8, label: 'Target' }] }, categories: ['a', 'b', 'c'], series: [{ name: 's', data: [2, 6, 10] }] },
				{ type: 'bar', shape: 'pill', gap: 0, fill: 'gradient', grid: 'none', categories: ['a', 'b'], series: [{ name: 's', data: [2, 6] }] },
			],
		});
		const [area, bar] = [...host.querySelectorAll('.vc-cartesian')];
		assert.ok(/url\(/.test(area.querySelector('.vc-area')?.getAttribute('style') ?? ''), 'pattern fill');
		assert.ok(area.querySelector('.vc-line.vc-nostroke'), 'stroke: false hides the line');
		assert.ok(area.querySelector('.vc-bg pattern circle'), 'dot-grid backdrop');
		assert.strictEqual(area.querySelector('.vc-refband text')?.textContent, 'Target');
		assert.ok(bar.querySelector('.vc-grid.vc-grid-none'));
		assert.ok(/url\(/.test(bar.querySelector('.vc-bar')?.getAttribute('style') ?? ''), 'gradient bars');
	});

	test('axis pills stay bounded during rapid scrubbing and cancel their rolls on dismissal', () => {
		render({ type: 'line', categories: ['Short', 'A much longer category'], series: [{ name: 'Count', data: [2, 9] }] });
		const plot = host.querySelector<HTMLElement>('.vc-plot')!;
		for (let index = 0; index < 40; index++) {
			plot.dispatchEvent(new KeyboardEvent('keydown', { key: index % 2 ? 'Home' : 'End', bubbles: true }));
			for (const slot of host.querySelectorAll('.vc-pill-slot')) {
				assert.ok(slot.childElementCount <= 2, 'at most an outgoing and incoming word per slot');
			}
		}
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(host.querySelectorAll('.vc-pill-word').length, 1);
		assert.strictEqual(host.querySelector('.vc-pill')!.getAnimations({ subtree: true }).length, 0);
	});

	test('long axis pills and tooltips fit a narrow chart', () => {
		host.style.width = '240px';
		render({ type: 'line', categories: ['A', 'A_very_long_category_name_'.repeat(6)], series: [{ name: 'Count', data: [2, 9] }] });
		const plot = host.querySelector<HTMLElement>('.vc-plot')!;
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		for (const selector of ['.vc-pill', '.vc-tip']) {
			assert.ok(plot.querySelector(selector)!.getBoundingClientRect().width <= plot.clientWidth, selector);
		}
	});

	test('axis pills follow pointer readings across cartesian variants', async () => {
		const types = ['line', 'area', 'bar', 'grouped-bar', 'stacked-bar', 'stacked-area', 'share', 'scatter', 'composed'];
		render({ charts: types.map(type => ({ type, categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Count', data: [2, 8, 5] }] })) });
		for (const plot of host.querySelectorAll<HTMLElement>('.vc-plot')) {
			const rect = (plot.querySelectorAll('.vc-scatter')[1] ?? plot).getBoundingClientRect();
			plot.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerType: 'mouse' }));
		}
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		for (const plot of host.querySelectorAll<HTMLElement>('.vc-plot')) {
			assert.strictEqual(plot.querySelector('.vc-pill.vc-shown')?.textContent, 'Tue');
			assert.ok(plot.querySelector('.vc-tip.vc-shown'));
			plot.dispatchEvent(new PointerEvent('pointerleave'));
			assert.ok(!plot.querySelector('.vc-pill.vc-shown'));
		}
	});

	test('candlestick readings support keyboard navigation, reuse tooltips and survive resizing', async () => {
		const handle = render({ type: 'candlestick', x: { timeZone: 'UTC' }, data: [['2026-10-01', 10, 12, 9, 11], ['2026-10-02', 11, 13, 8, 9]] });
		const plot = host.querySelector<HTMLElement>('.vc-plot')!;
		plot.focus();
		assert.ok(plot.querySelector('.vc-sr')!.textContent?.includes('Oct 2'));
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		assert.ok(plot.querySelector('.vc-sr')!.textContent?.includes('Oct 1'));
		const hero = plot.querySelector('.vc-tip-hero');
		const rect = plot.getBoundingClientRect();
		for (let index = 0; index < 20; index++) {
			plot.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width / 4, clientY: rect.top + 40, pointerType: 'mouse' }));
		}
		assert.strictEqual(plot.querySelector('.vc-tip-hero'), hero, 'moving within a candle reuses the tooltip');
		plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		host.style.width = '320px';
		handle.layout();
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		const pill = plot.querySelector('.vc-pill.vc-shown')!;
		assert.strictEqual(pill.textContent, 'Oct2');
		assert.ok(pill.getBoundingClientRect().right <= plot.getBoundingClientRect().right + 1);
		plot.blur();
		assert.ok(!plot.querySelector('.vc-pill.vc-shown'));
		assert.strictEqual(plot.querySelector('.vc-sr')!.textContent, '');
	});

	test('gauge, rings, funnel, donut and candlestick variants', () => {
		render({
			charts: [
				{ type: 'gauge', shape: 'linear', notches: 50, notch: 'round', value: 42, max: 100 },
				{ type: 'gauge', notch: 'soft', depth: 0.4, value: 60, max: 100 },
				{ type: 'rings', arc: 270, caps: 'flat', legend: 'bars', data: [{ label: 'a', value: 40 }, { label: 'b', value: 80 }], unit: 'percent' },
				{ type: 'funnel', orientation: 'horizontal', edges: 'straight', colors: 'palette', labels: 'grouped', grid: true, data: [{ label: 'Visitors', value: 100 }, { label: 'Leads', value: 55 }, { label: 'Closed', value: 5 }] },
				{ type: 'pie', fill: 'pattern', data: [{ label: 'a', value: 2 }, { label: 'b', value: 1 }] },
				{ type: 'candlestick', fill: 'solid', background: 'pattern', bands: [{ from: 9, to: 10 }], data: [['2026-10-01', 10, 12, 9, 11], ['2026-10-02', 11, 11.5, 8, 9]] },
			],
		});
		const gauges = [...host.querySelectorAll('.vc-gauge')];
		assert.strictEqual(gauges[0].querySelectorAll('rect.vc-gauge-lit[style*="opacity: 1"]').length, 21, '42% of 50 notches');
		assert.ok(gauges[1].querySelector('line.vc-gauge-cap'), 'soft notches are capped strokes');
		const track = host.querySelector('.vc-ring-track')!;
		const [shown, full] = track.getAttribute('stroke-dasharray')!.split(' ').map(Number);
		assert.ok(Math.abs(shown / full - 0.75) < 0.01, 'a 270° ring track covers three quarters');
		assert.strictEqual(track.getAttribute('stroke-linecap'), 'butt');
		assert.strictEqual(host.querySelectorAll('.vc-ring-progress i').length, 2);
		assert.strictEqual(host.querySelectorAll('.vc-funnel-band').length, 2);
		assert.strictEqual(host.querySelectorAll('.vc-funnel-big').length, 3);
		const pie = host.querySelector('.vc-arc')!.closest('.vc-block')!;
		assert.strictEqual(pie.querySelector('.vc-donut-center-value')?.textContent, '', 'a pie has no hole for the center label');
		assert.ok(/url\(/.test(pie.querySelector('.vc-arc')?.getAttribute('style') ?? ''));
		assert.ok(!/url\(/.test(host.querySelector('.vc-candle-body')?.getAttribute('style') ?? ''), 'solid bodies');
		assert.ok(host.querySelector('.vc-refband'));
	});

	test('reads the heatmap and donut shapes models send and prints donut shares once', () => {
		const matrix = [[1, 2, 3], [4, 5, 6]];
		const shapes = [
			{ type: 'heatmap', x: { categories: ['a', 'b', 'c'] }, y: { categories: ['Mon', 'Tue'] }, data: matrix },
			{ type: 'heatmap', rows: ['Mon', 'Tue'], categories: ['a', 'b', 'c'], x: { type: 'category' }, data: matrix },
			{ type: 'heatmap', categories: ['a', 'b', 'c'], series: [{ name: 'Mon', data: matrix[0] }, { name: 'Tue', data: matrix[1] }] },
			{ type: 'heatmap', data: [{ x: 'a', y: 'Mon', value: 1 }, { x: 'b', y: 'Mon', value: 2 }, { x: 'c', y: 'Mon', value: 3 }, { x: 'a', y: 'Tue', value: 4 }, { x: 'b', y: 'Tue', value: 5 }, { x: 'c', y: 'Tue', value: 6 }] },
		];
		for (const shape of shapes) {
			const result = charts.inspect({ charts: [shape] });
			assert.deepStrictEqual({ points: result.points, problems: result.problems }, { points: 6, problems: [] }, JSON.stringify(shape));
		}
		render({ charts: shapes });
		assert.strictEqual(host.querySelectorAll('.vc-heat-cell').length, 24);

		render({
			charts: [
				{ type: 'donut', unit: '%', data: [{ label: 'a', value: 60 }, { label: 'b', value: 40 }] },
				{ type: 'donut', unit: 'visits', data: [{ label: 'a', value: 300 }, { label: 'b', value: 100 }] },
			],
		});
		const [given, counted] = [...host.querySelectorAll('.vc-donut-list')];
		const points = [{ x: 'Search', y: 3 }, { x: 'Direct', y: 1 }];
		for (const shape of [
			{ type: 'donut', series: [{ name: 'Sessions', data: points }] },
			{ type: 'donut', categories: ['Search', 'Direct'], series: [{ name: 'Sessions', data: [3, 1] }] },
			{ type: 'donut', series: [{ name: 'Search', data: [1, 2] }, { name: 'Direct', data: [1] }] },
			{ type: 'pie', labels: ['Search', 'Direct'], values: [3, 1] },
		]) {
			const result = charts.inspect({ charts: [shape] });
			assert.deepStrictEqual({ points: result.points, problems: result.problems }, { points: 2, problems: [] }, JSON.stringify(shape));
		}
		assert.strictEqual(given.querySelectorAll('.vc-donut-share').length, 0, 'percents that sum to 100 are the shares');
		assert.deepStrictEqual([...counted.querySelectorAll('.vc-donut-share')].map(share => share.textContent), ['75%', '25%']);
		assert.strictEqual(given.parentElement?.querySelector('.vc-donut-center-value')?.textContent, '60%', 'shares rest on the largest part, not "100%"');
		assert.strictEqual(counted.parentElement?.querySelector('.vc-donut-center-value')?.textContent, '400 visits', 'counts rest on their total');

		render({ charts: [{ type: 'bar', unit: '$k', categories: ['May', 'Jun'], series: [{ name: 'MRR', data: [148, 212] }] }] });
		const bars = [...host.querySelectorAll('.vc-root')].pop()!;
		assert.ok([...bars.querySelectorAll('.vc-tick')].some(tick => /^\$\d+k$/.test(tick.textContent ?? '')), [...bars.querySelectorAll('.vc-tick')].map(tick => tick.textContent).join(' '));
	});

	test('three small charts share a row instead of wrapping, and narrow bars keep their axis labels clear', () => {
		render({ type: 'row', charts: [1, 2, 3].map(index => ({ type: 'bar', title: `Chart ${index}`, categories: ['a', 'b'], series: [{ name: 's', data: [20, 18] }] })) });
		const tops = [...host.querySelectorAll('.vc-row > .vc-block')].map(block => Math.round(block.getBoundingClientRect().top));
		assert.strictEqual(new Set(tops).size, 1, `rows at ${tops.join(', ')}`);
		const label = [...host.querySelectorAll('.vc-tick text')].find(text => text.textContent === '20');
		assert.strictEqual(label?.getAttribute('text-anchor'), 'end', 'labels sit in a gutter left of the bars');
	});
});
