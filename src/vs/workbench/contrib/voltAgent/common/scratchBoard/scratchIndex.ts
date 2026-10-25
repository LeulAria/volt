/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IScratchBoardMeta, IScratchFolder, IScratchIndex } from './scratchTypes.js';

/** The board list as the sidebar shows it. Pinned boards show once, under Pinned. */
export interface IScratchOrganizedIndex {
	readonly pinned: readonly IScratchBoardMeta[];
	readonly folders: readonly { readonly folder: IScratchFolder; readonly boards: readonly IScratchBoardMeta[] }[];
	readonly boards: readonly IScratchBoardMeta[];
	readonly archived: readonly IScratchBoardMeta[];
}

const byEdited = (a: IScratchBoardMeta, b: IScratchBoardMeta) => (b.edited - a.edited) || (b.created - a.created) || a.id.localeCompare(b.id);

export function matchesBoardQuery(board: IScratchBoardMeta, folder: IScratchFolder | undefined, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) {
		return true;
	}
	return q.split(/\s+/).every(word =>
		board.title.toLowerCase().includes(word)
		|| (board.excerpt ?? '').toLowerCase().includes(word)
		|| (folder?.name.toLowerCase().includes(word) ?? false));
}

export function organizeIndex(index: IScratchIndex, query = ''): IScratchOrganizedIndex {
	const folders = index.folders.filter(f => !f.deleted);
	const folderById = new Map(folders.map(f => [f.id, f]));
	const live = index.boards.filter(b => !b.deleted);
	const pinned: IScratchBoardMeta[] = [];
	const loose: IScratchBoardMeta[] = [];
	const archived: IScratchBoardMeta[] = [];
	const inFolder = new Map<string, IScratchBoardMeta[]>();
	for (const board of live) {
		const folder = board.folderId ? folderById.get(board.folderId) : undefined;
		if (!matchesBoardQuery(board, folder, query)) {
			continue;
		}
		if (board.archived) {
			archived.push(board);
		} else if (board.pinned) {
			pinned.push(board);
		} else if (folder) {
			let list = inFolder.get(folder.id);
			if (!list) {
				list = [];
				inFolder.set(folder.id, list);
			}
			list.push(board);
		} else {
			loose.push(board);
		}
	}
	const searching = query.trim().length > 0;
	return {
		pinned: pinned.sort(byEdited),
		folders: folders
			.filter(f => !searching || (inFolder.get(f.id)?.length ?? 0) > 0 || f.name.toLowerCase().includes(query.trim().toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.created - b.created)
			.map(folder => ({ folder, boards: (inFolder.get(folder.id) ?? []).sort(byEdited) })),
		boards: loose.sort(byEdited),
		archived: archived.sort(byEdited),
	};
}

export const UNTITLED_BOARD_TITLE = 'Untitled board';

export function boardDisplayTitle(board: Pick<IScratchBoardMeta, 'title'>): string {
	return board.title.trim() || UNTITLED_BOARD_TITLE;
}

/** "Untitled board", then "Untitled board 2", ... for a new board's default name. */
export function nextUntitledName(index: IScratchIndex, base = UNTITLED_BOARD_TITLE): string {
	const taken = new Set(index.boards.filter(b => !b.deleted).map(b => b.title.trim().toLowerCase()));
	if (!taken.has(base.toLowerCase())) {
		return base;
	}
	for (let n = 2; ; n++) {
		const name = `${base} ${n}`;
		if (!taken.has(name.toLowerCase())) {
			return name;
		}
	}
}

export function updateBoard(index: IScratchIndex, id: string, patch: Partial<Omit<IScratchBoardMeta, 'id'>>, now = Date.now()): IScratchIndex {
	let found = false;
	const boards = index.boards.map(b => {
		if (b.id !== id) {
			return b;
		}
		found = true;
		return { ...b, ...patch, id, updated: now };
	});
	return found ? { ...index, boards, updated: now } : index;
}

export function updateFolder(index: IScratchIndex, id: string, patch: Partial<Omit<IScratchFolder, 'id'>>, now = Date.now()): IScratchIndex {
	let found = false;
	const folders = index.folders.map(f => {
		if (f.id !== id) {
			return f;
		}
		found = true;
		return { ...f, ...patch, id, updated: now };
	});
	return found ? { ...index, folders, updated: now } : index;
}

/** Removes a folder; its boards move to the top level (nothing is lost with it). */
export function deleteFolder(index: IScratchIndex, id: string, now = Date.now()): IScratchIndex {
	return {
		...index,
		folders: index.folders.map(f => f.id === id ? { ...f, deleted: true, updated: now } : f),
		boards: index.boards.map(b => b.folderId === id ? { ...b, folderId: null, updated: now } : b),
		updated: now,
	};
}
