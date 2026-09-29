/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltFsBrowseService = createDecorator<IVoltFsBrowseService>('voltFsBrowseService');
export const VOLT_FS_BROWSE_CHANNEL_NAME = 'voltFsBrowse';

export interface IVoltFsEntry {
	readonly name: string;
	/** Absolute. */
	readonly path: string;
	/** For symlinks this is the target's kind. */
	readonly kind: 'dir' | 'file';
	readonly symlink?: boolean;
	readonly hidden: boolean;
	/** Holds a `.git` folder, or a `.git` file (a linked worktree or submodule). */
	readonly gitRepo?: boolean;
	readonly mtime?: number;
}

export type VoltFsListError = 'notFound' | 'noAccess' | 'notDirectory' | 'timeout';

export interface IVoltFsListing {
	/** The listed folder, with `~` expanded. */
	readonly path: string;
	readonly entries: readonly IVoltFsEntry[];
	/** Only the first entries carry metadata (git, mtime) in very large folders. */
	readonly truncated: boolean;
	readonly error?: VoltFsListError;
}

export interface IVoltQuickAccessRoot {
	readonly id: 'home' | 'desktop' | 'documents' | 'downloads' | 'code' | 'volume';
	readonly label: string;
	readonly path: string;
}

export interface IVoltFsFoundFolders {
	readonly requestId: string;
	readonly entries: readonly IVoltFsEntry[];
	readonly done: boolean;
}

export interface IVoltFsInspect {
	readonly exists: boolean;
	readonly directory: boolean;
	readonly empty: boolean;
	/** The `origin` URL when the folder is a git repo. */
	readonly gitRemote?: string;
}

/**
 * Fast folder browsing for the in-app project picker: one call per folder, symlinked folders
 * resolved, git repos detected. Never opens a native dialog.
 */
export interface IVoltFsBrowseService {
	readonly _serviceBrand: undefined;
	/** Streams deep-search results for {@link findFolders}. */
	readonly onDidFindFolders: Event<IVoltFsFoundFolders>;
	home(): Promise<string>;
	list(dir: string, options?: { readonly showHidden?: boolean; readonly dirsOnly?: boolean }): Promise<IVoltFsListing>;
	/** Breadth-first search for folders whose name matches `query`. Results arrive on {@link onDidFindFolders}. */
	findFolders(requestId: string, query: string, roots: readonly string[], options?: { readonly maxDepth?: number; readonly budgetMs?: number; readonly limit?: number }): Promise<void>;
	cancelFind(requestId: string): Promise<void>;
	quickAccess(): Promise<IVoltQuickAccessRoot[]>;
	/** Creates `parent/name` and returns its path. */
	mkdir(parent: string, name: string): Promise<string>;
	inspect(path: string): Promise<IVoltFsInspect>;
}
