/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A seeded generator for property tests (fast-check is not a dependency). Every run uses the same
 * seeds, so a failure names the seed that broke the law; `VOLT_PROPERTY_RUNS` raises the count.
 */

export const PROPERTY_RUNS = Number(process.env.VOLT_PROPERTY_RUNS) || 1000;

/** Mulberry32: small, fast and the same on every platform. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class Gen {
	constructor(private readonly next: () => number) { }
	int(max: number): number { return Math.floor(this.next() * max); }
	bool(p = 0.5): boolean { return this.next() < p; }
	pick<T>(values: readonly T[]): T { return values[this.int(values.length)]; }
	some<T>(values: readonly T[], max = 4): T[] { return [...new Set(Array.from({ length: this.int(max + 1) }, () => this.pick(values)))]; }
}

/** Runs `law` on `runs` seeds; a failure says which seed. */
export function forAll(name: string, law: (gen: Gen, seed: number) => void, runs = PROPERTY_RUNS): void {
	for (let seed = 1; seed <= runs; seed++) {
		try {
			law(new Gen(rng(seed * 7919)), seed);
		} catch (err) {
			throw new Error(`${name} failed for seed ${seed}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
