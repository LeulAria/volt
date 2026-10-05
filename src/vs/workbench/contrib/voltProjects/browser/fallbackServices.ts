/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoltFsBrowseService, IVoltFsEntry, IVoltFsInspect, IVoltFsListing, IVoltQuickAccessRoot } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { IVoltGitApplyResult, IVoltGitBranches, IVoltGitDiffEntry, IVoltGitRef, IVoltGitRepo, IVoltGitService, IVoltGitSnapshot } from '../../../../platform/voltGit/common/voltGit.js';
import { IPathService } from '../../../services/path/common/pathService.js';

/**
 * Folder browsing without the desktop main process (web, remote): the same picker, backed by
 * IFileService. Slower (no git badges, no deep search), never a native dialog.
 */
export class FileServiceFsBrowse implements IVoltFsBrowseService {

	declare readonly _serviceBrand: undefined;
	readonly onDidFindFolders = Event.None;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) { }

	async home(): Promise<string> {
		return (await this.pathService.userHome()).path;
	}

	async list(dir: string, options?: { readonly showHidden?: boolean }): Promise<IVoltFsListing> {
		const path = dir.startsWith('~') ? `${await this.home()}${dir.slice(1)}` : dir;
		try {
			const stat = await this.fileService.resolve(this.uri(path), { resolveMetadata: true });
			const entries: IVoltFsEntry[] = (stat.children ?? [])
				.filter(child => child.isDirectory && (options?.showHidden || !child.name.startsWith('.')))
				.map(child => ({ name: child.name, path: child.resource.path, kind: 'dir' as const, hidden: child.name.startsWith('.'), symlink: child.isSymbolicLink || undefined, mtime: child.mtime }))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
			return { path, entries, truncated: false };
		} catch {
			return { path, entries: [], truncated: false, error: 'notFound' };
		}
	}

	async findFolders(): Promise<void> { }

	async cancelFind(): Promise<void> { }

	async quickAccess(): Promise<IVoltQuickAccessRoot[]> {
		return [{ id: 'home', label: 'Home', path: await this.home() }];
	}

	async mkdir(parent: string, name: string): Promise<string> {
		const created = await this.fileService.createFolder(URI.joinPath(this.uri(parent), name));
		return created.resource.path;
	}

	async inspect(path: string): Promise<IVoltFsInspect> {
		try {
			const stat = await this.fileService.resolve(this.uri(path));
			return { exists: true, directory: stat.isDirectory, empty: !stat.children?.length };
		} catch {
			return { exists: false, directory: false, empty: true };
		}
	}

	private uri(path: string): URI {
		return this.pathService.defaultUriScheme === 'file' ? URI.file(path) : URI.from({ scheme: this.pathService.defaultUriScheme, path });
	}
}

/** Git runs only in the desktop app. */
export class NullVoltGitService implements IVoltGitService {

	declare readonly _serviceBrand: undefined;
	readonly onDidCloneProgress = Event.None;

	private unavailable(): never {
		throw new Error('Git operations are only available in the Volt desktop app.');
	}

	async resolveRepo(): Promise<IVoltGitRepo | undefined> { return undefined; }
	async snapshot(): Promise<IVoltGitSnapshot> { return this.unavailable(); }
	async writeIndexTree(): Promise<string> { return this.unavailable(); }
	async diffSummary(): Promise<IVoltGitDiffEntry[]> { return this.unavailable(); }
	async readBlob(): Promise<VSBuffer> { return this.unavailable(); }
	async writeBlob(): Promise<string> { return this.unavailable(); }
	async setIndexEntry(): Promise<void> { return this.unavailable(); }
	async resetIndexPaths(): Promise<void> { return this.unavailable(); }
	async updateRef(): Promise<void> { return this.unavailable(); }
	async listRefs(): Promise<IVoltGitRef[]> { return []; }
	async deleteRefs(): Promise<void> { }
	async applyPatch(): Promise<IVoltGitApplyResult> { return this.unavailable(); }
	async clone(): Promise<void> { return this.unavailable(); }
	async cancelClone(): Promise<void> { }
	async createBranch(): Promise<void> { return this.unavailable(); }
	async listBranches(): Promise<IVoltGitBranches> { return { local: [], remote: [], tags: [], refs: [] }; }
	async checkout(): Promise<void> { return this.unavailable(); }
}
