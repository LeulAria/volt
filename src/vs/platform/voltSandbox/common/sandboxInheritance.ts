/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How sandbox settings combine across chats, and which folders a denial may grant. Pure.
 *
 * A sandboxed chat that starts or instructs another chat must not reach through it what its own
 * sandbox denies: children are confined at least as tightly as the chat that made them.
 */

import { chatCovers, IChatView } from './authority.js';
import { networkEntryWithin } from './networkRules.js';
import { chatSubject } from './principals.js';
import { isPathInside, IVoltSandboxSettings, normalizeSandboxPath, SandboxStrategy, strategyAtLeast, VoltSandboxLevel } from './sandboxPolicy.js';

/**
 * What a chat's sandbox covers beyond its settings (INV-11): how its agent is sandboxed, and the
 * folders it works in. Optional so callers that know only the settings still compare those.
 */
export interface ISandboxScope {
	/** Its agent's strategy (`sandboxStrategy` of its provider at its level). Unknown: `wrap` for a sandboxed level. */
	readonly strategy?: SandboxStrategy;
	/**
	 * Real paths of its workspace roots (its checkout, and a linked worktree's git dir): what it
	 * writes at `workspace-write`. Unknown: only its allowed folders are compared.
	 */
	readonly roots?: readonly string[];
}

const LEVEL_RANK: Readonly<Record<VoltSandboxLevel, number>> = { 'off': 0, 'workspace-write': 1, 'read-only': 2 };

/** Every host, for a side whose network is unrestricted. */
const ALL = 'all';
type DomainSet = readonly string[] | typeof ALL;

/**
 * True when every connection `pattern` lets through, `by` lets through, by the broker's rules
 * (`networkEntryWithin`): `*` is the web ports without paste sites or IP literals, `*.example.com`
 * its descendants on 443, never `example.com` itself.
 */
function domainPatternCovered(pattern: string, by: string): boolean {
	return pattern.trim().toLowerCase() === by.trim().toLowerCase() || networkEntryWithin(pattern, [by]);
}

function intersectDomains(a: DomainSet, b: DomainSet): DomainSet {
	if (a === ALL) {
		return b;
	}
	if (b === ALL) {
		return a;
	}
	const kept = [...a.filter(x => b.some(y => domainPatternCovered(x, y))), ...b.filter(y => a.some(x => domainPatternCovered(y, x)))];
	return [...new Set(kept.map(domain => domain.trim().toLowerCase()))];
}

/** Folders writable under both lists: for each nested pair, the inner one. */
function intersectRoots(a: readonly string[], b: readonly string[]): string[] {
	const kept: string[] = [];
	for (const x of a.map(normalizeSandboxPath)) {
		for (const y of b.map(normalizeSandboxPath)) {
			if (isPathInside(x, y)) {
				kept.push(x);
			} else if (isPathInside(y, x)) {
				kept.push(y);
			}
		}
	}
	// Drop folders inside another kept one.
	const unique = [...new Set(kept)];
	return unique.filter(root => !unique.some(other => other !== root && isPathInside(root, other)));
}

/** Hosts a sandboxed side reaches: all of them with network on, else the allowed list (the agent's API is added per provider either way). */
function reachable(settings: IVoltSandboxSettings): DomainSet {
	return settings.network ? ALL : settings.allowedDomains ?? [];
}

/**
 * The settings that allow only what both allow: the higher level (read-only > workspace-write >
 * off), network only when both have it, and the folders and hosts both granted. `off` allows
 * everything, so the other side is returned as is.
 */
export function stricterSandboxSettings(a: IVoltSandboxSettings, b: IVoltSandboxSettings): IVoltSandboxSettings {
	if (a.level === 'off') {
		return b;
	}
	if (b.level === 'off') {
		return a;
	}
	const level = LEVEL_RANK[a.level] >= LEVEL_RANK[b.level] ? a.level : b.level;
	const network = a.network && b.network;
	const roots = intersectRoots(a.extraWritableRoots ?? [], b.extraWritableRoots ?? []);
	// With network on the host lists are dormant (they apply once network goes off): both lists are intersected as written.
	const domains = network ? intersectDomains(a.allowedDomains ?? [], b.allowedDomains ?? []) : intersectDomains(reachable(a), reachable(b));
	const domainList = domains === ALL ? [] : domains;
	const listenPorts = (a.listenPorts ?? []).filter(port => (b.listenPorts ?? []).includes(port));
	return {
		level,
		network,
		...(roots.length ? { extraWritableRoots: roots } : {}),
		...(domainList.length ? { allowedDomains: domainList } : {}),
		...(listenPorts.length ? { listenPorts } : {}),
	};
}

/** Folders a side may write: its allowed folders, and its workspace roots at `workspace-write`. */
function writableRoots(settings: IVoltSandboxSettings, scope: ISandboxScope | undefined): string[] {
	return [...(settings.extraWritableRoots ?? []), ...(settings.level === 'workspace-write' ? scope?.roots ?? [] : [])].map(normalizeSandboxPath);
}

/**
 * True when `a` allows nothing `b` denies: a chat confined by `a` is confined at least as tightly
 * as one confined by `b`. With scopes, also its agent's strategy (`native` is weaker than `wrap`)
 * and the folders it works in (B-10, B-11): a chat that writes its workspace is only as strict as
 * one whose writable folders hold that workspace.
 *
 * Decided by the Policy Authority's `chatCovers` (INV-11, spec M.3 C2 step 4), the rule the host-tool
 * gate and the launcher use, so the three can't disagree. Unknown strategy: `wrap`; unknown roots:
 * only the allowed folders are compared, as before.
 */
export function isAtLeastAsStrict(a: IVoltSandboxSettings, b: IVoltSandboxSettings, scopes?: { readonly a?: ISandboxScope; readonly b?: ISandboxScope }): boolean {
	return chatCovers(scopeView('target', a, scopes?.a), scopeView('caller', b, scopes?.b));
}

function scopeView(name: string, settings: IVoltSandboxSettings, scope: ISandboxScope | undefined): IChatView {
	return { subject: chatSubject(name), settings, strategy: scope?.strategy ?? 'wrap', folders: scope?.roots ?? [] };
}

/**
 * What a child chat (delegated, launched, forked, run by an automation) should be stored with so
 * it is never confined less than `parent`; undefined when it already is (or the parent runs unconfined).
 */
export function inheritedSandboxSettings(parent: IVoltSandboxSettings, child: IVoltSandboxSettings): IVoltSandboxSettings | undefined {
	if (parent.level === 'off' || isAtLeastAsStrict(child, parent)) {
		return undefined;
	}
	return stricterSandboxSettings(parent, child);
}

export interface ISpawnSandboxDecision {
	/** What the child is stored with; undefined when its own settings already cover the caller. */
	readonly settings?: IVoltSandboxSettings;
	/** Its workspace is outside what the caller may write: it runs read-only there (B-AP-14). */
	readonly forcedReadOnly?: boolean;
	/** Why the child may not be started at all. */
	readonly refused?: string;
}

/**
 * The sandbox of a chat a sandboxed caller starts, hands off or moves (thread_launch, handoff,
 * thread_configure, forks; INV-11): at least the caller's settings, an agent strategy no weaker
 * than the caller's (else refused), and write access to its workspace only when that workspace,
 * as a real path, lies inside what the caller may write (else it runs read-only).
 */
export function spawnSandboxSettings(caller: IVoltSandboxSettings, child: IVoltSandboxSettings, scopes: { readonly caller?: ISandboxScope; readonly child?: ISandboxScope } = {}): ISpawnSandboxDecision {
	if (caller.level === 'off') {
		return {};
	}
	const callerStrategy = scopes.caller?.strategy ?? 'wrap';
	const childStrategy = scopes.child?.strategy ?? 'wrap';
	if (!strategyAtLeast(childStrategy, callerStrategy)) {
		return {
			refused: childStrategy === 'none'
				? 'That agent cannot run in Volt\'s sandbox on this machine, and this chat is sandboxed.'
				: 'That agent would run with a weaker sandbox than this chat\'s.',
		};
	}
	let settings = inheritedSandboxSettings(caller, child) ?? child;
	let forcedReadOnly = false;
	const childRoots = (scopes.child?.roots ?? []).map(normalizeSandboxPath);
	if (settings.level === 'workspace-write' && childRoots.length) {
		const callerWrites = writableRoots(caller, scopes.caller);
		if (!childRoots.every(root => callerWrites.some(allowed => isPathInside(root, allowed)))) {
			settings = { ...settings, level: 'read-only' };
			forcedReadOnly = true;
		}
	}
	if (!forcedReadOnly && isAtLeastAsStrict(child, caller, { a: scopes.child, b: scopes.caller }) && settings === child) {
		return {};
	}
	return { settings, ...(forcedReadOnly ? { forcedReadOnly } : {}) };
}

// --- "Allow folder" from a denial -------------------------------------------------------------

/** Never writable from a denial: system folders (and anything inside them). */
const SYSTEM_FOLDERS = [
	'/System', '/Library', '/Applications', '/Network', '/cores', '/private', '/usr', '/bin', '/sbin', '/etc', '/opt', '/var', '/dev',
	'/boot', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/sys', '/run', '/root', '/srv', '/snap', '/nix',
];

/** Temp folders inside the system ones: writable already, so a grant there changes little. */
const TEMP_FOLDERS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];

/**
 * Under the home folder: credentials, browser profiles and code that runs at login. Neither these
 * nor a folder containing them (`~/.config`, `~/Library`) may be granted.
 */
const PROTECTED_HOME = [
	'.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.config/gh', '.netrc', '.npmrc', '.pypirc',
	'.config/git', '.config/autostart', '.config/systemd', '.password-store', '.volt/accounts',
	'Library/Keychains', 'Library/LaunchAgents', 'Library/Cookies', 'Library/Safari',
	'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/Firefox',
	'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge', 'Library/Application Support/Arc',
	'.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
];

/** Folder names whose contents run later, outside the sandbox (hooks, editor tasks, agent settings). */
const PROTECTED_NAMES = ['.git', '.vscode', '.husky', '.claude', '.idea'];

export interface IFolderGrantContext {
	readonly home: string;
	/** The chat's checkout and its repository's `.git` (see sandboxWorkspaceRoots). */
	readonly workspaceRoots: readonly string[];
	/** Volt's user data folder (settings, storage, extensions' state). */
	readonly userDataDir?: string;
}

/**
 * Why `folder` may not be made writable from a denial ("Allow folder"), or undefined when it may.
 * Conservative on purpose: the folder is the parent of whatever path the agent tried, so the
 * agent picks it.
 */
export function folderGrantError(folder: string, context: IFolderGrantContext): string | undefined {
	const given = normalizeSandboxPath(folder);
	if (!given.startsWith('/')) {
		return `${folder} is not an absolute folder.`;
	}
	// `..` would name another folder than the one these checks see (the OS resolves it, they don't).
	if (given.split('/').includes('..')) {
		return `${folder} is not a plain folder path.`;
	}
	// Compared in one case: macOS and Windows folders are case-insensitive (`~/LIBRARY` is `~/Library`).
	const path = given.split('/').filter(segment => segment !== '.').join('/') || '/';
	return folderRefusal(path, path.toLowerCase(), {
		home: normalizeSandboxPath(context.home).toLowerCase(),
		workspaceRoots: context.workspaceRoots.map(root => normalizeSandboxPath(root).toLowerCase()),
		...(context.userDataDir ? { userDataDir: normalizeSandboxPath(context.userDataDir).toLowerCase() } : {}),
	});
}

/** {@link folderGrantError} on `path` and a context folded to lower case; `shown` is the folder as given. */
function folderRefusal(shown: string, path: string, context: IFolderGrantContext): string | undefined {
	if (path === '/') {
		return 'The whole disk cannot be made writable.';
	}
	const home = context.home;
	if (home.startsWith('/') && home !== '/' && isPathInside(home, path)) {
		return path === home ? 'Your home folder cannot be made writable as a whole; allow a project folder inside it.' : `${shown} contains your home folder; allow a project folder instead.`;
	}
	const temp = TEMP_FOLDERS.some(root => path !== root && isPathInside(path, root)) || path === '/tmp' || path === '/private/tmp';
	if (!temp && SYSTEM_FOLDERS.some(root => isPathInside(path, root.toLowerCase()))) {
		return `${shown} is a system folder; the sandbox keeps it read-only.`;
	}
	if (/^\/volumes(\/[^/]+)?$/.test(path)) {
		return `${shown} ${path === '/volumes' ? 'holds every drive' : 'is a whole drive'}; allow a folder on it instead.`;
	}
	const name = path.split('/').find(segment => PROTECTED_NAMES.includes(segment));
	if (name) {
		return `${shown} is inside a ${name} folder, whose files run later outside the sandbox.`;
	}
	if (home.startsWith('/') && home !== '/') {
		for (const relative of PROTECTED_HOME) {
			const protectedPath = `${home}/${relative.toLowerCase()}`;
			if (isPathInside(path, protectedPath) || isPathInside(protectedPath, path)) {
				return isPathInside(path, protectedPath) ? `${shown} holds credentials or startup files (~/${relative}).` : `${shown} contains ~/${relative} (credentials or startup files); allow a narrower folder.`;
			}
		}
	}
	const userData = context.userDataDir;
	if (userData && userData.startsWith('/') && (isPathInside(path, userData) || isPathInside(userData, path))) {
		return `${shown} ${isPathInside(path, userData) ? 'is inside' : 'contains'} Volt's own data folder.`;
	}
	for (const root of context.workspaceRoots.filter(root => root.startsWith('/'))) {
		if (root !== path && isPathInside(root, path)) {
			// Granting a parent of the checkout opens its neighbours (and, for a worktree, the main checkout) too.
			return `${shown} contains this chat's checkout and the folders beside it; allow a narrower folder.`;
		}
	}
	return undefined;
}
