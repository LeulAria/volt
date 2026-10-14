import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const KEY = 'volt.mobile.model';
let current: string | undefined;
const listeners = new Set<() => void>();

void AsyncStorage.getItem(KEY).then(value => {
	if (value && current === undefined) {
		current = value;
		listeners.forEach(listener => listener());
	}
});

/** The model this phone's composer sends with, until a chat has one of its own. */
export function setPickedModel(ref: string): void {
	current = ref;
	void AsyncStorage.setItem(KEY, ref);
	listeners.forEach(listener => listener());
}

export function usePickedModel(): string | undefined {
	return useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => current);
}
