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

/**
 * Workspace-wide ring buffer of recent text changes - the primary next-edit signal
 * ("the user just renamed X here, so X over there changes next").
 */
export class RecentEditsTracker extends Disposable {

	private readonly edits: IRecentEdit[] = [];
	private readonly modelListeners = this._register(new DisposableMap<string>());

	constructor(@IModelService modelService: IModelService) {
		super();
		const attach = (model: ITextModel) => {
			if (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.untitled) {
				return;
			}
			this.modelListeners.set(model.uri.toString(), model.onDidChangeContent(e => {
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
		this._register(modelService.onModelRemoved(model => this.modelListeners.deleteAndDispose(model.uri.toString())));
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
