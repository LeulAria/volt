/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { app, session, webContents, type AuthenticationResponseDetails, type AuthInfo, type Event as ElectronEvent, type OnBeforeRequestListenerDetails, type Session, type WebContents } from 'electron';
import { SandboxNetworkProxy } from '../../voltSandbox/node/sandboxProxy.js';
import { isSandboxBrowserPartition, ISandboxBrowserRules, sandboxBrowserProxyConfig, sandboxBrowserProxyLogin, sandboxBrowserRequestVerdict } from '../common/sandboxBrowser.js';

interface IPartitionState {
	readonly session: Session;
	rules: ISandboxBrowserRules | undefined;
	proxy: SandboxNetworkProxy | undefined;
	/** Serialises rule changes (the proxy starts asynchronously). */
	applying: Promise<void>;
}

/** Every sandboxed chat's browser session, so the app-wide proxy sign-in prompt leaves them alone. */
const sandboxSessions = new WeakSet<Session>();

/** Whether `target` is a sandboxed chat's browser session (its proxy sign-in is answered by {@link SandboxBrowserSessions}). */
export function isSandboxBrowserSession(target: Session | undefined): boolean {
	return !!target && sandboxSessions.has(target);
}

/**
 * The sandboxed chats' browser profiles in the main process (B-16; see `common/sandboxBrowser.ts`).
 * A profile is locked down the moment Volt first sees it (a `<webview>` about to attach with it,
 * or the window setting its rules): until its chat's rules arrive, every request is refused.
 *
 * Each profile's proxy has its own route token (B-31): a request without it gets a 407. Chromium
 * cannot carry credentials in a proxy rule, so it asks through the `login` event, which is
 * answered with that profile's token, only for that profile's own proxy, and only once per
 * challenge (a second ask means the token was refused: cancelled, never a dialog).
 */
export class SandboxBrowserSessions {

	private readonly partitions = new Map<string, IPartitionState>();
	/** Web contents (pages and their docked DevTools) by id, to the partition whose session they use. */
	private readonly owners = new Map<number, string>();
	private disposed = false;

	constructor(private readonly log: (message: string) => void) {
		app.on('web-contents-created', (_event, contents) => this.onWebContents(contents));
		app.on('login', (event, contents, details, authInfo, callback) => this.onLogin(event, contents, details, authInfo, callback));
	}

	private onLogin(event: ElectronEvent, contents: WebContents | null | undefined, details: AuthenticationResponseDetails & { firstAuthAttempt?: boolean }, authInfo: AuthInfo, callback: (username?: string, password?: string) => void): void {
		const partition = contents && !contents.isDestroyed() ? this.partitionOf(contents.session) : undefined;
		if (!partition || !authInfo.isProxy) {
			return;
		}
		event.preventDefault();
		const credentials = sandboxBrowserProxyLogin(this.partitions.get(partition)?.proxy, authInfo, details.firstAuthAttempt !== false);
		if (credentials) {
			callback(credentials.username, credentials.password);
		} else {
			this.log(`[volt-sandbox-browser] ${partition} refused a proxy sign-in for ${authInfo.host}:${authInfo.port}`);
			callback();
		}
	}

	/** A `<webview>` of a sandboxed partition is about to attach: lock its session first, and give it nothing extra. */
	private onWebContents(contents: WebContents): void {
		contents.on('will-attach-webview', (_event, webPreferences, params) => {
			const partition = (params as { partition?: string }).partition ?? webPreferences.partition;
			if (isSandboxBrowserPartition(partition)) {
				this.ensure(partition);
				delete webPreferences.preload;
				webPreferences.nodeIntegration = false;
				webPreferences.nodeIntegrationInSubFrames = false;
				webPreferences.contextIsolation = true;
				webPreferences.sandbox = true;
			}
		});
		const partition = this.partitionOf(contents.session);
		if (partition) {
			this.own(contents, partition);
		}
	}

	private partitionOf(target: Session): string | undefined {
		for (const [name, state] of this.partitions) {
			if (state.session === target) {
				return name;
			}
		}
		return undefined;
	}

	private own(contents: WebContents, partition: string): void {
		if (this.owners.get(contents.id) === partition) {
			return;
		}
		const id = contents.id;
		this.owners.set(id, partition);
		// The session keeps its rules and proxy: a moved tab's page restarts in new web contents.
		contents.once('destroyed', () => this.owners.delete(id));
	}

	/** The partition's session with every handler in place; deny-all until {@link setRules}. */
	private ensure(partition: string): IPartitionState {
		let state = this.partitions.get(partition);
		if (state) {
			return state;
		}
		const ses = session.fromPartition(partition);
		sandboxSessions.add(ses);
		state = { session: ses, rules: undefined, proxy: undefined, applying: Promise.resolve() };
		this.partitions.set(partition, state);
		ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !this.dispatch(partition, details) }));
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		// A sandboxed chat writes nothing outside its sandbox, Downloads included.
		ses.on('will-download', event => event.preventDefault());
		// Nothing reaches the network until the rules are set.
		void ses.setProxy(sandboxBrowserProxyConfig({ network: false, allowedDomains: [], listenPorts: [] }, undefined));
		// Pages already open with it (the window set rules after the page attached).
		for (const contents of webContents.getAllWebContents()) {
			if (!contents.isDestroyed() && contents.session === ses) {
				this.own(contents, partition);
			}
		}
		return state;
	}

	/**
	 * The one decision for every request of every sandboxed profile: the request is tied to its web
	 * contents, that to its chat's partition, and judged by that chat's rules. A request without a
	 * frame, from web contents Volt does not know, or of another partition is refused.
	 */
	private dispatch(partition: string, details: OnBeforeRequestListenerDetails): boolean {
		const owner = details.webContentsId !== undefined ? this.owners.get(details.webContentsId) : undefined;
		const rules = owner === partition ? this.partitions.get(partition)?.rules : undefined;
		// A navigation that changes process may not have its frame yet; the web contents still ties it
		// to the chat. Anything else without a frame (a service worker's fetch) is refused.
		const navigation = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
		const verdict = sandboxBrowserRequestVerdict(rules, { url: details.url, hasFrame: !!details.frame || navigation });
		if (!verdict.allow && !/^(data|about|devtools):/i.test(details.url)) {
			this.log(`[volt-sandbox-browser] ${partition} blocked ${details.method} ${redactUrl(details.url)}: ${verdict.reason}`);
		}
		return verdict.allow;
	}

	/** Sets a chat's browser rules (its sandbox's network part), starting or updating its proxy. */
	setRules(partition: string, rules: ISandboxBrowserRules): Promise<void> {
		if (!isSandboxBrowserPartition(partition) || this.disposed) {
			return Promise.reject(new Error(`${partition} is not a sandboxed chat's browser profile`));
		}
		const state = this.ensure(partition);
		const next = { network: !!rules.network, allowedDomains: [...rules.allowedDomains], listenPorts: rules.listenPorts.filter(port => Number.isInteger(port) && port > 0 && port < 65536) };
		state.applying = state.applying.catch(() => undefined).then(async () => {
			const narrower = !!state.rules && state.rules.allowedDomains.some(host => !next.allowedDomains.includes(host));
			if (next.network || narrower) {
				state.proxy?.dispose();
				state.proxy = undefined;
			}
			if (!next.network) {
				if (state.proxy) {
					state.proxy.allow(next.allowedDomains);
				} else {
					// Its own route token: no other process on this machine can use this chat's grants (B-31).
					state.proxy = await SandboxNetworkProxy.start(next.allowedDomains, (host, reason) => this.log(`[volt-sandbox-browser] ${partition} proxy refused ${host}: ${reason}`), { token: randomBytes(24).toString('base64url') });
				}
			}
			// The dispatcher's rules first: the proxy only ever narrows further.
			state.rules = next;
			await state.session.setProxy(sandboxBrowserProxyConfig(next, state.proxy?.port));
			await state.session.closeAllConnections();
		});
		return state.applying;
	}

	/** The web contents is a page (or docked DevTools) of a sandboxed chat's browser. */
	isSandboxPage(contents: WebContents): boolean {
		return this.partitionOf(contents.session) !== undefined;
	}

	dispose(): void {
		this.disposed = true;
		for (const state of this.partitions.values()) {
			state.proxy?.dispose();
		}
	}
}

function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname.length > 1 ? '/...' : '/'}`;
	} catch {
		return '(not a URL)';
	}
}
