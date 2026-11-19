import type { Cart } from './cart.ts';
import type { PriceRule } from './pricing/rule.ts';
import { computeTax, type Region, roundCents } from './tax.ts';

export interface Receipt {
	subtotal: number;
	discounted: number;
	tax: number;
	total: number;
}

export function applyRules(cart: Cart, rules: readonly PriceRule[]): number {
	let total = cart.subtotal();
	for (const rule of rules) {
		total = rule.apply(total, cart);
	}
	return total;
}

export function checkout(cart: Cart, rules: readonly PriceRule[], region: Region): Receipt {
	const subtotal = cart.subtotal();
	const discounted = applyRules(cart, rules);
	const tax = computeTax(discounted, region);
	return {
		subtotal: roundCents(subtotal),
		discounted: roundCents(discounted),
		tax,
		total: roundCents(discounted + tax),
	};
}

export function quote(cart: Cart, rules: readonly PriceRule[]): number {
	return roundCents(applyRules(cart, rules));
}
