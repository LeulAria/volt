/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AGENT_SERVER_PROTOCOL_VERSION, type IEnvironmentDescriptor, type IPairRequest, type IPairResponse, RemoteError, type RouteKind, type Role,
	VOLT_ENVIRONMENT_PATH, VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH
} from './protocol';

/** One address a saved machine answers at (its LAN IP, its Tailscale IP, loopback). */
export interface IRoute {
	/** `http://192.168.1.20:47321` */
	readonly baseUrl: string;
	readonly kind: RouteKind;
	readonly lastOkAt?: number;
}

/** A paired machine running Volt: where it is, and this device's key for it. */
export interface ISavedEnvironment {
	readonly environmentId: string;
	readonly label: string;
	readonly token: string;
	readonly deviceId: string;
	readonly role: Role;
	readonly routes: readonly IRoute[];
	readonly addedAt: number;
	readonly lastConnectedAt?: number;
	readonly platform?: { readonly os: string; readonly arch: string };
}

export interface IEnvironmentCatalog {
	readonly version: 1;
	readonly environments: readonly ISavedEnvironment[];
	readonly activeId?: string;
}

export const EMPTY_CATALOG: IEnvironmentCatalog = { version: 1, environments: [] };

/** What a scanned QR or typed address means. */
export type PairingTarget =
	| { readonly kind: 'code'; readonly baseUrl: string; readonly code: string }
	/** An owner token handed over directly (Volt's own "open in browser" link). */
	| { readonly kind: 'token'; readonly baseUrl: string; readonly token: string };

const ROUTE_RANK: Record<RouteKind, number> = { loopback: 0, lan: 1, tailnet: 2, public: 3 };

export function classifyHost(host: string): RouteKind {
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (bare === 'localhost' || bare === '::1' || bare.startsWith('127.')) {
		return 'loopback';
	}
	if (bare.endsWith('.ts.net')) {
		return 'tailnet';
	}
	if (bare.endsWith('.local') || bare.endsWith('.lan') || bare.endsWith('.home')) {
		return 'lan';
	}
	const parts = bare.split('.').map(Number);
	if (parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)) {
		const [a, b] = parts;
		if (a === 100 && b >= 64 && b <= 127) {
			return 'tailnet';
		}
		if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
			return 'lan';
		}
	}
	return 'public';
}

export function routeRank(kind: RouteKind): number {
	return ROUTE_RANK[kind];
}

export function routeLabel(kind: RouteKind): string {
	switch (kind) {
		case 'loopback': return 'This computer';
		case 'lan': return 'Local network';
		case 'tailnet': return 'Tailscale';
		case 'public': return 'Internet';
	}
}

/** `ABCD-EFGH` as typed or read: only letters and digits count. */
export function normalizeCode(code: string): string {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatCode(code: string): string {
	const clean = normalizeCode(code);
	return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * `192.168.1.20:47321` → `http://192.168.1.20:47321`. IP literals and `.local` names are plain HTTP
 * (a LAN server has no certificate); other host names are HTTPS (Tailscale Serve, a tunnel).
 */
export function normalizeBaseUrl(input: string): string | undefined {
	let text = input.trim();
	if (!text) {
		return undefined;
	}
	if (!/^[a-z]+:\/\//i.test(text)) {
		const host = text.split(/[/:]/)[0] ?? '';
		const kind = classifyHost(host);
		const secure = kind === 'public' || (kind === 'tailnet' && host.endsWith('.ts.net'));
		text = `${secure ? 'https' : 'http'}://${text}`;
	}
	try {
		const url = new URL(text);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return undefined;
		}
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

/**
 * Reads what a QR code or a pasted link holds:
 * - `http://host:port/pair#code=ABCD2345` (the server's pairing link)
 * - `volt://pair?url=<pairing link>` (the deep link form)
 * - `http://host:port/#token=<token>` (Volt's own browser link)
 */
export function parsePairingLink(text: string): PairingTarget | undefined {
	const raw = text.trim();
	if (!raw) {
		return undefined;
	}
	try {
		const deep = new URL(raw);
		if (deep.protocol === 'volt:' || deep.protocol === 'volt-mobile:') {
			const inner = deep.searchParams.get('url');
			return inner ? parsePairingLink(inner) : undefined;
		}
		if (deep.protocol !== 'http:' && deep.protocol !== 'https:') {
			return undefined;
		}
		const baseUrl = `${deep.protocol}//${deep.host}`;
		const fragment = new URLSearchParams(deep.hash.replace(/^#/, ''));
		const code = fragment.get('code') ?? deep.searchParams.get('code');
		if (code && normalizeCode(code).length >= 6) {
			return { kind: 'code', baseUrl, code: normalizeCode(code) };
		}
		const token = fragment.get('token');
		if (token) {
			return { kind: 'token', baseUrl, token };
		}
	} catch {
		// not a URL
	}
	return undefined;
}

export function wsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}

//#region HTTP

interface IFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<IFetchResponse>;

function fetchImpl(): FetchLike {
	const f = (globalThis as unknown as { fetch?: FetchLike }).fetch;
	if (!f) {
		throw new Error('fetch is not available.');
	}
	return f;
}

async function request<T>(url: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8_000);
	try {
		const res = await fetchImpl()(url, {
			method: init.method ?? 'GET',
			headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : {},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			signal: controller.signal,
		});
		const body = await res.json().catch(() => undefined) as { error?: string; message?: string } | undefined;
		if (!res.ok) {
			throw new RemoteError(body?.error ?? `http_${res.status}`, body?.message ?? `Volt answered ${res.status}.`);
		}
		return body as T;
	} catch (err) {
		if (err instanceof RemoteError) {
			throw err;
		}
		if ((err as { name?: string }).name === 'AbortError') {
			throw new RemoteError('Timeout', 'No answer. Check that this device is on the same network as your computer and that Volt is open.');
		}
		throw new RemoteError('Unreachable', 'Can\'t reach that address. Check the address and that both devices are on the same network.');
	} finally {
		clearTimeout(timer);
	}
}

/** Asks an address which machine it is (no token is sent). */
export async function probeEnvironment(baseUrl: string, timeoutMs = 4_000): Promise<IEnvironmentDescriptor> {
	const descriptor = await request<IEnvironmentDescriptor>(`${baseUrl}${VOLT_ENVIRONMENT_PATH}`, { timeoutMs });
	if (!descriptor || typeof descriptor.environmentId !== 'string') {
		throw new RemoteError('NotVolt', 'That address is not a Volt agent server.');
	}
	if (descriptor.protocol !== AGENT_SERVER_PROTOCOL_VERSION) {
		throw new RemoteError('ProtocolMismatch', descriptor.protocol > AGENT_SERVER_PROTOCOL_VERSION
			? 'Volt on your computer is newer than this app. Update the app.'
			: 'Volt on your computer is older than this app. Update Volt.');
	}
	return descriptor;
}

export async function exchangePairingCode(baseUrl: string, code: string, client: IPairRequest['client']): Promise<IPairResponse> {
	const body: IPairRequest = { code: normalizeCode(code), client };
	return request<IPairResponse>(`${baseUrl}${VOLT_PAIR_PATH}`, { method: 'POST', body, timeoutMs: 10_000 });
}

/** The browser on the machine Volt runs on signs itself in (loopback only). */
export async function requestLocalSession(baseUrl: string): Promise<IPairResponse> {
	return request<IPairResponse>(`${baseUrl}${VOLT_LOCAL_SESSION_PATH}`, { method: 'POST', body: {}, timeoutMs: 6_000 });
}

/**
 * Pairs with a machine: checks what it is, spends the code, and returns the environment to save.
 * Pairing the same machine again (over Tailscale after the LAN) adds a route to the saved entry.
 */
export async function pairEnvironment(target: PairingTarget, client: IPairRequest['client'], existing?: readonly ISavedEnvironment[]): Promise<ISavedEnvironment> {
	const descriptor = await probeEnvironment(target.baseUrl);
	const route: IRoute = { baseUrl: target.baseUrl, kind: classifyHost(new URL(target.baseUrl).hostname), lastOkAt: Date.now() };
	const known = existing?.find(env => env.environmentId === descriptor.environmentId);
	if (target.kind === 'token') {
		return {
			environmentId: descriptor.environmentId,
			label: descriptor.label,
			token: target.token,
			deviceId: known?.deviceId ?? 'owner',
			role: 'owner',
			routes: mergeRoutes(known?.routes ?? [], [route]),
			addedAt: known?.addedAt ?? Date.now(),
			platform: descriptor.platform,
		};
	}
	const paired = await exchangePairingCode(target.baseUrl, target.code, client);
	if (paired.environmentId !== descriptor.environmentId) {
		throw new RemoteError('Mismatch', 'The address changed machines while pairing. Try again.');
	}
	return {
		environmentId: paired.environmentId,
		label: descriptor.label,
		token: paired.token,
		deviceId: paired.deviceId,
		role: paired.role,
		routes: mergeRoutes(known?.routes ?? [], [route]),
		addedAt: known?.addedAt ?? Date.now(),
		platform: descriptor.platform,
	};
}

export function mergeRoutes(current: readonly IRoute[], added: readonly IRoute[]): IRoute[] {
	const byUrl = new Map(current.map(route => [route.baseUrl, route]));
	for (const route of added) {
		byUrl.set(route.baseUrl, { ...byUrl.get(route.baseUrl), ...route });
	}
	return [...byUrl.values()].sort((a, b) => routeRank(a.kind) - routeRank(b.kind));
}

/**
 * The best route that answers as this machine right now: every route is probed at once (no
 * token is sent), and only one that answers with the saved environment id is used, best kind
 * first. Throws when none answers.
 */
export async function chooseRoute(env: ISavedEnvironment, timeoutMs = 2_500): Promise<IRoute> {
	if (env.routes.length === 1) {
		return env.routes[0];
	}
	const results = await Promise.all(env.routes.map(async route => {
		try {
			const descriptor = await probeEnvironment(route.baseUrl, timeoutMs);
			return descriptor.environmentId === env.environmentId ? route : undefined;
		} catch {
			return undefined;
		}
	}));
	const answering = results.filter((route): route is IRoute => !!route).sort((a, b) => routeRank(a.kind) - routeRank(b.kind));
	if (!answering.length) {
		throw new RemoteError('Unreachable', `Can't reach ${env.label}. Make sure Volt is open and this device is on the same network.`);
	}
	return answering[0];
}

//#endregion

//#region Catalog

export function upsertEnvironment(catalog: IEnvironmentCatalog, env: ISavedEnvironment, activate = true): IEnvironmentCatalog {
	const others = catalog.environments.filter(e => e.environmentId !== env.environmentId);
	return { version: 1, environments: [...others, env], activeId: activate ? env.environmentId : catalog.activeId };
}

export function removeEnvironment(catalog: IEnvironmentCatalog, environmentId: string): IEnvironmentCatalog {
	const environments = catalog.environments.filter(e => e.environmentId !== environmentId);
	const activeId = catalog.activeId === environmentId ? environments[0]?.environmentId : catalog.activeId;
	return { version: 1, environments, ...(activeId ? { activeId } : {}) };
}

export function activeEnvironment(catalog: IEnvironmentCatalog): ISavedEnvironment | undefined {
	return catalog.environments.find(e => e.environmentId === catalog.activeId) ?? catalog.environments[0];
}

export function parseCatalog(json: string | null | undefined): IEnvironmentCatalog {
	if (!json) {
		return EMPTY_CATALOG;
	}
	try {
		const value = JSON.parse(json) as Partial<IEnvironmentCatalog>;
		if (value.version === 1 && Array.isArray(value.environments)) {
			return {
				version: 1,
				environments: value.environments.filter(e => e && typeof e.environmentId === 'string' && typeof e.token === 'string' && Array.isArray(e.routes)),
				...(typeof value.activeId === 'string' ? { activeId: value.activeId } : {}),
			};
		}
	} catch {
		// a corrupt catalog starts over
	}
	return EMPTY_CATALOG;
}

//#endregion
