/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const IGNORE_SUFFIXES = ['.map', '.tsbuildinfo', '.d.ts'];
const CSS_SUFFIX = '.css';
const JS_SUFFIX = '.js';

const FULL_RELOAD_PATHS = [
	'/electron-main/',
	'/code/electron-main/',
	'/platform/windows/electron-main/',
	'/workbench/electron-browser/desktop.main.js',
	'/workbench/workbench.desktop.main.js',
	'/code/electron-browser/workbench/workbench.js',
	'/bootstrap',
	'/main.js',
];

const FULL_RELOAD_SUFFIXES = [
	'.contribution.js',
];

export function isDevReloadAsset(relativePath: string): boolean {
	const path = normalizeRel(relativePath);
	if (!path || IGNORE_SUFFIXES.some(suffix => path.endsWith(suffix))) {
		return false;
	}
	return path.endsWith(CSS_SUFFIX) || path.endsWith(JS_SUFFIX);
}

export function isDevReloadCss(relativePath: string): boolean {
	return normalizeRel(relativePath).endsWith(CSS_SUFFIX);
}

export function isDevReloadJs(relativePath: string): boolean {
	const path = normalizeRel(relativePath);
	return path.endsWith(JS_SUFFIX) && !path.endsWith('.d.ts');
}

/**
 * Contribution modules and process entrypoints cannot be patched in place.
 * Everything else can try ESM/CSS hot apply first.
 */
export function requiresFullWindowReload(relativePath: string): boolean {
	const path = normalizeRel(relativePath);
	if (!isDevReloadJs(path)) {
		return false;
	}
	if (FULL_RELOAD_SUFFIXES.some(suffix => path.endsWith(suffix))) {
		return true;
	}
	return FULL_RELOAD_PATHS.some(marker => path.includes(marker) || path.endsWith(marker.slice(1)));
}

/** A burst this large is the initial `out/` transpile, not a real edit. */
export function isInitialCompileBurst(changeCount: number): boolean {
	return changeCount >= 20;
}

export function toOutRelativePath(outDirFsPath: string, fileFsPath: string): string {
	const prefix = outDirFsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const file = fileFsPath.replace(/\\/g, '/');
	if (file === prefix) {
		return '';
	}
	if (file.startsWith(`${prefix}/`)) {
		return file.slice(prefix.length + 1);
	}
	return file;
}

function normalizeRel(relativePath: string): string {
	return relativePath.replace(/\\/g, '/');
}
