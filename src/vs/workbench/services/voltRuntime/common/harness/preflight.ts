/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIntent } from './intent.js';

/**
 * The turn primer: what Volt gathers before an ACP agent's first model call, so the agent starts
 * where it would otherwise arrive after a dozen tool calls. Benchmarks (2026-10-09, Grok 4.7 on
 * cursor-agent) showed every run opening with the same exploration: list files, read each one,
 * find the start script, start the server, read its log, open the page. Each of those is a full
 * model call that re-reads ~16k tokens. Volt does them once, deterministically, and hands the
 * agent the result: the project's relevant files, the running app's URL in the chat's browser,
 * and the diagnostics the request implies (an accessibility audit when it asks for one, layout at
 * the widths it names).
 */
export interface IPreflightPlan {
	/** Find or start the app and open it in the chat's browser. */
	readonly browser: boolean;
	/** A throwaway draft: the project's code is not needed, a playground is. */
	readonly draft: boolean;
	/** Put the relevant project files in the primer. */
	readonly files: boolean;
	readonly a11y: boolean;
	/** Viewport widths to check the layout at; empty for none. */
	readonly widths: readonly number[];
	readonly perf: boolean;
}

const BROWSER_CHECK = /\b(?:browser|verify|verif(?:y|ies|ied)|check|test|confirm|make sure|see (?:if|whether|that)|preview|on (?:a|the) (?:page|screen)|in the app|end[- ]to[- ]end|e2e|sign ?up|log ?in|click(?:ing)?|scroll(?:s|ing)?|layout|overflow|responsive|accessib\w*|a11y|contrast)\b/i;
const DRAFT = /\b(?:prototype|draft|throwaway|throw-away|mock-?ups?|sandbox|playground|standalone|scratch page)\b/i;
const A11Y = /\b(?:accessib\w*|a11y|screen ?readers?|contrast|aria|wcag|keyboard (?:nav\w*|access\w*|users?))\b/i;
const LAYOUT = /\b(?:overflow\w*|responsive|layout|scroll(?:s|ing)? sideways|horizontal(?:ly)? scroll\w*|phones?|mobile|tablet|narrow|small screens?|viewport|breakpoints?)\b/i;
const PERF = /\b(?:slow|performance|perf|lcp|cls|load(?:ing)? time|speed (?:it )?up|janky|jank)\b/i;

export function preflightPlan(text: string, intent: IIntent): IPreflightPlan | undefined {
	if (!intent.uiWork || intent.lane === 'chat' || intent.lane === 'fast') {
		return undefined;
	}
	const draft = DRAFT.test(text);
	const widths = new Set<number>();
	for (const match of text.matchAll(/\b(\d{3,4})\s*(?:px|pixels?)\b/gi)) {
		const width = Number(match[1]);
		if (width >= 240 && width <= 3840) {
			widths.add(width);
		}
	}
	if (LAYOUT.test(text)) {
		if (!widths.size || /\b(?:phones?|mobile|small screens?|narrow)\b/i.test(text)) {
			if (![...widths].some(width => width <= 480)) {
				widths.add(375);
			}
		}
		if (/\b(?:tablet)\b/i.test(text)) {
			widths.add(768);
		}
		// "without changing the desktop layout": check the wide end too.
		if (![...widths].some(width => width >= 1024)) {
			widths.add(1280);
		}
	}
	return {
		browser: !draft && BROWSER_CHECK.test(text),
		draft,
		files: !draft,
		a11y: !draft && A11Y.test(text),
		widths: draft ? [] : [...widths].sort((a, b) => a - b).slice(0, 4),
		perf: !draft && PERF.test(text),
	};
}

//#region Project files

export interface IPrimerEntry {
	/** Relative to the project folder, with `/`. */
	readonly path: string;
	readonly size: number;
}

/** Folders that hold dependencies, builds, caches or VCS data, never the code an agent works on. */
export const PRIMER_SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.volt', '.cursor', 'bower_components', '.parcel-cache', '.output', 'tmp']);

const TEXT_EXTENSIONS = /\.(?:html?|css|scss|sass|less|m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|json|md|mdx|py|rb|go|rs|java|kt|swift|php|ya?ml|toml|ini|sh|sql|graphql|gql|txt|env\.example)$/i;
const FRONTEND = /\.(?:html?|css|scss|sass|less|m?[jt]sx?|vue|svelte|astro)$/i;
const NOISE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$|\.min\.(?:js|css)$|\.map$|\.snap$/i;
const STOPWORDS = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'your', 'you', 'are', 'was', 'were', 'have', 'has', 'not', 'but', 'when', 'what', 'which', 'then', 'than', 'them', 'they', 'there', 'their', 'its', 'can', 'could', 'should', 'would', 'will', 'just', 'also', 'any', 'all', 'each', 'every', 'one', 'two', 'make', 'sure', 'fix', 'find', 'check', 'verify', 'browser', 'page', 'app', 'work', 'works', 'working', 'does', 'doesn', 'don', 'how', 'why', 'out', 'after', 'before', 'without', 'while', 'only', 'some', 'like', 'want', 'need', 'please', 'it', 'is', 'in', 'on', 'of', 'to', 'a', 'an', 'or', 'be', 'so', 'if', 'at', 'by', 'as', 'we', 'me', 'my', 'our', 'us', 'thing', 'things', 'way', 'state', 'states', 'code', 'changing', 'change', 'show', 'see']);

export function primerCandidate(entry: IPrimerEntry): boolean {
	return TEXT_EXTENSIONS.test(entry.path) && !NOISE.test(entry.path) && entry.size > 0 && entry.size <= 64 * 1024;
}

export function promptKeywords(text: string): string[] {
	const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
	return [...new Set(words.filter(word => !STOPWORDS.has(word)))].slice(0, 40);
}

/**
 * Orders candidates by how likely the agent needs them: names the request mentions, then what
 * the files say, then the kind of file the work is about (front-end for UI work), entry points
 * and manifests. `contents` may hold the text of some or all of them.
 */
export function rankPrimerFiles(entries: readonly IPrimerEntry[], request: string, contents: ReadonlyMap<string, string>, uiWork: boolean): IPrimerEntry[] {
	const keywords = promptKeywords(request);
	const wantsTests = /\btests?\b|\bspec\b/i.test(request);
	const score = (entry: IPrimerEntry): number => {
		const path = entry.path.toLowerCase();
		const name = path.split('/').pop() ?? path;
		let total = 0;
		for (const word of keywords) {
			if (path.includes(word)) {
				total += 3;
			}
		}
		const text = contents.get(entry.path)?.toLowerCase();
		if (text) {
			total += keywords.filter(word => text.includes(word)).length;
		}
		if (uiWork && FRONTEND.test(path)) {
			total += 2;
		}
		if (/(?:^|\/)(?:src|app|public|pages|components|static|views|templates|client|web)\//.test(path)) {
			total += 1;
		}
		if (name === 'package.json' || name === 'pyproject.toml' || name === 'cargo.toml' || name === 'go.mod') {
			total += 3;
		}
		if (/^(?:server|app|main|index)\.[a-z]+$/.test(name)) {
			total += 1;
		}
		if (/(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[a-z]+$/.test(path) && !wantsTests) {
			total -= 2;
		}
		if (entry.size > 12 * 1024) {
			total -= 1;
		}
		return total;
	};
	return [...entries].map(entry => ({ entry, score: score(entry) })).sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path)).map(item => item.entry);
}

export interface IPrimerFiles {
	/** Files whose text is included, in reading order. */
	readonly included: readonly { readonly path: string; readonly text: string; readonly truncated: boolean }[];
	/** Every candidate path (for the listing), sorted. */
	readonly listing: readonly string[];
	readonly listingCut: number;
}

/**
 * Picks files for the primer within `budget` characters: everything when the project's code fits
 * (small apps), otherwise the best-ranked files, each cut at `perFile`.
 */
export function selectPrimerFiles(ranked: readonly IPrimerEntry[], contents: ReadonlyMap<string, string>, budget = 24_000, perFile = 9_000): IPrimerFiles {
	const included: { path: string; text: string; truncated: boolean }[] = [];
	let used = 0;
	for (const entry of ranked) {
		const text = contents.get(entry.path);
		if (text === undefined || used >= budget) {
			continue;
		}
		const room = Math.min(perFile, budget - used);
		if (room < 600 && text.length > room) {
			continue;
		}
		const cut = text.length > room;
		const kept = cut ? `${text.slice(0, room).replace(/\n[^\n]*$/, '')}\n… (cut here: ${text.length - room} more characters; read the file for the rest)` : text;
		included.push({ path: entry.path, text: kept, truncated: cut });
		used += kept.length;
	}
	const listing = ranked.map(entry => entry.path).sort();
	return { included: included.sort((a, b) => a.path.localeCompare(b.path)), listing: listing.slice(0, 200), listingCut: Math.max(0, listing.length - 200) };
}

export function formatPrimerFiles(files: IPrimerFiles): string | undefined {
	if (!files.included.length) {
		return undefined;
	}
	const whole = files.included.every(file => !file.truncated) && files.included.length === files.listing.length;
	const lines = [
		`[Volt] Project files, read just now (${whole ? 'the whole project' : `${files.included.length} most relevant of ${files.listing.length + files.listingCut}`}). They are current: work from them instead of listing, searching or re-reading these files.`,
	];
	if (!whole) {
		lines.push(`Other files: ${files.listing.filter(path => !files.included.some(file => file.path === path)).join(', ')}${files.listingCut ? `, and ${files.listingCut} more` : ''}`);
	}
	for (const file of files.included) {
		lines.push(`<file path="${file.path}">`, file.text.replace(/\n$/, ''), '</file>');
	}
	return lines.join('\n');
}

//#endregion
