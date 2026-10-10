/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { IChannelServer, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IVoltStallAttribution } from './voltDiagnostics.js';

export interface IIpcCallRecord {
	/** `channel.command`. */
	readonly name: string;
	/** Epoch milliseconds. */
	readonly startTime: number;
	/** Time spent before the call returned its promise: the part that blocks the loop. */
	readonly syncMs: number;
}

/** Called for every IPC call once its synchronous part ran; `result` settles with the call. */
export type IpcCallObserver = (channel: string, command: string, startTime: number, result: Promise<unknown>) => void;

const RING_SIZE = 32;

/**
 * Remembers the last IPC calls the main process served, so a stall can name what was running.
 * Recording costs two clock reads and an array write per call.
 */
export class IpcActivityRecorder {

	private readonly ring: (IIpcCallRecord | undefined)[] = new Array<IIpcCallRecord | undefined>(RING_SIZE);
	private next = 0;

	constructor(private readonly now: () => number = Date.now) { }

	record(name: string, startTime: number, syncMs: number): void {
		this.ring[this.next] = { name, startTime, syncMs };
		this.next = (this.next + 1) % RING_SIZE;
	}

	recent(): IIpcCallRecord[] {
		const result: IIpcCallRecord[] = [];
		for (let i = 0; i < RING_SIZE; i++) {
			const record = this.ring[(this.next + i) % RING_SIZE];
			if (record) {
				result.push(record);
			}
		}
		return result;
	}

	/**
	 * What ran during a stall from `startTime` to `endTime`: the call whose synchronous part took a
	 * real share of it, else the last call that started shortly before or inside it.
	 */
	attribute(startTime: number, endTime: number, slackMs = 1000): IVoltStallAttribution[] {
		const duration = endTime - startTime;
		let blocking: IIpcCallRecord | undefined;
		let last: IIpcCallRecord | undefined;
		for (const record of this.recent()) {
			const end = record.startTime + record.syncMs;
			if (end >= startTime - 5 && record.startTime <= endTime && record.syncMs >= Math.max(10, duration / 4)) {
				if (!blocking || record.syncMs > blocking.syncMs) {
					blocking = record;
				}
			}
			if (record.startTime <= endTime && record.startTime >= startTime - slackMs) {
				last = record;
			}
		}
		if (blocking) {
			return [{ kind: 'ipc', detail: blocking.name, durationMs: blocking.syncMs }];
		}
		if (last) {
			return [{ kind: 'ipc', detail: `${last.name} (last call, ${Math.max(0, Math.round(startTime - last.startTime))} ms before)` }];
		}
		return [];
	}

	wrapChannel<TContext>(channelName: string, channel: IServerChannel<TContext>, observer?: IpcCallObserver): IServerChannel<TContext> {
		return {
			call: <T>(ctx: TContext, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> => {
				const startTime = this.now();
				let result: Promise<T> | undefined;
				try {
					result = channel.call<T>(ctx, command, arg, cancellationToken);
					return result;
				} finally {
					this.record(`${channelName}.${command}`, startTime, this.now() - startTime);
					if (observer && result) {
						observer(channelName, command, startTime, result);
					}
				}
			},
			listen: (ctx, event, arg) => channel.listen(ctx, event, arg),
		};
	}

	/** Wraps every channel registered on `server` from now on. Returns a function that stops wrapping new ones. */
	instrument<TContext>(server: IChannelServer<TContext>, observer?: IpcCallObserver): () => void {
		const original = server.registerChannel;
		server.registerChannel = (channelName: string, channel: IServerChannel<TContext>) => original.call(server, channelName, this.wrapChannel(channelName, channel, observer));
		return () => server.registerChannel = original;
	}
}
