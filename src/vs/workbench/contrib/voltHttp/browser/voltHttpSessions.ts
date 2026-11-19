/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltHttpStreamEvent, IVoltHttpStreamMessage, IVoltHttpStreams } from '../../../../platform/voltHttp/common/voltHttpStreams.js';
import { IHttpRequest } from '../common/httpCollection.js';
import { HttpProtocol } from '../common/httpProtocols.js';
import { IHttpSendContext, IHttpStreamPlan, IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpStreamEntry, IVoltHttpService } from './voltHttpService.js';

export const IVoltHttpSessions = createDecorator<IVoltHttpSessions>('voltHttpSessions');

const MAX_ENTRIES = 5000;

export interface IHttpLiveEntry extends IHttpStreamEntry {
	readonly seq: number;
}

/** A request's connection as its tab shows it: kept while the tab is open, whichever tab is in front. */
export interface IHttpLiveSession {
	readonly key: string;
	readonly protocol: HttpProtocol;
	status: 'connecting' | 'open' | 'closed';
	url: string;
	readonly entries: IHttpLiveEntry[];
	readonly startedAt: number;
	openedAt?: number;
	closedAt?: number;
	/** Why it failed, when it did. */
	error?: string;
	/** The handshake's status and headers. */
	handshakeStatus?: number;
	handshakeHeaders?: Readonly<Record<string, string>>;
	/** Messages in and out. */
	received: number;
	sent: number;
	/** Entries dropped from the front once the timeline grew past its cap. */
	dropped: number;
}

export interface IVoltHttpSessions {
	readonly _serviceBrand: undefined;
	/** A session changed (its key): a message, its status. */
	readonly onDidChange: Event<string>;
	sessionOf(key: string): IHttpLiveSession | undefined;
	/** Connects `request` as the session of `key` (replacing an earlier one). The session shows what happens, failures included. */
	connect(key: string, request: IHttpRequest, context: IHttpSendContext): Promise<IHttpLiveSession>;
	/** Sends on the open session; `{{variables}}` in it are filled in as the request's were. */
	send(key: string, message: IVoltHttpStreamMessage): Promise<void>;
	disconnect(key: string): void;
	/** Empties the timeline, keeping the connection. */
	clear(key: string): void;
	/** Closes and forgets the session (its tab closed). */
	drop(key: string): void;
}

interface ILive {
	readonly session: IHttpLiveSession;
	readonly id: string;
	plan?: IHttpStreamPlan;
	seq: number;
	request: IHttpRequest;
	context: IHttpSendContext;
}

/**
 * The live connections of the Volt Client's open tabs (WebSocket, SSE, Socket.IO, MQTT, gRPC). The
 * connections themselves are held by `IVoltHttpStreams` (the main process in the desktop app); this
 * keeps each one's timeline so a tab shows it again after another was in front, and writes a
 * finished session into the project's history.
 */
export class VoltHttpSessions extends Disposable implements IVoltHttpSessions {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly byKey = new Map<string, ILive>();
	private readonly byId = new Map<string, ILive>();

	constructor(
		@IVoltHttpStreams private readonly streams: IVoltHttpStreams,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
	) {
		super();
		this._register(streams.onDidStreamEvent(event => this.onEvent(event)));
	}

	sessionOf(key: string): IHttpLiveSession | undefined {
		return this.byKey.get(key)?.session;
	}

	private push(live: ILive, entry: IHttpStreamEntry): void {
		const entries = live.session.entries;
		entries.push({ ...entry, seq: live.seq++ });
		if (entries.length > MAX_ENTRIES) {
			const cut = entries.length - MAX_ENTRIES;
			entries.splice(0, cut);
			live.session.dropped += cut;
		}
	}

	async connect(key: string, request: IHttpRequest, context: IHttpSendContext): Promise<IHttpLiveSession> {
		this.end(key);
		const session: IHttpLiveSession = { key, protocol: request.protocol ?? 'ws', status: 'connecting', url: request.url, entries: [], startedAt: Date.now(), received: 0, sent: 0, dropped: 0 };
		const live: ILive = { session, id: generateUuid(), seq: 0, request, context };
		this.byKey.set(key, live);
		this.byId.set(live.id, live);
		this._onDidChange.fire(key);
		const fail = (message: string) => {
			if (session.status !== 'closed') {
				session.status = 'closed';
				session.closedAt = Date.now();
				session.error = message;
				this.push(live, { at: Date.now(), direction: 'error', data: message });
				this.byId.delete(live.id);
				this._onDidChange.fire(key);
			}
		};
		try {
			live.plan = await this.collections.streamPlan(request, context);
			if (this.byKey.get(key) !== live || session.status === 'closed') {
				return session;
			}
			session.url = live.plan.spec.url;
			await this.streams.open(live.id, live.plan.spec);
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
		return session;
	}

	private onEvent(event: IVoltHttpStreamEvent): void {
		const live = this.byId.get(event.id);
		if (!live) {
			return;
		}
		const session = live.session;
		switch (event.type) {
			case 'open':
				session.status = 'open';
				session.openedAt ??= event.at;
				session.handshakeStatus = event.status;
				session.handshakeHeaders = event.headers;
				this.push(live, { at: event.at, direction: 'info', data: event.text ?? 'Connected' });
				// The request's own messages go out first, in order.
				for (const message of live.plan?.messages ?? []) {
					void this.streams.send(live.id, message).catch(err => {
						this.push(live, { at: Date.now(), direction: 'error', data: err instanceof Error ? err.message : String(err) });
						this._onDidChange.fire(session.key);
					});
				}
				break;
			case 'message':
			case 'sent':
				if (event.type === 'message') {
					session.received++;
				} else {
					session.sent++;
				}
				this.push(live, { at: event.at, direction: event.type === 'message' ? 'in' : 'out', data: event.data ?? '', ...(event.target ? { target: event.target } : {}), ...(event.binary ? { binary: true } : {}), ...(event.size !== undefined ? { size: event.size } : {}) });
				break;
			case 'info':
				if (session.protocol === 'grpc' && session.status === 'connecting') {
					// A call is open once its stream starts: the response headers may wait for the first answer.
					session.status = 'open';
					session.openedAt = event.at;
				}
				this.push(live, { at: event.at, direction: 'info', data: event.text ?? event.data ?? '' });
				break;
			case 'error':
				session.error = event.text ?? event.data ?? 'The connection failed.';
				this.push(live, { at: event.at, direction: 'error', data: session.error });
				break;
			case 'close': {
				session.status = 'closed';
				session.closedAt = event.at;
				const why = [event.code !== undefined ? String(event.code) : '', event.text ?? ''].filter(Boolean).join(' ');
				this.push(live, { at: event.at, direction: 'info', data: why ? `Disconnected (${why})` : 'Disconnected' });
				this.byId.delete(event.id);
				this.record(live);
				break;
			}
		}
		this._onDidChange.fire(session.key);
	}

	/** A finished session in the history, as an exchange whose body is its messages. */
	private record(live: ILive): void {
		const session = live.session;
		if (!session.openedAt) {
			return;
		}
		const messages = session.entries.filter(entry => entry.direction === 'in' || entry.direction === 'out');
		const body = JSON.stringify(messages.slice(-200).map(entry => ({ direction: entry.direction, ...(entry.target ? { target: entry.target } : {}), data: entry.data })), null, 2);
		this.http.record({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			at: session.startedAt,
			...(live.request.name ? { name: live.request.name } : {}),
			method: live.request.method,
			protocol: session.protocol,
			url: session.url,
			headers: Object.entries(live.plan?.spec.headers ?? {}),
			...(live.context.root ? { root: live.context.root.toString() } : {}),
			...(live.context.collection ? { request: { collection: live.context.collection.toString(), id: live.request.id } } : {}),
			response: { status: session.handshakeStatus ?? 200, statusText: `${session.received} in, ${session.sent} out`, headers: { ...session.handshakeHeaders, 'content-type': 'application/json' }, body, durationMs: (session.closedAt ?? Date.now()) - session.startedAt, size: body.length },
		});
	}

	async send(key: string, message: IVoltHttpStreamMessage): Promise<void> {
		const live = this.byKey.get(key);
		if (!live || live.session.status !== 'open') {
			throw new Error('Not connected.');
		}
		const resolve = live.plan?.resolve ?? ((text: string) => text);
		try {
			await this.streams.send(live.id, { ...message, data: message.binary ? message.data : resolve(message.data), ...(message.target ? { target: resolve(message.target) } : {}) });
		} catch (err) {
			this.push(live, { at: Date.now(), direction: 'error', data: err instanceof Error ? err.message : String(err) });
			this._onDidChange.fire(key);
			throw err;
		}
	}

	private end(key: string): void {
		const live = this.byKey.get(key);
		if (live && live.session.status !== 'closed') {
			void this.streams.close(live.id).catch(() => undefined);
		}
	}

	disconnect(key: string): void {
		const live = this.byKey.get(key);
		if (!live || live.session.status === 'closed') {
			return;
		}
		if (live.session.status === 'connecting' && !live.plan) {
			// Still reading its files: nothing is open yet.
			live.session.status = 'closed';
			live.session.closedAt = Date.now();
			this.byId.delete(live.id);
			this._onDidChange.fire(key);
			return;
		}
		this.end(key);
	}

	clear(key: string): void {
		const live = this.byKey.get(key);
		if (live) {
			live.session.entries.length = 0;
			live.session.dropped = 0;
			this._onDidChange.fire(key);
		}
	}

	drop(key: string): void {
		this.end(key);
		const live = this.byKey.get(key);
		if (live) {
			// Its close event has nobody left to tell.
			this.byId.delete(live.id);
			this.byKey.delete(key);
		}
	}

	override dispose(): void {
		for (const key of [...this.byKey.keys()]) {
			this.end(key);
		}
		super.dispose();
	}
}

registerSingleton(IVoltHttpSessions, VoltHttpSessions, InstantiationType.Delayed);
