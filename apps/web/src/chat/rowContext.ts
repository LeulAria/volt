/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccessMode, ComposerMode, ICheckpointState, IPromptAttachment } from '@volt/client-core';
import { createContext, useContext } from 'react';

/** What transcript rows need from the chat around them (editing, checkpoints, opening files). */
export interface IChatRowContext {
	readonly chatId: string;
	readonly running: boolean;
	/** The chat's project folder: relative paths in replies resolve against it. */
	readonly root?: string;
	readonly mode: ComposerMode;
	readonly modelRef?: string;
	readonly accessMode?: AccessMode;
	readonly checkpoints?: ICheckpointState;
	readonly editingTurnId?: string;
	/** The prompt whose checkpoint was just restored ("Redo checkpoint" shows under it). */
	readonly restoredTurnId?: string;
	readonly lastTurnId?: string;
	readonly startEdit: (turnId: string | undefined) => void;
	readonly onRewound: (text: string, attachments: readonly IPromptAttachment[]) => void;
	readonly onRestored: (turnId: string | undefined) => void;
	readonly openPath?: (path: string, line?: number) => void;
}

export const ChatRowContext = createContext<IChatRowContext | undefined>(undefined);

export function useChatRow(): IChatRowContext | undefined {
	return useContext(ChatRowContext);
}

/** `src/a.ts:12:4`, `./b.tsx`, `/abs/c.py`: a path with an extension, maybe a line and column. */
export function parseFileRef(text: string): { readonly path: string; readonly line?: number; readonly column?: number } | undefined {
	const clean = text.trim().replace(/^file:\/\//, '').replace(/^`|`$/g, '');
	const m = /^((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]+)*\.[A-Za-z0-9]{1,8})(?:[:#]L?(\d+)(?:[:-](\d+))?)?$/.exec(clean);
	if (!m || /^https?:/.test(clean) || /^\d+\.\d+/.test(clean)) {
		return undefined;
	}
	return { path: m[1], ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { column: Number(m[3]) } : {}) };
}
