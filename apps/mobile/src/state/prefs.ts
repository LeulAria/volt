/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createConversationPrefsStore, type IConversationPrefs } from '@volt/client-core';
import { useSyncExternalStore } from 'react';

/** Tool call density, code wrap and diff tints on this phone (Settings > Agent conversations). */
export const conversationPrefs = createConversationPrefsStore({
	getItem: key => AsyncStorage.getItem(key),
	setItem: (key, value) => AsyncStorage.setItem(key, value),
	removeItem: key => AsyncStorage.removeItem(key),
});

export function useConversationPrefs(): IConversationPrefs {
	return useSyncExternalStore(conversationPrefs.subscribe, conversationPrefs.get, conversationPrefs.get);
}
