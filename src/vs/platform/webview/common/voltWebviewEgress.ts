/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Network egress of sandboxed extensions' webviews, judged in Electron main (spec I.10, INV-19).
 * Webviews are frames of a workbench window, so their requests share the window's session; the
 * one `webRequest.onBeforeRequest` dispatcher of that session ties each request to its webview by
 * the frame it came from (a `vscode-webview://<origin>` ancestor) and asks this registry. Pure, so
 * the decisions are tested without Electron.
 */

const WEBVIEW_SCHEME = 'vscode-webview:';
const WORKBENCH_SCHEME = 'vscode-file:';
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

export interface IWebviewEgressRequest {
	readonly url: string;
	/** The URL of the request's frame and of each ancestor, innermost first; undefined: the request has no frame. */
	readonly frames: readonly string[] | undefined;
	readonly referrer?: string;
}

export type WebviewEgressVerdict =
	| { readonly allow: true }
	| { readonly allow: false; readonly reason: string; readonly origin?: string };

const ALLOW: WebviewEgressVerdict = { allow: true };

function protocolOf(url: string): string | undefined {
	const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
	return match?.[1].toLowerCase();
}

function webviewOriginOf(url: string | undefined): string | undefined {
	if (!url || protocolOf(url) !== WEBVIEW_SCHEME) {
		return undefined;
	}
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

function defaultPort(protocol: string): string {
	return protocol === 'https:' || protocol === 'wss:' ? '443' : '80';
}

/**
 * The URL's host is one of the granted `net.connect` targets: `api.example.com`,
 * `*.example.com` (subdomains only), `example.com:8443` (that port; without one, any port), `*`.
 */
export function isEgressHostGranted(url: string, hosts: readonly string[]): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const port = parsed.port || defaultPort(parsed.protocol);
	return hosts.some(pattern => {
		if (pattern === '*') {
			return true;
		}
		const match = /^(.*?)(?::(\d{1,5}))?$/.exec(pattern.toLowerCase());
		const name = match?.[1] ?? '';
		if (match?.[2] && match[2] !== port) {
			return false;
		}
		return name.startsWith('*.') ? host.endsWith(name.slice(1)) && host.length > name.length - 1 : host === name;
	});
}

/**
 * The sandboxed webviews shown anywhere, by their encoded `vscode-webview` origin (one per
 * extension and view type, the same in every window), with the hosts each may reach. A webview
 * that isn't listed is not judged here (its owner isn't sandboxed); its CSP floor still applies.
 */
export class WebviewEgressRegistry {

	/** Encoded origin to the webview instances showing it (by webview id), their window and hosts. */
	private readonly byOrigin = new Map<string, Map<string, { readonly windowId: number; readonly hosts: readonly string[] }>>();

	/** Sets the hosts the webview `webviewId` of window `windowId`, at `encodedOrigin`, may reach (replacing an earlier registration). */
	set(windowId: number, webviewId: string, encodedOrigin: string, hosts: readonly string[]): void {
		this.delete(webviewId);
		let instances = this.byOrigin.get(encodedOrigin);
		if (!instances) {
			instances = new Map();
			this.byOrigin.set(encodedOrigin, instances);
		}
		instances.set(webviewId, { windowId, hosts: [...hosts] });
	}

	/** Removes the webview's registration, wherever it was (a webview that moved has a new origin). */
	delete(webviewId: string): void {
		this.deleteWhere(id => id === webviewId);
	}

	/** The window closed or reloaded: its webviews went without unregistering. */
	deleteWindow(windowId: number): void {
		this.deleteWhere((_id, owner) => owner === windowId);
	}

	private deleteWhere(matches: (webviewId: string, windowId: number) => boolean): void {
		for (const [origin, instances] of this.byOrigin) {
			for (const [id, entry] of instances) {
				if (matches(id, entry.windowId)) {
					instances.delete(id);
				}
			}
			if (instances.size === 0) {
				this.byOrigin.delete(origin);
			}
		}
	}

	get hasSandboxedWebviews(): boolean {
		return this.byOrigin.size > 0;
	}

	/**
	 * One request of a window's session (`webContentsId` undefined: Electron main's own request,
	 * not judged). Only network requests (`http`, `https`, `ws`, `wss`) are judged, and only while a
	 * sandboxed webview is shown:
	 * - from a frame inside a sandboxed webview: allowed only to its granted hosts;
	 * - from any other frame (the workbench, an unsandboxed webview): allowed;
	 * - without a frame (a worker, a request whose frame is gone): tied to a webview by its
	 *   referrer; from the workbench (`vscode-file:`) allowed; anything else refused, because it
	 *   can't be told apart from a sandboxed webview's worker.
	 */
	verdict(webContentsId: number | undefined, request: IWebviewEgressRequest): WebviewEgressVerdict {
		const protocol = protocolOf(request.url);
		if (!protocol || !NETWORK_SCHEMES.has(protocol) || webContentsId === undefined || !this.hasSandboxedWebviews) {
			return ALLOW;
		}
		let origin: string | undefined;
		if (request.frames) {
			for (const frame of request.frames) {
				origin = webviewOriginOf(frame);
				if (origin) {
					break;
				}
			}
			if (!origin) {
				return ALLOW;
			}
		} else {
			// A worker started from a blob of the page has `blob:vscode-webview://...` as its referrer.
			const referrer = request.referrer?.replace(/^blob:/i, '');
			origin = webviewOriginOf(referrer);
			if (!origin) {
				return referrer && protocolOf(referrer) === WORKBENCH_SCHEME
					? ALLOW
					: { allow: false, reason: 'a request without a frame while a sandboxed extension\'s webview is shown' };
			}
		}
		const instances = this.byOrigin.get(origin);
		if (!instances) {
			return ALLOW;
		}
		// Instances of one origin share their owner; while a change reaches them one by one, a
		// host counts only when every instance grants it.
		return [...instances.values()].every(entry => isEgressHostGranted(request.url, entry.hosts))
			? ALLOW
			: { allow: false, origin, reason: 'the host is not one the sandboxed extension declared with net.connect' };
	}
}
