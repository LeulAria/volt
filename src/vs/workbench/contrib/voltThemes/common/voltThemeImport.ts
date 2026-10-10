/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Where a theme extension was found. */
export type VoltThemeImportSource = 'vscode' | 'cursor';

export interface IVoltThemeImportTheme {
	readonly label: string;
	/** `vs`, `vs-dark`, `hc-black` or `hc-light`. */
	readonly uiTheme: string;
}

export interface IVoltThemeImportCandidate {
	/** `publisher.name`, lower case: the extension's identity. */
	readonly id: string;
	readonly displayName: string;
	readonly publisher: string;
	readonly version: string;
	readonly source: VoltThemeImportSource;
	/** The extension folder's name inside its editor's extensions directory. */
	readonly folderName: string;
	readonly themes: readonly IVoltThemeImportTheme[];
}

/** Contribution points a pure theme package may carry besides color themes. */
const THEME_ONLY_POINTS = new Set(['themes', 'iconThemes', 'productIconThemes']);

/**
 * A theme extension from its package.json: it contributes color themes and is a theme package
 * (category "Themes", or nothing but themes). Language packs that happen to ship a theme (C#
 * contributes "Visual Studio 2019") are not offered: copying them would install a language server.
 */
export function parseThemeExtension(manifest: unknown, folderName: string, source: VoltThemeImportSource): IVoltThemeImportCandidate | undefined {
	if (!manifest || typeof manifest !== 'object') {
		return undefined;
	}
	const m = manifest as { name?: unknown; publisher?: unknown; version?: unknown; displayName?: unknown; categories?: unknown; contributes?: unknown; main?: unknown; browser?: unknown };
	if (typeof m.name !== 'string' || typeof m.publisher !== 'string' || typeof m.version !== 'string' || !m.contributes || typeof m.contributes !== 'object') {
		return undefined;
	}
	const contributes = m.contributes as Record<string, unknown>;
	const raw = contributes.themes;
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const themes = raw.flatMap((t): IVoltThemeImportTheme[] => {
		if (!t || typeof t !== 'object' || typeof (t as { path?: unknown }).path !== 'string') {
			return [];
		}
		const { label, id, uiTheme } = t as { label?: unknown; id?: unknown; uiTheme?: unknown };
		const name = typeof label === 'string' && label ? label : typeof id === 'string' ? id : undefined;
		return name ? [{ label: name, uiTheme: typeof uiTheme === 'string' ? uiTheme : 'vs-dark' }] : [];
	});
	if (!themes.length) {
		return undefined;
	}
	const categories = Array.isArray(m.categories) ? m.categories : [];
	const themeCategory = categories.some(c => typeof c === 'string' && c.toLowerCase() === 'themes');
	const onlyThemes = Object.keys(contributes).every(key => THEME_ONLY_POINTS.has(key)) && !m.main && !m.browser;
	if (!themeCategory && !onlyThemes) {
		return undefined;
	}
	return {
		id: `${m.publisher}.${m.name}`.toLowerCase(),
		displayName: typeof m.displayName === 'string' && m.displayName && !m.displayName.startsWith('%') ? m.displayName : m.name,
		publisher: m.publisher,
		version: m.version,
		source,
		folderName,
		themes,
	};
}

/** Semver-ish compare of `major.minor.patch[-tag]`; a release sorts above its pre-release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, tag] = v.split('-', 2);
		return { parts: core.split('.').map(p => parseInt(p, 10) || 0), tag };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	if (x.tag === y.tag) {
		return 0;
	}
	return x.tag === undefined ? 1 : y.tag === undefined ? -1 : x.tag < y.tag ? -1 : 1;
}

/**
 * One candidate per extension: the newest version found, VS Code's copy on a tie. Sorted by name.
 */
export function newestCandidates(candidates: readonly IVoltThemeImportCandidate[]): IVoltThemeImportCandidate[] {
	const byId = new Map<string, IVoltThemeImportCandidate>();
	for (const candidate of candidates) {
		const seen = byId.get(candidate.id);
		const order = seen ? compareVersions(candidate.version, seen.version) : 1;
		if (!seen || order > 0 || (order === 0 && candidate.source === 'vscode' && seen.source !== 'vscode')) {
			byId.set(candidate.id, candidate);
		}
	}
	return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The folders an editor still has installed, from its `extensions/extensions.json`; `undefined`
 * when the file is missing or unreadable (then every folder counts). Folders named in
 * `.obsolete` are leftovers the editor will delete.
 */
export function installedFolders(extensionsJson: string | undefined, obsoleteJson: string | undefined): { readonly installed: ReadonlySet<string> | undefined; readonly obsolete: ReadonlySet<string> } {
	const obsolete = new Set<string>();
	try {
		const parsed: unknown = obsoleteJson ? JSON.parse(obsoleteJson) : undefined;
		if (parsed && typeof parsed === 'object') {
			for (const [key, value] of Object.entries(parsed)) {
				if (value) {
					obsolete.add(key);
				}
			}
		}
	} catch {
		// A broken .obsolete only means nothing is hidden.
	}
	let installed: Set<string> | undefined;
	try {
		const parsed: unknown = extensionsJson ? JSON.parse(extensionsJson) : undefined;
		if (Array.isArray(parsed)) {
			installed = new Set();
			for (const entry of parsed as ({ relativeLocation?: unknown; location?: { path?: unknown } } | null)[]) {
				const relative = entry?.relativeLocation;
				const path = entry?.location?.path;
				if (typeof relative === 'string') {
					installed.add(relative);
				} else if (typeof path === 'string') {
					installed.add(path.slice(path.lastIndexOf('/') + 1));
				}
			}
		}
	} catch {
		installed = undefined;
	}
	return { installed, obsolete };
}

/** The folder name VS Code gives an extension: `publisher.name-version`. */
export function extensionFolderName(candidate: Pick<IVoltThemeImportCandidate, 'id' | 'version'>): string {
	return `${candidate.id}-${candidate.version}`;
}

export const IMPORTABLE_THEME_SETTINGS = ['workbench.colorTheme', 'workbench.colorCustomizations', 'editor.tokenColorCustomizations'] as const;
export type ImportableThemeSetting = typeof IMPORTABLE_THEME_SETTINGS[number];

/** The theme settings an editor's settings.json sets (already parsed as JSONC). */
export function importableThemeSettings(settings: unknown): Partial<Record<ImportableThemeSetting, unknown>> {
	const result: Partial<Record<ImportableThemeSetting, unknown>> = {};
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
		return result;
	}
	const values = settings as Record<string, unknown>;
	const theme = values['workbench.colorTheme'];
	if (typeof theme === 'string' && theme) {
		result['workbench.colorTheme'] = theme;
	}
	for (const key of ['workbench.colorCustomizations', 'editor.tokenColorCustomizations'] as const) {
		const value = values[key];
		if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
			result[key] = value;
		}
	}
	return result;
}
