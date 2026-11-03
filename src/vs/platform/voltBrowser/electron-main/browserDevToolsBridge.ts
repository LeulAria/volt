/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo, Socket } from 'net';
import type { WebContents } from 'electron';
import { acceptWebSocket, NodeWebSocket } from '../../voltAgentServer/node/webSocket.js';

/** The DevTools frontend Chromium ships, opened in hosted mode on a WebSocket (`ws=`). */
const FRONTEND_URL = 'devtools://devtools/bundled/devtools_app.html';
/** A frontend that never connects lets its address go after this long. */
const UNUSED_ADDRESS_MS = 60_000;
/** Inspect Element waits this long for DevTools that are still opening. */
const INSPECT_WAIT_MS = 15_000;

/**
 * DevTools for an in-app browser page, drawn inside another view (the tab's DevTools pane) instead of
 * a window of their own. Electron's `setDevToolsWebContents` leaves an outside view without the
 * embedder bindings (the frontend comes up in hosted mode, talking to nothing), so the frontend is
 * loaded in hosted mode on purpose and pointed at a loopback WebSocket that relays the DevTools
 * protocol to the page's `webContents.debugger`. Each address is random and works once.
 */
export class BrowserDevToolsBridge {

	private listening: Promise<number> | undefined;
	private server: Server | undefined;
	private readonly addresses = new Map<string, WebContents>();
	private readonly sockets = new Set<NodeWebSocket>();
	/** The connected frontend per page, and who waits for one to connect. */
	private readonly live = new Map<number, NodeWebSocket>();
	private readonly waiters = new Map<number, Array<(ws: NodeWebSocket) => void>>();

	constructor(
		private readonly log: (message: string, error?: unknown) => void,
		/** Whether the page's debugger may be let go once DevTools close (Volt's own emulation may still use it). */
		private readonly mayDetach: (page: WebContents) => boolean,
	) { }

	/** Loads DevTools for `page` into `host`. */
	async open(page: WebContents, host: WebContents): Promise<void> {
		const port = await this.listen();
		const token = randomBytes(16).toString('hex');
		this.addresses.set(token, page);
		(setTimeout(() => this.addresses.delete(token), UNUSED_ADDRESS_MS) as unknown as { unref?(): void }).unref?.();
		await host.loadURL(`${FRONTEND_URL}?ws=127.0.0.1:${port}/devtools/${token}`);
	}

	/**
	 * Inspect Element: selects the node at (x, y), in the page's CSS pixels, in the page's docked DevTools,
	 * as Chrome's own Inspect does (`Overlay.inspectNodeRequested`). Waits for DevTools that are still opening.
	 */
	async inspect(page: WebContents, x: number, y: number): Promise<boolean> {
		const ws = await this.connection(page.id, INSPECT_WAIT_MS);
		if (!ws) {
			return false;
		}
		// DevTools turn the DOM domain on a moment after they connect.
		for (let attempt = 0; attempt < 20 && !ws.isClosed && !page.isDestroyed(); attempt++) {
			try {
				const node = await page.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }) as { backendNodeId?: number };
				if (node?.backendNodeId) {
					ws.send(JSON.stringify({ method: 'Overlay.inspectNodeRequested', params: { backendNodeId: node.backendNodeId } }));
					return true;
				}
			} catch {
				// Not ready yet.
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		return false;
	}

	private connection(pageId: number, waitMs: number): Promise<NodeWebSocket | undefined> {
		const ws = this.live.get(pageId);
		if (ws) {
			return Promise.resolve(ws);
		}
		return new Promise(resolve => {
			const list = this.waiters.get(pageId) ?? [];
			const done = (value: NodeWebSocket | undefined) => {
				clearTimeout(timer);
				const index = list.indexOf(done);
				if (index >= 0) {
					list.splice(index, 1);
				}
				resolve(value);
			};
			const timer = setTimeout(() => done(undefined), waitMs);
			list.push(done);
			this.waiters.set(pageId, list);
		});
	}

	dispose(): void {
		for (const socket of this.sockets) {
			socket.close(1001, 'closing');
		}
		this.server?.close();
	}

	private listen(): Promise<number> {
		this.listening ??= new Promise<number>((resolve, reject) => {
			const server = createServer((_req, res) => {
				res.writeHead(404);
				res.end();
			});
			server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as Socket));
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
			this.server = server;
		});
		return this.listening;
	}

	private onUpgrade(req: IncomingMessage, socket: Socket): void {
		const token = /^\/devtools\/([0-9a-f]{32})$/.exec(req.url ?? '')?.[1];
		const page = token ? this.addresses.get(token) : undefined;
		// Only the DevTools frontend may connect (a page in the browser could reach a loopback port too).
		const origin = req.headers.origin;
		if (!token || !page || page.isDestroyed() || (origin !== undefined && origin !== 'devtools://devtools')) {
			socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			return;
		}
		this.addresses.delete(token);
		const ws = acceptWebSocket(req, socket, { pingIntervalMs: 0 });
		if (ws) {
			this.relay(ws, page);
		}
	}

	private relay(ws: NodeWebSocket, page: WebContents): void {
		const protocol = page.debugger;
		let attachedHere = false;
		try {
			if (!protocol.isAttached()) {
				protocol.attach('1.3');
				attachedHere = true;
			}
		} catch (err) {
			this.log('[volt] browser DevTools could not attach to the page', err);
			ws.close(1011, 'attach failed');
			return;
		}
		this.sockets.add(ws);
		const pageId = page.id;
		this.live.set(pageId, ws);
		for (const waiter of [...this.waiters.get(pageId) ?? []]) {
			waiter(ws);
		}
		const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
			ws.send(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }));
		};
		const onDetach = () => ws.close(1000, 'detached');
		const onDestroyed = () => ws.close(1000, 'page closed');
		protocol.on('message', onMessage);
		protocol.on('detach', onDetach);
		page.once('destroyed', onDestroyed);
		ws.onMessage(text => {
			let message: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
			try {
				message = JSON.parse(text);
			} catch {
				return;
			}
			const { id, method, params } = message;
			const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
			if (typeof id !== 'number' || typeof method !== 'string' || page.isDestroyed()) {
				return;
			}
			const reply = (body: object) => ws.send(JSON.stringify(sessionId ? { id, ...body, sessionId } : { id, ...body }));
			protocol.sendCommand(method, params as object | undefined, sessionId).then(
				result => reply({ result: result ?? {} }),
				err => reply({ error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
			);
		});
		ws.onClose(() => {
			this.sockets.delete(ws);
			if (this.live.get(pageId) === ws) {
				this.live.delete(pageId);
			}
			protocol.removeListener('message', onMessage);
			protocol.removeListener('detach', onDetach);
			page.removeListener('destroyed', onDestroyed);
			if (attachedHere && !page.isDestroyed() && protocol.isAttached() && this.mayDetach(page)) {
				try {
					protocol.detach();
				} catch {
					// Already gone.
				}
			}
		});
	}
}
