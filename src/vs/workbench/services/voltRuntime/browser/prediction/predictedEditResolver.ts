/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPosition } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IPredictedEdit } from '../../common/prediction.js';
import { locateAnchor } from '../../common/prediction/anchorEdits.js';

/**
 * Places a predicted edit in the file as it is now. Text-anchored edits are found again (nearest
 * to `near`), so they survive edits above them; positional edits must still fit the file.
 * Undefined when the edit no longer applies: its text is gone, or it would change nothing.
 */
export function resolveEditInModel(edit: IPredictedEdit, model: ITextModel, near: IPosition): IPredictedEdit | undefined {
	if (edit.find !== undefined) {
		const match = locateAnchor(model.getValue(), edit.find, edit.replacement, model.getOffsetAt(near));
		if (!match) {
			return undefined;
		}
		const from = model.getPositionAt(match.start);
		const to = model.getPositionAt(match.end);
		const range = Range.fromPositions(from, to);
		if (model.getValueInRange(range) === match.replacement) {
			return undefined;
		}
		return { ...edit, range, replacement: match.replacement };
	}
	const { range } = edit;
	if (range.startLineNumber < 1 || range.endLineNumber > model.getLineCount()
		|| range.startColumn > model.getLineMaxColumn(range.startLineNumber)
		|| range.endColumn > model.getLineMaxColumn(range.endLineNumber)) {
		return undefined;
	}
	return model.getValueInRange(range) === edit.replacement ? undefined : edit;
}

/** Same-file edits top to bottom, in the order Tab walks them. */
export function sortByPosition(edits: IPredictedEdit[]): IPredictedEdit[] {
	return edits.sort((a, b) => Range.compareRangesUsingStarts(Range.lift(a.range), Range.lift(b.range)));
}
