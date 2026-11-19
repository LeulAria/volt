import { roundCents, computeTax } from './tax.ts';
import { Cart } from './cart.ts';
import { lineTotal } from './cart.ts';

export function   summarize( cart:Cart ):string{
const total=roundCents( cart.subtotal() )
    return `items=${cart.count()} total=${total}`
}
