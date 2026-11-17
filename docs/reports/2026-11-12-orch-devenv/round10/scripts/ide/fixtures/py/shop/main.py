from shop.api.handlers import handle_checkout, handle_quote
from shop.cart import CartItem


def main() -> None:
    items = [CartItem("tea", 12.5, 4)]
    print(handle_quote(items), handle_checkout(items, "eu"))


if __name__ == "__main__":
    main()
