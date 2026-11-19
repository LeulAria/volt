from abc import ABC, abstractmethod

from shop.cart import Cart


class PriceRule(ABC):
    """A pricing rule turns a running total into a new total."""

    name: str

    @abstractmethod
    def apply(self, total: float, cart: Cart) -> float:
        raise NotImplementedError
