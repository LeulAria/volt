import type { Cart } from './cart.ts';

export function refundTax(cart: Cart): number {
	return computeTax(cart.subtotal(), 'eu');
}
