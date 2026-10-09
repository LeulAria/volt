/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Color } from '../../../../../base/common/color.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IVoltVisualPreviewService, VOLT_VISUAL_MAX_WIDTH, VOLT_VISUAL_MIN_WIDTH } from '../../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolProvider, IVoltHostToolResult, PREVIEW_HTML_TOOL_NAME, RENDER_CHART_TOOL_NAME, RENDER_HTML_TOOL_NAME } from '../../../../services/voltRuntime/common/hostTools.js';
import { WebviewThemeDataProvider } from '../../../webview/browser/themeing.js';
import { PAGE_MEASURE_WIDTHS } from './agentVisualBridge.js';
import { buildVisualPage, imageMime, inlineLocalImages, localImagePaths, VISUAL_COLUMN_WIDTH, VISUAL_MAX_HEIGHT, VISUAL_MAX_HTML_CHARS, VISUAL_MIN_HEIGHT, withPageData } from './agentVisualPage.js';
import { themeKind, visualThemeCss, voltCharts } from './agentVisuals.js';

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
const MAX_SPEC_CHARS = 4_000_000;

const CHART_GUIDE = [
	'Input: { "title"?, "subtitle"?, "charts": [chart, ...] }. Charts stack top to bottom; { "type": "row", "charts": [...] } puts small charts side by side.',
	'Types. line | area | bar | grouped-bar | stacked-bar | stacked-area | share (100% stacked) | scatter: { "type", "title", "subtitle", "series": [{ "name", "data", "color"?, "dashed"?, "reference"? }], "x"?: { "type"?: "time"|"category"|"number", "start"?, "step"?: "minute"|"hour"|"day"|"week"|"month"|ms, "timeZone"?: "UTC" }, "categories"?, "unit"?, "y"?: { "min", "max", "zero", "label" }, "height"? }.',
	'data is numbers (with x.start + x.step, or categories), [x, y] pairs (x: ISO date, epoch ms, number or category), or points { "x", "y", "label"?, "detail"?: { "Model": "...", "Tool calls": 37 }, "href"?, "size"? }. null is a gap.',
	'Extras: "headline": true or { "label", "aggregate": "sum"|"avg"|"last"|"max"|"min", "good": "up"|"down" } shows the big number and its change vs the previous period; "ranges": true adds 1D/7D/30D/3M/1Y/All; "metrics": [{ "label", "unit", "series" }] adds a switcher that morphs between them; "annotations": [{ "x", "label" }] vertical markers; "rules": [{ "y", "label" }] thresholds; "callouts": [{ "x", "y", "label" }]; "highlight": "max"|"min"|"last"; "endLabels": true; "curve": "smooth"|"linear"|"step".',
	'heatmap: { "rows": [...], "columns": [...], "values": [[...]] } with values[row][column] (weekday x hour). treemap: { "data": { "name", "children": [{ "name", "value", "color"?, "href"?, "children"? }] }, "sizeLabel": "lines", "colorLabel": "edits in 60 days" }; click zooms. donut: { "data": [{ "label", "value" }] }. ranked: { "data": [{ "label", "value", "href"? }], "mono"?: true for paths, "color"?: "heat" }. cumulative: { "values": [one per entity], "entity": "installs", "measure": "turns" } (Lorenz curve with top-N% callouts). stats: { "items": [{ "label", "value", "unit"?, "delta"?: 12.4, "good"?, "trend"?: [...] }] } is a row of headline numbers.',
	'More types. sunburst: same "data" tree as treemap, rings by depth, click zooms. sankey: { "links": [{ "source", "target", "value" }] } flows across stages (author -> commit type -> package); color follows the middle stage. funnel: { "data": [{ "label", "value" }] } stages in order. gauge: { "value", "max"?, "label" } or { "data": [{ "label", "value", "max"? }] } for a switcher. rings: { "data": [{ "label", "value", "max"? }] } concentric progress rings ("ring" is a donut). radar: { "axes": ["Commits", "Authors", ...], "series": [{ "name", "data": [one per axis] }] }, each axis scaled to its largest value. candlestick: { "data": [{ "x": "2026-10-01", "open", "high", "low", "close" }] }. Composed: a bar chart whose series has "type": "line" draws it as a line over the bars (a 7-day average over daily bars).',
	'Look (you choose; defaults are good): on line/area/bar/candlestick charts "style": { "fill": "gradient"|"solid"|"pattern"|"none", "stroke": false (fill only), "fadeEdges": true, "background": "dots"|"pattern", "grid": "dashed"|"solid"|"none", "shape": "rounded"|"square"|"pill" (bars), "gap": 0-0.9 (bars; 0 touches), "bands": [{ "from", "to", "label"?, "pattern"? }] (target ranges), "pill": false (hides the date pill that follows the cursor) }. candlestick "colors": { "up", "down" }. funnel "orientation": "horizontal"|"vertical", "edges": "straight", "colors": "palette"|"gradient", "fill": "pattern", "labels": "grouped", "grid": true. gauge "shape": "linear", "notch": "square"|"soft"|"round", "depth": 0.15-1, "notches", "colors": [from, to], "labelPlacement": "center"|"below"|"none". rings "arc": 360|270|180, "caps": "flat", "thickness", "legend": "bars"|"none", "centerValue", "centerLabel". donut "hole": 0-0.9 (type "pie" is 0), "fill": "gradient"|"pattern", "hover": "grow", "centerValue".',
	'unit: "usd" | "tokens" | "count" | "percent" (0-100) | "ratio" (0-1) | "ms" | "s" | "bytes" | { "prefix", "suffix", "decimals" }; numbers format themselves ($1.2K, 14.2M, 1.8s). Leave colors out: Volt uses the theme\'s own palette and grays a series named "Other". If you must: "accent", "blue", "green", "orange", "purple", "yellow", "red", "teal", "pink", "muted".',
	'"variants": [{ "label": "Lines", ...fields that change }, { "label": "Churn", ... }] on any chart adds a switcher beside its title (size by lines vs churn, local time vs UTC, commits vs lines changed); line and bar variants morph into each other.',
	'"href" on a point, row or tile opens it in Volt: "volt://session/<chatId>", "volt://file/<path>#L12", or an https URL. Bar charts over many long names (files, models) draw as a ranked list on their own.',
	'Write titles that state the finding ("Opus 5.5 went from 0 to half of all turns in 3 days") and subtitles that say what is measured. Keep to 8 series (fold the rest into "Other"). Up to 50,000 points per series; dense data is downsampled without losing peaks.',
].join(' ');

const PAGE_GUIDE = [
	'Write one self-contained document with inline <style> and <script>. Remote https resources load as-is; local images written as absolute paths (src="/abs/shot.png", url(/abs/bg.webp)) are embedded automatically.',
	'Theme: the page sits on the chat background and follows the user\'s VS Code theme live. Style with CSS variables: --background --foreground --muted --muted-foreground --card --popover --border --input --ring --primary --primary-foreground --accent --destructive --warning --success --info --code-background --chart-1 ... --chart-8 --radius --font-sans --font-mono, and every --vscode-* theme color. body has the class vscode-light or vscode-dark.',
	'Layout: fluid width, no outer padding, card, border or banner title: the page is part of the reply and lines up with your text (728px on desktop, narrower when the chat is). Leave html, body and the outermost element without a background color (even if you would normally pick a dark page background): the chat shows through. A box that needs its own background gets at least 16px padding and var(--radius) corners. Give charts fixed pixel heights; never use 100vh or height:100% on html/body (the frame grows to fit the page, up to 2000px, so they make it grow again and again).',
	'Charts inside a page: window.VoltCharts.render(element, spec) takes the same chart specs as render_chart (or { "charts": [...] }), or put <script type="application/volt-chart+json">{...}</script> where a chart should go. Links into Volt: window.volt.open("volt://session/<id>" | "volt://file/<path>#L12" | "https://..."), window.volt.openFile(path, line), window.volt.openSession(id).',
	'Interactive pages talk back: window.volt.send(text) sends a message to you as the user (wire it to a button the user clicks: "Use option B", "Apply these settings"); window.volt.prompt(text) puts it in the composer for the user to edit and send; window.volt.setContext(value) sets state (a string or JSON: selections, filters, form values) that you receive with the user\'s next message; window.volt.fullscreen(true) shows the page over the chat. Pass large data as `data` (any JSON) and read it as window.volt.data, so the HTML stays a small template. Scripts run sandboxed, away from Volt and the user\'s session.',
].join(' ');

export const VISUAL_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: RENDER_CHART_TOOL_NAME,
		title: 'Rendered chart',
		group: 'visuals',
		description: `Show charts inline in this chat, above your final reply. Volt draws them natively in the user's theme (any VS Code theme, light or dark) with a hover crosshair and tooltips, legend toggles, range and metric switchers, keyboard reading and clickable points. Use it whenever a chart, dashboard or a few headline numbers say more than prose: you send data, not drawing code, so it takes seconds. Reach for it unasked when the answer has numbers over time, comparisons, distributions, flows or hierarchies, or analyses a repo or its usage; skip it for short answers. This is the tool for every data chart (bar, line, area, pie/donut, scatter, heatmap, treemap...): never draw data as a mermaid xychart-beta/pie, ASCII bars or an HTML page instead. Mermaid is for diagrams only (flowcharts, sequence, state, ER). Call it before your final text; the reader already sees the charts, so do not describe or restate them. ${CHART_GUIDE}`,
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Optional heading over all charts.' },
				subtitle: { type: 'string' },
				charts: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true }, description: 'Chart specs, drawn top to bottom.' },
			},
			required: ['charts'],
		},
	},
	{
		name: RENDER_HTML_TOOL_NAME,
		title: 'Rendered page',
		group: 'visuals',
		description: `Show a finished, self-contained HTML page (dashboard, report, mockup, diagram, image collage, interactive explainer or picker) live inline in this chat, above your final reply, in a sandboxed frame that follows the user's theme and fits the page's height at every chat width. For plain data charts prefer render_chart, or mix: pages can draw Volt charts too. Check the page with html_preview first; console errors from loading it come back in this result. Call it before your final text; the reader already sees the page, so do not announce, describe or restate it. ${PAGE_GUIDE}`,
		inputSchema: {
			type: 'object',
			properties: {
				html: { type: 'string', description: 'A complete, self-contained HTML document.' },
				title: { type: 'string', description: 'Short name for the page.' },
				height: { type: 'number', description: `Optional cap on the frame height in px (${VISUAL_MIN_HEIGHT}-${VISUAL_MAX_HEIGHT}); taller content scrolls inside. Leave it out to fit the page.` },
				data: { description: 'Optional JSON the page reads as window.volt.data (rows for a table, series for charts), so the HTML stays a small template.' },
			},
			required: ['html', 'title'],
		},
	},
	{
		name: PREVIEW_HTML_TOOL_NAME,
		title: 'Previewed page',
		group: 'visuals',
		description: `Render an HTML page offscreen in Volt, with the user's current theme, and get back a PNG screenshot (one image pixel per CSS pixel), contentHeight (what the page needs at that width), and the page's console output and uncaught errors with stack traces. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. ${PAGE_GUIDE}`,
		inputSchema: {
			type: 'object',
			properties: {
				html: { type: 'string', description: 'A complete, self-contained HTML document.' },
				width: { type: 'number', description: `Viewport width in CSS px, ${VOLT_VISUAL_MIN_WIDTH}-${VOLT_VISUAL_MAX_WIDTH}. Default ${VISUAL_COLUMN_WIDTH}, the reply column; about 390 checks phones.` },
				data: { description: 'The same `data` you will pass to html_render (window.volt.data).' },
			},
			required: ['html'],
		},
	},
];

function text(value: unknown, max = 200): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function formatMib(bytes: number): string {
	return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** Serves render_chart, html_render and html_preview on Volt's MCP server. */
export class AgentVisualToolProvider extends Disposable implements IVoltHostToolProvider {

	readonly tools = VISUAL_TOOLS;
	private readonly webviewTheme: WebviewThemeDataProvider;

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IFileService private readonly fileService: IFileService,
		@IThemeService private readonly themeService: IThemeService,
		@IVoltVisualPreviewService private readonly preview: IVoltVisualPreviewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.webviewTheme = this._register(instantiationService.createInstance(WebviewThemeDataProvider));
	}

	async invoke(name: string, args: Record<string, unknown>, _call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		switch (name) {
			case RENDER_CHART_TOOL_NAME: return this.renderChart(args);
			case RENDER_HTML_TOOL_NAME: return this.renderHtml(args);
			case PREVIEW_HTML_TOOL_NAME: return this.previewHtml(args);
		}
		return { error: `Unknown tool ${name}` };
	}

	private async renderChart(args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		let charts = args.charts;
		if (typeof charts === 'string') {
			try {
				charts = JSON.parse(charts);
			} catch {
				return { error: '"charts" is a string that is not valid JSON. Pass the array itself.' };
			}
		}
		if (!Array.isArray(charts) && charts && typeof charts === 'object') {
			charts = [charts];
		}
		// A single chart spec passed as the arguments themselves keeps its title on the chart.
		const single = !Array.isArray(charts) && !!(args.type || args.series || args.metrics || args.items || args.data || args.values);
		if (single) {
			charts = [args];
		}
		if (!Array.isArray(charts) || !charts.length) {
			return { error: 'Pass "charts": [ { "type": "line", "series": [ ... ] } ].' };
		}
		const visual = single ? { charts } : { title: text(args.title, 160), subtitle: text(args.subtitle, 300), charts };
		const engine = voltCharts(mainWindow);
		const report = engine.inspect(visual);
		if (!report.charts || !report.points) {
			return { error: `Nothing to draw. ${report.problems.join(' ')}`.trim() };
		}
		// A chart that would draw as an empty card is not shown at all: the agent fixes it and sends
		// the whole visual again, so the user sees one complete dashboard rather than a broken card
		// followed by a redraw.
		if (report.empty) {
			return { error: `Nothing was shown: ${report.problems.join(' ')} Fix those charts and call this tool again with every chart.`.trim() };
		}
		const json = JSON.stringify(visual);
		if (json.length > MAX_SPEC_CHARS) {
			return { error: `The spec is ${formatMib(json.length)}; the limit is ${formatMib(MAX_SPEC_CHARS)}. Aggregate or sample the data first.` };
		}
		const ref = await this.history.putAttachment(VSBuffer.fromString(json).buffer, 'application/json');
		const firstTitle = (charts as unknown[]).map(chart => chart && typeof chart === 'object' ? text((chart as Record<string, unknown>).title, 160) : undefined).find(Boolean);
		const title = ('title' in visual ? visual.title : undefined) ?? firstTitle ?? 'Chart';
		const lines = [
			`Shown to the user above your reply: ${engine.describe(visual).replace(/\n/g, '; ')}. Do not describe or restate it; reply with only what it does not show.`,
		];
		if (report.problems.length) {
			lines.push(`Drawn with warnings: ${report.problems.join(' ')}`);
		}
		return { text: lines.join('\n'), visual: { kind: 'chart', ref, title } };
	}

	private async renderHtml(args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const html = typeof args.html === 'string' ? args.html : '';
		const title = text(args.title, 200);
		if (!html.trim()) {
			return { error: 'Pass "html": a complete HTML document.' };
		}
		if (!title) {
			return { error: 'Pass a short "title" for the page.' };
		}
		if (html.length > VISUAL_MAX_HTML_CHARS) {
			return { error: `The page is ${html.length.toLocaleString()} characters; the limit is ${VISUAL_MAX_HTML_CHARS.toLocaleString()}. Move data into a compact JSON array or load it from a URL.` };
		}
		const page = args.data !== undefined ? withPageData(html, args.data) : html;
		const inlined = await this.inlineImages(page, true);
		if ('error' in inlined) {
			return { error: inlined.error };
		}
		const bytes = VSBuffer.fromString(inlined.html);
		if (bytes.byteLength > MAX_PAGE_BYTES) {
			return { error: `With its images embedded the page is ${formatMib(bytes.byteLength)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.` };
		}
		const ref = await this.history.putAttachment(bytes.buffer, 'text/html');
		// Measured at the reader widths a chat can have, so the frame opens at the page's height at
		// any of them (no jump when the page loads), and its load errors come back to the agent.
		let height: number | undefined;
		let heights: [number, number][] | undefined;
		let errors: string[] = [];
		try {
			const measured = await this.preview.capture({ html: this.previewPage(inlined.html), width: VISUAL_COLUMN_WIDTH, measureOnly: true, measureWidths: PAGE_MEASURE_WIDTHS.filter(width => width !== VISUAL_COLUMN_WIDTH) });
			height = measured.contentHeight;
			heights = [[VISUAL_COLUMN_WIDTH, measured.contentHeight] as [number, number], ...measured.heights.map(([width, h]) => [width, h] as [number, number])].sort((a, b) => a[0] - b[0]);
			errors = measured.console.filter(message => message.level === 'error').map(message => message.text);
		} catch (err) {
			this.logService.warn('[volt] could not measure a visual page', err);
			errors = [err instanceof Error ? err.message : String(err)];
		}
		const cap = typeof args.height === 'number' && Number.isFinite(args.height) ? Math.max(VISUAL_MIN_HEIGHT, Math.min(VISUAL_MAX_HEIGHT, args.height)) : undefined;
		const shown = Math.max(VISUAL_MIN_HEIGHT, Math.min(cap ?? VISUAL_MAX_HEIGHT, height ?? cap ?? 480));
		const lines = ['Shown to the user above your reply. Do not mention or describe the page; reply with only what it does not already say.'];
		if (errors.length) {
			lines.push(`But the page reported ${errors.length} error${errors.length === 1 ? '' : 's'} while loading, so the reader may see it broken. Fix ${errors.length === 1 ? 'it' : 'them'} and call html_render again (html_preview shows the result first):`, ...errors.slice(0, 8).map(error => `- ${error.slice(0, 600)}`));
		}
		return {
			text: lines.join('\n'),
			visual: { kind: 'html', ref, title, height: shown, ...(heights?.length ? { heights } : {}), ...(cap ? { cap } : {}) },
		};
	}

	private async previewHtml(args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const html = typeof args.html === 'string' ? args.html : '';
		if (!html.trim()) {
			return { error: 'Pass "html": a complete HTML document.' };
		}
		if (html.length > VISUAL_MAX_HTML_CHARS) {
			return { error: `The page is ${html.length.toLocaleString()} characters; the limit is ${VISUAL_MAX_HTML_CHARS.toLocaleString()}.` };
		}
		const width = typeof args.width === 'number' && Number.isFinite(args.width) ? Math.round(Math.min(VOLT_VISUAL_MAX_WIDTH, Math.max(VOLT_VISUAL_MIN_WIDTH, args.width))) : VISUAL_COLUMN_WIDTH;
		const inlined = await this.inlineImages(args.data !== undefined ? withPageData(html, args.data) : html, false);
		if ('error' in inlined) {
			return { error: inlined.error };
		}
		const result = await this.preview.capture({ html: this.previewPage(inlined.html), width, background: this.previewBackground() });
		const report = {
			width: result.width,
			contentHeight: result.contentHeight,
			capturedHeight: result.capturedHeight,
			theme: themeKind(this.themeService.getColorTheme()),
			consoleMessages: result.console,
			...(inlined.missing.length ? { missingImages: inlined.missing } : {}),
		};
		return { text: JSON.stringify(report, null, 1), image: result.png ? `data:image/png;base64,${result.png}` : undefined };
	}

	/** The page as an offscreen window sees it: every `--vscode-*` color inlined (no webview to inject them), animations off. */
	private previewPage(html: string): string {
		const theme = this.themeService.getColorTheme();
		const styles = this.webviewTheme.getWebviewThemeData().styles;
		const vscode: Record<string, string> = {};
		for (const [key, value] of Object.entries(styles)) {
			vscode[`--${key}`] = String(value);
		}
		return buildVisualPage(html, { themeCss: visualThemeCss(theme, vscode), kind: themeKind(theme), preview: true });
	}

	/** What the page sits on in the chat (`--background`), made opaque for the screenshot. */
	private previewBackground(): { r: number; g: number; b: number } {
		const theme = this.themeService.getColorTheme();
		const fallback = Color.fromHex(themeKind(theme) === 'light' ? '#ffffff' : '#1e1e1e');
		const editor = theme.getColor('editor.background')?.makeOpaque(fallback) ?? fallback;
		const { r, g, b } = (theme.getColor('sideBar.background') ?? editor).makeOpaque(editor).rgba;
		return { r, g, b };
	}

	private async inlineImages(html: string, strict: boolean): Promise<{ html: string; missing: string[] } | { error: string }> {
		const paths = localImagePaths(html);
		const images = new Map<string, string>();
		const missing: string[] = [];
		let total = 0;
		for (const raw of paths.slice(0, 200)) {
			const path = raw.replace(/^file:\/\//i, '');
			const mime = imageMime(path);
			if (!mime) {
				continue;
			}
			try {
				const resource = URI.file(decodeURIComponent(path));
				const stat = await this.fileService.stat(resource);
				if (stat.size !== undefined && stat.size > MAX_IMAGE_BYTES) {
					return { error: `${path} is ${formatMib(stat.size)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.` };
				}
				const content = await this.fileService.readFile(resource);
				total += content.value.byteLength;
				if (total > MAX_PAGE_BYTES) {
					return { error: `The page's images add up to more than ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.` };
				}
				images.set(raw, `data:${mime};base64,${encodeBase64(content.value)}`);
			} catch {
				missing.push(path);
			}
		}
		if (strict && missing.length) {
			return { error: `These local images could not be read: ${missing.join(', ')}. Use absolute paths to existing image files, or remove them.` };
		}
		return { html: images.size ? inlineLocalImages(html, images) : html, missing };
	}
}
