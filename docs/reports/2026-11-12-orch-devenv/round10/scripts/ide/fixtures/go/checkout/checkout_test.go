package checkout

import (
	"testing"

	"example.com/shop/cart"
	"example.com/shop/pricing"
)

func TestLineTotal(t *testing.T) {
	if got := cart.LineTotal(cart.CartItem{Sku: "tea", UnitPrice: 2.5, Quantity: 4}); got != 10 {
		t.Fatalf("LineTotal = %v, want 10", got)
	}
}

func TestCheckoutAppliesRulesAndTax(t *testing.T) {
	c := &cart.Cart{}
	c.Add(cart.CartItem{Sku: "tea", UnitPrice: 50, Quantity: 2})
	receipt := Checkout(c, []pricing.PriceRule{pricing.NewPercentOff(10)}, "eu")
	if receipt.Discounted != 90 || receipt.Total != 108 {
		t.Fatalf("receipt = %+v", receipt)
	}
}

func TestCheckoutWithoutTax(t *testing.T) {
	c := &cart.Cart{}
	c.Add(cart.CartItem{Sku: "tea", UnitPrice: 10, Quantity: 1})
	if got := Checkout(c, nil, "none").Total; got != 11 {
		t.Fatalf("Total = %v, want 11", got)
	}
}
