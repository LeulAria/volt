/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/voltProfiler.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { descriptionForeground, editorBackground, editorForeground, editorWidgetBorder, focusBorder } from '../../../../../platform/theme/common/colorRegistry.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { formatValue, frameLabel, IVoltProfile, percent } from '../../../../services/voltRuntime/common/profiler/profile.js';
import { describeFrame, findFrames, frameRelations, frameTimeRange, functionCosts, functionHeatmap, IHeatmap, ITimeRange, profileTotal, summarizeProfile, topFunctions } from '../../../../services/voltRuntime/common/profiler/profileAnalysis.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { PROFILER_EDITOR_ID, VoltProfilerInput } from './profilerInput.js';
import { categoryColor, diffColor, drawCounters, drawFlameChart, drawFlameGraph, drawHeatmap, drawOverview, heatColor, hitFlameChart, hitFlameGraph, hitHeatmap, IChartModel, IDrawTarget, IGraphModel, IGraphRect, IHeatLayout, IHeatModel, IOverviewColumn, IProfilerPalette, overviewColumns, RULER_HEIGHT, xToTime } from './profilerViews.js';
import { ADD_PROFILE_TO_CHAT_COMMAND_ID, availableViews, ILoadedProfile, IProfileNote, IVoltProfilerService, ProfilerColorMode, ProfilerView } from './voltProfilerService.js';

const SIDE_WIDTH = 300;
const OVERVIEW_HEIGHT = 46;
const LIST_ROW_HEIGHT = 22;
/** Below this width the side panel folds away and the canvas takes it all. */
const SIDE_MIN_EDITOR_WIDTH = 720;
/** The smallest time window the chart zooms to (ms). */
const MIN_SPAN = 0.001;

interface IRow {
	readonly key: string;
	readonly label: string;
	readonly detail?: string;
	readonly value: string;
	/** 0..1: the bar behind the row. */
	readonly share: number;
	readonly open: () => void;
}

class RowDelegate implements IListVirtualDelegate<IRow> {
	getHeight(): number { return LIST_ROW_HEIGHT; }
	getTemplateId(): string { return RowRenderer.ID; }
}

interface IRowTemplate {
	readonly bar: HTMLElement;
	readonly value: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
}

class RowRenderer implements IListRenderer<IRow, IRowTemplate> {
	static readonly ID = 'voltProfilerRow';
	readonly templateId = RowRenderer.ID;

	renderTemplate(container: HTMLElement): IRowTemplate {
		container.classList.add('volt-profiler-row');
		const bar = append(container, $('.volt-profiler-row-bar'));
		const value = append(container, $('span.volt-profiler-row-value'));
		const label = append(container, $('span.volt-profiler-row-label'));
		const detail = append(container, $('span.volt-profiler-row-detail'));
		return { bar, value, label, detail };
	}

	renderElement(row: IRow, _index: number, template: IRowTemplate): void {
		template.bar.style.width = `${Math.round(Math.max(0, Math.min(1, row.share)) * 100)}%`;
		template.value.textContent = row.value;
		template.label.textContent = row.label;
		template.detail.textContent = row.detail ?? '';
		template.label.title = row.detail ? `${row.label}  ${row.detail}` : row.label;
	}

	disposeTemplate(): void { }
}

/** A flat VS Code list of rows (callers, callees, the table, notes), sized to its rows. */
class RowList {
	readonly host: HTMLElement;
	private readonly list: WorkbenchList<IRow>;

	constructor(parent: HTMLElement, id: string, ariaLabel: string, instantiationService: IInstantiationService, store: DisposableStore) {
		this.host = append(parent, $('.volt-profiler-list'));
		this.list = store.add(instantiationService.createInstance(WorkbenchList<IRow>, id, this.host, new RowDelegate(), [new RowRenderer()], {
			identityProvider: { getId: (row: IRow) => row.key },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: { getWidgetAriaLabel: () => ariaLabel, getAriaLabel: (row: IRow) => `${row.label} ${row.value}` },
		}));
		store.add(this.list.onDidOpen(e => e.element?.open()));
	}

	/** `maxRows` caps the height (it scrolls past that); 0 fills `height`. */
	set(rows: readonly IRow[], maxRows: number, height?: number): void {
		const h = height ?? Math.min(rows.length, maxRows) * LIST_ROW_HEIGHT;
		this.host.style.height = `${h}px`;
		this.host.style.display = rows.length ? '' : 'none';
		this.list.layout(h);
		this.list.splice(0, this.list.length, [...rows]);
	}
}

interface IDrag {
	readonly x: number;
	readonly y: number;
	readonly range?: ITimeRange;
	readonly zoom: { readonly start: number; readonly end: number };
	readonly scrollTop: number;
	moved: boolean;
}

/**
 * The Profiler tab: a flame chart (time), a flame graph (aggregated; a diff when comparing two
 * runs), a heat map of where each hot function spends its time, a table and counter lines, with an
 * overview of the whole run to brush a window from. Zoom with Ctrl/Cmd+wheel or pinch, pan by
 * dragging or Shift+wheel, W/A/S/D like Chrome, double-click to zoom into a call. The side panel
 * shows the selected function with its callers, callees and the agent's notes. What the user
 * selects, the agent reads (`profile selection`); what the agent focuses or notes, the user sees.
 */
export class VoltProfilerEditor extends EditorPane {

	static readonly ID = PROFILER_EDITOR_ID;

	private root!: HTMLElement;
	private toolbar!: HTMLElement;
	private body!: HTMLElement;
	private main!: HTMLElement;
	private overview!: HTMLCanvasElement;
	private canvas!: HTMLCanvasElement;
	private tableHost!: HTMLElement;
	private tooltip!: HTMLElement;
	private side!: HTMLElement;
	private hint!: HTMLElement;
	private message!: HTMLElement;

	private loaded: ILoadedProfile | undefined;
	private readonly toolbarStore = this._register(new DisposableStore());
	private readonly sideStore = this._register(new DisposableStore());
	private readonly tableStore = this._register(new DisposableStore());
	private table: RowList | undefined;
	private tableSort: 'self' | 'total' = 'self';

	private size = new Dimension(0, 0);
	private palette: IProfilerPalette | undefined;
	private colors: string[] = [];
	private colorKey = '';
	private matches = new Set<number>();
	private scrollTop = 0;
	private contentHeight = 0;
	private graphZoom = { start: 0, end: 1 };
	private graphRects: IGraphRect[] = [];
	private heat: IHeatmap | undefined;
	private heatKey = '';
	private heatLayout: IHeatLayout | undefined;
	private hoveredNode: number | undefined;
	private hoveredCell: { row: number; column: number } | undefined;
	private hoverTime: number | undefined;
	private drag: IDrag | undefined;
	private brush: { readonly from: number; to: number } | undefined;
	private overviewCache: { key: string; columns: IOverviewColumn[] } | undefined;
	private frame: number | undefined;
	private sideKey = '';
	private toolbarKey = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IVoltProfilerService private readonly profiler: IVoltProfilerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(PROFILER_EDITOR_ID, group, telemetryService, themeService, storageService);
		this._register(profiler.onDidChange(id => {
			const previous = this.loaded;
			const next = id === previous?.id ? profiler.get(id) : undefined;
			if (previous && next) {
				// The agent zoomed the graph to another call: show that call whole.
				if (next.state.focusNode !== previous.state.focusNode) {
					this.graphZoom = { start: 0, end: 1 };
					this.scrollTop = 0;
				}
				this.loaded = next;
				this.refresh();
			}
		}));
		this._register(toDisposable(() => {
			if (this.frame !== undefined && this.root) {
				getWindow(this.root).cancelAnimationFrame(this.frame);
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-profiler'));
		this.toolbar = append(this.root, $('.volt-profiler-toolbar'));
		this.body = append(this.root, $('.volt-profiler-body'));
		this.main = append(this.body, $('.volt-profiler-main'));
		this.overview = append(this.main, $('canvas.volt-profiler-overview')) as HTMLCanvasElement;
		this.canvas = append(this.main, $('canvas.volt-profiler-canvas')) as HTMLCanvasElement;
		this.canvas.tabIndex = 0;
		this.canvas.setAttribute('role', 'img');
		this.tableHost = append(this.main, $('.volt-profiler-table'));
		this.tooltip = append(this.main, $('.volt-profiler-tooltip'));
		this.hint = append(this.main, $('.volt-profiler-hint'));
		this.hint.textContent = localize('voltProfiler.hint', "Drag or Shift+scroll to pan \u00b7 Ctrl/Cmd+scroll or pinch to zoom \u00b7 W/S zoom, A/D pan \u00b7 double-click a call to zoom in \u00b7 Esc to zoom out");
		this.message = append(this.main, $('.volt-profiler-message'));
		this.side = append(this.body, $('.volt-profiler-side'));
		this.registerCanvasEvents();
		this.registerOverviewEvents();
		this.updateStyles();
	}

	override async setInput(input: VoltProfilerInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.loaded = undefined;
		this.scrollTop = 0;
		this.graphZoom = { start: 0, end: 1 };
		this.sideKey = '';
		this.toolbarKey = '';
		this.showMessage(localize('voltProfiler.loading', "Reading the profile\u2026"));
		try {
			const loaded = await this.profiler.load(input.file, { ...(input.compareWith ? { compareWith: input.compareWith } : {}), ...(input.chatId ? { chatId: input.chatId } : {}) });
			if (token.isCancellationRequested || this.input !== input) {
				return;
			}
			this.loaded = loaded;
			input.setTitle(loaded.profile.title);
			this.showMessage(undefined);
			this.refresh();
		} catch (err) {
			if (this.input === input) {
				this.showMessage(localize('voltProfiler.failed', "This profile could not be read: {0}", err instanceof Error ? err.message : String(err)));
			}
		}
	}

	override clearInput(): void {
		this.loaded = undefined;
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.size = dimension;
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
		this.side.style.display = dimension.width >= SIDE_MIN_EDITOR_WIDTH ? '' : 'none';
		this.toolbarKey = '';
		this.refresh();
	}

	override focus(): void {
		super.focus();
		this.canvas?.focus();
	}

	override updateStyles(): void {
		super.updateStyles();
		if (!this.root) {
			return;
		}
		const dark = isDark(this.theme.type);
		this.palette = {
			dark,
			background: this.getColor(editorBackground) ?? (dark ? '#1e1e1e' : '#ffffff'),
			foreground: this.getColor(editorForeground) ?? (dark ? '#d4d4d4' : '#1f1f1f'),
			muted: this.getColor(descriptionForeground) ?? (dark ? '#9d9d9d' : '#6f6f6f'),
			grid: this.getColor(editorWidgetBorder) ?? (dark ? '#3c3c3c' : '#e5e5e5'),
			accent: this.getColor(focusBorder) ?? '#0078d4',
			match: dark ? '#f2cc60' : '#bf8700',
			note: dark ? '#f778ba' : '#bf3989',
			font: getWindow(this.root).getComputedStyle(this.root).fontFamily || 'sans-serif',
		};
		this.colorKey = '';
		this.overviewCache = undefined;
		this.refresh();
	}

	// --- State ---------------------------------------------------------------------------------

	/** What is drawn: the profile itself, or the merged tree of a diff. */
	private shown(): IVoltProfile | undefined {
		const loaded = this.loaded;
		if (!loaded) {
			return undefined;
		}
		return loaded.state.view === 'diff' && loaded.base ? loaded.base.diff.profile : loaded.profile;
	}

	private view(): ProfilerView {
		const loaded = this.loaded!;
		const views = availableViews(loaded);
		return views.includes(loaded.state.view) ? loaded.state.view : views[0] ?? 'graph';
	}

	private range(): ITimeRange {
		const duration = this.loaded?.profile.timeline?.duration ?? this.countersDuration();
		const range = this.loaded?.state.range;
		return range && range.end > range.start ? range : { start: 0, end: Math.max(duration, MIN_SPAN) };
	}

	private countersDuration(): number {
		let end = 0;
		for (const counter of this.loaded?.profile.counters ?? []) {
			end = Math.max(end, counter.points.at(-1)?.[0] ?? 0);
		}
		return end;
	}

	private setRange(range: ITimeRange | undefined): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const duration = loaded.profile.timeline?.duration ?? this.countersDuration();
		if (range) {
			const span = Math.max(MIN_SPAN, Math.min(duration, range.end - range.start));
			const start = Math.max(0, Math.min(duration - span, range.start));
			range = { start, end: start + span };
			if (range.start <= 0 && range.end >= duration) {
				range = undefined;
			}
		}
		this.profiler.update(loaded.id, { range }, 'user');
	}

	/** Frames of the diff tree and of the profile are different lists: the same function maps by name and place. */
	private toMainFrame(frame: number | undefined): number | undefined {
		const loaded = this.loaded;
		if (frame === undefined || !loaded || this.shown() === loaded.profile) {
			return frame;
		}
		const wanted = this.shown()!.frames[frame];
		const index = loaded.profile.frames.findIndex(candidate => candidate.name === wanted.name && candidate.file === wanted.file && candidate.line === wanted.line);
		return index > 0 ? index : undefined;
	}

	private toShownFrame(frame: number | undefined): number | undefined {
		const loaded = this.loaded;
		const shown = this.shown();
		if (frame === undefined || !loaded || !shown || shown === loaded.profile) {
			return frame;
		}
		const wanted = loaded.profile.frames[frame];
		const index = shown.frames.findIndex(candidate => candidate.name === wanted?.name && candidate.file === wanted?.file && candidate.line === wanted?.line);
		return index > 0 ? index : undefined;
	}

	private select(frame: number | undefined): void {
		if (this.loaded) {
			this.profiler.update(this.loaded.id, { selectedFrame: this.toMainFrame(frame) }, 'user');
		}
	}

	/** Colors per node: by category, by how hot the function is, or by how it changed (diff). */
	private nodeColors(profile: IVoltProfile): string[] {
		const loaded = this.loaded!;
		const palette = this.palette!;
		const view = this.view();
		const key = `${loaded.id}|${view}|${loaded.state.color}|${palette.dark}|${profile.nodes.length}`;
		if (key === this.colorKey) {
			return this.colors;
		}
		let colors: string[];
		if (view === 'diff' && loaded.base) {
			const { base, next } = loaded.base.diff;
			colors = profile.nodes.map((_, index) => diffColor(palette, (next[index] - base[index]) / Math.max(next[index], base[index], 1e-12)));
		} else if (loaded.state.color === 'heat') {
			const selfByFrame = new Float64Array(profile.frames.length);
			for (const cost of functionCosts(profile)) {
				selfByFrame[cost.frame] = cost.self;
			}
			let max = 0;
			selfByFrame.forEach(value => max = Math.max(max, value));
			colors = profile.nodes.map(node => heatColor(palette, selfByFrame[node.frame] / Math.max(max, 1e-12)));
		} else {
			const byFrame = profile.frames.map(frame => categoryColor(palette, frame.category, frame.name));
			colors = profile.nodes.map(node => byFrame[node.frame]);
		}
		this.colors = colors;
		this.colorKey = key;
		return colors;
	}

	private noteFrames(): Map<number, number> {
		const map = new Map<number, number>();
		for (const note of this.loaded?.notes ?? []) {
			const frame = this.toShownFrame(note.frame);
			if (frame !== undefined && !map.has(frame)) {
				map.set(frame, note.id);
			}
		}
		return map;
	}

	// --- Rendering -----------------------------------------------------------------------------

	private showMessage(text: string | undefined): void {
		this.message.textContent = text ?? '';
		this.message.style.display = text ? '' : 'none';
	}

	/** Toolbar and side panel now (when their inputs changed), canvases at the next frame. */
	private refresh(): void {
		if (!this.loaded || !this.palette) {
			return;
		}
		const shown = this.shown()!;
		const search = this.loaded.state.search.trim();
		this.matches = new Set(search ? findFrames(shown, search) : []);
		this.renderToolbar();
		this.renderSide();
		this.scheduleDraw();
	}

	private scheduleDraw(): void {
		if (this.frame !== undefined || !this.root) {
			return;
		}
		this.frame = getWindow(this.root).requestAnimationFrame(() => {
			this.frame = undefined;
			this.draw();
		});
	}

	private renderToolbar(): void {
		const loaded = this.loaded!;
		const view = this.view();
		const key = `${loaded.id}|${view}|${loaded.state.color}|${this.tableSort}|${!!loaded.state.range}|${loaded.state.focusNode}|${this.size.width}`;
		if (key === this.toolbarKey) {
			return;
		}
		this.toolbarKey = key;
		this.toolbarStore.clear();
		clearNode(this.toolbar);
		const { profile } = loaded;
		const title = append(this.toolbar, $('.volt-profiler-title'));
		title.appendChild(renderIcon(loaded.base ? Codicon.diff : Codicon.flame));
		append(title, $('span.name')).textContent = loaded.base ? `${loaded.base.profile.title} \u2192 ${profile.title}` : profile.title;
		const total = profileTotal(profile);
		const facts = [
			...(profile.timeline ? [formatValue(profile.timeline.duration, 'milliseconds')] : []),
			...(total > 0 && profile.unit !== 'milliseconds' ? [formatValue(total, profile.unit)] : []),
			...(profile.meta.samples ? [localize('voltProfiler.samples', "{0} samples", profile.meta.samples)] : []),
			loaded.id,
		];
		append(title, $('span.facts')).textContent = facts.join(' \u00b7 ');
		const controls = append(this.toolbar, $('.volt-profiler-controls'));
		const views = availableViews(loaded);
		createVoltDropdown<ProfilerView>(controls, this.contextViewService, {
			options: views.map(id => VIEW_OPTIONS[id]()),
			value: view,
			ariaLabel: localize('voltProfiler.viewAria', "View"),
			onChange: value => this.profiler.update(loaded.id, { view: value }, 'user'),
			width: 260,
		}, this.toolbarStore);
		if (view === 'chart' || view === 'graph') {
			createVoltDropdown<ProfilerColorMode>(controls, this.contextViewService, {
				options: [
					{ id: 'category', label: localize('voltProfiler.colorCategory', "Color by source"), description: localize('voltProfiler.colorCategoryDesc', "Your code, each package, the runtime and GC in their own colors."), icon: Codicon.symbolColor },
					{ id: 'heat', label: localize('voltProfiler.colorHeat', "Color by heat"), description: localize('voltProfiler.colorHeatDesc', "Functions with the most self time are the hottest."), icon: Codicon.flame },
				],
				value: loaded.state.color,
				ariaLabel: localize('voltProfiler.colorAria', "Colors"),
				onChange: value => this.profiler.update(loaded.id, { color: value }, 'user'),
				width: 280,
			}, this.toolbarStore);
		}
		if (view === 'table') {
			createVoltDropdown<'self' | 'total'>(controls, this.contextViewService, {
				options: [
					{ id: 'self', label: localize('voltProfiler.sortSelf', "Sort by self"), description: localize('voltProfiler.sortSelfDesc', "Where the time lands.") },
					{ id: 'total', label: localize('voltProfiler.sortTotal', "Sort by total"), description: localize('voltProfiler.sortTotalDesc', "With everything it calls.") },
				],
				value: this.tableSort,
				ariaLabel: localize('voltProfiler.sortAria', "Sort"),
				onChange: value => {
					this.tableSort = value;
					this.toolbarKey = '';
					this.refresh();
				},
			}, this.toolbarStore);
		}
		const search = append(controls, $('input.volt-profiler-search')) as HTMLInputElement;
		search.type = 'search';
		search.placeholder = localize('voltProfiler.search', "Find a function or file");
		search.value = loaded.state.search;
		search.setAttribute('aria-label', localize('voltProfiler.searchAria', "Find a function or file"));
		let pending: ReturnType<typeof setTimeout> | undefined;
		this.toolbarStore.add(addDisposableListener(search, EventType.INPUT, () => {
			clearTimeout(pending);
			pending = setTimeout(() => this.profiler.update(loaded.id, { search: search.value }, 'user'), 150);
		}));
		this.toolbarStore.add(toDisposable(() => clearTimeout(pending)));
		const zoomed = !!loaded.state.range || loaded.state.focusNode > 0;
		if (zoomed) {
			const reset = this.toolbarStore.add(createVoltButton(controls, 'ghost', { supportIcons: true, title: localize('voltProfiler.resetTitle', "Show the whole profile (0)") }));
			reset.label = `$(${Codicon.screenFull.id}) ${localize('voltProfiler.reset', "Reset Zoom")}`;
			this.toolbarStore.add(reset.onDidClick(() => this.resetZoom()));
		}
		const ask = this.toolbarStore.add(createVoltButton(controls, 'secondary', { supportIcons: true, title: localize('voltProfiler.askTitle', "Add this profile, or the selected function, to the chat as context") }));
		ask.label = `$(${Codicon.sparkle.id}) ${localize('voltProfiler.ask', "Ask Agent")}`;
		this.toolbarStore.add(ask.onDidClick(() => this.addToChat()));
	}

	private resetZoom(): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		this.graphZoom = { start: 0, end: 1 };
		this.scrollTop = 0;
		this.profiler.update(loaded.id, { range: undefined, focusNode: 0 }, 'user');
	}

	private draw(): void {
		const loaded = this.loaded;
		const palette = this.palette;
		if (!loaded || !palette || !this.root) {
			return;
		}
		const view = this.view();
		const sideWidth = this.side.style.display === 'none' ? 0 : SIDE_WIDTH;
		const width = Math.max(0, this.size.width - sideWidth);
		const toolbarHeight = this.toolbar.offsetHeight;
		const timeView = view === 'chart' || view === 'counters' || (view === 'heatmap' && !!loaded.profile.timeline);
		const withOverview = timeView && (!!loaded.profile.timeline || !!loaded.profile.counters?.length);
		const overviewHeight = withOverview ? OVERVIEW_HEIGHT : 0;
		const height = Math.max(0, this.size.height - toolbarHeight - overviewHeight);
		this.overview.style.display = withOverview ? '' : 'none';
		this.canvas.style.display = view === 'table' ? 'none' : '';
		this.tableHost.style.display = view === 'table' ? '' : 'none';
		this.hint.style.display = view === 'table' ? 'none' : '';
		if (withOverview) {
			this.drawOverviewStrip(width, overviewHeight, palette);
		}
		if (view === 'table') {
			this.drawTable(width, height);
			return;
		}
		const target = this.prepare(this.canvas, width, height);
		if (!target) {
			return;
		}
		const shown = this.shown()!;
		const selectedFrame = this.toShownFrame(loaded.state.selectedFrame);
		const style = {
			colorOf: ((colors: string[]) => (node: number) => colors[node])(this.nodeColors(shown)),
			isDimmed: (node: number) => this.matches.size > 0 && !this.matches.has(shown.nodes[node].frame),
			...(selectedFrame !== undefined ? { selectedFrame } : {}),
			...(this.hoveredNode !== undefined ? { hoveredNode: this.hoveredNode } : {}),
			notes: this.noteFrames(),
		};
		switch (view) {
			case 'chart': {
				const model: IChartModel = { ...style, profile: shown, range: this.range(), scrollTop: this.scrollTop };
				this.contentHeight = drawFlameChart(target, model, palette);
				break;
			}
			case 'graph':
			case 'diff': {
				const model: IGraphModel = { ...style, profile: shown, focusNode: Math.min(loaded.state.focusNode, shown.nodes.length - 1), zoom: this.graphZoom, scrollTop: this.scrollTop };
				const drawn = drawFlameGraph(target, model, palette);
				this.graphRects = drawn.rects;
				this.contentHeight = drawn.contentHeight;
				break;
			}
			case 'heatmap': {
				const model = this.heatModel();
				if (model) {
					this.heatLayout = drawHeatmap(target, model, palette);
					this.contentHeight = RULER_HEIGHT + model.rows.length * this.heatLayout.cellHeight + 8;
				}
				break;
			}
			case 'counters':
				drawCounters(target, loaded.profile.counters ?? [], this.range(), palette, this.hoverTime);
				this.contentHeight = height;
				break;
		}
	}

	/** Sizes a canvas for the device's pixel ratio and returns its 2D context in CSS pixels. */
	private prepare(canvas: HTMLCanvasElement, width: number, height: number): IDrawTarget | undefined {
		const ratio = getWindow(this.root).devicePixelRatio || 1;
		const w = Math.max(1, Math.floor(width * ratio));
		const h = Math.max(1, Math.floor(height * ratio));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		const ctx = canvas.getContext('2d');
		if (!ctx || width <= 0 || height <= 0) {
			return undefined;
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		return { ctx, width, height };
	}

	private drawOverviewStrip(width: number, height: number, palette: IProfilerPalette): void {
		const loaded = this.loaded!;
		const target = this.prepare(this.overview, width, height);
		if (!target) {
			return;
		}
		const columns = Math.max(1, Math.floor(width));
		const key = `${loaded.id}|${columns}|${palette.dark}`;
		if (this.overviewCache?.key !== key) {
			this.overviewCache = { key, columns: overviewColumns(loaded.profile, columns, (category, name) => categoryColor(palette, category, name)) };
		}
		const duration = loaded.profile.timeline?.duration ?? this.countersDuration();
		const view = this.brush ? { start: Math.min(this.brush.from, this.brush.to), end: Math.max(this.brush.from, this.brush.to) } : this.range();
		drawOverview(target, this.overviewCache.columns, loaded.profile.counters ?? [], duration, view, palette);
	}

	private heatModel(): IHeatModel | undefined {
		const loaded = this.loaded!;
		const { profile } = loaded;
		const selectedFrame = loaded.state.selectedFrame;
		if (profile.timeline) {
			const range = this.range();
			const key = `${loaded.id}|${range.start}|${range.end}`;
			if (key !== this.heatKey) {
				this.heat = functionHeatmap(profile, 40, 160, range);
				this.heatKey = key;
			}
			const heat = this.heat;
			if (!heat) {
				return undefined;
			}
			const selectedRow = selectedFrame !== undefined ? heat.frames.indexOf(selectedFrame) : -1;
			return {
				rows: heat.frames.map(frame => frameLabel(profile.frames[frame], loaded.root)),
				range: heat.range,
				values: heat.values,
				max: heat.max,
				unit: profile.unit,
				...(selectedRow >= 0 ? { selectedRow } : {}),
				...(this.hoveredCell ? { hovered: this.hoveredCell } : {}),
				scrollTop: this.scrollTop,
			};
		}
		const matrix = profile.matrix;
		if (!matrix) {
			return undefined;
		}
		let max = 0;
		for (const row of matrix.values) {
			for (const value of row) {
				max = Math.max(max, value);
			}
		}
		return { rows: matrix.rows, columns: matrix.columns, values: matrix.values, max, unit: matrix.unit, ...(this.hoveredCell ? { hovered: this.hoveredCell } : {}), scrollTop: this.scrollTop };
	}

	private drawTable(width: number, height: number): void {
		const loaded = this.loaded!;
		const { profile } = loaded;
		if (!this.table) {
			this.table = new RowList(this.tableHost, 'voltProfilerTable', localize('voltProfiler.tableAria', "Functions"), this.instantiationService, this.tableStore);
		}
		const range = loaded.state.range;
		const total = profileTotal(profile, range);
		const rows = topFunctions(profile, { by: this.tableSort, limit: 400, ...(range ? { range } : {}), ...(loaded.state.search ? { filter: loaded.state.search } : {}) }).map((cost): IRow => {
			const frame = profile.frames[cost.frame];
			const main = this.tableSort === 'self' ? cost.self : cost.total;
			const other = this.tableSort === 'self' ? cost.total : cost.self;
			return {
				key: String(cost.frame),
				label: frame.name,
				detail: `${this.tableSort === 'self' ? localize('voltProfiler.totalShort', "total") : localize('voltProfiler.selfShort', "self")} ${formatValue(other, profile.unit)} \u00b7 ${frame.file ? frameLabel(frame, loaded.root).slice(frame.name.length + 1) : frame.category}`,
				value: `${formatValue(main, profile.unit)}  ${percent(main, total)}`,
				share: main / Math.max(total, 1e-12),
				open: () => this.select(cost.frame),
			};
		});
		this.tableHost.style.width = `${width}px`;
		this.table.set(rows, 0, height);
	}

	// --- Side panel ----------------------------------------------------------------------------

	private renderSide(): void {
		const loaded = this.loaded!;
		const key = `${loaded.id}|${loaded.state.selectedFrame}|${loaded.notes.length}|${loaded.state.range?.start}|${loaded.state.range?.end}|${loaded.state.view}`;
		if (key === this.sideKey) {
			return;
		}
		this.sideKey = key;
		this.sideStore.clear();
		clearNode(this.side);
		const { profile } = loaded;
		const range = loaded.state.range;
		const total = profileTotal(profile, range);
		const frameIndex = loaded.state.selectedFrame;
		if (frameIndex !== undefined && profile.frames[frameIndex]) {
			const frame = profile.frames[frameIndex];
			const relations = frameRelations(profile, frameIndex, range);
			const head = append(this.side, $('.volt-profiler-side-head'));
			append(head, $('.volt-profiler-side-name')).textContent = frame.name;
			if (frame.file) {
				const link = append(head, $('a.volt-profiler-side-link')) as HTMLAnchorElement;
				link.textContent = frameLabel(frame, loaded.root).slice(frame.name.length + 2, -1);
				link.title = localize('voltProfiler.openSource', "Open {0}", frame.file);
				this.sideStore.add(addDisposableListener(link, EventType.CLICK, () => this.openSource(frameIndex)));
			}
			append(head, $('span.volt-profiler-chip')).textContent = frame.category;
			const stats = append(this.side, $('.volt-profiler-stats'));
			this.stat(stats, localize('voltProfiler.self', "Self"), `${formatValue(relations.self, profile.unit)}  ${percent(relations.self, total)}`);
			this.stat(stats, localize('voltProfiler.total', "Total"), `${formatValue(relations.total, profile.unit)}  ${percent(relations.total, total)}`);
			if (loaded.base) {
				const before = new Map(functionCosts(loaded.base.profile).map(cost => [`${loaded.base!.profile.frames[cost.frame].name}|${loaded.base!.profile.frames[cost.frame].file}|${loaded.base!.profile.frames[cost.frame].line}`, cost]));
				const was = before.get(`${frame.name}|${frame.file}|${frame.line}`);
				this.stat(stats, localize('voltProfiler.before', "Before"), was ? `${formatValue(was.self, profile.unit)} self \u00b7 ${formatValue(was.total, profile.unit)} total` : localize('voltProfiler.new', "not in the run before"));
			}
			const actions = append(this.side, $('.volt-profiler-side-actions'));
			const zoom = this.sideStore.add(createVoltButton(actions, 'ghost', { supportIcons: true }));
			zoom.label = `$(${Codicon.zoomIn.id}) ${localize('voltProfiler.zoomTo', "Zoom to It")}`;
			this.sideStore.add(zoom.onDidClick(() => this.zoomToFrame(frameIndex)));
			const add = this.sideStore.add(createVoltButton(actions, 'secondary', { supportIcons: true }));
			add.label = `$(${Codicon.sparkle.id}) ${localize('voltProfiler.askAbout', "Ask Agent")}`;
			this.sideStore.add(add.onDidClick(() => this.addToChat()));
			this.sideList(localize('voltProfiler.calledFrom', "Called from"), relations.callers.slice(0, 40).map(item => this.relationRow(item.frame, item.value, relations.total)), 6);
			this.sideList(localize('voltProfiler.calls', "Calls"), relations.callees.slice(0, 60).map(item => this.relationRow(item.frame, item.value, relations.total)), 8);
		} else {
			const head = append(this.side, $('.volt-profiler-side-head'));
			append(head, $('.volt-profiler-side-name')).textContent = range ? localize('voltProfiler.window', "Hottest in this window") : localize('voltProfiler.hottest', "Hottest functions");
			append(head, $('.volt-profiler-side-detail')).textContent = localize('voltProfiler.pick', "Click a call to see its callers and callees. The agent sees what you select.");
			const rows = topFunctions(profile, { by: 'self', limit: 30, ...(range ? { range } : {}) }).map(cost => this.relationRow(cost.frame, cost.self, total));
			this.sideList(localize('voltProfiler.bySelf', "By self time"), rows, 12);
		}
		if (loaded.notes.length) {
			this.sideList(localize('voltProfiler.notes', "Notes from the agent"), loaded.notes.map(note => this.noteRow(note)), 8);
		}
	}

	private stat(parent: HTMLElement, label: string, value: string): void {
		const row = append(parent, $('.volt-profiler-stat'));
		append(row, $('span.label')).textContent = label;
		append(row, $('span.value')).textContent = value;
	}

	private sideList(title: string, rows: readonly IRow[], maxRows: number): void {
		if (!rows.length) {
			return;
		}
		append(this.side, $('.volt-profiler-side-title')).textContent = title;
		new RowList(this.side, 'voltProfilerSideList', title, this.instantiationService, this.sideStore).set(rows, maxRows);
	}

	private relationRow(frame: number, value: number, whole: number): IRow {
		const { profile, root } = this.loaded!;
		const item = profile.frames[frame];
		return {
			key: `f${frame}`,
			label: frame === 0 ? localize('voltProfiler.topLevel', "(top level)") : item.name,
			...(item.file ? { detail: frameLabel(item, root).slice(item.name.length + 1) } : {}),
			value: formatValue(value, profile.unit),
			share: value / Math.max(whole, 1e-12),
			open: () => frame > 0 && this.select(frame),
		};
	}

	private noteRow(note: IProfileNote): IRow {
		const { profile } = this.loaded!;
		const target = note.frame !== undefined ? profile.frames[note.frame]?.name : note.range ? `${formatValue(note.range.start, 'milliseconds')}\u2013${formatValue(note.range.end, 'milliseconds')}` : undefined;
		return {
			key: `n${note.id}`,
			label: note.text,
			...(target ? { detail: target } : {}),
			value: `#${note.id}`,
			share: 0,
			open: () => {
				if (note.frame !== undefined) {
					this.select(note.frame);
				}
				if (note.range) {
					this.setRange(note.range);
				}
			},
		};
	}

	private async openSource(frame: number): Promise<void> {
		const item = this.loaded?.profile.frames[frame];
		if (!item?.file) {
			return;
		}
		// A URL a profiler recorded (http://, webpack://) opens as itself; anything else is a path.
		const resource = /^[a-z][a-z0-9+.-]+:\/\//i.test(item.file) ? URI.parse(item.file) : URI.file(item.file);
		const line = item.line ?? 1;
		await this.editorService.openEditor({ resource, options: { pinned: true, selection: { startLineNumber: line, startColumn: item.column ?? 1, endLineNumber: line, endColumn: item.column ?? 1 } } }).catch(() => undefined);
	}

	private zoomToFrame(frame: number): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const view = this.view();
		if (view === 'chart' || view === 'heatmap') {
			const range = frameTimeRange(loaded.profile, frame);
			if (range) {
				const pad = (range.end - range.start) * 0.05;
				this.setRange({ start: range.start - pad, end: range.end + pad });
			}
			return;
		}
		const shown = this.shown()!;
		const shownFrame = this.toShownFrame(frame);
		// The heaviest node of the function becomes the graph's focus.
		let best = -1;
		shown.nodes.forEach((node, index) => {
			if (node.frame === shownFrame && (best < 0 || node.total > shown.nodes[best].total)) {
				best = index;
			}
		});
		if (best > 0) {
			this.graphZoom = { start: 0, end: 1 };
			this.scrollTop = 0;
			this.profiler.update(loaded.id, { focusNode: best, view: view === 'diff' ? 'diff' : 'graph' }, 'user');
		}
	}

	/** The selection (or the whole profile) as a context chip in the chat beside the tab. */
	private addToChat(): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const frame = loaded.state.selectedFrame;
		const range = loaded.state.range;
		const where = `<volt_profile id="${loaded.id}" file="${loaded.file.fsPath}"${loaded.base ? ` compare_with="${loaded.base.file.fsPath}"` : ''}${range ? ` window="${range.start.toFixed(2)}-${range.end.toFixed(2)}ms"` : ''}>`;
		const body = frame !== undefined && loaded.profile.frames[frame]
			? describeFrame(loaded.profile, frame, loaded.root, range)
			: summarizeProfile(loaded.profile, { ...(loaded.root ? { root: loaded.root } : {}), ...(range ? { range } : {}), limit: 8 });
		const value = `${where}\n${body}\nRead more with the ide tool: capability "profile", ops analyze / selection / focus / annotate, profile "${loaded.id}".\n</volt_profile>`;
		const label = frame !== undefined && loaded.profile.frames[frame] ? `${loaded.profile.frames[frame].name} \u00b7 ${loaded.id}` : `${loaded.profile.title} \u00b7 ${loaded.id}`;
		void this.commandService.executeCommand(ADD_PROFILE_TO_CHAT_COMMAND_ID, { label, value, chatId: loaded.chatId });
	}

	// --- Pointer and keys ----------------------------------------------------------------------

	private registerCanvasEvents(): void {
		const canvas = this.canvas;
		const point = (e: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width };
		};
		this._register(addDisposableListener(canvas, EventType.MOUSE_MOVE, (e: MouseEvent) => {
			const { x, y, width } = point(e);
			const drag = this.drag;
			if (drag && (e.buttons & 1)) {
				const dx = x - drag.x;
				const dy = y - drag.y;
				if (Math.abs(dx) + Math.abs(dy) > 3) {
					drag.moved = true;
				}
				if (drag.moved) {
					this.panBy(dx, dy, width, drag);
				}
				return;
			}
			this.hover(x, y, width, e);
		}));
		this._register(addDisposableListener(canvas, EventType.MOUSE_LEAVE, () => {
			this.hoveredNode = undefined;
			this.hoveredCell = undefined;
			this.hoverTime = undefined;
			this.tooltip.style.display = 'none';
			this.scheduleDraw();
		}));
		this._register(addDisposableListener(canvas, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button !== 0) {
				return;
			}
			const { x, y } = point(e);
			this.drag = { x, y, ...(this.view() !== 'graph' && this.view() !== 'diff' ? { range: this.range() } : {}), zoom: { ...this.graphZoom }, scrollTop: this.scrollTop, moved: false };
		}));
		this._register(addDisposableListener(getWindow(canvas), EventType.MOUSE_UP, (e: MouseEvent) => {
			const drag = this.drag;
			this.drag = undefined;
			if (drag && !drag.moved && e.target === canvas) {
				const { x, y, width } = point(e);
				this.select(this.hitFrame(x, y, width));
			}
		}));
		this._register(addDisposableListener(canvas, EventType.DBLCLICK, (e: MouseEvent) => {
			const { x, y, width } = point(e);
			this.zoomInto(x, y, width);
		}));
		this._register(addDisposableListener(canvas, EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			const { x, width } = point(e);
			if (e.ctrlKey || e.metaKey) {
				// A pinch on a trackpad arrives as a wheel with Ctrl.
				this.zoomAt(x, width, Math.exp(e.deltaY * 0.01));
			} else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
				this.panTime(e.shiftKey ? e.deltaY : e.deltaX, width);
			} else {
				this.scrollBy(e.deltaY);
			}
		}, { passive: false }));
		this._register(addDisposableListener(canvas, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const width = this.canvas.clientWidth;
			switch (e.key.toLowerCase()) {
				case 'w': this.zoomAt(width / 2, width, 0.8); break;
				case 's': this.zoomAt(width / 2, width, 1.25); break;
				case 'a': this.panTime(-width * 0.1, width); break;
				case 'd': this.panTime(width * 0.1, width); break;
				case '0': this.resetZoom(); break;
				case 'escape': this.zoomOut(); break;
				default: return;
			}
			e.preventDefault();
		}));
	}

	private registerOverviewEvents(): void {
		const overview = this.overview;
		const timeAt = (e: MouseEvent) => {
			const rect = overview.getBoundingClientRect();
			const duration = this.loaded?.profile.timeline?.duration ?? this.countersDuration();
			return Math.max(0, Math.min(duration, ((e.clientX - rect.left) / Math.max(1, rect.width)) * duration));
		};
		this._register(addDisposableListener(overview, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			const at = timeAt(e);
			this.brush = { from: at, to: at };
			this.scheduleDraw();
		}));
		this._register(addDisposableListener(overview, EventType.MOUSE_MOVE, (e: MouseEvent) => {
			if (this.brush && (e.buttons & 1)) {
				this.brush.to = timeAt(e);
				this.scheduleDraw();
			}
		}));
		this._register(addDisposableListener(getWindow(overview), EventType.MOUSE_UP, (e: MouseEvent) => {
			const brush = this.brush;
			if (!brush) {
				return;
			}
			this.brush = undefined;
			const from = Math.min(brush.from, brush.to);
			const to = Math.max(brush.from, brush.to);
			const duration = this.loaded?.profile.timeline?.duration ?? this.countersDuration();
			if (to - from > duration / 400) {
				this.setRange({ start: from, end: to });
			} else if (e.target === overview) {
				// A click centers the window there.
				const range = this.range();
				const span = range.end - range.start;
				this.setRange({ start: from - span / 2, end: from + span / 2 });
			}
			this.scheduleDraw();
		}));
		this._register(addDisposableListener(overview, EventType.DBLCLICK, () => this.setRange(undefined)));
	}

	private hitFrame(x: number, y: number, width: number): number | undefined {
		const shown = this.shown();
		if (!shown) {
			return undefined;
		}
		const node = this.hitNode(x, y, width);
		if (node !== undefined) {
			return shown.nodes[node].frame;
		}
		if (this.view() === 'heatmap' && this.heatLayout && this.heat && this.loaded?.profile.timeline) {
			const cell = hitHeatmap(this.heatLayout, this.scrollTop, x, y);
			return cell ? this.heat.frames[cell.row] : undefined;
		}
		return undefined;
	}

	private hitNode(x: number, y: number, width: number): number | undefined {
		switch (this.view()) {
			case 'chart':
				return this.hitChart(x, y, width)?.node;
			case 'graph':
			case 'diff':
				return hitFlameGraph(this.graphRects, x, y);
		}
		return undefined;
	}

	private hitChart(x: number, y: number, width: number) {
		return hitFlameChart({ profile: this.shown()!, range: this.range(), scrollTop: this.scrollTop, colorOf: () => '', isDimmed: () => false, notes: new Map() }, width, x, y);
	}

	private hover(x: number, y: number, width: number, e: MouseEvent): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const view = this.view();
		const shown = this.shown()!;
		const lines: string[] = [];
		if (view === 'chart' || view === 'graph' || view === 'diff') {
			const node = this.hitNode(x, y, width);
			if (node !== this.hoveredNode) {
				this.hoveredNode = node;
				this.scheduleDraw();
			}
			if (node !== undefined) {
				const frame = shown.frames[shown.nodes[node].frame];
				const total = profileTotal(shown);
				lines.push(frame.name);
				if (frame.file) {
					lines.push(frameLabel(frame, loaded.root).slice(frame.name.length + 2, -1));
				}
				if (view === 'chart') {
					const hit = this.hitChart(x, y, width);
					if (hit) {
						lines.push(localize('voltProfiler.tipSlice', "{0} at {1}", formatValue(hit.end - hit.start, 'milliseconds'), formatValue(hit.start, 'milliseconds')));
					}
				} else if (view === 'diff' && loaded.base) {
					const before = loaded.base.diff.base[node];
					const after = loaded.base.diff.next[node];
					const change = before > 0 ? ` (${after >= before ? '+' : ''}${(((after - before) / before) * 100).toFixed(1)}%)` : '';
					lines.push(`${formatValue(before, shown.unit)} \u2192 ${formatValue(after, shown.unit)}${change}`);
				} else {
					lines.push(localize('voltProfiler.tipTotal', "total {0} ({1}), self {2}", formatValue(shown.nodes[node].total, shown.unit), percent(shown.nodes[node].total, total), formatValue(shown.nodes[node].self, shown.unit)));
				}
				lines.push(`${frame.category}${this.loaded?.notes.some(note => this.toShownFrame(note.frame) === shown.nodes[node].frame) ? ` \u00b7 ${localize('voltProfiler.tipNote', "the agent left a note")}` : ''}`);
			}
		} else if (view === 'heatmap' && this.heatLayout) {
			const cell = hitHeatmap(this.heatLayout, this.scrollTop, x, y);
			const changed = cell?.row !== this.hoveredCell?.row || cell?.column !== this.hoveredCell?.column;
			this.hoveredCell = cell && cell.column >= 0 ? cell : undefined;
			if (changed) {
				this.scheduleDraw();
			}
			const model = this.heatModel();
			if (cell && cell.column >= 0 && model) {
				lines.push(model.rows[cell.row]);
				const value = model.values[cell.row][cell.column];
				if (model.range) {
					const span = (model.range.end - model.range.start) / Math.max(1, this.heatLayout.columns);
					const start = model.range.start + cell.column * span;
					lines.push(localize('voltProfiler.tipCell', "{0} between {1} and {2}", formatValue(value, model.unit), formatValue(start, 'milliseconds'), formatValue(start + span, 'milliseconds')));
				} else {
					lines.push(`${model.columns?.[cell.column] ?? ''}: ${formatValue(value, model.unit)}`);
				}
			}
		} else if (view === 'counters') {
			this.hoverTime = xToTime(x, this.range(), width);
			this.scheduleDraw();
		}
		if (lines.length) {
			this.tooltip.replaceChildren();
			lines.forEach((line, index) => append(this.tooltip, $(index === 0 ? 'strong' : 'div')).textContent = line);
			this.tooltip.style.display = 'block';
			const rect = this.main.getBoundingClientRect();
			const left = Math.min(e.clientX - rect.left + 14, rect.width - this.tooltip.offsetWidth - 8);
			this.tooltip.style.left = `${Math.max(4, left)}px`;
			this.tooltip.style.top = `${e.clientY - rect.top + 16}px`;
		} else {
			this.tooltip.style.display = 'none';
		}
	}

	/** Zooms the time window (chart, heat map, counters) or the graph around `x`; `factor` < 1 zooms in. */
	private zoomAt(x: number, width: number, factor: number): void {
		const view = this.view();
		if (view === 'graph' || view === 'diff') {
			const zoom = this.graphZoom;
			const at = zoom.start + (x / Math.max(1, width)) * (zoom.end - zoom.start);
			const span = Math.max(1e-6, Math.min(1, (zoom.end - zoom.start) * factor));
			const start = Math.max(0, Math.min(1 - span, at - (x / Math.max(1, width)) * span));
			this.graphZoom = { start, end: start + span };
			this.scheduleDraw();
			return;
		}
		if (view === 'table') {
			return;
		}
		const range = this.range();
		const at = xToTime(x, range, width);
		const span = (range.end - range.start) * factor;
		const start = at - (x / Math.max(1, width)) * span;
		this.setRange({ start, end: start + span });
	}

	private panTime(dx: number, width: number): void {
		const view = this.view();
		if (view === 'graph' || view === 'diff') {
			const span = this.graphZoom.end - this.graphZoom.start;
			const start = Math.max(0, Math.min(1 - span, this.graphZoom.start + (dx / Math.max(1, width)) * span));
			this.graphZoom = { start, end: start + span };
			this.scheduleDraw();
			return;
		}
		const range = this.range();
		const shift = (dx / Math.max(1, width)) * (range.end - range.start);
		this.setRange({ start: range.start + shift, end: range.end + shift });
	}

	private panBy(dx: number, dy: number, width: number, drag: IDrag): void {
		const view = this.view();
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.canvas.clientHeight), drag.scrollTop - dy));
		if (view === 'graph' || view === 'diff') {
			const span = drag.zoom.end - drag.zoom.start;
			const start = Math.max(0, Math.min(1 - span, drag.zoom.start - (dx / Math.max(1, width)) * span));
			this.graphZoom = { start, end: start + span };
			this.scheduleDraw();
		} else if (drag.range) {
			const shift = (dx / Math.max(1, width)) * (drag.range.end - drag.range.start);
			this.setRange({ start: drag.range.start - shift, end: drag.range.end - shift });
		} else {
			this.scheduleDraw();
		}
	}

	private scrollBy(dy: number): void {
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.canvas.clientHeight), this.scrollTop + dy));
		this.scheduleDraw();
	}

	/** Double-click: into a call (its time in the chart, its subtree in the graph), or into a heat map cell's moment. */
	private zoomInto(x: number, y: number, width: number): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const view = this.view();
		if (view === 'chart') {
			const hit = this.hitChart(x, y, width);
			if (hit) {
				const pad = (hit.end - hit.start) * 0.05;
				this.setRange({ start: hit.start - pad, end: hit.end + pad });
			}
		} else if (view === 'graph' || view === 'diff') {
			const node = hitFlameGraph(this.graphRects, x, y);
			if (node !== undefined) {
				this.graphZoom = { start: 0, end: 1 };
				this.scrollTop = 0;
				this.profiler.update(loaded.id, { focusNode: node }, 'user');
			}
		} else if (view === 'heatmap' && this.heatLayout && this.heat && loaded.profile.timeline) {
			const cell = hitHeatmap(this.heatLayout, this.scrollTop, x, y);
			if (cell && cell.column >= 0) {
				const span = (this.heat.range.end - this.heat.range.start) / this.heat.buckets;
				const start = this.heat.range.start + cell.column * span;
				this.profiler.update(loaded.id, { view: 'chart', range: { start, end: start + span }, selectedFrame: this.heat.frames[cell.row] }, 'user');
			}
		}
	}

	private zoomOut(): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const view = this.view();
		if ((view === 'graph' || view === 'diff') && loaded.state.focusNode > 0) {
			this.graphZoom = { start: 0, end: 1 };
			this.profiler.update(loaded.id, { focusNode: Math.max(0, this.shown()!.nodes[loaded.state.focusNode]?.parent ?? 0) }, 'user');
		} else if (loaded.state.selectedFrame !== undefined) {
			this.select(undefined);
		} else if (loaded.state.range) {
			const width = this.canvas.clientWidth;
			this.zoomAt(width / 2, width, 2);
		}
	}
}

const VIEW_OPTIONS: Readonly<Record<ProfilerView, () => { id: ProfilerView; label: string; description: string; icon: ThemeIcon }>> = {
	chart: () => ({ id: 'chart', label: localize('voltProfiler.viewChart', "Flame Chart"), description: localize('voltProfiler.viewChartDesc', "Calls over time, like Chrome's Performance panel."), icon: Codicon.graphLine }),
	graph: () => ({ id: 'graph', label: localize('voltProfiler.viewGraph', "Flame Graph"), description: localize('voltProfiler.viewGraphDesc', "Every call path merged, widest first."), icon: Codicon.flame }),
	diff: () => ({ id: 'diff', label: localize('voltProfiler.viewDiff', "Difference"), description: localize('voltProfiler.viewDiffDesc', "This run's flame graph, red where it got slower, blue where faster."), icon: Codicon.diff }),
	heatmap: () => ({ id: 'heatmap', label: localize('voltProfiler.viewHeat', "Heat Map"), description: localize('voltProfiler.viewHeatDesc', "When each hot function runs."), icon: Codicon.symbolColor }),
	table: () => ({ id: 'table', label: localize('voltProfiler.viewTable', "Functions"), description: localize('voltProfiler.viewTableDesc', "Every function with self and total time."), icon: Codicon.listFlat }),
	counters: () => ({ id: 'counters', label: localize('voltProfiler.viewCounters', "Counters"), description: localize('voltProfiler.viewCountersDesc', "Memory, CPU and other values over time."), icon: Codicon.pulse }),
};
