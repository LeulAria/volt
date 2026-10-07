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
		const unknown = charts.inspect({ charts: [{ type: 'radar', series: [{ name: 'a', data: [1] }] }] });
		assert.ok(unknown.problems.some(problem => problem.includes('unknown chart type "radar"')), unknown.problems.join('\n'));
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
		render({
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
		});
		assert.strictEqual(host.querySelector('.vc-visual-title')?.textContent, 'Everything');
		assert.ok(host.querySelectorAll('.vc-tile').length >= 2);
		assert.ok(host.querySelectorAll('.vc-heat-cell').length === 2);
		assert.ok(host.querySelector('.vc-anno text')?.textContent === 'Ship');
		assert.ok([...host.querySelectorAll('.vc-callout text')].some(text => text.textContent?.startsWith('top 10%')));
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
});
