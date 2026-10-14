/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { estimateTokens } from '../harness/contextEngine.js';

/**
 * The search-to-context pipeline, model-free and pure: what a message names (planRetrieval), how
 * the search hits for it rank (rankEvidence), and what fits the token budget (packRetrieval).
 * The browser side runs the searches in between. Precision over recall: a message that names
 * nothing code-like retrieves nothing, and every block tells the model it may be incomplete.
 */

export interface IRetrievalPlan {
	/** Code identifiers, most specific first: looked up as declarations, then as text. */
	readonly identifiers: readonly string[];
	/** File paths or names the message mentions. */
	readonly paths: readonly string[];
	/** `path:line` locations (stack traces, compiler errors). */
	readonly locations: readonly { readonly path: string; readonly line: number }[];
	/** Quoted text or error messages, searched literally. */
	readonly phrases: readonly string[];
	/** The message is about tests: test files rank higher. */
	readonly wantsTests: boolean;
	/** Plain words (stemmed, no stop words), scored with BM25 over paths and contents. */
	readonly terms: readonly string[];
}

const MAX_IDENTIFIERS = 6;
const MAX_TERMS = 6;
/** English and request words that name no part of a codebase. */
const STOP_TERMS = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'when', 'then', 'than', 'what', 'which', 'where', 'while', 'why', 'how',
	'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did', 'doing', 'not', 'but', 'all', 'any', 'each', 'every', 'some', 'more',
	'most', 'other', 'such', 'only', 'own', 'same', 'too', 'very', 'can', 'will', 'just', 'should', 'would', 'could', 'might', 'must', 'shall', 'also',
	'there', 'here', 'their', 'them', 'they', 'its', 'our', 'your', 'you', 'his', 'her', 'one', 'two', 'out', 'off', 'over', 'under', 'again',
	'about', 'above', 'below', 'after', 'before', 'between', 'through', 'during', 'without', 'within', 'like', 'please', 'want', 'need', 'make',
	'made', 'get', 'got', 'set', 'let', 'use', 'used', 'using', 'add', 'added', 'adds', 'fix', 'fixed', 'fixes', 'update', 'updated', 'updates',
	'change', 'changed', 'changes', 'remove', 'removed', 'support', 'supports', 'implement', 'implemented', 'feat', 'chore', 'refactor', 'docs',
	'new', 'old', 'now', 'still', 'way', 'thing', 'things', 'something', 'stuff', 'work', 'works', 'working', 'issue', 'bug', 'bugs', 'code',
	'file', 'files', 'line', 'lines', 'function', 'method', 'class', 'type', 'value', 'name', 'list', 'show', 'shows', 'see', 'look', 'check',
	'try', 'keep', 'kept', 'stay', 'stays', 'goes', 'come', 'comes', 'take', 'takes', 'give', 'gives', 'first', 'last', 'next', 'even', 'well',
	'yes', 'okay', 'thanks', 'sure', 'right', 'wrong', 'good', 'bad', 'better', 'best', 'instead', 'already', 'always', 'never', 'often',
]);

/** A light stemmer: plurals and -ing/-ed fold together, so "terminals" finds "terminal" as a substring. */
export function stemTerm(word: string): string {
	for (const suffix of ['ing', 'ed', 'es', 's']) {
		if (word.endsWith(suffix) && word.length - suffix.length >= 4 && !word.endsWith('ss')) {
			const stem = word.slice(0, -suffix.length);
			// dragging -> dragg -> drag; but roll, pass, buzz and stuff keep their doubles.
			const last = stem[stem.length - 1];
			return suffix.length >= 2 && suffix !== 'es' && last === stem[stem.length - 2] && !'lsfz'.includes(last) && stem.length > 4 ? stem.slice(0, -1) : stem;
		}
	}
	return word;
}
const MAX_PATHS = 6;
const MAX_PHRASES = 2;

const FILE_EXT = 'ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|swift|m|mm|dart|vue|svelte|css|scss|less|html|json|jsonc|yaml|yml|toml|md|mdx|sql|sh|bash|zsh|proto|graphql|gql|xml|gradle|tf|ex|exs|erl|scala|clj|lua|r|jl|zig|nim';
/** `src/a/b.ts`, `./b.ts`, `src\\a\\b.ts` (Windows), `b.test.ts`, with an optional `:line(:col)`. */
const PATH_RE = new RegExp(`(?:^|[\\s(\`'"\\[])((?:[A-Za-z]:)?(?:\\.{0,2}[\\\\/])?(?:[\\w@.-]+[\\\\/])*[\\w@.-]+\\.(?:${FILE_EXT}))(?::(\\d+))?(?::\\d+)?(?=$|[\\s)\`'",;:\\]])`, 'gi');
const BARE_NAMES = new Set(['Dockerfile', 'Makefile', 'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Gemfile', 'docker-compose.yml', 'docker-compose.yaml', '.env.example']);
/** Words that look like code but say nothing about this project. */
const COMMON = new Set([
	'TODO', 'FIXME', 'README', 'JSON', 'HTML', 'HTTP', 'HTTPS', 'URL', 'URI', 'API', 'APIs', 'CSS', 'SQL', 'UUID', 'ASCII', 'UTF', 'CLI', 'SDK', 'CI', 'PR',
	'JavaScript', 'TypeScript', 'GitHub', 'GitLab', 'NodeJS', 'macOS', 'iOS', 'npm', 'pnpm', 'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef',
	'console.log', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'undefined', 'null',
	'async', 'await', 'function', 'return', 'const', 'import', 'export', 'default', 'class', 'interface', 'readonly', 'private', 'public', 'static', 'true', 'false',
	'OpenAI', 'ChatGPT', 'VSCode', 'YouTube', 'LinkedIn', 'PostgreSQL', 'MongoDB', 'GraphQL', 'WebSocket', 'OAuth', 'IntelliJ', 'DevTools', 'PowerShell',
]);

/** How code-like a word is: 0 for prose, more for shapes only code has. */
function identifierScore(word: string): number {
	if (word.length < 4 || COMMON.has(word) || /^\d/.test(word)) {
		return 0;
	}
	const humps = (word.match(/[a-z\d][A-Z]/g) ?? []).length;
	if (word.includes('_') && /[a-z]/i.test(word.replace(/_/g, '')) && !/^_+$/.test(word)) {
		return /^[A-Z\d_]+$/.test(word) ? (word.split('_').filter(Boolean).length >= 2 ? 2 : 0) : 3; // SCREAMING_CASE / snake_case
	}
	if (humps >= 1 && /^[a-z]/.test(word)) {
		return 2 + Math.min(humps, 3); // camelCase
	}
	if (humps >= 1 && /^[A-Z]/.test(word)) {
		return 2 + Math.min(humps, 3); // PascalCase with more than one word
	}
	return 0;
}

export function planRetrieval(text: string): IRetrievalPlan | undefined {
	if (!text || text.length > 40_000) {
		return undefined;
	}
	const identifiers = new Map<string, number>();
	const paths: string[] = [];
	const locations: { path: string; line: number }[] = [];
	const phrases: string[] = [];
	const addIdentifier = (word: string, bonus: number) => {
		const clean = word.replace(/^[^\w$]+|[^\w$]+$/g, '');
		const score = identifierScore(clean);
		if (score || bonus >= 3) {
			if (clean.length >= 3 && !COMMON.has(clean)) {
				identifiers.set(clean, Math.max(identifiers.get(clean) ?? 0, score + bonus));
			}
		}
	};

	for (const match of text.matchAll(PATH_RE)) {
		// Windows separators and drive letters: the search matches paths relative to the project,
		// so an absolute path keeps its last parts (`C:\\repo\\src\\a.ts` -> `repo/src/a.ts`).
		const path = match[1].replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
		if (/^\d+(\.\d+)+$/.test(path) || /^https?:/i.test(path) || /^[A-Z][\w]*\.js$/.test(path)) {
			continue; // a version number, a URL, or a product name (Node.js, Next.js)
		}
		if (match[2]) {
			locations.push({ path, line: Number(match[2]) });
		}
		if (!paths.includes(path)) {
			paths.push(path);
		}
	}
	for (const word of text.split(/[\s,;()[\]{}<>"'`]+/)) {
		if (BARE_NAMES.has(word) && !paths.includes(word)) {
			paths.push(word);
		}
	}
	// Identifiers come from the prose: the folders of a path are not things to look up.
	const prose = text.replace(PATH_RE, ' ');
	// `code spans` are the user saying "this exact thing".
	for (const span of prose.matchAll(/`([^`\n]{2,80})`/g)) {
		const inner = span[1].trim();
		if (/^[\w$.]+(\(\))?$/.test(inner)) {
			for (const part of inner.replace(/\(\)$/, '').split('.')) {
				addIdentifier(part, 3);
			}
		}
	}
	// An empty call written as code, `flush()`, names a function even when it is a plain word.
	// With arguments it must look like code itself: `feat(agent):` and "fix (the bug)" are prose.
	for (const call of prose.matchAll(/\b([A-Za-z_$][\w$]{2,})\((\)?)/g)) {
		addIdentifier(call[1], call[2] ? 3 : 1);
	}
	for (const word of prose.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		for (const part of word[0].split('.')) {
			addIdentifier(part, 0);
		}
	}
	for (const quoted of text.matchAll(/"([^"\n]{6,120})"|'([^'\n]{6,120})'/g)) {
		const phrase = (quoted[1] ?? quoted[2]).trim();
		if (/\s/.test(phrase) && phrases.length < MAX_PHRASES) {
			phrases.push(phrase);
		}
	}
	// An error message on its own line: `TypeError: x is not a function`.
	for (const line of text.split('\n')) {
		const error = /^\s*(?:Uncaught\s+)?(?:\w+Error|Error|error(?:\[\w+\])?|panic):\s*(.{6,120})$/.exec(line);
		if (error && phrases.length < MAX_PHRASES && !phrases.includes(error[1].trim())) {
			phrases.push(error[1].trim());
		}
	}
	const pathNames = new Set(paths.map(path => path.split('/').pop()!.replace(/\.[^.]+$/, '')));
	const ranked = [...identifiers.entries()]
		.filter(([name]) => !pathNames.has(name))
		.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
		.slice(0, MAX_IDENTIFIERS)
		.map(([name]) => name);
	// Plain words, for messages in prose: longer words say more, so they go first.
	const taken = new Set([...ranked, ...pathNames].map(name => name.toLowerCase()));
	const terms: string[] = [];
	for (const word of prose.replace(/`[^`]*`/g, ' ').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
		const term = stemTerm(word);
		if (!STOP_TERMS.has(word) && !STOP_TERMS.has(term) && term.length >= 4 && !taken.has(word) && !terms.includes(term)) {
			terms.push(term);
		}
	}
	terms.sort((a, b) => b.length - a.length);
	const wordTerms = terms.slice(0, MAX_TERMS);
	// One plain word alone is too vague to search for ("fix the layout").
	if (!ranked.length && !paths.length && !phrases.length && wordTerms.length < 2) {
		return undefined;
	}
	return {
		identifiers: ranked,
		paths: paths.slice(0, MAX_PATHS),
		locations: locations.slice(0, MAX_PATHS),
		phrases,
		wantsTests: /\b(tests?|specs?|unit test|failing test|jest|vitest|mocha|pytest)\b/i.test(text),
		terms: wordTerms,
	};
}

/** BM25's inverse document frequency: a word in few of `files` says much. */
export function idf(df: number, files: number): number {
	return Math.log(1 + (Math.max(files, df) - df + 0.5) / (df + 0.5));
}

/** BM25 term weight with no length normalization (b = 0): file sizes are not known here. */
export function bm25(tf: number, df: number, files: number, k1 = 1.2): number {
	return idf(df, files) * (tf * (k1 + 1)) / (tf + k1);
}

export type EvidenceKind = 'location' | 'mentioned' | 'declaration' | 'match' | 'phrase' | 'term';

export interface IRetrievalEvidence {
	/** Workspace-relative. */
	readonly path: string;
	readonly kind: EvidenceKind;
	readonly line?: number;
	/** The identifier or phrase that found it. */
	readonly term?: string;
	/** The declaring or matching line. */
	readonly text?: string;
	/** For matches: how many files the term matched (fewer: more specific). */
	readonly spread?: number;
	/** For plain-word terms: the BM25 weight this hit carries (path hits weigh double). */
	readonly weight?: number;
}

export interface IRankedFile {
	readonly path: string;
	readonly score: number;
	readonly evidence: readonly IRetrievalEvidence[];
}

const KIND_WEIGHT: Record<EvidenceKind, number> = { location: 12, mentioned: 10, declaration: 8, phrase: 6, match: 3, term: 1 };
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$|_test\.(go|py)$/i;
const GENERATED_PATH = /(^|\/)(dist|build|out|coverage|vendor|\.next|target|__generated__|generated)\/|\.min\.(js|css)$|\.d\.ts$|\.lock$|-lock\.json$/i;

/**
 * One score per file: the strongest kinds of evidence count fully, repeats less; a term found in
 * many files counts little; tests rank up only when the message is about tests; generated and
 * vendored files rank down; files the work tree changed rank up (they are what is in progress).
 */
export function rankEvidence(evidence: readonly IRetrievalEvidence[], options: { readonly wantsTests: boolean; readonly changed?: ReadonlySet<string> }): IRankedFile[] {
	const byPath = new Map<string, IRetrievalEvidence[]>();
	for (const item of evidence) {
		const list = byPath.get(item.path) ?? [];
		if (!list.some(existing => existing.kind === item.kind && existing.line === item.line && existing.term === item.term)) {
			list.push(item);
		}
		byPath.set(item.path, list);
	}
	const ranked: IRankedFile[] = [];
	for (const [path, items] of byPath) {
		let score = 0;
		const seenTerms = new Set<string>();
		for (const item of [...items].sort((a, b) => KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind])) {
			let weight = item.kind === 'term' ? item.weight ?? KIND_WEIGHT.term : KIND_WEIGHT[item.kind];
			if (item.kind === 'match' && item.spread) {
				weight *= 1 / Math.log2(1 + item.spread);
			}
			// A second hit for the same term in the same file adds little.
			const key = `${item.kind}:${item.term ?? ''}`;
			score += seenTerms.has(key) ? weight * 0.15 : weight;
			seenTerms.add(key);
		}
		// Different terms meeting in one file is the strongest signal of all.
		const terms = new Set(items.map(item => item.term).filter(Boolean));
		score *= 1 + Math.max(0, terms.size - 1) * 0.35;
		const isTest = TEST_PATH.test(path);
		if (isTest) {
			score *= options.wantsTests ? 1.3 : 0.6;
		}
		if (GENERATED_PATH.test(path)) {
			score *= 0.3;
		}
		if (options.changed?.has(path)) {
			score *= 1.25;
		}
		ranked.push({ path, score, evidence: items });
	}
	return ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
}

export interface ISnippet {
	/** 1-based, inclusive. */
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
}

/** Windows of `around` lines at each evidence line, merged where they touch, at most `maxLines` in all. */
export function snippetsFor(file: IRankedFile, lines: readonly string[], around = 3, maxLines = 24): ISnippet[] {
	const anchors = [...new Set(file.evidence.map(item => item.line).filter((line): line is number => !!line && line <= lines.length))].sort((a, b) => a - b);
	const windows: { start: number; end: number }[] = [];
	for (const line of anchors) {
		const start = Math.max(1, line - around);
		const end = Math.min(lines.length, line + around);
		const last = windows.at(-1);
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			windows.push({ start, end });
		}
	}
	const out: ISnippet[] = [];
	let used = 0;
	for (const window of windows) {
		const room = maxLines - used;
		if (room <= 2) {
			break;
		}
		const end = Math.min(window.end, window.start + room - 1);
		out.push({ start: window.start, end, lines: lines.slice(window.start - 1, end).map(line => line.length > 200 ? `${line.slice(0, 200)}\u2026` : line) });
		used += end - window.start + 1;
	}
	return out;
}

export interface IPackInput {
	readonly file: IRankedFile;
	readonly snippets: readonly ISnippet[];
}

export interface IPackedRetrieval {
	readonly text: string;
	readonly tokens: number;
	/** Files in the block, in order. */
	readonly files: readonly string[];
	/** Of those, the ones shown with their code (the rest by headline alone). */
	readonly withCode: readonly string[];
}

function headline(file: IRankedFile): string {
	const reasons: string[] = [];
	for (const item of file.evidence) {
		const reason = item.kind === 'declaration' ? `declares ${item.term}${item.line ? ` (line ${item.line})` : ''}`
			: item.kind === 'location' ? `line ${item.line} (from your message)`
				: item.kind === 'mentioned' ? 'named in your message'
					: item.kind === 'phrase' ? `contains "${(item.term ?? '').slice(0, 40)}"`
						: item.kind === 'term' ? `mentions "${item.term}"`
							: `uses ${item.term}`;
		if (!reasons.includes(reason)) {
			reasons.push(reason);
		}
		if (reasons.length >= 3) {
			break;
		}
	}
	return `${file.path} - ${reasons.join('; ')}`;
}

/**
 * The block given to the model, best files first, within `budgetTokens`: a file whose snippets do
 * not fit is listed by its headline alone, and listing stops when even that does not fit.
 */
export function packRetrieval(inputs: readonly IPackInput[], budgetTokens: number, options: { readonly partial?: boolean } = {}): IPackedRetrieval | undefined {
	const head = `<volt_context note="Volt searched the project for what this message names${options.partial ? ' (cut short by its time limit)' : ''}. Starting points, not the whole picture: read a file before editing it.">`;
	const tail = '</volt_context>';
	let tokens = estimateTokens(head) + estimateTokens(tail);
	const parts: string[] = [];
	const files: string[] = [];
	const withCode: string[] = [];
	for (const { file, snippets } of inputs) {
		const title = headline(file);
		const body = snippets.map(snippet => snippet.lines.map((line, i) => `${String(snippet.start + i).padStart(5)}| ${line}`).join('\n')).join('\n  \u2026\n');
		const full = body ? `${title}\n${body}` : title;
		const cost = estimateTokens(full) + 1;
		if (tokens + cost <= budgetTokens) {
			parts.push(full);
			tokens += cost;
			files.push(file.path);
			if (body) {
				withCode.push(file.path);
			}
			continue;
		}
		const short = estimateTokens(title) + 1;
		if (tokens + short <= budgetTokens) {
			parts.push(title);
			tokens += short;
			files.push(file.path);
			continue;
		}
		break;
	}
	if (!parts.length) {
		return undefined;
	}
	return { text: [head, ...parts, tail].join('\n'), tokens, files, withCode };
}

/** `git status --porcelain=v1 -z` -> workspace-relative paths of changed files. */
export function parsePorcelainZ(output: string): Set<string> {
	const paths = new Set<string>();
	const entries = output.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) {
			continue;
		}
		const status = entry.slice(0, 2);
		paths.add(entry.slice(3));
		if (status[0] === 'R' || status[0] === 'C') {
			i++; // the next entry is the rename's source
		}
	}
	return paths;
}
