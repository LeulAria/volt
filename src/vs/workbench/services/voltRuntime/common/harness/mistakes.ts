/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RecoveryStrategy } from './recovery.js';

/**
 * Consecutive-mistake counter (Cline MistakeTracker). Recovery still owns the
 * ladder; this only *tilts* it after a streak so a run that keeps failing the
 * same way switches approach before the budget is gone.
 */

export interface IMistakeSnapshot {
	readonly consecutive: number;
	readonly total: number;
	readonly prefer?: RecoveryStrategy;
}

export class MistakeTracker {

	private consecutive = 0;
	private total = 0;

	record(failed: boolean): IMistakeSnapshot {
		if (failed) {
			this.consecutive++;
			this.total++;
		} else {
			this.consecutive = 0;
		}
		return this.snapshot();
	}

	reset(): void {
		this.consecutive = 0;
	}

	snapshot(): IMistakeSnapshot {
		return {
			consecutive: this.consecutive,
			total: this.total,
			...(this.prefer() ? { prefer: this.prefer() } : {}),
		};
	}

	private prefer(): RecoveryStrategy | undefined {
		if (this.consecutive >= 6) {
			return 'ask';
		}
		if (this.consecutive >= 3) {
			return 'switch';
		}
		return undefined;
	}
}

export function isFailedStep(score: number, errors: number, stuck: boolean): boolean {
	return stuck || errors > 0 || score <= 0.2;
}
