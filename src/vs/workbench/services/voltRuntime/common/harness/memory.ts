/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory engine. Four scopes, one store:
 *
 *   working    facts established this step - discarded when the step ends
 *   session    facts established this conversation - discarded when the session ends
 *   project    facts about this workspace - survive sessions, not machines
 *   longterm   facts the user asked to keep - survive workspaces
 *
 * Recall is extractive and ranked, not generative. A memory that cannot be attributed to a
 * scope and a source is not stored: that is what stops the model from "remembering" a
 * conclusion it never evidenced.
 */

export type MemoryScope = 'working' | 'session' | 'project' | 'longterm' | 'semantic' | 'procedural';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['working', 'session', 'project', 'longterm', 'semantic', 'procedural'];

export interface IMemoryFact {
	readonly id: string;
	readonly scope: MemoryScope;
	readonly key: string;
	readonly value: string;
	readonly source: string;
	readonly at: number;
	readonly expiresAt?: number;
}

export interface IMemoryHit {
	readonly fact: IMemoryFact;
	readonly score: number;
}

const SCOPE_CAP: Readonly<Record<MemoryScope, number>> = {
	working: 32,
	session: 64,
	project: 128,
	longterm: 256,
	semantic: 128,
	procedural: 64,
};

export class MemoryEngine {

	private readonly facts = new Map<MemoryScope, IMemoryFact[]>();
	private seq = 0;

	remember(scope: MemoryScope, key: string, value: string, source: string, now = Date.now(), ttlMs?: number): IMemoryFact {
		const clean = value.trim();
		if (!clean || !key.trim()) {
			throw new Error('Memory refuses an empty key or value.');
		}
		const fact: IMemoryFact = {
			id: `m${++this.seq}`,
			scope,
			key: key.trim(),
			value: clean.slice(0, 400),
			source,
			at: now,
			...(ttlMs ? { expiresAt: now + ttlMs } : {}),
		};
		const list = (this.facts.get(scope) ?? []).filter(item => item.key !== fact.key);
		list.push(fact);
		this.facts.set(scope, list.slice(-SCOPE_CAP[scope]));
		return fact;
	}

	forget(scope: MemoryScope, key?: string): void {
		if (!key) {
			this.facts.delete(scope);
			return;
		}
		const list = (this.facts.get(scope) ?? []).filter(item => item.key !== key);
		this.facts.set(scope, list);
	}

	/** Drop working memory. Called at the end of a step so the next one starts clean. */
	clearWorking(): void {
		this.facts.delete('working');
	}

	recall(query: string, now = Date.now(), limit = 8): IMemoryHit[] {
		const tokens = tokenize(query);
		const hits: IMemoryHit[] = [];
		for (const scope of MEMORY_SCOPES) {
			for (const fact of this.facts.get(scope) ?? []) {
				if (fact.expiresAt && fact.expiresAt <= now) {
					continue;
				}
				const score = scoreFact(fact, tokens, query);
				if (score > 0) {
					hits.push({ fact, score });
				}
			}
		}
		return hits.sort((a, b) => b.score - a.score || b.fact.at - a.fact.at).slice(0, limit);
	}

	all(scope?: MemoryScope): readonly IMemoryFact[] {
		if (scope) {
			return this.facts.get(scope) ?? [];
		}
		return MEMORY_SCOPES.flatMap(item => this.facts.get(item) ?? []);
	}

	/**
	 * The slice worth spending tokens on. Long-term and project first: they are the facts the
	 * model cannot re-derive from this transcript.
	 */
	promptBlock(query: string, now = Date.now()): string | undefined {
		const hits = this.recall(query, now, 6).filter(hit => hit.fact.scope !== 'working');
		if (!hits.length) {
			return undefined;
		}
		return ['Remembered:', ...hits.map(hit => `- (${hit.fact.scope}) ${hit.fact.key}: ${hit.fact.value}`)].join('\n');
	}
}

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9_./-]+/).filter(token => token.length > 1);
}

function scoreFact(fact: IMemoryFact, tokens: readonly string[], query: string): number {
	const hay = `${fact.key} ${fact.value}`.toLowerCase();
	if (hay.includes(query.trim().toLowerCase()) && query.trim().length > 2) {
		return 1;
	}
	const hits = tokens.filter(token => hay.includes(token)).length;
	if (!hits) {
		return 0;
	}
	const scopeBonus = fact.scope === 'longterm' ? 0.15 : fact.scope === 'project' ? 0.1 : 0;
	return Math.min(1, hits / Math.max(1, tokens.length) + scopeBonus);
}
