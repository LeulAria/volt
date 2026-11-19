package pricing

import "example.com/shop/cart"

const ShippingFee = 4.99

type FreeShipping struct{}

func (FreeShipping) Name() string {
	return "free-shipping"
}

func (FreeShipping) Apply(total float64, c *cart.Cart) float64 {
	if total >= 50 {
		return total
	}
	return total + ShippingFee
}
