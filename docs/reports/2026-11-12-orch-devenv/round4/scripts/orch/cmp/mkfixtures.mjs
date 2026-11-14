// Recreates the bench fixtures under /tmp/v4orch/w (t0..t3) and the hidden t3 check, as round 2 and the
// first round-3 runs had them. The file texts were recovered from the recorded runs (tool results in
// data/orch/cmp/raw and round 2's data/cmp/raw), byte for byte where a run printed the whole file.
// Usage: node mkfixtures.mjs   (replaces /tmp/v4orch/w)
import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = '/tmp/v4orch/w';

const T1 = {
	'src/pricing.ts': `export interface LineItem { sku: string; unitCents: number; qty: number }
export function subtotal(items: LineItem[]): number {
	return items.reduce((s, i) => s + i.unitCents * i.qty, 0);
}
export function applyDiscount(cents: number, pct: number): number {
	// BUG: pct is a whole number (10 = 10%), but it is used as a fraction
	return Math.round(cents * (1 - pct));
}
export function tax(cents: number, rate = 0.08): number {
	return Math.round(cents * rate);
}
`,
	'src/cart.ts': `import { LineItem, subtotal, applyDiscount, tax } from './pricing';
export class Cart {
	private items: LineItem[] = [];
	add(item: LineItem) { this.items.push(item); }
	total(discountPct = 0): number {
		const sub = applyDiscount(subtotal(this.items), discountPct);
		return sub + tax(sub);
	}
}
`,
	'src/checkout.ts': `import { Cart } from './cart';
import { reserve } from './inventory';
export function checkout(cart: Cart, skus: Array<[string, number]>, discountPct: number) {
	for (const [sku, qty] of skus) { if (!reserve(sku, qty)) { throw new Error('out of stock ' + sku); } }
	return cart.total(discountPct);
}
`,
	'src/inventory.ts': `const stock = new Map<string, number>([['A1', 3], ['B2', 0], ['C3', 12]]);
export function inStock(sku: string): boolean { return (stock.get(sku) ?? 0) > 0; }
export function reserve(sku: string, qty: number): boolean {
	const have = stock.get(sku) ?? 0;
	if (have < qty) { return false; }
	stock.set(sku, have - qty);
	return true;
}
`,
};

const T2 = {
	'package.json': `{ "name": "shop", "private": true, "type": "module", "scripts": { "test": "node --test test/*.test.ts" } }
`,
	'src/pricing.ts': `export interface LineItem { sku: string; unitCents: number; qty: number }
export function subtotal(items: LineItem[]): number {
	return items.reduce((s, i) => s + i.unitCents * i.qty, 0);
}
/** pct is a whole percentage: applyDiscount(1000, 10) === 900. */
export function applyDiscount(cents: number, pct: number): number {
	return Math.round(cents * (1 - pct));
}
export function tax(cents: number, rate = 0.08): number {
	return Math.round(cents * rate);
}
`,
	'src/cart.ts': `import { type LineItem, subtotal, applyDiscount, tax } from './pricing.ts';
export class Cart {
	private items: LineItem[] = [];
	add(item: LineItem) { this.items.push(item); }
	total(discountPct = 0): number {
		const sub = applyDiscount(subtotal(this.items), discountPct);
		return sub + tax(sub);
	}
}
`,
	'src/inventory.ts': `const stock = new Map<string, number>([['A1', 3], ['B2', 0], ['C3', 12]]);
export function inStock(sku: string): boolean { return (stock.get(sku) ?? 0) > 0; }
/** Takes qty units if that many are left; returns whether it did. */
export function reserve(sku: string, qty: number): boolean {
	const have = stock.get(sku) ?? 0;
	if (have <= qty) { return false; }
	stock.set(sku, have - qty);
	return true;
}
`,
	'src/checkout.ts': `import { Cart } from './cart.ts';
import { reserve } from './inventory.ts';
/** Reserves every sku (throws 'out of stock <sku>' when one can't be), then returns the cart total. */
export function checkout(cart: Cart, skus: Array<[string, number]>, discountPct: number): number {
	for (const [sku, qty] of skus) {
		if (!reserve(sku, qty)) { continue; }
	}
	return cart.total(discountPct);
}
`,
	'test/pricing.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, tax } from '../src/pricing.ts';
test('subtotal', () => assert.equal(subtotal([{ sku: 'a', unitCents: 250, qty: 2 }, { sku: 'b', unitCents: 100, qty: 1 }]), 600));
test('applyDiscount takes a whole percentage', () => { assert.equal(applyDiscount(1000, 10), 900); assert.equal(applyDiscount(1000, 0), 1000); });
test('tax', () => assert.equal(tax(1000), 80));
`,
	'test/inventory.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inStock, reserve } from '../src/inventory.ts';
test('inStock', () => { assert.equal(inStock('A1'), true); assert.equal(inStock('B2'), false); });
test('reserve can take the last units', () => { assert.equal(reserve('A1', 3), true); assert.equal(reserve('A1', 1), false); });
`,
	'test/checkout.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.ts';
import { checkout } from '../src/checkout.ts';
test('checkout returns the total', () => { const c = new Cart(); c.add({ sku: 'C3', unitCents: 1000, qty: 1 }); assert.equal(checkout(c, [['C3', 1]], 0), 1080); });
test('checkout throws when out of stock', () => { const c = new Cart(); c.add({ sku: 'B2', unitCents: 1000, qty: 1 }); assert.throws(() => checkout(c, [['B2', 1]], 0), /out of stock B2/); });
`,
};

const T3 = {
	'package.json': `{ "name": "receipt", "private": true, "type": "module" }
`,
	'SPEC.md': `# money.ts spec

All amounts are integer cents.

## formatCents(cents: number): string
Dollars, a dot, and always two digits of cents. Negative amounts put the minus sign before the dollar sign.

| call | result |
|---|---|
| formatCents(0) | \`$0.00\` |
| formatCents(105) | \`$1.05\` |
| formatCents(123456) | \`$1234.56\` |
| formatCents(-250) | \`-$2.50\` |

## formatReceipt(lines: Array<{ label: string; cents: number }>): string
One line per item, \`<label>: <formatCents(cents)>\`, then a last line \`Total: <formatCents(sum)>\`.
Lines are joined with \`\\n\` (no trailing newline). An empty list gives just \`Total: $0.00\`.

Example: formatReceipt([{ label: 'Tea', cents: 350 }, { label: 'Refund', cents: -100 }])
returns \`Tea: $3.50\\nRefund: -$1.00\\nTotal: $2.50\`.
`,
	'src/money.ts': `/** Renders integer cents as dollars (see SPEC.md). */
export function formatCents(cents: number): string {
	const dollars = Math.floor(cents / 100);
	const rest = cents % 100;
	return '$' + dollars + '.' + rest;
}
`,
};

function repo(name, files) {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	if (Object.keys(files).length) {
		execSync('git init -q -b main && git add -A && git -c user.name=bench -c user.email=bench@local commit -qm fixture', { cwd: dir });
	}
}

repo('t0', {});
repo('t1', T1);
repo('t2', T2);
repo('t3', T3);
copyFileSync(join(here, 'check-t3.mjs'), '/tmp/v4orch/check-t3.mjs');
console.log('fixtures in', ROOT);
