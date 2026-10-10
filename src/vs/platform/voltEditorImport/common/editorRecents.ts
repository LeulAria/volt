/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltImportEditorId } from './voltEditorImport.js';

/**
 * Where VS Code family editors keep their recently opened list. Since VS Code 1.48 it is the
 * `history.recentlyOpenedPathsList` key of `User/globalStorage/state.vscdb` (SQLite, table
 * `ItemTable`); older builds wrote `openedPathsList` into `storage.json`, which also lists the
 * windows open at last exit (`windowsState`).
 */

export const RECENTS_STORAGE_KEY = 'history.recentlyOpenedPathsList';

export interface IEditorProfileDir {
	readonly id: VoltImportEditorId;
	readonly label: string;
	/** The editor's user data folder (holds `User/globalStorage`). */
	readonly dir: string;
}

const EDITORS: readonly { readonly id: VoltImportEditorId; readonly label: string; readonly folder: string }[] = [
	{ id: 'vscode', label: 'VS Code', folder: 'Code' },
	{ id: 'cursor', label: 'Cursor', folder: 'Cursor' },
	{ id: 'vscodeInsiders', label: 'VS Code Insiders', folder: 'Code - Insiders' },
	{ id: 'windsurf', label: 'Windsurf', folder: 'Windsurf' },
	{ id: 'vscodium', label: 'VSCodium', folder: 'VSCodium' },
];

/**
 * macOS: `~/Library/Application Support/<Name>`; Windows: `%APPDATA%\<Name>`;
 * Linux: `$XDG_CONFIG_HOME/<Name>` (default `~/.config`).
 */
export function editorProfileDirs(platform: 'darwin' | 'win32' | 'linux', home: string, env: { readonly APPDATA?: string; readonly XDG_CONFIG_HOME?: string }): IEditorProfileDir[] {
	const sep = platform === 'win32' ? '\\' : '/';
	const base = platform === 'darwin'
		? `${home}/Library/Application Support`
		: platform === 'win32'
			? (env.APPDATA || `${home}\\AppData\\Roaming`)
			: (env.XDG_CONFIG_HOME || `${home}/.config`);
	return EDITORS.map(editor => ({ id: editor.id, label: editor.label, dir: `${base}${sep}${editor.folder}` }));
}

/** Local folder URIs from a recently opened list, most recent first. Workspaces files, remotes and files are skipped. */
export function parseRecentlyOpened(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const entries = (parsed as { entries?: unknown })?.entries;
	if (!Array.isArray(entries)) {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const folderUri = (entry as { folderUri?: unknown })?.folderUri;
		if (typeof folderUri === 'string' && folderUri.startsWith('file://')) {
			out.push(folderUri);
		}
	}
	return out;
}

/** Older builds' `storage.json`: `openedPathsList.entries` (or `workspaces3`), then the last open windows. */
export function parseLegacyStorage(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return [];
	}
	const out: string[] = [];
	const opened = parsed.openedPathsList as { entries?: unknown; workspaces3?: unknown } | undefined;
	if (opened) {
		out.push(...parseRecentlyOpened(JSON.stringify({ entries: opened.entries ?? [] })));
		if (Array.isArray(opened.workspaces3)) {
			out.push(...opened.workspaces3.filter((value): value is string => typeof value === 'string' && value.startsWith('file://')));
		}
	}
	const windows = parsed.windowsState as { lastActiveWindow?: { folder?: unknown }; openedWindows?: { folder?: unknown }[] } | undefined;
	for (const window of [windows?.lastActiveWindow, ...(windows?.openedWindows ?? [])]) {
		if (typeof window?.folder === 'string' && window.folder.startsWith('file://')) {
			out.push(window.folder);
		}
	}
	return out;
}

/** `file:///Users/me/My%20App` → `/Users/me/My App`; `file:///c%3A/src` → `c:\src` on Windows. */
export function folderUriToPath(uri: string, platform: 'darwin' | 'win32' | 'linux'): string | undefined {
	if (!uri.startsWith('file://')) {
		return undefined;
	}
	let path: string;
	try {
		const rest = uri.slice('file://'.length);
		const slash = rest.indexOf('/');
		const authority = slash < 0 ? rest : rest.slice(0, slash);
		path = decodeURIComponent(slash < 0 ? '/' : rest.slice(slash));
		if (authority && platform === 'win32') {
			// UNC: file://server/share/x → \\server\share\x
			return `\\\\${authority}${path.replace(/\//g, '\\')}`;
		}
	} catch {
		return undefined;
	}
	if (platform === 'win32') {
		if (/^\/[a-zA-Z]:/.test(path)) {
			path = path.slice(1);
		}
		path = path.replace(/\//g, '\\');
	} else if (path.length > 1 && path.endsWith('/')) {
		path = path.slice(0, -1);
	}
	return path;
}

/** Keeps the first of each path (case-insensitively on Windows and macOS), in order, up to `limit`. */
export function dedupeFolders(paths: readonly string[], caseInsensitive: boolean, limit = 50): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const key = caseInsensitive ? path.toLowerCase() : path;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(path);
			if (out.length >= limit) {
				break;
			}
		}
	}
	return out;
}
