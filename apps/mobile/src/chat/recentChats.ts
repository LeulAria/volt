/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * The chats opened on this phone, newest first: the chat screen's tab strip, like the agent tabs
 * on the desktop. Kept per install.
 */

const KEY = 'volt.recentChats';
const MAX = 8;

let ids: readonly string[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
	listeners.forEach(listener => listener());
}

function save(): void {
	void AsyncStorage.setItem(KEY, JSON.stringify(ids)).catch(() => undefined);
}

function load(): void {
	if (loaded) {
		return;
	}
	loaded = true;
	void AsyncStorage.getItem(KEY).then(raw => {
		try {
			const stored = JSON.parse(raw ?? '[]') as unknown;
			if (Array.isArray(stored)) {
				// What was opened before the load finished stays first.
				ids = [...ids, ...stored.filter((id): id is string => typeof id === 'string' && !ids.includes(id))].slice(0, MAX);
				emit();
			}
		} catch {
			// ignored
		}
	}, () => undefined);
}

/** Puts a chat first (it was just opened). */
export function touchRecentChat(id: string): void {
	load();
	if (ids[0] === id) {
		return;
	}
	ids = [id, ...ids.filter(other => other !== id)].slice(0, MAX);
	save();
	emit();
}

export function closeRecentChat(id: string): void {
	ids = ids.filter(other => other !== id);
	save();
	emit();
}

export function useRecentChats(): readonly string[] {
	load();
	return useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => ids, () => ids);
}
