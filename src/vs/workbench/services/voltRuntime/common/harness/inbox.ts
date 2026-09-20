/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InboxTarget } from './preStep.js';

/**
 * Steering inbox. DeepSeek's loop has one inbox with two targets; Zeron adds a
 * busy-run queue vs send-now interrupt:
 *
 *   step   mid-turn steering - claimed before the next model call, same turn
 *   turn   a new user turn - claimed and the loop opens turn N+1
 *   wake   without a waking message, waiting context stays put
 *   interrupt  send-now: the next claim treats this as a turn even mid-step
 */

export interface IInboxInject {
	readonly wake?: boolean;
	readonly target?: InboxTarget;
	readonly interrupt?: boolean;
}

export interface IInboxMessage {
	readonly text: string;
	readonly wake: boolean;
	readonly target: InboxTarget;
	readonly interrupt: boolean;
	readonly at: number;
}

export interface IInboxClaim {
	readonly texts: string[];
	readonly opensTurn: boolean;
	readonly interrupted: boolean;
}

export class SteeringInbox {

	private readonly items: IInboxMessage[] = [];

	get pending(): number {
		return this.items.length;
	}

	get waking(): number {
		return this.items.filter(item => item.wake).length;
	}

	inject(text: string, wakeOrOptions: boolean | IInboxInject = true, now = Date.now()): IInboxMessage | undefined {
		const trimmed = text.trim();
		if (!trimmed) {
			return undefined;
		}
		const options: IInboxInject = typeof wakeOrOptions === 'boolean' ? { wake: wakeOrOptions } : wakeOrOptions;
		const item: IInboxMessage = {
			text: trimmed,
			wake: options.wake !== false,
			target: options.target ?? 'step',
			interrupt: options.interrupt === true,
			at: now,
		};
		this.items.push(item);
		return item;
	}

	/**
	 * Returns the batch the next step should see. Empty when nothing is waking
	 * the driver - waiting context stays put (DeepSeek: injected context waits).
	 */
	claim(): string[] {
		return this.claimBatch().texts;
	}

	claimBatch(): IInboxClaim {
		if (!this.items.some(item => item.wake)) {
			return { texts: [], opensTurn: false, interrupted: false };
		}
		const claimed = this.items.splice(0, this.items.length);
		return {
			texts: claimed.map(item => item.text),
			opensTurn: claimed.some(item => item.target === 'turn' || item.interrupt),
			interrupted: claimed.some(item => item.interrupt),
		};
	}

	peek(): readonly IInboxMessage[] {
		return this.items;
	}

	clear(): void {
		this.items.length = 0;
	}
}
