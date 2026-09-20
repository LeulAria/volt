/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared task state and the conflict resolver. Swarm workers write through this, not through
 * each other's transcripts: a claim on a path is what stops two implementers from editing the
 * same file and silently destroying each other's work.
 *
 * Conflicts are resolved by a rule, not a model. The rule is: the first claim wins; a later
 * writer on the same path is told to wait or to record a note rather than overwrite. That is
 * boring on purpose - a clever merge of two agent edits is how you ship a file nobody wrote.
 */

export type ConflictResolution = 'keep-current' | 'take-incoming' | 'queue' | 'split';

export interface IClaim {
	readonly workerId: string;
	readonly path: string;
	readonly at: number;
}

export interface ISharedFact {
	readonly key: string;
	readonly value: string;
	readonly workerId: string;
	readonly at: number;
}

export interface IConflict {
	readonly path: string;
	readonly holder: string;
	readonly challenger: string;
	readonly resolution: ConflictResolution;
	readonly reason: string;
}

export class SharedTaskState {

	private readonly claims = new Map<string, IClaim>();
	private readonly facts = new Map<string, ISharedFact>();
	private readonly conflicts: IConflict[] = [];
	private readonly notes: string[] = [];

	claim(workerId: string, path: string, now = Date.now()): IClaim | IConflict {
		const normalized = normalizePath(path);
		const existing = this.claims.get(normalized);
		if (existing && existing.workerId !== workerId) {
			const conflict: IConflict = {
				path: normalized,
				holder: existing.workerId,
				challenger: workerId,
				resolution: 'queue',
				reason: `${workerId} wanted ${normalized}, but ${existing.workerId} already holds it.`,
			};
			this.conflicts.push(conflict);
			return conflict;
		}
		const claim: IClaim = { workerId, path: normalized, at: now };
		this.claims.set(normalized, claim);
		return claim;
	}

	release(workerId: string, path?: string): void {
		if (path) {
			const normalized = normalizePath(path);
			if (this.claims.get(normalized)?.workerId === workerId) {
				this.claims.delete(normalized);
			}
			return;
		}
		for (const [key, claim] of this.claims) {
			if (claim.workerId === workerId) {
				this.claims.delete(key);
			}
		}
	}

	remember(workerId: string, key: string, value: string, now = Date.now()): void {
		this.facts.set(key, { key, value, workerId, at: now });
	}

	recall(key: string): ISharedFact | undefined {
		return this.facts.get(key);
	}

	note(text: string): void {
		if (text.trim()) {
			this.notes.push(text.trim());
		}
	}

	heldBy(path: string): string | undefined {
		return this.claims.get(normalizePath(path))?.workerId;
	}

	openClaims(): readonly IClaim[] {
		return [...this.claims.values()];
	}

	allFacts(): readonly ISharedFact[] {
		return [...this.facts.values()];
	}

	allConflicts(): readonly IConflict[] {
		return this.conflicts;
	}

	digest(): string {
		const parts: string[] = [];
		if (this.facts.size) {
			parts.push(['Known:', ...[...this.facts.values()].slice(-12).map(fact => `- ${fact.key}: ${fact.value}`)].join('\n'));
		}
		if (this.conflicts.length) {
			parts.push(['Conflicts:', ...this.conflicts.slice(-6).map(conflict => `- ${conflict.reason}`)].join('\n'));
		}
		if (this.notes.length) {
			parts.push(['Notes:', ...this.notes.slice(-8).map(note => `- ${note}`)].join('\n'));
		}
		return parts.join('\n\n');
	}
}

export function isConflict(value: IClaim | IConflict): value is IConflict {
	return 'holder' in value && 'challenger' in value;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
