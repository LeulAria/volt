package api

import (
	"example.com/shop/cart"
	"example.com/shop/checkout"
	"example.com/shop/pricing"
)

func DefaultRules() []pricing.PriceRule {
	return []pricing.PriceRule{pricing.NewPercentOff(10), pricing.NewBulkDiscount(5, 3), pricing.FreeShipping{}}
}

func buildCart(items []cart.CartItem) *cart.Cart {
	c := &cart.Cart{}
	for _, item := range items {
		c.Add(item)
	}
	return c
}

func HandleCheckout(items []cart.CartItem, region string) checkout.Receipt {
	return checkout.Checkout(buildCart(items), DefaultRules(), region)
}

func HandleQuote(items []cart.CartItem) float64 {
	return checkout.Quote(buildCart(items), DefaultRules())
}
