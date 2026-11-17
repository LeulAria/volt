import { handleCheckout, handleQuote } from './api/handlers.ts';

export { Cart, lineTotal } from './cart.ts';
export { checkout, quote } from './checkout.ts';
export { handleCheckout, handleQuote };

export function main(): void {
	const request = { items: [{ sku: 'tea', unitPrice: 12.5, quantity: 4 }], region: 'eu' as const };
	console.log(handleQuote(request), handleCheckout(request));
}
