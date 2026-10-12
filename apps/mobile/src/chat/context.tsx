/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TranscriptRow } from '@volt/client-core';
import { router } from 'expo-router';
import { createContext, useContext } from 'react';

export type UserRowData = Extract<TranscriptRow, { kind: 'user' }>;

/**
 * What a chat's rows can do beyond drawing themselves: open a sent message's menu, retry a reply,
 * redo a restored checkpoint, open a file the reply mentions. The chat screen provides it with
 * stable callbacks, so rows don't re-render when it re-renders.
 */
export interface IChatContext {
	readonly chatId: string;
	/** The chat's folder: relative paths in replies resolve against it. */
	readonly folder?: string;
	readonly onMessageMenu: (row: UserRowData) => void;
	readonly onRetry: (turnId: string) => void;
	/** The message whose checkpoint was just restored (a Redo pill shows under it). */
	readonly redoTurnId?: string;
	readonly onRedo: () => void;
}

export const ChatContext = createContext<IChatContext | undefined>(undefined);

export function useChatContext(): IChatContext | undefined {
	return useContext(ChatContext);
}

/** `src/app.ts:12`, `/abs/path.ts#L4`, `file:///abs`: the absolute path and line, when it looks like a file. */
export function resolveFileLink(href: string, folder: string | undefined): { readonly path: string; readonly line?: number } | undefined {
	let value = href.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith('file://')) {
		return undefined;
	}
	value = value.replace(/^file:\/\//, '');
	try {
		value = decodeURI(value);
	} catch {
		// keep as is
	}
	const match = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/.exec(value);
	const raw = match?.[1] ?? value;
	const line = Number(match?.[2] ?? match?.[3]) || undefined;
	if (!raw || /\s/.test(raw) || !/[\w-]\.[\w]{1,8}$|\/[\w.-]+$/.test(raw)) {
		return undefined;
	}
	if (raw.startsWith('/')) {
		return { path: raw, ...(line ? { line } : {}) };
	}
	if (!folder || raw.startsWith('..') || !raw.includes('/')) {
		return undefined;
	}
	const base = folder.endsWith('/') ? folder.slice(0, -1) : folder;
	return { path: `${base}/${raw.replace(/^\.\//, '')}`, ...(line ? { line } : {}) };
}

export function openFile(path: string, line?: number): void {
	router.push({ pathname: '/file', params: { path, ...(line ? { line: String(line) } : {}) } });
}
