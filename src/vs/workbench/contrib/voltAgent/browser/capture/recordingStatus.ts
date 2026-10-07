/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVoltRecordingStatusService = createDecorator<IVoltRecordingStatusService>('voltRecordingStatusService');

/** A screen or window recording in progress. */
export interface IVoltRecording {
	readonly id: string;
	/** What is being recorded: a window title, "Screen", a device name. */
	readonly label: string;
	readonly startedAt: number;
	/** Started by an agent (and which chat), or by the user. */
	readonly by: 'agent' | 'user';
	readonly sessionId?: string;
	/** Records a Volt window, so its previews are in the video. */
	readonly ownWindow: boolean;
	stop(): Promise<void>;
}

/**
 * The recordings running in this window. Previews (docked, floating, separate window) and device
 * views show a recording badge while any runs, so the user always knows the screen is captured.
 */
export interface IVoltRecordingStatusService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly recordings: readonly IVoltRecording[];
	add(recording: IVoltRecording): IDisposable;
}

export class VoltRecordingStatusService extends Disposable implements IVoltRecordingStatusService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private list: IVoltRecording[] = [];

	get recordings(): readonly IVoltRecording[] {
		return this.list;
	}

	add(recording: IVoltRecording): IDisposable {
		this.list = [...this.list, recording];
		this._onDidChange.fire();
		return toDisposable(() => {
			const next = this.list.filter(entry => entry !== recording);
			if (next.length !== this.list.length) {
				this.list = next;
				this._onDidChange.fire();
			}
		});
	}
}

/** `0:07`, `12:30`, `1:02:03`. */
export function formatRecordingTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total / 60) % 60;
	const seconds = String(total % 60).padStart(2, '0');
	return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

registerSingleton(IVoltRecordingStatusService, VoltRecordingStatusService, InstantiationType.Delayed);
