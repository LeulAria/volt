from shop.tax import round_cents, compute_tax
from shop.cart import Cart
from shop.cart import line_total

def   summarize( cart:Cart )->str:
    total=round_cents( cart.subtotal() )
    return "items=%d total=%s"%( cart.count(),total )
