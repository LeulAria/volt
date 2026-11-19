from shop.cart import Cart
from shop.pricing.base import BaseRule


class BulkDiscount(BaseRule):
    def __init__(self, amount: float, min_items: int) -> None:
        super().__init__("bulk-discount")
        self.amount = amount
        self.min_items = min_items

    def apply(self, total: float, cart: Cart) -> float:
        if cart.count() >= self.min_items:
            return self.clamp(total - self.amount)
        return total
