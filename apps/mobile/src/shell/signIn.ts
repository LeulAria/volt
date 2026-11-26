/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type IRoute, type ISavedEnvironment, routeRank } from '@volt/client-core/src/environments';
import { type IEnvironmentDescriptor, VOLT_ENVIRONMENT_PATH } from '@volt/client-core/src/protocol';
import { originOf, sameOrigin } from './bridge';

/**
 * How the shell gets a computer's workbench on screen without a credential in any URL the page
 * keeps: the route is chosen by asking every saved address which machine it is (no token sent),
 * then the WebView signs in there and lands on `/code/`.
 */

export const WORKBENCH_PATH = '/code/';
const SESSION_PATH = '/api/workbench/session';

export interface IShellDescriptor extends IEnvironmentDescriptor {
	/**
	 * `workbench`: the server serves the workbench at `/code/`. `shellSignIn`: `GET /api/workbench/session`
	 * takes the device token as a bearer, sets the session cookie and redirects to `next`.
	 */
	readonly capabilities: IEnvironmentDescriptor['capabilities'] & { readonly shellSignIn?: boolean };
}

export interface IResolvedRoute {
	readonly route: IRoute;
	readonly descriptor: IShellDescriptor;
}

export class ShellError extends Error {
	constructor(readonly kind: 'unreachable' | 'removed' | 'outdated', message: string) {
		super(message);
	}
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

const LAST_ROUTES_KEY = 'volt.shell.lastRoutes';
/** Per computer, the address its workbench last came up at. */
let lastRoutes: Readonly<Record<string, string>> = {};
/** Started at launch, next to the catalog. */
const lastRoutesLoaded: Promise<void> = AsyncStorage.getItem(LAST_ROUTES_KEY).then(json => {
	const value: unknown = json ? JSON.parse(json) : undefined;
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		lastRoutes = { ...value as Record<string, string>, ...lastRoutes };
	}
}).catch(() => undefined);

/** The address a computer's workbench came up at: it gets a head start the next time. */
export function rememberRoute(environmentId: string, baseUrl: string): void {
	if (lastRoutes[environmentId] === baseUrl) {
		return;
	}
	lastRoutes = { ...lastRoutes, [environmentId]: baseUrl };
	void AsyncStorage.setItem(LAST_ROUTES_KEY, JSON.stringify(lastRoutes)).catch(() => undefined);
}

/** What the address says it is, if it says it is this machine. */
async function probe(route: IRoute, environmentId: string, timeoutMs: number): Promise<IResolvedRoute | undefined> {
	try {
		const response = await fetchWithTimeout(`${route.baseUrl}${VOLT_ENVIRONMENT_PATH}`, { headers: { Accept: 'application/json' } }, timeoutMs);
		if (!response.ok) {
			return undefined;
		}
		const descriptor = await response.json() as IShellDescriptor;
		if (!descriptor || descriptor.environmentId !== environmentId || typeof descriptor.capabilities !== 'object' || !descriptor.capabilities) {
			return undefined;
		}
		return { route, descriptor };
	} catch {
		return undefined;
	}
}

/**
 * The best saved address that answers as this machine right now. Every address is asked at once;
 * a better kind (loopback, then LAN, Tailscale, public) wins when it answers within a moment of
 * the first answer, so a dead LAN address never holds up a working Tailscale one for long. The
 * address the workbench last came up at waits even less for a better kind: it worked last time.
 */
async function findRoute(env: ISavedEnvironment, timeoutMs = 4_000): Promise<IResolvedRoute> {
	await lastRoutesLoaded;
	const preferred = lastRoutes[env.environmentId];
	const routes = [...env.routes].sort((a, b) => routeRank(a.kind) - routeRank(b.kind));
	const results: (IResolvedRoute | undefined | null)[] = routes.map(() => null);
	const found = await new Promise<IResolvedRoute | undefined>(resolve => {
		let settled = 0;
		let grace: ReturnType<typeof setTimeout> | undefined;
		let graceAt = Infinity;
		const best = () => results.find((result): result is IResolvedRoute => !!result);
		const decide = () => {
			// The best answer so far, once nothing better-ranked is still pending.
			const index = results.findIndex(result => result !== undefined);
			if (index < 0) {
				return settled === routes.length ? resolve(undefined) : undefined;
			}
			if (results[index]) {
				clearTimeout(grace);
				resolve(results[index]!);
			}
		};
		routes.forEach((route, i) => {
			void probe(route, env.environmentId, timeoutMs).then(result => {
				results[i] = result;
				settled++;
				decide();
				const wait = route.baseUrl === preferred ? 100 : 400;
				if (result && Date.now() + wait < graceAt) {
					graceAt = Date.now() + wait;
					clearTimeout(grace);
					grace = setTimeout(() => resolve(best()), wait);
				}
			});
		});
		if (!routes.length) {
			resolve(undefined);
		}
	});
	if (!found) {
		throw new ShellError('unreachable', `Can't reach ${env.label}. Make sure Volt is open on it and this phone is on the same network.`);
	}
	return found;
}

/** A search started before the workbench asked for it (at launch). */
let early: { readonly environmentId: string; readonly routes: string; readonly at: number; readonly result: Promise<IResolvedRoute> } | undefined;

const routesKey = (env: ISavedEnvironment) => env.routes.map(route => route.baseUrl).join(' ');

/**
 * Starts looking for a computer before the workbench mounts: at launch, as soon as the catalog is
 * read and while the keychain is still being read (the search sends no token). The next
 * {@link resolveRoute} for the same computer takes its answer.
 */
export function startResolvingRoute(env: ISavedEnvironment): void {
	const result = findRoute(env);
	result.catch(() => undefined);
	early = { environmentId: env.environmentId, routes: routesKey(env), at: Date.now(), result };
}

/** {@link findRoute}, or the answer of the search {@link startResolvingRoute} started for it. */
export function resolveRoute(env: ISavedEnvironment): Promise<IResolvedRoute> {
	const started = early;
	early = undefined;
	if (started && started.environmentId === env.environmentId && started.routes === routesKey(env) && Date.now() - started.at < 10_000) {
		return started.result;
	}
	return findRoute(env);
}

/**
 * When the address the page is on stopped answering as this machine (the phone left the Wi-Fi),
 * the address that answers now; undefined while the page's own address still works or when
 * nothing answers (the computer is off or restarting: the page keeps retrying on its own).
 */
export async function movedRoute(env: ISavedEnvironment, baseUrl: string): Promise<IResolvedRoute | undefined> {
	const current = env.routes.find(route => route.baseUrl === baseUrl);
	const [stillThere, best] = await Promise.all([
		current ? probe(current, env.environmentId, 4_000) : Promise.resolve(undefined),
		findRoute(env).catch(() => undefined),
	]);
	return !stillThere && best && !sameOrigin(best.route.baseUrl, baseUrl) ? best : undefined;
}

export interface ISignInSource {
	readonly uri: string;
	readonly headers?: Record<string, string>;
}

/**
 * The page load that signs the WebView in. `attempt` makes every sign-in a new URL (a WebView
 * ignores a source it is already showing) and lets the navigation policy tell this load from
 * a redirect to the sign-in page. Servers with `shellSignIn` take the token as a header; older
 * ones get it in the fragment, which never reaches the network and which the sign-in page reads
 * and strips before it posts it to the session route.
 */
export function signInSource(baseUrl: string, token: string, descriptor: IShellDescriptor, attempt: number): ISignInSource {
	const next = encodeURIComponent(WORKBENCH_PATH);
	if (descriptor.capabilities.shellSignIn) {
		return { uri: `${baseUrl}${SESSION_PATH}?next=${next}&shell=${attempt}`, headers: { Authorization: `Bearer ${token}` } };
	}
	return { uri: `${baseUrl}/?next=${next}&shell=${attempt}#token=${encodeURIComponent(token)}` };
}

/** This attempt's own sign-in load (or a redirect it caused), not one the page started. */
export function isSignInAttempt(url: string, attempt: number): boolean {
	return new RegExp(`[?&]shell=${attempt}(&|#|$)`).test(url);
}

/** The path of an http(s) URL, without query or fragment. */
export function pathOf(url: string): string {
	const origin = originOf(url);
	if (!origin) {
		return '';
	}
	const rest = url.slice(url.indexOf('//') + 2);
	const slash = rest.search(/[/?#]/);
	if (slash < 0) {
		return '/';
	}
	const tail = rest.slice(slash);
	const path = tail.split(/[?#]/)[0];
	return path || '/';
}

/** The server's sign-in page: where a page that lost its session cookie is sent. */
export function isSignInPage(url: string): boolean {
	const path = pathOf(url);
	return path === '/' || path === '/pair' || path === '/index.html';
}

/** Whether the workbench's own session route answered for a URL (for HTTP errors). */
export function isSessionUrl(url: string): boolean {
	return pathOf(url) === SESSION_PATH;
}

/**
 * Checks the token with the session route the sign-in page itself posts to (also warming the
 * workbench server while the page loads). Resolves the HTTP status, or 0 when nothing answered.
 */
export async function checkToken(baseUrl: string, token: string): Promise<number> {
	try {
		const response = await fetchWithTimeout(`${baseUrl}${SESSION_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }, 8_000);
		return response.status;
	} catch {
		return 0;
	}
}

/** Signs the page's origin out (the session cookie), when a computer is forgotten. */
export function signOutScript(): string {
	return `fetch(${JSON.stringify(SESSION_PATH)}, { method: 'DELETE', credentials: 'same-origin' }).catch(function () {});true;`;
}
