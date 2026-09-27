/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, isEqual, joinPath, basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

/** Git facts for one folder, read straight from its `.git` directory. */
export interface IAgentRepoInfo {
	/** Identity shared by every clone and worktree of a repository: the origin remote, else the repository root. */
	readonly id: string;
	/** Repository name from the remote, else the repository folder name. */
	readonly name: string;
	/** Remote owner (`microsoft` in `microsoft/vscode`). */
	readonly owner?: string;
	/** Repository root folder. */
	readonly root: URI;
	/** Checked-out branch, or a short commit for a detached HEAD. */
	readonly branch?: string;
}

export interface IGitRemote {
	readonly host: string;
	readonly owner?: string;
	readonly name: string;
}

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@host:22/group/sub/repo.git` and local paths all reduce to
 * host, owner and name. The owner is the path between host and name.
 */
export function parseGitRemoteUrl(url: string): IGitRemote | undefined {
	const trimmed = url.trim();
	if (!trimmed) {
		return undefined;
	}
	let host = '';
	let path = '';
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
	// A one-letter "host" is a Windows drive, not scp-style `host:path`.
	if (scp && scp[1].length > 1 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		host = scp[1];
		path = scp[2];
	} else {
		const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]*)(?::\d+)?(\/.*)?$/i.exec(trimmed);
		if (match) {
			host = match[1];
			path = match[2] ?? '';
		} else {
			path = trimmed;
		}
	}
	const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
	const name = parts.at(-1);
	if (!name) {
		return undefined;
	}
	const owner = parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;
	return { host: host.toLowerCase(), owner: host ? owner : undefined, name };
}

/** Remote urls by remote name, in file order. */
export function parseGitConfigRemotes(config: string): Map<string, string> {
	const remotes = new Map<string, string>();
	let current: string | undefined;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) {
			continue;
		}
		const section = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
		if (section) {
			current = section[1].toLowerCase() === 'remote' ? section[2] : undefined;
			continue;
		}
		if (current === undefined) {
			continue;
		}
		const entry = /^url\s*=\s*(.+)$/i.exec(line);
		if (entry && !remotes.has(current)) {
			remotes.set(current, entry[1].trim().replace(/^"(.*)"$/, '$1'));
		}
	}
	return remotes;
}

/** Branch name from `.git/HEAD`, or the short commit when detached. */
export function parseGitHead(head: string): string | undefined {
	const text = head.trim();
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref) {
		return ref[1];
	}
	return /^[0-9a-f]{7,}$/i.test(text) ? text.slice(0, 7) : undefined;
}

/**
 * Two capital letters that name a repository in a flat list: the first letter
 * of the first two words (`aria-icons` → `AI`, `FalconWebsite` → `FW`), or the
 * first two letters of a one-word name (`volt` → `VO`).
 */
export function repoInitials(name: string): string {
	const bare = name.split('/').filter(Boolean).at(-1) ?? name;
	const spaced = bare
		.replace(/\.git$/i, '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
	const words = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	if (!words.length) {
		return '';
	}
	if (words.length === 1) {
		return [...words[0]].slice(0, 2).join('').toUpperCase();
	}
	return (firstChar(words[0]) + firstChar(words[1])).toUpperCase();
}

function firstChar(word: string): string {
	return [...word][0] ?? '';
}

/**
 * The owner most repositories share is the user's own account. Hiding it keeps
 * `volt` short while `microsoft/vscode` still says whose repository it is.
 */
export function dominantRepoOwner(repos: Iterable<IAgentRepoInfo>): string | undefined {
	const counts = new Map<string, number>();
	for (const repo of repos) {
		if (repo.owner) {
			const key = repo.owner.toLowerCase();
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [owner, count] of counts) {
		if (count > bestCount) {
			best = owner;
			bestCount = count;
		}
	}
	return best;
}

/** `owner/name`, or just the name when the owner is the user's own account. */
export function repoDisplayName(repo: IAgentRepoInfo, selfOwner: string | undefined): string {
	if (!repo.owner || (selfOwner && repo.owner.toLowerCase() === selfOwner)) {
		return repo.name;
	}
	return `${repo.owner}/${repo.name}`;
}

/** Full `owner/name` for the hover card. */
export function repoSlug(repo: IAgentRepoInfo): string {
	return repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}

const MAX_PARENT_WALK = 32;
const STALE_MS = 15_000;

interface IRepoEntry {
	readonly at: number;
	readonly value: Promise<IAgentRepoInfo | undefined>;
}

/**
 * Reads repository facts for sidebar folders without the SCM extension, so
 * folders that are not open in this window still group by repository and
 * show their branch. Results are cached and re-read after a short while.
 */
export class AgentRepoResolver {

	private readonly entries = new Map<string, IRepoEntry>();

	constructor(private readonly fileService: IFileService) { }

	/** Cached result, if one has been read. */
	peek(folder: URI): Promise<IAgentRepoInfo | undefined> | undefined {
		return this.entries.get(folder.toString())?.value;
	}

	resolve(folder: URI, now = Date.now()): Promise<IAgentRepoInfo | undefined> {
		const key = folder.toString();
		const existing = this.entries.get(key);
		if (existing && now - existing.at < STALE_MS) {
			return existing.value;
		}
		const value = this.read(folder).catch(() => undefined);
		this.entries.set(key, { at: now, value });
		return value;
	}

	private async read(folder: URI): Promise<IAgentRepoInfo | undefined> {
		const found = await this.findGitDir(folder);
		if (!found) {
			return undefined;
		}
		const [head, config] = await Promise.all([
			this.readText(joinPath(found.gitDir, 'HEAD')),
			this.readText(joinPath(found.commonDir, 'config')),
		]);
		const remotes = config ? parseGitConfigRemotes(config) : new Map<string, string>();
		const url = remotes.get('origin') ?? remotes.values().next().value;
		const remote = url ? parseGitRemoteUrl(url) : undefined;
		const name = remote?.name || basename(found.root) || found.root.path;
		return {
			id: remote?.host ? `${remote.host}/${remote.owner ? `${remote.owner}/` : ''}${remote.name}`.toLowerCase() : found.root.toString(),
			name,
			owner: remote?.owner,
			root: found.root,
			branch: head ? parseGitHead(head) : undefined,
		};
	}

	/** Walks up from the folder to the first `.git` directory or worktree pointer. */
	private async findGitDir(folder: URI): Promise<{ root: URI; gitDir: URI; commonDir: URI } | undefined> {
		let dir = folder;
		for (let i = 0; i < MAX_PARENT_WALK; i++) {
			const dotGit = joinPath(dir, '.git');
			const stat = await this.fileService.stat(dotGit).catch(() => undefined);
			if (stat?.isDirectory) {
				return { root: dir, gitDir: dotGit, commonDir: dotGit };
			}
			if (stat?.isFile) {
				const pointer = /^gitdir:\s*(.+)$/m.exec(await this.readText(dotGit) ?? '');
				if (pointer) {
					const gitDir = resolvePath(dir, pointer[1].trim());
					const common = (await this.readText(joinPath(gitDir, 'commondir')))?.trim();
					return { root: dir, gitDir, commonDir: common ? resolvePath(gitDir, common) : gitDir };
				}
			}
			const parent = dirname(dir);
			if (isEqual(parent, dir)) {
				return undefined;
			}
			dir = parent;
		}
		return undefined;
	}

	private async readText(resource: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
	}
}

/** A `.git` pointer is absolute or relative to the folder that holds it. */
function resolvePath(base: URI, path: string): URI {
	const normalized = path.replace(/\\/g, '/');
	if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
		return base.with({ path: normalized.startsWith('/') ? normalized : `/${normalized}` });
	}
	return joinPath(base, normalized);
}
