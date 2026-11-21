/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IPinnedTransport, type IWebSocketLike, isPin, setPinnedTransport } from '@volt/client-core';
import type { EventSubscription } from 'expo-modules-core';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Volt's agent server answers devices on the network over TLS with its own self-signed
 * certificate, whose SHA-256 the phone learns from the pairing QR (`fp=`). React Native's fetch
 * and WebSocket trust only certificate authorities, so requests and sockets to such an address
 * go through this native module (URLSession on iOS, OkHttp on Android): a connection opens only
 * when the server's leaf certificate hashes to the pin, and is refused otherwise. The same pin is
 * handed to the app's WebViews for that address (react-native-webview, patched), so a page from
 * the server loads only from the paired certificate too.
 */

interface ISocketEvent {
	readonly id: string;
	readonly type: 'open' | 'message' | 'close' | 'error';
	readonly data?: string;
	readonly code?: number | string;
	readonly reason?: string;
	readonly message?: string;
}

interface IVoltPinnedTlsModule {
	fetch(id: string, url: string, pin: string, options: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; body: string }>;
	cancel(id: string): void;
	openSocket(id: string, url: string, pin: string): void;
	send(id: string, text: string): void;
	closeSocket(id: string, code: number, reason: string): void;
	setWebViewPins(pins: Record<string, string>): boolean;
	addListener(event: 'onSocket', listener: (event: ISocketEvent) => void): EventSubscription;
}

const native = requireOptionalNativeModule<IVoltPinnedTlsModule>('VoltPinnedTls');

/** Requests without a reply in this long are given up natively (the caller usually aborts first). */
const DEFAULT_TIMEOUT_MS = 30_000;

let lastId = 0;
const nextId = () => `${Date.now().toString(36)}-${++lastId}`;

/** `https://[::1]:8443/x` → `::1:8443`: how the WebViews' pin registry names an address. */
export function pinnedAddress(url: string): string | undefined {
	const match = /^(?:https|wss):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(url);
	if (!match) {
		return undefined;
	}
	return `${match[1].replace(/^\[|\]$/g, '').toLowerCase()}:${match[2] ?? '443'}`;
}

//#region WebViews

const webViewPins = new Map<string, string>();

/**
 * Pages from `url`'s address load in WebViews only with `pin`'s certificate. Every pinned request
 * or socket that got through registers its address, so a page from the server the app is
 * connected to loads in a WebView exactly when the app's own connection to it does.
 */
export function trustInWebViews(url: string, pin: string): void {
	const address = pinnedAddress(url);
	if (!native || !address || webViewPins.get(address) === pin) {
		return;
	}
	webViewPins.set(address, pin);
	if (!native.setWebViewPins(Object.fromEntries(webViewPins))) {
		// The WebView library isn't the patched one: its pages from this address fail as untrusted.
		console.warn('[volt] WebViews in this build cannot check certificate pins; pages from the server will not load.');
	}
}

//#endregion

//#region HTTP

function codedError(code: string, message: string, name = 'Error'): Error {
	const error = new Error(message) as Error & { code: string };
	error.name = name;
	error.code = code;
	return error;
}

async function pinnedFetch(url: string, pin: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) {
	if (!native) {
		throw codedError('PinUnsupported', 'This build has no pinned transport.');
	}
	if (init.signal?.aborted) {
		throw codedError('Aborted', 'The request was cancelled.', 'AbortError');
	}
	const id = nextId();
	const onAbort = () => native.cancel(id);
	init.signal?.addEventListener('abort', onAbort);
	try {
		const { status, body } = await native.fetch(id, url, pin, {
			method: init.method,
			headers: init.headers,
			...(init.body !== undefined ? { body: init.body } : {}),
			timeoutMs: DEFAULT_TIMEOUT_MS,
		});
		trustInWebViews(url, pin);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => JSON.parse(body) as unknown,
		};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ERR_PIN_MISMATCH') {
			throw codedError('PinMismatch', (err as Error).message);
		}
		if (code === 'ERR_ABORTED') {
			throw codedError('Aborted', 'The request was cancelled.', 'AbortError');
		}
		throw err;
	} finally {
		init.signal?.removeEventListener('abort', onAbort);
	}
}

//#endregion

//#region WebSocket

const sockets = new Map<string, PinnedSocket>();
let subscription: EventSubscription | undefined;

function listen(module: IVoltPinnedTlsModule): void {
	subscription ??= module.addListener('onSocket', event => sockets.get(event.id)?.receive(event));
}

/** A WebSocket (the browser's interface, text frames) over a pinned connection. */
class PinnedSocket implements IWebSocketLike {
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
	onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	private readonly id = nextId();

	constructor(private readonly module: IVoltPinnedTlsModule, private readonly url: string, private readonly pin: string) {
		listen(module);
		sockets.set(this.id, this);
		try {
			module.openSocket(this.id, url, pin);
		} catch (err) {
			sockets.delete(this.id);
			throw err;
		}
	}

	send(data: string): void {
		if (this.readyState !== 1) {
			throw new Error('The socket is not open.');
		}
		this.module.send(this.id, data);
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState >= 2) {
			return;
		}
		this.readyState = 2;
		this.module.closeSocket(this.id, code, reason);
	}

	receive(event: ISocketEvent): void {
		switch (event.type) {
			case 'open':
				if (this.readyState === 0) {
					this.readyState = 1;
					trustInWebViews(this.url, this.pin);
					this.onopen?.({});
				}
				return;
			case 'message':
				this.onmessage?.({ data: event.data ?? '' });
				return;
			case 'error':
				this.onerror?.({ code: event.code === 'ERR_PIN_MISMATCH' ? 'PinMismatch' : event.code, message: event.message });
				return;
			case 'close':
				this.readyState = 3;
				sockets.delete(this.id);
				this.onclose?.({ code: typeof event.code === 'number' ? event.code : 1006, reason: event.reason ?? '' });
				return;
		}
	}
}

//#endregion

/** Whether this build can talk to a pinned address (false on the web build). */
export const hasNativePinnedTransport = !!native;

/**
 * Registers the native transport with client-core, which sends every request and socket for a
 * route with a pin through it. Without it (the web build) such routes are refused, never tried
 * unpinned.
 */
export function installPinnedTransport(): void {
	if (!native) {
		return;
	}
	const transport: IPinnedTransport = {
		fetch: (url, pin, init) => pinnedFetch(url, pin, init),
		createSocket: (url, pin) => {
			if (!isPin(pin)) {
				throw codedError('PinUnsupported', 'That is not a certificate pin.');
			}
			return new PinnedSocket(native, url, pin);
		},
	};
	setPinnedTransport(transport);
}
