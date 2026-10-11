/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	activeEnvironment, EMPTY_CATALOG, type IEnvironmentCatalog, type IPairRequest, type ISavedEnvironment, type IStorage, pairEnvironment, type PairingTarget,
	parseCatalog, removeEnvironment, upsertEnvironment, uuid
} from '@volt/client-core';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

/**
 * Paired machines. Tokens live in the keychain / keystore (SecureStore, one entry per machine);
 * the rest of the catalog (labels, routes) in AsyncStorage.
 */

const CATALOG_KEY = 'volt.catalog.v1';
const CLIENT_ID_KEY = 'volt.clientId';
const tokenKey = (environmentId: string) => `volt.token.${environmentId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const asyncStorage: IStorage = {
	getItem: key => AsyncStorage.getItem(key),
	setItem: (key, value) => AsyncStorage.setItem(key, value),
	removeItem: key => AsyncStorage.removeItem(key),
};

interface IState {
	readonly loaded: boolean;
	readonly catalog: IEnvironmentCatalog;
}

let state: IState = { loaded: false, catalog: EMPTY_CATALOG };
const listeners = new Set<() => void>();

function set(next: IState): void {
	state = next;
	listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useEnvironments(): IState {
	return useSyncExternalStore(subscribe, () => state, () => state);
}

export function useActiveEnvironment(): ISavedEnvironment | undefined {
	const { catalog } = useEnvironments();
	return activeEnvironment(catalog);
}

async function persist(catalog: IEnvironmentCatalog): Promise<void> {
	const stripped: IEnvironmentCatalog = { ...catalog, environments: catalog.environments.map(env => ({ ...env, token: '' })) };
	await AsyncStorage.setItem(CATALOG_KEY, JSON.stringify(stripped));
	await Promise.all(catalog.environments.map(env => SecureStore.setItemAsync(tokenKey(env.environmentId), env.token)));
}

export async function loadEnvironments(): Promise<void> {
	if (state.loaded) {
		return;
	}
	try {
		const parsed = parseCatalog(await AsyncStorage.getItem(CATALOG_KEY));
		const environments = await Promise.all(parsed.environments.map(async env => ({ ...env, token: (await SecureStore.getItemAsync(tokenKey(env.environmentId)).catch(() => null)) ?? '' })));
		set({ loaded: true, catalog: { ...parsed, environments: environments.filter(env => env.token) } });
	} catch {
		set({ loaded: true, catalog: EMPTY_CATALOG });
	}
}

let clientIdPromise: Promise<string> | undefined;

export function installClientId(): Promise<string> {
	clientIdPromise ??= (async () => {
		const existing = await AsyncStorage.getItem(CLIENT_ID_KEY);
		if (existing) {
			return existing;
		}
		const id = `mobile-${uuid()}`;
		await AsyncStorage.setItem(CLIENT_ID_KEY, id);
		return id;
	})();
	return clientIdPromise;
}

/** What the server shows in its device list for this phone. */
export function deviceInfo(): IPairRequest['client'] {
	const tablet = Device.deviceType === Device.DeviceType.TABLET;
	const name = Device.deviceName ?? Device.modelName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
	return {
		label: name,
		kind: tablet ? 'tablet' : 'mobile',
		os: `${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${Device.osVersion ?? ''}`.trim(),
		...(Device.modelName ? { model: Device.modelName } : {}),
	};
}

/** Pairs with a machine (or adds a route to one already paired) and makes it the active one. */
export async function pairWith(target: PairingTarget): Promise<ISavedEnvironment> {
	const environment = await pairEnvironment(target, deviceInfo(), state.catalog.environments);
	const catalog = upsertEnvironment(state.catalog, environment);
	await persist(catalog);
	set({ loaded: true, catalog });
	return environment;
}

export async function activate(environmentId: string): Promise<void> {
	const catalog = { ...state.catalog, activeId: environmentId };
	await persist(catalog);
	set({ loaded: true, catalog });
}

export async function forget(environmentId: string): Promise<void> {
	const catalog = removeEnvironment(state.catalog, environmentId);
	await SecureStore.deleteItemAsync(tokenKey(environmentId)).catch(() => undefined);
	await persist(catalog);
	set({ loaded: true, catalog });
}

export function updateEnvironment(environment: ISavedEnvironment): void {
	const catalog = upsertEnvironment(state.catalog, environment, state.catalog.activeId === environment.environmentId);
	set({ loaded: true, catalog });
	void persist(catalog);
}
