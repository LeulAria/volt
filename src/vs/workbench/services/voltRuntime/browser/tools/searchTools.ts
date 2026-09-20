/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { ISearchService, QueryType, resultIsMatch } from '../../../search/common/search.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

const MAX_GREP_HITS = 80;
const MAX_GLOB_HITS = 200;

export function createSearchTools(search: ISearchService, root: () => URI | undefined): IVoltTool[] {
	return [
		{
			name: 'grep',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'grep - search file contents with a regex',
			description: [
				'Search workspace file contents.',
				'Use when you need to find a symbol, string, or pattern.',
				'Do not use to read a file you already know the path of (use read_file).',
			].join(' '),
			schema: objectSchema({
				pattern: { type: 'string', description: 'Text or regular expression' },
				path: { type: 'string', description: 'Optional folder to search in' },
				glob: { type: 'string', description: 'Optional file glob, e.g. *.ts' },
				case_sensitive: { type: 'boolean' },
				is_regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default true if it looks like one.' },
			}, ['pattern']),
			execute: async args => runGrep(search, root(), args),
		},
		{
			name: 'glob',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'glob - find files by name pattern',
			description: [
				'Find files by glob pattern.',
				'Use when you need paths and do not yet know them.',
				'Do not use to list a single known directory (use list_dir).',
			].join(' '),
			schema: objectSchema({
				pattern: { type: 'string', description: 'Glob such as **/*.ts or src/**/*.json' },
				path: { type: 'string', description: 'Optional folder to search in' },
			}, ['pattern']),
			execute: async args => runGlob(search, root(), args),
		},
	];
}

async function runGrep(search: ISearchService, root: URI | undefined, args: unknown): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'query', 'regex');
	if (!pattern) {
		return fail('grep', 'pattern is required.');
	}
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory')) ?? root;
	if (!folder) {
		return fail('grep', 'No workspace is open.');
	}
	const glob = pickString(args, 'glob', 'include');
	const isRegex = pickBoolean(args, 'is_regex') || looksLikeRegex(pattern);
	try {
		const complete = await search.textSearch({
			type: QueryType.Text,
			contentPattern: {
				pattern,
				isRegExp: isRegex,
				isCaseSensitive: pickBoolean(args, 'case_sensitive'),
			},
			folderQueries: [{ folder }],
			maxResults: MAX_GREP_HITS,
			previewOptions: { matchLines: 1, charsPerLine: 200 },
			...(glob ? { includePattern: { [glob]: true } } : {}),
		});
		const lines: string[] = [];
		for (const file of complete.results) {
			const path = displayPath(root, file.resource);
			for (const result of file.results ?? []) {
				if (!resultIsMatch(result)) {
					continue;
				}
				const line = result.rangeLocations[0]?.source.startLineNumber ?? 0;
				const preview = firstPreviewLine(result.previewText);
				lines.push(`${path}:${line}: ${preview}`);
				if (lines.length >= MAX_GREP_HITS) {
					break;
				}
			}
			if (lines.length >= MAX_GREP_HITS) {
				break;
			}
		}
		const more = complete.limitHit ? '\n[limit hit - narrow the pattern or path]' : '';
		return { callId: '', name: 'grep', kind: 'search', text: lines.length ? lines.join('\n') + more : 'No matches.' };
	} catch (err) {
		return fail('grep', err instanceof Error ? err.message : String(err));
	}
}

async function runGlob(search: ISearchService, root: URI | undefined, args: unknown): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'glob', 'file_pattern');
	if (!pattern) {
		return fail('glob', 'pattern is required.');
	}
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory')) ?? root;
	if (!folder) {
		return fail('glob', 'No workspace is open.');
	}
	try {
		const complete = await search.fileSearch({
			type: QueryType.File,
			filePattern: pattern,
			shouldGlobMatchFilePattern: true,
			folderQueries: [{ folder }],
			maxResults: pickNumber(args, 'limit') ?? MAX_GLOB_HITS,
		});
		const lines = complete.results.map(file => displayPath(root, file.resource));
		const more = complete.limitHit ? '\n[limit hit - tighten the glob]' : '';
		return { callId: '', name: 'glob', kind: 'search', text: lines.length ? lines.join('\n') + more : 'No files matched.' };
	} catch (err) {
		return fail('glob', err instanceof Error ? err.message : String(err));
	}
}

function looksLikeRegex(pattern: string): boolean {
	return /[\\^$|?*+\[\](){}]/.test(pattern);
}

function firstPreviewLine(preview: string): string {
	return preview.split('\n')[0]?.trim() ?? '';
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: 'search', text, isError: true };
}
