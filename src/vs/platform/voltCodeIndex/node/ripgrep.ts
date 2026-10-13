/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { rgPath } from '@vscode/ripgrep';
import { join } from '../../../base/common/path.js';
import type { IVoltCodeIndexFileHits, IVoltCodeIndexLine, IVoltCodeIndexOptions } from '../common/voltCodeIndex.js';

/** ripgrep inside the packaged app lives outside the asar archive. */
const RG = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

/** Files the index never sees, like the agent's grep tool never searches them. */
const ALWAYS_EXCLUDED = ['!.git', '!node_modules'];
export const IGNORE_FILE_NAMES = ['.voltignore', '.cursorignore'];

/**
 * The files ripgrep would search under `root`: .gitignore, .ignore and .rgignore honored,
 * hidden files included, no ignore files from above the root, the same flags VS Code's search
 * passes. `.voltignore` and `.cursorignore` at the root (and below, when hierarchical) apply too.
 */
export async function listFiles(root: string, options: IVoltCodeIndexOptions, maxFiles: number): Promise<{ readonly paths: string[]; readonly truncated: boolean }> {
	const args = ['--files', '--hidden', '--no-require-git', '--no-ignore-parent', '--no-config', '--no-ignore-global', '--path-separator', '/'];
	for (const glob of ALWAYS_EXCLUDED) {
		args.push('-g', glob);
	}
	if (!options.ignoreSymlinks) {
		args.push('--follow');
	}
	for (const name of IGNORE_FILE_NAMES) {
		if (await fs.stat(join(root, name)).then(stat => stat.isFile(), () => false)) {
			args.push('--ignore-file', join(root, name));
		}
	}
	if (options.hierarchicalIgnore) {
		for (const glob of await nestedIgnoreGlobs(root, options)) {
			args.push('-g', glob);
		}
	}
	const paths: string[] = [];
	let truncated = false;
	await runLines(args, root, line => {
		if (paths.length >= maxFiles) {
			truncated = true;
			return false;
		}
		paths.push(line.startsWith('./') ? line.slice(2) : line);
		return true;
	});
	return { paths, truncated };
}

/**
 * `.voltignore` / `.cursorignore` files below the root, as exclude globs relative to it.
 * Negations cannot be expressed as excludes and are left out.
 */
async function nestedIgnoreGlobs(root: string, options: IVoltCodeIndexOptions): Promise<string[]> {
	const args = ['--files', '--hidden', '--no-require-git', '--no-ignore-parent', '--no-config', '--no-ignore-global', '--path-separator', '/'];
	for (const glob of ALWAYS_EXCLUDED) {
		args.push('-g', glob);
	}
	if (!options.ignoreSymlinks) {
		args.push('--follow');
	}
	for (const name of IGNORE_FILE_NAMES) {
		args.push('-g', `**/${name}`);
	}
	const files: string[] = [];
	await runLines(args, root, line => {
		const path = line.startsWith('./') ? line.slice(2) : line;
		if (path.includes('/')) {
			files.push(path);
		}
		return files.length < 500;
	});
	const globs: string[] = [];
	for (const file of files) {
		const dir = file.slice(0, file.lastIndexOf('/'));
		const text = await fs.readFile(join(root, file), 'utf8').catch(() => '');
		for (const raw of text.split(/\r?\n/)) {
			let rule = raw.trim();
			if (!rule || rule.startsWith('#') || rule.startsWith('!')) {
				continue;
			}
			rule = rule.replace(/\/+$/, '');
			const anchored = rule.startsWith('/') || rule.slice(0, -1).includes('/');
			rule = rule.replace(/^\/+/, '');
			globs.push(`!${dir}/${anchored ? '' : '**/'}${rule}`);
		}
	}
	return globs;
}

function runLines(args: string[], cwd: string, onLine: (line: string) => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(RG, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let rest = '';
		let stopped = false;
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (stopped) {
				return;
			}
			const text = rest + chunk;
			const lines = text.split('\n');
			rest = lines.pop() ?? '';
			for (const line of lines) {
				if (line && !onLine(line)) {
					stopped = true;
					child.kill();
					return;
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			if (stderr.length < 4096) {
				stderr += chunk;
			}
		});
		child.on('error', reject);
		child.on('close', code => {
			if (!stopped && rest) {
				onLine(rest);
			}
			// 1: nothing found. 2: some paths could not be read; what was listed is still right.
			if (stopped || code === 0 || code === 1 || code === 2) {
				resolve();
			} else {
				reject(new Error(`ripgrep exited with ${code}: ${stderr.trim()}`));
			}
		});
	});
}

export interface IRipgrepSearch {
	readonly pattern: string;
	readonly isRegExp: boolean;
	readonly caseSensitive: boolean;
	readonly multiline: boolean;
	readonly wholeWord: boolean;
	readonly context: number;
	readonly maxMatches: number;
	readonly maxLineChars: number;
}

/** `\uXXXX` and `\u{X}` (JS) as ripgrep's `\x{X}`. */
function rgPattern(pattern: string): string {
	return pattern.replace(/(?<!\\)((?:\\\\)*)\\u\{?([0-9a-fA-F]{1,6})\}?/g, (_m, lead: string, hex: string) => `${lead}\\x{${hex}}`);
}

interface IRgJson {
	readonly type: string;
	readonly data?: {
		readonly path?: { readonly text?: string };
		readonly lines?: { readonly text?: string };
		readonly line_number?: number;
		readonly submatches?: readonly { readonly start: number }[];
	};
}

/**
 * Searches the given root-relative files with ripgrep (the same engine and flags as the
 * agent's grep), for candidate sets too large or patterns too unusual to match in-process.
 * Throws when ripgrep rejects the pattern, so the caller can run its normal search and report
 * ripgrep's own error.
 */
export function searchFiles(root: string, files: readonly string[], search: IRipgrepSearch): Promise<{ readonly files: IVoltCodeIndexFileHits[]; readonly limitHit: boolean }> {
	const args = ['--json', '--hidden', '--no-config', '--crlf', search.caseSensitive ? '--case-sensitive' : '--ignore-case'];
	if (search.isRegExp) {
		args.push('--engine', 'auto', '--regexp', rgPattern(search.pattern));
	} else {
		args.push('--fixed-strings', '--regexp', search.pattern);
	}
	if (search.multiline) {
		args.push('--multiline');
	}
	if (search.wholeWord) {
		args.push('--word-regexp');
	}
	if (search.context) {
		args.push('--before-context', String(search.context), '--after-context', String(search.context));
	}
	args.push('--', ...files);
	const byPath = new Map<string, { matches: number; lines: Map<number, IVoltCodeIndexLine> }>();
	let total = 0;
	let limitHit = false;
	return new Promise((resolve, reject) => {
		const child = spawn(RG, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let rest = '';
		let stderr = '';
		let stopped = false;
		const onLine = (line: string) => {
			if (stopped || !line.startsWith('{"type":"match"') && !line.startsWith('{"type":"context"')) {
				return;
			}
			let event: IRgJson;
			try {
				event = JSON.parse(line) as IRgJson;
			} catch {
				return;
			}
			const path = event.data?.path?.text;
			const text = event.data?.lines?.text;
			const lineNumber = event.data?.line_number;
			if (!path || text === undefined || !lineNumber) {
				return;
			}
			const isMatch = event.type === 'match';
			if (isMatch && total >= search.maxMatches) {
				limitHit = true;
				stopped = true;
				child.kill();
				return;
			}
			let entry = byPath.get(path);
			if (!entry) {
				entry = { matches: 0, lines: new Map() };
				byPath.set(path, entry);
			}
			const first = text.replace(/\r?\n$/, '').split(/\r?\n/)[0];
			const column = isMatch ? Buffer.from(text, 'utf8').subarray(0, event.data?.submatches?.[0]?.start ?? 0).toString('utf8').length : 0;
			const clipped = first.length > search.maxLineChars
				? `${column > search.maxLineChars - 100 ? '\u2026' : ''}${first.slice(column > search.maxLineChars - 100 ? column - 100 : 0).slice(0, search.maxLineChars)}\u2026`
				: first;
			if (isMatch) {
				entry.matches++;
				total++;
				entry.lines.set(lineNumber, { line: lineNumber, text: clipped, match: true });
			} else if (!entry.lines.has(lineNumber)) {
				entry.lines.set(lineNumber, { line: lineNumber, text: clipped, match: false });
			}
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			const text = rest + chunk;
			const lines = text.split('\n');
			rest = lines.pop() ?? '';
			for (const line of lines) {
				onLine(line);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			if (stderr.length < 4096) {
				stderr += chunk;
			}
		});
		child.on('error', reject);
		child.on('close', code => {
			if (rest) {
				onLine(rest);
			}
			if (!stopped && code === 2 && !byPath.size) {
				reject(new Error(stderr.trim() || 'ripgrep failed'));
				return;
			}
			const out: IVoltCodeIndexFileHits[] = [];
			for (const [path, entry] of byPath) {
				if (entry.matches) {
					out.push({ path, matches: entry.matches, lines: [...entry.lines.values()].sort((a, b) => a.line - b.line) });
				}
			}
			out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
			resolve({ files: out, limitHit });
		});
	});
}
