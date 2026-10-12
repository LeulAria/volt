/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';

/**
 * The app's routes; the server answers every extension-less path with the app, so file paths
 * always ride in the query string (`/edit?path=/src/a.ts`), never in the path.
 */
export type Route =
	| { readonly name: 'home' }
	| { readonly name: 'chat'; readonly id: string }
	| { readonly name: 'new'; readonly projectId?: string }
	| { readonly name: 'settings'; readonly section: string }
	| { readonly name: 'pair' }
	| { readonly name: 'file'; readonly path: string; readonly line?: number; readonly column?: number }
	| { readonly name: 'diff'; readonly path: string; readonly base: DiffBase }
	| { readonly name: 'changes'; readonly chatId: string }
	| { readonly name: 'files' };

/**
 * The left side of a diff: the file as git's HEAD has it, or as it was before a chat's agent
 * changed it (a blob in `repo`, none when the agent created the file).
 */
export type DiffBase =
	| { readonly kind: 'head' }
	| { readonly kind: 'agent'; readonly chatId: string; readonly repo: string; readonly old?: string; readonly new?: string };

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

function num(value: string | null): number | undefined {
	const n = value ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseRoute(path: string): Route {
	const url = new URL(path, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const q = url.searchParams;
	switch (parts[0]) {
		case 't':
			return parts[1] ? { name: 'chat', id: parts[1] } : { name: 'home' };
		case 'new': {
			const projectId = q.get('project');
			return projectId ? { name: 'new', projectId } : { name: 'new' };
		}
		case 'settings':
			return { name: 'settings', section: parts[1] ?? 'general' };
		case 'devices':
			return { name: 'settings', section: 'devices' };
		case 'pair':
			return { name: 'pair' };
		case 'edit': {
			const file = q.get('path');
			if (!file) {
				return { name: 'home' };
			}
			const line = num(q.get('line'));
			const column = num(q.get('col'));
			return { name: 'file', path: file, ...(line ? { line } : {}), ...(column ? { column } : {}) };
		}
		case 'diff': {
			const file = q.get('path');
			if (!file) {
				return { name: 'home' };
			}
			const chatId = q.get('chat');
			const repo = q.get('repo');
			const base: DiffBase = chatId && repo
				? { kind: 'agent', chatId, repo, ...(q.get('old') ? { old: q.get('old')! } : {}), ...(q.get('new') ? { new: q.get('new')! } : {}) }
				: { kind: 'head' };
			return { name: 'diff', path: file, base };
		}
		case 'changes':
			return parts[1] ? { name: 'changes', chatId: parts[1] } : { name: 'home' };
		case 'files':
			return { name: 'files' };
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

export function filePath(path: string, line?: number, column?: number): string {
	const q = new URLSearchParams({ path });
	if (line) {
		q.set('line', String(line));
	}
	if (column) {
		q.set('col', String(column));
	}
	return `/edit?${q.toString()}`;
}

export function diffPath(path: string, base: DiffBase = { kind: 'head' }): string {
	const q = new URLSearchParams({ path });
	if (base.kind === 'agent') {
		q.set('chat', base.chatId);
		q.set('repo', base.repo);
		if (base.old) {
			q.set('old', base.old);
		}
		if (base.new) {
			q.set('new', base.new);
		}
	}
	return `/diff?${q.toString()}`;
}

export function changesPath(chatId: string): string {
	return `/changes/${encodeURIComponent(chatId)}`;
}

/** The path a route lives at (the inverse of {@link parseRoute}). */
export function routePath(route: Route): string {
	switch (route.name) {
		case 'home': return '/';
		case 'chat': return chatPath(route.id);
		case 'new': return route.projectId ? `/new?project=${encodeURIComponent(route.projectId)}` : '/new';
		case 'settings': return `/settings/${encodeURIComponent(route.section)}`;
		case 'pair': return '/pair';
		case 'file': return filePath(route.path, route.line, route.column);
		case 'diff': return diffPath(route.path, route.base);
		case 'changes': return changesPath(route.chatId);
		case 'files': return '/files';
	}
}
