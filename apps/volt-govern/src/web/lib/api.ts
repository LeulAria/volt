/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invalidate } from './query';

/** The console API (`/api/govern/*`): same-origin, cookie session, JSON in and out. */
export class ApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/govern${path}`, {
		method,
		credentials: 'same-origin',
		// Every write is JSON (the server refuses other writes: a cross-site page cannot send JSON).
		headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
		body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
	});
	const text = await res.text();
	const json = text ? (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })() : undefined;
	if (res.status === 401 && path !== '/me') {
		// The session ended (signed out elsewhere, expired, revoked): re-check it so the app returns to sign-in.
		invalidate('me');
	}
	if (!res.ok) {
		const err = json as { error?: string; code?: string } | undefined;
		throw new ApiError(err?.error ?? `Request failed (${res.status})`, res.status, err?.code);
	}
	return json as T;
}

export const api = {
	get: <T>(path: string) => request<T>('GET', path),
	post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
	put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
	patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
	delete: <T>(path: string) => request<T>('DELETE', path),
};

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
