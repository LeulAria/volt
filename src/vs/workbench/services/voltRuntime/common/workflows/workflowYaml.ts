/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkflowRecord, WorkflowValue } from './workflowTypes.js';

/**
 * The YAML subset workflow files use, read and written here without dependencies
 * (`base/common/yaml.ts` has no block scalars or escapes). Supported: comments, block maps and
 * lists (compact `- key: value` items too), flow lists and maps (also over several lines), plain,
 * single- and double-quoted scalars (folded over lines like YAML does), `|` and `>` block scalars
 * with chomping and indentation indicators, the YAML 1.2 core scalars (null, booleans, numbers),
 * and one optional `---` / `...`. Anchors, aliases, tags, complex keys and multiple documents are
 * refused with a clear error instead of being half supported. Where every value starts is kept
 * for `locate`, so issues found later (shape, graph) can point at a line.
 */

export interface IYamlError {
	readonly message: string;
	/** 1-based. */
	readonly line: number;
	readonly column: number;
}

export interface IYamlParseResult {
	readonly value?: WorkflowValue;
	readonly errors: readonly IYamlError[];
	/** Where a path (`['nodes', 2, 'config', 'prompt']`) starts in the text, for issue locations. */
	locate(path: readonly (string | number)[]): { readonly line: number; readonly column: number } | undefined;
}

/** Larger input is refused: workflows are a few KB, and the YAML panel parses on every change. */
export const YAML_MAX_SIZE = 1_000_000;
/** Deeper nesting is refused, so hostile input cannot exhaust the stack. */
export const YAML_MAX_DEPTH = 64;

interface IYamlLocation {
	readonly line: number;
	readonly column: number;
}

interface ICursor {
	row: number;
	col: number;
}

class YamlSyntaxError extends Error {
	constructor(message: string, readonly line: number, readonly column: number) {
		super(message);
	}
}

/** Empty, whitespace-only and comment-only lines. `[^]` so a comment may hold any character. */
const BLANK = /^[ \t]*(?:#[^]*)?$/;
const WHITESPACE_ONLY = /^[ \t]*$/;
const DOCUMENT_MARKER = /^(---|\.\.\.)(?=[ \t]|$)/;
/** YAML 1.2 core decimals. Leading zeros ("007"), hex, `.inf` and `1_000` stay strings. */
const NUMBER = /^[-+]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/;

const NOT_SUPPORTED = 'not supported in workflow files';

function isSpaceOrEnd(line: string, index: number): boolean {
	return index >= line.length || line[index] === ' ' || line[index] === '\t';
}

function leadingSpaces(line: string): number {
	let count = 0;
	while (line.charCodeAt(count) === 32) {
		count++;
	}
	return count;
}

function isSequenceEntry(line: string, col: number): boolean {
	return line[col] === '-' && isSpaceOrEnd(line, col + 1);
}

/** Map keys as own properties, so a `__proto__` key is data and never a prototype. */
function setKey(map: Record<string, WorkflowValue>, key: string, value: WorkflowValue): void {
	Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Plain scalar resolution (YAML 1.2 core schema). */
function resolvePlain(text: string): WorkflowValue {
	switch (text) {
		case '': case '~': case 'null': case 'Null': case 'NULL':
			return null;
		case 'true': case 'True': case 'TRUE':
			return true;
		case 'false': case 'False': case 'FALSE':
			return false;
	}
	if (NUMBER.test(text)) {
		const number = Number(text);
		if (Number.isFinite(number)) {
			return number;
		}
	}
	return text;
}

/** Index just past the closing quote of a quoted scalar that ends on this line; -1 otherwise. */
function quotedEnd(line: string, col: number): number {
	const quote = line[col];
	for (let i = col + 1; i < line.length; i++) {
		const ch = line[i];
		if (quote === '"' && ch === '\\') {
			i++;
		} else if (ch === quote) {
			if (quote === '\'' && line[i + 1] === '\'') {
				i++;
				continue;
			}
			return i + 1;
		}
	}
	return -1;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	'0': '\0', 'a': '\x07', 'b': '\b', 't': '\t', '\t': '\t', 'n': '\n', 'v': '\v', 'f': '\f', 'r': '\r', 'e': '\x1b',
	' ': ' ', '"': '"', '/': '/', '\\': '\\', 'N': String.fromCharCode(0x85), '_': String.fromCharCode(0xa0), 'L': String.fromCharCode(0x2028), 'P': String.fromCharCode(0x2029),
};
const HEX_ESCAPES: Readonly<Record<string, number>> = { 'x': 2, 'u': 4, 'U': 8 };

class YamlParser {
	readonly errors: IYamlError[] = [];
	readonly locations = new Map<string, IYamlLocation>();
	private readonly lines: string[];
	private readonly path: (string | number)[] = [];
	/** The first line after the value parsed last. */
	private row = 0;
	private depth = 0;

	constructor(text: string) {
		const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
		if (lines.length > 1 && lines[lines.length - 1] === '') {
			lines.pop(); // the final line break ends the last line; it does not start an empty one
		}
		this.lines = lines;
	}

	parseDocument(): WorkflowValue {
		const count = this.lines.length;
		let row = this.skipBlank(0);
		if (row < count && this.lines[row].startsWith('%')) {
			throw this.error(`YAML directives (%YAML, %TAG) are ${NOT_SUPPORTED}`, row, 0);
		}
		if (row < count && this.marker(row) === '---') {
			this.expectEnd(row, 3);
			row = this.skipBlank(row + 1);
		}
		let value: WorkflowValue = null;
		if (row < count && !this.marker(row)) {
			const indent = this.indentAt(row);
			this.record(row, indent);
			value = this.parseNode(-1, row, indent);
			row = this.skipBlank(this.row);
		}
		if (row < count) {
			const marker = this.marker(row);
			if (marker === '...') {
				this.expectEnd(row, 3);
				const after = this.skipBlank(row + 1);
				if (after < count) {
					throw this.error(`Multiple documents are ${NOT_SUPPORTED}; keep one workflow per file`, after, 0);
				}
			} else if (marker === '---') {
				throw this.error(`Multiple documents (---) are ${NOT_SUPPORTED}; keep one workflow per file`, row, 0);
			} else {
				throw this.error('Unexpected content after the end of the document; check the indentation', row, this.indentAt(row));
			}
		}
		return value;
	}

	//#region Block structure

	/** A block node starting at `col` of `row`: a line's indentation, or the text after `- `. */
	private parseNode(parentIndent: number, row: number, col: number): WorkflowValue {
		this.row = row;
		const line = this.lines[row];
		if (isSequenceEntry(line, col)) {
			return this.nested(row, col, () => this.parseSequence(row, col));
		}
		if (this.scanKey(row, col)) {
			return this.nested(row, col, () => this.parseMapping(row, col));
		}
		return this.parseInline(parentIndent, row, col);
	}

	private parseMapping(row: number, indent: number): WorkflowValue {
		const map: Record<string, WorkflowValue> = {};
		const seen = new Set<string>();
		while (true) {
			const key = this.scanKey(row, indent);
			if (!key) {
				const hint = this.lines[row].includes(':', indent) ? ' (a space must follow the colon)' : '';
				throw this.error(`Expected a "key: value" entry${hint}`, row, indent);
			}
			const duplicate = seen.has(key.key);
			if (duplicate) {
				this.errors.push({ message: `Duplicate key "${key.key}"`, line: row + 1, column: indent + 1 });
			}
			seen.add(key.key);
			this.path.push(key.key);
			this.record(row, indent);
			const value = this.parseMapValue(indent, row, key.end);
			this.path.pop();
			if (!duplicate) {
				setKey(map, key.key, value);
			}
			const next = this.skipBlank(this.row);
			if (next >= this.lines.length || this.marker(next)) {
				break;
			}
			const nextIndent = this.indentAt(next);
			if (nextIndent < indent) {
				break;
			}
			if (nextIndent > indent) {
				throw this.error(`Bad indentation: expected ${indent} spaces like the entries above`, next, nextIndent);
			}
			if (isSequenceEntry(this.lines[next], nextIndent)) {
				throw this.error('A list item cannot follow "key: value" entries at the same indentation', next, nextIndent);
			}
			row = next;
		}
		return map;
	}

	/** The value after `key:` (`col` is just past the colon). */
	private parseMapValue(mapIndent: number, row: number, col: number): WorkflowValue {
		const line = this.lines[row];
		let c = col;
		while (line[c] === ' ' || line[c] === '\t') {
			c++;
		}
		if (c < line.length && line[c] !== '#') {
			return this.parseInline(mapIndent, row, c);
		}
		this.row = row + 1;
		const next = this.skipBlank(row + 1);
		if (next < this.lines.length && !this.marker(next)) {
			const indent = this.indentAt(next);
			if (indent > mapIndent) {
				return this.parseNode(mapIndent, next, indent);
			}
			if (indent === mapIndent && isSequenceEntry(this.lines[next], indent)) {
				// `key:` followed by `- item` lines at the key's own indentation (a common style)
				return this.nested(next, indent, () => this.parseSequence(next, indent));
			}
		}
		return null;
	}

	private parseSequence(row: number, indent: number): WorkflowValue {
		const items: WorkflowValue[] = [];
		while (true) {
			const line = this.lines[row];
			this.path.push(items.length);
			this.record(row, indent);
			let c = indent + 1;
			while (line[c] === ' ' || line[c] === '\t') {
				c++;
			}
			let item: WorkflowValue = null;
			if (c < line.length && line[c] !== '#') {
				item = this.parseNode(indent, row, c);
			} else {
				this.row = row + 1;
				const next = this.skipBlank(row + 1);
				if (next < this.lines.length && !this.marker(next)) {
					const nextIndent = this.indentAt(next);
					if (nextIndent > indent) {
						item = this.parseNode(indent, next, nextIndent);
					}
				}
			}
			this.path.pop();
			items.push(item);
			const next = this.skipBlank(this.row);
			if (next >= this.lines.length || this.marker(next)) {
				break;
			}
			const nextIndent = this.indentAt(next);
			if (nextIndent < indent) {
				break;
			}
			if (nextIndent > indent) {
				throw this.error(`Bad indentation: expected ${indent} spaces like the list items above`, next, nextIndent);
			}
			if (!isSequenceEntry(this.lines[next], nextIndent)) {
				break; // a key after a list written at its key's indentation: the mapping above goes on
			}
			row = next;
		}
		return items;
	}

	/**
	 * A mapping key at `col`: plain text up to `: `, or a quoted string on one line followed by `:`.
	 * `end` is just past the colon. Undefined when the text there is not a key.
	 */
	private scanKey(row: number, col: number): { readonly key: string; readonly end: number } | undefined {
		const line = this.lines[row];
		const first = line[col];
		if (first === '"' || first === '\'') {
			const end = quotedEnd(line, col);
			if (end < 0) {
				return undefined;
			}
			let i = end;
			while (line[i] === ' ' || line[i] === '\t') {
				i++;
			}
			return line[i] === ':' && isSpaceOrEnd(line, i + 1) ? { key: this.parseQuoted(row, col).value, end: i + 1 } : undefined;
		}
		if (first === undefined || first === '[' || first === '{') {
			return undefined;
		}
		for (let i = col; i < line.length; i++) {
			const ch = line[i];
			if (ch === '#' && i > col && (line[i - 1] === ' ' || line[i - 1] === '\t')) {
				return undefined;
			}
			if (ch === ':' && isSpaceOrEnd(line, i + 1)) {
				const key = line.slice(col, i).replace(/[ \t]+$/, '');
				if (!key) {
					return undefined;
				}
				this.checkIndicator(row, col);
				return { key, end: i + 1 };
			}
		}
		return undefined;
	}

	//#endregion

	//#region Scalars

	/** A value that starts on this line: block scalar header, flow collection, quoted or plain scalar. */
	private parseInline(parentIndent: number, row: number, col: number): WorkflowValue {
		const line = this.lines[row];
		const ch = line[col];
		this.checkIndicator(row, col);
		if (ch === '|' || ch === '>') {
			return this.parseBlockScalar(parentIndent, row, col);
		}
		if (ch === '[' || ch === '{') {
			const cursor: ICursor = { row, col };
			const value = this.parseFlowCollection(cursor);
			this.expectEnd(cursor.row, cursor.col);
			this.row = cursor.row + 1;
			return value;
		}
		if (ch === '"' || ch === '\'') {
			const quoted = this.parseQuoted(row, col);
			this.expectEnd(quoted.row, quoted.col);
			this.row = quoted.row + 1;
			return quoted.value;
		}
		if (isSequenceEntry(line, col)) {
			throw this.error('A list cannot start on the same line as its key; put the "- " items on the lines below', row, col);
		}
		if (ch === ']' || ch === '}' || ch === ',') {
			throw this.error(`Unexpected "${ch}"`, row, col);
		}
		return this.parsePlain(parentIndent, row, col);
	}

	/** Refuses what YAML has but workflow files do not: anchors, aliases, tags, reserved characters. */
	private checkIndicator(row: number, col: number): void {
		const line = this.lines[row];
		switch (line[col]) {
			case '&': throw this.error(`Anchors (&) are ${NOT_SUPPORTED}; quote the value if it is text`, row, col);
			case '*': throw this.error(`Aliases (*) are ${NOT_SUPPORTED}; quote values that start with * (like cron expressions)`, row, col);
			case '!': throw this.error(`Tags (!) are ${NOT_SUPPORTED}; quote the value if it is text`, row, col);
			case '%': case '@': case '`': throw this.error(`"${line[col]}" cannot start a plain value in YAML; quote the value`, row, col);
			case '?':
				if (isSpaceOrEnd(line, col + 1)) {
					throw this.error(`Complex keys (?) are ${NOT_SUPPORTED}`, row, col);
				}
				break;
			case '{':
				if (line[col + 1] === '{') {
					throw this.error('A value that starts with {{ must be quoted: \'{{ inputs.task }}\'', row, col);
				}
				break;
		}
	}

	/** Plain text, folded over more-indented lines below it (one break is a space, empty lines are breaks). */
	private parsePlain(parentIndent: number, row: number, col: number): WorkflowValue {
		const first = this.plainLine(row, col);
		let text = first.text;
		let folded = false;
		let r = row + 1;
		if (!first.comment) {
			while (true) {
				let next = r;
				let empty = 0;
				while (next < this.lines.length && WHITESPACE_ONLY.test(this.lines[next])) {
					next++;
					empty++;
				}
				if (next >= this.lines.length || this.marker(next)) {
					break;
				}
				const indent = this.indentAt(next);
				if (indent <= parentIndent || this.lines[next][indent] === '#') {
					break;
				}
				const part = this.plainLine(next, indent);
				text += empty ? '\n'.repeat(empty) : ' ';
				text += part.text.replace(/^[ \t]+/, '');
				folded = true;
				r = next + 1;
				if (part.comment) {
					break;
				}
			}
		}
		this.row = r;
		return folded ? text : resolvePlain(text);
	}

	private plainLine(row: number, col: number): { readonly text: string; readonly comment: boolean } {
		const line = this.lines[row];
		for (let i = col; i < line.length; i++) {
			const ch = line[i];
			if (ch === '#' && i > col && (line[i - 1] === ' ' || line[i - 1] === '\t')) {
				return { text: line.slice(col, i).replace(/[ \t]+$/, ''), comment: true };
			}
			if (ch === ':' && isSpaceOrEnd(line, i + 1)) {
				throw this.error('Unexpected ": " in a value; quote the value, or check the indentation (a value cannot also have entries under it)', row, i);
			}
		}
		return { text: line.slice(col).replace(/[ \t]+$/, ''), comment: false };
	}

	/** A single- or double-quoted scalar; line breaks inside fold like YAML (a space, or one break per empty line). */
	private parseQuoted(row: number, col: number): { readonly value: string; readonly row: number; readonly col: number } {
		const quote = this.lines[row][col];
		let out = '';
		let spaces = '';
		let escapedBreak = false;
		let r = row;
		let i = col + 1;
		while (true) {
			const line = this.lines[r];
			if (i >= line.length) {
				spaces = ''; // whitespace before a line break is dropped
				let breaks = 0;
				do {
					r++;
					breaks++;
					if (r >= this.lines.length) {
						throw this.error(`Unterminated string: missing the closing ${quote}`, row, col);
					}
				} while (WHITESPACE_ONLY.test(this.lines[r]));
				out += breaks > 1 ? '\n'.repeat(breaks - 1) : escapedBreak ? '' : ' ';
				escapedBreak = false;
				const next = this.lines[r];
				i = 0;
				while (next[i] === ' ' || next[i] === '\t') {
					i++;
				}
				continue;
			}
			const ch = line[i];
			if (ch === ' ' || ch === '\t') {
				spaces += ch;
				i++;
				continue;
			}
			out += spaces;
			spaces = '';
			if (quote === '\'') {
				if (ch === '\'') {
					if (line[i + 1] !== '\'') {
						return { value: out, row: r, col: i + 1 };
					}
					i++;
				}
				out += ch;
				i++;
				continue;
			}
			if (ch === '"') {
				return { value: out, row: r, col: i + 1 };
			}
			if (ch !== '\\') {
				out += ch;
				i++;
				continue;
			}
			const escape = line[i + 1];
			if (escape === undefined) {
				escapedBreak = true; // a backslash at the end of a line joins the lines without a space
				i++;
				continue;
			}
			const simple = SIMPLE_ESCAPES[escape];
			if (simple !== undefined) {
				out += simple;
				i += 2;
				continue;
			}
			const length = HEX_ESCAPES[escape];
			if (length !== undefined) {
				const hex = line.slice(i + 2, i + 2 + length);
				const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === length ? parseInt(hex, 16) : -1;
				if (code < 0 || code > 0x10ffff) {
					throw this.error(`Invalid escape "\\${escape}${hex}": expected ${length} hex digits`, r, i);
				}
				out += String.fromCodePoint(code);
				i += 2 + length;
				continue;
			}
			throw this.error(`Unknown escape "\\${escape}" in a double-quoted string`, r, i);
		}
	}

	/** `|` (literal) or `>` (folded), with `-`/`+` chomping and an optional indentation digit. */
	private parseBlockScalar(parentIndent: number, row: number, col: number): string {
		const line = this.lines[row];
		const folded = line[col] === '>';
		let chomping: 'clip' | 'strip' | 'keep' = 'clip';
		let explicit = 0;
		let i = col + 1;
		for (let n = 0; n < 2; n++) {
			const ch = line[i];
			if ((ch === '-' || ch === '+') && chomping === 'clip') {
				chomping = ch === '-' ? 'strip' : 'keep';
				i++;
			} else if (ch !== undefined && ch >= '1' && ch <= '9' && !explicit) {
				explicit = Number(ch);
				i++;
			}
		}
		let j = i;
		while (line[j] === ' ' || line[j] === '\t') {
			j++;
		}
		if (j < line.length && !(line[j] === '#' && j > i)) {
			throw this.error('Invalid block scalar header: use |, |-, |+, >, >- or >+ (optionally with an indentation digit)', row, j);
		}

		let r = row + 1;
		let indent: number;
		if (explicit) {
			indent = Math.max(parentIndent, 0) + explicit;
		} else {
			let probe = r;
			while (probe < this.lines.length && WHITESPACE_ONLY.test(this.lines[probe])) {
				probe++;
			}
			indent = probe < this.lines.length ? leadingSpaces(this.lines[probe]) : 0;
			if (indent <= parentIndent) {
				indent = parentIndent + 1; // no content: the next line already belongs to the parent
			}
		}

		const contents: (string | undefined)[] = []; // undefined: an empty line
		for (; r < this.lines.length; r++) {
			const text = this.lines[r];
			const spaces = leadingSpaces(text);
			if (WHITESPACE_ONLY.test(text)) {
				contents.push(spaces >= indent && text.length > indent ? text.slice(indent) : undefined);
			} else if (spaces >= indent && !(indent === 0 && this.marker(r))) {
				contents.push(text.slice(indent));
			} else {
				break;
			}
		}
		this.row = r;

		let out = '';
		let empty = 0;
		let started = false;
		let moreIndented = false;
		for (const text of contents) {
			if (text === undefined) {
				empty++;
				continue;
			}
			if (!folded) {
				out += '\n'.repeat(started ? 1 + empty : empty);
			} else if (text[0] === ' ' || text[0] === '\t') {
				moreIndented = true; // more-indented lines keep their breaks
				out += '\n'.repeat(started ? 1 + empty : empty);
			} else if (moreIndented) {
				moreIndented = false;
				out += '\n'.repeat(empty + 1);
			} else if (empty === 0) {
				out += started ? ' ' : '';
			} else {
				out += '\n'.repeat(empty);
			}
			out += text;
			started = true;
			empty = 0;
		}
		if (chomping === 'keep') {
			out += '\n'.repeat(started ? 1 + empty : empty);
		} else if (chomping === 'clip' && started) {
			out += '\n';
		}
		return out;
	}

	//#endregion

	//#region Flow collections

	/** `[ … ]` or `{ … }` at the cursor, possibly over several lines; leaves the cursor after the closing bracket. */
	private parseFlowCollection(cursor: ICursor): WorkflowValue {
		const open = { row: cursor.row, col: cursor.col };
		return this.nested(open.row, open.col, () => this.lines[open.row][open.col] === '['
			? this.parseFlowSequence(cursor, open)
			: this.parseFlowMapping(cursor, open));
	}

	private parseFlowSequence(cursor: ICursor, open: ICursor): WorkflowValue {
		const items: WorkflowValue[] = [];
		cursor.col++;
		while (true) {
			this.skipFlowSpace(cursor, open, ']');
			if (this.lines[cursor.row][cursor.col] === ']') {
				cursor.col++;
				return items;
			}
			this.path.push(items.length);
			this.record(cursor.row, cursor.col);
			items.push(this.parseFlowNode(cursor, ']'));
			this.path.pop();
			this.skipFlowSpace(cursor, open, ']');
			const ch = this.lines[cursor.row][cursor.col];
			if (ch === ',') {
				cursor.col++;
			} else if (ch === ']') {
				cursor.col++;
				return items;
			} else {
				throw this.error(ch === ':' && cursor.row === open.row ? 'Use braces for a mapping inside a list: [{ key: value }]' : `Expected "," or "]"${this.unclosed(open, cursor)}`, cursor.row, cursor.col);
			}
		}
	}

	private parseFlowMapping(cursor: ICursor, open: ICursor): WorkflowValue {
		const map: Record<string, WorkflowValue> = {};
		const seen = new Set<string>();
		cursor.col++;
		while (true) {
			this.skipFlowSpace(cursor, open, '}');
			if (this.lines[cursor.row][cursor.col] === '}') {
				cursor.col++;
				return map;
			}
			const keyRow = cursor.row;
			const keyCol = cursor.col;
			const key = this.parseFlowKey(cursor);
			const duplicate = seen.has(key);
			if (duplicate) {
				this.errors.push({ message: `Duplicate key "${key}"`, line: keyRow + 1, column: keyCol + 1 });
			}
			seen.add(key);
			this.path.push(key);
			this.record(keyRow, keyCol);
			this.skipFlowSpace(cursor, open, '}');
			let value: WorkflowValue = null;
			if (this.lines[cursor.row][cursor.col] === ':') {
				cursor.col++;
				this.skipFlowSpace(cursor, open, '}');
				const ch = this.lines[cursor.row][cursor.col];
				if (ch !== ',' && ch !== '}') {
					value = this.parseFlowNode(cursor, '}');
				}
			}
			this.path.pop();
			if (!duplicate) {
				setKey(map, key, value);
			}
			this.skipFlowSpace(cursor, open, '}');
			const ch = this.lines[cursor.row][cursor.col];
			if (ch === ',') {
				cursor.col++;
			} else if (ch === '}') {
				cursor.col++;
				return map;
			} else {
				throw this.error(`Expected "," or "}"${this.unclosed(open, cursor)}`, cursor.row, cursor.col);
			}
		}
	}

	private parseFlowNode(cursor: ICursor, close: string): WorkflowValue {
		const line = this.lines[cursor.row];
		const ch = line[cursor.col];
		if (ch === '[' || ch === '{') {
			this.checkIndicator(cursor.row, cursor.col);
			return this.parseFlowCollection(cursor);
		}
		if (ch === '"' || ch === '\'') {
			const quoted = this.parseQuoted(cursor.row, cursor.col);
			cursor.row = quoted.row;
			cursor.col = quoted.col;
			return quoted.value;
		}
		return resolvePlain(this.flowPlain(cursor, close));
	}

	private parseFlowKey(cursor: ICursor): string {
		const ch = this.lines[cursor.row][cursor.col];
		if (ch === '"' || ch === '\'') {
			const quoted = this.parseQuoted(cursor.row, cursor.col);
			cursor.row = quoted.row;
			cursor.col = quoted.col;
			return quoted.value;
		}
		if (ch === '[' || ch === '{' || ch === ',' || ch === ':') {
			throw this.error('Expected a key', cursor.row, cursor.col);
		}
		return this.flowPlain(cursor, '}');
	}

	/** Plain text inside a flow collection: ends at `,`, brackets, `: ` or a comment. */
	private flowPlain(cursor: ICursor, close: string): string {
		const line = this.lines[cursor.row];
		const start = cursor.col;
		this.checkIndicator(cursor.row, start);
		const ch = line[start];
		if (ch === '|' || ch === '>') {
			throw this.error('Block scalars (| and >) cannot be used inside [ ] or { }', cursor.row, start);
		}
		if (isSequenceEntry(line, start)) {
			throw this.error('"- " list items cannot be used inside [ ] or { }', cursor.row, start);
		}
		if (ch === ',' || ch === ']' || ch === '}') {
			throw this.error(`Unexpected "${ch}"; expected a value or "${close}"`, cursor.row, start);
		}
		let i = start;
		for (; i < line.length; i++) {
			const c = line[i];
			if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}') {
				break;
			}
			if (c === ':' && (i + 1 >= line.length || ' \t,[]{}'.includes(line[i + 1]))) {
				break;
			}
			if (c === '#' && i > start && (line[i - 1] === ' ' || line[i - 1] === '\t')) {
				break;
			}
		}
		cursor.col = i;
		return line.slice(start, i).replace(/[ \t]+$/, '');
	}

	/** A hint for a flow collection that runs on into the next lines: most likely its bracket is missing. */
	private unclosed(open: ICursor, cursor: ICursor): string {
		return cursor.row === open.row ? '' : ` (is the ${this.lines[open.row][open.col] === '[' ? '"]"' : '"}"'} of line ${open.row + 1} missing?)`;
	}

	/** Skips whitespace, line breaks and comments inside a flow collection. */
	private skipFlowSpace(cursor: ICursor, open: ICursor, close: string): void {
		while (cursor.row < this.lines.length) {
			const line = this.lines[cursor.row];
			while (line[cursor.col] === ' ' || line[cursor.col] === '\t') {
				cursor.col++;
			}
			const comment = line[cursor.col] === '#' && (cursor.col === 0 || line[cursor.col - 1] === ' ' || line[cursor.col - 1] === '\t');
			if (cursor.col < line.length && !comment) {
				return;
			}
			cursor.row++;
			cursor.col = 0;
		}
		throw this.error(close === ']' ? 'Unterminated list: missing "]"' : 'Unterminated mapping: missing "}"', open.row, open.col);
	}

	//#endregion

	//#region Helpers

	private nested<T>(row: number, col: number, parse: () => T): T {
		if (++this.depth > YAML_MAX_DEPTH) {
			throw this.error(`Nesting is too deep (more than ${YAML_MAX_DEPTH} levels)`, row, col);
		}
		try {
			return parse();
		} finally {
			this.depth--;
		}
	}

	private record(row: number, col: number): void {
		const key = JSON.stringify(this.path);
		if (!this.locations.has(key)) {
			this.locations.set(key, { line: row + 1, column: col + 1 });
		}
	}

	private skipBlank(row: number): number {
		while (row < this.lines.length && BLANK.test(this.lines[row])) {
			row++;
		}
		return row;
	}

	private marker(row: number): string | undefined {
		return DOCUMENT_MARKER.exec(this.lines[row])?.[1];
	}

	/** Leading spaces of a content line; tabs there are an error (YAML indents with spaces only). */
	private indentAt(row: number): number {
		const line = this.lines[row];
		const spaces = leadingSpaces(line);
		if (line[spaces] === '\t') {
			throw this.error('Tabs cannot be used for indentation; use spaces', row, spaces);
		}
		return spaces;
	}

	/** Only whitespace and a comment may follow a value on its line. */
	private expectEnd(row: number, col: number): void {
		const line = this.lines[row];
		let i = col;
		while (line[i] === ' ' || line[i] === '\t') {
			i++;
		}
		if (i < line.length && !(line[i] === '#' && i > col)) {
			throw this.error(line[i] === ':'
				? 'Only plain or quoted text on one line can be a key'
				: `Unexpected text after the value: "${line.slice(i, i + 24)}"`, row, i);
		}
	}

	private error(message: string, row: number, col: number): YamlSyntaxError {
		return new YamlSyntaxError(message, row + 1, col + 1);
	}

	//#endregion
}

export function parseYaml(text: string): IYamlParseResult {
	if (text.length > YAML_MAX_SIZE) {
		return { errors: [{ message: `The file is too large (over ${YAML_MAX_SIZE / 1_000_000} MB)`, line: 1, column: 1 }], locate: () => undefined };
	}
	const parser = new YamlParser(text);
	// a syntax error stops the parse (no value); duplicate keys are reported and the first one kept
	let value: WorkflowValue | undefined;
	try {
		value = parser.parseDocument();
	} catch (error) {
		if (!(error instanceof YamlSyntaxError)) {
			throw error;
		}
		parser.errors.push({ message: error.message, line: error.line, column: error.column });
	}
	const errors = [...parser.errors].sort((a, b) => a.line - b.line || a.column - b.column);
	const locations = parser.locations;
	return {
		value,
		errors,
		locate: path => locations.get(JSON.stringify(path)),
	};
}

//#region Writing

export interface IYamlStringifyOptions {
	/** Comment lines written at the top (without `#`). */
	readonly header?: readonly string[];
	/** Arrays of scalars this short or shorter are written inline (`[120, 40]`). */
	readonly inlineArrayMax?: number;
}

/** Inline arrays stay under this width, so reviews and diffs read well. */
const INLINE_WIDTH = 72;

/** Words other YAML readers (YAML 1.1: GitHub Actions, PyYAML) take for booleans or null. */
const RESERVED_WORDS = /^(?:true|false|null|~|yes|no|on|off|y|n)$/i;
/** Anything that starts like a number in some YAML dialect (dates, octal, `1_000`, `.inf`). */
const NUMBER_LIKE = /^[-+.]?[0-9]|^[-+]?\.(?:inf|nan)$/i;
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function isCollection(value: WorkflowValue): value is readonly WorkflowValue[] | WorkflowRecord {
	return value !== null && typeof value === 'object';
}

function keysOf(map: WorkflowRecord): string[] {
	return Object.keys(map).filter(key => map[key] !== undefined);
}

/** Characters a single-quoted or plain scalar cannot carry (controls, odd line breaks, lone surrogates). */
function needsEscapes(text: string, allowTabsAndBreaks = false): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20) {
			if (allowTabsAndBreaks && (code === 0x09 || code === 0x0a)) {
				continue;
			}
			return true;
		}
		if ((code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
			return true;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i++;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/** Text that reads back as the same string without quotes, here and in other YAML readers. */
function isPlainSafe(text: string, flow: boolean): boolean {
	if (!text || text !== text.trim() || needsEscapes(text) || INDICATOR_START.test(text) || /^(?:---|\.\.\.)/.test(text)) {
		return false;
	}
	if (text.includes(': ') || text.includes(' #') || text.endsWith(':')) {
		return false;
	}
	if (flow && /[,[\]{}:]/.test(text)) {
		return false;
	}
	return !RESERVED_WORDS.test(text) && !NUMBER_LIKE.test(text) && resolvePlain(text) === text;
}

function quote(text: string): string {
	if (!needsEscapes(text)) {
		return `'${text.replace(/'/g, '\'\'')}'`;
	}
	// JSON escapes are a subset of YAML's double-quoted escapes; add the line breaks JSON leaves raw
	const json = JSON.stringify(text);
	let out = '';
	for (let i = 0; i < json.length; i++) {
		const code = json.charCodeAt(i);
		out += (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff ? `\\u${code.toString(16).padStart(4, '0')}` : json[i];
	}
	return out;
}

function formatString(text: string, flow: boolean): string {
	return isPlainSafe(text, flow) ? text : quote(text);
}

/** Keys keep their text as written (`200:` stays the key "200"), so only syntax decides quoting. */
function formatKey(key: string, flow = false): string {
	const plain = key && key === key.trim() && !needsEscapes(key) && !INDICATOR_START.test(key) && !/^(?:---|\.\.\.)/.test(key)
		&& !key.includes(': ') && !key.includes(' #') && !key.endsWith(':') && !(flow && /[,[\]{}:]/.test(key));
	return plain ? key : quote(key);
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return 'null';
	}
	return Object.is(value, -0) ? '-0' : String(value);
}

/** Multi-line text written as a `|` block: readable, and exact for anything without odd characters. */
function isBlockString(text: string): boolean {
	if (!text.includes('\n') || needsEscapes(text, true)) {
		return false;
	}
	const first = text.split('\n').find(line => line !== '');
	// a first line starting with whitespace would need an indentation indicator; quote those instead
	return first !== undefined && first[0] !== ' ' && first[0] !== '\t';
}

function trailingBreaks(text: string): number {
	let count = 0;
	while (count < text.length && text[text.length - 1 - count] === '\n') {
		count++;
	}
	return count;
}

function blockHeader(text: string): string {
	const breaks = trailingBreaks(text);
	return breaks === 0 ? '|-' : breaks === 1 ? '|' : '|+';
}

class YamlWriter {
	constructor(private readonly inlineMax: number, private readonly out: string[]) { }

	root(value: WorkflowValue): void {
		if (typeof value === 'string' && isBlockString(value)) {
			this.out.push(blockHeader(value));
			this.blockLines(value, 2);
		} else if (this.isInline(value)) {
			this.out.push(this.inline(value, false));
		} else if (Array.isArray(value)) {
			this.sequence(value, 0);
		} else {
			this.mapping(value as WorkflowRecord, 0);
		}
	}

	/** `prefix` is `key:` or `-` at `indent`; the value goes after it or on the lines below. */
	private entry(prefix: string, value: WorkflowValue, indent: number): void {
		if (typeof value === 'string' && isBlockString(value)) {
			this.out.push(`${prefix} ${blockHeader(value)}`);
			this.blockLines(value, indent + 2);
		} else if (this.isInline(value)) {
			this.out.push(`${prefix} ${this.inline(value, false)}`);
		} else {
			this.out.push(prefix);
			if (Array.isArray(value)) {
				this.sequence(value, indent + 2);
			} else {
				this.mapping(value as WorkflowRecord, indent + 2);
			}
		}
	}

	private mapping(map: WorkflowRecord, indent: number): void {
		for (const key of keysOf(map)) {
			this.entry(`${' '.repeat(indent)}${formatKey(key)}:`, map[key], indent);
		}
	}

	private sequence(items: readonly WorkflowValue[], indent: number): void {
		for (const item of items) {
			if (isCollection(item) && !this.isInline(item)) {
				// compact form: the item's first line goes on the dash line (`- id: start`)
				const first = this.out.length;
				if (Array.isArray(item)) {
					this.sequence(item, indent + 2);
				} else {
					this.mapping(item as WorkflowRecord, indent + 2);
				}
				this.out[first] = `${' '.repeat(indent)}- ${this.out[first].slice(indent + 2)}`;
			} else {
				this.entry(`${' '.repeat(indent)}-`, item, indent);
			}
		}
	}

	private blockLines(text: string, indent: number): void {
		const breaks = trailingBreaks(text);
		const pad = ' '.repeat(indent);
		for (const line of text.slice(0, text.length - breaks).split('\n')) {
			this.out.push(line ? pad + line : '');
		}
		for (let i = 1; i < breaks; i++) {
			this.out.push(''); // kept (`|+`) trailing breaks
		}
	}

	private isInline(value: WorkflowValue): boolean {
		if (Array.isArray(value)) {
			return value.length === 0 || (value.length <= this.inlineMax
				&& value.every(item => !isCollection(item) && !(typeof item === 'string' && item.includes('\n')))
				&& this.inline(value, true).length <= INLINE_WIDTH);
		}
		if (isCollection(value)) {
			return keysOf(value as WorkflowRecord).length === 0;
		}
		return !(typeof value === 'string' && isBlockString(value));
	}

	private inline(value: WorkflowValue, flow: boolean): string {
		if (value === null || value === undefined) {
			return 'null';
		}
		if (typeof value === 'boolean') {
			return value ? 'true' : 'false';
		}
		if (typeof value === 'number') {
			return formatNumber(value);
		}
		if (typeof value === 'string') {
			return formatString(value, flow);
		}
		if (Array.isArray(value)) {
			return value.length ? `[${value.map(item => this.inline(item, true)).join(', ')}]` : '[]';
		}
		const map = value as WorkflowRecord;
		const keys = keysOf(map);
		return keys.length ? `{ ${keys.map(key => `${formatKey(key, true)}: ${this.inline(map[key], true)}`).join(', ')} }` : '{}';
	}
}

/** Deterministic block-style YAML (2-space indent); `parseYaml` reads it back to an equal value. */
export function stringifyYaml(value: WorkflowValue, options: IYamlStringifyOptions = {}): string {
	const out: string[] = [];
	for (const line of (options.header ?? []).flatMap(text => text.split(/\r\n|\r|\n/))) {
		out.push(line ? `# ${line}` : '#');
	}
	new YamlWriter(Math.max(0, options.inlineArrayMax ?? 0), out).root(value);
	return out.join('\n') + '\n';
}

//#endregion
