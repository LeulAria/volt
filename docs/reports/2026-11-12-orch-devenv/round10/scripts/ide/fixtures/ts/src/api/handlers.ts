import { Cart, type CartItem } from '../cart.ts';
import { checkout, quote, type Receipt } from '../checkout.ts';
import { BulkDiscount } from '../pricing/bulkDiscount.ts';
import { freeShipping } from '../pricing/freeShipping.ts';
import { PercentOff } from '../pricing/percentOff.ts';
import type { PriceRule } from '../pricing/rule.ts';
import type { Region } from '../tax.ts';

export interface CheckoutRequest {
	items: CartItem[];
	region: Region;
}

export function defaultRules(): PriceRule[] {
	return [new PercentOff(10), new BulkDiscount(5, 3), freeShipping];
}

function buildCart(items: readonly CartItem[]): Cart {
	const cart = new Cart();
	for (const item of items) {
		cart.add(item);
	}
	return cart;
}

export function handleCheckout(request: CheckoutRequest): Receipt {
	return checkout(buildCart(request.items), defaultRules(), request.region);
}

export function handleQuote(request: CheckoutRequest): number {
	return quote(buildCart(request.items), defaultRules());
}
