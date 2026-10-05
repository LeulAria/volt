/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Answer presentation. The model's Markdown is drawn as written: prose, lists, and
 * headings stay Markdown, the way the model chose to structure them. Only structure the
 * model spelled out gets its own view: fenced code, Markdown tables, and the opt-in
 * `mermaid`, `chart`, and `output` fences.
 */

export type OutputKind = 'table' | 'list' | 'cards' | 'chart' | 'code' | 'mermaid' | 'text';

export type OutputView =
	| { readonly kind: 'text'; readonly markdown: string }
	| { readonly kind: 'table'; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly caption?: string }
	| { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
	| { readonly kind: 'cards'; readonly items: readonly OutputCard[] }
	| { readonly kind: 'chart'; readonly labels: readonly string[]; readonly values: readonly number[]; readonly unit?: string; readonly title?: string }
	| { readonly kind: 'code'; readonly language?: string; readonly code: string; readonly closed?: boolean }
	| { readonly kind: 'mermaid'; readonly source: string; readonly closed?: boolean };

export interface OutputCard {
	readonly title: string;
	readonly body: string;
	readonly meta?: string;
}

/** Any info string without backticks (CommonMark), including Cursor's code citations: ```12:40:src/app.ts */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*([^\s`]*)(?:\s+([^`]*))?$/;
const TABLE_LINE_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
/**
 * Split assistant text into presentation views. Later views win over surrounding prose:
 * a ranking list becomes a table even when the model wrote it as `1. Name - 123`.
 */
export function presentOutput(text: string, options?: { readonly tables?: boolean }): OutputView[] {
	try {
		return layoutOutput(text, options?.tables !== false);
	} catch {
		const markdown = text.trim();
		return markdown ? [{ kind: 'text', markdown }] : [];
	}
}

function layoutOutput(text: string, tables: boolean): OutputView[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const views: OutputView[] = [];
	let markdown: string[] = [];
	let i = 0;

	const flushMarkdown = () => {
		const content = markdown.join('\n').trim();
		markdown = [];
		if (content) {
			views.push({ kind: 'text', markdown: content });
		}
	};

	while (i < lines.length) {
		const fence = parseFenceLine(lines[i]);
		if (fence) {
			flushMarkdown();
			const body: string[] = [];
			if (fence.rest) {
				body.push(fence.rest);
			}
			i++;
			let closed = false;
			while (i < lines.length) {
				const close = parseFenceLine(lines[i]);
				if (close && close.marker[0] === fence.marker[0] && close.marker.length >= fence.marker.length && !close.language && !close.rest) {
					closed = true;
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			views.push(viewFromFence(fence.language || undefined, body.join('\n'), closed));
			continue;
		}

		if (tables && TABLE_LINE_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
			flushMarkdown();
			const tableLines = [lines[i], lines[i + 1]];
			i += 2;
			while (i < lines.length && TABLE_LINE_RE.test(lines[i])) {
				tableLines.push(lines[i]);
				i++;
			}
			const table = parseMarkdownTable(tableLines);
			if (table) {
				views.push({ kind: 'table', headers: table.headers, rows: table.rows });
			}
			continue;
		}

		markdown.push(lines[i]);
		i++;
	}

	flushMarkdown();
	return views;
}

export function outputPlainText(views: readonly OutputView[]): string {
	return views.map(view => {
		switch (view.kind) {
			case 'text':
				return view.markdown;
			case 'table':
				return [view.headers.join(' | '), ...view.rows.map(row => row.join(' | '))].join('\n');
			case 'list':
				return view.items.map((item, index) => view.ordered ? `${index + 1}. ${item}` : `- ${item}`).join('\n');
			case 'cards':
				return view.items.map(card => [card.title, card.body, card.meta].filter(Boolean).join('\n')).join('\n\n');
			case 'chart':
				return view.labels.map((label, index) => `${label}: ${view.values[index]}`).join('\n');
			case 'code':
				return view.code;
			case 'mermaid':
				return view.source;
		}
	}).filter(Boolean).join('\n\n');
}

function viewFromFence(language: string | undefined, body: string, closed: boolean): OutputView {
	const lang = language?.toLowerCase();
	if (lang === 'mermaid') {
		return { kind: 'mermaid', source: body, closed };
	}
	if (lang === 'chart') {
		const chart = parseChartSource(body);
		if (chart) {
			return chart;
		}
	}
	if (lang === 'output') {
		const structured = parseStructuredJson(body);
		if (structured) {
			return structured;
		}
	}
	return { kind: 'code', language, code: body, closed };
}

function parseFenceLine(line: string): { marker: string; language: string; rest: string } | undefined {
	const match = line.match(FENCE_OPEN_RE);
	if (!match) {
		return undefined;
	}
	return { marker: match[1], language: match[2] || '', rest: (match[3] || '').trim() };
}

function parseStructuredJson(text: string): OutputView | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return structuredFromUnknown(parsed);
	} catch {
		return undefined;
	}
}

function structuredFromUnknown(value: unknown): OutputView | undefined {
	if (Array.isArray(value)) {
		return tableFromObjectRows(value) ?? chartFromPairs(value);
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const rec = value as Record<string, unknown>;
	if (rec.table && typeof rec.table === 'object') {
		return structuredFromUnknown(rec.table);
	}
	const kind = typeof rec.kind === 'string' ? rec.kind : undefined;
	if (kind === 'table' || (Array.isArray(rec.headers) && Array.isArray(rec.rows))) {
		const headers = asStringArray(rec.headers);
		const rows = asRowArray(rec.rows, headers?.length);
		if (headers?.length && rows?.length) {
			return { kind: 'table', headers, rows, ...(typeof rec.caption === 'string' ? { caption: rec.caption } : {}) };
		}
	}
	if (kind === 'chart' || (Array.isArray(rec.labels) && Array.isArray(rec.values))) {
		const labels = asStringArray(rec.labels);
		const values = asNumberArray(rec.values);
		if (labels?.length && values && labels.length === values.length && labels.length >= 2) {
			return {
				kind: 'chart',
				labels,
				values,
				...(typeof rec.unit === 'string' ? { unit: rec.unit } : {}),
				...(typeof rec.title === 'string' ? { title: rec.title } : {}),
			};
		}
	}
	if (kind === 'cards' && Array.isArray(rec.items)) {
		const items = rec.items.map(asCard).filter((card): card is OutputCard => !!card);
		if (items.length >= 2) {
			return { kind: 'cards', items };
		}
	}
	if (kind === 'list' && Array.isArray(rec.items)) {
		const items = asStringArray(rec.items);
		if (items?.length) {
			return { kind: 'list', ordered: rec.ordered === true, items };
		}
	}
	if (kind === 'mermaid' && typeof rec.source === 'string') {
		return { kind: 'mermaid', source: rec.source, closed: true };
	}
	return tableFromObjectRows([rec]);
}

function tableFromObjectRows(values: readonly unknown[]): OutputView | undefined {
	const rows = values.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
	if (rows.length < 2) {
		return undefined;
	}
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
	}
	if (keys.length < 2) {
		return undefined;
	}
	return {
		kind: 'table',
		headers: keys.map(humanizeHeader),
		rows: rows.map(row => keys.map(key => stringifyCell(row[key]))),
	};
}

function chartFromPairs(values: readonly unknown[]): OutputView | undefined {
	const pairs: Array<{ label: string; value: number }> = [];
	for (const item of values) {
		if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string' && Number.isFinite(Number(item[1]))) {
			pairs.push({ label: item[0], value: Number(item[1]) });
			continue;
		}
		if (item && typeof item === 'object') {
			const rec = item as Record<string, unknown>;
			const label = typeof rec.label === 'string' ? rec.label : typeof rec.name === 'string' ? rec.name : undefined;
			const value = Number(rec.value ?? rec.y ?? rec.count);
			if (label && Number.isFinite(value)) {
				pairs.push({ label, value });
			}
		}
	}
	if (pairs.length < 3 || !looksLikeChart(pairs.map(pair => pair.value))) {
		return undefined;
	}
	return { kind: 'chart', labels: pairs.map(pair => pair.label), values: pairs.map(pair => pair.value) };
}

function asCard(value: unknown): OutputCard | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const rec = value as Record<string, unknown>;
	const title = typeof rec.title === 'string' ? rec.title : typeof rec.name === 'string' ? rec.name : undefined;
	const body = typeof rec.body === 'string' ? rec.body : typeof rec.text === 'string' ? rec.text : typeof rec.description === 'string' ? rec.description : undefined;
	if (!title || !body) {
		return undefined;
	}
	return { title, body, ...(typeof rec.meta === 'string' ? { meta: rec.meta } : {}) };
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = value.map(item => typeof item === 'string' ? item : stringifyCell(item));
	return items.length ? items : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = value.map(item => Number(item));
	return items.every(Number.isFinite) ? items : undefined;
}

function asRowArray(value: unknown, width?: number): string[][] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const rows = value.map(row => {
		if (!Array.isArray(row)) {
			return [stringifyCell(row)];
		}
		const cells = row.map(cell => stringifyCell(cell));
		if (width) {
			while (cells.length < width) {
				cells.push('');
			}
			return cells.slice(0, width);
		}
		return cells;
	});
	return rows.length ? rows : undefined;
}

function stringifyCell(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function humanizeHeader(key: string): string {
	const spaced = key.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
	if (!spaced) {
		return key;
	}
	return spaced.replace(/\b\w/g, ch => ch.toUpperCase());
}

function parseMarkdownTable(lines: readonly string[]): { headers: string[]; rows: string[][] } | undefined {
	if (lines.length < 2) {
		return undefined;
	}
	const split = (line: string) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim());
	const headers = split(lines[0]);
	const rows = lines.slice(2).filter(line => line.trim()).map(split).map(row => {
		while (row.length < headers.length) {
			row.push('');
		}
		return row.slice(0, headers.length);
	});
	for (let col = headers.length - 1; col >= 0; col--) {
		if (!headers[col] && rows.every(row => !row[col])) {
			headers.splice(col, 1);
			for (const row of rows) {
				row.splice(col, 1);
			}
		}
	}
	return headers.length ? { headers, rows } : undefined;
}

function parseChartSource(text: string): OutputView | undefined {
	const structured = parseStructuredJson(text);
	if (structured?.kind === 'chart' || structured?.kind === 'table') {
		return structured.kind === 'table' ? promoteNumericTable(structured) : structured;
	}
	const labels: string[] = [];
	const values: number[] = [];
	let title: string | undefined;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const titled = /^title\s*:\s*(.+)$/i.exec(line);
		if (titled) {
			title = titled[1].trim();
			continue;
		}
		const cells = line.split(/[,\t|:]+/).map(cell => cell.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		if (cells.length < 2) {
			continue;
		}
		const value = parseNumeric(cells[cells.length - 1]);
		if (value === undefined) {
			continue;
		}
		labels.push(cells.slice(0, -1).join(', '));
		values.push(value);
	}
	if (labels.length < 2) {
		return undefined;
	}
	return { kind: 'chart', labels, values, ...(title ? { title } : {}) };
}

function promoteNumericTable(view: Extract<OutputView, { kind: 'table' }>): OutputView {
	if (view.headers.length !== 2 || view.rows.length < 3) {
		return view;
	}
	const values = view.rows.map(row => parseNumeric(row[1]));
	if (values.some(value => value === undefined) || !looksLikeChart(values as number[])) {
		return view;
	}
	return {
		kind: 'chart',
		labels: view.rows.map(row => row[0]),
		values: values as number[],
		title: view.headers[1],
	};
}

function looksLikeChart(values: readonly number[]): boolean {
	if (values.length < 3 || values.every(value => value === values[0])) {
		return false;
	}
	const sum = values.reduce((a, b) => a + b, 0);
	if (sum <= 0) {
		return false;
	}
	const percents = values.every(value => value >= 0 && value <= 100) && Math.abs(sum - 100) <= 6;
	const shares = values.every(value => value >= 0) && values.some(value => value <= 1) && Math.abs(sum - 1) <= 0.08;
	return percents || shares;
}

function parseNumeric(value: string): number | undefined {
	const raw = value.replace(/[$\u20ac\u00a3\u00a5,\s]/g, '').replace(/%$/, '').replace(/^(AED|USD|EUR|GBP|INR)/i, '');
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}
