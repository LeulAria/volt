/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix } from '../../../base/common/path.js';
import type { IVoltCodeImport, IVoltCodeImporter, IVoltCodeImportersRequest, IVoltCodeImportersResult, IVoltCodeStructuralMatch, IVoltCodeStructuralRequest, IVoltCodeStructuralResult, IVoltCodeStructureResult } from '../common/voltCodeIndex.js';
import { extensionsOf, grammarFor, IParsedFile, STRUCTURE_LANGUAGES, TreeSitterParsers } from './treeSitterStructure.js';

/**
 * The code index's structure layer: per-file syntax (declarations with ranges, imports) from
 * tree-sitter, and the import graph across files. Nothing is parsed ahead of time: a question
 * parses the files it needs (the trigram index narrows "who imports X" to the files that mention
 * X's name) and the results are kept per file until the file changes.
 */

/** What the structure layer needs from its index. Paths are root-relative with `/`. */
export interface IStructureHost {
	/** The file's text as it is on disk now; undefined when unreadable or binary. */
	readText(path: string): Promise<string | undefined>;
	/** Changes when the file changes (size and modification time). */
	stamp(path: string): Promise<string | undefined>;
	/** Whether the index lists this file (exists, not ignored). */
	isListed(path: string): boolean;
	listed(): Iterable<string>;
	/** Files whose text matches `pattern` (a literal, or a regex when `regex`), limited to `extensions`; undefined when the index cannot say. */
	filesContaining(pattern: string, extensions: readonly string[], folder: string | undefined, limit: number, regex?: boolean): Promise<string[] | undefined>;
}

const MAX_CACHED_FILES = 4_000;
/** Candidate files parsed per importers query, at most. */
const MAX_IMPORTER_CANDIDATES = 600;
/** Files searched by a pattern with no literal word to narrow them. */
const MAX_UNNARROWED_FILES = 4_000;
const STRUCTURAL_DEADLINE_MS = 15_000;
const IMPORTERS_DEADLINE_MS = 12_000;

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const JS_TO_TS: Record<string, readonly string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

interface ICached {
	readonly stamp: string;
	readonly parsed: IParsedFile | undefined;
}

interface ITsPaths {
	/** Root-relative folder the paths are relative to. */
	readonly base: string;
	readonly paths: readonly { readonly prefix: string; readonly suffix: string; readonly wildcard: boolean; readonly targets: readonly string[] }[];
}

export class CodeStructure {

	private readonly cache = new Map<string, ICached>();
	private packages: Map<string, string> | undefined;
	private readonly tsconfigs = new Map<string, ITsPaths | null>();
	private goModule: { readonly path: string; readonly dir: string } | null | undefined;

	constructor(private readonly host: IStructureHost, private readonly parsers: TreeSitterParsers = sharedParsers()) { }

	/** Forgets a changed file (its next query parses it again). */
	invalidate(path: string): void {
		this.cache.delete(path);
		if (/(^|\/)(package\.json|tsconfig[^/]*\.json|go\.mod)$/.test(path)) {
			this.packages = undefined;
			this.tsconfigs.clear();
			this.goModule = undefined;
		}
	}

	async parsed(path: string): Promise<IParsedFile | undefined> {
		if (!grammarFor(path)) {
			return undefined;
		}
		const stamp = await this.host.stamp(path);
		if (!stamp) {
			return undefined;
		}
		const cached = this.cache.get(path);
		if (cached?.stamp === stamp) {
			// Most recently used last.
			this.cache.delete(path);
			this.cache.set(path, cached);
			return cached.parsed;
		}
		const text = await this.host.readText(path);
		const parsed = text === undefined ? undefined : await this.parsers.parse(path, text).catch(() => undefined);
		this.cache.set(path, { stamp, parsed });
		if (this.cache.size > MAX_CACHED_FILES) {
			this.cache.delete(this.cache.keys().next().value!);
		}
		return parsed;
	}

	async structure(path: string): Promise<IVoltCodeStructureResult> {
		if (!grammarFor(path)) {
			return { kind: 'fallback', reason: `no grammar for ${posix.extname(path) || path}` };
		}
		const parsed = await this.parsed(path);
		if (!parsed) {
			return { kind: 'fallback', reason: 'could not parse' };
		}
		const imports: IVoltCodeImport[] = [];
		for (const item of parsed.imports) {
			const resolved = await this.resolve(path, parsed.language, item.specifier);
			imports.push({ ...item, ...(resolved ? { resolved } : {}) });
		}
		return { kind: 'results', language: parsed.language, symbols: parsed.symbols, imports };
	}

	//#region Import resolution

	/** The root-relative file (Go: folder) an import names, when it is in this project. */
	async resolve(from: string, language: string, specifier: string): Promise<string | undefined> {
		switch (language) {
			case 'typescript': case 'tsx': case 'javascript':
				return this.resolveScript(from, specifier);
			case 'python':
				return this.resolvePython(from, specifier);
			case 'go':
				return this.resolveGo(specifier);
			case 'rust':
				return this.resolveRust(from, specifier);
			case 'cpp':
				return this.firstListed([posix.join(posix.dirname(from), specifier), specifier, `include/${specifier}`, `src/${specifier}`]);
			case 'ruby':
				return this.firstListed([`${posix.join(posix.dirname(from), specifier)}.rb`, posix.join(posix.dirname(from), specifier), `lib/${specifier}.rb`, `${specifier}.rb`]);
		}
		return undefined;
	}

	private firstListed(candidates: readonly string[]): string | undefined {
		for (const candidate of candidates) {
			const path = posix.normalize(candidate);
			if (!path.startsWith('../') && this.host.isListed(path)) {
				return path;
			}
		}
		return undefined;
	}

	private scriptFile(base: string): string | undefined {
		const extension = posix.extname(base);
		const candidates = [base];
		for (const swapped of JS_TO_TS[extension] ?? []) {
			candidates.push(base.slice(0, -extension.length) + swapped);
		}
		for (const added of SCRIPT_EXTENSIONS) {
			candidates.push(base + added);
		}
		for (const added of SCRIPT_EXTENSIONS) {
			candidates.push(`${base}/index${added}`);
		}
		return this.firstListed(candidates);
	}

	private async resolveScript(from: string, specifier: string): Promise<string | undefined> {
		if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
			return this.scriptFile(posix.join(posix.dirname(from), specifier));
		}
		if (specifier.startsWith('/')) {
			return undefined;
		}
		const paths = await this.tsPaths(from);
		for (const mapping of paths?.paths ?? []) {
			const matches = mapping.wildcard ? specifier.startsWith(mapping.prefix) && specifier.endsWith(mapping.suffix) && specifier.length >= mapping.prefix.length + mapping.suffix.length : specifier === mapping.prefix;
			if (!matches) {
				continue;
			}
			const star = mapping.wildcard ? specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length) : '';
			for (const target of mapping.targets) {
				const found = this.scriptFile(posix.join(paths!.base, target.replace('*', star)));
				if (found) {
					return found;
				}
			}
		}
		// A workspace package of this repository (`@acme/ui`, `@acme/ui/button`).
		const packages = await this.workspacePackages();
		const parts = specifier.split('/');
		const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
		const dir = packages.get(name);
		if (dir !== undefined) {
			const rest = specifier.slice(name.length + 1);
			return rest
				? this.scriptFile(posix.join(dir, rest)) ?? this.scriptFile(posix.join(dir, 'src', rest))
				: this.scriptFile(posix.join(dir, 'src/index')) ?? this.scriptFile(posix.join(dir, 'index'));
		}
		return undefined;
	}

	private async workspacePackages(): Promise<Map<string, string>> {
		if (!this.packages) {
			const packages = new Map<string, string>();
			const manifests = [...this.host.listed()].filter(path => /(^|\/)package\.json$/.test(path) && !/(^|\/)node_modules\//.test(path)).slice(0, 500);
			for (const manifest of manifests) {
				const name = parseLooseJson(await this.host.readText(manifest))?.name;
				if (typeof name === 'string' && !packages.has(name)) {
					packages.set(name, posix.dirname(manifest) === '.' ? '' : posix.dirname(manifest));
				}
			}
			this.packages = packages;
		}
		return this.packages;
	}

	/** `compilerOptions.paths` of the nearest tsconfig.json above `from` (no `extends`). */
	private async tsPaths(from: string): Promise<ITsPaths | undefined> {
		for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
			const file = dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`;
			if (!this.tsconfigs.has(file)) {
				let found: ITsPaths | null = null;
				if (this.host.isListed(file)) {
					const options = parseLooseJson(await this.host.readText(file))?.compilerOptions as { baseUrl?: unknown; paths?: unknown } | undefined;
					const paths = options?.paths && typeof options.paths === 'object' ? options.paths as Record<string, unknown> : undefined;
					if (paths) {
						const base = posix.normalize(posix.join(dir === '.' ? '' : dir, typeof options?.baseUrl === 'string' ? options.baseUrl : '.'));
						found = {
							base: base === '.' ? '' : base,
							paths: Object.entries(paths).map(([key, targets]) => {
								const star = key.indexOf('*');
								return { prefix: star >= 0 ? key.slice(0, star) : key, suffix: star >= 0 ? key.slice(star + 1) : '', wildcard: star >= 0, targets: Array.isArray(targets) ? targets.filter((target): target is string => typeof target === 'string') : [] };
							}).sort((a, b) => b.prefix.length - a.prefix.length),
						};
					}
				}
				this.tsconfigs.set(file, found);
			}
			const known = this.tsconfigs.get(file);
			if (known) {
				return known;
			}
			if (dir === '.' || dir === '') {
				return undefined;
			}
		}
	}

	private resolvePython(from: string, specifier: string): string | undefined {
		const dots = /^\.*/.exec(specifier)![0].length;
		const parts = specifier.slice(dots).split('.').filter(Boolean);
		const bases: string[] = [];
		if (dots) {
			let dir = posix.dirname(from);
			for (let i = 1; i < dots; i++) {
				dir = posix.dirname(dir);
			}
			bases.push(dir === '.' ? '' : dir);
		} else {
			bases.push('', 'src', 'lib');
			// A script importing a sibling module by name.
			const own = posix.dirname(from);
			if (own !== '.') {
				bases.push(own);
			}
		}
		const candidates: string[] = [];
		for (const base of bases) {
			const path = posix.join(base, ...parts);
			candidates.push(`${path}.py`, `${path}/__init__.py`, `${path}.pyi`);
		}
		return this.firstListed(candidates);
	}

	private async resolveGo(specifier: string): Promise<string | undefined> {
		if (this.goModule === undefined) {
			const text = this.host.isListed('go.mod') ? await this.host.readText('go.mod') : undefined;
			const module = text && /^module\s+(\S+)/m.exec(text)?.[1];
			this.goModule = module ? { path: module, dir: '' } : null;
		}
		const module = this.goModule;
		if (!module || !(specifier === module.path || specifier.startsWith(`${module.path}/`))) {
			return undefined;
		}
		const dir = specifier.slice(module.path.length + 1);
		return dir || '.';
	}

	private resolveRust(from: string, specifier: string): string | undefined {
		if (/^[A-Za-z_]\w*$/.test(specifier)) {
			// `mod name;`: a file next to this one (or in this module's folder).
			const dir = posix.dirname(from);
			const own = /(^|\/)(mod|lib|main)\.rs$/.test(from) ? dir : posix.join(dir, posix.basename(from, '.rs'));
			return this.firstListed([posix.join(own, `${specifier}.rs`), posix.join(own, specifier, 'mod.rs'), posix.join(dir, `${specifier}.rs`)]);
		}
		const path = /^crate::([\w:]+)/.exec(specifier)?.[1]?.split('::');
		if (!path) {
			return undefined;
		}
		for (let length = path.length; length > 0; length--) {
			const found = this.firstListed([`src/${path.slice(0, length).join('/')}.rs`, `src/${path.slice(0, length).join('/')}/mod.rs`]);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	//#endregion

	//#region Importers

	/** The word a file importing `path` must contain: its module name as imports spell it. */
	private importKey(path: string): string | undefined {
		const grammar = grammarFor(path);
		const base = posix.basename(path).replace(/\.d\.ts$/, '').replace(/\.[^.]+$/, '');
		if (grammar === 'go') {
			const dir = posix.dirname(path);
			return dir === '.' ? undefined : posix.basename(dir);
		}
		// A folder's own module is imported by the folder's name.
		if ((base === 'index' && grammar !== 'python') || (base === '__init__' && grammar === 'python') || (base === 'mod' && grammar === 'rust')) {
			const dir = posix.dirname(path);
			return dir === '.' ? undefined : posix.basename(dir);
		}
		return grammar === 'cpp' ? posix.basename(path) : base;
	}

	async importers(request: IVoltCodeImportersRequest, folder: string | undefined): Promise<IVoltCodeImportersResult> {
		const started = Date.now();
		const target = request.path.replace(/^\.?\/+/, '');
		const grammar = grammarFor(target);
		if (!grammar) {
			return { kind: 'fallback', reason: `no grammar for ${target}` };
		}
		const deadline = started + IMPORTERS_DEADLINE_MS;
		const depth = Math.max(1, Math.min(2, request.depth ?? 1));
		const out: IVoltCodeImporter[] = [];
		const seen = new Set<string>([target]);
		let limitHit = false;
		let frontier: { path: string; via?: string }[] = [{ path: target }];
		for (let level = 1; level <= depth && frontier.length; level++) {
			const next: { path: string; via?: string }[] = [];
			for (const item of frontier) {
				if (Date.now() > deadline || out.length >= request.limit) {
					limitHit = true;
					break;
				}
				const direct = await this.directImporters(item.path, folder, deadline);
				if (direct === undefined) {
					if (level === 1) {
						return { kind: 'fallback', reason: 'the index cannot list candidate files' };
					}
					continue;
				}
				for (const found of direct) {
					if (seen.has(found.path)) {
						continue;
					}
					seen.add(found.path);
					if (out.length >= request.limit) {
						limitHit = true;
						break;
					}
					out.push({ ...found, depth: level, ...(level > 1 ? { via: item.path } : {}) });
					next.push({ path: found.path });
				}
			}
			frontier = next.slice(0, 40);
		}
		return { kind: 'results', importers: out, limitHit, ms: Date.now() - started };
	}

	private async directImporters(path: string, folder: string | undefined, deadline: number): Promise<{ path: string; line: number; names: readonly string[] }[] | undefined> {
		const grammar = grammarFor(path);
		const key = this.importKey(path);
		if (!grammar || !key) {
			return [];
		}
		const family = grammar === 'typescript' || grammar === 'tsx' || grammar === 'javascript' ? ['typescript', 'tsx', 'javascript'] : [grammar];
		const extensions = family.flatMap(extensionsOf);
		// Only lines that can import it: the name as the last part of a quoted module path, or after import/from.
		const word = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = grammar === 'python' ? `\\b(?:import|from)\\b.*\\b${word}\\b`
			: grammar === 'rust' ? `\\b(?:mod|use)\\b.*\\b${word}\\b`
				: grammar === 'cpp' ? `#\\s*include\\s*["<][^">]*${word}`
					: `["'/]${word}(?:\\.[a-z]+)?["']`;
		const candidates = await this.host.filesContaining(pattern, [...new Set(extensions)], folder, MAX_IMPORTER_CANDIDATES, true);
		if (!candidates) {
			return undefined;
		}
		const targetDir = posix.dirname(path);
		const out: { path: string; line: number; names: readonly string[] }[] = [];
		for (const candidate of candidates) {
			if (candidate === path || Date.now() > deadline) {
				continue;
			}
			const parsed = await this.parsed(candidate);
			for (const item of parsed?.imports ?? []) {
				if (!item.specifier.includes(key)) {
					continue;
				}
				const resolved = await this.resolve(candidate, parsed!.language, item.specifier);
				if (resolved === path || (grammar === 'go' && resolved === (targetDir === '.' ? '.' : targetDir))) {
					out.push({ path: candidate, line: item.line, names: item.names });
					break;
				}
			}
		}
		return out;
	}

	//#endregion

	//#region Structural search

	async structural(request: IVoltCodeStructuralRequest, folder: string | undefined, matchesGlobs: (path: string) => boolean): Promise<IVoltCodeStructuralResult> {
		const started = Date.now();
		const language = request.language ? normalizeLanguage(request.language) : undefined;
		if (request.language && !language) {
			return { kind: 'fallback', reason: `no grammar named ${request.language}; one of ${STRUCTURE_LANGUAGES.join(', ')}` };
		}
		const where: [string, RegExp][] = [];
		for (const [name, source] of Object.entries(request.where ?? {})) {
			try {
				where.push([name.replace(/^\$/, ''), new RegExp(source)]);
			} catch {
				return { kind: 'fallback', reason: `where.${name} is not a valid regular expression: ${source}` };
			}
		}
		// The words of the pattern that are not metavariables narrow the files through the trigram index.
		const words = (request.pattern.replace(/\$\$\$[A-Z0-9_]*|\$[A-Z_][A-Z0-9_]*/g, ' ').match(/[A-Za-z_]\w*/g) ?? []).filter(word => !KEYWORDS.has(word)).sort((a, b) => b.length - a.length);
		const families = language ? [language] : ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'c-sharp', 'cpp', 'ruby'];
		const extensions = [...new Set(families.flatMap(extensionsOf))];
		let files: string[] | undefined;
		if (words[0]) {
			files = await this.host.filesContaining(words[0], extensions, folder, MAX_UNNARROWED_FILES);
		}
		if (!files) {
			files = [...this.host.listed()].filter(path => extensions.includes(posix.extname(path).slice(1).toLowerCase()) && (!folder || path.startsWith(`${folder}/`))).slice(0, MAX_UNNARROWED_FILES);
		}
		files = files.filter(matchesGlobs).sort();
		const matches: IVoltCodeStructuralMatch[] = [];
		let scanned = 0;
		let limitHit = false;
		const patternErrors = new Map<string, string>();
		for (const path of files) {
			const grammar = grammarFor(path);
			if (!grammar || (language && grammar !== language && !(language === 'typescript' && grammar === 'tsx'))) {
				continue;
			}
			if (Date.now() - started > STRUCTURAL_DEADLINE_MS || matches.length >= request.maxMatches) {
				limitHit = true;
				break;
			}
			const text = await this.host.readText(path);
			if (text === undefined) {
				continue;
			}
			scanned++;
			const found = await this.parsers.match(grammar, request.pattern, text, request.maxMatches - matches.length, where).catch(err => String(err));
			if (typeof found === 'string') {
				patternErrors.set(grammar, found);
				continue;
			}
			for (const hit of found) {
				matches.push({ path, ...hit });
			}
		}
		if (!matches.length && patternErrors.size && scanned === patternErrors.size) {
			return { kind: 'fallback', reason: [...patternErrors.values()][0] };
		}
		if (!matches.length && patternErrors.size) {
			const [grammar, reason] = [...patternErrors][0];
			return { kind: 'fallback', reason: `${reason} (${grammar})` };
		}
		return { kind: 'results', matches, limitHit, scanned, ms: Date.now() - started };
	}

	//#endregion
}

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'new', 'class', 'def', 'async', 'await', 'import', 'from', 'export', 'try', 'catch', 'throw', 'this', 'self', 'true', 'false', 'null', 'None', 'undefined', 'fn', 'func', 'pub', 'go', 'in', 'of', 'not', 'and', 'or']);

function normalizeLanguage(language: string): string | undefined {
	const value = language.trim().toLowerCase();
	const alias: Record<string, string> = { ts: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', rs: 'rust', golang: 'go', 'c#': 'c-sharp', csharp: 'c-sharp', cs: 'c-sharp', 'c++': 'cpp', c: 'cpp', rb: 'ruby' };
	const name = alias[value] ?? value;
	return STRUCTURE_LANGUAGES.includes(name) ? name : undefined;
}

/** JSON with comments and trailing commas (tsconfig, package.json); undefined when it does not parse. */
export function parseLooseJson(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		// Strip comments outside strings, then trailing commas.
		const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_all, string: string | undefined) => string ?? '').replace(/,(\s*[}\]])/g, '$1');
		try {
			return JSON.parse(stripped);
		} catch {
			return undefined;
		}
	}
}

let shared: TreeSitterParsers | undefined;

function sharedParsers(): TreeSitterParsers {
	shared ??= new TreeSitterParsers();
	return shared;
}
