/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoltAppliedCloudResult, IVoltCloudSourceSummary, IVoltCloudTaskInput, IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayEvent, IVoltRelayService, IVoltRelayState } from '../../../../platform/voltRelay/common/voltRelay.js';
import { IAgentServerClientService } from './agentServerClient.js';

/** The server's relay notices on the `server` topic (see ServerRelay). */
interface IRelayNotice {
	readonly kind?: string;
	readonly state?: IVoltRelayState;
	readonly event?: IVoltRelayEvent;
}

/**
 * The relay as a window sees it while agents run in the agent server: the server holds the
 * connection, the local webhook URL and the delivery queue (and runs deliveries itself), so this
 * window pairs, reads state, calls the relay and makes cloud tasks through it, and never drains.
 */
export class RemoteVoltRelayService extends Disposable implements IVoltRelayService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVoltRelayState>());
	readonly onDidChangeState: Event<IVoltRelayState> = this._onDidChangeState.event;
	private readonly _onDidEvent = this._register(new Emitter<IVoltRelayEvent>());
	readonly onDidEvent: Event<IVoltRelayEvent> = this._onDidEvent.event;

	private state: IVoltRelayState = { status: 'off' };
	private fetched: Promise<void> | undefined;

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this._register(client.onServerEvent(event => {
			const notice = event as IRelayNotice;
			if (notice.kind === 'relay.state' && notice.state) {
				this.setState(notice.state);
			} else if (notice.kind === 'relay.event' && notice.event) {
				this._onDidEvent.fire(notice.event);
			}
		}));
		// A restarted server (or a new connection) may hold another state.
		this._register(client.onDidResync(() => this.fetched = this.refresh()));
	}

	private setState(state: IVoltRelayState): void {
		if (JSON.stringify(state) !== JSON.stringify(this.state)) {
			this.state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private async refresh(): Promise<void> {
		try {
			this.setState(await this.client.call<IVoltRelayState>('relay.getState'));
		} catch {
			// An older server without a relay: it stays off.
		}
	}

	async getState(): Promise<IVoltRelayState> {
		if (!this.fetched) {
			this.fetched = this.client.whenReady.then(() => this.refresh());
		}
		await this.fetched;
		return this.state;
	}

	async connect(link: string, deviceName?: string): Promise<IVoltRelayState> {
		const state = await this.client.call<IVoltRelayState>('relay.connect', link, deviceName);
		this.setState(state);
		return state;
	}

	async disconnect(): Promise<void> {
		await this.client.call('relay.disconnect');
		this.setState({ status: 'off' });
	}

	request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		return this.client.call<T>('relay.request', method, path, body);
	}

	/** The server keeps the local hooks in step with the automations itself. */
	async setLocalHooks(_hooks: readonly IVoltLocalHook[]): Promise<void> { }

	/** The server runs the deliveries; a window has none to take. */
	async nextDelivery(waitMs: number): Promise<IVoltHeldDelivery | undefined> {
		await timeout(Math.max(1_000, Math.min(waitMs, 60_000)));
		return undefined;
	}

	async ackDelivery(_id: string, _source: 'relay' | 'local', _outcome: IVoltDeliveryOutcome): Promise<void> { }

	createCloudTask(input: IVoltCloudTaskInput): Promise<{ readonly task: unknown; readonly source: IVoltCloudSourceSummary }> {
		return this.client.call('relay.createCloudTask', input);
	}

	fetchCloudResult(taskId: string, repoRoot: string): Promise<IVoltAppliedCloudResult> {
		return this.client.call('relay.fetchCloudResult', taskId, repoRoot);
	}

	readBlobText(blobId: string, maxBytes: number): Promise<string> {
		return this.client.call('relay.readBlobText', blobId, maxBytes);
	}
}
