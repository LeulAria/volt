from typing import Sequence

from shop.cart import Cart, CartItem
from shop.checkout import Receipt, checkout, quote
from shop.pricing.bulk_discount import BulkDiscount
from shop.pricing.free_shipping import FreeShipping
from shop.pricing.percent_off import PercentOff
from shop.pricing.rule import PriceRule


def default_rules() -> list[PriceRule]:
    return [PercentOff(10), BulkDiscount(5, 3), FreeShipping()]


def build_cart(items: Sequence[CartItem]) -> Cart:
    cart = Cart()
    for item in items:
        cart.add(item)
    return cart


def handle_checkout(items: Sequence[CartItem], region: str) -> Receipt:
    return checkout(build_cart(items), default_rules(), region)


def handle_quote(items: Sequence[CartItem]) -> float:
    return quote(build_cart(items), default_rules())
