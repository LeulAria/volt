/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, isEqual, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

/** Folders above a project searched for its repository (a project may be a folder inside one). */
const MAX_PARENTS = 8;

/**
 * The number of entries in a git index file (`DIRC`, version, entry count: 12 bytes, big-endian), or
 * undefined when the bytes are not an index header. A split index (`core.splitIndex`) counts only the
 * entries changed since its shared index (see {@link gitTrackedFileCount}).
 */
export function gitIndexEntryCount(header: Uint8Array): number | undefined {
	if (header.length < 12 || header[0] !== 0x44 || header[1] !== 0x49 || header[2] !== 0x52 || header[3] !== 0x43) {
		return undefined;
	}
	return ((header[8] << 24) >>> 0) + (header[9] << 16) + (header[10] << 8) + header[11];
}

/** The `gitdir:` a linked worktree's or a submodule's `.git` file points to, resolved against `dir`. */
export function gitDirFromFile(text: string, dir: URI): URI | undefined {
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
	if (!match) {
		return undefined;
	}
	const target = match[1];
	return /^([a-zA-Z]:)?[\\/]/.test(target) ? URI.file(target) : joinPath(dir, target);
}

/**
 * How many files git tracks in the repository holding `root`, read from its index's header (no git
 * process, no tree walk); undefined outside a repository or when the index cannot be read.
 */
export async function gitTrackedFileCount(fileService: IFileService, root: URI): Promise<number | undefined> {
	let dir = root;
	for (let i = 0; i <= MAX_PARENTS; i++) {
		const dotGit = joinPath(dir, '.git');
		const stat = await fileService.stat(dotGit).catch(() => undefined);
		if (stat) {
			const gitDir = stat.isDirectory ? dotGit : gitDirFromFile((await fileService.readFile(dotGit, { length: 4096 })).value.toString(), dir);
			if (!gitDir) {
				return undefined;
			}
			const header = await fileService.readFile(joinPath(gitDir, 'index'), { length: 12 }).catch(() => undefined);
			const count = header ? gitIndexEntryCount(header.value.buffer) : undefined;
			if (count === undefined) {
				return undefined;
			}
			// A split index's own count leaves out its shared index's entries: the size is unknown.
			const listing = await fileService.resolve(gitDir).catch(() => undefined);
			return listing?.children?.some(child => child.name.startsWith('sharedindex.')) ? undefined : count;
		}
		const parent = dirname(dir);
		if (isEqual(parent, dir)) {
			return undefined;
		}
		dir = parent;
	}
	return undefined;
}
