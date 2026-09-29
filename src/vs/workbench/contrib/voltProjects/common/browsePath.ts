/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The folder picker's path field is both where you are and what you filter by, as in T3 Code:
 * `~/code/` lists ~/code, `~/code/ap` lists ~/code filtered to names starting with "ap", and a
 * trailing separator enters a folder. These helpers work on the typed text, for POSIX and
 * Windows paths alike.
 */

export function pathSeparator(path: string): '/' | '\\' {
	return /^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\') || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

export function hasTrailingSeparator(path: string): boolean {
	return /[\\/]$/.test(path);
}

function lastSeparatorIndex(path: string): number {
	return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** The folder being listed: everything up to and including the last separator. */
export function browseDirectory(path: string): string {
	if (path === '~') {
		return '~/';
	}
	if (hasTrailingSeparator(path)) {
		return path;
	}
	const index = lastSeparatorIndex(path);
	return index < 0 ? '' : path.slice(0, index + 1);
}

/** The typed filter: the text after the last separator. */
export function browseLeaf(path: string): string {
	if (path === '~') {
		return '';
	}
	return path.slice(lastSeparatorIndex(path) + 1);
}

/** `dir` with `segment` entered. */
export function appendSegment(dir: string, segment: string): string {
	return `${ensureTrailingSeparator(dir)}${segment}${pathSeparator(dir)}`;
}

export function ensureTrailingSeparator(path: string): string {
	return !path || hasTrailingSeparator(path) ? path : `${path}${pathSeparator(path)}`;
}

/** The parent of a folder path (with its trailing separator), or undefined at a root. */
export function parentDirectory(path: string): string | undefined {
	const dir = browseDirectory(path);
	const trimmed = dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir;
	if (!trimmed || trimmed === '/' || trimmed === '~' || /^[a-zA-Z]:$/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) {
		// `~` has a parent, but only once expanded; callers untildify first.
		return undefined;
	}
	const index = lastSeparatorIndex(trimmed);
	if (index < 0) {
		return undefined;
	}
	return trimmed.slice(0, index + 1);
}

/** `/Users/me/code` → `~/code` when under `home`. */
export function tildify(path: string, home: string): string {
	if (!home) {
		return path;
	}
	const base = home.replace(/[\\/]+$/, '');
	if (path === base) {
		return '~';
	}
	if (path.startsWith(base) && /[\\/]/.test(path[base.length] ?? '')) {
		return `~${path.slice(base.length)}`;
	}
	return path;
}

/** `~/code` → `/Users/me/code`. */
export function untildify(path: string, home: string): string {
	if (path === '~') {
		return home;
	}
	if (path.startsWith('~/') || path.startsWith('~\\')) {
		return `${home.replace(/[\\/]+$/, '')}${pathSeparator(home)}${path.slice(2)}`;
	}
	return path;
}

/** Breadcrumb parts of an absolute or `~` path: each with the label and the folder it opens. */
export function breadcrumbParts(path: string): { readonly label: string; readonly path: string }[] {
	const dir = browseDirectory(path);
	const separator = pathSeparator(dir);
	const parts: { label: string; path: string }[] = [];
	let rest = dir;
	let prefix = '';
	if (dir.startsWith('~')) {
		parts.push({ label: '~', path: '~/' });
		prefix = '~/';
		rest = dir.slice(2);
	} else if (dir.startsWith('/')) {
		parts.push({ label: '/', path: '/' });
		prefix = '/';
		rest = dir.slice(1);
	} else if (/^[a-zA-Z]:[\\/]/.test(dir)) {
		prefix = dir.slice(0, 3);
		parts.push({ label: dir.slice(0, 2), path: prefix });
		rest = dir.slice(3);
	}
	for (const segment of rest.split(/[\\/]/).filter(Boolean)) {
		prefix = `${prefix}${segment}${separator}`;
		parts.push({ label: segment, path: prefix });
	}
	return parts;
}

/**
 * Drops results of a navigation that a newer one has overtaken, so a slow folder never paints
 * over the folder the user moved on to (T3's browse coordinator).
 */
export class BrowseGeneration {
	private generation = 0;

	next(): number {
		return ++this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}
}
