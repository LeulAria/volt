/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

export const IScratchSessionLinks = createDecorator<IScratchSessionLinks>('voltScratchSessionLinks');

/**
 * Which Scratch board a chat belongs to: the one it was started from, or one its agent drew on. The
 * chat's toolbar reads it at every chat switch, so it is a lookup, not a scan of the board files.
 */
export interface IScratchSessionLinks {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	boardFor(sessionId: string): string | undefined;
	link(sessionId: string, boardId: string): void;
}

const LINKS_KEY = 'volt.scratchBoard.sessionLinks';
/** The newest links kept; older chats find their board again when it is opened (the dock relinks). */
const MAX_LINKS = 2000;

interface ILink {
	readonly boardId: string;
	readonly at: number;
}

class ScratchSessionLinks extends Disposable implements IScratchSessionLinks {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private links = new Map<string, ILink>();
	private writing = false;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.load();
		// Profile storage is shared by the windows: a chat started from a board in another one links here too.
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, LINKS_KEY, this._store)(() => {
			if (!this.writing) {
				this.load();
				this._onDidChange.fire();
			}
		}));
	}

	boardFor(sessionId: string): string | undefined {
		return this.links.get(sessionId)?.boardId;
	}

	link(sessionId: string, boardId: string): void {
		if (this.links.get(sessionId)?.boardId === boardId) {
			return;
		}
		this.links.set(sessionId, { boardId, at: Date.now() });
		if (this.links.size > MAX_LINKS) {
			const oldest = [...this.links.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.links.size - MAX_LINKS);
			for (const [id] of oldest) {
				this.links.delete(id);
			}
		}
		this.save();
	}

	private load(): void {
		const next = new Map<string, ILink>();
		try {
			const raw = JSON.parse(this.storageService.get(LINKS_KEY, StorageScope.PROFILE, '{}')) as unknown;
			if (raw && typeof raw === 'object') {
				for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
					const link = value as Partial<ILink> | null;
					if (link && typeof link.boardId === 'string' && typeof link.at === 'number') {
						next.set(sessionId, { boardId: link.boardId, at: link.at });
					}
				}
			}
		} catch {
			// A damaged value starts over; the dock relinks a board's chats when it opens.
		}
		this.links = next;
	}

	private save(): void {
		this.writing = true;
		try {
			this.storageService.store(LINKS_KEY, JSON.stringify(Object.fromEntries(this.links)), StorageScope.PROFILE, StorageTarget.MACHINE);
		} finally {
			this.writing = false;
		}
		this._onDidChange.fire();
	}
}

registerSingleton(IScratchSessionLinks, ScratchSessionLinks, InstantiationType.Delayed);
