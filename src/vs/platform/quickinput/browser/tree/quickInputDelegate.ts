/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IQuickTreeItem } from '../../common/quickInput.js';
import { QuickInputTreeRenderer } from './quickInputTreeRenderer.js';

/** Volt: 26px rows, as in the quick pick list and Volt's other lists. */
export const QUICK_INPUT_TREE_ROW_HEIGHT = 26;

/**
 * Delegate for QuickInputTree that provides height and template information.
 */
export class QuickInputTreeDelegate<T extends IQuickTreeItem> implements IListVirtualDelegate<T> {
	getHeight(_element: T): number {
		return QUICK_INPUT_TREE_ROW_HEIGHT;
	}

	getTemplateId(_element: T): string {
		return QuickInputTreeRenderer.ID;
	}
}
