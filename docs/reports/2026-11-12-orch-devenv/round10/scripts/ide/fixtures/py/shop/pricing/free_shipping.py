from shop.cart import Cart
from shop.pricing.rule import PriceRule

SHIPPING_FEE = 4.99


class FreeShipping(PriceRule):
    name = "free-shipping"

    def apply(self, total: float, cart: Cart) -> float:
        return total if total >= 50 else total + SHIPPING_FEE
