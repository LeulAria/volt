/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-project settings that live on this machine (not in the repository): the model new chats
 * start on and the environment agent processes get. Worktree setup is the repository's own
 * `.volt/worktrees.json`, read and written here in the format run groups read.
 */

export const PROJECT_SETTINGS_STORAGE_KEY = 'volt.projects.settings.v1';

export interface IVoltProjectSettings {
	/** Catalog ref new chats in the project start on; undefined keeps the last model picked. */
	readonly defaultModel?: string;
	/** Extra environment for agent processes started in the project (or its worktrees). */
	readonly env?: Readonly<Record<string, string>>;
}

export type ProjectSettingsMap = Readonly<Record<string, IVoltProjectSettings>>;

/** Tolerates anything in storage: unknown keys and wrong types are dropped. */
export function normalizeProjectSettings(raw: unknown): ProjectSettingsMap {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	const out: Record<string, IVoltProjectSettings> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') {
			continue;
		}
		const record = value as Record<string, unknown>;
		const defaultModel = typeof record.defaultModel === 'string' && record.defaultModel ? record.defaultModel : undefined;
		let env: Record<string, string> | undefined;
		if (record.env && typeof record.env === 'object' && !Array.isArray(record.env)) {
			env = {};
			for (const [key, envValue] of Object.entries(record.env as Record<string, unknown>)) {
				if (isEnvName(key) && typeof envValue === 'string') {
					env[key] = envValue;
				}
			}
			if (!Object.keys(env).length) {
				env = undefined;
			}
		}
		if (defaultModel || env) {
			out[id] = { ...(defaultModel ? { defaultModel } : {}), ...(env ? { env } : {}) };
		}
	}
	return out;
}

/** Sets (or, with an empty value, clears) one project's settings. */
export function withProjectSettings(map: ProjectSettingsMap, id: string, settings: IVoltProjectSettings): ProjectSettingsMap {
	const { [id]: _previous, ...rest } = map;
	const next = normalizeProjectSettings({ [id]: settings })[id];
	return next ? { ...rest, [id]: next } : rest;
}

export function isEnvName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export interface IEnvParse {
	readonly env: Record<string, string>;
	/** 1-based line numbers that are not `NAME=value`. */
	readonly invalidLines: readonly number[];
}

/**
 * `.env`-style text: `NAME=value` per line, `#` comments and blank lines ignored, an optional
 * `export ` prefix, and matching outer quotes stripped. A later line wins.
 */
export function parseEnvText(text: string): IEnvParse {
	const env: Record<string, string> = {};
	const invalidLines: number[] = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			return;
		}
		const body = trimmed.replace(/^export\s+/, '');
		const eq = body.indexOf('=');
		const name = eq > 0 ? body.slice(0, eq).trim() : '';
		if (!isEnvName(name)) {
			invalidLines.push(index + 1);
			return;
		}
		let value = body.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === '\'') && value[value.length - 1] === value[0]) {
			value = value.slice(1, -1);
		}
		env[name] = value;
	});
	return { env, invalidLines };
}

export function formatEnvText(env: Readonly<Record<string, string>> | undefined): string {
	return Object.entries(env ?? {}).map(([name, value]) => `${name}=${/\s|#/.test(value) ? JSON.stringify(value) : value}`).join('\n');
}

/** Where Volt and Cursor look for worktree setup, Volt's first. */
export const VOLT_WORKTREES_FILE = '.volt/worktrees.json';
export const CURSOR_WORKTREES_FILE = '.cursor/worktrees.json';

export interface IWorktreeSetupRead {
	/** One command per entry; a single script path when {@link script} is set. */
	readonly steps: readonly string[];
	/** The value was a script path rather than a list of commands. */
	readonly script: boolean;
	/** The file is there but could not be read as setup; saving would replace it. */
	readonly error?: string;
}

/** The commands of `setup-worktree` (or this platform's `setup-worktree-unix` / `-windows`). */
export function readWorktreeSetup(text: string | undefined, platform: 'unix' | 'windows'): IWorktreeSetupRead {
	if (text === undefined) {
		return { steps: [], script: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { steps: [], script: false, error: err instanceof Error ? err.message : String(err) };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { steps: [], script: false, error: 'not a JSON object' };
	}
	const record = parsed as Record<string, unknown>;
	const value = record[platform === 'windows' ? 'setup-worktree-windows' : 'setup-worktree-unix'] ?? record['setup-worktree'];
	if (typeof value === 'string') {
		return { steps: value.trim() ? [value.trim()] : [], script: !!value.trim() };
	}
	if (Array.isArray(value)) {
		return { steps: value.filter((step): step is string => typeof step === 'string').map(step => step.trim()).filter(Boolean), script: false };
	}
	return { steps: [], script: false };
}

/**
 * The file's new text with `setup-worktree` set to `steps` (or removed when empty). Other keys,
 * including the per-platform ones, stay as they were. Undefined: delete the file (nothing left).
 */
export function writeWorktreeSetup(existing: string | undefined, steps: readonly string[]): string | undefined {
	let record: Record<string, unknown> = {};
	if (existing !== undefined) {
		try {
			const parsed = JSON.parse(existing);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				record = parsed;
			}
		} catch {
			// Unreadable: replaced.
		}
	}
	const clean = steps.map(step => step.trim()).filter(Boolean);
	const { ['setup-worktree']: _old, ...rest } = record;
	const next = clean.length ? { 'setup-worktree': clean, ...rest } : rest;
	return Object.keys(next).length ? `${JSON.stringify(next, undefined, '\t')}\n` : undefined;
}

/** Text area lines → steps. */
export function stepsFromText(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** The project whose folder holds `cwd` (deepest root wins), for env lookup. */
export function projectForPath<T extends { readonly root: string }>(cwd: string | undefined, projects: readonly T[], caseInsensitive: boolean): T | undefined {
	if (!cwd) {
		return undefined;
	}
	const norm = (path: string) => {
		const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
		return caseInsensitive ? unified.toLowerCase() : unified;
	};
	const target = norm(cwd);
	let best: T | undefined;
	let bestLength = -1;
	for (const project of projects) {
		const root = norm(project.root);
		if ((target === root || target.startsWith(`${root}/`)) && root.length > bestLength) {
			best = project;
			bestLength = root.length;
		}
	}
	return best;
}
