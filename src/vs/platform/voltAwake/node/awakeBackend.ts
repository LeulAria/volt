/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { LidCapability } from '../common/voltAwake.js';
import { AwakeExec } from './awakeExec.js';
import { AwakeRegistry, IAwakeProcessProbe } from './awakeRegistry.js';

/** How long a lid hold stays valid without a renewal; the recovery paths let go after it. */
export const LID_HOLD_TTL_SECONDS = 10 * 60;

/** Keeps the computer awake with the lid closed, one OS at a time. */
export interface IAwakeLidBackend extends IDisposable {
	/** macOS: the lid as polled while the hold lasts (undefined when unknown). */
	readonly onDidChangeLid: Event<boolean | undefined>;
	probe(): Promise<LidCapability>;
	/** At startup: undo what a Volt that crashed or was killed left behind. */
	reconcile(): Promise<void>;
	/**
	 * Takes (or keeps) the hold. Resolves true when the lid can no longer put the computer to sleep;
	 * false when only a partial hold was possible (setup missing, or another app owns the setting).
	 * Throws a message meant for the user when the OS refuses.
	 */
	hold(capability: LidCapability): Promise<boolean>;
	/** Pushes the deadline out while the hold lasts. */
	renew(): Promise<void>;
	release(): Promise<void>;
	/** The one-time approval. Throws when the user cancels or the OS refuses. */
	setUp(): Promise<void>;
	removeSetup(): Promise<void>;
}

export interface IAwakeBackendContext {
	readonly exec: AwakeExec;
	readonly registry: AwakeRegistry;
	readonly probe: IAwakeProcessProbe;
	readonly log: ILogService;
	/** Who holds: `volt` (the app) or `volt-server` (the agent server). */
	readonly owner: string;
}

export class UnsupportedLidBackend implements IAwakeLidBackend {
	readonly onDidChangeLid = Event.None;
	constructor(private readonly detail: string) { }
	async probe(): Promise<LidCapability> { return { kind: 'unsupported', detail: this.detail }; }
	async reconcile(): Promise<void> { }
	async hold(): Promise<boolean> { return false; }
	async renew(): Promise<void> { }
	async release(): Promise<void> { }
	async setUp(): Promise<void> { throw new Error(this.detail); }
	async removeSetup(): Promise<void> { }
	dispose(): void { }
}
