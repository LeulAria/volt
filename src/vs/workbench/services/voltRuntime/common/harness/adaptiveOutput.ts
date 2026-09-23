/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adaptive answer presentation. The model writes prose; this module decides how the
 * workbench should draw it. Rankings, comparisons, prices, specs, and other
 * side-by-side rows become tables, including a name with a written note.
 * The LLM is not asked to emit a particular widget.
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

const FENCE_OPEN_RE = /^(`{3,}|~{3,})([A-Za-z0-9_+-]*)(?:\s+(.*))?$/;
const TABLE_LINE_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const LIST_ITEM_RE = /^\s*(?:([-*•])|(\d+)[.)])\s+(\S.*)$/;
const NUMBER_RE = /^(?:[$\u20ac\u00a3\u00a5]\s*)?-?\d{1,3}(?:[,\s\u00a0\u202f']\d{3})+(?:\.\d+)?%?$|^(?:[$\u20ac\u00a3\u00a5]\s*)?-?\d+(?:\.\d+)?%?$|^(?:AED|USD|EUR|GBP|INR)\s*-?\d[\d,\s]*(?:\.\d+)?$|^-?\d+(?:\.\d+)?\s*(?:billion|million|thousand|bn|m|k|b|%)$/i;
const VALUE_TAIL_RE = /((?:[$\u20ac\u00a3\u00a5]|AED|USD|EUR|GBP|INR)?\s*-?\d{1,3}(?:[,\s\u00a0\u202f']\d{3})+(?:\.\d+)?%?|(?:[$\u20ac\u00a3\u00a5]|AED|USD|EUR|GBP|INR)\s*-?\d[\d,\s]*(?:\.\d+)?%?|-?\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*(?:billion|million|thousand|bn|m|k)\b)\s*$/i;
const SIZE_RE = /^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|K|M|G)\s*$/i;
const STEP_VERB_RE = /^(read|open|add|run|create|fix|update|edit|write|install|check|verify|start|stop|move|delete|remove|copy|paste|click|select|set|use|make|ensure|go|then|first|next|finally|after)\b/i;
const CARD_HEADING_RE = /^(#{2,4})\s+(\S.*)$/;
const BOLD_TITLE_RE = /^\*\*([^*]+)\*\*(?:\s*[\u2014\u2013:\-]\s*|\s+)(\S.*)$/;
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

const ENTITY_HEADERS: Array<{ readonly pattern: RegExp; readonly header: string }> = [
	{ pattern: /\bcountr(?:y|ies)\b/i, header: 'Country' },
	{ pattern: /\bmodels?\b/i, header: 'Model' },
	{ pattern: /\bfiles?\b/i, header: 'File' },
	{ pattern: /\bpackages?\b/i, header: 'Package' },
	{ pattern: /\bcompanies?\b|\bfirms?\b/i, header: 'Company' },
	{ pattern: /\bcities\b|\bcity\b/i, header: 'City' },
	{ pattern: /\blanguages?\b/i, header: 'Language' },
];

const VALUE_HEADERS: Array<{ readonly pattern: RegExp; readonly header: string }> = [
	{ pattern: /\bpopulation|populated|inhabitants|people\b/i, header: 'Population' },
	{ pattern: /\bpric(?:e|ing)|cost|costs|aed|usd|eur\b/i, header: 'Price' },
	{ pattern: /\bsize|bytes|disk\b/i, header: 'Size' },
	{ pattern: /\bscore|rating|rank(?:ing)?\b/i, header: 'Score' },
	{ pattern: /\bspec(?:s|ification)?\b/i, header: 'Spec' },
	{ pattern: /\bshare|percent|%\b/i, header: 'Share' },
	{ pattern: /\bcount|total|amount\b/i, header: 'Count' },
];

/**
 * Split assistant text into presentation views. Later views win over surrounding prose:
 * a ranking list becomes a table even when the model wrote it as `1. Name - 123`.
 */
export function presentOutput(text: string): OutputView[] {
	try {
		return layoutOutput(text);
	} catch {
		const markdown = text.trim();
		return markdown ? [{ kind: 'text', markdown }] : [];
	}
}

function layoutOutput(text: string): OutputView[] {
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

		if (TABLE_LINE_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
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

		const jsonBlock = readJsonBlock(lines, i);
		if (jsonBlock) {
			flushMarkdown();
			views.push(jsonBlock.view);
			i = jsonBlock.end;
			continue;
		}

		const structured = readStructuredList(lines, i, lastMarkdown(markdown, views));
		if (structured) {
			flushMarkdown();
			views.push(structured.view);
			i = structured.end;
			continue;
		}

		const records = readRankRecords(lines, i, lastMarkdown(markdown, views));
		if (records) {
			flushMarkdown();
			views.push(records.view);
			i = records.end;
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
	if (lang === 'json' || lang === 'output') {
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

function lastMarkdown(buffer: readonly string[], views: readonly OutputView[]): string {
	const pending = buffer.join('\n').trim();
	if (pending) {
		return pending;
	}
	for (let i = views.length - 1; i >= 0; i--) {
		const view = views[i];
		if (view.kind === 'text') {
			return view.markdown;
		}
	}
	return '';
}

function readJsonBlock(lines: readonly string[], start: number): { view: OutputView; end: number } | undefined {
	const trimmed = lines[start]?.trim() ?? '';
	if (trimmed[0] !== '{' && trimmed[0] !== '[') {
		return undefined;
	}
	const chunk: string[] = [];
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < lines.length; i++) {
		chunk.push(lines[i]);
		for (const ch of lines[i]) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\' && inString) {
				escape = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) {
				continue;
			}
			if (ch === '{' || ch === '[') {
				depth++;
			} else if (ch === '}' || ch === ']') {
				depth--;
			}
		}
		if (depth === 0 && chunk.join('\n').trim().length > 1) {
			const view = parseStructuredJson(chunk.join('\n'));
			if (!view) {
				return undefined;
			}
			return { view, end: i + 1 };
		}
		if (depth < 0) {
			return undefined;
		}
	}
	return undefined;
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

function readStructuredList(lines: readonly string[], start: number, context: string): { view: OutputView; end: number } | undefined {
	const cards = readCardGroup(lines, start);
	if (cards) {
		return cards;
	}
	const items = readListItems(lines, start);
	if (!items) {
		return undefined;
	}
	const comparable = comparableTable(items.entries, context);
	if (comparable) {
		return { view: comparable, end: items.end };
	}
	if (items.entries.length >= 2 && items.entries.every(entry => entry.body.length < 80 && !STEP_VERB_RE.test(entry.body))) {
		return { view: { kind: 'list', ordered: items.ordered, items: items.entries.map(entry => entry.body) }, end: items.end };
	}
	return undefined;
}

function readListItems(lines: readonly string[], start: number): { ordered: boolean; entries: Array<{ marker: string; body: string }>; end: number } | undefined {
	const first = LIST_ITEM_RE.exec(lines[start] ?? '');
	if (!first) {
		return undefined;
	}
	const ordered = !!first[2];
	const entries: Array<{ marker: string; body: string }> = [];
	let i = start;
	while (i < lines.length) {
		if (!lines[i].trim()) {
			if (i + 1 < lines.length && LIST_ITEM_RE.test(lines[i + 1])) {
				i++;
				continue;
			}
			break;
		}
		const match = LIST_ITEM_RE.exec(lines[i]);
		if (!match || !!match[2] !== ordered) {
			break;
		}
		let body = match[3];
		i++;
		while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM_RE.test(lines[i])) {
			body += ` ${lines[i].trim()}`;
			i++;
		}
		entries.push({ marker: match[2] || match[1], body: stripItemMarkup(body) });
	}
	return entries.length >= 2 ? { ordered, entries, end: i } : undefined;
}

/**
 * Turn ranking/price/spec list items into a table. Used by the harness walker and
 * by the markdown renderer, so a numbered list still becomes a table even if the
 * model never emitted pipes.
 */
export function tableFromListItems(items: readonly string[], context = '', ordered = false): Extract<OutputView, { kind: 'table' }> | undefined {
	if (items.length < 2) {
		return undefined;
	}
	const parsed = items.map(item => parseComparableItem(item));
	const records = parsed.filter((item): item is { label: string; values: string[] } => !!item);
	if (records.length < 2 || records.length < Math.ceil(items.length * 0.6)) {
		return undefined;
	}
	const width = records[0].values.length;
	if (width < 1 || records.some(item => item.values.length !== width)) {
		return undefined;
	}
	const comparableColumns = Array.from({ length: width }, (_, col) => records.filter(item => isComparableValue(item.values[col])).length);
	const numericTable = comparableColumns.some(count => count === records.length || (records.length >= 3 && count >= Math.ceil(records.length * 0.7)));
	const attributeTable = !numericTable && width === 1 && records.length >= 3 && records.length === items.length && records.every(item => isEntityLabel(item.label));
	if (!numericTable && !attributeTable) {
		return undefined;
	}
	if (records.every(item => STEP_VERB_RE.test(item.label) || /[.!?].+\s/.test(item.label))) {
		return undefined;
	}
	const numbered = ordered || items.every(item => /^\s*\d+[.)]\s+\S/.test(item));
	const headers = inferHeaders(context, records, numbered);
	const rows = parsed.map((item, index) => {
		if (!item) {
			return undefined;
		}
		return numbered ? [String(index + 1), item.label, ...item.values] : [item.label, ...item.values];
	}).filter((row): row is string[] => !!row);
	return rows.length >= 2 ? { kind: 'table', headers, rows } : undefined;
}

function comparableTable(entries: readonly { marker: string; body: string }[], context: string): Extract<OutputView, { kind: 'table' }> | undefined {
	return tableFromListItems(entries.map(entry => entry.body), context, entries.every(entry => /^\d+$/.test(entry.marker)));
}

function parseComparableItem(body: string): { label: string; values: string[] } | undefined {
	const bold = BOLD_TITLE_RE.exec(body);
	const stripped = stripLeadingIndex(bold ? `${bold[1]} \u2014 ${bold[2]}` : body);
	const text = normalizeSeparators(stripped);
	const split = /^(.*?)\s*(?:\u2014+|[:|])\s+(.+)$/.exec(text) ?? /^(.*?)\s+-{1,3}\s+(.+)$/.exec(text);
	if (split) {
		const label = split[1].replace(/^\*+|\*+$/g, '').trim();
		const rest = split[2].trim();
		const parts = rest.split(/\s*(?:\u2014+|[:|])\s+/).map(part => part.trim()).filter(Boolean);
		if (label && label.length <= 80 && parts.length >= 1 && parts.length <= 4 && parts.every(isComparableValue)) {
			return { label, values: parts };
		}
		if (isEntityLabel(label) && rest.length >= 2 && rest.length <= 280) {
			return { label, values: [rest] };
		}
	}
	const tail = VALUE_TAIL_RE.exec(text);
	if (tail && tail.index && tail.index > 0) {
		const label = text.slice(0, tail.index).replace(/[\s\u2014\-:|]+$/g, '').replace(/^\*+|\*+$/g, '').trim();
		const value = tail[1].trim();
		if (label && label.length <= 80 && isComparableValue(value) && !STEP_VERB_RE.test(label)) {
			return { label, values: [value] };
		}
	}
	return undefined;
}

function normalizeSeparators(value: string): string {
	return value
		.replace(/&mdash;|&ndash;|&#0*821[12];|&#x201[34];/gi, '\u2014')
		.replace(DASH_RE, '\u2014')
		.replace(/\s+/g, ' ')
		.trim();
}

function stripLeadingIndex(value: string): string {
	return value.replace(/^\s*\d+[.)]\s+/, '').trim();
}

const LEAD_IN_RE = /^(?:i|we|you|it|they|he|she|the|a|an|this|that|these|those|there|here|so|and|but|if|when|while|because|then)\b/i;
const RECORD_LINE_RE = /^([A-Z][^()\n]{1,72}?)\s+\(([^)\n]{2,80})\):\s+(\S(?:.*\S)?)\s*$/;
const RANK_STOP_RE = /^(?:the|a|an|and|or|it|to|for|of|with|that|this|these|those|then|check|pass|use|call|read|open|run|add(?:ed)?|fix(?:ed)?|updat(?:e|ed)|remov(?:e|ed)|chang(?:e|ed)|made|using|return|returns|see)\b/i;

/**
 * A row label is a name, not a sentence or an instruction.
 * "Go" is also a step verb, so that single word stays a name.
 */
function isEntityLabel(label: string): boolean {
	const text = label.replace(/^[`*_]+|[`*_]+$/g, '').trim();
	if (!text || text.length > 48) {
		return false;
	}
	if (/[.!?]/.test(text) && !/^[A-Za-z0-9#+]+\.[A-Za-z0-9]{1,8}$/.test(text)) {
		return false;
	}
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0 || words.length > 5) {
		return false;
	}
	if (LEAD_IN_RE.test(text)) {
		return false;
	}
	if (STEP_VERB_RE.test(text) && text.toLowerCase() !== 'go') {
		return false;
	}
	return true;
}

function readRankRecords(lines: readonly string[], start: number, context: string): { view: OutputView; end: number } | undefined {
	const first = matchRankRecord(lines[start] ?? '');
	if (!first) {
		return undefined;
	}
	const rows: Array<{ source: string; measure: string; ranking: string }> = [];
	let i = start;
	while (i < lines.length) {
		if (!lines[i].trim()) {
			let j = i + 1;
			while (j < lines.length && !lines[j].trim()) {
				j++;
			}
			if (j < lines.length && matchRankRecord(lines[j])) {
				i = j;
				continue;
			}
			break;
		}
		const record = matchRankRecord(lines[i]);
		if (!record) {
			break;
		}
		let ranking = record.ranking;
		let closed = /[.]\s*$/.test(lines[i].trim());
		while (!closed && i + 1 < lines.length && isRankingContinuation(lines[i + 1])) {
			i++;
			ranking = `${ranking} ${lines[i].trim()}`;
			closed = /[.]\s*$/.test(lines[i].trim());
		}
		rows.push({ source: record.source, measure: record.measure, ranking: cleanRanking(ranking) });
		i++;
	}
	if (rows.length < 3) {
		return undefined;
	}
	const source = /\bindex(?:es)?\b/i.test(context) ? 'Index' : 'Source';
	const share = rows.every(row => row.ranking.split(',').every(part => /\d+(?:\.\d+)?%/.test(part)));
	return {
		view: {
			kind: 'table',
			headers: [source, 'Measure', share ? 'Share' : 'Ranking'],
			rows: rows.map(row => [row.source, row.measure, row.ranking]),
		},
		end: i,
	};
}

function matchRankRecord(line: string): { source: string; measure: string; ranking: string } | undefined {
	const match = RECORD_LINE_RE.exec(line.trim());
	if (!match) {
		return undefined;
	}
	const source = match[1].trim().replace(/[,:;]\s*$/, '');
	const measure = match[2].trim();
	const ranking = cleanRanking(match[3]);
	if (!source || STEP_VERB_RE.test(source) || LEAD_IN_RE.test(source)) {
		return undefined;
	}
	if (!/\b(?:19|20)\d{2}\b/.test(`${source} ${measure}`)) {
		return undefined;
	}
	if (!looksLikeRanking(ranking)) {
		return undefined;
	}
	return { source, measure, ranking };
}

function looksLikeRanking(value: string): boolean {
	const parts = value.split(',').map(part => part.trim()).filter(Boolean);
	if (parts.length < 3) {
		return false;
	}
	const nameLike = parts.filter(part => part.length <= 40 && part.split(/\s+/).length <= 6 && !RANK_STOP_RE.test(part));
	return nameLike.length >= Math.ceil(parts.length * 0.8);
}

function isRankingContinuation(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed || matchRankRecord(line) || LIST_ITEM_RE.test(trimmed) || parseFenceLine(trimmed)) {
		return false;
	}
	return /^[\d.%]/.test(trimmed) || /^[a-z(]/.test(trimmed);
}

function cleanRanking(value: string): string {
	return value.replace(/\s+/g, ' ').replace(/[.]+\s*$/, '').trim();
}

function isComparableValue(value: string): boolean {
	const raw = value.replace(/^[`*_]+|[`*_]+$/g, '').trim();
	if (!raw || raw.length > 48) {
		return false;
	}
	return NUMBER_RE.test(raw) || SIZE_RE.test(raw) || /^(?:yes|no|n\/a|true|false|low|mid|high|pass|fail)$/i.test(raw) || /^[A-Z]{1,6}\s?-?\d[\d.,]*$/.test(raw);
}

function inferHeaders(context: string, items: readonly { label: string; values: string[] }[], numbered: boolean): string[] {
	const name = ENTITY_HEADERS.find(entry => entry.pattern.test(context))?.header ?? 'Name';
	const headers = numbered ? ['Rank', name] : [name];
	for (let col = 0; col < items[0].values.length; col++) {
		const samples = items.map(item => item.values[col]);
		headers.push(valueHeader(context, samples, col, items[0].values.length));
	}
	return headers;
}

function valueHeader(context: string, samples: readonly string[], index: number, total: number): string {
	const fromContext = VALUE_HEADERS.find(entry => entry.pattern.test(context));
	if (fromContext && comparableCount(samples) === samples.length && (total === 1 || index === 0)) {
		return fromContext.header;
	}
	if (samples.every(sample => SIZE_RE.test(sample))) {
		return 'Size';
	}
	if (samples.every(sample => /%/.test(sample))) {
		return 'Share';
	}
	if (samples.every(sample => /[$\u20ac\u00a3\u00a5]|AED|USD|EUR|GBP|INR/i.test(sample))) {
		return 'Price';
	}
	if (comparableCount(samples) === samples.length && samples.every(sample => NUMBER_RE.test(sample))) {
		return total === 1 ? (fromContext?.header ?? 'Value') : `Value ${index + 1}`;
	}
	if (comparableCount(samples) === 0) {
		return 'Notes';
	}
	return total === 1 ? 'Value' : `Value ${index + 1}`;
}

function comparableCount(samples: readonly string[]): number {
	return samples.filter(sample => isComparableValue(sample)).length;
}

function readCardGroup(lines: readonly string[], start: number): { view: OutputView; end: number } | undefined {
	const heading = CARD_HEADING_RE.exec(lines[start] ?? '');
	if (!heading) {
		return undefined;
	}
	const level = heading[1];
	const items: OutputCard[] = [];
	let i = start;
	while (i < lines.length) {
		const next = CARD_HEADING_RE.exec(lines[i] ?? '');
		if (!next || next[1] !== level) {
			break;
		}
		const title = next[2].trim();
		i++;
		const body: string[] = [];
		while (i < lines.length && lines[i].trim() && !CARD_HEADING_RE.test(lines[i]) && !TABLE_LINE_RE.test(lines[i]) && !parseFenceLine(lines[i])) {
			body.push(lines[i]);
			i++;
		}
		while (i < lines.length && !lines[i].trim()) {
			if (i + 1 < lines.length && CARD_HEADING_RE.test(lines[i + 1])) {
				i++;
				break;
			}
			if (i + 1 < lines.length && lines[i + 1].trim()) {
				break;
			}
			i++;
		}
		const joined = body.join('\n').trim();
		if (!joined || joined.length < 20 || joined.length > 400 || title.length > 56) {
			return undefined;
		}
		items.push({ title, body: joined });
	}
	if (items.length < 2 || items.length > 8) {
		return undefined;
	}
	if (items.every(item => item.body.length < 40 && parseComparableItem(`${item.title} \u2014 ${item.body}`))) {
		return undefined;
	}
	return { view: { kind: 'cards', items }, end: i };
}

function stripItemMarkup(value: string): string {
	return value.replace(/\s+/g, ' ').replace(/^\*\*|\*\*$/g, '').trim();
}

function parseNumeric(value: string): number | undefined {
	const raw = value.replace(/[$\u20ac\u00a3\u00a5,\s]/g, '').replace(/%$/, '').replace(/^(AED|USD|EUR|GBP|INR)/i, '');
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}
