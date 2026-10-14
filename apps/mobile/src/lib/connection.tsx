import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { AgentClientServices, type AgentServerConnectionState, type IWebSocketLike } from '@/core/voltCore';
import { DeviceStorage } from './storage';
import { IPairing, webSocketUrl } from './pairing';

const PAIRING_KEY = 'volt.pairing';

interface IVoltContext {
	readonly pairing: IPairing | undefined;
	readonly services: AgentClientServices | undefined;
	readonly loaded: boolean;
	pair(pairing: IPairing): Promise<void>;
	unpair(): Promise<void>;
}

const VoltContext = createContext<IVoltContext | undefined>(undefined);

/**
 * The agent server connection for the whole app: the pairing (kept in the keychain) and one set of
 * the shared client services, the same ones the web app and the agent window run on.
 */
export function VoltProvider({ children }: { readonly children: ReactNode }) {
	const [pairing, setPairing] = useState<IPairing | undefined>();
	const [storage, setStorage] = useState<DeviceStorage | undefined>();
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		void (async () => {
			const [saved, device] = await Promise.all([SecureStore.getItemAsync(PAIRING_KEY), DeviceStorage.load()]);
			setStorage(device);
			try {
				setPairing(saved ? JSON.parse(saved) as IPairing : undefined);
			} catch {
				setPairing(undefined);
			}
			setLoaded(true);
		})();
	}, []);

	const services = useMemo(() => {
		if (!pairing || !storage) {
			return undefined;
		}
		return new AgentClientServices({
			kind: 'mobile',
			endpoint: async () => ({ url: webSocketUrl(pairing.server), token: pairing.token }),
			createSocket: url => new WebSocket(url) as unknown as IWebSocketLike,
			storage,
			onError: (method, err) => console.warn(`[volt] ${method} failed`, err),
		});
	}, [pairing, storage]);

	useEffect(() => {
		if (!services) {
			return;
		}
		services.connect();
		// Coming back to the foreground skips the reconnect backoff (as T3 Code's app does).
		const subscription = AppState.addEventListener('change', state => {
			if (state === 'active' && services.client.connection.state !== 'open') {
				services.client.connection.reconnect();
			}
		});
		return () => {
			subscription.remove();
			services.dispose();
		};
	}, [services]);

	const pair = useCallback(async (next: IPairing) => {
		await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(next));
		setPairing(next);
	}, []);
	const unpair = useCallback(async () => {
		await SecureStore.deleteItemAsync(PAIRING_KEY);
		setPairing(undefined);
	}, []);

	const value = useMemo(() => ({ pairing, services, loaded, pair, unpair }), [pairing, services, loaded, pair, unpair]);
	return <VoltContext.Provider value={value}>{children}</VoltContext.Provider>;
}

export function useVolt(): IVoltContext {
	const context = useContext(VoltContext);
	if (!context) {
		throw new Error('useVolt outside VoltProvider');
	}
	return context;
}

export function useServices(): AgentClientServices {
	const { services } = useVolt();
	if (!services) {
		throw new Error('not paired');
	}
	return services;
}

/**
 * A number that changes whenever the server's state that screens read changes (chats, threads,
 * projects, models, questions): read it to re-render with the latest mirror.
 */
export function useServerVersion(services: AgentClientServices | undefined): number {
	const version = useRef(0);
	const subscribe = useCallback((notify: () => void) => {
		if (!services) {
			return () => { };
		}
		const bump = () => {
			version.current++;
			notify();
		};
		const disposables = [
			services.client.onDidChangeCollection(bump),
			services.client.onDidChangeState(bump),
			services.history.onDidChange(bump),
			services.orchestrator.onDidChange(bump),
			services.projects.onDidChangeProjects(bump),
			services.projects.onDidChangeActiveProject(bump),
		];
		return () => disposables.forEach(d => d.dispose());
	}, [services]);
	return useSyncExternalStore(subscribe, () => version.current);
}

export function useConnectionState(services: AgentClientServices | undefined): AgentServerConnectionState | 'none' {
	const subscribe = useCallback((notify: () => void) => {
		const disposable = services?.client.onDidChangeState(notify);
		return () => disposable?.dispose();
	}, [services]);
	return useSyncExternalStore(subscribe, () => services?.client.connection.state ?? 'none');
}

/** Re-renders every `ms` while `active` (ages, "Working 12s"). */
export function useTicker(ms: number, active = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return;
		}
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms, active]);
	return now;
}
