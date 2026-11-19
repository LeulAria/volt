from dataclasses import dataclass
from typing import Sequence

from shop.cart import Cart
from shop.pricing.rule import PriceRule
from shop.tax import compute_tax, round_cents


@dataclass
class Receipt:
    subtotal: float
    discounted: float
    tax: float
    total: float


def apply_rules(cart: Cart, rules: Sequence[PriceRule]) -> float:
    total = cart.subtotal()
    for rule in rules:
        total = rule.apply(total, cart)
    return total


def checkout(cart: Cart, rules: Sequence[PriceRule], region: str) -> Receipt:
    subtotal = cart.subtotal()
    discounted = apply_rules(cart, rules)
    tax = compute_tax(discounted, region)
    return Receipt(
        subtotal=round_cents(subtotal),
        discounted=round_cents(discounted),
        tax=tax,
        total=round_cents(discounted + tax),
    )


def quote(cart: Cart, rules: Sequence[PriceRule]) -> float:
    return round_cents(apply_rules(cart, rules))
