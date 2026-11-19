package pricing

import "example.com/shop/cart"

type PercentOff struct {
	BaseRule
	percent float64
}

func NewPercentOff(percent float64) *PercentOff {
	return &PercentOff{BaseRule{"percent-off"}, percent}
}

func (p *PercentOff) Apply(total float64, c *cart.Cart) float64 {
	return p.clamp(total * (1 - p.percent/100))
}
