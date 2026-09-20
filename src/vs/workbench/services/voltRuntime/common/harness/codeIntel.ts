/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code intelligence, kept deterministic and model-free. A real LSP index lives in the
 * workbench; this module ranks *what we already know* so the context pack and the planner
 * can prefer `src/login.ts` over `README.md` without a round trip.
 *
 * Impact is a graph walk: if A imports B and B is changing, A is in the blast radius.
 * That is enough to tell the verifier which tests to run first, and enough to tell the
 * model which files it should re-read after an edit.
 */

export interface ICodeFile {
	readonly path: string;
	readonly language?: string;
	readonly size?: number;
	readonly imports?: readonly string[];
	readonly exported?: readonly string[];
}

export interface IRelevanceHit {
	readonly path: string;
	readonly score: number;
	readonly reasons: readonly string[];
}

export interface IImpactReport {
	readonly changed: readonly string[];
	readonly affected: readonly string[];
	readonly tests: readonly string[];
}

const TEST_RE = /(?:\.test|\.spec|\/__tests__\/|\/tests?\/)/i;

const WEIGHT = {
	exactPath: 1,
	basename: 0.7,
	token: 0.15,
	import: 0.25,
	exportHit: 0.35,
	language: 0.05,
} as const;

export function rankFiles(query: string, files: readonly ICodeFile[], limit = 12): IRelevanceHit[] {
	const tokens = tokenize(query);
	const hits = files.map(file => scoreFile(file, query, tokens)).filter(hit => hit.score > 0);
	return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

export function impactOf(changed: readonly string[], files: readonly ICodeFile[]): IImpactReport {
	const byPath = new Map(files.map(file => [normalize(file.path), file]));
	const changedSet = new Set(changed.map(normalize));
	const affected = new Set<string>(changedSet);

	// Reverse imports: a file that imports a changed file is affected.
	for (const file of files) {
		for (const imported of file.imports ?? []) {
			if (changedSet.has(normalize(imported)) || matchesBasename(changedSet, imported)) {
				affected.add(normalize(file.path));
			}
		}
	}

	const tests = files
		.map(file => normalize(file.path))
		.filter(path => TEST_RE.test(path) && (affected.has(path) || looksLikeTestFor(path, changedSet, byPath)));
	return {
		changed: [...changedSet],
		affected: [...affected].filter(path => !changedSet.has(path)).sort(),
		tests: [...new Set(tests)].sort(),
	};
}

export function languageOf(path: string): string | undefined {
	const ext = path.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'ts':
		case 'tsx': return 'typescript';
		case 'js':
		case 'jsx':
		case 'mjs':
		case 'cjs': return 'javascript';
		case 'py': return 'python';
		case 'rs': return 'rust';
		case 'go': return 'go';
		case 'json': return 'json';
		case 'md': return 'markdown';
		case 'css':
		case 'scss': return 'css';
		default: return undefined;
	}
}

function scoreFile(file: ICodeFile, query: string, tokens: readonly string[]): IRelevanceHit {
	const path = normalize(file.path);
	const base = basename(path);
	const reasons: string[] = [];
	let score = 0;

	const q = query.trim().toLowerCase();
	if (q && path.toLowerCase().includes(q)) {
		score += WEIGHT.exactPath;
		reasons.push('path matches the request');
	} else if (q && base.toLowerCase().includes(q)) {
		score += WEIGHT.basename;
		reasons.push('filename matches the request');
	}

	const hay = `${path} ${(file.exported ?? []).join(' ')}`.toLowerCase();
	const tokenHits = tokens.filter(token => hay.includes(token));
	if (tokenHits.length) {
		score += Math.min(0.6, tokenHits.length * WEIGHT.token);
		reasons.push(`mentions ${tokenHits.slice(0, 3).join(', ')}`);
	}

	const exportHit = (file.exported ?? []).some(name => tokens.includes(name.toLowerCase()));
	if (exportHit) {
		score += WEIGHT.exportHit;
		reasons.push('exports a named symbol from the request');
	}

	if (file.language && tokens.includes(file.language)) {
		score += WEIGHT.language;
	}

	return { path: file.path, score: round2(Math.min(1, score)), reasons };
}

function looksLikeTestFor(path: string, changed: ReadonlySet<string>, byPath: Map<string, ICodeFile>): boolean {
	if (!TEST_RE.test(path)) {
		return false;
	}
	const stem = basename(path).replace(/\.(test|spec)\.[a-z]+$/i, '');
	for (const change of changed) {
		if (basename(change).replace(/\.[a-z]+$/i, '') === stem) {
			return true;
		}
		const file = byPath.get(change);
		if (file?.exported?.some(name => path.toLowerCase().includes(name.toLowerCase()))) {
			return true;
		}
	}
	return false;
}

function matchesBasename(changed: ReadonlySet<string>, imported: string): boolean {
	const base = basename(normalize(imported));
	for (const path of changed) {
		if (basename(path) === base || basename(path).replace(/\.[a-z]+$/i, '') === base.replace(/\.[a-z]+$/i, '')) {
			return true;
		}
	}
	return false;
}

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9_./-]+/).filter(token => token.length > 1);
}

function normalize(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basename(path: string): string {
	return path.split('/').pop() ?? path;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
