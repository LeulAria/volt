/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltClient } from '@volt/client-core/src/client';
import { chooseRoute, type ISavedEnvironment } from '@volt/client-core/src/environments';
import { AppState } from 'react-native';
import { asyncStorage, installClientId } from './environments';
import { startLiveActivities } from './liveActivities';

/**
 * Live Activities and the Dynamic Island (iOS): a client of the active computer's agent server
 * that only feeds the activity planner, next to the workbench (which has its own connection).
 * Started once the workbench is up so it never competes with its start-up. Reconnects when the
 * app comes back to the foreground and writes its cache when it goes to the background.
 */
export function startLiveClient(environment: ISavedEnvironment, baseUrl: () => string | undefined): () => void {
	let disposed = false;
	let client: VoltClient | undefined;
	let stopActivities: (() => void) | undefined;
	let subscription: { remove(): void } | undefined;
	void installClientId().then(clientId => {
		if (disposed) {
			return;
		}
		client = new VoltClient({
			environment,
			clientKind: 'mobile',
			clientId,
			storage: asyncStorage,
			// The address the workbench signed in at, already checked to be this machine.
			resolveBaseUrl: async () => baseUrl() ?? (await chooseRoute(environment)).baseUrl,
		});
		void client.start();
		stopActivities = startLiveActivities(client);
		let backgroundedAt = 0;
		subscription = AppState.addEventListener('change', appState => {
			if (appState === 'active') {
				// A long background usually means a dead socket; replace it instead of waiting for a ping.
				if (backgroundedAt && Date.now() - backgroundedAt > 10_000) {
					client?.reconnect();
				} else {
					client?.resume();
				}
				backgroundedAt = 0;
			} else if (appState === 'background') {
				backgroundedAt = Date.now();
				client?.suspend();
			}
		});
	});
	return () => {
		disposed = true;
		subscription?.remove();
		stopActivities?.();
		client?.dispose();
	};
}
