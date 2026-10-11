/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type Collections, type IChatListItem, type IClientStatus, type IPendingSend, type IRuntimeState, type IToast, type ITranscript, runtimeOf, selectChatItems, type VoltClient
} from '@volt/client-core';
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';

const ClientContext = createContext<VoltClient | undefined>(undefined);

export function ClientProvider({ client, children }: { readonly client: VoltClient; readonly children: ReactNode }) {
	return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): VoltClient {
	const client = useContext(ClientContext);
	if (!client) {
		throw new Error('useClient outside ClientProvider');
	}
	return client;
}

function useKey<T>(key: string, get: () => T): T {
	const client = useClient();
	return useSyncExternalStore(listener => client.subscribe(key, listener), get, get);
}

export function useStatus(): IClientStatus {
	const client = useClient();
	return useKey('status', () => client.getStatus());
}

/** The collections, re-rendering only when one of `names` changes. */
export function useCollections(names: readonly string[]): Collections {
	const client = useClient();
	return useSyncExternalStore(
		listener => {
			const unsubscribes = names.map(name => client.subscribe(`col:${name}`, listener));
			return () => unsubscribes.forEach(unsubscribe => unsubscribe());
		},
		() => client.getCollections(),
		() => client.getCollections(),
	);
}

const LIST_COLLECTIONS = ['history', 'orch.threads', 'orch.tasks', 'access', 'questions', 'projects', 'sessions'];

export function useChatItems(): readonly IChatListItem[] {
	return selectChatItems(useCollections(LIST_COLLECTIONS));
}

export function useRuntime(): IRuntimeState {
	return runtimeOf(useCollections(['runtime']));
}

export function useTranscript(chatId: string): ITranscript | undefined {
	const client = useClient();
	useEffect(() => client.retainTranscript(chatId), [client, chatId]);
	return useKey(`transcript:${chatId}`, () => client.getTranscript(chatId));
}

export function usePending(chatId: string): readonly IPendingSend[] {
	const client = useClient();
	return useKey(`pending:${chatId}`, () => client.getPending(chatId));
}

export function useToasts(): readonly IToast[] {
	const client = useClient();
	return useKey('toasts', () => client.getToasts());
}

/** Re-renders every `ms` (live timers). */
export function useNow(ms = 1000, active = true): number {
	return useSyncExternalStore(
		listener => {
			if (!active) {
				return () => undefined;
			}
			const timer = setInterval(listener, ms);
			return () => clearInterval(timer);
		},
		() => (active ? Math.floor(Date.now() / ms) * ms : 0),
		() => 0,
	);
}
