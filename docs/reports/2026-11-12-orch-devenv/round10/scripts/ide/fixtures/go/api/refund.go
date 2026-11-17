package api

import "example.com/shop/cart"

func RefundTax(c *cart.Cart) float64 {
	return tax.ComputeTax(c.Subtotal(), "eu")
}
