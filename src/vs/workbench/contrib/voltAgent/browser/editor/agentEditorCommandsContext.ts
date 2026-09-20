/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEditorCommandsContext } from '../../../../common/editor.js';

export function isEditorCommandsContext(value: unknown): value is IEditorCommandsContext {
	return !!value && typeof value === 'object' && typeof (value as IEditorCommandsContext).groupId === 'number';
}

/**
 * Title-bar actions send the editor URI first, then `{ groupId }`. Scan every
 * argument so the side-panel `+` is not treated as the center group.
 */
export function findEditorCommandsContext(args: readonly unknown[]): IEditorCommandsContext | undefined {
	for (const arg of args) {
		if (isEditorCommandsContext(arg)) {
			return arg;
		}
	}
	return undefined;
}
