package checkout

import (
	"example.com/shop/cart"
	"example.com/shop/pricing"
	"example.com/shop/tax"
)

type Receipt struct {
	Subtotal   float64
	Discounted float64
	Tax        float64
	Total      float64
}

func ApplyRules(c *cart.Cart, rules []pricing.PriceRule) float64 {
	total := c.Subtotal()
	for _, rule := range rules {
		total = rule.Apply(total, c)
	}
	return total
}

func Checkout(c *cart.Cart, rules []pricing.PriceRule, region string) Receipt {
	subtotal := c.Subtotal()
	discounted := ApplyRules(c, rules)
	taxed := tax.ComputeTax(discounted, region)
	return Receipt{
		Subtotal:   tax.RoundCents(subtotal),
		Discounted: tax.RoundCents(discounted),
		Tax:        taxed,
		Total:      tax.RoundCents(discounted + taxed),
	}
}

func Quote(c *cart.Cart, rules []pricing.PriceRule) float64 {
	return tax.RoundCents(ApplyRules(c, rules))
}
