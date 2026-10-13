/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createConversationPrefsStore, type IConversationPrefs } from '@volt/client-core';
import { useEffect, useSyncExternalStore } from 'react';
import { webStorage } from './session';

/** Tool call density, code wrap and diff tints for this browser (Settings > Appearance). */
export const conversationPrefs = createConversationPrefsStore(webStorage);

export function useConversationPrefs(): IConversationPrefs {
	return useSyncExternalStore(conversationPrefs.subscribe, conversationPrefs.get, conversationPrefs.get);
}

/** Keeps `<html data-code-wrap data-plain-diffs>` on the choices, for the transcript's CSS. */
export function useAppliedConversationPrefs(): void {
	const { codeWrap, themedDiffs } = useConversationPrefs();
	useEffect(() => {
		const root = document.documentElement;
		root.toggleAttribute('data-code-wrap', codeWrap);
		root.toggleAttribute('data-plain-diffs', !themedDiffs);
	}, [codeWrap, themedDiffs]);
}
