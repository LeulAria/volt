from shop.pricing.rule import PriceRule


class BaseRule(PriceRule):
    def __init__(self, name: str) -> None:
        self.name = name

    def clamp(self, value: float) -> float:
        return 0.0 if value < 0 else value
