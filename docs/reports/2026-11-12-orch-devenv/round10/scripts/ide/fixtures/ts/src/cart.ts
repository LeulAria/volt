export interface CartItem {
	sku: string;
	unitPrice: number;
	quantity: number;
}

/** The price of one line: unit price times quantity. */
export function lineTotal(item: CartItem): number {
	return item.unitPrice * item.quantity;
}

export class Cart {
	private readonly items: CartItem[] = [];

	add(item: CartItem): void {
		this.items.push(item);
	}

	list(): readonly CartItem[] {
		return this.items;
	}

	subtotal(): number {
		return this.items.reduce((sum, item) => sum + lineTotal(item), 0);
	}

	count(): number {
		return this.items.reduce((sum, item) => sum + item.quantity, 0);
	}
}
