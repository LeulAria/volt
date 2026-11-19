/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeLocation, ICodeNavIndex, ICodeSymbol } from './codeTools.js';
import { ISearchIndex } from './searchTools.js';
import { displayPath } from './workspacePath.js';

const MAX_DEFINITIONS = 20;
const MAX_REFERENCES = 300;
const MAX_IMPORTERS = 200;
/** A first query may wait this long for the index to load (it is not built just for it). */
const STRUCTURE_WAIT_MS = 8_000;

const HASH_COMMENTS = /\.(?:py|pyi|rb|sh|bash|zsh|ya?ml|toml|pl|r|ex|exs)$/i;

/**
 * Whether a line uses `name` as code: not only inside a comment or a quoted string. The index
 * matches whole words in text, so "references" by name listed `// LineTotal is the price of one
 * line` and `t.Fatalf("LineTotal = %v", got)` next to the calls. Judged per line: a block comment's
 * inner lines are caught by their leading `*`, a multi-line string is not.
 */
export function isCodeUse(line: string, name: string, path: string): boolean {
	const hash = HASH_COMMENTS.test(path);
	const trimmed = line.trimStart();
	if (hash ? trimmed.startsWith('#') : /^(?:\/\/|\/\*|\*(?:\s|\/|$))/.test(trimmed)) {
		return false;
	}
	const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g');
	const uses = [...line.matchAll(word)].map(match => match.index);
	if (!uses.length) {
		return true; // not our match to judge (a regex or multi-line hit)
	}
	let quote = '';
	let next = 0;
	for (let index = 0; index < line.length && next < uses.length; index++) {
		const char = line[index];
		if (index === uses[next]) {
			if (!quote) {
				return true;
			}
			next++;
		}
		if (quote) {
			if (char === '\\') {
				index++;
			} else if (char === quote) {
				quote = '';
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (hash ? char === '#' : char === '/' && line[index + 1] === '/') {
			return false; // the rest is a trailing comment
		}
	}
	return false;
}

/** code_nav by name, from the code index: declarations, whole-word uses, and a file's outline. */
export function createCodeIndexNav(index: ISearchIndex): ICodeNavIndex {
	const usable = (root: URI) => root.scheme === Schemas.file && index.enabled();
	return {
		definitions: async (root, name) => {
			if (!usable(root)) {
				return []; // off, not loading: nothing to wait for (see onceIndexed)
			}
			const result = await index.service.symbols({ root: root.fsPath, query: name, match: 'exact', limit: MAX_DEFINITIONS, options: index.options() }).catch(() => undefined);
			if (result?.kind !== 'results') {
				return undefined;
			}
			return result.symbols.map((symbol): ICodeLocation => ({ uri: joinPath(root, symbol.path), line: symbol.line, column: symbol.column ?? 1, preview: symbol.text }));
		},
		references: async (root, name) => {
			if (!usable(root) || !/^[\w$]+$/.test(name)) {
				return [];
			}
			const result = await index.service.search({
				root: root.fsPath,
				pattern: `\\b${name.replace(/\$/g, '\\$')}\\b`,
				isRegExp: true,
				caseSensitive: true,
				multiline: false,
				maxMatches: MAX_REFERENCES,
				options: index.options(),
			}).catch(() => undefined);
			if (result?.kind !== 'results') {
				return undefined;
			}
			return result.files.flatMap(file => file.lines.filter(line => line.match && isCodeUse(line.text, name, file.path)).map((line): ICodeLocation => ({
				uri: joinPath(root, file.path),
				line: line.line,
				column: Math.max(1, line.text.indexOf(name) + 1),
				preview: line.text.trim().slice(0, 160),
			})));
		},
		implementations: async (root, name) => {
			if (!usable(root) || !/^[\w$]+$/.test(name)) {
				return undefined;
			}
			// `class X implements A, Name {`, `class Y extends Name<T>`, `interface Z extends Name`; Python's `class X(Base, Name):`.
			const escaped = name.replace(/\$/g, '\\$');
			const result = await index.service.search({
				root: root.fsPath,
				pattern: `\\b(?:class|interface)\\s+[\\w$]+[^{;]*\\b(?:implements|extends)\\b[^{;]*\\b${escaped}\\b|^\\s*class\\s+\\w+\\s*\\([^)]*\\b${escaped}\\b[^)]*\\)\\s*:`,
				isRegExp: true,
				caseSensitive: true,
				multiline: false,
				maxMatches: MAX_DEFINITIONS * 5,
				options: index.options(),
			}).catch(() => undefined);
			if (result?.kind !== 'results') {
				return undefined;
			}
			return result.files.flatMap(file => file.lines.filter(line => line.match).map((line): ICodeLocation => ({
				uri: joinPath(root, file.path),
				line: line.line,
				column: Math.max(1, line.text.search(/\b(?:class|interface)\b/) + 1),
				preview: line.text.trim().slice(0, 160),
			})));
		},
		structure: async (root, uri) => {
			if (!usable(root)) {
				return undefined;
			}
			const result = await index.service.structure({ root: root.fsPath, path: displayPath(root, uri), waitMs: STRUCTURE_WAIT_MS, options: index.options() }).catch(() => undefined);
			return result?.kind === 'results' ? { symbols: result.symbols, imports: result.imports } : undefined;
		},
		importers: async (root, uri, depth) => {
			if (!usable(root)) {
				return undefined;
			}
			const result = await index.service.importers({ root: root.fsPath, path: displayPath(root, uri), depth, limit: MAX_IMPORTERS, waitMs: STRUCTURE_WAIT_MS, options: index.options() }).catch(() => undefined);
			return result?.kind === 'results' ? result.importers.map(item => ({ ...item, uri: joinPath(root, item.path), ...(item.via ? { viaUri: joinPath(root, item.via) } : {}) })) : undefined;
		},
		structural: async (root, request) => {
			if (!usable(root)) {
				return 'Volt\'s code index is off (Settings > Code Intelligence), and structural search runs in it.';
			}
			const result = await index.service.structural({
				root: root.fsPath,
				pattern: request.pattern,
				...(request.folder ? { folder: request.folder.fsPath } : {}),
				...(request.language ? { language: request.language } : {}),
				...(request.includes ? { includes: request.includes } : {}),
				...(request.excludes ? { excludes: request.excludes } : {}),
				...(request.where ? { where: request.where } : {}),
				maxMatches: request.maxMatches,
				waitMs: STRUCTURE_WAIT_MS,
				options: index.options(),
			}).catch(err => ({ kind: 'fallback' as const, reason: err instanceof Error ? err.message : String(err) }));
			return result.kind === 'results' ? result : result.reason;
		},
		outline: async (root, uri) => {
			if (!usable(root)) {
				return undefined;
			}
			const result = await index.service.symbols({ root: root.fsPath, query: '*', path: displayPath(root, uri), limit: 500, options: index.options() }).catch(() => undefined);
			if (result?.kind !== 'results') {
				return undefined;
			}
			return [...result.symbols]
				.filter(symbol => symbol.path === displayPath(root, uri))
				.sort((a, b) => a.line - b.line)
				.map((symbol): ICodeSymbol => ({ name: symbol.name, kind: symbol.kind, line: symbol.line, endLine: symbol.line, depth: symbol.kind === 'method' || symbol.kind === 'field' ? 1 : 0 }));
		},
	};
}
