RATES = {
    "eu": 0.2,
    "us": 0.07,
    "none": 0.0,
}


def round_cents(value: float) -> float:
    return round(value * 100) / 100


def compute_tax(amount: float, region: str) -> float:
    return round_cents(amount * RATES[region])
