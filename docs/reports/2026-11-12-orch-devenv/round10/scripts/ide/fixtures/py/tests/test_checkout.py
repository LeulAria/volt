import unittest

from shop.cart import Cart, CartItem, line_total
from shop.checkout import checkout
from shop.pricing.percent_off import PercentOff


class CheckoutTest(unittest.TestCase):
    def test_line_total(self) -> None:
        self.assertEqual(line_total(CartItem("tea", 2.5, 4)), 10)

    def test_checkout_applies_rules_and_tax(self) -> None:
        cart = Cart()
        cart.add(CartItem("tea", 50, 2))
        receipt = checkout(cart, [PercentOff(10)], "eu")
        self.assertEqual(receipt.discounted, 90)
        self.assertEqual(receipt.total, 108)

    def test_checkout_without_tax(self) -> None:
        cart = Cart()
        cart.add(CartItem("tea", 10, 1))
        self.assertEqual(checkout(cart, [], "none").total, 11)


if __name__ == "__main__":
    unittest.main()
