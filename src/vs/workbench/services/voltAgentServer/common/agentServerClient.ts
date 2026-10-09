/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CollectionMirror } from '../../../../platform/voltAgentServer/common/collections.js';
import { AgentServerConnection, AgentServerConnectionState, IAgentServerConnectionOptions } from '../../../../platform/voltAgentServer/common/connection.js';
import { ICollectionDelta } from '../../../../platform/voltAgentServer/common/protocol.js';
import { SessionTopicData } from '../../../../platform/voltAgentServer/common/sessionPatch.js';
import { fromWire, toWire } from '../../../../platform/voltAgentServer/common/wire.js';
import { IVoltEventEnvelope } from '../../voltRuntime/common/events.js';

/** The desktop runs its agents in the agent server (and is one of its clients) when this is on. */
export const AGENT_SERVER_ENABLED_SETTING = 'volt.agentServer.enabled';

let enabledAtStartup: boolean | undefined;

/**
 * Whether this window runs its agents in the agent server. Read once per window: services and
 * contributions made later must agree with the ones made first, so a change needs a restart.
 */
export function agentServerEnabled(configurationService: IConfigurationService): boolean {
	enabledAtStartup ??= configurationService.getValue<boolean>(AGENT_SERVER_ENABLED_SETTING) === true;
	return enabledAtStartup;
}

export const IAgentServerClientService = createDecorator<IAgentServerClientService>('agentServerClientService');

export interface IAgentServerResync {
	/** The server restarted (or this is the first connection). */
	readonly newEpoch: boolean;
}

/**
 * This window's link to the agent server: the connection, the mirror of the server's replicated
 * state, and the server's event streams. The `Remote*` services answer the agent services'
 * interfaces from it.
 */
export interface IAgentServerClientService {
	readonly _serviceBrand: undefined;
	readonly connection: AgentServerConnection;
	readonly mirror: CollectionMirror;
	/** Resolves once the first snapshot of the server's state is in the mirror. */
	readonly whenReady: Promise<void>;
	readonly isReady: boolean;
	readonly onDidChangeState: Event<AgentServerConnectionState>;
	/** The mirror was replaced by a snapshot: views reload (open chats reopen). */
	readonly onDidResync: Event<IAgentServerResync>;
	readonly onDidChangeCollection: Event<{ readonly col: string; readonly keys: readonly string[]; readonly reset: boolean }>;
	readonly onSessionEvent: Event<SessionTopicData>;
	readonly onRuntimeEvent: Event<IVoltEventEnvelope>;
	readonly onHostToolsEvent: Event<unknown>;
	readonly onServerEvent: Event<unknown>;
	/** Calls a server method; arguments and the result cross as wire values (URIs, bytes revived). */
	call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
	/** A call whose result nobody waits for; failures are logged. */
	send(method: string, ...args: unknown[]): void;
	registerHandler(method: string, handler: (...args: unknown[]) => unknown): IDisposable;
}

export interface IAgentServerClientOptions extends IAgentServerConnectionOptions {
	readonly onError?: (method: string, err: unknown) => void;
}

/** {@link IAgentServerClientService} over one {@link AgentServerConnection}. Runs in any window or page. */
export class AgentServerClient extends Disposable implements IAgentServerClientService {

	declare readonly _serviceBrand: undefined;

	readonly connection: AgentServerConnection;
	readonly mirror = new CollectionMirror();

	private readonly _onDidResync = this._register(new Emitter<IAgentServerResync>());
	readonly onDidResync = this._onDidResync.event;
	private readonly _onSessionEvent = this._register(new Emitter<SessionTopicData>());
	readonly onSessionEvent = this._onSessionEvent.event;
	private readonly _onRuntimeEvent = this._register(new Emitter<IVoltEventEnvelope>());
	readonly onRuntimeEvent = this._onRuntimeEvent.event;
	private readonly _onHostToolsEvent = this._register(new Emitter<unknown>());
	readonly onHostToolsEvent = this._onHostToolsEvent.event;
	private readonly _onServerEvent = this._register(new Emitter<unknown>());
	readonly onServerEvent = this._onServerEvent.event;

	readonly onDidChangeState: Event<AgentServerConnectionState>;
	readonly onDidChangeCollection: Event<{ readonly col: string; readonly keys: readonly string[]; readonly reset: boolean }>;

	readonly whenReady: Promise<void>;
	private _isReady = false;

	constructor(private readonly options: IAgentServerClientOptions) {
		super();
		this.connection = this._register(new AgentServerConnection(options));
		this._register({ dispose: () => this.mirror.dispose() });
		this.onDidChangeState = this.connection.onDidChangeState;
		this.onDidChangeCollection = this.mirror.onDidChange;
		let ready: () => void;
		this.whenReady = new Promise<void>(resolve => ready = resolve);
		this._register(this.connection.onDidWelcome(welcome => {
			if (welcome.snapshot) {
				this.mirror.applySnapshot(fromWire(welcome.snapshot.collections));
				this._isReady = true;
				ready();
				this._onDidResync.fire({ newEpoch: welcome.newEpoch });
			}
		}));
		this._register(this.connection.onEvent(event => {
			switch (event.topic) {
				case 'col':
					this.mirror.applyDelta(fromWire<ICollectionDelta>(event.data));
					break;
				case 'session':
					this._onSessionEvent.fire(event.data as SessionTopicData);
					break;
				case 'runtime.event':
					this._onRuntimeEvent.fire(fromWire<IVoltEventEnvelope>(event.data));
					break;
				case 'hostTools':
					this._onHostToolsEvent.fire(fromWire(event.data));
					break;
				case 'server':
					this._onServerEvent.fire(event.data);
					break;
			}
		}));
	}

	get isReady(): boolean {
		return this._isReady;
	}

	connect(): void {
		this.connection.connect();
	}

	async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		const result = await this.connection.call(method, ...args.map(arg => toWire(arg)));
		return fromWire<T>(result);
	}

	send(method: string, ...args: unknown[]): void {
		this.call(method, ...args).catch(err => this.options.onError?.(method, err));
	}

	registerHandler(method: string, handler: (...args: unknown[]) => unknown): IDisposable {
		return this.connection.registerHandler(method, async (...params) => toWire(await handler(...params.map(param => fromWire(param)))));
	}
}
