/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ARCHITECTURE_COLORS, colorOf } from './scratchArchitecture.js';
import { createText } from './scratchFactory.js';
import { escapeHtml } from './scratchHtml.js';
import { AGENT_DIAGRAM_STYLE, IScratchStyleDefaults, IScratchTextElement, ScratchElement, ScratchTextAlign } from './scratchTypes.js';

/**
 * Pages: a hand-lettered sheet like a slide someone wrote in Excalidraw. A big heading, a
 * comparison table (row names in quiet grey, values centred under their column, the best value in
 * a row picked out in green), a small footnote and a few takeaway bullets. Every piece is plain
 * board text, so the user can move or retype any cell afterwards.
 */

// ---- The spec --------------------------------------------------------------------------------

export interface IPageCell {
	readonly text: string;
	/** Light-space colour; unset draws in ink (or green when it is its row's best). */
	readonly color: string | undefined;
	readonly best: boolean;
}

export interface IPageColumn {
	readonly label: string;
	readonly color: string | undefined;
}

export interface IPageRow {
	readonly label: string;
	readonly cells: readonly IPageCell[];
	/** Which number wins the row: its best cells turn green. */
	readonly best: 'high' | 'low' | undefined;
}

export interface IPageTable {
	readonly columns: readonly IPageColumn[];
	readonly rows: readonly IPageRow[];
}

export interface IPageSpec {
	readonly heading: string;
	readonly subtitle: string;
	readonly table: IPageTable | undefined;
	readonly footnote: string;
	readonly bullets: readonly string[];
}

const MAX_COLUMNS = 8;
const MAX_ROWS = 40;
const MAX_BULLETS = 12;

/** What a row's best value is drawn in, unless a cell sets its own colour. */
export const PAGE_BEST_COLOR = ARCHITECTURE_COLORS.green;
const INK = '#1e1e1e';
const MUTED = '#868e96';

function text(v: unknown, max: number): string {
	return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : '';
}

function cellOf(v: unknown): IPageCell {
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		const o = v as Record<string, unknown>;
		return { text: text(o.text ?? o.value, 80), color: colorOf(o.color), best: o.best === true };
	}
	return { text: text(v, 80), color: undefined, best: false };
}

/** The agent's page as a spec, or what is wrong with it. Takes the object or its JSON text. */
export function parsePageSpec(value: unknown, fallbackHeading = ''): { readonly spec: IPageSpec; readonly warnings: string[] } | { readonly error: string } {
	let input = value;
	if (typeof input === 'string') {
		try {
			input = JSON.parse(input);
		} catch {
			return { error: '`page` must be an object: { heading, table: { columns, rows }, footnote, bullets }.' };
		}
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { error: '`page` must be an object: { heading, table: { columns, rows }, footnote, bullets }.' };
	}
	const v = input as Record<string, unknown>;
	const warnings: string[] = [];
	let table: IPageTable | undefined;
	if (v.table !== undefined && v.table !== null) {
		const t = v.table as Record<string, unknown>;
		const rawColumns = Array.isArray(t.columns) ? t.columns : [];
		const columns: IPageColumn[] = rawColumns.slice(0, MAX_COLUMNS).map(c => c && typeof c === 'object' ? { label: text((c as Record<string, unknown>).label, 60), color: colorOf((c as Record<string, unknown>).color) } : { label: text(c, 60), color: undefined });
		if (rawColumns.length > MAX_COLUMNS) {
			warnings.push(`only the first ${MAX_COLUMNS} columns were drawn`);
		}
		const rawRows = Array.isArray(t.rows) ? t.rows : [];
		if (rawRows.length > MAX_ROWS) {
			warnings.push(`only the first ${MAX_ROWS} rows were drawn`);
		}
		const rows: IPageRow[] = [];
		for (const raw of rawRows.slice(0, MAX_ROWS)) {
			// A row is { label, cells } or an array whose first item is its name.
			const r: Record<string, unknown> = Array.isArray(raw) ? { label: raw[0], cells: raw.slice(1) } : raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
			const cells = (Array.isArray(r.cells) ? r.cells : Array.isArray(r.values) ? r.values : []).slice(0, MAX_COLUMNS).map(cellOf);
			const best = r.best === 'high' || r.best === 'max' ? 'high' : r.best === 'low' || r.best === 'min' ? 'low' : undefined;
			rows.push({ label: text(r.label ?? r.name, 120), cells, best });
		}
		const width = Math.max(columns.length, ...rows.map(r => r.cells.length));
		if (!width || !rows.length) {
			return { error: 'The page\'s `table` needs `columns` (the names along the top) and `rows` ({ label, cells }).' };
		}
		// Every column has a header, even an empty one, so cells line up under it.
		while (columns.length < width) {
			columns.push({ label: '', color: undefined });
		}
		table = { columns, rows };
	}
	const bullets = (Array.isArray(v.bullets) ? v.bullets : []).slice(0, MAX_BULLETS).map(b => text(b, 240)).filter(Boolean);
	const spec: IPageSpec = {
		heading: text(v.heading ?? v.title, 160) || fallbackHeading,
		subtitle: text(v.subtitle, 240),
		table,
		footnote: text(v.footnote ?? v.note, 400),
		bullets,
	};
	if (!spec.table && !spec.bullets.length && !spec.subtitle) {
		return { error: 'Nothing on the page: give it a `table`, `bullets` or a `subtitle`.' };
	}
	return { spec, warnings };
}

// ---- Layout ----------------------------------------------------------------------------------

export interface IPageOptions {
	readonly style?: IScratchStyleDefaults;
	/** Width of `text` at `fontSize` in the hand font; an estimate when not given. */
	readonly measure?: (text: string, fontSize: number) => number;
}

const HEADING_SIZE = 44;
const SUBTITLE_SIZE = 22;
const HEADER_SIZE = 20;
const LABEL_SIZE = 20;
const VALUE_SIZE = 22;
const FOOTNOTE_SIZE = 13;
const BULLET_SIZE = 20;
/** The hand font's line height (see lineHeightFor). */
const LINE = 1.25;

/** The row names' column wraps past this. */
const LABEL_MAX = 400;
const LABEL_GAP = 56;
const VALUE_MIN = 150;
const VALUE_PAD = 56;
const ROW_GAP = 22;
const PAGE_MIN = 720;

function estimateWidth(value: string, fontSize: number): number {
	return value.length * fontSize * 0.56;
}

/** Words wrapped to `max` px. */
function wrap(value: string, fontSize: number, max: number, measure: (text: string, fontSize: number) => number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of value.split(' ')) {
		const next = line ? `${line} ${word}` : word;
		if (line && measure(next, fontSize) > max) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines;
}

/** The first number in a cell ("$2 / $10" is 2, "1,846" is 1846, "67.2%" is 67.2). */
export function cellNumber(value: string): number | undefined {
	const match = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(value);
	if (!match) {
		return undefined;
	}
	const n = Number(match[0].replace(/,/g, ''));
	return Number.isFinite(n) ? n : undefined;
}

/** Which cells of a row are its best: marked `best`, or the highest (lowest) number when the row says which wins. */
export function bestCells(row: IPageRow): ReadonlySet<number> {
	const marked = new Set(row.cells.flatMap((cell, i) => cell.best ? [i] : []));
	if (marked.size || !row.best) {
		return marked;
	}
	const numbers = row.cells.map(cell => cellNumber(cell.text));
	const known = numbers.filter((n): n is number => n !== undefined);
	// One number alone wins nothing.
	if (known.length < 2 || known.every(n => n === known[0])) {
		return marked;
	}
	const target = row.best === 'high' ? Math.max(...known) : Math.min(...known);
	numbers.forEach((n, i) => n === target && marked.add(i));
	return marked;
}

/** The page's elements laid out from `origin`, top left. */
export function pageToElements(spec: IPageSpec, origin: readonly [number, number], options: IPageOptions = {}): ScratchElement[] {
	const style = options.style ?? AGENT_DIAGRAM_STYLE;
	const measure = options.measure ?? estimateWidth;
	const elements: IScratchTextElement[] = [];
	const [x0, y0] = origin;

	// The lines break where they were measured to: left-aligned text hugs them and never wraps again
	// (the board's own measure can land a hair wider and would wrap a line, cutting off the last one).
	// `width` is the column a centred text sits in; left-aligned text takes its lines' width.
	const put = (x: number, y: number, width: number, lines: readonly string[], fontSize: number, color: string, align: ScratchTextAlign = 'left'): number => {
		const height = Math.ceil(Math.max(1, lines.length) * fontSize * LINE);
		const hug = align === 'left';
		elements.push(createText({
			x, y, width: Math.ceil(hug ? Math.max(...lines.map(line => measure(line, fontSize))) + 4 : width), height,
			html: `<p>${lines.map(escapeHtml).join('<br>')}</p>`,
			autoSize: hug,
			fontFamily: 'hand',
			fontSize,
			textAlign: align,
			stroke: color,
		}, style));
		return height;
	};

	// The table decides the page's width; text above and below wraps to it.
	const table = spec.table;
	let labelWidth = 0;
	let columnWidths: number[] = [];
	if (table) {
		labelWidth = Math.min(LABEL_MAX, Math.max(0, ...table.rows.map(r => measure(r.label, LABEL_SIZE))));
		columnWidths = table.columns.map((column, c) => Math.max(VALUE_MIN, VALUE_PAD + Math.max(
			measure(column.label, HEADER_SIZE),
			...table.rows.map(r => r.cells[c] ? measure(r.cells[c].text, VALUE_SIZE) : 0),
		)));
	}
	const tableWidth = table ? labelWidth + (labelWidth ? LABEL_GAP : 0) + columnWidths.reduce((a, b) => a + b, 0) : 0;
	const pageWidth = Math.max(PAGE_MIN, tableWidth);
	let y = y0;
	if (spec.heading) {
		y += put(x0, y, 0, wrap(spec.heading, HEADING_SIZE, pageWidth, measure), HEADING_SIZE, INK);
		y += spec.subtitle ? 10 : 48;
	}
	if (spec.subtitle) {
		y += put(x0, y, 0, wrap(spec.subtitle, SUBTITLE_SIZE, pageWidth, measure), SUBTITLE_SIZE, MUTED);
		y += 44;
	}
	if (table) {
		const valuesX = x0 + labelWidth + (labelWidth ? LABEL_GAP : 0);
		const columnX = columnWidths.map((_, c) => valuesX + columnWidths.slice(0, c).reduce((a, b) => a + b, 0));
		if (table.columns.some(c => c.label)) {
			let headerHeight = 0;
			table.columns.forEach((column, c) => {
				if (column.label) {
					headerHeight = Math.max(headerHeight, put(columnX[c], y, columnWidths[c], wrap(column.label, HEADER_SIZE, columnWidths[c] - 16, measure), HEADER_SIZE, column.color ?? INK, 'center'));
				}
			});
			y += headerHeight + ROW_GAP + 8;
		}
		for (const row of table.rows) {
			const best = bestCells(row);
			let rowHeight = 0;
			if (row.label) {
				rowHeight = put(x0, y, 0, wrap(row.label, LABEL_SIZE, labelWidth, measure), LABEL_SIZE, MUTED);
			}
			row.cells.forEach((cell, c) => {
				if (cell.text) {
					const color = cell.color ?? (best.has(c) ? PAGE_BEST_COLOR : INK);
					rowHeight = Math.max(rowHeight, put(columnX[c], y, columnWidths[c], wrap(cell.text, VALUE_SIZE, columnWidths[c] - 16, measure), VALUE_SIZE, color, 'center'));
				}
			});
			y += Math.max(rowHeight, Math.ceil(VALUE_SIZE * LINE)) + ROW_GAP;
		}
		y += 6;
	}
	if (spec.footnote) {
		y += put(x0, y, 0, wrap(spec.footnote, FOOTNOTE_SIZE, pageWidth, measure), FOOTNOTE_SIZE, MUTED);
		y += 40;
	}
	for (const bullet of spec.bullets) {
		y += put(x0, y, 0, wrap(`• ${bullet}`, BULLET_SIZE, pageWidth, measure), BULLET_SIZE, MUTED);
		y += 8;
	}
	return elements;
}

/** One line for the tool's result: "a table of 11 rows and 3 columns, 3 bullets". */
export function describePage(spec: IPageSpec): string {
	return [
		spec.table ? `a table of ${spec.table.rows.length} rows and ${spec.table.columns.length} columns` : '',
		spec.bullets.length ? `${spec.bullets.length} bullets` : '',
		spec.footnote ? 'a footnote' : '',
	].filter(Boolean).join(', ');
}
