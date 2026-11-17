package cart

// CartItem is one line of a cart.
type CartItem struct {
	Sku       string
	UnitPrice float64
	Quantity  int
}

// LineTotal is the price of one line: unit price times quantity.
func LineTotal(item CartItem) float64 {
	return item.UnitPrice * float64(item.Quantity)
}

// Cart holds the lines of an order.
type Cart struct {
	items []CartItem
}

func (c *Cart) Add(item CartItem) {
	c.items = append(c.items, item)
}

func (c *Cart) List() []CartItem {
	return c.items
}

func (c *Cart) Subtotal() float64 {
	sum := 0.0
	for _, item := range c.items {
		sum += LineTotal(item)
	}
	return sum
}

func (c *Cart) Count() int {
	n := 0
	for _, item := range c.items {
		n += item.Quantity
	}
	return n
}
