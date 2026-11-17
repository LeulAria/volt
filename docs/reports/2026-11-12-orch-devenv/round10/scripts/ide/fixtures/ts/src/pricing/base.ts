import type { Cart } from '../cart.ts';
import type { PriceRule } from './rule.ts';

export abstract class BaseRule implements PriceRule {
	readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	abstract apply(total: number, cart: Cart): number;

	protected clamp(value: number): number {
		return value < 0 ? 0 : value;
	}
}
