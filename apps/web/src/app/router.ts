/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';

/** The few routes the app has; the server answers every extension-less path with the app. */
export type Route =
	| { readonly name: 'home' }
	| { readonly name: 'chat'; readonly id: string }
	| { readonly name: 'new'; readonly projectId?: string }
	| { readonly name: 'settings'; readonly section: string }
	| { readonly name: 'pair' };

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener('popstate', listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener('popstate', listener);
	};
}

function snapshot(): string {
	return `${window.location.pathname}${window.location.search}`;
}

export function parseRoute(path: string): Route {
	const url = new URL(path, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	switch (parts[0]) {
		case 't':
			return parts[1] ? { name: 'chat', id: parts[1] } : { name: 'home' };
		case 'new': {
			const projectId = url.searchParams.get('project');
			return projectId ? { name: 'new', projectId } : { name: 'new' };
		}
		case 'settings':
			return { name: 'settings', section: parts[1] ?? 'general' };
		case 'devices':
			return { name: 'settings', section: 'devices' };
		case 'pair':
			return { name: 'pair' };
		default:
			return { name: 'home' };
	}
}

export function useRoute(): Route {
	const path = useSyncExternalStore(subscribe, snapshot, snapshot);
	return parseRoute(path);
}

export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
	if (to === snapshot()) {
		return;
	}
	if (options.replace) {
		window.history.replaceState(null, '', to);
	} else {
		window.history.pushState(null, '', to);
	}
	listeners.forEach(listener => listener());
}

export function chatPath(id: string): string {
	return `/t/${encodeURIComponent(id)}`;
}
