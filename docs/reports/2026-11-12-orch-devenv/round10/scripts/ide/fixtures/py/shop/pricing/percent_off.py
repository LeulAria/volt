from shop.cart import Cart
from shop.pricing.base import BaseRule


class PercentOff(BaseRule):
    def __init__(self, percent: float) -> None:
        super().__init__("percent-off")
        self.percent = percent

    def apply(self, total: float, cart: Cart) -> float:
        return self.clamp(total * (1 - self.percent / 100))
