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

/** code_nav by name, from the code index: declarations, whole-word uses, and a file's outline. */
export function createCodeIndexNav(index: ISearchIndex): ICodeNavIndex {
	const usable = (root: URI) => root.scheme === Schemas.file && index.enabled();
	return {
		definitions: async (root, name) => {
			if (!usable(root)) {
				return undefined;
			}
			const result = await index.service.symbols({ root: root.fsPath, query: name, match: 'exact', limit: MAX_DEFINITIONS, options: index.options() }).catch(() => undefined);
			if (result?.kind !== 'results') {
				return undefined;
			}
			return result.symbols.map((symbol): ICodeLocation => ({ uri: joinPath(root, symbol.path), line: symbol.line, column: symbol.column ?? 1, preview: symbol.text }));
		},
		references: async (root, name) => {
			if (!usable(root) || !/^[\w$]+$/.test(name)) {
				return undefined;
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
			return result.files.flatMap(file => file.lines.filter(line => line.match).map((line): ICodeLocation => ({
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
			// `class X implements A, Name {`, `class Y extends Name<T>`, `interface Z extends Name`.
			const escaped = name.replace(/\$/g, '\\$');
			const result = await index.service.search({
				root: root.fsPath,
				pattern: `\\b(?:class|interface)\\s+[\\w$]+[^{;]*\\b(?:implements|extends)\\b[^{;]*\\b${escaped}\\b`,
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
