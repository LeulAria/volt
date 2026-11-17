from dataclasses import dataclass


@dataclass
class CartItem:
    sku: str
    unit_price: float
    quantity: int


def line_total(item: CartItem) -> float:
    """The price of one line: unit price times quantity."""
    return item.unit_price * item.quantity


class Cart:
    def __init__(self) -> None:
        self._items: list[CartItem] = []

    def add(self, item: CartItem) -> None:
        self._items.append(item)

    def list(self) -> tuple[CartItem, ...]:
        return tuple(self._items)

    def subtotal(self) -> float:
        return sum(line_total(item) for item in self._items)

    def count(self) -> int:
        return sum(item.quantity for item in self._items)
