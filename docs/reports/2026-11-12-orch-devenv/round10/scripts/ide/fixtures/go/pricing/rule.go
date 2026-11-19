package pricing

import "example.com/shop/cart"

// PriceRule turns a running total into a new total.
type PriceRule interface {
	Name() string
	Apply(total float64, c *cart.Cart) float64
}
