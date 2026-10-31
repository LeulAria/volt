/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IDiffEditor, IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { registerDiffEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { IDiffEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

/** Square buttons, a little shorter than a line, centered on the hunk's first row. */
const BUTTON_SIZE = 16;

/**
 * An undo button left of the line numbers on every hunk of a review diff whose right side is the
 * working tree file, in any diff editor (the commit review, Open Changes, source control): it puts that hunk back as the
 * left side has it and saves the file, so the commit and the diff follow at once (Cmd+Z in the
 * file brings it back). Monaco's own revert arrows show only side by side, in a glyph margin the
 * review's inline diff does not have.
 */
class AgentReviewRevertContribution extends Disposable implements IDiffEditorContribution {

	static readonly ID = 'workbench.contrib.voltAgentReviewRevert';

	private readonly domNode = $('.volt-review-reverts');
	private readonly widget: IOverlayWidget = {
		getId: () => 'volt.reviewReverts',
		getDomNode: () => this.domNode,
		getPosition: () => null,
	};
	private readonly buttons = this._register(new DisposableStore());
	private shown = false;

	constructor(
		private readonly diffEditor: IDiffEditor,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
		super();
		const modified = diffEditor.getModifiedEditor();
		const later = this._register(new RunOnceScheduler(() => this.render(), 0));
		this._register(diffEditor.onDidUpdateDiff(() => later.schedule()));
		this._register(diffEditor.onDidChangeModel(() => later.schedule()));
		this._register(modified.onDidLayoutChange(() => later.schedule()));
		this._register(modified.onDidContentSizeChange(() => later.schedule()));
		// Scrolling moves them with the lines, in the same frame.
		this._register(modified.onDidScrollChange(e => e.scrollTopChanged && this.render()));
		this._register(toDisposable(() => this.hide()));
	}

	/** Only where the right side is a file on disk the user can edit; a commit's or a virtual side gets none. */
	private applies(): boolean {
		const model = this.diffEditor.getModel();
		const modified = this.diffEditor.getModifiedEditor();
		return !!model
			&& !modified.getOption(EditorOption.readOnly)
			&& !!this.textFileService.files.get(model.modified.uri);
	}

	private render(): void {
		this.buttons.clear();
		this.domNode.replaceChildren();
		const changes = this.applies() ? this.diffEditor.getDiffComputationResult()?.changes2 ?? [] : [];
		const model = this.diffEditor.getModel();
		if (!changes.length || !model) {
			this.hide();
			return;
		}
		const modified = this.diffEditor.getModifiedEditor();
		if (!this.shown) {
			modified.addOverlayWidget(this.widget);
			this.shown = true;
		}
		const lineCount = model.modified.getLineCount();
		const lineHeight = modified.getOption(EditorOption.lineHeight);
		const scrollTop = modified.getScrollTop();
		const label = localize('voltReviewRevert.undo', "Undo This Change");
		for (const change of changes) {
			// The hunk's first row: its deleted lines (a zone above the line) when it has any.
			const start = change.modified.startLineNumber;
			const top = start > lineCount ? modified.getBottomForLineNumber(lineCount) : modified.getTopForLineNumber(start, true);
			const button = append(this.domNode, $('button.volt-review-revert')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			button.appendChild(renderIcon(Codicon.discard));
			button.style.top = `${Math.round(top - scrollTop + (lineHeight - BUTTON_SIZE) / 2)}px`;
			setAgentTooltip(button, label);
			// Not a click in the editor: no cursor move, no selection.
			this.buttons.add(addDisposableListener(button, EventType.MOUSE_DOWN, e => EventHelper.stop(e, true)));
			this.buttons.add(addDisposableListener(button, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				void this.revert(change);
			}));
		}
	}

	private hide(): void {
		if (this.shown) {
			this.diffEditor.getModifiedEditor().removeOverlayWidget(this.widget);
			this.shown = false;
		}
	}

	/** As Monaco's own revert arrow does it, then saved (no format on save: only the hunk changes). */
	private async revert(change: DetailedLineRangeMapping): Promise<void> {
		const model = this.diffEditor.getModel();
		if (!model) {
			return;
		}
		const modified = this.diffEditor.getModifiedEditor();
		modified.pushUndoStop();
		modified.executeEdits('voltReviewRevert', [{
			range: change.modified.toExclusiveRange(),
			text: model.original.getValueInRange(change.original.toExclusiveRange()),
		}]);
		modified.pushUndoStop();
		await this.textFileService.save(model.modified.uri, { skipSaveParticipants: true });
	}
}

registerDiffEditorContribution(AgentReviewRevertContribution.ID, AgentReviewRevertContribution);
