/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

export const SEND_SELECTION_TO_CHAT_COMMAND_ID = 'workbench.action.voltAgent.addSelectionToChat';
export const INLINE_COMMENT_COMMAND_ID = 'workbench.action.voltAgent.commentSelection';
export const INLINE_COMMENT_CLOSE_COMMAND_ID = 'workbench.action.voltAgent.inlineComment.close';
export const INLINE_COMMENT_KEEP_COMMAND_ID = 'workbench.action.voltAgent.inlineComment.keep';
export const INLINE_COMMENT_UNDO_COMMAND_ID = 'workbench.action.voltAgent.inlineComment.undo';

export const CONTEXT_INLINE_COMMENT_VISIBLE = new RawContextKey<boolean>('voltInlineCommentVisible', false);
export const CONTEXT_INLINE_COMMENT_HAS_PREVIEW = new RawContextKey<boolean>('voltInlineCommentHasPreview', false);
