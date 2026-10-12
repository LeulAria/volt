/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	classifyHost, errorMessage, type IEnvironmentCatalog, type IStorage, type ISavedEnvironment, mergeRoutes, pairEnvironment, parseCatalog, parsePairingLink,
	probeEnvironment, removeEnvironment, requestLocalSession, upsertEnvironment, uuid
} from '@volt/client-core';

const CATALOG_KEY = 'volt.web.catalog';
const CLIENT_ID_KEY = 'volt.web.clientId';

/** localStorage behind the async storage interface the client uses. */
export const webStorage: IStorage = {
	getItem: key => Promise.resolve(safe(() => window.localStorage.getItem(key), null)),
	setItem: (key, value) => Promise.resolve(safe(() => window.localStorage.setItem(key, value), undefined)),
	removeItem: key => Promise.resolve(safe(() => window.localStorage.removeItem(key), undefined)),
};

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

export function clientId(): string {
	let id = safe(() => window.localStorage.getItem(CLIENT_ID_KEY), null);
	if (!id) {
		id = `web-${uuid()}`;
		safe(() => window.localStorage.setItem(CLIENT_ID_KEY, id!), undefined);
	}
	return id;
}

export function loadCatalog(): IEnvironmentCatalog {
	return parseCatalog(safe(() => window.localStorage.getItem(CATALOG_KEY), null));
}

export function saveCatalog(catalog: IEnvironmentCatalog): void {
	safe(() => window.localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)), undefined);
}

/** This page's server: the web app is always served by the agent server it talks to. */
export function serverOrigin(): string {
	return window.location.origin;
}

function isLoopback(): boolean {
	return classifyHost(window.location.hostname) === 'loopback';
}

export function browserLabel(): string {
	const ua = navigator.userAgent;
	const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
	return os ? `${browser} on ${os}` : browser;
}

export type BootResult =
	| { readonly kind: 'ready'; readonly environment: ISavedEnvironment; readonly workbench?: boolean }
	| { readonly kind: 'pair'; readonly code?: string; readonly error?: string };

/**
 * Decides how this page signs in:
 * 1. `#token=` (Volt's "Open in browser" link): an owner token, kept and stripped from the URL.
 * 2. `/pair#code=` (a pairing link): the pair page spends the code.
 * 3. A saved environment for this server: used as is.
 * 4. The page is on the server's own machine (loopback): it asks for a local session.
 * 5. Otherwise: the pair page asks for a code.
 */
export async function bootstrap(): Promise<BootResult> {
	const origin = serverOrigin();
	const link = parsePairingLink(window.location.href);
	if (link?.kind === 'token') {
		window.history.replaceState(null, '', window.location.pathname);
		try {
			const environment = await pairEnvironment({ ...link, baseUrl: origin }, { label: browserLabel(), kind: 'web' }, loadCatalog().environments);
			saveCatalog(upsertEnvironment(loadCatalog(), environment));
			return { kind: 'ready', environment };
		} catch (err) {
			return { kind: 'pair', error: errorMessage(err) };
		}
	}
	if (link?.kind === 'code') {
		return { kind: 'pair', code: link.code };
	}
	const catalog = loadCatalog();
	let descriptor: Awaited<ReturnType<typeof probeEnvironment>> | undefined;
	try {
		descriptor = await probeEnvironment(origin);
	} catch (err) {
		const saved = catalog.environments.find(env => env.routes.some(route => route.baseUrl === origin));
		// Offline or restarting: the cached state can still be shown.
		return saved ? { kind: 'ready', environment: saved } : { kind: 'pair', error: errorMessage(err) };
	}
	workbenchAvailable = !!descriptor.capabilities?.workbench;
	const saved = catalog.environments.find(env => env.environmentId === descriptor.environmentId);
	if (saved) {
		const environment = { ...saved, label: descriptor.label, routes: mergeRoutes(saved.routes, [{ baseUrl: origin, kind: classifyHost(window.location.hostname) }]) };
		saveCatalog(upsertEnvironment(catalog, environment));
		return { kind: 'ready', environment, workbench: workbenchAvailable };
	}
	if (isLoopback()) {
		try {
			const session = await requestLocalSession(origin);
			const environment: ISavedEnvironment = {
				environmentId: session.environmentId,
				label: descriptor.label,
				token: session.token,
				deviceId: session.deviceId,
				role: session.role,
				routes: [{ baseUrl: origin, kind: 'loopback', lastOkAt: Date.now() }],
				addedAt: Date.now(),
				platform: descriptor.platform,
			};
			saveCatalog(upsertEnvironment(catalog, environment));
			return { kind: 'ready', environment, workbench: workbenchAvailable };
		} catch (err) {
			return { kind: 'pair', error: errorMessage(err) };
		}
	}
	return { kind: 'pair' };
}

export async function pairWithCode(code: string): Promise<ISavedEnvironment> {
	const environment = await pairEnvironment({ kind: 'code', baseUrl: serverOrigin(), code }, { label: browserLabel(), kind: 'web' }, loadCatalog().environments);
	saveCatalog(upsertEnvironment(loadCatalog(), environment));
	return environment;
}

//#region Volt's workbench (VS Code in the browser, at /code/)

const UI_KEY = 'volt.web.ui';
const WORKBENCH_SESSION_PATH = '/api/workbench/session';

/** Whether the server that served this page also serves the workbench (known once it answered). */
let workbenchAvailable = false;

export function isWorkbenchAvailable(): boolean {
	return workbenchAvailable;
}

/** Asks the server again (a page that paired from a link never probed it). */
export async function refreshWorkbenchAvailable(): Promise<boolean> {
	try {
		workbenchAvailable = !!(await probeEnvironment(serverOrigin())).capabilities?.workbench;
	} catch {
		// keep what is known
	}
	return workbenchAvailable;
}

/** `lite`: this browser chose the lightweight app over the workbench. */
export function prefersLiteApp(): boolean {
	return safe(() => window.localStorage.getItem(UI_KEY), null) === 'lite';
}

export function setPrefersLiteApp(lite: boolean): void {
	safe(() => lite ? window.localStorage.setItem(UI_KEY, 'lite') : window.localStorage.removeItem(UI_KEY), undefined);
}

/**
 * Where a signed-in page goes instead of the lightweight app: the workbench page it was sent
 * from (`?next=/code/…`), or the workbench itself (the desktop's UI, laid out for any width),
 * unless this browser chose the lightweight app (`?lite=1`). The app's own pages (Devices, a
 * chat link) stay here.
 */
export function workbenchTarget(workbench: boolean | undefined): string | undefined {
	const params = new URLSearchParams(window.location.search);
	if (params.has('lite')) {
		setPrefersLiteApp(params.get('lite') !== '0');
		params.delete('lite');
		const query = params.toString();
		window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
	}
	const next = params.get('next');
	if (next && /^\/code(\/|$|\?)/.test(next)) {
		return next;
	}
	if (!workbench || prefersLiteApp() || (window.location.pathname !== '/' && window.location.pathname !== '/pair')) {
		return undefined;
	}
	return '/code/';
}

/**
 * Signs this browser in to the workbench (cookies the server checks on every request) and goes
 * there. Resolves false when the server would not, so the page can stay.
 */
export async function openWorkbench(environment: ISavedEnvironment, target = '/code/'): Promise<boolean> {
	try {
		const response = await fetch(WORKBENCH_SESSION_PATH, { method: 'POST', credentials: 'same-origin', headers: { Authorization: `Bearer ${environment.token}` } });
		if (!response.ok) {
			return false;
		}
		setPrefersLiteApp(false);
		window.location.replace(target);
		return true;
	} catch {
		return false;
	}
}

//#endregion

export function forgetEnvironment(environmentId: string): void {
	saveCatalog(removeEnvironment(loadCatalog(), environmentId));
}
