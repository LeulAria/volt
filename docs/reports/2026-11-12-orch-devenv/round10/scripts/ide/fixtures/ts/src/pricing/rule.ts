import type { Cart } from '../cart.ts';

/** A pricing rule turns a running total into a new total. */
export interface PriceRule {
	readonly name: string;
	apply(total: number, cart: Cart): number;
}
