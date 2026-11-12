/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix } from '../../../base/common/path.js';
import { executionBearingReason } from '../../voltSandbox/common/executionBearing.js';
import { isChatSubject, isFirstPartySubject, SubjectKey } from '../../voltSandbox/common/principals.js';
import { isPathInside, IVoltSandboxSettings, normalizeSandboxPath, planAllowsWrite, resolveSandboxPlan } from '../../voltSandbox/common/sandboxPolicy.js';
import { CREDENTIAL_HOME_PATHS as PROFILE_CREDENTIAL_PATHS, SECRET_FILE_PATTERNS } from '../../voltSandbox/common/sandboxProfiles.js';

/**
 * The files broker's rules (spec I.2, INV-12, INV-33), pure so the window's host-tool gate and the
 * execution host's broker (`node/filesBroker.ts`) decide alike:
 *
 * - {@link validateBrokerPath}: what a caller may name at all. Absolute, NFC, no `.` or `..`, no
 *   control characters, bounded; on Windows no device names, alternate data streams, 8.3 short
 *   names or `\\?\` prefixes. A path in another normalization or spelling is refused, not mapped.
 * - {@link brokerReadRefusal} / {@link brokerWriteRefusal}: a sandboxed chat's own rule (the one
 *   the OS enforces on its agent), on real paths.
 * - {@link filesPlan}: the capability and target `evaluate` judges for a principal, and the floor
 *   the broker enforces itself on the final path: credential folders and secret files for everyone,
 *   execution-bearing files (A3) for every writer that is not first party, and the principal's
 *   scope (its workspace folders and the paths its manifest declares).
 *
 * Case folds on macOS and Windows (APFS and NTFS fold case by default): `~/.SSH` is `~/.ssh`.
 */

export const FILES_BROKER_LIMITS = Object.freeze({
	/** Open handles per principal. */
	handles: 64,
	/** Bytes written per principal per minute. */
	writeBytesPerMinute: 256 * 1024 * 1024,
	/** Most bytes one read returns. */
	readChunk: 1024 * 1024,
	/** Most bytes one write takes. */
	writeChunk: 16 * 1024 * 1024,
	/** Longest path accepted. */
	pathLength: 4096,
});

export class FilesBrokerPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FilesBrokerPathError';
	}
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i;

/** The path as the broker takes it, or a {@link FilesBrokerPathError}. */
export function validateBrokerPath(raw: unknown, platform: string): string {
	if (typeof raw !== 'string' || !raw) {
		throw new FilesBrokerPathError('the path must be a non-empty string');
	}
	if (raw.length > FILES_BROKER_LIMITS.pathLength) {
		throw new FilesBrokerPathError(`the path is longer than ${FILES_BROKER_LIMITS.pathLength} characters`);
	}
	// allow-any-unicode-next-line
	if (/[\u0000-\u001f\u007f]/.test(raw)) {
		throw new FilesBrokerPathError('the path has control characters');
	}
	if (raw.normalize('NFC') !== raw) {
		throw new FilesBrokerPathError('the path is not in NFC: name it as the file system shows it');
	}
	const windows = platform === 'win32';
	if (windows) {
		if (/^(?:\\\\|\/\/)[?.]/.test(raw)) {
			throw new FilesBrokerPathError('device and \\\\?\\ paths are not accepted');
		}
		if (!/^[a-zA-Z]:[\\/]/.test(raw)) {
			throw new FilesBrokerPathError(`${raw} is not an absolute path with a drive`);
		}
	} else if (!raw.startsWith('/')) {
		throw new FilesBrokerPathError(`${raw} is not an absolute path`);
	}
	const parts = (windows ? raw.slice(3) : raw.slice(1)).split(windows ? /[\\/]/ : '/');
	for (const part of parts) {
		if (part === '.' || part === '..') {
			throw new FilesBrokerPathError('the path has `.` or `..` components');
		}
		if (windows) {
			if (part.includes(':')) {
				throw new FilesBrokerPathError('alternate data streams are not accepted');
			}
			if (/[. ]$/.test(part)) {
				throw new FilesBrokerPathError('a component ends with a dot or a space, which Windows drops');
			}
			if (WINDOWS_DEVICE.test(part)) {
				throw new FilesBrokerPathError(`${part} is a device name`);
			}
			if (/~\d/.test(part)) {
				throw new FilesBrokerPathError('8.3 short names are not accepted: use the long name');
			}
		}
	}
	return windows ? raw.replace(/\//g, '\\').replace(/\\+$/, '') : normalizeSandboxPath(raw);
}

/** Machine facts the path rules need. Without `home`, writes are refused (the plan needs it). */
export interface ISandboxPathContext {
	/** The chat's folders: its worktree or project, as named and resolved through symlinks. */
	readonly roots: readonly string[];
	readonly home?: string;
	/** `TMPDIR` (on macOS the per-user `/var/folders/.../T`). */
	readonly tmpdir?: string;
	readonly platform: string;
}

/** Under the home folder: credentials and other apps' private data. Never read for a sandboxed principal. */
export const BROKER_CREDENTIAL_HOME_PATHS: readonly string[] = [...new Set([
	'.ssh', '.aws', '.gnupg', '.kube', '.azure', '.docker', '.config/gh', '.config/gcloud', '.config/hub', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/git/credentials',
	'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Mail', 'Library/Messages',
	'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
	'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Application Support/com.apple.TCC',
	'.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
	// Volt's own: account logins and the app's user data.
	'.volt/accounts', 'Library/Application Support/Volt', 'Library/Application Support/Volt Beta', 'Library/Application Support/code-oss-dev', '.config/Volt', '.config/code-oss-dev',
	...PROFILE_CREDENTIAL_PATHS,
])];

/** Secret file names (`.env` and friends), wherever they are. */
const SECRET_NAMES = SECRET_FILE_PATTERNS.map(pattern => pattern.replace(/^\*\*\//, ''));

function caseFolds(platform: string): boolean {
	return platform === 'darwin' || platform === 'win32';
}

/**
 * A path as the rules compare it: `..` resolved, normalized, NFC, `/private/tmp` and `/private/var`
 * as `/tmp` and `/var` on macOS, case folded where the file system folds it.
 */
function comparable(path: string, platform: string): string {
	let normalized = normalizeSandboxPath(posix.normalize(path.trim().replace(/\\/g, '/'))).normalize('NFC');
	if (platform === 'darwin' && /^\/private\/(tmp|var|etc)(\/|$)/i.test(normalized)) {
		normalized = normalized.slice('/private'.length);
	}
	return caseFolds(platform) ? normalized.toLowerCase() : normalized;
}

/** Why `path` (a real path) holds credentials or private app data, or undefined. */
export function credentialRefusal(path: string, home: string | undefined, platform: string): string | undefined {
	const target = comparable(path, platform);
	if (home) {
		const h = comparable(home, platform);
		if (BROKER_CREDENTIAL_HOME_PATHS.some(dir => isPathInside(target, comparable(`${h}/${dir}`, platform)))) {
			return `${path} is in a folder with credentials or private app data`;
		}
	}
	const name = target.slice(target.lastIndexOf('/') + 1);
	if (SECRET_NAMES.some(secret => (caseFolds(platform) ? secret.toLowerCase() : secret) === name)) {
		return `${path} is a secrets file`;
	}
	return undefined;
}

/** Why a sandboxed chat may not read `path` (resolved through symlinks), or undefined when it may. */
export function brokerReadRefusal(settings: IVoltSandboxSettings | undefined, path: string, context: ISandboxPathContext): string | undefined {
	if (!settings || settings.level === 'off') {
		return undefined;
	}
	const target = comparable(path, context.platform);
	if (!target.startsWith('/')) {
		return `${path} is not an absolute path`;
	}
	const home = context.home ? comparable(context.home, context.platform) : undefined;
	if (home && BROKER_CREDENTIAL_HOME_PATHS.some(dir => isPathInside(target, comparable(`${home}/${dir}`, context.platform)))) {
		return `${path} is in a folder with credentials or private app data`;
	}
	const roots = [...context.roots, ...(settings.extraWritableRoots ?? []), '/tmp', '/var/tmp', ...(context.tmpdir ? [context.tmpdir] : [])]
		.map(root => comparable(root, context.platform))
		.filter(root => root.startsWith('/') && root !== '/' && root !== home);
	return roots.some(root => isPathInside(target, root)) ? undefined : `${path} is outside this chat's workspace`;
}

/** Why a sandboxed chat may not write `path` (resolved through symlinks): the rule the OS enforces on the agent itself. */
export function brokerWriteRefusal(settings: IVoltSandboxSettings | undefined, path: string, context: ISandboxPathContext): string | undefined {
	if (!settings || settings.level === 'off') {
		return undefined;
	}
	if (!context.home) {
		return `Volt cannot tell whether the sandbox allows writing ${path}`;
	}
	const plan = resolveSandboxPlan({
		level: settings.level,
		network: settings.network,
		// No agent's state folders: these tools write projects, never an agent CLI's own files.
		providerId: '',
		workspaceRoots: [...context.roots],
		...(settings.extraWritableRoots?.length ? { extraWritableRoots: settings.extraWritableRoots } : {}),
	}, { platform: context.platform, home: context.home, tmpdir: context.tmpdir ?? '/tmp' });
	const normalized = normalizeSandboxPath(posix.normalize(path.trim())).normalize('NFC');
	// Where the file system folds case, `.GIT/hooks` is `.git/hooks`: a spelling the plan's protected names miss is refused.
	const caseTrick = caseFolds(context.platform) && !!executionBearingReason(normalized, context.home, true) && !executionBearingReason(normalized, context.home, false);
	if (planAllowsWrite(plan, normalized) && !caseTrick) {
		return undefined;
	}
	return settings.level === 'read-only' ? 'this chat\'s sandbox is read-only' : `the sandbox does not allow writing ${path}`;
}

export type FilesAccess = 'read' | 'write';

/** Where a principal may reach through the broker, as core recorded it (never from the caller). */
export interface IFilesScope {
	/** Its workspace folders (a chat: its worktree or project), as real paths. */
	readonly roots: readonly string[];
	/** Folders its manifest declares for `files.*` (within its ceiling for a built-in), as real paths. */
	readonly declaredRoots?: readonly string[];
	readonly home?: string;
	readonly tmpdir?: string;
	readonly platform: string;
	/** A chat: its sandbox settings, whose path rules are the OS sandbox's. */
	readonly chat?: IVoltSandboxSettings;
}

/** What `evaluate` judges for one open, and the floor's answer. */
export interface IFilesPlan {
	readonly capability: string;
	/** `~/rel` under the home folder (so declared targets like `~/.volt/customize/*` match), else the path. */
	readonly target: string;
	/** Why the broker itself refuses, before asking the Authority. */
	readonly refusal?: string;
}

function inScope(path: string, roots: readonly string[], platform: string): boolean {
	const target = comparable(path, platform);
	return roots.some(root => {
		const r = comparable(root, platform);
		return r.startsWith('/') && r !== '/' && isPathInside(target, r);
	});
}

/** `path` as a target: `~/rel` under the home folder. */
export function filesTarget(path: string, home: string | undefined): string {
	if (home) {
		const h = normalizeSandboxPath(home.replace(/\\/g, '/'));
		const p = path.replace(/\\/g, '/');
		if (p === h) {
			return '~';
		}
		if (p.startsWith(`${h}/`)) {
			return `~/${p.slice(h.length + 1)}`;
		}
	}
	return path;
}

/**
 * The capability, target and floor for `subject` opening `path` (a real path, validated) for
 * `access`. A chat is judged by its sandbox's own rule; any other principal by its scope: its
 * workspace folders (`files.read:workspace`, `files.write`) and its declared folders
 * (`files.read:home` under the home folder). Credential folders and secret files are refused for
 * everyone but the user; execution-bearing files are never written for a principal that is not
 * first party (INV-15).
 */
export function filesPlan(subject: SubjectKey, path: string, access: FilesAccess, scope: IFilesScope): IFilesPlan {
	const target = filesTarget(path, scope.home);
	const write = access === 'write';
	if (subject === 'user') {
		return { capability: write ? 'files.write' : 'files.read:workspace', target };
	}
	const credential = credentialRefusal(path, scope.home, scope.platform);
	if (credential) {
		return { capability: write ? 'files.write' : 'files.read:home', target, refusal: credential };
	}
	if (write && !isFirstPartySubject(subject)) {
		const bearing = executionBearingReason(path, scope.home, caseFolds(scope.platform));
		if (bearing) {
			return { capability: 'files.write', target, refusal: `${path} is not written for an agent or extension: ${bearing}` };
		}
	}
	if (isChatSubject(subject)) {
		const context: ISandboxPathContext = { roots: scope.roots, platform: scope.platform, ...(scope.home ? { home: scope.home } : {}), ...(scope.tmpdir ? { tmpdir: scope.tmpdir } : {}) };
		const refusal = write ? brokerWriteRefusal(scope.chat, path, context) : brokerReadRefusal(scope.chat, path, context);
		return { capability: write ? 'files.write' : 'files.read:workspace', target, ...(refusal ? { refusal } : {}) };
	}
	const inWorkspace = inScope(path, scope.roots, scope.platform);
	const declared = inScope(path, scope.declaredRoots ?? [], scope.platform);
	if (!inWorkspace && !declared) {
		return { capability: write ? 'files.write' : 'files.read:workspace', target, refusal: `${path} is outside the folders this principal may reach (its workspace and the paths it declares)` };
	}
	const home = scope.home && inScope(path, [scope.home], scope.platform);
	return { capability: write ? 'files.write' : !inWorkspace && home ? 'files.read:home' : 'files.read:workspace', target };
}

/**
 * The folders a manifest's `files.*` targets name (`~/.volt/customize/*` is `~/.volt/customize`):
 * a target with a wildcard anywhere but at its end names no folder, and is left out.
 */
export function declaredFileRoots(targets: readonly string[], home: string | undefined): string[] {
	const out: string[] = [];
	for (const target of targets) {
		let path = target.replace(/\/\*+$/, '');
		if (path.includes('*')) {
			continue;
		}
		if (path === '~' || path.startsWith('~/')) {
			if (!home) {
				continue;
			}
			path = `${normalizeSandboxPath(home)}${path.slice(1)}`;
		}
		if (path.startsWith('/') && path !== '/') {
			out.push(normalizeSandboxPath(path));
		}
	}
	return out;
}
