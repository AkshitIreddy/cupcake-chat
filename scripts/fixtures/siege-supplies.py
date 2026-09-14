"""Fictional siege logistics: supplies, spoilage, and changing population.

The quantities are story assumptions, not historical Roman ration records.
This checks the arithmetic behind a scene; it does not model nutrition.
"""
import math
import unittest


def usable_grain(stock_kg, spoilage=0.0):
    if not math.isfinite(stock_kg) or stock_kg < 0:
        raise ValueError("Stock must be finite and nonnegative")
    if not math.isfinite(spoilage) or not 0 <= spoilage <= 1:
        raise ValueError("Spoilage must be between zero and one")
    return stock_kg * (1 - spoilage)


def days_remaining(stock_kg, people, ration_kg=0.75):
    stock = usable_grain(stock_kg)
    if not math.isfinite(people) or people <= 0 or not float(people).is_integer():
        raise ValueError("People must be a positive whole number")
    if not math.isfinite(ration_kg) or ration_kg <= 0:
        raise ValueError("Ration must be finite and positive")
    return stock / (people * ration_kg)


def arrival_scenario(stock_kg, people, arrivals, after_days, ration_kg=0.75):
    initial_days = days_remaining(stock_kg, people, ration_kg)
    if after_days < 0 or not math.isfinite(after_days):
        raise ValueError("Arrival time must be finite and nonnegative")
    if arrivals < 0 or not math.isfinite(arrivals) or not float(arrivals).is_integer():
        raise ValueError("Arrivals must be a nonnegative whole number")
    if after_days > initial_days:
        return {"remaining_kg": 0.0, "further_days": 0.0, "total_days": initial_days}
    remaining = max(0.0, stock_kg - people * ration_kg * after_days)
    further = days_remaining(remaining, people + arrivals, ration_kg)
    return {"remaining_kg": remaining, "further_days": further,
            "total_days": after_days + further}


class SupplyChecks(unittest.TestCase):
    def test_spoilage_and_initial_duration(self):
        self.assertEqual(usable_grain(18000, 0.1), 16200)
        self.assertEqual(days_remaining(16200, 600), 36)

    def test_refugees_after_ten_days(self):
        result = arrival_scenario(16200, 600, 120, 10)
        self.assertEqual(result["remaining_kg"], 11700)
        self.assertAlmostEqual(result["further_days"], 65 / 3)
        self.assertAlmostEqual(result["total_days"], 95 / 3)

    def test_no_arrivals_preserves_duration(self):
        self.assertEqual(arrival_scenario(16200, 600, 0, 10)["total_days"], 36)

    def test_population_reduces_duration(self):
        self.assertEqual(days_remaining(16200, 1200), 18)

    def test_late_arrival_cannot_extend_exhausted_stock(self):
        self.assertEqual(arrival_scenario(16200, 600, 120, 40)["total_days"], 36)

    def test_invalid_and_empty_inputs(self):
        self.assertEqual(days_remaining(0, 600), 0)
        for args in [(-1, 600), (10, 0), (10, 2.5), (float("nan"), 600)]:
            with self.assertRaises(ValueError):
                days_remaining(*args)


if __name__ == "__main__":
    unittest.main(verbosity=2)
