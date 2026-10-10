/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IRecentEdit } from '../../common/prediction.js';
import { truncateSnippet } from '../../common/prediction/contextWindow.js';

const MAX_ENTRIES = 30;
/** Consecutive keystrokes on the same line coalesce into one entry. */
const COALESCE_WINDOW_MS = 2000;
/** Keystroke times kept per file, for how fast the user is typing there. */
const KEY_TIMES = 16;

/** How the user is typing in one file right now. */
export interface ITypingState {
	/** Changes in the last second. */
	readonly keysLastSecond: number;
	/** The last change only removed text (backspace, delete, cut). */
	readonly deleting: boolean;
}

/**
 * Workspace-wide ring buffer of recent text changes - the primary next-edit signal
 * ("the user just renamed X here, so X over there changes next").
 */
export class RecentEditsTracker extends Disposable {

	private readonly edits: IRecentEdit[] = [];
	private readonly modelListeners = this._register(new DisposableMap<string>());
	private readonly typingByUri = new Map<string, { times: number[]; deleting: boolean }>();

	constructor(@IModelService modelService: IModelService) {
		super();
		const attach = (model: ITextModel) => {
			if (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.untitled) {
				return;
			}
			this.modelListeners.set(model.uri.toString(), model.onDidChangeContent(e => {
				if (!e.isFlush && !e.isUndoing && !e.isRedoing) {
					this.noteKeystroke(model.uri.toString(), e.changes.every(change => !change.text && change.rangeLength > 0));
				}
				for (const change of e.changes) {
					this.record({
						uri: model.uri,
						startLineNumber: change.range.startLineNumber,
						// The change event does not carry the removed text; the line marker
						// plus inserted text is signal enough for the prompt.
						removed: '',
						inserted: truncateSnippet(change.text),
						timestamp: Date.now(),
					}, change.rangeLength);
				}
			}));
		};
		modelService.getModels().forEach(attach);
		this._register(modelService.onModelAdded(attach));
		this._register(modelService.onModelRemoved(model => {
			this.modelListeners.deleteAndDispose(model.uri.toString());
			this.typingByUri.delete(model.uri.toString());
		}));
	}

	private noteKeystroke(uri: string, deleting: boolean): void {
		let typing = this.typingByUri.get(uri);
		if (!typing) {
			typing = { times: [], deleting };
			this.typingByUri.set(uri, typing);
		}
		typing.times.push(Date.now());
		if (typing.times.length > KEY_TIMES) {
			typing.times.shift();
		}
		typing.deleting = deleting;
	}

	/** How fast the user is typing in `uri`, and whether they are deleting. */
	typing(uri: string): ITypingState {
		const typing = this.typingByUri.get(uri);
		if (!typing) {
			return { keysLastSecond: 0, deleting: false };
		}
		const since = Date.now() - 1000;
		let keys = 0;
		for (let i = typing.times.length - 1; i >= 0 && typing.times[i] >= since; i--) {
			keys++;
		}
		return { keysLastSecond: keys, deleting: typing.deleting };
	}

	private record(edit: IRecentEdit, removedLength: number): void {
		// Skip pure whitespace churn and giant paste/undo blobs.
		if (!edit.inserted.trim() && removedLength === 0) {
			return;
		}
		if (edit.inserted.length > 2000) {
			return;
		}
		const last = this.edits[this.edits.length - 1];
		if (last
			&& last.uri.toString() === edit.uri.toString()
			&& last.startLineNumber === edit.startLineNumber
			&& edit.timestamp - last.timestamp < COALESCE_WINDOW_MS) {
			last.inserted = truncateSnippet(last.inserted + edit.inserted);
			last.timestamp = edit.timestamp;
			return;
		}
		this.edits.push(edit);
		if (this.edits.length > MAX_ENTRIES) {
			this.edits.shift();
		}
	}

	list(): IRecentEdit[] {
		return this.edits.slice();
	}
}
