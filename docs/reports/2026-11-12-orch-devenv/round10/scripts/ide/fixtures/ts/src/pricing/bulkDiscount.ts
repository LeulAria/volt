import type { Cart } from '../cart.ts';
import { BaseRule } from './base.ts';

export class BulkDiscount extends BaseRule {
	private readonly amount: number;
	private readonly minItems: number;

	constructor(amount: number, minItems: number) {
		super('bulk-discount');
		this.amount = amount;
		this.minItems = minItems;
	}

	apply(total: number, cart: Cart): number {
		return cart.count() >= this.minItems ? this.clamp(total - this.amount) : total;
	}
}
