/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IVoltHttpLoad, IVoltLoadProgress, IVoltLoadSpec } from '../common/voltHttpLoad.js';
import { IVoltLoadRun, startVoltLoad, VoltLoadEvent } from '../node/voltLoad.js';

/** The most runs at once: each one is a worker thread with up to 2000 connections. */
const MAX_RUNS = 4;

/**
 * The Volt Client's performance tests, run from the main process: each run is a worker thread
 * (`../node/voltLoad.ts`), so the load never competes with the windows for the main thread.
 */
export class VoltHttpLoadMainService extends Disposable implements IVoltHttpLoad {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<IVoltLoadProgress>());
	readonly onDidProgress: Event<IVoltLoadProgress> = this._onDidProgress.event;

	private readonly runs = new Map<string, IVoltLoadRun>();

	async start(spec: IVoltLoadSpec): Promise<string> {
		if (this.runs.size >= MAX_RUNS) {
			throw new Error(`${MAX_RUNS} performance tests are already running. Stop one first.`);
		}
		const id = generateUuid();
		// The first events can come before `start` returns the id: they wait for it.
		let ready = false;
		const early: VoltLoadEvent[] = [];
		const deliver = (event: VoltLoadEvent) => {
			if (event.type !== 'sample') {
				this.runs.delete(id);
			}
			this._onDidProgress.fire({ ...event, id });
		};
		const run = this.begin(spec, event => ready ? deliver(event) : void early.push(event));
		this.runs.set(id, run);
		setTimeout(() => {
			ready = true;
			for (const event of early.splice(0)) {
				deliver(event);
			}
		}, 0);
		return id;
	}

	async stop(id: string): Promise<void> {
		this.runs.get(id)?.stop();
	}

	/** Starts the engine. Throws for a spec that cannot run. */
	protected begin(spec: IVoltLoadSpec, emit: (event: VoltLoadEvent) => void): IVoltLoadRun {
		return startVoltLoad(spec, emit);
	}

	override dispose(): void {
		for (const run of [...this.runs.values()]) {
			run.stop();
		}
		this.runs.clear();
		super.dispose();
	}
}
