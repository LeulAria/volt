/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoiceCallRecord } from '@volt/client-core';
import { createContext, useEffect, useMemo, useState } from 'react';
import { useClient } from '../../state/client';
import { useVoiceCall } from './voiceCall';

export interface IChatVoiceCalls {
	/** Calls whose card follows a turn's reply, by that turn's id. */
	readonly byTurn: ReadonlyMap<string, readonly IVoiceCallRecord[]>;
	/** Calls with no drawn anchor yet (a live first turn): at the chat's newest end. */
	readonly loose: readonly IVoiceCallRecord[];
}

const EMPTY: IChatVoiceCalls = { byTurn: new Map(), loose: [] };

export const VoiceCallsContext = createContext<IChatVoiceCalls>(EMPTY);

/** The voice calls that reached a chat, read again whenever a call starts, moves or ends. */
export function useChatVoiceCalls(chatId: string, turnIds: ReadonlySet<string>): IChatVoiceCalls {
	const client = useClient();
	const voice = useVoiceCall();
	const [calls, setCalls] = useState<readonly IVoiceCallRecord[]>([]);
	const phase = voice?.state.phase;
	const liveId = voice?.state.callId;
	const liveChat = voice?.state.chatId;
	useEffect(() => {
		let cancelled = false;
		void client.voiceCalls(chatId).then(found => {
			if (!cancelled) {
				setCalls(found);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [client, chatId, phase, liveId, liveChat]);
	return useMemo(() => {
		const all = [...calls];
		// The live call before the server's record lists it here (its first turn just started).
		if (liveId && liveChat === chatId && !all.some(call => call.id === liveId)) {
			all.push({ id: liveId, startedAt: Date.now(), status: 'ongoing', chatIds: [chatId], turns: [] });
		}
		if (!all.length) {
			return EMPTY;
		}
		const byTurn = new Map<string, IVoiceCallRecord[]>();
		const loose: IVoiceCallRecord[] = [];
		for (const call of all) {
			const turnId = call.anchors?.[chatId]?.turnId;
			if (turnId && turnIds.has(turnId)) {
				byTurn.set(turnId, [...(byTurn.get(turnId) ?? []), call]);
			} else {
				loose.push(call);
			}
		}
		return { byTurn, loose };
	}, [calls, chatId, liveId, liveChat, turnIds]);
}
