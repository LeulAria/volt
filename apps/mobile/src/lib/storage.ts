import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IAgentClientStorage } from '@/core/voltCore';

const PREFIX = 'volt.client.';

/**
 * The shared services read their storage synchronously (selected project, models). Keys are
 * loaded once at start and written through to AsyncStorage.
 */
export class DeviceStorage implements IAgentClientStorage {

	private readonly values = new Map<string, string>();

	static async load(): Promise<DeviceStorage> {
		const storage = new DeviceStorage();
		const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(PREFIX));
		for (const [key, value] of await AsyncStorage.multiGet(keys)) {
			if (value !== null) {
				storage.values.set(key.slice(PREFIX.length), value);
			}
		}
		return storage;
	}

	get(key: string, _scope?: unknown, fallback?: string): string | undefined {
		return this.values.get(key) ?? fallback;
	}

	store(key: string, value: string): void {
		this.values.set(key, value);
		void AsyncStorage.setItem(PREFIX + key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
		void AsyncStorage.removeItem(PREFIX + key);
	}
}
