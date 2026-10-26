/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ErrorClass } from './progress.js';
import { RecoveryStrategy } from './recovery.js';

/**
 * Procedural memory and failure lessons. A recovery that worked once is worth trying again
 * when the same class of error comes back; a recovery that failed is not. These are
 * extractive records, not generated advice - the source is a strategy that actually ran.
 */

export interface ILesson {
	readonly id: string;
	readonly error: ErrorClass | 'stuck' | 'doom' | 'regression' | 'waste';
	readonly strategy: RecoveryStrategy;
	readonly worked: boolean;
	readonly note: string;
	readonly at: number;
}

export class LessonBook {

	private readonly items: ILesson[] = [];
	private seq = 0;

	record(error: ILesson['error'], strategy: RecoveryStrategy, worked: boolean, note: string, now = Date.now()): ILesson {
		const lesson: ILesson = {
			id: `l${++this.seq}`,
			error,
			strategy,
			worked,
			note: note.trim().slice(0, 240),
			at: now,
		};
		this.items.push(lesson);
		return lesson;
	}

	/** The outcome is known now: a recovery recorded as tried either worked or did not. */
	settle(lesson: ILesson, worked: boolean, note?: string): ILesson {
		const index = this.items.indexOf(lesson);
		if (index < 0) {
			return lesson;
		}
		const settled: ILesson = { ...lesson, worked, ...(note ? { note: note.trim().slice(0, 240) } : {}) };
		this.items[index] = settled;
		return settled;
	}

	/** Strategies that have already failed for this error, cheapest first is *not* implied. */
	failedFor(error: ILesson['error']): readonly RecoveryStrategy[] {
		return this.items.filter(item => item.error === error && !item.worked).map(item => item.strategy);
	}

	/** The last strategy that actually recovered this error class, if any. */
	lastSuccess(error: ILesson['error']): RecoveryStrategy | undefined {
		for (let i = this.items.length - 1; i >= 0; i--) {
			if (this.items[i].error === error && this.items[i].worked) {
				return this.items[i].strategy;
			}
		}
		return undefined;
	}

	recall(error: ILesson['error'], limit = 4): readonly ILesson[] {
		return this.items.filter(item => item.error === error).slice(-limit);
	}

	promptBlock(): string | undefined {
		const useful = this.items.filter(item => item.worked).slice(-4);
		if (!useful.length) {
			return undefined;
		}
		return ['Lessons that already worked this run:', ...useful.map(item => `- ${item.error} → ${item.strategy}: ${item.note}`)].join('\n');
	}

	all(): readonly ILesson[] {
		return this.items;
	}

	/** One line per lesson, for traces and run metrics: `doom → nudge: worked (repeat of read_file)`. */
	describe(): string[] {
		return this.items.map(item => `${item.error} \u2192 ${item.strategy}: ${item.worked ? 'worked' : 'did not work'}${item.note ? ` (${item.note})` : ''}`);
	}
}
