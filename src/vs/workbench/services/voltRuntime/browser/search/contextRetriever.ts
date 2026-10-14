/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { bm25, idf, IPackInput, IRetrievalEvidence, packRetrieval, planRetrieval, rankEvidence, snippetsFor } from '../../common/search/contextRetrieval.js';

export { parsePorcelainZ } from '../../common/search/contextRetrieval.js';
import { VoltSearch } from './voltSearch.js';

/** Searches in flight at once; the index answers each in milliseconds, ripgrep in hundreds. */
const PARALLEL = 4;
/** Matching lines read per plain word: enough to tell a rare word from a common one. */
const TERM_MATCHES = 300;
/** Files kept per plain word, most matches first. */
const TERM_FILES = 40;
/** Plain-word hits weigh this much against declarations and named files. */
const TERM_SCALE = 0.5;
/** A prose-only message gets this many files, by path and reason, within this many tokens. */
const PROSE_FILES = 5;
const PROSE_BUDGET = 300;
/** Files read for snippets: the best few, never large ones. */
const SNIPPET_FILES = 5;
const SNIPPET_MAX_BYTES = 512 * 1024;
const RANKED_FILES = 8;

export interface IRetrieveOptions {
	/** Tokens the block may use. */
	readonly budgetTokens: number;
	/** Whatever is found by then is used; the rest is cancelled. */
	readonly deadlineMs: number;
	/** Code around each hit (Volt's own agent), or only the file list (CLI agents read files themselves). */
	readonly snippets: boolean;
	/** Files given with snippets earlier in this chat: listed again, without their code. */
	readonly seen?: ReadonlySet<string>;
	/** Workspace-relative paths the work tree has changed (they rank up). */
	readonly changed?: () => Promise<ReadonlySet<string>>;
	readonly token: CancellationToken;
}

export interface IRetrievedContext {
	readonly text: string;
	readonly tokens: number;
	readonly files: readonly string[];
	/** Files whose code the block shows. */
	readonly withCode: readonly string[];
	readonly ms: number;
	readonly searches: number;
	/** The deadline cut some searches short. */
	readonly partial: boolean;
}

/**
 * Turns a user message into a short, budgeted list of the code it is about, before the agent's
 * first step: what the message names is looked up narrowly first (declarations, named files,
 * quoted errors), and only names with no declaration are searched as text. Runs alongside the
 * turn's other preparation, so it costs no time unless the searches outlast it.
 */
export class ContextRetriever {

	constructor(
		private readonly search: VoltSearch,
		private readonly fileService: IFileService,
	) { }

	async retrieve(root: URI, message: string, options: IRetrieveOptions): Promise<IRetrievedContext | undefined> {
		const started = Date.now();
		const plan = planRetrieval(message);
		if (!plan) {
			return undefined;
		}
		const cts = new CancellationTokenSource(options.token);
		let partial = false;
		const deadline = setTimeout(() => {
			partial = true;
			cts.cancel();
		}, options.deadlineMs);
		const token = cts.token;
		// Started now, used after the searches: it only re-ranks what they find.
		const changedRead = options.changed?.().catch(() => undefined);
		const files = plan.terms.length ? this.search.fileCount(root).catch(() => undefined) : Promise.resolve(undefined);
		const evidence: IRetrievalEvidence[] = [];
		let searches = 0;
		const run = semaphore(PARALLEL);
		const attempt = (fn: () => Promise<void>) => run(async () => {
			if (token.isCancellationRequested) {
				return;
			}
			searches++;
			await fn().catch(() => undefined);
		});
		// Stops waiting at the deadline; searches still running are cancelled and their results dropped.
		const settle = (work: Promise<unknown>) => Promise.race([work, new Promise<void>(resolve => token.onCancellationRequested(() => resolve()))]);

		try {
			// Narrow: what the message names exactly.
			const declared = new Set<string>();
			const lineOf = new Map(plan.locations.map(location => [location.path, location.line]));
			await settle(Promise.all([
				...plan.identifiers.map(name => attempt(async () => {
					const found = await this.search.symbols({ root, name, match: 'exact', limit: 5 }, token);
					for (const symbol of found.symbols) {
						evidence.push({ path: symbol.path, kind: 'declaration', line: symbol.line, term: name, text: symbol.text });
						declared.add(name);
					}
				})),
				...plan.paths.map(path => attempt(async () => {
					const line = lineOf.get(path);
					const name = path.split('/').pop()!;
					const parts = path.replace(/^(\.\.\/)+/, '').split('/');
					// An absolute path (a stack trace) holds folders above the project: try its tail too.
					let found = parts.length > 1 ? await this.search.glob({ root, folder: root, pattern: `**/${parts.join('/')}`, limit: 3 }, token) : undefined;
					if (!found?.paths.length && parts.length > 2) {
						found = await this.search.glob({ root, folder: root, pattern: `**/${parts.slice(-2).join('/')}`, limit: 3 }, token);
					}
					if (!found?.paths.length) {
						found = await this.search.findFiles({ root, query: name, limit: 5 }, token);
					}
					// A named file is that file: fuzzy neighbours are not evidence.
					for (const hit of found.paths.filter(hit => hit === path || hit.endsWith(`/${path}`) || hit.split('/').pop() === name).slice(0, 3)) {
						evidence.push({ path: hit, kind: line ? 'location' : 'mentioned', ...(line ? { line } : {}), term: name });
					}
				})),
				// BM25 over the plain words: contents (match counts as term frequency) and paths (double).
				...plan.terms.map(term => attempt(async () => {
					const [content, names, total] = await Promise.all([
						this.search.grep({ root, folder: root, pattern: term, literal: true, maxMatches: TERM_MATCHES }, token),
						this.search.findFiles({ root, query: term, limit: 30 }, token),
						files,
					]);
					const inPath = names.paths.filter(path => path.toLowerCase().includes(term));
					// A word with more matching lines than were read is common: count it as widespread.
					const df = Math.max(1, content.limitHit ? content.files.length * 3 : content.files.length, inPath.length);
					const n = total ?? 10_000;
					const rarity = idf(df, n);
					const hits = new Map<string, { tf: number; line?: number; path: boolean }>();
					for (const file of [...content.files].sort((a, b) => b.matches - a.matches).slice(0, TERM_FILES)) {
						const first = [...file.lines].find(([, hit]) => hit.match)?.[0];
						hits.set(file.path, { tf: file.matches, ...(first ? { line: first } : {}), path: false });
					}
					for (const path of inPath) {
						const hit = hits.get(path);
						hits.set(path, { tf: hit?.tf ?? 0, ...(hit?.line ? { line: hit.line } : {}), path: true });
					}
					for (const [path, hit] of hits) {
						const weight = TERM_SCALE * ((hit.tf ? bm25(hit.tf, df, n) : 0) + (hit.path ? 2 * rarity : 0));
						evidence.push({ path, kind: 'term', term, weight, ...(hit.line ? { line: hit.line } : {}) });
					}
				})),
				...plan.phrases.map(phrase => attempt(async () => {
					const found = await this.search.grep({ root, folder: root, pattern: phrase, literal: true, maxMatches: 10 }, token);
					for (const file of found.files) {
						for (const [line, hit] of [...file.lines].filter(([, hit]) => hit.match).slice(0, 2)) {
							evidence.push({ path: file.path, kind: 'phrase', line, term: phrase, text: hit.text, spread: found.files.length });
						}
					}
				})),
			]));

			// Broader, only where the narrow pass found nothing: names with no declaration, as whole
			// words; plus the uses of the first declared name (its callers matter to an edit).
			const undeclared = plan.identifiers.filter(name => !declared.has(name)).slice(0, 3);
			const firstDeclared = plan.identifiers.find(name => declared.has(name));
			const broad = [...undeclared, ...(firstDeclared ? [firstDeclared] : [])];
			if (broad.length && !token.isCancellationRequested) {
				await settle(Promise.all(broad.map(name => attempt(async () => {
					const found = await this.search.grep({ root, folder: root, pattern: name, literal: true, wholeWord: true, caseSensitive: true, maxMatches: 40 }, token);
					const spread = found.limitHit ? Math.max(found.files.length, 40) : found.files.length;
					for (const file of found.files.slice(0, 8)) {
						for (const [line, hit] of [...file.lines].filter(([, hit]) => hit.match).slice(0, 2)) {
							evidence.push({ path: file.path, kind: 'match', line, term: name, text: hit.text, spread });
						}
					}
				}))));
			}
			if (!evidence.length) {
				return undefined;
			}
			const changed = changedRead ? await Promise.race([changedRead, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 100))]) : undefined;
			// A file found only by plain words needs two of them, one in its path: words in contents
			// alone (`chat`, `settings`) match thousands of lines and measured as noise.
			const ranked = rankEvidence(evidence, { wantsTests: plan.wantsTests, ...(changed ? { changed } : {}) })
				.filter(file => file.evidence.some(item => item.kind !== 'term') || (new Set(file.evidence.map(item => item.term)).size >= Math.min(2, plan.terms.length) && termInPath(file.path, file.evidence)))
				.slice(0, RANKED_FILES);
			if (!ranked.length) {
				return undefined;
			}
			// A message in prose is weaker evidence than a named symbol or file: point at the best few
			// files (their paths and why) without their code, for a fraction of the tokens.
			const proseOnly = !plan.identifiers.length && !plan.paths.length && !plan.phrases.length;
			const shown = proseOnly ? ranked.slice(0, PROSE_FILES) : ranked;
			const inputs: IPackInput[] = await Promise.all(shown.map(async (file, i): Promise<IPackInput> => {
				if (!options.snippets || proseOnly || i >= SNIPPET_FILES || options.seen?.has(file.path) || !file.evidence.some(item => item.line)) {
					return { file, snippets: [] };
				}
				const lines = await this.fileService.readFile(joinPath(root, file.path), { limits: { size: SNIPPET_MAX_BYTES } })
					.then(content => content.value.toString().split(/\r?\n/), () => undefined);
				return { file, snippets: lines ? snippetsFor(file, lines) : [] };
			}));
			const packed = packRetrieval(inputs, proseOnly ? Math.min(options.budgetTokens, PROSE_BUDGET) : options.budgetTokens, { partial });
			if (!packed) {
				return undefined;
			}
			return {
				...packed,
				ms: Date.now() - started,
				searches,
				partial,
			};
		} finally {
			clearTimeout(deadline);
			cts.dispose(true);
		}
	}
}

/** One of the file's plain-word hits is in its path, not only its contents. */
function termInPath(path: string, evidence: readonly IRetrievalEvidence[]): boolean {
	const lower = path.toLowerCase();
	return evidence.some(item => item.kind === 'term' && !!item.term && lower.includes(item.term));
}

function semaphore(limit: number): (task: () => Promise<void>) => Promise<void> {
	let running = 0;
	const queue: (() => void)[] = [];
	return async task => {
		if (running >= limit) {
			await new Promise<void>(resolve => queue.push(resolve));
		}
		running++;
		try {
			await task();
		} finally {
			running--;
			queue.shift()?.();
		}
	};
}
