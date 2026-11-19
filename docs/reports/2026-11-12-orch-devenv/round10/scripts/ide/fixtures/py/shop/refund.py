from shop.cart import Cart


def refund_tax(cart: Cart) -> float:
    return compute_tax(cart.subtotal(), "eu")
