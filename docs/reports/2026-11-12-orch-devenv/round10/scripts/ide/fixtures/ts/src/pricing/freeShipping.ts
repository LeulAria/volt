import type { PriceRule } from './rule.ts';

export const SHIPPING_FEE = 4.99;

export const freeShipping: PriceRule = {
	name: 'free-shipping',
	apply(total: number): number {
		return total >= 50 ? total : total + SHIPPING_FEE;
	},
};
