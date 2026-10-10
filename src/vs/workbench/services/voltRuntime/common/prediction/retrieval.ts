/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase context for a prediction with no embeddings and no repository scan. Each open (or just
 * closed) file is cut into overlapping windows of lines, indexed by the names they use. The windows
 * that share the most rare names with the code around the cursor are what the model sees: BM25
 * weighting, so a name used everywhere says little and one used in two places says a lot. The
 * declarations of the names around the cursor come along as one-line signatures (with the members
 * of a type), the cheapest way to show the model an API. Pure: text in, text out.
 */

import { KEYWORDS } from './contextWindow.js';

/** Lines per window, and the step between windows (they overlap by half). */
export const CHUNK_LINES = 12;
const CHUNK_STRIDE = 6;
/** Lines this long on average are minified or generated: nothing in them is worth showing. */
const MINIFIED_LINE_CHARS = 300;
const MAX_LINE_CHARS = 200;
/** A window must share this many names with the cursor's code, and score this much, to be shown. */
const MIN_SHARED_NAMES = 2;
const MIN_SCORE = 3;
/** Other languages count less: a TypeScript file next to a Python one says little about it. */
const OTHER_LANGUAGE_FACTOR = 0.6;
/** Names in more than about a third of all windows are too common for their declaration to help. */
const MIN_DEFINITION_IDF = 1;

const NAME = /[A-Za-z_$][\w$]{2,}/g;

/** One file, analyzed once per version. */
export interface IDocumentAnalysis {
	readonly path: string;
	readonly languageId: string;
	readonly lines: readonly string[];
	readonly chunkCount: number;
	/** Name -> windows (by index, ascending) that use it. */
	readonly postings: ReadonlyMap<string, readonly number[]>;
	/** Name -> 0-based line of its declaration. */
	readonly declarations: ReadonlyMap<string, number>;
}

/** Declaration shapes across common languages; group 1 is the declared name. */
const DECLARATIONS: readonly RegExp[] = [
	// TS/JS/Java/C#/Kotlin/Swift/Scala types and functions.
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:public\s+|private\s+|internal\s+|sealed\s+|data\s+|abstract\s+|final\s+|static\s+|async\s+)*(?:function\*?|class|interface|type|enum|namespace|struct|trait|protocol|record|object|module|fun|func|fn|def)\s+([A-Za-z_$][\w$]*)/,
	// Go methods: func (r *T) Name(
	/^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/,
	// Rust impl blocks.
	/^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_]\w*)/,
	// Top-level-ish bindings: const name = / let name: Type =
	/^\s{0,4}(?:export\s+)?(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
	// Class members: `  async name(args): T {`. A call never ends with its own `{`.
	/^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+)?\{\s*$/,
];

/** Window indexes that contain line `line` (0-based). */
function chunksOf(line: number, chunkCount: number): [number, number] {
	const first = Math.max(0, Math.ceil((line - CHUNK_LINES + 1) / CHUNK_STRIDE));
	const last = Math.min(chunkCount - 1, Math.floor(line / CHUNK_STRIDE));
	return [first, last];
}

export function analyzeDocument(path: string, languageId: string, text: string): IDocumentAnalysis {
	const lines = text.split('\n');
	const postings = new Map<string, number[]>();
	const declarations = new Map<string, number>();
	const chunkCount = lines.length <= CHUNK_LINES ? 1 : Math.ceil((lines.length - CHUNK_LINES) / CHUNK_STRIDE) + 1;
	if (text.length / Math.max(1, lines.length) > MINIFIED_LINE_CHARS) {
		return { path, languageId, lines: [], chunkCount: 0, postings, declarations };
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length > 4 * MAX_LINE_CHARS) {
			continue;
		}
		const [first, last] = chunksOf(i, chunkCount);
		for (const match of line.matchAll(NAME)) {
			const name = match[0];
			if (KEYWORDS.has(name.toLowerCase())) {
				continue;
			}
			let list = postings.get(name);
			if (!list) {
				list = [];
				postings.set(name, list);
			}
			// Window ranges only move forward from line to line, so a list stays sorted and unique
			// by appending what lies past its end.
			for (let c = first; c <= last; c++) {
				if (!list.length || list[list.length - 1] < c) {
					list.push(c);
				}
			}
		}
		// Cheap pre-check: most lines declare nothing.
		if (/\b(?:function|class|interface|type|enum|namespace|struct|trait|protocol|record|object|module|fun|func|fn|def|impl|const|let|var|val)\b|^\s+[\w$]+\s*(?:<[^>()]*>)?\s*\(/.test(line)) {
			for (const pattern of DECLARATIONS) {
				const name = pattern.exec(line)?.[1];
				if (name && !KEYWORDS.has(name.toLowerCase()) && !declarations.has(name)) {
					declarations.set(name, i);
					break;
				}
			}
		}
	}
	return { path, languageId, lines, chunkCount, postings, declarations };
}

/**
 * Names around the cursor, weighted by nearness: the line being typed most, then the lines just
 * above, then a little of what follows. Keywords and names shorter than three characters are left out.
 */
export function queryTerms(prefix: string, linePrefix: string, suffix: string): Map<string, number> {
	const terms = new Map<string, number>();
	const add = (line: string, weight: number) => {
		for (const match of line.matchAll(NAME)) {
			const name = match[0];
			if (!KEYWORDS.has(name.toLowerCase()) && (terms.get(name) ?? 0) < weight) {
				terms.set(name, weight);
			}
		}
	};
	add(linePrefix, 3);
	const above = prefix.split('\n');
	above.pop();
	for (let d = 1; d <= 20 && d <= above.length; d++) {
		add(above[above.length - d], 2 / (1 + d / 4));
	}
	for (const line of suffix.split('\n', 5)) {
		add(line, 0.7);
	}
	return terms;
}

export interface IRetrievalQuery {
	readonly path: string;
	readonly languageId: string;
	/** Name -> weight, from {@link queryTerms}. */
	readonly terms: ReadonlyMap<string, number>;
	/** Lines of the current file the excerpt already shows (0-based, inclusive). */
	readonly excerpt?: { readonly start: number; readonly end: number };
}

export interface IRetrievedChunk {
	readonly path: string;
	/** 0-based first line. */
	readonly startLine: number;
	readonly text: string;
	readonly score: number;
}

const FAMILIES: Record<string, string> = {
	typescript: 'js', typescriptreact: 'js', javascript: 'js', javascriptreact: 'js', vue: 'js', svelte: 'js',
	c: 'c', cpp: 'c', 'objective-c': 'c', 'objective-cpp': 'c',
	css: 'css', scss: 'css', less: 'css',
	html: 'html', handlebars: 'html',
};

export function languageFamily(languageId: string): string {
	return FAMILIES[languageId] ?? languageId;
}

/** Inverse document frequency of each query name over all windows; names used nowhere are dropped. */
function idfOf(terms: ReadonlyMap<string, number>, docs: readonly IDocumentAnalysis[]): Map<string, number> {
	const total = docs.reduce((sum, doc) => sum + doc.chunkCount, 0);
	const idf = new Map<string, number>();
	for (const name of terms.keys()) {
		let df = 0;
		for (const doc of docs) {
			df += doc.postings.get(name)?.length ?? 0;
		}
		if (df) {
			idf.set(name, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
		}
	}
	return idf;
}

/**
 * The windows most like the code at the cursor, best first, never overlapping each other or the
 * excerpt, within `maxChars` together. Empty when nothing shares enough rare names.
 */
export function retrieveChunks(query: IRetrievalQuery, docs: readonly IDocumentAnalysis[], maxChars: number, maxChunks = 3): IRetrievedChunk[] {
	const idf = idfOf(query.terms, docs);
	if (!idf.size) {
		return [];
	}
	const family = languageFamily(query.languageId);
	const candidates: { doc: IDocumentAnalysis; chunk: number; score: number }[] = [];
	for (const doc of docs) {
		if (!doc.chunkCount) {
			continue;
		}
		const scores = new Float64Array(doc.chunkCount);
		const shared = new Uint8Array(doc.chunkCount);
		for (const [name, weight] of query.terms) {
			const termIdf = idf.get(name);
			const list = termIdf ? doc.postings.get(name) : undefined;
			if (!list) {
				continue;
			}
			for (const chunk of list) {
				scores[chunk] += weight * termIdf!;
				shared[chunk]++;
			}
		}
		const factor = languageFamily(doc.languageId) === family ? 1 : OTHER_LANGUAGE_FACTOR;
		const current = doc.path === query.path;
		for (let chunk = 0; chunk < doc.chunkCount; chunk++) {
			if (shared[chunk] < MIN_SHARED_NAMES || scores[chunk] * factor < MIN_SCORE) {
				continue;
			}
			if (current && query.excerpt && overlaps(chunk, query.excerpt)) {
				continue;
			}
			candidates.push({ doc, chunk, score: scores[chunk] * factor });
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	const picked: IRetrievedChunk[] = [];
	const taken = new Map<IDocumentAnalysis, number[]>();
	let used = 0;
	for (const { doc, chunk, score } of candidates) {
		if (picked.length >= maxChunks) {
			break;
		}
		const near = taken.get(doc);
		if (near?.some(other => Math.abs(other - chunk) * CHUNK_STRIDE < CHUNK_LINES)) {
			continue;
		}
		const text = chunkText(doc, chunk);
		if (!text || used + text.length > maxChars) {
			continue;
		}
		picked.push({ path: doc.path, startLine: chunk * CHUNK_STRIDE, text, score });
		taken.set(doc, [...(near ?? []), chunk]);
		used += text.length;
	}
	return picked;
}

function overlaps(chunk: number, excerpt: { readonly start: number; readonly end: number }): boolean {
	const start = chunk * CHUNK_STRIDE;
	return start <= excerpt.end && start + CHUNK_LINES - 1 >= excerpt.start;
}

function chunkText(doc: IDocumentAnalysis, chunk: number): string {
	const lines = doc.lines.slice(chunk * CHUNK_STRIDE, chunk * CHUNK_STRIDE + CHUNK_LINES).map(line => clipLine(line.trimEnd()));
	while (lines.length && !lines[0].trim()) {
		lines.shift();
	}
	while (lines.length && !lines[lines.length - 1].trim()) {
		lines.pop();
	}
	return lines.join('\n');
}

function clipLine(line: string): string {
	return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}...`;
}

/**
 * Signatures of the names around the cursor, heaviest names first: `api.ts:12 export function
 * getUser(id: string): Promise<User>`, a type with its first members. Declarations the excerpt
 * already shows are left out.
 */
export function retrieveDefinitions(query: IRetrievalQuery, docs: readonly IDocumentAnalysis[], maxChars: number, maxCount = 6): string[] {
	// Rare names first: a name used all over (`dispose`, `value`) has a declaration in every file
	// and says nothing about this one.
	const idf = idfOf(query.terms, docs);
	const names = [...query.terms]
		.map(([name, weight]) => ({ name, score: weight * (idf.get(name) ?? 0) }))
		.filter(({ name }) => (idf.get(name) ?? 0) >= MIN_DEFINITION_IDF)
		.sort((a, b) => b.score - a.score)
		.slice(0, 16)
		.map(({ name }) => name);
	const family = languageFamily(query.languageId);
	// The current file first, then files of the same language family, then the rest.
	const ordered = [...docs].sort((a, b) => rank(a) - rank(b));
	function rank(doc: IDocumentAnalysis): number {
		return doc.path === query.path ? 0 : languageFamily(doc.languageId) === family ? 1 : 2;
	}
	const out: string[] = [];
	let used = 0;
	for (const name of names) {
		if (out.length >= maxCount) {
			break;
		}
		for (const doc of ordered) {
			const line = doc.declarations.get(name);
			if (line === undefined) {
				continue;
			}
			if (doc.path === query.path && query.excerpt && line >= query.excerpt.start && line <= query.excerpt.end) {
				// On screen already: nothing to add, and no other file's declaration of it either.
				break;
			}
			const rendered = `${shortPath(doc.path)}:${line + 1} ${signature(doc.lines, line)}`;
			if (used + rendered.length <= maxChars) {
				out.push(rendered);
				used += rendered.length;
			}
			break;
		}
	}
	return out;
}

/** The last two segments of a path: enough to tell files apart, cheap in tokens. */
function shortPath(path: string): string {
	return path.split('/').slice(-2).join('/');
}

const SIGNATURE_CHARS = 300;
const MAX_MEMBERS = 8;

/**
 * The declaration on `line` as one line: a signature split over lines is joined up to its
 * closing parenthesis; a type, class or enum shows its first members, indented deeper than it.
 */
export function signature(lines: readonly string[], line: number): string {
	const head = lines[line].trim();
	let text = head;
	let next = line + 1;
	// Parameters on the lines that follow: `function f(\n  a: string,\n  b: number\n): T {`.
	if (/[(,]\s*$/.test(head)) {
		while (next < lines.length && next <= line + 6 && text.length < SIGNATURE_CHARS) {
			const part = lines[next++].trim();
			text += part.startsWith(')') ? part : ` ${part}`;
			if (part.includes(')')) {
				break;
			}
		}
	}
	if (/\b(?:class|interface|type|enum|struct|trait|protocol|record|object)\b/.test(head) && /\{\s*$/.test(text)) {
		const indent = /^\s*/.exec(lines[line])![0].length;
		const members: string[] = [];
		// Members sit at the depth of the first line inside; deeper lines are their bodies.
		let memberDepth: number | undefined;
		for (let i = line + 1; i < lines.length && members.length < MAX_MEMBERS; i++) {
			const raw = lines[i];
			if (!raw.trim()) {
				continue;
			}
			const depth = /^\s*/.exec(raw)![0].length;
			if (depth <= indent) {
				break;
			}
			memberDepth ??= depth;
			const member = raw.trim();
			if (depth === memberDepth && !/^(\/\/|\/?\*|#)/.test(member) && !/^[})\]]/.test(member)) {
				members.push(member.replace(/\s*\{\s*$/, ''));
			}
		}
		text = `${text} ${members.join(' ')}${members.length >= MAX_MEMBERS ? ' ...' : ''} }`;
	} else {
		text = text.replace(/\s*\{\s*$/, '');
	}
	return text.length <= SIGNATURE_CHARS ? text : `${text.slice(0, SIGNATURE_CHARS)}...`;
}

/**
 * Lines of `text` (terminal output, a log) that matter for the cursor's code: true when the text
 * names at least one of the rarer names around the cursor.
 */
export function mentionsAny(text: string, terms: ReadonlyMap<string, number>, minWeight = 1): boolean {
	for (const match of text.matchAll(NAME)) {
		const weight = terms.get(match[0]);
		if (weight !== undefined && weight >= minWeight && match[0].length >= 4) {
			return true;
		}
	}
	return false;
}
