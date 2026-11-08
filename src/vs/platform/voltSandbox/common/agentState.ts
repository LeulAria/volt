/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-chat config overlays for agent CLIs (B-05, INV-17). Pure: the node side
 * (agentStateOverlay.ts) creates the folders and copies files; the agent profile
 * (sandboxPolicy.ts) makes them readable and writable.
 *
 * An agent CLI rewrites its own config as it runs (Claude Code's `~/.claude.json` holds MCP
 * servers and trusted folders next to counters and session ids). A sandboxed chat must not be able
 * to plant anything there that a later unsandboxed run of the same CLI picks up. So for CLIs that
 * take their config folder from the environment, a sandboxed chat gets its own copy:
 *
 * - the variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_CONFIG_DIR`) points at a per-chat
 *   folder under `~/.volt/sandbox/agent-state/<chat>/<provider>/config`;
 * - the user's settings, instructions, skills and plugins are linked in read-only, and the link
 *   names are protected, so the sandbox can neither change them nor replace a link;
 * - config files the CLI must write (`.claude.json`, `cli-config.json`) are copied in fresh at
 *   each launch and writable there; after each turn Volt copies back only the keys on the
 *   provider's list (session ids, counters) and reports every other change as dropped;
 * - logins keep working: on macOS Claude Code keeps using the user's keychain item (its
 *   `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set to the real folder); credential files are copied
 *   in, and a refreshed login is copied back only when it is provably the same account.
 */

/** Where a provider's overlay comes from. Paths are relative to the home folder. */
export interface IAgentOverlaySpec {
	/** The variable the CLI reads its config folder from. */
	readonly env: string;
	/** The real config folder, used when the user has not set `env` themselves. */
	readonly home: string;
	/** Entries of the real folder linked in read-only: settings, instructions, skills, plugins. */
	readonly link: readonly string[];
	/** Files copied in at each launch (writable in the overlay), and the keys copied back after a turn. */
	readonly seed: readonly IAgentSeedSpec[];
	/** Login files kept in the config folder: copied in, and back when they are the same account and newer. */
	readonly credentials?: readonly IAgentCredentialSpec[];
	/** Claude Code: where its login lives, apart from the config folder. */
	readonly secureStorage?: { readonly env: string; readonly file: string; readonly freshness: readonly string[]; readonly identity: 'claude' };
	/** More variables the overlay sets (`${config}` is the overlay folder). */
	readonly setEnv?: Readonly<Record<string, string>>;
}

export interface IAgentSeedSpec {
	/** Name in the overlay. */
	readonly name: string;
	/** Where it is copied from: `config:<name>` (the real config folder) or `home:<path>`. */
	readonly from: string;
	/**
	 * Keys copied back after a turn, as dotted paths; `*` matches one key (`projects.*.lastSessionId`).
	 * A path also covers everything below it.
	 */
	readonly mergeBack: readonly string[];
}

export interface IAgentCredentialSpec {
	readonly name: string;
	/** Dotted path of the value that grows with every refresh (a timestamp or an expiry). */
	readonly freshness: readonly string[];
	/** Dotted paths that must be equal in both copies for the overlay's to be written back. */
	readonly identity: readonly string[];
}

/** Claude Code's global config: what a turn may change in the user's copy. */
const CLAUDE_MERGE_BACK = [
	'numStartups', 'tipsHistory', 'promptQueueUseCount',
	'projects.*.lastSessionId', 'projects.*.lastCost', 'projects.*.lastAPIDuration', 'projects.*.lastAPIDurationWithoutRetries', 'projects.*.lastToolDuration',
	'projects.*.lastDuration', 'projects.*.lastLinesAdded', 'projects.*.lastLinesRemoved', 'projects.*.lastTotalInputTokens', 'projects.*.lastTotalOutputTokens',
	'projects.*.lastTotalCacheCreationInputTokens', 'projects.*.lastTotalCacheReadInputTokens', 'projects.*.lastTotalWebSearchRequests', 'projects.*.lastModelUsage',
	'projects.*.lastSessionMetrics', 'projects.*.exampleFiles', 'projects.*.exampleFilesGeneratedAt', 'projects.*.hasCompletedProjectOnboarding',
	'projects.*.projectOnboardingSeenCount',
];

export const AGENT_OVERLAYS: Readonly<Record<string, IAgentOverlaySpec>> = {
	'claude-code': {
		env: 'CLAUDE_CONFIG_DIR',
		home: '.claude',
		link: ['settings.json', 'settings.local.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'hooks', 'plugins', 'output-styles', 'rules', 'keybindings.json', 'statusline.sh'],
		seed: [{ name: '.claude.json', from: 'home:.claude.json', mergeBack: CLAUDE_MERGE_BACK }],
		secureStorage: { env: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', file: '.credentials.json', freshness: ['claudeAiOauth', 'expiresAt'], identity: 'claude' },
	},
	codex: {
		env: 'CODEX_HOME',
		home: '.codex',
		link: ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'rules', 'skills', 'plugins', 'prompts', 'hooks.json'],
		seed: [],
		// Codex refreshes its ChatGPT login into auth.json; the account id must not change.
		credentials: [{ name: 'auth.json', freshness: ['last_refresh'], identity: ['tokens.account_id', 'OPENAI_API_KEY'] }],
	},
	'cursor-acp': {
		env: 'CURSOR_CONFIG_DIR',
		home: '.cursor',
		link: ['mcp.json', 'hooks.json', 'hooks', 'rules', 'skills', 'skills-cursor', 'agents', 'plugins', 'extensions', 'permissions.json', 'sandbox-policies'],
		// The CLI saves the model it last used here. Its command allow lists, approval mode and own
		// sandbox settings live in the same file and stay as the user set them.
		seed: [{ name: 'cli-config.json', from: 'config:cli-config.json', mergeBack: ['model', 'selectedModel', 'hasChangedDefaultModel', 'modelParameters', 'modelSelectionHistory', 'maxMode'] }],
		// Its project data (MCP approvals among it) goes with the overlay too.
		setEnv: { CURSOR_DATA_DIR: '${config}' },
	},
};

/** Machine facts an overlay plan needs. */
export interface IAgentStateHost {
	readonly platform: string;
	/** Real path. */
	readonly home: string;
	/** `~/.volt/sandbox/agent-state`. */
	readonly root: string;
	/** The user's environment: an overlay variable they set themselves names the real folder. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
}

/** A link in the overlay. */
export interface IAgentStateLink {
	/** In the overlay. */
	readonly path: string;
	/** The user's real file or folder. */
	readonly target: string;
}

export interface IAgentStateSeed {
	readonly path: string;
	readonly from: string;
	readonly snapshot: string;
	readonly mergeBack: readonly string[];
}

export interface IAgentStateCredential {
	/** The per-chat copy. */
	readonly path: string;
	/** The user's real file. */
	readonly real: string;
	readonly freshness: readonly string[];
	/** Dotted paths that must match, or `claude` (checked against the account the token belongs to). */
	readonly identity: readonly string[] | 'claude';
	/** The real global config holding `oauthAccount` (identity `claude`). */
	readonly account?: string;
}

/** Everything one sandboxed agent launch needs for its overlay. All paths absolute. */
export interface IAgentStatePlan {
	readonly providerId: string;
	/** `<root>/<chat>/<provider>`: Volt's, never reachable from the sandbox as a whole. */
	readonly dir: string;
	/** The overlay the CLI's variable points at. Writable, minus `protect`. */
	readonly configDir: string;
	/** The seed snapshots: what the overlay started with, for the merge. Not reachable from the sandbox. */
	readonly seedDir: string;
	/** Per-chat login folder, when the login is copied in. Writable. */
	readonly secureDir?: string;
	readonly env: Readonly<Record<string, string>>;
	readonly links: readonly IAgentStateLink[];
	readonly seeds: readonly IAgentStateSeed[];
	readonly credentials: readonly IAgentStateCredential[];
	/** Readable in the sandbox: the link targets. */
	readonly read: readonly string[];
	/** Writable in the sandbox: the overlay and its login folder. */
	readonly write: readonly string[];
	/** Writable single files in the real home (Claude Code's login on macOS: the keychain's fallback file and its lock). */
	readonly writeFiles: readonly string[];
	/** Never writable: the links and every config name in the overlay. */
	readonly protect: readonly string[];
}

/** A chat id as a folder name. */
export function agentStateKey(key: string | undefined): string {
	const clean = (key ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120);
	return clean || 'default';
}

function joinPath(...parts: string[]): string {
	return parts.join('/').replace(/\/{2,}/g, '/');
}

/** The overlay plan for one launch, or undefined when the provider has none (its config stays read-only). */
export function agentStatePlan(providerId: string, stateKey: string | undefined, host: IAgentStateHost, configNames: readonly string[]): IAgentStatePlan | undefined {
	const spec = AGENT_OVERLAYS[providerId];
	if (!spec || host.platform === 'win32') {
		return undefined;
	}
	const own = host.hostEnv[spec.env]?.trim();
	// The user's own folder, as they named it (Claude Code hashes the name as given for its keychain item).
	const realConfig = own && own.startsWith('/') ? own : joinPath(host.home, spec.home);
	const dir = joinPath(host.root, agentStateKey(stateKey), providerId);
	const configDir = joinPath(dir, 'config');
	const seedDir = joinPath(dir, 'seed');
	const env: Record<string, string> = { [spec.env]: configDir };
	for (const [name, value] of Object.entries(spec.setEnv ?? {})) {
		env[name] = value.replace(/\$\{config\}/g, configDir);
	}
	const links = spec.link.map(name => ({ path: joinPath(configDir, name), target: joinPath(realConfig, name) }));
	const seeds = spec.seed.map(seed => ({
		path: joinPath(configDir, seed.name),
		from: seed.from.startsWith('config:') ? joinPath(realConfig, seed.from.slice('config:'.length)) : own && seed.from === 'home:.claude.json' ? joinPath(realConfig, '.claude.json') : joinPath(host.home, seed.from.slice('home:'.length)),
		snapshot: joinPath(seedDir, seed.name),
		mergeBack: seed.mergeBack,
	}));
	const credentials: IAgentStateCredential[] = (spec.credentials ?? []).map(credential => ({
		path: joinPath(configDir, credential.name),
		real: joinPath(realConfig, credential.name),
		freshness: credential.freshness,
		identity: credential.identity,
	}));
	const write = [configDir];
	const writeFiles: string[] = [];
	let secureDir: string | undefined;
	const storage = spec.secureStorage;
	if (storage) {
		if (host.platform === 'darwin') {
			// The login stays in the user's keychain item: the CLI's secure-storage folder names the real
			// config folder ('' is its default, `~/.claude`), so the item's name does not change. Only its
			// plain-text fallback file and the storage lock are written in the real folder.
			env[storage.env] = own && own.startsWith('/') ? own : '';
			writeFiles.push(joinPath(realConfig, storage.file), joinPath(realConfig, '.storage-write.lock'));
		} else {
			secureDir = joinPath(dir, 'secure');
			env[storage.env] = secureDir;
			write.push(secureDir);
			credentials.push({
				path: joinPath(secureDir, storage.file),
				real: joinPath(realConfig, storage.file),
				freshness: storage.freshness,
				identity: 'claude',
				account: seeds.find(seed => seed.path.endsWith('/.claude.json'))?.from,
			});
		}
	}
	const linkNames = new Set(spec.link);
	const protect = [...links.map(link => link.path), ...configNames.filter(name => !linkNames.has(name) && !spec.seed.some(seed => seed.name === name)).map(name => joinPath(configDir, name))];
	return {
		providerId,
		dir,
		configDir,
		seedDir,
		...(secureDir ? { secureDir } : {}),
		env,
		links,
		seeds,
		credentials,
		read: links.map(link => link.target),
		write,
		writeFiles,
		protect: [...new Set(protect)],
	};
}

// --- Merging back ---------------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

/** Keys that never cross: prototype pollution. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** One merged value at most this big (as JSON). */
const MAX_MERGED_VALUE = 64 * 1024;
const MAX_DEPTH = 4;

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `a.b`, with keys that hold dots, slashes or spaces quoted: `projects["/Users/me/repo"].lastSessionId`. */
export function formatKeyPath(path: readonly string[]): string {
	return path.map((key, i) => /^[A-Za-z_$][\w$-]*$/.test(key) ? `${i ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`).join('');
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Every changed leaf between `before` and `after` (objects are walked; arrays and scalars are leaves). */
function changedPaths(before: unknown, after: unknown, prefix: string[] = [], out: string[][] = []): string[][] {
	if (prefix.length < MAX_DEPTH && (isRecord(before) || isRecord(after)) && (before === undefined || isRecord(before)) && (after === undefined || isRecord(after))) {
		const b = isRecord(before) ? before : {};
		const a = isRecord(after) ? after : {};
		let changed = false;
		for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
			if (!same(b[key], a[key])) {
				changed = true;
				changedPaths(b[key], a[key], [...prefix, key], out);
			}
		}
		if (!changed && !same(before, after)) {
			// An empty object added or removed.
			out.push(prefix);
		}
		return out;
	}
	if (!same(before, after)) {
		out.push(prefix);
	}
	return out;
}

/** Whether `pattern` (dotted, `*` for one key) names `path` or a parent of it. */
export function keyPatternCovers(pattern: string, path: readonly string[]): boolean {
	const parts = pattern.split('.');
	return parts.length <= path.length && parts.every((part, i) => part === '*' || part === path[i]);
}

/** Whether some path `pattern` names lies at or below `prefix`. */
function patternReaches(pattern: string, prefix: readonly string[]): boolean {
	const parts = pattern.split('.');
	return prefix.length <= parts.length ? prefix.every((key, i) => parts[i] === '*' || parts[i] === key) : keyPatternCovers(pattern, prefix);
}

/** A dropped change as the user reads it: one key below where the allowed keys end (`mcpServers.evil`). */
function droppedLabel(path: readonly string[], allowed: readonly string[]): string {
	let end = 0;
	while (end < path.length && allowed.some(pattern => patternReaches(pattern, path.slice(0, end + 1)))) {
		end++;
	}
	return formatKeyPath(path.slice(0, Math.min(path.length, end + 2)));
}

function valueAt(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

export interface IAgentStateMerge {
	/** The user's file with the allowed changes applied; undefined when nothing changes. */
	readonly merged?: JsonRecord;
	/** Allowed changes, applied. */
	readonly applied: readonly string[];
	/** Every other change the sandbox made, kept out of the user's file. */
	readonly dropped: readonly string[];
}

/**
 * What a turn changed in an overlay file (`seed` is what it started with, `after` what it holds
 * now), applied to the user's current file `real` for the keys `allowed` names. Changes the user
 * made meanwhile to other keys stay.
 */
export function mergeAgentState(seed: unknown, after: unknown, real: unknown, allowed: readonly string[]): IAgentStateMerge {
	const applied: string[] = [];
	const dropped: string[] = [];
	if (!isRecord(after)) {
		return { applied, dropped: isRecord(seed) ? ['(the whole file)'] : [] };
	}
	let merged: JsonRecord | undefined;
	for (const path of changedPaths(seed, after)) {
		const value = valueAt(after, path);
		const ok = path.length > 0
			&& !path.some(key => FORBIDDEN_KEYS.has(key))
			&& allowed.some(pattern => keyPatternCovers(pattern, path))
			&& (value === undefined || JSON.stringify(value).length <= MAX_MERGED_VALUE);
		if (!ok) {
			const label = droppedLabel(path, allowed);
			if (!dropped.includes(label)) {
				dropped.push(label);
			}
			continue;
		}
		merged ??= structuredCloneJson(isRecord(real) ? real : {});
		setAt(merged, path, value as JsonValue | undefined);
		applied.push(formatKeyPath(path));
	}
	return { ...(merged ? { merged } : {}), applied, dropped };
}

function structuredCloneJson(value: JsonRecord): JsonRecord {
	return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function setAt(target: JsonRecord, path: readonly string[], value: JsonValue | undefined): void {
	let current = target;
	for (const key of path.slice(0, -1)) {
		const next = current[key];
		if (!isRecord(next)) {
			current[key] = {};
		}
		current = current[key] as JsonRecord;
	}
	const last = path[path.length - 1];
	if (value === undefined) {
		delete current[last];
	} else {
		current[last] = value;
	}
}

/** A credential's freshness as a number (an epoch in ms, or an ISO date), or undefined. */
export function credentialFreshness(value: unknown, path: readonly string[]): number | undefined {
	const raw = valueAt(value, path);
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return raw;
	}
	if (typeof raw === 'string') {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** Whether every identity path holds the same value in both (absent in both counts as the same). */
export function sameCredentialIdentity(a: unknown, b: unknown, identity: readonly string[]): boolean {
	return identity.every(path => same(valueAt(a, path.split('.')) ?? null, valueAt(b, path.split('.')) ?? null));
}
