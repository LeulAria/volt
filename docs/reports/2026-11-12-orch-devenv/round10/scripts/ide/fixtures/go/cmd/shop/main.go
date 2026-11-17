package main

import (
	"fmt"

	"example.com/shop/api"
	"example.com/shop/cart"
)

func main() {
	items := []cart.CartItem{{Sku: "tea", UnitPrice: 12.5, Quantity: 4}}
	fmt.Println(api.HandleQuote(items), api.HandleCheckout(items, "eu"))
}
