package api

import (
	"fmt"
	"example.com/shop/tax"
	"example.com/shop/cart"
)

func   Summarize( c *cart.Cart ) string {
total:=tax.RoundCents( c.Subtotal() )
    return fmt.Sprintf( "items=%d total=%v",c.Count(),total )
}
