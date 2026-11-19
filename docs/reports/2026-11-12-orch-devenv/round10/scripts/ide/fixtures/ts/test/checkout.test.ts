import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cart, lineTotal } from '../src/cart.ts';
import { checkout } from '../src/checkout.ts';
import { PercentOff } from '../src/pricing/percentOff.ts';

test('lineTotal multiplies price by quantity', () => {
	assert.equal(lineTotal({ sku: 'tea', unitPrice: 2.5, quantity: 4 }), 10);
});

test('checkout applies rules and tax', () => {
	const cart = new Cart();
	cart.add({ sku: 'tea', unitPrice: 50, quantity: 2 });
	const receipt = checkout(cart, [new PercentOff(10)], 'eu');
	assert.equal(receipt.discounted, 90);
	assert.equal(receipt.total, 108);
});

test('checkout without tax keeps the discounted total', () => {
	const cart = new Cart();
	cart.add({ sku: 'tea', unitPrice: 10, quantity: 1 });
	assert.equal(checkout(cart, [], 'none').total, 11);
});
