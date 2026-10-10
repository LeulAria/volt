/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front matter of skills, rules, subagents and commands as an ordered list of properties, read
 * and written back without disturbing the rest of the file. Enough YAML for these headers:
 * scalars (plain or quoted), folded and literal blocks (`>-`, `|`), inline and dash lists.
 * Anything else is kept verbatim.
 */

export interface IFrontmatterEntry {
	readonly key: string;
	/** The value as text: a list reads as comma-separated items, a block as its joined lines. */
	readonly value: string;
	/** How it was written, so an unedited entry is written back as it was. */
	readonly style: 'plain' | 'quoted' | 'block' | 'list' | 'raw';
	/** Source lines of the entry, for entries written back untouched. */
	readonly lines: readonly string[];
}

export interface IFrontmatterDocument {
	readonly hasFrontmatter: boolean;
	readonly entries: readonly IFrontmatterEntry[];
	/** Everything after the closing `---` line, as written. */
	readonly body: string;
	/** Line break used by the file. */
	readonly eol: '\n' | '\r\n';
}

const FENCE = /^---\s*$/;
const KEY_LINE = /^([A-Za-z_][\w.-]*)\s*:(.*)$/;

export function parseFrontmatterDocument(text: string): IFrontmatterDocument {
	const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
	const source = text.replace(/^\uFEFF/, '');
	const lines = source.split(/\r?\n/);
	if (!lines.length || !FENCE.test(lines[0])) {
		return { hasFrontmatter: false, entries: [], body: source, eol };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (FENCE.test(lines[i])) {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { hasFrontmatter: false, entries: [], body: source, eol };
	}
	const entries: IFrontmatterEntry[] = [];
	let i = 1;
	while (i < end) {
		const line = lines[i];
		const match = KEY_LINE.exec(line);
		if (!match) {
			// A comment, a blank line or something this parser does not model: keep it on the previous entry.
			const previous = entries.pop();
			if (previous) {
				entries.push({ ...previous, style: previous.style === 'plain' || previous.style === 'quoted' ? 'raw' : previous.style, lines: [...previous.lines, line] });
			} else if (line.trim()) {
				entries.push({ key: '', value: line, style: 'raw', lines: [line] });
			}
			i++;
			continue;
		}
		const key = match[1];
		const rest = match[2].trim();
		const own = [line];
		let j = i + 1;
		while (j < end && (/^\s+\S/.test(lines[j]) || (!lines[j].trim() && j + 1 < end && /^\s+\S/.test(lines[j + 1])))) {
			own.push(lines[j]);
			j++;
		}
		const continuation = own.slice(1);
		if (/^[>|][+-]?\d*$/.test(rest)) {
			const folded = rest.startsWith('>');
			const content = dedent(continuation);
			const value = folded ? foldLines(content) : content.join('\n');
			entries.push({ key, value: value.trim(), style: 'block', lines: own });
		} else if (!rest && continuation.length && continuation.every(item => /^\s*-\s/.test(item) || !item.trim())) {
			const items = continuation.filter(item => item.trim()).map(item => unquote(item.replace(/^\s*-\s*/, '').trim()));
			entries.push({ key, value: items.join(', '), style: 'list', lines: own });
		} else if (rest.startsWith('[') && rest.endsWith(']') && !continuation.length) {
			const items = rest.slice(1, -1).split(',').map(item => unquote(item.trim())).filter(Boolean);
			entries.push({ key, value: items.join(', '), style: 'list', lines: own });
		} else if (continuation.length) {
			// A plain scalar wrapped over several lines.
			const value = [rest, ...continuation.map(item => item.trim())].filter(Boolean).join(' ');
			entries.push({ key, value: unquote(value), style: 'raw', lines: own });
		} else {
			const quoted = /^(['"]).*\1$/.test(rest);
			entries.push({ key, value: unquote(rest), style: quoted ? 'quoted' : 'plain', lines: own });
		}
		i = j;
	}
	const body = lines.slice(end + 1).join(eol);
	return { hasFrontmatter: true, entries, body, eol };
}

/** The document as text. `entries` may be edited copies; untouched ones keep their source lines. */
export function serializeFrontmatterDocument(doc: Pick<IFrontmatterDocument, 'entries' | 'body' | 'eol'> & { hasFrontmatter?: boolean }, forceFrontmatter = false): string {
	const eol = doc.eol;
	if (!doc.entries.length && !forceFrontmatter && !doc.hasFrontmatter) {
		return doc.body;
	}
	const head = doc.entries.flatMap(entry => entry.lines.length ? entry.lines : formatEntry(entry.key, entry.value));
	return ['---', ...head, '---', doc.body].join(eol);
}

/** A new or edited entry, written the way it will be read back. */
export function frontmatterEntry(key: string, value: string, asList = false): IFrontmatterEntry {
	const lines = asList ? formatList(key, value) : formatEntry(key, value);
	return { key, value, style: asList ? 'list' : 'plain', lines };
}

export function frontmatterValue(doc: IFrontmatterDocument, key: string): string | undefined {
	const lower = key.toLowerCase();
	return doc.entries.find(entry => entry.key.toLowerCase() === lower)?.value;
}

/** Sets (or adds, or with `undefined` removes) one property, keeping the others as written. */
export function withFrontmatterValue(doc: IFrontmatterDocument, key: string, value: string | undefined, asList = false): IFrontmatterDocument {
	const lower = key.toLowerCase();
	const index = doc.entries.findIndex(entry => entry.key.toLowerCase() === lower);
	const entries = [...doc.entries];
	if (value === undefined) {
		if (index >= 0) {
			entries.splice(index, 1);
		}
	} else if (index >= 0) {
		entries[index] = frontmatterEntry(entries[index].key, value, asList || entries[index].style === 'list');
	} else {
		entries.push(frontmatterEntry(key, value, asList));
	}
	return { ...doc, entries, hasFrontmatter: doc.hasFrontmatter || entries.length > 0 };
}

export function isTruthy(value: string | undefined): boolean {
	return !!value && /^(true|yes|on|1)$/i.test(value.trim());
}

function formatEntry(key: string, value: string): string[] {
	if (!key) {
		return value ? [value] : [];
	}
	const text = value.replace(/\r?\n/g, ' ').trim();
	return [text ? `${key}: ${quoteIfNeeded(text)}` : `${key}:`];
}

function formatList(key: string, value: string): string[] {
	const items = value.split(',').map(item => item.trim()).filter(Boolean);
	// Cursor writes globs as one comma-separated scalar; keep that shape, it reads back the same.
	return [items.length ? `${key}: ${items.join(',')}` : `${key}:`];
}

/** Quotes a scalar only when plain YAML would read it differently. */
export function quoteIfNeeded(value: string): string {
	if (/^(true|false|null|~|yes|no|on|off)$/i.test(value)) {
		return value;
	}
	if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || /: |\s#/.test(value) || /^\s|\s$/.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return value;
}

function unquote(value: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(value);
	if (!match) {
		return value;
	}
	return match[1] === '"' ? match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : match[2].replace(/''/g, '\'');
}

function dedent(lines: readonly string[]): string[] {
	const indents = lines.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length);
	const strip = indents.length ? Math.min(...indents) : 0;
	return lines.map(line => line.slice(strip));
}

/** YAML folding: single breaks become spaces, blank lines stay paragraph breaks. */
function foldLines(lines: readonly string[]): string {
	const paragraphs: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (!line.trim()) {
			paragraphs.push(current.join(' '));
			current = [];
		} else {
			current.push(line.trim());
		}
	}
	paragraphs.push(current.join(' '));
	return paragraphs.filter((paragraph, index) => paragraph || index < paragraphs.length - 1).join('\n');
}
