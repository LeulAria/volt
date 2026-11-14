/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs, Stats } from 'fs';
import { isAbsolute, join } from '../../../base/common/path.js';
import type { IAdminPolicy } from '../common/authority.js';
import type { ISandboxCompositionNote, ISandboxLayer } from '../common/compile.js';
import { capUserLayer, expandPolicyFileTokens, ISandboxPolicyFileState, parseSandboxPolicyFile, SANDBOX_POLICY_FILE, SandboxPolicyFileParse, SandboxPolicyFileSource } from '../common/sandboxPolicyFiles.js';
import { MAX_POLICY_BYTES } from '../common/sandboxSchema.js';
import { canonicalPath } from './sandboxResolver.js';

/** The policy files of one launch, as layers for the compiler. */
export interface ISandboxPolicyFileLayers {
	/** The user's (trusted, capped by the managed policy) first, then each workspace root's (untrusted). */
	readonly layers: readonly ISandboxLayer[];
	readonly files: readonly ISandboxPolicyFileState[];
	/** The user's widenings the managed policy denies. */
	readonly ignored: readonly ISandboxCompositionNote[];
	/** Set when the user's file is broken: the launch is refused with this. */
	readonly refusal?: string;
	/** Repository files that were ignored, and why: shown in the chat. */
	readonly warnings: readonly string[];
	/** Real paths for the narrowing's containment checks, when a repository's file narrows reads or writes. */
	readonly realpaths?: Readonly<Record<string, string>>;
}

interface ICached {
	readonly key: string;
	readonly parse: SandboxPolicyFileParse;
}

const MAX_CACHED = 256;

/** `dev:ino:size:mtime:ctime`: a file rewritten in place, replaced or touched gets a new key. */
function statKey(stat: Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function errorCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Reads `~/.volt/sandbox.json` and each workspace root's `.volt/sandbox.json` at every launch,
 * parsing a file again only when its stat changed (a warm launch costs one `stat` per file).
 *
 * A repository's file is opened without following a symlink, non-blocking, and must be a regular
 * file of at most `MAX_POLICY_BYTES`: a planted FIFO or a link to `/dev/zero` is a warning, never
 * a hang. The user's own file may be a symlink (dotfile managers) but must end at a regular file.
 */
export class SandboxPolicyFiles {

	private readonly cache = new Map<string, ICached>();

	constructor(
		/** Tests: the user's file somewhere else than `~/.volt/sandbox.json`. */
		private readonly userFile?: string,
	) { }

	async read(home: string, workspaceRoots: readonly string[], admin: IAdminPolicy): Promise<ISandboxPolicyFileLayers> {
		const userPath = this.userFile ?? join(home, SANDBOX_POLICY_FILE);
		const roots = [...new Set(workspaceRoots.filter(root => isAbsolute(root) && !root.endsWith('/.git')))];
		const [user, ...repos] = await Promise.all([
			this.load(userPath, 'user'),
			...roots.map(root => this.load(join(root, SANDBOX_POLICY_FILE), 'workspace')),
		]);
		const files: ISandboxPolicyFileState[] = [];
		const layers: ISandboxLayer[] = [];
		const warnings: string[] = [];
		let ignored: readonly ISandboxCompositionNote[] = [];
		const shown = (path: string) => path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
		if (user) {
			if (!user.ok) {
				files.push({ source: 'user', path: userPath, state: 'error', problem: user.problem });
				return {
					layers: [], files, ignored: [], warnings: [],
					refusal: `Your sandbox policy ${shown(userPath)} has an error, so Volt did not start this sandboxed process: ${user.problem}. Fix the file or remove it.`,
				};
			}
			const capped = capUserLayer(expandPolicyFileTokens(user.layer, home, undefined), admin, home);
			files.push({ source: 'user', path: userPath, state: 'loaded' });
			layers.push({ source: 'user', trusted: true, layer: capped.layer });
			ignored = capped.ignored;
		}
		repos.forEach((repo, i) => {
			if (!repo) {
				return;
			}
			const path = join(roots[i], SANDBOX_POLICY_FILE);
			if (!repo.ok) {
				files.push({ source: 'workspace', path, state: 'error', problem: repo.problem });
				warnings.push(`Volt ignored ${shown(path)}: ${repo.problem}. Its rules only narrow the sandbox, so the chat runs without them until the file is fixed.`);
				return;
			}
			files.push({ source: 'workspace', path, state: 'loaded' });
			layers.push({ source: 'workspace', trusted: false, layer: expandPolicyFileTokens(repo.layer, home, roots[i]) });
		});
		const realpaths = await this.realpaths(layers, [home, ...roots]);
		return { layers, files, ignored, warnings, ...realpaths ? { realpaths } : {} };
	}

	/** Undefined for a missing file; a problem for anything else that is not a valid policy. */
	private async load(path: string, source: SandboxPolicyFileSource): Promise<SandboxPolicyFileParse | undefined> {
		let stat: Stats;
		try {
			stat = source === 'user' ? await fs.stat(path) : await fs.lstat(path);
		} catch (err) {
			const code = errorCode(err);
			return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : { ok: false, problem: `the file cannot be read (${code ?? err})` };
		}
		if (!stat.isFile()) {
			return { ok: false, problem: stat.isSymbolicLink() ? 'a repository\'s policy file may not be a symbolic link' : 'not a regular file' };
		}
		const cached = this.cache.get(path);
		if (cached?.key === statKey(stat)) {
			return cached.parse;
		}
		if (stat.size > MAX_POLICY_BYTES) {
			return { ok: false, problem: `the file is larger than ${MAX_POLICY_BYTES} bytes` };
		}
		let handle: fs.FileHandle | undefined;
		try {
			// Non-blocking and (a repository's) without following a link swapped in after the lstat.
			handle = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (source === 'workspace' ? (constants.O_NOFOLLOW ?? 0) : 0));
			const opened = await handle.stat();
			if (!opened.isFile() || opened.size > MAX_POLICY_BYTES) {
				return { ok: false, problem: opened.isFile() ? `the file is larger than ${MAX_POLICY_BYTES} bytes` : 'not a regular file' };
			}
			const buffer = Buffer.alloc(opened.size + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const parse: SandboxPolicyFileParse = bytesRead > opened.size ? { ok: false, problem: 'the file changed while it was read' } : parseSandboxPolicyFile(buffer.subarray(0, bytesRead).toString('utf8'));
			if (this.cache.size >= MAX_CACHED) {
				this.cache.delete(this.cache.keys().next().value!);
			}
			this.cache.set(path, { key: statKey(opened), parse });
			return parse;
		} catch (err) {
			const code = errorCode(err);
			return code === 'ENOENT' ? undefined : { ok: false, problem: code === 'ELOOP' ? 'a repository\'s policy file may not be a symbolic link' : `the file cannot be read (${code ?? err})` };
		} finally {
			await handle?.close();
		}
	}

	/**
	 * When a repository's file narrows reads or writes: the real paths of its absolute entries and of
	 * the folders they are compared with (home, workspace roots), so a symlink cannot carry an entry
	 * outside unnoticed. The resolver checks the same again on its own answers (B-32).
	 */
	private async realpaths(layers: readonly ISandboxLayer[], parents: readonly string[]): Promise<Record<string, string> | undefined> {
		const entries = layers.filter(layer => !layer.trusted).flatMap(({ layer }) => [...layer.filesystem?.read ?? [], ...layer.filesystem?.write ?? []]).filter(path => path.startsWith('/'));
		if (!entries.length) {
			return undefined;
		}
		const paths = [...new Set([...entries, ...parents])];
		const answers = await Promise.all(paths.map(path => canonicalPath(path).then(c => c.path, () => path)));
		return Object.fromEntries(paths.map((path, i) => [path, answers[i]]));
	}
}
