package pricing

import "example.com/shop/cart"

type BulkDiscount struct {
	BaseRule
	amount   float64
	minItems int
}

func NewBulkDiscount(amount float64, minItems int) *BulkDiscount {
	return &BulkDiscount{BaseRule{"bulk-discount"}, amount, minItems}
}

func (b *BulkDiscount) Apply(total float64, c *cart.Cart) float64 {
	if c.Count() >= b.minItems {
		return b.clamp(total - b.amount)
	}
	return total
}
