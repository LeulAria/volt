/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type Collections, type IChatListItem, type ICheckpointState, type IClientStatus, type IPendingSend, type IRuntimeState, type ISavedEnvironment, type IToast, type ITranscript,
	runtimeOf, selectChatItems, VoltClient
} from '@volt/client-core';
import * as Network from 'expo-network';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { asyncStorage, installClientId } from './environments';
import { startLiveActivities } from './liveActivities';

const ClientContext = createContext<VoltClient | undefined>(undefined);

/**
 * One client for the active machine. Reconnects when the app comes to the foreground or the
 * network changes (Wi-Fi to cellular), and writes its cache when the app goes to the background.
 */
export function ClientProvider({ environment, children }: { readonly environment: ISavedEnvironment | undefined; readonly children: ReactNode }) {
	const [client, setClient] = useState<VoltClient | undefined>();
	const envKey = environment ? `${environment.environmentId}:${environment.token}` : undefined;

	useEffect(() => {
		if (!environment) {
			setClient(undefined);
			return;
		}
		let disposed = false;
		let next: VoltClient | undefined;
		const subscriptions: { remove(): void }[] = [];
		let stopActivities: (() => void) | undefined;
		void installClientId().then(clientId => {
			if (disposed) {
				return;
			}
			next = new VoltClient({ environment, clientKind: 'mobile', clientId, storage: asyncStorage });
			setClient(next);
			void next.start();
			stopActivities = startLiveActivities(next);
			let backgroundedAt = 0;
			subscriptions.push(AppState.addEventListener('change', appState => {
				if (appState === 'active') {
					// A long background usually means a dead socket; replace it instead of waiting for a ping.
					if (backgroundedAt && Date.now() - backgroundedAt > 10_000) {
						next?.reconnect();
					} else {
						next?.resume();
					}
					backgroundedAt = 0;
				} else if (appState === 'background') {
					backgroundedAt = Date.now();
					next?.suspend();
				}
			}));
			subscriptions.push(Network.addNetworkStateListener(network => {
				next?.setNetworkAvailable(network.isConnected !== false);
				if (network.isConnected) {
					next?.resume();
				}
			}));
		});
		return () => {
			disposed = true;
			subscriptions.forEach(s => s.remove());
			stopActivities?.();
			next?.dispose();
		};
		// The client is replaced only when the machine or its key changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [envKey]);

	return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useOptionalClient(): VoltClient | undefined {
	return useContext(ClientContext);
}

export function useClient(): VoltClient {
	const client = useContext(ClientContext);
	if (!client) {
		throw new Error('useClient without a connected machine');
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

export const LIST_COLLECTIONS = ['history', 'orch.threads', 'orch.tasks', 'access', 'questions', 'projects', 'sessions'];

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

/** An attachment's image (a data URL), loaded on first use; only this hook's owner re-renders. */
export function useAttachment(ref: string | undefined): string | undefined {
	const client = useClient();
	const url = useSyncExternalStore(
		listener => ref ? client.subscribe(`attachment:${ref}`, listener) : () => undefined,
		() => ref ? client.getAttachmentUrl(ref) : undefined,
		() => undefined,
	);
	useEffect(() => {
		if (ref && !url) {
			void client.loadAttachment(ref);
		}
	}, [client, ref, url]);
	return url;
}

/** A chat's checkpoints (loaded once when the chat opens; the server publishes changes). */
export function useCheckpoints(chatId: string): ICheckpointState | undefined {
	const client = useClient();
	useEffect(() => {
		void client.loadCheckpoints(chatId);
	}, [client, chatId]);
	return useSyncExternalStore(
		listener => {
			const a = client.subscribe(`checkpoints:${chatId}`, listener);
			const b = client.subscribe('col:checkpoints', listener);
			return () => {
				a();
				b();
			};
		},
		() => client.getCheckpoints(chatId),
		() => undefined,
	);
}
