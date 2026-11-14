/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { fromWire, toWire } from '../../../../../platform/voltAgentServer/common/wire.js';

/**
 * A chat's first screen: its last exchanges as a window last showed them, kept for the next window that opens the
 * chat (a reload, a relaunch, Open Chat in New Window). With the agent server a window reads a chat's transcript
 * from the server, which at a window's start waits for the connection too; the pane stayed hidden all that while.
 * The first screen is drawn at once and the transcript, when it comes, replaces it.
 */
export interface IFirstScreenLimits {
	/** Messages kept at most (three exchanges). */
	readonly messages: number;
	/** Characters of their wire form kept at most. */
	readonly chars: number;
}

export const FIRST_SCREEN_LIMITS: IFirstScreenLimits = { messages: 6, chars: 192 * 1024 };
/** Chats whose first screen is kept, most recent first. */
const FIRST_SCREEN_CHATS = 8;
const INDEX_KEY = 'volt.agent.firstScreens';
const keyOf = (sessionId: string) => `volt.agent.firstScreen/${sessionId}`;

interface IFirstScreenMessage {
	readonly kind: string;
}

/**
 * The wire form of the last whole exchanges of `messages` that fit `limits`, starting at a prompt; undefined when not
 * even the last exchange fits (or there is nothing to show).
 */
export function firstScreenOf(messages: readonly IFirstScreenMessage[], limits: IFirstScreenLimits = FIRST_SCREEN_LIMITS): string | undefined {
	const kept: string[] = [];
	let chars = 2;
	let firstUser = -1;
	for (let i = messages.length - 1; i >= 0 && kept.length < limits.messages; i--) {
		let text: string;
		try {
			text = JSON.stringify(toWire(messages[i]));
		} catch {
			break;
		}
		if (chars + text.length + 1 > limits.chars) {
			break;
		}
		chars += text.length + 1;
		kept.unshift(text);
		if (messages[i].kind === 'user') {
			firstUser = kept.length;
		}
	}
	// An exchange starts at its prompt: replies kept without theirs are left out.
	if (firstUser < 0) {
		return undefined;
	}
	return `[${kept.slice(kept.length - firstUser).join(',')}]`;
}

/** Keeps chat `sessionId`'s first screen as of `now` (or forgets it when nothing fits). */
export function saveFirstScreen(storage: IStorageService, sessionId: string, messages: readonly IFirstScreenMessage[], now = Date.now()): void {
	const screen = messages.length ? firstScreenOf(messages) : undefined;
	const index = readIndex(storage).filter(([id]) => id !== sessionId);
	if (screen) {
		index.unshift([sessionId, now]);
		storage.store(keyOf(sessionId), screen, StorageScope.APPLICATION, StorageTarget.MACHINE);
	} else {
		storage.remove(keyOf(sessionId), StorageScope.APPLICATION);
	}
	for (const [dropped] of index.splice(FIRST_SCREEN_CHATS)) {
		storage.remove(keyOf(dropped), StorageScope.APPLICATION);
	}
	storage.store(INDEX_KEY, JSON.stringify(index), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/**
 * Chat `sessionId`'s first screen as a window last kept it. `changedAt` is when the chat last changed, when known: a
 * screen kept before that (the chat ran on in another window or on the agent server) is out of date and not shown.
 */
export function readFirstScreen<T>(storage: IStorageService, sessionId: string, changedAt?: number): T[] | undefined {
	const raw = storage.get(keyOf(sessionId), StorageScope.APPLICATION);
	if (!raw) {
		return undefined;
	}
	if (changedAt !== undefined && (readIndex(storage).find(([id]) => id === sessionId)?.[1] ?? 0) < changedAt) {
		return undefined;
	}
	try {
		const messages = fromWire<T[]>(JSON.parse(raw));
		return Array.isArray(messages) && messages.length ? messages : undefined;
	} catch {
		return undefined;
	}
}

/** The chats with a first screen, most recent first, and when each was kept. */
function readIndex(storage: IStorageService): [string, number][] {
	try {
		const index = JSON.parse(storage.get(INDEX_KEY, StorageScope.APPLICATION, '[]'));
		return Array.isArray(index)
			? index.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number')
			: [];
	} catch {
		return [];
	}
}
